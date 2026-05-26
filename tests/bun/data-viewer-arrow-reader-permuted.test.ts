/**
 * ArrowSliceReader.getRows with an active permutation.
 *
 * The "permuted path" indexes start..end into the permutation array,
 * fetches the underlying rows it points at, and returns them in
 * visible (sorted) order along with the original 0-based row indices.
 */

import { describe, test, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computePermutation } from '../../editors/vscode/src/data-viewer/sort';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

describe('getRows with permutation: tiny fixture', () => {
    test('identity permutation returns rows in original order', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const perm = new Uint32Array([0, 1, 2, 3, 4]);
        const out = await r.getRows({
            start: 0, end: 5, columns: [0], viewportGeneration: 1, permutation: perm,
        });
        expect(out.rows.map(r => r[0])).toEqual([1, 2, 3, 4, 5]);
        expect(out.originalRowIndices).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });

    test('reversed permutation returns rows in reverse', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const perm = new Uint32Array([4, 3, 2, 1, 0]);
        const out = await r.getRows({
            start: 0, end: 5, columns: [0], viewportGeneration: 1, permutation: perm,
        });
        expect(out.rows.map(r => r[0])).toEqual([5, 4, 3, 2, 1]);
        expect(out.originalRowIndices).toEqual([4, 3, 2, 1, 0]);
        await r.close();
    });

    test('windowed read into the middle of the permutation', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const perm = new Uint32Array([2, 0, 4, 1, 3]);
        const out = await r.getRows({
            start: 1, end: 4, columns: [0], viewportGeneration: 1, permutation: perm,
        });
        // perm[1..4] = [0, 4, 1] → x values [1, 5, 2]
        expect(out.rows.map(r => r[0])).toEqual([1, 5, 2]);
        expect(out.originalRowIndices).toEqual([0, 4, 1]);
        await r.close();
    });

    test('end-to-end: permutation from sort engine matches sorted-cell order', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // y = [1.5, NA, NaN, +Inf, -Inf]
        const perm = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'asc' }],
            { labelsOn: true, formatOn: true, digits: 3 },
        );
        const out = await r.getRows({
            start: 0, end: 5, columns: [0, 1], viewportGeneration: 1, permutation: perm,
        });
        // Asc puts -Inf first, then 1.5, +Inf, then [NA, NaN] in original order.
        expect(out.originalRowIndices).toEqual([4, 0, 3, 1, 2]);
        // x column values follow the same row order: [5, 1, 4, 2, 3]
        expect(out.rows.map(r => r[0])).toEqual([5, 1, 4, 2, 3]);
        await r.close();
    });
});

describe('getRows with permutation: multibatch (random access across batches)', () => {
    test('non-monotone permutation pulls rows from multiple batches', async () => {
        const r = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        // Hand-crafted: row 999 (batch 9), row 0 (batch 0), row 500 (batch 5).
        const perm = new Uint32Array(1000);
        for (let i = 0; i < 1000; i++) perm[i] = i;
        // Swap perm[0]=999, perm[999]=0; leave the rest identity.
        perm[0] = 999;
        perm[999] = 0;

        const loaded: number[] = [];
        r.onBatchLoad = i => loaded.push(i);

        const out = await r.getRows({
            start: 0, end: 1, columns: [0], viewportGeneration: 1, permutation: perm,
        });
        // perm[0] = 999 → i value 1000 → resolves to row 999 in batch 9.
        expect(out.rows[0][0]).toBe(1000);
        expect(out.originalRowIndices).toEqual([999]);
        // Reads only the one batch that contains row 999.
        expect(loaded).toEqual([9]);
        await r.close();
    });

    test('batch LRU absorbs the same batch read once per window', async () => {
        const r = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        // Permutation that pulls rows alternately from batches 0 and 9
        // — each batch should be loaded once, not once per row.
        const perm = new Uint32Array([0, 999, 1, 998, 2, 997]);

        const loaded: number[] = [];
        r.onBatchLoad = i => loaded.push(i);

        await r.getRows({
            start: 0, end: 6, columns: [0], viewportGeneration: 1, permutation: perm,
        });
        // Each unique batch loaded exactly once: batch 0 and batch 9.
        const unique = [...new Set(loaded)].sort();
        expect(unique).toEqual([0, 9]);
        expect(loaded.length).toBe(2);
        await r.close();
    });

    test('stale viewportGeneration short-circuits permuted read too', async () => {
        const r = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        r.setLatestViewportGeneration(10);
        const perm = new Uint32Array([0, 1, 2]);
        const out = await r.getRows({
            start: 0, end: 3, columns: [0], viewportGeneration: 5, permutation: perm,
        });
        expect(out.stale).toBe(true);
        expect(out.rows).toEqual([]);
        await r.close();
    });
});

describe('getRows without permutation: backwards compatibility', () => {
    test('omitting permutation preserves existing behavior (no originalRowIndices)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const out = await r.getRows({
            start: 0, end: 3, columns: [0], viewportGeneration: 1,
        });
        expect(out.rows.map(r => r[0])).toEqual([1, 2, 3]);
        expect(out.originalRowIndices).toBeUndefined();
        await r.close();
    });
});
