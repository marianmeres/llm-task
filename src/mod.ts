/**
 * @module llm-task
 *
 * One-shot, stateless LLM calls used inside application code — "summarize this
 * into a title", "classify this message", "extract the invoice number". These
 * are *transformations, not conversations*: provider-agnostic, boring to call,
 * safe to fail (normalized errors, retries, timeouts).
 *
 * The central abstraction is a reusable, pre-configured **task** — a prompt
 * that behaves like a typed function. Not a chat SDK, not an agent framework.
 *
 * @example
 * ```typescript
 * import {
 * 	cleaners,
 * 	createAnthropicAdapter,
 * 	createLlmClient,
 * } from "@marianmeres/llm-task";
 *
 * const client = createLlmClient({
 * 	adapter: createAnthropicAdapter(), // or { apiKey: "sk-ant-..." }
 * 	model: "claude-haiku-4-5",
 * });
 *
 * const toTitle = client.task({
 * 	system: "Summarize the user input into a single short sentence title.",
 * 	maxTokens: 64,
 * 	clean: [cleaners.stripFences, cleaners.unquote, cleaners.firstLine],
 * });
 *
 * const title = await toTitle(userInput); // -> string
 * ```
 *
 * @example Structured output (zod, or any Standard Schema library)
 * ```typescript
 * import { z } from "zod";
 *
 * const Invoice = z.object({ number: z.string(), total: z.number() });
 *
 * const parseInvoice = client.task({
 * 	system: "Extract the invoice data from the user input.",
 * 	schema: Invoice,
 * 	jsonSchema: z.toJSONSchema(Invoice), // native structured output (zod v4)
 * });
 *
 * const invoice = await parseInvoice(text); // -> { number: string; total: number }
 * ```
 */

export * from "./adapter.ts";
export * from "./adapters/anthropic.ts";
export * from "./adapters/mock.ts";
export * from "./adapters/openai.ts";
export * from "./batch.ts";
export * from "./cache.ts";
export * from "./cleaners.ts";
export * from "./client.ts";
export * from "./errors.ts";
export type { Logger } from "./logger.ts";
export {
	buildJsonInstruction,
	buildRepairInstruction,
	formatIssues,
	type InferOutput,
	isStandardSchema,
	type JsonSchema,
	parseJsonLoose,
	type StandardResult,
	type StandardSchemaProps,
	type StandardSchemaV1,
} from "./schema.ts";
