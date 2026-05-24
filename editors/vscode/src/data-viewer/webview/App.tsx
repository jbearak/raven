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
import type {
    ExtensionToWebview,
    Layout,
    Settings,
    WebviewToExtension,
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
};

type ContextMenuState = {
    leftPx: number;
    topPx: number;
    columnIndex?: number;
};

type HeaderTooltipState = {
    text: string;
    leftPx: number;
    topPx: number;
};

const EMPTY_LAYOUT: Layout = { columnWidths: {}, hiddenColumns: [] };
const EMPTY_TOOLBAR: ToolbarState = { labelsOn: true, formatOn: true, digits: 3 };
const DEFAULT_SETTINGS: Settings = { missingValueStyle: 'foreground', defaultDigits: 3 };

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

    const visibleCols = useMemo(
        () => visibleColumnIndices(columns, layout.hiddenColumns),
        [columns, layout.hiddenColumns],
    );
    const allGridColumns = useMemo(() => buildGridColumns(columns, layout), [columns, layout]);
    const gridColumns = useMemo(
        () => buildVisibleGridColumns(allGridColumns, visibleCols),
        [allGridColumns, visibleCols],
    );
    const labelsHaveEffect = hasLabelsEffect(columns);
    const formatHasEffect = hasFormatEffect(columns);
    const rowCountText = describeVisibleRows(nrow, visibleRange);
    const statusText = [
        describeShape(nrow, columns, objectClass),
        describeHiddenColumnCount(layout.hiddenColumns.length),
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
        applyInitOrReplace,
        applyLabels,
        applyRows,
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
    }, [copySelection, postLifecycle, visibleCols.length, visibleRange]);

    const drawHeader: DrawHeaderCallback = useCallback(({ ctx, column, theme, rect, isSelected, hasSelectedCell }, drawContent) => {
        const col = column as typeof gridColumns[number];
        if (!col.variableLabel) {
            drawContent();
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
    }, [gridColumns]);

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
        setHeaderTooltip({
            text: `${col.name}: ${label}`,
            leftPx: args.bounds.x + args.localEventX,
            topPx: args.bounds.y + args.localEventY + 16,
        });
    }, [columns, visibleCols]);

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
                        const next = createColumnSelection(colIndex);
                        setGridSelection(next);
                        postLifecycle('header-click', visibleRange, next);
                    }}
                    onHeaderContextMenu={(colIndex, event) => {
                        event.preventDefault();
                        const next = createColumnSelection(colIndex);
                        setGridSelection(next);
                        setContextMenu({
                            leftPx: event.bounds.x + event.localEventX,
                            topPx: event.bounds.y + event.localEventY,
                            columnIndex: visibleCols[colIndex],
                        });
                    }}
                    onCellContextMenu={(_cell, event) => {
                        event.preventDefault();
                        setContextMenu({
                            leftPx: event.bounds.x + event.localEventX,
                            topPx: event.bounds.y + event.localEventY,
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
