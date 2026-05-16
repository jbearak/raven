<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import type {
        ExtensionToWebview,
        Layout,
        Settings,
        WebviewToExtension,
    } from '../messages';
    import type { Cell } from '../wire-format';
    import type { ColumnSchema } from '../arrow-reader';
    import {
        visibleRange, coalesceScroll,
        cappedScrollHeight, logicalScrollTop, visualOffsetPx,
        MAX_SCROLL_PX, HORIZONTAL_GUTTER_PX,
    } from './grid-model';
    import { RowCache } from './row-cache';
    import { Selection } from './selection-model';
    import { formatCell } from './cell-render';
    import Toolbar from './Toolbar.svelte';
    import CustomScrollbar from './CustomScrollbar.svelte';
    type PersistedState = {
        panelGeneration: number;
        nrow: number;
        columns: ColumnSchema[];
        dictionaries: Record<number, string[]>;
        layout: Layout;
        settings: Settings;
        labelsOn: boolean;
        formatOn: boolean;
        digits: number;
        objectClass?: string;
        visibleRows: Cell[][];
        visibleRangeStart: number;
    };

    interface Props {
        vscode: {
            postMessage(msg: WebviewToExtension): void;
            setState?(state: PersistedState): void;
        };
        initialState?: PersistedState;
    }
    let { vscode, initialState: restored }: Props = $props();

    // ----- Panel state -----------------------------------------------------
    let panelGeneration = $state(0);
    let nrow = $state(0);
    let columns = $state<ColumnSchema[]>([]);
    let dictionaries = $state<Record<number, string[]>>({});
    let layout = $state<Layout>({ columnWidths: {}, hiddenColumns: [] });
    let currentSchemaHash = '';
    let settings = $state<Settings>({
        missingValueStyle: 'foreground', defaultDigits: 3,
    });
    let objectClass = $state<string | undefined>(undefined);

    onDestroy(() => {
        postLifecycle('destroy');
    });

    // ----- Toolbar state ---------------------------------------------------
    // Defaults are ON; restorePersistedState (below) overwrites for panels
    // with saved state, so a user who has toggled either off keeps that
    // preference across reloads.
    let labelsOn = $state(true);
    let formatOn = $state(true);
    let digits = $state(3);

    // ----- Row data + virtualization --------------------------------------
    const rowCache = new RowCache(200_000); // ~200k cells
    let viewportEl: HTMLDivElement | null = $state(null);
    let scrollTop = $state(0);
    let viewportHeight = $state(600);
    const ROW_HEIGHT = 24;
    let viewportGeneration = 0;
    let nextRequestId = 0;
    /** Outstanding row requests keyed by requestId. */
    const inflight = new Map<number, { start: number; end: number }>();
    /** Loaded windows in display: parallel to columnsForRender's order. */
    let visibleRows = $state<Cell[][]>([]);
    let visibleRangeStart = $state(0);
    function restorePersistedState(state: PersistedState | undefined): void {
        if (!state) return;
        panelGeneration = state.panelGeneration;
        nrow = state.nrow;
        columns = state.columns;
        dictionaries = state.dictionaries;
        layout = state.layout;
        settings = state.settings;
        labelsOn = state.labelsOn;
        formatOn = state.formatOn;
        digits = state.digits;
        objectClass = state.objectClass;
        visibleRows = state.visibleRows;
        visibleRangeStart = state.visibleRangeStart;
    }
    // svelte-ignore state_referenced_locally
    restorePersistedState(restored);

    // ----- Derived ---------------------------------------------------------
    const hiddenSet = $derived(new Set(layout.hiddenColumns));
    const visibleCols = $derived<number[]>(
        columns
            .map((_c, i) => i)
            .filter(i => !hiddenSet.has(i)),
    );
    const totalGridHeight = $derived(nrow * ROW_HEIGHT);
    const useCustomScrollbar = $derived(totalGridHeight > MAX_SCROLL_PX);
    /** Width of the sticky row-number column, sized to fit the widest row number. */
    const rowColWidth = $derived(`calc(${String(Math.max(1, nrow)).length}ch + 16px)`);

    // ----- Selection -------------------------------------------------------
    const selection = new Selection();
    let selectionVersion = $state(0);  // force re-render when selection changes
    let copyStatus = $state<'' | 'copying' | 'copied' | 'error'>('');
    let copyStatusMsg = $state<string>('');
    let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;
    function bumpSelection() { selectionVersion++; }

    function postLifecycle(event: string): void {
        vscode.postMessage({
            type: 'lifecycle',
            event,
            panelGeneration,
            nrow,
            columns: columns.length,
            visibleRows: visibleRows.length,
            visibleRangeStart,
            visibleRangeEnd: visibleRangeStart + visibleRows.length,
            timestamp: Date.now(),
        });
    }

    // ----- Pending getLabels for high-cardinality columns -----------------
    /** Per-column resolved label cache (for Labels=on on high-cardinality
     *  dictionary cols where dictionaries[colIdx] isn't shipped). */
    let resolvedLabels = $state<Record<number, Record<number, string>>>({});

    // ----- Message handling -----------------------------------------------
    onMount(() => {
        postLifecycle('mount');
        const handler = (ev: MessageEvent<ExtensionToWebview>) => {
            const m = ev.data;
            if (!m || typeof m !== 'object') return;
            if (m.panelGeneration < panelGeneration) return;
            switch (m.type) {
                case 'init':
                case 'replace':
                    applyInitOrReplace(m);
                    return;
                case 'rows':
                    applyRows(m);
                    return;
                case 'labels':
                    applyLabels(m);
                    return;
                case 'copyDone':
                    applyCopyDone(m);
                    return;
                case 'testKey':
                    // Test-only: dispatch a synthetic KeyboardEvent on
                    // `window` so the same onKeyDown handler a real
                    // keypress would invoke runs end-to-end. The
                    // <svelte:window onkeydown={onKeyDown}> binding
                    // listens at the window level, so window.dispatchEvent
                    // is the canonical delivery path for synthetic events.
                    window.dispatchEvent(new KeyboardEvent('keydown', {
                        key: m.key,
                        code: m.key,
                        bubbles: true,
                        cancelable: true,
                    }));
                    return;
                case 'testScrollbarDrag': {
                    // Test-only: dispatch synthetic pointerdown/move/up
                    // events on the thumb element so the same drag
                    // handlers a real user pointer would invoke run
                    // end-to-end. pointerId 999 avoids colliding with
                    // any real mouse pointer (Chromium primary mouse is
                    // pointerId 1).
                    const thumb = document.querySelector('[data-test-id="custom-scrollbar-thumb"]');
                    if (!(thumb instanceof HTMLElement)) return;
                    const trackEl = thumb.parentElement;
                    if (!(trackEl instanceof HTMLElement)) return;
                    const trackHeight = Math.max(0, viewportHeight - HORIZONTAL_GUTTER_PX);
                    const thumbRect = thumb.getBoundingClientRect();
                    const trackRect = trackEl.getBoundingClientRect();
                    const thumbHeightPx = thumbRect.height;
                    // Current thumb center.
                    const centerX = thumbRect.left + thumbRect.width / 2;
                    const startY = thumbRect.top + thumbRect.height / 2;
                    // Target thumb-top, then target Y for the pointer
                    // (we want the pointer to end up such that thumb's
                    // top lands at fraction*(trackHeight - thumbHeight)).
                    const targetThumbTop = m.fraction * Math.max(0, trackHeight - thumbHeightPx);
                    const targetY = trackRect.top + targetThumbTop + thumbHeightPx / 2;
                    const opts = {
                        pointerId: 999,
                        pointerType: 'mouse',
                        bubbles: true,
                        cancelable: true,
                        button: 0,
                    } as const;
                    thumb.dispatchEvent(new PointerEvent('pointerdown', {
                        ...opts, clientX: centerX, clientY: startY,
                    }));
                    thumb.dispatchEvent(new PointerEvent('pointermove', {
                        ...opts, clientX: centerX, clientY: targetY,
                    }));
                    thumb.dispatchEvent(new PointerEvent('pointerup', {
                        ...opts, clientX: centerX, clientY: targetY,
                    }));
                    return;
                }
            }
        };
        window.addEventListener('message', handler);
        // macOS dispatches Cmd-A and Cmd-C through the Edit menu's responder
        // chain rather than as a JS keydown event. Chromium responds by
        // calling document.execCommand('selectAll') / firing a 'copy' event
        // directly, so the window-level keydown listener never sees them.
        // Catch both via the synthesized DOM events instead — this is what
        // actually fires for Cmd shortcuts on macOS, while Ctrl shortcuts
        // continue to flow through the keydown path.
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('copy', onDocumentCopy);
        vscode.postMessage({ type: 'webviewReady' });
        // Pull focus into the iframe so Cmd/Ctrl+A and Cmd/Ctrl+C reach the
        // window-level keydown handler. Without this, the panel can mount
        // without focus inside the iframe (e.g. opened via R's View() while
        // the editor still has focus); keystrokes would then never reach
        // our handler and Cmd+A would fall back to the browser's default
        // "select all webview text" behavior.
        focusViewport();
        return () => {
            window.removeEventListener('message', handler);
            document.removeEventListener('selectionchange', onSelectionChange);
            document.removeEventListener('copy', onDocumentCopy);
        };
    });

    /** Fires after Cmd-A / Edit > Select All (which Chromium implements via
     *  document.execCommand('selectAll'), bypassing keydown on macOS).
     *  When we observe the document gaining a body-spanning native
     *  selection we suppress it and run our grid select-all instead.
     *
     *  A user-initiated drag-select keeps both endpoints inside the same
     *  text node, so the containsNode(body) check only matches the
     *  synthetic "select all". */
    function onSelectionChange(): void {
        const sel = window.getSelection?.();
        if (!sel || sel.rangeCount === 0) return;
        if (sel.isCollapsed) return;
        const root = document.body;
        if (!root) return;
        if (!sel.containsNode(root, true)) return;
        sel.removeAllRanges();
        if (visibleCols.length > 0 && nrow > 0) {
            selection.selectAll(nrow, visibleCols);
            bumpSelection();
        }
    }

    /** Fires for Cmd-C / Edit > Copy on macOS regardless of whether
     *  keydown reached us. We always intercept and write our TSV to the
     *  clipboard via the extension host (the webview can't access
     *  navigator.clipboard reliably under the default CSP). */
    function onDocumentCopy(e: ClipboardEvent): void {
        if (!selection.rect()) return;
        e.preventDefault();
        copySelection();
    }

    /** Pull keyboard focus to the grid viewport so Cmd/Ctrl shortcuts
     *  reach our window-level keydown handler. Called on mount and on
     *  every pointer interaction inside the panel. */
    function focusViewport(): void {
        viewportEl?.focus({ preventScroll: true });
    }

    function applyInitOrReplace(
        m: Extract<ExtensionToWebview, { type: 'init' | 'replace' }>,
    ): void {
        const sameDataset =
            m.panelGeneration === panelGeneration
            && m.nrow === nrow
            && sameColumns(m.columns, columns);
        panelGeneration = m.panelGeneration;
        nrow = m.nrow;
        columns = m.columns;
        layout = m.layout;
        dictionaries = m.dictionaries;
        objectClass = m.objectClass;
        currentSchemaHash = m.schemaHash;
        if (m.type === 'init' && 'settings' in m) {
            settings = m.settings;
        }
        labelsOn = m.toolbar.labelsOn;
        formatOn = m.toolbar.formatOn;
        digits = m.toolbar.digits;
        toolbarBootstrapped = true;
        rowCache.clear();
        resolvedLabels = {};
        if (!sameDataset) {
            visibleRows = [];
            visibleRangeStart = 0;
        }
        selection.clear();
        bumpSelection();
        persistWebviewState();
        postLifecycle(m.type);
        scheduleFetchVisible();
    }

    function applyRows(
        m: Extract<ExtensionToWebview, { type: 'rows' }>,
    ): void {
        if (m.panelGeneration !== panelGeneration) return;
        if (m.viewportGeneration < viewportGeneration) return;
        if (m.stale) return;
        inflight.delete(m.requestId);
        rowCache.put(m.start, m.end, m.rows);
        const range = visibleRange({
            scrollTop: logicalScrollTop(scrollTop, totalGridHeight, viewportHeight, ROW_HEIGHT),
            viewportHeight, rowHeight: ROW_HEIGHT, nrow, overscan: 8,
        });
        if (range.start === m.start && range.end === m.end) {
            visibleRows = m.rows;
            visibleRangeStart = m.start;
            persistWebviewState();
            postLifecycle('rows');
        }
    }

    function applyLabels(m: Extract<ExtensionToWebview, { type: 'labels' }>): void {
        if (m.panelGeneration !== panelGeneration) return;
        const colMap = { ...(resolvedLabels[m.columnIndex] ?? {}) };
        for (const k of Object.keys(m.labels)) {
            colMap[Number(k)] = m.labels[Number(k)];
        }
        resolvedLabels = { ...resolvedLabels, [m.columnIndex]: colMap };
    }

    function applyCopyDone(m: Extract<ExtensionToWebview, { type: 'copyDone' }>): void {
        if (m.ok) {
            copyStatus = 'copied';
            copyStatusMsg = 'Copied';
        } else {
            copyStatus = 'error';
            copyStatusMsg = m.error ?? 'Copy failed';
        }
        if (copyStatusTimer) clearTimeout(copyStatusTimer);
        copyStatusTimer = setTimeout(() => {
            copyStatus = '';
            copyStatusMsg = '';
        }, 2500);
    }

    // ----- Fetching -------------------------------------------------------
    const scheduleFetchVisible = coalesceScroll(() => {
        const range = visibleRange({
            scrollTop: logicalScrollTop(scrollTop, totalGridHeight, viewportHeight, ROW_HEIGHT),
            viewportHeight, rowHeight: ROW_HEIGHT, nrow, overscan: 8,
        });
        if (range.end <= range.start) {
            visibleRows = [];
            visibleRangeStart = range.start;
            persistWebviewState();
            // Tell the host every change to visibleRangeStart, including
            // the empty-range case — otherwise the test API can stall on
            // a stale range when nrow shrinks to 0 or the viewport
            // collapses.
            postLifecycle('empty-range');
            return;
        }
        const cached = rowCache.get(range.start, range.end);
        if (cached) {
            visibleRows = cached;
            visibleRangeStart = range.start;
            persistWebviewState();
            // Without this, an End keypress that lands on a pre-cached
            // window (e.g., re-pressing End after a scroll-up) would
            // never tell the host its range changed, leaving the polling
            // test stuck on a stale lastVisibleRange.
            postLifecycle('cache-hit');
            return;
        }
        viewportGeneration += 1;
        const requestId = ++nextRequestId;
        inflight.set(requestId, { start: range.start, end: range.end });
        const msg: WebviewToExtension = {
            type: 'getRows',
            panelGeneration,
            requestId,
            viewportGeneration,
            start: range.start,
            end: range.end,
            columns: visibleCols,
        };
        vscode.postMessage(msg);
    }, 16);

    function onScroll(e: Event): void {
        const target = e.target as HTMLDivElement;
        scrollTop = target.scrollTop;
        scheduleFetchVisible();
    }

    // ----- Selection + copy ----------------------------------------------
    /** Active drag mode. Set on pointerdown and cleared on global pointerup
     *  so a drag that begins on a column header doesn't get hijacked by a
     *  cell's pointerenter handler (and vice versa). */
    type DragMode = 'cell' | 'column' | 'row' | 'resize' | null;
    let dragMode: DragMode = null;
    let resizeDrag: { colIdx: number; startX: number; startWidth: number } | null = null;

    function onCellPointerDown(row: number, col: number, e: PointerEvent): void {
        if (e.button !== 0) return;
        focusViewport();
        dragMode = 'cell';
        if (e.shiftKey) selection.focus(row, col);
        else selection.anchor(row, col, 'cells');
        bumpSelection();
    }

    function onCellPointerEnter(row: number, col: number, e: PointerEvent): void {
        if (dragMode !== 'cell') return;
        if ((e.buttons & 1) !== 1) return;
        selection.focus(row, col);
        bumpSelection();
    }

    function onColHeaderPointerDown(colIdx: number, e: PointerEvent): void {
        if (e.button !== 0) return;
        focusViewport();
        dragMode = 'column';
        if (nrow === 0) return;
        if (e.shiftKey) selection.focus(nrow - 1, colIdx);
        else {
            selection.anchor(0, colIdx, 'columns');
            selection.focus(nrow - 1, colIdx);
        }
        bumpSelection();
    }

    function onColHeaderPointerEnter(colIdx: number, e: PointerEvent): void {
        if (dragMode !== 'column') return;
        if ((e.buttons & 1) !== 1) return;
        if (nrow === 0) return;
        selection.focus(nrow - 1, colIdx);
        bumpSelection();
    }

    function onRowHeaderPointerDown(absRow: number, e: PointerEvent): void {
        if (e.button !== 0) return;
        focusViewport();
        dragMode = 'row';
        if (visibleCols.length === 0) return;
        const minCol = visibleCols[0];
        const maxCol = visibleCols[visibleCols.length - 1];
        if (e.shiftKey) selection.focus(absRow, maxCol);
        else {
            selection.anchor(absRow, minCol, 'rows');
            selection.focus(absRow, maxCol);
        }
        bumpSelection();
    }

    /** Top-left corner cell ("#") behaves as the "select all" affordance,
     *  matching spreadsheet conventions. Always sets selection kind to
     *  'all' so a copy includes the column-header row. */
    function onCornerPointerDown(e: PointerEvent): void {
        if (e.button !== 0) return;
        focusViewport();
        if (visibleCols.length === 0 || nrow === 0) return;
        selection.selectAll(nrow, visibleCols);
        bumpSelection();
    }

    function onRowHeaderPointerEnter(absRow: number, e: PointerEvent): void {
        if (dragMode !== 'row') return;
        if ((e.buttons & 1) !== 1) return;
        if (visibleCols.length === 0) return;
        const maxCol = visibleCols[visibleCols.length - 1];
        selection.focus(absRow, maxCol);
        bumpSelection();
    }

    function onResizeHandlePointerDown(colIdx: number, e: PointerEvent): void {
        e.stopPropagation(); // don't trigger column selection
        dragMode = 'resize';
        resizeDrag = { colIdx, startX: e.clientX, startWidth: widthOf(colIdx) };
        (e.target as Element).setPointerCapture(e.pointerId);
    }

    function onWindowPointerMove(e: PointerEvent): void {
        if (!resizeDrag) return;
        const delta = e.clientX - resizeDrag.startX;
        const newWidth = Math.max(30, resizeDrag.startWidth + delta);
        // Update visually during the drag; persistence happens once on
        // pointer-up so we don't post a save message per pointer event.
        layout = {
            ...layout,
            columnWidths: { ...layout.columnWidths, [resizeDrag.colIdx]: newWidth },
        };
    }

    function onWindowPointerUp(): void {
        const wasResizing = dragMode === 'resize' && resizeDrag !== null;
        dragMode = null;
        resizeDrag = null;
        if (wasResizing) persistLayout();
    }

    function copySelection(): void {
        const r = selection.rect();
        if (!r) return;
        const colIndices = selection.colIndices()
            ?? rangeFilter(r.colStart, r.colEnd, visibleCols);
        if (colIndices.length === 0) return;
        const requestId = ++nextRequestId;
        const msg: WebviewToExtension = {
            type: 'copy',
            panelGeneration,
            requestId,
            range: {
                rowStart: r.rowStart, rowEnd: r.rowEnd,
                colIndices,
            },
            labelsOn, formatOn, digits,
            includeHeader: selection.includesHeader(),
        };
        copyStatus = 'copying';
        copyStatusMsg = 'Copying...';
        vscode.postMessage(msg);
    }

    function onKeyDown(e: KeyboardEvent): void {
        const meta = e.metaKey || e.ctrlKey;
        if (e.key === 'Escape' && contextMenu) {
            closeContextMenu();
            return;
        }
        // Plain (no-modifier) navigation keys — added for issue #183.
        // We deliberately ignore any modifier so platform shortcuts
        // (Shift+End to extend selection, Cmd+End in some apps to jump-
        // and-extend) fall through to the browser/OS unchanged. The
        // viewportEl null guard handles the brief window between mount
        // and the bind:this assignment.
        //
        // Skip when focus is on a form control: <select>, <input>,
        // <textarea>, or a contenteditable element have their own native
        // Home/End/PageUp/PageDown semantics (e.g. <select> jumps to the
        // first/last option) that we'd otherwise hijack. The toolbar's
        // digits <select> and the column-popover checkboxes are concrete
        // examples.
        const target = e.target;
        const onFormControl = target instanceof HTMLElement && (
            target.tagName === 'INPUT'
            || target.tagName === 'SELECT'
            || target.tagName === 'TEXTAREA'
            || target.isContentEditable
        );
        if (!meta && !e.shiftKey && !e.altKey && !onFormControl && viewportEl) {
            switch (e.key) {
                case 'End':
                    e.preventDefault();
                    // scrollHeight - clientHeight is the canonical
                    // browser-clamped maximum. The inner .grid div is
                    // height-capped at MAX_SCROLL_PX + ROW_HEIGHT, so
                    // this lands at or near the model's maxPhysical;
                    // logicalScrollTop's clamp absorbs any DOM-vs-model
                    // rounding mismatch.
                    viewportEl.scrollTop = viewportEl.scrollHeight - viewportEl.clientHeight;
                    return;
                case 'Home':
                    e.preventDefault();
                    viewportEl.scrollTop = 0;
                    return;
                case 'PageDown':
                    e.preventDefault();
                    viewportEl.scrollTop += viewportEl.clientHeight;
                    return;
                case 'PageUp':
                    e.preventDefault();
                    viewportEl.scrollTop -= viewportEl.clientHeight;
                    return;
            }
        }
        if (meta && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            selection.selectAll(nrow, visibleCols);
            bumpSelection();
            return;
        }
        if (meta && (e.key === 'c' || e.key === 'C')) {
            if (!selection.rect()) return;
            e.preventDefault();
            copySelection();
        }
    }

    // ----- Context menu ---------------------------------------------------
    type ContextTarget =
        | { kind: 'cell'; row: number; col: number }
        | { kind: 'column'; col: number }
        | { kind: 'row'; row: number };
    let contextMenu = $state<{ x: number; y: number } | null>(null);

    /** Find the cell/header context for a right-click target. Returns null
     *  when the click is on whitespace, the toolbar, the corner, or any
     *  other non-data element — in which case we suppress the default menu
     *  but show nothing. */
    function classifyContextTarget(target: EventTarget | null): ContextTarget | null {
        if (!(target instanceof Element)) return null;
        const cell = target.closest('[data-grid-target]');
        if (!(cell instanceof HTMLElement)) return null;
        const kind = cell.dataset.gridTarget;
        if (kind === 'cell') {
            const row = Number(cell.dataset.row);
            const col = Number(cell.dataset.col);
            if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
            return { kind: 'cell', row, col };
        }
        if (kind === 'col-header') {
            const col = Number(cell.dataset.col);
            if (!Number.isFinite(col)) return null;
            return { kind: 'column', col };
        }
        if (kind === 'row-header') {
            const row = Number(cell.dataset.row);
            if (!Number.isFinite(row)) return null;
            return { kind: 'row', row };
        }
        return null;
    }

    function onContextMenu(e: MouseEvent): void {
        e.preventDefault();
        const target = classifyContextTarget(e.target);
        if (!target) {
            contextMenu = null;
            return;
        }
        // If the click lands outside the current selection, move the
        // selection to the clicked target before showing the menu — matches
        // typical spreadsheet behavior.
        const inRect = (() => {
            const r = selection.rect();
            if (!r) return false;
            switch (target.kind) {
                case 'cell':
                    return target.row >= r.rowStart && target.row < r.rowEnd
                        && target.col >= r.colStart && target.col < r.colEnd;
                case 'column':
                    return target.col >= r.colStart && target.col < r.colEnd;
                case 'row':
                    return target.row >= r.rowStart && target.row < r.rowEnd;
            }
        })();
        if (!inRect) {
            switch (target.kind) {
                case 'cell':
                    selection.anchor(target.row, target.col, 'cells');
                    break;
                case 'column':
                    if (nrow > 0) {
                        selection.anchor(0, target.col, 'columns');
                        selection.focus(nrow - 1, target.col);
                    }
                    break;
                case 'row':
                    if (visibleCols.length > 0) {
                        const minCol = visibleCols[0];
                        const maxCol = visibleCols[visibleCols.length - 1];
                        selection.anchor(target.row, minCol, 'rows');
                        selection.focus(target.row, maxCol);
                    }
                    break;
            }
            bumpSelection();
        }
        contextMenu = { x: e.clientX, y: e.clientY };
    }

    function closeContextMenu(): void {
        contextMenu = null;
    }

    function onContextCopy(): void {
        copySelection();
        closeContextMenu();
    }

    // ----- Layout persistence --------------------------------------------
    // Save synchronously on every committed mutation: each toggle is one
    // click, and column-width drags call us only on pointer-up. Posting
    // immediately means there's no pending timer to lose if the user
    // closes the panel right after acting (the webview JS context dies
    // with the iframe and any setTimeout debounce dies with it).
    function persistLayout(): void {
        // Snapshot the layout out of Svelte 5's $state proxy before
        // posting. postMessage uses structured cloning, which silently
        // fails to serialize reactive proxies — the message gets posted
        // but never reaches the extension's onDidReceiveMessage handler.
        // Spreading into a plain object avoids that.
        const msg: WebviewToExtension = {
            type: 'saveLayout',
            panelGeneration,
            schemaHash: currentSchemaHash,
            layout: {
                columnWidths: { ...layout.columnWidths },
                hiddenColumns: [...layout.hiddenColumns],
            },
        };
        vscode.postMessage(msg);
    }

    function onToggleColumn(index: number, hidden: boolean): void {
        const set = new Set(layout.hiddenColumns);
        if (hidden) set.add(index); else set.delete(index);
        layout = { ...layout, hiddenColumns: Array.from(set) };
        persistLayout();
        // Cached row windows were decoded for the previous visible-column
        // subset. After a hide/show toggle, those cells no longer line up
        // with the new column order, so we must drop the cache before
        // refetching.
        rowCache.clear();
        visibleRows = [];
        persistWebviewState();
        scheduleFetchVisible();
    }

    function persistWebviewState(): void {
        vscode.setState?.({
            panelGeneration,
            nrow,
            columns,
            dictionaries,
            layout,
            settings,
            labelsOn,
            formatOn,
            digits,
            objectClass,
            visibleRows,
            visibleRangeStart,
        });
    }

    // ----- Toolbar persistence -------------------------------------------
    // `toolbarBootstrapped` is a plain `let` (not $state) so the persistence
    // $effect doesn't subscribe to it. The first $effect run sees `false`
    // and skips, avoiding a save of the pre-init defaults that would clobber
    // whatever's stored in the host. applyInitOrReplace flips it true once
    // the host has supplied the loaded-or-default toolbar state.
    let toolbarBootstrapped = false;
    function persistToolbar(): void {
        const msg: WebviewToExtension = {
            type: 'saveToolbar',
            panelGeneration,
            schemaHash: currentSchemaHash,
            toolbar: { labelsOn, formatOn, digits },
        };
        vscode.postMessage(msg);
    }
    $effect(() => {
        // Subscribe to the toolbar state.
        void labelsOn; void formatOn; void digits;
        if (!toolbarBootstrapped) return;
        persistToolbar();
    });

    $effect(() => {
        persistWebviewState();
    });

    function widthOf(index: number): number {
        return layout.columnWidths[index] ?? 120;
    }

    function isInRect(row: number, col: number): boolean {
        // touch selectionVersion so this re-runs on selection changes
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        selectionVersion;
        const r = selection.rect();
        if (!r) return false;
        return row >= r.rowStart && row < r.rowEnd
            && col >= r.colStart && col < r.colEnd;
    }

    function isColSelected(col: number): boolean {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        selectionVersion;
        const r = selection.rect();
        if (!r) return false;
        return col >= r.colStart && col < r.colEnd;
    }

    function isRowSelected(row: number): boolean {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        selectionVersion;
        const r = selection.rect();
        if (!r) return false;
        return row >= r.rowStart && row < r.rowEnd;
    }

    function getDictForCol(colIdx: number): string[] | undefined {
        return dictionaries[colIdx];
    }

    function getResolvedLabel(colIdx: number, idx: number): string | undefined {
        return resolvedLabels[colIdx]?.[idx];
    }

    /** For high-cardinality columns when Labels is on, request only the
     *  indices currently visible. */
    $effect(() => {
        if (!labelsOn) return;
        for (let ci = 0; ci < visibleCols.length; ci++) {
            const colIdx = visibleCols[ci];
            const col = columns[colIdx];
            if (!col || col.dictionaryShipped) continue;
            // No value-labels metadata path needs getLabels (those are
            // already in col.valueLabels).
            if (!col.arrowType.startsWith('Dictionary')) continue;
            const want = new Set<number>();
            const cache = resolvedLabels[colIdx] ?? {};
            for (const row of visibleRows) {
                const cell = row[ci];
                if (typeof cell === 'number' && cache[cell] === undefined) {
                    want.add(cell);
                }
            }
            if (want.size === 0) continue;
            const requestId = ++nextRequestId;
            const msg: WebviewToExtension = {
                type: 'getLabels',
                panelGeneration,
                requestId,
                columnIndex: colIdx,
                indices: Array.from(want),
            };
            vscode.postMessage(msg);
        }
    });

    // ----- Resize observer for viewport height ---------------------------
    $effect(() => {
        if (!viewportEl) return;
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                viewportHeight = entry.contentRect.height;
                scheduleFetchVisible();
            }
        });
        ro.observe(viewportEl);
        return () => ro.disconnect();
    });

    function rangeFilter(start: number, end: number, all: number[]): number[] {
        const out: number[] = [];
        for (const i of all) if (i >= start && i < end) out.push(i);
        return out;
    }

    function sameColumns(a: ColumnSchema[], b: ColumnSchema[]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].name !== b[i].name || a[i].arrowType !== b[i].arrowType) {
                return false;
            }
        }
        return true;
    }
</script>

<svelte:window onkeydown={onKeyDown} onpointerup={onWindowPointerUp} onpointermove={onWindowPointerMove} />

<!-- Suppress the platform context menu everywhere in the panel; show our
     own only when the click lands on a cell, column header, or row
     header. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="data-viewer"
     oncontextmenu={onContextMenu}
     onclick={() => { if (contextMenu) closeContextMenu(); }}>
    <Toolbar
        bind:labelsOn
        bind:formatOn
        bind:digits
        nrow={nrow}
        columns={columns}
        layout={layout}
        objectClass={objectClass}
        onToggleColumn={onToggleColumn}
    />
    {#if copyStatus !== ''}
        <div class="toast toast-{copyStatus}">{copyStatusMsg}</div>
    {/if}
    <div class="viewport-wrapper">
        <div class="viewport"
             class:using-custom-scrollbar={useCustomScrollbar}
             role="grid"
             aria-rowcount={nrow}
             bind:this={viewportEl}
             onscroll={onScroll}
             tabindex="0">
            <div class="grid" style="height: {cappedScrollHeight(totalGridHeight) + ROW_HEIGHT}px;">
                <!-- Header row (sticky top) -->
                <div class="header-row">
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div class="cell header rowname-col corner-cell"
                         style="width: {rowColWidth};"
                         title="Select all"
                         onpointerdown={onCornerPointerDown}>#</div>
                {#each visibleCols as colIdx (colIdx)}
                    {@const col = columns[colIdx]}
                    <div class="cell header col-header
                            {isColSelected(colIdx) ? 'selected-header' : ''}"
                         data-grid-target="col-header"
                         data-col={colIdx}
                         style="width: {widthOf(colIdx)}px;"
                         aria-label={col.variableLabel ? `${col.name}: ${col.variableLabel}` : col.name}
                         onpointerdown={(e) => onColHeaderPointerDown(colIdx, e)}
                         onpointerenter={(e) => onColHeaderPointerEnter(colIdx, e)}
                    >
                        <span class="col-name">{col.name}</span>
                        {#if col.variableLabel}
                            <span class="col-tooltip" role="tooltip">{col.name}: {col.variableLabel}</span>
                        {/if}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="resize-handle"
                             onpointerdown={(e) => onResizeHandlePointerDown(colIdx, e)}></div>
                    </div>
                {/each}
            </div>
            <!-- Data rows -->
            <div class="rows" style="transform: translateY({visualOffsetPx(visibleRangeStart * ROW_HEIGHT, totalGridHeight, viewportHeight, ROW_HEIGHT)}px);">
                {#each visibleRows as rowCells, rowOffset (visibleRangeStart + rowOffset)}
                    {@const absRow = visibleRangeStart + rowOffset}
                    <div class="data-row" style="height: {ROW_HEIGHT}px;">
                        <div class="cell rowname-col row-header
                                {isRowSelected(absRow) ? 'selected-header' : ''}"
                             data-grid-target="row-header"
                             data-row={absRow}
                             style="width: {rowColWidth};"
                             onpointerdown={(e) => onRowHeaderPointerDown(absRow, e)}
                             onpointerenter={(e) => onRowHeaderPointerEnter(absRow, e)}
                        >
                            {absRow + 1}
                        </div>
                        {#each visibleCols as colIdx, ci (colIdx)}
                            {@const col = columns[colIdx]}
                            {@const cell = rowCells[ci]}
                            {@const dict = getDictForCol(colIdx)}
                            {@const decoded = formatCell(
                                cell, col, dict, labelsOn, formatOn, digits,
                            )}
                            {@const labelOverride = labelsOn
                                && col.arrowType.startsWith('Dictionary')
                                && !col.dictionaryShipped
                                && typeof cell === 'number'
                                ? getResolvedLabel(colIdx, cell as number)
                                : undefined}
                            <div class="cell data
                                {decoded.missing ? 'missing-' + settings.missingValueStyle : ''}
                                {col.isInteger || col.arrowType.startsWith('Float') ? 'numeric' : ''}
                                {isInRect(absRow, colIdx) ? 'selected' : ''}"
                                 role="gridcell"
                                 tabindex="-1"
                                 data-grid-target="cell"
                                 data-row={absRow}
                                 data-col={colIdx}
                                 style="width: {widthOf(colIdx)}px;"
                                 onpointerdown={(e) => onCellPointerDown(absRow, colIdx, e)}
                                 onpointerenter={(e) => onCellPointerEnter(absRow, colIdx, e)}
                            >
                                {labelOverride ?? decoded.text}
                            </div>
                        {/each}
                    </div>
                {/each}
            </div>
        </div>
    </div>
    {#if useCustomScrollbar}
        <CustomScrollbar
            trackHeight={Math.max(0, viewportHeight - HORIZONTAL_GUTTER_PX)}
            scrollTop={scrollTop}
            nrow={nrow}
            rowHeight={ROW_HEIGHT}
            maxPhysical={MAX_SCROLL_PX + ROW_HEIGHT - viewportHeight}
            onScrollTo={(newScrollTop) => {
                if (viewportEl) viewportEl.scrollTop = newScrollTop;
            }}
        />
    {/if}
    </div>
    {#if contextMenu}
        <div class="context-menu"
             role="menu"
             style="left: {contextMenu.x}px; top: {contextMenu.y}px;">
            <button type="button"
                    class="context-menu-item"
                    role="menuitem"
                    disabled={!selection.rect()}
                    onclick={onContextCopy}>
                Copy
            </button>
        </div>
    {/if}
</div>

<style>
    /* Base layout — most styling lives in styles.css for theme-awareness. */
    :global(html, body, #root, body > div) {
        width: 100%;
        height: 100%;
        margin: 0;
    }
</style>
