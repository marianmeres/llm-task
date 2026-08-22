import { assert, assertEquals, assertThrows } from "@std/assert";
import {
	buildJsonInstruction,
	buildRepairInstruction,
	formatIssues,
	isStandardSchema,
	parseJsonLoose,
	type StandardSchemaV1,
} from "../src/schema.ts";

/** Minimal hand-rolled Standard Schema (what zod/valibot/arktype implement). */
export function fakeSchema<T>(
	check: (v: unknown) => { value: T } | { issues: { message: string }[] },
): StandardSchemaV1<unknown, T> {
	return { "~standard": { version: 1, vendor: "fake", validate: check } };
}

Deno.test("isStandardSchema detects the interface", () => {
	assert(isStandardSchema(fakeSchema((v) => ({ value: v }))));
	assert(!isStandardSchema({ type: "object" }));
	assert(!isStandardSchema(null));
	assert(!isStandardSchema("x"));
	assert(!isStandardSchema({ "~standard": {} }));
});

Deno.test("parseJsonLoose parses plain json", () => {
	assertEquals(parseJsonLoose('{"a":1}'), { a: 1 });
	assertEquals(parseJsonLoose("  [1,2]  "), [1, 2]);
});

Deno.test("parseJsonLoose unwraps fences", () => {
	assertEquals(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
	assertEquals(parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
});

Deno.test("parseJsonLoose throws on invalid json", () => {
	assertThrows(() => parseJsonLoose("not json"), SyntaxError);
});

Deno.test("formatIssues formats paths", () => {
	assertEquals(
		formatIssues([
			{ message: "required", path: ["a", "b"] },
			{ message: "too big", path: [{ key: "c" }] },
			{ message: "bad" },
		]),
		"a.b: required; c: too big; bad",
	);
});

Deno.test("buildJsonInstruction with and without schema", () => {
	const plain = buildJsonInstruction();
	assert(plain.includes("valid JSON only"));
	assert(!plain.includes("JSON Schema"));
	const withSchema = buildJsonInstruction({ type: "object" });
	assert(withSchema.includes('{"type":"object"}'));
});

Deno.test("buildRepairInstruction contains text and issues", () => {
	const out = buildRepairInstruction("{bad", "a: required");
	assert(out.includes("{bad"));
	assert(out.includes("a: required"));
});
