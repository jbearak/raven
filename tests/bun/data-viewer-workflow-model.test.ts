// Go-to-row parsing, the find count, and the status line's selection
// summary (webview/workflow-model.ts).
import { describe, expect, test } from 'bun:test';
import {
    describeFindCount,
    describeSelection,
    formatStat,
    parseRowTarget,
    SELECTION_SUMMARY_MAX_CELLS,
    summarizeSelection,
} from '../../editors/vscode/src/data-viewer/webview/workflow-model';
import type { Cell } from '../../editors/vscode/src/data-viewer/wire-format';

describe('parseRowTarget', () => {
    test('a bare number is an R row number; # makes it a display position', () => {
        expect(parseRowTarget('120')).toEqual({ kind: 'rowNumber', n: 120 });
        expect(parseRowTarget(' 1,200 ')).toEqual({ kind: 'rowNumber', n: 1200 });
        expect(parseRowTarget('#5')).toEqual({ kind: 'position', n: 5 });
        expect(parseRowTarget('# 7')).toEqual({ kind: 'position', n: 7 });
    });
    test('zero, negatives, decimals and text are rejected', () => {
        for (const bad of ['', '0', '#0', '-3', '2.5', 'abc', '#', '1e3']) expect(parseRowTarget(bad)).toBeNull();
    });
});

describe('describeFindCount', () => {
    test('states', () => {
        expect(describeFindCount({ searching: true })).toBe('Searching…');
        expect(describeFindCount({ searching: false })).toBe('');
        expect(describeFindCount({ searching: false, count: 0, index: -1 })).toBe('No matches');
        expect(describeFindCount({ searching: false, count: 1234, index: 2 })).toBe('3 of 1,234');
        expect(describeFindCount({ searching: false, count: 5, index: -1 })).toBe('5 matches');
        expect(describeFindCount({ searching: false, error: 'boom' })).toBe('boom');
    });
});

describe('summarizeSelection', () => {
    const grid: Record<string, Cell> = {
        '1,0': 1.5, '1,1': null, '1,2': { _: 'nan' }, '1,3': 4,
        '2,0': 10, '2,1': 20, '2,2': 30, '2,3': 40,
        '3,0': 'a', '3,1': 'b', '3,2': 'c', '3,3': 'd',
    };
    const at = (c: number, r: number) => grid[`${c},${r}`];
    test('numeric cells: count, NA (NaN included), sum; text columns only count', () => {
        const s = summarizeSelection({ start: 0, end: 4 }, [1, 2, 3], c => c !== 3, at);
        expect(s).toEqual({ cells: 12, numeric: { count: 6, na: 2, sum: 105.5 } });
        expect(describeSelection(s, formatStat)).toBe('12 cells · 2 NA · Σ 105.5 · mean 17.5833');
    });
    test('an unloaded cell, or a selection past the cap, shows the count only', () => {
        expect(summarizeSelection({ start: 0, end: 5 }, [1], () => true, at)).toEqual({ cells: 5 });
        const big = summarizeSelection({ start: 0, end: SELECTION_SUMMARY_MAX_CELLS + 1 }, [1], () => true, () => 1);
        expect(big).toEqual({ cells: SELECTION_SUMMARY_MAX_CELLS + 1 });
        expect(describeSelection(big, formatStat)).toBe('100,001 cells');
    });
    test('a single cell says nothing', () => {
        expect(describeSelection(summarizeSelection({ start: 0, end: 1 }, [2], () => true, at), formatStat)).toBe('');
    });
});

describe('formatStat', () => {
    test('compact, with scientific at the extremes', () => {
        expect(formatStat(120.4)).toBe('120.4');
        expect(formatStat(20.066666)).toBe('20.0667');
        expect(formatStat(1234567.891)).toBe('1,234,567.89');
        expect(formatStat(1e-7)).toBe('1e-7');
        expect(formatStat(-Infinity)).toBe('-Inf');
    });
});
