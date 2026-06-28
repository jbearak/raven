/**
 * Shared record-batch iteration for full-column data-viewer scans.
 *
 * Sort, filter, and histogram code read whole columns by walking the
 * reader's record batches. Centralizing the walk here gives one place for the
 * cooperative-cancellation checkpoint (#519): when a `signal` is passed,
 * the iteration throws an `AbortError` before each batch if aborted and
 * yields the event loop after each batch so a queued webview Cancel or
 * superseding sort/filter is delivered before the next read. With no
 * `signal` it is byte-identical to a plain batch loop — no checks, no
 * yields. The virtualized viewport `getRows` path does not walk batches
 * through here at all.
 */
import type { ArrowSliceReader } from './arrow-reader';
import { throwIfAborted, yieldToEventLoop } from './abort';

/** One record batch plus its row range in the full dataset. */
export type BatchSlice = { batch: any; start: number; length: number };

/** Async iterator over a reader's record batches with their starting
 *  row index. See the module doc for the `signal` semantics. */
export async function* iterateBatches(
    reader: ArrowSliceReader,
    signal?: AbortSignal,
): AsyncGenerator<BatchSlice> {
    const numBatches = reader.batchStarts.length - 1;
    for (let bi = 0; bi < numBatches; bi++) {
        throwIfAborted(signal);
        const batch = await readerGetBatch(reader, bi);
        const start = reader.batchStarts[bi];
        const length = reader.batchStarts[bi + 1] - start;
        yield { batch, start, length };
        if (signal) await yieldToEventLoop();
    }
    throwIfAborted(signal);
}

/** Bridge into the reader's private batch loader. The reader caches
 *  decoded batches with an LRU, so repeated reads here are cheap and
 *  warm the cache for the subsequent `getRows()` window. Module-private:
 *  callers go through {@link iterateBatches} so the cancellation checkpoint
 *  is never bypassed. */
function readerGetBatch(reader: ArrowSliceReader, i: number): Promise<any> {
    return (reader as any).getBatch(i);
}
