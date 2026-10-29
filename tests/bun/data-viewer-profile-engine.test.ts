/**
 * Column profiles (design "Summaries"): the estimators against known
 * answers (Space-Saving bounds, HyperLogLog error, reservoir quantiles
 * marked ≈), and the profile engine against R's `quantile`, `mean`, `sd`
 * and `table` on fixtures (skipped without R).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import {
    computeProfile,
    countValues,
    quantilesFromKey,
    valueCountsFrom,
} from '../../editors/vscode/src/data-viewer/profile-engine';
import {
    guaranteedOrder,
    hashNumber,
    hashString,
    HyperLogLog,
    mulberry32,
    NumberCounter,
    quantileType7,
    Reservoir,
    SpaceSaving,
} from '../../editors/vscode/src/data-viewer/sketches';
import { materializeSortKey } from '../../editors/vscode/src/data-viewer/sort';
import { hash01, writeArrowFixture } from './_helpers/arrow-fixture-writer';
import type { ColumnSpec } from './_helpers/arrow-fixture-writer';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-profile-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function fixture(name: string, nrow: number, columns: ColumnSpec[], chunkRows = 4096): string {
    const path = join(DIR, `${name}.arrow`);
    writeArrowFixture(path, { nrow, columns, chunkRows });
    return path;
}

describe('Space-Saving', () => {
    test('every monitored count is within its error bound; unmonitored ≤ floor', () => {
        const rand = mulberry32(7);
        const truth = new Map<number, number>();
        const ss = new SpaceSaving<number>(1000);
        // Zipf-ish stream over 50k values.
        for (let i = 0; i < 300_000; i++) {
            const v = Math.floor(50_000 * rand() ** 3);
            truth.set(v, (truth.get(v) ?? 0) + 1);
            ss.add(v);
        }
        const top = ss.top();
        expect(top.length).toBe(1000);
        const monitored = new Set<number>();
        for (const e of top) {
            const t = truth.get(e.value) ?? 0;
            expect(t).toBeLessThanOrEqual(e.count);
            expect(t).toBeGreaterThanOrEqual(e.count - e.error);
            monitored.add(e.value);
        }
        for (const [v, t] of truth) if (!monitored.has(v)) expect(t).toBeLessThanOrEqual(ss.floor);
        // The heaviest values are exactly identified.
        const trueTop = [...truth].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v]) => v);
        expect(top.slice(0, 5).map(e => e.value)).toEqual(trueTop);
    });

    test('seeding from exact counts keeps the guarantees', () => {
        const truth = new Map<string, number>();
        const exact = new Map<string, number>();
        const rand = mulberry32(3);
        const stream: string[] = [];
        for (let i = 0; i < 100_000; i++) stream.push(`v${Math.floor(5_000 * rand() ** 2)}`);
        for (const s of stream.slice(0, 40_000)) exact.set(s, (exact.get(s) ?? 0) + 1);
        const ss = new SpaceSaving<string>(200);
        ss.seed(exact);
        for (const s of stream.slice(40_000)) ss.add(s);
        for (const s of stream) truth.set(s, (truth.get(s) ?? 0) + 1);
        for (const e of ss.top()) {
            const t = truth.get(e.value)!;
            expect(t).toBeLessThanOrEqual(e.count);
            expect(t).toBeGreaterThanOrEqual(e.count - e.error);
        }
    });

    test('guaranteedOrder: lower bound must reach the next upper bound', () => {
        expect(guaranteedOrder([{ count: 10, error: 0 }, { count: 10, error: 0 }], 2, 0)).toBe(true);
        expect(guaranteedOrder([{ count: 10, error: 3 }, { count: 9, error: 0 }], 1, 0)).toBe(false);
        expect(guaranteedOrder([{ count: 10, error: 1 }, { count: 9, error: 0 }], 1, 0)).toBe(true);
        expect(guaranteedOrder([{ count: 10, error: 1 }], 1, 12)).toBe(false);
    });
});

describe('HyperLogLog', () => {
    test.each([1_000, 50_000, 1_000_000])('estimates %p distinct within 3%%', n => {
        const h = new HyperLogLog();
        for (let i = 0; i < n; i++) {
            h.addHash(hashString(`id-${i}`));
            h.addHash(hashString(`id-${i % 97}`)); // duplicates don't count
        }
        expect(Math.abs(h.estimate() - n) / n).toBeLessThan(0.03);
    });

    test('a sketch seeded from the distinct set equals one run from row 0', () => {
        const a = new HyperLogLog();
        const b = new HyperLogLog();
        const rows: number[] = [];
        for (let i = 0; i < 20_000; i++) rows.push(Math.floor(hash01(i, 1) * 5_000) / 7);
        for (const x of rows) a.addHash(hashNumber(x));
        for (const x of new Set(rows)) b.addHash(hashNumber(x));
        expect([...b.registers]).toEqual([...a.registers]);
    });
});

describe('NumberCounter', () => {
    test('counts exactly to the cap, -0 as +0, then refuses new values', () => {
        const c = new NumberCounter(3);
        expect(c.add(1)).toBe(true);
        expect(c.add(-0)).toBe(true);
        expect(c.add(0)).toBe(true);
        expect(c.add(2.5)).toBe(true);
        expect(c.add(9)).toBe(false);
        expect(c.add(1)).toBe(true);
        expect(new Map(c.entries())).toEqual(new Map([[1, 2], [0, 2], [2.5, 1]]));
    });
});

describe('Reservoir quantiles', () => {
    test('exact while every value fits; ≈ beyond, within 1%', () => {
        const small = new Reservoir(1000);
        for (let i = 1; i <= 500; i++) small.add(i);
        expect(small.complete).toBe(true);
        expect(quantileType7(small.sorted(), 0.5)).toBe(250.5);

        const big = new Reservoir(100_000);
        for (let i = 0; i < 2_000_000; i++) big.add(hash01(i, 9) * 1000);
        expect(big.complete).toBe(false);
        const s = big.sorted();
        expect(s.length).toBe(100_000);
        expect(Math.abs(quantileType7(s, 0.5) - 500)).toBeLessThan(10);
        expect(Math.abs(quantileType7(s, 0.25) - 250)).toBeLessThan(10);
    });
});

describe('profile engine', () => {
    const N = 20_000;
    const x = (i: number) => (hash01(i, 1) < 0.05 ? null : hash01(i, 1) < 0.06 ? NaN : Math.round((hash01(i, 2) * 200 - 50) * 100) / 100);
    const s = (i: number) => (hash01(i, 3) < 0.03 ? null : hash01(i, 3) < 0.05 ? '' : `k${Math.floor(hash01(i, 4) ** 2 * 40)}`);
    const f = (i: number) => (hash01(i, 5) < 0.02 ? null : Math.floor(hash01(i, 6) * 5));
    const b = (i: number) => (hash01(i, 7) < 0.1 ? null : hash01(i, 8) < 0.3);
    const d = (i: number) => (hash01(i, 9) < 0.1 ? null : 19_000 + Math.floor(hash01(i, 10) * 400));
    const path = fixture('mixed', N, [
        { name: 'x', kind: 'dbl', gen: x },
        { name: 's', kind: 'chr', gen: s },
        { name: 'f', kind: 'fct', levels: ['a', 'b', 'c', 'd', 'e', 'unused'], gen: f },
        { name: 'b', kind: 'lgl', gen: b },
        { name: 'd', kind: 'date', gen: d },
    ]);

    test('numeric: counts, moments, quantiles and a histogram summing to the finite rows', async () => {
        const r = await ArrowSliceReader.open(path);
        const { profile: p, histogram50 } = await computeProfile(r, 0);
        const vals: number[] = [];
        let na = 0, nan = 0;
        for (let i = 0; i < N; i++) {
            const v = x(i);
            if (v === null) na++;
            else if (Number.isNaN(v)) nan++;
            else vals.push(v);
        }
        expect(p.kind).toBe('numeric');
        expect(p.na).toBe(na);
        expect(p.nan).toBe(nan);
        expect(p.distinct).toEqual({ value: new Set(vals).size, exact: true });
        const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
        expect(p.mean!).toBeCloseTo(mean, 10);
        expect(p.quantiles!.exact).toBe(true);
        expect(p.min).toBe(Math.min(...vals));
        expect(p.max).toBe(Math.max(...vals));
        expect(p.histogram!.length).toBe(20);
        expect(p.histogram!.reduce((a, bin) => a + bin.count, 0)).toBe(vals.length);
        expect(histogram50!.reduce((a, bin) => a + bin.count, 0)).toBe(vals.length);
        await r.close();
    });

    test('quantiles: reservoir past its size is marked ≈; a cached sort key makes them exact', async () => {
        const r = await ArrowSliceReader.open(path);
        const approx = await computeProfile(r, 0, { reservoirSize: 1000 });
        expect(approx.profile.quantiles!.exact).toBe(false);
        const exact = await computeProfile(r, 0);
        const key = await materializeSortKey(r, 0, { labelsOn: true, formatOn: true, digits: 3 });
        const keyed = await computeProfile(r, 0, { reservoirSize: 1000, sortKey: key });
        expect(keyed.profile.quantiles!.exact).toBe(true);
        expect(keyed.profile.quantiles!.p25).toBe(exact.profile.quantiles!.p25);
        expect(keyed.profile.quantiles!.p50).toBe(exact.profile.quantiles!.p50);
        expect(keyed.profile.quantiles!.p75).toBe(exact.profile.quantiles!.p75);
        expect(quantilesFromKey(key, exact.profile.rows - exact.profile.na - exact.profile.nan)).toBeDefined();
        await r.close();
    });

    test('character: empty strings, lengths, exact top values', async () => {
        const r = await ArrowSliceReader.open(path);
        const { profile: p } = await computeProfile(r, 1);
        const counts = new Map<string, number>();
        let empty = 0, na = 0;
        for (let i = 0; i < N; i++) {
            const v = s(i);
            if (v === null) { na++; continue; }
            if (v === '') empty++;
            counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        expect(p.kind).toBe('character');
        expect(p.na).toBe(na);
        expect(p.emptyStrings).toBe(empty);
        expect(p.minLength).toBe(0);
        expect(p.maxLength).toBe(3);
        expect(p.distinct).toEqual({ value: counts.size, exact: true });
        const best = [...counts].sort((a, c) => c[1] - a[1])[0];
        expect(p.top!.values[0]).toEqual({ value: best[0], count: best[1], error: 0 });
        expect(p.top!.exact).toBe(true);
        expect(p.top!.approximateOrder).toBe(false);
        await r.close();
    });

    test('character past the cap: HLL distinct and Space-Saving top values, marked ≈', async () => {
        const r = await ArrowSliceReader.open(path);
        const { profile: p, counts } = await computeProfile(r, 1, { exactCap: 10 });
        expect(p.distinct.exact).toBe(false);
        expect(p.top!.exact).toBe(false);
        for (const e of counts!.entries) expect(e.error).toBeGreaterThanOrEqual(0);
        const vc = valueCountsFrom(counts!, 'desc', 5);
        expect(vc.exact).toBe(false);
        await r.close();
    });

    test('factor: levels used of declared, exact counts', async () => {
        const r = await ArrowSliceReader.open(path);
        const { profile: p } = await computeProfile(r, 2);
        expect(p.kind).toBe('factor');
        expect(p.levels!.declared).toBe(6);
        expect(p.levels!.used).toBe(5);
        expect(p.levels!.counts.map(e => e.label)).toEqual(['a', 'b', 'c', 'd', 'e', 'unused']);
        expect(p.levels!.counts[5].count).toBe(0);
        const total = p.levels!.counts.reduce((a, e) => a + e.count, 0);
        expect(total + p.na).toBe(N);
        await r.close();
    });

    test('logical and date', async () => {
        const r = await ArrowSliceReader.open(path);
        const lg = (await computeProfile(r, 3)).profile;
        let t = 0, fl = 0, na = 0;
        for (let i = 0; i < N; i++) { const v = b(i); if (v === null) na++; else if (v) t++; else fl++; }
        expect([lg.trueCount, lg.falseCount, lg.na]).toEqual([t, fl, na]);
        const dt = (await computeProfile(r, 4)).profile;
        expect(dt.kind).toBe('date');
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < N; i++) { const v = d(i); if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
        expect(dt.min).toEqual({ _: 'date', v: new Date(lo * 86_400_000).toISOString().slice(0, 10) });
        expect(dt.max).toEqual({ _: 'date', v: new Date(hi * 86_400_000).toISOString().slice(0, 10) });
        await r.close();
    });

    test('countValues: numeric value counts, exact then Space-Saving', async () => {
        const r = await ArrowSliceReader.open(path);
        const exact = await countValues(r, 0);
        expect(exact.exact).toBe(true);
        const rare = valueCountsFrom(exact, 'asc', 3);
        expect(rare.entries[0].count).toBeLessThanOrEqual(rare.entries[2].count);
        const approx = await countValues(r, 0, { exactCap: 100 });
        expect(approx.exact).toBe(false);
        expect(approx.distinct.exact).toBe(false);
        await r.close();
    });

    test('cancellation: an aborted signal rejects', async () => {
        const r = await ArrowSliceReader.open(path);
        const ac = new AbortController();
        ac.abort();
        const err = await computeProfile(r, 0, { signal: ac.signal }).then(() => undefined, e => e);
        expect((err as Error)?.name).toBe('AbortError');
        await r.close();
    });
});

/** R available with the fixtures' values passed as text. */
const R = process.env.RAVEN_TEST_R_BIN ?? 'Rscript';
const hasR = spawnSync(R, ['--version']).status === 0;

describe.skipIf(!hasR)('profile engine against R', () => {
    test('quantile, mean, sd and table agree with R', async () => {
        const N = 30_000;
        const x = (i: number) => (hash01(i, 11) < 0.04 ? null : (hash01(i, 12) - 0.3) * 1e3 + hash01(i, 13));
        const s = (i: number) => (hash01(i, 14) < 0.02 ? null : `v${Math.floor(hash01(i, 15) ** 3 * 30)}`);
        const path = fixture('vs-r', N, [
            { name: 'x', kind: 'dbl', gen: x },
            { name: 's', kind: 'chr', gen: s },
        ]);
        const xs = join(DIR, 'x.txt');
        const ss = join(DIR, 's.txt');
        writeFileSync(xs, Array.from({ length: N }, (_, i) => { const v = x(i); return v === null ? 'NA' : v.toPrecision(17); }).join('\n'));
        writeFileSync(ss, Array.from({ length: N }, (_, i) => s(i) ?? 'NA').join('\n'));
        const script = `
x <- as.numeric(readLines("${xs}"))
s <- readLines("${ss}"); s[s == "NA"] <- NA
q <- quantile(x, c(.25, .5, .75), na.rm = TRUE, names = FALSE)
cat(sprintf("%.17g", c(q, mean(x, na.rm = TRUE), sd(x, na.rm = TRUE))), sep = "\\n")
tb <- sort(table(s), decreasing = TRUE)
cat(paste(names(tb), as.integer(tb), sep = "="), sep = "\\n")
cat(length(unique(s[!is.na(s)])), "\\n")
`;
        const out = spawnSync(R, ['--vanilla', '-e', script], { encoding: 'utf8' });
        expect(out.status).toBe(0);
        const lines = out.stdout.trim().split('\n').map(l => l.trim());
        const [p25, p50, p75, mean, sd] = lines.slice(0, 5).map(Number);
        const r = await ArrowSliceReader.open(path);
        const px = (await computeProfile(r, 0)).profile;
        expect(px.quantiles!.exact).toBe(true);
        expect(px.quantiles!.p25).toBeCloseTo(p25, 9);
        expect(px.quantiles!.p50).toBeCloseTo(p50, 9);
        expect(px.quantiles!.p75).toBeCloseTo(p75, 9);
        expect(px.mean!).toBeCloseTo(mean, 9);
        expect(px.sd!).toBeCloseTo(sd, 9);
        const ps = await computeProfile(r, 1);
        const table = new Map(lines.slice(5, -1).map(l => { const [k, v] = l.split('='); return [k, Number(v)]; }));
        expect(ps.profile.distinct).toEqual({ value: Number(lines[lines.length - 1]), exact: true });
        for (const e of ps.counts!.entries) expect(table.get(e.value as string)).toBe(e.count);
        expect(ps.counts!.entries.length).toBe(table.size);
        await r.close();
    });
});
