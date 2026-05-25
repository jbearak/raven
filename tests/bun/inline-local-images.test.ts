/**
 * Unit tests for `inlineLocalImagesAsDataUrls`. The function is the
 * workaround for the nested-iframe subresource issue in the Knit
 * Output panel: VS Code's webview resource handler does not intercept
 * subresource fetches from a nested `<iframe srcdoc>`, so the
 * webview-resource URL the `<base>` resolves an `<img src>` to
 * escapes the protocol handler and fails with a real DNS lookup.
 * Inlining the image bytes as `data:` URLs sidesteps the handler.
 *
 * The tests cover what the function MUST and MUST NOT rewrite, so a
 * future refactor can re-implement it freely (regex → parser, etc.)
 * as long as the contract holds.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    inlineLocalImagesAsDataUrls,
    KNIT_PLOT_SVG_CLASS,
    __resetSvgHostContextForTest,
} from '../../editors/vscode/src/knit/inline-images';

function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-inline-img-'));
    try {
        return fn(dir);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
}

// Smallest valid 1×1 transparent PNG.
const TINY_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c63000100000005000174ec61e30000' +
    '0000049454e44ae426082',
    'hex',
);

describe('inlineLocalImagesAsDataUrls', () => {
    test('replaces a relative <img src> with a data: URL', () => {
        withTempDir((dir) => {
            const figDir = path.join(dir, 'figure');
            fs.mkdirSync(figDir, { recursive: true });
            fs.writeFileSync(path.join(figDir, 'plot-1.png'), TINY_PNG);

            const html = '<p><img src="figure/plot-1.png" alt="x" data-src="figure/plot-1.png"></p>';
            const out = inlineLocalImagesAsDataUrls(html, dir);

            expect(out).toContain('src="data:image/png;base64,');
            // The unmodified `data-src` attribute and the `alt`
            // attribute MUST survive — only `src` is rewritten.
            expect(out).toContain('alt="x"');
            expect(out).toContain('data-src="figure/plot-1.png"');
        });
    });

    test('leaves absolute http/https URLs alone', () => {
        const html = '<img src="https://example.com/x.png">';
        expect(inlineLocalImagesAsDataUrls(html, '/no/such/dir')).toBe(html);
    });

    test('leaves data: URLs alone', () => {
        const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
        expect(inlineLocalImagesAsDataUrls(html, '/no/such/dir')).toBe(html);
    });

    test('leaves vscode-webview / file URLs alone', () => {
        const html1 = '<img src="vscode-webview://abc/x.png">';
        const html2 = '<img src="file:///etc/hosts">';
        expect(inlineLocalImagesAsDataUrls(html1, '/tmp')).toBe(html1);
        expect(inlineLocalImagesAsDataUrls(html2, '/tmp')).toBe(html2);
    });

    test('leaves protocol-relative URLs alone', () => {
        const html = '<img src="//cdn.example/x.png">';
        expect(inlineLocalImagesAsDataUrls(html, '/tmp')).toBe(html);
    });

    test('leaves absolute filesystem paths alone', () => {
        const html = '<img src="/usr/share/icons/x.png">';
        expect(inlineLocalImagesAsDataUrls(html, '/tmp')).toBe(html);
    });

    test('rejects path traversal — does NOT read files outside the doc dir', () => {
        withTempDir((dir) => {
            const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-outside-'));
            try {
                const secret = path.join(outsideDir, 'secret.png');
                fs.writeFileSync(secret, TINY_PNG);
                const innerDir = path.join(dir, 'inner');
                fs.mkdirSync(innerDir);

                // Resolves to outside the doc dir via `..` walks
                const html = `<img src="../../${path.relative(path.dirname(dir), secret)}">`;
                const out = inlineLocalImagesAsDataUrls(html, innerDir);
                // The src should remain its original (untrusted)
                // value — NOT be replaced with the secret file's
                // base64.
                expect(out).toContain('<img src="../../');
                expect(out).not.toContain('data:image/png;base64,');
            } finally {
                try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        });
    });

    test('leaves missing files alone (no throw, src untouched)', () => {
        withTempDir((dir) => {
            const html = '<img src="figure/does-not-exist.png">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            expect(out).toBe(html);
        });
    });

    test('leaves unknown extensions alone', () => {
        withTempDir((dir) => {
            fs.writeFileSync(path.join(dir, 'mystery.xyz'), TINY_PNG);
            const html = '<img src="mystery.xyz">';
            expect(inlineLocalImagesAsDataUrls(html, dir)).toBe(html);
        });
    });

    test('uses image/svg+xml data URL for user-included .svg outside figure/', () => {
        // SVGs the user references in their Rmd (logos, icons, etc.) that
        // are NOT under `figure/` keep their data-URL path. The inline-SVG
        // substitution is scoped to knit-emitted plots, so user-included
        // images preserve their original colors and fragment-identifier
        // semantics.
        withTempDir((dir) => {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
            fs.writeFileSync(path.join(dir, 'icon.svg'), svg);
            const html = '<img src="icon.svg">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            expect(out).toContain('src="data:image/svg+xml;base64,');
        });
    });

    test('handles multiple <img> tags in the same document', () => {
        withTempDir((dir) => {
            fs.mkdirSync(path.join(dir, 'figure'));
            fs.writeFileSync(path.join(dir, 'figure', 'a.png'), TINY_PNG);
            fs.writeFileSync(path.join(dir, 'figure', 'b.png'), TINY_PNG);
            const html =
                '<img src="figure/a.png" alt="A">' +
                '<p>text</p>' +
                '<img src="figure/b.png" alt="B">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            const matches = out.match(/data:image\/png;base64,/g) ?? [];
            expect(matches.length).toBe(2);
            expect(out).toContain('alt="A"');
            expect(out).toContain('alt="B"');
        });
    });

    test('leaves <img> with no src alone', () => {
        const html = '<img alt="no-src">';
        expect(inlineLocalImagesAsDataUrls(html, '/tmp')).toBe(html);
    });

    test('trims a leading ./ before resolving', () => {
        withTempDir((dir) => {
            fs.mkdirSync(path.join(dir, 'figure'));
            fs.writeFileSync(path.join(dir, 'figure', 'p.png'), TINY_PNG);
            const html = '<img src="./figure/p.png">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            expect(out).toContain('src="data:image/png;base64,');
        });
    });

    test('inlines through a ?query cache-buster suffix', () => {
        // htmlwidgets and similar markdown renderers append a
        // version-style query to defeat HTTP caching. With the
        // suffix landing inside `path.extname`, the inline pass
        // used to bail out (MIME lookup fails on `.png?v=1`) and
        // the broken-image icon appeared in the nested iframe.
        // Splitting on `?` recovers the real file path.
        withTempDir((dir) => {
            fs.mkdirSync(path.join(dir, 'figure'));
            fs.writeFileSync(path.join(dir, 'figure', 'plot.png'), TINY_PNG);
            const html = '<img src="figure/plot.png?v=1">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            expect(out).toContain('src="data:image/png;base64,');
            // The query suffix rides along on the data URL. It's
            // meaningless to a data URL processor but harmless
            // (and it preserves round-trip fidelity if anything
            // downstream inspects the URL).
            expect(out).toMatch(/src="data:image\/png;base64,[^"]+\?v=1"/);
        });
    });

    test('preserves a #fragment suffix on the rewritten data URL', () => {
        // `<img src="diagram.svg#layer-1">` is a real SVG view
        // identifier — browsers honor fragments on SVG `img`
        // sources to scroll to a named `<view>` element. The
        // fragment MUST survive the inline rewrite or the
        // panel's rendering of the image will differ from the
        // standalone HTML opened in a browser.
        withTempDir((dir) => {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' +
                '<view id="layer-1" viewBox="0 0 1 1"/></svg>';
            fs.writeFileSync(path.join(dir, 'diagram.svg'), svg);
            const html = '<img src="diagram.svg#layer-1">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            expect(out).toContain('src="data:image/svg+xml;base64,');
            expect(out).toMatch(/src="data:image\/svg\+xml;base64,[^"]+#layer-1"/);
        });
    });

    test('handles both ?query and #fragment together', () => {
        // Cover the case where both appear (`?v=1#frag`). We
        // split on the first `?` or `#` so the entire suffix
        // (`?v=1#frag`) rides along on the data URL.
        withTempDir((dir) => {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
            fs.writeFileSync(path.join(dir, 'icon.svg'), svg);
            const html = '<img src="icon.svg?v=1#frag">';
            const out = inlineLocalImagesAsDataUrls(html, dir);
            expect(out).toContain('src="data:image/svg+xml;base64,');
            expect(out).toMatch(/src="data:image\/svg\+xml;base64,[^"]+\?v=1#frag"/);
        });
    });

    // -----------------------------------------------------------------
    // Inline-SVG path for knit-emitted figures
    //
    // SVGs under <docDir>/figure/ flow through DOMPurify sanitization
    // + structural background-rect tagging and land in the rendered HTML
    // as inline `<svg class="raven-knit-plot">` markup, NOT as
    // `<img src="data:image/svg+xml...">`. This is what enables the Knit
    // Output panel's "Apply VS Code theme" toggle to recolor plot text
    // and strokes via CSS overlay — parent CSS does not cascade into
    // `<img>`-loaded SVG regardless of the URL scheme.
    // -----------------------------------------------------------------

    describe('inline SVG for knit-emitted figures (figure/*.svg)', () => {
        // Sample plot SVG that exercises the bg-rect tagging rules from
        // `tag-backgrounds.ts`:
        //   - The first <rect> child of <svg> is the outer canvas (Rule 1).
        //   - A <rect> direct child of <g> with no stroke-linejoin/linecap
        //     is a panel background (Rule 2).
        //   - A <rect> with stroke-linejoin / stroke-linecap is a data rect.
        const PLOT_SVG =
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
            '<rect width="100" height="100" fill="#fff"/>' + // outer canvas (bg)
            '<g>' +
            '<rect x="10" y="10" width="80" height="80" fill="#eee"/>' + // panel bg
            '<rect x="20" y="20" width="20" height="40" fill="steelblue" ' +
            'stroke="black" stroke-linejoin="miter" stroke-linecap="butt"/>' + // data bar
            '<line x1="10" y1="50" x2="90" y2="50" stroke="black"/>' +
            '<text x="50" y="95" text-anchor="middle">x</text>' +
            '</g>' +
            '</svg>';

        test('replaces a figure/*.svg <img> with inline <svg class="raven-knit-plot">', () => {
            __resetSvgHostContextForTest();
            withTempDir((dir) => {
                fs.mkdirSync(path.join(dir, 'figure'));
                fs.writeFileSync(path.join(dir, 'figure', 'plot-1.svg'), PLOT_SVG);

                const html = '<p><img src="figure/plot-1.svg" alt="A"></p>';
                const out = inlineLocalImagesAsDataUrls(html, dir);

                // The wrapping <img> tag is gone — replaced with the SVG itself.
                expect(out).not.toContain('<img src="figure/plot-1.svg"');
                expect(out).not.toContain('data:image/svg+xml');
                // The class lives on the root <svg>; CSS in
                // knit-output.ts:applyTheme() scopes its recoloring rules
                // to this selector.
                expect(out).toContain(`class="${KNIT_PLOT_SVG_CLASS}"`);
                // Structural tagger should have tagged the outer canvas
                // and the panel background, but NOT the bar (which has
                // stroke-linejoin + stroke-linecap).
                expect(out).toMatch(/<rect[^>]*class="[^"]*raven-bg/);
                const ravenBgMatches = out.match(/class="[^"]*raven-bg/g) ?? [];
                expect(ravenBgMatches.length).toBe(2);
            });
        });

        test('strips dangerous content from the inlined SVG (defense in depth)', () => {
            __resetSvgHostContextForTest();
            withTempDir((dir) => {
                fs.mkdirSync(path.join(dir, 'figure'));
                const dirty =
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
                    '<script>window.alert(1)</script>' +
                    '<style>@import url("//evil/?cookie")</style>' +
                    '<a href="javascript:1"><rect width="1" height="1"/></a>' +
                    '<rect width="1" height="1" style="background:url(//evil/?bg)"/>' +
                    '<foreignObject><iframe src="//evil/"></iframe></foreignObject>' +
                    '</svg>';
                fs.writeFileSync(path.join(dir, 'figure', 'plot.svg'), dirty);
                const out = inlineLocalImagesAsDataUrls('<img src="figure/plot.svg">', dir);

                // No script, no <style>, no foreignObject — DOMPurify
                // FORBID_TAGS strips them. No `style=` attribute either
                // (FORBID_ATTR).
                expect(out).not.toContain('<script');
                expect(out).not.toContain('<style');
                expect(out).not.toContain('<foreignObject');
                expect(out).not.toContain('<iframe');
                expect(out).not.toMatch(/\sstyle\s*=/i);
                expect(out).not.toContain('javascript:');
            });
        });

        test('leaves <img> in place when the SVG read fails', () => {
            __resetSvgHostContextForTest();
            withTempDir((dir) => {
                // No file written, but the path looks like a knit figure.
                const html = '<img src="figure/missing.svg">';
                const out = inlineLocalImagesAsDataUrls(html, dir);
                expect(out).toBe(html);
            });
        });

        test('handles multiple knit-plot SVGs in one document', () => {
            __resetSvgHostContextForTest();
            withTempDir((dir) => {
                fs.mkdirSync(path.join(dir, 'figure'));
                fs.writeFileSync(path.join(dir, 'figure', 'a.svg'), PLOT_SVG);
                fs.writeFileSync(path.join(dir, 'figure', 'b.svg'), PLOT_SVG);
                const html =
                    '<img src="figure/a.svg" alt="A"><p>text</p><img src="figure/b.svg" alt="B">';
                const out = inlineLocalImagesAsDataUrls(html, dir);

                const svgMatches = out.match(/<svg\b[^>]*class="[^"]*raven-knit-plot/g) ?? [];
                expect(svgMatches.length).toBe(2);
                expect(out).not.toContain('<img src="figure/');
            });
        });

        test('idempotent class addition when the SVG already has the class', () => {
            __resetSvgHostContextForTest();
            withTempDir((dir) => {
                fs.mkdirSync(path.join(dir, 'figure'));
                const preMarked = PLOT_SVG.replace(
                    '<svg ',
                    `<svg class="${KNIT_PLOT_SVG_CLASS}" `,
                );
                fs.writeFileSync(path.join(dir, 'figure', 'plot.svg'), preMarked);
                const out = inlineLocalImagesAsDataUrls('<img src="figure/plot.svg">', dir);

                // The class is present exactly once in the root <svg>'s class attr.
                const rootClassMatch = out.match(/<svg\b[^>]*class="([^"]*)"/);
                expect(rootClassMatch).not.toBeNull();
                const tokens = rootClassMatch![1].split(/\s+/).filter(Boolean);
                expect(tokens.filter((t) => t === KNIT_PLOT_SVG_CLASS).length).toBe(1);
            });
        });
    });
});
