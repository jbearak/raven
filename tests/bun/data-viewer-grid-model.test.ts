import { describe, test, expect } from 'bun:test';
import {
    buildGridColumns,
    buildVisibleGridColumns,
    clampColumnWidth,
    describeRestoreMessage,
    capFrozenWidths,
    clampAutoWidth,
    describeShape,
    describeStatusLine,
    emptyStateMessage,
    gutterHeaderText,
    measuredColumnWidth,
    typeDefaultWidth,
    describeVisibleRows,
    fitLeadingText,
    MAX_COLUMN_WIDTH_PX,
    MIN_COLUMN_WIDTH_PX,
    paddedRange,
    pendingOperationLabels,
    rowMarkerWidth,
    visibleColumnIndices,
} from '../../editors/vscode/src/data-viewer/webview/grid-model';
import {
    hideAllColumns,
    showAllColumns,
    toggleColumnHidden,
} from '../../editors/vscode/src/data-viewer/webview/column-visibility-model';
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

    test('clampColumnWidth bounds a drag to 40-3200 px; measured widths to 60-400 px', () => {
        expect(MIN_COLUMN_WIDTH_PX).toBe(40);
        expect(MAX_COLUMN_WIDTH_PX).toBe(3200);
        expect(clampAutoWidth(10)).toBe(60);
        expect(clampAutoWidth(1000)).toBe(400);
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
    });

    test('pendingOperationLabels lists active host operations', () => {
        // The toolbar progress pills replace the old bottom status bar's
        // "Sorting…"/"Filtering…" text. Both can be active at once.
        expect(pendingOperationLabels(false, false)).toEqual([]);
        expect(pendingOperationLabels(true, false)).toEqual(['Sorting…']);
        expect(pendingOperationLabels(false, true)).toEqual(['Filtering…']);
        expect(pendingOperationLabels(true, true)).toEqual(['Sorting…', 'Filtering…']);
    });

    test('describeVisibleRows shows Loading until the dataset arrives', () => {
        // Before init lands, nrow is 0 and the bare "Showing 0-0 of 0" reads
        // as an empty/broken table; show that it is loading instead.
        expect(describeVisibleRows(0, { start: 0, end: 0 }, true)).toBe('Loading…');
        // loading wins even if a stale count is around (e.g. getState restore).
        expect(describeVisibleRows(1000, { start: 0, end: 25 }, true)).toBe('Loading…');
        // default (not loading) is unchanged.
        expect(describeVisibleRows(0, { start: 0, end: 0 })).toBe('Showing 0-0 of 0');
        expect(describeVisibleRows(0, { start: 0, end: 0 }, false)).toBe('Showing 0-0 of 0');
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
        expect(formatCell(0, factor, factor.dictionary, { labelsOn: false, formatOn: false, digits: 3 }))
            .toMatchObject({ text: '1', missing: false });
    });

    test('factor with Labels on shows level', () => {
        expect(formatCell(2, factor, factor.dictionary, { labelsOn: true, formatOn: false, digits: 3 }))
            .toMatchObject({ text: 'high', missing: false });
    });

    test('integer column ignores Format', () => {
        expect(formatCell(7, intCol, undefined, { labelsOn: false, formatOn: true, digits: 4 }))
            .toMatchObject({ text: '7', missing: false });
    });

    test('float column rounds when Format on', () => {
        expect(formatCell(1.23456, floatCol, undefined, { labelsOn: false, formatOn: true, digits: 2 }))
            .toMatchObject({ text: '1.23', missing: false });
    });

    test('float column with integer-valued cell skips toFixed', () => {
        expect(formatCell(5, floatCol, undefined, { labelsOn: false, formatOn: true, digits: 3 }))
            .toMatchObject({ text: '5', missing: false });
    });

    test('null prints NA and NaN prints NaN; both are missing', () => {
        expect(formatCell(null, floatCol, undefined, { labelsOn: false, formatOn: false, digits: 3 }))
            .toMatchObject({ text: 'NA', missing: true });
        expect(formatCell({ _: 'nan' }, floatCol, undefined, { labelsOn: false, formatOn: false, digits: 3 }))
            .toMatchObject({ text: 'NaN', missing: true });
    });

    test('haven_labelled with Labels on swaps to label', () => {
        expect(formatCell(1, labelledCol, undefined, { labelsOn: true, formatOn: false, digits: 3 }))
            .toMatchObject({ text: 'one', missing: false });
    });

    test('sentinel display values pass through', () => {
        expect(formatCell({ _: 'date', v: '2024-01-15' }, undefined, undefined, false, false, 3))
            .toMatchObject({ text: '2024-01-15', missing: false });
        expect(formatCell({ _: 'trunc', v: 'long...' }, undefined, undefined, false, false, 3))
            .toMatchObject({ text: 'long...', missing: false });
    });
});

describe('saved sort/filter restore messaging (#519)', () => {
    test('describeRestoreMessage words by which prefs apply', () => {
        expect(describeRestoreMessage(true, true))
            .toBe('Applying your saved sort & filter…');
        expect(describeRestoreMessage(true, false))
            .toBe('Applying your saved sort…');
        expect(describeRestoreMessage(false, true))
            .toBe('Applying your saved filter…');
    });

    test('describeShape keeps the frame shape visible while a restore banner shows', () => {
        expect(describeShape(0, 0, undefined, true)).toBe('Loading…');
        expect(describeShape(1000, 11, undefined, false)).toBe('1,000 × 11');
        expect(describeShape(32, 11, 12, false)).toBe('12 of 32 rows × 11');
    });
});

describe('widths', () => {
    const measure = {
        name: (t: string) => t.length * 8,
        tag: (t: string) => t.length * 6,
        label: (t: string) => t.length * 7,
        cell: (t: string) => t.length * 7,
    };
    test('measured width is the widest of name + sort slot, tag, label, and values', () => {
        expect(measuredColumnWidth('mpg', '<dbl>', undefined, ['21.000'], measure, 18)).toBe(62);
        expect(measuredColumnWidth('x', '<dbl>', 'A long variable label here', [], measure, 18))
            .toBe(26 * 7 + 20);
        expect(measuredColumnWidth('x', '<chr>', undefined, ['y'.repeat(200)], measure, 18)).toBe(400);
    });
    test('type defaults for wide frames', () => {
        const c = (typeTag: string): ColumnSchema =>
            ({ name: 'c', arrowType: 'Float64', isInteger: false, dictionaryShipped: false, typeTag });
        expect(typeDefaultWidth(c('<dttm UTC>'))).toBeGreaterThan(typeDefaultWidth(c('<dbl>')));
        expect(typeDefaultWidth(c('<lgl>'))).toBeLessThan(typeDefaultWidth(c('<chr>')));
    });
    test('a persisted user width wins over the measured default', () => {
        const all = buildGridColumns(cols, { columnWidths: { 0: 2000 }, hiddenColumns: [] }, { 0: 90, 1: 95 });
        expect(all[0].width).toBe(2000);
        expect(all[1].width).toBe(95);
    });
    test('frozen rowname columns shrink to keep the frozen region within half the viewport', () => {
        expect(capFrozenWidths(50, [300], 1000)).toEqual([300]);
        expect(capFrozenWidths(50, [600], 1000)).toEqual([450]);
    });
});

describe('status line, gutter header, empty states', () => {
    test('status line shows the exact visible range and filter context', () => {
        expect(describeStatusLine(32, 11, undefined, { start: 0, end: 20 })).toBe('rows 1–20 of 32 · 11 cols');
        expect(describeStatusLine(32, 11, 12, { start: 0, end: 12 }))
            .toBe('rows 1–12 of 12 (filtered from 32) · 11 cols');
        expect(describeStatusLine(5000, 1, undefined, { start: 1200, end: 1240 }))
            .toBe('rows 1,201–1,240 of 5,000 · 1 col');
    });
    test('gutter header shows shown / total only while filtered', () => {
        expect(gutterHeaderText(32, undefined)).toBe('');
        expect(gutterHeaderText(32, 12)).toBe('12 / 32');
    });
    test('empty states', () => {
        expect(emptyStateMessage(0, undefined, false)).toEqual({ text: 'No rows', clearFilters: false });
        expect(emptyStateMessage(32, 0, false)).toEqual({ text: 'No rows match these filters', clearFilters: true });
        expect(emptyStateMessage(32, 5, false)).toBeUndefined();
        expect(emptyStateMessage(0, undefined, true)).toBeUndefined();
    });
});
