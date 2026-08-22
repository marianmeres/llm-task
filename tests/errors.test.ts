import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import {
	AuthError,
	ContextLengthError,
	errorFromHttpStatus,
	InvalidRequestError,
	isRetryableError,
	LLMError,
	OutputValidationError,
	parseRetryAfter,
	RateLimitError,
	TimeoutError,
	TransientError,
	TruncatedOutputError,
} from "../src/errors.ts";

Deno.test("LLMError carries metadata and cause", () => {
	const cause = new Error("boom");
	const e = new LLMError("msg", { adapter: "x", status: 500, cause, raw: { a: 1 } });
	assertEquals(e.name, "LLMError");
	assertEquals(e.adapter, "x");
	assertEquals(e.status, 500);
	assertEquals(e.cause, cause);
	assertEquals(e.raw, { a: 1 });
	assertEquals(e.retryable, false);
});

Deno.test("subclasses set name and instanceof chain", () => {
	const e = new RateLimitError("slow down", { retryAfter: 30 });
	assertEquals(e.name, "RateLimitError");
	assertInstanceOf(e, RateLimitError);
	assertInstanceOf(e, LLMError);
	assertInstanceOf(e, Error);
	assertEquals(e.retryAfter, 30);
});

Deno.test("retryable flags", () => {
	assert(new TransientError("x").retryable);
	assert(new RateLimitError("x").retryable);
	assert(!new AuthError("x").retryable);
	assert(!new ContextLengthError("x").retryable);
	assert(!new InvalidRequestError("x").retryable);
	assert(!new TimeoutError("x").retryable);
	assert(!new TruncatedOutputError("x").retryable);
	assert(!new OutputValidationError("x").retryable);
	assert(isRetryableError(new TransientError("x")));
	assert(!isRetryableError(new Error("x")));
	assert(!isRetryableError("nope"));
});

Deno.test("TruncatedOutputError carries text", () => {
	assertEquals(new TruncatedOutputError("x", { text: "partial" }).text, "partial");
	assertEquals(new TruncatedOutputError("x").text, "");
});

Deno.test("OutputValidationError carries text and issues", () => {
	const e = new OutputValidationError("x", {
		text: "{}",
		issues: [{ message: "missing", path: ["a"] }],
	});
	assertEquals(e.text, "{}");
	assertEquals(e.issues.length, 1);
});

Deno.test("parseRetryAfter parses seconds", () => {
	assertEquals(parseRetryAfter("30"), 30);
	assertEquals(parseRetryAfter("0"), 0);
	assertEquals(parseRetryAfter("-5"), 0);
	assertEquals(parseRetryAfter(null), undefined);
	assertEquals(parseRetryAfter(""), undefined);
	assertEquals(parseRetryAfter("garbage"), undefined);
});

Deno.test("parseRetryAfter parses http-date", () => {
	const future = new Date(Date.now() + 60_000).toUTCString();
	const secs = parseRetryAfter(future)!;
	assert(secs > 55 && secs <= 61, `got ${secs}`);
	// past dates clamp to 0
	assertEquals(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
});

Deno.test("errorFromHttpStatus maps statuses", () => {
	assertInstanceOf(errorFromHttpStatus(401, "x"), AuthError);
	assertInstanceOf(errorFromHttpStatus(403, "x"), AuthError);
	assertInstanceOf(errorFromHttpStatus(408, "x"), TransientError);
	assertInstanceOf(errorFromHttpStatus(413, "x"), ContextLengthError);
	assertInstanceOf(errorFromHttpStatus(429, "x"), RateLimitError);
	assertInstanceOf(errorFromHttpStatus(500, "x"), TransientError);
	assertInstanceOf(errorFromHttpStatus(529, "x"), TransientError);
	assertInstanceOf(errorFromHttpStatus(400, "x"), InvalidRequestError);
	assertInstanceOf(errorFromHttpStatus(404, "x"), InvalidRequestError);
	assertEquals(errorFromHttpStatus(500, "x").status, 500);
	assertEquals(
		(errorFromHttpStatus(429, "x", { retryAfter: 7 }) as RateLimitError).retryAfter,
		7,
	);
});
