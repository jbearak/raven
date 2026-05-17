import { describe, test, expect } from 'bun:test';
import { buildShellHtml } from '../../editors/vscode/src/knit/knit-output';

const args = (outputPath: string, nonce = 'NONCE123') => ({
    iframeSrc: `https://webview.test${outputPath}`,
    cspSource: 'https://webview.test',
    outputPath,
    nonce,
});

describe('buildShellHtml', () => {
    test('CSP <meta> appears in <head>, before <body>', () => {
        const html = buildShellHtml(args('/work/report.html'));
        const cspIdx = html.indexOf('Content-Security-Policy');
        const bodyIdx = html.indexOf('<body');
        expect(cspIdx).toBeGreaterThan(0);
        expect(bodyIdx).toBeGreaterThan(0);
        expect(cspIdx).toBeLessThan(bodyIdx);
    });

    test('CSP contains nonce, frame-src, no default-src loophole', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain("default-src 'none'");
        expect(html).toContain('frame-src https://webview.test');
        expect(html).toContain("script-src 'nonce-NONCE123'");
        expect(html).toContain("connect-src 'none'");
    });

    test('iframe src is the supplied iframeSrc', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('src="https://webview.test/work/report.html"');
    });

    test('iframe sandbox attribute is empty (most restrictive)', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/<iframe\b[^>]*\bsandbox=""/);
    });

    test('toolbar contains refresh and open-in-browser buttons', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('id="raven-knit-refresh"');
        expect(html).toContain('id="raven-knit-open-browser"');
    });

    test('filename is HTML-escaped', () => {
        const html = buildShellHtml(args('/work/<script>alert(1)</script>.html'));
        expect(html).not.toContain('<script>alert(1)</script>.html');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.html');
    });

    test('toolbar script is nonce-tagged', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/<script\s+nonce="NONCE123">/);
    });
});
