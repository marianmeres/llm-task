# Implementation Progress — OpenAI-compatible + Azure OpenAI adapter

<!-- tracker: v1 -->

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the relevant `NN-*.md` section.

**Status legend:** ⬜ ready · 🚧 in progress · ⏸️ blocked/awaiting decision · 🔒 human-only ·
✅ done · ⏭️ deferred

> Convention: one branch per sprint, one commit per task. The decision sweep is **complete**
> — every open question from the dimension docs was resolved on 2026-09-03 and recorded in
> the Decisions log below, so no row is `⏸️` and the sprint is runnable end to end.

## Sprint — OpenAI-compatible core, Azure adapter, contract extensions and docs

```sprint
Branch: `sprint/azure-adapter`
Verify: deno task test
Verify: deno check src/mod.ts
Verify: deno fmt --check src/ tests/
```

| Status | ID  | Deps        | Task                                                                   | Source                                       | Commit |
| ------ | --- | ----------- | ---------------------------------------------------------------------- | -------------------------------------------- | ------ |
| ✅     | T01 | —           | OpenAI-compatible core + `createOpenAIAdapter`, no native schema yet   | [01](./01-openai-compatible-adapter.md) #1   | —      |
| ✅     | T02 | T01         | OpenAI strict-mode schema normaliser; enable `capabilities.jsonSchema` | [01](./01-openai-compatible-adapter.md) #2   | —      |
| ✅     | T03 | T02         | `createAzureOpenAIAdapter` over the core                               | [01](./01-openai-compatible-adapter.md) #3   | —      |
| ✅     | T04 | T03         | `getToken()` dynamic-credential option across the adapters             | [02](./02-adapter-contract-extensions.md) #1 | —      |
| ⬜     | T05 | T04         | `cacheScope` on `TaskRunOptions` for dynamic-identity adapters         | [02](./02-adapter-contract-extensions.md) #2 | —      |
| ⬜     | T09 | T03         | Live smoke test against a real Azure deployment                        | [03](./03-surface-docs-and-example.md) #4    | —      |
| ⬜     | T06 | T03 T04 T05 | README + API.md: document all three real adapters                      | [03](./03-surface-docs-and-example.md) #1    | —      |
| ⬜     | T07 | T03 T04 T05 | AGENTS.md: wire format, contract extensions, no-Azure-in-example note  | [03](./03-surface-docs-and-example.md) #2    | —      |

Each row includes its own tests and its `src/mod.ts` export line — one reviewable commit per
row, green at every step. Row order is execution order: all code lands before the two
documentation rows, so they document a finished surface rather than a moving one.

`T08` is **retired**. It was "add an Azure entry to the example app's live-provider picker";
the call on 2026-09-03 was not to add one, and recording why now belongs to `T07`. The id is
not reused.

## Decisions log

- **2026-09-03** — Adapter split as one parameterised core plus thin per-provider factories,
  rather than two independent adapters — the OpenAI/Azure delta is three config values (URL
  shape, auth header, whether `model` is sent), so a second full adapter would be ~80%
  duplication.
- **2026-09-03** — `createOpenAIAdapter` ships in T01 with `capabilities.jsonSchema: false`
  and T02 turns it on — keeps both commits coherent and independently green, and gives the
  normaliser its own review boundary.
- **2026-09-03** — Azure defaults to the `/openai/v1/` surface, with an optional `apiVersion`
  switching to the classic deployment route — avoids having to pick one route up front, at a
  cost of about six lines.
- **2026-09-03** — `capabilities.jsonMode` stays `false` on both new adapters and the client
  is left alone — the client reads only `jsonSchema`
  ([`src/client.ts:437`](../../src/client.ts)), so the flag is currently decorative and
  `json_object` mode adds nothing over the existing prompt instruction.
- **2026-09-03** — `maxTokensField` defaults to `max_completion_tokens`, overridable — newer
  models reject the legacy `max_tokens`, older clone endpoints require it.
- **2026-09-03** — Verify commands scope `deno fmt --check` to `src/ tests/`: a full-repo
  `deno fmt --check` fails on a pre-existing `example/index.html` formatting difference, so
  an unscoped check would make the baseline red before any task ran.
- **2026-09-03** — **`createOpenAICompatibleAdapter` is exported publicly** — it is the
  supported way to reach Groq, Together, OpenRouter, Fireworks or a self-hosted Ollama
  without a PR. Additive at 0.2.0; commits the package to the config object's shape.
- **2026-09-03** — **Cache partitioning is `cacheScope?: string` on `TaskRunOptions`**, not a
  function-valued `Adapter.fingerprint` — the value to partition on is a property of the
  caller, not of the adapter, and the caller is the only party that knows it. Keeps `Adapter`
  unchanged and composes with `batch()`.
- **2026-09-03** — **`cacheScope` is documented, not enforced** — no `dynamicIdentity`
  capability flag, no client-side throw on a missing scope. Consistent with the package's
  existing stance that the cache is opt-in per client; the hazard is documented in AGENTS.md
  instead. Revisit only if a shipped adapter makes the mistake easy to reach.
- **2026-09-03** — **No Azure entry in the example app's live-provider picker** — a browser
  call to an Azure OpenAI resource needs resource-side CORS, which a registry entry cannot
  declare, and a picker entry that fails for everyone who has not configured their resource
  is worse than its absence. T07 records the reasoning in AGENTS.md beside the existing note
  about the Anthropic browser header. T08 retired.
- **2026-09-03** — **`getToken()` lands on the Anthropic adapter too**, for symmetry — dead
  weight unless a token-authenticating gateway sits in front of it, but a per-adapter
  credential model is worse than one uniform one. Cheap to drop from T04 if you disagree.
- **2026-09-03** — Single sprint rather than two sprints plus a backlog — at eight tasks the
  section split bought nothing, and a run ends at the next sprint heading, so splitting would
  have meant three invocations for one body of work.

## How to resume (for a fresh conversation)

1. Read this file + [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
2. Pick the first ⬜ task whose `Deps` are all ✅ (or the `T##` you were given); open its
   source doc section for the detail and its **Done when** criterion.
3. The Decisions log above is the answer to that task's "Open questions" — the dimension docs
   still list them as questions, but every one has a recorded call. Do not re-litigate them
   without saying so.
4. Branch → implement → run the `Verify:` commands → update this file → commit when the owner
   asks.
