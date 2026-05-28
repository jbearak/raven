import { describe, test, expect } from 'bun:test';
import {
    shouldWrap,
    WRAP_HYSTERESIS_PX,
} from '../../editors/vscode/src/data-viewer/webview/use-toolbar-wrap';

const parts = (lead: number, chips: number, actions: number) => ({
    leadPx: lead,
    chipsPx: chips,
    actionsPx: actions,
});

const GAP = 8;

describe('data-viewer shouldWrap', () => {
    test('does not wrap when content fits within the available width', () => {
        // 80 + 200 + 200 + 2*8 = 496 <= 800
        expect(shouldWrap(parts(80, 200, 200), 800, GAP, false)).toBe(false);
    });

    test('wraps when content exceeds the available width', () => {
        // 80 + 600 + 200 + 2*8 = 896 > 800
        expect(shouldWrap(parts(80, 600, 200), 800, GAP, false)).toBe(true);
    });

    test('does not wrap when content fits exactly', () => {
        // 100 + 100 + 100 + 2*8 = 316; available 316 -> not greater
        expect(shouldWrap(parts(100, 100, 100), 316, GAP, false)).toBe(false);
    });

    test('wraps when content overflows by a single pixel', () => {
        // needed 316, available 315
        expect(shouldWrap(parts(100, 100, 100), 315, GAP, false)).toBe(true);
    });

    test('never wraps when there are no chips, even on a tiny width', () => {
        // Wrapping an empty chip group cannot relieve a row-1 overflow.
        expect(shouldWrap(parts(80, 0, 200), 50, GAP, false)).toBe(false);
        expect(shouldWrap(parts(80, 0, 200), 50, GAP, true)).toBe(false);
    });

    test('counts only one gap when the lead is absent', () => {
        // chips 300 + actions 300 + 1*8 = 608 > 600
        expect(shouldWrap(parts(0, 300, 300), 600, GAP, false)).toBe(true);
        // chips 296 + actions 296 + 1*8 = 600 -> not greater
        expect(shouldWrap(parts(0, 296, 296), 600, GAP, false)).toBe(false);
    });

    describe('hysteresis', () => {
        // needed = 80 + 500 + 200 + 2*8 = 796
        const near = parts(80, 500, 200);

        test('stays wrapped within the hysteresis band', () => {
            // available 800: needed 796 is below available but within
            // the 8px band, so a currently-wrapped toolbar stays wrapped.
            expect(WRAP_HYSTERESIS_PX).toBeGreaterThan(0);
            expect(shouldWrap(near, 800, GAP, true)).toBe(true);
        });

        test('stays unwrapped within the hysteresis band', () => {
            // Same geometry, but currently unwrapped: 796 <= 800 so it
            // does not wrap. The band makes the state sticky.
            expect(shouldWrap(near, 800, GAP, false)).toBe(false);
        });

        test('unwraps once content shrinks below the band', () => {
            // needed 796, available 810: 796 <= 810 - 8 (=802) -> unwrap
            expect(shouldWrap(near, 810, GAP, true)).toBe(false);
        });
    });
});
