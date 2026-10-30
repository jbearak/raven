/**
 * Filters built from summaries agree with the summaries: brushing
 * histogram bins filters to exactly the brushed bars' total (bins are
 * `[lo, hi)`, the last closed, via `numBetween.upperInclusive`), and
 * value counts / top-value bars build set filters whose row count is the
 * clicked values' count, for every column kind and both Labels states.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import { computeProfile, valueCountsFrom } from '../../editors/vscode/src/data-viewer/profile-engine';
import type { FilterPredicate } from '../../editors/vscode/src/data-viewer/messages';
import {
    brushedTotal,
    brushPredicate,
    setFilterFor,
} from '../../editors/vscode/src/data-viewer/webview/summary-model';
import { hash01, writeArrowFixture } from './_helpers/arrow-fixture-writer';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-brush-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const N = 30_000;
const PATH = join(DIR, 'brush.arrow');
writeArrowFixture(PATH, {
    nrow: N,
    chunkRows: 4096,
    columns: [
        // Integers landing exactly on bin edges (edges every 5 over 0..100).
        { name: 'ints', kind: 'int', gen: i => (hash01(i, 1) < 0.03 ? null : Math.floor(hash01(i, 2) * 101)) },
        // Decimals whose edges aren't representable exactly.
        { name: 'dec', kind: 'dbl', gen: i => (hash01(i, 3) < 0.02 ? NaN : Math.round(hash01(i, 4) * 1000) / 10 - 3.3) },
        { name: 'fct', kind: 'fct', levels: ['lo', 'mid', 'hi', 'never'], gen: i => (hash01(i, 5) < 0.05 ? null : Math.floor(hash01(i, 6) ** 2 * 3)) },
        { name: 'chr', kind: 'chr', gen: i => (hash01(i, 7) < 0.05 ? null : `w${Math.floor(hash01(i, 8) * 12)}`) },
        { name: 'lgl', kind: 'lgl', gen: i => (hash01(i, 9) < 0.1 ? null : hash01(i, 10) < 0.4) },
        {
            name: 'lab', kind: 'dbl', gen: i => (hash01(i, 11) < 0.05 ? null : 1 + Math.floor(hash01(i, 12) * 3)),
            fieldMd: { 'raven.value_labels': JSON.stringify({ 1: 'one', 2: 'two', 3: 'three' }) },
        },
        { name: 'day', kind: 'date', gen: i => 19_000 + Math.floor(hash01(i, 13) * 20) },
    ],
});

async function count(reader: ArrowSliceReader, columnIndex: number, predicate: FilterPredicate, labelsOn = true): Promise<number> {
    const rows = await computeFilteredIndices(reader, {
        entries: [{ id: 't', columnIndex, predicate, enabled: true, includeMissing: false }],
        labelsOnWhenFiltered: labelsOn,
    }, { labelsOn, formatOn: true, digits: 3 });
    return rows?.length ?? reader.nrow;
}

describe('brushing', () => {
    test.each([0, 1])('column %p: every single bin and many ranges filter to the brushed total', async ci => {
        const reader = await ArrowSliceReader.open(PATH);
        const { profile } = await computeProfile(reader, ci);
        const bins = profile.histogram!;
        expect(bins.length).toBe(20);
        const last = bins.length - 1;
        const ranges: [number, number][] = [];
        for (let i = 0; i <= last; i++) ranges.push([i, i]);
        ranges.push([0, last], [3, 7], [12, last], [last, 15], [0, 0], [1, 2]);
        for (const [a, b] of ranges) {
            const p = brushPredicate(bins, a, b);
            expect(await count(reader, ci, p)).toBe(brushedTotal(bins, a, b));
        }
        await reader.close();
    });

    test('the last bin is closed; the others are half-open', () => {
        const bins = [{ lo: 0, hi: 1, count: 1 }, { lo: 1, hi: 2, count: 1 }];
        expect(brushPredicate(bins, 0, 0)).toEqual({ kind: 'numBetween', lo: 0, hi: 1, inclusive: true, upperInclusive: false });
        expect(brushPredicate(bins, 1, 0)).toEqual({ kind: 'numBetween', lo: 0, hi: 2, inclusive: true, upperInclusive: true });
    });

    test('upperInclusive overrides only the upper bound', async () => {
        const reader = await ArrowSliceReader.open(PATH);
        const both = await count(reader, 0, { kind: 'numBetween', lo: 10, hi: 20, inclusive: true });
        const halfOpen = await count(reader, 0, { kind: 'numBetween', lo: 10, hi: 20, inclusive: true, upperInclusive: false });
        const openClosed = await count(reader, 0, { kind: 'numBetween', lo: 10, hi: 20, inclusive: false, upperInclusive: true });
        const at20 = await count(reader, 0, { kind: 'numCompare', op: '=', value: 20 });
        const at10 = await count(reader, 0, { kind: 'numCompare', op: '=', value: 10 });
        expect(halfOpen).toBe(both - at20);
        expect(openClosed).toBe(both - at10);
        await reader.close();
    });
});

describe('set filters from value counts', () => {
    test.each([
        [2, true], [2, false], [3, true], [4, true], [5, true], [5, false], [6, true],
    ] as const)('column %p (labels %p): the filtered count is the clicked values\' total', async (ci, labelsOn) => {
        const reader = await ArrowSliceReader.open(PATH);
        const { profile, counts } = await computeProfile(reader, ci);
        const vc = valueCountsFrom(counts!, 'desc', 100);
        const col = reader.schema.columns[ci];
        const picks = ci === 6 ? [vc.entries[0]] : [vc.entries[0], vc.entries[vc.entries.length - 1]];
        const p = setFilterFor(col, profile.kind, picks, labelsOn)!;
        expect(p).toBeDefined();
        const expected = picks.reduce((a, e) => a + e.count, 0);
        expect(await count(reader, ci, p, labelsOn)).toBe(expected);
        await reader.close();
    });
});
