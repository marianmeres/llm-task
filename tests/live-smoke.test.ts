/**
 * Live smoke tests against the real provider APIs. Opt-in only:
 *
 * ```sh
 * deno task test:live         # needs ANTHROPIC_API_KEY (or .env)
 * deno task test:live:azure   # needs AZURE_OPENAI_* (or .env)
 * ```
 *
 * The default `deno task test` run ignores these tests (permissions are only
 * queried, never requested — no prompt, no network).
 *
 * `test:live:azure` grants `--allow-net` unscoped because the resource host is
 * per-customer and must not be hardcoded here. To narrow it, run the file
 * directly with `--allow-net=<your-resource>.openai.azure.com`.
 */
import { assert, assertEquals } from "@std/assert";
import { createAnthropicAdapter } from "../src/adapters/anthropic.ts";
import { createAzureOpenAIAdapter } from "../src/adapters/azure-openai.ts";
import { firstLine, unquote } from "../src/cleaners.ts";
import { createLlmClient } from "../src/client.ts";
import { readEnv } from "../src/utils.ts";

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

/** Azure config, or `null` when anything required is missing or unpermitted. */
const azure = (() => {
	// readEnv queries the permission before reading, so an ungranted run yields
	// undefined instead of a prompt
	const endpoint = readEnv("AZURE_OPENAI_ENDPOINT");
	const apiKey = readEnv("AZURE_OPENAI_API_KEY");
	const deployment = readEnv("AZURE_OPENAI_DEPLOYMENT");
	if (!endpoint || !apiKey || !deployment) return null;
	try {
		// the resource host is per-customer, so it cannot be a literal here
		const { host } = new URL(endpoint);
		if (Deno.permissions.querySync({ name: "net", host }).state !== "granted") {
			return null;
		}
	} catch {
		return null;
	}
	return {
		endpoint,
		apiKey,
		deployment,
		// unset uses the /openai/v1/ surface; set switches to the classic route
		apiVersion: readEnv("AZURE_OPENAI_API_VERSION"),
	};
})();

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

Deno.test({
	name: "live: azure structured output (json schema)",
	ignore: !azure,
	async fn() {
		const cfg = azure!;
		const client = createLlmClient({
			adapter: createAzureOpenAIAdapter({
				endpoint: cfg.endpoint,
				apiKey: cfg.apiKey,
				apiVersion: cfg.apiVersion,
			}),
			model: cfg.deployment,
		});
		const extract = client.task<{
			product: string;
			quantity: number;
			color: string | null;
		}>({
			system: "Extract the ordered product, quantity and color from the " +
				"user input.",
			schema: {
				type: "object",
				properties: {
					product: { type: "string" },
					quantity: { type: "integer" },
					color: { type: "string" },
				},
				// `color` is optional on purpose: the strict-mode normaliser
				// rewrites it to a required, null-widened property, and only a
				// real endpoint can confirm it accepts the result
				required: ["product", "quantity"],
			},
		});
		const r = await extract.run("Please send me three boxes of blue widgets.");
		assert(r.text.length > 0, "expected a non-empty completion");
		assert(r.usage, "expected the provider to report usage");
		assert(r.usage.outputTokens > 0);
		assertEquals(r.value.quantity, 3);
		assert(r.value.product.toLowerCase().includes("widget"));
		// strict mode admits no optional keys, so the widened one must be present
		assert("color" in r.value, "expected the widened optional key to be present");
	},
});
