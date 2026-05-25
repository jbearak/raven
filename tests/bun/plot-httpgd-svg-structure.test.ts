// Two-layer regression test for the CSS overlay's load-bearing
// structural assumption — see spec
// `docs/superpowers/specs/2026-05-25-plot-viewer-vscode-theme-toggle-design.md`
// §Test plan.
//
// Layer 1 (always runs): parse a checked-in fixture captured from an
// `httpgd` plot of `plot(1:10)` and assert (a) the root <svg> carries
// the `httpgd` class token AND (b) the first ELEMENT child of the
// root is a <rect>. The CSS overlay selector `svg.httpgd >
// rect:first-of-type` depends on both. A failing assertion means
// either our parser/selectors drifted, OR the fixture is stale
// relative to a new httpgd output shape.
//
// Layer 2 (sandbox-skipped, runs in normal local/CI): boot an R
// subprocess + httpgd, render a fresh plot, assert the same contract
// against the live SVG. If httpgd ever changes its output shape, this
// fails BEFORE the fixture goes stale. Not implemented in this commit
// — first ship the fixture as the always-running guard, then add the
// live layer once the R-subprocess test harness is wired in. The
// fixture layer alone catches our own selector / parser drift; the
// live layer adds the upstream-httpgd guardrail.

import { describe, test, expect } from 'bun:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURE_PATH = resolve(
    import.meta.dir,
    '..',
    'fixtures',
    'httpgd',
    'plot-1-10.svg',
);

function load_fixture(): string {
    return readFileSync(FIXTURE_PATH, 'utf-8');
}

function parse_svg(text: string): SVGSVGElement {
    // jsdom needs an HTML host page; embed the SVG inside it so the
    // parsed `<svg>` lives in the document tree.
    const dom = new JSDOM(`<!doctype html><html><body>${text}</body></html>`);
    const svg = dom.window.document.querySelector('svg');
    if (!svg) throw new Error('parse_svg: no <svg> in fixture');
    return svg as unknown as SVGSVGElement;
}

describe('httpgd SVG structure — fixture layer', () => {
    test('fixture file is readable and non-empty', () => {
        const text = load_fixture();
        expect(text.length).toBeGreaterThan(100);
        expect(text).toContain('<svg');
    });

    test('root <svg> carries the `httpgd` class token (load-bearing for the overlay selector)', () => {
        // The CSS overlay matches `svg.httpgd > rect:first-of-type`,
        // i.e. class-token matching, not exact string-equality. Use
        // classList.contains so a future benign httpgd whitespace
        // change (e.g. `class="httpgd foo"`) does NOT break CI for
        // no real reason.
        const svg = parse_svg(load_fixture());
        const classList = (svg as unknown as { classList: DOMTokenList }).classList;
        expect(classList.contains('httpgd')).toBe(true);
    });

    test('first ELEMENT child of <svg> is a <rect> (load-bearing for the canvas-rect hide rule)', () => {
        const svg = parse_svg(load_fixture());
        // `firstElementChild` skips text/whitespace nodes — the exact
        // semantic the CSS selector `> rect:first-of-type` produces.
        const first = (svg as unknown as { firstElementChild: Element | null })
            .firstElementChild;
        expect(first).not.toBeNull();
        expect(first!.tagName.toLowerCase()).toBe('rect');
    });

    test('viewBox attribute is preserved (load-bearing for responsive scaling under inline SVG)', () => {
        const svg = parse_svg(load_fixture());
        const vb = svg.getAttribute('viewBox');
        expect(vb).not.toBeNull();
        // Don't pin exact dimensions — httpgd output sizes vary with
        // the request. Just check the shape: four space-separated
        // numbers.
        expect(vb).toMatch(/^[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+$/);
    });

    test('fixture survives sanitize_svg with the structural contract intact', async () => {
        // End-to-end integration: the fixture, after passing through
        // sanitize_svg (which strips <script>/<style>/etc. and inline
        // `style=` attrs), MUST still satisfy the overlay's
        // structural contract — otherwise toggling the theme on a
        // fresh httpgd output would produce a broken render.
        //
        // Load sanitize via dynamic import + beforeAll-style DOM
        // priming, same as plot-webview-sanitize.test.ts.
        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        const g = globalThis as Record<string, unknown>;
        g.window = dom.window;
        g.document = dom.window.document;
        g.Node = dom.window.Node;
        g.NodeFilter = dom.window.NodeFilter;
        g.HTMLElement = dom.window.HTMLElement;
        g.SVGElement = dom.window.SVGElement;
        g.DocumentFragment = dom.window.DocumentFragment;
        const { sanitize_svg } = await import('../../editors/vscode/src/plot/webview/sanitize');
        const sanitized = sanitize_svg(load_fixture());
        const svg = parse_svg(sanitized);
        const classList = (svg as unknown as { classList: DOMTokenList }).classList;
        expect(classList.contains('httpgd')).toBe(true);
        const first = (svg as unknown as { firstElementChild: Element | null })
            .firstElementChild;
        expect(first).not.toBeNull();
        expect(first!.tagName.toLowerCase()).toBe('rect');
    });
});
