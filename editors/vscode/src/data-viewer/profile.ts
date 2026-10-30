/**
 * Column profiles: what the header summary band, the Columns sidebar and
 * value counts show. Types only, shared by the scan worker
 * (`profile-engine.ts`), the host (`profile-scheduler.ts`) and the
 * webview.
 *
 * A profile always describes the **whole frame**, never the filtered
 * view. Each statistic says whether it is exact; estimates print with
 * `≈`. **Distinct** counts observed values, NA excluded.
 */
import type { ColumnSchema } from './arrow-reader';
import type { HistogramBin } from './messages';
import type { Cell } from './wire-format';

/** How a column is summarized. `labelled` is a value-labelled numeric
 *  or character column (haven_labelled), summarized like a factor. */
export type ProfileKind = 'numeric' | 'date' | 'factor' | 'labelled' | 'character' | 'logical' | 'other';

export type Estimate = { value: number; exact: boolean };

/** One counted value. `value` is the raw key: a 0-based dictionary code
 *  for factors, the number for numeric and labelled-numeric columns, the
 *  string for character columns, `true`/`false` for logical. `error` is
 *  the count's guaranteed error bound (0 when exact): the true count lies
 *  in `[count - error, count]`. */
export type CountedEntry = {
    value: string | number | boolean;
    /** The value's label (factor level or value label), when it has one. */
    label?: string;
    count: number;
    error: number;
};

export type TopValues = {
    /** Count-descending, at most {@link PROFILE_TOP_N}. */
    values: CountedEntry[];
    /** Counts are exact (no Space-Saving). */
    exact: boolean;
    /** The listed order isn't guaranteed: some value's lower bound doesn't
     *  beat the next one's upper bound. */
    approximateOrder: boolean;
};

export type ColumnProfile = {
    columnIndex: number;
    kind: ProfileKind;
    /** Rows described (the whole frame). */
    rows: number;
    /** NA (null) rows, exact. */
    na: number;
    /** NaN rows, exact (numeric columns; 0 otherwise). */
    nan: number;
    distinct: Estimate;
    /** numeric and date: smallest and largest present value, as wire
     *  cells so the webview formats them like the grid. */
    min?: Cell;
    max?: Cell;
    /** numeric: over finite values. */
    mean?: number;
    sd?: number;
    infinite?: number;
    quantiles?: { p25: number; p50: number; p75: number; exact: boolean };
    /** numeric and date: 20 uniform bins over the finite values, each
     *  `[lo, hi)` except the last, `[lo, hi]`. Date bins are in days,
     *  datetime bins in microseconds. */
    histogram?: HistogramBin[];
    top?: TopValues;
    /** factor and labelled: declared levels (or value labels), how many
     *  occur, and the counts of the first {@link PROFILE_LEVELS_N} in
     *  declared order. */
    levels?: { declared: number; used: number; counts: CountedEntry[] };
    /** character */
    emptyStrings?: number;
    minLength?: number;
    maxLength?: number;
    /** logical */
    trueCount?: number;
    falseCount?: number;
    /** date: the zone datetimes display in. */
    timeZone?: string;
};

/** A profile's availability: loading (shimmer), ready, or failed (`—`,
 *  with the error in the tooltip). Never "loading" after a failure. */
export type ProfileState =
    | { state: 'loading' }
    | { state: 'ready'; profile: ColumnProfile }
    | { state: 'failed'; error: string };

/** A profile state change for one column; `null` drops a pending
 *  (cancelled) column. */
export type ProfileUpdate = [columnIndex: number, state: ProfileState | null];

/** Value counts (the frequency popover). */
export type ValueCounts = {
    columnIndex: number;
    /** Sorted as requested; at most the requested limit. */
    entries: CountedEntry[];
    /** Every count is exact, and `entries` with `order: 'asc'` are truly
     *  the rarest. False past the exact-count cap (Space-Saving). */
    exact: boolean;
    approximateOrder: boolean;
    distinct: Estimate;
    /** Non-missing rows (the denominator of the percentages). */
    present: number;
    na: number;
    order: 'desc' | 'asc';
};

/** Top values kept in a profile. */
export const PROFILE_TOP_N = 10;
/** Levels listed with counts in a profile. */
export const PROFILE_LEVELS_N = 24;
/** Bins in the summary sparkline. */
export const PROFILE_BINS = 20;
/** Exact distinct/count tracking stops past this many distinct values. */
export const EXACT_DISTINCT_CAP = 100_000;
/** Reservoir size for approximate quantiles. */
export const RESERVOIR_SIZE = 100_000;
/** Space-Saving counters. */
export const SPACE_SAVING_COUNTERS = 1_000;
/** Most entries a value-counts reply carries. */
export const VALUE_COUNTS_LIMIT = 1_000;

/** How a column is profiled, from its schema. */
export function profileKind(col: ColumnSchema): ProfileKind {
    const t = col.arrowType;
    const numeric = t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float');
    if (t.startsWith('Dictionary')) return 'factor';
    if (col.valueLabels && (numeric || t === 'Utf8' || t === 'LargeUtf8')) return 'labelled';
    if (numeric) return 'numeric';
    if (t === 'Bool') return 'logical';
    if (t.startsWith('Date') || t.startsWith('Timestamp')) return 'date';
    return 'character';
}
