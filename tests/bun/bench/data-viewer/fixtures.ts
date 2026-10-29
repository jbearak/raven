// Benchmark fixtures for the data viewer (design F0). Written in JS with
// the same batch geometry and metadata as the R `View()` writer
// (tests/bun/_helpers/arrow-fixture-writer.ts), so the bench needs no R.
// Generated outside every timed section and cached on disk, keyed by
// fixture, scale, and GENERATOR_VERSION.
//
//   A  long mixed     10M × 10    (~0.7 GB at scale 1)
//   C  categorical     1M × 20    50k-level factor, 1M-distinct strings
//   D  typical        50k × 30    value/variable labels, display formats
//   G  small wide     20k × 2,000 doubles (~320 MB)
//
// `scale` multiplies the row counts of A and C (the CI job runs them
// reduced); D and G are always full size.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash01, writeArrowFixture } from '../../_helpers/arrow-fixture-writer';
import type { ColumnSpec } from '../../_helpers/arrow-fixture-writer';

export const GENERATOR_VERSION = 1;

export type FixtureName = 'A' | 'C' | 'D' | 'G';

/** Columns the bench drives, by role. */
export type FixtureInfo = {
    name: FixtureName;
    path: string;
    nrow: number;
    ncol: number;
    numericColumn: number;
    stringColumn?: number;
    filterColumn: number;
    /** numBetween bounds keeping roughly half the rows. */
    filterRange: [number, number];
};

const DAY0 = 19_000;
const TS0 = 1_700_000_000_000_000n;

function fixtureA(): ColumnSpec[] {
    return [
        { name: 'id', kind: 'int', gen: i => i + 1 },
        { name: 'x', kind: 'dbl', gen: i => (hash01(i, 1) < 0.01 ? null : (hash01(i, 2) + hash01(i, 3) - 1) * 100) },
        { name: 'y', kind: 'dbl', gen: i => hash01(i, 4) * 1_000 },
        { name: 'z', kind: 'dbl', gen: i => { const h = hash01(i, 5); return h < 0.005 ? null : h < 0.01 ? NaN : h * 7; } },
        { name: 'w', kind: 'dbl', gen: i => Math.floor(hash01(i, 6) * 500) },
        { name: 's', kind: 'chr', gen: i => (hash01(i, 7) < 0.01 ? null : `k${Math.floor(hash01(i, 8) * 100_000)}`) },
        { name: 'b', kind: 'lgl', gen: i => (hash01(i, 9) < 0.02 ? null : hash01(i, 10) < 0.5) },
        { name: 'f', kind: 'fct', levels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], gen: i => Math.floor(hash01(i, 11) * 8) },
        { name: 'd', kind: 'date', gen: i => DAY0 + Math.floor(hash01(i, 12) * 3_650) },
        { name: 't', kind: 'dttm', gen: i => TS0 + BigInt(Math.floor(hash01(i, 13) * 1e9)) * 1_000_000n },
    ];
}

function fixtureC(): ColumnSpec[] {
    const bigLevels = Array.from({ length: 50_000 }, (_, i) => `level_${i}`);
    const cols: ColumnSpec[] = [
        { name: 'big_fct', kind: 'fct', levels: bigLevels, gen: i => Math.floor(hash01(i, 21) * 50_000) },
        { name: 'uniq', kind: 'chr', gen: i => `id-${(i * 2_654_435_761 >>> 0).toString(36)}-${i}` },
    ];
    for (let k = 0; k < 6; k++) cols.push({ name: `num${k}`, kind: 'dbl', gen: i => (hash01(i, 30 + k) < 0.02 ? null : hash01(i, 40 + k) * 1e4) });
    for (let k = 0; k < 4; k++) cols.push({ name: `int${k}`, kind: 'int', gen: i => Math.floor(hash01(i, 50 + k) * 1_000) });
    for (let k = 0; k < 4; k++) cols.push({ name: `cat${k}`, kind: 'chr', gen: i => `c${Math.floor(hash01(i, 60 + k) * 100)}` });
    for (let k = 0; k < 2; k++) cols.push({ name: `flag${k}`, kind: 'lgl', gen: i => hash01(i, 70 + k) < 0.3 });
    for (let k = 0; k < 2; k++) cols.push({ name: `grp${k}`, kind: 'fct', levels: ['x', 'y', 'z', 'w'], gen: i => Math.floor(hash01(i, 80 + k) * 4) });
    return cols;
}

function fixtureD(): ColumnSpec[] {
    const cols: ColumnSpec[] = [];
    const labels = JSON.stringify({ 1: 'Strongly disagree', 2: 'Disagree', 3: 'Neutral', 4: 'Agree', 5: 'Strongly agree' });
    for (let k = 0; k < 10; k++) {
        cols.push({
            name: `q${k + 1}`, kind: 'dbl', gen: i => (hash01(i, 100 + k) < 0.05 ? null : 1 + Math.floor(hash01(i, 120 + k) * 5)),
            fieldMd: {
                'raven.value_labels': labels,
                'raven.variable_label': `Survey question ${k + 1}`,
                'raven.format': '%8.0g',
                'raven.type_tag': '<dbl+lbl>',
            },
        });
    }
    for (let k = 0; k < 10; k++) {
        cols.push({
            name: `m${k}`, kind: 'dbl', gen: i => hash01(i, 140 + k) * 1e5,
            fieldMd: { 'raven.format': '%9.2f', 'raven.variable_label': `Measure ${k}` },
        });
    }
    for (let k = 0; k < 5; k++) cols.push({ name: `txt${k}`, kind: 'chr', gen: i => `respondent note ${Math.floor(hash01(i, 160 + k) * 5_000)}` });
    for (let k = 0; k < 3; k++) cols.push({ name: `n${k}`, kind: 'int', gen: i => Math.floor(hash01(i, 170 + k) * 100) });
    cols.push({ name: 'when', kind: 'date', gen: i => DAY0 + (i % 365) });
    cols.push({ name: 'region', kind: 'fct', levels: ['N', 'S', 'E', 'W'], gen: i => i % 4 });
    return cols;
}

function fixtureG(): ColumnSpec[] {
    return Array.from({ length: 2_000 }, (_, c): ColumnSpec => ({
        name: `v${c}`, kind: 'dbl', gen: i => (hash01(i, c) < 0.01 ? null : hash01(i, c + 7_919) * 100),
    }));
}

/** Create (or reuse) fixture `name` under `dir`. */
export function ensureFixture(dir: string, name: FixtureName, scale: number): FixtureInfo {
    mkdirSync(dir, { recursive: true });
    const scaled = (n: number) => Math.max(1_000, Math.round(n * scale));
    const spec = {
        A: { nrow: scaled(10_000_000), columns: fixtureA(), numeric: 2, str: 5, filter: 2, range: [0, 500] as [number, number] },
        C: { nrow: scaled(1_000_000), columns: fixtureC(), numeric: 2, str: 1, filter: 3, range: [0, 5_000] as [number, number] },
        D: { nrow: 50_000, columns: fixtureD(), numeric: 10, str: 20, filter: 11, range: [0, 50_000] as [number, number] },
        G: { nrow: 20_000, columns: fixtureG(), numeric: 0, str: undefined, filter: 1, range: [0, 50] as [number, number] },
    }[name];
    const scaleTag = name === 'A' || name === 'C' ? `-s${scale}` : '';
    const path = join(dir, `${name}${scaleTag}-v${GENERATOR_VERSION}.arrow`);
    if (!existsSync(path)) {
        const t0 = performance.now();
        const tmp = `${path}.tmp`;
        writeArrowFixture(tmp, { nrow: spec.nrow, columns: spec.columns });
        renameSync(tmp, path);
        writeFileSync(`${path}.json`, JSON.stringify({ nrow: spec.nrow, ncol: spec.columns.length }));
        console.error(`[bench] generated fixture ${name} (${spec.nrow} × ${spec.columns.length}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
    return {
        name,
        path,
        nrow: spec.nrow,
        ncol: spec.columns.length,
        numericColumn: spec.numeric,
        stringColumn: spec.str,
        filterColumn: spec.filter,
        filterRange: spec.range,
    };
}
