import {
	assert,
	assertEquals,
	assertRejects,
	assertStringIncludes,
	assertThrows,
} from "@std/assert";
import {
	createAnthropicAdapter,
	normalizeJsonSchema,
} from "../src/adapters/anthropic.ts";
import {
	AuthError,
	ContextLengthError,
	InvalidRequestError,
	RateLimitError,
	TransientError,
} from "../src/errors.ts";

/** Captured request info from the fetch stub. */
interface Captured {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** DI-style fetch stub (no globals touched) — mirrors the ecosystem pattern. */
function makeFetch(
	respond: (call: Captured) => Response | Promise<Response> | never,
): { fetch: typeof globalThis.fetch; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetchStub = async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
		const call: Captured = {
			url: String(input),
			method: init?.method,
			headers,
			body: JSON.parse(String(init?.body ?? "null")),
		};
		calls.push(call);
		if (init?.signal?.aborted) throw init.signal.reason;
		return await respond(call);
	};
	return { fetch: fetchStub as typeof globalThis.fetch, calls };
}

const okBody = (over: Record<string, unknown> = {}) =>
	new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			model: "claude-haiku-4-5",
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
			...over,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

const errBody = (
	status: number,
	type: string,
	message: string,
	headers: Record<string, string> = {},
) => new Response(JSON.stringify({ type: "error", error: { type, message } }), {
	status,
	headers,
});

const req = {
	input: "some input",
	model: "claude-haiku-4-5",
	maxTokens: 64,
};

Deno.test("anthropic: sends correct wire format", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAnthropicAdapter({ apiKey: "sk-test", fetch });

	const result = await adapter.complete({
		...req,
		system: "Summarize.",
		temperature: 0.2,
	});

	assertEquals(calls.length, 1);
	assertEquals(calls[0].url, "https://api.anthropic.com/v1/messages");
	assertEquals(calls[0].method, "POST");
	assertEquals(calls[0].headers["x-api-key"], "sk-test");
	assertEquals(calls[0].headers["anthropic-version"], "2023-06-01");
	assertEquals(calls[0].headers["content-type"], "application/json");
	assertEquals(calls[0].body, {
		model: "claude-haiku-4-5",
		max_tokens: 64,
		messages: [{ role: "user", content: "some input" }],
		system: "Summarize.",
		temperature: 0.2,
	});
	assertEquals(result.text, "Hello");
	assertEquals(result.finishReason, "stop");
	assertEquals(result.usage, { inputTokens: 10, outputTokens: 5 });
	assertEquals(result.model, "claude-haiku-4-5");
	assert(result.raw);
});

Deno.test("anthropic: omits optional fields when unset", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAnthropicAdapter({ apiKey: "sk-test", fetch });
	await adapter.complete({ ...req });
	assert(!("system" in calls[0].body));
	assert(!("temperature" in calls[0].body));
	assert(!("output_config" in calls[0].body));
});

Deno.test("anthropic: custom baseUrl, version, headers", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAnthropicAdapter({
		apiKey: "sk-test",
		fetch,
		baseUrl: "https://proxy.example.com/",
		version: "2099-01-01",
		headers: { "anthropic-beta": "some-beta" },
	});
	await adapter.complete({ ...req });
	assertEquals(calls[0].url, "https://proxy.example.com/v1/messages");
	assertEquals(calls[0].headers["anthropic-version"], "2099-01-01");
	assertEquals(calls[0].headers["anthropic-beta"], "some-beta");
});

Deno.test("anthropic: sends normalized output_config for jsonSchema", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAnthropicAdapter({ apiKey: "sk-test", fetch });
	await adapter.complete({
		...req,
		jsonSchema: {
			type: "object",
			properties: { n: { type: "number", minimum: 0 } },
			required: ["n"],
		},
	});
	assertEquals(calls[0].body.output_config, {
		format: {
			type: "json_schema",
			schema: {
				type: "object",
				properties: { n: { type: "number" } },
				required: ["n"],
				additionalProperties: false,
			},
		},
	});
});

Deno.test("anthropic: joins multiple text blocks", async () => {
	const { fetch } = makeFetch(() =>
		okBody({
			content: [
				{ type: "text", text: "A" },
				{ type: "tool_use", id: "x" },
				{ type: "text", text: "B" },
			],
		})
	);
	const adapter = createAnthropicAdapter({ apiKey: "sk-test", fetch });
	assertEquals((await adapter.complete({ ...req })).text, "AB");
});

Deno.test("anthropic: maps stop reasons", async () => {
	for (
		const [wire, normalized] of [
			["end_turn", "stop"],
			["stop_sequence", "stop"],
			["max_tokens", "length"],
			["refusal", "content_filter"],
			["pause_turn", "other"],
		] as const
	) {
		const { fetch } = makeFetch(() => okBody({ stop_reason: wire }));
		const adapter = createAnthropicAdapter({ apiKey: "sk-test", fetch });
		assertEquals((await adapter.complete({ ...req })).finishReason, normalized);
	}
});

Deno.test("anthropic: missing api key throws AuthError without fetch", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAnthropicAdapter({ fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertStringIncludes(e.message, "ANTHROPIC_API_KEY");
	assertEquals(calls.length, 0);
});

Deno.test("anthropic: maps 401 to AuthError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(401, "authentication_error", "invalid x-api-key")
	);
	const adapter = createAnthropicAdapter({ apiKey: "bad", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertEquals(e.status, 401);
	assertStringIncludes(e.message, "invalid x-api-key");
	assert(e.raw);
});

Deno.test("anthropic: maps 429 to RateLimitError with retryAfter", async () => {
	const { fetch } = makeFetch(() =>
		errBody(429, "rate_limit_error", "slow down", { "retry-after": "12" })
	);
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), RateLimitError);
	assertEquals(e.retryAfter, 12);
});

Deno.test("anthropic: maps 400 to InvalidRequestError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(400, "invalid_request_error", "max_tokens: must be positive")
	);
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	await assertRejects(() => adapter.complete({ ...req }), InvalidRequestError);
});

Deno.test("anthropic: maps context-length 400 to ContextLengthError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(
			400,
			"invalid_request_error",
			"prompt is too long: 250000 tokens > 200000",
		)
	);
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	await assertRejects(() => adapter.complete({ ...req }), ContextLengthError);
});

Deno.test("anthropic: maps 413 to ContextLengthError", async () => {
	const { fetch } = makeFetch(() => errBody(413, "request_too_large", "too large"));
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	await assertRejects(() => adapter.complete({ ...req }), ContextLengthError);
});

Deno.test("anthropic: maps 500/529 to TransientError", async () => {
	for (
		const [status, type] of [[500, "api_error"], [529, "overloaded_error"]] as const
	) {
		const { fetch } = makeFetch(() => errBody(status, type, "upstream sad"));
		const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
		const e = await assertRejects(() => adapter.complete({ ...req }), TransientError);
		assertEquals(e.status, status);
	}
});

Deno.test("anthropic: non-json error body still maps", async () => {
	const { fetch } = makeFetch(() => new Response("Bad Gateway", { status: 502 }));
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), TransientError);
	assertEquals(e.status, 502);
});

Deno.test("anthropic: transport failure maps to TransientError", async () => {
	const boom = new TypeError("fetch failed");
	const { fetch } = makeFetch(() => {
		throw boom;
	});
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), TransientError);
	assertEquals(e.cause, boom);
});

Deno.test("anthropic: abort passes through untouched", async () => {
	const { fetch } = makeFetch(() => okBody());
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	const ctrl = new AbortController();
	const reason = new DOMException("cancelled", "AbortError");
	ctrl.abort(reason);
	const e = await assertRejects(() =>
		adapter.complete({ ...req, signal: ctrl.signal })
	);
	assertEquals(e, reason);
});

Deno.test("normalizeJsonSchema strips unsupported keywords recursively", () => {
	assertEquals(
		normalizeJsonSchema({
			type: "object",
			properties: {
				name: { type: "string", minLength: 1, maxLength: 10, pattern: "^a" },
				tags: {
					type: "array",
					minItems: 1,
					uniqueItems: true,
					items: { type: "object", properties: { id: { type: "integer" } } },
				},
				choice: {
					anyOf: [{ type: "string" }, { type: "number", multipleOf: 2 }],
				},
			},
			required: ["name"],
		}),
		{
			type: "object",
			properties: {
				name: { type: "string" },
				tags: {
					type: "array",
					items: {
						type: "object",
						properties: { id: { type: "integer" } },
						additionalProperties: false,
					},
				},
				choice: { anyOf: [{ type: "string" }, { type: "number" }] },
			},
			required: ["name"],
			additionalProperties: false,
		},
	);
});

// -- review-workflow regression tests ----------------------------------------

Deno.test("anthropic: classifies real-world 400 messages correctly", async () => {
	// context overflow message (no "prompt is too long" wording)
	{
		const { fetch } = makeFetch(() =>
			errBody(
				400,
				"invalid_request_error",
				"input length and `max_tokens` exceed context limit: 200708 + 1024 > " +
					"200000, decrease input length or `max_tokens` and try again",
			)
		);
		const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
		await assertRejects(() => adapter.complete({ ...req }), ContextLengthError);
	}
	// output-cap config error must NOT be a context-length error
	{
		const { fetch } = makeFetch(() =>
			errBody(
				400,
				"invalid_request_error",
				"max_tokens: 100000 > 64000, which is the maximum allowed number of " +
					"output tokens for claude-haiku-4-5",
			)
		);
		const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
		await assertRejects(() => adapter.complete({ ...req }), InvalidRequestError);
	}
});

Deno.test("anthropic: 200 with non-JSON body maps to TransientError", async () => {
	const { fetch } = makeFetch(() =>
		new Response("<html>proxy</html>", { status: 200 })
	);
	const adapter = createAnthropicAdapter({ apiKey: "k", fetch });
	await assertRejects(() => adapter.complete({ ...req }), TransientError);
});

Deno.test("normalizeJsonSchema rejects record/map schemas", () => {
	assertThrows(
		() =>
			normalizeJsonSchema({
				type: "object",
				additionalProperties: { type: "string" },
			}),
		InvalidRequestError,
		"record/map",
	);
	assertThrows(
		() =>
			normalizeJsonSchema({
				type: "object",
				patternProperties: { "^x": { type: "string" } },
			}),
		InvalidRequestError,
		"patternProperties",
	);
	// patternProperties alongside real properties is stripped, not rejected
	assertEquals(
		normalizeJsonSchema({
			type: "object",
			properties: { a: { type: "string" } },
			patternProperties: { "^x": {} },
		}),
		{
			type: "object",
			properties: { a: { type: "string" } },
			additionalProperties: false,
		},
	);
});

Deno.test("anthropic: fingerprint distinguishes configurations", () => {
	const a = createAnthropicAdapter({ apiKey: "k" });
	const b = createAnthropicAdapter({ apiKey: "k", baseUrl: "https://p.example.com" });
	const c = createAnthropicAdapter({ apiKey: "k", headers: { "anthropic-beta": "x" } });
	assert(a.fingerprint && b.fingerprint && c.fingerprint);
	assert(a.fingerprint !== b.fingerprint);
	assert(a.fingerprint !== c.fingerprint);
	// same config -> same fingerprint (stable cache keys across instances)
	assertEquals(a.fingerprint, createAnthropicAdapter({ apiKey: "other" }).fingerprint);
});
