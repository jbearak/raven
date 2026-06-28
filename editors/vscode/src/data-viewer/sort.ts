/**
 * Sort engine for the data viewer.
 *
 * Produces a row permutation (`Uint32Array` of length `nrow`) from one or
 * more {@link SortKey}s, sourced directly from the open
 * {@link ArrowSliceReader}.
 *
 * Invariants:
 *   - **Stable**: equal keys retain their original (pre-sort) order. We
 *     rely on `Array.prototype.sort` which is required to be stable
 *     since ES2019.
 *   - **NA-last in both directions**: null, NaN, and other missing
 *     sentinels always sort after present values regardless of `'asc' |
 *     'desc'`. Matches R's `order(..., na.last = TRUE)` and the
 *     end-state of every reference product we surveyed.
 *   - **WYSIWYG label routing**: when `labelsOn` is true, factor and
 *     value-labelled columns sort by the displayed label string. When
 *     `labelsOn` is false, they sort by the underlying integer code /
 *     numeric value. This is Raven-specific and is documented as a
 *     trade-off in `docs/data-viewer.md`.
 *   - **Format independence**: the `formatOn` / `digits` toolbar state
 *     never affects sort order. Format only controls rendering.
 *
 * Performance:
 *   - Per-key column reads use the same async batch path as `getRows`,
 *     so the existing batch LRU absorbs random access from subsequent
 *     window reads. We read each sort-key column exactly once per
 *     `computePermutation` call.
 *   - String columns are compared via `Intl.Collator` with
 *     `numeric: true` so "file_2" sorts before "file_10".
 *   - The off-main-thread worker path (spec §5.2) is not yet wired —
 *     for ≥ 500k rows we still run on the extension-host event loop.
 *     Adding the worker is a follow-up; the current path is correct
 *     and bounded by reader-batch I/O.
 */

import type { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import type { SortKey } from './messages';
import { iterateBatches } from './batch-iter';
import { throwIfAborted, yieldToEventLoop } from './abort';

/** Toolbar snapshot used to derive sort keys WYSIWYG. */
export type SortContext = {
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
};

/** Per-key cached column data. `missing[i]` is non-zero iff row `i`
 *  should be considered null/NaN. The `compare(a, b)` function returns a
 *  signed integer for two present rows; sign convention is asc (low to
 *  high). The driver multiplies by ±1 per the direction. */
type SortColumn = {
    missing: Uint8Array;
    compare: (a: number, b: number) => number;
};

const COLLATOR = new Intl.Collator(undefined, {
    sensitivity: 'variant',
    numeric: true,
});

/**
 * Build a row permutation that, when applied to the unsorted reader
 * row stream, yields rows in the order described by `keys`.
 *
 * An empty `keys` array returns the identity permutation.
 */
export async function computePermutation(
    reader: ArrowSliceReader,
    keys: readonly SortKey[],
    ctx: SortContext,
    opts?: { signal?: AbortSignal },
): Promise<Uint32Array> {
    const signal = opts?.signal;
    const nrow = reader.nrow;
    const perm = new Uint32Array(nrow);
    for (let i = 0; i < nrow; i++) perm[i] = i;
    if (keys.length === 0) return perm;

    const cols: SortColumn[] = [];
    const directions: (1 | -1)[] = [];
    for (const k of keys) {
        const schema = reader.schema.columns[k.columnIndex];
        if (!schema) {
            throw new Error(
                `computePermutation: unknown columnIndex ${k.columnIndex}`,
            );
        }
        cols.push(await buildSortColumn(reader, k.columnIndex, schema, ctx, signal));
        directions.push(k.direction === 'desc' ? -1 : 1);
    }

    // Materialize the permutation as a plain number[] for sort(), then
    // copy back. Uint32Array.sort exists but lacks the stability guarantee
    // and the comparator signature isn't well-typed.
    const idx: number[] = Array.from(perm);
    // Yield once more before the (synchronous, potentially expensive) sort so
    // a Cancel queued during the final column read is delivered and observed
    // here, leaving the data in natural order rather than running the full
    // sort first. Only the cancellable restore passes a signal.
    if (signal) {
        await yieldToEventLoop();
        throwIfAborted(signal);
    }
    idx.sort((a, b) => compareRows(a, b, cols, directions));
    throwIfAborted(signal);
    for (let i = 0; i < nrow; i++) perm[i] = idx[i];
    return perm;
}

/** Multi-key, NA-last comparator. Missing rows always sort after present
 *  ones, regardless of direction. Equal across all keys → return 0
 *  (sort() is stable). */
function compareRows(
    a: number,
    b: number,
    cols: SortColumn[],
    directions: (1 | -1)[],
): number {
    for (let k = 0; k < cols.length; k++) {
        const col = cols[k];
        const am = col.missing[a] !== 0;
        const bm = col.missing[b] !== 0;
        if (am && bm) continue;
        if (am) return 1;       // a missing → after b
        if (bm) return -1;      // b missing → after a
        const c = col.compare(a, b);
        if (c !== 0) return c * directions[k];
    }
    return 0;
}

async function buildSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    ctx: SortContext,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const arrowType = schema.arrowType;

    if (arrowType.startsWith('Dictionary')) {
        return buildDictionarySortColumn(reader, columnIndex, schema, ctx, signal);
    }
    // Value-labelled columns (haven_labelled, foreign::value.labels,
    // readstata13) can be backed by any Arrow type whose `.get()`
    // produces a number, bigint, or string — cell-render.ts shows the
    // label for any such cell, regardless of underlying storage. Sort
    // must match: when Labels is on, route through the displayed-text
    // key. Restricted to the type families whose wire form yields a
    // labels-eligible cell (Int*/Float/Utf8); Bool, Date, Timestamp
    // never get label rendering today and so don't need label sorting.
    if (ctx.labelsOn && schema.valueLabels
        && (arrowType.startsWith('Int')
            || arrowType.startsWith('Float')
            || arrowType === 'Utf8'
            || arrowType === 'LargeUtf8')) {
        return buildValueLabelledSortColumn(reader, columnIndex, schema, signal);
    }
    if (arrowType === 'Int64') {
        // 64-bit integers exceed Number's 2^53 safe range; use signed
        // BigInt storage + bigint comparator so the order stays exact.
        return buildBigIntSortColumn(reader, columnIndex, false, signal);
    }
    if (arrowType === 'Uint64') {
        // Same reasoning, but unsigned storage — BigInt64Array would
        // wrap any value above 2^63-1 to a negative two's-complement
        // bigint and corrupt ascending order.
        return buildBigIntSortColumn(reader, columnIndex, true, signal);
    }
    if (arrowType.startsWith('Int') || arrowType === 'Bool') {
        return buildNumericSortColumn(reader, columnIndex, false, signal);
    }
    if (arrowType.startsWith('Float')) {
        return buildNumericSortColumn(reader, columnIndex, true, signal);
    }
    if (arrowType.startsWith('Date')) {
        return buildNumericSortColumn(reader, columnIndex, false, signal);
    }
    if (arrowType.startsWith('Timestamp')) {
        return buildTimestampSortColumn(reader, columnIndex, signal);
    }
    // Utf8 / LargeUtf8 / fallback.
    return buildStringSortColumn(reader, columnIndex, signal);
}

/** Numeric sort column from Int8/16/32, Bool, Float, or Date columns.
 *  All of these have `.get()` results that fit in JS Number without
 *  precision loss (Int8/16/32 < 2^32, Bool 0/1, Float64 IEEE-754,
 *  Date32 < ~5.8M days, Date64 ms < 2^53 for any plausible year).
 *  Int64/Uint64 columns route through {@link buildBigIntSortColumn}.
 *
 *  When `floatNaNMissing` is true, NaN values are treated as missing
 *  (matches Float NA semantics from the bootstrap profile). */
async function buildNumericSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    floatNaNMissing: boolean,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values = new Float64Array(nrow);
    const missing = new Uint8Array(nrow);
    let written = 0;
    for await (const batch of iterateBatches(reader, signal)) {
        const child = batch.batch.getChildAt(columnIndex);
        for (let r = 0; r < batch.length; r++) {
            const v = child.get(r);
            const i = batch.start + r;
            if (v === null || v === undefined) {
                missing[i] = 1;
                values[i] = 0;
            } else if (floatNaNMissing && Number.isNaN(v as number)) {
                missing[i] = 1;
                values[i] = 0;
            } else {
                values[i] = v as number;
            }
            written++;
        }
    }
    if (written !== nrow) {
        throw new Error(`buildNumericSortColumn: read ${written}, expected ${nrow}`);
    }
    return {
        missing,
        compare: (a, b) => Math.sign(values[a] - values[b]),
    };
}

/** Sort column for Int64 / Uint64. Bigint storage + bigint comparator
 *  so distinct values beyond 2^53 stay distinct (Number coercion would
 *  coalesce them and produce spurious sort ties). Storage type depends
 *  on signedness:
 *
 *  - `Int64`  uses `BigInt64Array`  — range [-2^63, 2^63 - 1].
 *  - `Uint64` uses `BigUint64Array` — range [0, 2^64 - 1].
 *
 *  Cross-storage works in both directions: indexed access returns
 *  `bigint`, and bigint `<` / `>` is exact across all magnitudes. */
async function buildBigIntSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    unsigned: boolean,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values: BigInt64Array | BigUint64Array = unsigned
        ? new BigUint64Array(nrow)
        : new BigInt64Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader, signal)) {
        const child = batch.batch.getChildAt(columnIndex);
        for (let r = 0; r < batch.length; r++) {
            const v = child.get(r);
            const i = batch.start + r;
            if (v === null || v === undefined) {
                missing[i] = 1;
                continue;
            }
            values[i] = typeof v === 'bigint' ? v : BigInt(v as number);
        }
    }
    return {
        missing,
        compare: (a, b) => {
            const va = values[a];
            const vb = values[b];
            return va < vb ? -1 : va > vb ? 1 : 0;
        },
    };
}

/** Timestamp sort: raw values are microseconds-since-epoch bigints
 *  from Arrow. Storage stays as `BigInt64Array` so far-future or
 *  pre-1970 timestamps (which would exceed Number's safe-int range at
 *  microsecond resolution beyond ~285 years from epoch) sort
 *  exactly. */
async function buildTimestampSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values = new BigInt64Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader, signal)) {
        const child = batch.batch.getChildAt(columnIndex);
        const data = child.data[0];
        for (let r = 0; r < batch.length; r++) {
            const i = batch.start + r;
            if (isNullAt(data, r)) {
                missing[i] = 1;
                continue;
            }
            values[i] = data.values[r] as bigint;
        }
    }
    return {
        missing,
        compare: (a, b) => {
            const va = values[a];
            const vb = values[b];
            return va < vb ? -1 : va > vb ? 1 : 0;
        },
    };
}

async function buildStringSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values: string[] = new Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader, signal)) {
        const child = batch.batch.getChildAt(columnIndex);
        for (let r = 0; r < batch.length; r++) {
            const i = batch.start + r;
            const v = child.get(r);
            if (v === null || v === undefined) {
                missing[i] = 1;
                values[i] = '';
            } else {
                values[i] = String(v);
            }
        }
    }
    return {
        missing,
        compare: (a, b) => COLLATOR.compare(values[a], values[b]),
    };
}

/** Dictionary-encoded column. When Labels is on, sort by the resolved
 *  label string (via the shipped dictionary or, for unshipped large
 *  dictionaries, by fetched label slices). When Labels is off, sort by
 *  the integer code. */
async function buildDictionarySortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    ctx: SortContext,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const codes = new Int32Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader, signal)) {
        const child = batch.batch.getChildAt(columnIndex);
        const data = child.data[0];
        for (let r = 0; r < batch.length; r++) {
            const i = batch.start + r;
            if (isNullAt(data, r)) {
                missing[i] = 1;
                codes[i] = -1;
                continue;
            }
            codes[i] = data.values[r] as number;
        }
    }

    if (!ctx.labelsOn) {
        return {
            missing,
            compare: (a, b) => Math.sign(codes[a] - codes[b]),
        };
    }

    // Labels on. Resolve each unique code to its label. For shipped
    // dictionaries we have the strings; for large/unshipped dictionaries
    // we fetch on demand and cache.
    const labelByCode = new Map<number, string>();
    const dict = schema.dictionary;
    if (dict) {
        for (let i = 0; i < dict.length; i++) labelByCode.set(i, dict[i]);
    } else {
        // Determine which codes appear, fetch in bulk via reader.getLabels.
        const need = new Set<number>();
        for (let i = 0; i < nrow; i++) {
            if (!missing[i]) need.add(codes[i]);
        }
        const fetched = await reader.getLabels(columnIndex, [...need]);
        // getLabels is an extra async hop after the cancellable batch scan;
        // check the signal so a Cancel delivered during it is observed
        // promptly rather than only after the (cheap) compare step.
        throwIfAborted(signal);
        for (const [k, v] of Object.entries(fetched)) {
            labelByCode.set(Number(k), v);
        }
    }
    return {
        missing,
        compare: (a, b) => {
            const la = labelByCode.get(codes[a]) ?? '';
            const lb = labelByCode.get(codes[b]) ?? '';
            return COLLATOR.compare(la, lb);
        },
    };
}

/** Value-labelled column (haven_labelled, foreign::value.labels,
 *  readstata13) with Labels on: sort by the displayed label, falling
 *  back to the raw value's string form when no label exists. Works
 *  across the storage types whose `.get()` returns a `number`,
 *  `bigint`, or `string` — the same set that cell-render.ts's label
 *  lookup applies to. Keys are looked up via `String(rawValue)` to
 *  match the JSON-key form that the R-side bootstrap writes (numeric
 *  haven_labelled values become decimal-string keys; string values
 *  stay as-is). */
async function buildValueLabelledSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    signal?: AbortSignal,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const display: string[] = new Array(nrow);
    const missing = new Uint8Array(nrow);
    const valueLabels = schema.valueLabels ?? {};
    for await (const batch of iterateBatches(reader, signal)) {
        const child = batch.batch.getChildAt(columnIndex);
        for (let r = 0; r < batch.length; r++) {
            const i = batch.start + r;
            const v = child.get(r);
            if (v === null || v === undefined) {
                missing[i] = 1;
                display[i] = '';
                continue;
            }
            if (typeof v === 'number' && Number.isNaN(v)) {
                missing[i] = 1;
                display[i] = '';
                continue;
            }
            const key = typeof v === 'bigint' ? v.toString() : String(v);
            const label = valueLabels[key];
            display[i] = label !== undefined ? label : key;
        }
    }
    return {
        missing,
        compare: (a, b) => COLLATOR.compare(display[a], display[b]),
    };
}

function isNullAt(data: any, row: number): boolean {
    const bm = data.nullBitmap;
    if (!bm || bm.length === 0) return false;
    const byteIdx = row >> 3;
    if (byteIdx >= bm.length) return false;
    return ((bm[byteIdx] >> (row & 7)) & 1) === 0;
}
