// Defense-in-depth regression test for the inline codicon SVG
// constants in editors/vscode/src/plot/webview/App.svelte.
//
// Why this test exists: `SHARE_ICON`, `SYMBOL_COLOR_ICON`, and
// `OPEN_IN_BROWSER_ICON` are injected into the webview via Svelte's
// `{@html ...}` template syntax, which bypasses Svelte's normal HTML
// escaping. Unlike the plot's runtime SVG (which is routed through
// `sanitize_svg` — see plot-webview-sanitize.test.ts), there is no
// runtime sanitizer in the icon path: the strings are concatenated into
// the page exactly as written. Today the constants are hand-vetted
// codicon paths, but a future contributor copy-pasting a third-party
// SVG could introduce `<use href="...">`, `<image href="...">`, a
// `<script>` block, or an `onerror="..."` attribute — any of which
// would silently expand the webview's attack surface (CSP allows
// `style-src 'unsafe-inline'`, so attribute-style payloads are not
// blocked; external-href fetches via `<use>`/`<image>` can also leak
// request metadata to attacker-controlled origins).
//
// This test parses the App.svelte source, extracts each icon constant
// by name, and asserts that every constant is free of the elements and
// attributes listed in the security comment on the constants. If a
// constant fails, the fix is to either (a) keep it pure SVG (path /
// rect / circle / g / etc. — no external refs, no scripts, no event
// handlers) or (b) route it through `sanitize_svg` at module init and
// embed the sanitized output. Do NOT silence this test by widening the
// allowlist without explicit security review.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP_SVELTE_PATH = join(
    __dirname,
    '..',
    '..',
    'editors',
    'vscode',
    'src',
    'plot',
    'webview',
    'App.svelte',
);

const APP_SVELTE_SOURCE = readFileSync(APP_SVELTE_PATH, 'utf-8');

// Extract a `const NAME = '...';` value from the App.svelte source.
// Uses single-quoted strings only because that's the existing
// convention for these constants; if the convention ever changes to
// backticks or double quotes the extractor needs to update in lockstep.
function extractIcon(name: string): string {
    // Match `const NAME = ` then either `'...'` or `\n        '...'`.
    // Single quotes are not allowed inside the string body itself
    // (which is true for SVG path data — quotes inside paths are
    // double quotes).
    const re = new RegExp(`const\\s+${name}\\s*=\\s*\\n?\\s*'([^']*)'`);
    const match = APP_SVELTE_SOURCE.match(re);
    if (!match) {
        throw new Error(
            `Could not locate \`const ${name} = '...'\` in App.svelte. ` +
                `If the constant was renamed or moved, update this test ` +
                `in lockstep — the security guard depends on the lookup.`,
        );
    }
    return match[1];
}

const ICON_CONSTANTS: Record<string, string> = {
    SHARE_ICON: extractIcon('SHARE_ICON'),
    SYMBOL_COLOR_ICON: extractIcon('SYMBOL_COLOR_ICON'),
    OPEN_IN_BROWSER_ICON: extractIcon('OPEN_IN_BROWSER_ICON'),
};

describe('App.svelte inline icon constants — XSS defense-in-depth', () => {
    test('extractor located every expected constant', () => {
        // Sanity: every entry should have non-empty SVG markup.
        for (const [name, svg] of Object.entries(ICON_CONSTANTS)) {
            expect(svg.length, `${name} should be non-empty`).toBeGreaterThan(0);
            expect(svg.toLowerCase()).toContain('<svg');
        }
    });

    // Run the same forbidden-content checks against every constant.
    for (const [name, svg] of Object.entries(ICON_CONSTANTS)) {
        describe(name, () => {
            test('contains no <script> element', () => {
                expect(svg).not.toMatch(/<\s*script\b/i);
            });
            test('contains no <use> element (external-href vector)', () => {
                expect(svg).not.toMatch(/<\s*use\b/i);
            });
            test('contains no <image> element (external-href vector)', () => {
                expect(svg).not.toMatch(/<\s*image\b/i);
            });
            test('contains no <a> element (navigation-hijack vector)', () => {
                expect(svg).not.toMatch(/<\s*a\b/i);
            });
            test('contains no <foreignObject> element (arbitrary-HTML host)', () => {
                expect(svg).not.toMatch(/<\s*foreignObject\b/i);
            });
            test('contains no <iframe> element', () => {
                expect(svg).not.toMatch(/<\s*iframe\b/i);
            });
            test('contains no href / xlink:href attribute', () => {
                // The codicon paths use `viewBox`, `fill`, `clip-rule`,
                // `fill-rule`, etc. — none of which should ever resolve
                // to an external URL.
                expect(svg).not.toMatch(/\bhref\s*=/i);
                expect(svg).not.toMatch(/\bxlink:href\s*=/i);
            });
            test('contains no inline event-handler attribute', () => {
                // Match `on…="…"` style attributes. The regex requires
                // a word boundary on each side so it doesn't false-
                // positive on e.g. `fill="none"`. The character class
                // after `on` is letters-only (event names are letters).
                expect(svg).not.toMatch(/(?:^|\s|<|;)on[a-zA-Z]+\s*=/);
            });
            test('contains no data: or javascript: URL', () => {
                expect(svg.toLowerCase()).not.toContain('data:');
                expect(svg.toLowerCase()).not.toContain('javascript:');
            });
            test('contains no inline style attribute (CSS-exfiltration defense)', () => {
                // Mirrors the FORBID_ATTR list in `sanitize_svg` for
                // the plot SVG. CSS payloads can exfiltrate state via
                // `background-image: url(...)` and similar.
                expect(svg).not.toMatch(/\bstyle\s*=/i);
            });
        });
    }
});
