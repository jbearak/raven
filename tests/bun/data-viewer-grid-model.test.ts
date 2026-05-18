import { describe, test, expect } from 'bun:test';
import {
    visibleRange,
    coalesceScroll,
    MAX_SCROLL_PX,
    cappedScrollHeight,
    estimatedMaxPhysicalScrollTop,
    logicalScrollTop,
    visualOffsetPx,
    visualRowsOffsetPx,
    MIN_THUMB_PX,
    HEADER_ROW_PX,
    HORIZONTAL_GUTTER_PX,
    shouldForceLogicalBottomAfterScroll,
    customThumbHeight,
    customThumbTop,
    customScrollTopFromThumbTop,
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
    test('estimatedMaxPhysicalScrollTop: uses capped content height plus row sentinel', () => {
        expect(estimatedMaxPhysicalScrollTop(LARGE, VH, RH)).toBe(maxPhysical);
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

    test('bottom: near-bottom physical scroll snaps to the logical last row', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        const logical = logicalScrollTop(
            maxPhysical - (3 * RH), totalGridHeight, VH, RH, maxPhysical,
        );
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        expect(range.end).toBe(nrow);
        expect(logical).toBe(totalGridHeight + RH - VH);
    });

    test('bottom: explicit bottom drag reaches the logical last row even if physical scroll is shy', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        const logical = logicalScrollTop(
            maxPhysical - (50 * RH), totalGridHeight, VH, RH, maxPhysical, true,
        );
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        expect(range.end).toBe(nrow);
        expect(logical).toBe(totalGridHeight + RH - VH);
    });

    test('bottom: browser-clamped scroll event preserves explicit custom-thumb bottom intent', () => {
        const chromiumClamp = maxPhysical * 0.932;
        expect(shouldForceLogicalBottomAfterScroll({
            scrollTop: chromiumClamp,
            maxPhysical,
            rowHeight: RH,
            previousForceBottom: true,
            pendingBottomIntent: true,
        })).toBe(true);
    });

    test('bottom: ordinary upward scroll clears prior bottom intent', () => {
        const notNearBottom = maxPhysical * 0.932;
        expect(shouldForceLogicalBottomAfterScroll({
            scrollTop: notNearBottom,
            maxPhysical,
            rowHeight: RH,
            previousForceBottom: true,
            pendingBottomIntent: false,
        })).toBe(false);
    });

    test('bottom: measured DOM max below model max still reaches the last row', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        const measuredMaxPhysical = maxPhysical * 0.932;
        const logical = logicalScrollTop(
            measuredMaxPhysical, totalGridHeight, VH, RH, measuredMaxPhysical,
        );
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        expect(range.end).toBe(nrow);
        expect(visualOffsetPx(
            range.start * RH, totalGridHeight, VH, RH, measuredMaxPhysical,
        )).toBeLessThanOrEqual(measuredMaxPhysical);
    });

    test('visualRowsOffsetPx: bottom window keeps the last row on screen', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        const measuredMaxPhysical = maxPhysical * 0.932;
        const logical = logicalScrollTop(
            measuredMaxPhysical, totalGridHeight, VH, RH, measuredMaxPhysical,
        );
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        const renderedRowsHeight = (range.end - range.start) * RH;
        const rowsTop = HEADER_ROW_PX + visualRowsOffsetPx(
            range.start * RH,
            renderedRowsHeight,
            totalGridHeight,
            VH,
            RH,
            measuredMaxPhysical,
        ) - measuredMaxPhysical;

        expect(rowsTop + renderedRowsHeight).toBeLessThanOrEqual(VH);
        expect(rowsTop + renderedRowsHeight).toBeGreaterThanOrEqual(VH - 1);
    });

    test('logicalScrollTop: clamps overshoot above maxPhysical to maxLogical (large)', () => {
        // macOS rubber-band can briefly push scrollTop above maxPhysical.
        // Without the clamp, the scaled value exceeds maxLogical and
        // visibleRange would return an empty window.
        expect(logicalScrollTop(maxPhysical * 1.1, LARGE, VH, RH))
            .toBe(maxLogicalLarge);
    });

    test('logicalScrollTop: clamps negative scrollTop to 0 (large)', () => {
        // Defensive: Chromium shouldn't report negative scrollTop, but the
        // clamp removes the assumption.
        expect(logicalScrollTop(-50, LARGE, VH, RH)).toBe(0);
    });

    test('logicalScrollTop: clamps negative scrollTop to 0 (small)', () => {
        // The small-data fast path also clamps now, so a stray negative
        // scrollTop never propagates to visibleRange's floor() math.
        expect(logicalScrollTop(-50, SMALL, VH, RH)).toBe(0);
    });

    test('logicalScrollTop: clamps positive overshoot in small data to maxLogicalSmall', () => {
        // The small-data branch also clamps overshoot. macOS rubber-band
        // can briefly push scrollTop above maxLogicalSmall; without the
        // clamp, visibleRange would read past the end of the dataset.
        const maxLogicalSmall = SMALL + RH - VH;
        expect(logicalScrollTop(maxLogicalSmall * 1.1, SMALL, VH, RH))
            .toBe(maxLogicalSmall);
    });

    test('visibleRange after clamped overshoot still includes the last row', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        // Simulate rubber-band overshoot: scrollTop 10% past maxPhysical.
        const logical = logicalScrollTop(maxPhysical * 1.1, totalGridHeight, VH, RH);
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        // Without the clamp, logical exceeds maxLogical, range.start exceeds
        // nrow, and range.end (clamped at nrow) ends up < range.start — an
        // empty window that blanks the grid. The clamp keeps start < end.
        expect(range.start).toBeLessThan(range.end);
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
    test('float column with integer-valued cell skips toFixed (Format on)', () => {
        // Many SPSS/SAS files store integer-valued data as Float64; we
        // don't want to render "5" as "5.000".
        expect(formatCell(5, floatCol, undefined, false, true, 3))
            .toEqual({ text: '5', missing: false });
    });
    test('float column with negative integer-valued cell skips toFixed', () => {
        expect(formatCell(-42, floatCol, undefined, false, true, 3))
            .toEqual({ text: '-42', missing: false });
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

describe('custom scrollbar math', () => {
    const VH = 600;
    const RH = 24;
    const TRACK = VH - HORIZONTAL_GUTTER_PX;  // 588

    test('customThumbHeight: tiny dataset → full track', () => {
        // 5 rows fit in the track many times over → thumb fills track.
        expect(customThumbHeight(TRACK, RH, 5)).toBe(TRACK);
    });
    test('customThumbHeight: large dataset → MIN_THUMB_PX floor', () => {
        // 10M rows on 600 px viewport: proportional thumb ≈ 0.0015 px.
        // Clamped up to MIN_THUMB_PX.
        expect(customThumbHeight(TRACK, RH, 10_000_000)).toBe(MIN_THUMB_PX);
    });
    test('customThumbHeight: mid-size proportional', () => {
        // 100 rows: visibleCount = ceil(588/24) = 25.
        // proportional = 588 * (25/100) = 147. Above MIN_THUMB.
        expect(customThumbHeight(TRACK, RH, 100)).toBeCloseTo(147);
    });
    test('customThumbHeight: nrow === 0 → full track', () => {
        expect(customThumbHeight(TRACK, RH, 0)).toBe(TRACK);
    });
    test('customThumbHeight: rowHeight === 0 → full track', () => {
        expect(customThumbHeight(TRACK, 0, 1000)).toBe(TRACK);
    });
    test('customThumbHeight: trackHeight === 0 → 0', () => {
        expect(customThumbHeight(0, RH, 1000)).toBe(0);
    });
    test('customThumbHeight: trackHeight < MIN_THUMB_PX → trackHeight', () => {
        // 20-px track gets a 20-px thumb, not a 30-px overflowing one.
        expect(customThumbHeight(20, RH, 10_000_000)).toBe(20);
    });

    test('customThumbTop: scrollTop=0 → 0', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        expect(customThumbTop(0, TRACK, th, 14_999_424)).toBe(0);
    });
    test('customThumbTop: scrollTop=maxPhysical → trackHeight - thumbHeight', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        const maxPhysical = 14_999_424;
        expect(customThumbTop(maxPhysical, TRACK, th, maxPhysical))
            .toBeCloseTo(TRACK - th);
    });
    test('customThumbTop: midpoint → midpoint', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        const maxPhysical = 14_999_424;
        expect(customThumbTop(maxPhysical / 2, TRACK, th, maxPhysical))
            .toBeCloseTo((TRACK - th) / 2);
    });
    test('customThumbTop: maxPhysical <= 0 → 0', () => {
        expect(customThumbTop(100, TRACK, MIN_THUMB_PX, 0)).toBe(0);
        expect(customThumbTop(100, TRACK, MIN_THUMB_PX, -10)).toBe(0);
    });
    test('customThumbTop: thumbHeight >= trackHeight → 0', () => {
        // Whole track is thumb; nothing to scroll.
        expect(customThumbTop(100, TRACK, TRACK, 14_999_424)).toBe(0);
    });

    test('customScrollTopFromThumbTop: thumbTop=0 → 0', () => {
        expect(customScrollTopFromThumbTop(0, TRACK, MIN_THUMB_PX, 14_999_424))
            .toBe(0);
    });
    test('customScrollTopFromThumbTop: thumbTop=trackUsable → maxPhysical', () => {
        const th = MIN_THUMB_PX;
        const maxPhysical = 14_999_424;
        expect(customScrollTopFromThumbTop(TRACK - th, TRACK, th, maxPhysical))
            .toBeCloseTo(maxPhysical);
    });
    test('customScrollTopFromThumbTop: round-trip with customThumbTop', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        const maxPhysical = 14_999_424;
        for (const scrollTop of [0, 1234, maxPhysical / 3, maxPhysical / 2,
                                 maxPhysical * 0.99, maxPhysical]) {
            const top = customThumbTop(scrollTop, TRACK, th, maxPhysical);
            const back = customScrollTopFromThumbTop(top, TRACK, th, maxPhysical);
            expect(back).toBeCloseTo(scrollTop);
        }
    });
    test('customScrollTopFromThumbTop: maxPhysical <= 0 → 0', () => {
        expect(customScrollTopFromThumbTop(100, TRACK, MIN_THUMB_PX, 0)).toBe(0);
    });
    test('customScrollTopFromThumbTop: trackUsable <= 0 → 0', () => {
        expect(customScrollTopFromThumbTop(100, TRACK, TRACK, 14_999_424)).toBe(0);
    });
});
