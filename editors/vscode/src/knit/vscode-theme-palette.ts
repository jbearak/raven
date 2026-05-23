/**
 * Resolves the active VS Code color theme into a `GithubPalette`-shaped
 * record so the Knit Output webview can paint syntax tokens with the
 * editor's actual colors instead of the bundled GitHub palette.
 *
 * Why this lives in a dedicated module:
 *
 *   - VS Code's public extension API does NOT expose the active
 *     theme's TextMate `tokenColors`. The only exposed signal is
 *     `ColorThemeKind` (Light / Dark / HC / HC-Light) plus the named
 *     CSS variables a webview can read from the shell document. To
 *     resolve real per-scope colors we have to find the contributing
 *     extension's theme JSON on disk, parse it (including `include`
 *     chains), and layer the user's `editor.tokenColorCustomizations`
 *     on top. None of that is shared with the grammar loader.
 *
 *   - Scope-selector matching is genuinely complex (parent selectors,
 *     specificity, comma-separated alternatives, rule ordering). We
 *     delegate to vscode-textmate's own matcher via
 *     `GrammarRegistry.extractWithTheme` — set the merged theme on the
 *     registry, tokenize a canonical R snippet per role, read the
 *     foreground color index out of the binary-tokenize result, look
 *     up the hex in the registry's color map. That way we never
 *     re-implement scope matching here.
 *
 *   - The extractor is purely async + dependency-injected (no `vscode`
 *     module import). The live wiring lives in `knit-output-panel.ts`,
 *     which feeds in `extensions`, the workbench theme id, user
 *     customizations, and a reader function. Unit tests fake all
 *     three.
 *
 * Failure modes are explicit (`{ok: false, reason, detail}`) so callers
 * can decide whether to fall back, log, or surface to the user. The
 * panel wiring always falls back silently to the GitHub palette and
 * logs one line to the Knit output channel.
 */

import * as path from 'path';
import {
    githubLight,
    githubDark,
    type GithubPalette,
    type TokenRole,
} from './github-colors';
import type { GrammarRegistry, ThemeSetting } from './grammar-registry';

/**
 * Minimal `vscode.Extension` surface the extractor consumes. Defined
 * inline so the module has no `vscode` import — callers pass
 * `{id, extensionPath, packageJSON}` shaped objects.
 */
export interface ExtensionLike {
    id: string;
    extensionPath: string;
    packageJSON: unknown;
}

export type ThemeFailureReason =
    | 'no-theme-id'
    | 'theme-not-found'
    | 'read-error'
    | 'parse-error'
    | 'unsupported-format'
    | 'cycle-detected'
    | 'grammar-unavailable';

export interface ThemePaletteSuccess {
    ok: true;
    palette: GithubPalette;
    /** The matched theme id (or label fallback). */
    themeId: string;
    /** Whether the theme is light. From the caller's ColorThemeKind. */
    isLight: boolean;
}

export interface ThemePaletteFailure {
    ok: false;
    reason: ThemeFailureReason;
    detail: string;
}

export type ThemePaletteOutcome = ThemePaletteSuccess | ThemePaletteFailure;

export interface ThemePaletteArgs {
    /** Value of `workbench.colorTheme` from VS Code settings. */
    workbenchColorThemeId: string;

    /**
     * Whether the active theme is light. Comes from
     * `vscode.window.activeColorTheme.kind` — the API exposes this
     * directly, so we never guess from the theme JSON's `"type"` field
     * or the editor background's luminance.
     */
    isLight: boolean;

    /** All installed extensions, for the `contributes.themes` walk. */
    extensions: readonly ExtensionLike[];

    /**
     * Raw value of `editor.tokenColorCustomizations`. Accepts the
     * fallback shape (`{textMateRules: […]}`) and the per-theme shape
     * (`{"[Default Dark+]": {textMateRules: […]}}`). Both are layered
     * after the resolved theme's `tokenColors`.
     */
    tokenColorCustomizations: unknown;

    /**
     * Raw value of `editor.semanticTokenColorCustomizations`. Used for
     * the simple form only (a top-level `rules` map of
     * `type[.modifier]` → color or `{foreground}`). The general
     * type+modifier selector grammar is not implemented; complex
     * selectors are ignored.
     */
    semanticTokenColorCustomizations: unknown;

    /**
     * Grammar registry to drive scope-selector matching. The registry
     * must be capable of tokenizing the R language; otherwise we
     * return `grammar-unavailable`.
     */
    registry: Pick<GrammarRegistry, 'extractWithTheme' | 'primeForLanguage'>;

    /** File reader for theme JSONs. Absolute paths only. */
    readFile: (absolutePath: string) => Promise<string>;

    /**
     * realpath resolver. Used for theme-include cycle detection and
     * for stable canonicalization across symlinked extension installs.
     * Defaults to `(p) => Promise.resolve(p)` for tests; production
     * passes `fs.promises.realpath`.
     */
    realPath?: (absolutePath: string) => Promise<string>;
}

/**
 * Canonical R snippets used to probe the theme for each TokenRole.
 *
 * The probe relies on the active R grammar producing a specific scope
 * chain for one specific character offset in each snippet. The
 * snippets were chosen by inspecting vscode.r's `r.tmLanguage.json`
 * (which mirrors REditorSupport.r-syntax) so each probe lands on a
 * token that grammar tags with a well-known TextMate scope:
 *
 *   - keyword:     `if (TRUE) {}`     offset 0 → `keyword.control.conditional.if.r`
 *   - string:      `"x"`              offset 1 → `string.quoted.double.r` (body inside the quotes)
 *   - number:      `42`               offset 0 → `constant.numeric.float.decimal.r`
 *   - comment:     `# x`              offset 0 → `comment.line.number-sign.r`
 *   - function:    `library(x)`       offset 0 → `support.function.r`
 *                  vscode.r only tags builtin function names with a
 *                  function scope; plain `foo(x)` would leave `foo`
 *                  unscoped, fall through to the theme default, and
 *                  produce invisible text. `library` is a hardcoded
 *                  builtin in every R grammar shipped since
 *                  REditorSupport.r-syntax existed.
 *   - type:        `list(1)`          offset 0 → `storage.type.r`
 *                  vscode.r's `storage-type` rule tags the names of
 *                  base data-shape constructors (`list`, `character`,
 *                  `integer`, etc.) with `storage.type.r`.
 *   - variable:    `x`                offset 0
 *                  R grammars typically do NOT tag bare identifiers
 *                  with a `variable.*` scope. We probe anyway so a
 *                  theme that DOES (e.g. semantic-token overrides) can
 *                  win; otherwise the probe falls through to the
 *                  default and the resolver fills in the GitHub
 *                  fallback.
 *   - operator:    `1 + 2`            offset 2 → `keyword.operator.arithmetic.r`
 *   - punctuation: `f()`              offset 2 → `punctuation.definition.arguments.end.r`
 *   - constant:    `TRUE`             offset 0 → `constant.language.r`
 */
interface ProbeSample {
    snippet: string;
    probeOffset: number;
}

const PROBE_SAMPLES: Record<TokenRole, ProbeSample> = {
    keyword: { snippet: 'if (TRUE) {}', probeOffset: 0 },
    string: { snippet: '"x"', probeOffset: 1 },
    number: { snippet: '42', probeOffset: 0 },
    comment: { snippet: '# x', probeOffset: 0 },
    function: { snippet: 'library(x)', probeOffset: 0 },
    type: { snippet: 'list(1)', probeOffset: 0 },
    variable: { snippet: 'x', probeOffset: 0 },
    operator: { snippet: '1 + 2', probeOffset: 2 },
    punctuation: { snippet: 'f()', probeOffset: 2 },
    constant: { snippet: 'TRUE', probeOffset: 0 },
};

/**
 * Bit layout encoded into `Uint32Array` metadata by vscode-textmate's
 * `tokenizeLine2`. The foreground color index occupies bits 15..23.
 * The constant matches vscode-textmate's MetadataConsts; if upstream
 * ever shifts the layout the test suite would catch it because the
 * canonical-scope probes return obviously-wrong colors.
 */
const FOREGROUND_OFFSET = 15;
const FOREGROUND_MASK = 0x00FF8000;

/** Match any of `#rrggbb`, `#rgb`, `#rrggbbaa`, or `#rgba`. */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6,8})$/i;

/**
 * Semantic-token type name → `TokenRole` mapping for the simple
 * `semanticTokenColors` form. Bare type names only — selectors with
 * modifiers (`function.declaration`) are dropped on the floor by the
 * caller, which doesn't implement the full VS Code semantic-token
 * selector grammar. The map covers the standard semantic-token types
 * VS Code's API documents plus a few commonly-used aliases.
 */
const SEMANTIC_TYPE_TO_ROLE: Readonly<Record<string, TokenRole>> = {
    keyword: 'keyword',
    string: 'string',
    number: 'number',
    comment: 'comment',
    function: 'function',
    method: 'function',
    type: 'type',
    class: 'type',
    interface: 'type',
    struct: 'type',
    variable: 'variable',
    parameter: 'variable',
    property: 'variable',
    operator: 'operator',
    namespace: 'type',
    macro: 'function',
    enum: 'type',
    enumMember: 'constant',
    decorator: 'function',
};

/**
 * Resolve the active VS Code theme into a Knit-Output-ready palette.
 *
 * Top-level flow:
 *
 *   1. Locate the contributing theme JSON via `contributes.themes`.
 *   2. Read + parse, resolving `include` chains relative to each
 *      including file (cycle detection via canonicalized absolute
 *      paths).
 *   3. Layer the user's `editor.tokenColorCustomizations` after the
 *      resolved theme's `tokenColors` — both the global fallback
 *      block and any `"[<active-theme-label>]"` block.
 *   4. Layer semantic-color customizations after that.
 *   5. Apply the merged settings via `registry.extractWithTheme`,
 *      tokenize one probe snippet per `TokenRole`, decode the
 *      foreground color index from the binary token at the probe
 *      offset, look up the hex in `colorMap`. Roles whose probe
 *      yields the default foreground (index 0) fall back to another
 *      role's resolved color if a `fallbackRole` is configured, then
 *      ultimately to the GitHub palette underneath.
 *   6. Layer `semanticTokenColors.function` (and any other
 *      type-name → color entries that map to one of our roles) on
 *      top. This makes themes that customize semantic colors look
 *      consistent with VS Code's editor.
 *   7. Validate every resolved color via `HEX_COLOR_RE` and reject
 *      invalid entries (they fall back to the GitHub palette).
 */
export async function resolveActiveThemePalette(
    args: ThemePaletteArgs,
): Promise<ThemePaletteOutcome> {
    if (!args.workbenchColorThemeId) {
        return { ok: false, reason: 'no-theme-id', detail: 'workbench.colorTheme is empty' };
    }

    const located = locateThemeFile(args.workbenchColorThemeId, args.extensions);
    if (!located) {
        return {
            ok: false,
            reason: 'theme-not-found',
            detail: `no contributed theme matches "${args.workbenchColorThemeId}"`,
        };
    }

    let mergedDoc: ParsedThemeDocument;
    try {
        mergedDoc = await loadAndMergeThemeChain({
            entryPath: located.absolutePath,
            readFile: args.readFile,
            realPath: args.realPath ?? ((p) => Promise.resolve(p)),
        });
    } catch (err) {
        const reason: ThemeFailureReason =
            err instanceof UnsupportedFormatError ? 'unsupported-format'
            : err instanceof ThemeCycleError ? 'cycle-detected'
            : err instanceof ParseError ? 'parse-error'
            : 'read-error';
        return {
            ok: false,
            reason,
            detail: err instanceof Error ? err.message : String(err),
        };
    }

    const tokenColors = mergeCustomizations({
        baseTokenColors: mergedDoc.tokenColors,
        tokenColorCustomizations: args.tokenColorCustomizations,
        activeThemeLabel: located.label,
    });

    // Probe via vscode-textmate using the merged TextMate settings.
    const rGrammarReady = await args.registry.primeForLanguage('r');
    if (!rGrammarReady) {
        return {
            ok: false,
            reason: 'grammar-unavailable',
            detail: 'no R grammar contribution available',
        };
    }

    let resolvedRoleColors: Partial<Record<TokenRole, string>>;
    try {
        resolvedRoleColors = await probeRoleColors({
            registry: args.registry,
            tokenColors,
        });
    } catch (err) {
        return {
            ok: false,
            reason: 'grammar-unavailable',
            detail: err instanceof Error ? err.message : String(err),
        };
    }

    // Semantic-color customizations override the TextMate probe for
    // roles whose type name matches.
    const semanticOverrides = readSemanticOverrides({
        baseSemanticTokenColors: mergedDoc.semanticTokenColors,
        semanticTokenColorCustomizations: args.semanticTokenColorCustomizations,
        activeThemeLabel: located.label,
    });
    for (const [role, color] of Object.entries(semanticOverrides) as Array<[TokenRole, string]>) {
        if (color) resolvedRoleColors[role] = color;
    }

    // Validate every role color; drop invalid ones.
    for (const role of Object.keys(resolvedRoleColors) as TokenRole[]) {
        const color = resolvedRoleColors[role];
        if (!color || !HEX_COLOR_RE.test(color)) delete resolvedRoleColors[role];
    }

    // Background / foreground come from the merged theme's editor
    // colors. Sanitize via the same hex regex.
    const bg = pickValidColor(mergedDoc.editorColors['editor.background']);
    const fg = pickValidColor(mergedDoc.editorColors['editor.foreground']);

    const fallback = args.isLight ? githubLight : githubDark;
    const palette: GithubPalette = {
        background: bg ?? fallback.background,
        foreground: fg ?? fallback.foreground,
        roles: {
            keyword: resolvedRoleColors.keyword ?? fallback.roles.keyword,
            string: resolvedRoleColors.string ?? fallback.roles.string,
            number: resolvedRoleColors.number ?? fallback.roles.number,
            comment: resolvedRoleColors.comment ?? fallback.roles.comment,
            function: resolvedRoleColors.function ?? fallback.roles.function,
            type: resolvedRoleColors.type ?? fallback.roles.type,
            variable: resolvedRoleColors.variable ?? fallback.roles.variable,
            operator: resolvedRoleColors.operator ?? fallback.roles.operator,
            punctuation: resolvedRoleColors.punctuation ?? fallback.roles.punctuation,
            constant: resolvedRoleColors.constant ?? fallback.roles.constant,
        },
    };

    return { ok: true, palette, themeId: located.id, isLight: args.isLight };
}

// ---------------------------------------------------------------------
// Theme-file lookup
// ---------------------------------------------------------------------

interface LocatedTheme {
    id: string;
    label: string;
    absolutePath: string;
}

interface ThemeContribution {
    id?: string;
    label?: string;
    uiTheme?: string;
    path?: string;
}

/**
 * Walk `extensions` for a `contributes.themes` entry whose `id` (or,
 * failing that, `label`) matches `wantedId`. The setting
 * `workbench.colorTheme` typically holds the label (e.g.
 * "Default Dark Modern"), but some users persist the `id` after a
 * VS Code-internal upgrade — so we accept either as the lookup key.
 */
function locateThemeFile(
    wantedId: string,
    extensions: readonly ExtensionLike[],
): LocatedTheme | null {
    for (const ext of extensions) {
        const themes = readThemeContributions(ext.packageJSON);
        for (const t of themes) {
            const id = typeof t.id === 'string' ? t.id : '';
            const label = typeof t.label === 'string' ? t.label : '';
            if (id !== wantedId && label !== wantedId) continue;
            if (typeof t.path !== 'string' || t.path.length === 0) continue;
            const absolutePath = path.isAbsolute(t.path)
                ? t.path
                : path.join(ext.extensionPath, t.path);
            return { id: id || label || wantedId, label: label || id, absolutePath };
        }
    }
    return null;
}

function readThemeContributions(pkg: unknown): ThemeContribution[] {
    if (!pkg || typeof pkg !== 'object') return [];
    const contributes = (pkg as { contributes?: unknown }).contributes;
    if (!contributes || typeof contributes !== 'object') return [];
    const themes = (contributes as { themes?: unknown }).themes;
    if (!Array.isArray(themes)) return [];
    const out: ThemeContribution[] = [];
    for (const t of themes) {
        if (t && typeof t === 'object') out.push(t as ThemeContribution);
    }
    return out;
}

// ---------------------------------------------------------------------
// Theme-JSON parsing + include chain
// ---------------------------------------------------------------------

interface ParsedThemeDocument {
    tokenColors: ThemeSetting[];
    semanticTokenColors: Record<string, unknown>;
    editorColors: Record<string, string>;
}

class ParseError extends Error {}
class UnsupportedFormatError extends Error {}
class ThemeCycleError extends Error {}

/**
 * Load a theme JSON document, recursively resolving `include` chains.
 *
 *   - `tokenColors` arrays from this file are appended AFTER the
 *     included file's, so the current file's rules take precedence
 *     at scope-selector match time (later rules win in TextMate).
 *   - `semanticTokenColors` and `colors` maps are merged with the
 *     current file's keys overriding the included file's.
 *   - `include` paths are resolved relative to the INCLUDING file's
 *     directory, not the original extension root. Built-in themes
 *     like `dark_plus.json` chain through several files this way.
 *   - Cycle detection canonicalizes paths via `realPath`. Symlinked
 *     installs (Homebrew on macOS, some Linux distros) place
 *     extensions behind symlinks that would otherwise let two
 *     `include`s reach the same file via different paths and never
 *     trigger the visited check.
 */
async function loadAndMergeThemeChain(args: {
    entryPath: string;
    readFile: (absolutePath: string) => Promise<string>;
    realPath: (absolutePath: string) => Promise<string>;
}): Promise<ParsedThemeDocument> {
    // True cycle detection requires "currently on the include stack"
    // (a back-edge in DFS terms), not "ever seen". A theme can legally
    // be a DAG with diamonds — VS Code's built-in `dark_plus.json`
    // chain pulls in multiple sub-files that share common ancestors.
    // Treating a diamond as a cycle would throw spuriously and force
    // the GitHub-palette fallback.
    const onStack = new Set<string>();
    const alreadyMerged = new Set<string>();
    // Acc starts with the most-derived (innermost) file's lists, but
    // tokenColors are then prepended by the includes so the final
    // order is "outermost (oldest) → innermost (most-derived)". That
    // matches TextMate semantics: later rules win during selector
    // matching.
    const tokenColors: ThemeSetting[] = [];
    const semanticTokenColors: Record<string, unknown> = {};
    const editorColors: Record<string, string> = {};

    async function load(thisPath: string): Promise<void> {
        const canonical = await args.realPath(thisPath).catch(() => thisPath);
        if (onStack.has(canonical)) {
            throw new ThemeCycleError(`include cycle detected at ${canonical}`);
        }
        if (alreadyMerged.has(canonical)) {
            // Diamond include — same file reached via two distinct
            // paths but not via a back-edge. Skip the re-merge so
            // we don't duplicate its rules, but do NOT throw.
            return;
        }
        onStack.add(canonical);

        let raw: string;
        try {
            raw = await args.readFile(thisPath);
        } catch (err) {
            throw new Error(`failed to read ${thisPath}: ${err instanceof Error ? err.message : String(err)}`);
        }

        const trimmed = raw.trimStart();
        if (trimmed.startsWith('<?xml') || trimmed.startsWith('<plist')) {
            throw new UnsupportedFormatError(`tmTheme (XML/plist) format not supported: ${thisPath}`);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(stripJsonWithComments(raw));
        } catch (err) {
            throw new ParseError(
                `${thisPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new ParseError(`${thisPath}: top-level is not an object`);
        }

        const obj = parsed as Record<string, unknown>;

        // Resolve includes FIRST so the current file's rules can
        // override them.
        if (typeof obj.include === 'string' && obj.include.length > 0) {
            const includedAbs = path.resolve(path.dirname(thisPath), obj.include);
            await load(includedAbs);
        }

        // tokenColors: append (later rules win in TextMate selector
        // matching, which is the order we want — included file's
        // rules first, this file's last).
        const tc = obj.tokenColors;
        if (Array.isArray(tc)) {
            for (const entry of tc) {
                const normalized = normalizeThemeSetting(entry);
                if (normalized) tokenColors.push(normalized);
            }
        }

        // semanticTokenColors: current file overrides included.
        const stc = obj.semanticTokenColors;
        if (stc && typeof stc === 'object' && !Array.isArray(stc)) {
            for (const [k, v] of Object.entries(stc as Record<string, unknown>)) {
                semanticTokenColors[k] = v;
            }
        }

        // colors: current file overrides included.
        const colors = obj.colors;
        if (colors && typeof colors === 'object' && !Array.isArray(colors)) {
            for (const [k, v] of Object.entries(colors as Record<string, unknown>)) {
                if (typeof v === 'string') editorColors[k] = v;
            }
        }

        // Pop from the in-progress stack now that we're done merging
        // this node; promote to `alreadyMerged` so a sibling include
        // path that reaches the same file later sees the deduplication
        // skip (and doesn't replay the rules).
        onStack.delete(canonical);
        alreadyMerged.add(canonical);
    }

    await load(args.entryPath);

    return { tokenColors, semanticTokenColors, editorColors };
}

function normalizeThemeSetting(entry: unknown): ThemeSetting | null {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const settings = e.settings;
    if (!settings || typeof settings !== 'object') return null;
    return {
        name: typeof e.name === 'string' ? e.name : undefined,
        scope: typeof e.scope === 'string' || Array.isArray(e.scope)
            ? (e.scope as string | string[])
            : undefined,
        settings: settings as ThemeSetting['settings'],
    };
}

/**
 * Strip line/block comments from JSON-with-comments. VS Code's
 * built-in themes (and many community themes) ship `.jsonc` files
 * with `//` and `/* *\/` blocks that JSON.parse rejects.
 *
 * The strip is minimal — it does not handle trailing commas. If a
 * theme uses them and our parse fails, we surface a `parse-error`
 * outcome and the caller falls back to the GitHub palette. We avoid
 * pulling in a full JSONC dependency for that case; the overwhelming
 * majority of themes round-trip cleanly through this stripper.
 */
function stripJsonWithComments(raw: string): string {
    const out: string[] = [];
    let i = 0;
    const n = raw.length;
    while (i < n) {
        const ch = raw[i];
        // String literal — copy verbatim including escaped quotes.
        if (ch === '"') {
            const start = i;
            i++;
            while (i < n) {
                if (raw[i] === '\\' && i + 1 < n) {
                    i += 2;
                    continue;
                }
                if (raw[i] === '"') { i++; break; }
                i++;
            }
            out.push(raw.slice(start, i));
            continue;
        }
        if (ch === '/' && i + 1 < n) {
            const next = raw[i + 1];
            if (next === '/') {
                // Skip to end of line.
                i += 2;
                while (i < n && raw[i] !== '\n') i++;
                continue;
            }
            if (next === '*') {
                i += 2;
                while (i + 1 < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
                i = Math.min(n, i + 2);
                continue;
            }
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}

// ---------------------------------------------------------------------
// User customizations
// ---------------------------------------------------------------------

/**
 * Layer `editor.tokenColorCustomizations` onto `baseTokenColors`.
 *
 * Precedence (lowest-to-highest, which is FIRST → LAST in TextMate's
 * "later rule wins" order):
 *
 *   1. Theme's `tokenColors` from JSON (baseTokenColors).
 *   2. Top-level `textMateRules` block (applies to all themes).
 *   3. `[<active-theme-label>].textMateRules` (per-theme overrides).
 *
 * VS Code's settings system has additional layering (user / workspace
 * / folder), but `getConfiguration('editor').get('tokenColorCustomizations')`
 * returns the merged effective value, so we don't have to re-implement
 * the scope precedence.
 */
function mergeCustomizations(args: {
    baseTokenColors: ThemeSetting[];
    tokenColorCustomizations: unknown;
    activeThemeLabel: string;
}): ThemeSetting[] {
    const merged = [...args.baseTokenColors];
    const cust = args.tokenColorCustomizations;
    if (!cust || typeof cust !== 'object') return merged;
    const obj = cust as Record<string, unknown>;

    function appendRulesFrom(node: unknown): void {
        if (!node || typeof node !== 'object') return;
        const rules = (node as { textMateRules?: unknown }).textMateRules;
        if (!Array.isArray(rules)) return;
        for (const r of rules) {
            const n = normalizeThemeSetting(r);
            if (n) merged.push(n);
        }
    }

    // 1. Global fallback block (the customizations object itself).
    appendRulesFrom(obj);

    // 2. Per-theme block keyed by `[<label>]`. The label comes from the
    //    contributed theme's `label` field; comparison is exact.
    const perTheme = obj[`[${args.activeThemeLabel}]`];
    appendRulesFrom(perTheme);

    return merged;
}

/**
 * Read the simple form of `semanticTokenColors` plus user customizations
 * into a `TokenRole → color` map. Only entries whose key is a bare
 * semantic-token type that maps to one of our roles are honored;
 * `type.modifier` selectors and modifier-style rules are ignored.
 *
 * VS Code's full semantic-token rule grammar is significantly more
 * complex (type+modifiers, language scoping, multiple selector
 * syntaxes). Implementing it properly would duplicate VS Code-internal
 * code and add a lot of surface for a Knit Output viewer whose color
 * mapping is already 10-role coarse. The simple form covers the
 * majority of themes that explicitly opt-in for things like
 * `"function": "#abc"`.
 */
function readSemanticOverrides(args: {
    baseSemanticTokenColors: Record<string, unknown>;
    semanticTokenColorCustomizations: unknown;
    activeThemeLabel: string;
}): Partial<Record<TokenRole, string>> {
    const out: Partial<Record<TokenRole, string>> = {};

    // Base theme's semanticTokenColors first.
    overlay(out, args.baseSemanticTokenColors);

    const cust = args.semanticTokenColorCustomizations;
    if (cust && typeof cust === 'object') {
        const c = cust as Record<string, unknown>;
        // VS Code's setting wraps the rules under a `rules` key in the
        // customizations object, but also accepts the top-level keys
        // for backwards compatibility. Try both.
        const baseRules = (c.rules && typeof c.rules === 'object') ? c.rules as Record<string, unknown> : c;
        overlay(out, baseRules);

        const perTheme = c[`[${args.activeThemeLabel}]`];
        if (perTheme && typeof perTheme === 'object') {
            const perThemeObj = perTheme as Record<string, unknown>;
            const perThemeRules = (perThemeObj.rules && typeof perThemeObj.rules === 'object')
                ? perThemeObj.rules as Record<string, unknown>
                : perThemeObj;
            overlay(out, perThemeRules);
        }
    }

    return out;

    function overlay(target: Partial<Record<TokenRole, string>>, source: Record<string, unknown>): void {
        for (const [key, value] of Object.entries(source)) {
            // Skip keys with dots (modifier selectors), `*` patterns,
            // language qualifiers, etc. — anything not a bare type.
            if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) continue;
            const role = SEMANTIC_TYPE_TO_ROLE[key];
            if (!role) continue;
            const color = extractSemanticColor(value);
            if (color) target[role] = color;
        }
    }

    function extractSemanticColor(value: unknown): string | null {
        if (typeof value === 'string') {
            const lower = value.toLowerCase();
            return HEX_COLOR_RE.test(lower) ? lower : null;
        }
        if (value && typeof value === 'object') {
            const fg = (value as { foreground?: unknown }).foreground;
            if (typeof fg === 'string') {
                const lower = fg.toLowerCase();
                if (HEX_COLOR_RE.test(lower)) return lower;
            }
        }
        return null;
    }
}

// ---------------------------------------------------------------------
// vscode-textmate probing
// ---------------------------------------------------------------------

async function probeRoleColors(args: {
    registry: Pick<GrammarRegistry, 'extractWithTheme'>;
    tokenColors: readonly ThemeSetting[];
}): Promise<Partial<Record<TokenRole, string>>> {
    // The "no rule matched" foreground that vscode-textmate will use
    // for any token whose scope chain doesn't match any rule in
    // `args.tokenColors`. Two cases:
    //
    //   1. `tokenColors` has an empty-scope (or scope-undefined) rule.
    //      vscode-textmate treats that as the theme's defaults — its
    //      `foreground` becomes the no-match color. The LAST empty-
    //      scope rule wins, mirroring vscode-textmate's parseTheme.
    //   2. `tokenColors` has NO empty-scope rule. vscode-textmate
    //      hardcodes `#000000` as the foreground default.
    //
    // We compute this BEFORE setTheme so the inner callback can
    // filter probe results that match it — preventing roles whose
    // scope had no specific theme rule from inheriting an invisible
    // (#000000) or undifferentiated (editor.foreground) color and
    // overriding the legible GitHub fallback.
    const noMatchFg = effectiveDefaultForeground(args.tokenColors);

    return args.registry.extractWithTheme(args.tokenColors, async (api) => {
        const out: Partial<Record<TokenRole, string>> = {};
        const roles = Object.keys(PROBE_SAMPLES) as TokenRole[];
        for (const role of roles) {
            const sample = PROBE_SAMPLES[role];
            const result = await api.tokenizeLine2ForLanguage('r', sample.snippet);
            if (!result) continue;
            const color = colorAtOffset(result.tokens, sample.probeOffset, api.colorMap);
            if (color === null) continue;
            const normalized = color.toLowerCase();
            // Skip probes that matched the theme's no-rule default.
            // The role is "not specifically themed for R" — fall
            // through to the GitHub palette so it stays legible.
            if (normalized === noMatchFg) continue;
            out[role] = normalized;
        }
        return out;
    });
}

/**
 * The foreground color vscode-textmate will assign to any token whose
 * scope chain matches none of `tokenColors`. Mirrors vscode-textmate's
 * `resolveParsedThemeRules`: rules with an empty scope (or with `scope`
 * omitted / set to the empty string) act as the theme's defaults, with
 * the LAST such rule winning; if none exist, the engine uses the
 * hardcoded `#000000`.
 */
function effectiveDefaultForeground(tokenColors: readonly ThemeSetting[]): string {
    let defaultFg = '#000000';
    for (const rule of tokenColors) {
        if (!isEmptyScope(rule.scope)) continue;
        const fg = rule.settings.foreground;
        if (typeof fg !== 'string') continue;
        const lower = fg.toLowerCase();
        if (HEX_COLOR_RE.test(lower)) defaultFg = lower;
    }
    return defaultFg;
}

function isEmptyScope(scope: string | string[] | undefined): boolean {
    if (scope === undefined) return true;
    if (typeof scope === 'string') return scope.trim().length === 0;
    if (Array.isArray(scope)) {
        return scope.length === 0 || scope.every((s) => typeof s !== 'string' || s.trim().length === 0);
    }
    return false;
}

/**
 * Locate the binary token covering `offset` and return its theme
 * foreground color, or `null` if the token uses the default
 * foreground (index 0, which means "no theme rule matched — paint
 * with the editor's default foreground").
 *
 * Binary layout per vscode-textmate: tokens is a flat Uint32Array
 * where index `2*i` is the token's startIndex and `2*i + 1` is the
 * encoded metadata.
 */
function colorAtOffset(
    tokens: Uint32Array,
    offset: number,
    colorMap: readonly string[],
): string | null {
    // Walk backwards from the end so a token whose range is
    // `[startIndex, lineLength)` for the last entry can still match
    // offsets at line-end.
    for (let i = tokens.length - 2; i >= 0; i -= 2) {
        const start = tokens[i];
        if (offset >= start) {
            const metadata = tokens[i + 1];
            const fgIdx = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
            // Foreground index 0 is the registry's reserved sentinel
            // ("no color"). In practice vscode-textmate assigns at
            // least one default rule (whether from the theme's
            // empty-scope entry or its hardcoded fallback), so a
            // metadata value of 0 generally won't appear — but if it
            // does, treat as "no color" so the caller's fallback
            // kicks in.
            if (fgIdx === 0) return null;
            const color = colorMap[fgIdx];
            if (typeof color !== 'string') return null;
            const lower = color.toLowerCase();
            return HEX_COLOR_RE.test(lower) ? lower : null;
        }
    }
    return null;
}

// ---------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------

function pickValidColor(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const lower = value.toLowerCase();
    return HEX_COLOR_RE.test(lower) ? lower : null;
}
