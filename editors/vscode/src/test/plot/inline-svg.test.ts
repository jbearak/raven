import * as assert from 'assert';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as http from 'http';
import { RSessionServer } from '../../r-session-server';
import { PlotViewerPanel } from '../../plot/plot-viewer-panel';

/**
 * Pins the rendering-substrate invariant: the webview HTML does NOT
 * contain an `<img>` element and the toolbar carries the "Apply VS Code
 * theme" button. A future regression reverting to `<img>` would break
 * the toggle silently (CSS doesn't cascade into image-loaded SVG); this
 * test guards against that at the build artifact layer.
 *
 * Why bundle-string assertions rather than rendered DOM: vscode-test
 * doesn't expose the webview's runtime DOM. The bundle is a stable
 * proxy: the substrate decision (`<div class="plot-host">` vs `<img>`)
 * is baked into `App.svelte`, esbuild-svelte compiles it into the
 * bundle, and the bundle ships unchanged to the webview.
 */
suite('plot viewer substrate — inline SVG (not <img>)', () => {
    test('built webview bundle uses the plot-host div, not an <img>', async () => {
        const ext = vscode.extensions.getExtension('jbearak.raven-r')
            ?? vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.raven-r'));
        assert.ok(ext, 'raven extension should be installed in the test host');
        const bundleUri = vscode.Uri.joinPath(
            ext!.extensionUri,
            'dist',
            'webviews',
            'plot-viewer',
            'index.js',
        );
        const bytes = await vscode.workspace.fs.readFile(bundleUri);
        const bundle = new TextDecoder('utf-8').decode(bytes);
        // Substrate marker — minified, but the class name survives.
        assert.ok(
            bundle.includes('plot-host'),
            'webview bundle should contain the plot-host class name',
        );
        // The new toolbar button label.
        assert.ok(
            bundle.includes('Apply VS Code theme'),
            'webview bundle should advertise the toggle button',
        );
        // DOMPurify sanitization helper.
        assert.ok(
            bundle.includes('sanitize') && bundle.includes('FORBID_TAGS'),
            'webview bundle should include the DOMPurify sanitize call',
        );
    });

    test('PlotViewerPanel HTML does not list blob: or data: in img-src', async function () {
        // Cross-link with csp.test.ts but tied specifically to the
        // substrate change. CSP narrowing IS the contract that pins
        // the substrate: if a future change re-introduces blob: or
        // data:, it's probably because someone reverted to <img> for
        // the post-quit fallback, and the toggle would silently break.
        this.timeout(15000);
        const ext = vscode.extensions.getExtension('jbearak.raven-r')!;
        await ext.activate();

        const server = new RSessionServer();
        await server.start();
        const fake_httpgd = http.createServer((_req, res) => res.writeHead(200).end());
        await new Promise<void>(r => fake_httpgd.listen(0, '127.0.0.1', () => r()));
        const httpgdPort = (fake_httpgd.address() as { port: number }).port;
        try {
            const sessionId = crypto.randomBytes(8).toString('hex');
            await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-raven-session-token': server.token,
                },
                body: JSON.stringify({
                    sessionId,
                    httpgdHost: '127.0.0.1',
                    httpgdPort,
                    httpgdToken: 'tok',
                }),
            });
            const ctx = { extensionUri: ext.extensionUri } as unknown as vscode.ExtensionContext;
            const panel = new PlotViewerPanel(ctx, server, sessionId, 1, { onDisposed: () => {} });
            try {
                panel.notifyPlotAvailable();
                const html = await pollFor(() => {
                    const internal = panel as unknown as { panel: vscode.WebviewPanel | null };
                    const h = internal.panel?.webview.html ?? '';
                    return h.includes('Content-Security-Policy') ? h : null;
                }, 5000);
                assert.doesNotMatch(html, /img-src[^;]*\bblob:/, 'no blob: in img-src');
                assert.doesNotMatch(html, /img-src[^;]*\bdata:/, 'no data: in img-src');
                // The initial-render seed should be present.
                assert.match(
                    html,
                    /__ravenInitialPlotState = \{"themeApplied":(?:true|false)\};/,
                    'initial-state seed should be a literal JSON boolean',
                );
            } finally {
                panel.dispose();
            }
        } finally {
            await new Promise<void>(r => fake_httpgd.close(() => r()));
            await server.stop();
        }
    });
});

async function pollFor<T>(fn: () => T | null | undefined, timeout_ms: number): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
        const v = fn();
        if (v !== null && v !== undefined) return v;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`pollFor: timed out after ${timeout_ms}ms`);
}
