/**
 * @module adapter
 *
 * The provider adapter contract. Adapters stay dumb: thin `fetch` + wire-format
 * mapping only (~40 lines for a typical provider). All policy — retries,
 * timeouts, caching, schema strategy, cleaners, truncation guard — lives in the
 * client layer above.
 */

import type { JsonSchema } from "./schema.ts";

/** What a provider adapter natively supports (drives the schema strategy). */
export interface AdapterCapabilities {
	/** Native JSON-schema constrained output (e.g. Anthropic structured outputs). */
	jsonSchema: boolean;
	/** Loose "must be JSON" mode without a schema (e.g. OpenAI `json_object`). */
	jsonMode: boolean;
	/** Streaming support (out of scope in v1 — reserved for a later `stream()`). */
	streaming: boolean;
}

/** Normalized finish reason. */
export type FinishReason = "stop" | "length" | "content_filter" | "other";

/** Normalized token usage. */
export interface CompletionUsage {
	/** Input (prompt) tokens billed. */
	inputTokens: number;
	/** Output (completion) tokens billed. */
	outputTokens: number;
}

/**
 * The single normalized request an adapter receives. Instructions (`system`)
 * and untrusted caller input (`input`) are always separate — never concatenated
 * — which removes the dumbest class of prompt injection.
 */
export interface CompletionRequest {
	/** The task instruction (sent as the provider's system prompt). */
	system?: string;
	/** The untrusted input (sent as a separate user message). */
	input: string;
	/** Provider-native model id (no alias maps — they rot). */
	model: string;
	/** Max output tokens (always set by the client; Anthropic requires it). */
	maxTokens: number;
	/** Sampling temperature, when set. */
	temperature?: number;
	/**
	 * JSON Schema for native structured output. Only set when the client chose
	 * the native strategy (adapter `capabilities.jsonSchema` is `true`).
	 * Normalized by the core; adapters may additionally rewrite it to satisfy
	 * provider-specific schema restrictions.
	 */
	jsonSchema?: JsonSchema;
	/** Composed abort signal (caller signal + local deadline). */
	signal?: AbortSignal;
}

/** The normalized result an adapter returns. */
export interface CompletionResult {
	/** The completion text (all text blocks joined). */
	text: string;
	/** Normalized finish reason. */
	finishReason: FinishReason;
	/** Normalized token usage, when the provider reports it. */
	usage?: CompletionUsage;
	/** The model that answered, as reported by the provider. */
	model: string;
	/** The raw provider response body. Always retained, never swallowed. */
	raw: unknown;
}

/**
 * A provider adapter: one method. Errors thrown from `complete` must be
 * normalized `LLMError` subclasses (use `errorFromHttpStatus` from the errors
 * module) — except caller-initiated aborts, which are re-thrown as-is.
 */
export interface Adapter {
	/** Stable adapter id (used in error metadata and cache keys). */
	readonly id: string;
	/**
	 * Optional configuration fingerprint distinguishing differently configured
	 * instances that share the same `id` (e.g. different base URLs or extra
	 * headers). Mixed into client cache keys, so such instances never collide
	 * on cached completions — important for shared (Redis/KV) caches.
	 */
	readonly fingerprint?: string;
	/** What the provider natively supports. */
	readonly capabilities: AdapterCapabilities;
	/** Performs one completion call. */
	complete(req: CompletionRequest): Promise<CompletionResult>;
}
