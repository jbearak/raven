<script lang="ts">
    import {
        customThumbHeight,
        customThumbTop,
        customScrollTopFromThumbTop,
    } from './grid-model';

    interface Props {
        /** Pixel height of the scrollbar track (viewportHeight minus the
         *  HORIZONTAL_GUTTER_PX bottom reservation). */
        trackHeight: number;
        /** Current physical scrollTop of the viewport. */
        scrollTop: number;
        /** Total row count in the dataset. */
        nrow: number;
        /** Pixel height of one row. */
        rowHeight: number;
        /** Maximum physical scrollTop = MAX_SCROLL_PX + rowHeight - viewportHeight. */
        maxPhysical: number;
        /** Callback invoked when the user's drag or click changes the
         *  desired scrollTop. The parent should set viewportEl.scrollTop
         *  to this value; the browser's onScroll handler does the rest. */
        onScrollTo: (newScrollTop: number) => void;
    }

    let { trackHeight, scrollTop, nrow, rowHeight, maxPhysical, onScrollTo }: Props = $props();

    let trackEl: HTMLDivElement | null = $state(null);

    /** Pointer Y offset relative to thumb top at drag start. null when
     *  not dragging. */
    let dragOffset: number | null = $state(null);
    /** Captured pointer id, for safe release on cleanup paths. */
    let dragPointerId: number | null = null;
    /** getBoundingClientRect().top of the track at drag start. Cached so
     *  pointermove doesn't re-measure on every frame. */
    let dragTrackTop = 0;

    const thumbHeight = $derived(customThumbHeight(trackHeight, rowHeight, nrow));
    const thumbTop = $derived(customThumbTop(scrollTop, trackHeight, thumbHeight, maxPhysical));

    function onThumbPointerDown(e: PointerEvent): void {
        if (e.button !== 0) return;
        if (!trackEl) return;
        e.preventDefault();
        e.stopPropagation();   // don't also trigger track-paging
        dragPointerId = e.pointerId;
        dragTrackTop = trackEl.getBoundingClientRect().top;
        dragOffset = e.clientY - (dragTrackTop + thumbTop);
        // Synthetic events from the test seam may not be eligible for
        // capture in all browsers; real user events always succeed.
        try {
            (e.target as Element).setPointerCapture(e.pointerId);
        } catch {
            // ignore — capture is a quality-of-life win, not required
        }
    }

    function onThumbPointerMove(e: PointerEvent): void {
        if (dragOffset === null) return;
        const rawThumbTop = e.clientY - dragTrackTop - dragOffset;
        const clampedThumbTop = Math.max(0, Math.min(trackHeight - thumbHeight, rawThumbTop));
        onScrollTo(customScrollTopFromThumbTop(clampedThumbTop, trackHeight, thumbHeight, maxPhysical));
    }

    function endDrag(e: PointerEvent): void {
        if (dragPointerId !== null) {
            const target = e.target as Element;
            // hasPointerCapture guard: lostpointercapture fires *after*
            // the browser has released, so a naive releasePointerCapture
            // would throw.
            try {
                if (target.hasPointerCapture(dragPointerId)) {
                    target.releasePointerCapture(dragPointerId);
                }
            } catch {
                // ignore
            }
        }
        dragOffset = null;
        dragPointerId = null;
    }

    function onTrackPointerDown(e: PointerEvent): void {
        if (e.button !== 0) return;
        if (!trackEl) return;
        // Page up if click is above the thumb, down if below.
        const trackTop = trackEl.getBoundingClientRect().top;
        const clickY = e.clientY - trackTop;
        const direction = clickY < thumbTop ? -1 : 1;
        onScrollTo(scrollTop + direction * trackHeight);
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="custom-scrollbar-track"
    bind:this={trackEl}
    onpointerdown={onTrackPointerDown}
>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="custom-scrollbar-thumb"
        class:dragging={dragOffset !== null}
        data-test-id="custom-scrollbar-thumb"
        style="top: {thumbTop}px; height: {thumbHeight}px;"
        onpointerdown={onThumbPointerDown}
        onpointermove={onThumbPointerMove}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onlostpointercapture={endDrag}
    ></div>
</div>
