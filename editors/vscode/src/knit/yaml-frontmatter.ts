/**
 * R Markdown YAML front-matter parsing for the knit command.
 *
 * This module owns three concerns:
 *   1. Slicing the leading `---` ... `---` block out of a document.
 *   2. Parsing that block with js-yaml's JSON schema (no `!!js/function`,
 *      no other dangerous tags) into a plain object.
 *   3. Reading the small surface we care about: output format and the
 *      "deferred-feature blockers" listed in the design doc — `knit:`
 *      hook, `runtime: shiny`, `server: shiny`, `site:`. `params:` and
 *      multi-output entries are intentionally NOT blockers; see
 *      docs/superpowers/specs/2026-05-16-rmd-knit-preview-design.md.
 */

import * as yaml from 'js-yaml';

export type FrontmatterDoc = Record<string, unknown>;

export type ParseResult =
    | { ok: true; value: FrontmatterDoc }
    | { ok: false; error: string };

export type BlockerKind = 'knit-hook' | 'shiny' | 'site';

export interface Blocker {
    kind: BlockerKind;
    /** Human-readable message body (the title is set by the caller). */
    message: string;
    /** R expression the user can copy and paste into a console. */
    copyCommand: string;
}

const BOM = '﻿';

/**
 * Split a document into its YAML front-matter fence (if any) and the
 * remaining body. `fence` is the inner body of the fence (with a
 * trailing `\n`); `body` is what follows the closing `---`. When no
 * terminated front matter is present `fence` is `null` and `body` is
 * the input text, returned as-is.
 *
 * BOM stripping and CRLF normalization happen only on the
 * front-matter path. Avoiding them on the no-front-matter path lets a
 * large knit output (data frames, big tables) pass through this
 * function without a full-string normalization allocation, and
 * preserves CRLF endings for any downstream consumer that cares.
 */
function splitFrontmatter(text: string): { fence: string | null; body: string } {
    // Fast path: if the document cannot possibly start with a
    // front-matter fence (after an optional BOM), return as-is.
    const afterBom = text.startsWith(BOM) ? text.slice(BOM.length) : text;
    if (!afterBom.startsWith('---\n') && !afterBom.startsWith('---\r\n')) {
        return { fence: null, body: text };
    }

    // Slow path: BOM-strip + CRLF→LF normalize, then scan for the
    // closing fence.
    let normalized = afterBom;
    normalized = normalized.replace(/\r\n/g, '\n');

    const rest = normalized.slice(4); // skip the opening "---\n"

    // Empty front matter: the close fence sits immediately after the
    // open fence (`---\n---\n…` or `---\n---` at EOF). The regex
    // below requires a leading `\n` before the close, which isn't
    // present in that case — handle it explicitly so we still strip
    // the visible artifact (`<pre class="frontmatter">` in VS Code's
    // markdown renderer) that this gate is here to prevent.
    if (rest.startsWith('---\n')) {
        return { fence: '', body: rest.slice(4) };
    }
    if (rest === '---') {
        return { fence: '', body: '' };
    }

    const closeMatch = rest.match(/\n---(?:\n|$)/);
    if (!closeMatch || closeMatch.index === undefined) {
        // Unterminated fence: behave like the no-front-matter path
        // and return the input as-is. Important for the (admittedly
        // unreachable in production) case of an unterminated CRLF
        // fence — we don't want to silently LF-normalize a body that
        // the caller is about to flow into a downstream consumer.
        return { fence: null, body: text };
    }
    const inner = rest.slice(0, closeMatch.index);
    const fence = inner.endsWith('\n') ? inner : inner + '\n';
    const after = rest.slice(closeMatch.index + closeMatch[0].length);
    return { fence, body: after };
}

/**
 * Strip the YAML front-matter block from the document text. Returns the
 * inner body of the fence with a normalized trailing newline, or `null`
 * when no terminated front-matter block is present. When a fence IS
 * present, CRLF line endings inside the fence are normalized to LF so
 * downstream YAML parsing is line-ending-agnostic.
 *
 * An empty fence (`---\n---\n`) returns an empty string, not `null`:
 * the document declared an empty YAML block and downstream
 * `parseFrontmatter('')` yields an empty map, matching how
 * rmarkdown / pandoc treat the same shape.
 */
export function extractFrontmatter(text: string): string | null {
    return splitFrontmatter(text).fence;
}

/**
 * Return the document body with the leading `--- ... ---` front-matter
 * block removed. When no terminated front matter is present the input
 * is returned as-is (no BOM stripping, no CRLF normalization).
 *
 * Used by the knit pipeline to keep the YAML out of the post-knit
 * markdown handed to VS Code's `markdown.api.render`: that pipeline
 * renders front matter as a styled `<pre class="frontmatter">` block
 * (visible as a table-like box at the top of the preview), but we
 * already consume the YAML separately upstream. Mirrors what
 * `rmarkdown::render` + pandoc do natively.
 *
 * Callers MUST only invoke this when they know the source `.Rmd`
 * actually contained a front-matter fence: otherwise a no-YAML
 * document whose first chunk emits `---\n…\n---\n` content would
 * silently lose that output. `renderKnitHtml`'s `hadSourceFrontmatter`
 * flag enforces that contract.
 */
export function stripFrontmatter(text: string): string {
    return splitFrontmatter(text).body;
}

/**
 * Parse a front-matter body. Uses js-yaml's JSON schema, which:
 *   - Preserves YAML `null`, booleans, numbers, and strings as their
 *     JS equivalents (`FAILSAFE_SCHEMA` would stringify `null` as
 *     `"null"`, breaking the "`knit: null` is not a blocker" rule).
 *   - Excludes the YAML 1.1 octal-with-leading-zero / `yes`-as-true
 *     extensions of DEFAULT_SCHEMA, which are confusing in YAML
 *     frontmatter.
 *   - Refuses dangerous tags (`!!js/function`, etc.).
 *
 * Returns `{ ok: false, error }` on parse failure so the caller can
 * surface the message in the knit output channel.
 */
export function parseFrontmatter(body: string): ParseResult {
    if (body.trim() === '') return { ok: true, value: {} };
    try {
        const loaded = yaml.load(body, { schema: yaml.JSON_SCHEMA });
        // Top-level non-map results (e.g. a bare scalar document)
        // coerce to an empty object — front matter shouldn't be a
        // scalar, and downstream code only ever expects a map.
        if (loaded === null || loaded === undefined) return { ok: true, value: {} };
        if (typeof loaded !== 'object' || Array.isArray(loaded)) return { ok: true, value: {} };
        return { ok: true, value: loaded as FrontmatterDoc };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
    }
}

/**
 * Format identifiers that Raven's HTML-only knit pipeline accepts.
 *
 * The new pipeline renders only HTML (via knitr + VS Code's markdown
 * renderer + Raven's syntax highlighter). PDF / Word / slides / custom
 * formats are explicitly out of scope; we surface a Blocker with a
 * copy-paste R command instead. Aliases like `bookdown::html_document2`
 * stay on the supported list because they ultimately produce HTML.
 */
const SUPPORTED_HTML_FORMATS: ReadonlySet<string> = new Set([
    'html_document',
    'html_notebook',
    'html_vignette',
    'html_fragment',
    'bookdown::html_document2',
    'distill::distill_article',
    'pkgdown::html_document',
    'rmdformats::readthedown',
    'rmdformats::material',
    'rmdformats::html_clean',
    'rmdformats::html_docco',
    'tufte::tufte_html',
    'prettydoc::html_pretty',
]);

/**
 * True when `format` produces HTML through the existing rmarkdown +
 * pandoc pipeline AND would also produce HTML through the new
 * knitr-direct pipeline. Unknown formats default to `false`; we err on
 * the side of refusing rather than silently producing broken output.
 */
export function isSupportedHtmlFormat(format: string): boolean {
    return SUPPORTED_HTML_FORMATS.has(format.trim());
}

/**
 * Format identifier the knit subprocess should pass to
 * `rmarkdown::render`'s `output_format` argument. Returns
 * `"html_document"` whenever the document doesn't specify a format we
 * can recognize — matches rmarkdown's own default and lets a user with
 * no `output:` field still produce HTML.
 */
export function detectFormat(fm: FrontmatterDoc): string {
    const output = fm.output;
    if (output === undefined || output === null) return 'html_document';
    if (typeof output === 'string') return output.trim() || 'html_document';
    if (typeof output === 'object' && !Array.isArray(output)) {
        const keys = Object.keys(output as Record<string, unknown>);
        if (keys.length === 0) return 'html_document';
        // Trim object keys for consistency with the scalar-output path.
        // Without this trim, a YAML map like `{" html_document ": {}}`
        // would yield a value that the HTML-format predicate trims (and
        // would otherwise accept) but that downstream
        // `validateFormatIdentifier` rejects — the gate and the render
        // path would disagree about the same string.
        const trimmed = keys[0].trim();
        return trimmed || 'html_document';
    }
    return 'html_document';
}

/**
 * Detect features that the knit command intentionally doesn't support.
 * Each blocker carries a `copyCommand` the UI surfaces in a "Copy
 * command" button so the user can run the equivalent in the R console.
 *
 * Detection is conservative: when in doubt, surface the blocker rather
 * than risk silently producing wrong output. `params:` and
 * multi-output entries are explicitly *not* blockers (the design doc
 * defers parameter-dialog UI and multi-format pickers to later issues).
 */
export function detectBlockers(fm: FrontmatterDoc): Blocker[] {
    const blockers: Blocker[] = [];

    if ('knit' in fm && fm.knit !== null && fm.knit !== undefined) {
        const value = fm.knit;
        const inferred = inferKnitHookCommand(value);
        blockers.push({
            kind: 'knit-hook',
            message:
                "This document specifies a custom knit hook. Raven doesn't honor custom hooks. " +
                "Run the equivalent in the R console.",
            copyCommand: inferred,
        });
    }

    const runtime = stringField(fm.runtime);
    const serverString = stringField(fm.server);
    const serverNested = typeof fm.server === 'object' && fm.server !== null
        ? stringField((fm.server as Record<string, unknown>).type)
        : null;
    if (
        runtime?.startsWith('shiny') ||
        serverString === 'shiny' ||
        serverNested === 'shiny'
    ) {
        blockers.push({
            kind: 'shiny',
            message: "Shiny documents aren't supported by Raven: Knit Preview.",
            copyCommand: "rmarkdown::run('FILENAME')",
        });
    }

    if ('site' in fm && fm.site !== null && fm.site !== undefined) {
        const siteValue = stringField(fm.site);
        const isBookdown = siteValue !== null && /bookdown/.test(siteValue);
        blockers.push({
            kind: 'site',
            message: "Site projects aren't supported by Raven: Knit Preview.",
            copyCommand: isBookdown
                ? "bookdown::serve_book()"
                : "rmarkdown::render_site()",
        });
    }

    return blockers;
}

function stringField(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return value.trim();
}

function inferKnitHookCommand(value: unknown): string {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // Common shape: `(function(input, ...) bookdown::render_book(input, ...))`.
        // Prefer a namespaced `pkg::fn(` over an unqualified call so we
        // skip past `function(` in the wrapper. If neither exists, fall
        // back to the first identifier-like call. The `FILENAME`
        // placeholder is substituted by the caller using `escapeRString`
        // so paths with apostrophes / backslashes stay valid R syntax.
        const namespaced = trimmed.match(/([A-Za-z_][A-Za-z0-9_.]*::[A-Za-z_][A-Za-z0-9_.]*)\s*\(/);
        if (namespaced) return `${namespaced[1]}('FILENAME')`;
        const plain = trimmed.match(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/);
        if (plain && plain[1] !== 'function') return `${plain[1]}('FILENAME')`;
    }
    return "rmarkdown::render('FILENAME')";
}
