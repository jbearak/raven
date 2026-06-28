/**
 * Cooperative-cancellation helpers for data-viewer full-column scans.
 * Saved sort/filter restore and interactive sort/filter changes read
 * whole columns to compute a permutation / survivor set; threading an
 * {@link AbortSignal} through those reads, and yielding the event loop
 * between Arrow record batches, lets a webview Cancel or superseding
 * user action interrupt the wait.
 *
 * These are host-side only (the column reads run on the extension host,
 * not in the webview). The no-signal path of every consumer stays
 * byte-identical: {@link throwIfAborted} is a cheap guard that never
 * throws without a signal, and the yield is only inserted when a signal
 * is present.
 */

/**
 * Throw an `AbortError` if `signal` is aborted; otherwise no-op. Called
 * at each Arrow record-batch boundary so an abort raised since the last
 * yield interrupts the read. The error is a `DOMException` (not an
 * `Error` subclass on every runtime), matched by {@link isAbortError}.
 */
export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('The data-viewer operation was aborted', 'AbortError');
    }
}

/**
 * Release the event loop so a queued webview→host message (Cancel or a
 * superseding sort/filter) is delivered before the next batch is read.
 * `setImmediate` schedules a check-phase callback that runs after the poll
 * phase where incoming IPC is handled, so the abort is observed on the
 * next {@link throwIfAborted}. Only inserted on signal-bearing paths.
 */
export function yieldToEventLoop(): Promise<void> {
    return new Promise<void>(resolve => {
        setImmediate(resolve);
    });
}

/**
 * Whether `err` is an abort (a user Cancel) rather than a genuine read
 * failure. Matched on `name` because the abort is thrown as a
 * `DOMException`, which is not an `Error` subclass on every runtime.
 */
export function isAbortError(err: unknown): boolean {
    return typeof err === 'object'
        && err !== null
        && (err as { name?: unknown }).name === 'AbortError';
}
