import { assertEquals } from "@std/assert";
import {
	applyCleaners,
	cleaners,
	collapseWhitespace,
	firstLine,
	stripFences,
	stripPrefix,
	trim,
	unquote,
} from "../src/cleaners.ts";

Deno.test("trim trims whitespace", () => {
	assertEquals(trim("  hello \n"), "hello");
});

Deno.test("unquote removes one pair of matching quotes", () => {
	assertEquals(unquote('"Hello"'), "Hello");
	assertEquals(unquote("'Hello'"), "Hello");
	assertEquals(unquote("“Hello”"), "Hello");
	assertEquals(unquote("«Hello»"), "Hello");
	assertEquals(unquote("`Hello`"), "Hello");
	// only one pair
	assertEquals(unquote('""Hello""'), '"Hello"');
	// unmatched quotes stay
	assertEquals(unquote('"Hello'), '"Hello');
	assertEquals(unquote("no quotes"), "no quotes");
	// does not eat a single quote char
	assertEquals(unquote('"'), '"');
});

Deno.test("stripFences unwraps a fenced block", () => {
	assertEquals(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
	assertEquals(stripFences("```\ntext\n```"), "text");
	assertEquals(stripFences("no fences"), "no fences");
	// fences inside text are untouched
	assertEquals(stripFences("a ```b``` c"), "a ```b``` c");
});

Deno.test("firstLine returns first non-empty line", () => {
	assertEquals(firstLine("\n\n  Title here  \nsecond line"), "Title here");
	assertEquals(firstLine(""), "");
});

Deno.test("collapseWhitespace collapses runs", () => {
	assertEquals(collapseWhitespace("a\n\n  b\tc "), "a b c");
});

Deno.test("stripPrefix removes string prefix case-insensitively", () => {
	assertEquals(stripPrefix("Title:")("title: Hello"), "Hello");
	assertEquals(stripPrefix("Title:")("Hello"), "Hello");
});

Deno.test("stripPrefix removes regexp prefix", () => {
	assertEquals(stripPrefix(/^Title:\s*/i)("TITLE: Hello"), "Hello");
});

Deno.test("applyCleaners applies in order", () => {
	assertEquals(
		applyCleaners('```\n"Hello World"\n```', [stripFences, unquote]),
		"Hello World",
	);
	assertEquals(applyCleaners("  x  "), "  x  ");
});

Deno.test("cleaners object groups all built-ins", () => {
	assertEquals(cleaners.trim, trim);
	assertEquals(cleaners.stripPrefix, stripPrefix);
});
