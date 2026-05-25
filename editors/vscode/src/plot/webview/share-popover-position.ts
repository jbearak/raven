// Pure positioning math for the share-popover, extracted from
// `App.svelte` so it's unit-testable. The Svelte component still owns
// the DOM measurement (offsetWidth/offsetHeight on a momentarily
// `visibility: hidden; display: flex` element) and the inline-style
// writes — only the clamp algorithm lives here.
//
// Design: the popover is anchored to the right side of the toolbar's
// share button. The default position is `left = buttonRight - width`,
// so the popover's right edge aligns with the button's right edge.
// When that would leave parts of the popover off-screen, we clamp into
// the viewport in a specific order so the user always sees the most
// useful portion:
//
//   - Horizontal: prefer keeping the RIGHT edge in view (so the user's
//     eye, which followed the share button to find the popover, lands
//     on visible content). On a viewport narrower than the popover,
//     the left edge extends off-left rather than the right edge off-
//     right.
//   - Vertical: prefer below the button, but flip above when below
//     would overflow AND there's more room above. Final clamp keeps
//     the TOP edge in view so users see the first item even if the
//     popover is taller than the viewport (degenerate case).
//
// The function is pure (no globals, no DOM), takes plain numbers in,
// returns plain numbers out — `compute_share_popover_position` is the
// single source of truth and the test suite enumerates every clamp
// branch.

/** A 2D bounding box, viewport-relative (matches DOMRect fields). */
export interface PositionRect {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

export interface PositionViewport {
    readonly width: number;
    readonly height: number;
}

export interface PositionResult {
    readonly left: number;
    readonly top: number;
}

/** Inset (px) preserved between popover and viewport edges. */
export const POPOVER_VIEWPORT_PADDING = 4;
/** Gap (px) between the trigger button and the popover. */
export const POPOVER_TRIGGER_GAP = 4;

/**
 * Compute the (left, top) inline position for the share popover.
 *
 * @param button - the share button's getBoundingClientRect output (we
 *                 only need top/right/bottom)
 * @param popover - the popover's measured natural box
 * @param viewport - the viewport dimensions (window.innerWidth/Height)
 * @returns inline left/top values, in CSS pixels
 */
export function compute_share_popover_position(
    button: PositionRect,
    popover: { width: number; height: number },
    viewport: PositionViewport,
): PositionResult {
    const PAD = POPOVER_VIEWPORT_PADDING;
    const GAP = POPOVER_TRIGGER_GAP;

    // HORIZONTAL CLAMP. Right-edge-wins algorithm:
    //   1. Start at the preferred (right-anchored) position:
    //      left = buttonRight - popoverWidth. With a wide-enough
    //      viewport this places the popover's right edge directly
    //      under the button's right edge.
    //   2. If that would push the LEFT edge off-screen (preferred <
    //      PAD), slide right to PAD.
    //   3. If the result would push the RIGHT edge off-screen, slide
    //      LEFT until the right edge fits at innerW - PAD. When the
    //      popover is wider than the viewport, this step makes `left`
    //      negative — the LEFT edge extends off-screen and the user
    //      still sees the right portion (closest to the trigger).
    //
    // Order matters: step 3 runs AFTER step 2 so the RIGHT-edge
    // constraint always wins. Swapping the order would make narrow
    // viewports prefer left-alignment and hide the last item ("PDF")
    // off-screen, defeating the right-anchor design intent.
    let left = button.right - popover.width;
    if (left < PAD) left = PAD;
    if (left + popover.width > viewport.width - PAD) {
        left = viewport.width - PAD - popover.width;
    }

    // VERTICAL CLAMP.
    //   1. Default: place below the button (top = buttonBottom + GAP).
    //   2. If that overflows the bottom AND there's usable room above
    //      (topAbove >= PAD) AND there's more room above than below,
    //      flip to place above (top = buttonTop - GAP - h). The
    //      `topAbove >= PAD` gate is what actually decides whether the
    //      flip is feasible — `roomAbove > roomBelow` is the
    //      tiebreaker the design intent encodes, but under overflow
    //      with EQUAL rooms (a+b == viewport.height) the topAbove gate
    //      always fails algebraically, so the strict `>` vs `>=` of
    //      the room comparator is observationally inert. Choose strict
    //      `>` defensively (ties favor staying below — natural reading
    //      order, button is on screen) but don't claim the comparator
    //      is the decisive gate.
    //   3. If still overflowing, clamp top so the popover stops at the
    //      bottom viewport padding (top = innerH - PAD - h). On
    //      degenerate cases (popover taller than viewport), this can
    //      pull top to a small/negative value; the trailing `< PAD`
    //      clamp then forces top = PAD so the TOP edge of the popover
    //      wins (user sees first items; bottom extends off-screen).
    //   4. The trailing `if (top < PAD) top = PAD` is ALSO load-bearing
    //      for a SEPARATE case the steps above don't cover: a button
    //      scrolled above the viewport (button.bottom < PAD, possibly
    //      negative). The default `top = button.bottom + GAP` then
    //      lands below PAD, but the overflow branch isn't entered
    //      (the popover would happily fit below the off-screen
    //      button). Without this trailing clamp the popover would
    //      render at negative top. See the
    //      `button scrolled above viewport` test for coverage.
    let top = button.bottom + GAP;
    if (top + popover.height > viewport.height - PAD) {
        const topAbove = button.top - GAP - popover.height;
        const roomAbove = button.top;
        const roomBelow = viewport.height - button.bottom;
        if (topAbove >= PAD && roomAbove > roomBelow) {
            top = topAbove;
        } else {
            top = Math.max(PAD, viewport.height - PAD - popover.height);
        }
    }
    if (top < PAD) top = PAD;

    return { left, top };
}
