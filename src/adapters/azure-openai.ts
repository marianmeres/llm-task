/**
 * @module adapters/azure-openai
 *
 * Azure OpenAI adapter — a thin configuration of the OpenAI-compatible core in
 * [`./openai.ts`](./openai.ts). Azure differs from OpenAI proper in three
 * things only: the URL shape, the auth header, and whether `model` names a
 * model or a deployment.
 */

import type { Adapter } from "../adapter.ts";
import { readEnv, stableStringify } from "../utils.ts";
import { createOpenAICompatibleAdapter, type MaxTokensField } from "./openai.ts";

/** Options for {@link createAzureOpenAIAdapter}. */
export interface AzureOpenAIAdapterOptions {
	/** Resource endpoint, e.g. "https://acme-eu.openai.azure.com" (no trailing slash). */
	endpoint: string;
	/**
	 * Azure OpenAI API key. When omitted, lazily falls back to the
	 * `AZURE_OPENAI_API_KEY` environment variable (in Deno only when
	 * `--allow-env` was granted — an explicit key never touches the environment).
	 */
	apiKey?: string;
	/**
	 * Dynamic credential source, called once per request. Takes precedence over
	 * `apiKey` and the environment fallback. Use for short-lived tokens — an
	 * Entra ID service principal, a managed identity, any OAuth flow — and do
	 * your own caching inside it; this package does not cache the token.
	 * Throwing surfaces as `AuthError`.
	 *
	 * Its value is sent in the same `api-key` header a static key uses. A
	 * resource that expects the token in `Authorization: Bearer` instead needs
	 * `createOpenAICompatibleAdapter` with its own `buildAuthHeaders`.
	 */
	getToken?: () => string | Promise<string>;
	/**
	 * When set, the classic deployment route is used and this value is sent as
	 * `api-version`. When omitted, the OpenAI-compatible `/openai/v1/` surface is
	 * used and `model` carries the deployment name.
	 */
	apiVersion?: string;
	/**
	 * Output token limit field name. Newer models reject the legacy
	 * `max_tokens`; older deployments require it.
	 * @default "max_completion_tokens"
	 */
	maxTokensField?: MaxTokensField;
	/** Extra request headers. Merged over the defaults. */
	headers?: Record<string, string>;
	/**
	 * Injectable `fetch` implementation (handy for tests — no network, no keys).
	 * Defaults to `fetchOrThrow` from `@marianmeres/http-utils` (native `fetch`
	 * with normalized transport errors).
	 */
	fetch?: typeof fetch;
}

const AZURE_ADAPTER_ID = "azure-openai";

/**
 * Creates the Azure OpenAI adapter.
 *
 * `CompletionRequest.model` carries the **deployment name**, not a model id —
 * on Azure the model is chosen when the deployment is created.
 *
 * Defaults to the `/openai/v1/` surface. Pass `apiVersion` to use the classic
 * `/openai/deployments/{deployment}/` route instead (older resources); the
 * deployment is then addressed through the URL and omitted from the body.
 *
 * Supports native structured output — the schema is normalized to strict
 * mode's restrictions automatically, see `normalizeOpenAiJsonSchema`.
 *
 * @example
 * ```typescript
 * import { createAzureOpenAIAdapter, createLlmClient } from "@marianmeres/llm-task";
 *
 * const client = createLlmClient({
 * 	adapter: createAzureOpenAIAdapter({
 * 		endpoint: "https://acme-eu.openai.azure.com", // or { apiKey: "..." }
 * 	}),
 * 	model: "classifier", // deployment name
 * });
 * ```
 */
export function createAzureOpenAIAdapter(
	options: AzureOpenAIAdapterOptions,
): Adapter {
	const endpoint = options.endpoint.replace(/\/+$/, "");
	const { apiVersion } = options;

	return createOpenAICompatibleAdapter({
		id: AZURE_ADAPTER_ID,
		// two differently configured resources must never collide in a shared cache
		fingerprint: `${endpoint}|${apiVersion ?? ""}|${options.maxTokensField ?? ""}|${
			stableStringify(options.headers ?? {})
		}`,
		buildUrl: (deployment) =>
			apiVersion
				? `${endpoint}/openai/deployments/${
					encodeURIComponent(deployment)
				}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
				: `${endpoint}/openai/v1/chat/completions`,
		buildAuthHeaders: (key) => ({ "api-key": key }),
		// the classic route addresses the deployment through the URL
		sendModel: !apiVersion,
		resolveKey: () =>
			options.getToken?.() ?? options.apiKey ?? readEnv("AZURE_OPENAI_API_KEY"),
		missingKeyMessage: "Missing Azure OpenAI API key — pass `apiKey` to " +
			"createAzureOpenAIAdapter() or set the AZURE_OPENAI_API_KEY environment " +
			"variable (Deno: requires --allow-env=AZURE_OPENAI_API_KEY).",
		maxTokensField: options.maxTokensField,
		headers: options.headers,
		fetch: options.fetch,
		capabilities: { jsonSchema: true, jsonMode: false, streaming: false },
	});
}
