import {
	assert,
	assertEquals,
	assertInstanceOf,
	assertRejects,
	assertStringIncludes,
} from "@std/assert";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { createMemoryCache } from "../src/cache.ts";
import { firstLine, stripFences, unquote } from "../src/cleaners.ts";
import {
	createLlmClient,
	type HookResponseInfo,
	type HookRetryInfo,
} from "../src/client.ts";
import {
	AuthError,
	ContentFilterError,
	OutputValidationError,
	RateLimitError,
	TimeoutError,
	TransientError,
	TruncatedOutputError,
} from "../src/errors.ts";
import type { JsonSchema, StandardSchemaV1 } from "../src/schema.ts";
import { fakeSchema } from "./schema.test.ts";

Deno.test("task returns cleaned string value", async () => {
	const adapter = createMockAdapter({ respond: '```\n"A Title"\nsecond\n```' });
	const client = createLlmClient({ adapter, model: "m" });
	const toTitle = client.task({
		system: "Titleize.",
		clean: [stripFences, firstLine, unquote],
	});
	assertEquals(await toTitle("input"), "A Title");
	assertEquals(adapter.calls[0].system, "Titleize.");
	assertEquals(adapter.calls[0].input, "input");
});

Deno.test("task.run returns the full envelope", async () => {
	const adapter = createMockAdapter({ respond: "hi" });
	const client = createLlmClient({ adapter, model: "m" });
	const t = client.task({});
	const r = await t.run("x");
	assertEquals(r.value, "hi");
	assertEquals(r.text, "hi");
	assertEquals(r.finishReason, "stop");
	assertEquals(r.model, "m");
	assertEquals(r.cached, false);
	assertEquals(r.inputTruncated, false);
	assertEquals(r.attempts, 1);
	assertEquals(r.repaired, false);
	assert(r.usage);
	assert(r.raw);
});

Deno.test("client.run is a one-shot escape hatch", async () => {
	const adapter = createMockAdapter({ respond: "out" });
	const client = createLlmClient({ adapter, model: "m" });
	const r = await client.run({ system: "s", input: "in" });
	assertEquals(r.value, "out");
	assertEquals(adapter.calls[0].input, "in");
});

Deno.test("model resolution: call > task > client; missing model throws", async () => {
	const adapter = createMockAdapter({ respond: "x" });
	const client = createLlmClient({ adapter, model: "client-m" });
	const t = client.task({});
	await t("a");
	assertEquals(adapter.calls[0].model, "client-m");
	const t2 = client.task({ model: "task-m" });
	await t2("a");
	assertEquals(adapter.calls[1].model, "task-m");
	await t2("a", { model: "call-m" });
	assertEquals(adapter.calls[2].model, "call-m");

	const bare = createLlmClient({ adapter: createMockAdapter() });
	await assertRejects(() => bare.task({})("x"), TypeError, "model");
});

Deno.test("maxTokens default and merge", async () => {
	const adapter = createMockAdapter({ respond: "x" });
	const client = createLlmClient({ adapter, model: "m" });
	await client.task({})("a");
	assertEquals(adapter.calls[0].maxTokens, 1024);
	await client.task({ maxTokens: 64 })("a", { maxTokens: 32 });
	assertEquals(adapter.calls[1].maxTokens, 32);
});

Deno.test("non-string input throws TypeError", async () => {
	const client = createLlmClient({ adapter: createMockAdapter(), model: "m" });
	// deno-lint-ignore no-explicit-any
	await assertRejects(() => client.task({})(123 as any), TypeError);
});

Deno.test("retries on TransientError then succeeds", async () => {
	const adapter = createMockAdapter({
		respond: [new TransientError("boom"), new TransientError("boom2"), "ok"],
	});
	const retries: HookRetryInfo[] = [];
	const client = createLlmClient({
		adapter,
		model: "m",
		retry: { baseDelayMs: 1, maxDelayMs: 2 },
		hooks: { onRetry: (i) => retries.push(i) },
	});
	const r = await client.task({}).run("x");
	assertEquals(r.value, "ok");
	assertEquals(r.attempts, 3);
	assertEquals(retries.length, 2);
	assertEquals(retries[0].attempt, 1);
	assertInstanceOf(retries[0].error, TransientError);
});

Deno.test("does not retry on non-retryable errors", async () => {
	const adapter = createMockAdapter({ respond: [new AuthError("bad key"), "never"] });
	const client = createLlmClient({ adapter, model: "m" });
	await assertRejects(() => client.task({})("x"), AuthError);
	assertEquals(adapter.calls.length, 1);
});

Deno.test("gives up after configured attempts", async () => {
	const adapter = createMockAdapter({ respond: new TransientError("always") });
	const client = createLlmClient({
		adapter,
		model: "m",
		retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
	});
	await assertRejects(() => client.task({})("x"), TransientError);
	assertEquals(adapter.calls.length, 2);
});

Deno.test("retry: false disables retries", async () => {
	const adapter = createMockAdapter({ respond: new TransientError("boom") });
	const client = createLlmClient({ adapter, model: "m" });
	await assertRejects(() => client.task({ retry: false })("x"), TransientError);
	assertEquals(adapter.calls.length, 1);
});

Deno.test("unknown adapter throw is wrapped, not retried", async () => {
	const adapter = createMockAdapter({
		respond: () => {
			throw new Error("bug in adapter");
		},
	});
	const client = createLlmClient({ adapter, model: "m" });
	const e = await assertRejects(() => client.task({})("x"));
	assertStringIncludes((e as Error).message, "bug in adapter");
	assertEquals(adapter.calls.length, 1);
});

Deno.test("timeoutMs produces TimeoutError", async () => {
	const adapter = createMockAdapter({ respond: "late", delayMs: 200 });
	const client = createLlmClient({ adapter, model: "m" });
	const e = await assertRejects(
		() => client.task({ timeoutMs: 20 })("x"),
		TimeoutError,
	);
	assertStringIncludes(e.message, "20ms");
});

Deno.test("retry respects the overall deadline", async () => {
	const adapter = createMockAdapter({ respond: new TransientError("boom") });
	const client = createLlmClient({
		adapter,
		model: "m",
		retry: { attempts: 10, baseDelayMs: 60_000, maxDelayMs: 60_000 },
	});
	const t0 = Date.now();
	await assertRejects(() => client.task({ timeoutMs: 100 })("x"), TransientError);
	assert(Date.now() - t0 < 5_000, "must not sleep through huge backoff");
	assertEquals(adapter.calls.length, 1);
});

Deno.test("caller abort passes through untouched", async () => {
	const adapter = createMockAdapter({ respond: "x", delayMs: 200 });
	const client = createLlmClient({ adapter, model: "m" });
	const ctrl = new AbortController();
	const reason = new Error("user cancelled");
	setTimeout(() => ctrl.abort(reason), 10);
	const e = await assertRejects(() => client.task({})("x", { signal: ctrl.signal }));
	assertEquals(e, reason);
});

Deno.test("throws TruncatedOutputError on length finish by default", async () => {
	const adapter = createMockAdapter({
		respond: { text: "partial", finishReason: "length" },
	});
	const client = createLlmClient({ adapter, model: "m" });
	const e = await assertRejects(() => client.task({})("x"), TruncatedOutputError);
	assertEquals(e.text, "partial");
});

Deno.test("allowTruncated returns the partial text", async () => {
	const adapter = createMockAdapter({
		respond: { text: "partial", finishReason: "length" },
	});
	const client = createLlmClient({ adapter, model: "m" });
	const r = await client.task({ allowTruncated: true }).run("x");
	assertEquals(r.value, "partial");
	assertEquals(r.finishReason, "length");
});

Deno.test("throws ContentFilterError on refusal", async () => {
	const adapter = createMockAdapter({
		respond: { text: "", finishReason: "content_filter" },
	});
	const client = createLlmClient({ adapter, model: "m" });
	await assertRejects(() => client.task({})("x"), ContentFilterError);
});

Deno.test("maxInputChars truncates input, flags and fires hook", async () => {
	const adapter = createMockAdapter({ respond: "ok" });
	let hooked = 0;
	const client = createLlmClient({
		adapter,
		model: "m",
		hooks: { onInputTruncated: () => hooked++ },
	});
	const r = await client.task({ maxInputChars: 5 }).run("0123456789");
	assertEquals(adapter.calls[0].input, "01234");
	assertEquals(r.inputTruncated, true);
	assertEquals(hooked, 1);
	// under the limit: untouched
	const r2 = await client.task({ maxInputChars: 5 }).run("0123");
	assertEquals(r2.inputTruncated, false);
	assertEquals(hooked, 1);
});

Deno.test("onRequest/onResponse hooks fire (client and task level)", async () => {
	const adapter = createMockAdapter({ respond: "ok" });
	const order: string[] = [];
	const client = createLlmClient({
		adapter,
		model: "m",
		hooks: { onRequest: () => order.push("client-req") },
	});
	const t = client.task({
		hooks: {
			onRequest: (i) => {
				order.push("task-req");
				assertEquals(i.model, "m");
				assertEquals(i.attempt, 1);
			},
			onResponse: (i) => {
				order.push("task-res");
				assertEquals(i.cached, false);
				assertEquals(i.result.text, "ok");
			},
		},
	});
	await t("x");
	assertEquals(order, ["client-req", "task-req", "task-res"]);
});

Deno.test("throwing hooks never break the call", async () => {
	const adapter = createMockAdapter({ respond: "ok" });
	const client = createLlmClient({
		adapter,
		model: "m",
		logger: { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} },
		hooks: {
			onRequest: () => {
				throw new Error("broken hook");
			},
		},
	});
	assertEquals(await client.task({})("x"), "ok");
});

// -- cache -------------------------------------------------------------------

Deno.test("cache: second identical call served from cache", async () => {
	const adapter = createMockAdapter({ respond: "cached-me" });
	const client = createLlmClient({
		adapter,
		model: "m",
		cache: createMemoryCache(),
	});
	const t = client.task({ system: "s" });
	const r1 = await t.run("x");
	const r2 = await t.run("x");
	assertEquals(adapter.calls.length, 1);
	assertEquals(r1.cached, false);
	assertEquals(r2.cached, true);
	assertEquals(r2.value, "cached-me");
	assertEquals(r2.attempts, 0);
	assertEquals(r2.raw, undefined);
});

Deno.test("cache: different input misses", async () => {
	const adapter = createMockAdapter({ respond: "v" });
	const client = createLlmClient({ adapter, model: "m", cache: createMemoryCache() });
	const t = client.task({});
	await t("a");
	await t("b");
	assertEquals(adapter.calls.length, 2);
});

Deno.test("cache: opt-out per task and per call", async () => {
	const adapter = createMockAdapter({ respond: "v" });
	const client = createLlmClient({ adapter, model: "m", cache: createMemoryCache() });
	const t = client.task({ cache: false });
	await t("a");
	await t("a");
	assertEquals(adapter.calls.length, 2);
	const t2 = client.task({});
	await t2("b", { cache: false });
	await t2("b", { cache: false });
	assertEquals(adapter.calls.length, 4);
});

Deno.test("cache: truncated results are not cached", async () => {
	const adapter = createMockAdapter({
		respond: { text: "partial", finishReason: "length" },
	});
	const client = createLlmClient({ adapter, model: "m", cache: createMemoryCache() });
	const t = client.task({ allowTruncated: true });
	await t("x");
	await t("x");
	assertEquals(adapter.calls.length, 2);
});

// -- structured output -------------------------------------------------------

const Point = fakeSchema<{ x: number; y: number }>((v) => {
	const o = v as Record<string, unknown>;
	if (typeof o?.x === "number" && typeof o?.y === "number") {
		return { value: { x: o.x, y: o.y } };
	}
	return { issues: [{ message: "x and y must be numbers" }] };
});

Deno.test("standard schema: parses and validates typed value", async () => {
	const adapter = createMockAdapter({ respond: '{"x":1,"y":2}' });
	const client = createLlmClient({ adapter, model: "m" });
	const t = client.task({ system: "s", schema: Point });
	const value = await t("input");
	assertEquals(value, { x: 1, y: 2 });
	// no wire schema available -> prompt strategy, instruction appended
	assertStringIncludes(adapter.calls[0].system!, "valid JSON only");
	assertEquals(adapter.calls[0].jsonSchema, undefined);
});

Deno.test("standard schema + jsonSchema: native strategy, no prompt injection", async () => {
	const adapter = createMockAdapter({ respond: '{"x":1,"y":2}' });
	const client = createLlmClient({ adapter, model: "m" });
	const wire = { type: "object", properties: { x: {}, y: {} } };
	const t = client.task({ system: "s", schema: Point, jsonSchema: wire });
	await t("input");
	assertEquals(adapter.calls[0].system, "s");
	assertEquals(adapter.calls[0].jsonSchema, wire);
});

Deno.test("json schema on non-native adapter falls back to prompt strategy", async () => {
	const adapter = createMockAdapter({
		respond: '{"a":1}',
		capabilities: { jsonSchema: false },
	});
	const client = createLlmClient({ adapter, model: "m" });
	const t = client.task({ schema: { type: "object" } });
	const value = await t("input");
	assertEquals(value, { a: 1 });
	assertStringIncludes(adapter.calls[0].system!, '{"type":"object"}');
	assertEquals(adapter.calls[0].jsonSchema, undefined);
});

Deno.test("plain json schema returns parsed unknown via native strategy", async () => {
	const adapter = createMockAdapter({ respond: '```json\n{"n":7}\n```' });
	const client = createLlmClient({ adapter, model: "m" });
	const t = client.task<{ n: number }>({ schema: { type: "object" } });
	assertEquals(await t("x"), { n: 7 });
	// native strategy on the wire: schema sent, no prompt injection
	assertEquals(adapter.calls[0].jsonSchema, { type: "object" });
	assertEquals(adapter.calls[0].system, undefined);
});

Deno.test("repair: single retry with issues appended, then success", async () => {
	const adapter = createMockAdapter({
		respond: ["not json at all", '{"x":1,"y":2}'],
	});
	const client = createLlmClient({ adapter, model: "m" });
	const r = await client.task({ system: "s", schema: Point }).run("input");
	assertEquals(r.value, { x: 1, y: 2 });
	assertEquals(r.repaired, true);
	assertEquals(r.attempts, 2);
	assertEquals(adapter.calls.length, 2);
	assertStringIncludes(adapter.calls[1].system!, "failed validation");
	assertStringIncludes(adapter.calls[1].system!, "not json at all");
});

Deno.test("repair: second failure throws OutputValidationError", async () => {
	const adapter = createMockAdapter({ respond: ['{"x":"a"}', '{"y":"b"}'] });
	const client = createLlmClient({ adapter, model: "m" });
	const e = await assertRejects(
		() => client.task({ schema: Point })("input"),
		OutputValidationError,
	);
	assertEquals(adapter.calls.length, 2);
	assertEquals(e.text, '{"y":"b"}');
	assertEquals(e.issues[0].message, "x and y must be numbers");
});

Deno.test("repair result lands in the cache", async () => {
	const adapter = createMockAdapter({ respond: ["bad", '{"x":1,"y":2}'] });
	const client = createLlmClient({ adapter, model: "m", cache: createMemoryCache() });
	const t = client.task({ schema: Point });
	await t("in");
	const r2 = await t.run("in");
	assertEquals(adapter.calls.length, 2, "second call must be a cache hit");
	assertEquals(r2.cached, true);
	assertEquals(r2.value, { x: 1, y: 2 });
});

// -- review-workflow regression tests ----------------------------------------

Deno.test("retry honors Retry-After (max of backoff and retryAfter)", async () => {
	const adapter = createMockAdapter({
		respond: [new RateLimitError("slow", { retryAfter: 0.05 }), "ok"],
	});
	const retries: HookRetryInfo[] = [];
	const client = createLlmClient({
		adapter,
		model: "m",
		retry: { baseDelayMs: 1, maxDelayMs: 2 },
		hooks: { onRetry: (i) => retries.push(i) },
	});
	const t0 = Date.now();
	const r = await client.task({}).run("x");
	assertEquals(r.value, "ok");
	assertEquals(retries.length, 1);
	assert(retries[0].delayMs >= 50, `delayMs was ${retries[0].delayMs}`);
	assert(Date.now() - t0 >= 50, "must actually wait the Retry-After delay");
});

Deno.test("retryAfter overshooting the deadline gives up immediately", async () => {
	const adapter = createMockAdapter({
		respond: new RateLimitError("slow", { retryAfter: 60 }),
	});
	const client = createLlmClient({ adapter, model: "m" });
	const t0 = Date.now();
	await assertRejects(() => client.task({ timeoutMs: 100 })("x"), RateLimitError);
	assert(Date.now() - t0 < 5_000, "must not sleep through the huge Retry-After");
	assertEquals(adapter.calls.length, 1);
});

Deno.test("stale cache hit: repairs, reports cached:false, re-caches", async () => {
	const Lenient = fakeSchema<unknown>((v) => ({ value: v }));
	const adapter = createMockAdapter({ respond: ['{"z":9}', '{"x":1,"y":2}'] });
	const client = createLlmClient({ adapter, model: "m", cache: createMemoryCache() });
	// primes the shared cache entry with text that fails the strict schema
	await client.task({ system: "s", schema: Lenient })("in");
	const strict = client.task({ system: "s", schema: Point });
	const r = await strict.run("in");
	assertEquals(adapter.calls.length, 2, "exactly one repair call");
	assertEquals(r.value, { x: 1, y: 2 });
	assertEquals(r.repaired, true);
	assertEquals(r.cached, false, "a real adapter call happened");
	assertEquals(r.attempts, 1);
	assert(r.raw, "raw comes from the live repair response");
	// the repaired completion was re-cached
	const r2 = await strict.run("in");
	assertEquals(adapter.calls.length, 2);
	assertEquals(r2.cached, true);
	assertEquals(r2.value, { x: 1, y: 2 });
});

Deno.test("jsonSchema without schema is structured and typed unknown", async () => {
	const adapter = createMockAdapter({ respond: '{"n":7}' });
	const client = createLlmClient({ adapter, model: "m" });
	const t = client.task<{ n: number }>({ jsonSchema: { type: "object" } });
	const v = await t("x");
	assertEquals(v, { n: 7 });
	assertEquals(adapter.calls[0].jsonSchema, { type: "object" });
	// without the explicit type argument the value is `unknown`, not `string`
	const u = await client.task({ jsonSchema: { type: "object" } })("x");
	// @ts-expect-error — unknown is not assignable to string
	const _s: string = u;
	assertEquals(u, { n: 7 });
});

Deno.test("union-typed schema degrades to unknown (not string)", async () => {
	const adapter = createMockAdapter({ respond: '{"a":1}' });
	const client = createLlmClient({ adapter, model: "m" });
	const schema = { type: "object" } as StandardSchemaV1 | JsonSchema;
	const v = await client.task({ schema })("x");
	// @ts-expect-error — unknown is not assignable to string
	const _s: string = v;
	assertEquals(v, { a: 1 });
});

Deno.test("cache hit fires onResponse (cached, attempt 0) and no onRequest", async () => {
	const adapter = createMockAdapter({ respond: "v" });
	const events: string[] = [];
	let cachedInfo: HookResponseInfo | undefined;
	const client = createLlmClient({
		adapter,
		model: "m",
		cache: createMemoryCache(),
		hooks: {
			onRequest: () => events.push("req"),
			onResponse: (i) => {
				events.push("res");
				if (i.cached) cachedInfo = i;
			},
		},
	});
	const t = client.task({});
	await t("x");
	await t("x");
	assertEquals(events, ["req", "res", "res"]);
	assertEquals(cachedInfo?.attempt, 0);
	assertEquals(cachedInfo?.durationMs, 0);
	assertEquals(cachedInfo?.result.text, "v");
});

Deno.test("cache: same id but different fingerprint never collides", async () => {
	const cache = createMemoryCache();
	const a1 = createMockAdapter({ respond: "one", fingerprint: "cfg-1" });
	const a2 = createMockAdapter({ respond: "two", fingerprint: "cfg-2" });
	const c1 = createLlmClient({ adapter: a1, model: "m", cache });
	const c2 = createLlmClient({ adapter: a2, model: "m", cache });
	assertEquals(await c1.task({})("x"), "one");
	assertEquals(await c2.task({})("x"), "two");
	assertEquals(a2.calls.length, 1, "must not be served adapter 1's entry");
});
