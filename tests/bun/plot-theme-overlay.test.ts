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
const tag_background_rects: (text: string) => string = await (async () => {
    const mod = await import('../../editors/vscode/src/plot/webview/tag-backgrounds');
    return mod.tag_background_rects;
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
        // Contract: when `.apply-vscode-theme` is on, the selector(s)
        // in App.svelte's <style> block that set `fill: none` must
        // match the inner background rect — the one inside
        // `<g clip-path>`, NOT a direct child of <svg>. With the new
        // structural-tagging mechanism, the rect carries
        // `class="raven-bg"` once the SVG has been through
        // `tag_background_rects`; the CSS selector hits via that
        // class. We run the synthetic SVG through the tagger so the
        // assertion exercises the same end-to-end behavior the
        // webview sees.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        // Sanity: we should have AT LEAST one fill-none rule under
        // `.apply-vscode-theme`. If this fails first, the App.svelte
        // style block was reshaped in a way that broke the parser.
        expect(selectors.length).toBeGreaterThan(0);

        const svgSource =
            '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<defs><clipPath id="cp"><rect /></clipPath></defs>'
            + '<g clip-path="url(#cp)">'
            + '<rect id="inner" fill="#FFFFFF" stroke="none" />'
            + '</g>'
            + '</svg>';
        const tagged = tag_background_rects(svgSource);
        const dom = new JSDOM(
            `<!doctype html><html><body><div class="plot-host apply-vscode-theme">${tagged}</div></body></html>`,
        );
        const innerRect = dom.window.document.getElementById('inner');
        expect(innerRect).not.toBeNull();
        // Pin the tagger end-to-end: the inner rect MUST carry the
        // class before the CSS selector can hit it.
        expect(innerRect!.classList.contains('raven-bg')).toBe(true);
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
        // `fill="#EBEBEB"` (grey92 in hex). Under the structural-
        // tagging mechanism the panel rect is tagged by Rule 2
        // (direct-child <g> rect lacking stroke-linejoin and
        // stroke-linecap) — fill colour is no longer load-bearing.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        const svgSource =
            '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#panel-clip)">'
            + '<rect id="panel-bg" fill="#EBEBEB" stroke="none" />'
            + '</g>'
            + '</svg>';
        const tagged = tag_background_rects(svgSource);
        const dom = new JSDOM(
            `<!doctype html><html><body><div class="plot-host apply-vscode-theme">${tagged}</div></body></html>`,
        );
        const panelBg = dom.window.document.getElementById('panel-bg');
        expect(panelBg).not.toBeNull();
        expect(panelBg!.classList.contains('raven-bg')).toBe(true);
        const matched = selectors.some(sel => {
            try { return panelBg!.matches(sel); }
            catch { return false; }
        });
        expect(matched).toBe(true);
    });

    test('overlay covers a theme_dark()-style panel rect (fill="#7F7F7F") — proves heuristic beats the old colour allowlist', () => {
        // The whole point of switching from a colour allowlist to
        // structural tagging: themes the allowlist never saw should
        // still get their panel.background hidden. `theme_dark()`'s
        // grey50 = `#7F7F7F` wasn't in the previous allowlist —
        // before this refactor the panel would have stayed painted
        // dark-grey over the editor background. After: tagged by
        // Rule 2 (direct-child <g> rect lacking stroke-linejoin and
        // stroke-linecap), hidden by `.raven-bg`.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        const svgSource =
            '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#panel-clip)">'
            + '<rect id="panel-bg" fill="#7F7F7F" stroke="none" />'
            + '</g>'
            + '</svg>';
        const tagged = tag_background_rects(svgSource);
        const dom = new JSDOM(
            `<!doctype html><html><body><div class="plot-host apply-vscode-theme">${tagged}</div></body></html>`,
        );
        const panelBg = dom.window.document.getElementById('panel-bg');
        expect(panelBg).not.toBeNull();
        expect(panelBg!.classList.contains('raven-bg')).toBe(true);
        const matched = selectors.some(sel => {
            try { return panelBg!.matches(sel); }
            catch { return false; }
        });
        expect(matched).toBe(true);
    });

    test('overlay still covers the first-of-type direct-child canvas rect (regression guard)', () => {
        // Negative-space companion: the outer canvas rect (Rule 1,
        // first-of-type direct child of <svg>) must still be hidden.
        // Pre-refactor this was a dedicated `:first-of-type` selector;
        // now the rect is tagged by Rule 1 and hidden by the same
        // `.raven-bg` rule that covers every other background rect.
        const source = readFileSync(APP_SVELTE_PATH, 'utf-8');
        const selectors = extract_fill_none_selectors_under_theme(source);
        const svgSource =
            '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect id="canvas" width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '</svg>';
        const tagged = tag_background_rects(svgSource);
        const dom = new JSDOM(
            `<!doctype html><html><body><div class="plot-host apply-vscode-theme">${tagged}</div></body></html>`,
        );
        const canvasRect = dom.window.document.getElementById('canvas');
        expect(canvasRect).not.toBeNull();
        expect(canvasRect!.classList.contains('raven-bg')).toBe(true);
        const matched = selectors.some(sel => {
            try { return canvasRect!.matches(sel); }
            catch { return false; }
        });
        expect(matched).toBe(true);
    });
});
