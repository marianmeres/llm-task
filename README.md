# @marianmeres/llm-task

[![NPM version](https://img.shields.io/npm/v/@marianmeres/llm-task.svg)](https://www.npmjs.com/package/@marianmeres/llm-task)
[![JSR version](https://jsr.io/badges/@marianmeres/llm-task)](https://jsr.io/@marianmeres/llm-task)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

One-shot, stateless LLM calls used inside application code — "summarize this
into a title", "classify this message", "extract the invoice number". These are
_transformations, not conversations_: you define a reusable **task** (a prompt
that behaves like a typed function) once, then call it N times with only the
varying input.

Not a chat SDK, not an agent framework. No conversation history, no tool
calling, no embeddings, no streaming (v1) — by design.

## Features

- **Task abstraction** — prompt, model, params and output cleanup defined once,
  called like a plain function
- **Provider adapters** — one unified API; `anthropic` (raw `fetch`, no
  provider SDK) and `mock` ship in v1, the adapter interface is ~one method
- **Safe to fail** — normalized error taxonomy (`instanceof`, never
  provider-specific status codes), retries with jitter honoring `Retry-After`,
  per-call deadlines that the retry budget never overshoots
- **Structured output** — pass a [Standard Schema](https://standardschema.dev)
  (zod / valibot / arktype) or a plain JSON Schema; typed return value,
  client-side validation, exactly one automatic repair round-trip
- **Prompt/input separation** — instructions go to `system`, untrusted input
  travels as a separate user message; they are never concatenated
- **No silent truncation** — `finishReason: "length"` throws by default
- **Output cleaners** — `unquote`, `stripFences`, `firstLine`, ... because
  models wrap titles in quotes constantly
- **Mock adapter + cache + batch helper** — unit-test consumer code with no
  network and no keys, cache repeated dev-loop calls, map over 400 rows with
  bounded concurrency

## Installation

```sh
deno add jsr:@marianmeres/llm-task
```

```sh
npm i @marianmeres/llm-task
```

## Quick Start

```typescript
import { cleaners, createAnthropicAdapter, createLlmClient } from "@marianmeres/llm-task";

const client = createLlmClient({
	adapter: createAnthropicAdapter(), // or { apiKey: "sk-ant-..." }
	model: "claude-haiku-4-5",
});

const toTitle = client.task({
	system: "Summarize the user input into a single short sentence title.",
	maxTokens: 64,
	clean: [cleaners.stripFences, cleaners.unquote, cleaners.firstLine],
});

const title = await toTitle(userInput); // -> string
const title2 = await toTitle(userInput, { signal, model: "claude-sonnet-5" });
```

Need the full envelope (usage, finish reason, cache flags, raw response)?

```typescript
const r = await toTitle.run(userInput);
// r.value, r.text, r.usage, r.finishReason, r.model, r.raw,
// r.cached, r.inputTruncated, r.attempts, r.repaired
```

One-shot escape hatch without defining a task:

```typescript
const r = await client.run({ system: "Classify as bug|question|feature.", input });
```

## Structured output

Opt-in via `schema` — it changes the task's return type. Any
[Standard Schema](https://standardschema.dev) library works (zod v3.24+,
valibot v1+, arktype v2+), or a plain JSON Schema object:

```typescript
import { z } from "zod";

const Invoice = z.object({ number: z.string(), total: z.number() });

const parseInvoice = client.task({
	system: "Extract the invoice data from the user input.",
	schema: Invoice, // validated client-side
	jsonSchema: z.toJSONSchema(Invoice), // optional: enables native structured output
});

const invoice = await parseInvoice(text); // -> { number: string; total: number }
```

> `z.toJSONSchema` requires **zod v4** (on zod 3.25+ use `import { z } from "zod/v4"`;
> on zod v3 use the `zod-to-json-schema` package). The `schema` field itself works with
> any Standard Schema implementation, including zod v3.24+.

How the strategy is chosen:

| You pass                                  | Provider supports native JSON schema | What happens                                                                   |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| `schema` (Standard Schema) + `jsonSchema` | yes                                  | schema enforced natively by the provider **and** validated client-side         |
| `schema` (plain JSON Schema)              | yes                                  | schema enforced natively, result is `JSON.parse`d (`unknown`, or `task<T>()`)  |
| `jsonSchema` alone (no `schema`)          | yes                                  | same as above — structured task, no client-side validation                     |
| `schema` (Standard Schema) only           | —                                    | "respond with JSON only" instruction, parsed + validated client-side           |
| any schema                                | no                                   | schema/JSON instruction injected into the system prompt, validated client-side |

On a failed parse/validation the client resends **once** with the validation
errors appended; a second failure throws `OutputValidationError` (with `text` +
`issues`). Never a loop.

> The Anthropic adapter automatically normalizes the wire schema to Anthropic's
> structured output restrictions (`additionalProperties: false` everywhere,
> unsupported constraints like `minLength`/`minimum` stripped). With a Standard
> Schema validator configured, the stripped constraints are still enforced
> client-side. Record/map schemas (schema-valued `additionalProperties`, e.g.
> `z.record(...)`) cannot be expressed under these restrictions and are rejected
> with `InvalidRequestError` instead of being silently rewritten.

## Error handling

Every failure is a normalized `LLMError` subclass — branch on `instanceof`,
never on provider-specific shapes. `cause` and `raw` always carry the original
error/payload.

| Class                   | Meaning                                                           | Retried automatically |
| ----------------------- | ----------------------------------------------------------------- | --------------------- |
| `AuthError`             | bad/missing key (401/403)                                         | no                    |
| `RateLimitError`        | 429 — carries `retryAfter?: number` (seconds)                     | yes                   |
| `ContextLengthError`    | input too long for the model                                      | no                    |
| `ContentFilterError`    | refused / filtered by the provider                                | no                    |
| `InvalidRequestError`   | 400-class, malformed request                                      | no                    |
| `TransientError`        | 5xx, overloaded, network failure                                  | yes                   |
| `TruncatedOutputError`  | output hit `maxTokens` — carries partial `text`                   | no                    |
| `OutputValidationError` | schema validation failed after repair — carries `text` + `issues` | no                    |
| `TimeoutError`          | local `timeoutMs` deadline exceeded                               | no (caller's choice)  |

```typescript
import { ContextLengthError, LLMError, RateLimitError } from "@marianmeres/llm-task";

try {
	await toTitle(input);
} catch (e) {
	if (e instanceof RateLimitError) queue.delay(e.retryAfter ?? 60);
	else if (e instanceof ContextLengthError) await summarizeInChunks(input);
	else if (e instanceof LLMError) log.error(e.adapter, e.status, e.message, e.raw);
	else throw e; // TypeError (programmer error) or caller abort
}
```

Reliability defaults:

- **Retries** (client or task level): 3 attempts total, exponential backoff with
  jitter, only on `TransientError` / `RateLimitError`, `Retry-After` honored,
  `retry: false` disables.
- **Timeout** (client, task or call level): `timeoutMs: 30_000` covers the whole
  call including retries and the repair round-trip; a caller `AbortSignal` is
  composed in and propagates untouched.
- **Truncation** (task level): `finishReason: "length"` throws
  `TruncatedOutputError` unless `allowTruncated: true`.

## Testing with the mock adapter

Unit-test code that calls this package with no network and no API keys:

```typescript
import {
	createLlmClient,
	createMockAdapter,
	TransientError,
} from "@marianmeres/llm-task";

const adapter = createMockAdapter({
	// single value, function, or a sequence (last entry repeats):
	respond: [new TransientError("flaky"), '{"ok":true}'],
});
const client = createLlmClient({ adapter, model: "test-model" });

// ... exercise your code, then assert on what was sent:
adapter.calls[0].system; // the instruction
adapter.calls[0].input; // the user input
```

`respond` accepts a `string`, a `Partial<CompletionResult>` (e.g.
`{ text: "x", finishReason: "length" }`), an `Error` to throw, a function
`(req, callIndex) => ...`, or an array of any of these.

## Batch helper

"Summarize these 400 rows" — bounded concurrency, per-item error isolation,
abort passthrough, input order preserved:

```typescript
import { batch } from "@marianmeres/llm-task";

const results = await batch(toTitle, rows, {
	concurrency: 5,
	onProgress: ({ done, total }) => console.log(`${done}/${total}`),
});
for (const r of results) {
	if (r.ok) save(r.input, r.value);
	else console.error(`row ${r.index}:`, r.error);
}
```

## Caching

Pluggable completion cache — a dev-loop feature (re-running the same input 50
times while iterating hits the network once). In-memory LRU ships bundled;
implement `LlmCache` (`get`/`set`, sync or async) for anything else:

```typescript
import { createMemoryCache } from "@marianmeres/llm-task";

const client = createLlmClient({
	adapter,
	model: "claude-haiku-4-5",
	cache: createMemoryCache({ maxEntries: 500 }),
});

// opt out: client.task({ cache: false }) or toTitle(input, { cache: false })
```

Keys are hashes of `(adapter id + adapter configuration fingerprint, model,
system, input, params)` — differently configured adapters (e.g. two base URLs)
sharing one cache never collide, which matters for shared Redis/KV caches
(custom adapters should set `Adapter.fingerprint` to get the same guarantee).
Only clean
(`finishReason: "stop"`) completions are cached, and post-processing (cleaners,
parsing, validation) re-runs on hits — so task config can change without stale
values.

## Hooks & logging

Wire your own logging/tracing/metrics via lifecycle hooks (client- and/or
task-level; both fire):

```typescript
const client = createLlmClient({
	adapter,
	model: "claude-haiku-4-5",
	hooks: {
		onRequest: ({ model, attempt }) => trace.start(model, attempt),
		onResponse: ({ result, durationMs, cached }) =>
			metrics.observe(durationMs, result.usage, { cached }),
		onRetry: ({ attempt, delayMs, error }) => log.warn({ attempt, delayMs, error }),
		onInputTruncated: ({ originalChars }) => log.warn({ originalChars }),
	},
	// optional internal diagnostics; compatible with `console` and @marianmeres/clog:
	logger: console,
});
```

## API key resolution & Deno permissions

1. An explicit `apiKey` in `createAnthropicAdapter({ apiKey })` **always wins**
   and never touches the environment (no `--allow-env` prompt, no Workers
   crash).
2. Otherwise the `ANTHROPIC_API_KEY` environment variable is read **lazily**
   (first call, not import time). In Deno it is only read when permission was
   explicitly granted — the package never triggers an interactive prompt.

Required Deno permissions: `--allow-net=api.anthropic.com`, plus
`--allow-env=ANTHROPIC_API_KEY` only when relying on the env fallback.

## Writing a custom adapter

An adapter is one method — thin `fetch` + wire-format mapping (~40 lines); all
policy lives in the client. Map provider errors with the shared
`errorFromHttpStatus(status, message, opts)` helper and you get the whole
reliability layer (retries, deadlines, cache, schema strategy) for free:

```typescript
import {
	type Adapter,
	type CompletionRequest,
	type CompletionResult,
	errorFromHttpStatus,
	parseRetryAfter,
} from "@marianmeres/llm-task";

export function createMyAdapter(options: { apiKey: string }): Adapter {
	return {
		id: "my-provider",
		capabilities: { jsonSchema: false, jsonMode: false, streaming: false },
		async complete(req: CompletionRequest): Promise<CompletionResult> {
			const response = await fetch("https://api.example.com/complete", {
				method: "POST",
				headers: { authorization: `Bearer ${options.apiKey}` },
				body: JSON.stringify({
					model: req.model,
					system: req.system,
					prompt: req.input,
					max_tokens: req.maxTokens,
					temperature: req.temperature,
				}),
				signal: req.signal,
			});
			const raw = await response.json();
			if (!response.ok) {
				throw errorFromHttpStatus(response.status, raw?.message ?? "error", {
					adapter: "my-provider",
					raw,
					cause: raw,
					retryAfter: parseRetryAfter(response.headers.get("retry-after")),
				});
			}
			return {
				text: raw.text,
				finishReason: raw.truncated ? "length" : "stop",
				usage: { inputTokens: raw.usage.in, outputTokens: raw.usage.out },
				model: raw.model,
				raw,
			};
		},
	};
}
```

## Example

An interactive showcase lives in [`example/`](./example/) — the **real client**,
driven by the package's own `createMockAdapter` by default, so it runs in the
browser with no API key and no network. All policy (retries, deadlines, cache,
schema strategy, error taxonomy) lives in the client rather than the adapter, so
what the demo does is what a live provider call does.

You can also **switch the provider to the live Anthropic API** and paste a key
to watch the same machinery run for real — see [Live provider](#live-provider)
below.

Three panels:

- **Task lab** — build a task (system prompt, `maxTokens`, cleaners, retry
  budget, `timeoutMs`, cache, `maxInputChars`), script how the provider
  misbehaves (transient failures, `Retry-After`, truncation, refusal, bad key,
  latency, unparseable JSON), then watch the lifecycle hooks fire in a timeline
  — attempts, backoff, cache hits, the single JSON repair round-trip — next to
  the `TaskResult` envelope, the normalized error, `adapter.calls` (proof that
  `system` and `input` are never concatenated) and a copyable snippet of the
  equivalent code.
- **Batch** — `batch()` over 12 rows with a live concurrency slider, per-item
  error isolation and abort.
- **Cleaners** — the pure string helpers, applied live to messy model output.

```sh
deno task example:dev     # bundle + watch  (example/dist/bundle.js)
deno task example:build   # one-off type-checked, minified bundle
deno task example:serve   # http://localhost:8000
deno task example:theme   # regenerate example/theme.css (add --list for themes)
```

### Live provider

The **provider** card switches the adapter from `mock` to `anthropic`. Paste a
key and every run becomes a real, billed Messages API call — same task config,
same timeline, same envelope, real tokens and latency. Useful for confirming a
key works, comparing models, or watching native structured output actually
constrain a response.

The adapter is constructed with the header Anthropic requires for direct
browser access:

```typescript
createAnthropicAdapter({
	apiKey,
	// browsers only — the CORS preflight fails without it
	headers: { "anthropic-dangerous-direct-browser-access": "true" },
});
```

> **An API key in a web page is a development pattern, not a shipping one.**
> This is a localhost tool, which is the "internal tools / development or
> debugging" case Anthropic documents for direct browser access. In production,
> keep the key server-side and call the task from there.
>
> The example holds up its end: the field is a password input, the key is never
> written into the generated snippet, it is only persisted if you tick the box
> (and then to `sessionStorage`, which dies with the tab), and **Forget key**
> clears it. `deno task example:serve` serves `example/` only — not the repo
> root — so a local `.env` is never exposed over HTTP.

Adding another provider later is one entry in
[`example/src/providers.ts`](./example/src/providers.ts); the picker, the key
handling and the generated snippet are all driven off that list.

## Testing this package

```sh
deno task test        # offline: fetch stub + mock adapter, no permissions
deno task test:live   # opt-in live smoke test (needs ANTHROPIC_API_KEY / .env)
```

## API Reference

See [API.md](./API.md) for full API documentation.

## License

[MIT](LICENSE)
