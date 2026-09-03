/**
 * @module adapters/openai
 *
 * OpenAI Chat Completions adapter, plus the parameterized core it is built on —
 * the same wire format is spoken by Azure OpenAI, Groq, Together, OpenRouter,
 * Fireworks, GitHub Models and a self-hosted Ollama. Thin `fetch` + wire-format
 * mapping only — all policy (retries, timeouts, caching, schema strategy) lives
 * in the client.
 */

import { fetchOrThrow, getErrorMessage, HTTP_ERROR } from "@marianmeres/http-utils";
import type {
	Adapter,
	AdapterCapabilities,
	CompletionRequest,
	CompletionResult,
	FinishReason,
} from "../adapter.ts";
import {
	AuthError,
	ContextLengthError,
	errorFromHttpStatus,
	parseRetryAfter,
	TransientError,
} from "../errors.ts";
import { isAbortLike, readEnv, stableStringify } from "../utils.ts";

/** Name of the output token limit field on the wire. */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

/** The knobs that differ between OpenAI-compatible providers. */
export interface OpenAICompatibleConfig {
	/** Stable adapter id (error metadata, cache keys). */
	id: string;
	/**
	 * Configuration fingerprint distinguishing differently configured instances
	 * sharing the same `id`. Must cover everything that changes the answer —
	 * endpoint, wire options, extra headers.
	 */
	fingerprint: string;
	/** Full request URL for a given model/deployment. */
	buildUrl: (model: string) => string;
	/** Auth headers for a given key (`Authorization: Bearer …`, `api-key: …`, …). */
	buildAuthHeaders: (key: string) => Record<string, string>;
	/**
	 * Whether to send the `model` field on the wire. Azure's classic deployment
	 * route addresses the model through the URL and omits it.
	 */
	sendModel: boolean;
	/** Lazy credential lookup — called per request, never at construction. */
	resolveKey: () => string | undefined;
	/** Thrown as {@link AuthError} when `resolveKey` yields nothing. */
	missingKeyMessage: string;
	/**
	 * Output token limit field name. Newer models reject the legacy
	 * `max_tokens`; older clone endpoints require it.
	 * @default "max_completion_tokens"
	 */
	maxTokensField?: MaxTokensField;
	/** Extra request headers. Merged over the defaults. */
	headers?: Record<string, string>;
	/** Injectable `fetch` (handy for tests — no network, no keys). */
	fetch?: typeof fetch;
	/** What the endpoint natively supports (drives the client schema strategy). */
	capabilities: AdapterCapabilities;
}

/** Minimal shape of a Chat Completions success response. */
interface ChatCompletion {
	choices?: {
		message?: { content?: string | null };
		finish_reason?: string;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number };
	model?: string;
}

const DEFAULT_MAX_TOKENS_FIELD: MaxTokensField = "max_completion_tokens";

/**
 * Creates an adapter for any endpoint speaking the OpenAI Chat Completions wire
 * format. This is the supported way to reach a provider this package does not
 * ship a dedicated factory for — Groq, Together, OpenRouter, Fireworks, a
 * self-hosted Ollama — without waiting for a release.
 *
 * @example
 * ```typescript
 * const groq = createOpenAICompatibleAdapter({
 * 	id: "groq",
 * 	fingerprint: "groq",
 * 	buildUrl: () => "https://api.groq.com/openai/v1/chat/completions",
 * 	buildAuthHeaders: (key) => ({ authorization: `Bearer ${key}` }),
 * 	sendModel: true,
 * 	resolveKey: () => Deno.env.get("GROQ_API_KEY"),
 * 	missingKeyMessage: "Missing GROQ_API_KEY.",
 * 	capabilities: { jsonSchema: false, jsonMode: false, streaming: false },
 * });
 * ```
 */
export function createOpenAICompatibleAdapter(config: OpenAICompatibleConfig): Adapter {
	const doFetch = config.fetch ?? fetchOrThrow;
	const maxTokensField = config.maxTokensField ?? DEFAULT_MAX_TOKENS_FIELD;

	return {
		id: config.id,
		fingerprint: config.fingerprint,
		capabilities: config.capabilities,
		async complete(req: CompletionRequest): Promise<CompletionResult> {
			const apiKey = config.resolveKey();
			if (!apiKey) {
				throw new AuthError(config.missingKeyMessage, { adapter: config.id });
			}

			// instruction and untrusted input stay separate messages, never concatenated
			const messages: { role: string; content: string }[] = [];
			if (req.system !== undefined) {
				messages.push({ role: "system", content: req.system });
			}
			messages.push({ role: "user", content: req.input });

			const body: Record<string, unknown> = {
				messages,
				[maxTokensField]: req.maxTokens,
			};
			if (config.sendModel) body.model = req.model;
			if (req.temperature !== undefined) body.temperature = req.temperature;

			let response: Response;
			try {
				response = await doFetch(config.buildUrl(req.model), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...config.buildAuthHeaders(apiKey),
						...config.headers,
					},
					body: JSON.stringify(body),
					signal: req.signal,
				});
			} catch (e) {
				// caller-initiated aborts and local deadline timeouts pass through
				// untouched — the client maps them to its own taxonomy
				if (isAbortLike(e)) throw e;
				if (e instanceof HTTP_ERROR.NetworkError) {
					throw new TransientError(e.message, {
						adapter: config.id,
						cause: e.cause ?? e,
					});
				}
				throw new TransientError(getErrorMessage(e), {
					adapter: config.id,
					cause: e,
				});
			}

			if (!response.ok) throw await toLlmError(response, config.id);

			let data: ChatCompletion;
			try {
				data = (await response.json()) as ChatCompletion;
			} catch (e) {
				// a proxy/gateway answering 2xx with a non-JSON body must still
				// surface as a normalized (retryable) error, not a bare SyntaxError
				throw new TransientError(
					`${config.id} returned a non-JSON success body: ${
						getErrorMessage(e)
					}`,
					{ adapter: config.id, status: response.status, cause: e },
				);
			}

			const choice = data.choices?.[0];
			return {
				// `content` is null on a refusal or a tool-only turn
				text: choice?.message?.content ?? "",
				finishReason: mapFinishReason(choice?.finish_reason),
				usage: data.usage
					? {
						inputTokens: data.usage.prompt_tokens ?? 0,
						outputTokens: data.usage.completion_tokens ?? 0,
					}
					: undefined,
				model: data.model ?? req.model,
				raw: data,
			};
		},
	};
}

/** Options for {@link createOpenAIAdapter}. */
export interface OpenAIAdapterOptions {
	/**
	 * OpenAI API key. When omitted, lazily falls back to the `OPENAI_API_KEY`
	 * environment variable (in Deno only when `--allow-env` was granted — an
	 * explicit key never touches the environment).
	 */
	apiKey?: string;
	/**
	 * API base URL (no trailing slash).
	 * @default "https://api.openai.com/v1"
	 */
	baseUrl?: string;
	/**
	 * Output token limit field name. Newer models reject the legacy
	 * `max_tokens`; older clone endpoints require it.
	 * @default "max_completion_tokens"
	 */
	maxTokensField?: MaxTokensField;
	/** Extra request headers (e.g. `openai-organization`). Merged over the defaults. */
	headers?: Record<string, string>;
	/**
	 * Injectable `fetch` implementation (handy for tests — no network, no keys).
	 * Defaults to `fetchOrThrow` from `@marianmeres/http-utils` (native `fetch`
	 * with normalized transport errors).
	 */
	fetch?: typeof fetch;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_ADAPTER_ID = "openai";

/**
 * Creates the OpenAI Chat Completions adapter.
 *
 * Structured tasks use the client's prompt-instruction strategy (the schema is
 * described in the prompt and validated client-side).
 *
 * @example
 * ```typescript
 * import { createLlmClient, createOpenAIAdapter } from "@marianmeres/llm-task";
 *
 * const client = createLlmClient({
 * 	adapter: createOpenAIAdapter(), // or { apiKey: "sk-..." }
 * 	model: "gpt-4.1-mini",
 * });
 * ```
 */
export function createOpenAIAdapter(options: OpenAIAdapterOptions = {}): Adapter {
	const baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
	const maxTokensField = options.maxTokensField ?? DEFAULT_MAX_TOKENS_FIELD;

	return createOpenAICompatibleAdapter({
		id: OPENAI_ADAPTER_ID,
		fingerprint: `${baseUrl}|${maxTokensField}|${
			stableStringify(options.headers ?? {})
		}`,
		buildUrl: () => `${baseUrl}/chat/completions`,
		buildAuthHeaders: (key) => ({ authorization: `Bearer ${key}` }),
		sendModel: true,
		resolveKey: () => options.apiKey ?? readEnv("OPENAI_API_KEY"),
		missingKeyMessage: "Missing OpenAI API key — pass `apiKey` to " +
			"createOpenAIAdapter() or set the OPENAI_API_KEY environment variable " +
			"(Deno: requires --allow-env=OPENAI_API_KEY).",
		maxTokensField,
		headers: options.headers,
		fetch: options.fetch,
		capabilities: { jsonSchema: false, jsonMode: false, streaming: false },
	});
}

/** Maps Chat Completions `finish_reason` values to the normalized {@link FinishReason}. */
function mapFinishReason(reason: string | undefined): FinishReason {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "content_filter":
			return "content_filter";
		default:
			return "other";
	}
}

/**
 * Message patterns identifying a context-length 400. OpenAI answers with
 * "This model's maximum context length is X tokens, however you requested …";
 * clones vary in wording but keep the "context length" phrasing.
 */
const CONTEXT_LENGTH_RE =
	/maximum context length|context (length|window)|reduce the length of the (messages|prompt|input)/i;

/** Converts a non-2xx Chat Completions response into a normalized `LLMError`. */
async function toLlmError(response: Response, adapterId: string): Promise<Error> {
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		try {
			raw = await response.text();
		} catch {
			raw = undefined;
		}
	}
	// error bodies look like `{ error: { message, type, param, code } }`
	const err = (raw as { error?: { message?: unknown; code?: unknown } } | undefined)
		?.error;
	const message = typeof err?.message === "string" && err.message
		? err.message
		: typeof raw === "string" && raw.trim()
		? raw.trim()
		: response.statusText || `HTTP ${response.status}`;
	const opts = { adapter: adapterId, raw, cause: raw };

	if (
		response.status === 400 &&
		(err?.code === "context_length_exceeded" || CONTEXT_LENGTH_RE.test(message))
	) {
		return new ContextLengthError(message, { ...opts, status: 400 });
	}
	return errorFromHttpStatus(response.status, message, {
		...opts,
		retryAfter: parseRetryAfter(response.headers.get("retry-after")),
	});
}
