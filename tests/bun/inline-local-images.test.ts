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

import { inlineLocalImagesAsDataUrls } from '../../editors/vscode/src/knit/inline-images';

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

    test('uses image/svg+xml for .svg', () => {
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
});
