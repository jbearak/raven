// Heuristic background-tagging for the "Apply VS Code theme" overlay.
//
// `tag_background_rects` walks a sanitized SVG and adds `class="raven-bg"`
// to every <rect> that looks like a canvas or panel background:
//
//   1. The first <rect> direct child of <svg> — httpgd's outer canvas,
//      regardless of fill.
//   2. A <rect> direct child of a <g> AND with neither `stroke-linejoin`
//      nor `stroke-linecap` attributes. ggplot2's element_rect (used
//      for panel.background, plot.background, etc.) and httpgd's inner
//      canvas render without these attributes (their grid defaults
//      match httpgd's defaults). Data rects (GeomRect / GeomBar /
//      GeomCol / GeomTile) ALWAYS carry both because GeomRect defaults
//      to `linejoin = "mitre"` / `lineend = "butt"` and httpgd emits
//      non-default join/cap values explicitly.
//
// This distinguisher is validated against captured real httpgd 2.1.4
// output for both `theme_gray()` scatter and bar plots — see the
// `tests/fixtures/httpgd/ggplot-*.svg` fixtures.

import { describe, test, expect, beforeAll } from 'bun:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

beforeAll(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const g = globalThis as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.Node = dom.window.Node;
    g.NodeFilter = dom.window.NodeFilter;
    g.HTMLElement = dom.window.HTMLElement;
    g.SVGElement = dom.window.SVGElement;
    g.Element = dom.window.Element;
    g.DocumentFragment = dom.window.DocumentFragment;
});

const tag_background_rects: (text: string) => string = await (async () => {
    const mod = await import('../../editors/vscode/src/plot/webview/tag-backgrounds');
    return mod.tag_background_rects;
})();
const sanitize_svg: (text: string) => string = await (async () => {
    const mod = await import('../../editors/vscode/src/plot/webview/sanitize');
    return mod.sanitize_svg;
})();

const FIXTURES_DIR = resolve(
    (import.meta as unknown as { dir: string }).dir,
    '..',
    'fixtures',
    'httpgd',
);

function parse_rects(svgText: string): Element[] {
    const dom = new JSDOM(`<!doctype html><html><body>${svgText}</body></html>`);
    return Array.from(dom.window.document.querySelectorAll('rect'));
}

describe('tag_background_rects — heuristic identifies canvas + panel rects', () => {
    test('existing httpgd fixture: both canvas rects gain class="raven-bg"; data circles untouched', () => {
        const fixture = readFileSync(resolve(FIXTURES_DIR, 'plot-1-10.svg'), 'utf-8');
        const sanitized = sanitize_svg(fixture);
        const tagged = tag_background_rects(sanitized);
        const rects = parse_rects(tagged);
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        // Outer canvas (Rule 1) + inner canvas (Rule 2, no linejoin/
        // linecap, direct child of <g>) = 2. The <clipPath><rect/></clipPath>
        // defs rect is not tagged — its parent is <clipPath>, neither
        // <svg> nor <g>.
        expect(taggedRects.length).toBe(2);
        const dom = new JSDOM(`<!doctype html><html><body>${tagged}</body></html>`);
        const circles = Array.from(dom.window.document.querySelectorAll('circle'));
        expect(circles.length).toBeGreaterThan(0);
        for (const c of circles) {
            expect(c.classList.contains('raven-bg')).toBe(false);
        }
    });

    test('real httpgd ggplot scatter: outer canvas + inner canvas + panel.background all tagged', () => {
        // Captured live from R via `ggplot(mtcars, aes(wt, mpg)) +
        // geom_point()` against httpgd 2.1.4. The inner canvas rect
        // arrives as `stroke="#FFFFFF" fill="#FFFFFF"` (matching
        // stroke/fill, not "none") — the original "stroke=none AND
        // only-rect-in-g" heuristic missed it. This is the regression
        // pin for the user-reported "always white" bug.
        const fixture = readFileSync(resolve(FIXTURES_DIR, 'ggplot-scatter.svg'), 'utf-8');
        const sanitized = sanitize_svg(fixture);
        const tagged = tag_background_rects(sanitized);
        const rects = parse_rects(tagged);
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        // 3 expected: outer canvas (#FFFFFF, Rule 1), inner canvas
        // (#FFFFFF/#FFFFFF, Rule 2), panel.background (#EBEBEB, Rule 2).
        // The 3 <clipPath><rect/></clipPath> defs rects sit under
        // <clipPath> and are skipped.
        expect(taggedRects.length).toBe(3);
        // Spot-check each by fill colour.
        const fills = taggedRects.map(r => r.getAttribute('fill')).sort();
        expect(fills).toEqual(['#EBEBEB', '#FFFFFF', '#FFFFFF']);
    });

    test('real httpgd ggplot bar chart: backgrounds tagged, bars (with linejoin/linecap) untouched', () => {
        // Captured live: `ggplot(mtcars, aes(factor(cyl))) + geom_bar()`.
        // The c1 <g> holds the panel.background rect AND 3 bar rects
        // as siblings. A naive "only-rect-in-g" rule would miss the
        // panel.background; an "all stroke=none rects" rule would
        // erase the bars. The linejoin/linecap distinguisher cleanly
        // separates them: GeomBar emits `stroke-linejoin="miter"`
        // and `stroke-linecap="butt"`; element_rect does not.
        const fixture = readFileSync(resolve(FIXTURES_DIR, 'ggplot-bar.svg'), 'utf-8');
        const sanitized = sanitize_svg(fixture);
        const tagged = tag_background_rects(sanitized);
        const rects = parse_rects(tagged);
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        // 3 expected: outer canvas, inner canvas, panel.background.
        expect(taggedRects.length).toBe(3);
        // The 3 bar rects (#595959) must NOT be tagged.
        const bars = rects.filter(r => r.getAttribute('fill') === '#595959');
        expect(bars).toHaveLength(3);
        for (const bar of bars) {
            expect(bar.classList.contains('raven-bg')).toBe(false);
        }
        // Pin the structural signal: each bar carries stroke-linejoin
        // (this is what makes the heuristic work).
        for (const bar of bars) {
            expect(bar.hasAttribute('stroke-linejoin')).toBe(true);
            expect(bar.hasAttribute('stroke-linecap')).toBe(true);
        }
    });

    test('ggplot2 panel.background synthetic: outer canvas + panel rect both tagged', () => {
        // Synthetic mirror of theme_gray output. The heuristic must
        // NOT look at fill — theme_dark's #7F7F7F or a user-customized
        // colour would fail an allowlist but pass the structural rules.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<defs><clipPath id="cp"><rect /></clipPath></defs>'
            + '<g clip-path="url(#cp)">'
            + '<rect fill="#EBEBEB" stroke="none" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        // 2 expected: outer canvas (Rule 1) + panel rect (Rule 2).
        // The defs clipPath rect's parent is <clipPath>, not <g>.
        expect(taggedRects.length).toBe(2);
    });

    test('theme_dark()-style panel (fill=#7F7F7F, no linejoin/linecap alone in <g>) is tagged', () => {
        // Generalization probe: themes the colour allowlist never
        // saw should still get their panel.background tagged.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#cp)">'
            + '<rect fill="#7F7F7F" stroke="none" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        const panelBg = rects.find(r => r.getAttribute('fill') === '#7F7F7F');
        expect(panelBg).toBeDefined();
        expect(panelBg!.classList.contains('raven-bg')).toBe(true);
    });

    test('bar chart synthetic: rects with stroke-linejoin/stroke-linecap are NOT tagged', () => {
        // ggplot2 GeomBar / GeomRect / GeomCol / GeomTile always emit
        // `stroke-linejoin="miter"` and `stroke-linecap="butt"` because
        // their grid defaults differ from httpgd's "round" defaults.
        // Background rects (element_rect themes, inner canvas) never
        // emit these attributes. The presence check is the load-bearing
        // distinguisher.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#cp)">'
            // Panel.bg — alone-or-not is no longer the criterion, only
            // attr-presence. Lives alongside bars in the same <g>.
            + '<rect fill="#EBEBEB" stroke="none" />'
            + '<rect x="0" width="20" fill="#0000FF" stroke="none" stroke-linejoin="miter" stroke-linecap="butt" />'
            + '<rect x="30" width="20" fill="#0000FF" stroke="none" stroke-linejoin="miter" stroke-linecap="butt" />'
            + '<rect x="60" width="20" fill="#0000FF" stroke="none" stroke-linejoin="miter" stroke-linecap="butt" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        // 2 tagged: outer canvas + panel.bg (no linejoin/linecap).
        // The 3 bars (with linejoin/linecap) stay un-tagged.
        expect(taggedRects).toHaveLength(2);
        const bars = rects.filter(r => r.getAttribute('fill') === '#0000FF');
        expect(bars).toHaveLength(3);
        for (const bar of bars) {
            expect(bar.classList.contains('raven-bg')).toBe(false);
        }
    });

    test('geom_rect() annotation (with stroke-linejoin) is NOT tagged', () => {
        // GeomRect's default linejoin="mitre" / lineend="butt" gets
        // emitted by httpgd, so the annotation carries the
        // distinguishing attributes even when colour=NA produces
        // stroke="none". The presence-of-linejoin check keeps it out
        // of the background bucket.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#cp)">'
            + '<rect fill="#FF0000" stroke="none" stroke-linejoin="miter" stroke-linecap="butt" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        const annotation = rects.find(r => r.getAttribute('fill') === '#FF0000');
        expect(annotation).toBeDefined();
        expect(annotation!.classList.contains('raven-bg')).toBe(false);
    });

    test('inner-canvas-style rect (stroke=fill, no linejoin/linecap) is tagged — pins the user-reported regression', () => {
        // The httpgd ggplot inner canvas emits
        // `stroke="#FFFFFF" fill="#FFFFFF"` (stroke matches fill, NOT
        // "none"). The original heuristic's `stroke === 'none'` check
        // dropped this rect, leaving the panel area white over the
        // editor background once the panel.background was hidden.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#cp)">'
            + '<rect fill="#FFFFFF" stroke="#FFFFFF" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        const innerCanvas = rects.find(r => r.getAttribute('stroke') === '#FFFFFF');
        expect(innerCanvas).toBeDefined();
        expect(innerCanvas!.classList.contains('raven-bg')).toBe(true);
    });

    test('existing class attribute is preserved alongside raven-bg', () => {
        // Defensive: a future httpgd version (or third-party SVG)
        // might pre-emit a class on the canvas rect. The tagger must
        // append `raven-bg` rather than clobber the existing value.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect class="httpgd-extra" fill="#FFFFFF" stroke="none" />'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        expect(rects).toHaveLength(1);
        const classes = (rects[0].getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        expect(classes).toContain('httpgd-extra');
        expect(classes).toContain('raven-bg');
    });

    test('repeated invocation does not duplicate the raven-bg class', () => {
        // The fetch effect caches the post-tag bytes, so repeated
        // application is rare — but a future caller might (e.g. for
        // diagnostics) and the result should still be idempotent.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect fill="#FFFFFF" stroke="none" />'
            + '</svg>';
        const once = tag_background_rects(input);
        const twice = tag_background_rects(once);
        const rects = parse_rects(twice);
        const tokens = (rects[0].getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        const bgCount = tokens.filter(t => t === 'raven-bg').length;
        expect(bgCount).toBe(1);
    });

    test('empty input returns empty output without throwing', () => {
        expect(tag_background_rects('')).toBe('');
    });

    test('input lacking <svg> is returned unchanged', () => {
        const input = 'hello world';
        expect(tag_background_rects(input)).toBe(input);
    });
});
