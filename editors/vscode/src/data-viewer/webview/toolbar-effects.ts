import type { ColumnSchema } from '../arrow-reader';
import { usesSourceFormat } from '../display-format';

// True when the Format toggle changes what this column shows. A float
// drawn through a recognized source format always qualifies, even one
// declared for whole numbers (`isInteger`): `DOLLAR8` shows a stored 12.75
// as `$13`, and Format off is the way back to the stored value. Any other
// float qualifies unless its format declares whole numbers.
export function hasFormatEffectCol(col: ColumnSchema): boolean {
    return usesSourceFormat(col) || hasDigitsEffectCol(col);
}

// True when the digits dropdown changes what this column shows: a float
// with no recognized source format (which sets its own decimals) and not
// declared for whole numbers.
export function hasDigitsEffectCol(col: ColumnSchema): boolean {
    return !col.isInteger && col.arrowType.startsWith('Float') && !usesSourceFormat(col);
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

export const hasDigitsEffect = (cols: ColumnSchema[]): boolean =>
    cols.some(hasDigitsEffectCol);

export const hasLabelsEffect = (cols: ColumnSchema[]): boolean =>
    cols.some(hasLabelsEffectCol);
