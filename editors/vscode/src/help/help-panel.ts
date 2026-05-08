import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
    ExtensionToWebviewMessage,
    isWebviewToExtensionMessage,
    LoadPayload,
} from './messages';
import { createHelpStateMachine, type FetchResponse } from './state-machine';
import { rewriteImageSrcs, type RewriteContext } from './image-rewriter';

type ViewerColumn = 'active' | 'beside';

function reveal_view_column(setting: ViewerColumn): vscode.ViewColumn {
    return setting === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
}

function build_html(
    webview: vscode.Webview,
    extension_uri: vscode.Uri,
    nonce: string,
): string {
    const js_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'help-viewer', 'index.js'),
    );
    const css_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(extension_uri, 'dist', 'webviews', 'help-viewer', 'index.css'),
    );
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${css_uri}" />
    <title>R Help</title>
</head>
<body>
    <script nonce="${nonce}" src="${js_uri}"></script>
</body>
</html>`;
}

export interface HelpPanelOptions {
    /** Called once after the underlying webview disposes. */
    onDisposed: () => void;
}

/**
 * A VS Code webview panel that renders R help and supports back/forward
 * navigation. Singleton per VS Code session — reused across topics.
 *
 * Lifecycle:
 *  - Created lazily on the first `openTopic()` call.
 *  - `localResourceRoots` starts with only the help-viewer dist directory.
 *    After the first successful fetch, the panel is recreated with the actual
 *    `libPaths` appended so that images served from package help directories
 *    can be loaded via webview URIs.
 *  - When the libPaths in a subsequent response are not a subset of the current
 *    roots, the panel is disposed and recreated with the expanded root set.
 */
export class HelpPanel {
    private panel: vscode.WebviewPanel | null = null;
    private theme_sub: vscode.Disposable | null = null;
    private current_lib_paths: string[] = [];
    private current_help_dir: string | null = null;
    private state_machine: ReturnType<typeof createHelpStateMachine>;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly client: LanguageClient,
        private readonly options: HelpPanelOptions,
    ) {
        this.state_machine = createHelpStateMachine({
            fetch: (topic, pkg, _id) => this.fetch_help(topic, pkg),
            onLoad: (load, _scrollY) => this.handle_load(load),
            onLoading: () => this.post({ type: 'loading', payload: {} }),
            onError: (e) =>
                this.post({
                    type: 'error',
                    payload: { reason: e.reason as never, message: e.message },
                }),
            onHistoryChange: (s) =>
                this.post({ type: 'history-state', payload: s }),
        });
    }

    static create(
        context: vscode.ExtensionContext,
        client: LanguageClient,
        onDisposed: () => void,
    ): HelpPanel {
        return new HelpPanel(context, client, { onDisposed });
    }

    /** Public entry point: open a topic, possibly creating the panel if needed. */
    async openTopic(topic: string, pkg: string | null, anchor: string | null): Promise<void> {
        if (!pkg) {
            void vscode.window.showErrorMessage(
                `Raven: cannot open help — no package known for topic '${topic}'`,
            );
            return;
        }
        await this.ensure_panel();
        await this.state_machine.navigate(topic, pkg, anchor);
    }

    async back(): Promise<void> {
        if (!this.panel) return;
        await this.state_machine.back();
    }

    async forward(): Promise<void> {
        if (!this.panel) return;
        await this.state_machine.forward();
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = null;
        this.theme_sub?.dispose();
        this.theme_sub = null;
    }

    private async ensure_panel(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
            return;
        }
        this.create_panel(this.current_lib_paths);
    }

    /**
     * Create the webview panel with the given additional resource roots.
     *
     * `extra_roots` is initially empty; it is populated once we know the
     * response's `libPaths` so that images in package help directories can be
     * served via webview URIs. VS Code does not allow updating
     * `localResourceRoots` after panel creation, so we dispose and recreate
     * when the roots need to expand.
     */
    private create_panel(extra_roots: string[]): void {
        const config = vscode.workspace.getConfiguration('raven.help');
        const column_setting = config.get<ViewerColumn>('viewerColumn', 'beside');
        const dist_root = vscode.Uri.joinPath(
            this.context.extensionUri,
            'dist',
            'webviews',
            'help-viewer',
        );
        const panel = vscode.window.createWebviewPanel(
            'raven.helpViewer',
            'R Help',
            { viewColumn: reveal_view_column(column_setting), preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    dist_root,
                    ...extra_roots.map((p) => vscode.Uri.file(p)),
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
            this.options.onDisposed();
        });
        this.theme_sub = vscode.window.onDidChangeActiveColorTheme(() => {
            this.post({ type: 'theme-changed', payload: {} });
        });
        this.panel = panel;
    }

    /** Call the LSP `raven.getHelpHtml` command and return a typed response.
     *
     * Captures `helpDir` and `libPaths` into instance fields BEFORE returning
     * so that `handle_load` can use them for the image-rewrite pass without
     * having to re-fetch. */
    private async fetch_help(topic: string, pkg: string): Promise<FetchResponse> {
        try {
            const result = await this.client.sendRequest<{
                ok: boolean;
                topic?: string;
                package?: string;
                title?: string;
                html?: string;
                helpDir?: string;
                libPaths?: string[];
                reason?: string;
                message?: string;
            }>('workspace/executeCommand', {
                command: 'raven.getHelpHtml',
                arguments: [topic, pkg],
            });
            if (result.ok) {
                const help_dir = result.helpDir ?? '';
                const lib_paths = result.libPaths ?? [];
                // Capture BEFORE returning so handle_load sees the right values.
                this.current_help_dir = help_dir || null;
                this.update_resource_roots_if_needed(lib_paths);
                return {
                    ok: true,
                    topic: result.topic ?? topic,
                    package: result.package ?? pkg,
                    title: result.title ?? `${pkg}::${topic}`,
                    html: result.html ?? '',
                    helpDir: help_dir,
                    libPaths: lib_paths,
                    anchor: null,
                };
            }
            return {
                ok: false,
                reason: result.reason ?? 'render-failed',
                message: result.message ?? 'unknown error',
            };
        } catch (err) {
            return {
                ok: false,
                reason: 'render-failed',
                message: String(err),
            };
        }
    }

    /**
     * Handle a successful state-machine load: rewrite images then post `load`.
     *
     * By the time this is called, `fetch_help` has already run and populated
     * `current_help_dir` / `current_lib_paths`, so the RewriteContext is ready.
     */
    private handle_load(load: LoadPayload): void {
        if (!this.panel) return;
        if (this.current_help_dir) {
            const ctx: RewriteContext = {
                helpDir: this.current_help_dir,
                libPaths: this.current_lib_paths,
                asWebviewUri: (abs) =>
                    this.panel!.webview
                        .asWebviewUri(vscode.Uri.file(abs))
                        .toString(),
                fileExists: (abs) => {
                    try {
                        return fs.existsSync(abs);
                    } catch {
                        return false;
                    }
                },
            };
            const rewritten_html = rewriteImageSrcs(load.html, ctx);
            this.post({ type: 'load', payload: { ...load, html: rewritten_html } });
        } else {
            this.post({ type: 'load', payload: load });
        }
        this.panel.title = `R Help: ${load.package}::${load.topic}`;
    }

    /**
     * Expand `localResourceRoots` when `libPaths` introduces new roots.
     *
     * VS Code does not allow mutating `localResourceRoots` after panel
     * creation, so we must dispose the panel and create a new one whenever
     * the libPaths from a fetch response are not a subset of the current roots.
     * The first successful response always triggers a recreate (since we start
     * with an empty root list for libPaths).
     */
    private update_resource_roots_if_needed(lib_paths: string[]): void {
        if (!this.panel) {
            this.current_lib_paths = lib_paths;
            return;
        }
        const is_subset = lib_paths.every((p) => this.current_lib_paths.includes(p));
        if (is_subset) return;
        // Dispose and recreate with expanded roots. onDisposed fires, which
        // would normally notify the owner — suppress that by temporarily
        // unlinking the onDisposed hook here by directly disposing and
        // recreating (the panel field is reset in the dispose listener, which
        // fires synchronously in most VS Code environments). We update
        // current_lib_paths first so create_panel sees the new value.
        this.current_lib_paths = lib_paths;
        // Dispose the old panel. The onDidDispose listener sets this.panel =
        // null and calls options.onDisposed(), but we immediately recreate
        // below, so the caller (the owner's singleton ref) will remain valid.
        this.panel.dispose();
        // panel is now null (set by onDidDispose synchronously or async).
        // Recreate with the new roots.
        this.create_panel(this.current_lib_paths);
    }

    private post(msg: ExtensionToWebviewMessage): void {
        this.panel?.webview.postMessage(msg);
    }

    private on_webview_message(msg: unknown): void {
        if (!isWebviewToExtensionMessage(msg)) return;
        switch (msg.type) {
            case 'webview-ready':
                // Webview is up; nothing to push immediately (we navigate on
                // openTopic).
                break;
            case 'navigate':
                void this.state_machine.navigate(
                    msg.payload.topic,
                    msg.payload.package,
                    msg.payload.anchor,
                );
                break;
            case 'open-external': {
                try {
                    const u = vscode.Uri.parse(msg.payload.url);
                    if (
                        u.scheme === 'http' ||
                        u.scheme === 'https' ||
                        u.scheme === 'mailto'
                    ) {
                        void vscode.env.openExternal(u);
                    }
                } catch {
                    // ignore — malformed URL
                }
                break;
            }
            case 'report-error':
                console.warn('[Raven help webview]', msg.payload.message);
                break;
            case 'scroll':
                this.state_machine.setScrollY(msg.payload.y);
                break;
            case 'back':
                void this.state_machine.back();
                break;
            case 'forward':
                void this.state_machine.forward();
                break;
        }
    }
}
