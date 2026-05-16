/**
 * R Markdown YAML front-matter parsing for the knit command.
 *
 * This module owns three concerns:
 *   1. Slicing the leading `---` ... `---` block out of a document.
 *   2. Parsing that block with js-yaml's SAFE schema (no `!!js/function`,
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
 * Strip the YAML front-matter block from the document text. Returns the
 * inner body of the fence with a normalized trailing newline, or `null`
 * when no terminated front-matter block is present. CRLF line endings are
 * normalized to LF so downstream parsing is line-ending-agnostic.
 */
export function extractFrontmatter(text: string): string | null {
    let body = text;
    if (body.startsWith(BOM)) body = body.slice(BOM.length);
    body = body.replace(/\r\n/g, '\n');

    if (!body.startsWith('---\n') && body !== '---' && !body.startsWith('---')) {
        return null;
    }
    if (!body.startsWith('---\n')) return null;

    const rest = body.slice(4);
    const closeMatch = rest.match(/\n---(?:\n|$)/);
    if (!closeMatch || closeMatch.index === undefined) return null;
    const inner = rest.slice(0, closeMatch.index);
    return inner.endsWith('\n') ? inner : inner + '\n';
}

/**
 * Parse a front-matter body. Uses js-yaml's SAFE schema, which forbids
 * dangerous tags (`!!js/function`, etc.). Returns `{ ok: false, error }`
 * on parse failure so the caller can surface the message in the knit
 * output channel.
 */
export function parseFrontmatter(body: string): ParseResult {
    if (body.trim() === '') return { ok: true, value: {} };
    try {
        const loaded = yaml.load(body, { schema: yaml.FAILSAFE_SCHEMA });
        // FAILSAFE preserves strings/sequences/maps and refuses tags like
        // `!!js/function`. Top-level non-map results (e.g. a bare scalar
        // document) coerce to an empty object — front matter shouldn't be
        // a scalar, and downstream code only ever expects a map.
        if (loaded === null || loaded === undefined) return { ok: true, value: {} };
        if (typeof loaded !== 'object' || Array.isArray(loaded)) return { ok: true, value: {} };
        return { ok: true, value: loaded as FrontmatterDoc };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
    }
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
        return keys[0];
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
            message: "Shiny documents aren't supported by Raven: Knit.",
            copyCommand: "rmarkdown::run('FILENAME')",
        });
    }

    if ('site' in fm && fm.site !== null && fm.site !== undefined) {
        const siteValue = stringField(fm.site);
        const isBookdown = siteValue !== null && /bookdown/.test(siteValue);
        blockers.push({
            kind: 'site',
            message: "Site projects aren't supported by Raven: Knit.",
            copyCommand: isBookdown
                ? "bookdown::serve_book()"
                : (siteValue && /^rmarkdown::render_site$/.test(siteValue))
                    ? "rmarkdown::render_site()"
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
        // Pick out the inner pkg::fn call when we can — gives the user a
        // working starting point. Otherwise fall back to the default.
        const match = trimmed.match(/([A-Za-z_][A-Za-z0-9_.]*(?:::[A-Za-z_][A-Za-z0-9_.]*)?)\s*\(/);
        if (match) return `${match[1]}('FILENAME')`;
    }
    return "rmarkdown::render('FILENAME')";
}
