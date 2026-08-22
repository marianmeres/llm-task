/**
 * @module logger
 *
 * Minimal structural logger contract. Compatible with `console` and with
 * `@marianmeres/clog` — pass either (or any object with these four methods)
 * via the client `logger` option. No logging dependency is bundled.
 */

/**
 * Minimal logger interface. Compatible with `console` and with
 * `@marianmeres/clog`'s `Logger`. Pass any object with these four methods
 * (e.g. `console`, or a `createClog("...")` instance) via the client config.
 */
export interface Logger {
	/** Logs a debug message. */
	debug: (...args: unknown[]) => unknown;
	/** Logs an info message. */
	log: (...args: unknown[]) => unknown;
	/** Logs a warning message. */
	warn: (...args: unknown[]) => unknown;
	/** Logs an error message. */
	error: (...args: unknown[]) => unknown;
}

/**
 * Default fallback logger. Quiet by default: `debug` and `log` are no-ops,
 * `warn` / `error` go to `console`. Pass `logger: console` for full verbosity,
 * or `logger: createClog(...)` from `@marianmeres/clog` for richer formatting.
 */
export const quietLogger: Logger = {
	debug: () => {},
	log: () => {},
	warn: (...args) => console.warn(...args),
	error: (...args) => console.error(...args),
};

/** Prefixes every call with `[ns]`. */
export function withNamespace(logger: Logger, ns: string): Logger {
	const tag = `[${ns}]`;
	return {
		debug: (...args) => logger.debug(tag, ...args),
		log: (...args) => logger.log(tag, ...args),
		warn: (...args) => logger.warn(tag, ...args),
		error: (...args) => logger.error(tag, ...args),
	};
}
