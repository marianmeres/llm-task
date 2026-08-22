import { assert, assertEquals } from "@std/assert";
import { composeSignals } from "../src/utils.ts";

Deno.test("composeSignals: empty and single signal passthrough", () => {
	assertEquals(composeSignals(undefined, undefined).signal, undefined);
	const ctrl = new AbortController();
	assertEquals(composeSignals(ctrl.signal, undefined).signal, ctrl.signal);
});

Deno.test("composeSignals: combined signal aborts with the source reason", () => {
	const a = new AbortController();
	const b = new AbortController();
	const { signal } = composeSignals(a.signal, b.signal);
	assert(signal && !signal.aborted);
	const reason = new Error("stop");
	b.abort(reason);
	assert(signal.aborted);
	assertEquals(signal.reason, reason);
});

Deno.test("composeSignals: manual fallback works and dispose detaches", () => {
	// force the fallback path by temporarily hiding AbortSignal.any
	const any = AbortSignal.any;
	// deno-lint-ignore no-explicit-any
	(AbortSignal as any).any = undefined;
	try {
		// combined abort still works
		{
			const a = new AbortController();
			const b = new AbortController();
			const { signal } = composeSignals(a.signal, b.signal);
			const reason = new Error("stop");
			a.abort(reason);
			assert(signal!.aborted);
			assertEquals(signal!.reason, reason);
		}
		// pre-aborted source
		{
			const a = new AbortController();
			a.abort("early");
			const { signal } = composeSignals(a.signal, new AbortController().signal);
			assert(signal!.aborted);
			assertEquals(signal!.reason, "early");
		}
		// dispose detaches: aborting a source afterwards no longer propagates
		{
			const a = new AbortController();
			const b = new AbortController();
			const { signal, dispose } = composeSignals(a.signal, b.signal);
			dispose();
			a.abort(new Error("late"));
			assert(!signal!.aborted, "disposed composite must not abort");
			dispose(); // idempotent
		}
	} finally {
		// deno-lint-ignore no-explicit-any
		(AbortSignal as any).any = any;
	}
});
