// Theme-overlay coverage for the "Apply VS Code theme" toggle.
//
// The overlay lives in `editors/vscode/src/plot/webview/App.svelte`
// inside a scoped `<style>` block. Its job is to (a) hide every
// httpgd-emitted canvas-background rect so the webview body's
// `--vscode-editor-background` shows through, and (b) recolor the
// strokes/text to `--vscode-editor-foreground`.
//
// The bug this suite pins: httpgd emits MORE THAN ONE white-fill rect
// covering the canvas — the first-of-type direct child of <svg> is one,
// and at least one more lives inside a `<g clip-path>` wrapper. The
// original overlay only targeted `> rect:first-of-type`, so the inner
// rect kept its `fill="#FFFFFF"` and painted a white slab over the
// editor background when the toggle was on. Hidden by the prior bug
// where sanitize stripped all colors (everything painted black), but
// visible after the sanitize fix landed.
//
// Tests are static-source: we extract the overlay's CSS selectors from
// App.svelte, strip Svelte's `:global(...)` wrappers, and verify that
// at least one selector matches a representative inner-rect node via
// JSDOM's `Element.matches`. This is a clean reflection of how the
// browser will actually apply the rules without relying on a real CSS
// engine (which JSDOM doesn't ship).

import { describe, test, expect, beforeAll } from 'bun:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DIR = (import.meta as unknown as { dir: string }).dir;
const APP_SVELTE_PATH = resolve(
    TEST_DIR,
    '..',
    '..',
    'editors',
    'vscode',
    'src',
    'plot',
    'webview',
    'App.svelte',
);
const FIXTURE_PATH = resolve(
    TEST_DIR,
    '..',
    'fixtures',
    'httpgd',
    'plot-1-10.svg',
);

// Prime jsdom globals so sanitize.ts (which we'll dynamically import)
// can call DOMPurify against a fake window. Same pattern as
// `plot-webview-sanitize.test.ts`.
beforeAll(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const g = globalThis as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.Node = dom.window.Node;
    g.NodeFilter = dom.window.NodeFilter;
    g.HTMLElement = dom.window.HTMLElement;
    g.SVGElement = dom.window.SVGElement;
    g.DocumentFragment = dom.window.DocumentFragment;
});

const sanitize_svg: (text: string) => string = await (async () => {
    const mod = await import('../../editors/vscode/src/plot/webview/sanitize');
    return mod.sanitize_svg;
})();

/**
 * Extract every CSS rule under `.apply-vscode-theme` from App.svelte's
 * `<style>` block that sets `fill: none`. Returns the cleaned
 * selectors (with `:global(...)` wrappers stripped) so they can be
 * matched against real DOM nodes via `Element.matches`.
 *
 * Parser intent — not a full CSS parser; the App.svelte style block
 * is small and hand-maintained, so a regex over `<style>` + a balanced-
 * brace iterator is plenty. We bail loudly if the shape ever diverges.
 */
function extract_fill_none_selectors_under_theme(source: string): string[] {
    const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
    if (!styleMatch) throw new Error('App.svelte: no <style> block');
    // Strip /* ... */ comments before scanning. Without this, a comment
    // text leaks into the next rule's selectors blob (commas inside
    // prose terminate selector splits, etc.).
    const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, '');
    // Walk top-level rules in the <style> block (no @media nesting
    // expected). Split on top-level `}` after a `{`.
    const rules: { selectors: string; body: string }[] = [];
    let depth = 0;
    let buf = '';
    let inBody = false;
    let currentSelectors = '';
    for (const ch of css) {
        if (ch === '{' && depth === 0) {
            currentSelectors = buf.trim();
            buf = '';
            inBody = true;
            depth = 1;
            continue;
        }
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0 && inBody) {
                rules.push({ selectors: currentSelectors, body: buf });
                buf = '';
                inBody = false;
                continue;
            }
        }
        buf += ch;
    }
    // Filter rules whose body contains `fill: none` (with arbitrary
    // whitespace) and whose selector list mentions `.apply-vscode-theme`.
    const FILL_NONE_RE = /\bfill\s*:\s*none\b/;
    const selectors: string[] = [];
    for (const rule of rules) {
        if (!FILL_NONE_RE.test(rule.body)) continue;
        if (!rule.selectors.includes('.apply-vscode-theme')) continue;
        for (const raw of rule.selectors.split(',')) {
            // Strip `:global(...)` wrappers — Svelte's compiler unwraps
            // them in the emitted CSS, so the browser sees the inner
            // selector directly.
            const cleaned = raw.replace(/:global\(([^)]+)\)/g, '$1').trim();
            if (cleaned) selectors.push(cleaned);
        }
    }
    return selectors;
}

describe('plot-host theme overlay — multi-rect canvas hiding', () => {
    test('httpgd fixture has multiple white-fill rects covering the canvas', () => {
        // Pin the structural assumption: an `httpgd` plot has MORE
        // than one rect with `fill='#FFFFFF'` painting the canvas —
        // the first-of-type direct child of <svg>, plus at least one
        // more wrapped in a <g clip-path>. The theme overlay must
        // cover both so the editor background shows through cleanly
        // when the toggle is on. If httpgd ever emits only one canvas
        // rect (e.g. drops the inner clip-path background), this test
        // turns green and the CSS rule for the inner rect becomes
        // safe to remove.
        const fixture = readFileSync(FIXTURE_PATH, 'utf-8');
        const sanitized = sanitize_svg(fixture);
        const dom = new JSDOM(`<!doctype html><html><body>${sanitized}</body></html>`);
        const rects = Array.from(dom.window.document.querySelectorAll('rect'));
        const whiteFillRects = rects.filter(r => {
            const fill = r.getAttribute('fill');
            return fill !== null && /^#fff(fff)?$/i.test(fill);
        });
        expect(whiteFillRects.length).toBeGreaterThanOrEqual(2);
    });

    test('overlay covers the inner clip-path canvas rect, not just the first-of-type direct child', () => {
        // The actual contract: when `.apply-vscode-theme` is on, the
        // selector(s) in App.svelte's <style> block that set
        // `fill: none` must match the inner background rect — the
        // one inside `<g clip-path>`, NOT a direct child of <svg>.
        // The pre-fix overlay only had `svg.httpgd > rect:first-of-type`,
        // which is structurally insufficient.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        // Sanity: we should have AT LEAST one fill-none rule under
        // `.apply-vscode-theme`. If this fails first, the App.svelte
        // style block was reshaped in a way that broke the parser.
        expect(selectors.length).toBeGreaterThan(0);

        // Build a representative DOM mirroring httpgd's output: an
        // outer `:first-of-type` canvas rect and an inner rect inside
        // `<g clip-path>`. Use `id` attrs so the test doesn't rely on
        // `:first-of-type` ordering of arbitrary `<rect>` nodes inside
        // the harness page.
        const dom = new JSDOM(
            '<!doctype html><html><body>'
            + '<div class="plot-host apply-vscode-theme">'
            + '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<defs><clipPath id="cp"><rect /></clipPath></defs>'
            + '<g clip-path="url(#cp)">'
            + '<rect id="inner" fill="#FFFFFF" stroke="none" />'
            + '</g>'
            + '</svg>'
            + '</div>'
            + '</body></html>',
        );
        const innerRect = dom.window.document.getElementById('inner');
        expect(innerRect).not.toBeNull();
        const matched = selectors.some(sel => {
            try {
                return innerRect!.matches(sel);
            } catch {
                // Selector that Element.matches can't parse (e.g.
                // a CSS function not in JSDOM's matcher) — treat as
                // a non-match. The pass condition still requires AT
                // LEAST one parseable selector to match.
                return false;
            }
        });
        expect(matched).toBe(true);
    });

    test('overlay covers the ggplot2 panel.background rect (fill="#EBEBEB")', () => {
        // ggplot2's `theme_gray()` is the package default; its
        // `panel.background = element_rect(fill = "grey92")` emits as
        // `fill="#EBEBEB"` (grey92 in hex). The overlay must cover this
        // rect too, otherwise the gray panel slab paints over the
        // editor background inside the cartesian grid — visible as a
        // light gray rectangle inside an otherwise themed plot.
        //
        // We don't ship a real ggplot2 httpgd fixture (would require
        // running R), but the contract is the rect's fill attribute:
        // the overlay's selector(s) must match a rect with the grey92
        // fill regardless of where it sits in the SVG tree.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        const dom = new JSDOM(
            '<!doctype html><html><body>'
            + '<div class="plot-host apply-vscode-theme">'
            + '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#panel-clip)">'
            + '<rect id="panel-bg" fill="#EBEBEB" stroke="none" />'
            + '</g>'
            + '</svg>'
            + '</div>'
            + '</body></html>',
        );
        const panelBg = dom.window.document.getElementById('panel-bg');
        expect(panelBg).not.toBeNull();
        const matched = selectors.some(sel => {
            try { return panelBg!.matches(sel); }
            catch { return false; }
        });
        expect(matched).toBe(true);
    });

    test('overlay still covers the first-of-type direct-child canvas rect (regression guard)', () => {
        // Negative-space companion to the inner-rect test: don't let a
        // future change replace the `:first-of-type` selector with one
        // that misses the original canvas rect. The two assertions
        // together pin both rects as in-scope.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        const dom = new JSDOM(
            '<!doctype html><html><body>'
            + '<div class="plot-host apply-vscode-theme">'
            + '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '</svg>'
            + '</div>'
            + '</body></html>',
        );
        const canvasRect = dom.window.document.getElementById('canvas');
        const matched = selectors.some(sel => {
            try { return canvasRect!.matches(sel); }
            catch { return false; }
        });
        expect(matched).toBe(true);
    });
});
