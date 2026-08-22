/**
 * Live provider registry for the example app.
 *
 * The demo defaults to `createMockAdapter` (scripted, offline). This module is
 * the other half: real adapters that talk to a real API with a real key typed
 * into the page. Adding a provider later is one entry here — the UI, the
 * generated snippet and the key handling are all driven off this list.
 *
 * Browser caveat, and it is a real one: an API key in a web page is visible to
 * anyone who can see that page. This is a localhost developer tool, which is
 * exactly the "internal tools / development or debugging" carve-out Anthropic
 * documents for direct browser access — it is not a pattern to ship. The key
 * is never persisted unless you ask for it (and then only to `sessionStorage`),
 * never written into the generated snippet, and never leaves the page except
 * in the `x-api-key` header of the request it authenticates.
 */

import { type Adapter, createAnthropicAdapter } from "../../src/mod.ts";

/** One real provider the example can talk to. */
export interface LiveProvider {
	/** Stable id (the `<select>` value, and the sessionStorage key suffix). */
	id: string;
	/** Option label. */
	label: string;
	/** Env var the package falls back to outside the browser. */
	envVar: string;
	/** Where to mint a key. */
	consoleUrl: string;
	/** Input placeholder. */
	keyPlaceholder: string;
	/** Cheap client-side shape check — a typo hint, never a validation. */
	keyPrefix: string;
	/** Model prefilled when this provider is picked. */
	defaultModel: string;
	/** `<datalist>` suggestions; the field stays free text. */
	models: string[];
	/** Factory name used in the generated snippet. */
	factory: string;
	/**
	 * Extra `createXAdapter()` options the snippet must show, as source lines —
	 * anything the browser needs that server code would not.
	 */
	snippetOptions: string[];
	/** Whatever the UI should warn about before the first live call. */
	note: string;
	/** Builds the adapter for a typed key. */
	create(apiKey: string): Adapter;
}

/**
 * The Anthropic Messages API, called straight from the page.
 *
 * `anthropic-dangerous-direct-browser-access: true` is what makes the browser
 * request pass CORS; without it the fetch is blocked before it leaves the tab
 * (and surfaces as a retried `TransientError`, since the client cannot tell a
 * blocked request from a flaky network). The name is a warning, not a
 * formality — see the module doc.
 */
const anthropic: LiveProvider = {
	id: "anthropic",
	label: "anthropic — live Messages API",
	envVar: "ANTHROPIC_API_KEY",
	consoleUrl: "https://console.anthropic.com/settings/keys",
	keyPlaceholder: "sk-ant-…",
	keyPrefix: "sk-ant-",
	defaultModel: "claude-haiku-4-5",
	models: [
		"claude-haiku-4-5",
		"claude-sonnet-5",
		"claude-opus-5",
		"claude-opus-4-8",
		"claude-fable-5",
	],
	factory: "createAnthropicAdapter",
	snippetOptions: [
		"\t// browsers only — CORS preflight fails without it:",
		'\theaders: { "anthropic-dangerous-direct-browser-access": "true" },',
	],
	note: "Real calls, real tokens, real money. The key stays in this tab and " +
		"travels only to api.anthropic.com — but a key in a web page is a " +
		"development pattern, never a shipping one. A blocked/CORS request " +
		"arrives as a retried `TransientError`; the browser console has the " +
		"underlying reason.",
	create: (apiKey: string): Adapter =>
		createAnthropicAdapter({
			apiKey,
			headers: { "anthropic-dangerous-direct-browser-access": "true" },
		}),
};

/** Every live provider the example knows about. Add new ones here. */
export const LIVE_PROVIDERS: LiveProvider[] = [anthropic];

export const PROVIDER_BY_ID: Map<string, LiveProvider> = new Map(
	LIVE_PROVIDERS.map((p) => [p.id, p]),
);

/** The scripted, offline default — not a `LiveProvider`, it needs no key. */
export const MOCK_PROVIDER_ID = "mock";

/* ---- Key storage ----------------------------------------------------------
 * Opt-in, and `sessionStorage` rather than `localStorage` on purpose: the key
 * survives a reload but dies with the tab. Every accessor is guarded — a
 * private window or blocked site data must not break the page. */

const storageKey = (providerId: string) => `llm-task-example-key:${providerId}`;

export function loadStoredKey(providerId: string): string {
	try {
		return sessionStorage.getItem(storageKey(providerId)) ?? "";
	} catch {
		return "";
	}
}

export function storeKey(providerId: string, apiKey: string): void {
	try {
		sessionStorage.setItem(storageKey(providerId), apiKey);
	} catch { /* private mode / site data blocked — the field still works */ }
}

export function forgetStoredKey(providerId: string): void {
	try {
		sessionStorage.removeItem(storageKey(providerId));
	} catch { /* nothing to do */ }
}
