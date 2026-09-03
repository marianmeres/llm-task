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
	InvalidRequestError,
	parseRetryAfter,
	TransientError,
} from "../errors.ts";
import type { JsonSchema } from "../schema.ts";
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
			if (req.jsonSchema) {
				body.response_format = {
					type: "json_schema",
					json_schema: {
						name: "output",
						strict: true,
						schema: normalizeOpenAiJsonSchema(req.jsonSchema, config.id),
					},
				};
			}

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
 * Supports native structured output (`response_format` strict JSON schema) —
 * the schema is normalized to strict mode's restrictions automatically, see
 * {@link normalizeOpenAiJsonSchema}.
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
		capabilities: { jsonSchema: true, jsonMode: false, streaming: false },
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

/**
 * JSON Schema keywords OpenAI strict mode does not support — stripped before
 * sending. When a Standard Schema validator is configured on the task, these
 * constraints are still enforced client-side after parsing.
 *
 * Deliberately errs on the side of stripping: a keyword an endpoint would have
 * accepted costs only a lost hint to the model, while one it rejects fails the
 * whole request with an opaque 400.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"default",
	"minItems",
	"maxItems",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"unevaluatedItems",
	"minProperties",
	"maxProperties",
	"patternProperties",
	"propertyNames",
	"unevaluatedProperties",
];

/** Schema keys whose values are themselves (maps of / arrays of) schemas. */
const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"];
const SCHEMA_LIST_KEYS = ["anyOf", "allOf", "oneOf", "prefixItems"];

/**
 * Normalizes a JSON Schema to OpenAI strict mode's restrictions: recursively
 * sets `additionalProperties: false` on all object schemas, lists every key of
 * `properties` in `required` (strict mode permits no optional keys), and strips
 * unsupported constraint keywords.
 *
 * A property that was optional is widened to accept `null` instead, since that
 * is how strict mode expresses optionality. This changes what the model may
 * return: a `null` where the task's schema wanted a missing key fails
 * client-side validation and costs one repair round-trip. Only a declared
 * `type` can be widened this way — a `$ref`-valued optional property becomes
 * required as-is.
 *
 * Record/map schemas cannot be expressed under these restrictions, so instead
 * of silently destroying their semantics this THROWS {@link InvalidRequestError}
 * for: a schema-valued `additionalProperties` (e.g. zod `z.record(...)`), or an
 * object schema whose only property mechanism is `patternProperties`.
 * Restructure such data as an array of `{ key, value }` objects, or drop the
 * wire schema (prompt-strategy tasks validate client-side only).
 *
 * @param schema The schema to normalize.
 * @param adapterId Adapter id reported on a thrown `InvalidRequestError`.
 */
export function normalizeOpenAiJsonSchema(
	schema: JsonSchema,
	adapterId: string = OPENAI_ADAPTER_ID,
): JsonSchema {
	return walkSchema(schema, adapterId) as JsonSchema;
}

function walkSchema(node: unknown, adapterId: string): unknown {
	if (Array.isArray(node)) return node.map((n) => walkSchema(n, adapterId));
	if (node === null || typeof node !== "object") return node;

	const src = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(src)) {
		if (UNSUPPORTED_SCHEMA_KEYWORDS.includes(key)) continue;
		if (SCHEMA_MAP_KEYS.includes(key) && value && typeof value === "object") {
			const map: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				map[k] = walkSchema(v, adapterId);
			}
			out[key] = map;
		} else if (SCHEMA_LIST_KEYS.includes(key) && Array.isArray(value)) {
			out[key] = value.map((v) => walkSchema(v, adapterId));
		} else if (key === "items") {
			out[key] = walkSchema(value, adapterId);
		} else {
			out[key] = value;
		}
	}

	const isObjectSchema = out.type === "object" || out.properties !== undefined ||
		src.patternProperties !== undefined;
	if (isObjectSchema) {
		// forcing additionalProperties: false onto these would silently rewrite
		// the schema into "always {}" — fail fast instead
		if (src.additionalProperties && typeof src.additionalProperties === "object") {
			throw new InvalidRequestError(
				"OpenAI structured outputs do not support record/map schemas " +
					"(schema-valued `additionalProperties`). Restructure as an array of " +
					"{ key, value } objects, or drop the wire schema.",
				{ adapter: adapterId },
			);
		}
		if (src.patternProperties !== undefined && src.properties === undefined) {
			throw new InvalidRequestError(
				"OpenAI structured outputs do not support `patternProperties` as an " +
					"object schema's only property mechanism. Restructure the schema, or " +
					"drop the wire schema.",
				{ adapter: adapterId },
			);
		}
		out.additionalProperties = false;

		const properties = out.properties as Record<string, unknown> | undefined;
		if (properties && typeof properties === "object") {
			const wasRequired = new Set(
				Array.isArray(src.required) ? (src.required as unknown[]) : [],
			);
			for (const [key, value] of Object.entries(properties)) {
				if (!wasRequired.has(key)) properties[key] = widenWithNull(value);
			}
			out.required = Object.keys(properties);
		}
	}
	return out;
}

/** Adds `"null"` to a schema's declared `type`, leaving anything else alone. */
function widenWithNull(schema: unknown): unknown {
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
		return schema;
	}
	const { type } = schema as { type?: unknown };
	if (typeof type === "string") {
		return type === "null" ? schema : { ...schema, type: [type, "null"] };
	}
	if (Array.isArray(type) && type.every((t) => typeof t === "string")) {
		return type.includes("null") ? schema : { ...schema, type: [...type, "null"] };
	}
	return schema;
}
