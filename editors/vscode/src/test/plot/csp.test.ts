import * as assert from 'assert';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as http from 'http';
import { RSessionServer } from '../../r-session-server';
import { PlotViewerPanel } from '../../plot/plot-viewer-panel';
import { csp_sources_for_external_base } from '../../plot/csp';

/**
 * Confirms the local-host invariant the unit tests can't reach: that
 * `vscode.env.asExternalUri` leaves loopback URIs on a loopback authority,
 * and that the resulting CSP includes loopback origins so the webview can
 * fetch images, list plots, and open the WebSocket without "Refused to
 * connect/load" violations.
 */
suite('plot viewer CSP — local host', () => {
    test('asExternalUri keeps a loopback URI on loopback', async () => {
        const out = await vscode.env.asExternalUri(
            vscode.Uri.parse('http://127.0.0.1:7777'),
        );
        // On a local extension host the API contract is that the URI is
        // returned unchanged. Allow `localhost` / IPv6 loopback as well so
        // the test isn't brittle across VS Code versions.
        const authority = out.authority;
        const isLoopback =
            authority.startsWith('127.0.0.1:') ||
            authority.startsWith('localhost:') ||
            authority.startsWith('[::1]:');
        assert.ok(
            isLoopback,
            `expected loopback authority, got ${authority} (${out.toString()})`,
        );
        const sources = csp_sources_for_external_base(out.toString(true).replace(/\/$/, ''));
        assert.ok(sources.http.startsWith('http://'));
        assert.ok(sources.ws.startsWith('ws://'));
    });

    test('PlotViewerPanel HTML CSP allows loopback http and ws', async () => {
        const ext = vscode.extensions.getExtension('jbearak.raven-r')
            ?? vscode.extensions.all.find(e => e.id.toLowerCase().endsWith('.raven-r'));
        assert.ok(ext, 'raven extension should be installed in the test host');
        await ext!.activate();

        // Real session server + a fake httpgd listener so /session-ready is
        // accepted and the panel has a session to derive CSP from.
        const server = new RSessionServer();
        await server.start();
        const fake_httpgd = http.createServer((_req, res) => res.writeHead(200).end());
        await new Promise<void>(r => fake_httpgd.listen(0, '127.0.0.1', () => r()));
        const httpgdPort = (fake_httpgd.address() as { port: number }).port;
        const sessionId = crypto.randomBytes(8).toString('hex');
        const ready = await fetch(`http://127.0.0.1:${server.port}/session-ready`, {
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
        assert.strictEqual(ready.status, 200);

        // Minimal ExtensionContext stub — PlotViewerPanel only reads
        // extensionUri to compute localResourceRoots and webview asset URIs.
        const ctx = { extensionUri: ext!.extensionUri } as unknown as vscode.ExtensionContext;
        const panel = new PlotViewerPanel(ctx, server, sessionId, 1, { onDisposed: () => {} });
        try {
            // Drive a /plot-available event so notifyPlotAvailable creates the panel.
            const avail = await fetch(`http://127.0.0.1:${server.port}/plot-available`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-raven-session-token': server.token,
                },
                body: JSON.stringify({ sessionId, hsize: 1, upid: 1 }),
            });
            assert.strictEqual(avail.status, 200);
            panel.notifyPlotAvailable();

            // Wait for create_panel's awaited asExternalUri to resolve and the
            // webview HTML to be set. notifyPlotAvailable is fire-and-forget.
            const html = await pollFor(() => {
                const internal = panel as unknown as { panel: vscode.WebviewPanel | null };
                const h = internal.panel?.webview.html ?? '';
                return h.includes('Content-Security-Policy') ? h : null;
            }, 5000);

            const cspMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
            assert.ok(cspMatch, 'CSP meta tag should be present');
            const csp = cspMatch![1];
            assert.match(csp, /img-src[^;]*http:\/\/127\.0\.0\.1:\*/, 'img-src allows loopback http');
            assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/, 'connect-src allows loopback http');
            assert.match(csp, /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/, 'connect-src allows loopback ws');
        } finally {
            panel.dispose();
            await new Promise<void>(r => fake_httpgd.close(() => r()));
            await server.stop();
        }
    });
});

async function pollFor<T>(fn: () => T | null, timeout_ms: number): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
        const v = fn();
        if (v !== null && v !== undefined) return v;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`pollFor: timed out after ${timeout_ms}ms`);
}
