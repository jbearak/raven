/**
 * Filter engine — predicate evaluation against the same Arrow batches
 * the sort engine consumes. Returns `undefined` for an empty / all-
 * disabled state so the panel can skip storage.
 *
 * Covered in this file across Tasks 4–8:
 *   - Universal predicates and disabled chips (Task 4)
 *   - Numeric predicates (Task 5)
 *   - String predicates incl. regex (Task 6)
 *   - Date / Timestamp predicates (Task 7)
 *   - Set / factor / labelled predicates with Labels routing (Task 8)
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeData, makeVector, Table, tableToIPC, TimestampMicrosecond } from 'apache-arrow';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import type { FilterEntry, FilterState } from '../../editors/vscode/src/data-viewer/messages';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

const CTX_LABELS_ON = { labelsOn: true, formatOn: true, digits: 3 };

function state(entries: FilterEntry[]): FilterState {
    return { entries, labelsOnWhenFiltered: true };
}

function entry(id: string, columnIndex: number, predicate: FilterEntry['predicate'], opts: Partial<Omit<FilterEntry, 'id' | 'columnIndex' | 'predicate'>> = {}): FilterEntry {
    return {
        id,
        columnIndex,
        predicate,
        enabled: opts.enabled ?? true,
        includeMissing: opts.includeMissing ?? false,
    };
}

describe('computeFilteredIndices — empty / disabled state', () => {
    test('empty entries returns undefined', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const out = await computeFilteredIndices(r, state([]), CTX_LABELS_ON);
        expect(out).toBeUndefined();
        await r.close();
    });

    test('all-disabled entries returns undefined', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'isEmpty' }, { enabled: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out).toBeUndefined();
        await r.close();
    });
});

describe('computeFilteredIndices — isEmpty / isNotEmpty', () => {
    test('isEmpty on y keeps rows where y is NA/NaN (rows 1,2)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(out).toBeInstanceOf(Uint32Array);
        expect(Array.from(out!)).toEqual([1, 2]);
        await r.close();
    });

    test('isNotEmpty on y keeps non-missing rows (0,3,4)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isNotEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });

    test('isEmpty on a column with no missing values returns []', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'isEmpty' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — multi-entry AND', () => {
    test('disabled entries are ignored', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const enabled = entry('a', 1, { kind: 'isNotEmpty' });
        const disabled = entry('b', 1, { kind: 'isEmpty' }, { enabled: false });
        const out = await computeFilteredIndices(r, state([enabled, disabled]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — includeMissing', () => {
    test('isNotEmpty ignores includeMissing: NA / NaN rows still fail', async () => {
        // Mirrors isEmpty, which keeps missing rows regardless of the flag.
        // The UI hides the checkbox for both, but a seeded or restored entry
        // can still carry includeMissing: true.
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'isNotEmpty' }, { includeMissing: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — numeric predicates on x [1,2,3,4,5]', () => {
    test('numCompare = 3', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numCompare', op: '=', value: 3 });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([2]);
        await r.close();
    });
    test('numCompare >= 3', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numCompare', op: '>=', value: 3 });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([2, 3, 4]);
        await r.close();
    });
    test('numBetween inclusive 2..4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numBetween', lo: 2, hi: 4, inclusive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1, 2, 3]);
        await r.close();
    });
    test('numBetween exclusive 2..4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numBetween', lo: 2, hi: 4, inclusive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([2]);
        await r.close();
    });
    test('numNotBetween inclusive 2..4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 0, { kind: 'numNotBetween', lo: 2, hi: 4, inclusive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — numeric on Float with NA / NaN / Inf', () => {
    test('numCompare > 0 keeps 1.5 and +Inf', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'numCompare', op: '>', value: 0 });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('numCompare > 0 with includeMissing keeps NA/NaN too', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 1, { kind: 'numCompare', op: '>', value: 0 }, { includeMissing: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1, 2, 3]);
        await r.close();
    });
});

describe('computeFilteredIndices — string predicates on s ["a","b",null,"d","e"]', () => {
    test('strCompare = "b" case-insensitive matches "b"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strCompare', op: '=', value: 'B', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1]);
        await r.close();
    });
    test('strCompare = "B" case-sensitive matches nothing', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strCompare', op: '=', value: 'B', caseSensitive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
    test('strContains "d" matches "d"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strContains', value: 'd', caseSensitive: false, negate: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([3]);
        await r.close();
    });
    test('strContains negate -> excludes "d"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strContains', value: 'd', caseSensitive: false, negate: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1, 4]);
        await r.close();
    });
    test('strStartsWith "a"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strStartsWith', value: 'a', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0]);
        await r.close();
    });
    test('strEndsWith "e"', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strEndsWith', value: 'e', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([4]);
        await r.close();
    });
    test('strRegex /^[ab]$/i', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strRegex', pattern: '^[ab]$', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1]);
        await r.close();
    });
    test('strRegex with invalid pattern returns []  (entry treated as no-match, no throw)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'strRegex', pattern: '[', caseSensitive: false });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

const CTX_LABELS_OFF = { labelsOn: false, formatOn: true, digits: 3 };

describe('computeFilteredIndices — setIn on factor with Labels routing', () => {
    test('Labels on: setIn matches against label strings', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 3, { kind: 'setIn', values: ['low', 'high'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 2, 3]);
        await r.close();
    });
    test('Labels off: setIn matches against codes', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 3, { kind: 'setIn', values: [0, 2] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(out!)).toEqual([0, 2, 3]);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn/setNotIn on labelled FLOAT (tiny col 6 lbl=[1,2,3,1,2])', () => {
    // valueLabels {1:low,2:mid,3:high}. Matching is by underlying code and
    // MUST be identical with Labels on and off (toggle-independent).
    test('setIn [1] matches rows 0,3 with Labels ON', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: [1] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('setIn [1] matches rows 0,3 with Labels OFF (identical)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: [1] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('setIn [1,3] matches rows 0,2,3', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: [1, 3] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 2, 3]);
        await r.close();
    });
    test('setNotIn [1] keeps rows 1,2,4', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setNotIn', values: [1] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1, 2, 4]);
        await r.close();
    });
    test('label strings (legacy) no longer match — codes only', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 6, { kind: 'setIn', values: ['low'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn on labelled INT (labelled-non-float col 0 rating=[1,2,3,1,2])', () => {
    test('setIn [2] matches rows 1,4 regardless of toggle', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const e = entry('a', 0, { kind: 'setIn', values: [2] });
        const on = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        const off = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(on!)).toEqual([1, 4]);
        expect(Array.from(off!)).toEqual([1, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn on value-labelled STRING stays WYSIWYG (toggle-dependent)', () => {
    // labelled-non-float.arrow col 1 `answer`: Utf8 ['Y','N','M','Y','N'],
    // value labels {Y:Apple,N:Mango,M:Zebra}. This column must KEEP the
    // displayed-string semantics (matches labels when Labels on, raw codes
    // when off) — it must NOT use the code-based labelled-numeric path.
    test('Labels ON: matches the displayed label (rows 0,3)', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const e = entry('a', 1, { kind: 'setIn', values: ['Apple'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 3]);
        await r.close();
    });
    test('Labels OFF: matches raw codes, so the label string matches nothing', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const e = entry('a', 1, { kind: 'setIn', values: ['Apple'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — setIn on plain string column', () => {
    test('matches values directly regardless of labelsOn', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 2, { kind: 'setIn', values: ['a', 'e'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 4]);
        await r.close();
    });
});

describe('computeFilteredIndices — date predicates on d (DateDay 2024-01-01..05)', () => {
    test('dateCompare < 2024-01-03', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 4, { kind: 'dateCompare', op: '<', value: '2024-01-03' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([0, 1]);
        await r.close();
    });
    test('dateBetween inclusive 2024-01-02..2024-01-04', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 4, { kind: 'dateBetween', lo: '2024-01-02', hi: '2024-01-04', inclusive: true });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([1, 2, 3]);
        await r.close();
    });
    test('a range with one unparseable bound is a no-match, as in Copy as R code', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        for (const kind of ['dateBetween', 'dateNotBetween'] as const) {
            for (const [lo, hi] of [['2024-01-03', 'not-a-date'], ['not-a-date', '2024-01-03']]) {
                const out = await computeFilteredIndices(r, state([entry('a', 4, { kind, lo, hi, inclusive: true })]), CTX_LABELS_ON);
                expect([kind, lo, Array.from(out!)]).toEqual([kind, lo, []]);
            }
        }
        await r.close();
    });
    test('dateCompare != with unparseable date is a no-match (not keep-all)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const e = entry('a', 4, { kind: 'dateCompare', op: '!=', value: 'not-a-date' });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        expect(Array.from(out!)).toEqual([]);
        await r.close();
    });
});

describe('computeFilteredIndices — date-time predicates on a microsecond Timestamp', () => {
    // Rows: 2023-12-31, 2024-01-01, 2024-01-01 00:00:00.5, 2024-01-02 (UTC).
    const MICROS = [1703980800000000n, 1704067200000000n, 1704067200500000n, 1704153600000000n];
    async function rows(predicate: FilterEntry['predicate'], micros = MICROS, zone = 'UTC'): Promise<number[]> {
        const dir = mkdtempSync(join(tmpdir(), 'raven-dv-ts-filter-'));
        try {
            const type = new TimestampMicrosecond(zone);
            const t = makeVector(makeData({ type, length: micros.length, data: BigInt64Array.from(micros) }));
            const path = join(dir, 'ts.arrow');
            writeFileSync(path, tableToIPC(new Table({ t }), 'file'));
            const r = await ArrowSliceReader.open(path);
            try {
                return Array.from((await computeFilteredIndices(r, state([entry('a', 0, predicate)]), CTX_LABELS_ON))!);
            } finally {
                await r.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    const MIDNIGHT = '2024-01-01T00:00:00Z';
    // What the popover's datetime-local input gives: no offset. It is the
    // time the grid shows, so it is read in the column's zone, whatever
    // zone this process runs in.
    test('a bound without an offset is a time in the zone the column is shown in', async () => {
        const typed = { kind: 'dateCompare', op: '=', value: '2024-01-01T00:00' } as const;
        expect(await rows(typed)).toEqual([1]);
        // 2024-01-01 00:00 in Kolkata (UTC+05:30) is 2023-12-31 18:30 UTC.
        const kolkata = [1704047400000000n, 1704067200000000n];
        expect(await rows(typed, kolkata, 'Asia/Kolkata')).toEqual([0]);
        expect(await rows({ kind: 'dateBetween', lo: '2024-01-01T00:00', hi: '2024-01-01T05:30', inclusive: true }, kolkata, 'Asia/Kolkata'))
            .toEqual([0, 1]);
        // An explicit offset is still an instant.
        expect(await rows({ kind: 'dateCompare', op: '=', value: MIDNIGHT }, kolkata, 'Asia/Kolkata')).toEqual([1]);
    });
    test('each comparison keeps the rows on its side of the instant', async () => {
        expect(await rows({ kind: 'dateCompare', op: '=', value: MIDNIGHT })).toEqual([1]);
        expect(await rows({ kind: 'dateCompare', op: '!=', value: MIDNIGHT })).toEqual([0, 2, 3]);
        expect(await rows({ kind: 'dateCompare', op: '<', value: MIDNIGHT })).toEqual([0]);
        expect(await rows({ kind: 'dateCompare', op: '>', value: MIDNIGHT })).toEqual([2, 3]);
        expect(await rows({ kind: 'dateCompare', op: '<=', value: '2024-01-01T00:00:00.500Z' })).toEqual([0, 1, 2]);
    });
    test('a range keeps the instants inside it', async () => {
        expect(await rows({ kind: 'dateBetween', lo: MIDNIGHT, hi: '2024-01-01T12:00:00Z', inclusive: true })).toEqual([1, 2]);
        expect(await rows({ kind: 'dateNotBetween', lo: MIDNIGHT, hi: '2024-01-01T12:00:00Z', inclusive: true })).toEqual([0, 3]);
    });
});

describe('computeFilteredIndices — setIn on UNSHIPPED large-dictionary factor', () => {
    // Forcing dictionaryThreshold=1 leaves the dictionary unshipped
    // (schema.dictionary undefined), so the engine must resolve labels via
    // reader.getLabels through dictFromGetLabels. bigdict.arrow: one `zip`
    // factor, 50 rows, 20 levels zip-000..zip-019, index = row % 20.
    test('Labels on: resolves labels via getLabels and matches', async () => {
        const r = await ArrowSliceReader.open(FIX('bigdict.arrow'), { dictionaryThreshold: 1 });
        expect(r.schema.columns[0].dictionaryShipped).toBe(false);
        const e = entry('a', 0, { kind: 'setIn', values: ['zip-000', 'zip-005'] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_ON);
        // row % 20 ∈ {0, 5} over rows 0..49.
        expect(Array.from(out!)).toEqual([0, 5, 20, 25, 40, 45]);
        await r.close();
    });
    test('Labels off: matches against integer codes', async () => {
        const r = await ArrowSliceReader.open(FIX('bigdict.arrow'), { dictionaryThreshold: 1 });
        const e = entry('a', 0, { kind: 'setIn', values: [0, 5] });
        const out = await computeFilteredIndices(r, state([e]), CTX_LABELS_OFF);
        expect(Array.from(out!)).toEqual([0, 5, 20, 25, 40, 45]);
        await r.close();
    });
});
