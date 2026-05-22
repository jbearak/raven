import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildShellHtml, isKnitOutputMessage } from './knit-output';
import { inlineLocalImagesAsDataUrls } from './inline-images';

/**
 * Webview panel that renders a single `.Rmd`'s rendered HTML output in
 * an `<iframe sandbox="allow-same-origin">` with Refresh / Open-in-
 * Browser / theme-toggle toolbar buttons.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-panel-per-file-design.md`
 * and the prior `2026-05-17-knit-output-webview-design.md`.
 *
 * Per-source registry: one panel per `.Rmd`, keyed by `sourceUri.fsPath`
 * to match the in-flight gate in `knit-commands.ts` (which also keys by
 * fsPath so the same file under different relative URIs collapses).
 * New panels anchor to `previewColumn` so they stack as tabs in a
 * single "preview" column rather than scattering.
 *
 * Architecture (unchanged from the singleton implementation):
 *  - Outer Raven-controlled shell document owns the CSP (in `<head>`),
 *    the toolbar, and a nonce'd `<script>` that posts messages.
 *  - Inner `<iframe sandbox="allow-same-origin" srcdoc="…">` embeds the
 *    rendered HTML inline. `allow-same-origin` is required because a
 *    bare `sandbox=""` would give the iframe an opaque origin that
 *    bypasses VS Code's webview service worker (Electron falls back
 *    to DNS resolution, which fails with `ERR_NAME_NOT_RESOLVED`).
 *    Scripts, forms, and popups are still blocked.
 *  - `localResourceRoots` is confined to `path.dirname(outputPath)`,
 *    where rmarkdown's `_files/` figure directories sit.
 *
 * Singleton → per-source: subsequent knits of the *same* source reuse
 * the panel and swap iframe content. Knits of different sources open
 * separate panels. If a panel's `outputPath` rootDir changes (rare —
 * e.g. user edited `output_dir`), only that panel is disposed and
 * recreated in its current column (`localResourceRoots` is immutable
 * post-creation — same workaround `help-panel.ts` uses).
 */
export class KnitOutputPanel {
    private static instances = new Map<string, KnitOutputPanel>();
    private static previewColumn: vscode.ViewColumn | undefined;

    private panel: vscode.WebviewPanel;
    private rootDir: string;
    private sourceUri: vscode.Uri;
    private outputPath: string;
    private readonly output: vscode.OutputChannel;
    /**
     * The most recent concrete `ViewColumn` this panel was observed in.
     * `panel.viewColumn` is documented as "only set if the webview is
     * in one of the editor view columns" — it can transiently be
     * `undefined` (newly created panel, mid-drag) even when the panel
     * is in a real column. We snapshot the column whenever VS Code
     * reports a defined value, so reuse / reveal logic and the
     * preview-column recompute can fall back to "where the panel
     * last was" instead of `ViewColumn.Beside`.
     */
    private lastKnownColumn: vscode.ViewColumn | undefined;

    /**
     * Open or update the panel for `args.sourceUri`. Returns
     * `{ ok: true }` on success, `{ ok: false, error }` if the rendered
     * file cannot be accessed (caller should fall back to
     * `revealFileInOS`).
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

        const key = args.sourceUri.fsPath;
        const rootDir = path.dirname(args.outputPath);
        const existing = KnitOutputPanel.instances.get(key);

        if (existing && existing.rootDir === rootDir) {
            existing.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
            // Prefer the panel's *current* column; fall back to the
            // last-known column so re-knitting a hidden panel does
            // not relocate it to `Beside` (which moves the panel
            // away from its prior tab group).
            const revealCol =
                existing.panel.viewColumn
                ?? existing.lastKnownColumn
                ?? vscode.ViewColumn.Beside;
            existing.panel.reveal(revealCol, true);
            return { ok: true };
        }

        if (existing) {
            // localResourceRoots is immutable post-creation — dispose
            // and recreate in the same column. Scoped to this source;
            // other panels untouched. Same column fallback chain as
            // the reuse branch above.
            const column =
                existing.panel.viewColumn
                ?? existing.lastKnownColumn
                ?? vscode.ViewColumn.Beside;
            existing.panel.dispose();
            KnitOutputPanel.create(context, args, rootDir, column);
            return { ok: true };
        }

        // Anchor priority for a brand-new panel:
        //  1. recorded `previewColumn` (already resolved by at least
        //     one prior knit's `onDidChangeViewState`)
        //  2. any surviving instance's panel.viewColumn or
        //     lastKnownColumn (handles back-to-back knits before the
        //     first panel's column has resolved yet)
        //  3. `ViewColumn.Beside`
        const column =
            KnitOutputPanel.previewColumn
            ?? KnitOutputPanel.findExistingColumn()
            ?? vscode.ViewColumn.Beside;
        KnitOutputPanel.create(context, args, rootDir, column);
        return { ok: true };
    }

    private static findExistingColumn(): vscode.ViewColumn | undefined {
        for (const inst of KnitOutputPanel.instances.values()) {
            const col = inst.panel.viewColumn ?? inst.lastKnownColumn;
            if (col !== undefined) return col;
        }
        return undefined;
    }

    /** Visible only for tests. */
    static getInstancesForTesting(): ReadonlyMap<string, KnitOutputPanel> {
        return KnitOutputPanel.instances;
    }

    /** Visible only for tests. */
    static getPreviewColumnForTesting(): vscode.ViewColumn | undefined {
        return KnitOutputPanel.previewColumn;
    }

    /**
     * Visible only for tests — disposes every real `WebviewPanel` in
     * the registry, clears the Map, and resets `previewColumn`. Fakes
     * inserted via `setInstancesForTesting` do not expose `dispose`
     * and are skipped.
     */
    static disposeAllForTesting(): void {
        for (const inst of [...KnitOutputPanel.instances.values()]) {
            const maybePanel = inst.panel as unknown as { dispose?: () => void };
            if (typeof maybePanel?.dispose === 'function') {
                maybePanel.dispose();
            }
        }
        KnitOutputPanel.instances.clear();
        KnitOutputPanel.previewColumn = undefined;
    }

    /**
     * Visible only for tests — inject lightweight stand-ins into the
     * Map so `recomputePreviewColumn` can be exercised without real
     * `createWebviewPanel` calls. The recompute logic only reads
     * `inst.panel.viewColumn`, so duck-typing is sufficient.
     */
    static setInstancesForTesting(
        fakes: ReadonlyArray<{ key: string; viewColumn: vscode.ViewColumn | undefined }>,
    ): void {
        KnitOutputPanel.instances.clear();
        for (const f of fakes) {
            const stub = {
                panel: { viewColumn: f.viewColumn } as unknown as vscode.WebviewPanel,
            } as unknown as KnitOutputPanel;
            KnitOutputPanel.instances.set(f.key, stub);
        }
    }

    /** Visible only for tests. */
    static setPreviewColumnForTesting(col: vscode.ViewColumn | undefined): void {
        KnitOutputPanel.previewColumn = col;
    }

    /** Visible only for tests. */
    static recomputePreviewColumnForTesting(): void {
        KnitOutputPanel.recomputePreviewColumn();
    }

    /** Visible only for tests. */
    getPanelForTesting(): vscode.WebviewPanel {
        return this.panel;
    }

    /** Visible only for tests. */
    getRootDirForTesting(): string {
        return this.rootDir;
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
        const key = args.sourceUri.fsPath;
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
        KnitOutputPanel.instances.set(key, instance);

        // Anchor the preview column on the first panel that has a
        // resolved column. Subsequent new panels open in this column
        // so they stack as tabs rather than scattering to Beside.
        const resolved = panel.viewColumn;
        if (resolved !== undefined) {
            instance.lastKnownColumn = resolved;
            if (KnitOutputPanel.previewColumn === undefined) {
                KnitOutputPanel.previewColumn = resolved;
            }
        }

        panel.onDidChangeViewState(() => {
            const col = panel.viewColumn;
            if (col !== undefined) instance.lastKnownColumn = col;
            KnitOutputPanel.recomputePreviewColumn();
        });
        panel.onDidDispose(() => {
            // Guard against a stale dispose listener for an instance
            // that has since been replaced under the same key (the
            // rootDir-mismatch branch disposes the old panel and
            // inserts a new one). VS Code's dispose() is synchronous
            // today, but the guard makes the invariant explicit and
            // survives any future async change.
            if (KnitOutputPanel.instances.get(key) === instance) {
                KnitOutputPanel.instances.delete(key);
            }
            KnitOutputPanel.recomputePreviewColumn();
        });

        instance.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
        return instance;
    }

    /**
     * Three-step preview-column recompute. Uses
     * `panel.viewColumn ?? lastKnownColumn` so a panel that is hidden
     * behind another tab (and therefore has `viewColumn === undefined`
     * per the VS Code API contract) still counts as occupying its
     * column.
     *
     *  - empty registry  → previewColumn = undefined
     *  - previewColumn still occupied by some panel → stays put
     *  - otherwise → adopts any surviving panel's column (so a
     *    dragged-away lone panel keeps siblings clustered with it)
     */
    private static recomputePreviewColumn(): void {
        if (KnitOutputPanel.instances.size === 0) {
            KnitOutputPanel.previewColumn = undefined;
            return;
        }
        const target = KnitOutputPanel.previewColumn;
        if (target !== undefined) {
            for (const inst of KnitOutputPanel.instances.values()) {
                const col = inst.panel.viewColumn ?? inst.lastKnownColumn;
                if (col === target) return;
            }
        }
        for (const inst of KnitOutputPanel.instances.values()) {
            const col = inst.panel.viewColumn ?? inst.lastKnownColumn;
            if (col !== undefined) {
                KnitOutputPanel.previewColumn = col;
                return;
            }
        }
        KnitOutputPanel.previewColumn = undefined;
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
        const docDir = path.dirname(args.outputPath);
        const baseHref = this.panel.webview
            .asWebviewUri(vscode.Uri.file(docDir + path.sep))
            .toString();
        // Inline relative `<img>` sources as data URLs. VS Code's
        // resource handler does NOT intercept subresource fetches
        // issued from a nested `<iframe>` (the same restriction the
        // srcdoc workaround handles for top-level navigation), so the
        // `webview-resource://…/figure/plot-1.png` URL the `<base>`
        // resolves an `<img src>` to escapes the protocol handler and
        // hits the real network stack — yielding a broken-image icon
        // even though the file exists on disk and the browser-open
        // path renders it correctly. Inlining the bytes as
        // `data:image/png;base64,…` sidesteps the resource handler
        // entirely. The on-disk `.html` written by the post-knit
        // renderer still references images by relative path, so
        // "Open in Browser" stays self-contained without an inflated
        // base64 payload. The mutation only touches the in-memory
        // copy handed to the iframe.
        htmlContent = inlineLocalImagesAsDataUrls(htmlContent, docDir, this.output);
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
