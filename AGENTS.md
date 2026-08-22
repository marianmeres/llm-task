# @marianmeres/llm-task - Agent Reference

Machine-readable documentation for AI agents and code assistants.

## Package Overview

- **Name**: `@marianmeres/llm-task`
- **Purpose**: One-shot, stateless LLM calls ("summarize into a title",
  "classify", "extract") as reusable, typed task functions — provider-agnostic,
  with normalized errors, retries and timeouts
- **Runtime**: Deno (also published to npm); runs in Node 20+, Bun, Cloudflare
  Workers and the browser (no Node/Deno-only APIs unguarded)
- **Entry Point**: `./src/mod.ts`
- **Runtime deps**: `@marianmeres/http-utils` only (no provider SDKs — raw `fetch`)

## Non-goals (by design)

Not a chat SDK, not an agent framework. Out of scope: conversation history,
tool calling / agent loops, embeddings, multimodal input, streaming (v1;
reserved via `capabilities.streaming` + a later separate `stream()`), model
alias maps, fallback chains (belongs in a consumer wrapper).

## Exports

```typescript
export {
	// cleaners
	applyCleaners,
	// errors
	AuthError,
	// batch + cache
	batch,
	// schema
	buildJsonInstruction,
	buildRepairInstruction,
	cleaners,
	collapseWhitespace,
	ContentFilterError,
	ContextLengthError,
	// adapters
	createAnthropicAdapter,
	// client / tasks
	createLlmClient, // LlmClient: task(), run(), adapter
	createMemoryCache,
	createMockAdapter,
	errorFromHttpStatus,
	firstLine,
	formatIssues,
	InvalidRequestError,
	isRetryableError,
	isStandardSchema,
	LLMError,
	normalizeJsonSchema,
	OutputValidationError,
	parseJsonLoose,
	parseRetryAfter,
	RateLimitError,
	stripFences,
	stripPrefix,
	TimeoutError,
	TransientError,
	trim,
	TruncatedOutputError,
	unquote,
} from "./src/mod.ts";
// + all types: Adapter, AdapterCapabilities, CompletionRequest,
// CompletionResult, CompletionUsage, FinishReason, LlmClient, LlmClientConfig,
// LlmTask, TaskConfig, TaskDefaults, TaskRunOptions, TaskResult, RunConfig,
// RetryOptions, LlmHooks, Hook*Info, LlmCache, CachedCompletion, MemoryCache,
// MemoryCacheOptions, BatchOptions, BatchProgress, BatchItemResult, Cleaner,
// Logger, StandardSchemaV1, StandardSchemaProps, StandardResult, InferOutput,
// JsonSchema, ValidationIssue, *ErrorOptions, MockAdapter, MockAdapterOptions,
// MockResponse, AnthropicAdapterOptions
```

## Core Types

```typescript
interface Adapter {
	readonly id: string;
	readonly fingerprint?: string; // distinguishes configs sharing an id (cache keys)
	readonly capabilities: { jsonSchema: boolean; jsonMode: boolean; streaming: boolean };
	complete(req: CompletionRequest): Promise<CompletionResult>;
}

interface CompletionRequest {
	system?: string; // instruction — NEVER concatenated with input
	input: string; // untrusted input — separate user message
	model: string; // provider-native id
	maxTokens: number; // always set by the client (default 1024)
	temperature?: number;
	jsonSchema?: JsonSchema; // only when native structured output chosen
	signal?: AbortSignal;
}

interface CompletionResult {
	text: string;
	finishReason: "stop" | "length" | "content_filter" | "other";
	usage?: { inputTokens: number; outputTokens: number };
	model: string;
	raw: unknown; // never swallowed
}

interface TaskResult<T = string> {
	value: T;
	text: string;
	finishReason: FinishReason;
	usage?: CompletionUsage;
	model: string;
	raw: unknown;
	cached: boolean;
	inputTruncated: boolean;
	attempts: number;
	repaired: boolean;
}

interface LlmTask<T = string> {
	(input: string, options?: TaskRunOptions): Promise<T>; // bare value
	run(input: string, options?: TaskRunOptions): Promise<TaskResult<T>>; // envelope
}
```

## Layering (keep it this way)

```
consumer code
	├── client.task() / batch()      ← ergonomics
	├── createLlmClient()            ← ALL policy: retries, deadline, cache,
	│                                  hooks, schema strategy, cleaners,
	│                                  finish-reason guard, error normalization
	└── adapter.complete()           ← thin fetch + wire mapping ONLY (~40 lines)
```

Never put policy into an adapter; never make the client aware of a provider's
wire format.

## Key Behaviors

1. **Config resolution**: call options > task config > client config >
   built-in defaults. `model` is required at some level (else `TypeError`).
2. **Return typing (D1)**: no schema → `string`; Standard Schema →
   `InferOutput<S>`; plain JSON Schema (via `schema` or `jsonSchema` alone) →
   `unknown` / explicit `task<T>()`; a union-typed `schema` value → `unknown`.
   Runtime and overloads always agree.
3. **Schema strategy**: native (`CompletionRequest.jsonSchema`) only when a
   wire JSON schema exists AND `capabilities.jsonSchema`; otherwise the
   JSON/schema instruction is appended to the system prompt. Standard Schema
   always validates client-side.
4. **JSON repair**: exactly ONE repair round-trip on parse/validation failure
   (validation errors + previous output appended to the system prompt); second
   failure throws `OutputValidationError { text, issues }`. Never a loop.
5. **Retries**: only `TransientError`/`RateLimitError`; default 3 total
   attempts, exponential backoff with equal jitter (500ms base, 10s cap),
   `Retry-After` honored (may exceed cap). Each logical call (primary, repair)
   gets its own retry budget.
6. **Deadline**: `timeoutMs` (default 30s) spans retries + repair; a retry
   sleep that would overshoot it throws the last error instead. Local deadline
   → `TimeoutError`; caller `AbortSignal` rejection passes through untouched.
7. **Finish-reason guard**: `"length"` throws `TruncatedOutputError` (opt-out
   `allowTruncated: true`); `"content_filter"` always throws
   `ContentFilterError`.
8. **Cache**: key = sha256 of stable-stringified `(adapter.id,
   adapter.fingerprint, model, system, input, maxTokens, temperature, wire
   jsonSchema)`. Only `finishReason: "stop"` completions cached, `raw` not
   cached (result `raw` is `undefined` on hits). Post-processing re-runs on
   hits; a stale hit failing validation triggers the repair round-trip, is
   re-cached, and reports `cached: false` (a real call happened). Cache backend
   / hashing errors are logged and swallowed (degrade to uncached).
9. **Env access**: lazy + guarded — explicit `apiKey` never touches env; in
   Deno the permission is queried (never prompted); Node/Bun read
   `process.env`; browser/Workers return `undefined`.
10. **Hooks/logger**: hooks (client- then task-level) are pure observers,
    throws swallowed + logged. `logger` defaults to quiet (warn/error only);
    `console` / `@marianmeres/clog` compatible.
11. **Input truncation**: opt-in `maxInputChars`; reported via
    `onInputTruncated` hook + `inputTruncated` result flag, never silent.

## Anthropic wire format (adapter)

- `POST {baseUrl}/v1/messages`, headers `x-api-key`, `anthropic-version:
  2023-06-01`, `content-type: application/json` (+ custom `headers`).
- Body: `{ model, max_tokens, messages: [{ role: "user", content: input }],
  system?, temperature?, output_config?: { format: { type: "json_schema",
  schema } } }`.
- `normalizeJsonSchema()` strips constraints Anthropic rejects (`minimum`,
  `minLength`, `pattern`, ...) and forces `additionalProperties: false` on all
  object schemas. It THROWS `InvalidRequestError` for record/map schemas
  (schema-valued `additionalProperties`) and for `patternProperties`-only
  object schemas — silent semantic rewrites are refused.
- Errors: body `{ type: "error", error: { type, message } }`; mapping in
  `toLlmError()` + shared `errorFromHttpStatus()`. Context-length 400 detected
  by message regex.
- Transport: `fetchOrThrow` from `@marianmeres/http-utils` (injectable via
  `options.fetch` — see tests).

## File Structure

```
src/
  mod.ts                # @module doc + re-exports
  client.ts             # createLlmClient — the policy layer (largest file)
  adapter.ts            # Adapter contract types
  adapters/anthropic.ts # Anthropic Messages API adapter
  adapters/mock.ts      # Mock adapter (tests/consumers)
  batch.ts              # bounded-concurrency batch()
  cache.ts              # LlmCache contract + createMemoryCache (LRU)
  cleaners.ts           # output cleaners
  errors.ts             # LLMError taxonomy + adapter helpers
  schema.ts             # Standard Schema types (vendored) + JSON helpers
  logger.ts             # Logger contract (clog/console compatible)
  utils.ts              # env/signals/backoff/hash internals
tests/
  *.test.ts             # offline: DI fetch stub + mock adapter
  live-smoke.test.ts    # opt-in live API test (auto-ignored without perms)
scripts/
  build-npm.ts          # packages .npm-dist/ via @marianmeres/npmbuild
  gen-example-theme.ts  # example/theme.css from @marianmeres/design-tokens
  gen-example-version.ts# example/src/version.generated.ts (gitignored)
example/                # the demo app, publish-excluded (see Example App)
  index.html            # AUTHORED shell: <template>s + token-driven CSS
  reboot.css            # vendored Bootstrap Reboot (consumes --bs-* vars)
  theme.css             # GENERATED design-tokens "zinc" theme + reboot bridge
  src/main.ts           # AUTHORED app logic (@marianmeres/vanilla)
  src/scenarios.ts      # AUTHORED mock scripts + demo schema (DOM-free)
  src/providers.ts      # AUTHORED live-provider registry + API key storage
  src/version.generated.ts # GENERATED package version, gitignored
  dist/bundle.js        # GENERATED by @marianmeres/deno-build, committed
index.html              # root redirect to ./example/, publish-excluded
```

## Tasks

```bash
deno task test          # offline tests (no permissions, no network)
deno task test:watch
deno task test:live     # live smoke test — needs ANTHROPIC_API_KEY (or .env)
deno task npm:build     # build npm package
deno task publish       # publish to JSR and npm
deno task release       # bump version
deno task example:build # type-check + minify example/dist/bundle.js
deno task example:dev   # same, in watch mode
deno task example:serve # static server on example/ ONLY (:8000) — never the
                        # repo root: that would expose .env over HTTP
deno task example:theme # regenerate example/theme.css (--list for names)
```

## Usage Patterns

### Reusable string task

```typescript
const client = createLlmClient({
	adapter: createAnthropicAdapter(),
	model: "claude-haiku-4-5",
});
const toTitle = client.task({
	system: "Summarize the user input into a single short sentence title.",
	maxTokens: 64,
	clean: [cleaners.stripFences, cleaners.unquote, cleaners.firstLine],
});
const title = await toTitle(userInput);
```

### Structured output (zod / Standard Schema)

```typescript
const Invoice = z.object({ number: z.string(), total: z.number() });
const parseInvoice = client.task({
	system: "Extract the invoice data.",
	schema: Invoice,
	jsonSchema: z.toJSONSchema(Invoice), // optional but recommended (native mode; zod v4)
});
const invoice = await parseInvoice(text); // typed
```

### Testing consumer code

```typescript
const adapter = createMockAdapter({ respond: [new TransientError("x"), "ok"] });
const client = createLlmClient({ adapter, model: "test" });
// assert on adapter.calls[i].{system,input,model,jsonSchema,...}
```

## Example App (`example/`)

An interactive showcase of the whole surface, running the **real client** against
`createMockAdapter` in the browser — no API key, no network. This is honest
rather than convenient: all policy lives in `client.ts`, so a mock-driven demo
exercises the same code paths a live call does. Three panels: **Task lab**
(config + scripted provider misbehavior -> hook timeline, `TaskResult` envelope,
normalized error, `adapter.calls`, generated snippet), **Batch** (`batch()` over
12 rows, concurrency slider, per-item isolation, abort) and **Cleaners** (the
pure helpers, live).

Follows the ecosystem example convention: `@marianmeres/vanilla` for the reactive
DOM, `@marianmeres/design-tokens` (+ Bootstrap Reboot bridge) for the theme,
`@marianmeres/deno-build` for the committed `example/dist/bundle.js`. Excluded
from the JSR publish set.

### Live providers (`example/src/providers.ts`)

The provider picker can swap the mock for a real adapter driven by a key typed
into the page — a developer tool, not a shipping pattern. `LIVE_PROVIDERS` is
the registry: one entry supplies the label, env var name, key placeholder/prefix,
default + suggested models, the snippet's factory name and extra option lines,
the UI warning, and `create(apiKey)`. Adding a provider is one entry; nothing in
`main.ts` is per-provider.

The Anthropic entry passes
`headers: { "anthropic-dangerous-direct-browser-access": "true" }` — without it
the browser's CORS preflight fails, and because the client cannot distinguish a
blocked request from a flaky network it surfaces as a **retried**
`TransientError`.

**Key-handling rules — do not regress these:**

- The key input is `type="password"`; the key is **never** interpolated into the
  generated snippet (the snippet shows the env-var fallback or the browser
  header, never the value).
- Persistence is opt-in and `sessionStorage` only, namespaced
  `llm-task-example-key:<providerId>`; every accessor is try/caught (private
  mode). **Forget key** clears field + storage.
- `CompletionRequest` carries no headers, so neither the timeline nor the wire
  panel can leak the key — keep it that way if either panel grows.
- `example:serve` must serve `example/`, never the repo root (`.env`).

### Invariants

- `example/src/scenarios.ts` is **DOM-free** — the scripted `MockResponse`s, the
  hand-rolled Standard Schema (`ticketSchema`, no zod dependency) and the batch
  fixture. `main.ts` holds everything that touches the DOM.
- Every scenario carries both a `text` and a `json` script; `structuredOnly`
  ones are `disabled` in the `<select>` while the task is a string task.
- Scenarios apply to the mock only — with a live provider the real API decides
  what happens, the mock-capability toggle is hidden (the real adapter reports
  its own), and the wire panel falls back to the requests seen by the
  `onRequest` hook (`adapter.calls` is the mock's recorder).
- Run is disabled while a live provider has no key; the batch panel's live
  switch only appears once one is entered, and is labelled with the call count.
- `example/theme.css` **must** keep the `stuic-` prefix and the reboot bridge —
  `example/reboot.css` consumes the `--bs-*` vars it emits. Only the palette is
  meant to vary (`deno task example:theme <name>`, `--list` to enumerate).
- `example/index.html` holds all markup in `<template>`s; `main.ts` never builds
  markup from strings (there is no `innerHTML` in it).
- The example imports the package via `../../src/mod.ts`, so it type-checks
  against the working tree — `deno task example:build` is a second, browser-side
  type check of the public API (`--strict`).
- `example/src/version.generated.ts` is gitignored and (re)written by the
  `example:build`/`example:dev` tasks; `theme.css` and `dist/bundle.js` are
  generated but committed.

## Testing Notes

- Offline tests inject `fetch` into `createAnthropicAdapter({ fetch })` — the
  DI stub pattern (`makeFetch` in `tests/anthropic.test.ts`); no globals
  patched.
- `tests/schema.test.ts` exports `fakeSchema()` — a minimal hand-rolled
  Standard Schema used by client tests.
- Retry/timeout tests use millisecond-scale delays (`baseDelayMs: 1`).
- `tests/live-smoke.test.ts` self-ignores unless env+net permissions are
  granted AND `ANTHROPIC_API_KEY` is set (permissions are queried via
  `Deno.permissions.querySync`, never prompted).

## Extending

- **New adapter**: implement `Adapter.complete()` (~40 lines) using
  `errorFromHttpStatus` + `parseRetryAfter`; keep it policy-free. The obvious
  next one is an OpenAI-compatible adapter with a configurable `baseURL`
  (covers OpenAI/Groq/OpenRouter/Ollama/...).
- **Streaming (future)**: add a separate optional `stream()` guarded by
  `capabilities.streaming`; do not bend `complete()` around it.
- **Fallback chains**: intentionally NOT a client feature — wrap the client in
  consumer code instead.
