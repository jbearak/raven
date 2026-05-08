/**
 * DataViewerPanel — owns one webview tab keyed by panel name.
 *
 * Generations: every replace() increments `generation`. The handle()
 * method captures the current generation before any await, and drops
 * the reply if a replace landed in the meantime. The webview also tags
 * its requests with the generation it last received and silently
 * ignores responses tagged with an older one.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';

import { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import {
    COPY_CELL_LIMIT,
    ExtensionToWebview,
    Layout,
    Settings,
    WebviewToExtension,
} from './messages';
import { LayoutStore, schemaHash } from './layout-state';
import { build_csp } from './csp';
import { render_tsv, ResolvedLabels } from './tsv';

export class DataViewerPanel {
    readonly panelName: string;
    private readonly webviewPanel: vscode.WebviewPanel;
    private reader: ArrowSliceReader;
    private filePath: string;
    private generation = 0;
    private dictionaries: Record<number, string[]> = {};
    private columns: ColumnSchema[] = [];
    private layoutHash = '';
    private layout: Layout = { columnWidths: {}, hiddenColumns: [] };

    private constructor(
        panelName: string,
        webviewPanel: vscode.WebviewPanel,
        reader: ArrowSliceReader,
        filePath: string,
        private readonly store: LayoutStore,
        private readonly settings: Settings,
        private readonly disposeHook: () => void,
    ) {
        this.panelName = panelName;
        this.webviewPanel = webviewPanel;
        this.reader = reader;
        this.filePath = filePath;
        this.webviewPanel.onDidDispose(() => { void this.dispose(); });
        this.webviewPanel.webview.onDidReceiveMessage(
            (m: WebviewToExtension) => { void this.handle(m); },
        );
    }

    static async create(
        panelName: string,
        reader: ArrowSliceReader,
        filePath: string,
        store: LayoutStore,
        settings: Settings,
        extensionUri: vscode.Uri,
        disposeHook: () => void,
    ): Promise<DataViewerPanel> {
        const webviewPanel = vscode.window.createWebviewPanel(
            'raven.dataViewer',
            panelName,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'dist'),
                ],
            },
        );
        webviewPanel.webview.html = build_html(webviewPanel.webview, extensionUri);
        const panel = new DataViewerPanel(
            panelName, webviewPanel, reader, filePath, store, settings, disposeHook,
        );
        await panel.sendInit();
        return panel;
    }

    /** Replace the underlying reader. Old file is deleted; old generation
     *  is bumped so any in-flight reply is dropped. */
    async replace(reader: ArrowSliceReader, filePath: string): Promise<void> {
        this.generation += 1;
        const prevPath = this.filePath;
        this.reader = reader;
        this.filePath = filePath;
        await this.sendReplace();
        try { await fs.unlink(prevPath); } catch { /* ignore */ }
    }

    reveal(): void { this.webviewPanel.reveal(); }

    private async sendInit(): Promise<void> {
        this.columns = this.reader.schema.columns;
        this.layoutHash = schemaHash(this.columns);
        this.layout = (await this.store.load(this.panelName, this.layoutHash))
            ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const msg: ExtensionToWebview = {
            type: 'init',
            panelGeneration: this.generation,
            nrow: this.reader.nrow,
            columns: this.columns,
            layout: this.layout,
            settings: this.settings,
            dictionaries: this.dictionaries,
        };
        await this.webviewPanel.webview.postMessage(msg);
    }

    private async sendReplace(): Promise<void> {
        this.columns = this.reader.schema.columns;
        this.layoutHash = schemaHash(this.columns);
        this.layout = (await this.store.load(this.panelName, this.layoutHash))
            ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const msg: ExtensionToWebview = {
            type: 'replace',
            panelGeneration: this.generation,
            nrow: this.reader.nrow,
            columns: this.columns,
            layout: this.layout,
            dictionaries: this.dictionaries,
        };
        await this.webviewPanel.webview.postMessage(msg);
    }

    private collectDictionaries(): Record<number, string[]> {
        const out: Record<number, string[]> = {};
        this.columns.forEach((c, i) => {
            if (c.dictionaryShipped && c.dictionary) out[i] = c.dictionary;
        });
        return out;
    }

    private async handle(m: WebviewToExtension): Promise<void> {
        if (m.panelGeneration !== this.generation) return;
        // Capture generation BEFORE any await so a replace mid-fetch causes
        // us to drop the stale response rather than post under the new
        // generation.
        const gen = this.generation;
        switch (m.type) {
            case 'getRows': {
                this.reader.setLatestViewportGeneration(m.viewportGeneration);
                const out = await this.reader.getRows({
                    start: m.start,
                    end: m.end,
                    columns: m.columns,
                    viewportGeneration: m.viewportGeneration,
                });
                if (gen !== this.generation) return;
                const reply: ExtensionToWebview = {
                    type: 'rows',
                    panelGeneration: gen,
                    requestId: m.requestId,
                    viewportGeneration: m.viewportGeneration,
                    start: m.start,
                    end: m.end,
                    rows: out.rows,
                    stale: out.stale,
                };
                await this.webviewPanel.webview.postMessage(reply);
                return;
            }
            case 'getLabels': {
                const labels = await this.reader.getLabels(m.columnIndex, m.indices);
                if (gen !== this.generation) return;
                const reply: ExtensionToWebview = {
                    type: 'labels',
                    panelGeneration: gen,
                    requestId: m.requestId,
                    columnIndex: m.columnIndex,
                    labels,
                };
                await this.webviewPanel.webview.postMessage(reply);
                return;
            }
            case 'saveLayout': {
                this.layout = m.layout;
                await this.store.save(this.panelName, this.layoutHash, m.layout);
                return;
            }
            case 'copy': {
                await this.handleCopy(m, gen);
                return;
            }
        }
    }

    private async handleCopy(
        m: Extract<WebviewToExtension, { type: 'copy' }>,
        gen: number,
    ): Promise<void> {
        const cells = (m.range.rowEnd - m.range.rowStart) * m.range.colIndices.length;
        const replyDone = (ok: boolean, error?: string): ExtensionToWebview => ({
            type: 'copyDone',
            panelGeneration: gen,
            requestId: m.requestId,
            ok,
            error,
        });
        if (cells > COPY_CELL_LIMIT) {
            await this.webviewPanel.webview.postMessage(
                replyDone(false, 'Selection exceeds copy limit'));
            return;
        }
        const got = await this.reader.getRows({
            start: m.range.rowStart,
            end: m.range.rowEnd,
            columns: m.range.colIndices,
            viewportGeneration: Number.MAX_SAFE_INTEGER,
        });
        if (gen !== this.generation) return;

        // Resolve labels for any non-shipped dictionary columns in the
        // selection so a Labels-on copy renders the level strings the
        // grid is showing rather than the raw numeric indices.
        const resolved: ResolvedLabels = {};
        if (m.labelsOn) {
            for (let ci = 0; ci < m.range.colIndices.length; ci++) {
                const colIdx = m.range.colIndices[ci];
                const col = this.columns[colIdx];
                if (!col || col.dictionaryShipped
                    || !col.arrowType.startsWith('Dictionary')) continue;
                const indices = new Set<number>();
                for (const row of got.rows) {
                    const cell = row[ci];
                    if (typeof cell === 'number') indices.add(cell);
                }
                if (indices.size === 0) continue;
                const labels = await this.reader.getLabels(colIdx, [...indices]);
                if (gen !== this.generation) return;
                resolved[colIdx] = labels;
            }
        }

        const tsv = render_tsv(
            got.rows, m.range.colIndices, this.columns, this.dictionaries,
            m.labelsOn, m.formatOn, m.digits, resolved,
        );
        try {
            await vscode.env.clipboard.writeText(tsv);
            await this.webviewPanel.webview.postMessage(replyDone(true));
        } catch (err) {
            await this.webviewPanel.webview.postMessage(
                replyDone(false, err instanceof Error ? err.message : String(err)));
        }
    }

    private async dispose(): Promise<void> {
        try { await fs.unlink(this.filePath); } catch { /* ignore */ }
        this.disposeHook();
    }
}

/** Build the data-viewer webview HTML. Inline (mirrors plot-viewer-panel.ts). */
function build_html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const { csp, nonce } = build_csp(webview);
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(
        extensionUri, 'dist', 'webviews', 'data-viewer', 'index.js'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(
        extensionUri, 'dist', 'webviews', 'data-viewer', 'index.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
<title>Data Viewer</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${jsUri}"></script>
</body>
</html>`;
}

