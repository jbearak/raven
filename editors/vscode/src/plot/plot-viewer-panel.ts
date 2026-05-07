import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
    ExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
    SaveFormat,
} from './messages';
import { PlotSessionServer } from './session-server';
import { download_to_buffer } from './http-download';
import { csp_sources_for_external_base } from './csp';

type ViewerColumn = 'active' | 'beside';

function reveal_view_column(setting: ViewerColumn): vscode.ViewColumn {
    return setting === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
}

function build_html(
    webview: vscode.Webview,
    extension_uri: vscode.Uri,
    nonce: string,
    externalBaseUrl: string,
): string {
    const js_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'plot-viewer', 'index.js'),
    );
    const css_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'plot-viewer', 'index.css'),
    );
    // Loopback hosts must match those accepted by PlotSessionServer for
    // httpgdHost (see session-server.ts allowedHosts): 127.0.0.1, localhost,
    // and ::1. If the CSP omits one, webview fetches and websocket connects
    // to that host fail silently.
    const loopbackHttp = 'http://127.0.0.1:* http://localhost:* http://[::1]:*';
    const loopbackWs = 'ws://127.0.0.1:* ws://localhost:* ws://[::1]:*';
    const external = csp_sources_for_external_base(externalBaseUrl);
    const imgSrc = `${webview.cspSource} ${loopbackHttp} ${external.http} data:`.trim();
    const connectSrc = `${loopbackHttp} ${loopbackWs} ${external.http} ${external.ws}`
        .replace(/\s+/g, ' ')
        .trim();
    const csp = [
        `default-src 'none'`,
        `img-src ${imgSrc}`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `connect-src ${connectSrc}`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${css_uri}" />
    <title>Raven Plot Viewer</title>
</head>
<body>
    <script nonce="${nonce}" src="${js_uri}"></script>
</body>
</html>`;
}

export interface PlotViewerPanelOptions {
    /** Called once after the underlying webview disposes (user closed it,
     *  or VS Code shut down). Gives the owner a chance to drop its reference. */
    onDisposed: () => void;
}

/**
 * One webview panel bound to a single R session. Lifetimes:
 *   - Created lazily by `PlotServices` on the first /plot-available event for
 *     this session.
 *   - Reveals once on creation in raven.plot.viewerColumn (preserveFocus).
 *   - Subsequent plots from the same session post a state-update; the panel
 *     stays where the user put it.
 *   - User-closed panels invoke `onDisposed`; the next plot from the same
 *     session creates a fresh panel via `PlotServices`.
 */
export class PlotViewerPanel {
    private panel: vscode.WebviewPanel | null = null;
    private theme_sub: vscode.Disposable | null = null;
    /** httpgd base URL after `vscode.env.asExternalUri` mapping. Computed
     *  once when the panel is created so the CSP and the URLs sent to the
     *  webview stay consistent. Equal to the loopback URL on local hosts. */
    private external_base_url: string | null = null;
    private ensure_panel_in_flight: Promise<void> | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly server: PlotSessionServer,
        private readonly sessionId: string,
        private readonly panelIndex: number,
        private readonly options: PlotViewerPanelOptions,
    ) {}

    /** Reveal the panel (creating it if needed) and push the current state. */
    notifyPlotAvailable(): void {
        void this.ensure_panel().then(() => this.post_state_update());
    }

    /** Push state-update so the webview can show the "session ended" banner.
     *  Does not create a panel if none exists yet. */
    notifySessionEnded(): void {
        this.post_state_update();
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = null;
        this.theme_sub?.dispose();
        this.theme_sub = null;
    }

    private async ensure_panel(): Promise<void> {
        if (this.panel) return;
        if (this.ensure_panel_in_flight) return this.ensure_panel_in_flight;
        this.ensure_panel_in_flight = this.create_panel().finally(() => {
            this.ensure_panel_in_flight = null;
        });
        return this.ensure_panel_in_flight;
    }

    private async create_panel(): Promise<void> {
        // Compute the externally-reachable httpgd base URL once and reuse it
        // for both the CSP allow-list and every URL we post to the webview,
        // so they cannot drift. On a local host this is the loopback URL
        // unchanged; on a remote host (SSH, WSL, Codespaces) it's the
        // tunnel origin assigned by VS Code.
        const session = this.server.getSession(this.sessionId);
        if (session && this.external_base_url === null) {
            const mapped = await vscode.env.asExternalUri(vscode.Uri.parse(session.httpgdBaseUrl));
            // Strip a trailing slash that vscode.Uri may add, so that
            // `${base}/plot` keeps the same shape as before.
            this.external_base_url = mapped.toString(true).replace(/\/$/, '');
        }
        const config = vscode.workspace.getConfiguration('raven.plot');
        const column_setting = config.get<ViewerColumn>('viewerColumn', 'beside');
        const title = this.panelIndex === 1
            ? 'Raven Plot Viewer'
            : `Raven Plot Viewer ${this.panelIndex}`;
        const panel = vscode.window.createWebviewPanel(
            'raven.plotViewer',
            title,
            { viewColumn: reveal_view_column(column_setting), preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'plot-viewer'),
                ],
            },
        );
        const nonce = crypto.randomBytes(16).toString('base64');
        panel.webview.html = build_html(
            panel.webview,
            this.context.extensionUri,
            nonce,
            this.external_base_url ?? '',
        );
        panel.webview.onDidReceiveMessage((msg) => this.on_webview_message(msg));
        panel.onDidDispose(() => {
            this.panel = null;
            this.theme_sub?.dispose();
            this.theme_sub = null;
            this.options.onDisposed();
        });
        this.theme_sub = vscode.window.onDidChangeActiveColorTheme(() => {
            this.post(this.panel, { type: 'theme-changed', payload: {} });
        });
        this.panel = panel;
    }

    private post_state_update(): void {
        if (!this.panel) return;
        const session = this.server.getSession(this.sessionId);
        // The mapped URL is computed once at panel creation. The CSP in the
        // webview HTML was generated against the same value, so the webview
        // can always fetch/connect to whatever we post here.
        const externalBaseUrl = this.external_base_url ?? session?.httpgdBaseUrl ?? '';
        this.post(this.panel, {
            type: 'state-update',
            payload: {
                activeSession: session
                    ? {
                          sessionId: session.sessionId,
                          httpgdBaseUrl: externalBaseUrl,
                          httpgdToken: session.httpgdToken,
                          upid: session.lastUpid,
                      }
                    : null,
                sessionEnded: session?.ended ?? false,
            },
        });
    }

    private post(panel: vscode.WebviewPanel | null, msg: ExtensionToWebviewMessage): void {
        panel?.webview.postMessage(msg);
    }

    private on_webview_message(msg: unknown) {
        if (!isWebviewToExtensionMessage(msg)) return;
        switch (msg.type) {
            case 'webview-ready':
                this.post_state_update();
                break;
            case 'request-save-plot':
                this.handle_save(msg.payload.plotId, msg.payload.format).catch(err => {
                    vscode.window.showErrorMessage(`Raven: failed to save plot — ${err}`);
                });
                break;
            case 'request-open-externally':
                this.handle_open_externally(msg.payload.plotId).catch(err => {
                    vscode.window.showErrorMessage(`Raven: open externally failed — ${err}`);
                });
                break;
            case 'report-error':
                console.warn('[Raven plot webview]', msg.payload.message);
                break;
        }
    }

    private async handle_save(plot_id: string, format: SaveFormat): Promise<void> {
        const session = this.server.getSession(this.sessionId);
        if (!session) return;
        const filters: Record<string, string[]> = {
            PNG: ['png'], SVG: ['svg'], PDF: ['pdf'],
        };
        const default_name = `plot-${Date.now()}.${format}`;
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(this.suggested_dir(), default_name)),
            filters,
        });
        if (!target) return;
        // Fixed export dimensions (1200x900) decouple saved file resolution from
        // the live preview viewport, so saved plots have consistent quality
        // regardless of how the user has the panel sized.
        const cacheBuster = session.lastUpid > 0
            ? `&c=${session.lastUpid}`
            : '';
        const url = `${session.httpgdBaseUrl}/plot?id=${encodeURIComponent(plot_id)}` +
            `&renderer=${format}&width=1200&height=900` +
            `&token=${encodeURIComponent(session.httpgdToken)}${cacheBuster}`;
        // Use Node's http/https modules instead of the global `fetch`, which
        // is not available on the Node 16 runtime shipped by VS Code 1.75
        // (see engines.vscode in package.json).
        const buf = await download_to_buffer(url);
        await fs.writeFile(target.fsPath, buf);
    }

    private async handle_open_externally(plot_id: string): Promise<void> {
        const session = this.server.getSession(this.sessionId);
        if (!session) return;
        // Use the externally-reachable URL computed at panel creation so the
        // user's local browser opens the forwarded port on remote hosts
        // (SSH, WSL, Codespaces) instead of an unreachable loopback.
        const externalBase = this.external_base_url ?? session.httpgdBaseUrl;
        const cacheBuster = session.lastUpid > 0
            ? `&c=${session.lastUpid}`
            : '';
        const url = `${externalBase}/plot?id=${encodeURIComponent(plot_id)}` +
            `&renderer=svg&token=${encodeURIComponent(session.httpgdToken)}${cacheBuster}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private suggested_dir(): string {
        const ws = vscode.workspace.workspaceFolders?.[0];
        return ws ? ws.uri.fsPath : (process.env.HOME ?? process.cwd());
    }
}
