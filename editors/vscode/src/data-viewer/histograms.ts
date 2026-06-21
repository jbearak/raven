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
 */

import type { ArrowSliceReader } from './arrow-reader';
import type { HistogramBin } from './messages';

const BIN_COUNT = 50;

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
): Promise<Record<number, HistogramBin[]>> {
    const out: Record<number, HistogramBin[]> = {};
    const schema = reader.schema.columns;
    for (let ci = 0; ci < schema.length; ci++) {
        if (!isNumericArrowType(schema[ci].arrowType)) continue;
        out[ci] = await computeHistogramForColumn(reader, ci);
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
): Promise<HistogramBin[]> {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    const numBatches = reader.batchStarts.length - 1;

    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const length = reader.batchStarts[bi + 1] - reader.batchStarts[bi];
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

    if (count === 0) return [];
    if (min === max) {
        return [{ lo: min, hi: max, count }];
    }

    const width = (max - min) / BIN_COUNT;
    const bins: HistogramBin[] = new Array(BIN_COUNT);
    for (let i = 0; i < BIN_COUNT; i++) {
        bins[i] = { lo: min + i * width, hi: min + (i + 1) * width, count: 0 };
    }
    bins[BIN_COUNT - 1].hi = max;

    for (let bi = 0; bi < numBatches; bi++) {
        const batch = await (reader as any).getBatch(bi);
        const child = batch.getChildAt(columnIndex);
        const length = reader.batchStarts[bi + 1] - reader.batchStarts[bi];
        for (let r = 0; r < length; r++) {
            const v = child.get(r);
            if (v === null || v === undefined) continue;
            const x = typeof v === 'bigint' ? Number(v) : (v as number);
            if (!Number.isFinite(x)) continue;
            let idx = Math.floor((x - min) / width);
            if (idx >= BIN_COUNT) idx = BIN_COUNT - 1;
            if (idx < 0) idx = 0;
            bins[idx].count++;
        }
    }
    return bins;
}
