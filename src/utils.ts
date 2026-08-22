/**
 * @module utils
 *
 * Internal runtime-portable helpers (env access, signals, backoff, hashing).
 * Nothing here touches Node-only or Deno-only APIs unguarded — the package
 * must run in Deno, Node, Bun, Cloudflare Workers and the browser.
 */

/**
 * Lazy, safe environment variable read. Never throws and never triggers an
 * interactive Deno permission prompt: in Deno the permission state is queried
 * first and the variable is only read when access was explicitly granted
 * (`--allow-env` / `--allow-env=NAME`). Falls back to `process.env` (Node/Bun).
 * Returns `undefined` in environments without env access (browser, Workers).
 */
export function readEnv(name: string): string | undefined {
	// Deno (query first — reading without a granted permission would prompt)
	try {
		// deno-lint-ignore no-explicit-any
		const D = (globalThis as any).Deno;
		if (D?.env?.get) {
			const state = D.permissions?.querySync?.({ name: "env", variable: name })
				?.state;
			if (state === undefined || state === "granted") {
				const v = D.env.get(name);
				if (v !== undefined) return v;
			}
			return undefined;
		}
	} catch {
		/* ignore */
	}
	// Node / Bun
	try {
		// deno-lint-ignore no-explicit-any
		const v = (globalThis as any).process?.env?.[name];
		if (typeof v === "string") return v;
	} catch {
		/* ignore */
	}
	return undefined;
}

/**
 * Abortable sleep. Resolves after `ms`, or rejects with the signal's abort
 * reason as soon as the signal aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const id = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(id);
			reject(signal!.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Result of {@link composeSignals}: the combined signal plus a cleanup hook. */
export interface ComposedSignal {
	/** The combined signal (`undefined` when no signals were given). */
	signal: AbortSignal | undefined;
	/**
	 * Detaches whatever listeners the manual fallback attached to the source
	 * signals — call it once the guarded operation settles, so a long-lived
	 * source signal does not accumulate one listener per call. No-op on
	 * runtimes with `AbortSignal.any` (which registers weakly). Idempotent.
	 */
	dispose: () => void;
}

const NOOP = () => {};

/**
 * Combines multiple optional abort signals into one. Uses `AbortSignal.any`
 * when available, with a manual fallback for older runtimes (the fallback
 * requires calling `dispose()` after the guarded operation settles).
 */
export function composeSignals(
	...signals: (AbortSignal | undefined)[]
): ComposedSignal {
	const list = signals.filter((s): s is AbortSignal => !!s);
	if (!list.length) return { signal: undefined, dispose: NOOP };
	if (list.length === 1) return { signal: list[0], dispose: NOOP };
	if (typeof AbortSignal.any === "function") {
		return { signal: AbortSignal.any(list), dispose: NOOP };
	}
	// manual fallback — track handlers so they can be detached
	const ctrl = new AbortController();
	const handlers: [AbortSignal, () => void][] = [];
	const dispose = () => {
		for (const [s, h] of handlers) s.removeEventListener("abort", h);
		handlers.length = 0;
	};
	const abort = (reason: unknown) => {
		dispose();
		if (!ctrl.signal.aborted) ctrl.abort(reason);
	};
	for (const s of list) {
		if (s.aborted) {
			abort(s.reason);
			break;
		}
		const h = () => abort(s.reason);
		handlers.push([s, h]);
		s.addEventListener("abort", h, { once: true });
	}
	return { signal: ctrl.signal, dispose };
}

/**
 * Exponential backoff with equal jitter: caps `base * 2^(attempt-1)` at `max`,
 * then randomizes within `[cap/2, cap]` so concurrent clients do not stampede.
 *
 * @param attempt - 1-based number of the attempt that just failed.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
	const cap = Math.min(maxMs, baseMs * 2 ** (Math.max(1, attempt) - 1));
	return cap / 2 + Math.random() * (cap / 2);
}

/**
 * SHA-256 hex digest of a string. Uses WebCrypto; note `crypto.subtle` is
 * unavailable in browser insecure contexts — callers must treat a throw here
 * as recoverable (the client degrades to uncached operation).
 */
export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Deterministic JSON stringify (recursively sorted object keys), so logically
 * equal values always produce the same cache key.
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortDeep((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** Returns `true` when the error is an abort/timeout style rejection. */
export function isAbortLike(e: unknown): boolean {
	const name = (e as Error)?.name;
	return name === "AbortError" || name === "TimeoutError";
}
