import { assert, assertEquals, assertRejects } from "@std/assert";
import { batch, type BatchProgress } from "../src/batch.ts";
import { sleep } from "../src/utils.ts";

Deno.test("batch: preserves input order", async () => {
	const results = await batch(
		async (n: number) => {
			await sleep(Math.random() * 20);
			return n * 2;
		},
		[1, 2, 3, 4, 5],
	);
	assertEquals(
		results.map((r) => (r.ok ? r.value : null)),
		[2, 4, 6, 8, 10],
	);
	assertEquals(results.map((r) => r.index), [0, 1, 2, 3, 4]);
});

Deno.test("batch: bounds concurrency", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	await batch(
		async (_: number) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await sleep(10);
			inFlight--;
		},
		Array.from({ length: 20 }, (_, i) => i),
		{ concurrency: 3 },
	);
	assertEquals(maxInFlight, 3);
});

Deno.test("batch: isolates per-item errors", async () => {
	const results = await batch(
		// deno-lint-ignore require-await
		async (n: number) => {
			if (n % 2) throw new Error(`odd ${n}`);
			return n;
		},
		[0, 1, 2, 3],
	);
	assertEquals(results.map((r) => r.ok), [true, false, true, false]);
	const failed = results[1];
	assert(!failed.ok);
	assertEquals((failed.error as Error).message, "odd 1");
	assertEquals(failed.input, 1);
});

Deno.test("batch: reports progress", async () => {
	const progress: BatchProgress[] = [];
	await batch(
		// deno-lint-ignore require-await
		async (n: number) => {
			if (n === 1) throw new Error("x");
			return n;
		},
		[0, 1, 2],
		{ concurrency: 1, onProgress: (p) => progress.push({ ...p }) },
	);
	assertEquals(progress.length, 3);
	assertEquals(progress.at(-1), { done: 3, total: 3, ok: 2, failed: 1, index: 2 });
});

Deno.test("batch: pre-aborted signal fails all items without starting any", async () => {
	const ctrl = new AbortController();
	const reason = new Error("cancelled");
	ctrl.abort(reason);
	let started = 0;
	const results = await batch(
		// deno-lint-ignore require-await
		async (n: number) => {
			started++;
			return n;
		},
		[0, 1, 2],
		{ signal: ctrl.signal },
	);
	assertEquals(started, 0);
	assertEquals(results.length, 3);
	for (const r of results) assertEquals(r.ok ? null : r.error, reason);
});

Deno.test("batch: abort mid-run cancels in-flight and remaining", async () => {
	const ctrl = new AbortController();
	const reason = new Error("cancelled");
	setTimeout(() => ctrl.abort(reason), 20);
	const results = await batch(
		async (n: number, opts) => {
			await sleep(n < 2 ? 1 : 10_000, opts?.signal);
			return n;
		},
		[0, 1, 2, 3, 4, 5],
		{ concurrency: 2, signal: ctrl.signal },
	);
	// the fast ones succeeded
	assert(results[0].ok);
	assert(results[1].ok);
	// the slow/unstarted ones carry the abort reason
	const failures = results.filter((r) => !r.ok);
	assert(failures.length >= 2);
	for (const f of failures) assertEquals(f.ok ? null : f.error, reason);
});

Deno.test("batch: invalid concurrency throws", async () => {
	// deno-lint-ignore require-await
	const fn = async (n: number) => n;
	await assertRejects(() => batch(fn, [1], { concurrency: 0 }), TypeError);
});

Deno.test("batch: empty inputs", async () => {
	// deno-lint-ignore require-await
	assertEquals(await batch(async (n: number) => n, []), []);
});
