/**
 * Webview tile cache (F5): (row page, column page) tiles, O(1) lookup,
 * bounded by cells and bytes, visible tiles pinned.
 */
import { describe, expect, test } from 'bun:test';
import { TileCache, tileGeometry } from '../../editors/vscode/src/data-viewer/webview/tile-cache';
import type { Cell } from '../../editors/vscode/src/data-viewer/wire-format';

function block(rows: number, cols: number, rowStart: number, colStart: number): Cell[][] {
    return Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => (rowStart + r) * 10_000 + colStart + c));
}

describe('tileGeometry', () => {
    test('256 × 32 unsorted, 64 × 32 permuted, smaller row pages for wide frames', () => {
        expect(tileGeometry(false, 10)).toEqual({ rowsPerTile: 256, colsPerTile: 32 });
        expect(tileGeometry(true, 10)).toEqual({ rowsPerTile: 64, colsPerTile: 32 });
        expect(tileGeometry(false, 600).rowsPerTile).toBe(128);
        expect(tileGeometry(true, 2000).rowsPerTile).toBe(32);
        expect(tileGeometry(true, 4000).rowsPerTile).toBe(16);
    });
});

describe('TileCache', () => {
    test('splits a reply into tiles; cells and originals come back by position', () => {
        const c = new TileCache({ rowsPerTile: 4, colsPerTile: 2 });
        const originals = Array.from({ length: 8 }, (_, i) => 100 + i);
        c.putBlock(0, 0, block(8, 4, 0, 0), originals, 8, 4);
        expect(c.size).toBe(4);
        expect(c.cell(5, 3)).toBe(5 * 10_000 + 3);
        expect(c.originalRowIndex(6)).toBe(106);
        expect(c.hasRow(7)).toBe(true);
        expect(c.has(1, 1)).toBe(true);
    });

    test('partial pages are not stored, except the last page of the frame', () => {
        const c = new TileCache({ rowsPerTile: 4, colsPerTile: 2 });
        c.putBlock(2, 0, block(4, 2, 2, 0), undefined, 100, 2); // rows 2..6: no whole page
        expect(c.size).toBe(0);
        c.putBlock(8, 0, block(2, 2, 8, 0), undefined, 10, 2); // rows 8..10 end the frame
        expect(c.size).toBe(1);
        expect(c.cell(9, 1)).toBe(9 * 10_000 + 1);
        expect(c.originalRowIndex(9)).toBeUndefined();
    });

    test('missing() is the bounding box of uncached tiles', () => {
        const c = new TileCache({ rowsPerTile: 4, colsPerTile: 2 });
        c.putBlock(0, 0, block(4, 2, 0, 0), undefined, 100, 10);
        expect(c.missing([0, 0], [0, 0])).toBeUndefined();
        expect(c.missing([0, 1], [0, 1])).toEqual({ rowPages: [0, 1], colPages: [0, 1] });
        expect(c.missing([0, 0], [0, 2])).toEqual({ rowPages: [0, 0], colPages: [1, 2] });
    });

    test('evicts least-recently-used tiles past the cell bound, never pinned ones', () => {
        const c = new TileCache({ rowsPerTile: 4, colsPerTile: 2 }, { maxCells: 3 * 8, maxBytes: 1e9 });
        c.pin([0, 0], [0, 0]); // the viewport
        for (let rp = 0; rp < 6; rp++) c.putBlock(rp * 4, 0, block(4, 2, rp * 4, 0), undefined, 100, 2);
        expect(c.cells).toBeLessThanOrEqual(24);
        expect(c.has(0, 0)).toBe(true); // pinned survived
        expect(c.has(5, 0)).toBe(true); // newest survived
        expect(c.has(1, 0)).toBe(false);
        expect(c.hasRow(5)).toBe(false); // its page's originals went with it
    });

    test('is bounded by bytes too (long strings)', () => {
        const c = new TileCache({ rowsPerTile: 2, colsPerTile: 1 }, { maxCells: 1e9, maxBytes: 3000 });
        const long = 'x'.repeat(500);
        for (let rp = 0; rp < 10; rp++) c.putBlock(rp * 2, 0, [[long], [long]], undefined, 100, 1);
        expect(c.bytes).toBeLessThanOrEqual(3000);
        expect(c.size).toBeLessThan(10);
    });

    test('lookup is O(1): a million-tile key space costs the same as one', () => {
        const c = new TileCache({ rowsPerTile: 64, colsPerTile: 32 }, { maxCells: 1e9, maxBytes: 1e12 });
        c.putBlock(64 * 1_000_000, 32 * 60, block(64, 32, 0, 0), undefined, 64 * 1_000_001, 32 * 61);
        const t0 = performance.now();
        let hits = 0;
        for (let i = 0; i < 100_000; i++) if (c.cell(64 * 1_000_000 + (i % 64), 32 * 60 + (i % 32)) !== undefined) hits++;
        expect(hits).toBe(100_000);
        expect(performance.now() - t0).toBeLessThan(200);
    });

    test('sampleColumn returns cached values at a position', () => {
        const c = new TileCache({ rowsPerTile: 4, colsPerTile: 2 });
        c.putBlock(0, 0, block(8, 2, 0, 0), undefined, 8, 2);
        expect(c.sampleColumn(1, 3)).toEqual([1, 10_001, 20_001]);
    });
});
