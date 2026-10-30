/**
 * The single mapping between Glide's display column index and the source
 * (schema) column index.
 *
 * Display column 0 is the synthetic **gutter**, a webview-only column
 * showing R row numbers; it has no source index and never reaches the
 * host. Display columns 1.. are the non-hidden source columns: rowname
 * columns first, then pinned columns in pin order (both frozen with the
 * gutter), then the rest in schema order. Unpinning a column returns it
 * to its schema position. Row windows
 * fetched from the host hold cells in `dataCols` order, so a display
 * column's cell is at position `display − 1` of a cached row.
 *
 * Every consumer that turns a Glide column index into something about
 * the data — cell content, selection, resize, sort and filter targets,
 * hidden columns, keyboard shortcuts on the focused column, the context
 * menu, copy, and ARIA — goes through this module, so the gutter offset
 * lives in one place.
 */

import type { ColumnSchema } from '../arrow-reader';

/** Display index of the gutter. */
export const GUTTER_DISPLAY_INDEX = 0;

export type DisplayColumns = {
    /** Source indices in display order (display index = position + 1). */
    readonly dataCols: readonly number[];
    /** Leading display columns Glide freezes: the gutter, the visible
     *  rowname columns, and the visible pinned columns. */
    readonly freezeColumns: number;
    /** Total display columns, gutter included. */
    readonly count: number;
    /** Source index → display index, for visible columns. */
    readonly displayBySource: ReadonlyMap<number, number>;
    /** Source indices of visible rowname columns. */
    readonly rownameCols: readonly number[];
    /** Source indices of visible pinned columns, in pin order. */
    readonly pinnedCols: readonly number[];
    /** Source indices of every rowname column, hidden ones included:
     *  "Copy with row names" copies the frame's names even when the
     *  column is hidden. */
    readonly allRownameCols: readonly number[];
};

export function buildDisplayColumns(
    columns: readonly ColumnSchema[],
    hiddenColumns: readonly number[],
    pinnedColumns: readonly number[] = [],
): DisplayColumns {
    const hidden = new Set(hiddenColumns);
    const pinnedCols = [...new Set(pinnedColumns)].filter(i =>
        columns[i] !== undefined && !columns[i].isRowname && !hidden.has(i));
    const pinned = new Set(pinnedCols);
    const rownameCols: number[] = [];
    const allRownameCols: number[] = [];
    const rest: number[] = [];
    for (let i = 0; i < columns.length; i++) {
        if (columns[i].isRowname) allRownameCols.push(i);
        if (hidden.has(i) || pinned.has(i)) continue;
        (columns[i].isRowname ? rownameCols : rest).push(i);
    }
    const dataCols = [...rownameCols, ...pinnedCols, ...rest];
    const displayBySource = new Map<number, number>();
    dataCols.forEach((src, pos) => displayBySource.set(src, pos + 1));
    return {
        dataCols,
        freezeColumns: 1 + rownameCols.length + pinnedCols.length,
        count: dataCols.length + 1,
        displayBySource,
        rownameCols,
        pinnedCols,
        allRownameCols,
    };
}

/** True when source column `source` is pinned (hidden pins included). */
export function isPinned(pinnedColumns: readonly number[] | undefined, source: number): boolean {
    return pinnedColumns?.includes(source) ?? false;
}

/** `pinnedColumns` with `source` pinned last, or unpinned. */
export function togglePinned(pinnedColumns: readonly number[] | undefined, source: number): number[] {
    const pins = [...(pinnedColumns ?? [])];
    const at = pins.indexOf(source);
    if (at >= 0) pins.splice(at, 1);
    else pins.push(source);
    return pins;
}

/** Whether a frozen region of `frozenWidths` (gutter, rowname and pinned
 *  column widths) fits in half of a `viewportPx`-wide grid. An unknown
 *  viewport (0) always fits. */
export function frozenFits(frozenWidths: readonly number[], viewportPx: number): boolean {
    if (viewportPx <= 0) return true;
    return frozenWidths.reduce((a, b) => a + b, 0) <= viewportPx * 0.5;
}

export function isGutter(displayIndex: number): boolean {
    return displayIndex === GUTTER_DISPLAY_INDEX;
}

/** Source index shown at `displayIndex`; undefined for the gutter or an
 *  index out of range. */
export function sourceAt(dc: DisplayColumns, displayIndex: number): number | undefined {
    if (displayIndex <= GUTTER_DISPLAY_INDEX) return undefined;
    return dc.dataCols[displayIndex - 1];
}

/** Position of `displayIndex`'s cell within a cached row; -1 for the
 *  gutter. */
export function rowPosition(displayIndex: number): number {
    return displayIndex - 1;
}

/** Display index of a source column, or -1 when hidden/out of range. */
export function displayIndexOf(dc: DisplayColumns, source: number): number {
    return dc.displayBySource.get(source) ?? -1;
}

/** First display index that holds data (1), or -1 when every column is
 *  hidden. */
export function firstDataDisplayIndex(dc: DisplayColumns): number {
    return dc.dataCols.length > 0 ? 1 : -1;
}

/** Clamp a display index into the data range (never the gutter). */
export function clampToData(dc: DisplayColumns, displayIndex: number): number {
    return Math.max(1, Math.min(dc.count - 1, displayIndex));
}

/**
 * Source columns to copy for a set of selected display indices, in
 * display order. The gutter is never copied; rowname columns only when
 * `withRowNames` is set (and then always, first, even if not selected or
 * hidden).
 */
export function copyColumns(
    dc: DisplayColumns,
    displayIndices: Iterable<number>,
    withRowNames: boolean,
): number[] {
    const rownames = new Set(dc.allRownameCols);
    const picked = new Set<number>();
    for (const d of displayIndices) {
        const src = sourceAt(dc, d);
        if (src !== undefined && !rownames.has(src)) picked.add(src);
    }
    const ordered = dc.dataCols.filter(src => picked.has(src));
    return withRowNames ? [...dc.allRownameCols, ...ordered] : ordered;
}

/** Every copyable data column (row selections copy whole rows). */
export function allCopyColumns(dc: DisplayColumns, withRowNames: boolean): number[] {
    return copyColumns(dc, dc.dataCols.map((_, i) => i + 1), withRowNames);
}

/**
 * The 1-based R row number for display row `row`: the original row index
 * from the host's permutation when a sort or filter is active, else the
 * display position.
 */
export function rRowNumber(row: number, originalRowIndex: number | undefined): number {
    return (originalRowIndex ?? row) + 1;
}
