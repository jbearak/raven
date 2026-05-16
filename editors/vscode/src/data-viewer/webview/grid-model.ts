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


// ----- Custom scrollbar math (issue #183 follow-up) ---------------------

/** Minimum pixel height for the custom scrollbar thumb. Below this the
 *  thumb is hard to click/drag. Chosen so even a 10 M-row dataset gets a
 *  visible, draggable thumb. */
export const MIN_THUMB_PX = 30;

/** Pixel reservation at the bottom of the custom scrollbar track for the
 *  native horizontal scrollbar, when present. The CSS rule sets the
 *  track's `bottom: HORIZONTAL_GUTTER_PX`, and the math takes
 *  `trackHeight = viewportHeight - HORIZONTAL_GUTTER_PX`. Sharing the
 *  constant guarantees the math + layout agree.
 *
 *  Always reserved, regardless of whether the horizontal scrollbar is
 *  actually present. The visual cost when absent is the thumb stopping
 *  ~12 px shy of the viewport bottom (negligible). The alternative —
 *  measuring dynamically — adds layout-thrash on every render with
 *  little benefit. */
export const HORIZONTAL_GUTTER_PX = 12;

/** Pixel height of the custom scrollbar thumb. The thumb represents the
 *  fraction of the dataset currently visible (visibleCount / nrow), with
 *  a hard minimum so even a single visible row in a 10 M-row dataset
 *  produces a draggable thumb. The minimum is itself capped at the
 *  track height — for tiny tracks (< MIN_THUMB_PX), the thumb fills the
 *  track rather than overflowing it.
 *
 *  Note `trackHeight`, not `viewportHeight`: the track is shorter than
 *  the viewport by HORIZONTAL_GUTTER_PX (see above). */
export function customThumbHeight(
    trackHeight: number,
    rowHeight: number,
    nrow: number,
): number {
    if (trackHeight <= 0) return 0;
    if (nrow <= 0 || rowHeight <= 0) return trackHeight;
    const visibleCount = Math.max(1, Math.ceil(trackHeight / rowHeight));
    if (visibleCount >= nrow) return trackHeight;
    const proportional = trackHeight * (visibleCount / nrow);
    return Math.min(trackHeight, Math.max(MIN_THUMB_PX, proportional));
}

/** Pixel offset of the thumb's top from the top of the track. Track
 *  height is `viewportHeight - HORIZONTAL_GUTTER_PX`; the thumb's top
 *  can range from 0 to (trackHeight - thumbHeight). The mapping is
 *  linear in the *physical* scrollTop so the thumb tracks user
 *  scrolling exactly. */
export function customThumbTop(
    scrollTop: number,
    trackHeight: number,
    thumbHeight: number,
    maxPhysical: number,
): number {
    const trackUsable = Math.max(0, trackHeight - thumbHeight);
    if (maxPhysical <= 0 || trackUsable <= 0) return 0;
    const fraction = Math.max(0, Math.min(1, scrollTop / maxPhysical));
    return fraction * trackUsable;
}

/** Convert a thumb-top pixel offset (during a drag) back to the physical
 *  scrollTop the viewport needs. Inverse of customThumbTop. The caller
 *  sets viewportEl.scrollTop = result; the existing onScroll →
 *  scheduleFetchVisible pipeline does the rest. */
export function customScrollTopFromThumbTop(
    thumbTop: number,
    trackHeight: number,
    thumbHeight: number,
    maxPhysical: number,
): number {
    const trackUsable = Math.max(0, trackHeight - thumbHeight);
    if (trackUsable <= 0 || maxPhysical <= 0) return 0;
    const fraction = Math.max(0, Math.min(1, thumbTop / trackUsable));
    return fraction * maxPhysical;
}
