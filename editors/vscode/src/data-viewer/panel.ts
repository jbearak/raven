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
    EMPTY_FILTER,
    EMPTY_SORT,
    ExtensionToWebview,
    FilterState,
    HistogramBin,
    Layout,
    Settings,
    SortState,
    WebviewToExtension,
} from './messages';
import { computePermutation } from './sort';
import { computeFilteredIndices } from './filter';
import { isAbortError } from './abort';
import { computeHistogramForColumn, isNumericArrowType } from './histograms';
import { LayoutStore, schemaHash } from './layout-state';
import { ToolbarState, ToolbarStateStore } from './toolbar-state';
import { SortStateStore } from './sort-state';
import { FilterStateStore } from './filter-state';
import { build_csp } from './csp';
import { render_tsv, ResolvedLabels } from './tsv';
import { applyViewerTabIcon } from '../viewer-tab-icon';

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
    /** Current filter state. Mirrors what the webview shows in the chip
     *  strip. Updated by `setFilters` and by init/replace's restore path. */
    private filter: FilterState = EMPTY_FILTER;
    /** Row indices surviving the active filter, in original (unsorted)
     *  order. `undefined` ↔ no filter active (all rows pass). */
    private filteredIndices: Uint32Array | undefined;
    /** Monotonic counter — bumped on every setFilters call so stale
     *  async results can be detected and dropped. */
    private filterGeneration = 0;
    /** Per-column numeric histogram cache, keyed by column index, for the
     *  current reader. Populated lazily by the `getHistogram` handler (a
     *  histogram costs two full column scans, so we never recompute one).
     *  Cleared on `replace()` because the new reader is a different dataset. */
    private histogramCache = new Map<number, HistogramBin[]>();
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
    // --- Saved-sort/filter restore on open (#519) ---
    /** Controls the in-flight restore's column reads. A webview Cancel
     *  aborts it; cancellation is read from the captured signal, not a
     *  shared boolean, so a concurrent send can't erase an in-flight
     *  cancel. */
    private restoreAbort: AbortController | null = null;
    /** True while a cancellable restore is reading columns. Gates the
     *  in-flight vs. already-completed cancel paths and makes interactive
     *  setSort/setFilters no-op so a generation bump can't strand it. */
    private restoring = false;
    /** Monotonic id of the active restore (-1 ⇔ none). The
     *  restorePending/cancelRestore handshake key. NOT `generation` —
     *  webviewReady reloads do not bump generation, so reusing it would
     *  alias restores across a reload. */
    private restoreId = -1;
    /** Source of {@link restoreId}; bumped per restore begun. */
    private restoreSeq = 0;
    /** True when the user clicked Cancel on an in-flight restore but the
     *  abort has not yet been observed by paintWithRestore. Lets a webview
     *  reload that races into that window honor the cancel (forget the
     *  prefs) instead of bailing stale and re-restoring them. */
    private restoreCancelRequested = false;
    /** Active toolbar last shipped to the webview, captured so the late
     *  clear-and-forget can rebuild a `replace` without re-loading the
     *  store. */
    private lastToolbar: ToolbarState | undefined;
    /** Serializes sendInit/sendReplace so two restores never overlap (a
     *  reload mid-restore must not start a concurrent send that overwrites
     *  {@link restoreAbort}). */
    private sendChain: Promise<void> = Promise.resolve();

    private constructor(
        panelName: string,
        webviewPanel: vscode.WebviewPanel,
        reader: ArrowSliceReader,
        filePath: string,
        private readonly store: LayoutStore,
        private readonly toolbarStore: ToolbarStateStore,
        private readonly sortStore: SortStateStore,
        private readonly filterStore: FilterStateStore,
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
        filterStore: FilterStateStore,
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
        applyViewerTabIcon(webviewPanel, 'table');
        webviewPanel.webview.html = build_html(webviewPanel.webview, extensionUri);
        const panel = new DataViewerPanel(
            panelName, webviewPanel, reader, filePath,
            store, toolbarStore, sortStore, filterStore, settings, disposeHook,
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
        // Abort any in-flight restore from the previous dataset. The
        // generation bump above makes it bail *stale* (prefs intact); the
        // abort frees the serialized send chain so sendReplace below isn't
        // stuck behind the dropped read. But if the user had clicked Cancel
        // on that restore, honor it (forget the prev dataset's prefs) before
        // re-arming — abortAndClearRestore clears the flag, so capture it
        // (and the prev schema hash, while this.reader is still the old one)
        // first. Mirrors the webviewReady reload path.
        const restoreCancelled = this.restoreCancelRequested;
        const prevSchemaHash = this.currentSchemaHash();
        this.abortAndClearRestore();
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
        // Old filtered indices cannot be reused — sendReplace below will
        // attempt to restore a saved filter against the new reader.
        this.filter = EMPTY_FILTER;
        this.filteredIndices = undefined;
        this.filterGeneration += 1;
        // Histograms are reader-scoped; the new reader is a different dataset.
        this.histogramCache.clear();
        const prevReader = this.reader;
        const prevPath = this.filePath;
        this.reader = reader;
        this.filePath = filePath;
        this.trace('replace', { filePath, nrow: reader.nrow, columns: reader.schema.columns.length });
        // Honor a cancel of the previous dataset's restore by forgetting its
        // prefs before sendReplace re-reads the store (so a same-schema reopen
        // does not silently re-apply what the user cancelled).
        if (restoreCancelled) await this.forgetPersistedPrefs(prevSchemaHash);
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

    // sendInit / sendReplace are serialized through `sendChain` so two
    // restores never overlap. The chain wraps only these public entry
    // points; internal delegation (an uninitialized replace) calls the
    // *impl* directly so it never awaits a job queued behind itself.
    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.sendChain.catch(() => {}).then(fn);
        this.sendChain = next.then(() => {}, () => {});
        return next;
    }

    private sendInit(): Promise<boolean> {
        return this.enqueue(() => this.sendInitImpl());
    }

    private sendReplace(): Promise<void> {
        return this.enqueue(() => this.sendReplaceImpl());
    }

    private sendInitImpl(): Promise<boolean> {
        return this.paintWithRestore('init');
    }

    private async sendReplaceImpl(): Promise<void> {
        if (!this.webviewInitialized) {
            await this.sendInitImpl();
            return;
        }
        await this.paintWithRestore('replace');
    }

    /**
     * Load persisted state, (re)apply any saved sort/filter against the
     * current reader, and post the paint-enabling `init`/`replace`. When
     * a saved pref applies, a cancellable restore is begun first: a
     * `restorePending` precedes the (potentially long) column reads so the
     * webview can explain the wait and offer Cancel (#519).
     *
     * On Cancel the restore is abandoned, the in-memory sort/filter reset,
     * the persisted prefs forgotten, and the grid shown in natural order.
     * A genuine (non-abort) read failure instead keeps the prefs and warns.
     */
    private async paintWithRestore(kind: 'init' | 'replace'): Promise<boolean> {
        const generation = this.generation;
        const reader = this.reader;
        const columns = reader.schema.columns;
        const layoutHash = schemaHash(columns);
        const [layout, toolbar, savedSort, savedFilter] = await Promise.all([
            this.store.load(this.panelName, layoutHash),
            this.toolbarStore.load(this.panelName, layoutHash),
            this.settings.persistSort
                ? this.sortStore.load(this.panelName, layoutHash)
                : Promise.resolve(undefined),
            this.settings.persistFilters
                ? this.filterStore.load(this.panelName, layoutHash)
                : Promise.resolve(undefined),
        ]);
        if (generation !== this.generation || reader !== this.reader) return false;
        this.columns = columns;
        this.layout = layout ?? { columnWidths: {}, hiddenColumns: [] };
        this.dictionaries = this.collectDictionaries();
        const activeToolbar = toolbar ?? this.defaultToolbar();
        this.lastToolbar = activeToolbar;

        // Begin a cancellable restore if saved prefs apply. `myAbort`
        // identifies this restore's controller; cancellation is read from
        // its own signal so a concurrent send reassigning this.restoreAbort
        // can't change what THIS call sees.
        const began = this.maybeBeginRestore(generation, savedSort, savedFilter);
        const myAbort = began ? this.restoreAbort : null;
        const isCancelled = () => myAbort?.signal.aborted === true;
        try {
            // restoreSort/restoreFilter set this.sort/permutation/filter/
            // filteredIndices as a side effect and return true only on a
            // genuine (non-abort) failure.
            const sortFailed = await this.restoreSort(
                savedSort, activeToolbar, generation, reader, myAbort?.signal,
            );
            // A refresh/reload during the read supersedes this attempt; bail
            // *stale* (prefs intact) before the cancel path. A user Cancel
            // does NOT bump generation, so it falls through to forget below.
            if (generation !== this.generation || reader !== this.reader) return false;
            let filterFailed = false;
            if (!isCancelled()) {
                filterFailed = await this.restoreFilter(
                    savedFilter, activeToolbar, generation, reader, myAbort?.signal,
                );
                if (generation !== this.generation || reader !== this.reader) return false;
            }
            // Snapshot the cancel decision ONCE before the paint. The reads
            // are done; using a single snapshot for resetRestoredPrefs (below)
            // keeps the post/forget/filterApplied branches internally
            // consistent — re-reading the live isCancelled() across the
            // `await postPaint` could split-brain (e.g. suppress filterApplied
            // while leaving filteredIndices applied). A cancel that lands
            // *during* the paint is handled by the cancelledNow branch.
            const cancelledBeforePaint = isCancelled();
            if (cancelledBeforePaint) this.resetRestoredPrefs();

            await this.postPaint(kind, generation, layoutHash, activeToolbar);
            if (kind === 'init') this.webviewInitialized = true;

            // A lifecycle interruption (webview reload / replace()) during the
            // paint bumps generation and aborts our controller. That abort is
            // NOT a user Cancel, so bail *stale* here — before the cancel
            // branch below would misread the aborted signal as a Cancel and
            // wrongly forget the prefs. The interrupting path keeps the prefs
            // (or forgets them itself if the user had actually cancelled) and
            // the queued re-send re-restores. A genuine user Cancel never
            // bumps generation, so it falls through to the branches below.
            if (generation !== this.generation || reader !== this.reader) {
                return false;
            }

            if (cancelledBeforePaint) {
                // Persist the forget only after the paint, so a store-write
                // failure cannot strand the webview waiting on a message it
                // never receives.
                await this.forgetPersistedPrefs(layoutHash);
            } else if (isCancelled()) {
                // The user cancelled during the paint (after the reads, before
                // the finally). The chips were already posted; honor the cancel
                // as a clear-and-forget so the grid ends in natural order.
                await this.clearAndForgetNaturalOrder(layoutHash);
            } else {
                // Normal completion. A restored filter changes the visible row
                // count; the webview learns the effective count from
                // filterApplied (metadata.nrow stays the full dataset size).
                if (this.filteredIndices) {
                    await this.webviewPanel.webview.postMessage({
                        type: 'filterApplied',
                        panelGeneration: generation,
                        requestId: -1,
                        filter: this.filter,
                        nrowFiltered: this.filteredIndices.length,
                        fromPersistence: true,
                    } satisfies ExtensionToWebview);
                }
                if (sortFailed || filterFailed) {
                    const what = sortFailed && filterFailed
                        ? 'sort and filter'
                        : sortFailed ? 'sort' : 'filter';
                    vscode.window.showWarningMessage(
                        `Could not reapply the saved ${what} for this dataset; `
                        + 'it was not applied.',
                    );
                }
            }
            return true;
        } finally {
            // Only the call that began this restore clears its state, and
            // only if a concurrent refresh hasn't swapped in a newer one.
            if (began && this.restoreAbort === myAbort) {
                this.restoring = false;
                this.restoreAbort = null;
            }
        }
    }

    /** Build and post the paint-enabling init/replace message from the
     *  current in-memory state (sort/filter are EMPTY after a cancel, so
     *  no chips render). */
    private async postPaint(
        kind: 'init' | 'replace',
        generation: number,
        layoutHash: string,
        activeToolbar: ToolbarState,
    ): Promise<void> {
        const common = {
            panelGeneration: generation,
            nrow: this.reader.nrow,
            columns: this.columns,
            layout: this.layout,
            toolbar: activeToolbar,
            dictionaries: this.dictionaries,
            schemaHash: layoutHash,
            sort: this.sort,
            filter: this.filter,
        };
        const msg: ExtensionToWebview = kind === 'init'
            ? { type: 'init', ...common, settings: this.settings }
            : { type: 'replace', ...common };
        this.trace(`post-${kind}`, {
            generation,
            nrow: this.reader.nrow,
            columns: this.columns.length,
            schemaHash: layoutHash,
            loadedLayoutHidden: this.layout.hiddenColumns,
            loadedToolbar: activeToolbar,
        });
        await this.webviewPanel.webview.postMessage(msg);
    }

    // -------------------------------------------------------
    // Saved-preference restore handshake (#519)
    // -------------------------------------------------------

    /** Whether `saved` references only columns that still exist. */
    private columnsInRange(indices: number[]): boolean {
        const max = this.columns.length - 1;
        return indices.every(i => i >= 0 && i <= max);
    }

    /**
     * If a saved sort and/or filter applies to the current dataset, arm a
     * cancellable restore (fresh AbortController, fresh restoreId) and post
     * `restorePending` before the column reads. Returns whether one began.
     *
     * Applicability mirrors the real restore guards: a sort is applicable
     * iff it has keys all in range (restoreSort drops it otherwise); a
     * filter iff it has an in-range, enabled entry (restoreFilter rejects
     * any out-of-range entry, and computeFilteredIndices only reads when an
     * enabled entry survives) — so the banner appears iff a heavy read will
     * actually run.
     */
    private maybeBeginRestore(
        generation: number,
        savedSort: SortState | undefined,
        savedFilter: FilterState | undefined,
    ): boolean {
        const hasSort = this.settings.persistSort
            && !!savedSort
            && savedSort.keys.length > 0
            && this.columnsInRange(savedSort.keys.map(k => k.columnIndex));
        const hasFilter = this.settings.persistFilters
            && !!savedFilter
            && savedFilter.entries.length > 0
            && this.columnsInRange(savedFilter.entries.map(e => e.columnIndex))
            && savedFilter.entries.some(e => e.enabled);
        if (!hasSort && !hasFilter) return false;

        this.restoreAbort = new AbortController();
        this.restoreId = ++this.restoreSeq;
        this.restoring = true;
        this.restoreCancelRequested = false;
        void this.webviewPanel.webview.postMessage({
            type: 'restorePending',
            panelGeneration: generation,
            restoreId: this.restoreId,
            sort: hasSort,
            filter: hasFilter,
        } satisfies ExtensionToWebview);
        return true;
    }

    /** Drop the restored sort/filter from memory and consume the handshake
     *  (synchronous). The caller persists the forget separately. */
    private resetRestoredPrefs(): void {
        this.restoreId = -1;
        // NB: deliberately does NOT clear restoreCancelRequested. That flag is
        // the user's "forget" intent and is consumed only by maybeBeginRestore
        // (a fresh restore) or abortAndClearRestore (a lifecycle path reads it
        // first). Clearing it here would let a lifecycle interruption that
        // races the paint lose a cancel the user already requested.
        this.sort = EMPTY_SORT;
        this.permutation = undefined;
        this.sortGeneration += 1;
        this.filter = EMPTY_FILTER;
        this.filteredIndices = undefined;
        this.filterGeneration += 1;
    }

    /** Consume the restore handshake because the user superseded the
     *  restored prefs (a new sort/filter), so a later cancelRestore with
     *  the old id can no longer reach the clear-and-forget branch. */
    private consumeRestoreHandshake(): void {
        this.restoreId = -1;
    }

    /** Abort the in-flight restore's reads and clear the handshake. Used by
     *  the lifecycle-interruption paths (a webview reload and replace()):
     *  both bump generation first, which makes the aborted restore bail
     *  *stale* (prefs intact), while the abort lets the serialized chain
     *  advance at once instead of waiting on the dropped read. */
    private abortAndClearRestore(): void {
        this.restoreAbort?.abort();
        this.restoreAbort = null;
        this.restoring = false;
        this.restoreId = -1;
        this.restoreCancelRequested = false;
    }

    /** Schema hash of the live reader — used by the late clear-and-forget
     *  path, which runs outside the send methods (where `layoutHash` is a
     *  local). */
    private currentSchemaHash(): string {
        return schemaHash(this.reader.schema.columns);
    }

    /** Forget the persisted sort/filter for this dataset × schema. */
    private async forgetPersistedPrefs(hash: string): Promise<void> {
        if (this.settings.persistSort) {
            await this.sortStore.clear(this.panelName, hash);
        }
        if (this.settings.persistFilters) {
            await this.filterStore.clear(this.panelName, hash);
        }
    }

    /** Post a natural-order `replace` from in-memory state at the given
     *  (already-bumped) generation, so the webview adopts the new
     *  generation and drops chips. Used by the late clear-and-forget. */
    private async postReplaceNaturalOrder(generation: number): Promise<void> {
        await this.postPaint(
            'replace',
            generation,
            this.currentSchemaHash(),
            this.lastToolbar ?? this.defaultToolbar(),
        );
    }

    /**
     * Handle a webview Cancel of the saved-preference restore. Ignores a
     * stale/consumed id. While the restore is in flight, aborts the column
     * reads (paintWithRestore's cancelled path forgets + posts natural
     * order). If the restore already completed (the cross-window race),
     * honors the click as an explicit clear-and-forget so it is never
     * silently dropped.
     */
    private async handleCancelRestore(
        msg: Extract<WebviewToExtension, { type: 'cancelRestore' }>,
    ): Promise<void> {
        if (msg.restoreId !== this.restoreId) return;
        if (this.restoring) {
            // Record the cancel intent so a webview reload that races the
            // abort (and bumps generation, making paintWithRestore bail
            // stale) still forgets the prefs rather than re-restoring them.
            this.restoreCancelRequested = true;
            this.restoreAbort?.abort();
            return;
        }
        // The restore already completed (the cross-window race): honor the
        // click as a clear-and-forget so it is never silently dropped.
        await this.clearAndForgetNaturalOrder(this.currentSchemaHash());
    }

    /**
     * Drop the restored sort/filter to natural order and forget the
     * persisted prefs. Bumps the generation and clears the row state
     * synchronously (BEFORE awaiting the store writes) so an in-flight
     * getRows reply under the old effective permutation is dropped by the
     * generation gate, then posts a natural-order `replace` so the webview
     * adopts the new generation and drops the chips. Shared by the
     * late-cancel path and the cancel-during-paint path.
     */
    private async clearAndForgetNaturalOrder(hash: string): Promise<void> {
        this.resetRestoredPrefs();
        this.generation += 1;
        await this.postReplaceNaturalOrder(this.generation);
        await this.forgetPersistedPrefs(hash);
    }

    /** Attempt to restore a persisted sort, updating `this.sort` and
     *  `this.permutation` as a side effect (the caller reads them when
     *  building the paint message). Returns true iff a genuine (non-abort)
     *  read failure occurred, so the caller can warn and keep the saved
     *  pref; a user-Cancel abort returns false (silent natural order).
     *  Always recomputes the permutation against the current reader —
     *  schema-hash equality is not evidence that two datasets share row
     *  values, so the only persisted truth is the list of sort keys. The
     *  sort is dropped (no failure) when:
     *    - persistSort is off,
     *    - no saved state exists,
     *    - the saved state had no keys (already empty), or
     *    - any key references a column that no longer exists.
     *  An optional `signal` makes the column reads cancellable (#519).
     *  Caller is responsible for the post-await generation check. */
    private async restoreSort(
        saved: SortState | undefined,
        toolbar: ToolbarState,
        generation: number,
        reader: ArrowSliceReader,
        signal?: AbortSignal,
    ): Promise<boolean> {
        this.sort = EMPTY_SORT;
        this.permutation = undefined;
        if (!saved || saved.keys.length === 0) return false;
        const maxColIndex = this.columns.length - 1;
        for (const k of saved.keys) {
            if (k.columnIndex < 0 || k.columnIndex > maxColIndex) return false;
        }
        try {
            const perm = await computePermutation(reader, saved.keys, {
                labelsOn: toolbar.labelsOn,
                formatOn: toolbar.formatOn,
                digits: toolbar.digits,
            }, { signal });
            if (generation !== this.generation || reader !== this.reader) return false;
            this.sort = {
                keys: saved.keys,
                labelsOnWhenSorted: toolbar.labelsOn,
            };
            this.permutation = perm;
            this.sortGeneration += 1;
            return false;
        } catch (err) {
            // A user Cancel aborts the read → natural order, silent. A
            // genuine read failure → natural order, but report so the
            // caller can warn and keep the saved pref for next time.
            return !isAbortError(err);
        }
    }

    /** Attempt to restore a persisted filter, updating `this.filter` and
     *  `this.filteredIndices` as a side effect. Returns true iff a genuine
     *  (non-abort) read failure occurred (see {@link restoreSort}); a
     *  user-Cancel abort returns false. The filter is dropped (no failure)
     *  when:
     *    - persistFilters is off,
     *    - no saved state exists,
     *    - the saved state had no entries (already empty), or
     *    - any entry references a column that no longer exists.
     *  An optional `signal` makes the column reads cancellable (#519).
     *  Caller is responsible for the post-await generation check. */
    private async restoreFilter(
        saved: FilterState | undefined,
        toolbar: ToolbarState,
        generation: number,
        reader: ArrowSliceReader,
        signal?: AbortSignal,
    ): Promise<boolean> {
        this.filter = EMPTY_FILTER;
        this.filteredIndices = undefined;
        if (!saved || saved.entries.length === 0) return false;
        const maxColIndex = this.columns.length - 1;
        for (const e of saved.entries) {
            if (e.columnIndex < 0 || e.columnIndex > maxColIndex) return false;
        }
        try {
            const indices = await computeFilteredIndices(reader, saved, {
                labelsOn: toolbar.labelsOn,
                formatOn: toolbar.formatOn,
                digits: toolbar.digits,
            }, { signal });
            if (generation !== this.generation || reader !== this.reader) return false;
            this.filter = { entries: saved.entries, labelsOnWhenFiltered: toolbar.labelsOn };
            this.filteredIndices = indices;
            this.filterGeneration += 1;
            return false;
        } catch (err) {
            // Cancel → natural order silently; genuine failure → natural
            // order, reported so the caller can warn and keep the filter.
            return !isAbortError(err);
        }
    }

    /** Combine filter + sort into the single permutation handed to the
     *  reader. `filteredIndices` is the surviving row set in ORIGINAL order;
     *  `permutation` (when present) is a sort permutation over the ORIGINAL
     *  frame. We post-filter the sort permutation by the filteredIndices set
     *  so the visible window reflects both, in sorted order.
     *
     *  Spec open-question 4 / follow-up #328: building the sort permutation
     *  over the full nrow rather than the filtered domain wastes memory; the
     *  first cut accepts that. */
    private composeEffective(): Uint32Array | undefined {
        if (!this.filteredIndices) return this.permutation;
        if (!this.permutation) return this.filteredIndices;
        const survives = new Uint8Array(this.reader.nrow);
        for (let i = 0; i < this.filteredIndices.length; i++) survives[this.filteredIndices[i]] = 1;
        const out = new Uint32Array(this.filteredIndices.length);
        let j = 0;
        for (let i = 0; i < this.permutation.length; i++) {
            if (survives[this.permutation[i]]) out[j++] = this.permutation[i];
        }
        return out;
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
            // A webview reload mid-restore is a lifecycle interruption, not
            // a user Cancel: bump generation so the abandoned restore bails
            // *stale* (prefs intact) rather than taking the cancel/forget
            // path, then abort it so the serialized chain advances at once.
            // The queued sendInit re-reads from the store and re-restores
            // (raven has no one-shot restored flags).
            if (this.restoring) {
                // If the user had clicked Cancel on this restore, honor it:
                // forget the prefs durably before re-arming, so the queued
                // re-send shows natural order instead of re-restoring. A pure
                // reload (no pending cancel) keeps the prefs.
                const cancelled = this.restoreCancelRequested;
                const hash = this.currentSchemaHash();
                this.generation += 1;
                this.abortAndClearRestore();
                if (cancelled) await this.forgetPersistedPrefs(hash);
            }
            await this.sendInit();
            return;
        }
        if (m.type === 'cancelRestore') {
            await this.handleCancelRestore(m);
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
        if (m.type === 'saveFilter') {
            if (m.schemaHash && this.settings.persistFilters) {
                if (m.filter.entries.length === 0) {
                    await this.filterStore.clear(this.panelName, m.schemaHash);
                } else {
                    await this.filterStore.save(this.panelName, m.schemaHash, m.filter);
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
                const effectivePerm = this.composeEffective();
                try {
                    out = await reader.getRows({
                        start: m.start,
                        end: m.end,
                        columns: m.columns,
                        viewportGeneration: m.viewportGeneration,
                        permutation: effectivePerm,
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
            case 'getHistogram': {
                const reader = this.reader;
                const ci = m.columnIndex;
                let bins = this.histogramCache.get(ci);
                if (!bins) {
                    // panel.ts is the trust boundary for webview messages.
                    // Only scan a valid, numeric column; an out-of-range or
                    // non-numeric index (a malformed/future caller — the UI
                    // gates on colKind) degrades to an empty histogram without
                    // launching a wasted full-column scan. A decode error must
                    // likewise still produce a reply — otherwise the webview's
                    // in-flight marker for this column never clears and the
                    // brush stays blank forever with no retry (unlike getRows,
                    // a missing histogram reply is unrecoverable). All degrade
                    // to "no brush". The whole-grid getRows path would also be
                    // failing if a batch genuinely can't decode, and a decode
                    // failure on a fixed Arrow file is deterministic, so the
                    // empty result is cached below rather than re-scanning on
                    // every popover reopen.
                    const cols = reader.schema.columns;
                    const scannable = Number.isInteger(ci) && ci >= 0 && ci < cols.length
                        && isNumericArrowType(cols[ci].arrowType);
                    if (!scannable) {
                        bins = [];
                    } else {
                        try {
                            bins = await computeHistogramForColumn(reader, ci);
                        } catch {
                            bins = [];
                        }
                    }
                    // After the await: drop if the panel was disposed or the
                    // dataset was swapped (mirrors the getRows handler) — no
                    // reply is owed, the new generation's webview already
                    // cleared its in-flight marker. A concurrent request for
                    // the same column may have cached a result meanwhile;
                    // first writer wins so a late error-[] never clobbers it.
                    if (this.disposed || gen !== this.generation || reader !== this.reader) return;
                    const existing = this.histogramCache.get(ci);
                    if (existing) bins = existing;
                    else this.histogramCache.set(ci, bins);
                }
                const reply: ExtensionToWebview = {
                    type: 'histogram',
                    panelGeneration: gen,
                    requestId: m.requestId,
                    columnIndex: ci,
                    bins,
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
            case 'setFilters': {
                await this.handleSetFilters(m, gen);
                return;
            }
        }
    }

    private async handleSetSort(
        m: Extract<WebviewToExtension, { type: 'setSort' }>,
        gen: number,
    ): Promise<void> {
        // Ignore interactive sort while a saved-preference restore is in
        // flight: a generation bump here would make the restore discard its
        // result without posting init/replace, stranding the panel. The
        // restore posts authoritative state momentarily.
        if (this.restoring) return;
        // The user is superseding the restored prefs, so the restore
        // handshake is over — a delayed cancelRestore with the old id must
        // not reach the clear-and-forget branch and wipe this.
        this.consumeRestoreHandshake();

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
            // publishing a stale idle/error pair would either clear a
            // "Sorting…" pill that belongs to a newer request or surface
            // an error that's no longer relevant.
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

    private async handleSetFilters(
        m: Extract<WebviewToExtension, { type: 'setFilters' }>,
        gen: number,
    ): Promise<void> {
        // Ignore interactive filter while a restore is in flight (see
        // handleSetSort), then consume the handshake when superseding.
        if (this.restoring) return;
        this.consumeRestoreHandshake();

        this.filterGeneration += 1;
        const myFilterGen = this.filterGeneration;
        const next: FilterState = { entries: m.entries, labelsOnWhenFiltered: m.labelsOn };

        if (m.entries.length === 0 || m.entries.every(e => !e.enabled)) {
            this.filter = next;
            this.filteredIndices = undefined;
            await this.webviewPanel.webview.postMessage({
                type: 'filterApplied', panelGeneration: gen, requestId: m.requestId,
                filter: next, nrowFiltered: this.reader.nrow, fromPersistence: false,
            } satisfies ExtensionToWebview);
            return;
        }

        await this.webviewPanel.webview.postMessage({
            type: 'filterStatus', panelGeneration: gen, state: 'pending',
        } satisfies ExtensionToWebview);

        let indices: Uint32Array | undefined;
        try {
            indices = await computeFilteredIndices(this.reader, next, {
                labelsOn: m.labelsOn,
                formatOn: true,
                digits: this.settings.defaultDigits,
            });
        } catch (err) {
            if (gen !== this.generation || myFilterGen !== this.filterGeneration || this.disposed) return;
            await this.webviewPanel.webview.postMessage({
                type: 'filterStatus', panelGeneration: gen, state: 'idle',
            } satisfies ExtensionToWebview);
            await this.webviewPanel.webview.postMessage({
                type: 'error', panelGeneration: gen,
                message: err instanceof Error ? err.message : String(err),
            } satisfies ExtensionToWebview);
            return;
        }

        if (gen !== this.generation || myFilterGen !== this.filterGeneration) return;
        this.filter = next;
        this.filteredIndices = indices;
        await this.webviewPanel.webview.postMessage({
            type: 'filterStatus', panelGeneration: gen, state: 'idle',
        } satisfies ExtensionToWebview);
        await this.webviewPanel.webview.postMessage({
            type: 'filterApplied', panelGeneration: gen, requestId: m.requestId,
            filter: next, nrowFiltered: indices?.length ?? this.reader.nrow, fromPersistence: false,
        } satisfies ExtensionToWebview);
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
        const copyPerm = this.composeEffective();
        const got = await this.reader.getRows({
            start: m.range.rowStart,
            end: m.range.rowEnd,
            columns: m.range.colIndices,
            viewportGeneration: Number.MAX_SAFE_INTEGER,
            permutation: copyPerm,
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
