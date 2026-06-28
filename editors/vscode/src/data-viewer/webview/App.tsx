import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    CompactSelection,
    DataEditorCore as DataEditor,
    GridCellKind,
    markerCellRenderer,
    textCellRenderer,
    type DataEditorRef,
    type DataEditorCoreProps,
    type DrawCellCallback,
    type DrawHeaderCallback,
    type GridMouseEventArgs,
    type GridSelection,
    type Item,
    type Rectangle,
    type Theme,
} from '@glideapps/glide-data-grid';
import type { ColumnSchema } from '../arrow-reader';
import {
    EMPTY_FILTER,
    EMPTY_SORT,
    type ExtensionToWebview,
    type FilterEntry,
    type FilterState,
    type HistogramBin,
    type Layout,
    type Settings,
    type SortKey,
    type SortState,
    type WebviewToExtension,
} from '../messages';
import type { ToolbarState } from '../toolbar-state';
import type { Cell } from '../wire-format';
import { RowCache } from './row-cache';
import { formatCell } from './cell-render';
import { hasFormatEffect, hasLabelsEffect } from './toolbar-effects';
import {
    buildGridColumns,
    buildVisibleGridColumns,
    describeRestoreMessage,
    describeToolbarRowCount,
    fitLeadingText,
    HEADER_HEIGHT_PX,
    OVERSCAN_ROWS,
    paddedRange,
    pendingOperationLabels,
    rowMarkerWidth,
    ROW_HEIGHT_PX,
    type VisibleRange,
    visibleColumnIndices,
} from './grid-model';
import {
    hideAllColumns,
    showAllColumns,
    toggleColumnHidden,
} from './column-visibility-model';
import { ColumnVisibilityPopover } from './column-visibility-popover';
import { ColumnContextMenu } from './column-context-menu';
import { ToolbarSortStrip } from './sort-strip';
import { FilterStrip } from './filter-strip';
import { FilterPopover } from './filter-popover';
import { colKind } from './filter-column-kind';
import { useToolbarWrap } from './use-toolbar-wrap';
import {
    filterEntriesForNextRequest,
    nextSortKeysForColumn,
    sortKeysForNextRequest,
    createIntentRequestState,
    requestFilterIntent,
    requestSortIntent,
    shouldAcceptAppliedResponse,
    shouldAcceptInteractiveResponse,
    shouldAcceptSortResponse,
} from './transform-intent';

type VscodeApi = {
    postMessage(msg: WebviewToExtension): void;
    setState?(state: PersistedState): void;
};

type PersistedState = {
    panelGeneration: number;
    nrow: number;
    columns: ColumnSchema[];
    dictionaries: Record<number, string[]>;
    layout: Layout;
    settings: Settings;
    toolbar: ToolbarState;
    schemaHash: string;
    visibleRange: VisibleRange;
    sort: SortState;
    filter: FilterState;
    nrowFiltered?: number;
    histograms?: Record<number, HistogramBin[]>;
};

type ContextMenuState = {
    leftPx: number;
    topPx: number;
    columnIndex?: number;
    kind: 'cell' | 'column';
};

type HeaderTooltipState = {
    text: string;
    leftPx: number;
    topPx: number;
};

const EMPTY_LAYOUT: Layout = { columnWidths: {}, hiddenColumns: [] };
const EMPTY_TOOLBAR: ToolbarState = { labelsOn: true, formatOn: true, digits: 3 };
const DEFAULT_SETTINGS: Settings = { missingValueStyle: 'foreground', defaultDigits: 3, persistSort: true, persistFilters: true };

/** Delay before the saved-sort/filter restore banner appears (#519). A
 *  restore that finishes faster than this never flashes the message; only a
 *  genuinely slow restore reveals it and its skip action. */
const RESTORE_DEBOUNCE_MS = 200;
// Glide's renderer type is invariant, but dispatch is by each renderer's `kind`.
const DATA_VIEWER_RENDERERS = [
    markerCellRenderer,
    textCellRenderer,
] as unknown as NonNullable<DataEditorCoreProps['renderers']>;
const DATA_VIEWER_IMAGE_LOADER: DataEditorCoreProps['imageWindowLoader'] = {
    setWindow: () => undefined,
    loadOrGetImage: () => undefined,
    setCallback: () => undefined,
};

function createEmptySelection(): GridSelection {
    return {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
    };
}

function createColumnSelection(colIndex: number): GridSelection {
    return {
        columns: CompactSelection.fromSingleSelection(colIndex),
        rows: CompactSelection.empty(),
    };
}

function createAllColumnsSelection(columnCount: number): GridSelection {
    return {
        columns: columnCount > 0
            ? CompactSelection.fromSingleSelection([0, columnCount])
            : CompactSelection.empty(),
        rows: CompactSelection.empty(),
    };
}

function createCellSelection(col: number, row: number): GridSelection {
    return {
        current: {
            cell: [col, row],
            range: { x: col, y: row, width: 1, height: 1 },
            rangeStack: [],
        },
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
    };
}

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
    return style.getPropertyValue(name).trim() || fallback;
}

function buildGridTheme(style: CSSStyleDeclaration): Partial<Theme> {
    const fg = readCssVar(style, '--vscode-foreground', '#cccccc');
    const editorFg = readCssVar(style, '--vscode-editor-foreground', fg);
    const editorBg = readCssVar(style, '--vscode-editor-background', '#1e1e1e');
    const headerBg = readCssVar(style, '--vscode-editorGroupHeader-tabsBackground', editorBg);
    const border = readCssVar(style, '--vscode-panel-border', 'rgba(128,128,128,0.35)');
    const selectionBg = readCssVar(style, '--vscode-list-activeSelectionBackground', '#094771');
    const selectionFg = readCssVar(style, '--vscode-list-activeSelectionForeground', '#ffffff');
    const hoverBg = readCssVar(style, '--vscode-list-hoverBackground', 'rgba(128,128,128,0.1)');
    const focusBorder = readCssVar(style, '--vscode-focusBorder', '#007fd4');
    const fontFamily = readCssVar(style, '--vscode-editor-font-family', 'monospace');
    return {
        bgCell: editorBg,
        bgCellMedium: editorBg,
        bgHeader: headerBg,
        bgHeaderHasFocus: selectionBg,
        bgHeaderHovered: hoverBg,
        textDark: editorFg,
        textMedium: fg,
        textLight: fg,
        textHeader: fg,
        textHeaderSelected: selectionFg,
        borderColor: border,
        horizontalBorderColor: border,
        headerBottomBorderColor: border,
        accentColor: focusBorder,
        accentFg: selectionFg,
        accentLight: selectionBg,
        linkColor: readCssVar(style, '--vscode-textLink-foreground', focusBorder),
        fontFamily,
    };
}

function buildMissingThemes(style: CSSStyleDeclaration): { fg: Partial<Theme>; bg: Partial<Theme> } {
    return {
        fg: { textDark: readCssVar(style, '--vscode-editorError-foreground', '#f14c4c') },
        bg: { bgCell: readCssVar(style, '--vscode-diffEditor-removedTextBackground', 'rgba(255,0,0,0.06)') },
    };
}

function useVscodeTheme(): { grid: Partial<Theme>; missingFg: Partial<Theme>; missingBg: Partial<Theme> } {
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        const observer = new MutationObserver(() => setRevision(r => r + 1));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['style', 'class', 'data-vscode-theme-kind', 'data-vscode-theme-name'],
        });
        return () => observer.disconnect();
    }, []);

    return useMemo(() => {
        const style = getComputedStyle(document.documentElement);
        const missing = buildMissingThemes(style);
        return {
            grid: buildGridTheme(style),
            missingFg: missing.fg,
            missingBg: missing.bg,
        };
    }, [revision]);
}

/** True when an event would type into the given element (or its
 *  shadow-DOM descendants). Used to guard keyboard shortcuts so they
 *  don't hijack the user's typing in text inputs / textareas / selects /
 *  contenteditable surfaces. */
function isEditableTarget(el: Element | null): boolean {
    if (!el) return false;
    if (el instanceof HTMLInputElement) {
        // Buttons and checkboxes don't take text — only true text inputs.
        const t = el.type.toLowerCase();
        return t !== 'button' && t !== 'submit' && t !== 'reset'
            && t !== 'checkbox' && t !== 'radio'
            && t !== 'image' && t !== 'file' && t !== 'color';
    }
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLSelectElement) return true;
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    return false;
}

/** Paint the sort arrow + (when there's more than one key) a priority
 *  badge in the right-edge cluster of a column header. The arrow alpha
 *  encodes the primary/secondary cue at a glance; the badge is the
 *  precise readout. */
function drawSortGlyphs(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
    theme: Theme,
    entry: { direction: 'asc' | 'desc'; priority: number },
    showBadge: boolean,
): void {
    const isPrimary = entry.priority === 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    const arrowRightEdge = rect.x + rect.width - 8;
    const arrowCenterY = rect.y + rect.height / 2;
    const arrowSize = 5;
    ctx.fillStyle = theme.textHeader;
    ctx.globalAlpha = isPrimary ? 0.85 : 0.55;
    ctx.beginPath();
    if (entry.direction === 'asc') {
        ctx.moveTo(arrowRightEdge - arrowSize, arrowCenterY + arrowSize / 2);
        ctx.lineTo(arrowRightEdge, arrowCenterY + arrowSize / 2);
        ctx.lineTo(arrowRightEdge - arrowSize / 2, arrowCenterY - arrowSize / 2);
    } else {
        ctx.moveTo(arrowRightEdge - arrowSize, arrowCenterY - arrowSize / 2);
        ctx.lineTo(arrowRightEdge, arrowCenterY - arrowSize / 2);
        ctx.lineTo(arrowRightEdge - arrowSize / 2, arrowCenterY + arrowSize / 2);
    }
    ctx.closePath();
    ctx.fill();
    if (showBadge) {
        const badgeCenterX = arrowRightEdge - arrowSize - 10;
        const badgeRadius = 7;
        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.bgHeader === theme.bgCell
            ? 'rgba(128, 128, 128, 0.35)'
            : theme.bgCell;
        ctx.beginPath();
        ctx.arc(badgeCenterX, arrowCenterY, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.textHeader;
        ctx.font = `600 9px ${theme.fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(entry.priority), badgeCenterX, arrowCenterY + 0.5);
    }
    ctx.restore();
}

function sameColumns(a: readonly ColumnSchema[], b: readonly ColumnSchema[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].name !== b[i].name || a[i].arrowType !== b[i].arrowType) return false;
    }
    return true;
}

export function App({
    vscode,
    initialState,
}: {
    vscode: VscodeApi;
    initialState?: unknown;
}) {
    const restored = initialState as PersistedState | undefined;
    const { grid: vscodeTheme, missingFg, missingBg } = useVscodeTheme();
    const gridRef = useRef<DataEditorRef>(null);
    const gridShellRef = useRef<HTMLDivElement>(null);
    const headerTooltipRef = useRef<HTMLDivElement>(null);
    const rowCacheRef = useRef(new RowCache(200_000));
    const inflightRef = useRef(new Map<number, string>());
    const pendingKeysRef = useRef(new Set<string>());
    const nextRequestIdRef = useRef(0);
    const intentRequestStateRef = useRef(createIntentRequestState());
    const panelGenerationRef = useRef(restored?.panelGeneration ?? 0);
    /** Column indices whose histogram has been requested from the host but
     *  not yet received, so the lazy-fetch effect fires at most one
     *  getHistogram per column. Cleared on replace (new dataset). */
    const histogramRequestedRef = useRef(new Map<number, number>());
    const bootstrappingRef = useRef(true);
    const latestSortRequestIdRef = useRef<number | null>(null);
    const latestSortIntentRef = useRef<SortState | null>(null);
    const acceptedSortRequestIdRef = useRef(0);
    const latestFilterRequestIdRef = useRef<number | null>(null);
    const latestFilterIntentRef = useRef<FilterState | null>(null);
    const acceptedFilterRequestIdRef = useRef(0);
    const restoreInteractionBlockRef = useRef<{ sort: boolean; filter: boolean } | null>(null);
    const viewportGenerationRef = useRef(0);
    const toolbarBootstrappedRef = useRef(false);
    const missingRowRequestRef = useRef<VisibleRange | null>(null);
    const missingRowRequestTimerRef = useRef<number | null>(null);
    /** Toolbar wrap measurement refs: when the sort/filter chips can't fit
     *  beside the action buttons, the chip group drops to its own second row
     *  via `.toolbar.is-wrapped`. See `useToolbarWrap` for the policy. */
    const toolbarRef = useRef<HTMLDivElement>(null);
    const rowCountRef = useRef<HTMLSpanElement>(null);
    const toolbarChipsRef = useRef<HTMLDivElement>(null);
    const toolbarActionsRef = useRef<HTMLDivElement>(null);

    const [panelGeneration, setPanelGeneration] = useState(restored?.panelGeneration ?? 0);
    const [nrow, setNrow] = useState(restored?.nrow ?? 0);
    const [columns, setColumns] = useState<ColumnSchema[]>(restored?.columns ?? []);
    const [dictionaries, setDictionaries] = useState<Record<number, string[]>>(restored?.dictionaries ?? {});
    const [layout, setLayout] = useState<Layout>(restored?.layout ?? EMPTY_LAYOUT);
    const [settings, setSettings] = useState<Settings>(restored?.settings ?? DEFAULT_SETTINGS);
    const [toolbar, setToolbar] = useState<ToolbarState>(restored?.toolbar ?? EMPTY_TOOLBAR);
    const [schemaHash, setSchemaHash] = useState(restored?.schemaHash ?? '');
    const [visibleRange, setVisibleRange] = useState<VisibleRange>(restored?.visibleRange ?? { start: 0, end: 0 });
    const [cacheRevision, setCacheRevision] = useState(0);
    const [gridSelection, setGridSelection] = useState<GridSelection>(createEmptySelection);
    const [resolvedLabels, setResolvedLabels] = useState<Record<number, Record<number, string>>>({});
    const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [headerTooltip, setHeaderTooltip] = useState<HeaderTooltipState | null>(null);
    const [copyStatus, setCopyStatus] = useState<'' | 'copying' | 'copied' | 'error'>('');
    const [copyStatusMsg, setCopyStatusMsg] = useState('');
    const [sort, setSort] = useState<SortState>(restored?.sort ?? EMPTY_SORT);
    const [sortPending, setSortPending] = useState(false);
    const [filter, setFilter] = useState<FilterState>(restored?.filter ?? EMPTY_FILTER);
    const [pendingFilterIntent, setPendingFilterIntent] = useState<FilterState | null>(null);
    const [filterPending, setFilterPending] = useState(false);
    const [nrowFiltered, setNrowFiltered] = useState<number | undefined>(restored?.nrowFiltered);
    const [histograms, setHistograms] = useState<Record<number, HistogramBin[]>>(restored?.histograms ?? {});
    /** True until the first init/replace lands. Until then nrow is 0 and the
     *  row-count readout would say "Showing 0-0 of 0", which reads as an
     *  empty/broken table; show "Loading…" instead. Starts false when we
     *  restored a non-empty schema from getState (we already have something
     *  to show). */
    const [loading, setLoading] = useState<boolean>(!(restored?.columns && restored.columns.length > 0));
    // Saved-sort/filter restore banner (#519). `restorePending` is set only
    // after the debounce timer fires, so a fast restore never flashes it;
    // `restoreCancelling` shows the optimistic "Loading…" until init/replace
    // lands. The refs hold the live restoreId (echoed on cancelRestore) and the
    // debounce timer so it can be cleared when the restore completes.
    const [restorePending, setRestorePending] =
        useState<{ restoreId: number; sort: boolean; filter: boolean } | null>(null);
    const [restoreCancelling, setRestoreCancelling] = useState(false);
    const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const restoreIdRef = useRef<number | null>(null);
    // The exact filter object the host last sent authoritatively (via
    // init/replace, or a fromPersistence filterApplied). The debounced
    // saveFilter effect skips when `filter` is still this object, so the
    // webview never echoes host-owned state back to the store. This matters
    // on a genuine restore-filter read failure: the host keeps the saved
    // filter but sends EMPTY for display; without this guard the webview
    // would saveFilter(EMPTY) and destroy the very pref the host preserved.
    // A real user change replaces `filter` with a new object (≠ this ref),
    // so it still persists normally. (#519)
    const lastHostFilterRef = useRef<FilterState | null>(null);
    const [filterEditor, setFilterEditor] = useState<{
        entry?: FilterEntry;
        columnIndex?: number;
        leftPx?: number;
        topPx?: number;
    } | null>(null);

    const nextRequestId = useCallback(() => {
        const requestId = ++nextRequestIdRef.current;
        intentRequestStateRef.current.nextRequestId = requestId;
        return requestId;
    }, []);

    const visibleCols = useMemo(
        () => visibleColumnIndices(columns, layout.hiddenColumns),
        [columns, layout.hiddenColumns],
    );
    /** Map of source column index → { direction, priority (1-based) } for
     *  the active sort. Empty when no sort is active. Used by drawHeader
     *  and by the context menu's "check active direction" rendering. */
    const sortByColumn = useMemo(() => {
        const m = new Map<number, { direction: 'asc' | 'desc'; priority: number }>();
        sort.keys.forEach((k, i) =>
            m.set(k.columnIndex, { direction: k.direction, priority: i + 1 }));
        return m;
    }, [sort]);
    const showPriorityBadge = sort.keys.length > 1;
    const allGridColumns = useMemo(() => buildGridColumns(columns, layout), [columns, layout]);
    const gridColumns = useMemo(
        () => buildVisibleGridColumns(allGridColumns, visibleCols),
        [allGridColumns, visibleCols],
    );
    const labelsHaveEffect = hasLabelsEffect(columns);
    const formatHasEffect = hasFormatEffect(columns);
    /** When a filter is active, the host's permutation has length `nrowFiltered`.
     *  All grid-coordinate math must use this count so row indices never
     *  exceed the permutation length; display/identity contexts still use nrow. */
    const effectiveNrow = nrowFiltered ?? nrow;
    const displayedFilter = pendingFilterIntent ?? filter;
    // On open, explain the background wait while saved sort/filter
    // preferences are reapplied (#519). The grid already shows natural-order
    // data, so the toolbar keeps its row-count while the banner offers a
    // clearer "skip and show data now" affordance below it.
    const restoreMessage = restorePending
        ? (restoreCancelling
            ? 'Loading…'
            : describeRestoreMessage(restorePending.sort, restorePending.filter))
        : null;
    const rowCountText = describeToolbarRowCount(
        effectiveNrow, visibleRange, loading, false,
    );
    /** Whether the chip group must wrap onto its own second row. `layout.hiddenColumns.length`
     *  is in the deps because the Columns count badge widens the action buttons without
     *  changing the toolbar width — without that the wrap state can be stale.
     *  `labelsHaveEffect`/`formatHasEffect` are in the deps for the same reason:
     *  they add/remove the Labels and Format/digits controls (changing the action
     *  group's width) on dataset change without changing the toolbar width. */
    const toolbarChipsWrapped = useToolbarWrap(
        {
            toolbar: toolbarRef,
            lead: rowCountRef,
            chips: toolbarChipsRef,
            actions: toolbarActionsRef,
        },
        // sortPending/filterPending are deps because the progress pills they
        // drive widen the chip group, which can change whether it must wrap.
        [sort.keys, displayedFilter.entries, rowCountText, layout.hiddenColumns.length, sortPending, filterPending, labelsHaveEffect, formatHasEffect],
    );
    /** Transient progress pills for the toolbar chip group. The data viewer
     *  has no bottom status bar: the sort/filter chip strips carry the full
     *  sort/filter picture, and the row-count lead carries the totals (and
     *  "Loading…"). These pills are the only "working…" cue while the host
     *  rebuilds a permutation/filter index on a large frame. */
    const pendingLabels = pendingOperationLabels(sortPending, filterPending);

    const persistWebviewState = useCallback(() => {
        vscode.setState?.({
            panelGeneration,
            nrow,
            columns,
            dictionaries,
            layout,
            settings,
            toolbar,
            schemaHash,
            visibleRange,
            sort,
            filter,
            nrowFiltered,
            histograms,
        });
    }, [
        vscode,
        panelGeneration,
        nrow,
        columns,
        dictionaries,
        layout,
        settings,
        toolbar,
        schemaHash,
        visibleRange,
        sort,
        filter,
        nrowFiltered,
        histograms,
    ]);

    useEffect(() => {
        persistWebviewState();
    }, [persistWebviewState]);

    const focusCell = useCallback((selection: GridSelection = gridSelection): { row: number; col: number } | null => {
        const current = selection.current;
        if (current) {
            const col = visibleCols[current.cell[0]];
            if (col !== undefined) return { row: current.cell[1], col };
        }
        if (effectiveNrow <= 0 || visibleCols.length === 0) return null;
        return { row: Math.min(effectiveNrow - 1, visibleRange.start), col: visibleCols[0] };
    }, [effectiveNrow, gridSelection, visibleCols, visibleRange.start]);

    const postLifecycle = useCallback((
        event: string,
        range: VisibleRange = visibleRange,
        selection = gridSelection,
        generation = panelGeneration,
    ) => {
        vscode.postMessage({
            type: 'lifecycle',
            event,
            panelGeneration: generation,
            nrow,
            columns: columns.length,
            visibleRows: Math.max(0, range.end - range.start),
            visibleRangeStart: range.start,
            visibleRangeEnd: range.end,
            viewportRangeStart: range.start,
            viewportRangeEnd: range.end,
            focusCell: focusCell(selection),
            timestamp: Date.now(),
        });
    }, [columns.length, focusCell, gridSelection, nrow, panelGeneration, visibleRange, vscode]);

    const persistLayout = useCallback((nextLayout: Layout) => {
        if (!schemaHash) return;
        vscode.postMessage({
            type: 'saveLayout',
            panelGeneration,
            schemaHash,
            layout: {
                columnWidths: { ...nextLayout.columnWidths },
                hiddenColumns: [...nextLayout.hiddenColumns],
            },
        });
    }, [panelGeneration, schemaHash, vscode]);

    const clearRows = useCallback(() => {
        rowCacheRef.current.clear();
        inflightRef.current.clear();
        pendingKeysRef.current.clear();
        if (missingRowRequestTimerRef.current !== null) {
            window.clearTimeout(missingRowRequestTimerRef.current);
            missingRowRequestTimerRef.current = null;
        }
        missingRowRequestRef.current = null;
        setCacheRevision(r => r + 1);
    }, []);

    const requestRows = useCallback((range: VisibleRange) => {
        if (bootstrappingRef.current) return;
        if (range.end <= range.start || visibleCols.length === 0) return;
        if (rowCacheRef.current.hasRange(range.start, range.end)) return;
        const columnsKey = visibleCols.join(',');
        const key = `${range.start}:${range.end}:${columnsKey}`;
        if (pendingKeysRef.current.has(key)) return;

        viewportGenerationRef.current += 1;
        const requestId = nextRequestId();
        pendingKeysRef.current.add(key);
        inflightRef.current.set(requestId, key);
        vscode.postMessage({
            type: 'getRows',
            panelGeneration,
            requestId,
            viewportGeneration: viewportGenerationRef.current,
            start: range.start,
            end: range.end,
            columns: visibleCols,
        });
    }, [nextRequestId, panelGeneration, visibleCols, vscode]);

    const scheduleMissingRowRequest = useCallback((row: number) => {
        if (effectiveNrow <= 0 || visibleCols.length === 0) return;
        const clamped = Math.max(0, Math.min(effectiveNrow - 1, row));
        const current = missingRowRequestRef.current;
        missingRowRequestRef.current = current
            ? {
                start: Math.min(current.start, clamped),
                end: Math.max(current.end, clamped + 1),
            }
            : { start: clamped, end: clamped + 1 };
        if (missingRowRequestTimerRef.current !== null) return;
        missingRowRequestTimerRef.current = window.setTimeout(() => {
            const range = missingRowRequestRef.current;
            missingRowRequestRef.current = null;
            missingRowRequestTimerRef.current = null;
            if (!range) return;
            requestRows(paddedRange(range.start, range.end - range.start, effectiveNrow, OVERSCAN_ROWS));
        }, 0);
    }, [effectiveNrow, requestRows, visibleCols.length]);

    useEffect(() => () => {
        if (missingRowRequestTimerRef.current !== null) {
            window.clearTimeout(missingRowRequestTimerRef.current);
        }
    }, []);

    const applyInitOrReplace = useCallback((m: Extract<ExtensionToWebview, { type: 'init' | 'replace' }>) => {
        const sameDataset = m.nrow === nrow
            && sameColumns(m.columns, columns);
        panelGenerationRef.current = m.panelGeneration;
        setPanelGeneration(m.panelGeneration);
        setNrow(m.nrow);
        setColumns(m.columns);
        setLayout(m.layout);
        setDictionaries(m.dictionaries);
        setSchemaHash(m.schemaHash);
        if (m.type === 'init') setSettings(m.settings);
        setToolbar(m.toolbar);
        latestSortRequestIdRef.current = null;
        latestSortIntentRef.current = null;
        acceptedSortRequestIdRef.current = 0;
        latestFilterRequestIdRef.current = null;
        latestFilterIntentRef.current = null;
        acceptedFilterRequestIdRef.current = 0;
        intentRequestStateRef.current.latestSortIntent = null;
        intentRequestStateRef.current.latestFilterIntent = null;
        setPendingFilterIntent(null);
        setSort(m.sort);
        setSortPending(false);
        setFilter(m.filter);
        // init/replace carries the host's authoritative filter; don't echo it
        // back via saveFilter (see lastHostFilterRef).
        lastHostFilterRef.current = m.filter;
        // Histograms are fetched lazily per column (getHistogram) the first
        // time a numeric filter popover opens — not shipped in init/replace.
        // Drop any cached bins + in-flight request markers whenever the
        // dataset changes (always on replace; on init unless this is the same
        // dataset being restored from getState, e.g. after a tab hide/show),
        // since bins are keyed by column index and would be wrong for a
        // different schema. A same-dataset init keeps the restored cache.
        if (m.type === 'replace' || !sameDataset) {
            setHistograms({});
            histogramRequestedRef.current.clear();
        }
        setFilterPending(false);
        setNrowFiltered(undefined);
        setLoading(false);
        toolbarBootstrappedRef.current = true;
        clearRows();
        setResolvedLabels({});
        setGridSelection(createEmptySelection());
        if (!sameDataset) setVisibleRange({ start: 0, end: 0 });
        postLifecycle(
            m.type,
            sameDataset ? visibleRange : { start: 0, end: 0 },
            createEmptySelection(),
            m.panelGeneration,
        );
        window.setTimeout(() => gridRef.current?.scrollTo(0, 0, 'both'), 0);
    }, [clearRows, columns, nrow, panelGeneration, postLifecycle, visibleRange]);

    const applyRows = useCallback((m: Extract<ExtensionToWebview, { type: 'rows' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        const key = inflightRef.current.get(m.requestId);
        if (!key) {
            return;
        }
        pendingKeysRef.current.delete(key);
        inflightRef.current.delete(m.requestId);
        if (m.stale) return;
        rowCacheRef.current.put(m.start, m.end, m.rows);
        setCacheRevision(r => r + 1);
        const rowEnd = Math.min(m.end, m.start + m.rows.length);
        const width = Math.min(visibleCols.length, m.rows[0]?.length ?? visibleCols.length);
        const damageList: { cell: Item }[] = [];
        for (let row = m.start; row < rowEnd; row++) {
            for (let displayCol = 0; displayCol < width; displayCol++) {
                damageList.push({ cell: [displayCol, row] });
            }
        }
        if (damageList.length > 0) {
            gridRef.current?.updateCells(damageList);
        }
        postLifecycle('rows');
    }, [postLifecycle, visibleCols.length]);

    const applyLabels = useCallback((m: Extract<ExtensionToWebview, { type: 'labels' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        setResolvedLabels(previous => ({
            ...previous,
            [m.columnIndex]: {
                ...(previous[m.columnIndex] ?? {}),
                ...m.labels,
            },
        }));
        const displayCol = visibleCols.indexOf(m.columnIndex);
        if (displayCol < 0) return;
        const damageList: { cell: Item }[] = [];
        for (let row = visibleRange.start; row < visibleRange.end; row++) {
            damageList.push({ cell: [displayCol, row] });
        }
        if (damageList.length > 0) {
            gridRef.current?.updateCells(damageList);
        }
    }, [visibleCols, visibleRange.end, visibleRange.start]);

    const applyHistogram = useCallback((m: Extract<ExtensionToWebview, { type: 'histogram' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        if (histogramRequestedRef.current.get(m.columnIndex) !== m.requestId) return;
        histogramRequestedRef.current.delete(m.columnIndex);
        setHistograms(prev => ({ ...prev, [m.columnIndex]: m.bins }));
    }, []);

    const applySortApplied = useCallback((m: Extract<ExtensionToWebview, { type: 'sortApplied' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        if (!shouldAcceptSortResponse(
            latestSortRequestIdRef.current,
            m.requestId,
            m.fromPersistence,
        )) return;
        latestSortRequestIdRef.current = null;
        latestSortIntentRef.current = null;
        acceptedSortRequestIdRef.current = m.requestId;
        setSort(m.sort);
        setSortPending(false);
        // Permutation just changed — every cached row window is now in
        // the wrong order. Clear and refetch the current viewport.
        clearRows();
        // (Pulse animation on apply, suppressed when fromPersistence,
        // is deferred — spec §3.1 describes it but no callers depend on
        // it for v1.)
        // Refetch covers the visible range; the existing
        // requestRows / paddedRange path picks the right window once the
        // cache is empty.
        if (effectiveNrow > 0 && visibleCols.length > 0) {
            requestRows(paddedRange(
                visibleRange.start,
                Math.max(1, visibleRange.end - visibleRange.start),
                effectiveNrow,
                OVERSCAN_ROWS,
            ));
        }
        if (m.error) {
            setCopyStatus('error');
            setCopyStatusMsg(m.error);
        }
        // Persist the latest sort. Cleared (empty keys) saves are also
        // valid — the host treats an empty SortState as a clear. Rollbacks
        // are failure recovery, not a new user preference.
        if (schemaHash && !m.rollback) {
            vscode.postMessage({
                type: 'saveSort',
                panelGeneration: m.panelGeneration,
                schemaHash,
                sort: m.sort,
            });
        }
    }, [
        clearRows,
        effectiveNrow,
        requestRows,
        schemaHash,
        visibleCols.length,
        visibleRange,
        vscode,
    ]);

    const applySortStatus = useCallback((m: Extract<ExtensionToWebview, { type: 'sortStatus' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        if (!shouldAcceptSortResponse(latestSortRequestIdRef.current, m.requestId, false)) return;
        setSortPending(m.state === 'pending');
    }, []);

    const applyFilterApplied = useCallback((m: Extract<ExtensionToWebview, { type: 'filterApplied' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        if (!shouldAcceptAppliedResponse(
            latestFilterRequestIdRef.current,
            m.requestId,
            m.fromPersistence,
        )) {
            if (m.fromPersistence) restoreInteractionBlockRef.current = null;
            return;
        }
        latestFilterRequestIdRef.current = null;
        latestFilterIntentRef.current = null;
        acceptedFilterRequestIdRef.current = m.requestId;
        setPendingFilterIntent(null);
        if (m.error) {
            setCopyStatus('error');
            setCopyStatusMsg(m.error);
        }
        setFilter(m.filter);
        // Host-owned state and rollback recovery are not new user
        // preferences. Successful user filter applies are persisted
        // immediately (like sort applies), then marked as handled so the
        // debounced saveFilter effect does not duplicate the write. Persisting
        // on acknowledgement avoids losing an accepted filter if a later
        // pending filter cancels the debounce and then rolls back.
        if (m.fromPersistence) {
            lastHostFilterRef.current = m.filter;
            restoreInteractionBlockRef.current = null;
        } else if (m.rollback) {
            lastHostFilterRef.current = m.filter;
        } else if (schemaHash) {
            vscode.postMessage({
                type: 'saveFilter',
                panelGeneration: m.panelGeneration,
                schemaHash,
                filter: m.filter,
            });
            lastHostFilterRef.current = m.filter;
        }
        const activeNrowFiltered = m.filter.entries.some(e => e.enabled) ? m.nrowFiltered : undefined;
        setNrowFiltered(activeNrowFiltered);
        setFilterPending(false);
        // Permutation just changed — every cached row window is stale.
        // Clear and refetch the current viewport, exactly as applySortApplied does.
        // clearRows() is idempotent (safe on the fromPersistence path too).
        clearRows();
        const count = activeNrowFiltered ?? nrow;
        if (count > 0 && visibleCols.length > 0) {
            requestRows(paddedRange(
                visibleRange.start,
                Math.max(1, visibleRange.end - visibleRange.start),
                count,
                OVERSCAN_ROWS,
            ));
        }
    }, [
        clearRows,
        nrow,
        requestRows,
        schemaHash,
        visibleCols.length,
        visibleRange,
        vscode,
    ]);

    const applyFilterStatus = useCallback((m: Extract<ExtensionToWebview, { type: 'filterStatus' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        if (!shouldAcceptInteractiveResponse(latestFilterRequestIdRef.current, m.requestId)) return;
        setFilterPending(m.state === 'pending');
    }, []);

    /** Send a setFilters request. Empty `entries` clears the filter. The host
     *  replies with `filterApplied` which drives state updates. */
    const applyFilters = useCallback((entries: FilterEntry[]) => {
        if (bootstrappingRef.current || restoreInteractionBlockRef.current !== null) return;
        const request = requestFilterIntent(
            intentRequestStateRef.current,
            entries,
            toolbar.labelsOn,
        );
        nextRequestIdRef.current = intentRequestStateRef.current.nextRequestId;
        const next = request.filter;
        latestFilterIntentRef.current = next;
        setPendingFilterIntent(next);
        setFilterPending(next.entries.some(e => e.enabled));
        latestFilterRequestIdRef.current = request.requestId;
        vscode.postMessage({
            type: 'setFilters',
            panelGeneration,
            requestId: request.requestId,
            rollbackBaseRequestId: acceptedFilterRequestIdRef.current,
            entries: request.entries,
            labelsOn: next.labelsOnWhenFiltered,
        });
    }, [panelGeneration, toolbar.labelsOn, vscode]);

    const filterEntriesForRequest = useCallback(() => {
        return filterEntriesForNextRequest(filter.entries, latestFilterIntentRef.current);
    }, [filter.entries]);

    const onEditFilter = useCallback((entry: FilterEntry) => {
        setFilterEditor({ entry });
    }, []);

    /** Open the filter popover for a column, pre-seeded with its active filter
     *  (one-filter-per-column invariant) so editing reflects the live settings.
     *  When the column is unfiltered, `existing` is undefined and the popover
     *  opens blank — the "add new" path. Reads through
     *  `filterEntriesForRequest` so rapid edits compose from the latest pending
     *  request rather than the last host acknowledgement. */
    const openFilterEditor = useCallback(
        (columnIndex: number, leftPx: number, topPx: number) => {
            const existing = filterEntriesForRequest().find(e => e.columnIndex === columnIndex);
            setFilterEditor({ entry: existing, columnIndex, leftPx, topPx });
        },
        [filterEntriesForRequest],
    );

    const onToggleFilterEnabled = useCallback((id: string) => {
        applyFilters(filterEntriesForRequest().map(e => e.id === id ? { ...e, enabled: !e.enabled } : e));
    }, [applyFilters, filterEntriesForRequest]);

    const onRemoveFilter = useCallback((id: string) => {
        applyFilters(filterEntriesForRequest().filter(e => e.id !== id));
    }, [applyFilters, filterEntriesForRequest]);

    const onClearAllFilters = useCallback(() => {
        applyFilters([]);
    }, [applyFilters]);

    const clearFilterOnColumn = useCallback((columnIndex: number) => {
        applyFilters(filterEntriesForRequest().filter(e => e.columnIndex !== columnIndex));
    }, [filterEntriesForRequest, applyFilters]);

    /** Send a setSort request. Empty `keys` clears the sort. The host
     *  replies with `sortApplied` which drives state updates. */
    const applySort = useCallback((keys: SortKey[]) => {
        if (bootstrappingRef.current || restoreInteractionBlockRef.current !== null) return;
        const request = requestSortIntent(
            intentRequestStateRef.current,
            keys,
            toolbar.labelsOn,
        );
        nextRequestIdRef.current = intentRequestStateRef.current.nextRequestId;
        const next = request.sort;
        latestSortIntentRef.current = next;
        setSort(next);
        setSortPending(keys.length > 0);
        latestSortRequestIdRef.current = request.requestId;
        vscode.postMessage({
            type: 'setSort',
            panelGeneration,
            requestId: request.requestId,
            rollbackBaseRequestId: acceptedSortRequestIdRef.current,
            keys: request.keys,
            labelsOn: toolbar.labelsOn,
            formatOn: toolbar.formatOn,
            digits: toolbar.digits,
        });
    }, [panelGeneration, toolbar, vscode]);

    const sortKeysForRequest = useCallback(() => {
        return sortKeysForNextRequest(sort.keys, latestSortIntentRef.current);
    }, [sort.keys]);

    /** Pick a direction for `sourceIndex`. When `append` is true, merge
     *  into the existing sort (flipping the column's direction in place
     *  if already present). Otherwise this column becomes the only sort
     *  key. */
    const sortColumn = useCallback((
        sourceIndex: number,
        direction: 'asc' | 'desc',
        append: boolean,
    ) => {
        const next = nextSortKeysForColumn(sortKeysForRequest(), sourceIndex, direction, append);
        if (!next) return;
        applySort(next);
    }, [applySort, sortKeysForRequest]);

    const clearSortOnColumn = useCallback((sourceIndex: number) => {
        const current = sortKeysForRequest();
        const next = current.filter(k => k.columnIndex !== sourceIndex);
        if (next.length === current.length) return;
        applySort(next);
    }, [applySort, sortKeysForRequest]);

    const clearAllSorts = useCallback(() => {
        if (sortKeysForRequest().length === 0) return;
        applySort([]);
    }, [applySort, sortKeysForRequest]);

    const applyCopyDone = useCallback((m: Extract<ExtensionToWebview, { type: 'copyDone' }>) => {
        if (m.panelGeneration !== panelGenerationRef.current) return;
        setCopyStatus(m.ok ? 'copied' : 'error');
        setCopyStatusMsg(m.ok ? 'Copied' : (m.error ?? 'Copy failed'));
        window.setTimeout(() => {
            setCopyStatus('');
            setCopyStatusMsg('');
        }, 2500);
    }, []);

    const estimatedViewportRowCount = useCallback((): number => {
        const current = visibleRange.end - visibleRange.start;
        if (current > 0) return current;
        const shell = document.querySelector('.grid-shell');
        const height = shell instanceof HTMLElement ? shell.clientHeight : 0;
        return Math.max(1, Math.floor((height - HEADER_HEIGHT_PX) / ROW_HEIGHT_PX) || 20);
    }, [visibleRange.end, visibleRange.start]);

    const viewportForStart = useCallback((start: number): VisibleRange => {
        const height = estimatedViewportRowCount();
        const clampedStart = Math.max(0, Math.min(start, Math.max(0, effectiveNrow - height)));
        return {
            start: clampedStart,
            end: Math.min(effectiveNrow, clampedStart + height),
        };
    }, [effectiveNrow, estimatedViewportRowCount]);

    const scrollToViewport = useCallback((
        viewport: VisibleRange,
        event: string,
        selection: GridSelection = gridSelection,
    ) => {
        setVisibleRange(viewport);
        requestRows(paddedRange(viewport.start, viewport.end - viewport.start, effectiveNrow, OVERSCAN_ROWS));
        postLifecycle(event, viewport, selection);
    }, [effectiveNrow, gridSelection, postLifecycle, requestRows]);

    useEffect(() => {
        if (effectiveNrow <= 0 || visibleCols.length === 0) return;
        const hasViewport = visibleRange.end > visibleRange.start;
        const viewport = hasViewport
            ? visibleRange
            : {
                start: 0,
                end: Math.min(effectiveNrow, estimatedViewportRowCount()),
            };
        const timeout = window.setTimeout(() => {
            if (!hasViewport) {
                setVisibleRange(viewport);
                postLifecycle('initial-visible', viewport);
            }
            requestRows(paddedRange(
                viewport.start,
                viewport.end - viewport.start,
                effectiveNrow,
                OVERSCAN_ROWS,
            ));
        }, 0);
        return () => window.clearTimeout(timeout);
    }, [
        effectiveNrow,
        estimatedViewportRowCount,
        postLifecycle,
        requestRows,
        visibleCols.length,
        visibleRange,
    ]);

    const scrollToFraction = useCallback((fraction: number) => {
        const clamped = Math.max(0, Math.min(1, fraction));
        const height = estimatedViewportRowCount();
        const start = effectiveNrow <= 0 ? 0 : Math.round(Math.max(0, effectiveNrow - height) * clamped);
        const targetRow = clamped >= 1 ? Math.max(0, effectiveNrow - 1) : start;
        gridRef.current?.scrollTo(0, targetRow, 'vertical', 0, 0, {
            vAlign: clamped >= 1 ? 'end' : clamped <= 0 ? 'start' : 'center',
        });
        scrollToViewport(viewportForStart(start), 'test-scroll');
    }, [effectiveNrow, estimatedViewportRowCount, scrollToViewport, viewportForStart]);

    const handleTestKey = useCallback((key: string) => {
        if (key === 'End') {
            const displayCol = Math.max(0, Math.min(
                visibleCols.length - 1,
                gridSelection.current?.cell[0] ?? 0,
            ));
            const row = Math.max(0, effectiveNrow - 1);
            const next = createCellSelection(displayCol, row);
            setGridSelection(next);
            scrollToFraction(1);
            postLifecycle('test-key', viewportForStart(Math.max(0, effectiveNrow - estimatedViewportRowCount())), next);
            return;
        }
        if (key === 'Home') {
            const next = createCellSelection(0, 0);
            setGridSelection(next);
            scrollToFraction(0);
            postLifecycle('test-key', viewportForStart(0), next);
            return;
        }
        if (effectiveNrow <= 0 || visibleCols.length === 0) return;
        const current = gridSelection.current?.cell ?? [0, Math.max(0, visibleRange.start)];
        let col = current[0];
        let row = current[1];
        if (key === 'ArrowDown') row += 1;
        else if (key === 'ArrowUp') row -= 1;
        else if (key === 'ArrowRight') col += 1;
        else if (key === 'ArrowLeft') col -= 1;
        else return;
        col = Math.max(0, Math.min(visibleCols.length - 1, col));
        row = Math.max(0, Math.min(effectiveNrow - 1, row));
        const next = createCellSelection(col, row);
        setGridSelection(next);
        gridRef.current?.focus();
        gridRef.current?.scrollTo(col, row, 'both');
        let viewport = visibleRange;
        if (row < visibleRange.start || row >= visibleRange.end) {
            viewport = viewportForStart(row);
            setVisibleRange(viewport);
            requestRows(paddedRange(viewport.start, viewport.end - viewport.start, effectiveNrow, OVERSCAN_ROWS));
        }
        postLifecycle('test-key', viewport, next);
    }, [
        effectiveNrow,
        estimatedViewportRowCount,
        gridSelection,
        postLifecycle,
        requestRows,
        scrollToFraction,
        viewportForStart,
        visibleCols.length,
        visibleRange,
    ]);

    useEffect(() => {
        bootstrappingRef.current = true;
        vscode.postMessage({ type: 'webviewReady' });
    }, [vscode]);

    /** Skip the in-flight saved-sort/filter restore (#519). Posts the
     *  echoed restoreId so a stale cancel from a prior lifecycle is ignored
     *  by the host, and optimistically shows "Loading…" until the
     *  natural-order init/replace lands. */
    const cancelRestore = useCallback(() => {
        const id = restoreIdRef.current;
        if (id === null) return;
        setRestoreCancelling(true);
        vscode.postMessage({
            type: 'cancelRestore',
            panelGeneration,
            restoreId: id,
        });
    }, [vscode, panelGeneration]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
            const m = event.data;
            if (!m || typeof m !== 'object') return;
            const currentGeneration = panelGenerationRef.current;
            if ('panelGeneration' in m && m.panelGeneration < currentGeneration) return;
            if ('panelGeneration' in m && bootstrappingRef.current) {
                if (m.type !== 'init' && m.type !== 'replace' && m.type !== 'restorePending') return;
                if (m.panelGeneration <= currentGeneration) return;
            }
            switch (m.type) {
                case 'restorePending': {
                    // Defer showing the banner until the debounce elapses; a
                    // restore that completes sooner clears the timer on
                    // init/replace below and never flashes the message.
                    restoreIdRef.current = m.restoreId;
                    setRestoreCancelling(false);
                    if (restoreTimerRef.current !== null) {
                        clearTimeout(restoreTimerRef.current);
                    }
                    const info = { restoreId: m.restoreId, sort: m.sort, filter: m.filter };
                    restoreInteractionBlockRef.current = { sort: m.sort, filter: m.filter };
                    // If a banner is already visible (a prior restore whose
                    // debounce elapsed), swap its wording at once rather than
                    // showing stale text until the timer fires.
                    setRestorePending(prev => (prev ? info : prev));
                    restoreTimerRef.current = setTimeout(() => {
                        setRestorePending(info);
                        restoreTimerRef.current = null;
                    }, RESTORE_DEBOUNCE_MS);
                    return;
                }
                case 'init':
                case 'replace':
                    bootstrappingRef.current = false;
                    // Both the normal and cancelled/late-cancel restore paths
                    // end by posting init/replace, so clear the banner here.
                    if (restoreTimerRef.current !== null) {
                        clearTimeout(restoreTimerRef.current);
                        restoreTimerRef.current = null;
                    }
                    setRestorePending(null);
                    setRestoreCancelling(false);
                    if (!(restoreInteractionBlockRef.current?.filter
                        && m.filter.entries.some(e => e.enabled))) {
                        restoreInteractionBlockRef.current = null;
                    }
                    restoreIdRef.current = null;
                    applyInitOrReplace(m);
                    return;
                case 'rows':
                    applyRows(m);
                    return;
                case 'labels':
                    applyLabels(m);
                    return;
                case 'histogram':
                    applyHistogram(m);
                    return;
                case 'copyDone':
                    applyCopyDone(m);
                    return;
                case 'sortApplied':
                    applySortApplied(m);
                    return;
                case 'sortStatus':
                    applySortStatus(m);
                    return;
                case 'filterApplied':
                    applyFilterApplied(m);
                    return;
                case 'filterStatus':
                    applyFilterStatus(m);
                    return;
                case 'testKey':
                    handleTestKey(m.key);
                    return;
                case 'testScrollToFraction':
                    scrollToFraction(m.fraction);
                    return;
                case 'error':
                    setCopyStatus('error');
                    setCopyStatusMsg(m.message);
                    return;
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [
        applyCopyDone,
        applyFilterApplied,
        applyFilterStatus,
        applyHistogram,
        applyInitOrReplace,
        applyLabels,
        applyRows,
        applySortApplied,
        applySortStatus,
        handleTestKey,
        panelGeneration,
        scrollToFraction,
        vscode,
    ]);

    // Clear the restore-banner debounce timer on UNMOUNT only. This must not
    // live in the message-handler effect's cleanup: that effect re-runs on
    // every dep change (e.g. a scroll updates visibleRange → applyInitOrReplace
    // identity changes), which would clear a pending timer and prevent the
    // banner from ever appearing during a slow restore while the old grid is
    // still interactive.
    useEffect(() => () => {
        if (restoreTimerRef.current !== null) {
            clearTimeout(restoreTimerRef.current);
            restoreTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!toolbarBootstrappedRef.current || !schemaHash) return;
        vscode.postMessage({
            type: 'saveToolbar',
            panelGeneration,
            schemaHash,
            toolbar,
        });
    }, [panelGeneration, schemaHash, toolbar, vscode]);

    // Lazily fetch a numeric column's histogram the first time its filter
    // popover opens. Histograms are not shipped at init (a full-frame scan
    // would block the grid from painting — see histograms.ts), so the brush
    // appears once the host replies. Non-numeric columns have no brush, so
    // we don't request them.
    useEffect(() => {
        if (filterEditor === null) return;
        const ci = filterEditor.entry?.columnIndex ?? filterEditor.columnIndex;
        if (ci === undefined) return;
        const col = columns[ci];
        if (!col) return;
        // Only columns that get a histogram brush in the popover. Gate on the
        // same classifier the popover uses (colKind) so "shows a brush" and
        // "fetches the bins" can never diverge — both numeric and labelled-
        // numeric columns offer the between/histogram predicate.
        const kind = colKind(col);
        if (kind !== 'numeric' && kind !== 'labelledNumeric') return;
        if (histograms[ci] !== undefined) return;          // already cached
        if (histogramRequestedRef.current.has(ci)) return;  // request in flight
        if (bootstrappingRef.current) return;
        const requestId = nextRequestId();
        histogramRequestedRef.current.set(ci, requestId);
        vscode.postMessage({
            type: 'getHistogram',
            panelGeneration,
            requestId,
            columnIndex: ci,
        });
    }, [filterEditor, columns, histograms, nextRequestId, panelGeneration, vscode]);

    useEffect(() => {
        // Guard on the same bootstrap flag as saveToolbar: until the first
        // init/replace lands, `filter` is still the (possibly empty) seed,
        // and saving it would clobber a host-persisted filter before the
        // restore round-trip completes.
        if (!toolbarBootstrappedRef.current || !schemaHash) return;
        if (pendingFilterIntent !== null || latestFilterRequestIdRef.current !== null) return;
        // Don't echo a host-owned filter back to the store. On a genuine
        // restore-filter read failure the host keeps the saved filter but
        // sends EMPTY for display; echoing that would destroy the pref the
        // host preserved. A real user change replaces `filter` with a new
        // object, so it still persists. (#519)
        if (filter === lastHostFilterRef.current) return;
        const id = window.setTimeout(() => {
            vscode.postMessage({
                type: 'saveFilter',
                panelGeneration,
                schemaHash,
                filter,
            });
        }, 300);
        return () => window.clearTimeout(id);
    }, [filter, panelGeneration, pendingFilterIntent, schemaHash, vscode]);

    /** Labels-toggle invalidates sort keys derived from displayed text.
     *  When the active sort touches a factor or value-labelled column
     *  and Labels changed since the sort was built, re-issue setSort so
     *  the host rebuilds the permutation against the current toolbar
     *  state. Numeric / date / string sorts are unaffected and skipped. */
    useEffect(() => {
        if (sort.keys.length === 0) return;
        if (sort.labelsOnWhenSorted === toolbar.labelsOn) return;
        const touchesLabelled = sort.keys.some(k => {
            const col = columns[k.columnIndex];
            if (!col) return false;
            return col.arrowType.startsWith('Dictionary')
                || (col.arrowType.startsWith('Float') && col.valueLabels);
        });
        if (!touchesLabelled) return;
        applySort(sort.keys);
    }, [applySort, columns, sort, toolbar.labelsOn]);

    /** Labels-toggle invalidates setIn/setNotIn filter predicates that were
     *  built against label strings. When the active filter touches a labelled
     *  column and labelsOn changed since the filter was built, re-issue
     *  applyFilters so the host recomputes the permutation under the new
     *  toolbar state. The resulting filterApplied sets
     *  filter.labelsOnWhenFiltered = toolbar.labelsOn, making the guard true
     *  on the next render and preventing an infinite re-fire loop. */
    useEffect(() => {
        if (displayedFilter.entries.length === 0) return;
        if (displayedFilter.labelsOnWhenFiltered === toolbar.labelsOn) return;
        const touchesLabelled = displayedFilter.entries.some(e => {
            const col = columns[e.columnIndex];
            if (!col) return false;
            return e.predicate.kind === 'setIn' || e.predicate.kind === 'setNotIn';
        });
        if (!touchesLabelled) return;
        applyFilters(filterEntriesForRequest());
    }, [applyFilters, columns, displayedFilter, filterEntriesForRequest, toolbar.labelsOn]);

    useEffect(() => {
        if (!toolbar.labelsOn) return;
        const wantByColumn: Record<number, Set<number>> = {};
        for (let displayCol = 0; displayCol < visibleCols.length; displayCol++) {
            const colIdx = visibleCols[displayCol];
            const col = columns[colIdx];
            if (!col || col.dictionaryShipped || !col.arrowType.startsWith('Dictionary')) continue;
            const cache = resolvedLabels[colIdx] ?? {};
            for (let row = visibleRange.start; row < visibleRange.end; row++) {
                const cell = rowCacheRef.current.getRow(row)?.[displayCol];
                if (typeof cell === 'number' && cache[cell] === undefined) {
                    (wantByColumn[colIdx] ??= new Set()).add(cell);
                }
            }
        }
        for (const [colIndexRaw, indices] of Object.entries(wantByColumn)) {
            if (indices.size === 0) continue;
            const requestId = nextRequestId();
            vscode.postMessage({
                type: 'getLabels',
                panelGeneration,
                requestId,
                columnIndex: Number(colIndexRaw),
                indices: [...indices],
            });
        }
    }, [
        cacheRevision,
        columns,
        panelGeneration,
        resolvedLabels,
        toolbar.labelsOn,
        visibleCols,
        visibleRange,
        vscode,
    ]);

    const copySelection = useCallback((selection: GridSelection = gridSelection) => {
        if (effectiveNrow <= 0 || visibleCols.length === 0) return;
        let rowStart = 0;
        let rowEnd = 0;
        let colIndices: number[] = [];
        let includeHeader = false;

        if (selection.columns.length > 0) {
            rowStart = 0;
            rowEnd = effectiveNrow;
            colIndices = selection.columns.toArray()
                .map(displayCol => visibleCols[displayCol])
                .filter((col): col is number => col !== undefined);
            includeHeader = true;
        } else if (selection.rows.length > 0) {
            const rows = selection.rows.toArray();
            rowStart = Math.max(0, Math.min(...rows));
            rowEnd = Math.min(effectiveNrow, Math.max(...rows) + 1);
            colIndices = [...visibleCols];
        } else if (selection.current) {
            const range = selection.current.range;
            rowStart = Math.max(0, range.y);
            rowEnd = Math.min(effectiveNrow, range.y + range.height);
            for (let displayCol = range.x; displayCol < range.x + range.width; displayCol++) {
                const col = visibleCols[displayCol];
                if (col !== undefined) colIndices.push(col);
            }
        }

        if (rowEnd <= rowStart || colIndices.length === 0) return;
        const requestId = nextRequestId();
        setCopyStatus('copying');
        setCopyStatusMsg('Copying...');
        vscode.postMessage({
            type: 'copy',
            panelGeneration,
            requestId,
            range: { rowStart, rowEnd, colIndices },
            labelsOn: toolbar.labelsOn,
            formatOn: toolbar.formatOn,
            digits: toolbar.digits,
            includeHeader,
        });
    }, [effectiveNrow, gridSelection, nextRequestId, panelGeneration, toolbar, visibleCols, vscode]);

    useEffect(() => {
        const onCopy = (event: ClipboardEvent) => {
            event.preventDefault();
            copySelection();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            // Sort shortcuts: Shift+Alt+A / D / 0. Reserved namespace —
            // they don't collide with the platform's Cmd/Ctrl+A select
            // or arrow-key navigation already wired below. Skip when
            // focus is in a text-entry control (e.g. the column-filter
            // input in the Columns popover) so the modifier doesn't
            // hijack the user's typing.
            if (event.shiftKey && event.altKey
                && !event.metaKey && !event.ctrlKey
                && !isEditableTarget(document.activeElement)) {
                if (event.key === 'A' || event.code === 'KeyA') {
                    event.preventDefault();
                    const focused = gridSelection.current?.cell[0];
                    const sourceIndex = focused !== undefined ? visibleCols[focused] : undefined;
                    if (sourceIndex !== undefined) sortColumn(sourceIndex, 'asc', false);
                    return;
                }
                if (event.key === 'D' || event.code === 'KeyD') {
                    event.preventDefault();
                    const focused = gridSelection.current?.cell[0];
                    const sourceIndex = focused !== undefined ? visibleCols[focused] : undefined;
                    if (sourceIndex !== undefined) sortColumn(sourceIndex, 'desc', false);
                    return;
                }
                if (event.key === ')' || event.code === 'Digit0') {
                    event.preventDefault();
                    clearAllSorts();
                    return;
                }
                if (event.key === '9' || event.code === 'Digit9') {
                    event.preventDefault();
                    onClearAllFilters();
                    return;
                }
                if (event.key === 'F' || event.code === 'KeyF') {
                    event.preventDefault();
                    const focused = gridSelection.current?.cell[0];
                    const sourceIndex = focused !== undefined ? visibleCols[focused] : undefined;
                    if (sourceIndex !== undefined) {
                        openFilterEditor(sourceIndex, 100, 100);
                    }
                    return;
                }
                if (event.key === 'X' || event.code === 'KeyX') {
                    event.preventDefault();
                    const focused = gridSelection.current?.cell[0];
                    const sourceIndex = focused !== undefined ? visibleCols[focused] : undefined;
                    if (sourceIndex !== undefined) clearFilterOnColumn(sourceIndex);
                    return;
                }
            }
            const meta = event.metaKey || event.ctrlKey;
            if (!meta) return;
            if (event.key === 'a' || event.key === 'A') {
                event.preventDefault();
                const next = createAllColumnsSelection(visibleCols.length);
                setGridSelection(next);
                postLifecycle('select-all', visibleRange, next);
            } else if (event.key === 'c' || event.key === 'C') {
                event.preventDefault();
                copySelection();
            }
        };
        document.addEventListener('copy', onCopy);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('copy', onCopy);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [
        clearAllSorts,
        clearFilterOnColumn,
        copySelection,
        gridSelection,
        onClearAllFilters,
        openFilterEditor,
        postLifecycle,
        sortColumn,
        visibleCols,
        visibleRange,
    ]);

    const drawHeader: DrawHeaderCallback = useCallback(({ ctx, column, columnIndex, theme, rect, isSelected, hasSelectedCell }, drawContent) => {
        const col = column as typeof gridColumns[number];
        const sourceIndex = visibleCols[columnIndex];
        const sortEntry = sourceIndex !== undefined ? sortByColumn.get(sourceIndex) : undefined;

        // Default text rendering when no variable label — but we still
        // need to paint sort glyphs on top when the column is sorted.
        if (!col.variableLabel) {
            drawContent();
            if (sortEntry) drawSortGlyphs(ctx, rect, theme, sortEntry, showPriorityBadge);
            return;
        }
        const textColor = isSelected || hasSelectedCell ? theme.textHeaderSelected : theme.textHeader;
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.clip();
        ctx.fillStyle = textColor;
        ctx.font = `${theme.headerFontStyle} ${theme.fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.fillText(col.title, rect.x + 12, rect.y + 14);
        ctx.globalAlpha = 0.68;
        ctx.font = `400 11px ${theme.fontFamily}`;
        ctx.fillText(col.variableLabel, rect.x + 12, rect.y + rect.height - 9);
        ctx.restore();
        if (sortEntry) drawSortGlyphs(ctx, rect, theme, sortEntry, showPriorityBadge);
    }, [gridColumns, showPriorityBadge, sortByColumn, visibleCols]);

    const drawCell: DrawCellCallback = useCallback((args, drawContent) => {
        const sourceIndex = visibleCols[args.col];
        const col = sourceIndex === undefined ? undefined : columns[sourceIndex];
        if (!col || args.cell.kind !== GridCellKind.Text
            || (!col.isInteger && !col.arrowType.startsWith('Float'))) {
            drawContent();
            return;
        }

        const text = args.cell.displayData;
        if (!text) {
            drawContent();
            return;
        }

        const availableWidth = args.rect.width - (args.theme.cellHorizontalPadding * 2) - 1;
        args.ctx.font = `${args.theme.baseFontStyle} ${args.theme.fontFamily}`;
        const fitted = fitLeadingText(text, availableWidth, value => args.ctx.measureText(value).width);
        if (!fitted.truncated) {
            drawContent();
            return;
        }

        args.ctx.save();
        args.ctx.beginPath();
        args.ctx.rect(args.rect.x, args.rect.y, args.rect.width, args.rect.height);
        args.ctx.clip();
        args.ctx.font = `${args.theme.baseFontStyle} ${args.theme.fontFamily}`;
        args.ctx.fillStyle = args.theme.textDark;
        args.ctx.textAlign = 'left';
        args.ctx.textBaseline = 'middle';
        args.ctx.fillText(
            fitted.text,
            args.rect.x + args.theme.cellHorizontalPadding + 0.5,
            args.rect.y + args.rect.height / 2,
        );
        args.ctx.restore();
    }, [columns, visibleCols]);

    const toGridShellPoint = useCallback((clientX: number, clientY: number): { leftPx: number; topPx: number } => {
        const shellRect = gridShellRef.current?.getBoundingClientRect();
        if (!shellRect) return { leftPx: clientX, topPx: clientY };
        return {
            leftPx: clientX - shellRect.left,
            topPx: clientY - shellRect.top,
        };
    }, []);

    useEffect(() => {
        const el = headerTooltipRef.current;
        const parent = gridShellRef.current;
        if (!el || !parent || !headerTooltip) return;
        let left = headerTooltip.leftPx;
        let top = headerTooltip.topPx;
        const margin = 4;
        if (left + el.offsetWidth > parent.clientWidth - margin) {
            left = parent.clientWidth - el.offsetWidth - margin;
        }
        if (top + el.offsetHeight > parent.clientHeight - margin) {
            top = parent.clientHeight - el.offsetHeight - margin;
        }
        el.style.left = `${Math.max(margin, left)}px`;
        el.style.top = `${Math.max(margin, top)}px`;
    }, [headerTooltip]);

    const onItemHovered = useCallback((args: GridMouseEventArgs) => {
        if (args.kind !== 'header') {
            setHeaderTooltip(null);
            return;
        }
        const sourceIndex = visibleCols[args.location[0]];
        const col = sourceIndex === undefined ? undefined : columns[sourceIndex];
        const label = col?.variableLabel?.trim();
        if (!col || !label) {
            setHeaderTooltip(null);
            return;
        }
        const point = toGridShellPoint(args.bounds.x, args.bounds.y + args.bounds.height);
        setHeaderTooltip({
            text: label,
            leftPx: point.leftPx,
            topPx: point.topPx,
        });
    }, [columns, toGridShellPoint, visibleCols]);

    const updateHiddenColumns = useCallback((hiddenColumns: number[]) => {
        const nextLayout = { ...layout, hiddenColumns };
        setLayout(nextLayout);
        clearRows();
        setGridSelection(createEmptySelection());
        persistLayout(nextLayout);
        window.setTimeout(() => postLifecycle('columns'), 0);
    }, [clearRows, layout, persistLayout, postLifecycle]);

    return (
        <div className="data-viewer-root">
            <div
                className={toolbarChipsWrapped ? 'toolbar is-wrapped' : 'toolbar'}
                ref={toolbarRef}
            >
                <span className="row-count" ref={rowCountRef}>{rowCountText}</span>
                <div className="toolbar-chips" ref={toolbarChipsRef}>
                    <ToolbarSortStrip
                        sort={sort}
                        columns={columns}
                        onChange={applySort}
                        onClearAll={clearAllSorts}
                    />
                    <FilterStrip
                        filter={displayedFilter}
                        columns={columns}
                        onEdit={onEditFilter}
                        onToggleEnabled={onToggleFilterEnabled}
                        onRemove={onRemoveFilter}
                        onClearAll={onClearAllFilters}
                    />
                    {pendingLabels.map(label => (
                        <span
                            key={label}
                            className="toolbar-progress"
                            role="status"
                            aria-live="polite"
                        >
                            {label}
                        </span>
                    ))}
                </div>
                <div className="toolbar-actions" ref={toolbarActionsRef}>
                    {/* Labels/Format act on specific column kinds (factors &
                       labelled / Float). When no column in the dataset is
                       affected, the control can never do anything, so hide it
                       rather than show a permanently-greyed button. */}
                    {labelsHaveEffect && (
                        <button
                            type="button"
                            className={toolbar.labelsOn ? 'toggle active' : 'toggle'}
                            onClick={() => setToolbar(t => ({ ...t, labelsOn: !t.labelsOn }))}
                        >
                            Labels
                        </button>
                    )}
                    {formatHasEffect && (
                        <>
                            <button
                                type="button"
                                className={toolbar.formatOn ? 'toggle active' : 'toggle'}
                                onClick={() => setToolbar(t => ({ ...t, formatOn: !t.formatOn }))}
                            >
                                Format
                            </button>
                            {/* Digits is a dependent control: shown whenever
                               Format applies, but disabled (not hidden) while
                               Format is toggled off — a transient, user-driven
                               state, unlike the dataset-level no-effect case. */}
                            <select
                                className="digits"
                                value={toolbar.digits}
                                disabled={!toolbar.formatOn}
                                onChange={event => setToolbar(t => ({ ...t, digits: Number(event.target.value) }))}
                                aria-label="Digits"
                            >
                                {[0, 1, 2, 3, 4, 5, 6].map(d => (
                                    <option key={d} value={d}>{d}</option>
                                ))}
                            </select>
                        </>
                    )}
                    <div className="columns-popover-anchor">
                        <button
                            type="button"
                            className={columnsPopoverOpen ? 'toggle active' : 'toggle'}
                            onClick={() => setColumnsPopoverOpen(open => !open)}
                        >
                            Columns
                            {layout.hiddenColumns.length > 0 && (
                                <span className="hidden-count-badge">{layout.hiddenColumns.length}</span>
                            )}
                        </button>
                        {columnsPopoverOpen && (
                            <ColumnVisibilityPopover
                                columns={columns}
                                hiddenColumns={layout.hiddenColumns}
                                onToggle={index => updateHiddenColumns(toggleColumnHidden(layout.hiddenColumns, index))}
                                onShowAll={() => updateHiddenColumns(showAllColumns())}
                                onHideAll={() => updateHiddenColumns(hideAllColumns(columns))}
                                onClose={() => setColumnsPopoverOpen(false)}
                            />
                        )}
                    </div>
                </div>
            </div>
            {restoreMessage && (
                <div className="toolbar-restore" role="status" aria-live="polite">
                    <span>{restoreMessage}</span>
                    {!restoreCancelling && (
                        <button
                            type="button"
                            className="restore-skip"
                            onClick={cancelRestore}
                        >
                            Skip and show data now
                        </button>
                    )}
                </div>
            )}
            <div className="grid-shell" ref={gridShellRef}>
                <DataEditor
                    ref={gridRef}
                    renderers={DATA_VIEWER_RENDERERS}
                    imageWindowLoader={DATA_VIEWER_IMAGE_LOADER}
                    theme={vscodeTheme}
                    width="100%"
                    height="100%"
                    columns={gridColumns}
                    rows={effectiveNrow}
                    rowHeight={ROW_HEIGHT_PX}
                    headerHeight={HEADER_HEIGHT_PX}
                    rowMarkers={{ kind: 'number', width: rowMarkerWidth(effectiveNrow) }}
                    rowSelect="multi"
                    columnSelect="multi"
                    rangeSelect="rect"
                    smoothScrollX={true}
                    smoothScrollY={true}
                    drawHeader={drawHeader}
                    drawCell={drawCell}
                    onItemHovered={onItemHovered}
                    gridSelection={gridSelection}
                    onGridSelectionChange={selection => {
                        setGridSelection(selection);
                        postLifecycle('selection', visibleRange, selection);
                    }}
                    onHeaderClicked={colIndex => {
                        if (colIndex < 0) return;
                        const next = createColumnSelection(colIndex);
                        setGridSelection(next);
                        postLifecycle('header-click', visibleRange, next);
                    }}
                    onHeaderContextMenu={(colIndex, event) => {
                        event.preventDefault();
                        if (colIndex < 0) {
                            setContextMenu(null);
                            return;
                        }
                        const next = createColumnSelection(colIndex);
                        setGridSelection(next);
                        const point = toGridShellPoint(
                            event.bounds.x + event.localEventX,
                            event.bounds.y + event.localEventY,
                        );
                        setContextMenu({
                            leftPx: point.leftPx,
                            topPx: point.topPx,
                            columnIndex: visibleCols[colIndex],
                            kind: 'column',
                        });
                    }}
                    onCellContextMenu={(_cell, event) => {
                        event.preventDefault();
                        const point = toGridShellPoint(
                            event.bounds.x + event.localEventX,
                            event.bounds.y + event.localEventY,
                        );
                        setContextMenu({
                            leftPx: point.leftPx,
                            topPx: point.topPx,
                            kind: 'cell',
                        });
                    }}
                    onColumnResize={(_column, _newSize, colIndex, newSizeWithGrow) => {
                        const sourceIndex = visibleCols[colIndex];
                        if (sourceIndex === undefined) return;
                        setLayout(current => ({
                            ...current,
                            columnWidths: {
                                ...current.columnWidths,
                                [sourceIndex]: newSizeWithGrow,
                            },
                        }));
                    }}
                    onColumnResizeEnd={(_column, _newSize, colIndex, newSizeWithGrow) => {
                        const sourceIndex = visibleCols[colIndex];
                        if (sourceIndex === undefined) return;
                        setLayout(current => {
                            const next = {
                                ...current,
                                columnWidths: {
                                    ...current.columnWidths,
                                    [sourceIndex]: newSizeWithGrow,
                                },
                            };
                            persistLayout(next);
                            return next;
                        });
                    }}
                    onVisibleRegionChanged={(range: Rectangle) => {
                        const viewport = {
                            start: Math.max(0, Math.floor(range.y)),
                            end: Math.min(effectiveNrow, Math.ceil(range.y + range.height)),
                        };
                        setVisibleRange(viewport);
                        requestRows(paddedRange(range.y, range.height, effectiveNrow, OVERSCAN_ROWS));
                        postLifecycle('visible', viewport);
                    }}
                    getCellContent={([displayCol, row]: Item) => {
                        const sourceIndex = visibleCols[displayCol];
                        const col = sourceIndex === undefined ? undefined : columns[sourceIndex];
                        const cell = rowCacheRef.current.getRow(row)?.[displayCol];
                        if (cell === undefined || !col) {
                            if (col) scheduleMissingRowRequest(row);
                            return {
                                kind: GridCellKind.Text,
                                data: '',
                                displayData: '',
                                readonly: true,
                                allowOverlay: false,
                            };
                        }
                        const dictionary = dictionaries[sourceIndex];
                        const decoded = formatCell(
                            cell,
                            col,
                            dictionary,
                            toolbar.labelsOn,
                            toolbar.formatOn,
                            toolbar.digits,
                        );
                        const labelOverride = toolbar.labelsOn
                            && col.arrowType.startsWith('Dictionary')
                            && !col.dictionaryShipped
                            && typeof cell === 'number'
                            ? resolvedLabels[sourceIndex]?.[cell]
                            : undefined;
                        const text = labelOverride ?? decoded.text;
                        const missingTheme = decoded.missing && settings.missingValueStyle !== 'none'
                            ? settings.missingValueStyle === 'background' ? missingBg : missingFg
                            : undefined;
                        return {
                            kind: GridCellKind.Text,
                            data: text,
                            displayData: text,
                            readonly: true,
                            allowOverlay: true,
                            contentAlign: col.isInteger || col.arrowType.startsWith('Float') ? 'right' : 'left',
                            copyData: text,
                            ...(missingTheme ? { themeOverride: missingTheme } : {}),
                        };
                    }}
                />
                {contextMenu && (
                    <ColumnContextMenu
                        leftPx={contextMenu.leftPx}
                        topPx={contextMenu.topPx}
                        copyLabel={contextMenu.kind === 'column' ? 'Copy Column' : 'Copy'}
                        onCopy={() => {
                            copySelection();
                            setContextMenu(null);
                        }}
                        onHideColumn={contextMenu.columnIndex === undefined
                            ? undefined
                            : () => {
                                updateHiddenColumns(toggleColumnHidden(layout.hiddenColumns, contextMenu.columnIndex!));
                                setContextMenu(null);
                            }}
                        onClose={() => setContextMenu(null)}
                        sort={contextMenu.kind === 'column' && contextMenu.columnIndex !== undefined
                            ? {
                                activeDirection:
                                    sortByColumn.get(contextMenu.columnIndex)?.direction ?? 'none',
                                anySorted: sort.keys.length > 0,
                                otherColumnsSorted: sort.keys.some(
                                    k => k.columnIndex !== contextMenu.columnIndex,
                                ),
                                onSort: (direction, append) => {
                                    sortColumn(contextMenu.columnIndex!, direction, append);
                                    setContextMenu(null);
                                },
                                onAddToSort: (direction) => {
                                    sortColumn(contextMenu.columnIndex!, direction, true);
                                    setContextMenu(null);
                                },
                                onClearColumn: () => {
                                    clearSortOnColumn(contextMenu.columnIndex!);
                                    setContextMenu(null);
                                },
                                onClearAll: () => {
                                    clearAllSorts();
                                    setContextMenu(null);
                                },
                            }
                            : undefined}
                        filter={contextMenu.kind === 'column' && contextMenu.columnIndex !== undefined
                            ? {
                                hasFilter: displayedFilter.entries.some(
                                    e => e.columnIndex === contextMenu.columnIndex,
                                ),
                                anyFiltered: displayedFilter.entries.length > 0,
                                onAddFilter: () => {
                                    openFilterEditor(
                                        contextMenu.columnIndex!,
                                        contextMenu.leftPx,
                                        contextMenu.topPx,
                                    );
                                    setContextMenu(null);
                                },
                                onClearColumn: () => {
                                    applyFilters(filterEntriesForRequest().filter(
                                        e => e.columnIndex !== contextMenu.columnIndex,
                                    ));
                                    setContextMenu(null);
                                },
                                onClearAll: () => {
                                    applyFilters([]);
                                    setContextMenu(null);
                                },
                            }
                            : undefined}
                    />
                )}
                {filterEditor !== null && (() => {
                    const editorColumnIndex = filterEditor.entry?.columnIndex ?? filterEditor.columnIndex;
                    if (editorColumnIndex === undefined) return null;
                    const editorColumn = columns[editorColumnIndex];
                    if (!editorColumn) return null;
                    return (
                        <FilterPopover
                            // Key by target column so switching columns forces a
                            // remount and re-seeds the form from that column's
                            // filter; the seed runs only in useState initializers.
                            key={editorColumnIndex}
                            column={editorColumn}
                            columnIndex={editorColumnIndex}
                            histogram={histograms[editorColumnIndex]}
                            initial={filterEditor.entry}
                            anchor={{
                                leftPx: filterEditor.leftPx ?? 100,
                                topPx: filterEditor.topPx ?? 100,
                            }}
                            onApply={(entry) => {
                                // One-filter-per-column: replace by id (edit) or by columnIndex (new).
                                const next = (() => {
                                    if (filterEditor.entry) {
                                        // Editing existing: replace by id, also enforce one-per-column.
                                        const withoutSameCol = filterEntriesForRequest().filter(
                                            e => e.id !== entry.id && e.columnIndex !== entry.columnIndex,
                                        );
                                        return [...withoutSameCol, entry];
                                    }
                                    // New: replace any existing entry for this column.
                                    const withoutCol = filterEntriesForRequest().filter(
                                        e => e.columnIndex !== entry.columnIndex,
                                    );
                                    return [...withoutCol, entry];
                                })();
                                applyFilters(next);
                                setFilterEditor(null);
                            }}
                            onCancel={() => setFilterEditor(null)}
                        />
                    );
                })()}
                {headerTooltip && (
                    <div
                        ref={headerTooltipRef}
                        className="header-tooltip"
                        style={{
                            left: `${headerTooltip.leftPx}px`,
                            top: `${headerTooltip.topPx}px`,
                        }}
                    >
                        {headerTooltip.text}
                    </div>
                )}
            </div>
            {copyStatus && <div className={`toast toast-${copyStatus}`}>{copyStatusMsg}</div>}
        </div>
    );
}
