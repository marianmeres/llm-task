# Azure adapter — @marianmeres/llm-task

Analysis and implementation plan for adding an OpenAI-compatible adapter core and an Azure
OpenAI adapter to the package. Produced 2026-09-03 against commit `9ea4d90`. This is a
**planning artifact — no code was changed**; every `file:line` claim was re-opened and
verified against the working tree, and the offline suite was confirmed green (113 passed)
before the verification commands in the tracker were chosen.

The driver for this work is a customer project — a legal-document classification pipeline
that must run in the customer's own Azure tenant, in the EU, on a stateless completion API.
Its design overview lives outside this directory; this plan covers only the package side.

**Start here:** [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
**Execution state:** [`PROGRESS.md`](./PROGRESS.md).

## Documents

| #  | Doc                                                                | Scope                                        | Headline finding                                                                                            |
| -- | ------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 00 | [overview-and-roadmap](./00-overview-and-roadmap.md)               | synthesis + roadmap                          | The critical path is three tasks; everything else waits without blocking anything                           |
| 01 | [openai-compatible-adapter](./01-openai-compatible-adapter.md)     | the adapter itself                           | One parameterised core plus two thin factories — the OpenAI/Azure delta is three config values              |
| 02 | [adapter-contract-extensions](./02-adapter-contract-extensions.md) | `Adapter` contract changes                   | `getToken()` is nearly free; it also makes a latent cache-scoping bug reachable                             |
| 03 | [surface-docs-and-example](./03-surface-docs-and-example.md)       | exports, docs, example app, live test        | No Azure entry in the example app — a browser call needs resource-side CORS a registry entry cannot declare |
| —  | [PROGRESS](./PROGRESS.md)                                          | living tracker (source of truth for "where") | 8 tasks in one sprint, all `⬜` — the decision sweep is closed                                              |

## How it was produced

Inline research against the working tree → a verify pass re-opening every cited file and
line → synthesis. Recommendations that duplicated existing functionality were dropped
rather than hedged; the one deliberate omission (`capabilities.jsonMode`) is recorded with
its reasoning in [01 #4](./01-openai-compatible-adapter.md) so it reads as considered
rather than missed.

> The decision sweep is **closed**. Every open question raised by the dimension docs was
> resolved on 2026-09-03 and recorded with its rationale in
> [`PROGRESS.md`](./PROGRESS.md)'s Decisions log, so no row is `⏸️` and the sprint runs end
> to end. The dimension docs keep their reasoning; where one reads as an open question, the
> Decisions log holds the answer.
