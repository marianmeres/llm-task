/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />
/**
 * Example app for `@marianmeres/llm-task`.
 *
 * Three panels over one idea — a task is a prompt that behaves like a typed
 * function, and everything interesting happens *around* the provider call:
 *
 * - **Task lab** — configure a task, script how the provider misbehaves, run
 *   it, and watch the lifecycle hooks fire: attempts, backoff, the deadline,
 *   cache hits, the JSON repair round-trip, the normalized error taxonomy.
 *   The wire panel shows `adapter.calls` — proof that `system` and `input`
 *   travel as separate fields.
 * - **Batch** — `batch()` over 12 rows with a live concurrency slider,
 *   per-item error isolation and abort.
 * - **Cleaners** — the pure string helpers, instant, no client involved.
 *
 * The provider is `createMockAdapter` (scripted in `scenarios.ts`), but the
 * client is the real one: policy lives in `src/client.ts`, so swapping in
 * `createAnthropicAdapter()` would change nothing else here.
 *
 * Built with `@marianmeres/vanilla`: explicit reactive state (`observable` /
 * `computed` / `reactTo`), markup that lives in `<template>`s (`fromTemplate` /
 * `refs`), one delegated listener tree per view (`delegate`), and panels
 * composed as child views (`mount`).
 *
 * This is browser code: the triple-slash lib references above type it against
 * the DOM (the repo's `deno.json` targets the Deno runtime for the library).
 *
 * Bundle with: `deno task example:build` (→ `example/dist/bundle.js`).
 */
import {
	createView,
	delegate,
	fromTemplate,
	mount,
	observable,
	reactTo,
	refs,
	type ViewInstance,
} from "@marianmeres/vanilla";
import {
	type Adapter,
	applyCleaners,
	batch,
	type BatchItemResult,
	type Cleaner,
	cleaners,
	type CompletionRequest,
	createLlmClient,
	createMemoryCache,
	createMockAdapter,
	LLMError,
	type MockAdapterOptions,
	OutputValidationError,
	RateLimitError,
	type TaskDefaults,
	TruncatedOutputError,
} from "../../src/mod.ts";
import {
	forgetStoredKey,
	LIVE_PROVIDERS,
	type LiveProvider,
	loadStoredKey,
	MOCK_PROVIDER_ID,
	PROVIDER_BY_ID,
	storeKey,
} from "./providers.ts";
import {
	BATCH_ROWS,
	batchRespond,
	CLEANERS_SAMPLE,
	SAMPLE_INPUT,
	SCENARIO_BY_ID,
	SCENARIOS,
	type Ticket,
	ticketJsonSchema,
	ticketSchema,
} from "./scenarios.ts";
import { VERSION } from "./version.generated.ts";

/* ---- Config --------------------------------------------------------------- */

/** Must match the literal in the anti-FOUC inline script in index.html. */
const THEME_KEY = "llm-task-example-theme";

/** Model used when the mock is the provider (echoed, never actually called). */
const MOCK_MODEL = "claude-haiku-4-5";

/** Per-call latency of the batch panel's mock, so concurrency is visible. */
const BATCH_DELAY_MS = 400;

const DEFAULT_SYSTEM_TEXT =
	"Summarize the user input into a single short sentence title. " +
	"Plain text only — no quotes, no label, no commentary.";

const DEFAULT_SYSTEM_JSON =
	"Triage the user's support message into a ticket: category, priority and a " +
	"one-line summary.";

/**
 * The cleaner registry — id, the actual function, and the source that goes into
 * the generated snippet. Array order is the order they are applied in.
 */
const CLEANER_LIST: { id: string; fn: Cleaner; code: string }[] = [
	{ id: "trim", fn: cleaners.trim, code: "cleaners.trim" },
	{ id: "stripFences", fn: cleaners.stripFences, code: "cleaners.stripFences" },
	{ id: "firstLine", fn: cleaners.firstLine, code: "cleaners.firstLine" },
	{ id: "unquote", fn: cleaners.unquote, code: "cleaners.unquote" },
	{
		id: "stripPrefix",
		fn: cleaners.stripPrefix(/^Title:\s*/i),
		code: "cleaners.stripPrefix(/^Title:\\s*/i)",
	},
	{
		id: "collapseWhitespace",
		fn: cleaners.collapseWhitespace,
		code: "cleaners.collapseWhitespace",
	},
];

/** Resolves selected cleaner ids to functions, always in registry order. */
const pickCleaners = (ids: readonly string[]): Cleaner[] =>
	CLEANER_LIST.filter((c) => ids.includes(c.id)).map((c) => c.fn);

const pickCleanerCode = (ids: readonly string[]): string[] =>
	CLEANER_LIST.filter((c) => ids.includes(c.id)).map((c) => c.code);

/* ---- Theme (page-level, class-based: matches the design-tokens `.dark`) ----
 * The class is set pre-paint by the inline script in index.html; this keeps it
 * and the browser chrome color (<meta name="theme-color">) in sync afterwards. */

const prefersDark = (): boolean =>
	globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

const applyTheme = (dark: boolean): void => {
	const root = document.documentElement;
	root.classList.toggle("dark", dark);
	const bg = getComputedStyle(root)
		.getPropertyValue("--stuic-color-background")
		.trim();
	if (bg) {
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute("content", bg);
	}
};

let isDark = (() => {
	const stored = localStorage.getItem(THEME_KEY);
	return stored ? stored === "dark" : prefersDark();
})();
applyTheme(isDark);

const toggleTheme = (): void => {
	isDark = !isDark;
	applyTheme(isDark);
	localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
};

/* ---- Utils ---------------------------------------------------------------- */

const ms = (n: number): string => `${Math.round(n)} ms`;

/** `value` as it would read in code — objects pretty-printed, strings quoted. */
function inspect(v: unknown): string {
	if (typeof v === "string") return JSON.stringify(v);
	const json = JSON.stringify(v, null, 2);
	return json === undefined ? String(v) : json;
}

/** A one-line, length-capped preview of arbitrary text. */
function preview(text: string, max = 90): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Renders a `<code>`-flavored inline markup subset (`` `x` ``) safely. */
function withCode(target: HTMLElement, text: string): void {
	target.replaceChildren();
	for (const [i, part] of text.split("`").entries()) {
		if (!part) continue;
		if (i % 2) {
			const code = document.createElement("code");
			code.textContent = part;
			target.appendChild(code);
		} else {
			target.appendChild(document.createTextNode(part));
		}
	}
}

/** Copies `text`, flashing the button's label so the click has feedback. */
async function copyToClipboard(button: HTMLElement, text: string): Promise<void> {
	const original = button.textContent;
	try {
		await navigator.clipboard.writeText(text);
		button.textContent = "Copied ✓";
	} catch (err) {
		console.error(err);
		button.textContent = "Failed";
	}
	setTimeout(() => {
		button.textContent = original;
	}, 1200);
}

/** Builds a `<span class="chip">` (optionally toned). */
function chip(text: string, tone?: "ok" | "warn" | "error" | "info"): HTMLElement {
	const el = document.createElement("span");
	el.className = tone ? `chip chip-${tone}` : "chip";
	el.textContent = text;
	return el;
}

/** Class name of a thrown value — the thing consumers branch on. */
const errorName = (e: unknown): string =>
	e instanceof Error ? e.name : typeof e === "object" ? "Object" : typeof e;

/* ---- Shared state --------------------------------------------------------- */

/** One cache instance for the whole page, so hits survive a config change. */
const memCache = createMemoryCache({ maxEntries: 100 });

const panel = observable<"task" | "batch" | "cleaners">("task");

/* -- provider selection (shared: the batch panel reads it too) -------------- */

/** `"mock"`, or a {@link LiveProvider} id. */
const providerId = observable<string>(MOCK_PROVIDER_ID);
/** The key for the currently selected live provider. Never leaves this tab. */
const apiKey = observable("");
/** Opt-in `sessionStorage` persistence for the key. */
const rememberKey = observable(false);
const model = observable(MOCK_MODEL);

/** The selected live provider, or `undefined` while the mock is selected. */
const liveProvider = (): LiveProvider | undefined => PROVIDER_BY_ID.get(providerId.get());

/** `true` when a live provider is selected AND a key has been typed. */
const liveReady = (): boolean => !!liveProvider() && apiKey.get().trim().length > 0;

/**
 * Builds the adapter for the current provider. The mock branch stays scripted;
 * the live branch hands the key to the registry entry, which is the only place
 * that sees it.
 */
function createAdapterFor(
	mock: { respond: MockAdapterOptions["respond"]; delayMs?: number; native: boolean },
): Adapter {
	const live = liveProvider();
	if (live) return live.create(apiKey.get().trim());
	return createMockAdapter({
		respond: mock.respond,
		delayMs: mock.delayMs,
		capabilities: { jsonSchema: mock.native },
	});
}

/* ============================== Task panel ================================= */

/** One timeline row — a lifecycle hook, or the final outcome. */
interface LogEntry {
	/** ms since the run started. */
	at: number;
	/** Monospace headline. */
	label: string;
	/** Optional second line. */
	detail?: string;
	tone?: "ok" | "warn" | "error";
}

function createTaskPanel(): ViewInstance {
	return createView((track) => {
		const el = fromTemplate("tpl-task");
		const r = refs(el);

		/* -- state -- */

		const systemText = observable(DEFAULT_SYSTEM_TEXT);
		const systemJson = observable(DEFAULT_SYSTEM_JSON);
		const structured = observable(false);
		const maxTokens = observable(256);
		const maxInputChars = observable(0);
		const attempts = observable(3);
		const timeoutMs = observable(30_000);
		const allowTruncated = observable(false);
		const useCache = observable(true);
		const nativeSchema = observable(true);
		const scenarioId = observable("clean");
		const cleanerIds = observable<readonly string[]>([
			"stripFences",
			"firstLine",
			"unquote",
			"stripPrefix",
			"collapseWhitespace",
		]);
		const input = observable(SAMPLE_INPUT);
		const running = observable(false);
		const log = observable<readonly LogEntry[]>([]);

		const system = () => (structured.get() ? systemJson : systemText);

		/** Live during a run, so the Abort button has something to pull. */
		let controller: AbortController | undefined;

		/* -- static UI -- */

		// provider select: the mock first, then every registered live provider
		for (
			const [value, label] of [
				[MOCK_PROVIDER_ID, "mock — scripted, offline"] as const,
				...LIVE_PROVIDERS.map((lp) => [lp.id, lp.label] as const),
			]
		) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			r.provider.appendChild(option);
		}

		let lastGroup = "";
		for (const s of SCENARIOS) {
			const select = r.scenario as HTMLSelectElement;
			if (s.group !== lastGroup) {
				const group = document.createElement("optgroup");
				group.label = s.group;
				select.appendChild(group);
				lastGroup = s.group;
			}
			const option = document.createElement("option");
			option.value = s.id;
			option.textContent = s.label;
			option.dataset.structuredOnly = s.structuredOnly ? "1" : "";
			select.lastElementChild!.appendChild(option);
		}

		for (const c of CLEANER_LIST) {
			const row = fromTemplate("tpl-check");
			const cr = refs(row);
			cr.label.textContent = c.code;
			(cr.box as HTMLInputElement).dataset.id = c.id;
			r.cleanList.appendChild(row);
		}

		/* -- rendering -- */

		/** Everything that depends on which provider is selected. */
		const renderProvider = (): void => {
			const live = liveProvider();
			(r.provider as HTMLSelectElement).value = providerId.get();
			(r.model as HTMLInputElement).value = model.get();
			r.mockBlock.hidden = !!live;
			r.liveBlock.hidden = !live;

			const models = live?.models ?? [MOCK_MODEL];
			r.modelList.replaceChildren(
				...models.map((m) => {
					const o = document.createElement("option");
					o.value = m;
					return o;
				}),
			);

			if (live) {
				const key = apiKey.get();
				const input = r.apiKey as HTMLInputElement;
				if (input.value !== key) input.value = key;
				input.placeholder = live.keyPlaceholder;
				r.keyEnv.textContent = live.envVar;
				(r.keyConsole as HTMLAnchorElement).href = live.consoleUrl;
				(r.remember as HTMLInputElement).checked = rememberKey.get();
				r.keyHint.textContent = !key
					? "Nothing is sent until you paste a key."
					: key.startsWith(live.keyPrefix)
					? `${key.length} chars — sent as the x-api-key header, nowhere else.`
					: `Does not start with "${live.keyPrefix}" — typo?`;
				withCode(r.liveNote, live.note);
			}

			// the run button is only meaningful once a live provider has a key
			const blocked = !!live && !liveReady();
			(r.run as HTMLButtonElement).disabled = running.get() || blocked;
			r.runHint.textContent = blocked
				? "Paste an API key above to run against the live provider."
				: live
				? "⌘/Ctrl + Enter also runs. Every run is a real, billed API call."
				: "⌘/Ctrl + Enter also runs. Nothing leaves the page.";
		};

		const renderConfig = (): void => {
			(r.system as HTMLTextAreaElement).value = system().get();
			(r.output as HTMLSelectElement).value = structured.get() ? "json" : "text";
			(r.maxTokens as HTMLInputElement).value = String(maxTokens.get());
			(r.maxInputChars as HTMLInputElement).value = String(maxInputChars.get());
			(r.attempts as HTMLInputElement).value = String(attempts.get());
			(r.timeout as HTMLInputElement).value = String(timeoutMs.get());
			(r.allowTruncated as HTMLInputElement).checked = allowTruncated.get();
			(r.cache as HTMLInputElement).checked = useCache.get();
			(r.native as HTMLInputElement).checked = nativeSchema.get();
			(r.scenario as HTMLSelectElement).value = scenarioId.get();
			(r.input as HTMLTextAreaElement).value = input.get();
			r.cleanCard.hidden = structured.get();
			for (const box of r.cleanList.querySelectorAll("input")) {
				box.checked = cleanerIds.get().includes(box.dataset.id ?? "");
			}
			// scenarios that only mean something for structured output
			for (
				const option of r.scenario.querySelectorAll<HTMLOptionElement>("option")
			) {
				option.disabled = !!option.dataset.structuredOnly && !structured.get();
			}
			withCode(r.scenarioNote, SCENARIO_BY_ID.get(scenarioId.get())?.note ?? "");
			r.cacheSize.textContent = String(memCache.size);
		};

		const renderLog = (): void => {
			const entries = log.get();
			r.logEmpty.hidden = entries.length > 0;
			const frag = document.createDocumentFragment();
			for (const e of entries) {
				const item = fromTemplate("tpl-log");
				const ir = refs(item);
				if (e.tone) item.classList.add(`tone-${e.tone}`);
				ir.time.textContent = `+${Math.round(e.at)}`;
				ir.label.textContent = e.label;
				ir.detail.hidden = !e.detail;
				if (e.detail) ir.detail.textContent = e.detail;
				frag.appendChild(item);
			}
			r.log.replaceChildren(frag);
			r.log.scrollTop = r.log.scrollHeight;
		};

		const renderSnippet = (): void => {
			const isJson = structured.get();
			const live = liveProvider();
			const factory = live?.factory ?? "createAnthropicAdapter";
			const imports = [
				isJson ? null : "cleaners",
				factory,
				"createLlmClient",
				useCache.get() ? "createMemoryCache" : null,
			].filter(Boolean) as string[];

			const taskLines = [`\tsystem: ${inspect(system().get())},`];
			if (isJson) {
				taskLines.push("\tschema: Ticket, // any Standard Schema (zod, ...)");
				taskLines.push("\tjsonSchema: z.toJSONSchema(Ticket), // → native mode");
			}
			taskLines.push(`\tmaxTokens: ${maxTokens.get()},`);
			if (maxInputChars.get() > 0) {
				taskLines.push(`\tmaxInputChars: ${maxInputChars.get()},`);
			}
			if (timeoutMs.get() !== 30_000) {
				taskLines.push(`\ttimeoutMs: ${timeoutMs.get()},`);
			}
			if (attempts.get() !== 3) {
				taskLines.push(
					attempts.get() === 1
						? "\tretry: false,"
						: `\tretry: { attempts: ${attempts.get()} },`,
				);
			}
			if (allowTruncated.get()) taskLines.push("\tallowTruncated: true,");
			if (!useCache.get()) taskLines.push("\tcache: false,");
			if (!isJson) {
				const picked = pickCleanerCode(cleanerIds.get());
				if (picked.length) taskLines.push(`\tclean: [${picked.join(", ")}],`);
			}

			// the key is deliberately absent — the snippet shows the env fallback,
			// which is what server code should do anyway
			const adapterLines = live && live.snippetOptions.length
				? [`\tadapter: ${factory}({`, ...live.snippetOptions, "\t}),"]
				: [`\tadapter: ${factory}(), // ${
					live?.envVar ?? "ANTHROPIC_API_KEY"
				} fallback`];

			(r.snippet as HTMLElement).textContent = [
				`import {\n${imports.map((i) => `\t${i},`).join("\n")}\n` +
				`} from "@marianmeres/llm-task";`,
				"",
				"const client = createLlmClient({",
				...adapterLines,
				`\tmodel: ${JSON.stringify(model.get())},`,
				useCache.get() ? "\tcache: createMemoryCache()," : null,
				"});",
				"",
				"const task = client.task({",
				...taskLines,
				"});",
				"",
				`const value = await task(input); // -> ${isJson ? "Ticket" : "string"}`,
				"const full = await task.run(input); // -> TaskResult<…>",
			].filter((l) => l !== null).join("\n");
		};

		/** The result envelope, field by field. */
		const renderResult = (
			result: {
				value: unknown;
				text: string;
				finishReason: string;
				usage?: { inputTokens: number; outputTokens: number };
				model: string;
				cached: boolean;
				inputTruncated: boolean;
				attempts: number;
				repaired: boolean;
			},
		): void => {
			r.outcomeTitle.textContent = "Result — TaskResult<…>";
			const dl = document.createElement("dl");
			dl.className = "kv";
			const rows: [string, string | HTMLElement][] = [
				["value", inspect(result.value)],
				["text", inspect(result.text)],
				["finishReason", result.finishReason],
				[
					"usage",
					result.usage
						? `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`
						: "—",
				],
				["model", result.model],
				["attempts", String(result.attempts)],
				["cached", String(result.cached)],
				["repaired", String(result.repaired)],
				["inputTruncated", String(result.inputTruncated)],
			];
			for (const [k, v] of rows) {
				const dt = document.createElement("dt");
				dt.textContent = k;
				const dd = document.createElement("dd");
				if (typeof v === "string") dd.textContent = v;
				else dd.appendChild(v);
				dl.append(dt, dd);
			}
			const flags = document.createElement("div");
			flags.className = "stats";
			if (result.cached) flags.appendChild(chip("cache hit", "info"));
			if (result.repaired) flags.appendChild(chip("repaired", "warn"));
			if (result.inputTruncated) flags.appendChild(chip("input truncated", "warn"));
			if (result.finishReason === "length") {
				flags.appendChild(chip("truncated output", "warn"));
			}

			r.outcome.replaceChildren(dl);
			if (flags.childElementCount) r.outcome.appendChild(flags);
			r.outcomeCard.hidden = false;
		};

		/** The normalized error — the thing you actually branch on. */
		const renderError = (e: unknown): void => {
			r.outcomeTitle.textContent = "Threw — the normalized error";
			const dl = document.createElement("dl");
			dl.className = "kv";
			const rows: [string, string][] = [["instanceof", errorName(e)]];
			if (e instanceof LLMError) {
				rows.push(["message", e.message]);
				rows.push(["adapter", e.adapter ?? "—"]);
				rows.push(["status", e.status === undefined ? "—" : String(e.status)]);
				rows.push(["retryable", String(e.retryable)]);
				if (e instanceof RateLimitError) {
					rows.push(["retryAfter", `${e.retryAfter ?? "—"} s`]);
				}
				if (e instanceof TruncatedOutputError) {
					rows.push(["text (partial)", inspect(e.text)]);
				}
				if (e instanceof OutputValidationError) {
					rows.push(["text", inspect(e.text)]);
					for (const [i, issue] of e.issues.entries()) {
						rows.push([
							`issues[${i}]`,
							`${(issue.path ?? []).join(".")}: ${issue.message}`,
						]);
					}
				}
			} else {
				rows.push(["message", String((e as Error)?.message ?? e)]);
			}
			for (const [k, v] of rows) {
				const dt = document.createElement("dt");
				dt.textContent = k;
				const dd = document.createElement("dd");
				dd.textContent = v;
				dl.append(dt, dd);
			}
			r.outcome.replaceChildren(dl);
			r.outcomeCard.hidden = false;
		};

		/** Every request the adapter actually received, verbatim. */
		const renderCalls = (calls: readonly CompletionRequest[]): void => {
			r.wireCard.hidden = calls.length === 0;
			const frag = document.createDocumentFragment();
			for (const [i, call] of calls.entries()) {
				const block = fromTemplate("tpl-call");
				const br = refs(block);
				br.head.append(
					chip(`call ${i + 1}`),
					chip(call.model),
					chip(`maxTokens ${call.maxTokens}`),
					chip(call.jsonSchema ? "jsonSchema: native" : "jsonSchema: —"),
				);
				br.body.textContent = JSON.stringify(
					{
						system: call.system,
						input: call.input,
						model: call.model,
						maxTokens: call.maxTokens,
						temperature: call.temperature,
						jsonSchema: call.jsonSchema,
					},
					null,
					2,
				);
				frag.appendChild(block);
			}
			r.calls.replaceChildren(frag);
		};

		/* -- the run -- */

		const push = (entry: LogEntry): void => {
			log.update((l) => [...l, entry]);
		};

		async function run(): Promise<void> {
			if (running.get()) return;
			running.set(true);
			log.set([]);
			r.outcomeCard.hidden = true;
			r.wireCard.hidden = true;

			const scenario = SCENARIO_BY_ID.get(scenarioId.get())!;
			const isJson = structured.get();
			const t0 = Date.now();
			const at = () => Date.now() - t0;

			// a fresh adapter per run: the scripted sequence restarts, and the
			// recorded `calls` are only this run's. With a live provider the
			// scenario is ignored — the real API decides what happens.
			const adapter = createAdapterFor({
				respond: isJson ? scenario.json : scenario.text,
				delayMs: scenario.delayMs,
				native: nativeSchema.get(),
			});

			controller = new AbortController();

			// the mock records requests as `adapter.calls`; a live adapter does
			// not, so the hook is the fallback source for the wire panel
			const sent: CompletionRequest[] = [];

			const client = createLlmClient({
				adapter,
				model: model.get(),
				cache: memCache,
				hooks: {
					onRequest: ({ request, attempt }) => {
						sent.push({ ...request });
						push({
							at: at(),
							label: `onRequest — attempt ${attempt}`,
							detail: `system: ${preview(request.system ?? "—", 70)}`,
						});
					},
					onResponse: ({ result, durationMs, cached, attempt }) =>
						push({
							at: at(),
							tone: "ok",
							label: cached
								? "onResponse — cache hit"
								: `onResponse — attempt ${attempt}, ${ms(durationMs)}`,
							detail: `finishReason: ${result.finishReason} · ${
								preview(result.text || "(empty)", 70)
							}`,
						}),
					onRetry: ({ attempt, delayMs, error }) =>
						push({
							at: at(),
							tone: "warn",
							label: `onRetry — attempt ${attempt} failed, waiting ${
								ms(delayMs)
							}`,
							detail: `${errorName(error)}: ${
								(error as Error)?.message ?? ""
							}`,
						}),
					onInputTruncated: ({ originalChars, maxInputChars }) =>
						push({
							at: at(),
							tone: "warn",
							label: "onInputTruncated",
							detail: `${originalChars} → ${maxInputChars} chars`,
						}),
				},
			});

			const common: TaskDefaults & {
				allowTruncated: boolean;
				cache: boolean;
				maxInputChars?: number;
				system: string;
			} = {
				system: system().get(),
				maxTokens: maxTokens.get(),
				timeoutMs: timeoutMs.get(),
				retry: { attempts: attempts.get() },
				allowTruncated: allowTruncated.get(),
				cache: useCache.get(),
				maxInputChars: maxInputChars.get() || undefined,
			};

			try {
				// two branches, so the return type stays honest: `Ticket` for the
				// Standard Schema task, `string` for the plain one
				const result = isJson
					? await client
						.task({
							...common,
							schema: ticketSchema,
							// the capability toggle is a mock-only control; a real
							// adapter reports its own capabilities
							jsonSchema: liveProvider() || nativeSchema.get()
								? ticketJsonSchema
								: undefined,
						})
						.run(input.get(), { signal: controller.signal })
					: await client
						.task({ ...common, clean: pickCleaners(cleanerIds.get()) })
						.run(input.get(), { signal: controller.signal });

				push({
					at: at(),
					tone: "ok",
					label: `✓ value — ${isJson ? "Ticket" : "string"}`,
					detail: preview(inspect(result.value as Ticket | string), 140),
				});
				renderResult(result);
			} catch (e) {
				push({
					at: at(),
					tone: "error",
					label: `✗ threw ${errorName(e)}`,
					detail: (e as Error)?.message ?? String(e),
				});
				renderError(e);
			} finally {
				// `calls` is the mock's recorder; a live adapter has none, so fall
				// back to what the onRequest hook saw
				renderCalls((adapter as { calls?: CompletionRequest[] }).calls ?? sent);
				r.cacheSize.textContent = String(memCache.size);
				controller = undefined;
				running.set(false);
			}
		}

		/* -- reactions -- */

		track(reactTo(
			[
				systemText,
				systemJson,
				structured,
				maxTokens,
				maxInputChars,
				attempts,
				timeoutMs,
				allowTruncated,
				useCache,
				nativeSchema,
				scenarioId,
				cleanerIds,
				providerId,
				apiKey,
				rememberKey,
				model,
			],
			() => {
				renderConfig();
				renderProvider();
				renderSnippet();
			},
		));

		track(log.subscribe(renderLog));

		track(running.subscribe((on) => {
			(r.run as HTMLButtonElement).textContent = on ? "Running…" : "Run task";
			(r.abort as HTMLButtonElement).disabled = !on;
			renderProvider(); // owns the run button's disabled state
		}));

		/* -- events -- */

		track(delegate(el, {
			setSystem: (_e, t) => system().set((t as HTMLTextAreaElement).value),
			setOutput: (_e, t) => {
				const isJson = (t as HTMLSelectElement).value === "json";
				structured.set(isJson);
				// a structured-only scenario makes no sense for a string task
				const current = SCENARIO_BY_ID.get(scenarioId.get());
				if (!isJson && current?.structuredOnly) scenarioId.set("clean");
			},
			setMaxTokens: (_e, t) =>
				maxTokens.set(Math.max(1, Number((t as HTMLInputElement).value) || 1)),
			setMaxInputChars: (_e, t) =>
				maxInputChars.set(
					Math.max(0, Number((t as HTMLInputElement).value) || 0),
				),
			setAttempts: (_e, t) =>
				attempts.set(Math.max(1, Number((t as HTMLInputElement).value) || 1)),
			setTimeout: (_e, t) =>
				timeoutMs.set(Math.max(0, Number((t as HTMLInputElement).value) || 0)),
			setAllowTruncated: (_e, t) =>
				allowTruncated.set((t as HTMLInputElement).checked),
			setCache: (_e, t) => useCache.set((t as HTMLInputElement).checked),
			setNative: (_e, t) => nativeSchema.set((t as HTMLInputElement).checked),
			setScenario: (_e, t) => scenarioId.set((t as HTMLSelectElement).value),
			setProvider: (_e, t) => {
				const id = (t as HTMLSelectElement).value;
				providerId.set(id);
				const live = PROVIDER_BY_ID.get(id);
				model.set(live?.defaultModel ?? MOCK_MODEL);
				// a remembered key is per provider
				apiKey.set(live ? loadStoredKey(id) : "");
				rememberKey.set(live ? !!loadStoredKey(id) : false);
			},
			setModel: (_e, t) => model.set((t as HTMLInputElement).value),
			setApiKey: (_e, t) => {
				const value = (t as HTMLInputElement).value;
				apiKey.set(value);
				if (rememberKey.get()) storeKey(providerId.get(), value.trim());
			},
			setRemember: (_e, t) => {
				const on = (t as HTMLInputElement).checked;
				rememberKey.set(on);
				if (on) storeKey(providerId.get(), apiKey.get().trim());
				else forgetStoredKey(providerId.get());
			},
			forgetKey: () => {
				forgetStoredKey(providerId.get());
				apiKey.set("");
				rememberKey.set(false);
			},
			setInput: (_e, t) => input.set((t as HTMLTextAreaElement).value),
			toggle: (_e, t) => {
				const box = t as HTMLInputElement;
				const id = box.dataset.id ?? "";
				cleanerIds.update((ids) =>
					box.checked ? [...ids, id] : ids.filter((x) => x !== id)
				);
			},
			maybeRun: (e) => {
				const ev = e as KeyboardEvent;
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) void run();
			},
			run: () => void run(),
			abort: () =>
				controller?.abort(new DOMException("Aborted by you", "AbortError")),
			clearCache: () => {
				memCache.clear();
				r.cacheSize.textContent = "0";
			},
			copySnippet: (_e, t) => void copyToClipboard(t, r.snippet.textContent ?? ""),
		}));

		renderConfig();
		renderProvider();
		renderSnippet();
		renderLog();

		return { el };
	});
}

/* ============================== Batch panel ================================ */

/** Per-row UI state, mutated in place as the batch progresses. */
type RowState = "idle" | "running" | "ok" | "failed";

function createBatchPanel(): ViewInstance {
	return createView((track) => {
		const el = fromTemplate("tpl-batch");
		const r = refs(el);

		const concurrency = observable(4);
		const running = observable(false);
		/** Opt-in: run the batch against the live provider instead of the mock. */
		const useLive = observable(false);
		let controller: AbortController | undefined;

		const inputs = BATCH_ROWS.map((row) => row.input);
		/** One DOM node per row, kept around so progress can mutate it directly. */
		const rowEls: { el: HTMLElement; out: HTMLElement }[] = [];

		for (const row of BATCH_ROWS) {
			const node = fromTemplate("tpl-brow");
			const nr = refs(node);
			nr.in.textContent = row.input;
			nr.out.textContent = "—";
			rowEls.push({ el: node, out: nr.out });
			r.rows.appendChild(node);
		}

		const setRow = (index: number, state: RowState, out: string): void => {
			const row = rowEls[index];
			if (!row) return;
			row.el.classList.remove("is-running", "is-ok", "is-failed");
			if (state !== "idle") row.el.classList.add(`is-${state}`);
			row.out.textContent = out;
		};

		const renderStats = (
			done: number,
			ok: number,
			failed: number,
			elapsed: number,
		): void => {
			r.bar.style.width = `${(done / inputs.length) * 100}%`;
			r.stats.replaceChildren(
				chip(`${done}/${inputs.length} done`),
				chip(`${ok} ok`, ok ? "ok" : undefined),
				chip(`${failed} failed`, failed ? "error" : undefined),
				chip(`${ms(elapsed)} elapsed`),
				chip(`concurrency ${concurrency.get()}`, "info"),
			);
		};

		const renderSnippet = (): void => {
			(r.snippet as HTMLElement).textContent = [
				'import { batch } from "@marianmeres/llm-task";',
				"",
				"const results = await batch(toTitle, rows, {",
				`\tconcurrency: ${concurrency.get()},`,
				"\tsignal,",
				"\tonProgress: ({ done, total }) => console.log(`${done}/${total}`),",
				"});",
				"",
				"for (const r of results) {",
				"\tif (r.ok) save(r.input, r.value);",
				"\telse console.error(`row ${r.index}:`, r.error);",
				"}",
			].join("\n");
		};

		async function run(): Promise<void> {
			if (running.get()) return;
			running.set(true);
			controller = new AbortController();
			const t0 = Date.now();
			rowEls.forEach((_, i) => setRow(i, "idle", "—"));
			renderStats(0, 0, 0, 0);

			const live = useLive.get() && liveReady() ? liveProvider() : undefined;
			const adapter = live
				? live.create(apiKey.get().trim())
				: createMockAdapter({ respond: batchRespond, delayMs: BATCH_DELAY_MS });
			const client = createLlmClient({
				adapter,
				model: model.get(),
				// the hook is how the UI knows an item went in flight — batch()
				// itself only reports items that have already settled
				hooks: {
					onRequest: ({ request }) => {
						const index = inputs.indexOf(request.input);
						if (index >= 0) setRow(index, "running", "…");
					},
				},
			});
			const toTitle = client.task({
				system: "Summarize the support message into a short title. " +
					"Plain text only, no quotes.",
				maxTokens: 64,
				// the mock's failures are deterministic, so retries only add
				// noise; a real 429 mid-batch genuinely deserves the backoff
				retry: live ? undefined : false,
				clean: [cleaners.unquote, cleaners.firstLine],
			});

			// batch() reports counts, not values, as items settle — so the row is
			// updated by a thin wrapper around the task that reports and rethrows
			const reporting = async (
				text: string,
				options?: { signal?: AbortSignal },
			): Promise<string> => {
				const index = inputs.indexOf(text);
				try {
					const value = await toTitle(text, options);
					setRow(index, "ok", value);
					return value;
				} catch (e) {
					setRow(index, "failed", `✗ ${errorName(e)}`);
					throw e;
				}
			};

			let results: BatchItemResult<string>[] = [];
			try {
				results = await batch(reporting, inputs, {
					concurrency: concurrency.get(),
					signal: controller.signal,
					onProgress: ({ done, ok, failed }) =>
						renderStats(done, ok, failed, Date.now() - t0),
				});
			} finally {
				// aborted-before-started items never reached the wrapper
				for (const item of results) {
					if (!item.ok) {
						setRow(item.index, "failed", `✗ ${errorName(item.error)}`);
					}
				}
				renderStats(
					results.length,
					results.filter((x) => x.ok).length,
					results.filter((x) => !x.ok).length,
					Date.now() - t0,
				);
				controller = undefined;
				running.set(false);
			}
		}

		track(concurrency.subscribe((n) => {
			(r.conc as HTMLInputElement).value = String(n);
			r.concOut.textContent = String(n);
			renderSnippet();
		}));

		track(reactTo([providerId, apiKey, useLive], () => {
			const ready = liveReady();
			r.liveGate.hidden = !ready;
			if (!ready && useLive.get()) useLive.set(false);
			(r.useLive as HTMLInputElement).checked = useLive.get();
			r.liveGateLabel.replaceChildren();
			if (ready) {
				const strong = document.createElement("strong");
				strong.textContent = `${BATCH_ROWS.length} real API calls`;
				r.liveGateLabel.append(
					document.createTextNode("use the live provider — "),
					strong,
					document.createTextNode(" per run, billed to your key"),
				);
			}
		}));

		track(running.subscribe((on) => {
			(r.run as HTMLButtonElement).disabled = on;
			(r.run as HTMLButtonElement).textContent = on ? "Running…" : "Run batch";
			(r.abort as HTMLButtonElement).disabled = !on;
		}));

		track(delegate(el, {
			setConcurrency: (_e, t) =>
				concurrency.set(Number((t as HTMLInputElement).value)),
			setUseLive: (_e, t) => useLive.set((t as HTMLInputElement).checked),
			run: () => void run(),
			abort: () =>
				controller?.abort(new DOMException("Aborted by you", "AbortError")),
		}));

		renderStats(0, 0, 0, 0);

		return { el };
	});
}

/* ============================= Cleaners panel ============================== */

function createCleanersPanel(): ViewInstance {
	return createView((track) => {
		const el = fromTemplate("tpl-cleaners");
		const r = refs(el);

		const raw = observable(CLEANERS_SAMPLE);
		const selected = observable<readonly string[]>([
			"stripFences",
			"firstLine",
			"unquote",
			"stripPrefix",
			"collapseWhitespace",
		]);

		for (const c of CLEANER_LIST) {
			const row = fromTemplate("tpl-check");
			const cr = refs(row);
			cr.label.textContent = c.code;
			(cr.box as HTMLInputElement).dataset.id = c.id;
			r.list.appendChild(row);
		}

		track(reactTo([raw, selected], () => {
			const ids = selected.get();
			for (const box of r.list.querySelectorAll("input")) {
				box.checked = ids.includes(box.dataset.id ?? "");
			}
			const out = applyCleaners(raw.get(), pickCleaners(ids));
			(r.out as HTMLElement).textContent = out || "(empty)";
			r.len.textContent = `${raw.get().length} → ${out.length} chars`;
			const picked = pickCleanerCode(ids);
			(r.snippet as HTMLElement).textContent = picked.length
				? `client.task({\n\tsystem: "…",\n\tclean: [\n${
					picked.map((c) => `\t\t${c},`).join("\n")
				}\n\t],\n});`
				: 'client.task({\n\tsystem: "…",\n\t// no cleaners — raw text\n});';
		}));

		(r.raw as HTMLTextAreaElement).value = raw.get();

		track(delegate(el, {
			setRaw: (_e, t) => raw.set((t as HTMLTextAreaElement).value),
			toggle: (_e, t) => {
				const box = t as HTMLInputElement;
				const id = box.dataset.id ?? "";
				selected.update((ids) =>
					box.checked ? [...ids, id] : ids.filter((x) => x !== id)
				);
			},
		}));

		return { el };
	});
}

/* ================================== App =================================== */

const app = createView((track) => {
	const el = fromTemplate("tpl-app");
	const r = refs(el);

	// panels are page-lifetime children: mounted once, shown/hidden by the tabs
	const views: Record<string, ViewInstance> = {
		task: mount(track, r.panels, createTaskPanel()),
		batch: mount(track, r.panels, createBatchPanel()),
		cleaners: mount(track, r.panels, createCleanersPanel()),
	};

	track(panel.subscribe((active) => {
		for (const [name, view] of Object.entries(views)) {
			(view.el as HTMLElement).hidden = name !== active;
		}
		for (const tab of el.querySelectorAll<HTMLElement>("[data-tab]")) {
			tab.setAttribute("aria-selected", String(tab.dataset.tab === active));
		}
	}));

	track(delegate(el, {
		tab: (_e, t) => panel.set(t.dataset.tab as "task" | "batch" | "cleaners"),
		toggleTheme: () => toggleTheme(),
	}));

	r.version.textContent = `v${VERSION}`;

	return { el };
});

document.getElementById("app")!.appendChild(app.el!);
