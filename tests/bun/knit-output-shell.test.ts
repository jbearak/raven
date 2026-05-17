import { describe, test, expect } from 'bun:test';
import { buildShellHtml } from '../../editors/vscode/src/knit/knit-output';

const fakeWebview = {
    asWebviewUri: (uri: { fsPath: string }) =>
        `https://webview.test${uri.fsPath}`,
    cspSource: 'https://webview.test',
};

describe('buildShellHtml', () => {
    test('CSP <meta> appears in <head>, before <body>', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        const cspIdx = html.indexOf('Content-Security-Policy');
        const bodyIdx = html.indexOf('<body');
        expect(cspIdx).toBeGreaterThan(0);
        expect(bodyIdx).toBeGreaterThan(0);
        expect(cspIdx).toBeLessThan(bodyIdx);
    });

    test('CSP contains nonce, frame-src, no default-src loophole', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toContain("default-src 'none'");
        expect(html).toContain('frame-src https://webview.test');
        expect(html).toContain("script-src 'nonce-NONCE123'");
        expect(html).toContain("connect-src 'none'");
    });

    test('iframe src is asWebviewUri of the output path', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toContain('src="https://webview.test/work/report.html"');
    });

    test('iframe sandbox attribute is empty (most restrictive)', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        // Note: sandbox="" (empty string) is the strictest mode. Be exact.
        expect(html).toMatch(/<iframe\b[^>]*\bsandbox=""/);
    });

    test('toolbar contains refresh and open-in-browser buttons', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toContain('id="raven-knit-refresh"');
        expect(html).toContain('id="raven-knit-open-browser"');
    });

    test('filename is HTML-escaped', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/<script>alert(1)</script>.html',
            nonce: 'NONCE123',
        });
        // The basename appears in the title attribute and the toolbar span.
        // Verify the raw "<script>" substring does NOT appear in the HTML.
        expect(html).not.toContain('<script>alert(1)</script>.html');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.html');
    });

    test('toolbar script is nonce-tagged', () => {
        const html = buildShellHtml({
            webview: fakeWebview as any,
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
        });
        expect(html).toMatch(/<script\s+nonce="NONCE123">/);
    });
});
