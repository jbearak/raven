import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
    ExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
    SaveFormat,
} from './messages';
import { PlotEvent, PlotSessionServer } from './session-server';

type ViewerColumn = 'active' | 'beside';

function reveal_view_column(setting: ViewerColumn): vscode.ViewColumn {
    return setting === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
}

function build_html(webview: vscode.Webview, extension_uri: vscode.Uri, nonce: string): string {
    const js_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'plot-viewer', 'index.js'),
    );
    const css_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'plot-viewer', 'index.css'),
    );
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} http://127.0.0.1:* data:`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `connect-src http://127.0.0.1:* ws://127.0.0.1:*`,
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

export class PlotViewerPanel {
    private panel: vscode.WebviewPanel | null = null;
    private theme_sub: vscode.Disposable | null = null;
    private detach_session_listener: (() => void) | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly server: PlotSessionServer,
    ) {}

    attach() {
        this.detach_session_listener = this.server.onEvent(e => this.on_server_event(e));
    }

    dispose() {
        this.detach_session_listener?.();
        this.detach_session_listener = null;
        this.panel?.dispose();
        this.panel = null;
        this.theme_sub?.dispose();
        this.theme_sub = null;
    }

    private on_server_event(event: PlotEvent) {
        if (event.type === 'plot-available') {
            this.ensure_panel();
            this.post_state_update();
        } else if (event.type === 'session-ended') {
            this.post_state_update();
        }
    }

    private ensure_panel() {
        if (this.panel) return;
        const config = vscode.workspace.getConfiguration('raven.plot');
        const column_setting = config.get<ViewerColumn>('viewerColumn', 'beside');
        const panel = vscode.window.createWebviewPanel(
            'raven.plotViewer',
            'Raven Plot Viewer',
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
        panel.webview.html = build_html(panel.webview, this.context.extensionUri, nonce);
        panel.webview.onDidReceiveMessage((msg) => this.on_webview_message(msg));
        panel.onDidDispose(() => {
            this.panel = null;
            this.theme_sub?.dispose();
            this.theme_sub = null;
        });
        this.theme_sub = vscode.window.onDidChangeActiveColorTheme(() => {
            this.post(this.panel, { type: 'theme-changed', payload: {} });
        });
        this.panel = panel;
    }

    private post_state_update() {
        if (!this.panel) return;
        const active_id = this.server.activeSessionId;
        const session = active_id ? this.server.getSession(active_id) : undefined;
        this.post(this.panel, {
            type: 'state-update',
            payload: {
                activeSession: session
                    ? {
                          sessionId: session.sessionId,
                          httpgdBaseUrl: session.httpgdBaseUrl,
                          httpgdToken: session.httpgdToken,
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
        const active_id = this.server.activeSessionId;
        const session = active_id ? this.server.getSession(active_id) : undefined;
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
        const url = `${session.httpgdBaseUrl}/plot?id=${encodeURIComponent(plot_id)}` +
            `&renderer=${format}&width=1200&height=900` +
            `&token=${encodeURIComponent(session.httpgdToken)}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`httpgd ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await fs.writeFile(target.fsPath, buf);
    }

    private async handle_open_externally(plot_id: string): Promise<void> {
        const active_id = this.server.activeSessionId;
        const session = active_id ? this.server.getSession(active_id) : undefined;
        if (!session) return;
        const url = `${session.httpgdBaseUrl}/plot?id=${encodeURIComponent(plot_id)}` +
            `&renderer=svg&token=${encodeURIComponent(session.httpgdToken)}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private suggested_dir(): string {
        const ws = vscode.workspace.workspaceFolders?.[0];
        return ws ? ws.uri.fsPath : (process.env.HOME ?? process.cwd());
    }
}
