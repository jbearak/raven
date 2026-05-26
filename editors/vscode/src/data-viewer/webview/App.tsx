import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    CompactSelection,
    DataEditor,
    GridCellKind,
    type DataEditorRef,
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
    describeHiddenColumnCount,
    describeShape,
    describeVisibleRows,
    fitLeadingText,
    HEADER_HEIGHT_PX,
    OVERSCAN_ROWS,
    paddedRange,
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
    objectClass?: string;
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
    const viewportGenerationRef = useRef(0);
    const toolbarBootstrappedRef = useRef(false);
    const missingRowRequestRef = useRef<VisibleRange | null>(null);
    const missingRowRequestTimerRef = useRef<number | null>(null);

    const [panelGeneration, setPanelGeneration] = useState(restored?.panelGeneration ?? 0);
    const [nrow, setNrow] = useState(restored?.nrow ?? 0);
    const [columns, setColumns] = useState<ColumnSchema[]>(restored?.columns ?? []);
    const [dictionaries, setDictionaries] = useState<Record<number, string[]>>(restored?.dictionaries ?? {});
    const [layout, setLayout] = useState<Layout>(restored?.layout ?? EMPTY_LAYOUT);
    const [settings, setSettings] = useState<Settings>(restored?.settings ?? DEFAULT_SETTINGS);
    const [toolbar, setToolbar] = useState<ToolbarState>(restored?.toolbar ?? EMPTY_TOOLBAR);
    const [schemaHash, setSchemaHash] = useState(restored?.schemaHash ?? '');
    const [objectClass, setObjectClass] = useState<string | undefined>(restored?.objectClass);
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
    const [filterPending, setFilterPending] = useState(false);
    const [nrowFiltered, setNrowFiltered] = useState<number | undefined>(restored?.nrowFiltered);
    const [histograms, setHistograms] = useState<Record<number, HistogramBin[]>>(restored?.histograms ?? {});
    const [filterEditor, setFilterEditor] = useState<{ entry?: FilterEntry; columnIndex?: number } | null>(null);

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
    const rowCountText = describeVisibleRows(nrow, visibleRange);
    /** Summary text appended to the status bar when a sort is active.
     *  Truncates to 4 keys with an ellipsis so the bar never wraps; the
     *  toolbar chip strip is the full picture. */
    const sortStatusText = useMemo(() => {
        if (sort.keys.length === 0) return '';
        const MAX = 4;
        const visible = sort.keys.slice(0, MAX).map(k => {
            const col = columns[k.columnIndex];
            const name = col?.name ?? `col ${k.columnIndex}`;
            return `${name} ${k.direction === 'asc' ? '▲' : '▼'}`;
        }).join(', ');
        return sort.keys.length > MAX
            ? `sorted by ${visible}, +${sort.keys.length - MAX} more`
            : `sorted by ${visible}`;
    }, [columns, sort]);
    const statusText = [
        describeShape(nrow, columns, objectClass),
        describeHiddenColumnCount(layout.hiddenColumns.length),
        sortPending ? 'Sorting…' : sortStatusText,
    ].filter(Boolean).join(' | ');

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
            objectClass,
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
        objectClass,
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
        if (nrow <= 0 || visibleCols.length === 0) return null;
        return { row: Math.min(nrow - 1, visibleRange.start), col: visibleCols[0] };
    }, [gridSelection, nrow, visibleCols, visibleRange.start]);

    const postLifecycle = useCallback((event: string, range: VisibleRange = visibleRange, selection = gridSelection) => {
        vscode.postMessage({
            type: 'lifecycle',
            event,
            panelGeneration,
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
        if (range.end <= range.start || visibleCols.length === 0) return;
        if (rowCacheRef.current.hasRange(range.start, range.end)) return;
        const columnsKey = visibleCols.join(',');
        const key = `${range.start}:${range.end}:${columnsKey}`;
        if (pendingKeysRef.current.has(key)) return;

        viewportGenerationRef.current += 1;
        const requestId = ++nextRequestIdRef.current;
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
    }, [panelGeneration, visibleCols, vscode]);

    const scheduleMissingRowRequest = useCallback((row: number) => {
        if (nrow <= 0 || visibleCols.length === 0) return;
        const clamped = Math.max(0, Math.min(nrow - 1, row));
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
            requestRows(paddedRange(range.start, range.end - range.start, nrow, OVERSCAN_ROWS));
        }, 0);
    }, [nrow, requestRows, visibleCols.length]);

    useEffect(() => () => {
        if (missingRowRequestTimerRef.current !== null) {
            window.clearTimeout(missingRowRequestTimerRef.current);
        }
    }, []);

    const applyInitOrReplace = useCallback((m: Extract<ExtensionToWebview, { type: 'init' | 'replace' }>) => {
        const sameDataset = m.panelGeneration === panelGeneration
            && m.nrow === nrow
            && sameColumns(m.columns, columns);
        setPanelGeneration(m.panelGeneration);
        setNrow(m.nrow);
        setColumns(m.columns);
        setLayout(m.layout);
        setDictionaries(m.dictionaries);
        setSchemaHash(m.schemaHash);
        setObjectClass(m.objectClass);
        if (m.type === 'init') setSettings(m.settings);
        setToolbar(m.toolbar);
        setSort(m.sort);
        setSortPending(false);
        setFilter(m.filter);
        setHistograms(m.histograms ?? {});
        setFilterPending(false);
        if (m.filter.entries.length === 0) setNrowFiltered(undefined);
        toolbarBootstrappedRef.current = true;
        clearRows();
        setResolvedLabels({});
        setGridSelection(createEmptySelection());
        if (!sameDataset) setVisibleRange({ start: 0, end: 0 });
        postLifecycle(m.type, sameDataset ? visibleRange : { start: 0, end: 0 }, createEmptySelection());
        window.setTimeout(() => gridRef.current?.scrollTo(0, 0, 'both'), 0);
    }, [clearRows, columns, nrow, panelGeneration, postLifecycle, visibleRange]);

    const applyRows = useCallback((m: Extract<ExtensionToWebview, { type: 'rows' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
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
    }, [panelGeneration, postLifecycle, visibleCols.length]);

    const applyLabels = useCallback((m: Extract<ExtensionToWebview, { type: 'labels' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
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
    }, [panelGeneration, visibleCols, visibleRange.end, visibleRange.start]);

    const applySortApplied = useCallback((m: Extract<ExtensionToWebview, { type: 'sortApplied' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
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
        if (nrow > 0 && visibleCols.length > 0) {
            requestRows(paddedRange(
                visibleRange.start,
                Math.max(1, visibleRange.end - visibleRange.start),
                nrow,
                OVERSCAN_ROWS,
            ));
        }
        // Persist the latest sort. Cleared (empty keys) saves are also
        // valid — the host treats an empty SortState as a clear.
        if (schemaHash) {
            vscode.postMessage({
                type: 'saveSort',
                panelGeneration: m.panelGeneration,
                schemaHash,
                sort: m.sort,
            });
        }
    }, [
        clearRows,
        nrow,
        panelGeneration,
        requestRows,
        schemaHash,
        visibleCols.length,
        visibleRange,
        vscode,
    ]);

    const applySortStatus = useCallback((m: Extract<ExtensionToWebview, { type: 'sortStatus' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
        setSortPending(m.state === 'pending');
    }, [panelGeneration]);

    const applyFilterApplied = useCallback((m: Extract<ExtensionToWebview, { type: 'filterApplied' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
        setFilter(m.filter);
        setNrowFiltered(m.filter.entries.some(e => e.enabled) ? m.nrowFiltered : undefined);
        setFilterPending(false);
    }, [panelGeneration]);

    const applyFilterStatus = useCallback((m: Extract<ExtensionToWebview, { type: 'filterStatus' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
        setFilterPending(m.state === 'pending');
    }, [panelGeneration]);

    /** Send a setFilters request. Empty `entries` clears the filter. The host
     *  replies with `filterApplied` which drives state updates. */
    const applyFilters = useCallback((entries: FilterEntry[]) => {
        setFilterPending(entries.some(e => e.enabled));
        const requestId = ++nextRequestIdRef.current;
        vscode.postMessage({
            type: 'setFilters',
            panelGeneration,
            requestId,
            entries,
            labelsOn: toolbar.labelsOn,
        });
    }, [panelGeneration, toolbar.labelsOn, vscode]);

    const onEditFilter = useCallback((entry: FilterEntry) => {
        setFilterEditor({ entry });
    }, []);

    const onToggleFilterEnabled = useCallback((id: string) => {
        applyFilters(filter.entries.map(e => e.id === id ? { ...e, enabled: !e.enabled } : e));
    }, [applyFilters, filter.entries]);

    const onRemoveFilter = useCallback((id: string) => {
        applyFilters(filter.entries.filter(e => e.id !== id));
    }, [applyFilters, filter.entries]);

    const onClearAllFilters = useCallback(() => {
        applyFilters([]);
    }, [applyFilters]);

    /** Send a setSort request. Empty `keys` clears the sort. The host
     *  replies with `sortApplied` which drives state updates. */
    const applySort = useCallback((keys: SortKey[]) => {
        setSortPending(true);
        const requestId = ++nextRequestIdRef.current;
        vscode.postMessage({
            type: 'setSort',
            panelGeneration,
            requestId,
            keys,
            labelsOn: toolbar.labelsOn,
            formatOn: toolbar.formatOn,
            digits: toolbar.digits,
        });
    }, [panelGeneration, toolbar, vscode]);

    /** Pick a direction for `sourceIndex`. When `append` is true, merge
     *  into the existing sort (flipping the column's direction in place
     *  if already present). Otherwise this column becomes the only sort
     *  key. */
    const sortColumn = useCallback((
        sourceIndex: number,
        direction: 'asc' | 'desc',
        append: boolean,
    ) => {
        const existing = sort.keys.findIndex(k => k.columnIndex === sourceIndex);
        let next: SortKey[];
        if (!append) {
            // Plain pick: this column becomes the sort. If user picks the
            // same column/direction that's already active, no-op.
            if (existing >= 0
                && sort.keys.length === 1
                && sort.keys[0].direction === direction) {
                return;
            }
            next = [{ columnIndex: sourceIndex, direction }];
        } else if (existing >= 0) {
            // Shift+pick on an existing key: flip direction in place,
            // priority preserved.
            if (sort.keys[existing].direction === direction) return;
            next = sort.keys.map((k, i) =>
                i === existing ? { ...k, direction } : k);
        } else {
            // Shift+pick on a new column: append at the end.
            next = [...sort.keys, { columnIndex: sourceIndex, direction }];
        }
        applySort(next);
    }, [applySort, sort.keys]);

    const clearSortOnColumn = useCallback((sourceIndex: number) => {
        const next = sort.keys.filter(k => k.columnIndex !== sourceIndex);
        if (next.length === sort.keys.length) return;
        applySort(next);
    }, [applySort, sort.keys]);

    const clearAllSorts = useCallback(() => {
        if (sort.keys.length === 0) return;
        applySort([]);
    }, [applySort, sort.keys.length]);

    const applyCopyDone = useCallback((m: Extract<ExtensionToWebview, { type: 'copyDone' }>) => {
        if (m.panelGeneration !== panelGeneration) return;
        setCopyStatus(m.ok ? 'copied' : 'error');
        setCopyStatusMsg(m.ok ? 'Copied' : (m.error ?? 'Copy failed'));
        window.setTimeout(() => {
            setCopyStatus('');
            setCopyStatusMsg('');
        }, 2500);
    }, [panelGeneration]);

    const estimatedViewportRowCount = useCallback((): number => {
        const current = visibleRange.end - visibleRange.start;
        if (current > 0) return current;
        const shell = document.querySelector('.grid-shell');
        const height = shell instanceof HTMLElement ? shell.clientHeight : 0;
        return Math.max(1, Math.floor((height - HEADER_HEIGHT_PX) / ROW_HEIGHT_PX) || 20);
    }, [visibleRange.end, visibleRange.start]);

    const viewportForStart = useCallback((start: number): VisibleRange => {
        const height = estimatedViewportRowCount();
        const clampedStart = Math.max(0, Math.min(start, Math.max(0, nrow - height)));
        return {
            start: clampedStart,
            end: Math.min(nrow, clampedStart + height),
        };
    }, [estimatedViewportRowCount, nrow]);

    const scrollToViewport = useCallback((
        viewport: VisibleRange,
        event: string,
        selection: GridSelection = gridSelection,
    ) => {
        setVisibleRange(viewport);
        requestRows(paddedRange(viewport.start, viewport.end - viewport.start, nrow, OVERSCAN_ROWS));
        postLifecycle(event, viewport, selection);
    }, [gridSelection, nrow, postLifecycle, requestRows]);

    useEffect(() => {
        if (nrow <= 0 || visibleCols.length === 0) return;
        const hasViewport = visibleRange.end > visibleRange.start;
        const viewport = hasViewport
            ? visibleRange
            : {
                start: 0,
                end: Math.min(nrow, estimatedViewportRowCount()),
            };
        const timeout = window.setTimeout(() => {
            if (!hasViewport) {
                setVisibleRange(viewport);
                postLifecycle('initial-visible', viewport);
            }
            requestRows(paddedRange(
                viewport.start,
                viewport.end - viewport.start,
                nrow,
                OVERSCAN_ROWS,
            ));
        }, 0);
        return () => window.clearTimeout(timeout);
    }, [
        estimatedViewportRowCount,
        nrow,
        postLifecycle,
        requestRows,
        visibleCols.length,
        visibleRange,
    ]);

    const scrollToFraction = useCallback((fraction: number) => {
        const clamped = Math.max(0, Math.min(1, fraction));
        const height = estimatedViewportRowCount();
        const start = nrow <= 0 ? 0 : Math.round(Math.max(0, nrow - height) * clamped);
        const targetRow = clamped >= 1 ? Math.max(0, nrow - 1) : start;
        gridRef.current?.scrollTo(0, targetRow, 'vertical', 0, 0, {
            vAlign: clamped >= 1 ? 'end' : clamped <= 0 ? 'start' : 'center',
        });
        scrollToViewport(viewportForStart(start), 'test-scroll');
    }, [estimatedViewportRowCount, nrow, scrollToViewport, viewportForStart]);

    const handleTestKey = useCallback((key: string) => {
        if (key === 'End') {
            const displayCol = Math.max(0, Math.min(
                visibleCols.length - 1,
                gridSelection.current?.cell[0] ?? 0,
            ));
            const row = Math.max(0, nrow - 1);
            const next = createCellSelection(displayCol, row);
            setGridSelection(next);
            scrollToFraction(1);
            postLifecycle('test-key', viewportForStart(Math.max(0, nrow - estimatedViewportRowCount())), next);
            return;
        }
        if (key === 'Home') {
            const next = createCellSelection(0, 0);
            setGridSelection(next);
            scrollToFraction(0);
            postLifecycle('test-key', viewportForStart(0), next);
            return;
        }
        if (nrow <= 0 || visibleCols.length === 0) return;
        const current = gridSelection.current?.cell ?? [0, Math.max(0, visibleRange.start)];
        let col = current[0];
        let row = current[1];
        if (key === 'ArrowDown') row += 1;
        else if (key === 'ArrowUp') row -= 1;
        else if (key === 'ArrowRight') col += 1;
        else if (key === 'ArrowLeft') col -= 1;
        else return;
        col = Math.max(0, Math.min(visibleCols.length - 1, col));
        row = Math.max(0, Math.min(nrow - 1, row));
        const next = createCellSelection(col, row);
        setGridSelection(next);
        gridRef.current?.focus();
        gridRef.current?.scrollTo(col, row, 'both');
        let viewport = visibleRange;
        if (row < visibleRange.start || row >= visibleRange.end) {
            viewport = viewportForStart(row);
            setVisibleRange(viewport);
            requestRows(paddedRange(viewport.start, viewport.end - viewport.start, nrow, OVERSCAN_ROWS));
        }
        postLifecycle('test-key', viewport, next);
    }, [
        estimatedViewportRowCount,
        gridSelection,
        nrow,
        postLifecycle,
        requestRows,
        scrollToFraction,
        viewportForStart,
        visibleCols.length,
        visibleRange,
    ]);

    useEffect(() => {
        vscode.postMessage({ type: 'webviewReady' });
    }, [vscode]);

    useEffect(() => {
        const onMessage = (event: MessageEvent<ExtensionToWebview>) => {
            const m = event.data;
            if (!m || typeof m !== 'object') return;
            if ('panelGeneration' in m && m.panelGeneration < panelGeneration) return;
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

    useEffect(() => {
        if (!toolbarBootstrappedRef.current || !schemaHash) return;
        vscode.postMessage({
            type: 'saveToolbar',
            panelGeneration,
            schemaHash,
            toolbar,
        });
    }, [panelGeneration, schemaHash, toolbar, vscode]);

    useEffect(() => {
        // Guard on the same bootstrap flag as saveToolbar: until the first
        // init/replace lands, `filter` is still the (possibly empty) seed,
        // and saving it would clobber a host-persisted filter before the
        // restore round-trip completes.
        if (!toolbarBootstrappedRef.current || !schemaHash) return;
        const id = window.setTimeout(() => {
            vscode.postMessage({
                type: 'saveFilter',
                panelGeneration,
                schemaHash,
                filter,
            });
        }, 300);
        return () => window.clearTimeout(id);
    }, [filter, panelGeneration, schemaHash, vscode]);

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
            const requestId = ++nextRequestIdRef.current;
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
        if (nrow <= 0 || visibleCols.length === 0) return;
        let rowStart = 0;
        let rowEnd = 0;
        let colIndices: number[] = [];
        let includeHeader = false;

        if (selection.columns.length > 0) {
            rowStart = 0;
            rowEnd = nrow;
            colIndices = selection.columns.toArray()
                .map(displayCol => visibleCols[displayCol])
                .filter((col): col is number => col !== undefined);
            includeHeader = true;
        } else if (selection.rows.length > 0) {
            const rows = selection.rows.toArray();
            rowStart = Math.max(0, Math.min(...rows));
            rowEnd = Math.min(nrow, Math.max(...rows) + 1);
            colIndices = [...visibleCols];
        } else if (selection.current) {
            const range = selection.current.range;
            rowStart = Math.max(0, range.y);
            rowEnd = Math.min(nrow, range.y + range.height);
            for (let displayCol = range.x; displayCol < range.x + range.width; displayCol++) {
                const col = visibleCols[displayCol];
                if (col !== undefined) colIndices.push(col);
            }
        }

        if (rowEnd <= rowStart || colIndices.length === 0) return;
        const requestId = ++nextRequestIdRef.current;
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
    }, [gridSelection, nrow, panelGeneration, toolbar, visibleCols, vscode]);

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
        copySelection,
        gridSelection,
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
            <div className="toolbar">
                <span className="row-count">{rowCountText}</span>
                <ToolbarSortStrip
                    sort={sort}
                    columns={columns}
                    onChange={applySort}
                    onClearAll={clearAllSorts}
                />
                <FilterStrip
                    filter={filter}
                    columns={columns}
                    onEdit={onEditFilter}
                    onToggleEnabled={onToggleFilterEnabled}
                    onRemove={onRemoveFilter}
                    onClearAll={onClearAllFilters}
                />
                <button
                    type="button"
                    className={toolbar.labelsOn ? 'toggle active' : 'toggle'}
                    disabled={!labelsHaveEffect}
                    onClick={() => setToolbar(t => ({ ...t, labelsOn: !t.labelsOn }))}
                >
                    Labels
                </button>
                <button
                    type="button"
                    className={toolbar.formatOn ? 'toggle active' : 'toggle'}
                    disabled={!formatHasEffect}
                    onClick={() => setToolbar(t => ({ ...t, formatOn: !t.formatOn }))}
                >
                    Format
                </button>
                <select
                    className="digits"
                    value={toolbar.digits}
                    disabled={!toolbar.formatOn || !formatHasEffect}
                    onChange={event => setToolbar(t => ({ ...t, digits: Number(event.target.value) }))}
                    aria-label="Digits"
                >
                    {[0, 1, 2, 3, 4, 5, 6].map(d => (
                        <option key={d} value={d}>{d}</option>
                    ))}
                </select>
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
            <div className="grid-shell" ref={gridShellRef}>
                <DataEditor
                    ref={gridRef}
                    theme={vscodeTheme}
                    width="100%"
                    height="100%"
                    columns={gridColumns}
                    rows={nrow}
                    rowHeight={ROW_HEIGHT_PX}
                    headerHeight={HEADER_HEIGHT_PX}
                    rowMarkers={{ kind: 'number', width: rowMarkerWidth(nrow) }}
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
                            end: Math.min(nrow, Math.ceil(range.y + range.height)),
                        };
                        setVisibleRange(viewport);
                        requestRows(paddedRange(range.y, range.height, nrow, OVERSCAN_ROWS));
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
                    />
                )}
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
            <div className="status-bar">{statusText}</div>
        </div>
    );
}
