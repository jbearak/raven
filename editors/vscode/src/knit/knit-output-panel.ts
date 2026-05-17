import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildShellHtml, isKnitOutputMessage } from './knit-output';

/**
 * Singleton webview panel that renders the most recent HTML knit output
 * inside an `<iframe sandbox="">` with Refresh and Open-in-Browser
 * toolbar buttons.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md`.
 *
 * Architecture:
 *  - Outer Raven-controlled shell document owns the CSP (in `<head>`),
 *    the toolbar, and a nonce'd `<script>` that posts messages.
 *  - Inner `<iframe>` loads the rendered HTML via
 *    `webview.asWebviewUri(outputPath)`. `sandbox=""` (empty, most
 *    restrictive) blocks scripts, forms, popups, and top-navigation.
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

    private constructor(
        _context: vscode.ExtensionContext,
        panel: vscode.WebviewPanel,
        rootDir: string,
        args: {
            sourceUri: vscode.Uri;
            outputPath: string;
            output: vscode.OutputChannel;
        },
    ) {
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
        this.panel.webview.html = buildShellHtml({
            webview: this.panel.webview,
            outputPath: args.outputPath,
            nonce,
        });
        this.panel.title = `Knit Output: ${path.basename(args.outputPath)}`;
    }

    private handleMessage(msg: unknown): void {
        if (!isKnitOutputMessage(msg)) return;
        if (msg.type === 'refresh') {
            void vscode.commands.executeCommand('raven.knit', this.sourceUri);
            return;
        }
        if (msg.type === 'openInBrowser') {
            void openInBrowser(this.outputPath, this.output);
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
