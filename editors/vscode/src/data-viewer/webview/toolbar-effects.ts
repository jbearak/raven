import type { ColumnSchema } from '../arrow-reader';

// True when the Format toggle would change at least one cell in this column.
// Mirrors cell-render.ts:45 — only Float* columns reach that branch with
// `typeof cell === 'number'` AND `!col.isInteger`.
export function hasFormatEffectCol(col: ColumnSchema): boolean {
    return !col.isInteger && col.arrowType.startsWith('Float');
}

// True when the Labels toggle would change at least one cell in this column.
// Covers shipped and async-fetched dictionaries plus haven_labelled columns
// with non-empty valueLabels.
export function hasLabelsEffectCol(col: ColumnSchema): boolean {
    if (col.arrowType.startsWith('Dictionary')) return true;
    return !!col.valueLabels && Object.keys(col.valueLabels).length > 0;
}

export const hasFormatEffect = (cols: ColumnSchema[]): boolean =>
    cols.some(hasFormatEffectCol);

export const hasLabelsEffect = (cols: ColumnSchema[]): boolean =>
    cols.some(hasLabelsEffectCol);
