/**
 * Filter engine for the data viewer. Produces a Uint32Array of surviving
 * row indices from a FilterState evaluated against an open
 * ArrowSliceReader.
 *
 * Invariants:
 *   - **Empty / all-disabled state**: returns undefined so the panel
 *     can skip filter storage entirely.
 *   - **Cross-entry AND**: enabled entries are intersected on a row
 *     mask; disabled entries are ignored.
 *   - **WYSIWYG label routing (factors & value-labelled strings)**: when
 *     `labelsOn` is true, factor and value-labelled *string* columns evaluate
 *     `setIn` / `setNotIn` against the displayed label string; when false,
 *     against the underlying code / string value.
 *   - **Labelled-numeric set membership is code-based**: a numeric column
 *     carrying `valueLabels` always matches `setIn` / `setNotIn` against the
 *     underlying numeric code, ignoring `labelsOn` (the popover stores codes;
 *     labels are display-only). This is intentionally NOT WYSIWYG so the
 *     filter survives a Labels toggle.
 *   - **Format independence**: digits / formatOn never affects the
 *     row index. Numeric predicates always match against the raw
 *     double.
 *   - **Int64 / Uint64 are exact**: a numeric predicate on such a column
 *     compares the stored integer with the bound's real value
 *     ({@link int64Intervals}); a bound a double can't hold arrives as
 *     decimal text (`NumBound`). Nothing is rounded to double, so
 *     `= 2^53` does not keep 2^53 + 1. Histogram bins are assigned the
 *     same way (`histograms.ts` `binIndex`), so a brush still filters to
 *     the rows its bars count.
 *   - **NA / NaN semantics**: missing rows fail any predicate unless
 *     `includeMissing` is true on that entry, in which case the entry
 *     passes for missing rows regardless of predicate value. The two
 *     missingness predicates ignore `includeMissing`: `isEmpty` always
 *     keeps missing rows and `isNotEmpty` always drops them (a seeded or
 *     restored entry can carry the flag even though the UI hides it).
 *
 * Performance:
 *   - Row mask is a `Uint8Array(nrow)`; final compaction to
 *     `Uint32Array` is O(nrow).
 *   - Per-entry column reads stream through the reader's batch loader
 *     (same iterator the sort engine uses), reading only that column.
 *   - String predicates are evaluated once per distinct value, not once
 *     per row: once per dictionary entry for factor columns, and through
 *     a bounded memo for plain string columns (see
 *     {@link stringAcceptor}). Case-insensitive matching therefore folds
 *     each distinct value once.
 */

import type { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import type { FilterEntry, FilterPredicate, FilterState } from './messages';
import { iterateBatches } from './batch-iter';
import { throwIfAborted, yieldToEventLoop } from './abort';

export type FilterContext = {
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
};

export async function computeFilteredIndices(
    reader: ArrowSliceReader,
    state: FilterState,
    ctx: FilterContext,
    opts?: { signal?: AbortSignal },
): Promise<Uint32Array | undefined> {
    const signal = opts?.signal;
    const active = state.entries.filter(e => e.enabled);
    if (active.length === 0) return undefined;

    const nrow = reader.nrow;
    const mask = new Uint8Array(nrow);
    mask.fill(1);

    for (const e of active) {
        throwIfAborted(signal);
        await applyEntry(reader, e, ctx, mask, signal);
        if (allZero(mask)) break;
    }
    // Yield once more before the synchronous compaction tail so a Cancel
    // queued during the final entry's mask scan is delivered and honored here,
    // leaving the data unfiltered rather than publishing compacted indices.
    if (signal) await yieldToEventLoop();
    throwIfAborted(signal);
    return compact(mask);
}

/**
 * The pass mask of one entry over every row (1 ⇔ the row passes). The
 * scan worker caches these per entry, so editing one entry of a filter
 * recombines masks instead of re-evaluating the others (F3).
 */
export async function computeEntryMask(
    reader: ArrowSliceReader,
    entry: FilterEntry,
    ctx: FilterContext,
    opts?: { signal?: AbortSignal },
): Promise<Uint8Array> {
    const mask = new Uint8Array(reader.nrow);
    mask.fill(1);
    await applyEntry(reader, entry, ctx, mask, opts?.signal);
    return mask;
}

/** Row indices where `mask` is non-zero, ascending. */
export function maskToIndices(mask: Uint8Array): Uint32Array {
    return compact(mask);
}

async function applyEntry(
    reader: ArrowSliceReader,
    entry: FilterEntry,
    ctx: FilterContext,
    mask: Uint8Array,
    signal?: AbortSignal,
): Promise<void> {
    const schema = reader.schema.columns[entry.columnIndex];
    if (!schema) {
        throw new Error(`computeFilteredIndices: unknown columnIndex ${entry.columnIndex}`);
    }
    const p = entry.predicate;
    const accept = await acceptorFor(reader, entry.columnIndex, schema, p, ctx, signal);
    // isEmpty / isNotEmpty target missingness itself, so includeMissing
    // never applies to them: missing rows always pass isEmpty and always
    // fail isNotEmpty. All other predicates use the entry's flag.
    const include = p.kind === 'isEmpty'
        ? true
        : p.kind === 'isNotEmpty' ? false : entry.includeMissing;
    const missing = await missingMaskFor(reader, entry.columnIndex, schema, signal);

    // Yield once more before the synchronous mask scan so a Cancel queued
    // during the acceptor/missing-mask reads is delivered and observed here,
    // leaving the data unfiltered rather than publishing filtered indices.
    // Only the cancellable restore passes a signal; throwIfAborted(undefined)
    // is a no-op on the interactive path.
    if (signal) await yieldToEventLoop();
    throwIfAborted(signal);
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 0) continue;
        if (missing[i]) {
            mask[i] = include ? 1 : 0;
            continue;
        }
        mask[i] = accept(i) ? 1 : 0;
    }
    throwIfAborted(signal);
}

/** Returns a fn `(rowIndex) => boolean` whose domain is **non-missing**
 *  rows (missing-row handling is enforced by the outer loop). Built
 *  once per entry; per-row evaluation is O(1) lookup. */
async function acceptorFor(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    predicate: FilterEntry['predicate'],
    ctx: FilterContext,
    signal?: AbortSignal,
): Promise<(row: number) => boolean> {
    if (predicate.kind === 'isEmpty') return () => false;
    if (predicate.kind === 'isNotEmpty') return () => true;

    if (predicate.kind === 'bool') {
        const values = await loadBool(reader, columnIndex, signal);
        const want = predicate.value ? 1 : 0;
        return (i) => values[i] === want;
    }

    if (predicate.kind === 'numCompare' || predicate.kind === 'numBetween' || predicate.kind === 'numNotBetween') {
        if (isInt64Type(schema.arrowType)) {
            // Exact: the column's integers against the bound's real value.
            // As doubles, every integer past 2^53 rounds to a neighbour
            // and `= 2^53` would keep 2^53 + 1 too.
            const intervals = int64Intervals(predicate);
            if (intervals.length === 0) return () => false;
            const values = await loadInt64(reader, columnIndex, signal);
            const [a, b] = intervals;
            const inA = intervalTest(a);
            if (!b) return (i) => inA(values[i]);
            const inB = intervalTest(b);
            return (i) => inA(values[i]) || inB(values[i]);
        }
        // A bound that isn't a number (a `null` from a lossy transport)
        // matches nothing; comparing with it would coerce it to 0.
        const bounds = predicate.kind === 'numCompare'
            ? [numBoundValue(predicate.value)]
            : [numBoundValue(predicate.lo), numBoundValue(predicate.hi)];
        if (bounds.some(b => b === undefined)) return () => false;
        const values = await loadNumeric(reader, columnIndex, signal);
        if (predicate.kind === 'numCompare') {
            const v = bounds[0]!;
            switch (predicate.op) {
                case '=': return (i) => values[i] === v;
                case '!=': return (i) => values[i] !== v;
                case '<': return (i) => values[i] < v;
                case '<=': return (i) => values[i] <= v;
                case '>': return (i) => values[i] > v;
                case '>=': return (i) => values[i] >= v;
            }
        }
        const lo = bounds[0]!, hi = bounds[1]!, incl = predicate.inclusive;
        if (predicate.kind === 'numBetween') {
            const hiIncl = predicate.upperInclusive ?? incl;
            if (hiIncl !== incl) {
                return incl
                    ? (i) => values[i] >= lo && values[i] < hi
                    : (i) => values[i] > lo && values[i] <= hi;
            }
            return incl
                ? (i) => values[i] >= lo && values[i] <= hi
                : (i) => values[i] > lo && values[i] < hi;
        }
        return incl
            ? (i) => values[i] < lo || values[i] > hi
            : (i) => values[i] <= lo || values[i] >= hi;
    }

    if (predicate.kind === 'strCompare'
        || predicate.kind === 'strContains'
        || predicate.kind === 'strStartsWith'
        || predicate.kind === 'strEndsWith'
        || predicate.kind === 'strRegex') {
        const cs = predicate.caseSensitive;
        const fold = (x: string): string => (cs ? x : x.toLowerCase());
        let test: (hay: string) => boolean;
        switch (predicate.kind) {
            case 'strCompare': {
                const needle = fold(predicate.value);
                const eq = predicate.op === '=';
                test = (hay) => (fold(hay) === needle) === eq;
                break;
            }
            case 'strContains': {
                const needle = fold(predicate.value);
                const neg = predicate.negate;
                test = (hay) => fold(hay).includes(needle) !== neg;
                break;
            }
            case 'strStartsWith': {
                const needle = fold(predicate.value);
                test = (hay) => fold(hay).startsWith(needle);
                break;
            }
            case 'strEndsWith': {
                const needle = fold(predicate.value);
                test = (hay) => fold(hay).endsWith(needle);
                break;
            }
            case 'strRegex': {
                // NB: the compiled pattern is user-supplied and `r.test` runs
                // synchronously on the extension-host event loop, once per
                // distinct value. A catastrophic-backtracking pattern (e.g.
                // `(a+)+$`) on a large frame can stall the host. This is user-
                // self-inflicted and the webview validates syntax (not ReDoS)
                // before applying; a hard guard would require a worker. If we
                // ever see this in practice, move filter compute off-thread.
                let rx: RegExp | null = null;
                try {
                    rx = new RegExp(predicate.pattern, cs ? '' : 'i');
                } catch {
                    // Invalid pattern: the chip should already be marked
                    // invalid by the webview, but we may still be invoked
                    // (e.g. on restore from persistence after a code
                    // change). Treat as no-match without throwing.
                    rx = null;
                }
                if (!rx) return () => false;
                const r = rx;
                test = (hay) => r.test(hay);
                break;
            }
        }
        return stringAcceptor(reader, columnIndex, schema, test, signal);
    }

    if (predicate.kind === 'dateCompare'
        || predicate.kind === 'dateBetween'
        || predicate.kind === 'dateNotBetween') {
        // Convert ISO strings to the same numeric domain the underlying
        // arrow values live in.
        //
        // apache-arrow's child.get(r) for Date32<DAY> (DateDay) returns
        // ms-since-epoch — NOT day-count — even though the raw typed array
        // stores days. loadNumeric therefore stores ms for all Date columns.
        // Timestamp columns (bigint microseconds) coerce to Number ms * 1000
        // via loadNumeric's bigint path, which loses sub-ms precision but is
        // fine for user-typed ISO strings.
        const values = await loadNumeric(reader, columnIndex, signal);
        const isTs = schema.arrowType.startsWith('Timestamp');
        const toUnit = (iso: string): number => {
            const ms = Date.parse(iso);
            if (!Number.isFinite(ms)) return NaN;
            if (isTs) return ms * 1000;
            // Date32<DAY> / Date64: loadNumeric stores ms-since-epoch.
            return ms;
        };
        switch (predicate.kind) {
            case 'dateCompare': {
                const v = toUnit(predicate.value);
                // Unparseable ISO -> no-match, mirroring the invalid-regex
                // fallback. Without this guard `!=` would keep every row,
                // since `x !== NaN` is always true.
                if (!Number.isFinite(v)) return () => false;
                switch (predicate.op) {
                    case '=': return (i) => values[i] === v;
                    case '!=': return (i) => values[i] !== v;
                    case '<': return (i) => values[i] < v;
                    case '<=': return (i) => values[i] <= v;
                    case '>': return (i) => values[i] > v;
                    case '>=': return (i) => values[i] >= v;
                }
            }
            case 'dateBetween': {
                const lo = toUnit(predicate.lo), hi = toUnit(predicate.hi);
                return predicate.inclusive
                    ? (i) => values[i] >= lo && values[i] <= hi
                    : (i) => values[i] > lo && values[i] < hi;
            }
            case 'dateNotBetween': {
                const lo = toUnit(predicate.lo), hi = toUnit(predicate.hi);
                return predicate.inclusive
                    ? (i) => values[i] < lo || values[i] > hi
                    : (i) => values[i] <= lo || values[i] >= hi;
            }
        }
    }

    if (predicate.kind === 'setIn' || predicate.kind === 'setNotIn') {
        const wantStr = new Set(predicate.values.map(String));
        const isFactor = schema.arrowType.startsWith('Dictionary');
        const hasValueLabels = !!schema.valueLabels;

        if (isFactor) {
            const codes = await loadFactorCodes(reader, columnIndex, signal);
            if (ctx.labelsOn) {
                const labels: string[] = Array.isArray(schema.dictionary)
                    ? schema.dictionary
                    : await dictFromGetLabels(reader, columnIndex, codes, signal);
                return predicate.kind === 'setIn'
                    ? (i) => wantStr.has(labels[codes[i]])
                    : (i) => !wantStr.has(labels[codes[i]]);
            }
            return predicate.kind === 'setIn'
                ? (i) => wantStr.has(String(codes[i]))
                : (i) => !wantStr.has(String(codes[i]));
        }

        // Labelled NUMERIC column: always match the underlying numeric code,
        // regardless of the Labels toggle. The popover stores codes (numbers)
        // for these columns; labels are display-only. This makes the filter
        // toggle-independent (flipping Labels never invalidates it).
        const t = schema.arrowType;
        const isNumericLabelled = !isFactor && hasValueLabels
            && (t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float'));
        if (isNumericLabelled && isInt64Type(t)) {
            // Int64/UInt64: exact, on the decimal text (Value Counts counts
            // on the bigint and sends values a double can't hold as text).
            const want = new Set(predicate.values.map(int64SetKey).filter(k => k !== undefined));
            const values = await loadString(reader, columnIndex, signal);
            return predicate.kind === 'setIn'
                ? (i) => want.has(values[i])
                : (i) => !want.has(values[i]);
        }
        if (isNumericLabelled) {
            const want = new Set(predicate.values.filter(isNumberLike).map(Number));
            const values = await loadNumeric(reader, columnIndex, signal);
            return predicate.kind === 'setIn'
                ? (i) => want.has(values[i])
                : (i) => !want.has(values[i]);
        }

        if (hasValueLabels && ctx.labelsOn) {
            const displayed = await loadValueLabelled(reader, columnIndex, schema, signal);
            return predicate.kind === 'setIn'
                ? (i) => wantStr.has(displayed[i])
                : (i) => !wantStr.has(displayed[i]);
        }

        const values = await loadString(reader, columnIndex, signal);
        return predicate.kind === 'setIn'
            ? (i) => wantStr.has(values[i])
            : (i) => !wantStr.has(values[i]);
    }

    const _exhaustive: never = predicate;
    throw new Error(`filter: unhandled predicate ${(_exhaustive as { kind: string }).kind}`);
}

/** An Arrow Int64 / Uint64 column (a `bit64::integer64` in R). */
export function isInt64Type(arrowType: string): boolean {
    return /^U?[Ii]nt64$/.test(arrowType);
}

const INT_TEXT = /^[+-]?[0-9]+$/;

/** A numeric bound as a double: the number itself, or numeric text read
 *  as one. `undefined` when it is no number (a `null` from a lossy
 *  transport, other text). */
export function numBoundValue(b: unknown): number | undefined {
    if (typeof b === 'number') return b;
    if (typeof b !== 'string' || b.trim() === '') return undefined;
    const n = Number(b);
    return Number.isNaN(n) ? undefined : n;
}

/** A bound's exact floor and ceiling. Infinite bounds stay `±Infinity`;
 *  `undefined` when the bound is no number, or NaN. */
function boundFloorCeil(b: unknown): { floor: bigint | number; ceil: bigint | number } | undefined {
    if (typeof b === 'string' && INT_TEXT.test(b.trim())) {
        const v = BigInt(b.trim());
        return { floor: v, ceil: v };
    }
    const n = numBoundValue(b);
    if (n === undefined || Number.isNaN(n)) return undefined;
    if (!Number.isFinite(n)) return { floor: n, ceil: n };
    return { floor: BigInt(Math.floor(n)), ceil: BigInt(Math.ceil(n)) };
}

/** A set of integers `{ n : lo ≤ n ≤ hi }`; an absent side is unbounded. */
export type IntInterval = { lo?: bigint; hi?: bigint };

/** The integers `n` with `n op bound`, exactly, as a union of intervals
 *  (`[]` ⇔ none). A fractional bound moves to the nearest integer that
 *  keeps the comparison's meaning (`n >= 2.5` ⇔ `n >= 3`). */
function compareIntervals(op: '=' | '!=' | '<' | '<=' | '>' | '>=', bound: unknown): IntInterval[] {
    const fc = boundFloorCeil(bound);
    if (!fc) return [];
    const { floor, ceil } = fc;
    const from = (x: bigint | number, shift: bigint): IntInterval[] =>
        typeof x === 'bigint' ? [{ lo: x + shift }] : x > 0 ? [] : [{}];
    const upTo = (x: bigint | number, shift: bigint): IntInterval[] =>
        typeof x === 'bigint' ? [{ hi: x + shift }] : x > 0 ? [{}] : [];
    switch (op) {
        case '>=': return from(ceil, 0n);
        case '>': return from(floor, 1n);
        case '<=': return upTo(floor, 0n);
        case '<': return upTo(ceil, -1n);
        case '=': return typeof floor === 'bigint' && floor === ceil ? [{ lo: floor, hi: floor }] : [];
        case '!=': return typeof floor === 'bigint' && floor === ceil
            ? [{ hi: floor - 1n }, { lo: floor + 1n }] : [{}];
    }
}

/**
 * The integers a numeric predicate keeps, as a union of at most two
 * inclusive intervals (`[]` ⇔ none). This is what `num*` filters mean on
 * an Int64 / Uint64 column: the bound's real value against each stored
 * integer, with no rounding to double on either side. Shared by the
 * engine and by Copy as R code (`r-code.ts`), so the two agree.
 *
 * A bound that is no number (a `null` from a lossy transport, NaN)
 * yields `[]` for every operator, `!=` included.
 */
export function int64Intervals(
    p: Extract<FilterPredicate, { kind: 'numCompare' | 'numBetween' | 'numNotBetween' }>,
): IntInterval[] {
    if (p.kind === 'numCompare') return compareIntervals(p.op, p.value);
    if (boundFloorCeil(p.lo) === undefined || boundFloorCeil(p.hi) === undefined) return [];
    if (p.kind === 'numNotBetween') {
        return [
            ...compareIntervals(p.inclusive ? '<' : '<=', p.lo),
            ...compareIntervals(p.inclusive ? '>' : '>=', p.hi),
        ];
    }
    const hiIncl = p.upperInclusive ?? p.inclusive;
    const [a] = compareIntervals(p.inclusive ? '>=' : '>', p.lo);
    const [b] = compareIntervals(hiIncl ? '<=' : '<', p.hi);
    if (!a || !b) return [];
    // `a` is unbounded above and `b` below (or either is everything).
    const lo = a.lo, hi = b.hi;
    if (lo !== undefined && hi !== undefined && lo > hi) return [];
    return [{ ...(lo !== undefined ? { lo } : {}), ...(hi !== undefined ? { hi } : {}) }];
}

function intervalTest({ lo, hi }: IntInterval): (v: bigint) => boolean {
    if (lo !== undefined && hi !== undefined) return lo === hi ? (v) => v === lo : (v) => v >= lo && v <= hi;
    if (lo !== undefined) return (v) => v >= lo;
    if (hi !== undefined) return (v) => v <= hi;
    return () => true;
}

/** A set-filter value as an Int64 column's decimal text, or undefined
 *  when it can't equal any integer (or isn't a value at all: a `null`
 *  from a lossy transport must match nothing, not 0). */
export function int64SetKey(v: unknown): string | undefined {
    let b: bigint | undefined;
    if (typeof v === 'number' && Number.isInteger(v)) b = BigInt(v);
    else if (typeof v === 'string' && /^-?[0-9]+$/.test(v.trim())) b = BigInt(v.trim());
    // No column value lies outside ±(2^63 − 1): -2^63 is bit64's NA, and
    // as.integer64() turns it (or anything further out) into NA, which
    // would match the missing rows in R.
    if (b === undefined || b > INT64_MAX || b < -INT64_MAX) return undefined;
    return b.toString();
}
const INT64_MAX = (1n << 63n) - 1n;

/** A set-filter value that reads as a number: a number, or numeric text
 *  (`"Infinity"`, `"3"`). Anything else, `null` included, is not one. */
export function isNumberLike(v: unknown): v is number | string {
    if (typeof v === 'number') return true;
    return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v));
}

/** Memo bound for {@link stringAcceptor} on non-dictionary columns. Past
 *  it, values are tested directly (a high-cardinality column gains
 *  nothing from memoizing). */
const STRING_MEMO_MAX = 100_000;

/**
 * Row acceptor for a string predicate `test`, evaluating `test` once per
 * distinct value rather than once per row:
 *   - dictionary (factor) columns: once per dictionary entry, against the
 *     dictionary strings the reader loaded at open, then a code lookup;
 *   - other columns: through a memo of up to {@link STRING_MEMO_MAX}
 *     distinct values.
 * Missing rows never reach the acceptor (the caller's mask loop handles
 * them), so null codes and empty placeholders are irrelevant.
 */
async function stringAcceptor(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    test: (hay: string) => boolean,
    signal?: AbortSignal,
): Promise<(row: number) => boolean> {
    const dict = schema.arrowType.startsWith('Dictionary')
        ? reader.dictionaryVector(columnIndex)
        : undefined;
    if (dict) {
        const pass = new Uint8Array(dict.length);
        for (let d = 0; d < dict.length; d++) {
            const v = dict.get(d);
            pass[d] = v !== null && v !== undefined && test(String(v)) ? 1 : 0;
        }
        const codes = await loadFactorCodes(reader, columnIndex, signal);
        return (i) => pass[codes[i]] === 1;
    }
    const values = await loadString(reader, columnIndex, signal);
    const memo = new Map<string, boolean>();
    return (i) => {
        const v = values[i];
        let hit = memo.get(v);
        if (hit === undefined) {
            hit = test(v);
            if (memo.size < STRING_MEMO_MAX) memo.set(v, hit);
        }
        return hit;
    };
}

async function missingMaskFor(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const nrow = reader.nrow;
    const m = new Uint8Array(nrow);
    const isFloat = schema.arrowType.startsWith('Float');
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) m[start + r] = 1;
            else if (isFloat && typeof v === 'number' && Number.isNaN(v)) m[start + r] = 1;
        }
    }
    return m;
}

async function loadBool(reader: ArrowSliceReader, columnIndex: number, signal?: AbortSignal): Promise<Uint8Array> {
    const nrow = reader.nrow;
    const values = new Uint8Array(nrow);
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            values[start + r] = v ? 1 : 0;
        }
    }
    return values;
}

async function loadNumeric(reader: ArrowSliceReader, columnIndex: number, signal?: AbortSignal): Promise<Float64Array> {
    const nrow = reader.nrow;
    const out = new Float64Array(nrow);
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            // bigint values (timestamps; an Int64 / Uint64 set or date
            // path) coerce to Number. Numeric predicates on Int64 /
            // Uint64 columns don't come here: they compare the exact
            // integers (`loadInt64`).
            out[start + r] = typeof v === 'bigint' ? Number(v) : (v as number);
        }
    }
    return out;
}

/** An Int64 / Uint64 column's exact values (0n at missing rows, which
 *  the caller's missing mask handles). */
async function loadInt64(
    reader: ArrowSliceReader, columnIndex: number, signal?: AbortSignal,
): Promise<BigInt64Array | BigUint64Array> {
    const unsigned = reader.schema.columns[columnIndex].arrowType.startsWith('U');
    const out = unsigned ? new BigUint64Array(reader.nrow) : new BigInt64Array(reader.nrow);
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            out[start + r] = typeof v === 'bigint' ? v : BigInt(v as number);
        }
    }
    return out;
}

async function loadString(reader: ArrowSliceReader, columnIndex: number, signal?: AbortSignal): Promise<string[]> {
    const nrow = reader.nrow;
    const out: string[] = new Array(nrow).fill('');
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v !== null && v !== undefined) out[start + r] = String(v);
        }
    }
    return out;
}

async function loadFactorCodes(reader: ArrowSliceReader, columnIndex: number, signal?: AbortSignal): Promise<Int32Array> {
    const nrow = reader.nrow;
    const codes = new Int32Array(nrow);
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        const data = child.data[0];
        for (let r = 0; r < length; r++) codes[start + r] = data.values[r] as number;
    }
    return codes;
}

async function dictFromGetLabels(
    reader: ArrowSliceReader,
    columnIndex: number,
    codes: Int32Array,
    signal?: AbortSignal,
): Promise<string[]> {
    const seen = new Set<number>();
    for (let i = 0; i < codes.length; i++) seen.add(codes[i]);
    const labels = await reader.getLabels(columnIndex, [...seen]);
    // getLabels is an extra async hop after the cancellable column load;
    // check the signal so a Cancel during it is observed promptly.
    throwIfAborted(signal);
    const max = [...seen].reduce((a, b) => Math.max(a, b), -1);
    const out: string[] = new Array(max + 1).fill('');
    for (const [k, v] of Object.entries(labels)) out[Number(k)] = v;
    return out;
}

async function loadValueLabelled(
    reader: ArrowSliceReader,
    columnIndex: number,
    schema: ColumnSchema,
    signal?: AbortSignal,
): Promise<string[]> {
    const nrow = reader.nrow;
    const out: string[] = new Array(nrow).fill('');
    const labels = schema.valueLabels ?? {};
    for await (const { batch, start, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const key = typeof v === 'bigint' ? v.toString() : String(v);
            out[start + r] = labels[key] ?? key;
        }
    }
    return out;
}

function allZero(m: Uint8Array): boolean {
    for (let i = 0; i < m.length; i++) {
        if (m[i] !== 0) return false;
    }
    return true;
}

function compact(mask: Uint8Array): Uint32Array {
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) count++;
    }
    const out = new Uint32Array(count);
    let j = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i]) out[j++] = i;
    }
    return out;
}
