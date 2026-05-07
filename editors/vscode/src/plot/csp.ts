/**
 * Derive the CSP source tokens (one HTTP(S) and one WS(S)) for an httpgd
 * origin that the webview will reach through `vscode.env.asExternalUri`.
 *
 * On a local host the mapping returns the loopback URL unchanged and the
 * loopback fallbacks already cover it. On remote hosts (SSH, WSL, Codespaces)
 * the mapping returns a tunnel origin like `https://abc-1234.<…>` which must
 * be allow-listed explicitly or the webview's `<img>`, `fetch`, and
 * `WebSocket` requests will be blocked by CSP and the viewer stays empty.
 *
 * Pure: no `vscode` dependency, so it can be unit-tested under Bun.
 */
export function csp_sources_for_external_base(externalBaseUrl: string): {
    http: string;
    ws: string;
} {
    try {
        const u = new URL(externalBaseUrl);
        const http_origin = `${u.protocol}//${u.host}`;
        const ws_proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws_origin = `${ws_proto}//${u.host}`;
        return { http: http_origin, ws: ws_origin };
    } catch {
        return { http: '', ws: '' };
    }
}
