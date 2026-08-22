# API Reference

Complete reference for `@marianmeres/llm-task`.

## Table of Contents

**Factory functions**

- [`createLlmClient(config)`](#createllmclientconfig-llmclient)
- [`createAnthropicAdapter(options?)`](#createanthropicadapteroptions-adapter)
- [`createMockAdapter(options?)`](#createmockadapteroptions-mockadapter)
- [`createMemoryCache(options?)`](#creatememorycacheoptions-memorycache)

**Helpers**

- [`batch(taskFn, inputs, options?)`](#batchtaskfn-inputs-options-promisebatchitemresultt-i)
- [Cleaners](#cleaners)
- [Errors](#errors)
- [Schema helpers](#schema-helpers)

**Types**

- [Client & task types](#client--task-types)
- [Adapter types](#adapter-types)
- [Cache types](#cache-types)
- [`Logger`](#logger)

---

## Functions

### `createLlmClient(config): LlmClient`

Creates the client: one place for the adapter, defaults, retries, timeouts,
cache and hooks. All policy lives here — adapters stay thin.

**Parameters** (`LlmClientConfig`):

| Option        | Type                             | Default                                                | Description                                                        |
| ------------- | -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `adapter`     | `Adapter`                        | — (required)                                           | provider adapter                                                   |
| `model`       | `string`                         | —                                                      | default model for all tasks (provider-native id)                   |
| `maxTokens`   | `number`                         | `1024`                                                 | default max output tokens                                          |
| `temperature` | `number`                         | provider default                                       | default sampling temperature                                       |
| `timeoutMs`   | `number`                         | `30000`                                                | per-call deadline incl. retries + repair; `0` disables             |
| `retry`       | `Partial<RetryOptions> \| false` | `{ attempts: 3, baseDelayMs: 500, maxDelayMs: 10000 }` | retry policy; `false` disables                                     |
| `cache`       | `LlmCache \| false`              | none                                                   | completion cache (e.g. `createMemoryCache()`)                      |
| `hooks`       | `LlmHooks`                       | —                                                      | client-level lifecycle hooks                                       |
| `logger`      | `Logger`                         | quiet (warn/error only)                                | internal diagnostics; `console` and `@marianmeres/clog` compatible |

**Returns:** `LlmClient` with:

- `task(config)` — defines a reusable task (see below)
- `run(config & { input }, options?)` — one-shot escape hatch, returns the full
  `TaskResult` envelope
- `adapter` — the underlying adapter (readonly)

**Throws:** `TypeError` when `adapter` is missing.

**Example:**

```typescript
const client = createLlmClient({
	adapter: createAnthropicAdapter(),
	model: "claude-haiku-4-5",
	cache: createMemoryCache(),
});
```

#### `client.task(config): LlmTask<T>`

Defines a reusable task. The return type follows the config:

- `schema` is a Standard Schema → `LlmTask<InferOutput<S>>`
- `schema` is a plain JSON Schema → `LlmTask<unknown>` (or `client.task<T>(...)`)
- `jsonSchema` alone (no `schema`) → structured task, `LlmTask<unknown>` (or
  `client.task<T>(...)`), no client-side validation
- a `schema` value only statically typed as the union
  `StandardSchemaV1 | JsonSchema` → `LlmTask<unknown>`
- no schema at all → `LlmTask<string>`

**Parameters** (`TaskConfig` — extends all `TaskDefaults` above: `model`,
`maxTokens`, `temperature`, `timeoutMs`, `retry`, `hooks`):

| Option           | Type                             | Default | Description                                                                                                                                                                          |
| ---------------- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system`         | `string`                         | —       | task instruction (system prompt); caller input is never concatenated into it                                                                                                         |
| `schema`         | `StandardSchemaV1 \| JsonSchema` | —       | opt-in structured output                                                                                                                                                             |
| `jsonSchema`     | `JsonSchema`                     | —       | wire schema to pair with a Standard Schema `schema` (e.g. `z.toJSONSchema(S)`, zod v4) — enables native structured output; usable without `schema` too (structured, typed `unknown`) |
| `clean`          | `Cleaner[]`                      | `[]`    | output cleaners, applied in order (string tasks only)                                                                                                                                |
| `allowTruncated` | `boolean`                        | `false` | return partial text instead of throwing `TruncatedOutputError`                                                                                                                       |
| `maxInputChars`  | `number`                         | off     | truncate long input before sending (reported, never silent)                                                                                                                          |
| `cache`          | `boolean`                        | `true`  | participate in the client cache                                                                                                                                                      |

**Returns:** `LlmTask<T>` — a callable:

- `await task(input, options?)` → `T` (the bare value)
- `await task.run(input, options?)` → `TaskResult<T>` (full envelope)

Per-call `options` (`TaskRunOptions`): `signal`, `model`, `maxTokens`,
`temperature`, `timeoutMs`, `cache`.

**Example:**

```typescript
const classify = client.task({
	system:
		"Classify the support message as bug | question | feature. Reply with the single word.",
	maxTokens: 8,
	clean: [cleaners.trim],
});
const kind = await classify(message); // "bug" | ...
```

#### `client.run(config, options?): Promise<TaskResult<T>>`

Bare one-shot — a `TaskConfig` plus `input`, without defining a reusable task.
Same typing rules as `task()`, but always returns the full envelope.

```typescript
const r = await client.run({ system: "Summarize.", input, maxTokens: 128 });
console.log(r.value, r.usage);
```

---

### `createAnthropicAdapter(options?): Adapter`

Anthropic Messages API adapter (`POST {baseUrl}/v1/messages`, raw `fetch`, no
SDK dependency). Capabilities: `{ jsonSchema: true, jsonMode: false, streaming: false }`.

**Parameters** (`AnthropicAdapterOptions`):

| Option    | Type                     | Default                                         | Description                                                 |
| --------- | ------------------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| `apiKey`  | `string`                 | env `ANTHROPIC_API_KEY` (lazy)                  | explicit key always wins and never touches the environment  |
| `baseUrl` | `string`                 | `"https://api.anthropic.com"`                   | API base URL (proxies, gateways)                            |
| `version` | `string`                 | `"2023-06-01"`                                  | `anthropic-version` header                                  |
| `headers` | `Record<string, string>` | —                                               | extra headers (e.g. `anthropic-beta`), merged over defaults |
| `fetch`   | `typeof fetch`           | `fetchOrThrow` (from `@marianmeres/http-utils`) | injectable fetch for tests                                  |

Behavior notes:

- Requires a model that supports the Messages API; pass provider-native model
  ids (`"claude-haiku-4-5"`, `"claude-sonnet-5"`, ...) — no alias maps.
- Native structured output via `output_config.format` JSON schema; the schema
  is normalized to Anthropic's restrictions (see `normalizeJsonSchema`).
- `stop_reason` mapping: `end_turn`/`stop_sequence` → `"stop"`, `max_tokens` →
  `"length"`, `refusal` → `"content_filter"`, anything else → `"other"`.
- Error mapping: 401/403 → `AuthError`, 429 → `RateLimitError` (+`retryAfter`),
  413 or context-length 400 → `ContextLengthError`, other 400-class →
  `InvalidRequestError`, 5xx/529/network → `TransientError`.
- Sets `Adapter.fingerprint` from `baseUrl` + `version` + `headers`, so
  differently configured instances never share client cache entries.

### `normalizeJsonSchema(schema): JsonSchema`

Exported for testing/inspection: recursively sets
`additionalProperties: false` on object schemas and strips constraint keywords
Anthropic structured outputs reject (`minimum`, `maxLength`, `pattern`,
`minItems`, ...). Applied automatically by the Anthropic adapter.

**Throws** `InvalidRequestError` for schemas whose meaning cannot survive the
restrictions instead of silently rewriting them: a schema-valued
`additionalProperties` (record/map schemas, e.g. `z.record(...)`) or an object
schema whose only property mechanism is `patternProperties`. Restructure such
data (e.g. an array of `{ key, value }` objects) or drop the wire schema.

---

### `createMockAdapter(options?): MockAdapter`

Mock adapter for unit testing consumer code — no network, no keys. Records
every request in `adapter.calls`.

**Parameters** (`MockAdapterOptions`):

| Option         | Type                             | Default                | Description                                                                                                             |
| -------------- | -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `respond`      | `MockResponse \| MockResponse[]` | `""`                   | string, `Partial<CompletionResult>`, `Error` (thrown), function `(req, callIndex) => ...`, or a sequence (last repeats) |
| `delayMs`      | `number`                         | `0`                    | artificial latency (abortable)                                                                                          |
| `id`           | `string`                         | `"mock"`               | adapter id                                                                                                              |
| `capabilities` | `Partial<AdapterCapabilities>`   | `{ jsonSchema: true }` | capability overrides                                                                                                    |

**Example** (testing retry behavior):

```typescript
const adapter = createMockAdapter({
	respond: [new TransientError("flaky"), "ok"],
});
```

---

### `createMemoryCache(options?): MemoryCache`

Bundled in-memory LRU cache. `{ maxEntries?: number }` (default `1000`).
Returns an `LlmCache` with extra `size` (readonly) and `clear()`. Entries never
expire — eviction is LRU only. Throws `RangeError` on invalid `maxEntries`.

---

### `batch(taskFn, inputs, options?): Promise<BatchItemResult<T, I>[]>`

Runs a task (or any `(input, { signal }?) => Promise<T>` function) over many
inputs with bounded concurrency and per-item error isolation. Results keep
input order.

**Parameters:**

- `taskFn` — the function to run per input
- `inputs` — `readonly I[]`
- `options` (`BatchOptions`): `concurrency` (default `5`), `signal` (stops
  scheduling and is passed through to each call), `onProgress({ done, total, ok, failed, index })`

**Returns:** array of
`{ ok: true, value, input, index } | { ok: false, error, input, index }`.

**Throws:** `TypeError` on invalid `concurrency`.

---

## Cleaners

Composable `(text: string) => string` functions for the task `clean` option
(applied in order; string tasks only). Importable individually or grouped as
`cleaners`:

| Cleaner                         | Effect                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `trim`                          | trims whitespace                                                                 |
| `unquote`                       | removes one pair of matching surrounding quotes (`"` `'` `“”` `‘’` `«»` `` ` ``) |
| `stripFences`                   | unwraps a single surrounding markdown code fence                                 |
| `firstLine`                     | first non-empty line, trimmed                                                    |
| `collapseWhitespace`            | collapses all whitespace runs to single spaces                                   |
| `stripPrefix(prefix)`           | factory — removes a leading `string` (case-insensitive) or `RegExp`              |
| `applyCleaners(text, cleaners)` | applies a list left to right                                                     |

---

## Errors

All extend `LLMError extends Error` with `adapter?`, `status?`, `raw?`,
`retryable` and standard `cause`. Branch with `instanceof`. See the table in
[README](./README.md#error-handling).

| Export                  | Extra fields                                     |
| ----------------------- | ------------------------------------------------ |
| `LLMError`              | base: `adapter?`, `status?`, `raw?`, `retryable` |
| `AuthError`             |                                                  |
| `RateLimitError`        | `retryAfter?: number` (seconds)                  |
| `ContextLengthError`    |                                                  |
| `ContentFilterError`    |                                                  |
| `InvalidRequestError`   |                                                  |
| `TransientError`        |                                                  |
| `TimeoutError`          |                                                  |
| `TruncatedOutputError`  | `text: string` (the partial output)              |
| `OutputValidationError` | `text: string`, `issues: ValidationIssue[]`      |

Helpers (mainly for adapter authors):

- `isRetryableError(e): boolean` — `true` for retryable `LLMError`s
- `parseRetryAfter(headerValue): number | undefined` — seconds from a
  `Retry-After` header (delta-seconds or HTTP-date)
- `errorFromHttpStatus(status, message, options?): LLMError` — status → error
  class mapping shared by adapters

---

## Schema helpers

- `StandardSchemaV1<Input, Output>` — the vendored
  [Standard Schema v1](https://standardschema.dev) interface (types only;
  implemented by zod/valibot/arktype)
- `InferOutput<S>` — infers a Standard Schema's output type
- `JsonSchema` — loosely typed plain JSON Schema object
- `isStandardSchema(value)` — type guard
- `parseJsonLoose(text)` — tolerant JSON parse (trims, unwraps one code fence);
  throws `SyntaxError`
- `formatIssues(issues)` — issues → short readable string
- `buildJsonInstruction(jsonSchema?)`, `buildRepairInstruction(text, issues)` —
  the prompt fragments used by the degradation/repair strategies (exported for
  transparency/testing)

---

## Types

### Client & task types

```typescript
interface RetryOptions {
	attempts: number; // total attempts (1 = no retries), default 3
	baseDelayMs: number; // default 500
	maxDelayMs: number; // default 10000 (Retry-After may exceed it)
}

interface LlmHooks {
	onRequest?: (info: HookRequestInfo) => void; // before every real adapter call
	onResponse?: (info: HookResponseInfo) => void; // every success, incl. cache hits
	onRetry?: (info: HookRetryInfo) => void; // before each backoff sleep
	onInputTruncated?: (info: HookInputTruncatedInfo) => void;
}

interface TaskResult<T = string> {
	value: T; // cleaned string or validated typed object
	text: string; // final completion text
	finishReason: "stop" | "length" | "content_filter" | "other";
	usage?: { inputTokens: number; outputTokens: number };
	model: string; // as reported by the provider
	raw: unknown; // raw provider body (undefined on cache hits)
	cached: boolean; // no adapter call at all (a stale hit that needed repair -> false)
	inputTruncated: boolean;
	attempts: number; // total adapter calls (0 = pure cache hit)
	repaired: boolean; // the single JSON repair round-trip was used
}

interface LlmTask<T = string> {
	(input: string, options?: TaskRunOptions): Promise<T>;
	run(input: string, options?: TaskRunOptions): Promise<TaskResult<T>>;
}
```

(See `TaskConfig`, `TaskDefaults`, `TaskRunOptions`, `LlmClientConfig`,
`RunConfig`, `LlmClient` and the `Hook*Info` shapes in the source JSDoc — all
exported.)

### Adapter types

```typescript
interface Adapter {
	readonly id: string;
	readonly fingerprint?: string; // distinguishes configs sharing an id (cache keys)
	readonly capabilities: {
		jsonSchema: boolean; // native structured output
		jsonMode: boolean; // loose "must be JSON" mode (reserved)
		streaming: boolean; // reserved for a later stream()
	};
	complete(req: CompletionRequest): Promise<CompletionResult>;
}

interface CompletionRequest {
	system?: string;
	input: string; // untrusted input — separate user message
	model: string;
	maxTokens: number; // always set by the client
	temperature?: number;
	jsonSchema?: JsonSchema; // only when the native strategy was chosen
	signal?: AbortSignal; // composed caller signal + deadline
}

interface CompletionResult {
	text: string;
	finishReason: "stop" | "length" | "content_filter" | "other";
	usage?: { inputTokens: number; outputTokens: number };
	model: string;
	raw: unknown; // never swallowed
}
```

### Cache types

```typescript
interface LlmCache {
	get(
		key: string,
	): CachedCompletion | undefined | Promise<CachedCompletion | undefined>;
	set(key: string, value: CachedCompletion): void | Promise<void>;
}

interface CachedCompletion {
	text: string;
	finishReason: FinishReason; // always "stop" in practice
	usage?: CompletionUsage;
	model: string;
}
```

Cache errors are logged and ignored — a broken cache never breaks a call.

### `Logger`

```typescript
interface Logger {
	debug: (...args: unknown[]) => unknown;
	log: (...args: unknown[]) => unknown;
	warn: (...args: unknown[]) => unknown;
	error: (...args: unknown[]) => unknown;
}
```

Structurally compatible with `console` and with `@marianmeres/clog` instances —
no logging dependency is bundled.
