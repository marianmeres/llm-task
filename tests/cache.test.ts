import { assertEquals, assertThrows } from "@std/assert";
import { type CachedCompletion, createMemoryCache } from "../src/cache.ts";
import { sha256Hex, stableStringify } from "../src/utils.ts";

const entry = (text: string): CachedCompletion => ({
	text,
	finishReason: "stop",
	model: "m",
});

Deno.test("memory cache get/set/clear", () => {
	const cache = createMemoryCache();
	assertEquals(cache.get("k"), undefined);
	cache.set("k", entry("v"));
	assertEquals(cache.get("k")?.text, "v");
	assertEquals(cache.size, 1);
	cache.clear();
	assertEquals(cache.size, 0);
});

Deno.test("memory cache evicts least recently used", () => {
	const cache = createMemoryCache({ maxEntries: 2 });
	cache.set("a", entry("a"));
	cache.set("b", entry("b"));
	cache.get("a"); // refresh "a" — "b" becomes LRU
	cache.set("c", entry("c"));
	assertEquals(cache.get("b"), undefined);
	assertEquals(cache.get("a")?.text, "a");
	assertEquals(cache.get("c")?.text, "c");
});

Deno.test("memory cache validates maxEntries", () => {
	assertThrows(() => createMemoryCache({ maxEntries: 0 }), RangeError);
});

Deno.test("stableStringify is key-order independent", () => {
	assertEquals(
		stableStringify({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } }),
		stableStringify({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }),
	);
});

Deno.test("sha256Hex produces stable hex", async () => {
	const h = await sha256Hex("hello");
	assertEquals(h.length, 64);
	assertEquals(h, await sha256Hex("hello"));
	assertEquals(
		h,
		"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	);
});
