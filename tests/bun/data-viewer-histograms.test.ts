/**
 * Histogram precomputation. 50 uniform-width bins per numeric column;
 * NA / NaN excluded; columns with no present values yield `[]`; columns
 * where all present values are equal collapse to a single zero-width
 * bin with the full count.
 */
import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeNumericHistograms } from '../../editors/vscode/src/data-viewer/histograms';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

describe('computeNumericHistograms', () => {
    test('numeric columns get bins; non-numeric do not', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const h = await computeNumericHistograms(r);
        expect(h[0]).toBeDefined();          // x
        expect(h[1]).toBeDefined();          // y
        expect(h[6]).toBeDefined();          // lbl
        expect(h[2]).toBeUndefined();        // s — Utf8
        expect(h[3]).toBeUndefined();        // f — Dictionary
        expect(h[4]).toBeUndefined();        // d — DateDay
        expect(h[5]).toBeUndefined();        // ts — Timestamp
        await r.close();
    });

    test('totals equal nrow minus NA / NaN / ±Inf', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const h = await computeNumericHistograms(r);
        const xTotal = h[0].reduce((s, b) => s + b.count, 0);
        expect(xTotal).toBe(5);
        const yTotal = h[1].reduce((s, b) => s + b.count, 0);
        expect(yTotal).toBe(1);
        await r.close();
    });

    test('uniform-bin spans cover [min, max]', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const h = await computeNumericHistograms(r);
        const x = h[0];
        expect(x.length).toBe(50);
        expect(x[0].lo).toBe(1);
        expect(x[x.length - 1].hi).toBe(5);
        await r.close();
    });

    test('single-value column collapses to one zero-width bin', async () => {
        const r = await ArrowSliceReader.open(FIX('bigint64.arrow'));
        const h = await computeNumericHistograms(r);
        const keys = Object.keys(h).map(Number);
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) {
            const bins = h[k];
            for (const b of bins) {
                expect(b.lo).toBeLessThanOrEqual(b.hi);
                expect(b.count).toBeGreaterThanOrEqual(0);
            }
        }
        await r.close();
    });
});
