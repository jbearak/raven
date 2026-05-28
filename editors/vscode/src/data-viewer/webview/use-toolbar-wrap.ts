/**
 * Decides when the data-viewer toolbar's sort/filter chip group must
 * drop onto its own second row so the action buttons stay pinned
 * top-right.
 *
 * The pure `shouldWrap` holds the policy and is unit-tested; the
 * `useToolbarWrap` hook feeds it widths measured from the DOM and
 * re-measures on resize and on chip/row-count changes.
 */

import {
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
} from 'react';

/**
 * Once wrapped, the content must shrink this many pixels below the
 * available width before we unwrap again. The band keeps sub-pixel
 * layout jitter at the boundary from flapping the toolbar between one
 * and two rows.
 */
export const WRAP_HYSTERESIS_PX = 8;

/** Flex `gap` on `.toolbar` and `.toolbar-chips`, in px (see styles.css). */
const TOOLBAR_GAP_PX = 8;

/** Intrinsic (content) widths of the three toolbar regions, in px. */
export interface ToolbarPartWidths {
    leadPx: number; // the row-count span
    chipsPx: number; // sort + filter strips (summed content + inner gaps)
    actionsPx: number; // the Labels / Format / digits / Columns controls
}

/**
 * Decide whether the chip group should wrap to its own row.
 *
 * `wasWrapped` is the current state, used only for the hysteresis
 * band. The decision is otherwise a fixed point — and so does not
 * oscillate — only as long as the measured `parts` widths are the same
 * whether or not the toolbar is currently wrapped. The hook below holds
 * up its end of that bargain by summing each strip's `scrollWidth`
 * (intrinsic content width); see the precondition documented there.
 */
export function shouldWrap(
    parts: ToolbarPartWidths,
    availablePx: number,
    gapPx: number,
    wasWrapped: boolean,
): boolean {
    // With no chips there is nothing to move to a second row, so
    // wrapping could never relieve a row-1 overflow.
    if (parts.chipsPx <= 0) {
        return false;
    }

    const presentWidths = [parts.leadPx, parts.chipsPx, parts.actionsPx]
        .filter(width => width > 0);

    const contentPx = presentWidths.reduce((sum, width) => sum + width, 0);
    const gapsPx = Math.max(0, presentWidths.length - 1) * gapPx;
    const neededPx = contentPx + gapsPx;

    const thresholdPx = wasWrapped
        ? availablePx - WRAP_HYSTERESIS_PX
        : availablePx;
    return neededPx > thresholdPx;
}

interface ToolbarWrapRefs {
    toolbar: RefObject<HTMLElement | null>;
    lead: RefObject<HTMLElement | null>;
    chips: RefObject<HTMLElement | null>;
    actions: RefObject<HTMLElement | null>;
}

/**
 * Track whether the toolbar chip group must wrap onto its own row.
 *
 * Measures intrinsic content widths — each region's `scrollWidth`, and
 * for the chips the sum of the individual strips' intrinsic widths (not
 * the `.toolbar-chips` container's `scrollWidth`, which stretches to full
 * width when wrapped and would then read as overflowing) — and compares
 * them to the toolbar's client width via `shouldWrap`.
 *
 * PRECONDITION (keeps `shouldWrap` from oscillating): every measured
 * region's reported intrinsic width must be stable regardless of how
 * wide its parent is. Each region's "intrinsic width" is its own
 * `scrollWidth` plus the clipped overflow of any nested `overflow:auto`
 * / `overflow:scroll` descendant — Raven's chip strips have an inner
 * scrollable `.sort-strip-chips` / `.filter-strip-chips` so the strip
 * label and clear-all stay visible while the chips themselves scroll,
 * and the outer strip's own `scrollWidth` would otherwise collapse to
 * the strip's constrained allocation. Adding back the inner
 * `scrollWidth − clientWidth` recovers the full chip content width,
 * and is independent of the parent's width.
 *
 * Re-measures on toolbar width changes (ResizeObserver, ignoring
 * height-only churn from wrapping) and whenever `contentDeps` change.
 * Callers must include in `contentDeps` anything that changes a
 * region's width without changing the toolbar's width — e.g. the Columns
 * count badge, which widens the action buttons.
 */

/** Intrinsic width of an element, including any content clipped by a
 *  nested `overflow:auto` / `overflow:scroll` descendant. The element's
 *  own `scrollWidth` already counts visible content; for each inner
 *  scroll container we add back `scrollWidth − clientWidth`, the portion
 *  the container hides. This is independent of the parent's width — as
 *  the parent shrinks, the element's `scrollWidth` shrinks and the
 *  hidden portion grows by the same amount, so their sum stays fixed.
 *  Exported so the real-layout test harness can self-calibrate boundary
 *  widths against the same number the hook uses. */
export function intrinsicWidthPx(element: HTMLElement): number {
    let widthPx = element.scrollWidth;
    element.querySelectorAll<HTMLElement>('*').forEach(el => {
        const overflowX = getComputedStyle(el).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') {
            widthPx += Math.max(0, el.scrollWidth - el.clientWidth);
        }
    });
    return widthPx;
}
export function useToolbarWrap(
    refs: ToolbarWrapRefs,
    contentDeps: readonly unknown[],
): boolean {
    const [isWrapped, setIsWrapped] = useState(false);

    const measure = (): void => {
        const toolbar = refs.toolbar.current;
        if (!toolbar) return;

        const lead = refs.lead.current;
        const actions = refs.actions.current;
        const leadPx = lead ? intrinsicWidthPx(lead) : 0;
        const actionsPx = actions ? intrinsicWidthPx(actions) : 0;

        let chipsPx = 0;
        const chips = refs.chips.current;
        if (chips) {
            const strips = Array.from(chips.children) as HTMLElement[];
            for (const strip of strips) {
                chipsPx += intrinsicWidthPx(strip);
            }
            chipsPx += Math.max(0, strips.length - 1) * TOOLBAR_GAP_PX;
        }

        const parts = { leadPx, chipsPx, actionsPx };
        const availablePx = toolbar.clientWidth;
        // Decide against the committed `prev`, not a closed-over value, so
        // the hysteresis band always sees the true current wrap state.
        setIsWrapped(prev => {
            const next = shouldWrap(parts, availablePx, TOOLBAR_GAP_PX, prev);
            return prev === next ? prev : next;
        });
    };

    // Keep a ref to the latest `measure` (closing over the current
    // `refs`) so the one-time observer below can call it without
    // re-subscribing.
    const measureRef = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        measureRef.current = measure;
    });

    // Re-measure when chip/row-count content changes (width may be
    // unchanged, so the ResizeObserver would not fire on its own).
    useLayoutEffect(() => {
        measureRef.current();
    }, contentDeps);

    // Observe toolbar width once. Wrapping changes the toolbar's height
    // but not its width, so a width guard avoids a feedback callback.
    useLayoutEffect(() => {
        const toolbar = refs.toolbar.current;
        if (!toolbar || typeof ResizeObserver === 'undefined') return;
        let lastWidthPx = -1;
        const observer = new ResizeObserver(() => {
            const widthPx = toolbar.clientWidth;
            if (widthPx === lastWidthPx) return;
            lastWidthPx = widthPx;
            measureRef.current();
        });
        observer.observe(toolbar);
        return () => observer.disconnect();
    }, [refs.toolbar]);

    return isWrapped;
}
