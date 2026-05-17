import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildShellHtml, isKnitOutputMessage } from './knit-output';

/**
 * Singleton webview panel that renders the most recent HTML knit output
 * inside an `<iframe sandbox="allow-same-origin">` with Refresh and
 * Open-in-Browser toolbar buttons.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md`.
 *
 * Architecture:
 *  - Outer Raven-controlled shell document owns the CSP (in `<head>`),
 *    the toolbar, and a nonce'd `<script>` that posts messages.
 *  - Inner `<iframe>` loads the rendered HTML via
 *    `webview.asWebviewUri(outputPath)`. The sandbox blocks scripts,
 *    forms, popups, and top-navigation. `allow-same-origin` is
 *    required: VS Code serves `vscode-cdn.net` webview resources via
 *    a service worker scoped to that origin, and a sandboxed iframe
 *    with a unique opaque origin bypasses the service worker (Electron
 *    falls back to DNS resolution, which fails with
 *    `ERR_NAME_NOT_RESOLVED`). `allow-same-origin` re-enters the SW
 *    scope without enabling scripts/forms.
 *    `frame-src ${cspSource}` on the outer CSP prevents iframe
 *    navigation to external hosts.
 *  - `localResourceRoots` is confined to `path.dirname(outputPath)`,
 *    which is also where rmarkdown's `_files/` figure directories sit.
 *
 * Singleton: one panel per VS Code window. Subsequent knits replace the
 * iframe `src`. If the new output's `rootDir` differs, the panel is
 * disposed and recreated (VS Code does not allow updating
 * `localResourceRoots` post-creation — see `help-panel.ts`).
 */
export class KnitOutputPanel {
    private static instance: KnitOutputPanel | undefined;

    private panel: vscode.WebviewPanel;
    private rootDir: string;
    private sourceUri: vscode.Uri;
    private outputPath: string;
    private readonly output: vscode.OutputChannel;

    /**
     * Open or update the singleton panel. Returns `{ ok: true }` on
     * success, `{ ok: false, error }` if the rendered file cannot be
     * accessed (caller should fall back to `revealFileInOS`).
     */
    static async showOrUpdate(
        context: vscode.ExtensionContext,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        try {
            await fs.promises.access(args.outputPath, fs.constants.R_OK);
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        const rootDir = path.dirname(args.outputPath);
        const existing = KnitOutputPanel.instance;

        if (existing && existing.rootDir === rootDir) {
            existing.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
            existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
            return { ok: true };
        }

        if (existing) {
            // localResourceRoots is immutable after panel creation — dispose
            // and recreate in the same column. Same workaround as help-panel.
            const column = existing.panel.viewColumn ?? vscode.ViewColumn.Beside;
            existing.panel.dispose();
            // panel.dispose() fires onDidDispose, which clears `instance`.
            KnitOutputPanel.create(context, args, rootDir, column);
            return { ok: true };
        }

        KnitOutputPanel.create(context, args, rootDir, vscode.ViewColumn.Beside);
        return { ok: true };
    }

    /** Visible only for tests. */
    static getInstanceForTesting(): KnitOutputPanel | undefined {
        return KnitOutputPanel.instance;
    }

    /** Visible only for tests — destroys the singleton. */
    static disposeForTesting(): void {
        KnitOutputPanel.instance?.panel.dispose();
    }

    private static create(
        context: vscode.ExtensionContext,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
        rootDir: string,
        column: vscode.ViewColumn,
    ): KnitOutputPanel {
        const panel = vscode.window.createWebviewPanel(
            'raven.knitOutput',
            'Knit Output',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(rootDir)],
            },
        );
        const instance = new KnitOutputPanel(context, panel, rootDir, args);
        KnitOutputPanel.instance = instance;
        instance.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
        return instance;
    }

    private readonly context: vscode.ExtensionContext;

    private constructor(
        context: vscode.ExtensionContext,
        panel: vscode.WebviewPanel,
        rootDir: string,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
    ) {
        this.context = context;
        this.panel = panel;
        this.rootDir = rootDir;
        this.sourceUri = args.sourceUri;
        this.outputPath = args.outputPath;
        this.output = args.output;

        this.panel.webview.onDidReceiveMessage((msg: unknown) => this.handleMessage(msg));
        this.panel.onDidDispose(() => {
            if (KnitOutputPanel.instance === this) {
                KnitOutputPanel.instance = undefined;
            }
        });
    }

    private updateContent(args: { sourceUri: vscode.Uri; outputPath: string }): void {
        this.sourceUri = args.sourceUri;
        this.outputPath = args.outputPath;
        const nonce = crypto.randomBytes(16).toString('base64');
        // Read the rendered HTML from disk; inlining via `srcdoc`
        // bypasses the nested-iframe navigation issue (see
        // buildShellHtml's doc comment).
        let htmlContent: string;
        try {
            htmlContent = fs.readFileSync(args.outputPath, 'utf-8');
        } catch (err) {
            this.output.appendLine(
                `[panel] read failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            htmlContent = '<!doctype html><html><body><p>Raven: Knit — '
                + 'could not read the rendered output. Use Open in Browser instead.'
                + '</p></body></html>';
        }
        // Subresources in the rendered HTML (CSS, images, fonts)
        // resolve relative to the document's directory. Setting the
        // base href to the webview URI for that directory makes those
        // requests go through the outer webview's resource handler.
        // The trailing slash is required so relative paths like
        // `img.png` resolve to `${dir}/img.png` rather than replacing
        // the last URL segment.
        const baseHref = this.panel.webview
            .asWebviewUri(vscode.Uri.file(path.dirname(args.outputPath) + path.sep))
            .toString();
        this.panel.webview.html = buildShellHtml({
            htmlContent,
            baseHref,
            cspSource: this.panel.webview.cspSource,
            outputPath: args.outputPath,
            nonce,
            initialThemeApplied: KnitOutputPanel.readThemePreference(this.context),
        });
        this.panel.title = `Knit Output: ${path.basename(args.outputPath)}`;
    }

    /**
     * Storage key for the "Apply VS Code theme" toggle. Lives in
     * `globalState` so the choice persists across panel disposal /
     * recreation, across knits, and across VS Code restarts.
     */
    private static readonly THEME_PREFERENCE_KEY = 'raven.knit.applyVSCodeTheme';

    private static readThemePreference(context: vscode.ExtensionContext): boolean {
        // `globalState` is undefined in some test paths that stub
        // ExtensionContext with `{}`; treat that the same as
        // "preference not yet stored" rather than crashing.
        const gs = context.globalState as vscode.Memento | undefined;
        if (!gs || typeof gs.get !== 'function') return false;
        const v = gs.get<unknown>(KnitOutputPanel.THEME_PREFERENCE_KEY);
        return typeof v === 'boolean' ? v : false;
    }

    private handleMessage(msg: unknown): void {
        if (!isKnitOutputMessage(msg)) return;
        if (msg.type === 'refresh') {
            void vscode.commands.executeCommand('raven.knit', this.sourceUri);
            return;
        }
        if (msg.type === 'openInBrowser') {
            void openInBrowser(this.outputPath, this.output);
            return;
        }
        if (msg.type === 'themeChanged') {
            void this.context.globalState.update(
                KnitOutputPanel.THEME_PREFERENCE_KEY,
                msg.applied,
            );
        }
    }
}

/**
 * Open the rendered file via the user's OS default browser.
 *
 * In local workspaces this opens the configured handler for `file:` (a
 * browser, typically). In remote workspaces, `openExternal(file:)` may
 * route the request to the extension-host machine — i.e. the remote
 * server, not where the user is sitting. When `openExternal` returns
 * false we write the path to the Knit output channel and warn the user.
 */
export async function openInBrowser(
    outputPath: string,
    output: vscode.OutputChannel,
): Promise<void> {
    const uri = vscode.Uri.file(outputPath);
    let opened = false;
    try {
        opened = await vscode.env.openExternal(uri);
    } catch (err) {
        output.appendLine(
            `[Open in Browser] openExternal threw: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (opened) return;
    output.appendLine(`[Open in Browser] file:// did not open. Rendered output is at: ${outputPath}`);
    void vscode.window.showWarningMessage(
        'Open in Browser is not available for this workspace. The rendered file path has been written to the Raven: Knit output channel.',
    );
}
