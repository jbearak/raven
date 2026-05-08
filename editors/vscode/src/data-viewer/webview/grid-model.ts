/** Pure virtualization math for the data-viewer grid. No DOM, no
 *  framework dependency — unit-testable under Bun. */

export type VisibleArgs = {
    scrollTop: number;
    viewportHeight: number;
    rowHeight: number;
    nrow: number;
    overscan: number;
};

export type Range = { start: number; end: number };

export function visibleRange(a: VisibleArgs): Range {
    const start = Math.max(0, Math.floor(a.scrollTop / a.rowHeight) - a.overscan);
    const visibleCount = Math.ceil(a.viewportHeight / a.rowHeight);
    const end = Math.min(
        a.nrow,
        Math.floor(a.scrollTop / a.rowHeight) + visibleCount + a.overscan,
    );
    return { start, end };
}

/** Wrap `fn` so multiple synchronous calls within the cool-off window
 *  collapse to one trailing-edge invocation with the latest args. */
export function coalesceScroll<F extends (...args: any[]) => void>(
    fn: F,
    intervalMs: number,
): (...args: Parameters<F>) => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: Parameters<F> | null = null;
    return (...args: Parameters<F>) => {
        pending = args;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            const a = pending!;
            pending = null;
            fn(...a);
        }, intervalMs);
    };
}
