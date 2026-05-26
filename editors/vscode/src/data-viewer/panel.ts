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
    EMPTY_SORT,
    ExtensionToWebview,
    Layout,
    Settings,
    SortState,
    WebviewToExtension,
} from './messages';
import { computePermutation } from './sort';
import { LayoutStore, schemaHash } from './layout-state';
import { ToolbarState, ToolbarStateStore } from './toolbar-state';
import { SortStateStore } from './sort-state';
import { build_csp } from './csp';
import { render_tsv, ResolvedLabels } from './tsv';

let dataViewerTraceOutput: vscode.OutputChannel | undefined;

export class DataViewerPanel {
    readonly panelName: string;
    private readonly webviewPanel: vscode.WebviewPanel;
    private reader: ArrowSliceReader;
    private filePath: string;
    private generation = 0;
    private webviewReady = false;
    private webviewInitialized = false;
    private disposed = false;
    private dictionaries: Record<number, string[]> = {};
    private columns: ColumnSchema[] = [];
    private layout: Layout = { columnWidths: {}, hiddenColumns: [] };
    /** Current sort state. Mirrors what the webview sees in its header
     *  glyphs and toolbar chip strip. Updated by `setSort` and by
     *  init/replace's restore path. */
    private sort: SortState = EMPTY_SORT;
    /** Permutation backing the current sort. `undefined` ↔ identity
     *  ordering. Plumbed into every reader.getRows call below. */
    private permutation: Uint32Array | undefined;
    /** Monotonic counter — every setSort that produces a new permutation
     *  bumps it. Late-landing `sortApplied` responses tagged with an
     *  older value are dropped. */
    private sortGeneration = 0;
    private readonly traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /** Latest visible-row range observed via lifecycle events. Used by
     *  the integration test API. `undefined` until the first lifecycle
     *  message arrives; cleared on `replace()` so a stale range from the
     *  previous dataset is never returned for the new one. */
    private lastVisibleRange: { start: number; end: number } | undefined;
    /** Latest on-screen row range observed via lifecycle events. This
     *  excludes fetched-but-hidden overscan rows. */
    private lastViewportRange: { start: number; end: number } | undefined;
    /** Latest selected focus cell observed via lifecycle events. */
    private lastFocusCell: { row: number; col: number } | undefined;

    private constructor(
        panelName: string,
        webviewPanel: vscode.WebviewPanel,
        reader: ArrowSliceReader,
        filePath: string,
        private readonly store: LayoutStore,
        private readonly toolbarStore: ToolbarStateStore,
        private readonly sortStore: SortStateStore,
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
        toolbarStore: ToolbarStateStore,
        sortStore: SortStateStore,
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
            panelName, webviewPanel, reader, filePath,
            store, toolbarStore, sortStore, settings, disposeHook,
        );
        panel.trace('create', { filePath, nrow: reader.nrow, columns: reader.schema.columns.length });
        return panel;
    }

    /** Replace the underlying reader. Old file is deleted; old generation
     *  is bumped so any in-flight reply is dropped.
     *
     *  Disposal can race with replace: the user may close the tab while a
     *  replace is in flight. If disposal happens before the swap, we own
     *  cleaning up the new reader/file (dispose() can't see them yet). If it
     *  happens after the swap, dispose() closes the new reader and unlinks
     *  the new path, but the old reader/file is still ours to clean up. */
    async replace(reader: ArrowSliceReader, filePath: string): Promise<void> {
        if (this.disposed) {
            await reader.close().catch(() => undefined);
            try { await fs.unlink(filePath); } catch { /* ignore */ }
            return;
        }
        this.generation += 1;
        // Clear cached visible range so a stale range from the previous
        // dataset is never returned for the new one. The next lifecycle
        // event from the webview will repopulate it.
        this.lastVisibleRange = undefined;
        this.lastViewportRange = undefined;
        this.lastFocusCell = undefined;
        // Old permutation cannot be reused — sendReplace below will
        // attempt to restore a saved sort against the new reader.
        this.sort = EMPTY_SORT;
        this.permutation = undefined;
        this.sortGeneration += 1;
        const prevReader = this.reader;
        const prevPath = this.filePath;
        this.reader = reader;
        this.filePath = filePath;
        this.trace('replace', { filePath, nrow: reader.nrow, columns: reader.schema.columns.length });
        if (this.webviewReady) await this.sendReplace();
        await prevReader.close().catch(() => undefined);
        try { await fs.unlink(prevPath); } catch { /* ignore */ }
    }

    reveal(): void { this.webviewPanel.reveal(); }

    private defaultToolbar(): ToolbarState {
        return {
            labelsOn: true,
            formatOn: true,
            digits: this.settings.defaultDigits,
        };
    }

    private async sendInit(): Promise<boolean> {
        const generation = this.generation;
        const reader = this.reader;
        const columns = reader.schema.columns;
        const layoutHash = schemaHash(columns);
        const [layout, toolbar, savedSort] = await Promise.all([
            this.store.load(this.panelName, layoutHash),
            this.toolbarStore.load(this.panelName, layoutHash),
            this.settings.persistSort
                ? this.sortStore.load(this.panelName, layoutHash)
                : Promise.resolve(undefined),
        ]);
        if (generation !== this.generation || reader !== this.reader) return false;
        this.columns = columns;
        this.layout = layout ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const activeToolbar = toolbar ?? this.defaultToolbar();
        const restored = await this.restoreSort(savedSort, activeToolbar, generation, reader);
        if (generation !== this.generation || reader !== this.reader) return false;
        const msg: ExtensionToWebview = {
            type: 'init',
            panelGeneration: generation,
            nrow: reader.nrow,
            columns: this.columns,
            layout: this.layout,
            toolbar: activeToolbar,
            settings: this.settings,
            dictionaries: this.dictionaries,
            schemaHash: layoutHash,
            objectClass: reader.schema.objectClass,
            sort: restored,
        };
        this.trace('post-init', {
            generation,
            nrow: reader.nrow,
            columns: this.columns.length,
            schemaHash: layoutHash,
            loadedLayoutHidden: this.layout.hiddenColumns,
            loadedToolbar: toolbar ?? null,
        });
        await this.webviewPanel.webview.postMessage(msg);
        this.webviewInitialized = true;
        return true;
    }

    private async sendReplace(): Promise<void> {
        if (!this.webviewInitialized) {
            await this.sendInit();
            return;
        }
        const generation = this.generation;
        const reader = this.reader;
        const columns = reader.schema.columns;
        const layoutHash = schemaHash(columns);
        const [layout, toolbar, savedSort] = await Promise.all([
            this.store.load(this.panelName, layoutHash),
            this.toolbarStore.load(this.panelName, layoutHash),
            this.settings.persistSort
                ? this.sortStore.load(this.panelName, layoutHash)
                : Promise.resolve(undefined),
        ]);
        if (generation !== this.generation || reader !== this.reader) return;
        this.columns = columns;
        this.layout = layout ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const activeToolbar = toolbar ?? this.defaultToolbar();
        const restored = await this.restoreSort(savedSort, activeToolbar, generation, reader);
        if (generation !== this.generation || reader !== this.reader) return;
        const msg: ExtensionToWebview = {
            type: 'replace',
            panelGeneration: generation,
            nrow: reader.nrow,
            columns: this.columns,
            layout: this.layout,
            toolbar: activeToolbar,
            dictionaries: this.dictionaries,
            schemaHash: layoutHash,
            objectClass: reader.schema.objectClass,
            sort: restored,
        };
        this.trace('post-replace', {
            generation,
            nrow: reader.nrow,
            columns: this.columns.length,
            schemaHash: layoutHash,
            loadedLayoutHidden: this.layout.hiddenColumns,
            loadedToolbar: toolbar ?? null,
        });
        await this.webviewPanel.webview.postMessage(msg);
    }

    /** Attempt to restore a persisted sort. Returns the SortState to ship
     *  to the webview, and as a side effect updates `this.sort` and
     *  `this.permutation`. Always recomputes the permutation against the
     *  current reader — schema-hash equality is not evidence that two
     *  datasets share row values, so the only persisted truth is the
     *  list of sort keys. The state is dropped when:
     *    - persistSort is off,
     *    - no saved state exists,
     *    - the saved state had no keys (already empty), or
     *    - any key references a column that no longer exists.
     *  Caller is responsible for the post-await generation check. */
    private async restoreSort(
        saved: SortState | undefined,
        toolbar: ToolbarState,
        generation: number,
        reader: ArrowSliceReader,
    ): Promise<SortState> {
        this.sort = EMPTY_SORT;
        this.permutation = undefined;
        if (!saved || saved.keys.length === 0) return EMPTY_SORT;
        const maxColIndex = this.columns.length - 1;
        for (const k of saved.keys) {
            if (k.columnIndex < 0 || k.columnIndex > maxColIndex) return EMPTY_SORT;
        }
        try {
            const perm = await computePermutation(reader, saved.keys, {
                labelsOn: toolbar.labelsOn,
                formatOn: toolbar.formatOn,
                digits: toolbar.digits,
            });
            if (generation !== this.generation || reader !== this.reader) return EMPTY_SORT;
            this.sort = {
                keys: saved.keys,
                labelsOnWhenSorted: toolbar.labelsOn,
            };
            this.permutation = perm;
            this.sortGeneration += 1;
            return this.sort;
        } catch {
            return EMPTY_SORT;
        }
    }

    private collectDictionaries(): Record<number, string[]> {
        const out: Record<number, string[]> = {};
        this.columns.forEach((c, i) => {
            if (c.dictionaryShipped && c.dictionary) out[i] = c.dictionary;
        });
        return out;
    }

    private async handle(m: WebviewToExtension): Promise<void> {
        if (this.disposed) return;
        try {
            await this.handleInner(m);
        } catch (err) {
            // Reader operations can reject with EBADF if dispose() closes the
            // FileHandle mid-await. Swallow those — the webview is gone.
            if (this.disposed) return;
            throw err;
        }
    }

    private async handleInner(m: WebviewToExtension): Promise<void> {
        if (m.type === 'webviewReady') {
            this.trace('webview-ready', { generation: this.generation });
            this.webviewReady = true;
            await this.sendInit();
            return;
        }
        if (m.type === 'lifecycle') {
            this.trace(`webview-${m.event}`, {
                generation: m.panelGeneration,
                nrow: m.nrow,
                columns: m.columns,
                visibleRows: m.visibleRows,
                visibleRangeStart: m.visibleRangeStart,
                visibleRangeEnd: m.visibleRangeEnd,
                viewportRangeStart: m.viewportRangeStart,
                viewportRangeEnd: m.viewportRangeEnd,
                focusCell: m.focusCell,
                timestamp: m.timestamp,
            });
            // Cache the range only when both fields are finite numbers.
            // panel.ts is the trust boundary for messages from the webview;
            // narrow defensively so a malformed message can never store
            // {start: NaN, end: undefined as number} into lastVisibleRange.
            if (m.panelGeneration === this.generation
                && Number.isFinite(m.visibleRangeStart)
                && Number.isFinite(m.visibleRangeEnd)) {
                this.lastVisibleRange = {
                    start: m.visibleRangeStart,
                    end: m.visibleRangeEnd,
                };
            }
            if (m.panelGeneration === this.generation
                && Number.isFinite(m.viewportRangeStart)
                && Number.isFinite(m.viewportRangeEnd)) {
                this.lastViewportRange = {
                    start: m.viewportRangeStart,
                    end: m.viewportRangeEnd,
                };
            }
            if (m.panelGeneration === this.generation) {
                this.lastFocusCell = m.focusCell
                    && Number.isFinite(m.focusCell.row)
                    && Number.isFinite(m.focusCell.col)
                    ? { row: m.focusCell.row, col: m.focusCell.col }
                    : undefined;
            }
            return;
        }
        // Save messages are keyed by their carried schemaHash, not by the
        // panel's current generation. A debounced saveLayout/saveToolbar
        // can land after a replace bumped the generation; it's still valid
        // for the schemaHash it was tagged with at schedule time.
        if (m.type === 'saveLayout') {
            this.trace('save-layout', {
                schemaHash: m.schemaHash,
                hidden: m.layout.hiddenColumns,
                widths: Object.keys(m.layout.columnWidths).length,
            });
            if (m.schemaHash) {
                this.layout = m.layout;
                await this.store.save(this.panelName, m.schemaHash, m.layout);
            }
            return;
        }
        if (m.type === 'saveToolbar') {
            this.trace('save-toolbar', {
                schemaHash: m.schemaHash,
                toolbar: m.toolbar,
            });
            if (m.schemaHash) {
                await this.toolbarStore.save(this.panelName, m.schemaHash, m.toolbar);
            }
            return;
        }
        if (m.type === 'saveSort') {
            this.trace('save-sort', {
                schemaHash: m.schemaHash,
                keys: m.sort.keys,
            });
            if (m.schemaHash && this.settings.persistSort) {
                if (m.sort.keys.length === 0) {
                    await this.sortStore.clear(this.panelName, m.schemaHash);
                } else {
                    await this.sortStore.save(this.panelName, m.schemaHash, m.sort);
                }
            }
            return;
        }
        if (m.panelGeneration !== this.generation) return;
        // Capture generation BEFORE any await so a replace mid-fetch causes
        // us to drop the stale response rather than post under the new
        // generation.
        const gen = this.generation;
        switch (m.type) {
            case 'getRows': {
                const reader = this.reader;
                reader.setLatestViewportGeneration(m.viewportGeneration);
                this.trace('get-rows', {
                    generation: m.panelGeneration,
                    requestId: m.requestId,
                    viewportGeneration: m.viewportGeneration,
                    start: m.start,
                    end: m.end,
                    columns: m.columns.length,
                });
                let out;
                try {
                    out = await reader.getRows({
                        start: m.start,
                        end: m.end,
                        columns: m.columns,
                        viewportGeneration: m.viewportGeneration,
                        permutation: this.permutation,
                    });
                } catch (err) {
                    if (gen !== this.generation || reader !== this.reader || this.disposed) return;
                    throw err;
                }
                if (gen !== this.generation || reader !== this.reader) return;
                const reply: ExtensionToWebview = {
                    type: 'rows',
                    panelGeneration: gen,
                    requestId: m.requestId,
                    viewportGeneration: m.viewportGeneration,
                    start: m.start,
                    end: m.end,
                    rows: out.rows,
                    stale: out.stale,
                    originalRowIndices: out.originalRowIndices,
                };
                this.trace('post-rows', {
                    generation: gen,
                    requestId: m.requestId,
                    start: m.start,
                    end: m.end,
                    rows: out.rows.length,
                    stale: out.stale,
                });
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
            case 'copy': {
                await this.handleCopy(m, gen);
                return;
            }
            case 'setSort': {
                await this.handleSetSort(m, gen);
                return;
            }
        }
    }

    private async handleSetSort(
        m: Extract<WebviewToExtension, { type: 'setSort' }>,
        gen: number,
    ): Promise<void> {
        // Clear the current permutation and let the webview render a
        // "Sorting…" indicator while we work. For empty `keys`, this is
        // also the final state (no apply pass needed).
        this.sortGeneration += 1;
        const mySortGen = this.sortGeneration;
        if (m.keys.length === 0) {
            this.sort = EMPTY_SORT;
            this.permutation = undefined;
            const ack: ExtensionToWebview = {
                type: 'sortApplied',
                panelGeneration: gen,
                requestId: m.requestId,
                sort: EMPTY_SORT,
                fromPersistence: false,
            };
            await this.webviewPanel.webview.postMessage(ack);
            return;
        }

        const pending: ExtensionToWebview = {
            type: 'sortStatus',
            panelGeneration: gen,
            state: 'pending',
        };
        await this.webviewPanel.webview.postMessage(pending);

        let perm: Uint32Array;
        try {
            perm = await computePermutation(this.reader, m.keys, {
                labelsOn: m.labelsOn,
                formatOn: m.formatOn,
                digits: m.digits,
            });
        } catch (err) {
            // Drop the failure entirely if a newer setSort or a panel
            // replace landed while computePermutation was in flight —
            // publishing a stale idle/error pair would either confuse the
            // status bar (clearing a "Sorting…" that belongs to a newer
            // request) or surface an error that's no longer relevant.
            if (gen !== this.generation
                || mySortGen !== this.sortGeneration
                || this.disposed) {
                return;
            }
            const idle: ExtensionToWebview = {
                type: 'sortStatus',
                panelGeneration: gen,
                state: 'idle',
            };
            await this.webviewPanel.webview.postMessage(idle);
            const errMsg: ExtensionToWebview = {
                type: 'error',
                panelGeneration: gen,
                message: err instanceof Error ? err.message : String(err),
            };
            await this.webviewPanel.webview.postMessage(errMsg);
            return;
        }

        // If another setSort raced in front, or the panel was replaced,
        // discard our result without publishing.
        if (gen !== this.generation || mySortGen !== this.sortGeneration) return;

        const next: SortState = {
            keys: m.keys,
            labelsOnWhenSorted: m.labelsOn,
        };
        this.sort = next;
        this.permutation = perm;

        const idle: ExtensionToWebview = {
            type: 'sortStatus',
            panelGeneration: gen,
            state: 'idle',
        };
        await this.webviewPanel.webview.postMessage(idle);
        const ack: ExtensionToWebview = {
            type: 'sortApplied',
            panelGeneration: gen,
            requestId: m.requestId,
            sort: next,
            fromPersistence: false,
        };
        await this.webviewPanel.webview.postMessage(ack);
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
            permutation: this.permutation,
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
            m.labelsOn, m.formatOn, m.digits, resolved, m.includeHeader,
        );
        try {
            await vscode.env.clipboard.writeText(tsv);
            await this.webviewPanel.webview.postMessage(replyDone(true));
        } catch (err) {
            await this.webviewPanel.webview.postMessage(
                replyDone(false, err instanceof Error ? err.message : String(err)));
        }
    }

    /** Latest visible-row range from the most recent lifecycle message,
     *  or undefined if none has arrived yet. Used by the test harness to
     *  verify scroll position. Returns a defensive copy so callers cannot
     *  mutate the internal state. */
    getVisibleRange(): { start: number; end: number } | undefined {
        return this.lastVisibleRange
            ? { ...this.lastVisibleRange }
            : undefined;
    }

    /** Latest on-screen row range from the most recent lifecycle message,
     *  excluding overscan rows. */
    getViewportRange(): { start: number; end: number } | undefined {
        return this.lastViewportRange
            ? { ...this.lastViewportRange }
            : undefined;
    }

    /** Latest selected focus cell from the most recent lifecycle message. */
    getFocusCell(): { row: number; col: number } | undefined {
        return this.lastFocusCell
            ? { ...this.lastFocusCell }
            : undefined;
    }

    /** Test-only: post a `testKey` message to the webview so it dispatches
     *  a synthetic KeyboardEvent on `window`. Awaiting the returned promise
     *  waits for the message to be queued, not for any reply; tests should
     *  poll `getVisibleRange()` to observe the result. */
    async pressKey(key: string): Promise<void> {
        if (this.disposed) return;
        const msg: ExtensionToWebview = {
            type: 'testKey',
            panelGeneration: this.generation,
            key,
        };
        await this.webviewPanel.webview.postMessage(msg);
    }

    /** Test-only: post a `testScrollToFraction` message to the webview
     *  so it scrolls through the grid's imperative scroll API. fraction=0
     *  jumps to top, fraction=1 jumps to bottom. Non-finite inputs are
     *  rejected, and finite values are clamped to [0, 1] to keep test
     *  behavior deterministic. Awaiting waits for the message to be
     *  queued, not for any reply; tests should poll
     *  `getVisibleRange()` to observe the result. */
    async dragScrollbar(fraction: number): Promise<void> {
        if (this.disposed) return;
        if (!Number.isFinite(fraction)) {
            throw new RangeError('fraction must be a finite number');
        }
        const clampedFraction = Math.min(1, Math.max(0, fraction));
        const msg: ExtensionToWebview = {
            type: 'testScrollToFraction',
            panelGeneration: this.generation,
            fraction: clampedFraction,
        };
        await this.webviewPanel.webview.postMessage(msg);
    }

    /** Column names in schema order — used by the test harness. */
    getColumnNames(): string[] {
        return this.columns.map(c => c.name);
    }

    private async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.trace('dispose', {});
        await this.reader.close().catch(() => undefined);
        try { await fs.unlink(this.filePath); } catch { /* ignore */ }
        this.disposeHook();
    }

    private trace(event: string, details: Record<string, unknown>): void {
        const traceLevel = vscode.workspace.getConfiguration('raven')
            .get<string>('trace.server', 'off');
        if (traceLevel === 'off') return;
        const payload = {
            traceId: this.traceId,
            panelName: this.panelName,
            event,
            ...details,
        };
        console.info('[Raven data viewer]', payload);
        if (!dataViewerTraceOutput) {
            dataViewerTraceOutput = vscode.window.createOutputChannel('Raven Data Viewer');
        }
        dataViewerTraceOutput.appendLine(JSON.stringify(payload));
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
