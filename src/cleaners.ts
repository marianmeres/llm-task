/**
 * @module cleaners
 *
 * Small composable output cleaners. Models wrap titles in quotes, prepend
 * labels and fence outputs constantly — these unglamorous helpers fix that.
 * Applied in order via the task `clean` option (string tasks only; structured
 * output uses a tolerant JSON parse instead).
 */

/** A single output cleaner: receives text, returns cleaned text. */
export type Cleaner = (text: string) => string;

/** Trims leading/trailing whitespace. */
export const trim: Cleaner = (text) => text.trim();

const QUOTE_PAIRS: [string, string][] = [
	['"', '"'],
	["'", "'"],
	["“", "”"], // “ ”
	["‘", "’"], // ‘ ’
	["«", "»"], // « »
	["`", "`"],
];

/**
 * Removes one pair of matching surrounding quotes (`"..."`, `'...'`, `“...”`,
 * `‘...’`, `«...»`, `` `...` ``), if present. Trims first.
 */
export const unquote: Cleaner = (text) => {
	const t = text.trim();
	for (const [open, close] of QUOTE_PAIRS) {
		if (
			t.length >= open.length + close.length && t.startsWith(open) &&
			t.endsWith(close)
		) {
			return t.slice(open.length, -close.length).trim();
		}
	}
	return t;
};

/**
 * Unwraps a single markdown code fence (```lang ... ```) surrounding the whole
 * text, if present. Trims first.
 */
export const stripFences: Cleaner = (text) => {
	const t = text.trim();
	const m = t.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/);
	return m ? m[1].trim() : t;
};

/** Returns the first non-empty line, trimmed. */
export const firstLine: Cleaner = (text) => {
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (t) return t;
	}
	return "";
};

/** Collapses all whitespace runs (incl. newlines) into single spaces and trims. */
export const collapseWhitespace: Cleaner = (text) => text.replace(/\s+/g, " ").trim();

/**
 * Creates a cleaner removing a leading prefix — a string (matched
 * case-insensitively) or a RegExp (matched as-is, anchor it yourself).
 *
 * @example
 * ```typescript
 * stripPrefix(new RegExp("^Title:\\s*", "i"));
 * stripPrefix("Title:");
 * ```
 */
export function stripPrefix(prefix: string | RegExp): Cleaner {
	return (text) => {
		const t = text.trim();
		if (typeof prefix === "string") {
			return t.toLowerCase().startsWith(prefix.toLowerCase())
				? t.slice(prefix.length).trim()
				: t;
		}
		return t.replace(prefix, "").trim();
	};
}

/** Applies cleaners left to right. */
export function applyCleaners(text: string, cleaners: readonly Cleaner[] = []): string {
	return cleaners.reduce((acc, c) => c(acc), text);
}

/**
 * All built-in cleaners grouped in one object, for consumers who prefer
 * `cleaners.trim` over importing the (generically named) functions directly.
 */
export const cleaners: {
	trim: Cleaner;
	unquote: Cleaner;
	stripFences: Cleaner;
	firstLine: Cleaner;
	collapseWhitespace: Cleaner;
	stripPrefix: typeof stripPrefix;
} = { trim, unquote, stripFences, firstLine, collapseWhitespace, stripPrefix };
