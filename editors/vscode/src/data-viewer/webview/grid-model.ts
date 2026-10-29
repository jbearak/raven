import type { SizedGridColumn } from '@glideapps/glide-data-grid';
import type { ColumnSchema } from '../arrow-reader';
import type { Layout } from '../messages';

export const ROW_HEIGHT_PX = 24;
export const HEADER_HEIGHT_PX = 40;
export const OVERSCAN_ROWS = 8;
/** Bounds for a user's drag (and any persisted width). */
export const MIN_COLUMN_WIDTH_PX = 40;
export const MAX_COLUMN_WIDTH_PX = 3200;
/** Bounds for measured default and auto-fit widths. */
export const MIN_AUTO_WIDTH_PX = 60;
export const MAX_AUTO_WIDTH_PX = 400;
/** Above this many columns, default widths come from the type, not from
 *  measuring names and values (RStudio's budget). */
export const MEASURE_COLUMN_LIMIT = 200;
/** Loaded values sampled per column for the measured default width. */
export const MEASURE_SAMPLE_ROWS = 200;
/** Slack added to measured text so glyphs don't touch the border. */
export const MEASURE_PADDING_PX = 20;

const DEFAULT_COLUMN_WIDTH_PX = 120;

export type DataViewerGridColumn = SizedGridColumn & {
    sourceIndex: number;
    variableLabel?: string;
};

export type VisibleRange = {
    start: number;
    end: number;
};

/** Clamp a user-dragged or persisted width to 40–3200 px. */
export function clampColumnWidth(width: number | undefined): number {
    if (width === undefined || !Number.isFinite(width)) {
        return DEFAULT_COLUMN_WIDTH_PX;
    }
    return Math.max(
        MIN_COLUMN_WIDTH_PX,
        Math.min(MAX_COLUMN_WIDTH_PX, Math.round(width)),
    );
}

/** Clamp a measured width to 60–400 px. */
export function clampAutoWidth(width: number): number {
    if (!Number.isFinite(width)) return DEFAULT_COLUMN_WIDTH_PX;
    return Math.max(MIN_AUTO_WIDTH_PX, Math.min(MAX_AUTO_WIDTH_PX, Math.round(width)));
}

/** Width for a column we don't measure (frames wider than
 *  `MEASURE_COLUMN_LIMIT`), by type tag. */
export function typeDefaultWidth(col: ColumnSchema): number {
    const tag = col.typeTag ?? '';
    if (tag.startsWith('<dttm')) return 180;
    if (tag === '<lgl>') return 70;
    if (tag === '<int>') return 80;
    if (tag === '<date>') return 100;
    if (tag === '<chr>' || tag.endsWith('+lbl>')) return 160;
    if (tag === '<fct>' || tag === '<ord>') return 130;
    if (col.isInteger) return 80;
    if (col.arrowType.startsWith('Float')) return 100;
    return DEFAULT_COLUMN_WIDTH_PX;
}

/** A width measurer for header and cell text in a given font. */
export type TextMeasure = {
    /** Width of `text` in the header name font (600 weight). */
    name(text: string): number;
    /** Width of `text` in the header type-tag font. */
    tag(text: string): number;
    /** Width of `text` in the header label font. */
    label(text: string): number;
    /** Width of `text` in the cell font. */
    cell(text: string): number;
};

/**
 * Measured default width: the widest of the name (plus the reserved sort
 * slot), type tag, label, and the sampled loaded values, clamped to
 * 60–400 px (table-viewer's `fit-column-model.ts` rule).
 */
export function measuredColumnWidth(
    name: string,
    tag: string,
    label: string | undefined,
    values: Iterable<string>,
    measure: TextMeasure,
    sortSlotPx: number,
): number {
    let max = Math.max(
        measure.name(name) + sortSlotPx,
        measure.tag(tag),
        label ? measure.label(label) : 0,
    );
    for (const v of values) {
        const w = measure.cell(v);
        if (w > max) max = w;
    }
    return clampAutoWidth(max + MEASURE_PADDING_PX);
}

/** Back-compat estimate from string lengths, used when no canvas is
 *  available to measure with. */
export function computeDefaultColumnWidth(col: ColumnSchema): number {
    const titleWidth = col.name.length * 7 + 18;
    const labelWidth = (col.variableLabel ?? '').length * 6;
    const typeWidth = (col.typeTag ?? '').length * 6;
    return clampAutoWidth(Math.max(titleWidth, labelWidth, typeWidth) + MEASURE_PADDING_PX);
}

/** Width of the R-row-number gutter: room for the largest row number
 *  (or the `shown / total` header while filtered). */
export function gutterWidth(nrow: number, measure: (text: string) => number, headerText = ''): number {
    const digits = Math.max(1, nrow).toLocaleString('en-US').replace(/\d/g, '8');
    return Math.ceil(Math.max(32, measure(digits), measure(headerText)) + 16);
}

export function rowMarkerWidth(nrow: number): number {
    return Math.max(48, String(Math.max(1, nrow)).length * 8 + 24);
}

/**
 * Glide columns for every source column: the persisted user width when
 * there is one (clamped 40–3200), else the measured default (`auto`),
 * else the type default (wide frames) or a length estimate.
 */
export function buildGridColumns(
    columns: readonly ColumnSchema[],
    layout: Layout,
    auto: Readonly<Record<number, number>> = {},
): DataViewerGridColumn[] {
    const wide = columns.length > MEASURE_COLUMN_LIMIT;
    return columns.map((col, index) => {
        const user = layout.columnWidths[index];
        const width = user !== undefined
            ? clampColumnWidth(user)
            : auto[index] ?? (wide ? typeDefaultWidth(col) : computeDefaultColumnWidth(col));
        return {
            id: String(index),
            title: col.name,
            width,
            sourceIndex: index,
            variableLabel: col.variableLabel,
            hasMenu: false,
        };
    });
}

/** Shrink frozen rowname columns so gutter + rownames fit in half the
 *  viewport; past that they ellipsize. Returns new widths by position. */
export function capFrozenWidths(
    gutter: number,
    frozenWidths: readonly number[],
    viewportWidth: number,
): number[] {
    const cap = Math.max(0, viewportWidth / 2 - gutter);
    const total = frozenWidths.reduce((a, b) => a + b, 0);
    if (viewportWidth <= 0 || total <= cap) return [...frozenWidths];
    const scale = cap / total;
    return frozenWidths.map(w => Math.max(MIN_COLUMN_WIDTH_PX, Math.floor(w * scale)));
}

export function visibleColumnIndices(
    columns: readonly ColumnSchema[],
    hiddenColumns: readonly number[],
): number[] {
    const hidden = new Set(hiddenColumns);
    const out: number[] = [];
    for (let i = 0; i < columns.length; i++) {
        if (!hidden.has(i)) out.push(i);
    }
    return out;
}

export function buildVisibleGridColumns(
    allColumns: readonly DataViewerGridColumn[],
    visibleCols: readonly number[],
): DataViewerGridColumn[] {
    return visibleCols.map(index => allColumns[index]).filter(Boolean);
}

export function describeVisibleRows(nrow: number, range: VisibleRange, loading = false): string {
    // Before the init/replace message lands, nrow is 0 and a bare
    // "Showing 0-0 of 0" reads as an empty/broken table; say it's loading.
    if (loading) return 'Loading…';
    if (nrow <= 0) return 'Showing 0-0 of 0';
    if (range.end <= range.start) return `Showing 0-0 of ${nrow.toLocaleString()}`;
    const start = Math.min(nrow, range.start + 1);
    const end = Math.min(nrow, range.end);
    return `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${nrow.toLocaleString()}`;
}

const fmtCount = (n: number): string => n.toLocaleString('en-US');

/** Toolbar shape: `32 × 11`, or `12 of 32 rows × 11` while filtered. */
export function describeShape(
    nrow: number,
    ncol: number,
    nrowFiltered: number | undefined,
    loading: boolean,
): string {
    if (loading) return 'Loading…';
    if (nrowFiltered !== undefined) {
        return `${fmtCount(nrowFiltered)} of ${fmtCount(nrow)} rows × ${fmtCount(ncol)}`;
    }
    return `${fmtCount(nrow)} × ${fmtCount(ncol)}`;
}

/** Status line under the grid: the exact visible row range and filter
 *  context, e.g. `rows 1,201–1,240 of 12 (filtered from 32) · 11 cols`. */
export function describeStatusLine(
    nrow: number,
    ncol: number,
    nrowFiltered: number | undefined,
    viewport: VisibleRange,
): string {
    const shown = nrowFiltered ?? nrow;
    const filtered = nrowFiltered !== undefined ? ` (filtered from ${fmtCount(nrow)})` : '';
    const cols = `${fmtCount(ncol)} ${ncol === 1 ? 'col' : 'cols'}`;
    if (shown <= 0 || viewport.end <= viewport.start) {
        return `${fmtCount(shown)} rows${filtered} · ${cols}`;
    }
    const start = Math.min(shown, viewport.start + 1);
    const end = Math.min(shown, viewport.end);
    return `rows ${fmtCount(start)}–${fmtCount(end)} of ${fmtCount(shown)}${filtered} · ${cols}`;
}

/** Text of the gutter header: `shown / total` while a filter is active. */
export function gutterHeaderText(nrow: number, nrowFiltered: number | undefined): string {
    return nrowFiltered === undefined ? '' : `${fmtCount(nrowFiltered)} / ${fmtCount(nrow)}`;
}

/** The empty-state message for the grid, or undefined when rows exist. */
export function emptyStateMessage(
    nrow: number,
    nrowFiltered: number | undefined,
    loading: boolean,
): { text: string; clearFilters: boolean } | undefined {
    if (loading) return undefined;
    if (nrow === 0) return { text: 'No rows', clearFilters: false };
    if (nrowFiltered === 0) return { text: 'No rows match these filters', clearFilters: true };
    return undefined;
}

/**
 * Explains the saved-sort/filter restore wait on open (#519). `sort` /
 * `filter` say which preferences are being reapplied; at least one is true.
 */
export function describeRestoreMessage(sort: boolean, filter: boolean): string {
    if (sort && filter) return 'Applying your saved sort & filter…';
    if (sort) return 'Applying your saved sort…';
    return 'Applying your saved filter…';
}

/** Labels for the host operations currently in progress, shown as transient
 *  pills in the toolbar chip group. The data viewer has no bottom status bar;
 *  this is the only progress cue for a multi-second sort/filter on a large
 *  frame. Both can be active at once (a re-sort triggered while a filter index
 *  rebuilds), so this returns a list rather than a single string. */
export function pendingOperationLabels(sortPending: boolean, filterPending: boolean): string[] {
    const out: string[] = [];
    if (sortPending) out.push('Sorting…');
    if (filterPending) out.push('Filtering…');
    return out;
}

export function paddedRange(
    y: number,
    height: number,
    nrow: number,
    overscan: number = OVERSCAN_ROWS,
): VisibleRange {
    const start = Math.max(0, Math.floor(y) - overscan);
    const end = Math.min(nrow, Math.ceil(y + height) + overscan);
    return { start, end };
}

export function fitLeadingText(
    text: string,
    maxWidthPx: number,
    measureWidth: (text: string) => number,
    marker: string = '...',
): { text: string; truncated: boolean } {
    if (maxWidthPx <= 0) return { text: '', truncated: text.length > 0 };
    if (measureWidth(text) <= maxWidthPx) return { text, truncated: false };

    const markerWidth = measureWidth(marker);
    if (markerWidth >= maxWidthPx) return { text: marker, truncated: true };

    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureWidth(text.slice(0, mid) + marker) <= maxWidthPx) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    return { text: text.slice(0, lo) + marker, truncated: true };
}
