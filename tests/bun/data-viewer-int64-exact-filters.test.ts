// Comparison and range filters on an integer64 (Arrow Int64) column are
// exact: the bound's real value against each stored integer, never two
// doubles. Past 2^53 a double holds only every second integer, so a
// rounded comparison keeps the neighbours too (`big = 2^53` used to keep
// 2^53 + 1). The same intervals drive Copy as R code, whose real-R round
// trip is in data-viewer-r-code-roundtrip.test.ts.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Field, Int64, RecordBatch, Schema, Table, tableToIPC, Uint64, vectorFromArray } from 'apache-arrow';
import type { ColumnSchema } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import { computeHistogramForColumn } from '../../editors/vscode/src/data-viewer/histograms';
import { computeProfile } from '../../editors/vscode/src/data-viewer/profile-engine';
import { brushedTotal, brushPredicate } from '../../editors/vscode/src/data-viewer/webview/summary-model';
import { generateRCode } from '../../editors/vscode/src/data-viewer/r-code';
import { EMPTY_SORT, type FilterPredicate } from '../../editors/vscode/src/data-viewer/messages';
import {
    brushNumBetween, buildPredicate, defaultFormState, predicateToKindValue, seedFromEntry,
} from '../../editors/vscode/src/data-viewer/webview/filter-popover-seed';
import { summarizePredicate } from '../../editors/vscode/src/data-viewer/webview/predicate-summary';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-int64-exact-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const P53 = 9007199254740992; // 2^53

/** Rows: 0 → 2^53, 1 → 2^53 + 1, 2 → 2^53 + 2, 3 → -7, 4 → NA, 5 → 3.
 *  `big` is plain; `lab` holds the same values with value labels;
 *  `u` is unsigned, with 2^64 − 1 in row 0. */
async function open(): Promise<ArrowSliceReader> {
    const values = [9007199254740992n, 9007199254740993n, 9007199254740994n, -7n, null, 3n];
    const t = new Table({
        big: vectorFromArray(values, new Int64()),
        lab: vectorFromArray(values, new Int64()),
        u: vectorFromArray([18446744073709551615n, 9007199254740993n, 9007199254740994n, 7n, null, 3n], new Uint64()),
    });
    const tag = (extra: [string, string][] = []) => new Map([['raven.type_tag', '<integer64>'], ...extra]);
    const schema = new Schema([
        new Field('big', t.schema.fields[0].type, true, tag()),
        new Field('lab', t.schema.fields[1].type, true, tag([
            ['raven.value_labels', JSON.stringify({ '9007199254740992': 'even', '9007199254740993': 'odd' })],
        ])),
        new Field('u', t.schema.fields[2].type, true, tag()),
    ]);
    const withMd = new Table(schema, t.batches.map(b => new RecordBatch(schema, b.data)));
    const p = join(DIR, `i64-${Math.random()}.arrow`);
    writeFileSync(p, tableToIPC(withMd, 'file'));
    return ArrowSliceReader.open(p);
}

async function rows(columnIndex: number, predicate: FilterPredicate, includeMissing = false): Promise<number[]> {
    const r = await open();
    try {
        const out = await computeFilteredIndices(r, {
            entries: [{ id: 'a', columnIndex, predicate, enabled: true, includeMissing }],
            labelsOnWhenFiltered: true,
        }, { labelsOn: true, formatOn: true, digits: 3 });
        return Array.from(out!);
    } finally {
        await r.close();
    }
}

describe('integer64 comparison and range filters are exact', () => {
    const cases: [string, FilterPredicate, number[]][] = [
        ['= 2^53 keeps only 2^53', { kind: 'numCompare', op: '=', value: P53 }, [0]],
        ['= 2^53 + 1, typed as text', { kind: 'numCompare', op: '=', value: '9007199254740993' }, [1]],
        ['!= 2^53 + 1', { kind: 'numCompare', op: '!=', value: '9007199254740993' }, [0, 2, 3, 5]],
        ['> 2^53 keeps 2^53 + 1', { kind: 'numCompare', op: '>', value: P53 }, [1, 2]],
        ['>= 2^53 + 1', { kind: 'numCompare', op: '>=', value: '9007199254740993' }, [1, 2]],
        ['< 2^53 + 1', { kind: 'numCompare', op: '<', value: '9007199254740993' }, [0, 3, 5]],
        ['<= 2^53', { kind: 'numCompare', op: '<=', value: P53 }, [0, 3, 5]],
        ['between 2^53 + 1 and itself', { kind: 'numBetween', lo: '9007199254740993', hi: '9007199254740993', inclusive: true }, [1]],
        ['between 2^53 and 2^53 + 2, exclusive', { kind: 'numBetween', lo: P53, hi: 9007199254740994, inclusive: false }, [1]],
        ['a histogram bin [2^53, 2^53 + 2)', { kind: 'numBetween', lo: P53, hi: 9007199254740994, inclusive: true, upperInclusive: false }, [0, 1]],
        ['not between 2^53 and 2^53', { kind: 'numNotBetween', lo: P53, hi: P53, inclusive: true }, [1, 2, 3, 5]],
        ['not between, exclusive', { kind: 'numNotBetween', lo: P53, hi: 9007199254740994, inclusive: false }, [0, 2, 3, 5]],
        // A fractional bound: no integer equals it, and it sits between two.
        ['>= 2.5', { kind: 'numCompare', op: '>=', value: 2.5 }, [0, 1, 2, 5]],
        ['> -7.5', { kind: 'numCompare', op: '>', value: -7.5 }, [0, 1, 2, 3, 5]],
        ['< -6.5', { kind: 'numCompare', op: '<', value: -6.5 }, [3]],
        ['= 2.5', { kind: 'numCompare', op: '=', value: 2.5 }, []],
        ['!= 2.5', { kind: 'numCompare', op: '!=', value: 2.5 }, [0, 1, 2, 3, 5]],
        ['< Inf', { kind: 'numCompare', op: '<', value: Infinity }, [0, 1, 2, 3, 5]],
        ['> Inf', { kind: 'numCompare', op: '>', value: Infinity }, []],
        ['between -Inf and 3', { kind: 'numBetween', lo: -Infinity, hi: 3, inclusive: true }, [3, 5]],
        ['a reversed range is empty', { kind: 'numBetween', lo: 5, hi: 1, inclusive: true }, []],
        ['a null bound matches nothing', { kind: 'numCompare', op: '!=', value: null as unknown as number }, []],
        // A bound typed with a fraction or an exponent arrives as decimal
        // text and is read digit by digit: as a double, 2^53 + 0.5 is 2^53.
        ['< 2^53 + 0.5 keeps 2^53', { kind: 'numCompare', op: '<', value: '9007199254740992.5' }, [0, 3, 5]],
        ['<= 2^53 + 0.5', { kind: 'numCompare', op: '<=', value: '9007199254740992.5' }, [0, 3, 5]],
        ['> 2^53 + 0.5', { kind: 'numCompare', op: '>', value: '9007199254740992.5' }, [1, 2]],
        ['>= 2^53 + 0.5', { kind: 'numCompare', op: '>=', value: '9007199254740992.5' }, [1, 2]],
        ['= 2^53 + 0.5 is no integer', { kind: 'numCompare', op: '=', value: '9007199254740992.5' }, []],
        ['!= 2^53 + 0.5', { kind: 'numCompare', op: '!=', value: '9007199254740992.5' }, [0, 1, 2, 3, 5]],
        ['= 2^53 + 1 in scientific notation', { kind: 'numCompare', op: '=', value: '9.007199254740993e15' }, [1]],
        ['= 2^53 + 1 with a zero fraction', { kind: 'numCompare', op: '=', value: '+9007199254740993.000' }, [1]],
        ['> 9007199254740.9925e3 (2^53 + 0.5 again)', { kind: 'numCompare', op: '>', value: '9007199254740.9925e3' }, [1, 2]],
        ['between 2^53 + 0.5 and 2^53 + 1.5', { kind: 'numBetween', lo: '9007199254740992.5', hi: '9007199254740993.5', inclusive: true }, [1]],
        ['between, exclusive, with fractional ends', { kind: 'numBetween', lo: '9007199254740991.5', hi: '9007199254740993.5', inclusive: false }, [0, 1]],
        ['a half-open range with fractional ends', { kind: 'numBetween', lo: '2.5', hi: '9007199254740992.5', inclusive: true, upperInclusive: false }, [0, 5]],
        ['not between 2^53 + 0.5 and 2^53 + 1.5', { kind: 'numNotBetween', lo: '9007199254740992.5', hi: '9007199254740993.5', inclusive: true }, [0, 2, 3, 5]],
        ['a reversed fractional range is empty', { kind: 'numBetween', lo: '5.5', hi: '1.5', inclusive: true }, []],
        ['> -7.5, typed', { kind: 'numCompare', op: '>', value: '-7.5' }, [0, 1, 2, 3, 5]],
        ['< -6.5, typed', { kind: 'numCompare', op: '<', value: '-6.5' }, [3]],
        ['>= -7.0', { kind: 'numCompare', op: '>=', value: '-7.0' }, [0, 1, 2, 3, 5]],
        ['> .5', { kind: 'numCompare', op: '>', value: '.5' }, [0, 1, 2, 5]],
        ['<= 3.', { kind: 'numCompare', op: '<=', value: '3.' }, [3, 5]],
        // Below every double, on either side of zero.
        ['> 1e-10000', { kind: 'numCompare', op: '>', value: '1e-10000' }, [0, 1, 2, 5]],
        ['>= -1e-10000', { kind: 'numCompare', op: '>=', value: '-1e-10000' }, [0, 1, 2, 5]],
        ['< 1e-10000', { kind: 'numCompare', op: '<', value: '1e-10000' }, [3]],
        ['= 0e-10000 is zero', { kind: 'numCompare', op: '!=', value: '0.000e-10000' }, [0, 1, 2, 3, 5]],
        // Past every 64-bit integer, however large the exponent.
        ['< 1e30, typed', { kind: 'numCompare', op: '<', value: '1e30' }, [0, 1, 2, 3, 5]],
        ['> 1e30, typed', { kind: 'numCompare', op: '>', value: '1e30' }, []],
        ['!= 1e999999999999999999999', { kind: 'numCompare', op: '!=', value: '1e999999999999999999999' }, [0, 1, 2, 3, 5]],
        ['= -1e400', { kind: 'numCompare', op: '=', value: '-1e400' }, []],
        ['>= -1e400', { kind: 'numCompare', op: '>=', value: '-1e400' }, [0, 1, 2, 3, 5]],
        ['between -1e400 and 3.5', { kind: 'numBetween', lo: '-1e400', hi: '3.5', inclusive: true }, [3, 5]],
        // Not a number at all: nothing, `!=` included.
        ['a half-written exponent matches nothing', { kind: 'numCompare', op: '!=', value: '1e' }, []],
        ['a lone point matches nothing', { kind: 'numCompare', op: '!=', value: '.' }, []],
    ];
    for (const [name, p, want] of cases) {
        test(name, async () => { expect(await rows(0, p)).toEqual(want); });
    }

    test('missing rows pass only with includeMissing', async () => {
        expect(await rows(0, { kind: 'numCompare', op: '=', value: '9007199254740993' }, true)).toEqual([1, 4]);
        expect(await rows(0, { kind: 'numCompare', op: '>', value: Infinity }, true)).toEqual([4]);
    });

    test('a labelled integer64: two codes that round to one double stay apart', async () => {
        expect(await rows(1, { kind: 'numCompare', op: '=', value: '9007199254740993' })).toEqual([1]);
        expect(await rows(1, { kind: 'numCompare', op: '=', value: P53 })).toEqual([0]);
        expect(await rows(1, { kind: 'numBetween', lo: P53, hi: P53, inclusive: true })).toEqual([0]);
        expect(await rows(1, { kind: 'setIn', values: ['9007199254740993'] })).toEqual([1]);
        expect(await rows(1, { kind: 'setIn', values: [P53] })).toEqual([0]);
    });

    test('an unsigned column takes fractional bounds past 2^63', async () => {
        expect(await rows(2, { kind: 'numCompare', op: '>=', value: '18446744073709551614.5' })).toEqual([0]);
        expect(await rows(2, { kind: 'numCompare', op: '<', value: '18446744073709551614.5' })).toEqual([1, 2, 3, 5]);
        expect(await rows(2, { kind: 'numCompare', op: '<=', value: '1.8446744073709551615e19' })).toEqual([0, 1, 2, 3, 5]);
        expect(await rows(2, { kind: 'numCompare', op: '<', value: '-0.5' })).toEqual([]);
    });

    test('a set value on an unlabelled column is the integer it names, as in Copy as R code', async () => {
        // Edited by hand after a Value counts pick: a leading zero.
        expect(await rows(0, { kind: 'setIn', values: ['09007199254740993'] })).toEqual([1]);
        expect(await rows(0, { kind: 'setIn', values: ['9007199254740993', 3] })).toEqual([1, 5]);
        expect(await rows(0, { kind: 'setNotIn', values: ['-007'] })).toEqual([0, 1, 2, 5]);
        expect(await rows(0, { kind: 'setIn', values: ['abc', '2.5'] })).toEqual([]);
    });

    test('an unsigned column compares past 2^63', async () => {
        expect(await rows(2, { kind: 'numCompare', op: '>', value: '9223372036854775808' })).toEqual([0]);
        expect(await rows(2, { kind: 'numCompare', op: '=', value: '18446744073709551615' })).toEqual([0]);
        expect(await rows(2, { kind: 'numCompare', op: '<', value: '9007199254740994' })).toEqual([1, 3, 5]);
    });
});

describe('the filter popover keeps an integer64 bound exact', () => {
    const form = (value: string) => ({ ...defaultFormState(), numCompare: { op: '=' as const, value } });

    test('an integer a double cannot hold stays decimal text on an Int64 column', () => {
        expect(buildPredicate('numCompare', form('9007199254740993'), { setUsesChecklist: false, int64: true }))
            .toEqual({ kind: 'numCompare', op: '=', value: '9007199254740993' });
        expect(buildPredicate('numCompare', form(' -9007199254740993 '), { setUsesChecklist: false, int64: true }))
            .toEqual({ kind: 'numCompare', op: '=', value: '-9007199254740993' });
        const s = { ...defaultFormState(), numBetween: { lo: '9007199254740993', hi: '9223372036854775807', inclusive: true } };
        expect(buildPredicate('numBetween', s, { setUsesChecklist: false, int64: true }))
            .toEqual({ kind: 'numBetween', lo: '9007199254740993', hi: '9223372036854775807', inclusive: true });
    });

    test('a whole number a double holds exactly stays a number', () => {
        const opts = { setUsesChecklist: false, int64: true };
        expect(buildPredicate('numCompare', form('3'), opts)).toEqual({ kind: 'numCompare', op: '=', value: 3 });
        expect(buildPredicate('numCompare', form('9007199254740992'), opts)).toEqual({ kind: 'numCompare', op: '=', value: P53 });
        expect(buildPredicate('numCompare', form('Infinity'), opts)).toEqual({ kind: 'numCompare', op: '=', value: Infinity });
        expect(buildPredicate('numCompare', form('abc'), opts)).toBeNull();
        // Trailing junk is read as before (`parseFloat` takes the prefix).
        expect(buildPredicate('numCompare', form('12abc'), opts)).toEqual({ kind: 'numCompare', op: '=', value: 12 });
    });

    test('a fraction or an exponent stays the text that was typed', () => {
        const opts = { setUsesChecklist: false, int64: true };
        for (const [typed, kept] of [
            ['9007199254740992.5', '9007199254740992.5'], [' -2.50 ', '-2.50'], ['2.5', '2.5'], ['.5', '.5'], ['3.', '3.'],
            ['1e3', '1e3'], ['9.007199254740993E15', '9.007199254740993E15'], ['+1.5e-3', '+1.5e-3'],
        ]) {
            expect(buildPredicate('numCompare', form(typed), opts)).toEqual({ kind: 'numCompare', op: '=', value: kept });
        }
        const s = { ...defaultFormState(), numBetween: { lo: '2.5', hi: '9007199254740992.5', inclusive: true } };
        expect(buildPredicate('numNotBetween', s, opts))
            .toEqual({ kind: 'numNotBetween', lo: '2.5', hi: '9007199254740992.5', inclusive: true });
    });

    test('other columns still parse to a double', () => {
        expect(buildPredicate('numCompare', form('9007199254740993'), { setUsesChecklist: false }))
            .toEqual({ kind: 'numCompare', op: '=', value: P53 });
        expect(buildPredicate('numCompare', form('2.5'), { setUsesChecklist: false })).toEqual({ kind: 'numCompare', op: '=', value: 2.5 });
        expect(buildPredicate('numCompare', form('1e3'), { setUsesChecklist: false })).toEqual({ kind: 'numCompare', op: '=', value: 1000 });
    });

    test('typed in the popover, a fractional bound filters the rows it should', async () => {
        const p = buildPredicate('numCompare', { ...defaultFormState(), numCompare: { op: '<', value: '9007199254740992.5' } },
            { setUsesChecklist: false, int64: true })!;
        // As the host and the saved state see it: through JSON.
        expect(await rows(0, JSON.parse(JSON.stringify(p)))).toEqual([0, 3, 5]);
    });

    test('a fractional bound reopens and re-applies unchanged, shows in the chip, and survives a thumb drag', () => {
        const p: FilterPredicate = { kind: 'numBetween', lo: '2.5', hi: '9007199254740992.5', inclusive: true };
        expect(seedFromEntry(p, true).numBetween).toEqual({ lo: '2.5', hi: '9007199254740992.5', inclusive: true });
        expect(buildPredicate(predicateToKindValue(p), seedFromEntry(p, true), { setUsesChecklist: false, int64: true })).toEqual(p);
        const col: ColumnSchema = { name: 'big', arrowType: 'Int64', dictionaryShipped: false, isInteger: true };
        expect(summarizePredicate(p, col)).toBe('big 2.5–9007199254740992.5');
        expect(summarizePredicate({ kind: 'numCompare', op: '<', value: '9007199254740992.5' }, col)).toBe('big < 9007199254740992.5');
        // The low thumb moves to 7; the high one sits at the double the text reads as.
        expect(brushNumBetween(seedFromEntry(p, true).numBetween, 7, parseFloat('9007199254740992.5'), true))
            .toEqual({ lo: '7', hi: '9007199254740992.5', inclusive: true });
    });

    test('a text bound reopens and re-applies unchanged, and shows in the chip', () => {
        const p: FilterPredicate = { kind: 'numBetween', lo: '9007199254740993', hi: '9007199254740995', inclusive: true };
        expect(buildPredicate(predicateToKindValue(p), seedFromEntry(p), { setUsesChecklist: false, int64: true })).toEqual(p);
        const col: ColumnSchema = { name: 'big', arrowType: 'Int64', dictionaryShipped: false, isInteger: true };
        expect(summarizePredicate(p, col)).toBe('big 9007199254740993–9007199254740995');
        expect(summarizePredicate({ ...p, upperInclusive: false }, col)).toBe('big ∈ [9007199254740993, 9007199254740995)');
    });
});

describe('reopening the popover keeps a numeric integer64 bound exact', () => {
    const opts = { setUsesChecklist: false, int64: true };
    const reapply = (p: FilterPredicate) => buildPredicate(predicateToKindValue(p), seedFromEntry(p, true), opts);

    test('a bound a double holds exactly, whose shortest spelling is another integer, re-applies unchanged', () => {
        // String(1000000000000000128) is "1000000000000000100".
        const p = buildPredicate('numCompare', { ...defaultFormState(), numCompare: { op: '=', value: '1000000000000000128' } }, opts)!;
        expect(p).toEqual({ kind: 'numCompare', op: '=', value: 1000000000000000128 });
        expect(seedFromEntry(p, true).numCompare.value).toBe('1000000000000000128');
        expect(reapply(p)).toEqual(p);
        // The chip names the same ID, in comparisons and ranges alike.
        const big: ColumnSchema = { name: 'big', arrowType: 'Int64', dictionaryShipped: false, isInteger: true };
        expect(summarizePredicate(p, big)).toBe('big = 1000000000000000128');
        expect(summarizePredicate({ kind: 'numBetween', lo: -1000000000000000128, hi: 1000000000000000128, inclusive: true }, big))
            .toBe('big -1000000000000000128–1000000000000000128');
        expect(summarizePredicate({ kind: 'numNotBetween', lo: 3, hi: 1000000000000000128, inclusive: false }, big))
            .toBe('big not in (3, 1000000000000000128)');
        // Another column keeps the double's own spelling.
        expect(summarizePredicate({ kind: 'numCompare', op: '=', value: 2.5 }, { ...big, arrowType: 'Float64', isInteger: false }))
            .toBe('big = 2.5');
        const between: FilterPredicate = { kind: 'numBetween', lo: -1000000000000000128, hi: 1e21, inclusive: true };
        expect(seedFromEntry(between, true).numBetween).toEqual({ lo: '-1000000000000000128', hi: '1000000000000000000000', inclusive: true });
        expect(reapply(between)).toEqual(between);
        expect(reapply({ ...between, kind: 'numNotBetween' })).toEqual({ ...between, kind: 'numNotBetween' });
    });

    test('other columns and fractional bounds keep the short spelling', () => {
        const p: FilterPredicate = { kind: 'numCompare', op: '=', value: 1e21 };
        expect(seedFromEntry(p).numCompare.value).toBe('1e+21');
        expect(seedFromEntry({ ...p, value: 2.5 }, true).numCompare.value).toBe('2.5');
    });
});

describe('a histogram thumb rewrites only the bound it moved', () => {
    const typed = { lo: '9007199254740993', hi: '9007199254740995', inclusive: true };
    // The thumbs sit at the doubles the two fields parse to.
    const atLo = parseFloat(typed.lo), atHi = parseFloat(typed.hi);

    test('the untouched bound keeps its exact text', () => {
        expect(brushNumBetween(typed, 3, atHi, true)).toEqual({ lo: '3', hi: '9007199254740995', inclusive: true });
        expect(brushNumBetween(typed, atLo, 1000000000000000128, true))
            .toEqual({ lo: '9007199254740993', hi: '1000000000000000128', inclusive: true });
    });

    test('an empty or unparseable field takes the thumb position', () => {
        expect(brushNumBetween({ lo: '', hi: '', inclusive: false }, 0, 10, true)).toEqual({ lo: '0', hi: '10', inclusive: false });
    });
});

describe('Copy as R code compares an integer64 as integer64', () => {
    const cols: ColumnSchema[] = [{ name: 'big', arrowType: 'Int64', dictionaryShipped: false, isInteger: true, typeTag: '<integer64>' }];
    const code = (predicate: FilterPredicate, includeMissing = false, flavor: 'dplyr' | 'base' | 'data.table' = 'base'): string => {
        const r = generateRCode({
            expression: 'df', sourceKind: 'data.frame', columns: cols, sort: EMPTY_SORT,
            filter: { entries: [{ id: 'a', columnIndex: 0, predicate, enabled: true, includeMissing }], labelsOnWhenFiltered: true },
            hiddenColumns: [], locale: 'en',
        }, flavor);
        if ('error' in r) throw new Error(r.error);
        return r.code;
    };
    const i64 = (v: string) => `bit64::as.integer64("${v}")`;

    test('no side is rounded to double', () => {
        for (const flavor of ['dplyr', 'base', 'data.table'] as const) {
            const c = code({ kind: 'numCompare', op: '=', value: '9007199254740993' }, false, flavor);
            expect(c).toContain(`big == ${i64('9007199254740993')}`);
            expect(c).not.toContain('as.double');
            expect(c).toContain('bit64');
        }
        expect(code({ kind: 'numCompare', op: '=', value: P53 })).toContain(`big == ${i64('9007199254740992')}`);
        expect(code({ kind: 'numCompare', op: '!=', value: 3 })).toContain(`big != ${i64('3')}`);
        expect(code({ kind: 'numCompare', op: '>', value: P53 })).toContain(`big >= ${i64('9007199254740993')}`);
        expect(code({ kind: 'numCompare', op: '<', value: 3 })).toContain(`big <= ${i64('2')}`);
        // A typed fractional bound moves to the integer that means the same.
        expect(code({ kind: 'numCompare', op: '<', value: '9007199254740992.5' })).toContain(`big <= ${i64('9007199254740992')}`);
        expect(code({ kind: 'numCompare', op: '>=', value: '9007199254740992.5' })).toContain(`big >= ${i64('9007199254740993')}`);
        expect(code({ kind: 'numCompare', op: '=', value: '9007199254740992.5' })).toContain('FALSE');
        expect(code({ kind: 'numCompare', op: '=', value: '9.007199254740993e15' })).toContain(`big == ${i64('9007199254740993')}`);
        expect(code({ kind: 'numBetween', lo: 1, hi: '9007199254740993', inclusive: true }))
            .toContain(`big >= ${i64('1')} & big <= ${i64('9007199254740993')}`);
        expect(code({ kind: 'numBetween', lo: 1, hi: 5, inclusive: true, upperInclusive: false }))
            .toContain(`big >= ${i64('1')} & big <= ${i64('4')}`);
        expect(code({ kind: 'numNotBetween', lo: 2, hi: 9, inclusive: true }))
            .toContain(`(big <= ${i64('1')} | big >= ${i64('10')})`);
    });

    test('a fractional bound moves to the integer that keeps its meaning', () => {
        expect(code({ kind: 'numCompare', op: '>=', value: 2.5 })).toContain(`big >= ${i64('3')}`);
        expect(code({ kind: 'numCompare', op: '<=', value: 2.5 })).toContain(`big <= ${i64('2')}`);
        expect(code({ kind: 'numCompare', op: '>', value: -2.5 })).toContain(`big >= ${i64('-2')}`);
        expect(code({ kind: 'numCompare', op: '=', value: 2.5 })).toContain('FALSE');
        expect(code({ kind: 'numCompare', op: '!=', value: 2.5 })).toContain('!bit64::is.na.integer64(big)');
    });

    test('a bound no integer64 reaches folds away; as.integer64() would make it NA', () => {
        const all = '!bit64::is.na.integer64(big)';
        expect(code({ kind: 'numCompare', op: '<', value: Infinity })).toContain(all);
        expect(code({ kind: 'numCompare', op: '>', value: Infinity })).toContain('FALSE');
        expect(code({ kind: 'numCompare', op: '<', value: 1e30 })).toContain(all);
        expect(code({ kind: 'numCompare', op: '>=', value: '-9223372036854775808' })).toContain(all);
        expect(code({ kind: 'numCompare', op: '=', value: '9223372036854775808' })).toContain('FALSE');
        expect(code({ kind: 'numBetween', lo: 1, hi: Infinity, inclusive: true })).toContain(`big >= ${i64('1')}`);
        expect(code({ kind: 'numBetween', lo: 1, hi: Infinity, inclusive: true })).not.toContain('Inf');
        expect(code({ kind: 'numCompare', op: '<=', value: '9223372036854775807' })).toContain(all);
        expect(code({ kind: 'numCompare', op: '<', value: '9223372036854775807' })).toContain(`big <= ${i64('9223372036854775806')}`);
        for (const c of [
            code({ kind: 'numCompare', op: '<', value: 1e30 }),
            code({ kind: 'numCompare', op: '=', value: '9223372036854775808' }),
        ]) expect(c).not.toContain('as.integer64(');
    });

    test('missing rows: kept only with includeMissing', () => {
        expect(code({ kind: 'numCompare', op: '=', value: 3 }, true))
            .toContain(`bit64::is.na.integer64(big) | big == ${i64('3')}`);
    });
});

// A brushed histogram bar filters to the rows it counts. Past 2^53 a
// value's double can sit on a bin edge the integer is below, and the
// column's smallest and largest values can round inward past the outer
// edges, so the bins are assigned on the integers too.
describe('brushing an integer64 histogram past 2^53', () => {
    /** 4000 ids near 1.6e18 (doubles there are 256 apart), every one odd. */
    async function ids(): Promise<ArrowSliceReader> {
        const base = 1_600_000_000_000_000_001n;
        let seed = 12345;
        const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
        const v: (bigint | null)[] = [base + 127n, base + 1_000_001n + 128n];
        for (let i = 0; i < 4000; i++) v.push(i % 97 === 0 ? null : base + BigInt(next() % 1_000_000) * 2n);
        const t = new Table({ id: vectorFromArray(v, new Int64()) });
        const p = join(DIR, `ids-${Math.random()}.arrow`);
        writeFileSync(p, tableToIPC(t, 'file'));
        return ArrowSliceReader.open(p);
    }
    async function count(r: ArrowSliceReader, predicate: FilterPredicate): Promise<number> {
        const out = await computeFilteredIndices(r, {
            entries: [{ id: 'a', columnIndex: 0, predicate, enabled: true, includeMissing: false }],
            labelsOnWhenFiltered: true,
        }, { labelsOn: true, formatOn: true, digits: 3 });
        return out!.length;
    }

    test('every bar, and every bar together, filters to its count', async () => {
        const r = await ids();
        const { profile } = await computeProfile(r, 0);
        const present = 4002 - Math.ceil(4000 / 97);
        for (const bins of [profile.histogram!, await computeHistogramForColumn(r, 0)]) {
            const last = bins.length - 1;
            expect(brushedTotal(bins, 0, last)).toBe(present);
            expect(await count(r, brushPredicate(bins, 0, last))).toBe(present);
            for (let i = 0; i <= last; i++) {
                expect(await count(r, brushPredicate(bins, i, i))).toBe(brushedTotal(bins, i, i));
            }
        }
        await r.close();
    });

    test('values that are one double share a bar that still filters to them', async () => {
        const t = new Table({ id: vectorFromArray([9007199254740993n, 9007199254740992n, 9007199254740993n], new Int64()) });
        const p = join(DIR, `pair-${Math.random()}.arrow`);
        writeFileSync(p, tableToIPC(t, 'file'));
        const r = await ArrowSliceReader.open(p);
        const { profile } = await computeProfile(r, 0);
        const bins = profile.histogram!;
        expect(brushedTotal(bins, 0, bins.length - 1)).toBe(3);
        expect(await count(r, brushPredicate(bins, 0, bins.length - 1))).toBe(3);
        await r.close();
    });
});
