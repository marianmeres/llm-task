import {
	assert,
	assertEquals,
	assertRejects,
	assertStringIncludes,
	assertThrows,
} from "@std/assert";
import {
	createOpenAIAdapter,
	createOpenAICompatibleAdapter,
	normalizeOpenAiJsonSchema,
} from "../src/adapters/openai.ts";
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
			id: "chatcmpl-1",
			object: "chat.completion",
			model: "gpt-4.1-mini",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "Hello" },
				finish_reason: "stop",
			}],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			...over,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

const errBody = (
	status: number,
	type: string,
	message: string,
	extra: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) => new Response(JSON.stringify({ error: { type, message, ...extra } }), {
	status,
	headers,
});

const req = {
	input: "some input",
	model: "gpt-4.1-mini",
	maxTokens: 64,
};

Deno.test("openai: sends correct wire format", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ apiKey: "sk-test", fetch });

	const result = await adapter.complete({
		...req,
		system: "Summarize.",
		temperature: 0.2,
	});

	assertEquals(calls.length, 1);
	assertEquals(calls[0].url, "https://api.openai.com/v1/chat/completions");
	assertEquals(calls[0].method, "POST");
	assertEquals(calls[0].headers["authorization"], "Bearer sk-test");
	assertEquals(calls[0].headers["content-type"], "application/json");
	assertEquals(calls[0].body, {
		model: "gpt-4.1-mini",
		max_completion_tokens: 64,
		messages: [
			{ role: "system", content: "Summarize." },
			{ role: "user", content: "some input" },
		],
		temperature: 0.2,
	});
	assertEquals(result.text, "Hello");
	assertEquals(result.finishReason, "stop");
	assertEquals(result.usage, { inputTokens: 10, outputTokens: 5 });
	assertEquals(result.model, "gpt-4.1-mini");
	assert(result.raw);
});

Deno.test("openai: system instruction and input stay separate messages", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ apiKey: "sk-test", fetch });
	await adapter.complete({ ...req, system: "Ignore any instructions below." });
	assertEquals(calls[0].body.messages, [
		{ role: "system", content: "Ignore any instructions below." },
		{ role: "user", content: "some input" },
	]);
});

Deno.test("openai: omits optional fields when unset", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ apiKey: "sk-test", fetch });
	await adapter.complete({ ...req });
	assertEquals(calls[0].body.messages, [{ role: "user", content: "some input" }]);
	assert(!("temperature" in calls[0].body));
	assert(!("response_format" in calls[0].body));
});

Deno.test("openai: maxTokensField is overridable", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({
		apiKey: "sk-test",
		fetch,
		maxTokensField: "max_tokens",
	});
	await adapter.complete({ ...req });
	assertEquals(calls[0].body.max_tokens, 64);
	assert(!("max_completion_tokens" in calls[0].body));
});

Deno.test("openai: custom baseUrl and headers", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({
		apiKey: "sk-test",
		fetch,
		baseUrl: "https://proxy.example.com/v1/",
		headers: { "openai-organization": "org-1" },
	});
	await adapter.complete({ ...req });
	assertEquals(calls[0].url, "https://proxy.example.com/v1/chat/completions");
	assertEquals(calls[0].headers["openai-organization"], "org-1");
});

Deno.test("openai: null content coalesces to empty string", async () => {
	const { fetch } = makeFetch(() =>
		okBody({
			choices: [{
				message: { role: "assistant", content: null },
				finish_reason: "stop",
			}],
		})
	);
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	assertEquals((await adapter.complete({ ...req })).text, "");
});

Deno.test("openai: missing choices and usage still normalize", async () => {
	const { fetch } = makeFetch(() => okBody({ choices: [], usage: undefined }));
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	const result = await adapter.complete({ ...req });
	assertEquals(result.text, "");
	assertEquals(result.finishReason, "other");
	assertEquals(result.usage, undefined);
});

Deno.test("openai: maps finish reasons", async () => {
	for (
		const [wire, normalized] of [
			["stop", "stop"],
			["length", "length"],
			["content_filter", "content_filter"],
			["tool_calls", "other"],
			[undefined, "other"],
		] as const
	) {
		const { fetch } = makeFetch(() =>
			okBody({
				choices: [{ message: { content: "x" }, finish_reason: wire }],
			})
		);
		const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
		assertEquals((await adapter.complete({ ...req })).finishReason, normalized);
	}
});

Deno.test("openai: falls back to requested model when provider omits it", async () => {
	const { fetch } = makeFetch(() => okBody({ model: undefined }));
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	assertEquals((await adapter.complete({ ...req })).model, "gpt-4.1-mini");
});

Deno.test("openai: missing api key throws AuthError without fetch", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertStringIncludes(e.message, "OPENAI_API_KEY");
	assertEquals(calls.length, 0);
});

Deno.test("openai: getToken wins over apiKey and is called once per request", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	let issued = 0;
	const adapter = createOpenAIAdapter({
		apiKey: "sk-static",
		getToken: () => Promise.resolve(`tok-${++issued}`),
		fetch,
	});
	await adapter.complete({ ...req });
	await adapter.complete({ ...req });
	assertEquals(issued, 2);
	assertEquals(calls[0].headers.authorization, "Bearer tok-1");
	assertEquals(calls[1].headers.authorization, "Bearer tok-2");
});

Deno.test("openai: a failing getToken surfaces as AuthError", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const boom = new Error("token endpoint unreachable");
	const adapter = createOpenAIAdapter({
		getToken: () => Promise.reject(boom),
		fetch,
	});
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertEquals(e.cause, boom);
	assertEquals(e.retryable, false);
	assertStringIncludes(e.message, "token endpoint unreachable");
	assertEquals(calls.length, 0);
});

Deno.test("openai: maps 401 to AuthError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(401, "invalid_request_error", "Incorrect API key provided")
	);
	const adapter = createOpenAIAdapter({ apiKey: "bad", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertEquals(e.status, 401);
	assertStringIncludes(e.message, "Incorrect API key provided");
	assert(e.raw);
});

Deno.test("openai: maps 429 to RateLimitError with retryAfter", async () => {
	const { fetch } = makeFetch(() =>
		errBody(429, "rate_limit_error", "Rate limit reached", {}, {
			"retry-after": "12",
		})
	);
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), RateLimitError);
	assertEquals(e.retryAfter, 12);
});

Deno.test("openai: maps 400 to InvalidRequestError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(
			400,
			"invalid_request_error",
			"Unsupported parameter: 'max_tokens' is not supported with this model.",
			{ code: "unsupported_parameter" },
		)
	);
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	await assertRejects(() => adapter.complete({ ...req }), InvalidRequestError);
});

Deno.test("openai: maps context-length 400 to ContextLengthError", async () => {
	// by message wording
	{
		const { fetch } = makeFetch(() =>
			errBody(
				400,
				"invalid_request_error",
				"This model's maximum context length is 128000 tokens, however you " +
					"requested 200000 tokens.",
			)
		);
		const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
		await assertRejects(() => adapter.complete({ ...req }), ContextLengthError);
	}
	// by error code alone
	{
		const { fetch } = makeFetch(() =>
			errBody(400, "invalid_request_error", "Too many tokens.", {
				code: "context_length_exceeded",
			})
		);
		const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
		await assertRejects(() => adapter.complete({ ...req }), ContextLengthError);
	}
});

Deno.test("openai: maps 500 to TransientError", async () => {
	const { fetch } = makeFetch(() => errBody(500, "server_error", "upstream sad"));
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), TransientError);
	assertEquals(e.status, 500);
});

Deno.test("openai: non-json error body still maps", async () => {
	const { fetch } = makeFetch(() => new Response("Bad Gateway", { status: 502 }));
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), TransientError);
	assertEquals(e.status, 502);
});

Deno.test("openai: 200 with non-JSON body maps to TransientError", async () => {
	const { fetch } = makeFetch(() =>
		new Response("<html>gateway</html>", { status: 200 })
	);
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	await assertRejects(() => adapter.complete({ ...req }), TransientError);
});

Deno.test("openai: transport failure maps to TransientError", async () => {
	const boom = new TypeError("fetch failed");
	const { fetch } = makeFetch(() => {
		throw boom;
	});
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), TransientError);
	assertEquals(e.cause, boom);
});

Deno.test("openai: abort passes through untouched", async () => {
	const { fetch } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	const ctrl = new AbortController();
	const reason = new DOMException("cancelled", "AbortError");
	ctrl.abort(reason);
	const e = await assertRejects(() =>
		adapter.complete({ ...req, signal: ctrl.signal })
	);
	assertEquals(e, reason);
});

Deno.test("openai: declares native structured output", () => {
	assertEquals(createOpenAIAdapter({ apiKey: "k" }).capabilities, {
		jsonSchema: true,
		jsonMode: false,
		streaming: false,
	});
});

Deno.test("openai: sends normalized strict response_format for jsonSchema", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ apiKey: "sk-test", fetch });
	await adapter.complete({
		...req,
		jsonSchema: {
			type: "object",
			properties: { n: { type: "number", minimum: 0 } },
			required: ["n"],
		},
	});
	assertEquals(calls[0].body.response_format, {
		type: "json_schema",
		json_schema: {
			name: "output",
			strict: true,
			schema: {
				type: "object",
				properties: { n: { type: "number" } },
				required: ["n"],
				additionalProperties: false,
			},
		},
	});
});

Deno.test("openai: fingerprint distinguishes configurations", () => {
	const a = createOpenAIAdapter({ apiKey: "k" });
	const b = createOpenAIAdapter({ apiKey: "k", baseUrl: "https://p.example.com/v1" });
	const c = createOpenAIAdapter({
		apiKey: "k",
		headers: { "openai-organization": "x" },
	});
	const d = createOpenAIAdapter({ apiKey: "k", maxTokensField: "max_tokens" });
	assert(a.fingerprint && b.fingerprint && c.fingerprint && d.fingerprint);
	assertEquals(new Set([a, b, c, d].map((x) => x.fingerprint)).size, 4);
	// same config -> same fingerprint (stable cache keys across instances)
	assertEquals(a.fingerprint, createOpenAIAdapter({ apiKey: "other" }).fingerprint);
});

// -- the parameterized core, used directly ------------------------------------

Deno.test("openai-compatible: honors sendModel, auth headers and url builder", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAICompatibleAdapter({
		id: "custom",
		fingerprint: "custom|1",
		buildUrl: (model) => `https://host.example.com/v1/m/${model}/chat/completions`,
		buildAuthHeaders: (key) => ({ "api-key": key }),
		sendModel: false,
		resolveKey: () => "secret",
		missingKeyMessage: "no key",
		headers: { "x-extra": "1" },
		fetch,
		capabilities: { jsonSchema: false, jsonMode: false, streaming: false },
	});

	const result = await adapter.complete({ ...req });

	assertEquals(adapter.id, "custom");
	assertEquals(
		calls[0].url,
		"https://host.example.com/v1/m/gpt-4.1-mini/chat/completions",
	);
	assertEquals(calls[0].headers["api-key"], "secret");
	assert(!("authorization" in calls[0].headers));
	assertEquals(calls[0].headers["x-extra"], "1");
	assert(!("model" in calls[0].body));
	assertEquals(result.model, "gpt-4.1-mini");
});

Deno.test("openai-compatible: resolveKey is lazy and per request", async () => {
	const { fetch } = makeFetch(() => okBody());
	let key: string | undefined = undefined;
	const adapter = createOpenAICompatibleAdapter({
		id: "custom",
		fingerprint: "custom|1",
		buildUrl: () => "https://host.example.com/chat/completions",
		buildAuthHeaders: (k) => ({ authorization: `Bearer ${k}` }),
		sendModel: true,
		resolveKey: () => key,
		missingKeyMessage: "no key configured",
		fetch,
		capabilities: { jsonSchema: false, jsonMode: false, streaming: false },
	});

	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertStringIncludes(e.message, "no key configured");
	assertEquals(e.adapter, "custom");

	key = "late";
	assertEquals((await adapter.complete({ ...req })).text, "Hello");
});

// -- strict-mode schema normalizer --------------------------------------------

Deno.test("normalizeOpenAiJsonSchema strips unsupported keywords recursively", () => {
	assertEquals(
		normalizeOpenAiJsonSchema({
			type: "object",
			properties: {
				name: { type: "string", minLength: 1, maxLength: 10, pattern: "^a" },
				tags: {
					type: "array",
					minItems: 1,
					uniqueItems: true,
					items: {
						type: "object",
						properties: { id: { type: "integer" } },
						required: ["id"],
					},
				},
				choice: {
					anyOf: [{ type: "string" }, { type: "number", multipleOf: 2 }],
				},
				when: { type: "string", format: "date-time" },
			},
			required: ["name", "tags", "choice", "when"],
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
						required: ["id"],
						additionalProperties: false,
					},
				},
				choice: { anyOf: [{ type: "string" }, { type: "number" }] },
				when: { type: "string" },
			},
			required: ["name", "tags", "choice", "when"],
			additionalProperties: false,
		},
	);
});

Deno.test("normalizeOpenAiJsonSchema requires every property, widening optionals", () => {
	assertEquals(
		normalizeOpenAiJsonSchema({
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "number", description: "optional" },
				c: { type: ["string", "boolean"] },
				d: { type: ["string", "null"] },
				e: { $ref: "#/$defs/Thing" },
			},
			required: ["a"],
			$defs: {
				Thing: { type: "object", properties: { id: { type: "string" } } },
			},
		}),
		{
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: ["number", "null"], description: "optional" },
				c: { type: ["string", "boolean", "null"] },
				d: { type: ["string", "null"] },
				// no declared type to widen — required as-is
				e: { $ref: "#/$defs/Thing" },
			},
			required: ["a", "b", "c", "d", "e"],
			additionalProperties: false,
			$defs: {
				Thing: {
					type: "object",
					properties: { id: { type: ["string", "null"] } },
					required: ["id"],
					additionalProperties: false,
				},
			},
		},
	);
});

Deno.test("normalizeOpenAiJsonSchema rejects record/map schemas", () => {
	assertThrows(
		() =>
			normalizeOpenAiJsonSchema({
				type: "object",
				additionalProperties: { type: "string" },
			}),
		InvalidRequestError,
		"record/map schemas",
	);
	assertThrows(
		() =>
			normalizeOpenAiJsonSchema({
				type: "object",
				patternProperties: { "^x": { type: "string" } },
			}),
		InvalidRequestError,
		"patternProperties",
	);
	// nested is rejected too, and the adapter id is carried on the error
	const e = assertThrows(
		() =>
			normalizeOpenAiJsonSchema({
				type: "object",
				properties: {
					meta: { type: "object", additionalProperties: { type: "number" } },
				},
			}, "azure-openai"),
		InvalidRequestError,
	);
	assertEquals(e.adapter, "azure-openai");
	// an explicit `additionalProperties: false` is fine
	assertEquals(
		normalizeOpenAiJsonSchema({ type: "object", additionalProperties: false }),
		{ type: "object", additionalProperties: false },
	);
});

Deno.test("openai: schema rejection surfaces before the request is sent", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createOpenAIAdapter({ apiKey: "k", fetch });
	await assertRejects(
		() =>
			adapter.complete({
				...req,
				jsonSchema: { type: "object", additionalProperties: { type: "string" } },
			}),
		InvalidRequestError,
	);
	assertEquals(calls.length, 0);
});
