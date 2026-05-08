import { describe, test, expect } from 'bun:test';
import {
    visibleRange,
    coalesceScroll,
    MAX_SCROLL_PX,
    cappedScrollHeight,
    logicalScrollTop,
    visualOffsetPx,
} from '../../editors/vscode/src/data-viewer/webview/grid-model';
import { RowCache } from '../../editors/vscode/src/data-viewer/webview/row-cache';
import { Selection } from '../../editors/vscode/src/data-viewer/webview/selection-model';
import { formatCell } from '../../editors/vscode/src/data-viewer/webview/cell-render';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';

describe('visibleRange', () => {
    test('basic computation with overscan', () => {
        const r = visibleRange({
            scrollTop: 0, viewportHeight: 240, rowHeight: 24,
            nrow: 1000, overscan: 2,
        });
        expect(r.start).toBe(0);
        expect(r.end).toBe(Math.ceil(240 / 24) + 2);
    });
    test('clamps end to nrow', () => {
        const r = visibleRange({
            scrollTop: 24 * 990, viewportHeight: 240, rowHeight: 24,
            nrow: 1000, overscan: 2,
        });
        expect(r.end).toBe(1000);
    });
    test('start floors with overscan', () => {
        const r = visibleRange({
            scrollTop: 24 * 100, viewportHeight: 240, rowHeight: 24,
            nrow: 1000, overscan: 5,
        });
        expect(r.start).toBe(95);
    });
    test('non-zero scrollTop start computation', () => {
        const r = visibleRange({
            scrollTop: 24 * 50, viewportHeight: 240, rowHeight: 24,
            nrow: 1000, overscan: 0,
        });
        expect(r.start).toBe(50);
        expect(r.end).toBe(60);
    });
});

describe('scroll height capping', () => {
    const SMALL = MAX_SCROLL_PX - 1;
    const LARGE = MAX_SCROLL_PX * 16; // ~240 M px — 10 M rows × 24 px
    const VH = 600;   // typical viewport height
    const RH = 24;    // row height
    const maxPhysical = MAX_SCROLL_PX + RH - VH;   // real browser max scrollTop
    const maxLogicalLarge = LARGE + RH - VH;

    test('cappedScrollHeight: small dataset is unchanged', () => {
        expect(cappedScrollHeight(SMALL)).toBe(SMALL);
    });
    test('cappedScrollHeight: large dataset is capped', () => {
        expect(cappedScrollHeight(LARGE)).toBe(MAX_SCROLL_PX);
    });

    test('logicalScrollTop: identity when content fits', () => {
        expect(logicalScrollTop(1234, SMALL, VH, RH)).toBe(1234);
    });
    test('logicalScrollTop: top of large dataset', () => {
        expect(logicalScrollTop(0, LARGE, VH, RH)).toBe(0);
    });
    test('logicalScrollTop: browser max scrollTop maps to maxLogical', () => {
        expect(logicalScrollTop(maxPhysical, LARGE, VH, RH)).toBeCloseTo(maxLogicalLarge);
    });
    test('logicalScrollTop: midpoint maps proportionally', () => {
        expect(logicalScrollTop(maxPhysical / 2, LARGE, VH, RH)).toBeCloseTo(maxLogicalLarge / 2);
    });

    test('visualOffsetPx: identity when content fits', () => {
        expect(visualOffsetPx(5000, SMALL, VH, RH)).toBe(5000);
    });
    test('visualOffsetPx: maxLogical maps to maxPhysical', () => {
        expect(visualOffsetPx(maxLogicalLarge, LARGE, VH, RH)).toBeCloseTo(maxPhysical);
    });
    test('visualOffsetPx: midpoint maps proportionally', () => {
        expect(visualOffsetPx(maxLogicalLarge / 2, LARGE, VH, RH)).toBeCloseTo(maxPhysical / 2);
    });

    test('round-trip: logicalScrollTop → visibleRange → visualOffsetPx stays consistent', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        // Simulate scrolled to 75 % of the capped container
        const scrollTop = maxPhysical * 0.75;
        const logical = logicalScrollTop(scrollTop, totalGridHeight, VH, RH);
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 0,
        });
        // The first visible row should be near 75 % of nrow
        expect(range.start).toBeGreaterThan(nrow * 0.74);
        expect(range.start).toBeLessThan(nrow * 0.76);
        // And its visual position should be near 75 % of maxPhysical
        const visual = visualOffsetPx(range.start * RH, totalGridHeight, VH, RH);
        expect(visual).toBeGreaterThan(maxPhysical * 0.74);
        expect(visual).toBeLessThan(maxPhysical * 0.76);
    });

    test('bottom: max scrollTop reaches the last row', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        const logical = logicalScrollTop(maxPhysical, totalGridHeight, VH, RH);
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        expect(range.end).toBe(nrow);
    });
});

describe('coalesceScroll', () => {
    test('many rapid calls collapse to one fire', async () => {
        let calls = 0;
        const fn = coalesceScroll(() => calls++, 16);
        for (let i = 0; i < 10; i++) fn();
        await new Promise(r => setTimeout(r, 30));
        expect(calls).toBe(1);
    });
    test('fires again after the cool-off', async () => {
        let calls = 0;
        const fn = coalesceScroll(() => calls++, 16);
        fn(); await new Promise(r => setTimeout(r, 30));
        fn(); await new Promise(r => setTimeout(r, 30));
        expect(calls).toBe(2);
    });
    test('passes the latest args through', async () => {
        const seen: number[] = [];
        const fn = coalesceScroll((n: number) => seen.push(n), 10);
        fn(1); fn(2); fn(3);
        await new Promise(r => setTimeout(r, 25));
        expect(seen).toEqual([3]);
    });
});

describe('RowCache', () => {
    test('put/get roundtrip', () => {
        const c = new RowCache(100);
        c.put(0, 5, [[1, 2, 3]]);
        expect(c.get(0, 5)).toEqual([[1, 2, 3]]);
    });
    test('LRU evicts by aggregate cell count', () => {
        const c = new RowCache(10);
        c.put(0, 5, [[1, 2, 3, 4, 5]]);   // 5 cells
        c.put(5, 10, [[1, 2, 3, 4, 5]]);  // 5 cells (total = 10)
        c.put(10, 15, [[1, 2, 3, 4, 5]]); // pushes over → eldest evicted
        expect(c.get(0, 5)).toBeUndefined();
        expect(c.get(5, 10)).toBeDefined();
        expect(c.get(10, 15)).toBeDefined();
    });
    test('get on a hit moves to MRU', () => {
        const c = new RowCache(10);
        c.put(0, 5, [[1, 2, 3, 4, 5]]);
        c.put(5, 10, [[1, 2, 3, 4, 5]]);
        // touch 0..5
        c.get(0, 5);
        c.put(10, 15, [[1, 2, 3, 4, 5]]);
        // 5..10 is now eldest
        expect(c.get(0, 5)).toBeDefined();
        expect(c.get(5, 10)).toBeUndefined();
    });
    test('clear empties the cache', () => {
        const c = new RowCache(100);
        c.put(0, 5, [[1, 2, 3]]);
        c.clear();
        expect(c.get(0, 5)).toBeUndefined();
    });
});

describe('Selection', () => {
    test('rectangle from anchor + focus', () => {
        const s = new Selection();
        s.anchor(2, 3); s.focus(5, 1);
        expect(s.rect()).toEqual({
            rowStart: 2, rowEnd: 6, colStart: 1, colEnd: 4,
        });
    });
    test('focus alone (no anchor) returns null', () => {
        const s = new Selection();
        expect(s.rect()).toBeNull();
    });
    test('selectAll spans nrow × visibleCols', () => {
        const s = new Selection();
        s.selectAll(1000, [0, 2, 4]);
        expect(s.rect()).toEqual({
            rowStart: 0, rowEnd: 1000, colStart: 0, colEnd: 5,
        });
        expect(s.colIndices()).toEqual([0, 2, 4]);
    });
    test('clear resets', () => {
        const s = new Selection();
        s.anchor(1, 1); s.focus(2, 2);
        s.clear();
        expect(s.rect()).toBeNull();
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
    test('null cell is missing', () => {
        expect(formatCell(null, floatCol, undefined, false, false, 3))
            .toEqual({ text: '', missing: true });
    });
    test('NaN sentinel renders NaN and is missing', () => {
        expect(formatCell({ _: 'nan' }, floatCol, undefined, false, false, 3))
            .toEqual({ text: 'NaN', missing: true });
    });
    test('Inf renders not as missing', () => {
        expect(formatCell({ _: 'inf' }, floatCol, undefined, false, false, 3))
            .toEqual({ text: 'Inf', missing: false });
    });
    test('haven_labelled with Labels on swaps to label', () => {
        expect(formatCell(1, labelledCol, undefined, true, false, 3))
            .toEqual({ text: 'one', missing: false });
    });
    test('haven_labelled with Labels off shows raw value', () => {
        expect(formatCell(1, labelledCol, undefined, false, false, 3))
            .toEqual({ text: '1', missing: false });
    });
    test('Date sentinel passes through', () => {
        expect(formatCell({ _: 'date', v: '2024-01-15' }, undefined, undefined, false, false, 3))
            .toEqual({ text: '2024-01-15', missing: false });
    });
    test('truncated cell shows truncation indicator', () => {
        expect(formatCell({ _: 'trunc', v: 'long…' }, undefined, undefined, false, false, 3))
            .toEqual({ text: 'long…', missing: false });
    });
});
