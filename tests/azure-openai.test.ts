import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createAzureOpenAIAdapter } from "../src/adapters/azure-openai.ts";
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

const ENDPOINT = "https://acme-eu.openai.azure.com";

const req = {
	input: "some input",
	model: "classifier", // deployment name
	maxTokens: 64,
};

Deno.test("azure: v1 surface when apiVersion is unset", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "az-key",
		fetch,
	});

	const result = await adapter.complete({ ...req, system: "Classify." });

	assertEquals(adapter.id, "azure-openai");
	assertEquals(calls.length, 1);
	assertEquals(calls[0].url, `${ENDPOINT}/openai/v1/chat/completions`);
	assertEquals(calls[0].method, "POST");
	assertEquals(calls[0].body, {
		// the deployment name travels in `model` on the v1 surface
		model: "classifier",
		max_completion_tokens: 64,
		messages: [
			{ role: "system", content: "Classify." },
			{ role: "user", content: "some input" },
		],
	});
	assertEquals(result.text, "Hello");
	assertEquals(result.finishReason, "stop");
	assertEquals(result.usage, { inputTokens: 10, outputTokens: 5 });
});

Deno.test("azure: classic deployment route when apiVersion is set", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "az-key",
		apiVersion: "2024-10-21",
		fetch,
	});

	await adapter.complete({ ...req });

	assertEquals(
		calls[0].url,
		`${ENDPOINT}/openai/deployments/classifier/chat/completions` +
			"?api-version=2024-10-21",
	);
	// the deployment is addressed through the URL, so no `model` on the wire
	assert(!("model" in calls[0].body));
});

Deno.test("azure: deployment name is url-encoded on the classic route", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "az-key",
		apiVersion: "2024-10-21",
		fetch,
	});

	await adapter.complete({ ...req, model: "my classifier/v2" });

	assertEquals(
		calls[0].url,
		`${ENDPOINT}/openai/deployments/my%20classifier%2Fv2/chat/completions` +
			"?api-version=2024-10-21",
	);
});

Deno.test("azure: authenticates with api-key, never Authorization", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "az-key",
		headers: { "x-ms-client-request-id": "abc" },
		fetch,
	});

	await adapter.complete({ ...req });

	assertEquals(calls[0].headers["api-key"], "az-key");
	assert(!("authorization" in calls[0].headers));
	assertEquals(calls[0].headers["content-type"], "application/json");
	assertEquals(calls[0].headers["x-ms-client-request-id"], "abc");
});

Deno.test("azure: trailing slashes on the endpoint are trimmed", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: `${ENDPOINT}//`,
		apiKey: "az-key",
		fetch,
	});

	await adapter.complete({ ...req });

	assertEquals(calls[0].url, `${ENDPOINT}/openai/v1/chat/completions`);
});

Deno.test("azure: maxTokensField is overridable", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "az-key",
		maxTokensField: "max_tokens",
		fetch,
	});

	await adapter.complete({ ...req });

	assertEquals(calls[0].body.max_tokens, 64);
	assert(!("max_completion_tokens" in calls[0].body));
});

Deno.test("azure: missing api key throws AuthError without fetch", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({ endpoint: ENDPOINT, fetch });
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertStringIncludes(e.message, "AZURE_OPENAI_API_KEY");
	assertEquals(calls.length, 0);
});

Deno.test("azure: getToken wins over apiKey and is called once per request", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	let issued = 0;
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "az-static",
		getToken: () => Promise.resolve(`tok-${++issued}`),
		fetch,
	});
	await adapter.complete({ ...req });
	await adapter.complete({ ...req });
	assertEquals(issued, 2);
	assertEquals(calls[0].headers["api-key"], "tok-1");
	assertEquals(calls[1].headers["api-key"], "tok-2");
});

Deno.test("azure: a failing getToken surfaces as AuthError", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const boom = new Error("managed identity unavailable");
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		getToken: () => Promise.reject(boom),
		fetch,
	});
	const e = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertEquals(e.cause, boom);
	assertEquals(e.retryable, false);
	assertStringIncludes(e.message, "managed identity unavailable");
	assertEquals(calls.length, 0);
});

Deno.test("azure: declares native structured output", () => {
	const adapter = createAzureOpenAIAdapter({ endpoint: ENDPOINT, apiKey: "k" });
	assertEquals(adapter.capabilities, {
		jsonSchema: true,
		jsonMode: false,
		streaming: false,
	});
});

Deno.test("azure: sends strict response_format for jsonSchema", async () => {
	const { fetch, calls } = makeFetch(() => okBody());
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		fetch,
	});

	await adapter.complete({
		...req,
		jsonSchema: {
			type: "object",
			properties: { label: { type: "string" } },
			required: ["label"],
		},
	});

	assertEquals(calls[0].body.response_format, {
		type: "json_schema",
		json_schema: {
			name: "output",
			strict: true,
			schema: {
				type: "object",
				properties: { label: { type: "string" } },
				required: ["label"],
				additionalProperties: false,
			},
		},
	});
});

Deno.test("azure: fingerprint distinguishes configurations", () => {
	const a = createAzureOpenAIAdapter({ endpoint: ENDPOINT, apiKey: "k" });
	const b = createAzureOpenAIAdapter({
		endpoint: "https://acme-us.openai.azure.com",
		apiKey: "k",
	});
	const c = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		apiVersion: "2024-10-21",
	});
	const d = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		headers: { "x-ms-client-request-id": "abc" },
	});
	const e = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		maxTokensField: "max_tokens",
	});
	assertEquals(new Set([a, b, c, d, e].map((x) => x.fingerprint)).size, 5);
	// same config -> same fingerprint (stable cache keys across instances)
	assertEquals(
		a.fingerprint,
		createAzureOpenAIAdapter({ endpoint: ENDPOINT, apiKey: "other" }).fingerprint,
	);
});

Deno.test("azure: maps 401 to AuthError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(401, "invalid_request_error", "Access denied due to invalid api-key")
	);
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "bad",
		fetch,
	});
	const err = await assertRejects(() => adapter.complete({ ...req }), AuthError);
	assertEquals(err.status, 401);
	assertStringIncludes(err.message, "invalid api-key");
});

Deno.test("azure: maps 429 to RateLimitError with retryAfter", async () => {
	const { fetch } = makeFetch(() =>
		errBody(
			429,
			"rate_limit_error",
			"Requests to the endpoint have exceeded the " +
				"token rate limit",
			{},
			{ "retry-after": "30" },
		)
	);
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		fetch,
	});
	const err = await assertRejects(() => adapter.complete({ ...req }), RateLimitError);
	assertEquals(err.retryAfter, 30);
});

Deno.test("azure: maps 404 (unknown deployment) to InvalidRequestError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(
			404,
			"invalid_request_error",
			"The API deployment for this resource " +
				"does not exist",
			{ code: "DeploymentNotFound" },
		)
	);
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		apiVersion: "2024-10-21",
		fetch,
	});
	const err = await assertRejects(
		() => adapter.complete({ ...req }),
		InvalidRequestError,
	);
	assertEquals(err.status, 404);
});

Deno.test("azure: maps context-length 400 to ContextLengthError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(
			400,
			"invalid_request_error",
			"This model's maximum context length is 8192 tokens, however you " +
				"requested 20000 tokens.",
			{ code: "context_length_exceeded" },
		)
	);
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		fetch,
	});
	await assertRejects(() => adapter.complete({ ...req }), ContextLengthError);
});

Deno.test("azure: maps 500 to TransientError", async () => {
	const { fetch } = makeFetch(() =>
		errBody(500, "server_error", "Backend call failure")
	);
	const adapter = createAzureOpenAIAdapter({
		endpoint: ENDPOINT,
		apiKey: "k",
		fetch,
	});
	await assertRejects(() => adapter.complete({ ...req }), TransientError);
});
