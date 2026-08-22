/**
 * Live smoke test against the real Anthropic API. Opt-in only:
 *
 * ```sh
 * deno task test:live   # needs ANTHROPIC_API_KEY (or .env)
 * ```
 *
 * The default `deno task test` run ignores these tests (permissions are only
 * queried, never requested — no prompt, no network).
 */
import { assert, assertEquals } from "@std/assert";
import { createAnthropicAdapter } from "../src/adapters/anthropic.ts";
import { firstLine, unquote } from "../src/cleaners.ts";
import { createLlmClient } from "../src/client.ts";

const granted = (() => {
	try {
		return (
			Deno.permissions.querySync({
					name: "env",
					variable: "ANTHROPIC_API_KEY",
				}).state === "granted" &&
			Deno.permissions.querySync({
					name: "net",
					host: "api.anthropic.com",
				}).state === "granted" &&
			!!Deno.env.get("ANTHROPIC_API_KEY")
		);
	} catch {
		return false;
	}
})();

const MODEL = "claude-haiku-4-5";

Deno.test({
	name: "live: string task (title summarization)",
	ignore: !granted,
	async fn() {
		const client = createLlmClient({
			adapter: createAnthropicAdapter(),
			model: MODEL,
		});
		const toTitle = client.task({
			system: "Summarize the user input into a single short sentence title.",
			maxTokens: 64,
			clean: [unquote, firstLine],
		});
		const r = await toTitle.run(
			"The quarterly report shows revenue grew 12% while costs stayed flat, " +
				"mainly driven by the new subscription tier launched in March.",
		);
		assert(r.value.length > 0, "expected a non-empty title");
		assert(r.usage!.outputTokens > 0);
		assertEquals(r.finishReason, "stop");
	},
});

Deno.test({
	name: "live: structured output (json schema)",
	ignore: !granted,
	async fn() {
		const client = createLlmClient({
			adapter: createAnthropicAdapter(),
			model: MODEL,
		});
		const extract = client.task<{ product: string; quantity: number }>({
			system: "Extract the ordered product and quantity from the user input.",
			schema: {
				type: "object",
				properties: {
					product: { type: "string" },
					quantity: { type: "integer" },
				},
				required: ["product", "quantity"],
			},
		});
		const order = await extract(
			"Please send me three boxes of blue widgets.",
		);
		assertEquals(order.quantity, 3);
		assert(order.product.toLowerCase().includes("widget"));
	},
});
