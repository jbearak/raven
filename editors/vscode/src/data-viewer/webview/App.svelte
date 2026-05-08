<script lang="ts">
    import { onMount } from 'svelte';
    import type {
        ExtensionToWebview,
        Layout,
        Settings,
        WebviewToExtension,
    } from '../messages';
    import type { Cell } from '../wire-format';
    import type { ColumnSchema } from '../arrow-reader';
    import { visibleRange, coalesceScroll } from './grid-model';
    import { RowCache } from './row-cache';
    import { Selection } from './selection-model';
    import { formatCell } from './cell-render';
    import Toolbar from './Toolbar.svelte';

    interface Props {
        vscode: { postMessage(msg: WebviewToExtension): void };
    }
    let { vscode }: Props = $props();

    // ----- Panel state -----------------------------------------------------
    let panelGeneration = $state(0);
    let nrow = $state(0);
    let columns = $state<ColumnSchema[]>([]);
    let dictionaries = $state<Record<number, string[]>>({});
    let layout = $state<Layout>({ columnWidths: {}, hiddenColumns: [] });
    let settings = $state<Settings>({
        missingValueStyle: 'foreground', defaultDigits: 3,
    });

    // ----- Toolbar state ---------------------------------------------------
    let labelsOn = $state(false);
    let formatOn = $state(false);
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

    // ----- Derived ---------------------------------------------------------
    const hiddenSet = $derived(new Set(layout.hiddenColumns));
    const visibleCols = $derived<number[]>(
        columns
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !hiddenSet.has(c.name))
            .map(({ i }) => i),
    );
    const totalGridHeight = $derived(nrow * ROW_HEIGHT);

    // ----- Selection -------------------------------------------------------
    const selection = new Selection();
    let selectionVersion = $state(0);  // force re-render when selection changes
    let copyStatus = $state<'' | 'copying' | 'copied' | 'error'>('');
    let copyStatusMsg = $state<string>('');
    let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;
    function bumpSelection() { selectionVersion++; }

    // ----- Pending getLabels for high-cardinality columns -----------------
    /** Per-column resolved label cache (for Labels=on on high-cardinality
     *  dictionary cols where dictionaries[colIdx] isn't shipped). */
    let resolvedLabels = $state<Record<number, Record<number, string>>>({});

    // ----- Message handling -----------------------------------------------
    onMount(() => {
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
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    });

    function applyInitOrReplace(
        m: Extract<ExtensionToWebview, { type: 'init' | 'replace' }>,
    ): void {
        panelGeneration = m.panelGeneration;
        nrow = m.nrow;
        columns = m.columns;
        layout = m.layout;
        dictionaries = m.dictionaries;
        if (m.type === 'init' && 'settings' in m) {
            settings = m.settings;
            digits = m.settings.defaultDigits;
        }
        rowCache.clear();
        resolvedLabels = {};
        visibleRows = [];
        visibleRangeStart = 0;
        selection.clear();
        bumpSelection();
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
            scrollTop, viewportHeight, rowHeight: ROW_HEIGHT, nrow, overscan: 8,
        });
        if (range.start === m.start && range.end === m.end) {
            visibleRows = m.rows;
            visibleRangeStart = m.start;
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
            scrollTop, viewportHeight, rowHeight: ROW_HEIGHT, nrow, overscan: 8,
        });
        if (range.end <= range.start) {
            visibleRows = [];
            visibleRangeStart = range.start;
            return;
        }
        const cached = rowCache.get(range.start, range.end);
        if (cached) {
            visibleRows = cached;
            visibleRangeStart = range.start;
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
    function onCellPointerDown(row: number, col: number, e: PointerEvent): void {
        if (e.shiftKey) selection.focus(row, col);
        else selection.anchor(row, col);
        bumpSelection();
    }

    function onCellPointerEnter(row: number, col: number, e: PointerEvent): void {
        if ((e.buttons & 1) !== 1) return;
        selection.focus(row, col);
        bumpSelection();
    }

    function onKeyDown(e: KeyboardEvent): void {
        const meta = e.metaKey || e.ctrlKey;
        if (meta && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            selection.selectAll(nrow, visibleCols);
            bumpSelection();
            return;
        }
        if (meta && (e.key === 'c' || e.key === 'C')) {
            const r = selection.rect();
            if (!r) return;
            e.preventDefault();
            const colIndices = selection.colIndices()
                ?? rangeFilter(r.colStart, r.colEnd, visibleCols);
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
            };
            copyStatus = 'copying';
            copyStatusMsg = 'Copying...';
            vscode.postMessage(msg);
        }
    }

    // ----- Layout persistence --------------------------------------------
    let saveLayoutTimer: ReturnType<typeof setTimeout> | null = null;
    function persistLayout(): void {
        if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
        saveLayoutTimer = setTimeout(() => {
            const msg: WebviewToExtension = {
                type: 'saveLayout',
                panelGeneration,
                layout,
            };
            vscode.postMessage(msg);
        }, 250);
    }

    function onResizeColumn(name: string, width: number): void {
        layout = {
            ...layout,
            columnWidths: { ...layout.columnWidths, [name]: width },
        };
        persistLayout();
    }

    function onToggleColumn(name: string, hidden: boolean): void {
        const set = new Set(layout.hiddenColumns);
        if (hidden) set.add(name); else set.delete(name);
        layout = { ...layout, hiddenColumns: Array.from(set) };
        persistLayout();
        scheduleFetchVisible();
    }

    function widthOf(c: ColumnSchema): number {
        return layout.columnWidths[c.name] ?? 120;
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
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="data-viewer">
    <Toolbar
        bind:labelsOn
        bind:formatOn
        bind:digits
        nrow={nrow}
        columns={columns}
        layout={layout}
        onToggleColumn={onToggleColumn}
    />
    {#if copyStatus !== ''}
        <div class="toast toast-{copyStatus}">{copyStatusMsg}</div>
    {/if}
    <div class="viewport"
         bind:this={viewportEl}
         onscroll={onScroll}
         tabindex="0">
        <div class="grid" style="height: {totalGridHeight + ROW_HEIGHT}px;">
            <!-- Header row (sticky top) -->
            <div class="header-row">
                <div class="cell header rowname-col">#</div>
                {#each visibleCols as colIdx (colIdx)}
                    {@const col = columns[colIdx]}
                    <div class="cell header"
                         style="width: {widthOf(col)}px;"
                         title={col.variableLabel ? `${col.name}: ${col.variableLabel}` : col.name}
                    >
                        {col.name}
                    </div>
                {/each}
            </div>
            <!-- Data rows -->
            <div class="rows" style="transform: translateY({visibleRangeStart * ROW_HEIGHT}px);">
                {#each visibleRows as rowCells, rowOffset (visibleRangeStart + rowOffset)}
                    {@const absRow = visibleRangeStart + rowOffset}
                    <div class="data-row" style="height: {ROW_HEIGHT}px;">
                        <div class="cell rowname-col">{absRow + 1}</div>
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
                                 style="width: {widthOf(col)}px;"
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
</div>

<style>
    /* Base layout — most styling lives in styles.css for theme-awareness. */
    :global(html, body, #root, body > div) {
        width: 100%;
        height: 100%;
        margin: 0;
    }
</style>
