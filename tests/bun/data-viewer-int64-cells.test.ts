// What an integer64 (Arrow Int64) cell shows past 2^53. A double holds
// only every second integer there, so a cell sent as `Number(v)` showed,
// copied and searched as a neighbour's digits while filters, value counts
// and Copy as R code compared the exact integer. The reader now sends
// such a value as `{ _: 'i64', v }` with its decimal text, on every read
// path, and everything that formats a cell prints that text.
//
// Expected values are literals: comparing two read paths with each other
// passes when both are wrong the same way.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader, type ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { formatCell } from '../../editors/vscode/src/data-viewer/display-format';
import { findSourceRows } from '../../editors/vscode/src/data-viewer/find';
import { computeProfile } from '../../editors/vscode/src/data-viewer/profile-engine';
import { computePermutation } from '../../editors/vscode/src/data-viewer/sort';
import { render_tsv } from '../../editors/vscode/src/data-viewer/tsv';
import { encodeInt64, type Cell } from '../../editors/vscode/src/data-viewer/wire-format';
import { WorkerEngine } from '../../editors/vscode/src/data-viewer/worker-engine';
import { profileStatLines } from '../../editors/vscode/src/data-viewer/webview/summary-model';
import { describeSelection, formatStat, summarizeSelection } from '../../editors/vscode/src/data-viewer/webview/workflow-model';
import { writeArrowFixture } from './_helpers/arrow-fixture-writer';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-int64-cells-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const P53 = 9007199254740992n; // 2^53
const MAX = 9223372036854775807n; // 2^63 − 1
const N = 3 * 1024;
/** The first rows are the cases; the rest are 2^62 + row. */
const HEAD: (bigint | null)[] = [P53, P53 + 1n, -P53 - 1n, 5n, null, MAX, -MAX, P53 - 1n];
const value = (i: number): bigint | null => (i < HEAD.length ? HEAD[i] : (1n << 62n) + BigInt(i));
const big = (v: string): Cell => ({ _: 'i64', v });
const HEAD_CELLS: Cell[] = [
    big('9007199254740992'), big('9007199254740993'), big('-9007199254740993'), 5, null,
    big('9223372036854775807'), big('-9223372036854775807'), 9007199254740991,
];

const PATH = join(DIR, 'i64.arrow');
writeArrowFixture(PATH, {
    nrow: N,
    chunkRows: 1024,
    columns: [
        { name: 'id', kind: 'i64', gen: value, fieldMd: { 'raven.type_tag': '<int64>' } },
        {
            name: 'lab', kind: 'i64', gen: value,
            fieldMd: { 'raven.type_tag': '<int64>', 'raven.value_labels': JSON.stringify({ '9007199254740993': 'odd', '5': 'five' }) },
        },
        // Two neighbours that round to different doubles than themselves.
        { name: 'pair', kind: 'i64', gen: i => (i % 2 === 0 ? P53 + 1n : P53 + 3n) },
    ],
});

const OPTS = { labelsOn: true, formatOn: true, digits: 3 };

describe('encodeInt64', () => {
    test('a number while a double holds it exactly, decimal text past that', () => {
        expect(encodeInt64(null)).toBeNull();
        expect(encodeInt64(0n)).toBe(0);
        expect(encodeInt64(-42n)).toBe(-42);
        expect(encodeInt64(P53 - 1n)).toBe(9007199254740991);
        expect(encodeInt64(1n - P53)).toBe(-9007199254740991);
        expect(encodeInt64(P53)).toEqual(big('9007199254740992'));
        expect(encodeInt64(-P53)).toEqual(big('-9007199254740992'));
        expect(encodeInt64(P53 + 1n)).toEqual(big('9007199254740993'));
        expect(encodeInt64(18446744073709551615n)).toEqual(big('18446744073709551615'));
    });
});

describe('the reader sends integer64 cells exactly on every read path', () => {
    test('natural order (chunk decode), and through JSON as postMessage carries them', async () => {
        const r = await ArrowSliceReader.open(PATH);
        const out = await r.getRows({ start: 0, end: 8, columns: [0], viewportGeneration: 1 });
        expect(out.rows.map(row => row[0])).toEqual(HEAD_CELLS);
        expect(JSON.parse(JSON.stringify(out.rows)).map((row: Cell[]) => row[0])).toEqual(HEAD_CELLS);
        await r.close();
    });

    test('a sparse permuted window (fixed-width gather)', async () => {
        const r = await ArrowSliceReader.open(PATH);
        let gathers = 0;
        const orig = (r as any).gather.bind(r);
        (r as any).gather = (...a: unknown[]) => { gathers++; return orig(...a); };
        const perm = Uint32Array.from([1, 2049, 0, 6, 4, 2, 1030]);
        const out = await r.getRows({ start: 0, end: perm.length, columns: [0], viewportGeneration: 1, permutation: perm });
        expect(gathers).toBeGreaterThan(0);
        expect(out.rows.map(row => row[0])).toEqual([
            big('9007199254740993'), big('4611686018427389953'), big('9007199254740992'),
            big('-9223372036854775807'), null, big('-9007199254740993'), big('4611686018427388934'),
        ]);
        await r.close();
    });

    test('a dense permuted window (a whole sorted copy), with the sort order exact', async () => {
        const r = await ArrowSliceReader.open(PATH);
        const perm = await computePermutation(r, [{ columnIndex: 0, direction: 'desc' }], OPTS);
        // 2^63 − 1, then 2^62 + 3071 downward, …, and at the end the head's
        // small values, the negatives, and NA last.
        expect(Array.from(perm.subarray(0, 3))).toEqual([5, N - 1, N - 2]);
        expect(Array.from(perm.subarray(N - 8))).toEqual([8, 1, 0, 7, 3, 2, 6, 4]);
        const out = await r.getRows({ start: 0, end: N, columns: [0], viewportGeneration: 1, permutation: perm });
        expect(out.rows.slice(0, 2).map(row => row[0])).toEqual([big('9223372036854775807'), big('4611686018427390975')]);
        expect(out.rows.slice(N - 7).map(row => row[0])).toEqual([
            big('9007199254740993'), big('9007199254740992'), 9007199254740991, 5,
            big('-9007199254740993'), big('-9223372036854775807'), null,
        ]);
        await r.close();
    });
});

describe('what an integer64 cell shows and copies', () => {
    const col: ColumnSchema = { name: 'id', arrowType: 'Int64', isInteger: true, dictionaryShipped: false, typeTag: '<int64>' };
    const lab: ColumnSchema = { ...col, name: 'lab', valueLabels: { '9007199254740993': 'odd', '5': 'five' } };

    test('the exact digits, whatever Format and digits say', () => {
        for (const o of [OPTS, { ...OPTS, formatOn: false }, { ...OPTS, digits: 0, alignPad: true }]) {
            const f = formatCell(big('9007199254740993'), col, undefined, o);
            expect([f.text, f.copyText, f.missing]).toEqual(['9007199254740993', '9007199254740993', false]);
        }
        expect(formatCell(big('-9223372036854775807'), col, undefined, OPTS).text).toBe('-9223372036854775807');
    });

    test('a value label is found by the exact integer; Labels off shows the integer', () => {
        expect(formatCell(big('9007199254740993'), lab, undefined, OPTS)).toMatchObject({ text: 'odd', copyText: 'odd', isLabel: true });
        // 2^53 has no label; as a double it and 2^53 + 1 were the same key.
        expect(formatCell(big('9007199254740992'), lab, undefined, OPTS)).toEqual({ text: '9007199254740992', missing: false, copyText: '9007199254740992' });
        expect(formatCell(big('9007199254740993'), lab, undefined, { ...OPTS, labelsOn: false }).text).toBe('9007199254740993');
        expect(formatCell(5, lab, undefined, OPTS).text).toBe('five');
    });

    test('copy (the host renders TSV from the same cells) keeps neighbours apart', async () => {
        const r = await ArrowSliceReader.open(PATH);
        const out = await r.getRows({ start: 0, end: 8, columns: [0, 1], viewportGeneration: 1 });
        const cols = r.schema.columns;
        expect(render_tsv(out.rows, [0, 1], cols, {}, true, true, 3)).toBe([
            '9007199254740992\t9007199254740992',
            '9007199254740993\todd',
            '-9007199254740993\t-9007199254740993',
            '5\tfive',
            '\t',
            '9223372036854775807\t9223372036854775807',
            '-9223372036854775807\t-9223372036854775807',
            '9007199254740991\t9007199254740991',
        ].join('\n'));
        await r.close();
    });

    test('Find matches the digits shown: 2^53 + 1 is found, and only there', async () => {
        const r = await ArrowSliceReader.open(PATH);
        const find = async (query: string, columns = [0]) => Array.from(await findSourceRows(r, { query, columns, ...OPTS }, undefined));
        expect(await find('9007199254740993')).toEqual([1, 2]); // and its negative
        expect(await find('9007199254740992')).toEqual([0]);
        expect(await find('4611686018427389953')).toEqual([2049]);
        // The labelled column shows `odd` in row 1, so the digits match only row 2.
        expect(await find('9007199254740993', [1])).toEqual([2]);
        expect(await find('odd', [1])).toEqual([1]);
        await r.close();
    });

    test('a selection counts such cells; the sum is a double, shown to four digits', () => {
        const cells: Cell[] = [big('9007199254740993'), big('9007199254740992'), 5, null];
        const s = summarizeSelection({ start: 0, end: 4 }, [0], () => true, (_c, row) => cells[row]);
        expect(s.numeric).toEqual({ count: 3, na: 1, sum: 9007199254740993 + 9007199254740992 + 5 });
        expect(describeSelection(s, formatStat)).toBe('4 cells · 1 NA · Σ 1.801e+16 · mean 6.005e+15');
    });
});

describe('a column summary shows the exact smallest and largest integer64', () => {
    test('2^53 + 1 and 2^53 + 3, which as doubles are 2^53 and 2^53 + 4', async () => {
        const r = await ArrowSliceReader.open(PATH);
        const { profile } = await computeProfile(r, 2);
        expect(profile.min).toEqual(big('9007199254740993'));
        expect(profile.max).toEqual(big('9007199254740995'));
        const col = r.schema.columns[2];
        const lines = profileStatLines(profile, cell => formatCell(cell, col, undefined, OPTS).text);
        expect(lines.find(l => l.label === 'min')?.value).toBe('9007199254740993');
        expect(lines.find(l => l.label === 'max')?.value).toBe('9007199254740995');
        const all = await computeProfile(r, 0);
        expect([all.profile.min, all.profile.max]).toEqual([big('-9223372036854775807'), big('9223372036854775807')]);
        await r.close();
    });

    test('a column of small integers still sends numbers', async () => {
        const p = join(DIR, 'small.arrow');
        writeArrowFixture(p, { nrow: 10, columns: [{ name: 'n', kind: 'i64', gen: i => BigInt(i - 3) }] });
        const r = await ArrowSliceReader.open(p);
        const { profile } = await computeProfile(r, 0);
        expect([profile.min, profile.max]).toEqual([-3, 6]);
        const out = await r.getRows({ start: 0, end: 3, columns: [0], viewportGeneration: 1 });
        expect(out.rows.map(row => row[0])).toEqual([-3, -2, -1]);
        await r.close();
    });
});

// The extension reads through worker threads (`WorkerEngine`): the cells
// and count keys cross a thread boundary on the way to the host.
describe('through the reader thread and the scan worker', () => {
    const THREADS = join(import.meta.dir, '../../editors/vscode/src/data-viewer/threads');

    test('cells, a sorted window, the summary extremes and value counts arrive exact', async () => {
        const engine = await WorkerEngine.start({
            filePath: PATH, nrow: N,
            readerScript: join(THREADS, 'reader-thread.ts'), scanScript: join(THREADS, 'scan-worker.ts'),
        });
        try {
            const signal = new AbortController().signal;
            const natural = await engine.getRows({ start: 0, end: 8, columns: [0], viewportGeneration: 1 }, 0);
            expect(natural.rows.map(row => row[0])).toEqual(HEAD_CELLS);

            const { min, max } = await engine.profile(2, signal);
            expect([min, max]).toEqual([big('9007199254740993'), big('9007199254740995')]);

            const counts = await engine.valueCounts(2, 'desc', 5, signal);
            expect(counts.entries).toEqual([
                { value: '9007199254740993', count: N / 2, error: 0 },
                { value: '9007199254740995', count: N / 2, error: 0 },
            ]);

            const t = await engine.compute({ sort: { keys: [{ columnIndex: 0, direction: 'desc' }], labelsOnWhenSorted: true } });
            expect(await engine.coordinator.install(t)).toBe(true);
            const sorted = await engine.getRows({ start: 0, end: 2, columns: [0], viewportGeneration: 2 }, t.gen);
            expect(sorted.rows.map(row => row[0])).toEqual([big('9223372036854775807'), big('4611686018427390975')]);
        } finally {
            await engine.dispose();
        }
    }, 60_000);
});
