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
): Promise<Uint32Array> {
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
        cols.push(await buildSortColumn(reader, k.columnIndex, schema, ctx));
        directions.push(k.direction === 'desc' ? -1 : 1);
    }

    // Materialize the permutation as a plain number[] for sort(), then
    // copy back. Uint32Array.sort exists but lacks the stability guarantee
    // and the comparator signature isn't well-typed.
    const idx: number[] = Array.from(perm);
    idx.sort((a, b) => compareRows(a, b, cols, directions));
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
): Promise<SortColumn> {
    const arrowType = schema.arrowType;

    if (arrowType.startsWith('Dictionary')) {
        return buildDictionarySortColumn(reader, columnIndex, schema, ctx);
    }
    if (arrowType.startsWith('Int') || arrowType === 'Bool') {
        return buildNumericSortColumn(reader, columnIndex, false);
    }
    if (arrowType.startsWith('Float')) {
        // For value-labelled numerics, the Labels toggle (when on) routes
        // sort through the displayed-text key — same as a factor.
        if (ctx.labelsOn && schema.valueLabels) {
            return buildValueLabelledFloatSortColumn(reader, columnIndex, schema);
        }
        return buildNumericSortColumn(reader, columnIndex, true);
    }
    if (arrowType.startsWith('Date')) {
        return buildNumericSortColumn(reader, columnIndex, false);
    }
    if (arrowType.startsWith('Timestamp')) {
        return buildTimestampSortColumn(reader, columnIndex);
    }
    // Utf8 / LargeUtf8 / fallback.
    return buildStringSortColumn(reader, columnIndex);
}

/** Numeric sort column from an Int / Bool / Float / Date column.
 *  When `floatNaNMissing` is true, NaN values are treated as missing
 *  (matches Float NA semantics from the bootstrap profile). */
async function buildNumericSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    floatNaNMissing: boolean,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values = new Float64Array(nrow);
    const missing = new Uint8Array(nrow);
    let written = 0;
    for await (const batch of iterateBatches(reader)) {
        const child = batch.batch.getChildAt(columnIndex);
        for (let r = 0; r < batch.length; r++) {
            const v = child.get(r);
            const i = batch.start + r;
            if (v === null || v === undefined) {
                missing[i] = 1;
                values[i] = 0;
            } else if (typeof v === 'bigint') {
                values[i] = Number(v);
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

/** Timestamp sort: read raw microsecond bigint, fall back through
 *  `Number()` for ordering. JS number is safe up to ~2^53 µs which is
 *  ~285 years past the epoch — plenty for the present-day use case.
 *  Pre-1970 and far-future timestamps round-trip without precision loss
 *  at the second level. */
async function buildTimestampSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values = new Float64Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader)) {
        const child = batch.batch.getChildAt(columnIndex);
        const data = child.data[0];
        for (let r = 0; r < batch.length; r++) {
            const i = batch.start + r;
            if (isNullAt(data, r)) {
                missing[i] = 1;
                values[i] = 0;
                continue;
            }
            const raw = data.values[r] as bigint;
            values[i] = Number(raw);
        }
    }
    return {
        missing,
        compare: (a, b) => Math.sign(values[a] - values[b]),
    };
}

async function buildStringSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const values: string[] = new Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader)) {
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
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const codes = new Int32Array(nrow);
    const missing = new Uint8Array(nrow);
    for await (const batch of iterateBatches(reader)) {
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

/** Value-labelled Float column (haven_labelled or foreign value.labels)
 *  with Labels on: sort by displayed label, falling back to the
 *  formatted raw value when no label exists for a given cell. */
async function buildValueLabelledFloatSortColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
): Promise<SortColumn> {
    const nrow = reader.nrow;
    const display: string[] = new Array(nrow);
    const missing = new Uint8Array(nrow);
    const valueLabels = schema.valueLabels ?? {};
    for await (const batch of iterateBatches(reader)) {
        const child = batch.batch.getChildAt(columnIndex);
        for (let r = 0; r < batch.length; r++) {
            const i = batch.start + r;
            const v = child.get(r);
            if (v === null || v === undefined || Number.isNaN(v as number)) {
                missing[i] = 1;
                display[i] = '';
                continue;
            }
            const num = v as number;
            const label = valueLabels[String(num)];
            display[i] = label !== undefined ? label : String(num);
        }
    }
    return {
        missing,
        compare: (a, b) => COLLATOR.compare(display[a], display[b]),
    };
}

/** Async iterator over a reader's record batches with their starting
 *  row index. */
async function* iterateBatches(
    reader: ArrowSliceReader,
): AsyncGenerator<{ batch: any; start: number; length: number }> {
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await readerGetBatch(reader, bi);
        const start = reader.batchStarts[bi];
        const length = reader.batchStarts[bi + 1] - start;
        yield { batch, start, length };
    }
}

/** Bridge into the reader's private batch loader. The reader caches
 *  decoded batches with an LRU, so repeated reads here are cheap and
 *  warm the cache for the subsequent `getRows()` window. */
function readerGetBatch(reader: ArrowSliceReader, i: number): Promise<any> {
    return (reader as any).getBatch(i);
}

function isNullAt(data: any, row: number): boolean {
    const bm = data.nullBitmap;
    if (!bm || bm.length === 0) return false;
    const byteIdx = row >> 3;
    if (byteIdx >= bm.length) return false;
    return ((bm[byteIdx] >> (row & 7)) & 1) === 0;
}
