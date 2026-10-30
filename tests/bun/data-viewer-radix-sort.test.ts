/**
 * Radix and rank sorts (`radix.ts`, `sort.ts`) against a reference: a
 * comparator-based stable sort over the same data. Random data with
 * ties, NA, NaN, `-0`, ±Inf, 64-bit integers, non-ASCII and astral
 * strings, and collator-equal strings (NFC vs NFD). C order is also
 * checked against R's `sort(method = "radix")` when Rscript is on PATH.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CLS_NA,
    CLS_NAN,
    CLS_VALUE,
    compareCodePoints,
    encodeBigInt64,
    encodeFloat64,
    encodeRanks,
    radixSortByKey,
    rankDistinct,
} from '../../editors/vscode/src/data-viewer/radix';
import { stringComparator } from '../../editors/vscode/src/data-viewer/sort';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const noCancel = () => {};

function identity(n: number): Uint32Array {
    const p = new Uint32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    return p;
}

/** Reference: stable comparator sort, value bucket by `cmp` (direction
 *  applied), then NaN, then NA, each in incoming order. */
function referenceSort(
    perm: readonly number[],
    cls: Uint8Array,
    cmp: (a: number, b: number) => number,
    desc: boolean,
): number[] {
    const vals = perm.filter(r => cls[r] === CLS_VALUE);
    const nans = perm.filter(r => cls[r] === CLS_NAN);
    const nas = perm.filter(r => cls[r] === CLS_NA);
    vals.sort((a, b) => (desc ? -1 : 1) * cmp(a, b));
    return [...vals, ...nans, ...nas];
}

function randomDoubles(n: number, r: () => number): { values: Float64Array; cls: Uint8Array } {
    const pool = [0, -0, 1, -1, 1.5, -1.5, Infinity, -Infinity, 1e-300, -1e-300,
        Number.MAX_VALUE, -Number.MAX_VALUE, 5e-324, 42, 42, 42];
    const values = new Float64Array(n);
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const x = r();
        if (x < 0.08) { cls[i] = CLS_NA; continue; }
        if (x < 0.14) { cls[i] = CLS_NAN; values[i] = NaN; continue; }
        values[i] = x < 0.6 ? pool[Math.floor(r() * pool.length)] : (r() - 0.5) * 1e6;
    }
    return { values, cls };
}

describe('radixSortByKey: doubles', () => {
    for (const n of [0, 1, 2, 17, 300, 70_000]) {
        for (const desc of [false, true]) {
            test(`n=${n} ${desc ? 'desc' : 'asc'} matches the reference`, () => {
                const r = rng(n * 7 + (desc ? 1 : 0));
                const { values, cls } = randomDoubles(n, r);
                const key = encodeFloat64(values, cls);
                const got = radixSortByKey(identity(n), key, desc, noCancel);
                const want = referenceSort(
                    Array.from(identity(n)), cls,
                    (a, b) => (values[a] === values[b] ? 0 : values[a] < values[b] ? -1 : 1),
                    desc,
                );
                expect(Array.from(got)).toEqual(want);
            });
        }
    }

    test('-0 ties with +0 and keeps original order', () => {
        const values = new Float64Array([0, -0, 0, -0]);
        const cls = new Uint8Array(4);
        const got = radixSortByKey(identity(4), encodeFloat64(values, cls), false, noCancel);
        expect(Array.from(got)).toEqual([0, 1, 2, 3]);
        const gotDesc = radixSortByKey(identity(4), encodeFloat64(values, cls), true, noCancel);
        expect(Array.from(gotDesc)).toEqual([0, 1, 2, 3]);
    });

    test('NaN before NA in both directions', () => {
        const values = new Float64Array([NaN, 3, 0, 1]);
        const cls = new Uint8Array([CLS_NAN, CLS_VALUE, CLS_NA, CLS_VALUE]);
        const key = encodeFloat64(values, cls);
        expect(Array.from(radixSortByKey(identity(4), key, false, noCancel))).toEqual([3, 1, 0, 2]);
        expect(Array.from(radixSortByKey(identity(4), key, true, noCancel))).toEqual([1, 3, 0, 2]);
    });

    test('sorting a subset (filter survivors) permutes only those rows', () => {
        const r = rng(99);
        const { values, cls } = randomDoubles(1000, r);
        const key = encodeFloat64(values, cls);
        const subset = Uint32Array.from(Array.from(identity(1000)).filter(i => i % 3 === 0));
        const got = radixSortByKey(subset, key, false, noCancel);
        const want = referenceSort(
            Array.from(subset), cls,
            (a, b) => (values[a] === values[b] ? 0 : values[a] < values[b] ? -1 : 1),
            false,
        );
        expect(Array.from(got)).toEqual(want);
    });

    test('multi-key LSD equals a lexicographic stable sort', () => {
        const r = rng(5);
        const n = 5000;
        const a = new Float64Array(n);
        const b = new Float64Array(n);
        const clsA = new Uint8Array(n);
        const clsB = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            a[i] = Math.floor(r() * 5);
            b[i] = Math.floor(r() * 50) - 25;
            if (r() < 0.05) clsA[i] = CLS_NA;
            if (r() < 0.05) clsB[i] = CLS_NA;
        }
        // a asc, b desc
        let perm = identity(n);
        perm = radixSortByKey(perm, encodeFloat64(b, clsB), true, noCancel);
        perm = radixSortByKey(perm, encodeFloat64(a, clsA), false, noCancel);
        const want = Array.from(identity(n)).sort((x, y) => {
            const ax = clsA[x] ? 1 : 0;
            const ay = clsA[y] ? 1 : 0;
            if (ax !== ay) return ax - ay;
            if (!ax && a[x] !== a[y]) return a[x] - a[y];
            const bx = clsB[x] ? 1 : 0;
            const by = clsB[y] ? 1 : 0;
            if (bx !== by) return bx - by;
            if (!bx && b[x] !== b[y]) return b[y] - b[x];
            return 0;
        });
        expect(Array.from(perm)).toEqual(want);
    });

    test('cancellation fires every 65,536 elements', () => {
        const n = 200_000;
        const values = new Float64Array(n);
        for (let i = 0; i < n; i++) values[i] = (i * 7919) % 1000;
        let checks = 0;
        expect(() => radixSortByKey(identity(n), encodeFloat64(values, new Uint8Array(n)), false, () => {
            if (++checks === 3) throw new DOMException('x', 'AbortError');
        })).toThrow();
        expect(checks).toBe(3);
    });
});

describe('radixSortByKey: 64-bit integers', () => {
    test('signed and unsigned match BigInt comparison', () => {
        const r = rng(11);
        const n = 3000;
        const s = new BigInt64Array(n);
        const u = new BigUint64Array(n);
        const cls = new Uint8Array(n);
        const pool = [0n, 1n, -1n, 9007199254740993n, 9007199254740992n,
            -(2n ** 63n), 2n ** 63n - 1n];
        for (let i = 0; i < n; i++) {
            const big = BigInt(Math.floor(r() * 2 ** 32)) * BigInt(Math.floor(r() * 2 ** 31))
                * (r() < 0.5 ? -1n : 1n);
            s[i] = r() < 0.3 ? pool[Math.floor(r() * pool.length)] : big;
            u[i] = BigInt.asUintN(64, s[i]);
            if (r() < 0.05) cls[i] = CLS_NA;
        }
        for (const desc of [false, true]) {
            const gotS = radixSortByKey(identity(n), encodeBigInt64(s, cls, true), desc, noCancel);
            expect(Array.from(gotS)).toEqual(referenceSort(Array.from(identity(n)), cls,
                (a, b) => (s[a] === s[b] ? 0 : s[a] < s[b] ? -1 : 1), desc));
            const gotU = radixSortByKey(identity(n), encodeBigInt64(u, cls, false), desc, noCancel);
            expect(Array.from(gotU)).toEqual(referenceSort(Array.from(identity(n)), cls,
                (a, b) => (u[a] === u[b] ? 0 : u[a] < u[b] ? -1 : 1), desc));
        }
    });
});

// Strings: ASCII mixed case, digit runs, punctuation, Latin-1, combining
// marks, CJK, astral (emoji, math alphanumerics), U+E000–U+FFFF.
const STRING_POOL = [
    'a', 'A', 'b', 'B', 'file_2', 'file_10', 'file_1', 'File_3', 'a b', 'a-b', 'a_b',
    '', ' ', '10', '9', '-1', 'zeta', 'Zeta', 'éclair', 'eclair', 'Éclair',
    'é', 'é', // NFC vs NFD: collator-equal
    'ñ', 'ñ', 'straße', 'strasse', '日本', '中文', '\u{1F600}', '\u{1D400}',
    '', '�', 'Ａ', 'a\u{1F600}', 'a�',
];

function randomStrings(n: number, r: () => number): { values: string[]; cls: Uint8Array } {
    const values: string[] = new Array(n);
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (r() < 0.07) { cls[i] = CLS_NA; values[i] = ''; continue; }
        values[i] = r() < 0.8
            ? STRING_POOL[Math.floor(r() * STRING_POOL.length)]
            : STRING_POOL[Math.floor(r() * STRING_POOL.length)] + String(Math.floor(r() * 30));
    }
    return { values, cls };
}

/** Rank rows the way `sort.ts` does: distinct values ranked once. */
function rankRows(values: string[], cls: Uint8Array, cmp: (a: string, b: string) => number): Uint32Array {
    const idOf = new Map<string, number>();
    const distinct: string[] = [];
    const ids = new Uint32Array(values.length);
    for (let i = 0; i < values.length; i++) {
        if (cls[i]) continue;
        let id = idOf.get(values[i]);
        if (id === undefined) { id = distinct.length; idOf.set(values[i], id); distinct.push(values[i]); }
        ids[i] = id;
    }
    const ranks = rankDistinct(distinct, cmp, noCancel);
    for (let i = 0; i < values.length; i++) ids[i] = cls[i] ? 0 : ranks[ids[i]];
    return ids;
}

describe('rank sort: strings', () => {
    for (const order of ['natural', 'locale', 'c'] as const) {
        for (const desc of [false, true]) {
            test(`${order} ${desc ? 'desc' : 'asc'} matches a comparator sort`, () => {
                const r = rng(order.length * 31 + (desc ? 1 : 0));
                const n = 4000;
                const { values, cls } = randomStrings(n, r);
                const cmp = stringComparator({ stringOrder: order, locale: 'en-US' });
                const key = encodeRanks(rankRows(values, cls, cmp), cls);
                const got = radixSortByKey(identity(n), key, desc, noCancel);
                const want = referenceSort(Array.from(identity(n)), cls,
                    (a, b) => Math.sign(cmp(values[a], values[b])), desc);
                expect(Array.from(got)).toEqual(want);
            });
        }
    }

    test('collator-equal strings (NFC vs NFD) tie and keep original order', () => {
        const values = ['é', 'é', 'é', 'é'];
        const cls = new Uint8Array(4);
        const cmp = stringComparator({ stringOrder: 'natural', locale: 'en-US' });
        expect(cmp('é', 'é')).toBe(0);
        const ranks = rankRows(values, cls, cmp);
        expect(new Set(ranks).size).toBe(1);
        const got = radixSortByKey(identity(4), encodeRanks(ranks, cls), true, noCancel);
        expect(Array.from(got)).toEqual([0, 1, 2, 3]);
    });

    test('natural puts file_2 before file_10; locale and C do not', () => {
        const natural = stringComparator({ stringOrder: 'natural', locale: 'en-US' });
        const locale = stringComparator({ stringOrder: 'locale', locale: 'en-US' });
        expect(natural('file_2', 'file_10')).toBeLessThan(0);
        expect(locale('file_2', 'file_10')).toBeGreaterThan(0);
        expect(compareCodePoints('file_2', 'file_10')).toBeGreaterThan(0);
    });

    test('C order is code point order, uppercase first, astral after U+FFFD', () => {
        const sorted = [...STRING_POOL].sort(compareCodePoints);
        const byCodePoints = [...STRING_POOL].sort((a, b) => {
            const x = [...a].map(c => c.codePointAt(0)!);
            const y = [...b].map(c => c.codePointAt(0)!);
            for (let i = 0; i < Math.min(x.length, y.length); i++) {
                if (x[i] !== y[i]) return x[i] - y[i];
            }
            return x.length - y.length;
        });
        expect(sorted).toEqual(byCodePoints);
        expect(compareCodePoints('B', 'a')).toBeLessThan(0);
        expect(compareCodePoints('�', '\u{1F600}')).toBeLessThan(0);
        // JS `<` gets this one wrong (UTF-16 code units).
        expect('�' < '\u{1F600}').toBe(false);
    });

    test('rank sort cancels every 65,536 comparisons', () => {
        const distinct = Array.from({ length: 100_000 }, (_, i) => `v${(i * 7919) % 100_003}`);
        let checks = 0;
        expect(() => rankDistinct(distinct, compareCodePoints, () => {
            if (++checks === 2) throw new DOMException('x', 'AbortError');
        })).toThrow();
        expect(checks).toBe(2);
    });
});

const R = spawnSync('Rscript', ['--version']).status === 0;

describe('C order against R sort(method = "radix")', () => {
    test.skipIf(!R)('same order as R for the string pool', () => {
        const dir = mkdtempSync(join(tmpdir(), 'raven-radix-'));
        const input = join(dir, 'in.txt');
        // Distinct values only; R's radix sort is stable too, but its output
        // is values, not indices.
        const values = [...new Set(STRING_POOL.filter(s => s !== ''))];
        writeFileSync(input, values.join('\n') + '\n', 'utf8');
        const script = [
            `x <- readLines(${JSON.stringify(input)}, encoding = "UTF-8")`,
            'x <- enc2utf8(x)',
            'cat(sort(x, method = "radix"), sep = "\\n")',
        ].join('; ');
        const out = spawnSync('Rscript', ['-e', script], { encoding: 'utf8' });
        expect(out.status).toBe(0);
        const fromR = out.stdout.split('\n').filter(l => l !== '');
        expect([...values].sort(compareCodePoints)).toEqual(fromR);
    });
});
