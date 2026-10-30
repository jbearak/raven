/**
 * Numeric-column histograms for the filter popover. One uniform-width
 * 50-bin histogram per Int/Uint/Float column.
 *
 * NA / NaN are excluded from `count` because they are filtered through
 * `includeMissing`, not via the histogram brush. ±Inf is excluded
 * because it breaks uniform binning (Infinity / -Infinity span the
 * entire real line).
 *
 * Columns with no present finite values yield `[]`. Columns where every
 * present value equals min collapse to a single zero-width bin holding
 * the full count.
 *
 * IMPORTANT — these are NOT precomputed at panel init. A single column's
 * histogram requires two full scans of that column (a min/max pass and a
 * binning pass), so doing every numeric column up front blocks the grid
 * from painting until the entire frame has been read — on a 10M-row × 50-col
 * frame that was ~49s of empty grid. Instead `computeHistogramForColumn`
 * is called on demand the first time a numeric column's filter popover
 * opens (see `DataViewerPanel`'s getHistogram handler, which also caches
 * the result per reader). `computeNumericHistograms` (all columns at once)
 * remains for tests and any future eager use. RSS is bounded by the bin
 * array (50 × 24 bytes per numeric column), not by row count.
 *
 * Bins are `[lo, hi)` except the last, `[lo, hi]`, and a value's bin is
 * decided by comparing it with the edges it will be filtered against
 * ({@link binIndex}), not by the division alone, so a filter
 * `lo <= x < hi` built from bins selects exactly the rows they count.
 * Column profiles (`profile-engine.ts`) bin with the same helpers and
 * fill the scan worker's histogram cache, so a profiled column's filter
 * popover needs no scan.
 */

import type { ArrowSliceReader } from './arrow-reader';
import type { HistogramBin } from './messages';
import { iterateBatches } from './batch-iter';
import { throwIfAborted } from './abort';

export const BIN_COUNT = 50;

/** `n + 1` edges of `n` uniform bins over `[min, max]`; the last edge is
 *  `max` itself. */
export function binEdges(min: number, max: number, n: number): Float64Array {
    const width = (max - min) / n;
    const edges = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) edges[i] = min + i * width;
    edges[n] = max;
    return edges;
}

/** The bin of finite `x` in `[edges[0], edges[n]]`: `edges[i] <= x <
 *  edges[i + 1]`, or the last bin for `x == edges[n]`. */
export function binIndex(x: number, edges: Float64Array): number {
    const n = edges.length - 1;
    const min = edges[0];
    let idx = Math.floor(((x - min) / (edges[n] - min)) * n);
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    while (idx > 0 && x < edges[idx]) idx--;
    while (idx < n - 1 && x >= edges[idx + 1]) idx++;
    return idx;
}

/** Bins from edges and counts. */
export function binsFrom(edges: Float64Array, counts: ArrayLike<number>): HistogramBin[] {
    const n = edges.length - 1;
    const bins: HistogramBin[] = new Array(n);
    for (let i = 0; i < n; i++) bins[i] = { lo: edges[i], hi: edges[i + 1], count: counts[i] };
    return bins;
}

/** True for the Arrow types that produce a numeric histogram (the same
 *  types `colKind` classifies as `numeric` / `labelledNumeric`). The host
 *  uses this as a trust-boundary guard before launching an on-demand scan
 *  for a webview-supplied column index. */
export function isNumericArrowType(arrowType: string): boolean {
    return arrowType.startsWith('Int')
        || arrowType.startsWith('Uint')
        || arrowType.startsWith('Float');
}

export async function computeNumericHistograms(
    reader: ArrowSliceReader,
    opts?: { signal?: AbortSignal },
): Promise<Record<number, HistogramBin[]>> {
    const out: Record<number, HistogramBin[]> = {};
    const schema = reader.schema.columns;
    for (let ci = 0; ci < schema.length; ci++) {
        if (!isNumericArrowType(schema[ci].arrowType)) continue;
        out[ci] = await computeHistogramForColumn(reader, ci, opts);
    }
    return out;
}

/**
 * Compute the 50-bin histogram for one column. Returns `[]` for a column
 * with no present finite values (including non-numeric columns, whose
 * values are never finite numbers) so callers can treat "no histogram"
 * and "empty histogram" identically.
 */
export async function computeHistogramForColumn(
    reader: ArrowSliceReader,
    columnIndex: number,
    opts?: { signal?: AbortSignal },
): Promise<HistogramBin[]> {
    const signal = opts?.signal;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;

    for await (const { batch, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const x = typeof v === 'bigint' ? Number(v) : (v as number);
            if (!Number.isFinite(x)) continue;
            if (x < min) min = x;
            if (x > max) max = x;
            count++;
        }
    }

    throwIfAborted(signal);
    if (count === 0) return [];
    if (min === max) {
        return [{ lo: min, hi: max, count }];
    }

    const edges = binEdges(min, max, BIN_COUNT);
    const counts = new Float64Array(BIN_COUNT);

    for await (const { batch, length } of iterateBatches(reader, [columnIndex], signal)) {
        const child = batch.getChildAt(columnIndex);
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const x = typeof v === 'bigint' ? Number(v) : (v as number);
            if (!Number.isFinite(x)) continue;
            counts[binIndex(x, edges)]++;
        }
    }
    const bins = binsFrom(edges, counts);
    throwIfAborted(signal);
    return bins;
}
