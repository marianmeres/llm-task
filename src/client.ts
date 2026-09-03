/**
 * @module client
 *
 * The policy layer: `createLlmClient` holds the adapter plus all reliability
 * behavior (retries with jitter, deadlines, caching, hooks, schema strategy,
 * output cleaning, error normalization) and produces reusable tasks — prompts
 * that behave like typed functions.
 */

import { getErrorMessage } from "@marianmeres/http-utils";
import type {
	Adapter,
	CompletionRequest,
	CompletionResult,
	CompletionUsage,
	FinishReason,
} from "./adapter.ts";
import type { CachedCompletion, LlmCache } from "./cache.ts";
import { applyCleaners, type Cleaner } from "./cleaners.ts";
import {
	ContentFilterError,
	isRetryableError,
	LLMError,
	OutputValidationError,
	RateLimitError,
	TimeoutError,
	TruncatedOutputError,
	type ValidationIssue,
} from "./errors.ts";
import { type Logger, quietLogger, withNamespace } from "./logger.ts";
import {
	buildJsonInstruction,
	buildRepairInstruction,
	formatIssues,
	type InferOutput,
	isStandardSchema,
	type JsonSchema,
	parseJsonLoose,
	type StandardSchemaV1,
} from "./schema.ts";
import {
	backoffDelay,
	composeSignals,
	isAbortLike,
	sha256Hex,
	sleep,
	stableStringify,
} from "./utils.ts";

/** Retry policy. Retries happen only on `TransientError` / `RateLimitError`. */
export interface RetryOptions {
	/**
	 * Total attempts (1 = no retries).
	 * @default 3
	 */
	attempts: number;
	/**
	 * Base backoff delay in ms (grows exponentially with equal jitter).
	 * @default 500
	 */
	baseDelayMs: number;
	/**
	 * Backoff delay cap in ms. A provider `Retry-After` may exceed it.
	 * @default 10000
	 */
	maxDelayMs: number;
}

/** Info passed to the `onRequest` hook (fires before every real adapter call). */
export interface HookRequestInfo {
	/** Adapter id. */
	adapter: string;
	/** Resolved model. */
	model: string;
	/** The normalized request about to be sent. */
	request: CompletionRequest;
	/** 1-based attempt number within the current call sequence (primary/repair). */
	attempt: number;
}

/** Info passed to the `onResponse` hook (fires on success, incl. cache hits). */
export interface HookResponseInfo {
	/** Adapter id. */
	adapter: string;
	/** Resolved model. */
	model: string;
	/** The normalized completion result. */
	result: CompletionResult;
	/** Wall-clock duration of the call in ms (0 for cache hits). */
	durationMs: number;
	/** `true` when served from cache (no adapter call happened). */
	cached: boolean;
	/** 1-based attempt number (0 for cache hits). */
	attempt: number;
}

/** Info passed to the `onRetry` hook (fires before each backoff sleep). */
export interface HookRetryInfo {
	/** Adapter id. */
	adapter: string;
	/** Resolved model. */
	model: string;
	/** 1-based number of the attempt that just failed. */
	attempt: number;
	/** Delay before the next attempt in ms. */
	delayMs: number;
	/** The normalized error that triggered the retry. */
	error: unknown;
}

/** Info passed to the `onInputTruncated` hook (fires when `maxInputChars` cuts). */
export interface HookInputTruncatedInfo {
	/** Original input length in chars. */
	originalChars: number;
	/** The configured limit that was applied. */
	maxInputChars: number;
}

/**
 * Lifecycle hooks for logging, tracing or metrics — wire your own
 * observability instead of this package depending on a logger. Hooks are pure
 * observers: throws are swallowed (and logged) and never affect the call.
 * Client-level and task-level hooks both fire (client first).
 */
export interface LlmHooks {
	/** Fires before every real adapter call (not for cache hits). */
	onRequest?: (info: HookRequestInfo) => void;
	/** Fires after every successful completion (incl. cache hits). */
	onResponse?: (info: HookResponseInfo) => void;
	/** Fires before each retry backoff sleep. */
	onRetry?: (info: HookRetryInfo) => void;
	/** Fires when input was truncated to `maxInputChars` before sending. */
	onInputTruncated?: (info: HookInputTruncatedInfo) => void;
}

/** Options shared by the client config (as defaults) and per-task config. */
export interface TaskDefaults {
	/** Provider-native model id (task/call level overrides client default). */
	model?: string;
	/**
	 * Max output tokens.
	 * @default 1024
	 */
	maxTokens?: number;
	/** Sampling temperature (omitted from the request when unset). */
	temperature?: number;
	/**
	 * Overall per-call deadline in ms — covers retries and the repair attempt;
	 * the retry budget never overshoots it. `0` disables the deadline.
	 * @default 30000
	 */
	timeoutMs?: number;
	/** Retry policy overrides, or `false` to disable retries. */
	retry?: Partial<RetryOptions> | false;
	/** Lifecycle hooks (merged with — not replacing — client-level hooks). */
	hooks?: LlmHooks;
}

/**
 * A reusable task definition: the prompt, model choice, params and output
 * cleanup defined once, called N times with only the varying input.
 */
export interface TaskConfig extends TaskDefaults {
	/**
	 * The task instruction, sent as the provider's system prompt. Caller input
	 * is never concatenated into it — it always travels as a separate user
	 * message (prompt/input separation).
	 */
	system?: string;
	/**
	 * Structured output (opt-in — changes the task return type):
	 * a [Standard Schema](https://standardschema.dev) (zod/valibot/arktype/...)
	 * validated client-side, or a plain JSON Schema object sent to the provider.
	 */
	schema?: StandardSchemaV1 | JsonSchema;
	/**
	 * Wire JSON Schema to send alongside a Standard Schema `schema` — enables
	 * the provider's native structured output while keeping client-side
	 * validation (e.g. `jsonSchema: z.toJSONSchema(MySchema)`, zod v4). May
	 * also be used without `schema`: the task is then structured (parsed JSON,
	 * no client-side validation) and typed `unknown` / `task<T>(...)`.
	 */
	jsonSchema?: JsonSchema;
	/** Output cleaners applied in order (string tasks only). */
	clean?: readonly Cleaner[];
	/**
	 * Return partial text instead of throwing {@link TruncatedOutputError} when
	 * the model stops at `maxTokens`.
	 * @default false
	 */
	allowTruncated?: boolean;
	/**
	 * Truncate input longer than this many chars before sending (instead of
	 * surfacing a provider `ContextLengthError`). Off by default; when it fires
	 * it is reported via the `onInputTruncated` hook and the result's
	 * `inputTruncated` flag — never silent.
	 */
	maxInputChars?: number;
	/**
	 * Participate in the client cache (only meaningful when the client has one).
	 * @default true
	 */
	cache?: boolean;
}

/** Per-call overrides. */
export interface TaskRunOptions {
	/** Caller abort signal (composed with the local deadline). */
	signal?: AbortSignal;
	/** Model override for this call. */
	model?: string;
	/** Max output tokens override for this call. */
	maxTokens?: number;
	/** Temperature override for this call. */
	temperature?: number;
	/** Deadline override for this call. */
	timeoutMs?: number;
	/** Cache participation override for this call. */
	cache?: boolean;
	/**
	 * Opaque cache partition for this call. Mixed into the cache key, so callers
	 * sharing one client but not one identity never read each other's
	 * completions. Supply it whenever the adapter's credential varies per call
	 * (e.g. an adapter configured with `getToken()`) and the cache is on — it is
	 * documented, not enforced.
	 */
	cacheScope?: string;
}

/** The full result envelope (via `task.run()` / `client.run()`). */
export interface TaskResult<T = string> {
	/** The final task value: cleaned string, or the validated/typed object. */
	value: T;
	/** The (final) completion text before parsing, after the provider returned it. */
	text: string;
	/** Normalized finish reason of the final completion. */
	finishReason: FinishReason;
	/** Normalized token usage, when the provider reports it. */
	usage?: CompletionUsage;
	/** The model that answered, as reported by the provider. */
	model: string;
	/** Raw provider response body (`undefined` when served from cache). */
	raw: unknown;
	/**
	 * `true` when served from the cache with no adapter call at all. A stale
	 * cache hit that needed the repair round-trip reports `false` (a real call
	 * happened — see `repaired`; the repaired completion is re-cached).
	 */
	cached: boolean;
	/** `true` when the input was truncated to `maxInputChars` before sending. */
	inputTruncated: boolean;
	/** Total adapter calls made (0 for pure cache hits; includes the repair call). */
	attempts: number;
	/** `true` when the single JSON repair round-trip was needed (and succeeded). */
	repaired: boolean;
}

/** Client configuration: the adapter plus policy defaults for all tasks. */
export interface LlmClientConfig extends TaskDefaults {
	/** The provider adapter (e.g. `createAnthropicAdapter()`). */
	adapter: Adapter;
	/**
	 * Completion cache (e.g. `createMemoryCache()`), or `false`/omitted for none.
	 * Only clean (`finishReason: "stop"`) completions are cached; post-processing
	 * (cleaners, parsing, validation) re-runs on hits, so task config can change
	 * without stale values.
	 */
	cache?: LlmCache | false;
	/**
	 * Logger for internal diagnostics. Compatible with `console` and with
	 * `@marianmeres/clog` instances. Defaults to a quiet logger (warn/error to
	 * `console`, debug/log silenced).
	 */
	logger?: Logger;
}

/**
 * A callable task. Invoking it returns the bare value (string, or typed object
 * for schema tasks); `task.run()` returns the full {@link TaskResult} envelope
 * (usage, finish reason, cache/truncation flags, raw response).
 */
export interface LlmTask<T = string> {
	/** Runs the task and returns the bare value. */
	(input: string, options?: TaskRunOptions): Promise<T>;
	/** Runs the task and returns the full result envelope. */
	run(input: string, options?: TaskRunOptions): Promise<TaskResult<T>>;
}

/** One-shot config for `client.run()`: a task config plus the input. */
export interface RunConfig extends TaskConfig {
	/** The untrusted input (sent as a separate user message). */
	input: string;
}

/**
 * The client: holds the adapter + policy, defines tasks, runs one-shots.
 * Created via {@link createLlmClient}.
 */
export interface LlmClient {
	/** The underlying adapter. */
	readonly adapter: Adapter;

	/**
	 * Defines a reusable task. The return type follows the config: a Standard
	 * Schema `schema` yields its inferred output type, a plain JSON Schema
	 * (via `schema` or `jsonSchema` alone) yields `unknown` (or an explicit
	 * `task<T>(...)` type argument), no schema yields `string`. A `schema`
	 * value only statically known as the union of both degrades to `unknown`.
	 */
	task<S extends StandardSchemaV1>(
		config: TaskConfig & { schema: S },
	): LlmTask<InferOutput<S>>;
	task<T = unknown>(config: TaskConfig & { schema: JsonSchema }): LlmTask<T>;
	task(
		config: TaskConfig & { schema: StandardSchemaV1 | JsonSchema },
	): LlmTask<unknown>;
	task<T = unknown>(config: TaskConfig & { jsonSchema: JsonSchema }): LlmTask<T>;
	task(config: TaskConfig): LlmTask<string>;

	/**
	 * Bare one-shot escape hatch — a single call without defining a reusable
	 * task. Returns the full {@link TaskResult} envelope.
	 */
	run<S extends StandardSchemaV1>(
		config: RunConfig & { schema: S },
		options?: TaskRunOptions,
	): Promise<TaskResult<InferOutput<S>>>;
	run<T = unknown>(
		config: RunConfig & { schema: JsonSchema },
		options?: TaskRunOptions,
	): Promise<TaskResult<T>>;
	run(
		config: RunConfig & { schema: StandardSchemaV1 | JsonSchema },
		options?: TaskRunOptions,
	): Promise<TaskResult<unknown>>;
	run<T = unknown>(
		config: RunConfig & { jsonSchema: JsonSchema },
		options?: TaskRunOptions,
	): Promise<TaskResult<T>>;
	run(config: RunConfig, options?: TaskRunOptions): Promise<TaskResult<string>>;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

/** Outcome of one parse+validate pass over a completion text. */
type ParseOutcome =
	| { value: unknown; issues?: undefined }
	| { issues: readonly ValidationIssue[] };

/**
 * Creates an LLM client: one place for the adapter, defaults, retries,
 * timeouts, cache and hooks. Define tasks via {@link LlmClient.task}.
 *
 * @example
 * ```typescript
 * import {
 * 	cleaners,
 * 	createAnthropicAdapter,
 * 	createLlmClient,
 * } from "@marianmeres/llm-task";
 *
 * const client = createLlmClient({
 * 	adapter: createAnthropicAdapter(), // ANTHROPIC_API_KEY fallback
 * 	model: "claude-haiku-4-5",
 * });
 *
 * const toTitle = client.task({
 * 	system: "Summarize the user input into a single short sentence title.",
 * 	maxTokens: 64,
 * 	clean: [cleaners.stripFences, cleaners.unquote, cleaners.firstLine],
 * });
 *
 * const title = await toTitle(userInput); // -> string
 * ```
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
	const adapter = config.adapter;
	if (!adapter || typeof adapter.complete !== "function") {
		throw new TypeError("createLlmClient: `adapter` is required");
	}
	const logger = withNamespace(config.logger ?? quietLogger, "llm-task");
	const cacheStore = config.cache === false ? undefined : config.cache;

	/** Fires client-level then task-level hooks; a throwing hook never breaks the call. */
	function fireHook<K extends keyof LlmHooks>(
		taskHooks: LlmHooks | undefined,
		name: K,
		info: Parameters<NonNullable<LlmHooks[K]>>[0],
	): void {
		for (const hooks of [config.hooks, taskHooks]) {
			const hook = hooks?.[name] as ((i: unknown) => void) | undefined;
			if (!hook) continue;
			try {
				hook(info);
			} catch (e) {
				logger.warn(`${name} hook threw`, e);
			}
		}
	}

	async function execute(
		task: TaskConfig,
		input: string,
		options: TaskRunOptions = {},
	): Promise<TaskResult<unknown>> {
		if (typeof input !== "string") {
			throw new TypeError(`llm-task: input must be a string, got ${typeof input}`);
		}
		const model = options.model ?? task.model ?? config.model;
		if (!model) {
			throw new TypeError(
				"llm-task: `model` is required (set it on the client, the task, or the call)",
			);
		}
		const maxTokens = options.maxTokens ?? task.maxTokens ?? config.maxTokens ??
			DEFAULT_MAX_TOKENS;
		const temperature = options.temperature ?? task.temperature ?? config.temperature;
		const timeoutMs = options.timeoutMs ?? task.timeoutMs ?? config.timeoutMs ??
			DEFAULT_TIMEOUT_MS;
		const retry = resolveRetry(task.retry ?? config.retry, config.retry);
		const useCache = !!cacheStore && (options.cache ?? task.cache ?? true);

		// -- input truncation (opt-in, never silent) --------------------------
		let effInput = input;
		let inputTruncated = false;
		if (task.maxInputChars && input.length > task.maxInputChars) {
			effInput = input.slice(0, task.maxInputChars);
			inputTruncated = true;
			fireHook(task.hooks, "onInputTruncated", {
				originalChars: input.length,
				maxInputChars: task.maxInputChars,
			});
			logger.debug(
				`input truncated ${input.length} -> ${task.maxInputChars} chars`,
			);
		}

		// -- schema strategy ---------------------------------------------------
		const validator = isStandardSchema(task.schema) ? task.schema : undefined;
		const wireSchema = task.jsonSchema ??
			(task.schema && !validator ? (task.schema as JsonSchema) : undefined);
		const structured = !!task.schema || !!wireSchema;
		const native = !!wireSchema && adapter.capabilities.jsonSchema;
		let system = task.system;
		if (structured && !native) {
			// graceful degradation: schema/JSON instruction into the system prompt,
			// parsed and validated client-side
			system = joinSystem(system, buildJsonInstruction(wireSchema));
		}

		// -- deadline & signals ------------------------------------------------
		const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
		const { signal, dispose } = composeSignals(options.signal, timeoutSignal);
		const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
		let totalAttempts = 0;

		/** Normalizes anything thrown during an attempt into the error taxonomy. */
		function normalizeError(e: unknown): unknown {
			// caller-initiated abort propagates untouched
			if (options.signal?.aborted) return e;
			if (timeoutSignal?.aborted || isAbortLike(e)) {
				return e instanceof TimeoutError ? e : new TimeoutError(
					`llm-task: call exceeded timeoutMs (${timeoutMs}ms)`,
					{ adapter: adapter.id, cause: e },
				);
			}
			if (e instanceof LLMError) return e;
			return new LLMError(`Unexpected adapter error: ${getErrorMessage(e)}`, {
				adapter: adapter.id,
				cause: e,
			});
		}

		/**
		 * One adapter call wrapped in the retry policy (respecting the deadline).
		 * Each logical call (primary, repair) gets its own retry budget; the
		 * `attempt` reported to hooks is local to that call sequence.
		 */
		async function completeWithRetry(
			sys: string | undefined,
		): Promise<CompletionResult> {
			const request: CompletionRequest = {
				system: sys,
				input: effInput,
				model: model!,
				maxTokens,
				temperature,
				jsonSchema: native ? wireSchema : undefined,
				signal,
			};
			let attempt = 0;
			while (true) {
				attempt++;
				totalAttempts++;
				fireHook(task.hooks, "onRequest", {
					adapter: adapter.id,
					model: model!,
					request,
					attempt,
				});
				const t0 = Date.now();
				try {
					const result = await adapter.complete(request);
					fireHook(task.hooks, "onResponse", {
						adapter: adapter.id,
						model: model!,
						result,
						durationMs: Date.now() - t0,
						cached: false,
						attempt,
					});
					return result;
				} catch (e) {
					const err = normalizeError(e);
					if (!isRetryableError(err) || attempt >= retry.attempts) throw err;
					let delayMs = backoffDelay(
						attempt,
						retry.baseDelayMs,
						retry.maxDelayMs,
					);
					const retryAfter = err instanceof RateLimitError
						? err.retryAfter
						: undefined;
					if (retryAfter !== undefined) {
						delayMs = Math.max(delayMs, retryAfter * 1000);
					}
					if (Date.now() + delayMs >= deadline) {
						logger.warn(
							`retry would overshoot the ${timeoutMs}ms deadline, giving up`,
						);
						throw err;
					}
					fireHook(task.hooks, "onRetry", {
						adapter: adapter.id,
						model: model!,
						attempt,
						delayMs,
						error: err,
					});
					logger.warn(
						`attempt ${attempt}/${retry.attempts} failed (${
							(err as Error)?.name
						}: ${getErrorMessage(err)}), retrying in ${
							Math.round(delayMs)
						}ms`,
					);
					try {
						await sleep(delayMs, signal);
					} catch (abortErr) {
						throw normalizeError(abortErr);
					}
				}
			}
		}

		/** Throws on refused/truncated completions (the near-invisible bugs). */
		function guardFinish(result: CompletionResult): void {
			if (result.finishReason === "content_filter") {
				throw new ContentFilterError(
					"The provider refused or filtered the response.",
					{ adapter: adapter.id, raw: result.raw },
				);
			}
			if (result.finishReason === "length" && !task.allowTruncated) {
				throw new TruncatedOutputError(
					`Output was truncated at maxTokens (${maxTokens}) — ` +
						"raise maxTokens or set allowTruncated: true.",
					{ adapter: adapter.id, raw: result.raw, text: result.text },
				);
			}
		}

		/** One parse + validate pass (structured tasks). */
		async function parseAndValidate(text: string): Promise<ParseOutcome> {
			let parsed: unknown;
			try {
				parsed = parseJsonLoose(text);
			} catch (e) {
				return { issues: [{ message: `Invalid JSON: ${getErrorMessage(e)}` }] };
			}
			if (!validator) return { value: parsed };
			const res = await validator["~standard"].validate(parsed);
			if (res.issues) return { issues: res.issues };
			return { value: res.value };
		}

		let cacheKey: string | undefined;
		try {
			// -- cache lookup --------------------------------------------------
			let hit: CachedCompletion | undefined;
			if (useCache) {
				try {
					// inside the try: crypto.subtle may be unavailable (browser
					// insecure context) — degrade to uncached, never fail the call
					cacheKey = await sha256Hex(stableStringify({
						adapter: adapter.id,
						fingerprint: adapter.fingerprint ?? null,
						// stays absent from the key when unset (`JSON.stringify`
						// drops it), so existing entries keep their keys
						cacheScope: options.cacheScope,
						model,
						system: system ?? null,
						input: effInput,
						maxTokens,
						temperature: temperature ?? null,
						jsonSchema: native ? wireSchema : null,
					}));
					hit = await cacheStore!.get(cacheKey);
				} catch (e) {
					cacheKey = undefined;
					logger.warn("cache unavailable, continuing without cache", e);
				}
			}
			if (hit) {
				logger.debug("cache hit", cacheKey);
				const result: CompletionResult = { ...hit, raw: undefined };
				fireHook(task.hooks, "onResponse", {
					adapter: adapter.id,
					model: model!,
					result,
					durationMs: 0,
					cached: true,
					attempt: 0,
				});
				return await postProcess(result, true);
			}

			// -- the call ------------------------------------------------------
			const completion = await completeWithRetry(system);
			guardFinish(completion);
			return await postProcess(completion, false);
		} finally {
			// detach fallback-composed signal listeners (no-op with AbortSignal.any)
			dispose();
		}

		/** Cleans (string mode) or parses/validates/repairs (structured mode). */
		async function postProcess(
			completion: CompletionResult,
			cached: boolean,
		): Promise<TaskResult<unknown>> {
			let final = completion;
			let repaired = false;
			let value: unknown;

			if (!structured) {
				value = applyCleaners(completion.text, task.clean);
			} else {
				let outcome = await parseAndValidate(completion.text);
				if (outcome.issues) {
					// exactly one repair round-trip — never a loop
					logger.debug(
						`output failed validation (${formatIssues(outcome.issues)}), ` +
							"attempting single repair",
					);
					const repairSystem = joinSystem(
						system,
						buildRepairInstruction(
							completion.text,
							formatIssues(outcome.issues),
						),
					);
					final = await completeWithRetry(repairSystem);
					guardFinish(final);
					repaired = true;
					outcome = await parseAndValidate(final.text);
					if (outcome.issues) {
						throw new OutputValidationError(
							`Structured output failed validation after the repair attempt: ${
								formatIssues(outcome.issues)
							}`,
							{
								adapter: adapter.id,
								text: final.text,
								issues: outcome.issues,
								raw: final.raw,
							},
						);
					}
				}
				value = outcome.value;
			}

			// cache the final good completion (incl. a successful repair, and a
			// stale cache hit that needed repairing)
			if (cacheKey && final.finishReason === "stop" && (!cached || repaired)) {
				const entry: CachedCompletion = {
					text: final.text,
					finishReason: final.finishReason,
					usage: final.usage,
					model: final.model,
				};
				try {
					await cacheStore!.set(cacheKey, entry);
				} catch (e) {
					logger.warn("cache set failed", e);
				}
			}

			return {
				value,
				text: final.text,
				finishReason: final.finishReason,
				usage: final.usage,
				model: final.model,
				raw: final.raw,
				// a stale cache hit that needed the repair round-trip made a real
				// adapter call — report cached: false so the flag never lies
				cached: cached && !repaired,
				inputTruncated,
				attempts: totalAttempts,
				repaired,
			};
		}
	}

	return {
		adapter,
		task(taskConfig: TaskConfig): LlmTask<never> {
			const run = (input: string, options?: TaskRunOptions) =>
				execute(taskConfig, input, options);
			const fn = (input: string, options?: TaskRunOptions) =>
				run(input, options).then((r) => r.value);
			return Object.assign(fn, { run }) as unknown as LlmTask<never>;
		},
		run(runConfig: RunConfig, options?: TaskRunOptions) {
			const { input, ...taskConfig } = runConfig;
			// deno-lint-ignore no-explicit-any
			return execute(taskConfig, input, options) as any;
		},
	};
}

/** Joins system prompt segments with a blank line, skipping empties. */
function joinSystem(...parts: (string | undefined)[]): string {
	return parts.filter((p) => !!p?.trim()).join("\n\n");
}

/** Resolves the effective retry policy from task + client level config. */
function resolveRetry(
	effective: Partial<RetryOptions> | false | undefined,
	clientLevel: Partial<RetryOptions> | false | undefined,
): RetryOptions {
	if (effective === false) return { ...DEFAULT_RETRY, attempts: 1 };
	const clientPart = clientLevel && clientLevel !== effective ? clientLevel : undefined;
	const merged: RetryOptions = {
		...DEFAULT_RETRY,
		...(clientPart || {}),
		...(effective || {}),
	};
	merged.attempts = Math.max(1, Math.floor(merged.attempts));
	merged.baseDelayMs = Math.max(0, merged.baseDelayMs);
	merged.maxDelayMs = Math.max(merged.baseDelayMs, merged.maxDelayMs);
	return merged;
}
