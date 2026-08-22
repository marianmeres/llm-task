/**
 * @module batch
 *
 * Bounded-concurrency batch helper: run a task over many inputs with per-item
 * error isolation ("summarize these 400 rows"). Results keep input order.
 *
 * (Note: this is a concurrency-limited mapper, intentionally distinct from
 * `@marianmeres/batch`'s `BatchFlusher`, which solves accumulate-and-flush.)
 */

/** Progress info passed to `onProgress` after each item settles. */
export interface BatchProgress {
	/** Items settled so far (ok + failed). */
	done: number;
	/** Total number of items. */
	total: number;
	/** Items that succeeded so far. */
	ok: number;
	/** Items that failed so far. */
	failed: number;
	/** Index of the item that just settled. */
	index: number;
}

/** Options for {@link batch}. */
export interface BatchOptions {
	/**
	 * Maximum number of task calls in flight at once.
	 * @default 5
	 */
	concurrency?: number;
	/**
	 * Abort signal: stops scheduling new items and is passed through to each
	 * task call, so in-flight requests are cancelled too. Unstarted items settle
	 * as `{ ok: false, error: <abort reason> }` — the signal is never swallowed.
	 */
	signal?: AbortSignal;
	/** Called after each item settles (a throwing callback is ignored). */
	onProgress?: (progress: BatchProgress) => void;
}

/** Per-item result: success with value, or isolated failure with the error. */
export type BatchItemResult<T, I = string> =
	| {
		/** Discriminator: the item succeeded. */
		ok: true;
		/** The task value. */
		value: T;
		/** The original input. */
		input: I;
		/** The item's index in `inputs`. */
		index: number;
	}
	| {
		/** Discriminator: the item failed. */
		ok: false;
		/** The error the task rejected with (normalized `LLMError` for LLM failures). */
		error: unknown;
		/** The original input. */
		input: I;
		/** The item's index in `inputs`. */
		index: number;
	};

/**
 * Runs `taskFn` over all `inputs` with bounded concurrency. Errors are isolated
 * per item — one failing input never aborts the rest. The returned array is in
 * input order.
 *
 * @example
 * ```typescript
 * import { batch } from "@marianmeres/llm-task";
 *
 * const results = await batch(toTitle, rows, {
 * 	concurrency: 5,
 * 	onProgress: ({ done, total }) => console.log(`${done}/${total}`),
 * });
 * for (const r of results) {
 * 	if (r.ok) save(r.input, r.value);
 * 	else console.error(`row ${r.index} failed:`, r.error);
 * }
 * ```
 */
export async function batch<T, I = string>(
	taskFn: (input: I, options?: { signal?: AbortSignal }) => Promise<T>,
	inputs: readonly I[],
	options: BatchOptions = {},
): Promise<BatchItemResult<T, I>[]> {
	const concurrency = options.concurrency ?? 5;
	if (!Number.isFinite(concurrency) || concurrency < 1) {
		throw new TypeError(
			`batch: concurrency must be a finite number >= 1, got ${concurrency}`,
		);
	}
	const { signal, onProgress } = options;
	const results: BatchItemResult<T, I>[] = new Array(inputs.length);
	let next = 0;
	let done = 0;
	let ok = 0;
	let failed = 0;

	async function worker(): Promise<void> {
		while (next < inputs.length) {
			const index = next++;
			const input = inputs[index];
			if (signal?.aborted) {
				results[index] = { ok: false, error: signal.reason, input, index };
				failed++;
			} else {
				try {
					const value = await taskFn(input, { signal });
					results[index] = { ok: true, value, input, index };
					ok++;
				} catch (error) {
					results[index] = { ok: false, error, input, index };
					failed++;
				}
			}
			done++;
			try {
				onProgress?.({ done, total: inputs.length, ok, failed, index });
			} catch {
				/* progress observer must not affect the batch */
			}
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, inputs.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}
