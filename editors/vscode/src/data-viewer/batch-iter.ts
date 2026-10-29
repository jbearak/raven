/**
 * Shared record-batch iteration for full-column data-viewer scans.
 *
 * Sort, filter, and histogram code read whole columns by walking the
 * reader's record batches. Centralizing the walk here gives one place for
 * two invariants:
 *
 *   - **Projection.** Callers name the columns they need; each batch
 *     reads only those columns' buffers, and the reads bypass the
 *     reader's viewport chunk cache, so a scan never evicts the rows on
 *     screen. A batch's `getChildAt` throws for any other column.
 *   - **Cooperative cancellation (#519).** When a `signal` is passed, the
 *     iteration throws an `AbortError` before each batch if aborted and
 *     yields the event loop after each batch so a queued webview Cancel
 *     or superseding sort/filter is delivered before the next read. With
 *     no `signal` there are no checks and no yields.
 *
 * The virtualized viewport `getRows` path does not walk batches through
 * here at all.
 */
import type { ArrowSliceReader, ScanBatch } from './arrow-reader';
import { throwIfAborted, yieldToEventLoop } from './abort';

/** One record batch plus its row range in the full dataset. */
export type BatchSlice = { batch: ScanBatch; start: number; length: number };

/** Async iterator over a reader's record batches with their starting
 *  row index, reading only `columns`. See the module doc for the
 *  `signal` semantics. */
export async function* iterateBatches(
    reader: ArrowSliceReader,
    columns: readonly number[],
    signal?: AbortSignal,
): AsyncGenerator<BatchSlice> {
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        throwIfAborted(signal);
        const batch = await readerGetBatch(reader, bi, columns);
        const start = reader.batchStarts[bi];
        const length = reader.batchStarts[bi + 1] - start;
        yield { batch, start, length };
        if (signal) await yieldToEventLoop();
    }
    throwIfAborted(signal);
}

/** Bridge into the reader's private projected scan loader. Module-private:
 *  callers go through {@link iterateBatches} so the cancellation checkpoint
 *  is never bypassed. */
function readerGetBatch(
    reader: ArrowSliceReader,
    i: number,
    columns: readonly number[],
): Promise<ScanBatch> {
    return (reader as any).getBatch(i, columns);
}
