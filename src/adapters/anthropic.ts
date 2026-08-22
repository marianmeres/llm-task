/**
 * @module adapters/anthropic
 *
 * Anthropic Messages API adapter. Thin `fetch` + wire-format mapping only —
 * all policy (retries, timeouts, caching, schema strategy) lives in the client.
 */

import { fetchOrThrow, getErrorMessage, HTTP_ERROR } from "@marianmeres/http-utils";
import type {
	Adapter,
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

/** Options for {@link createAnthropicAdapter}. */
export interface AnthropicAdapterOptions {
	/**
	 * Anthropic API key. When omitted, lazily falls back to the
	 * `ANTHROPIC_API_KEY` environment variable (in Deno only when `--allow-env`
	 * was granted — an explicit key never touches the environment).
	 */
	apiKey?: string;
	/**
	 * API base URL (no trailing slash).
	 * @default "https://api.anthropic.com"
	 */
	baseUrl?: string;
	/**
	 * `anthropic-version` header value.
	 * @default "2023-06-01"
	 */
	version?: string;
	/** Extra request headers (e.g. `anthropic-beta`). Merged over the defaults. */
	headers?: Record<string, string>;
	/**
	 * Injectable `fetch` implementation (handy for tests — no network, no keys).
	 * Defaults to `fetchOrThrow` from `@marianmeres/http-utils` (native `fetch`
	 * with normalized transport errors).
	 */
	fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const ADAPTER_ID = "anthropic";

/** Minimal shape of an Anthropic Messages API success response. */
interface AnthropicMessage {
	content?: { type: string; text?: string }[];
	stop_reason?: string;
	usage?: { input_tokens?: number; output_tokens?: number };
	model?: string;
}

/**
 * Creates the Anthropic Messages API adapter.
 *
 * Supports native structured output (`output_config.format` JSON schema) —
 * the schema is normalized to Anthropic's restrictions automatically (all
 * objects get `additionalProperties: false`, unsupported numeric/string
 * constraints are stripped; when a Standard Schema validator is also configured
 * on the task, the stripped constraints are still enforced client-side).
 *
 * @example
 * ```typescript
 * import { createAnthropicAdapter, createLlmClient } from "@marianmeres/llm-task";
 *
 * const client = createLlmClient({
 * 	adapter: createAnthropicAdapter({ apiKey: "sk-ant-..." }),
 * 	model: "claude-haiku-4-5",
 * });
 * ```
 */
export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): Adapter {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const version = options.version ?? DEFAULT_VERSION;
	const doFetch = options.fetch ?? fetchOrThrow;

	return {
		id: ADAPTER_ID,
		// distinguishes differently configured instances in client cache keys
		fingerprint: `${baseUrl}|${version}|${stableStringify(options.headers ?? {})}`,
		capabilities: { jsonSchema: true, jsonMode: false, streaming: false },
		async complete(req: CompletionRequest): Promise<CompletionResult> {
			const apiKey = options.apiKey ?? readEnv("ANTHROPIC_API_KEY");
			if (!apiKey) {
				throw new AuthError(
					"Missing Anthropic API key — pass `apiKey` to createAnthropicAdapter() " +
						"or set the ANTHROPIC_API_KEY environment variable " +
						"(Deno: requires --allow-env=ANTHROPIC_API_KEY).",
					{ adapter: ADAPTER_ID },
				);
			}

			const body: Record<string, unknown> = {
				model: req.model,
				max_tokens: req.maxTokens,
				messages: [{ role: "user", content: req.input }],
			};
			if (req.system !== undefined) body.system = req.system;
			if (req.temperature !== undefined) body.temperature = req.temperature;
			if (req.jsonSchema) {
				body.output_config = {
					format: {
						type: "json_schema",
						schema: normalizeJsonSchema(req.jsonSchema),
					},
				};
			}

			let response: Response;
			try {
				response = await doFetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": version,
						...options.headers,
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
						adapter: ADAPTER_ID,
						cause: e.cause ?? e,
					});
				}
				throw new TransientError(getErrorMessage(e), {
					adapter: ADAPTER_ID,
					cause: e,
				});
			}

			if (!response.ok) throw await toLlmError(response);

			let data: AnthropicMessage;
			try {
				data = (await response.json()) as AnthropicMessage;
			} catch (e) {
				// a proxy/gateway answering 2xx with a non-JSON body must still
				// surface as a normalized (retryable) error, not a bare SyntaxError
				throw new TransientError(
					`Anthropic returned a non-JSON success body: ${getErrorMessage(e)}`,
					{ adapter: ADAPTER_ID, status: response.status, cause: e },
				);
			}
			const text = (data.content ?? [])
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("");

			return {
				text,
				finishReason: mapStopReason(data.stop_reason),
				usage: data.usage
					? {
						inputTokens: data.usage.input_tokens ?? 0,
						outputTokens: data.usage.output_tokens ?? 0,
					}
					: undefined,
				model: data.model ?? req.model,
				raw: data,
			};
		},
	};
}

/** Maps Anthropic `stop_reason` values to the normalized {@link FinishReason}. */
function mapStopReason(reason: string | undefined): FinishReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "refusal":
			return "content_filter";
		default:
			return "other";
	}
}

/**
 * Message patterns that identify a context-length 400 on Anthropic. Covers the
 * real-world shapes "prompt is too long: X tokens > Y maximum" and "input
 * length and `max_tokens` exceed context limit: ...". Deliberately does NOT
 * match the output-cap config error ("max_tokens: X > Y, which is the maximum
 * allowed number of output tokens for <model>") — that is an invalid request,
 * not an oversized input.
 */
const CONTEXT_LENGTH_RE =
	/prompt is too long|context (length|window)|exceeds? (the )?context limit/i;

/** Converts a non-2xx Anthropic response into a normalized `LLMError`. */
async function toLlmError(response: Response): Promise<Error> {
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
	// Anthropic error bodies look like `{type: "error", error: {type, message}}`
	const providerMsg = (raw as { error?: { message?: unknown } } | undefined)?.error
		?.message;
	const message = typeof providerMsg === "string" && providerMsg
		? providerMsg
		: typeof raw === "string" && raw.trim()
		? raw.trim()
		: response.statusText || `HTTP ${response.status}`;
	const opts = { adapter: ADAPTER_ID, raw, cause: raw };

	if (response.status === 400 && CONTEXT_LENGTH_RE.test(message)) {
		return new ContextLengthError(message, { ...opts, status: 400 });
	}
	return errorFromHttpStatus(response.status, message, {
		...opts,
		retryAfter: parseRetryAfter(response.headers.get("retry-after")),
	});
}

/**
 * JSON Schema keywords Anthropic structured outputs do not support — stripped
 * before sending. When a Standard Schema validator is configured on the task,
 * these constraints are still enforced client-side after parsing.
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
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"patternProperties",
	"propertyNames",
];

/** Schema keys whose values are themselves (maps of / arrays of) schemas. */
const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"];
const SCHEMA_LIST_KEYS = ["anyOf", "allOf", "oneOf", "prefixItems"];

/**
 * Normalizes a JSON Schema to Anthropic's structured output restrictions:
 * recursively sets `additionalProperties: false` on all object schemas and
 * strips unsupported constraint keywords.
 *
 * Record/map schemas cannot be expressed under these restrictions, so instead
 * of silently destroying their semantics this THROWS {@link InvalidRequestError}
 * for: a schema-valued `additionalProperties` (e.g. zod `z.record(...)`), or an
 * object schema whose only property mechanism is `patternProperties`.
 * Restructure such data as an array of `{ key, value }` objects, or drop the
 * wire schema (prompt-strategy tasks validate client-side only).
 */
export function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
	return walkSchema(schema) as JsonSchema;
}

function walkSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(walkSchema);
	if (node === null || typeof node !== "object") return node;

	const src = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(src)) {
		if (UNSUPPORTED_SCHEMA_KEYWORDS.includes(key)) continue;
		if (SCHEMA_MAP_KEYS.includes(key) && value && typeof value === "object") {
			const map: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				map[k] = walkSchema(v);
			}
			out[key] = map;
		} else if (SCHEMA_LIST_KEYS.includes(key) && Array.isArray(value)) {
			out[key] = value.map(walkSchema);
		} else if (key === "items") {
			out[key] = walkSchema(value);
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
				"Anthropic structured outputs do not support record/map schemas " +
					"(schema-valued `additionalProperties`). Restructure as an array of " +
					"{ key, value } objects, or drop the wire schema.",
				{ adapter: ADAPTER_ID },
			);
		}
		if (src.patternProperties !== undefined && src.properties === undefined) {
			throw new InvalidRequestError(
				"Anthropic structured outputs do not support `patternProperties` as an " +
					"object schema's only property mechanism. Restructure the schema, or " +
					"drop the wire schema.",
				{ adapter: ADAPTER_ID },
			);
		}
		out.additionalProperties = false;
	}
	return out;
}
