import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
    ExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
    SaveFormat,
} from './messages';
import { RSessionServer } from '../r-session-server';
import { download_to_buffer } from './http-download';
import { csp_sources_for_external_base } from './csp';
import { viewerTabIcon } from '../viewer-tab-icon';

type ViewerColumn = 'active' | 'beside';

function reveal_view_column(setting: ViewerColumn): vscode.ViewColumn {
    return setting === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
}

function build_html(
    webview: vscode.Webview,
    extension_uri: vscode.Uri,
    nonce: string,
    externalBaseUrl: string,
    initialThemeApplied: boolean,
): string {
    const js_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'plot-viewer', 'index.js'),
    );
    const css_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'plot-viewer', 'index.css'),
    );
    // Loopback hosts must match those accepted by RSessionServer for
    // httpgdHost (see r-session-server/index.ts allowedHosts): 127.0.0.1, localhost,
    // and ::1. If the CSP omits one, webview fetches and websocket connects
    // to that host fail silently.
    const loopbackHttp = 'http://127.0.0.1:* http://localhost:* http://[::1]:*';
    const loopbackWs = 'ws://127.0.0.1:* ws://localhost:* ws://[::1]:*';
    const external = csp_sources_for_external_base(externalBaseUrl);
    // After the inline-SVG substrate switch, the webview no longer
    // creates blob URLs or uses `<img src=data:...>`. The `img-src`
    // directive drops both `blob:` and `data:` to narrow the attack
    // surface. `connect-src` still allows loopback HTTP for the SVG
    // fetch — the SVG text comes through `connect-src`, not `img-src`,
    // because `fetch()` is governed by `connect-src` regardless of
    // payload type.
    const imgSrc = `${webview.cspSource} ${loopbackHttp} ${external.http}`.trim();
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
    // Initial-render seeding: write the persisted themeApplied value
    // into a global the Svelte `onMount` reads. JSON.stringify the
    // whole payload (not field-by-field interpolation) so any future
    // field can't be added with an injection-prone string concat. The
    // <bool> value is fully controlled by Raven (`context.globalState`)
    // and JSON-serialized — no untrusted input reaches the <script>
    // body.
    const initialStateJson = JSON.stringify({ themeApplied: initialThemeApplied });
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${css_uri}" />
    <title>Raven Plot Viewer</title>
</head>
<body>
    <script nonce="${nonce}">window.__ravenInitialPlotState = ${initialStateJson};</script>
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
 *
 * Theme toggle wiring: the toolbar's "Apply VS Code theme" button posts
 * `set-theme-applied` on click; the host writes the choice to
 * `globalState[THEME_PREFERENCE_KEY]` AND calls
 * `PlotServices.broadcastStateUpdate()` so every open panel re-renders
 * with the new value. The persisted value is read at panel-create time
 * and baked into the shell HTML's `<script>` seed so the first paint
 * doesn't flash an incorrect background.
 */
export class PlotViewerPanel {
    /**
     * Storage key for the "Apply VS Code theme" toggle. Lives in
     * `globalState` so the choice persists across panel disposal /
     * recreation, across plot sessions, and across VS Code restarts.
     * Parallel to `KnitOutputPanel.THEME_PREFERENCE_KEY`.
     */
    static readonly THEME_PREFERENCE_KEY = 'raven.plot.applyVSCodeTheme';

    /**
     * Read the persisted toggle value from globalState. Single source
     * of truth for both `build_html`'s initial-render seed and
     * `post_state_update`'s broadcast payload. `globalState` may be
     * undefined under sparse test stubs (`{} as vscode.ExtensionContext`);
     * treat that the same as "preference not yet stored".
     */
    static readThemePreference(context: vscode.ExtensionContext): boolean {
        const gs = context.globalState as vscode.Memento | undefined;
        if (!gs || typeof gs.get !== 'function') return false;
        const v = gs.get<unknown>(PlotViewerPanel.THEME_PREFERENCE_KEY);
        return typeof v === 'boolean' ? v : false;
    }

    private panel: vscode.WebviewPanel | null = null;
    /** httpgd base URL after `vscode.env.asExternalUri` mapping. Computed
     *  once when the panel is created so the CSP and the URLs sent to the
     *  webview stay consistent. Equal to the loopback URL on local hosts. */
    private external_base_url: string | null = null;
    private ensure_panel_in_flight: Promise<void> | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly server: RSessionServer,
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

    /**
     * Push the current state to this panel, if it exists. Called by
     * `PlotServices.broadcastStateUpdate` after any theme-toggle write
     * so every open panel re-renders with the new themeApplied value.
     * No-op when the panel hasn't been created yet (a not-yet-created
     * panel will read the persisted value via `build_html` on first
     * creation, so it never falls behind).
     */
    postStateUpdate(): void {
        this.post_state_update();
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = null;
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
        panel.iconPath = viewerTabIcon('graph');
        const nonce = crypto.randomBytes(16).toString('base64');
        const initialThemeApplied = PlotViewerPanel.readThemePreference(this.context);
        panel.webview.html = build_html(
            panel.webview,
            this.context.extensionUri,
            nonce,
            this.external_base_url ?? '',
            initialThemeApplied,
        );
        // Invariant: do NOT post state-update from inside create_panel.
        // The webview's message listener isn't installed until onMount
        // runs in the Svelte App, which is after the bundle loads. The
        // webview-ready round-trip is the single bottleneck that
        // guarantees the listener is live before any state arrives.
        panel.webview.onDidReceiveMessage((msg) => this.on_webview_message(msg));
        panel.onDidDispose(() => {
            this.panel = null;
            this.options.onDisposed();
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
                themeApplied: PlotViewerPanel.readThemePreference(this.context),
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
            case 'set-theme-applied':
                this.handle_set_theme_applied(msg.payload.applied).catch(err => {
                    console.warn('[Raven plot webview] set-theme-applied:', err);
                });
                break;
        }
    }

    private async handle_set_theme_applied(applied: boolean): Promise<void> {
        // `await` the Memento write before broadcasting so any panel
        // currently being created sees the new value via
        // `readThemePreference` in its `build_html` seed. Without the
        // await, broadcastStateUpdate could read the OLD value off
        // Memento and post the wrong themeApplied to other panels.
        await this.context.globalState.update(
            PlotViewerPanel.THEME_PREFERENCE_KEY,
            applied,
        );
        // The broadcast goes through PlotServices so this panel doesn't
        // need a sibling reference; the orchestrator iterates `panels`.
        // We dispatch via a registered command so the panel doesn't
        // need a direct PlotServices reference (mirrors knit-preview's
        // raven.knit.cancelExport pattern).
        try {
            await vscode.commands.executeCommand('raven.plot.broadcastStateUpdate');
        } catch {
            // Command may not be registered in test paths that stub
            // around PlotServices; the local panel already updated
            // through its own state-update on the next round-trip.
        }
    }

    private async handle_save(plot_id: string, format: SaveFormat): Promise<void> {
        const session = this.server.getSession(this.sessionId);
        if (!session) return;
        // Pass only the filter matching the chosen format. macOS NSSavePanel
        // enforces the active filter's extension, and the dialog selects the
        // first filter by default — so including all three caused PDF/SVG
        // saves to be rewritten as `name.pdf.png` / `name.svg.png`.
        const filter_labels: Record<SaveFormat, string> = {
            png: 'PNG', svg: 'SVG', pdf: 'PDF',
        };
        const filters: Record<string, string[]> = {
            [filter_labels[format]]: [format],
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
