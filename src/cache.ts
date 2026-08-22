/**
 * @module cache
 *
 * Pluggable completion cache. The client caches raw completions (not the
 * post-processed values), keyed on a hash of `(adapter, model, system, input,
 * params)` — so cleaners/schema config can change without stale results, and a
 * dev loop re-running the same input 50 times hits the network once.
 *
 * Only an in-memory implementation is bundled; implement {@link LlmCache} to
 * plug in Redis/KV/disk.
 */

import type { CompletionUsage, FinishReason } from "./adapter.ts";

/**
 * The cached portion of a completion. `raw` is intentionally not cached (it can
 * be arbitrarily large and non-serializable) — on a cache hit, `TaskResult.raw`
 * is `undefined`.
 */
export interface CachedCompletion {
	/** The completion text. */
	text: string;
	/** Normalized finish reason (only `"stop"` completions are ever cached). */
	finishReason: FinishReason;
	/** Normalized token usage, when reported. */
	usage?: CompletionUsage;
	/** The model that produced the completion, as reported by the provider. */
	model: string;
}

/**
 * Pluggable cache contract. Both methods may be sync or async. Keys are opaque
 * SHA-256 hex strings computed by the client.
 */
export interface LlmCache {
	/** Returns the cached completion for `key`, or `undefined` on miss. */
	get(
		key: string,
	): CachedCompletion | undefined | Promise<CachedCompletion | undefined>;
	/** Stores a completion under `key`. */
	set(key: string, value: CachedCompletion): void | Promise<void>;
}

/** Options for {@link createMemoryCache}. */
export interface MemoryCacheOptions {
	/**
	 * Maximum number of cached completions. When exceeded, the least recently
	 * used entry is evicted.
	 * @default 1000
	 */
	maxEntries?: number;
}

/** The in-memory cache returned by {@link createMemoryCache}. */
export interface MemoryCache extends LlmCache {
	/** Returns the cached completion for `key` (sync), or `undefined` on miss. */
	get(key: string): CachedCompletion | undefined;
	/** Stores a completion under `key` (sync). */
	set(key: string, value: CachedCompletion): void;
	/** Current number of cached entries. */
	readonly size: number;
	/** Removes all entries. */
	clear(): void;
}

/**
 * Creates a simple in-memory LRU cache. Suitable for dev loops and short-lived
 * processes; entries never expire (evicted only by `maxEntries`).
 *
 * @example
 * ```typescript
 * const client = createLlmClient({
 * 	adapter: createAnthropicAdapter(),
 * 	cache: createMemoryCache({ maxEntries: 200 }),
 * });
 * ```
 */
export function createMemoryCache(options: MemoryCacheOptions = {}): MemoryCache {
	const maxEntries = options.maxEntries ?? 1000;
	if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
		throw new RangeError(
			`createMemoryCache: maxEntries must be a finite number > 0, got ${maxEntries}`,
		);
	}
	const map = new Map<string, CachedCompletion>();
	return {
		get size(): number {
			return map.size;
		},
		get(key: string): CachedCompletion | undefined {
			const hit = map.get(key);
			if (hit !== undefined) {
				// refresh recency (Map preserves insertion order)
				map.delete(key);
				map.set(key, hit);
			}
			return hit;
		},
		set(key: string, value: CachedCompletion): void {
			if (map.has(key)) map.delete(key);
			map.set(key, value);
			while (map.size > maxEntries) {
				map.delete(map.keys().next().value!);
			}
		},
		clear(): void {
			map.clear();
		},
	};
}
