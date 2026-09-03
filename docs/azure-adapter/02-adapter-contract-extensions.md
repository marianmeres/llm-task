<!--
GENERATED ANALYSIS — @marianmeres/llm-task · OpenAI-compatible + Azure OpenAI adapter
Produced 2026-09-03 by inline research → verify pass against the working tree → synthesize.
Claims verified against the codebase at commit 9ea4d90. Planning artifact; no code was changed.
-->

# Adapter contract extensions

> Two changes to the `Adapter` contract itself, both surfaced by the Azure work but neither
> specific to Azure. The first is a small, well-understood addition: adapters currently
> assume a credential that is a static string, which is false for every OAuth-based
> provider. The second is a latent correctness bug that the first one makes reachable.
>
> They are separated from the adapter work on purpose. Neither is needed to ship a working
> Azure adapter against a static `api-key`, so neither should hold up the customer project.
> Both are worth doing before the package sees an OAuth provider in anger.

## Summary of recommendations

| # | Recommendation                                            | Value | Effort | Risk |
| - | --------------------------------------------------------- | ----- | ------ | ---- |
| 1 | `getToken()` adapter option for dynamic credentials       | med   | S      | low  |
| 2 | Cache scoping for adapters whose identity varies per call | med   | M      | med  |

## Findings & recommendations (detailed)

### 1. `getToken()` adapter option

- **Problem / observation** — every adapter option bag today models the credential as
  `apiKey?: string` with an environment-variable fallback. That is correct for a static
  API key and wrong for every token-based credential: Entra ID service principals, Azure
  managed identity, Google ADC, AWS SigV4-adjacent flows. Those tokens expire — typically
  in an hour — and the adapter is constructed once, so there is no point at which a static
  string can be refreshed.

- **Evidence** — [`anthropic.ts:96`](../../src/adapters/anthropic.ts):

  ```typescript
  const apiKey = options.apiKey ?? readEnv("ANTHROPIC_API_KEY");
  ```

  The read is correctly lazy — it happens inside `complete()`, once per call, not at
  construction. That is the property that makes this extension nearly free: the call site
  already re-resolves the credential on every request, so it only has to learn to `await`.

- **Proposed change** — add to each adapter's options:

  ```typescript
  /**
   * Dynamic credential source, called once per request. Takes precedence over
   * `apiKey` and the environment fallback. Use for short-lived tokens — an Entra
   * ID service principal, a managed identity, any OAuth flow — and do your own
   * caching inside it; this package does not cache the token.
   */
  getToken?: () => string | Promise<string>;
  ```

  Resolution order becomes `getToken()` → `apiKey` → `readEnv(...)`, with the existing
  `AuthError` when all three yield nothing. `complete()` is already `async`, so this adds
  one `await` and no structural change.

  Explicitly **not** in scope: token caching, refresh-ahead, or retry-on-401-then-refresh.
  Those are policy, and policy does not live in an adapter
  ([`src/adapter.ts:74`](../../src/adapter.ts) states the rule). A caller who needs
  caching writes it inside their own `getToken`.

- **Done when** — `deno task test` passes with tests asserting: `getToken` is awaited and
  its value reaches the auth header; `getToken` wins over an explicitly passed `apiKey`;
  `getToken` is called once per request rather than once per adapter (assert across two
  `complete()` calls with a counter); and a `getToken` that throws surfaces as an
  `AuthError` rather than an unwrapped rejection.

- **Affected files** — `src/adapters/openai.ts`, `src/adapters/azure-openai.ts`,
  `src/adapters/anthropic.ts` (for symmetry — an Anthropic key is static in practice, but
  a gateway in front of it may not be), `tests/openai.test.ts`,
  `tests/azure-openai.test.ts`, `tests/anthropic.test.ts`.

- **Effort / Value / Risk** — S / med / low. Purely additive; every existing call path is
  unchanged when the option is absent.

- **Implementation notes** — wrap the `getToken()` call in a `try` and re-throw as
  `AuthError` with the original as `cause`, so a failed token acquisition lands in the same
  taxonomy as a missing key rather than escaping as whatever the caller's SDK threw. Do not
  mark it retryable: a broken credential source is not a transient condition.

### 2. Cache scoping for adapters whose identity varies per call

- **Problem / observation** — the client's cache key mixes in `adapter.fingerprint`, which
  is a **static string fixed at adapter construction**. For an adapter whose credential —
  and therefore whose effective identity — varies per call, the key cannot distinguish two
  callers. Two users sharing one adapter instance and issuing the same task on the same
  input would share a cached completion. Where the provider's answer depends on who is
  asking, that is a data leak with the client's own cache as the vector.

- **Evidence** — the field is declared `readonly` at
  [`src/adapter.ts:88`](../../src/adapter.ts), computed once at construction in the one
  real implementation ([`anthropic.ts:93`](../../src/adapters/anthropic.ts)), and read into
  the key at [`src/client.ts:589`](../../src/client.ts):

  ```typescript
  cacheKey = await sha256Hex(stableStringify({
  	adapter: adapter.id,
  	fingerprint: adapter.fingerprint ?? null,
  	model,
  	system: system ?? null,
  	input: effInput,
  	maxTokens,
  	temperature: temperature ?? null,
  	jsonSchema: native ? wireSchema : null,
  }));
  ```

  There is no caller identity in that object and no way for a per-call value to reach it.

  **This is latent today, not live.** Every adapter currently shipped uses a static
  credential, and the customer project runs with the cache disabled. It becomes reachable
  the moment `getToken()` (#1) makes a per-user adapter instance look unnecessary — which
  is exactly the trap: the natural way to use `getToken` is one shared adapter with a
  per-request token, and that is the configuration in which the cache is wrong.

- **Proposed change** — a per-call opaque scope on `TaskRunOptions`, mixed into the key:

  ```typescript
  /**
   * Opaque cache partition for this call. Mixed into the cache key, so callers
   * sharing one client but not one identity never read each other's completions.
   * Required whenever the adapter's credential varies per call and the cache is on.
   */
  cacheScope?: string;
  ```

  `TaskRunOptions` is at [`src/client.ts:207`](../../src/client.ts) and already carries
  `cache?: boolean` at `:219`, so this sits beside an existing cache control. Add
  `cacheScope` to the hashed object above.

  This is preferred over the alternative of making `fingerprint` function-valued, for three
  reasons: it keeps `Adapter` unchanged; the value the cache must partition on is a
  property of the _caller_, not of the adapter, and the caller is the only party that knows
  it; and it composes with `batch()` without threading identity through the adapter.

  It does not, on its own, prevent the mistake — a caller who forgets it still shares. The
  mitigation is documentation plus the fact that the cache is opt-in per client
  ([`src/client.ts:415`](../../src/client.ts)); a hard guard would require the client to
  know which adapters have dynamic identity, which is knowledge the contract does not
  carry. **Decide whether that is acceptable before implementing** — see the open questions.

- **Done when** — `deno task test` passes with tests asserting: two calls differing only in
  `cacheScope` produce two adapter calls and two distinct cache entries; two calls with the
  same `cacheScope` produce one adapter call and a `cached: true` second result; and
  omitting `cacheScope` reproduces today's keying exactly (no change for existing callers).

- **Affected files** — `src/client.ts`, `tests/cache.test.ts` or `tests/client.test.ts`.

- **Effort / Value / Risk** — M / med / med. The risk is that this is a public API addition
  to the most heavily specified type in the package, and the wrong shape is expensive to
  walk back.

- **Implementation notes** — place `cacheScope` in the hashed object next to `adapter` and
  `fingerprint`, not appended at the end; `stableStringify`
  ([`src/utils.ts:143`](../../src/utils.ts)) sorts keys recursively, so position in the
  literal is cosmetic, but grouping the identity fields together reads better. Existing
  keys change only when the field is actually supplied, because `undefined` is dropped by
  `JSON.stringify` — verify that with a test rather than assuming it, since a `null`
  default would silently invalidate every existing cache entry.

## Decisions taken

All questions from this doc were resolved in the 2026-09-03 sweep; see the Decisions log in
[`PROGRESS.md`](./PROGRESS.md) for the full record and rationale.

- **Cache partitioning is `cacheScope?: string` on `TaskRunOptions`** — not a function-valued
  `Adapter.fingerprint`. The value to partition on is a property of the caller, not of the
  adapter, and the caller is the only party that knows it. `Adapter` stays unchanged, and the
  mechanism composes with `batch()` without threading identity through the adapter.
- **`cacheScope` is documented, not enforced.** No `dynamicIdentity` capability flag on
  `Adapter`, no client-side throw when the cache is on and a scope is missing. This is
  consistent with the package's existing stance that the cache is opt-in per client
  ([`src/client.ts:415`](../../src/client.ts)) — but it does mean the hazard survives a
  forgetful caller, so the AGENTS.md note in T07 is the mitigation and is not optional.
  Revisit only if a shipped adapter makes the mistake easy to reach.
- **`getToken()` lands on the Anthropic adapter too**, for symmetry. It is dead weight unless
  a token-authenticating gateway sits in front of `api.anthropic.com`, but one uniform
  credential model across adapters beats a per-adapter one. Cheap to drop from T04.
