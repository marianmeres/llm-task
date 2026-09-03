<!--
GENERATED ANALYSIS — @marianmeres/llm-task · OpenAI-compatible + Azure OpenAI adapter
Produced 2026-09-03 by inline research → verify pass against the working tree → synthesize.
Claims verified against the codebase at commit 9ea4d90. Planning artifact; no code was changed.
-->

# OpenAI-compatible adapter, and Azure on top of it

> The package ships one real adapter today — `createAnthropicAdapter` at
> [`src/adapters/anthropic.ts:85`](../../src/adapters/anthropic.ts) — plus the mock. The
> Azure OpenAI adapter the customer project needs is not a one-off: Azure is a variant of
> the OpenAI Chat Completions wire format, and the same core also covers OpenAI proper,
> GitHub Models, Groq, OpenRouter, Together and Ollama. `AGENTS.md` already names this as
> the obvious next adapter.
>
> The headline recommendation is to build **one parameterised core plus two thin
> factories**, not two independent adapters. The delta between OpenAI and Azure is three
> things — the URL shape, the auth header, and whether `model` names a model or a
> deployment — and every one of them is a config value, not a code path.
>
> Sequencing matters here. The core lands first _without_ native structured output, then
> a second commit adds the strict-mode schema normaliser and flips the capability on. Each
> step is independently coherent and independently green, which is what makes them two
> reviewable commits instead of one large one.

## Summary of recommendations

| # | Recommendation                                                    | Value | Effort | Risk |
| - | ----------------------------------------------------------------- | ----- | ------ | ---- |
| 1 | OpenAI-compatible core + `createOpenAIAdapter` (no native schema) | high  | M      | low  |
| 2 | OpenAI strict-mode schema normaliser; enable `jsonSchema`         | high  | M      | med  |
| 3 | `createAzureOpenAIAdapter` over the core                          | high  | S      | low  |
| 4 | Leave `capabilities.jsonMode` at `false` — deliberately           | —     | —      | —    |

## Findings & recommendations (detailed)

### 1. OpenAI-compatible core + `createOpenAIAdapter`

- **Problem / observation** — there is no adapter for the most widely cloned wire format
  in the ecosystem, and the customer project needs Azure specifically. Writing Azure
  standalone would duplicate ~80% of a general OpenAI adapter and leave the general one
  still unwritten.

- **Evidence** — the existing adapter is the shape to mirror. The returned object is small
  and policy-free: `id` at [`anthropic.ts:91`](../../src/adapters/anthropic.ts),
  `fingerprint` at `:93`, `capabilities` at `:94`, `complete()` at `:95`. Credentials are
  read lazily inside `complete()` at `:96` via `readEnv` — never at construction, so an
  explicit key never touches the environment ([`src/utils.ts:16`](../../src/utils.ts)).
  Errors go through the shared `errorFromHttpStatus`
  ([`src/errors.ts:204`](../../src/errors.ts)) and `parseRetryAfter` (`:174`).

- **Proposed change** — a new `src/adapters/openai.ts` exporting an internal parameterised
  builder plus the public factory:

  ```typescript
  /** The knobs that differ between OpenAI-compatible providers. */
  interface OpenAICompatibleConfig {
  	id: string;
  	fingerprint: string;
  	buildUrl: (model: string) => string;
  	buildAuthHeaders: (key: string) => Record<string, string>;
  	/** Model field on the wire; Azure's classic route omits it. */
  	sendModel: boolean;
  	resolveKey: () => string | undefined;
  	headers?: Record<string, string>;
  	fetch?: typeof fetch;
  	capabilities: AdapterCapabilities;
  }

  export function createOpenAIAdapter(options?: OpenAIAdapterOptions): Adapter;
  ```

  Wire mapping for the core:

  | Direction | Mapping                                                                                                    |
  | --------- | ---------------------------------------------------------------------------------------------------------- |
  | Request   | `POST {baseUrl}/chat/completions`                                                                          |
  | Body      | `{ model, messages, max_completion_tokens, temperature? }`                                                 |
  | Messages  | `system` → `{ role: "system", content }` (omitted when unset), then `{ role: "user", content: input }`     |
  | Auth      | `Authorization: Bearer {key}`                                                                              |
  | Text      | `choices[0].message.content ?? ""`                                                                         |
  | Finish    | `stop` → `stop`; `length` → `length`; `content_filter` → `content_filter`; anything else → `other`         |
  | Usage     | `usage.prompt_tokens` → `inputTokens`; `usage.completion_tokens` → `outputTokens`                          |
  | Model     | `data.model ?? req.model`                                                                                  |
  | Errors    | `{ error: { message, type, code } }` → `errorFromHttpStatus`, with a context-length regex for the 400 case |

  Prompt/input separation is preserved exactly as the contract requires
  ([`src/adapter.ts:38`](../../src/adapter.ts)): the instruction is a `system` message and
  the untrusted input is a separate `user` message. They are never concatenated.

  Three details that are easy to get wrong and are worth pinning in the implementation:

  - **`max_completion_tokens`, not `max_tokens`.** Newer models reject the legacy field.
    Expose `maxTokensField?: "max_tokens" | "max_completion_tokens"` defaulting to
    `max_completion_tokens`, so an older-model or clone endpoint stays reachable without a
    fork.
  - **`content` can be `null`** on a refusal or a tool-only turn. Coalesce to `""` rather
    than letting `undefined` reach `CompletionResult.text`, which is typed `string`.
  - **A 2xx with a non-JSON body must still normalise.** The Anthropic adapter turns that
    into a retryable `TransientError` rather than letting a bare `SyntaxError` escape
    ([`anthropic.ts:141`](../../src/adapters/anthropic.ts)); mirror it. A gateway in front
    of Azure is exactly where this happens.

  Ship this step with `capabilities: { jsonSchema: false, jsonMode: false, streaming: false }`.
  Structured tasks then use the client's prompt-instruction strategy, which already works
  and is covered by tests — native support arrives in #2.

- **Done when** — `tests/openai.test.ts` exists and `deno task test` passes with it,
  covering: system/user message separation, `max_completion_tokens` naming, bearer header,
  each `finish_reason` mapping, usage mapping, `content: null` → `""`, 401/429/500/400
  error mapping, `Retry-After` propagation, a non-JSON 2xx body, and abort passthrough.
  `deno check src/mod.ts` exits 0 with `createOpenAIAdapter` exported.

- **Affected files** — `src/adapters/openai.ts` (new), `src/mod.ts`,
  `tests/openai.test.ts` (new).

- **Effort / Value / Risk** — M / high / low. Purely additive; nothing existing changes.

- **Implementation notes** — mirror the DI fetch stub from
  [`tests/anthropic.test.ts:28`](../../tests/anthropic.test.ts) (`makeFetch`) verbatim in
  the new test file rather than extracting a shared helper; the duplication is small and
  keeps each adapter's test file readable standalone. Use `fetchOrThrow` from
  `@marianmeres/http-utils` as the default `fetch`, and re-throw abort-like errors
  untouched via `isAbortLike` ([`src/utils.ts:161`](../../src/utils.ts)) exactly as
  [`anthropic.ts:127`](../../src/adapters/anthropic.ts) does.

### 2. OpenAI strict-mode schema normaliser

- **Problem / observation** — OpenAI's structured outputs impose restrictions that differ
  from Anthropic's, so `normalizeJsonSchema` from the Anthropic adapter cannot be reused.
  Sending an unnormalised schema produces a 400 that reads as a generic invalid request,
  which is a bad first experience for the exact feature the customer project depends on.

- **Evidence** — the Anthropic normaliser is at
  [`anthropic.ts:246`](../../src/adapters/anthropic.ts) and is explicitly Anthropic-shaped:
  its `UNSUPPORTED_SCHEMA_KEYWORDS` list at `:222` strips numeric and string constraints,
  and it forces `additionalProperties: false`. OpenAI strict mode shares the
  `additionalProperties: false` requirement but adds one the Anthropic path does not have:
  **every key in `properties` must also appear in `required`.**

- **Proposed change** — `normalizeOpenAiJsonSchema(schema: JsonSchema): JsonSchema` in
  `src/adapters/openai.ts`, walking the schema the same way `walkSchema`
  ([`anthropic.ts:252`](../../src/adapters/anthropic.ts)) does, and:

  1. forcing `additionalProperties: false` on every object schema;
  2. setting `required` to the full key list of `properties` — an optional field is
     expressed by widening its type to include `"null"`, not by omission;
  3. stripping the keywords strict mode rejects;
  4. **throwing `InvalidRequestError` rather than silently rewriting** for record/map
     schemas (schema-valued `additionalProperties`) and `patternProperties`-only objects,
     exactly as [`anthropic.ts:283`](../../src/adapters/anthropic.ts) already does. That
     refusal-over-silent-rewrite stance is an established property of this package and the
     new adapter must not weaken it.

  Then set `capabilities.jsonSchema: true` and send:

  ```typescript
  body.response_format = {
  	type: "json_schema",
  	json_schema: {
  		name: "output",
  		strict: true,
  		schema: normalizeOpenAiJsonSchema(req.jsonSchema),
  	},
  };
  ```

  Note that widening optional properties to `["T", "null"]` changes the value the model may
  return. When the task also carries a Standard Schema validator the client still validates
  client-side, so a `null` where the schema wanted a missing key surfaces as a validation
  failure and gets one repair round-trip — the existing behaviour, not a new failure mode.
  This is worth a sentence in the JSDoc.

- **Done when** — `deno task test` passes with normaliser cases covering: nested objects
  all getting `additionalProperties: false`; `required` filled from `properties` at every
  level; `$defs`/`anyOf`/`items` recursion; `InvalidRequestError` thrown for a
  schema-valued `additionalProperties` and for a `patternProperties`-only object; and an
  adapter-level test asserting `response_format.json_schema.strict === true` on the wire.

- **Affected files** — `src/adapters/openai.ts`, `tests/openai.test.ts`.

- **Effort / Value / Risk** — M / high / med. The risk is schema-shape edge cases, which is
  precisely what the test list above exists to pin down.

- **Implementation notes** — do not try to share a walker with the Anthropic normaliser.
  The two differ in their `required` handling and their keyword lists, and a shared walker
  parameterised by both would be harder to read than two ~70-line functions. Two adapters,
  two normalisers, no abstraction.

### 3. `createAzureOpenAIAdapter` over the core

- **Problem / observation** — the customer project (see the design overview) needs Azure
  specifically, in the customer's own tenant, addressed by endpoint + deployment rather
  than by model name.

- **Evidence** — three deltas from OpenAI proper, all config:

  | Aspect        | OpenAI                        | Azure                                                                       |
  | ------------- | ----------------------------- | --------------------------------------------------------------------------- |
  | URL           | `{baseUrl}/chat/completions`  | `{endpoint}/openai/v1/chat/completions` (v1 surface)                        |
  | URL (classic) | —                             | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…` |
  | Auth header   | `Authorization: Bearer {key}` | `api-key: {key}`                                                            |
  | `model`       | model id                      | deployment name (v1 surface); omitted from the body on the classic route    |

- **Proposed change** — `src/adapters/azure-openai.ts`:

  ```typescript
  export interface AzureOpenAIAdapterOptions {
  	/** Resource endpoint, e.g. "https://acme-eu.openai.azure.com" (no trailing slash). */
  	endpoint: string;
  	/** Falls back to AZURE_OPENAI_API_KEY. */
  	apiKey?: string;
  	/**
  	 * When set, the classic deployment route is used and this value is sent as
  	 * `api-version`. When omitted, the OpenAI-compatible `/openai/v1/` surface is
  	 * used and `model` carries the deployment name.
  	 */
  	apiVersion?: string;
  	headers?: Record<string, string>;
  	fetch?: typeof fetch;
  }
  ```

  Defaulting to the `/openai/v1/` surface keeps the adapter a near-passthrough of the core
  and means `CompletionRequest.model` carries the deployment name — which reads naturally
  at the call site (`model: "classifier"`). Setting `apiVersion` opts into the classic
  route for an older resource. This removes the need to decide between the two routes up
  front, at a cost of roughly six lines.

  `fingerprint` must include the endpoint, the api-version and the extra headers — two
  differently-configured Azure resources sharing `id: "azure-openai"` must never collide in
  a shared cache. The Anthropic adapter's line at
  [`anthropic.ts:93`](../../src/adapters/anthropic.ts) is the pattern.

- **Done when** — `tests/azure-openai.test.ts` passes, asserting: the v1 URL when
  `apiVersion` is unset and the classic deployment URL with the `api-version` query
  parameter when it is set; the `api-key` header (and no `Authorization` header); the
  deployment name reaching the wire correctly on both routes; distinct `fingerprint`s for
  two different endpoints; and error mapping. `deno check src/mod.ts` exits 0 with
  `createAzureOpenAIAdapter` exported.

- **Affected files** — `src/adapters/azure-openai.ts` (new), `src/adapters/openai.ts`
  (export the internal builder), `src/mod.ts`, `tests/azure-openai.test.ts` (new).

- **Effort / Value / Risk** — S / high / low, given #1 and #2 have landed.

- **Implementation notes** — export the parameterised builder
  (`createOpenAICompatibleAdapter`) publicly as well. It is the supported way for a
  consumer to reach Groq, Together, OpenRouter or a self-hosted Ollama without waiting for
  an adapter in this package, and at version 0.2.0 an additive export is cheap. Say so in
  its JSDoc.

### 4. `capabilities.jsonMode` stays `false` — deliberately

`AdapterCapabilities.jsonMode` is declared at
[`src/adapter.ts:17`](../../src/adapter.ts) and **the client never reads it**. The only
capability consulted is `jsonSchema`, at
[`src/client.ts:437`](../../src/client.ts):

```typescript
const native = !!wireSchema && adapter.capabilities.jsonSchema;
```

So an adapter declaring `jsonMode: true` today changes nothing. OpenAI's
`response_format: { type: "json_object" }` would only add "the output is syntactically
valid JSON" on top of the client's existing prompt instruction — which already states the
requirement and, with a schema, states its shape too. Wiring a third strategy branch into
the client for that is not worth the added surface.

**Recommendation: set `jsonMode: false` in both new adapters and leave the client alone.**
Recorded here so a future reader can see this was considered rather than missed.

## Decisions taken

All questions from this doc were resolved in the 2026-09-03 sweep; see the Decisions log in
[`PROGRESS.md`](./PROGRESS.md) for the full record and rationale.

- **`createOpenAICompatibleAdapter` is exported publicly.** It is the supported way to reach
  Groq, Together, OpenRouter, Fireworks or a self-hosted Ollama without a PR. Additive at
  0.2.0, and it commits the package to the config object's shape — so treat that shape as
  public API from T01 onward, not as an internal detail to tidy later.
- **`maxTokensField` defaults to `max_completion_tokens`**, overridable per adapter. Newer
  models reject the legacy `max_tokens`; older clone endpoints require it. Worth a sanity
  check against whichever model the customer's Azure resource actually deploys, but not a
  blocker — the option exists precisely so that check can fail without a code change.
