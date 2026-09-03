<!--
GENERATED ANALYSIS — @marianmeres/llm-task · OpenAI-compatible + Azure OpenAI adapter
Produced 2026-09-03 by inline research → verify pass against the working tree → synthesize.
Claims verified against the codebase at commit 9ea4d90. Planning artifact; no code was changed.
-->

# Public surface, documentation and the example app

> None of this blocks the customer project — an adapter with green tests is usable from the
> working tree. It is what turns two new files into a released capability, and it is where
> a package with an already-good documentation set is easiest to let rot.
>
> One question here was decided rather than deferred: the example app calls providers
> straight from the browser, and Azure OpenAI resources reject cross-origin browser requests
> unless CORS is configured on the resource itself — something a registry entry cannot
> declare. The call was **not to add an Azure entry**, and to record why. That reasoning is
> now part of the AGENTS.md task rather than a task of its own.

## Summary of recommendations

| # | Recommendation                                  | Value | Effort | Risk |
| - | ----------------------------------------------- | ----- | ------ | ---- |
| 1 | README + API.md: the new adapters               | high  | S      | low  |
| 2 | AGENTS.md: wire format + extension notes        | med   | S      | low  |
| 3 | Example app live-provider entry for Azure       | low   | S      | med  |
| 4 | Live smoke test against a real Azure deployment | med   | S      | low  |

## Findings & recommendations (detailed)

### 1. README + API.md

- **Problem / observation** — both documents currently present Anthropic as the only real
  provider. `README.md` names `createAnthropicAdapter` throughout its examples and
  `API.md` documents `AnthropicAdapterOptions` as the only adapter option bag. A second and
  third factory that appear in the exports but nowhere in the prose read as unfinished.

- **Evidence** — `src/mod.ts:51-52` is the whole adapter surface today:

  ```typescript
  export * from "./adapters/anthropic.ts";
  export * from "./adapters/mock.ts";
  ```

  Both new adapters land here, which means both appear in the generated type surface and
  in JSR's documentation whether or not the prose mentions them.

- **Proposed change** — follow
  `mm-local-docs/HUMAN_DOCUMENTATION_GUIDE.md`. Concretely: a provider table in `README.md`
  listing the three real adapters with their capability rows and their credential
  environment variables; an Azure quick-start showing endpoint + deployment (the
  configuration the customer project actually uses); and `API.md` entries for
  `OpenAIAdapterOptions`, `AzureOpenAIAdapterOptions`, `createOpenAICompatibleAdapter` and
  `normalizeOpenAiJsonSchema`.

  Worth stating explicitly in the README, because it is the question every reader of an
  OpenAI-compatible adapter has: **which clones are covered.** OpenAI, Azure OpenAI, GitHub
  Models, Groq, OpenRouter, Together and Ollama all speak this format;
  `createOpenAICompatibleAdapter` is the supported way to reach any of them.

- **Done when** — `README.md` and `API.md` both document all three real adapters, every
  code sample in them type-checks against the working tree, and no sample references an
  option that does not exist.

- **Affected files** — `README.md`, `API.md`.

- **Effort / Value / Risk** — S / high / low.

- **Implementation notes** — the Azure sample should show the **customer-tenant** pattern
  from the design overview (`endpoint` + `deployment` + a credential the customer owns),
  not a key pasted inline. That is the shape this package will actually be used in.

### 2. AGENTS.md

- **Problem / observation** — `AGENTS.md` carries an "Anthropic wire format (adapter)"
  section documenting the request shape, the schema normalisation rules and the error
  mapping. Without the equivalent for the OpenAI-shaped adapters, a future agent session
  re-derives them from source.

- **Evidence** — the file's "Extending" section currently reads: _"The obvious next one is
  an OpenAI-compatible adapter with a configurable `baseURL` (covers
  OpenAI/Groq/OpenRouter/Ollama/…)."_ Once this plan lands that sentence is describing
  something that exists, and must become a description rather than a suggestion.

- **Proposed change** — per `mm-local-docs/AGENT_DOCUMENTATION_GUIDE.md`: an "OpenAI /
  Azure wire format" section mirroring the Anthropic one (endpoint, body, headers, error
  body shape, normaliser rules and what it refuses); update the File Structure tree with
  the two new adapter files and their tests; update the exports block; and rewrite the
  "Extending" bullet so it no longer proposes work that is done.

- **Done when** — `AGENTS.md` documents both new adapters at the same depth as the
  Anthropic section, its File Structure tree matches `find src tests -name '*.ts'`, and its
  "Extending" section no longer proposes the OpenAI adapter as future work.

- **Affected files** — `AGENTS.md`.

- **Effort / Value / Risk** — S / med / low.

### 3. Example app live-provider entry for Azure — deliberately not done

- **Decision (2026-09-03)** — no Azure entry is added to `LIVE_PROVIDERS`. The reasoning
  below is recorded in `AGENTS.md` as part of T07, beside the existing note about the
  Anthropic browser header.

- **Why** — the example app's provider picker is designed so adding a provider is one
  registry entry, and Azure satisfies the `LiveProvider` interface on paper: an `api-key` is
  a static pasteable string, so `envVar`, `keyPlaceholder`, `keyPrefix` and `create(apiKey)`
  all have sensible values.

  The obstacle is CORS, and it sits outside the code. The Anthropic entry only works because
  of a provider-specific opt-in header, and `example/src/providers.ts` records what happens
  without one: the browser blocks the request before it leaves the tab, and because the
  client cannot distinguish a blocked request from a flaky network it surfaces as a
  **retried `TransientError`**. Azure OpenAI rejects cross-origin browser calls unless CORS
  is configured on the resource — which is the resource owner's job. An entry in the picker
  would therefore fail for every reader who has not configured their own Azure resource, and
  fail in the most confusing way available: as a retry storm with no visible cause.

  The example's purpose is demonstrating the real client against `createMockAdapter`; the
  live picker is a developer convenience. A convenience that misleads is worth less than its
  absence.

- **Done when** — `AGENTS.md` states that there is no Azure live-provider entry and why, in
  the section that already documents the Anthropic browser-access header. No change to
  `example/`. Folded into T07; the original task id **T08 is retired and not reused**.

- **Affected files** — `AGENTS.md` only.

- **If this is revisited** — the test is a real Azure resource with CORS configured for the
  page's origin. If a browser call succeeds, the entry can be added with a `note` stating the
  CORS requirement plainly. The key-handling invariants in `AGENTS.md` are not negotiable and
  apply unchanged: password-type input, never interpolated into the generated snippet,
  `sessionStorage` only and opt-in, every accessor try/caught.

### 4. Live smoke test against a real Azure deployment

- **Problem / observation** — every adapter test is offline with an injected `fetch`, which
  proves the wire mapping matches our _belief_ about the API. `tests/live-smoke.test.ts`
  exists to check that belief against the real thing, and currently covers only Anthropic.

- **Evidence** — the existing live test self-ignores unless permissions and a key are both
  present, querying permissions via `Deno.permissions.querySync` rather than prompting, and
  `deno task test:live` scopes network access to `api.anthropic.com`.

- **Proposed change** — an Azure case in the same file, self-ignoring on the same pattern
  when `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` are absent. The `test:live` task's
  `--allow-net` list needs the endpoint host, which is per-resource — widen it to
  `--allow-net` with a comment, or add a second task, rather than hardcoding a customer
  hostname into `deno.json`.

- **Done when** — `deno task test` still reports the Azure live case as ignored with no
  credentials present and no permission prompt appears; with credentials, the case performs
  one real completion and asserts a non-empty `text` and a `usage` object.

- **Affected files** — `tests/live-smoke.test.ts`, `deno.json`, `.env.example`.

- **Effort / Value / Risk** — S / med / low.

- **Implementation notes** — a structured-output assertion is worth more here than a string
  completion, because the strict-mode normaliser (doc 01 #2) is the part most likely to be
  wrong against the real API and is the part offline tests can least validate.

## Decisions taken

All questions from this doc were resolved in the 2026-09-03 sweep; see the Decisions log in
[`PROGRESS.md`](./PROGRESS.md) for the full record and rationale.

- **No Azure entry in the example app** (#3 above). T08 retired, reasoning folded into T07.
- **`test:live` network scope** — do not hardcode a customer endpoint host into `deno.json`.
  Add a separate `test:live:azure` task whose `--allow-net` is supplied by the operator, or
  left open with a comment explaining why; the existing `test:live` task keeps its narrow
  `api.anthropic.com` scope untouched. Settle the exact form when T09 runs — it is a
  one-line task definition, not a design commitment.
