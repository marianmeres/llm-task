/**
 * @module schema
 *
 * Structured output support: the vendored
 * [Standard Schema v1](https://standardschema.dev) interface (a types-only
 * contract implemented by zod, valibot, arktype and others — no runtime
 * dependency), a loose JSON Schema type, and small parsing/validation helpers.
 */

import type { ValidationIssue } from "./errors.ts";

/**
 * The Standard Schema v1 interface. Any library implementing it (zod v3.24+,
 * valibot v1+, arktype v2+, ...) can be passed as a task `schema` directly.
 *
 * Vendored per the spec's recommendation — it is a types-only contract, so this
 * package depends on none of the schema libraries.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	/** The Standard Schema properties. */
	readonly "~standard": StandardSchemaProps<Input, Output>;
}

/** The Standard Schema v1 properties object. */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
	/** The version number of the standard. */
	readonly version: 1;
	/** The vendor name of the schema library (e.g. `"zod"`). */
	readonly vendor: string;
	/** Validates unknown input values. */
	readonly validate: (
		value: unknown,
	) => StandardResult<Output> | Promise<StandardResult<Output>>;
	/** Inferred types associated with the schema (types-only, never set at runtime). */
	readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

/** The result interface of the Standard Schema `validate` function. */
export type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<ValidationIssue> };

/** Infers the output type of a Standard Schema. */
export type InferOutput<S extends StandardSchemaV1> = S extends
	StandardSchemaV1<infer _I, infer O> ? O : never;

/**
 * A plain JSON Schema object (loosely typed — this package does not implement a
 * JSON Schema validator; the schema is passed to providers with native
 * structured output support, or injected into the prompt otherwise).
 */
export type JsonSchema = { readonly [key: string]: unknown };

/** Returns `true` when the value implements the Standard Schema v1 interface. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	return (
		typeof value === "object" &&
		value !== null &&
		"~standard" in value &&
		typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
	);
}

/**
 * Tolerant JSON parse for model output: trims whitespace and unwraps a single
 * markdown code fence (```json ... ```) before parsing.
 *
 * @throws {SyntaxError} When the (unwrapped) text is not valid JSON.
 */
export function parseJsonLoose(text: string): unknown {
	let t = text.trim();
	const fence = t.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/);
	if (fence) t = fence[1].trim();
	return JSON.parse(t);
}

/** Formats validation issues into a short human/model readable string. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
	return issues
		.map((i) => {
			const path = (i.path ?? [])
				.map((
					p,
				) => (typeof p === "object" && p !== null && "key" in p ? p.key : p))
				.join(".");
			return path ? `${path}: ${i.message}` : i.message;
		})
		.join("; ");
}

/**
 * Builds the instruction appended to the system prompt when the adapter has no
 * native structured output support (or no wire schema is available) — the
 * "graceful degradation" strategy.
 */
export function buildJsonInstruction(jsonSchema?: JsonSchema): string {
	let out = "Respond with valid JSON only — no prose, no markdown code fences.";
	if (jsonSchema) {
		out += `\nThe JSON must match this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
	}
	return out;
}

/**
 * Builds the one-shot repair instruction sent after a failed JSON parse or
 * schema validation (bounded at a single attempt — never a loop).
 */
export function buildRepairInstruction(text: string, issues: string): string {
	return [
		"Your previous response failed validation.",
		`Previous response:\n${text}`,
		`Validation errors: ${issues}`,
		"Return only valid JSON matching the required schema — no prose, no markdown code fences.",
	].join("\n\n");
}
