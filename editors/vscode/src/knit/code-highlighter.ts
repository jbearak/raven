/**
 * Pure HTML-emitting code highlighter for the Knit Output render
 * pipeline.
 *
 * Given:
 *   - a code-block's raw source text,
 *   - the source language ID (e.g. "r", "python"),
 *   - a `GrammarRegistry` (lazy-loads vscode-textmate grammars),
 *   - the active `GithubPalette` (light / dark),
 *   - an optional set of "function" semantic-token ranges (only used
 *     for R, populated from Raven's LSP `function` semantic token —
 *     this is the path the LSP-side custom request feeds),
 *
 * produces a string of `<span style="color: ...">...</span>` tokens
 * suitable for placing inside `<pre><code>`. The output is pure HTML
 * with no embedded scripts — runnable inside the iframe-sandbox knit
 * output uses.
 *
 * Why scope-to-role conversion runs in `github-colors.ts` rather than
 * here: the same scope→role mapping is also useful for the README
 * snippet examples (and for any future surface that needs the same
 * palette + scope policy). Keeping the policy in one place means tests
 * can exercise it without paying the vscode-textmate WASM init cost.
 */

import type { GrammarRegistry, ScopeToken } from './grammar-registry';
import {
    colorFor,
    githubDark,
    githubLight,
    scopeToRole,
    type GithubPalette,
    type TokenRole,
} from './github-colors';

/**
 * One overlay range. `start` is a zero-based character offset into the
 * code-block source, `end` is exclusive. `role` is what the overlay
 * promotes those characters to.
 *
 * In practice the only overlay we ship is the R `function` semantic
 * token, but the shape is generic so we can layer more in the future
 * without revisiting this module.
 */
export interface SemanticOverlay {
    start: number;
    end: number;
    role: TokenRole;
}

/**
 * Convert the raw `data: number[]` from an LSP `SemanticTokens`
 * response into a list of `SemanticOverlay` ranges keyed by
 * 0-based character offset into the supplied source text.
 *
 * `SemanticTokens` is encoded as a 5-tuple per token:
 *
 *   [deltaLine, deltaStart, length, tokenType, tokenModifiers]
 *
 * lines and start columns are deltas; tokenType is an index into the
 * legend (Raven advertises only `function` at index 0). We resolve
 * deltas back to absolute (line, col) and then to a character offset
 * inside `source`.
 *
 * Lines split on `\n`. CRLF input should be pre-normalised by the
 * caller; the Knit pipeline reads UTF-8 with LF terminators.
 *
 * Callers that want the function-only overlay can pass `tokenTypeIndex
 * = 0` (the Raven legend); the helper drops tokens whose type doesn't
 * match. The default is also 0 since we only use this for Raven today.
 */
export function semanticOverlaysFromLspData(
    data: ArrayLike<number>,
    source: string,
    options?: { tokenTypeIndex?: number; role?: TokenRole },
): SemanticOverlay[] {
    const want = options?.tokenTypeIndex ?? 0;
    const role: TokenRole = options?.role ?? 'function';

    const lineStarts: number[] = [0];
    for (let i = 0; i < source.length; i++) {
        if (source.charCodeAt(i) === 0x0a /* \n */) {
            lineStarts.push(i + 1);
        }
    }

    const overlays: SemanticOverlay[] = [];
    let line = 0;
    let col = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaStart = data[i + 1];
        const length = data[i + 2];
        const tokenType = data[i + 3];
        // Token modifiers (data[i + 4]) are unused by Raven today.

        if (deltaLine > 0) {
            line += deltaLine;
            col = deltaStart;
        } else {
            col += deltaStart;
        }

        if (tokenType !== want) continue;
        if (line >= lineStarts.length) continue;
        const start = lineStarts[line] + col;
        if (start < 0 || start >= source.length) continue;
        const end = Math.min(start + length, source.length);
        if (end <= start) continue;
        overlays.push({ start, end, role });
    }
    return overlays;
}

/**
 * Resolve the active palette. `vscode-light` and high-contrast-light
 * map to `githubLight`; everything else (default dark, vscode-dark,
 * hc-black) maps to `githubDark`. The Knit Output webview shell sets a
 * `body.vscode-light` / `body.vscode-dark` / `body.vscode-high-contrast-light`
 * class which the caller passes in via `themeClasses`.
 *
 * For the standalone HTML file that `Open in Browser` opens, the
 * caller passes `null` here and emits both palettes wrapped in
 * `@media (prefers-color-scheme: ...)` rules. See `render-html.ts`.
 */
export function paletteForThemeClasses(themeClasses: string | null): GithubPalette {
    if (themeClasses === null) return githubLight; // browser default — light
    if (/\bvscode-(light|high-contrast-light)\b/.test(themeClasses)) return githubLight;
    return githubDark;
}

/**
 * Highlight a single code block.
 *
 * `languageId` is the lower-cased language tag (from
 * `<code class="language-XXX">`). When the grammar registry can't
 * produce a grammar for it (e.g. an obscure language not contributed
 * by any installed extension), the source is HTML-escaped and emitted
 * with no per-token coloring — the palette's `foreground` covers the
 * default text color via the surrounding `<pre>` style.
 *
 * The output is a plain HTML string — no extra `<pre>` or `<code>`
 * wrappers, no whitespace munging — meant to be placed inside the
 * caller's `<code>` element.
 */
export async function highlightCodeBlock(args: {
    source: string;
    languageId: string;
    palette: GithubPalette;
    registry: GrammarRegistry;
    overlays?: readonly SemanticOverlay[];
}): Promise<string> {
    const { source, languageId, palette, registry, overlays = [] } = args;

    // Empty input → empty output. vscode-textmate handles empty
    // strings but the early return saves a grammar fetch.
    if (source.length === 0) return '';

    const grammar = await registry.primeForLanguage(languageId);
    if (!grammar) {
        // Unknown language. Emit the source as plain escaped HTML so
        // it still reads correctly inside the rendered block — just
        // without per-token colour.
        return escapeHtml(source);
    }

    // Pre-compute line starts so per-line scope tokens can be mapped
    // back to absolute character offsets (overlays use absolute
    // offsets into the source).
    const lineStarts: number[] = [0];
    for (let i = 0; i < source.length; i++) {
        if (source.charCodeAt(i) === 0x0a /* \n */) {
            lineStarts.push(i + 1);
        }
    }
    const lines = source.split('\n');

    const out: string[] = [];
    let ruleStack: unknown = null;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const result = await registry.tokenizeLineForLanguage(languageId, line, ruleStack);
        if (!result) {
            // No grammar (or transient failure) — fall back to
            // bare-escape for this line so output is still
            // structurally correct.
            out.push(escapeHtml(line));
            if (lineIdx + 1 < lines.length) out.push('\n');
            continue;
        }
        ruleStack = result.ruleStack;
        out.push(
            paintLine({
                line,
                lineStart: lineStarts[lineIdx],
                tokens: result.tokens,
                overlays,
                palette,
            }),
        );
        if (lineIdx + 1 < lines.length) out.push('\n');
    }
    return out.join('');
}

/**
 * Paint one line. Walks both the grammar's scope tokens and the
 * semantic overlays together to produce a sequence of
 * `<span style="color: ...">` runs.
 *
 * Algorithm: collect the union of all "boundaries" (start/end points
 * of either a grammar token or an overlay), then walk the line in
 * boundary-defined runs. Each run gets the role it inherits, where
 * overlays beat grammar scopes — Raven's `function` semantic token
 * promotes an identifier to the function role even when the grammar
 * didn't mark it as one.
 */
function paintLine(args: {
    line: string;
    lineStart: number;
    tokens: readonly ScopeToken[];
    overlays: readonly SemanticOverlay[];
    palette: GithubPalette;
}): string {
    const { line, lineStart, tokens, overlays, palette } = args;
    if (line.length === 0) return '';

    // Project overlays that intersect this line into (line-relative)
    // ranges, retaining the role.
    const lineEnd = lineStart + line.length;
    const lineOverlays: SemanticOverlay[] = [];
    for (const o of overlays) {
        const start = Math.max(o.start, lineStart) - lineStart;
        const end = Math.min(o.end, lineEnd) - lineStart;
        if (end > start && start < line.length) {
            lineOverlays.push({ start, end, role: o.role });
        }
    }

    // Collect a sorted set of boundary points: every token boundary +
    // every overlay boundary, clipped to [0, line.length].
    const boundaries = new Set<number>();
    boundaries.add(0);
    boundaries.add(line.length);
    for (const t of tokens) {
        if (t.startIndex >= 0 && t.startIndex <= line.length) boundaries.add(t.startIndex);
        if (t.endIndex >= 0 && t.endIndex <= line.length) boundaries.add(t.endIndex);
    }
    for (const o of lineOverlays) {
        boundaries.add(o.start);
        boundaries.add(o.end);
    }
    const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);

    const out: string[] = [];
    for (let i = 0; i + 1 < sortedBoundaries.length; i++) {
        const start = sortedBoundaries[i];
        const end = sortedBoundaries[i + 1];
        if (end <= start) continue;
        // Determine the active role for the [start, end) run. Overlay
        // wins if any overlay covers the run; otherwise the deepest
        // grammar scope at `start` decides.
        const overlay = lineOverlays.find((o) => o.start <= start && o.end >= end);
        let role: TokenRole | null = null;
        if (overlay) {
            role = overlay.role;
        } else {
            const tok = tokens.find((t) => t.startIndex <= start && t.endIndex >= end);
            if (tok) role = scopeToRole(tok.scopes);
        }
        const slice = line.slice(start, end);
        if (role === null) {
            out.push(escapeHtml(slice));
        } else {
            out.push(`<span style="color:${colorFor(palette, role)}">${escapeHtml(slice)}</span>`);
        }
    }
    return out.join('');
}

/**
 * HTML-escape source text. Avoids reusing `knit-output.ts`'s
 * escapeHtml so this module stays import-free of the panel code (the
 * dependency direction is one-way: panel imports highlighter, not the
 * other way around).
 */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Re-export the palettes so the rendering pipeline can build the CSS.
export { githubLight, githubDark, scopeToRole };
export type { GithubPalette };
