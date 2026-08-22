/**
 * @module errors
 *
 * Normalized error taxonomy for LLM calls. Every rejection this package produces
 * (other than programmer-error `TypeError`s and caller-initiated aborts) is an
 * `LLMError` subclass, so consumers can branch on `instanceof` rather than
 * provider-specific status codes or error body shapes.
 */

/** Options bag accepted by {@link LLMError} and its subclasses. */
export interface LLMErrorOptions {
	/** Id of the adapter that produced the error (e.g. `"anthropic"`). */
	adapter?: string;
	/** HTTP status code, when the error originates from an HTTP response. */
	status?: number;
	/** The original underlying error or error payload. Never swallowed. */
	cause?: unknown;
	/** The raw provider response body (parsed when possible). Never swallowed. */
	raw?: unknown;
}

/**
 * Base class for all normalized LLM errors.
 *
 * The original provider error is always retained: `cause` carries the underlying
 * error/payload and `raw` the raw response body, so nothing is ever swallowed.
 *
 * @example
 * ```typescript
 * import { LLMError, RateLimitError } from "@marianmeres/llm-task";
 *
 * try {
 * 	await toTitle(input);
 * } catch (e) {
 * 	if (e instanceof RateLimitError) console.log("retry after", e.retryAfter);
 * 	else if (e instanceof LLMError) console.log(e.adapter, e.status, e.message);
 * }
 * ```
 */
export class LLMError extends Error {
	/** Id of the adapter that produced the error (e.g. `"anthropic"`). */
	readonly adapter?: string;
	/** HTTP status code, when the error originates from an HTTP response. */
	readonly status?: number;
	/** The raw provider response body (parsed when possible). */
	readonly raw?: unknown;
	/** Whether the client's retry policy may retry on this error. */
	readonly retryable: boolean = false;

	constructor(message: string, options: LLMErrorOptions = {}) {
		super(message, { cause: options.cause });
		// `new.target.name` survives subclassing (and minification renames
		// consistently), so `e.name` always matches the concrete class.
		this.name = new.target.name;
		this.adapter = options.adapter;
		this.status = options.status;
		this.raw = options.raw;
	}
}

/** Bad or missing API key (HTTP 401/403). Not retryable. */
export class AuthError extends LLMError {}

/** Options bag for {@link RateLimitError}. */
export interface RateLimitErrorOptions extends LLMErrorOptions {
	/** Seconds to wait before retrying, as reported by the provider. */
	retryAfter?: number;
}

/** Provider rate limit hit (HTTP 429). Retryable. */
export class RateLimitError extends LLMError {
	override readonly retryable: boolean = true;
	/** Seconds to wait before retrying (from the `Retry-After` header), if reported. */
	readonly retryAfter?: number;

	constructor(message: string, options: RateLimitErrorOptions = {}) {
		super(message, options);
		this.retryAfter = options.retryAfter;
	}
}

/** Input too long for the model's context window. Not retryable. */
export class ContextLengthError extends LLMError {}

/** The provider refused or filtered the request/response. Not retryable. */
export class ContentFilterError extends LLMError {}

/** Malformed request rejected by the provider (400-class). Not retryable. */
export class InvalidRequestError extends LLMError {}

/** Transient failure: 5xx, overloaded, network error. Retryable. */
export class TransientError extends LLMError {
	override readonly retryable: boolean = true;
}

/**
 * The local per-call deadline (`timeoutMs`) was exceeded. Not auto-retried by
 * the client (retrying would overshoot the caller's deadline) — whether to try
 * again is the caller's choice.
 */
export class TimeoutError extends LLMError {}

/** Options bag for {@link TruncatedOutputError}. */
export interface TruncatedOutputErrorOptions extends LLMErrorOptions {
	/** The partial (truncated) model output. */
	text?: string;
}

/**
 * The model stopped because `maxTokens` was reached (`finishReason: "length"`).
 * Thrown by default so silently truncated output can never masquerade as a
 * complete result. Opt out per task via `allowTruncated: true`. Not retryable.
 */
export class TruncatedOutputError extends LLMError {
	/** The partial (truncated) model output. */
	readonly text: string;

	constructor(message: string, options: TruncatedOutputErrorOptions = {}) {
		super(message, options);
		this.text = options.text ?? "";
	}
}

/** A single validation issue (Standard Schema compatible shape). */
export interface ValidationIssue {
	/** Human readable issue description. */
	readonly message: string;
	/** Path to the offending value, if known. */
	readonly path?:
		| ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
		| undefined;
}

/** Options bag for {@link OutputValidationError}. */
export interface OutputValidationErrorOptions extends LLMErrorOptions {
	/** The final (failing) model output text. */
	text?: string;
	/** The validation issues of the final attempt. */
	issues?: readonly ValidationIssue[];
}

/**
 * Structured output failed JSON parsing or schema validation even after the
 * single repair attempt. Carries the failing `text` and the `issues`.
 * Not retryable.
 */
export class OutputValidationError extends LLMError {
	/** The final (failing) model output text. */
	readonly text: string;
	/** The validation issues of the final attempt. */
	readonly issues: readonly ValidationIssue[];

	constructor(message: string, options: OutputValidationErrorOptions = {}) {
		super(message, options);
		this.text = options.text ?? "";
		this.issues = options.issues ?? [];
	}
}

/**
 * Returns `true` if the error is an {@link LLMError} the retry policy may retry
 * ({@link TransientError} or {@link RateLimitError}).
 */
export function isRetryableError(e: unknown): boolean {
	return e instanceof LLMError && e.retryable;
}

/**
 * Parses a `Retry-After` HTTP header value into seconds. Supports both the
 * delta-seconds form (`"30"`) and the HTTP-date form.
 *
 * @returns Seconds to wait (>= 0), or `undefined` when unparseable/absent.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const secs = Number(value);
	if (Number.isFinite(secs)) return Math.max(0, secs);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
	return undefined;
}

/** Options bag for {@link errorFromHttpStatus}. */
export interface ErrorFromHttpStatusOptions extends LLMErrorOptions {
	/** Seconds to wait before retrying (for 429 responses). */
	retryAfter?: number;
}

/**
 * Maps an HTTP status code to the corresponding {@link LLMError} subclass.
 * Shared helper for adapters, so a new adapter only has to extract the status,
 * message and (optionally) `Retry-After` from its provider's wire format:
 *
 * - 401, 403 → {@link AuthError}
 * - 408 → {@link TransientError}
 * - 413 → {@link ContextLengthError}
 * - 429 → {@link RateLimitError}
 * - 5xx → {@link TransientError}
 * - anything else (400-class) → {@link InvalidRequestError}
 *
 * (Context-length 400s are provider specific — detect them from the error
 * message in the adapter and throw {@link ContextLengthError} directly.)
 */
export function errorFromHttpStatus(
	status: number,
	message: string,
	options: ErrorFromHttpStatusOptions = {},
): LLMError {
	const opts = { ...options, status };
	if (status === 401 || status === 403) return new AuthError(message, opts);
	if (status === 408) return new TransientError(message, opts);
	if (status === 413) return new ContextLengthError(message, opts);
	if (status === 429) return new RateLimitError(message, opts);
	if (status >= 500) return new TransientError(message, opts);
	return new InvalidRequestError(message, opts);
}
