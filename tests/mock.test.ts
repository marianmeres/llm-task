import { assert, assertEquals, assertRejects } from "@std/assert";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { TransientError } from "../src/errors.ts";

const req = { input: "in", model: "m", maxTokens: 10 };

Deno.test("mock: default empty response", async () => {
	const adapter = createMockAdapter();
	const r = await adapter.complete({ ...req });
	assertEquals(r.text, "");
	assertEquals(r.finishReason, "stop");
	assertEquals(r.model, "m");
});

Deno.test("mock: string response and call recording", async () => {
	const adapter = createMockAdapter({ respond: "hello" });
	const r = await adapter.complete({ ...req, system: "s" });
	assertEquals(r.text, "hello");
	assert(r.usage!.outputTokens > 0);
	assertEquals(adapter.calls.length, 1);
	assertEquals(adapter.calls[0].system, "s");
});

Deno.test("mock: partial result response", async () => {
	const adapter = createMockAdapter({
		respond: { text: "t", finishReason: "length", model: "other" },
	});
	const r = await adapter.complete({ ...req });
	assertEquals(r.finishReason, "length");
	assertEquals(r.model, "other");
});

Deno.test("mock: function response receives request and call index", async () => {
	const adapter = createMockAdapter({
		respond: (req, call) => `${req.input}-${call}`,
	});
	assertEquals((await adapter.complete({ ...req })).text, "in-0");
	assertEquals((await adapter.complete({ ...req })).text, "in-1");
});

Deno.test("mock: sequence with error injection, last repeats", async () => {
	const adapter = createMockAdapter({
		respond: [new TransientError("boom"), "ok"],
	});
	await assertRejects(() => adapter.complete({ ...req }), TransientError);
	assertEquals((await adapter.complete({ ...req })).text, "ok");
	assertEquals((await adapter.complete({ ...req })).text, "ok");
});

Deno.test("mock: delay is abortable", async () => {
	const adapter = createMockAdapter({ respond: "x", delayMs: 5_000 });
	const ctrl = new AbortController();
	const reason = new Error("stop");
	setTimeout(() => ctrl.abort(reason), 10);
	const t0 = Date.now();
	const e = await assertRejects(() =>
		adapter.complete({ ...req, signal: ctrl.signal })
	);
	assertEquals(e, reason);
	assert(Date.now() - t0 < 4_000);
});

Deno.test("mock: custom id and capabilities", () => {
	const adapter = createMockAdapter({
		id: "mock2",
		capabilities: { jsonSchema: false },
	});
	assertEquals(adapter.id, "mock2");
	assertEquals(adapter.capabilities.jsonSchema, false);
	assertEquals(adapter.capabilities.streaming, false);
});
