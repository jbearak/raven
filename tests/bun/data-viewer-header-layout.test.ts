// Canvas header layout (header-layout.ts): slot metrics, the accessible
// name that mirrors what is drawn, tooltip lines, and the missing share.
import { describe, expect, test } from 'bun:test';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import {
    formatMissingShare,
    headerAccessibleName,
    headerMetrics,
    headerTooltipLines,
    inSortSlot,
    MISSING_BAR_PX,
    SORT_SLOT_PX,
} from '../../editors/vscode/src/data-viewer/webview/header-layout';
import { prependRowNumbers } from '../../editors/vscode/src/data-viewer/tsv';

const mpg: ColumnSchema = {
    name: 'mpg', arrowType: 'Float64', isInteger: false, dictionaryShipped: false,
    typeTag: '<dbl>', variableLabel: 'Miles per gallon', originalClass: 'numeric', format: '%9.2f',
};

describe('headerMetrics', () => {
    test('the label line exists only when some column has a label', () => {
        const without = headerMetrics(13, false);
        const withLabels = headerMetrics(13, true);
        expect(without.labelY).toBeUndefined();
        expect(withLabels.labelY).toBeGreaterThan(withLabels.tagY);
        expect(withLabels.height).toBeGreaterThan(without.height);
        expect(withLabels.tagY).toBeGreaterThan(withLabels.nameY);
    });
    test('slots scale with the editor font size and leave room for the missing bar', () => {
        const small = headerMetrics(12, false);
        const large = headerMetrics(18, false);
        expect(large.height).toBeGreaterThan(small.height);
        expect(small.tagFontPx).toBe(Math.round(12 * 0.85));
        expect(small.height - small.tagY).toBeGreaterThan(MISSING_BAR_PX);
    });
    test('the sort slot is a reserved band at the right edge', () => {
        const rect = { x: 100, y: 0, width: 120, height: 40 };
        expect(inSortSlot(rect, 220 - SORT_SLOT_PX / 2)).toBe(true);
        expect(inSortSlot(rect, 110)).toBe(false);
    });
});

describe('accessible name and tooltip', () => {
    test('name, type, label, NA share, sort direction and priority', () => {
        expect(headerAccessibleName(mpg, { direction: 'asc', priority: 2 }, true, { count: 4, total: 32 }))
            .toBe('mpg, double, Miles per gallon, 13% missing, sorted ascending, priority 2');
        expect(headerAccessibleName({ ...mpg, variableLabel: undefined }, undefined, false, undefined))
            .toBe('mpg, double');
    });
    test('a partial count is never announced as a share', () => {
        expect(formatMissingShare({ count: 3, total: 32, partial: true })).toBeUndefined();
        expect(formatMissingShare({ count: 0, total: 32 })).toBe('0% missing');
        expect(formatMissingShare({ count: 1, total: 1000 })).toBe('<1% missing');
        expect(formatMissingShare({ count: 999, total: 1000 })).toBe('>99% missing');
    });
    test('tooltip lists name and tag, label, class, display format, NA, value labels', () => {
        const lines = headerTooltipLines(
            { ...mpg, valueLabels: { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f' } },
            { count: 4, total: 32 },
        );
        expect(lines).toEqual([
            'mpg  <dbl>',
            'Miles per gallon',
            'class: numeric',
            'display format: %9.2f',
            'NA: 4 (13% missing)',
            'value labels: 1 = a; 2 = b; 3 = c; 4 = d; 5 = e; … 1 more',
        ]);
        expect(headerTooltipLines(mpg, undefined)).toContain('NA: counting…');
        expect(headerTooltipLines(mpg, { count: 2, total: 32, partial: true })).toContain('NA: at least 2 (counting…)');
    });
});

describe('copy with row names (no rowname column)', () => {
    test('prepends R row numbers from the permutation, or the position', () => {
        expect(prependRowNumbers('a\t1\nb\t2', 10, undefined, false)).toBe('11\ta\t1\n12\tb\t2');
        expect(prependRowNumbers('x\ty\na\t1\nb\t2', 0, [7, 3], true)).toBe('\tx\ty\n8\ta\t1\n4\tb\t2');
    });
});
