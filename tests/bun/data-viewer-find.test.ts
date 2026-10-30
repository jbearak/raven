// Find in grid (find.ts) through the in-process engine: displayed-text
// matching with Labels/Format, NA and NaN words, display-order positions
// under a permutation, refinement, and cancellation.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { LocalEngine } from '../../editors/vscode/src/data-viewer/engine';
import { findSourceRows, toDisplayPositions } from '../../editors/vscode/src/data-viewer/find';
import { formatCell } from '../../editors/vscode/src/data-viewer/display-format';

const FIX = (n: string) => join(__dirname, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);
const Q = { labelsOn: true, formatOn: true, digits: 3 };
const signal = () => new AbortController().signal;

describe('find', () => {
    test('matches displayed text, case-insensitively, across the given columns', async () => {
        const reader = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        const engine = new LocalEngine(reader);
        const got = await engine.find({ query: '99', columns: [0], ...Q }, undefined, signal());
        const want = [];
        for (let i = 1; i <= 1000; i++) if (String(i).includes('99')) want.push(i - 1);
        expect(Array.from(got)).toEqual(want);
        await reader.close();
    });

    test('NA and NaN cells match their displayed words; every match is what formatCell shows', async () => {
        const reader = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const engine = new LocalEngine(reader);
        const cols = reader.schema.columns.map((_, i) => i);
        const got = await engine.find({ query: 'na', columns: [1], ...Q }, undefined, signal());
        // y = [1.5, NA, NaN, Inf, -Inf]
        expect(Array.from(got)).toEqual([1, 2]);
        // Cross-check every column against formatCell for a few queries.
        const all = await reader.getRows({ start: 0, end: reader.nrow, columns: cols });
        for (const q of ['a', '2024-01-0', '1', 'e']) {
            const want: number[] = [];
            all.rows.forEach((row, r) => {
                if (row.some((cell, c) => formatCell(cell, reader.schema.columns[c], reader.schema.columns[c].dictionary, Q).text.toLowerCase().includes(q))) want.push(r);
            });
            const found = await engine.find({ query: q.toUpperCase(), columns: cols, ...Q }, undefined, signal());
            expect(Array.from(found)).toEqual(want);
        }
        await reader.close();
    });

    test('positions follow the permutation on screen', () => {
        const perm = new Uint32Array([4, 3, 2, 1, 0]);
        expect(Array.from(toDisplayPositions(new Uint32Array([0, 3]), perm, 5))).toEqual([1, 4]);
        // A filter's permutation drops rows that aren't shown.
        expect(Array.from(toDisplayPositions(new Uint32Array([0, 3]), new Uint32Array([3, 1]), 5))).toEqual([0]);
        expect(Array.from(toDisplayPositions(new Uint32Array([2]), undefined, 5))).toEqual([2]);
    });

    test('extending the query refines the previous matches, reading only their batches', async () => {
        const reader = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        const engine = new LocalEngine(reader);
        const first = await engine.find({ query: '5', columns: [0], ...Q }, undefined, signal());
        expect(first.length).toBeGreaterThan(100);
        const r = reader as any;
        const orig = r.getBatch.bind(r);
        let reads = 0;
        r.getBatch = (...a: any[]) => { reads++; return orig(...a); };
        const refined = await engine.find({ query: '555', columns: [0], ...Q }, undefined, signal());
        expect(Array.from(refined)).toEqual([554]);
        // Every batch holds a "5" match, so all 10 are read once.
        const direct = await findSourceRows(reader, { query: '555', columns: [0], ...Q }, undefined);
        expect(Array.from(direct)).toEqual([554]);
        expect(reads).toBe(20);
        // A different query (not an extension) searches everything again.
        reads = 0;
        const other = await engine.find({ query: '12', columns: [0], ...Q }, undefined, signal());
        expect(other.length).toBeGreaterThan(0);
        expect(reads).toBe(10);
        await reader.close();
    });

    test('refinement narrows the candidate set: batches without candidates are skipped', async () => {
        const reader = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        const r = reader as any;
        const orig = r.getBatch.bind(r);
        let reads = 0;
        r.getBatch = (...a: any[]) => { reads++; return orig(...a); };
        const within = new Uint32Array([5, 950]);
        const got = await findSourceRows(reader, { query: '6', columns: [0], ...Q }, within);
        expect(Array.from(got)).toEqual([5]);
        expect(reads).toBe(2);
        await reader.close();
    });

    test('a cancelled find rejects with an abort', async () => {
        const reader = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        const engine = new LocalEngine(reader);
        const ac = new AbortController();
        ac.abort();
        await expect(engine.find({ query: '1', columns: [0], ...Q }, undefined, ac.signal)).rejects.toThrow();
        await reader.close();
    });
});
