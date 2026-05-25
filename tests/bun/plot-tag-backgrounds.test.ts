// Heuristic background-tagging for the "Apply VS Code theme" overlay.
//
// `tag_background_rects` walks a sanitized SVG and adds `class="raven-bg"`
// to every <rect> that looks like a canvas or panel background:
//
//   1. The first <rect> direct child of <svg> — httpgd's outer canvas,
//      regardless of fill.
//   2. The only <rect> direct child of a <g> parent AND with
//      `stroke="none"` (or no stroke attribute) — a panel background
//      sitting alone before its data layer.
//
// The overlay CSS then targets `rect.raven-bg` instead of a colour
// allowlist, so new ggplot themes (theme_dark, theme_minimal, user-
// customized) work without an extra hex entry per theme.
//
// Negatives the heuristic must respect:
//   - Bar-chart bars (multiple rect siblings in a <g>) stay un-tagged.
//   - geom_rect() annotations carrying a stroke stay un-tagged.

import { describe, test, expect, beforeAll } from 'bun:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

beforeAll(() => {
    // Same jsdom-into-globalThis pattern the sanitize tests use. The
    // tagger relies on `globalThis.document` so it can create a
    // detached container element and walk parsed DOM.
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

const FIXTURE_PATH = resolve(
    (import.meta as unknown as { dir: string }).dir,
    '..',
    'fixtures',
    'httpgd',
    'plot-1-10.svg',
);

function parse_rects(svgText: string): Element[] {
    const dom = new JSDOM(`<!doctype html><html><body>${svgText}</body></html>`);
    return Array.from(dom.window.document.querySelectorAll('rect'));
}

describe('tag_background_rects — heuristic identifies canvas + panel rects', () => {
    test('httpgd fixture: both canvas rects gain class="raven-bg"; data circles untouched', () => {
        const fixture = readFileSync(FIXTURE_PATH, 'utf-8');
        const sanitized = sanitize_svg(fixture);
        const tagged = tag_background_rects(sanitized);
        const rects = parse_rects(tagged);
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        // Outer canvas (first-of-type direct child of <svg>) + inner
        // canvas (single rect under <g clip-path>, stroke=none) = 2.
        // The <clipPath><rect/></clipPath> defs rects sit under
        // <clipPath>, not under <g> or directly under <svg>, so the
        // heuristic skips them.
        expect(taggedRects.length).toBe(2);
        // Data circles aren't rects; the tagger never visits them.
        const dom = new JSDOM(`<!doctype html><html><body>${tagged}</body></html>`);
        const circles = Array.from(dom.window.document.querySelectorAll('circle'));
        expect(circles.length).toBeGreaterThan(0);
        for (const c of circles) {
            expect(c.classList.contains('raven-bg')).toBe(false);
        }
    });

    test('ggplot2 panel.background: outer canvas + panel rect both tagged regardless of fill', () => {
        // Synthetic mirror of ggplot2 theme_gray output: outer #FFFFFF
        // canvas + a single #EBEBEB panel.background rect alone in its
        // <g clip-path>. Note: the heuristic must NOT look at fill —
        // theme_dark's #7F7F7F or a user-customized colour would fail
        // an allowlist but pass the structural rules.
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
        // The <clipPath><rect/></clipPath> defs rect is not tagged —
        // its parent is <clipPath>, not <g> or <svg>.
        expect(taggedRects.length).toBe(2);
    });

    test('theme_dark()-style panel (fill=#7F7F7F, stroke=none alone in <g>) is tagged', () => {
        // Generalization probe: the WHOLE POINT of the heuristic is
        // that it works for ggplot2 themes the colour allowlist never
        // saw — theme_dark, theme_minimal (which has no panel bg at
        // all so nothing to tag), user-customized themes. #7F7F7F is
        // theme_dark's panel default.
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

    test('bar chart: multiple <rect> siblings in <g> are NOT tagged (data, not background)', () => {
        // ggplot2 geom_bar() with default colour=NA emits multiple
        // rects with stroke=none inside one clip-path <g>. A naive
        // "all stroke=none rects" rule would erase the bars; the
        // :only-of-type constraint of Rule 2 is what saves us.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#cp)">'
            + '<rect x="0" width="20" fill="#0000FF" stroke="none" />'
            + '<rect x="30" width="20" fill="#0000FF" stroke="none" />'
            + '<rect x="60" width="20" fill="#0000FF" stroke="none" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        // The outer canvas is still tagged (Rule 1 always applies).
        const taggedRects = rects.filter(r => r.classList.contains('raven-bg'));
        expect(taggedRects).toHaveLength(1);
        expect(taggedRects[0].getAttribute('width')).toBe('100%');
        // None of the inner bars are tagged.
        const bars = rects.filter(r => r.getAttribute('fill') === '#0000FF');
        expect(bars).toHaveLength(3);
        for (const bar of bars) {
            expect(bar.classList.contains('raven-bg')).toBe(false);
        }
    });

    test('geom_rect() annotation with stroke is NOT tagged even when alone in <g>', () => {
        // A deliberate single annotation rect with a stroke colour
        // (the typical geom_rect() shape when colour aesthetic is set)
        // looks structurally like a panel-bg under Rule 2 if we ignore
        // stroke. The stroke check is what distinguishes them.
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#FFFFFF" stroke="none" />'
            + '<g clip-path="url(#cp)">'
            + '<rect fill="#FF0000" stroke="#000000" />'
            + '</g>'
            + '</svg>';
        const out = tag_background_rects(input);
        const rects = parse_rects(out);
        const annotation = rects.find(r => r.getAttribute('fill') === '#FF0000');
        expect(annotation).toBeDefined();
        expect(annotation!.classList.contains('raven-bg')).toBe(false);
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
        // Defensive: sanitize_svg can hand us non-SVG text on malformed
        // input. The tagger must not silently corrupt that.
        const input = 'hello world';
        expect(tag_background_rects(input)).toBe(input);
    });
});
