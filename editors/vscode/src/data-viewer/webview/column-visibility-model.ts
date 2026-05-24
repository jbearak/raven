import type { ColumnSchema } from '../arrow-reader';

export function toggleColumnHidden(
    hiddenColumns: readonly number[],
    columnIndex: number,
): number[] {
    const hidden = new Set(hiddenColumns);
    if (hidden.has(columnIndex)) {
        hidden.delete(columnIndex);
    } else {
        hidden.add(columnIndex);
    }
    return [...hidden].sort((a, b) => a - b);
}

export function showAllColumns(): number[] {
    return [];
}

export function hideAllColumns(columns: readonly ColumnSchema[]): number[] {
    return columns.map((_col, index) => index);
}

export function visibleColumnsSet(columns: readonly ColumnSchema[], hiddenColumns: readonly number[]): Set<number> {
    const hidden = new Set(hiddenColumns);
    const visible = new Set<number>();
    for (let i = 0; i < columns.length; i++) {
        if (!hidden.has(i)) visible.add(i);
    }
    return visible;
}
