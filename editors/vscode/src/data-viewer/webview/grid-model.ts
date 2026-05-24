import type { SizedGridColumn } from '@glideapps/glide-data-grid';
import type { ColumnSchema } from '../arrow-reader';
import type { Layout } from '../messages';

export const ROW_HEIGHT_PX = 24;
export const HEADER_HEIGHT_PX = 40;
export const OVERSCAN_ROWS = 8;
export const MIN_COLUMN_WIDTH_PX = 72;
export const MAX_COLUMN_WIDTH_PX = 320;

const DEFAULT_COLUMN_WIDTH_PX = 120;
const TITLE_CHAR_WIDTH_PX = 7;
const SUBTITLE_CHAR_WIDTH_PX = 6;
const CONTENT_CHAR_WIDTH_PX = 7;
const HEADER_PADDING_PX = 28;

export type DataViewerGridColumn = SizedGridColumn & {
    sourceIndex: number;
    variableLabel?: string;
};

export type VisibleRange = {
    start: number;
    end: number;
};

export function clampColumnWidth(width: number | undefined): number {
    if (width === undefined || !Number.isFinite(width)) {
        return DEFAULT_COLUMN_WIDTH_PX;
    }
    return Math.max(
        MIN_COLUMN_WIDTH_PX,
        Math.min(MAX_COLUMN_WIDTH_PX, Math.round(width)),
    );
}

export function computeDefaultColumnWidth(col: ColumnSchema): number {
    const titleWidth = col.name.length * TITLE_CHAR_WIDTH_PX;
    const labelWidth = (col.variableLabel ?? '').length * SUBTITLE_CHAR_WIDTH_PX;
    const typeWidth = col.arrowType.length * CONTENT_CHAR_WIDTH_PX;
    return clampColumnWidth(Math.max(titleWidth, labelWidth, typeWidth) + HEADER_PADDING_PX);
}

export function rowMarkerWidth(nrow: number): number {
    return Math.max(48, String(Math.max(1, nrow)).length * 8 + 24);
}

export function buildGridColumns(
    columns: readonly ColumnSchema[],
    layout: Layout,
): DataViewerGridColumn[] {
    return columns.map((col, index) => ({
        id: String(index),
        title: col.name,
        width: clampColumnWidth(layout.columnWidths[index] ?? computeDefaultColumnWidth(col)),
        sourceIndex: index,
        variableLabel: col.variableLabel,
        hasMenu: false,
    }));
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

export function describeVisibleRows(nrow: number, range: VisibleRange): string {
    if (nrow <= 0) return 'Showing 0-0 of 0';
    if (range.end <= range.start) return `Showing 0-0 of ${nrow.toLocaleString()}`;
    const start = Math.min(nrow, range.start + 1);
    const end = Math.min(nrow, range.end);
    return `Showing ${start.toLocaleString()}-${end.toLocaleString()} of ${nrow.toLocaleString()}`;
}

export function describeShape(nrow: number, columns: readonly ColumnSchema[], objectClass?: string): string {
    const shape = `${nrow.toLocaleString()} rows x ${columns.length.toLocaleString()} columns`;
    return objectClass ? `${shape} | ${objectClass}` : shape;
}

export function describeHiddenColumnCount(hiddenCount: number): string | null {
    if (hiddenCount <= 0) return null;
    return hiddenCount === 1 ? '1 column hidden' : `${hiddenCount} columns hidden`;
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
