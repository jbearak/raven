/**
 * Precomputed numeric-column histograms for the filter popover. One
 * uniform-width 50-bin histogram per Int/Uint/Float column.
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
 * Computed once per panel-init off the open ArrowSliceReader. RSS is
 * bounded by the bin array (50 × 24 bytes per numeric column), not by
 * row count.
 */

import type { ArrowSliceReader } from './arrow-reader';
import type { HistogramBin } from './messages';

const BIN_COUNT = 50;

export async function computeNumericHistograms(
    reader: ArrowSliceReader,
): Promise<Record<number, HistogramBin[]>> {
    const out: Record<number, HistogramBin[]> = {};
    const schema = reader.schema.columns;
    for (let ci = 0; ci < schema.length; ci++) {
        const t = schema[ci].arrowType;
        if (!(t.startsWith('Int') || t.startsWith('Uint') || t.startsWith('Float'))) {
            continue;
        }
        out[ci] = await histogramForColumn(reader, ci);
    }
    return out;
}

async function histogramForColumn(
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
