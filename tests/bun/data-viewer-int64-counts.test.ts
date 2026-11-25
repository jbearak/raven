// Value counts on an integer64 (Arrow Int64) column past the exact-count
// cap. Up to the cap the counts are on the exact `bigint`; past it they
// come from Space-Saving and HyperLogLog, which used to be fed doubles:
// 2^62 + 1 and 2^62 + 2 are the same double (doubles there are 1,024
// apart), so one listed "value" carried the rows of up to 1,024 different
// IDs with a stated error of 0. The sketches now key each 64-bit integer
// by its exact value, so a count's bounds are about that integer.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import { computeProfile, countValues, type CountSummary } from '../../editors/vscode/src/data-viewer/profile-engine';
import { setFilterFor } from '../../editors/vscode/src/data-viewer/webview/summary-model';
import { writeArrowFixture } from './_helpers/arrow-fixture-writer';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-int64-counts-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const BASE = 1n << 62n;

/** Every listed count must bound its value's true count, and no unlisted
 *  value may occur more often than the floor. */
function expectHonest(s: CountSummary, truth: Map<string, number>): void {
    const listed = new Set<string>();
    for (const e of s.entries) {
        const key = String(e.value);
        listed.add(key);
        const t = truth.get(key);
        // Each key is a value of the column, spelled exactly.
        expect([key, t !== undefined]).toEqual([key, true]);
        expect([key, e.count - e.error <= t!, t! <= e.count]).toEqual([key, true, true]);
    }
    expect(listed.size).toBe(s.entries.length);
    for (const [key, t] of truth) {
        if (!listed.has(key)) expect([key, t <= s.floor]).toEqual([key, true]);
    }
}

describe('integer64 value counts past the cap count each ID, not its double', () => {
    // 6,000 different IDs from 2^62 (all within six doubles), two of them
    // heavy and adjacent: as doubles the two are one value.
    const N = 12_000;
    const HEAVY_A = BASE + 1n, HEAVY_B = BASE + 2n;
    const value = (i: number): bigint | null => {
        if (i % 97 === 0) return null;
        if (i % 4 === 1) return HEAVY_A;
        if (i % 8 === 2) return HEAVY_B;
        return BASE + BigInt(10 + (i % 6000));
    };
    const truth = new Map<string, number>();
    let present = 0;
    for (let i = 0; i < N; i++) {
        const v = value(i);
        if (v === null) continue;
        present++;
        truth.set(v.toString(), (truth.get(v.toString()) ?? 0) + 1);
    }
    const path = join(DIR, 'ids.arrow');
    writeArrowFixture(path, {
        nrow: N, chunkRows: 1024,
        columns: [
            { name: 'id', kind: 'i64', gen: value, fieldMd: { 'raven.type_tag': '<int64>' } },
            {
                name: 'lab', kind: 'i64', gen: value,
                fieldMd: { 'raven.type_tag': '<int64>', 'raven.value_labels': JSON.stringify({ [HEAVY_A.toString()]: 'first', [HEAVY_B.toString()]: 'second' }) },
            },
        ],
    });

    test('Value counts: the two heavy neighbours are listed apart, every count bounds its ID', async () => {
        const r = await ArrowSliceReader.open(path);
        // The cap is crossed after 100 distinct values, then the 1,000
        // Space-Saving counters overflow too.
        const s = await countValues(r, 0, { exactCap: 100 });
        expect(s.exact).toBe(false);
        expect(s.present).toBe(present);
        expectHonest(s, truth);
        const a = s.entries.find(e => e.value === HEAVY_A.toString())!;
        const b = s.entries.find(e => e.value === HEAVY_B.toString())!;
        expect(a.count - a.error).toBeLessThanOrEqual(truth.get(HEAVY_A.toString())!);
        expect(b.count - b.error).toBeLessThanOrEqual(truth.get(HEAVY_B.toString())!);
        expect(s.entries.slice(0, 2).map(e => e.value)).toEqual([HEAVY_A.toString(), HEAVY_B.toString()]);
        // HyperLogLog's linear counting at this size is within a few percent.
        expect(Math.abs(s.distinct.value - truth.size) / truth.size).toBeLessThan(0.05);
        await r.close();
    });

    test('a listed value filters to exactly its rows', async () => {
        const r = await ArrowSliceReader.open(path);
        const s = await countValues(r, 0, { exactCap: 100 });
        const entry = s.entries.find(e => e.value === HEAVY_B.toString())!;
        const predicate = setFilterFor(r.schema.columns[0], 'numeric', [entry], true)!;
        const rows = await computeFilteredIndices(r, {
            entries: [{ id: 'a', columnIndex: 0, predicate, enabled: true, includeMissing: false }], labelsOnWhenFiltered: true,
        }, { labelsOn: true, formatOn: true, digits: 3 });
        expect(rows!.length).toBe(truth.get(HEAVY_B.toString())!);
        expect(Array.from(rows!).every(i => value(i) === HEAVY_B)).toBe(true);
        await r.close();
    });

    test('a labelled column: top values past the cap carry the label of the exact code', async () => {
        const r = await ArrowSliceReader.open(path);
        const { profile, counts } = await computeProfile(r, 1, { exactCap: 100 });
        expect(profile.kind).toBe('labelled');
        expect(counts!.exact).toBe(false);
        expectHonest(counts!, truth);
        expect(profile.top!.values.slice(0, 2).map(e => [e.value, e.label])).toEqual([
            [HEAVY_A.toString(), 'first'], [HEAVY_B.toString(), 'second'],
        ]);
        // The per-label counts beside it are exact, as before.
        expect(profile.levels!.counts.map(e => [e.label, e.count])).toEqual([
            ['first', truth.get(HEAVY_A.toString())!], ['second', truth.get(HEAVY_B.toString())!],
        ]);
        await r.close();
    });

    test('small 64-bit integers stay numbers past the cap', async () => {
        const p = join(DIR, 'small.arrow');
        writeArrowFixture(p, { nrow: 3000, chunkRows: 1024, columns: [{ name: 'n', kind: 'i64', gen: i => BigInt(i % 1500) - 5n }] });
        const r = await ArrowSliceReader.open(p);
        const s = await countValues(r, 0, { exactCap: 100 });
        expect(s.exact).toBe(false);
        expect(s.entries.every(e => typeof e.value === 'number')).toBe(true);
        const t = new Map<string, number>();
        for (let i = 0; i < 3000; i++) t.set(String(i % 1500 - 5), (t.get(String(i % 1500 - 5)) ?? 0) + 1);
        expectHonest(s, t);
        await r.close();
    });
});

describe('the real cap: 200,000 consecutive IDs from 2^62', () => {
    // Every ID occurs once. Fed as doubles, the 1,024 IDs sharing a double
    // were one value: a listed count of about 1,024 with error 0.
    test('no listed count claims more than its ID has; distinct is near 200,000', async () => {
        const N = 200_000;
        const path = join(DIR, 'consecutive.arrow');
        writeArrowFixture(path, { nrow: N, columns: [{ name: 'id', kind: 'i64', gen: i => BASE + BigInt(i) }] });
        const r = await ArrowSliceReader.open(path);
        const s = await countValues(r, 0);
        expect(s.exact).toBe(false);
        for (const e of s.entries) {
            const id = BigInt(e.value as string);
            expect(id >= BASE && id < BASE + BigInt(N)).toBe(true);
            expect(e.count - e.error).toBeLessThanOrEqual(1);
            expect(e.count).toBeGreaterThanOrEqual(1);
        }
        expect(new Set(s.entries.map(e => e.value)).size).toBe(s.entries.length);
        expect(Math.abs(s.distinct.value - N) / N).toBeLessThan(0.03);
        const { profile } = await computeProfile(r, 0);
        expect(Math.abs(profile.distinct.value - N) / N).toBeLessThan(0.03);
        await r.close();
    });
});
