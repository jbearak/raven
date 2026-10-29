// Projected reads, element gather, batch geometry, null counts, and the
// byte-bounded caches of ArrowSliceReader (design F2). Every read path is
// checked cell by cell against decoding whole batches with apache-arrow's
// own reader and `encodeArrowCell`, which is what the reader did before
// projection.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordBatchFileReader } from 'apache-arrow';
import {
    ArrowSliceReader,
    encodeArrowCell,
} from '../../editors/vscode/src/data-viewer/arrow-reader';
import { iterateBatches } from '../../editors/vscode/src/data-viewer/batch-iter';
import type { Cell } from '../../editors/vscode/src/data-viewer/wire-format';
import { hash01, writeArrowFixture } from './_helpers/arrow-fixture-writer';
import type { ColumnSpec } from './_helpers/arrow-fixture-writer';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-projected-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const LEVELS = ['low', 'mid', 'high'];
const BIG_LEVELS = Array.from({ length: 300 }, (_, i) => `lvl${i}`);

/** Every column kind the R writer emits, with NAs, NaN, ±Inf, empty and
 *  long and non-ASCII strings, and an all-valid column (no validity
 *  buffer). */
function allTypes(): ColumnSpec[] {
    return [
        { name: 'i', kind: 'int', gen: i => (i % 11 === 3 ? null : i - 500) },
        {
            name: 'd', kind: 'dbl', gen: i => {
                if (i % 13 === 1) return null;
                if (i % 17 === 2) return NaN;
                if (i === 5) return Infinity;
                if (i === 6) return -Infinity;
                return (i * 1.25) - 300;
            },
        },
        { name: 'dense', kind: 'dbl', gen: i => i / 3 },
        {
            name: 's', kind: 'chr', gen: i => {
                if (i % 7 === 0) return null;
                if (i % 29 === 1) return '';
                if (i % 31 === 2) return 'ü'.repeat(700);   // 1,400 bytes > truncation limit
                if (i % 37 === 3) return `日本-${i}`;
                return `s${i}`;
            },
        },
        { name: 'b', kind: 'lgl', gen: i => (i % 5 === 0 ? null : i % 3 === 0) },
        { name: 'f', kind: 'fct', levels: LEVELS, gen: i => (i % 9 === 4 ? null : i % 3) },
        { name: 'o', kind: 'fct', levels: BIG_LEVELS, ordered: true, gen: i => (i % 10 === 0 ? null : i % 300) },
        { name: 'dt', kind: 'date', gen: i => (i % 8 === 0 ? null : 19_000 + i - 400) },
        {
            name: 'ts', kind: 'dttm', tz: 'America/New_York',
            gen: i => (i % 6 === 0 ? null : BigInt(1_700_000_000_000_000 + i * 1_234_567) - 900_000_000_000n),
        },
    ];
}

/** Reference: decode every batch whole and encode with encodeArrowCell. */
function referenceCells(path: string): { cells: Cell[][]; nulls: number[] } {
    const r = RecordBatchFileReader.from(readFileSync(path)) as any;
    r.open();
    const fields = r.schema.fields;
    const cells: Cell[][] = [];
    const nulls = new Array(fields.length).fill(0);
    for (let bi = 0; bi < r.numRecordBatches; bi++) {
        const b = r.readRecordBatch(bi);
        for (let row = 0; row < b.numRows; row++) {
            cells.push(fields.map((f: any, c: number) => {
                const t = String(f.type);
                const tz = t.startsWith('Timestamp') ? (f.type.timezone ?? 'UTC') : 'UTC';
                return encodeArrowCell(b.getChildAt(c), row, t, tz);
            }));
        }
        fields.forEach((_: any, c: number) => { nulls[c] += b.getChildAt(c).nullCount; });
    }
    return { cells, nulls };
}

let seq = 0;
function fixture(opts: Parameters<typeof writeArrowFixture>[1]): string {
    const p = join(DIR, `f${seq++}.arrow`);
    writeArrowFixture(p, opts);
    return p;
}

const ALL_COLS = allTypes().map((_, i) => i);

describe('batch geometry', () => {
    test('arithmetic from raven.nrow / raven.chunk_rows when both checks pass', async () => {
        const p = fixture({ nrow: 2_500, chunkRows: 1_000, columns: allTypes() });
        const r = await ArrowSliceReader.open(p);
        expect(r.geometrySource).toBe('metadata');
        expect(r.nrow).toBe(2_500);
        expect(Array.from(r.batchStarts)).toEqual([0, 1_000, 2_000, 2_500]);
        expect(r.projectable).toBe(true);
        await r.close();
    });

    test('falls back to parsing headers when metadata is missing', async () => {
        const p = fixture({
            nrow: 2_500, chunkRows: 1_000, columns: allTypes(),
            schemaMd: { 'raven.nrow': null, 'raven.chunk_rows': null },
        });
        const r = await ArrowSliceReader.open(p);
        expect(r.geometrySource).toBe('headers');
        expect(Array.from(r.batchStarts)).toEqual([0, 1_000, 2_000, 2_500]);
        await r.close();
    });

    test('irregular batches fail the block-count check and fall back to headers', async () => {
        // Same block count as ceil(2500/1000) but split 1000/700/800: the
        // last-batch length check catches it.
        const p = fixture({
            nrow: 2_500, chunkRows: 1_000, columns: allTypes(), batchLengths: [1_000, 700, 800],
        });
        const r = await ArrowSliceReader.open(p);
        expect(r.geometrySource).toBe('headers');
        expect(Array.from(r.batchStarts)).toEqual([0, 1_000, 1_700, 2_500]);
        const ref = referenceCells(p).cells;
        const out = await r.getRows({ start: 0, end: 2_500, columns: ALL_COLS, viewportGeneration: 1 });
        expect(out.rows).toEqual(ref);
        await r.close();
    });

    test('a block count that disagrees with the metadata falls back to headers', async () => {
        const p = fixture({
            nrow: 2_500, chunkRows: 1_000, columns: allTypes(), batchLengths: [500, 500, 500, 500, 500],
        });
        const r = await ArrowSliceReader.open(p);
        expect(r.geometrySource).toBe('headers');
        expect(r.batchStarts.length).toBe(6);
        await r.close();
    });

    test('open does not decode any record batch', async () => {
        const p = fixture({ nrow: 5_000, chunkRows: 1_024, columns: allTypes() });
        const r = await ArrowSliceReader.open(p);
        const loaded: number[] = [];
        r.onBatchLoad = i => loaded.push(i);
        // Dictionaries are available without a batch read.
        expect(r.schema.columns[5].dictionary).toEqual(LEVELS);
        expect(r.schema.columns[6].dictionary?.length).toBe(300);
        expect(await r.getLabels(6, [0, 299, 300])).toEqual({ 0: 'lvl0', 299: 'lvl299' });
        expect(loaded).toEqual([]);
        await r.close();
    });
});

describe('projected reads match whole-batch decoding', () => {
    const path = () => fixture({ nrow: 3_333, chunkRows: 1_024, columns: allTypes() });

    test('unsorted windows, every type, across batch boundaries', async () => {
        const p = path();
        const ref = referenceCells(p).cells;
        const r = await ArrowSliceReader.open(p);
        for (const [s, e] of [[0, 3_333], [1_000, 1_100], [2_047, 2_049], [3_300, 4_000]]) {
            const out = await r.getRows({ start: s, end: e, columns: ALL_COLS, viewportGeneration: 1 });
            expect(out.rows).toEqual(ref.slice(s, Math.min(e, 3_333)));
        }
        await r.close();
    });

    test('permuted windows (element gather), every type', async () => {
        const p = path();
        const ref = referenceCells(p).cells;
        const r = await ArrowSliceReader.open(p);
        const perm = new Uint32Array(3_333);
        for (let i = 0; i < perm.length; i++) perm[i] = i;
        // Deterministic shuffle so a window hits many batches out of order.
        for (let i = perm.length - 1; i > 0; i--) {
            const j = Math.floor(hash01(i, 7) * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        const out = await r.getRows({
            start: 0, end: 3_333, columns: ALL_COLS, viewportGeneration: 1, permutation: perm,
        });
        expect(out.originalRowIndices).toEqual(Array.from(perm));
        expect(out.rows).toEqual(Array.from(perm, row => ref[row]));
        await r.close();
    });

    test('column order and subsets are honored on both paths', async () => {
        const p = path();
        const ref = referenceCells(p).cells;
        const r = await ArrowSliceReader.open(p);
        const cols = [8, 3, 0, 3];
        const pick = (row: Cell[]) => cols.map(c => row[c]);
        const plain = await r.getRows({ start: 10, end: 20, columns: cols, viewportGeneration: 1 });
        expect(plain.rows).toEqual(ref.slice(10, 20).map(pick));
        const perm = new Uint32Array([3_000, 5, 1_500]);
        const permuted = await r.getRows({
            start: 0, end: 3, columns: cols, viewportGeneration: 1, permutation: perm,
        });
        expect(permuted.rows).toEqual([ref[3_000], ref[5], ref[1_500]].map(pick));
        await r.close();
    });

    test('columnRange reads only that slice of the requested columns', async () => {
        const p = path();
        const ref = referenceCells(p).cells;
        const r = await ArrowSliceReader.open(p);
        const out = await r.getRows({
            start: 0, end: 4, columns: [0, 1, 2, 3, 4], columnRange: { start: 1, end: 3 },
            viewportGeneration: 1,
        });
        expect(out.rows).toEqual(ref.slice(0, 4).map(row => [row[1], row[2]]));
        await r.close();
    });

    test('scan batches read only the requested column', async () => {
        const p = path();
        const r = await ArrowSliceReader.open(p);
        let seen = 0;
        for await (const { batch, length } of iterateBatches(r, [1])) {
            expect(batch.getChildAt(1).length).toBe(length);
            expect(() => batch.getChildAt(0)).toThrow();
            seen += length;
        }
        expect(seen).toBe(3_333);
        // Scans bypass the viewport cache.
        expect(r.chunkCacheBytes).toBe(0);
        await r.close();
    });
});

describe('null counts from batch headers', () => {
    test('equal the decoded null counts per column, with progress', async () => {
        const p = fixture({ nrow: 3_333, chunkRows: 1_024, columns: allTypes() });
        const { nulls } = referenceCells(p);
        const r = await ArrowSliceReader.open(p);
        const progress: number[] = [];
        const counts = await r.nullCounts({ onProgress: done => progress.push(done) });
        expect(Array.from(counts)).toEqual(nulls);
        expect(progress).toEqual([1, 2, 3, 4]);
        // NaN is a value, not a null: only the NA rows count.
        expect(counts[2]).toBe(0);
        await r.close();
    });

    test('abort between batches', async () => {
        const p = fixture({ nrow: 3_333, chunkRows: 1_024, columns: allTypes() });
        const r = await ArrowSliceReader.open(p);
        const ctrl = new AbortController();
        const run = r.nullCounts({ signal: ctrl.signal, onProgress: () => ctrl.abort() });
        await expect(run).rejects.toThrow();
        await r.close();
    });
});

describe('caches', () => {
    test('viewport chunks are cached per (batch, column) and byte-bounded', async () => {
        const p = fixture({
            nrow: 8_192, chunkRows: 1_024,
            columns: [{ name: 'x', kind: 'dbl', gen: i => i }, { name: 'y', kind: 'dbl', gen: i => -i }],
        });
        // ~8 KiB per (batch, column) chunk; a 20 KiB budget holds two.
        const r = await ArrowSliceReader.open(p, { chunkCacheBytes: 20 * 1024 });
        const loaded: number[] = [];
        r.onBatchLoad = i => loaded.push(i);
        await r.getRows({ start: 0, end: 10, columns: [0], viewportGeneration: 1 });
        await r.getRows({ start: 0, end: 10, columns: [0], viewportGeneration: 1 });
        expect(loaded).toEqual([0]);
        // Second column of the same batch: one more read, column 0 still cached.
        await r.getRows({ start: 0, end: 10, columns: [0, 1], viewportGeneration: 1 });
        expect(loaded).toEqual([0, 0]);
        expect(r.chunkCacheBytes).toBeLessThanOrEqual(20 * 1024);
        // Walking other batches evicts the oldest chunks.
        for (let b = 1; b < 8; b++) {
            await r.getRows({ start: b * 1_024, end: b * 1_024 + 1, columns: [0], viewportGeneration: 1 });
        }
        expect(r.chunkCacheBytes).toBeLessThanOrEqual(20 * 1024);
        loaded.length = 0;
        await r.getRows({ start: 0, end: 1, columns: [0], viewportGeneration: 1 });
        expect(loaded).toEqual([0]);
        await r.close();
    });

    test('a permuted window reads each touched batch once', async () => {
        const p = fixture({
            nrow: 8_192, chunkRows: 1_024,
            columns: [{ name: 'x', kind: 'dbl', gen: i => i }],
        });
        const r = await ArrowSliceReader.open(p);
        const loaded: number[] = [];
        r.onBatchLoad = i => loaded.push(i);
        const out = await r.getRows({
            start: 0, end: 4, columns: [0], viewportGeneration: 1,
            permutation: new Uint32Array([8_000, 1, 8_001, 2]),
        });
        expect(out.rows).toEqual([[8_000], [1], [8_001], [2]]);
        expect(loaded).toEqual([0, 7]);
        // Gathers don't fill the chunk cache.
        expect(r.chunkCacheBytes).toBe(0);
        await r.close();
    });
});
