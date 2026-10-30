// The display ↔ source column mapping (display-columns.ts): gutter at
// display 0, rowname columns frozen first, hidden columns skipped, copy
// exclusions, and R row numbers after sort + filter.
import { describe, expect, test } from 'bun:test';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import {
    allCopyColumns,
    buildDisplayColumns,
    clampToData,
    copyColumns,
    displayIndexOf,
    firstDataDisplayIndex,
    isGutter,
    rowPosition,
    rRowNumber,
    sourceAt,
} from '../../editors/vscode/src/data-viewer/webview/display-columns';
import { TileCache } from '../../editors/vscode/src/data-viewer/webview/tile-cache';
import { composeEffectivePermutation } from '../../editors/vscode/src/data-viewer/effective-permutation';

const col = (name: string, extra: Partial<ColumnSchema> = {}): ColumnSchema =>
    ({ name, arrowType: 'Float64', isInteger: false, dictionaryShipped: false, ...extra });

// mtcars-shaped: rowname at source 0, then mpg, cyl, disp.
const withRownames = [col('rowname', { arrowType: 'Utf8', isRowname: true }), col('mpg'), col('cyl'), col('disp')];
const plain = [col('a'), col('b'), col('c')];

describe('buildDisplayColumns', () => {
    test('display 0 is the gutter; data columns follow in source order', () => {
        const dc = buildDisplayColumns(plain, []);
        expect(dc.dataCols).toEqual([0, 1, 2]);
        expect(dc.count).toBe(4);
        expect(dc.freezeColumns).toBe(1);
        expect(isGutter(0)).toBe(true);
        expect(sourceAt(dc, 0)).toBeUndefined();
        expect([1, 2, 3].map(d => sourceAt(dc, d))).toEqual([0, 1, 2]);
        expect(sourceAt(dc, 4)).toBeUndefined();
        expect(rowPosition(1)).toBe(0);
    });

    test('rowname columns are frozen with the gutter', () => {
        const dc = buildDisplayColumns(withRownames, []);
        expect(dc.freezeColumns).toBe(2);
        expect(dc.rownameCols).toEqual([0]);
        expect(sourceAt(dc, 1)).toBe(0);
    });

    test('hidden columns are skipped, including a hidden rowname', () => {
        const dc = buildDisplayColumns(withRownames, [0, 2]);
        expect(dc.dataCols).toEqual([1, 3]);
        expect(dc.freezeColumns).toBe(1);
        expect(displayIndexOf(dc, 3)).toBe(2);
        expect(displayIndexOf(dc, 2)).toBe(-1);
    });

    test('every column hidden leaves only the gutter', () => {
        const dc = buildDisplayColumns(plain, [0, 1, 2]);
        expect(dc.count).toBe(1);
        expect(firstDataDisplayIndex(dc)).toBe(-1);
    });

    test('display index round-trips through source index', () => {
        const dc = buildDisplayColumns(withRownames, [2]);
        for (let d = 1; d < dc.count; d++) expect(displayIndexOf(dc, sourceAt(dc, d)!)).toBe(d);
    });

    test('clampToData never lands on the gutter', () => {
        const dc = buildDisplayColumns(plain, []);
        expect(clampToData(dc, 0)).toBe(1);
        expect(clampToData(dc, -5)).toBe(1);
        expect(clampToData(dc, 99)).toBe(3);
    });
});

describe('copy columns', () => {
    const dc = buildDisplayColumns(withRownames, []);
    test('the gutter and rowname are excluded by default', () => {
        expect(copyColumns(dc, [0, 1, 2, 3], false)).toEqual([1, 2]);
        expect(allCopyColumns(dc, false)).toEqual([1, 2, 3]);
    });
    test('"Copy with row names" puts the rowname first even when not selected', () => {
        expect(copyColumns(dc, [3], true)).toEqual([0, 2]);
        expect(allCopyColumns(dc, true)).toEqual([0, 1, 2, 3]);
    });
    test('copy follows display order, not selection order', () => {
        expect(copyColumns(dc, [3, 2], false)).toEqual([1, 2]);
    });
    test('"Copy with row names" copies the frame\'s names even when the rowname column is hidden', () => {
        const hidden = buildDisplayColumns(withRownames, [0]);
        expect(hidden.rownameCols).toEqual([]);
        expect(hidden.allRownameCols).toEqual([0]);
        // Display 1 is now mpg (source 1).
        expect(copyColumns(hidden, [1], true)).toEqual([0, 1]);
        expect(allCopyColumns(hidden, true)).toEqual([0, 1, 2, 3]);
        expect(copyColumns(hidden, [1], false)).toEqual([1]);
    });
});

describe('gutter R row numbers', () => {
    test('natural order: display position + 1', () => {
        const cache = new TileCache({ rowsPerTile: 2, colsPerTile: 32 });
        cache.putBlock(10, 0, [[1], [2]], undefined, 100, 1);
        expect(rRowNumber(10, cache.originalRowIndex(10))).toBe(11);
        expect(rRowNumber(11, cache.originalRowIndex(11))).toBe(12);
    });

    test('after sort + filter the gutter shows the original row, not the position', () => {
        // 6 rows; sort descending by row index; keep only even original rows.
        const sortPerm = Uint32Array.from([5, 4, 3, 2, 1, 0]);
        const filtered = Uint32Array.from([0, 2, 4]);
        const effective = composeEffectivePermutation(sortPerm, filtered, 6)!;
        expect(Array.from(effective)).toEqual([4, 2, 0]);
        const cache = new TileCache({ rowsPerTile: 64, colsPerTile: 32 });
        // The host returns originalRowIndices = effective[start..end).
        cache.putBlock(0, 0, [[1], [2], [3]], Array.from(effective), 3, 1);
        expect([0, 1, 2].map(r => rRowNumber(r, cache.originalRowIndex(r)))).toEqual([5, 3, 1]);
    });
});
