/**
 * @module adapters/mock
 *
 * Mock adapter for unit testing consumer code — no network, no API keys.
 * Supports fixed responses, response-by-function, sequences (great for testing
 * retries) and error injection, and records every request for assertions.
 */

import type {
	Adapter,
	AdapterCapabilities,
	CompletionRequest,
	CompletionResult,
} from "../adapter.ts";
import { sleep } from "../utils.ts";

/**
 * A single scripted mock response:
 * - `string` — returned as the completion text (`finishReason: "stop"`)
 * - `Partial<CompletionResult>` — merged over sane defaults
 * - `Error` — thrown (error injection; use the normalized `LLMError` subclasses
 *   to exercise consumer error handling and client retry behavior)
 * - function — computed per call (may also throw, or return a promise)
 */
export type MockResponse =
	| string
	| Partial<CompletionResult>
	| Error
	| ((
		req: CompletionRequest,
		call: number,
	) =>
		| string
		| Partial<CompletionResult>
		| Promise<string | Partial<CompletionResult>>);

/** Options for {@link createMockAdapter}. */
export interface MockAdapterOptions {
	/**
	 * What to respond with. A single {@link MockResponse}, or an array consumed
	 * sequentially (the last entry repeats once exhausted) — e.g.
	 * `[new TransientError("boom"), "ok"]` to test retry behavior.
	 * @default "" (empty text)
	 */
	respond?: MockResponse | MockResponse[];
	/** Artificial latency per call in ms (abortable — respects the signal). */
	delayMs?: number;
	/**
	 * Adapter id reported in errors/cache keys.
	 * @default "mock"
	 */
	id?: string;
	/**
	 * Optional configuration fingerprint (see `Adapter.fingerprint`) — handy
	 * for testing that differently configured adapters do not share cache
	 * entries.
	 */
	fingerprint?: string;
	/** Capability overrides (defaults: `jsonSchema: true`, rest `false`). */
	capabilities?: Partial<AdapterCapabilities>;
}

/** The adapter returned by {@link createMockAdapter} — records all requests. */
export interface MockAdapter extends Adapter {
	/** Every {@link CompletionRequest} received, in call order. */
	readonly calls: CompletionRequest[];
}

/**
 * Creates a mock adapter.
 *
 * @example
 * ```typescript
 * import { createLlmClient, createMockAdapter } from "@marianmeres/llm-task";
 *
 * const adapter = createMockAdapter({ respond: "A Short Title" });
 * const client = createLlmClient({ adapter, model: "test-model" });
 * const toTitle = client.task({ system: "Summarize into a title." });
 *
 * assertEquals(await toTitle("..."), "A Short Title");
 * assertEquals(adapter.calls[0].system, "Summarize into a title.");
 * ```
 */
export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
	const id = options.id ?? "mock";
	const calls: CompletionRequest[] = [];
	let callCount = 0;

	return {
		id,
		fingerprint: options.fingerprint,
		capabilities: {
			jsonSchema: true,
			jsonMode: false,
			streaming: false,
			...options.capabilities,
		},
		calls,
		async complete(req: CompletionRequest): Promise<CompletionResult> {
			const call = callCount++;
			calls.push({ ...req });

			if (options.delayMs) await sleep(options.delayMs, req.signal);
			if (req.signal?.aborted) throw req.signal.reason;

			let respond = options.respond ?? "";
			if (Array.isArray(respond)) {
				respond = respond[Math.min(call, respond.length - 1)] ?? "";
			}
			if (respond instanceof Error) throw respond;
			if (typeof respond === "function") respond = await respond(req, call);

			const partial: Partial<CompletionResult> = typeof respond === "string"
				? { text: respond }
				: respond;

			return {
				text: "",
				finishReason: "stop",
				usage: {
					inputTokens: Math.ceil(req.input.length / 4),
					outputTokens: Math.ceil((partial.text ?? "").length / 4),
				},
				model: req.model,
				raw: { mock: true, call },
				...partial,
			};
		},
	};
}
