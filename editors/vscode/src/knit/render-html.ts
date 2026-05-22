/**
 * Knit Output rendering pipeline.
 *
 * The full flow (called from the post-knit code path in
 * `knit-commands.ts`):
 *
 *   1. R subprocess writes `<basename>.md` next to the source via
 *      `knitr::knit`.
 *   2. This module reads that `.md`.
 *   3. It calls `markdown.api.render` to convert to HTML using VS
 *      Code's full pipeline (KaTeX math, image rewriting, registered
 *      `markdown-it` plugins, etc.).
 *   4. It walks the HTML, finds every `<pre><code class="language-X">`
 *      block, replaces the body with grammar-aware GitHub-themed
 *      spans (via `code-highlighter.ts`). R blocks get Raven's LSP
 *      function-token overlay layered on top.
 *   5. It inlines KaTeX CSS + the GitHub light/dark stylesheets, then
 *      writes `<basename>.html`.
 *
 * The webview panel reads that `.html` and displays it in its iframe.
 * "Open in Browser" opens the same `.html` so the browser path gets
 * identical styling (theme picked via `prefers-color-scheme`).
 *
 * Everything in this module is pure-ish: side effects (reading the
 * `.md`, writing the `.html`, fetching the LSP semantic tokens, calling
 * VS Code's render API) are passed in as functions so unit tests can
 * exercise the full flow without spinning up VS Code.
 */

import type { GrammarRegistry } from './grammar-registry';
import {
    githubDark,
    githubLight,
    highlightCodeBlock,
    semanticOverlaysFromLspData,
    type GithubPalette,
} from './code-highlighter';

/** Per-language CSS class prefix `markdown-it` emits. */
const LANG_CLASS_PREFIX = 'language-';

/**
 * Render a post-knit `.md` source string into the final HTML body
 * we'll show in the panel and write to disk for "Open in Browser".
 *
 * The output is a self-contained HTML document: `<!doctype html>` +
 * inlined GitHub + KaTeX stylesheets + the rendered body. No external
 * scripts; the iframe sandbox in the knit-output panel is
 * `allow-same-origin` only (no `allow-scripts`), so we cannot rely on
 * client-side JS to do anything.
 */
export async function renderKnitHtml(args: {
    /** Post-knit markdown source. */
    markdownSource: string;

    /**
     * Renders markdown -> HTML using VS Code's pipeline. The default
     * production wiring calls `vscode.commands.executeCommand(
     * 'markdown.api.render', source)`. Tests pass a fake.
     */
    renderMarkdown: (source: string) => Promise<string>;

    /**
     * Tokenizer registry used by `highlightCodeBlock`. Production
     * callers pass the registry built from `createGrammarRegistry`.
     */
    registry: GrammarRegistry;

    /**
     * Fetches Raven's LSP `function` semantic tokens for raw R source
     * text via the `raven/semanticTokensForRString` custom request.
     * Returns the LSP-encoded `data: number[]` array, decoded with
     * `semanticOverlaysFromLspData` inside this module. Tests pass a
     * fake; if undefined, R code blocks get vscode-textmate-only
     * highlighting (no function-name overlay).
     */
    fetchRSemanticTokens?: (text: string) => Promise<ArrayLike<number>>;

    /**
     * The KaTeX CSS to inline. Production callers read the file
     * shipped by VS Code's `vscode.markdown-math` extension; tests
     * pass an empty string.
     */
    katexCss?: string;

    /**
     * Sets the data-theme attribute on the wrapper so the inlined
     * GitHub palettes can switch via either `prefers-color-scheme`
     * (browser) or the parent webview's body class (in-VS Code).
     * `null` produces a stylesheet that defaults to light and flips
     * to dark via `@media (prefers-color-scheme: dark)`; non-null
     * paints whichever palette the panel is currently themed for.
     */
    themeClasses?: string | null;
}): Promise<string> {
    const html = await args.renderMarkdown(args.markdownSource);
    const rewritten = await rewriteCodeBlocks(html, args);
    return assembleDocument(rewritten, args);
}

/**
 * Walk the rendered HTML for `<pre><code class="...language-X...">`
 * blocks (markdown-it's emitted shape), replace each block's body
 * with our highlighted version, and leave everything else
 * (paragraphs, math spans, raw HTML pass-through) alone.
 */
async function rewriteCodeBlocks(
    html: string,
    args: {
        registry: GrammarRegistry;
        fetchRSemanticTokens?: (text: string) => Promise<ArrayLike<number>>;
        themeClasses?: string | null;
    },
): Promise<string> {
    const out: string[] = [];
    let cursor = 0;
    // Loose regex: VS Code's pipeline emits attributes in different
    // orders depending on plugins (`<code data-line="N" class="...">`
    // vs `<code class="..." data-line="N">`), so we match
    // case-insensitively and scan from cursor each iteration. The
    // language attribute can be one of several classes — we extract
    // it from the class attribute below rather than constraining its
    // position in the regex.
    const blockRe = /<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
    blockRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(html)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;
        const codeAttrs = match[1];
        const innerEncoded = match[2];

        out.push(html.slice(cursor, matchStart));

        const languageId = extractLanguageId(codeAttrs);
        if (!languageId) {
            // No language tag — leave the original block intact so the
            // user's plain ``` blocks keep their inherited styling.
            out.push(match[0]);
            cursor = matchEnd;
            continue;
        }

        const rawSource = decodeCodeBlock(innerEncoded);
        let overlays: ReturnType<typeof semanticOverlaysFromLspData> = [];
        if (languageId === 'r' && args.fetchRSemanticTokens) {
            try {
                const data = await args.fetchRSemanticTokens(rawSource);
                overlays = semanticOverlaysFromLspData(data, rawSource);
            } catch (err) {
                // Fall back to grammar-only highlighting.
                console.error(
                    '[raven-knit] fetchRSemanticTokens failed: ' +
                        (err instanceof Error ? err.message : String(err)),
                );
            }
        }
        const highlighted = await highlightCodeBlock({
            source: rawSource,
            languageId,
            registry: args.registry,
            overlays,
        });
        out.push(
            `<pre><code class="${LANG_CLASS_PREFIX}${escapeAttr(languageId)}">` +
                highlighted +
                `</code></pre>`,
        );
        cursor = matchEnd;
    }
    out.push(html.slice(cursor));
    return out.join('');
}

/**
 * Pull the language ID out of a `<code class="…language-X…">` attribute
 * list. VS Code's pipeline (highlight.js mode) emits the class
 * `language-r`; markdown-it's default also emits `language-r`.
 * Returns the language ID lowercased, or null when none is declared.
 */
export function extractLanguageId(codeAttrs: string): string | null {
    const classMatch = codeAttrs.match(/\bclass\s*=\s*"([^"]*)"/i)
        ?? codeAttrs.match(/\bclass\s*=\s*'([^']*)'/i);
    if (!classMatch) return null;
    const classes = classMatch[1].split(/\s+/);
    for (const c of classes) {
        if (c.startsWith(LANG_CLASS_PREFIX)) {
            const lang = c.slice(LANG_CLASS_PREFIX.length).trim().toLowerCase();
            if (lang.length > 0) return lang;
        }
    }
    return null;
}

/**
 * Decode HTML-escaped code-block body back to its raw source.
 *
 * Two layers to reverse:
 *
 *   1. Inline highlighter markup. VS Code's `markdown.api.render`
 *      runs each code block through markdown-it's `highlight` hook,
 *      which on the preview pipeline pre-tokenizes via highlight.js
 *      and emits `<span class="hljs-...">…</span>` wrappers inside
 *      the `<code>`. Those tags are part of the markup, not of the
 *      source. We strip them first so the inner text reads as a
 *      verbatim copy of what the user wrote.
 *
 *   2. The five HTML metacharacters that the renderer escapes
 *      (`&`, `<`, `>`, `"`, `'`) need to be reversed before we feed
 *      the text to vscode-textmate.
 *
 * Stripping tags BEFORE entity-decoding is essential: in the
 * rendered inner content every literal `<` from the source code has
 * already been escaped to `&lt;`, so any remaining `<` is part of a
 * highlighter tag. Decoding first would conflate the two.
 *
 * Entity-reversal order also matters: `&amp;` must be reversed LAST
 * so a literal `&amp;lt;` (the escape sequence for the text `&lt;`)
 * round-trips correctly.
 */
export function decodeCodeBlock(encoded: string): string {
    return encoded
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&');
}

/** Escape a value for use inside an HTML attribute. */
function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build the final HTML document around the rewritten body. Two CSS
 * paths are emitted:
 *
 *   - GitHub light/dark palettes scoped to either
 *     `prefers-color-scheme` (when `themeClasses` is null — i.e. the
 *     standalone file we write for "Open in Browser") or to the
 *     panel's body class (when running inside VS Code).
 *   - KaTeX CSS, inlined verbatim so math renders without further
 *     resource fetches (the iframe-sandbox blocks scripts AND
 *     external link rel=stylesheet on most platforms).
 */
function assembleDocument(
    body: string,
    args: { katexCss?: string; themeClasses?: string | null },
): string {
    const css = composeStylesheet(args.themeClasses ?? null) +
        (args.katexCss ? `\n${args.katexCss}\n` : '');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Build the GitHub light/dark stylesheet. When `themeClasses` is null
 * we emit both palettes with the dark one scoped to
 * `prefers-color-scheme: dark`; the rendered file works in both light
 * and dark system themes when opened standalone in a browser. When
 * `themeClasses` is non-null we paint whichever palette matches the
 * caller's theme — the in-VS-Code panel passes the body class so the
 * code-block colors match the active editor theme variant.
 */
export function composeStylesheet(themeClasses: string | null): string {
    const isLight = themeClasses !== null && /\bvscode-(light|high-contrast-light)\b/.test(themeClasses);

    // Always include both palettes as data so we can swap them on
    // demand. The selector for "is this the dark variant" varies
    // (`prefers-color-scheme` for the standalone case, body-class for
    // the in-VS-Code panel). Below we set the active variant up
    // front and then add a media-query swap when running standalone.
    const lightVars = paletteAsCssVars(githubLight);
    const darkVars = paletteAsCssVars(githubDark);

    if (themeClasses === null) {
        // Standalone (browser) — start light, swap on prefers-color-scheme: dark.
        return `
:root {
  color-scheme: light dark;
  ${lightVars}
}
@media (prefers-color-scheme: dark) {
  :root {
    ${darkVars}
  }
}
${baseStyles()}
`.trim();
    }

    return `
:root {
  color-scheme: ${isLight ? 'light' : 'dark'};
  ${isLight ? lightVars : darkVars}
}
${baseStyles()}
`.trim();
}

function paletteAsCssVars(palette: GithubPalette): string {
    return [
        `--raven-bg: ${palette.background};`,
        `--raven-fg: ${palette.foreground};`,
        `--raven-c-keyword: ${palette.roles.keyword};`,
        `--raven-c-string: ${palette.roles.string};`,
        `--raven-c-number: ${palette.roles.number};`,
        `--raven-c-comment: ${palette.roles.comment};`,
        `--raven-c-function: ${palette.roles.function};`,
        `--raven-c-type: ${palette.roles.type};`,
        `--raven-c-variable: ${palette.roles.variable};`,
        `--raven-c-operator: ${palette.roles.operator};`,
        `--raven-c-punctuation: ${palette.roles.punctuation};`,
        `--raven-c-constant: ${palette.roles.constant};`,
    ].join('\n  ');
}

function baseStyles(): string {
    return `
body {
  background: var(--raven-bg);
  color: var(--raven-fg);
}
pre, code {
  background: var(--raven-bg);
  color: var(--raven-fg);
}
pre {
  padding: 0.75rem 1rem;
  border-radius: 6px;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, var(--raven-fg) 15%, transparent);
}
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
`.trim();
}
