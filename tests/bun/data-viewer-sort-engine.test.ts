/**
 * Sort engine — builds a row permutation from one or more SortKeys.
 *
 * Invariants exercised here:
 *   - Stable across equal keys.
 *   - null / NaN / NA always last in both asc and desc (matches R's
 *     `order(..., na.last = TRUE)`).
 *   - Multi-column lex order with per-key direction.
 *   - Format toggle never affects sort order.
 *   - Labels-on routes factor + value-labelled columns through the
 *     displayed-text key; Labels-off routes them through the underlying
 *     numeric / dictionary-code key. Same column produces different
 *     orders under the two modes.
 */

import { describe, test, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computePermutation } from '../../editors/vscode/src/data-viewer/sort';
import type { SortKey } from '../../editors/vscode/src/data-viewer/messages';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

const CTX_LABELS_ON = { labelsOn: true, formatOn: true, digits: 3 };
const CTX_LABELS_OFF = { labelsOn: false, formatOn: true, digits: 3 };

describe('computePermutation: empty / identity', () => {
    test('empty key list returns identity', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(r, [], CTX_LABELS_ON);
        expect(Array.from(p)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });

    test('returns a Uint32Array of length nrow', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(r, [], CTX_LABELS_ON);
        expect(p).toBeInstanceOf(Uint32Array);
        expect(p.length).toBe(r.nrow);
        await r.close();
    });
});

describe('computePermutation: numeric Int column', () => {
    test('int asc on tiny.x', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // x is [1,2,3,4,5] — already asc.
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });

    test('int desc on tiny.x', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([4, 3, 2, 1, 0]);
        await r.close();
    });
});

describe('computePermutation: Float with NA / NaN / ±Inf', () => {
    test('asc: -Inf < 1.5 < +Inf, NA and NaN last in original order', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // y = [1.5, NA, NaN, +Inf, -Inf]
        const p = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([4, 0, 3, 1, 2]);
        await r.close();
    });

    test('desc: +Inf > 1.5 > -Inf, NA and NaN still last in original order', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([3, 0, 4, 1, 2]);
        await r.close();
    });
});

describe('computePermutation: String column', () => {
    test('string asc on tiny.s with one null', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // s = ['a','b',null,'d','e']
        const p = await computePermutation(
            r,
            [{ columnIndex: 2, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([0, 1, 3, 4, 2]);
        await r.close();
    });

    test('string desc on tiny.s puts null last (not first)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 2, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([4, 3, 1, 0, 2]);
        await r.close();
    });
});

describe('computePermutation: factor column (WYSIWYG rule)', () => {
    // tiny.f indices [0, 1, 0, 2, 1] with levels ['low', 'med', 'high'].
    // Labels off → sort by integer code. Labels on → sort by label string
    // (alphabetic via Intl.Collator).
    test('Labels off: sort by integer code (declared level order)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 3, direction: 'asc' }],
            CTX_LABELS_OFF,
        );
        // codes asc: 0,0,1,1,2 → rows [0,2,1,4,3] (stable)
        expect(Array.from(p)).toEqual([0, 2, 1, 4, 3]);
        await r.close();
    });

    test('Labels on: sort by label string', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 3, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        // labels: row 0→low, 1→med, 2→low, 3→high, 4→med.
        // alphabetic asc: high(3), low(0,2), med(1,4) → [3,0,2,1,4]
        expect(Array.from(p)).toEqual([3, 0, 2, 1, 4]);
        await r.close();
    });
});

describe('computePermutation: haven_labelled (WYSIWYG rule)', () => {
    // tiny.lbl = [1,2,3,1,2] with valueLabels {1:'low',2:'mid',3:'high'}.
    test('Labels off: sort by underlying numeric', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 6, direction: 'asc' }],
            CTX_LABELS_OFF,
        );
        // values asc: 1,1,2,2,3 → [0,3,1,4,2]
        expect(Array.from(p)).toEqual([0, 3, 1, 4, 2]);
        await r.close();
    });

    test('Labels on: sort by displayed label', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 6, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        // labels: row 0→low, 1→mid, 2→high, 3→low, 4→mid.
        // alphabetic asc: high(2), low(0,3), mid(1,4) → [2,0,3,1,4]
        expect(Array.from(p)).toEqual([2, 0, 3, 1, 4]);
        await r.close();
    });
});

describe('computePermutation: Date and Timestamp', () => {
    test('date asc (already in order)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 4, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });

    test('timestamp desc', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 5, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([4, 3, 2, 1, 0]);
        await r.close();
    });
});

describe('computePermutation: multi-column lex order', () => {
    test('f asc, then x asc (factor ties broken by x)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // f codes [0,1,0,2,1]; tiebreak by x [1,2,3,4,5].
        const p = await computePermutation(
            r,
            [
                { columnIndex: 3, direction: 'asc' },
                { columnIndex: 0, direction: 'asc' },
            ],
            CTX_LABELS_OFF,
        );
        // groups by f: 0→[0,2] (x=1,3), 1→[1,4] (x=2,5), 2→[3] (x=4).
        // Within each group x asc → [0,2,1,4,3].
        expect(Array.from(p)).toEqual([0, 2, 1, 4, 3]);
        await r.close();
    });

    test('f asc, then x desc (descending tiebreaker)', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const p = await computePermutation(
            r,
            [
                { columnIndex: 3, direction: 'asc' },
                { columnIndex: 0, direction: 'desc' },
            ],
            CTX_LABELS_OFF,
        );
        // f asc same groups; within each, x desc.
        // f=0: rows 2(x=3) > 0(x=1); f=1: rows 4(x=5) > 1(x=2); f=2: row 3.
        expect(Array.from(p)).toEqual([2, 0, 4, 1, 3]);
        await r.close();
    });
});

describe('computePermutation: stability', () => {
    test('single-column sort preserves original order for equal keys', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        // Sort by f (codes [0,1,0,2,1]) — ties in original order.
        const p = await computePermutation(
            r,
            [{ columnIndex: 3, direction: 'asc' }],
            CTX_LABELS_OFF,
        );
        // f=0 rows in original order: 0 then 2. f=1: 1 then 4.
        expect(Array.from(p)).toEqual([0, 2, 1, 4, 3]);
        await r.close();
    });
});

describe('computePermutation: format toggle does not affect order', () => {
    test('y asc with formatOn=true vs false produces same permutation', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const a = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'asc' }],
            { labelsOn: true, formatOn: true, digits: 0 },
        );
        const b = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'asc' }],
            { labelsOn: true, formatOn: false, digits: 0 },
        );
        expect(Array.from(a)).toEqual(Array.from(b));
        await r.close();
    });
});

describe('computePermutation: multibatch', () => {
    test('asc on multibatch.i over 1000 rows', async () => {
        const r = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        // i = 1..1000 → already sorted.
        expect(p[0]).toBe(0);
        expect(p[999]).toBe(999);
        await r.close();
    });

    test('desc on multibatch.i over 1000 rows', async () => {
        const r = await ArrowSliceReader.open(FIX('multibatch.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(p[0]).toBe(999);
        expect(p[999]).toBe(0);
        await r.close();
    });
});

describe('computePermutation: Uint64 above signed 64-bit max', () => {
    // Fixture row order:
    //   0: 2^63 + 1   1: 2^64 - 1   2: 1   3: 0
    // BigInt64Array would wrap rows 0 and 1 to negative two's-complement
    // bigints, sorting them BEFORE the small values. BigUint64Array
    // preserves the unsigned ordering.
    test('asc keeps huge unsigned values above small ones', async () => {
        const r = await ArrowSliceReader.open(FIX('uint64.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([3, 2, 0, 1]);
        await r.close();
    });

    test('desc puts Uint64 max first', async () => {
        const r = await ArrowSliceReader.open(FIX('uint64.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([1, 0, 2, 3]);
        await r.close();
    });
});

describe('computePermutation: value-labelled non-Float columns', () => {
    // labelled-non-float.arrow row order — both columns are value-
    // labelled (Int32 + Utf8) so they exercise the generalized
    // labelled-sort path.
    //
    //   rating (Int32): [1, 2, 3, 1, 2]
    //     labels { 1: zebra, 2: apple, 3: mango }
    //   answer (Utf8):  [Y, N, M, Y, N]
    //     labels { Y: Yes, N: No, M: Maybe }
    test('Int32-labelled: Labels off sorts by integer code', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'asc' }],
            CTX_LABELS_OFF,
        );
        // codes asc: 1,1,2,2,3 → [0, 3, 1, 4, 2] (stable)
        expect(Array.from(p)).toEqual([0, 3, 1, 4, 2]);
        await r.close();
    });

    test('Int32-labelled: Labels on sorts by label string', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        // apple(1,4), mango(2), zebra(0,3) → [1, 4, 2, 0, 3]
        expect(Array.from(p)).toEqual([1, 4, 2, 0, 3]);
        await r.close();
    });

    test('Utf8-labelled: Labels off sorts by raw code string', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'asc' }],
            CTX_LABELS_OFF,
        );
        // codes asc: "M","N","N","Y","Y" → [2, 1, 4, 0, 3]
        expect(Array.from(p)).toEqual([2, 1, 4, 0, 3]);
        await r.close();
    });

    test('Utf8-labelled: Labels on sorts by label string', async () => {
        const r = await ArrowSliceReader.open(FIX('labelled-non-float.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 1, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        // labels asc: Maybe(2), No(1,4), Yes(0,3) → [2, 1, 4, 0, 3]
        expect(Array.from(p)).toEqual([2, 1, 4, 0, 3]);
        await r.close();
    });
});

describe('computePermutation: Int64 beyond MAX_SAFE_INTEGER', () => {
    // Fixture row order (see generate-data-viewer.mjs for the math):
    //   0: 2^53 + 5    → Number 2^53 + 4 (precise: largest of three)
    //   1: 2^53 + 3    → Number 2^53 + 4 (precise: middle; COLLIDES with row 0
    //                                     under naive Number coercion)
    //   2: 2^53 + 1    → Number 2^53     (precise: smallest of three)
    //   3: 1
    //   4: -1
    //
    // Naive Number stable sort would yield asc = [4, 3, 2, 0, 1]
    // (rows 0 and 1 tie at 2^53+4 and stay in original order). The
    // bigint sort path distinguishes the precise values and yields
    // [4, 3, 2, 1, 0] — the asc test below would FAIL if the engine
    // silently coerced through Number.
    test('asc distinguishes precise values past Number.MAX_SAFE_INTEGER', async () => {
        const r = await ArrowSliceReader.open(FIX('bigint64.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'asc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([4, 3, 2, 1, 0]);
        await r.close();
    });

    test('desc puts largest precise value first', async () => {
        const r = await ArrowSliceReader.open(FIX('bigint64.arrow'));
        const p = await computePermutation(
            r,
            [{ columnIndex: 0, direction: 'desc' }],
            CTX_LABELS_ON,
        );
        expect(Array.from(p)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });
});

describe('computePermutation: keys with unused order are ignored', () => {
    test('an empty SortKey[] returns identity even when passed twice', async () => {
        const r = await ArrowSliceReader.open(FIX('tiny.arrow'));
        const a = await computePermutation(r, [], CTX_LABELS_ON);
        const b = await computePermutation(r, [], CTX_LABELS_OFF);
        expect(Array.from(a)).toEqual([0, 1, 2, 3, 4]);
        expect(Array.from(b)).toEqual([0, 1, 2, 3, 4]);
        await r.close();
    });
});

const _typecheck: SortKey = { columnIndex: 0, direction: 'asc' };
void _typecheck;
