/**
 * Column profile engine: computes a {@link ColumnProfile} for one column
 * over the whole frame. Runs in the scan worker (`scan-core.ts`), at the
 * lowest priority: {@link ProfileOptions.pause} is awaited between record
 * batches, and the scan worker makes it wait while viewport reads, sorts,
 * filters, histograms or the null-count scan are running.
 *
 * Exactness, per statistic (design "Summaries"):
 *   - NA and NaN counts: exact (counted in the scan; the NA count equals
 *     the header null counts).
 *   - min, max, mean, sd, histogram: exact, from two projected passes
 *     (min/max/sum, then moments and binning), binned like
 *     `histograms.ts` so the 50-bin popover histogram falls out of the
 *     same pass and fills the shared cache.
 *   - quantiles: exact while every present value fits the 100k
 *     reservoir, or when the column's numeric sort key is cached
 *     (selection over the encoded key); otherwise from the reservoir,
 *     marked ≈.
 *   - distinct: exact for dictionary columns and while an exact counter
 *     holds under 100k values; past it, HyperLogLog (≈). The sketch is
 *     seeded from the exact set when it overflows, which is register for
 *     register the sketch a row-0 run would have built (`sketches.ts`).
 *   - top values: exact counts under the cap; past it, Space-Saving with
 *     1,000 counters seeded from the exact counts so far, with per-count
 *     error bounds and the "approximate order" rule. Plain numeric
 *     columns stop counting at the cap (their profile shows no top
 *     values); value counts on them run {@link countValues}.
 *
 * Distinct and top values count values R's `is.na()` is false for, so
 * NaN is excluded with NA. mean and sd follow R: an infinite value makes
 * the mean infinite (NaN for both signs) and sd NaN; quantiles, min and
 * max include infinities; the histogram bins finite values only.
 */
import type { ArrowSliceReader, ColumnSchema } from './arrow-reader';
import type { HistogramBin } from './messages';
import type {
    ColumnProfile,
    CountedEntry,
    Estimate,
    ProfileKind,
    TopValues,
    ValueCounts,
} from './profile';
import {
    profileKind,
    EXACT_DISTINCT_CAP,
    PROFILE_BINS,
    PROFILE_LEVELS_N,
    PROFILE_TOP_N,
    RESERVOIR_SIZE,
    SPACE_SAVING_COUNTERS,
} from './profile';
import type { EncodedKey } from './radix';
import { CLS_VALUE } from './radix';
import { iterateBatches } from './batch-iter';
import { throwIfAborted } from './abort';
import { BIN_COUNT, binEdges, binIndex, binsFrom } from './histograms';
import { isNullAt } from './sort';
import {
    guaranteedOrder,
    hashNumber,
    hashString,
    HyperLogLog,
    NumberCounter,
    quantileType7,
    Reservoir,
    SpaceSaving,
} from './sketches';
import { encodeDate, encodeNumber, encodeTimestampMicros } from './wire-format';
import type { Cell } from './wire-format';

export type ProfileOptions = {
    signal?: AbortSignal;
    /** Awaited before each record batch; the scan worker holds it while
     *  higher-priority work runs. */
    pause?: () => Promise<void>;
    /** The column's cached numeric sort key over all rows, if any; makes
     *  quantiles exact. */
    sortKey?: EncodedKey;
    /** Overrides for tests. */
    exactCap?: number;
    reservoirSize?: number;
};

/** Counts kept after a profile scan, for value counts. */
export type CountSummary = {
    columnIndex: number;
    exact: boolean;
    /** exact: every distinct value; otherwise the Space-Saving counters. */
    entries: CountedEntry[];
    /** Upper bound on any unlisted value's count (0 when exact). */
    floor: number;
    distinct: Estimate;
    present: number;
    na: number;
};

export type ProfileResult = {
    profile: ColumnProfile;
    /** The 50-bin popover histogram, from the same pass (numeric only). */
    histogram50?: HistogramBin[];
    counts?: CountSummary;
};

/** Compute one column's profile. */
export async function computeProfile(
    reader: ArrowSliceReader,
    columnIndex: number,
    opts: ProfileOptions = {},
): Promise<ProfileResult> {
    const col = reader.schema.columns[columnIndex];
    if (!col) throw new Error(`profile: unknown column ${columnIndex}`);
    const kind = profileKind(col);
    const t = col.arrowType;
    let result: ProfileResult;
    if (kind === 'factor') {
        result = await profileFactor(reader, columnIndex, opts);
    } else if (kind === 'logical') {
        result = await profileLogical(reader, columnIndex, opts);
    } else if (kind === 'numeric' || kind === 'date'
        || (kind === 'labelled' && t !== 'Utf8' && t !== 'LargeUtf8')) {
        result = await profileNumeric(reader, columnIndex, col, kind, opts);
    } else {
        result = await profileCharacter(reader, columnIndex, col, kind, opts);
    }
    throwIfAborted(opts.signal);
    return result;
}

/** Walk the column's batches, pausing between them. */
async function scan(
    reader: ArrowSliceReader,
    columnIndex: number,
    opts: ProfileOptions,
    fn: (child: any, length: number) => void,
): Promise<void> {
    for await (const { batch, length } of iterateBatches(reader, [columnIndex], opts.signal)) {
        fn(batch.getChildAt(columnIndex), length);
        await opts.pause?.();
        throwIfAborted(opts.signal);
    }
}

// ---------------------------------------------------------------------
// Numeric, date, labelled numeric
// ---------------------------------------------------------------------

type NumericDomain = 'number' | 'day' | 'day-ms' | 'micros';

function numericDomain(t: string): NumericDomain {
    if (t.startsWith('Timestamp')) return 'micros';
    // apache-arrow names these `Date64<MILLISECOND>` (and `Date32<DAY>`).
    if (t.startsWith('Date64')) return 'day-ms';
    if (t.startsWith('Date')) return 'day';
    return 'number';
}

async function profileNumeric(
    reader: ArrowSliceReader,
    columnIndex: number,
    col: ColumnSchema,
    kind: ProfileKind,
    opts: ProfileOptions,
): Promise<ProfileResult> {
    const domain = numericDomain(col.arrowType);
    const cap = opts.exactCap ?? EXACT_DISTINCT_CAP;
    const counter = new NumberCounter(cap);
    let hll: HyperLogLog | undefined;
    // Space-Saving past the cap only where top values are shown.
    const wantTop = kind === 'labelled';
    let ss: SpaceSaving<number> | undefined;
    const reservoir = new Reservoir(opts.reservoirSize ?? RESERVOIR_SIZE);
    const declared = kind === 'labelled' ? declaredCounter(col) : undefined;
    let na = 0, nan = 0, posInf = 0, negInf = 0, finite = 0;
    let min = Infinity, max = -Infinity, fmin = Infinity, fmax = -Infinity;
    let rawMin: number | bigint | undefined, rawMax: number | bigint | undefined;
    let sum = 0;

    await scan(reader, columnIndex, opts, (child, length) => {
        const data = child.data[0];
        const vals = data.values;
        const off: number = data.offset ?? 0;
        const big = typeof vals[off] === 'bigint' || vals instanceof BigInt64Array || vals instanceof BigUint64Array;
        const hasNulls = data.nullCount !== 0;
        for (let r = 0; r < length; r++) {
            if (hasNulls && isNullAt(data, r)) { na++; continue; }
            const raw = vals[off + r];
            let x: number = big ? Number(raw) : raw;
            if (domain === 'day-ms') x = Math.floor(x / 86_400_000);
            if (x !== x) { nan++; continue; }
            if (x < min) { min = x; rawMin = raw; }
            if (x > max) { max = x; rawMax = raw; }
            if (x === Infinity) posInf++;
            else if (x === -Infinity) negInf++;
            else {
                finite++;
                sum += x;
                if (x < fmin) fmin = x;
                if (x > fmax) fmax = x;
            }
            reservoir.add(x);
            if (declared) countDeclared(declared, String(x));
            if (hll === undefined) {
                if (counter.add(x)) continue;
                // Overflow: seed the sketches from the exact counts so far.
                hll = new HyperLogLog();
                for (const [k] of counter.entries()) hll.addHash(hashNumber(k));
                if (wantTop) {
                    ss = new SpaceSaving<number>(SPACE_SAVING_COUNTERS);
                    ss.seed(counter.entries());
                }
            }
            hll.addHash(hashNumber(x));
            ss?.add(x);
        }
    });

    // Pass 2: moments about the pass-1 mean (R's two-pass mean) and bins.
    let mean: number | undefined;
    let sd: number | undefined;
    let histogram: HistogramBin[] | undefined;
    let histogram50: HistogramBin[] | undefined;
    if (finite > 0) {
        const m0 = sum / finite;
        let s1 = 0, s2 = 0;
        const single = fmin === fmax;
        const e20 = single ? undefined : binEdges(fmin, fmax, PROFILE_BINS);
        const e50 = single ? undefined : binEdges(fmin, fmax, BIN_COUNT);
        const c20 = new Float64Array(PROFILE_BINS);
        const c50 = new Float64Array(BIN_COUNT);
        await scan(reader, columnIndex, opts, (child, length) => {
            const data = child.data[0];
            const vals = data.values;
            const off: number = data.offset ?? 0;
            const big = typeof vals[off] === 'bigint' || vals instanceof BigInt64Array || vals instanceof BigUint64Array;
            const hasNulls = data.nullCount !== 0;
            for (let r = 0; r < length; r++) {
                if (hasNulls && isNullAt(data, r)) continue;
                let x: number = big ? Number(vals[off + r]) : vals[off + r];
                if (domain === 'day-ms') x = Math.floor(x / 86_400_000);
                if (x !== x || x === Infinity || x === -Infinity) continue;
                const d = x - m0;
                s1 += d;
                s2 += d * d;
                if (e20) {
                    c20[binIndex(x, e20)]++;
                    c50[binIndex(x, e50!)]++;
                }
            }
        });
        const fm = m0 + s1 / finite;
        mean = posInf && negInf ? NaN : posInf ? Infinity : negInf ? -Infinity : fm;
        if (finite > 1) {
            const v = (s2 - (s1 * s1) / finite) / (finite - 1);
            sd = posInf || negInf ? NaN : Math.sqrt(Math.max(0, v));
        }
        if (e20) {
            histogram = binsFrom(e20, c20);
            histogram50 = binsFrom(e50!, c50);
        } else {
            histogram = [{ lo: fmin, hi: fmax, count: finite }];
            histogram50 = histogram;
        }
    } else if (posInf || negInf) {
        mean = posInf && negInf ? NaN : posInf ? Infinity : -Infinity;
    }

    const present = reader.nrow - na - nan;
    const exact = hll === undefined;
    const distinct: Estimate = exact
        ? { value: counter.size, exact: true }
        : { value: Math.max(cap, hll!.estimate()), exact: false };

    let quantiles: ColumnProfile['quantiles'];
    if (present > 0) {
        const fromKey = domain === 'number' && opts.sortKey
            ? quantilesFromKey(opts.sortKey, present)
            : undefined;
        if (fromKey) {
            quantiles = { ...fromKey, exact: true };
        } else {
            const sorted = reservoir.sorted();
            quantiles = {
                p25: quantileType7(sorted, 0.25),
                p50: quantileType7(sorted, 0.5),
                p75: quantileType7(sorted, 0.75),
                exact: reservoir.complete,
            };
        }
    }

    const profile: ColumnProfile = {
        columnIndex,
        kind,
        rows: reader.nrow,
        na,
        nan,
        distinct,
        infinite: posInf + negInf,
        ...(present > 0 ? {
            min: domainCell(domain, min, rawMin),
            max: domainCell(domain, max, rawMax),
        } : {}),
        ...(domain === 'number' ? { mean, sd, quantiles } : {}),
        histogram,
    };
    if (domain === 'micros') profile.timeZone = col.timeZone ?? 'UTC';

    let counts: CountSummary | undefined;
    const labelOf = (v: number): string | undefined => col.valueLabels?.[String(v)];
    if (exact) {
        const entries: CountedEntry[] = [];
        for (const [value, count] of counter.entries()) {
            const label = kind === 'labelled' ? labelOf(value) : undefined;
            entries.push(label !== undefined ? { value, label, count, error: 0 } : { value, count, error: 0 });
        }
        entries.sort((a, b) => b.count - a.count || compareKeys(a.value, b.value));
        counts = { columnIndex, exact: true, entries, floor: 0, distinct, present, na: na + nan };
    } else if (ss) {
        const entries = ss.top().map(e => withLabel(e, kind === 'labelled' ? labelOf(e.value) : undefined));
        counts = { columnIndex, exact: false, entries, floor: ss.floor, distinct, present, na: na + nan };
    }
    if (kind === 'labelled') {
        if (counts) profile.top = topFrom(counts);
        profile.levels = labelledLevels(col, declared!);
    }
    return { profile, histogram50: domain === 'number' ? histogram50 : undefined, counts };
}

function domainCell(domain: NumericDomain, x: number, raw: number | bigint | undefined): Cell {
    if (domain === 'day' || domain === 'day-ms') return encodeDate(x);
    if (domain === 'micros') {
        const us = typeof raw === 'bigint' ? raw : BigInt(Math.round(x));
        return encodeTimestampMicros(us);
    }
    return encodeNumber(x);
}

const F64 = new Float64Array(1);
const F64_U32 = new Uint32Array(F64.buffer);

/** Inverse of `radix.ts`'s `encodeFloat64` for one key. */
function decodeKey(hi: number, lo: number): number {
    if (hi & 0x80000000) {
        F64_U32[1] = (hi & 0x7fffffff) >>> 0;
        F64_U32[0] = lo;
    } else {
        F64_U32[1] = ~hi >>> 0;
        F64_U32[0] = ~lo >>> 0;
    }
    return F64[0];
}

/** Most values gathered for exact selection before falling back to the
 *  reservoir (a heavily tied column can put most rows in one bucket). */
const SELECT_GATHER_CAP = 4_000_000;

/**
 * Exact type-7 quartiles from an encoded sort key: count the values per
 * top-16-bit bucket, gather only the buckets holding the needed order
 * statistics, and sort those. `undefined` when the gather would be too
 * large.
 */
export function quantilesFromKey(
    key: EncodedKey,
    present: number,
): { p25: number; p50: number; p75: number } | undefined {
    if (!key.lo) return undefined;
    const { hi, lo, cls } = key;
    const n = cls.length;
    const counts = new Float64Array(65_536);
    let total = 0;
    for (let i = 0; i < n; i++) {
        if (cls[i] !== CLS_VALUE) continue;
        counts[hi[i] >>> 16]++;
        total++;
    }
    if (total !== present || total === 0) return undefined;
    const ps = [0.25, 0.5, 0.75];
    const ranks = new Set<number>();
    for (const p of ps) {
        const h = (total - 1) * p;
        ranks.add(Math.floor(h));
        ranks.add(Math.min(total - 1, Math.floor(h) + 1));
    }
    // Bucket and offset of each needed rank.
    const starts = new Float64Array(65_537);
    for (let b = 0; b < 65_536; b++) starts[b + 1] = starts[b] + counts[b];
    const need = new Map<number, number[]>();
    let gather = 0;
    for (const r of ranks) {
        let b = 0;
        while (starts[b + 1] <= r) b++;
        if (!need.has(b)) { need.set(b, []); gather += counts[b]; }
    }
    if (gather > SELECT_GATHER_CAP) return undefined;
    for (let i = 0; i < n; i++) {
        if (cls[i] !== CLS_VALUE) continue;
        const bucket = need.get(hi[i] >>> 16);
        if (bucket) bucket.push(decodeKey(hi[i], lo[i]));
    }
    const sortedBuckets = new Map<number, Float64Array>();
    for (const [b, vals] of need) sortedBuckets.set(b, Float64Array.from(vals).sort());
    const at = (r: number): number => {
        let b = 0;
        while (starts[b + 1] <= r) b++;
        return sortedBuckets.get(b)![r - starts[b]];
    };
    const q = (p: number): number => {
        const h = (total - 1) * p;
        const l = Math.floor(h);
        const a = at(l);
        const c = at(Math.min(total - 1, l + 1));
        return a === c ? a : a + (h - l) * (c - a);
    };
    return { p25: q(0.25), p50: q(0.5), p75: q(0.75) };
}

// ---------------------------------------------------------------------
// Factor
// ---------------------------------------------------------------------

function dictionaryLabels(reader: ArrowSliceReader, columnIndex: number, col: ColumnSchema): string[] | undefined {
    if (col.dictionary) return col.dictionary;
    const vec = reader.dictionaryVector(columnIndex);
    if (!vec) return undefined;
    const out: string[] = new Array(vec.length);
    for (let d = 0; d < vec.length; d++) {
        const v = vec.get(d);
        out[d] = v === null || v === undefined ? '' : String(v);
    }
    return out;
}

async function profileFactor(
    reader: ArrowSliceReader,
    columnIndex: number,
    opts: ProfileOptions,
): Promise<ProfileResult> {
    const col = reader.schema.columns[columnIndex];
    const labels = dictionaryLabels(reader, columnIndex, col);
    let counts = new Float64Array(labels?.length ?? 0);
    let na = 0;
    await scan(reader, columnIndex, opts, (child, length) => {
        const data = child.data[0];
        const vals = data.values;
        const off: number = data.offset ?? 0;
        const hasNulls = data.nullCount !== 0;
        for (let r = 0; r < length; r++) {
            if (hasNulls && isNullAt(data, r)) { na++; continue; }
            const c = Number(vals[off + r]);
            if (c >= counts.length) {
                const grown = new Float64Array(Math.max(c + 1, counts.length * 2));
                grown.set(counts);
                counts = grown;
            }
            counts[c]++;
        }
    });
    const declared = labels?.length ?? counts.length;
    const entries: CountedEntry[] = [];
    let used = 0;
    for (let c = 0; c < counts.length; c++) {
        if (counts[c] === 0) continue;
        used++;
        entries.push(withLabel({ value: c, count: counts[c], error: 0 }, labels?.[c]));
    }
    const levelCounts: CountedEntry[] = [];
    for (let c = 0; c < Math.min(declared, PROFILE_LEVELS_N); c++) {
        levelCounts.push(withLabel({ value: c, count: counts[c] ?? 0, error: 0 }, labels?.[c]));
    }
    entries.sort((a, b) => b.count - a.count || (a.value as number) - (b.value as number));
    const present = reader.nrow - na;
    const distinct: Estimate = { value: used, exact: true };
    const summary: CountSummary = { columnIndex, exact: true, entries, floor: 0, distinct, present, na };
    return {
        profile: {
            columnIndex,
            kind: 'factor',
            rows: reader.nrow,
            na,
            nan: 0,
            distinct,
            top: topFrom(summary),
            levels: { declared, used, counts: levelCounts },
        },
        counts: summary,
    };
}

// ---------------------------------------------------------------------
// Logical
// ---------------------------------------------------------------------

async function profileLogical(
    reader: ArrowSliceReader,
    columnIndex: number,
    opts: ProfileOptions,
): Promise<ProfileResult> {
    let na = 0, t = 0, f = 0;
    await scan(reader, columnIndex, opts, (child, length) => {
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) na++;
            else if (v) t++;
            else f++;
        }
    });
    const entries: CountedEntry[] = [];
    if (t > 0) entries.push({ value: true, count: t, error: 0 });
    if (f > 0) entries.push({ value: false, count: f, error: 0 });
    entries.sort((a, b) => b.count - a.count);
    const distinct: Estimate = { value: entries.length, exact: true };
    const summary: CountSummary = { columnIndex, exact: true, entries, floor: 0, distinct, present: t + f, na };
    return {
        profile: {
            columnIndex,
            kind: 'logical',
            rows: reader.nrow,
            na,
            nan: 0,
            distinct,
            trueCount: t,
            falseCount: f,
            top: topFrom(summary),
        },
        counts: summary,
    };
}

// ---------------------------------------------------------------------
// Character and labelled character
// ---------------------------------------------------------------------

/** Length in code points, as R's `nchar(type = "chars")`. */
function codePointLength(s: string): number {
    let n = s.length;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
            const p = s.charCodeAt(i - 1);
            if (p >= 0xd800 && p <= 0xdbff) n--;
        }
    }
    return n;
}

async function profileCharacter(
    reader: ArrowSliceReader,
    columnIndex: number,
    col: ColumnSchema,
    kind: ProfileKind,
    opts: ProfileOptions,
): Promise<ProfileResult> {
    const cap = opts.exactCap ?? EXACT_DISTINCT_CAP;
    let exact: Map<string, number> | undefined = new Map();
    let hll: HyperLogLog | undefined;
    let ss: SpaceSaving<string> | undefined;
    const declared = kind === 'labelled' ? declaredCounter(col) : undefined;
    let na = 0, empty = 0;
    let minLen = Infinity, maxLen = -Infinity;
    await scan(reader, columnIndex, opts, (child, length) => {
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) { na++; continue; }
            const s = typeof v === 'string' ? v : typeof v === 'bigint' ? v.toString() : String(v);
            if (s === '') empty++;
            if (declared) countDeclared(declared, s);
            const len = codePointLength(s);
            if (len < minLen) minLen = len;
            if (len > maxLen) maxLen = len;
            if (exact) {
                const c = exact.get(s);
                if (c !== undefined) { exact.set(s, c + 1); continue; }
                if (exact.size < cap) { exact.set(s, 1); continue; }
                hll = new HyperLogLog();
                for (const k of exact.keys()) hll.addHash(hashString(k));
                ss = new SpaceSaving<string>(SPACE_SAVING_COUNTERS);
                ss.seed(exact);
                exact = undefined;
            }
            hll!.addHash(hashString(s));
            ss!.add(s);
        }
    });
    const present = reader.nrow - na;
    const labelOf = (v: string): string | undefined => col.valueLabels?.[v];
    let summary: CountSummary;
    if (exact) {
        const entries: CountedEntry[] = [];
        for (const [value, count] of exact) entries.push(withLabel({ value, count, error: 0 }, labelOf(value)));
        entries.sort((a, b) => b.count - a.count || compareKeys(a.value, b.value));
        summary = {
            columnIndex, exact: true, entries, floor: 0,
            distinct: { value: exact.size, exact: true }, present, na,
        };
    } else {
        summary = {
            columnIndex, exact: false,
            entries: ss!.top().map(e => withLabel(e, labelOf(e.value))),
            floor: ss!.floor,
            distinct: { value: Math.max(cap, hll!.estimate()), exact: false },
            present, na,
        };
    }
    const profile: ColumnProfile = {
        columnIndex,
        kind,
        rows: reader.nrow,
        na,
        nan: 0,
        distinct: summary.distinct,
        top: topFrom(summary),
        emptyStrings: empty,
        ...(present > 0 ? { minLength: minLen, maxLength: maxLen } : {}),
    };
    if (kind === 'labelled') profile.levels = labelledLevels(col, declared!);
    return { profile, counts: summary };
}

// ---------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------

function withLabel<K extends string | number | boolean>(
    e: { value: K; count: number; error: number },
    label: string | undefined,
): CountedEntry {
    return label !== undefined ? { ...e, label } : { ...e };
}

function compareKeys(a: CountedEntry['value'], b: CountedEntry['value']): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** The profile's top values from a count summary. */
export function topFrom(s: CountSummary): TopValues {
    const values = s.entries.slice(0, PROFILE_TOP_N);
    return {
        values,
        exact: s.exact,
        approximateOrder: !s.exact && !guaranteedOrder(s.entries, values.length, s.floor),
    };
}

/** Exact per-row counts of a column's declared label values, kept beside
 *  the distinct-value summary: past the exact cap that summary is
 *  Space-Saving, which can't say how often an unmonitored label occurs.
 *  The declared set is finite, so these stay exact. */
function declaredCounter(col: ColumnSchema): Map<string, number> {
    return new Map(Object.keys(col.valueLabels ?? {}).map(k => [k, 0]));
}

function countDeclared(declared: Map<string, number>, key: string): void {
    const c = declared.get(key);
    if (c !== undefined) declared.set(key, c + 1);
}

/** Declared value labels (sorted by value, as the filter popover lists
 *  them) with their exact counts. */
function labelledLevels(col: ColumnSchema, declared: Map<string, number>): ColumnProfile['levels'] {
    const vl = col.valueLabels ?? {};
    const numeric = !col.arrowType.startsWith('Utf8') && !col.arrowType.startsWith('LargeUtf8');
    const keys = Object.keys(vl);
    const ordered = numeric
        ? keys.map(k => ({ k, v: Number(k) as string | number })).sort((a, b) => (a.v as number) - (b.v as number))
        : keys.map(k => ({ k, v: k as string | number }));
    let used = 0;
    for (const { k } of ordered) if ((declared.get(k) ?? 0) > 0) used++;
    const counts = ordered.slice(0, PROFILE_LEVELS_N).map(({ k, v }) => (
        { value: v, label: vl[k], count: declared.get(k) ?? 0, error: 0 }
    ));
    return { declared: keys.length, used, counts };
}

/** A value-counts reply from a count summary. Rarest first (`asc`) is
 *  only meaningful for exact summaries; Space-Saving can't name the
 *  rarest values, so callers offer it only when `exact`. */
export function valueCountsFrom(s: CountSummary, order: 'desc' | 'asc', limit: number): ValueCounts {
    const sorted = order === 'desc'
        ? s.entries
        : [...s.entries].sort((a, b) => a.count - b.count || compareKeys(a.value, b.value));
    const entries = sorted.slice(0, limit);
    return {
        columnIndex: s.columnIndex,
        entries,
        exact: s.exact,
        approximateOrder: !s.exact && !guaranteedOrder(s.entries, entries.length, s.floor),
        distinct: s.distinct,
        present: s.present,
        na: s.na,
        order,
    };
}

/**
 * Count values for value counts when no profile summary exists (plain
 * numeric columns past the exact cap profile without counting): exact
 * counts up to the cap, then Space-Saving seeded from them.
 */
export async function countValues(
    reader: ArrowSliceReader,
    columnIndex: number,
    opts: ProfileOptions = {},
): Promise<CountSummary> {
    const col = reader.schema.columns[columnIndex];
    if (!col) throw new Error(`profile: unknown column ${columnIndex}`);
    const kind = profileKind(col);
    if (kind !== 'numeric' && kind !== 'date') {
        const r = await computeProfile(reader, columnIndex, opts);
        return r.counts!;
    }
    const cap = opts.exactCap ?? EXACT_DISTINCT_CAP;
    const counter = new NumberCounter(cap);
    let ss: SpaceSaving<number> | undefined;
    let hll: HyperLogLog | undefined;
    let na = 0;
    const domain = numericDomain(col.arrowType);
    await scan(reader, columnIndex, opts, (child, length) => {
        const data = child.data[0];
        const vals = data.values;
        const off: number = data.offset ?? 0;
        const big = typeof vals[off] === 'bigint' || vals instanceof BigInt64Array || vals instanceof BigUint64Array;
        const hasNulls = data.nullCount !== 0;
        for (let r = 0; r < length; r++) {
            if (hasNulls && isNullAt(data, r)) { na++; continue; }
            let x: number = big ? Number(vals[off + r]) : vals[off + r];
            if (domain === 'day-ms') x = Math.floor(x / 86_400_000);
            if (x !== x) { na++; continue; }
            if (!ss) {
                if (counter.add(x)) continue;
                ss = new SpaceSaving<number>(SPACE_SAVING_COUNTERS);
                ss.seed(counter.entries());
                hll = new HyperLogLog();
                for (const [k] of counter.entries()) hll.addHash(hashNumber(k));
            }
            ss.add(x);
            hll!.addHash(hashNumber(x));
        }
    });
    const present = reader.nrow - na;
    if (!ss) {
        const entries: CountedEntry[] = [];
        for (const [value, count] of counter.entries()) entries.push({ value, count, error: 0 });
        entries.sort((a, b) => b.count - a.count || (a.value as number) - (b.value as number));
        return {
            columnIndex, exact: true, entries, floor: 0,
            distinct: { value: counter.size, exact: true }, present, na,
        };
    }
    return {
        columnIndex, exact: false, entries: ss.top(), floor: ss.floor,
        distinct: { value: Math.max(cap, hll!.estimate()), exact: false }, present, na,
    };
}
