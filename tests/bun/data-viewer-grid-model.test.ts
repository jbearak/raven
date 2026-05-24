import { describe, test, expect } from 'bun:test';
import {
    buildGridColumns,
    buildVisibleGridColumns,
    clampColumnWidth,
    describeHiddenColumnCount,
    describeShape,
    describeVisibleRows,
    fitLeadingText,
    MAX_COLUMN_WIDTH_PX,
    MIN_COLUMN_WIDTH_PX,
    paddedRange,
    rowMarkerWidth,
    visibleColumnIndices,
} from '../../editors/vscode/src/data-viewer/webview/grid-model';
import {
    hideAllColumns,
    showAllColumns,
    toggleColumnHidden,
} from '../../editors/vscode/src/data-viewer/webview/column-visibility-model';
import { RowCache } from '../../editors/vscode/src/data-viewer/webview/row-cache';
import { Selection } from '../../editors/vscode/src/data-viewer/webview/selection-model';
import { formatCell } from '../../editors/vscode/src/data-viewer/webview/cell-render';
import {
    hasFormatEffect,
    hasLabelsEffect,
} from '../../editors/vscode/src/data-viewer/webview/toolbar-effects';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

const cols: ColumnSchema[] = [
    { name: 'x', arrowType: 'Int32', isInteger: true, dictionaryShipped: false },
    { name: 'x', arrowType: 'Float64', isInteger: false, dictionaryShipped: false, variableLabel: 'duplicate x' },
    { name: 'grp', arrowType: 'Dictionary<Int32, Utf8>', isInteger: false, dictionaryShipped: true, dictionary: ['a', 'b'] },
];

describe('React data-viewer grid model', () => {
    test('visibleColumnIndices uses numeric indices and tolerates duplicate names', () => {
        expect(visibleColumnIndices(cols, [1])).toEqual([0, 2]);
    });

    test('buildVisibleGridColumns maps visible source indices back to Glide columns', () => {
        const all = buildGridColumns(cols, { columnWidths: { 1: 222 }, hiddenColumns: [0] });
        const visible = buildVisibleGridColumns(all, [1, 2]);
        expect(visible.map(c => c.sourceIndex)).toEqual([1, 2]);
        expect(visible[0].width).toBe(222);
        expect(visible[0].variableLabel).toBe('duplicate x');
    });

    test('toggleColumnHidden round-trips numeric hidden columns', () => {
        expect(toggleColumnHidden([2], 1)).toEqual([1, 2]);
        expect(toggleColumnHidden([1, 2], 1)).toEqual([2]);
        expect(showAllColumns()).toEqual([]);
        expect(hideAllColumns(cols)).toEqual([0, 1, 2]);
    });

    test('rowMarkerWidth grows to fit large row numbers', () => {
        expect(rowMarkerWidth(1)).toBe(48);
        expect(rowMarkerWidth(10_000_000)).toBeGreaterThan(rowMarkerWidth(1_000));
        expect(rowMarkerWidth(10_000_000)).toBeGreaterThanOrEqual('10000000'.length * 8 + 24);
    });

    test('clampColumnWidth bounds user and default widths', () => {
        expect(clampColumnWidth(undefined)).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH_PX);
        expect(clampColumnWidth(1)).toBe(MIN_COLUMN_WIDTH_PX);
        expect(clampColumnWidth(9999)).toBe(MAX_COLUMN_WIDTH_PX);
        expect(clampColumnWidth(123.4)).toBe(123);
    });

    test('paddedRange clamps to dataset bounds', () => {
        expect(paddedRange(0, 20, 100, 8)).toEqual({ start: 0, end: 28 });
        expect(paddedRange(90, 20, 100, 8)).toEqual({ start: 82, end: 100 });
    });

    test('description helpers are stable', () => {
        expect(describeVisibleRows(1000, { start: 0, end: 25 }))
            .toBe('Showing 1-25 of 1,000');
        expect(describeShape(1000, cols, 'data.frame')).toBe('1,000 rows x 3 columns | data.frame');
        expect(describeHiddenColumnCount(0)).toBeNull();
        expect(describeHiddenColumnCount(2)).toBe('2 columns hidden');
    });

    test('toolbar effect detection still matches Raven column metadata', () => {
        expect(hasFormatEffect(cols)).toBe(true);
        expect(hasLabelsEffect(cols)).toBe(true);
        expect(hasFormatEffect([cols[0]])).toBe(false);
        expect(hasLabelsEffect([cols[0]])).toBe(false);
    });

    test('fitLeadingText preserves leading digits and marks truncation', () => {
        const measure = (text: string) => text.length;
        expect(fitLeadingText('123456.789012', 20, measure)).toEqual({
            text: '123456.789012',
            truncated: false,
        });
        expect(fitLeadingText('123456.789012', 9, measure)).toEqual({
            text: '123456...',
            truncated: true,
        });
        expect(fitLeadingText('123456.789012', 6, measure)).toEqual({
            text: '123...',
            truncated: true,
        });
    });
});

describe('RowCache', () => {
    test('put/get roundtrip', () => {
        const c = new RowCache(100);
        c.put(0, 2, [[1, 2, 3], [4, 5, 6]]);
        expect(c.get(0, 2)).toEqual([[1, 2, 3], [4, 5, 6]]);
    });

    test('getRow finds a row inside a cached window', () => {
        const c = new RowCache(100);
        c.put(10, 12, [[1, 2], [3, 4]]);
        expect(c.getRow(11)).toEqual([3, 4]);
        expect(c.getRow(12)).toBeUndefined();
    });

    test('hasRange treats a cached superset as present', () => {
        const c = new RowCache(100);
        c.put(10, 20, Array.from({ length: 10 }, (_, i) => [i]));
        expect(c.hasRange(12, 18)).toBe(true);
        expect(c.hasRange(8, 18)).toBe(false);
        expect(c.hasRange(12, 22)).toBe(false);
    });

    test('LRU evicts by aggregate cell count', () => {
        const c = new RowCache(10);
        c.put(0, 1, [[1, 2, 3, 4, 5]]);
        c.put(1, 2, [[1, 2, 3, 4, 5]]);
        c.put(2, 3, [[1, 2, 3, 4, 5]]);
        expect(c.get(0, 1)).toBeUndefined();
        expect(c.get(1, 2)).toBeDefined();
        expect(c.get(2, 3)).toBeDefined();
    });

    test('clear empties the cache', () => {
        const c = new RowCache(100);
        c.put(0, 1, [[1, 2, 3]]);
        c.clear();
        expect(c.get(0, 1)).toBeUndefined();
    });
});

describe('Selection', () => {
    test('rectangle from anchor + focus', () => {
        const s = new Selection();
        s.anchor(2, 3);
        s.focus(5, 1);
        expect(s.rect()).toEqual({
            rowStart: 2, rowEnd: 6, colStart: 1, colEnd: 4,
        });
    });

    test('selectAll spans nrow x visibleCols and keeps explicit non-contiguous columns', () => {
        const s = new Selection();
        s.selectAll(1000, [0, 2, 4]);
        expect(s.rect()).toEqual({
            rowStart: 0, rowEnd: 1000, colStart: 0, colEnd: 5,
        });
        expect(s.colIndices()).toEqual([0, 2, 4]);
        expect(s.includesHeader()).toBe(true);
    });
});

describe('formatCell', () => {
    const factor: ColumnSchema = {
        name: 'f', arrowType: 'Dictionary<Int32, Utf8>',
        isInteger: false, dictionaryShipped: true,
        dictionary: ['low', 'med', 'high'],
    };
    const intCol: ColumnSchema = {
        name: 'i', arrowType: 'Int32', isInteger: true, dictionaryShipped: false,
    };
    const floatCol: ColumnSchema = {
        name: 'v', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
    };
    const labelledCol: ColumnSchema = {
        name: 'lab', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
        valueLabels: { '1': 'one', '2': 'two' },
    };

    test('factor with Labels off shows 1-based code', () => {
        expect(formatCell(0, factor, factor.dictionary, false, false, 3))
            .toEqual({ text: '1', missing: false });
    });

    test('factor with Labels on shows level', () => {
        expect(formatCell(2, factor, factor.dictionary, true, false, 3))
            .toEqual({ text: 'high', missing: false });
    });

    test('integer column ignores Format', () => {
        expect(formatCell(7, intCol, undefined, false, true, 4))
            .toEqual({ text: '7', missing: false });
    });

    test('float column rounds when Format on', () => {
        expect(formatCell(1.23456, floatCol, undefined, false, true, 2))
            .toEqual({ text: '1.23', missing: false });
    });

    test('float column with integer-valued cell skips toFixed', () => {
        expect(formatCell(5, floatCol, undefined, false, true, 3))
            .toEqual({ text: '5', missing: false });
    });

    test('null and NaN cells are missing', () => {
        expect(formatCell(null, floatCol, undefined, false, false, 3))
            .toEqual({ text: '', missing: true });
        expect(formatCell({ _: 'nan' }, floatCol, undefined, false, false, 3))
            .toEqual({ text: 'NaN', missing: true });
    });

    test('haven_labelled with Labels on swaps to label', () => {
        expect(formatCell(1, labelledCol, undefined, true, false, 3))
            .toEqual({ text: 'one', missing: false });
    });

    test('sentinel display values pass through', () => {
        expect(formatCell({ _: 'date', v: '2024-01-15' }, undefined, undefined, false, false, 3))
            .toEqual({ text: '2024-01-15', missing: false });
        expect(formatCell({ _: 'trunc', v: 'long...' }, undefined, undefined, false, false, 3))
            .toEqual({ text: 'long...', missing: false });
    });
});
