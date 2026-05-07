import { describe, test, expect } from 'bun:test';
import { csp_sources_for_external_base } from '../../editors/vscode/src/plot/csp';

describe('csp_sources_for_external_base', () => {
    test('derives http and ws origins from a loopback URL', () => {
        expect(csp_sources_for_external_base('http://127.0.0.1:7777')).toEqual({
            http: 'http://127.0.0.1:7777',
            ws: 'ws://127.0.0.1:7777',
        });
    });

    test('derives https and wss origins from a remote tunnel URL (asExternalUri output)', () => {
        // Models the URL VS Code returns for a remote host (SSH/WSL/Codespaces),
        // which the prior CSP didn't allow and which would block the webview's
        // <img>, fetch, and WebSocket calls.
        const r = csp_sources_for_external_base('https://abc-1234.tunnel.example.com');
        expect(r.http).toBe('https://abc-1234.tunnel.example.com');
        expect(r.ws).toBe('wss://abc-1234.tunnel.example.com');
    });

    test('returns empty strings for an unparseable base URL', () => {
        expect(csp_sources_for_external_base('')).toEqual({ http: '', ws: '' });
        expect(csp_sources_for_external_base('not a url')).toEqual({ http: '', ws: '' });
    });
});
