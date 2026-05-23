/**
 * Discovers and loads VS Code grammar contributions for the Knit
 * Output rendering pipeline.
 *
 * Every installed extension can contribute one or more entries under
 * `contributes.grammars` in its `package.json`. Each entry maps a
 * `language` ID (and a `scopeName`) to a `.tmLanguage.json` / `.plist`
 * grammar file inside the extension. VS Code's own preview pipeline
 * uses these contributions to tokenize code blocks; the Knit Output
 * rendering pipeline needs the same thing, except we have to walk the
 * contributions ourselves (VS Code does not expose a public "give me a
 * grammar by language ID" API).
 *
 * Resolution order for the R grammar specifically, in priority order:
 *
 *   1. `REditorSupport.r-syntax`  — upstream, freshest copy
 *   2. `REditorSupport.r`         — full R extension (bundles the
 *                                   same grammar)
 *   3. `vscode.r`                 — VS Code's built-in mirror, which
 *                                   is periodically synced from
 *                                   REditorSupport upstream
 *
 * For non-R languages the policy is simpler: pick the first installed
 * contribution we find. The Knit Output pipeline only needs a single
 * grammar per language, and a user with multiple grammars installed
 * for the same language is rare in practice.
 *
 * `vscode-textmate` + `vscode-oniguruma` are loaded lazily — we don't
 * pay the WASM-init cost until the first code block actually needs
 * highlighting.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
    IGrammar,
    IRawGrammar,
    IOnigLib,
    IRawTheme,
    Registry as RegistryType,
    StateStack,
} from 'vscode-textmate';

/**
 * Element type of `IRawTheme.settings`. The interface itself isn't
 * exported from vscode-textmate but the array shape is, so we derive
 * the element type. This keeps us in lockstep with whatever upstream's
 * setting shape is without redeclaring it.
 */
export type ThemeSetting = IRawTheme['settings'][number];

/** Public shape — small enough that a fake registry fits in tests. */
export interface GrammarRegistry {
    /**
     * Tokenize one line of source, returning the per-token scope
     * arrays we need to drive role mapping. The non-binary path is
     * what the highlighter consumes: it gives us actual scope names
     * like `entity.name.function.r` rather than an opaque theme
     * color index.
     */
    tokenizeLineForLanguage(
        languageId: string,
        line: string,
        state: unknown,
    ): Promise<LineTokenization | null>;

    /** Resolve the scopeName for a given language, or null if unknown. */
    scopeNameFor(languageId: string): string | null;

    /** Eagerly load the grammar so a tokenize call hits a warm cache. */
    primeForLanguage(languageId: string): Promise<boolean>;

    /**
     * Atomically apply `themeSettings` to the underlying registry, then
     * invoke `inner` while the theme is active. Returns whatever `inner`
     * returns.
     *
     * Why a callback rather than three separate methods (`setTheme`,
     * `tokenizeLine2`, `getColorMap`):
     *
     *   1. **Serialization.** `Registry.setTheme` is a registry-wide
     *      mutation. Concurrent extractors would clobber each other's
     *      theme between `setTheme` and the matching `tokenizeLine2`
     *      reads, yielding colors from the wrong theme. The callback
     *      shape lets us queue extractions through one promise chain,
     *      so each extractor sees a stable theme for its full window.
     *
     *   2. **Decoupling from the highlighter.** The Knit highlighter
     *      uses `tokenizeLineForLanguage` (raw scope chains), which is
     *      unaffected by `setTheme`. Hiding the theme-aware path
     *      behind `extractWithTheme` keeps that invariant obvious.
     *
     * The api exposed to `inner` carries the active colorMap and a
     * thin `tokenizeLine2` wrapper. `inner` must not retain references
     * past its return; the registry's state may change after.
     */
    extractWithTheme<T>(
        themeSettings: readonly ThemeSetting[],
        inner: (api: ThemeExtractionApi) => Promise<T>,
    ): Promise<T>;
}

/**
 * Theme-aware surface handed to `extractWithTheme`'s inner callback.
 * The `colorMap` is a snapshot taken after `setTheme` returns; the
 * entry at index N is the hex string for tokens whose metadata
 * foreground field equals N. `tokenizeLine2` returns binary tokens
 * encoded per vscode-textmate's bit layout (see
 * `vscode-theme-palette.ts` for the foreground-decoding helper).
 */
export interface ThemeExtractionApi {
    readonly colorMap: readonly string[];
    tokenizeLine2ForLanguage(
        languageId: string,
        line: string,
        state?: unknown,
    ): Promise<{ tokens: Uint32Array; ruleStack: unknown } | null>;
}

/**
 * Result of a single `tokenizeLine` call. We expose the per-token
 * range and its scope chain (outermost first, as TextMate emits it).
 * `ruleStack` is carried over verbatim to the next line.
 */
export interface LineTokenization {
    tokens: readonly ScopeToken[];
    ruleStack: unknown;
}

/**
 * One TextMate scope token. `startIndex` and `endIndex` are
 * 0-based character offsets into the line. `scopes` is the scope
 * chain ordered outermost (`source.r`) → innermost (e.g.
 * `entity.name.function.r`).
 */
export interface ScopeToken {
    startIndex: number;
    endIndex: number;
    scopes: readonly string[];
}

/**
 * One `contributes.grammars` entry as we read it from an extension's
 * package.json. Mirrors VS Code's grammar contribution schema; only
 * the fields we use are typed.
 */
interface GrammarContribution {
    language?: string;
    scopeName: string;
    path: string;
    embeddedLanguages?: Record<string, string>;
}

/** One contribution + which extension shipped it (for diagnostics). */
interface ResolvedContribution {
    extensionId: string;
    languageId: string;
    scopeName: string;
    absolutePath: string;
    embeddedLanguages?: Record<string, string>;
}

/**
 * Build a real registry that lazily loads vscode-textmate +
 * vscode-oniguruma. `onigWasmPath` is the path the build script writes
 * onig.wasm to (`dist/onig.wasm`); we read it once and feed the bytes
 * to `loadWASM`.
 *
 * `extensions` and `getExtensionById` are injected so the registry is
 * fully testable without a live `vscode.extensions` API. Production
 * call sites pass `vscode.extensions.all` and
 * `(id) => vscode.extensions.getExtension(id)`.
 */
export function createGrammarRegistry(args: {
    extensions: readonly vscode.Extension<unknown>[];
    getExtensionById: (id: string) => vscode.Extension<unknown> | undefined;
    onigWasmPath: string;
    /** Override the lazy import for tests. */
    importTextmate?: () => Promise<typeof import('vscode-textmate')>;
    importOniguruma?: () => Promise<typeof import('vscode-oniguruma')>;
    /** Override grammar file reads for tests. */
    readGrammarFile?: (absolutePath: string) => Promise<string>;
    /** Override onig.wasm reads for tests (default reads from `onigWasmPath`). */
    readOnigWasm?: () => Promise<ArrayBuffer>;
}): GrammarRegistry {
    const contributions = collectGrammarContributions(args.extensions);

    // Lazy state. We only initialise vscode-textmate / vscode-oniguruma
    // the first time someone asks us to tokenize a line — there is no
    // point paying the WASM-init cost for a knit that contains no code
    // blocks at all.
    let registryPromise: Promise<RegistryType> | null = null;
    const grammarCache = new Map<string, Promise<IGrammar | null>>();

    const importTextmate = args.importTextmate ?? (async () => import('vscode-textmate'));
    const importOniguruma = args.importOniguruma ?? (async () => import('vscode-oniguruma'));
    const readGrammarFile = args.readGrammarFile
        ?? (async (p: string) => fs.promises.readFile(p, 'utf-8'));
    const readOnigWasm: () => Promise<ArrayBuffer> = args.readOnigWasm
        ?? (async () => {
            const buf = await fs.promises.readFile(args.onigWasmPath);
            // Slice copies the relevant bytes into a fresh ArrayBuffer,
            // preserving WASM-loader compatibility regardless of Node /
            // bun / browser Buffer-backing differences.
            return buf.buffer.slice(
                buf.byteOffset,
                buf.byteOffset + buf.byteLength,
            ) as ArrayBuffer;
        });

    async function ensureRegistry(): Promise<RegistryType> {
        if (registryPromise) return registryPromise;
        const promise = (async () => {
            const textmate = await importTextmate();
            const oniguruma = await importOniguruma();
            const onigBuffer = await readOnigWasm();
            await oniguruma.loadWASM(onigBuffer);
            const onigLib: Promise<IOnigLib> = Promise.resolve({
                createOnigScanner: (patterns: string[]) => oniguruma.createOnigScanner(patterns),
                createOnigString: (s: string) => oniguruma.createOnigString(s),
            });
            return new textmate.Registry({
                onigLib,
                loadGrammar: async (scopeName: string): Promise<IRawGrammar | null> => {
                    const contrib = contributions.byScopeName.get(scopeName);
                    if (!contrib) return null;
                    const text = await readGrammarFile(contrib.absolutePath);
                    return textmate.parseRawGrammar(text, contrib.absolutePath);
                },
            });
        })();
        registryPromise = promise;
        // Clear the cache on rejection so a transient failure (an
        // EBUSY on the onig.wasm file mid-VSIX-install, a momentary
        // import glitch) doesn't permanently poison this registry's
        // lifetime. Without this the rejected promise sits in
        // `registryPromise` forever; every subsequent `extractWithTheme`
        // and `loadGrammar` re-throws and the panel sees the GitHub
        // palette for the rest of the session.
        promise.catch(() => {
            if (registryPromise === promise) registryPromise = null;
        });
        return promise;
    }

    async function loadGrammar(languageId: string): Promise<IGrammar | null> {
        const lang = languageId.toLowerCase();
        const cached = grammarCache.get(lang);
        if (cached) return cached;
        const contrib = pickContribution(contributions, lang);
        if (!contrib) {
            grammarCache.set(lang, Promise.resolve(null));
            return null;
        }
        const promise = (async () => {
            try {
                const registry = await ensureRegistry();
                const grammar = await registry.loadGrammar(contrib.scopeName);
                return grammar ?? null;
            } catch (err) {
                console.error(
                    `[raven-knit] failed to load grammar ${contrib.scopeName} ` +
                    `from ${contrib.extensionId} (${contrib.absolutePath}): ` +
                    (err instanceof Error ? err.message : String(err)),
                );
                return null;
            }
        })();
        grammarCache.set(lang, promise);
        return promise;
    }

    // Serialization queue for `extractWithTheme`. Concurrent callers
    // chain off this promise so each `setTheme` + tokenize window is
    // atomic. The previous value is awaited inside the closure so a
    // throw inside one extraction does not poison the queue for the
    // next.
    let themeOpQueue: Promise<unknown> = Promise.resolve();

    return {
        async tokenizeLineForLanguage(languageId, line, state) {
            const grammar = await loadGrammar(languageId);
            if (!grammar) return null;
            const result = grammar.tokenizeLine(line, (state ?? null) as StateStack | null);
            return {
                tokens: result.tokens.map((t) => ({
                    startIndex: t.startIndex,
                    endIndex: t.endIndex,
                    scopes: t.scopes,
                })),
                ruleStack: result.ruleStack,
            };
        },
        scopeNameFor(languageId) {
            const contrib = pickContribution(contributions, languageId.toLowerCase());
            return contrib?.scopeName ?? null;
        },
        async primeForLanguage(languageId) {
            const grammar = await loadGrammar(languageId);
            return grammar !== null;
        },
        async extractWithTheme<T>(
            themeSettings: readonly ThemeSetting[],
            inner: (api: ThemeExtractionApi) => Promise<T>,
        ): Promise<T> {
            // Tail-await the queue (ignore prior errors — they belong to
            // a previous extraction's caller, not this one), then run.
            const prev = themeOpQueue.catch(() => undefined);
            const run = (async (): Promise<T> => {
                await prev;
                const registry = await ensureRegistry();
                // Wrap setTheme + inner in try/finally so a throw inside
                // `inner` doesn't leave the registry on whatever stale
                // theme this extraction set. The next caller pays a
                // setTheme of its own anyway, so the cleanup is purely
                // about preserving the documented "registry never
                // observes a half-applied theme outside an
                // extractWithTheme window" invariant.
                registry.setTheme({ settings: [...themeSettings] });
                try {
                    const colorMap = registry.getColorMap();
                    const api: ThemeExtractionApi = {
                        colorMap,
                        async tokenizeLine2ForLanguage(languageId, line, state) {
                            const grammar = await loadGrammar(languageId);
                            if (!grammar) return null;
                            const result = grammar.tokenizeLine2(
                                line,
                                (state ?? null) as StateStack | null,
                            );
                            return { tokens: result.tokens, ruleStack: result.ruleStack };
                        },
                    };
                    return await inner(api);
                } finally {
                    // Reset to an empty theme so any code path that
                    // bypasses `extractWithTheme` (forbidden by the
                    // class invariant, but defended here as a
                    // belt-and-braces guard) sees a known state
                    // instead of a previous extraction's theme.
                    registry.setTheme({ settings: [] });
                }
            })();
            themeOpQueue = run;
            return run;
        },
    };
}

/**
 * Walk all installed extensions, collect every `contributes.grammars`
 * entry that maps a language ID we might tokenize. Returns lookup
 * tables keyed by lower-cased language ID and by scopeName.
 *
 * The `byScopeName` map is built in a second pass so it reflects the
 * SAME priority logic as `pickContribution`. Without that, a user
 * with both `vscode.r` and `REditorSupport.r-syntax` installed could
 * have the wrong grammar loaded when `vscode-textmate` looks up
 * `source.r` — the priority order would only affect language-ID
 * lookups, not the scope-name path that `Registry.loadGrammar` takes.
 */
function collectGrammarContributions(
    extensions: readonly vscode.Extension<unknown>[],
): {
    byLanguage: Map<string, ResolvedContribution[]>;
    byScopeName: Map<string, ResolvedContribution>;
} {
    const byLanguage = new Map<string, ResolvedContribution[]>();

    for (const ext of extensions) {
        const grammars = readGrammarContributions(ext);
        for (const g of grammars) {
            // Only the entries that map a language ID interest us. A
            // `contributes.grammars` entry can also be a pure injection
            // (no `language:`); those aren't language-keyed and we
            // ignore them here. The `path` field is relative to the
            // extension root per VS Code's contribution-point spec.
            if (!g.language || typeof g.scopeName !== 'string' || typeof g.path !== 'string') {
                continue;
            }
            const absolutePath = path.isAbsolute(g.path)
                ? g.path
                : path.join(ext.extensionPath, g.path);
            const resolved: ResolvedContribution = {
                extensionId: ext.id,
                languageId: g.language.toLowerCase(),
                scopeName: g.scopeName,
                absolutePath,
                embeddedLanguages: g.embeddedLanguages,
            };
            const bucket = byLanguage.get(resolved.languageId);
            if (bucket) bucket.push(resolved);
            else byLanguage.set(resolved.languageId, [resolved]);
        }
    }

    // Second pass: pick the canonical contribution per language using
    // the priority logic, then index those by scopeName. If two
    // languages happen to share a scopeName (rare but legal), the
    // first language encountered wins — there is no priority signal
    // across language IDs.
    const byScopeName = new Map<string, ResolvedContribution>();
    for (const [languageId, bucket] of byLanguage) {
        const canonical = pickContributionFromBucket(languageId, bucket);
        if (!canonical) continue;
        if (!byScopeName.has(canonical.scopeName)) {
            byScopeName.set(canonical.scopeName, canonical);
        }
    }

    return { byLanguage, byScopeName };
}

/**
 * Internal: pick the canonical contribution from a per-language
 * bucket using the same priority logic `pickContribution` exposes.
 * Factored out so both byScopeName construction and lookup-time
 * resolution share one source of truth.
 */
function pickContributionFromBucket(
    languageId: string,
    bucket: readonly ResolvedContribution[],
): ResolvedContribution | null {
    if (bucket.length === 0) return null;
    if (languageId === 'r') {
        for (const preferred of R_GRAMMAR_PRIORITY) {
            const hit = bucket.find((b) => b.extensionId.toLowerCase() === preferred);
            if (hit) return hit;
        }
    }
    return bucket[0];
}

function readGrammarContributions(
    ext: vscode.Extension<unknown>,
): GrammarContribution[] {
    const pkg = ext.packageJSON as unknown;
    if (!pkg || typeof pkg !== 'object') return [];
    const contributes = (pkg as { contributes?: unknown }).contributes;
    if (!contributes || typeof contributes !== 'object') return [];
    const grammars = (contributes as { grammars?: unknown }).grammars;
    if (!Array.isArray(grammars)) return [];
    const out: GrammarContribution[] = [];
    for (const g of grammars) {
        if (g && typeof g === 'object') out.push(g as GrammarContribution);
    }
    return out;
}

/**
 * R-grammar resolution priority. The full R extension subsumes the
 * grammar-only one, but if both are installed we prefer the standalone
 * `r-syntax` because it ships closer to upstream.
 */
const R_GRAMMAR_PRIORITY: readonly string[] = [
    'reditorsupport.r-syntax',
    'reditorsupport.r',
    'vscode.r',
];

function pickContribution(
    contributions: ReturnType<typeof collectGrammarContributions>,
    languageId: string,
): ResolvedContribution | null {
    const bucket = contributions.byLanguage.get(languageId);
    if (!bucket) return null;
    return pickContributionFromBucket(languageId, bucket);
}
