/** Build the Content-Security-Policy header for the data-viewer webview.
 *
 *  Returns both the `<meta>` content string and the per-load nonce that
 *  must be applied to script tags. */
import * as crypto from 'crypto';
import type * as vscode from 'vscode';

export function build_csp(webview: vscode.Webview): { csp: string; nonce: string } {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');
    return { csp, nonce };
}
