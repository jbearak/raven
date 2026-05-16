/** Pure virtualization math for the data-viewer grid. No DOM, no
 *  framework dependency — unit-testable under Bun. */

/** Chrome/Electron clips a div's scrollHeight at 2^24 = 16,777,216 px.
 *  We stay below it so the scrollbar isn't silently truncated on large
 *  datasets. At 24 px/row this lets the native path handle ~640 K rows;
 *  above that we remap logical ↔ visual coordinates. */
export const MAX_SCROLL_PX = 15_000_000;

/** Height to assign to the scroll-content div. Capped so the browser's
 *  pixel-height limit never truncates the scrollbar range. */
export function cappedScrollHeight(totalGridHeight: number): number {
    return Math.min(totalGridHeight, MAX_SCROLL_PX);
}

/** Map a physical scrollTop (in the capped container) to the logical
 *  scrollTop that visibleRange() expects. Identity-shaped when content fits.
 *
 *  The physical scroll range is [0, MAX_SCROLL_PX + rowHeight - viewportHeight]
 *  and the logical scroll range is [0, totalGridHeight + rowHeight - viewportHeight],
 *  so we scale between those two maxima (not between MAX_SCROLL_PX and
 *  totalGridHeight) to reach the very last row when scrolled to the bottom.
 *
 *  Both branches clamp to [0, maxLogical]. macOS rubber-band can briefly
 *  push scrollTop above maxPhysical; without the clamp the scaled value
 *  exceeds maxLogical, visibleRange's floor() math gives start > nrow,
 *  and the resulting empty range blanks the grid until the bounce
 *  resolves. The negative clamp is defensive against hypothetical
 *  Chromium oddities; in practice scrollTop should never be negative. */
export function logicalScrollTop(
    scrollTop: number,
    totalGridHeight: number,
    viewportHeight: number,
    rowHeight: number,
): number {
    if (totalGridHeight <= MAX_SCROLL_PX) {
        const maxLogicalSmall = Math.max(0, totalGridHeight + rowHeight - viewportHeight);
        return Math.max(0, Math.min(maxLogicalSmall, scrollTop));
    }
    const maxPhysical = MAX_SCROLL_PX + rowHeight - viewportHeight;
    if (maxPhysical <= 0) return 0;
    const maxLogical = totalGridHeight + rowHeight - viewportHeight;
    const scaled = (scrollTop / maxPhysical) * maxLogical;
    return Math.max(0, Math.min(maxLogical, scaled));
}

/** Map a logical pixel offset (visibleRangeStart × rowHeight) back to a
 *  visual translateY for use inside the capped scroll container. */
export function visualOffsetPx(
    logicalOffsetPx: number,
    totalGridHeight: number,
    viewportHeight: number,
    rowHeight: number,
): number {
    if (totalGridHeight <= MAX_SCROLL_PX) return logicalOffsetPx;
    const maxLogical = totalGridHeight + rowHeight - viewportHeight;
    if (maxLogical <= 0) return 0;
    const maxPhysical = MAX_SCROLL_PX + rowHeight - viewportHeight;
    return (logicalOffsetPx / maxLogical) * maxPhysical;
}

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
