# Data Viewer: Custom Scrollbar for Large Datasets (issue #183 follow-up)

Date: 2026-05-16
Status: Draft for review
Issue: [#183](https://github.com/jbearak/raven/issues/183) — "Data viewer:
can't scroll to the very last row in large datasets"

## Problem

The earlier PR for #183 added `End` / `Home` / `PageUp` / `PageDown`
keyboard shortcuts and clamped `logicalScrollTop` to fix the elastic-scroll
flicker, but explicitly left the native scrollbar drag broken in a
"Known limitations" section. That gap is now in scope.

For datasets with `totalGridHeight > MAX_SCROLL_PX` (≈ 625 K rows × 24 px),
two facts collide:

1. The browser's minimum scrollbar-thumb height (~17 px in Chromium) is
   reached when `clientHeight² / scrollHeight < ~17`. Past that point the
   thumb is rendered larger than its natural size, but Chromium's drag
   math uses the natural size, so the bottom of the drag track maps to a
   `scrollTop < scrollHeight - clientHeight`. Dragging the pill all the
   way down stops short of the last row.
2. Reducing `MAX_SCROLL_PX` to a value that keeps the natural thumb ≥ 17 px
   (≈ 21 K px for a 600-px viewport) destroys per-pixel scroll resolution:
   one wheel notch or one `ArrowDown` press would jump thousands of rows on
   a multi-million-row dataset. Wheel and arrow scrolling become unusable.

There is no value of `MAX_SCROLL_PX` that simultaneously gives a
draggable thumb *and* responsive wheel/arrow scrolling on huge datasets.
The only fix is to take ownership of the scrollbar widget.

## Goals / Non-Goals

Goals:

1. Dragging the scrollbar thumb to the bottom reaches the very last row
   on any dataset, including multi-million-row frames.
2. The fix engages **only** when the existing remap engages — i.e. only
   when `totalGridHeight > MAX_SCROLL_PX`. Below that threshold, the
   native scrollbar is preserved unchanged; users see the same VS Code
   styling they're used to for the common case (most R data frames are
   under 100 K rows).
3. The custom scrollbar is theme-aware via VS Code's
   `--vscode-scrollbarSlider-*` CSS variables, so the visual treatment
   matches the rest of VS Code as closely as a hand-rolled widget can.
4. Wheel, keyboard, and `ArrowDown` continue to behave exactly as they do
   today (they aren't part of the bug). No new event interception.
5. Cover both code paths with automated tests:
   - Bun unit tests for the new scrollbar math.
   - A mocha integration test that drives a drag-to-bottom and asserts
     the last row is reached.

Non-goals for this change:

- Replacing the **horizontal** native scrollbar. It isn't part of the
  bug; column counts stay small, no min-thumb compression problem.
  Keeping native horizontal preserves the platform-native feel where
  it works.
- Animation / smooth-scroll on track click. Native scrollbar paging is
  immediate; we match that.
- Touch / pointer-pen scrolling on touchscreens. The webview rarely
  runs on a touchscreen, and pointer events cover the common case.
  Touch-momentum scrolling continues to work via the native (visible
  but no-thumb) scroll mechanism.
- A draggable thumb on the **horizontal** scrollbar. See above.
- Changing `MAX_SCROLL_PX` or the existing remap. The remap is correct;
  the scrollbar widget was the broken piece.
- Custom track-click animations or velocity-aware scroll behavior.

## Architecture

A new Svelte-rendered scrollbar overlay that **conditionally** appears on
the right edge of the viewport. The native vertical scrollbar is hidden
on the same condition via CSS, with the gutter explicitly reserved so
the overlay has a 12-px lane to live in. A single derived flag controls
both:

```typescript
const useCustomScrollbar = $derived(totalGridHeight > MAX_SCROLL_PX);
```

When `useCustomScrollbar` is `true`:
- A class `using-custom-scrollbar` is applied to the viewport, which
  hides the native vertical scrollbar via `::-webkit-scrollbar:vertical`
  *and* reserves 12 px of right padding so the layout doesn't reclaim
  the scrollbar gutter.
- A new `<CustomScrollbar />` widget is rendered as a **sibling of the
  viewport**, inside a `viewport-wrapper` element that has
  `position: relative` so the overlay's `position: absolute` is
  relative to the viewport's bounding box (not its scroll content).
- The widget owns pointer-down / move / up handling on the thumb, plus
  pointer-down on the track for paging.

When `useCustomScrollbar` is `false` (the small/moderate-data case),
nothing changes from today: native scrollbar, no overlay, no extra
padding, no extra wrapper class.

Architecture diagram:

```text
viewport-wrapper (position: relative; flex: 1 1 auto)
├── viewport (overflow: auto; padding-right: 12px when using-custom-scrollbar)
│   └── grid (height: cappedScrollHeight + ROW_HEIGHT)
│       ├── header-row (sticky)
│       └── rows (translateY = visualOffsetPx(...))
└── CustomScrollbar (only when totalGridHeight > MAX_SCROLL_PX)
    │   position: absolute; right: 0; top: 0; bottom: 12px; width: 12px
    │   (bottom: 12px reserves room for the native horizontal scrollbar
    │    when present; if absent the overlay just stops 12 px shy of the
    │    bottom — visually negligible)
    └── thumb (size + position derived from scroll state)
```

The overlay being a **sibling** of the viewport rather than a child is
the key fix: an absolutely-positioned descendant of an `overflow: auto`
element is laid out in the element's *scroll content* coordinate space
(it scrolls with the content). Sibling-with-relative-wrapper places it
in the wrapper's coordinate space, which is fixed relative to the
scrollport.

The horizontal native scrollbar is unchanged on every code path.

## Math additions to `grid-model.ts`

Three new pure functions plus a shared constant for the bottom reservation,
all unit-testable under Bun. The CSS layout and the math share `HORIZONTAL_GUTTER_PX`
as a single source of truth — earlier drafts had them disagree (CSS used
`bottom: 12 px` while math used full `viewportHeight`, so a drag to
fraction 1 would overshoot the visible track by 12 px).

```typescript
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
```

`maxPhysical` here is the same `MAX_SCROLL_PX + ROW_HEIGHT - viewportHeight`
the existing code already computes in `logicalScrollTop`. Exposing the
math layer in `grid-model.ts` keeps the thumb computations DOM-free and
unit-testable.

## App.svelte changes

### Imports

`MAX_SCROLL_PX` is currently used only inside `grid-model.ts`. App.svelte
needs to import it (and the new `HORIZONTAL_GUTTER_PX`) for the gate and
for the `trackHeight` / `maxPhysical` props on `<CustomScrollbar />`.
Add to the existing import:

```typescript
import {
    visibleRange, coalesceScroll,
    cappedScrollHeight, logicalScrollTop, visualOffsetPx,
    MAX_SCROLL_PX, HORIZONTAL_GUTTER_PX,
} from './grid-model';
```

### CSS classes (distinct names, no collision risk)

Two new classes, prefixed and named for their role:

- `.viewport.using-custom-scrollbar` — applied to the viewport when the
  gate is on. Hides the native vertical scrollbar pseudo-element and
  reserves 12 px of right padding so the layout doesn't reclaim the
  scrollbar gutter (Chromium removes the gutter entirely when the
  pseudo is `display: none`).
- `.custom-scrollbar-track` — the overlay's outer element.
- `.custom-scrollbar-thumb` — the draggable thumb inside the track.

```css
.viewport.using-custom-scrollbar {
    /* Reserve a 12 px lane for the overlay so grid content doesn't
     * extend under it. Without this, hiding the native scrollbar via
     * ::-webkit-scrollbar:vertical { display: none } collapses the
     * gutter and the rightmost cells/resize handles are obscured. */
    padding-right: 12px;
}

.viewport.using-custom-scrollbar::-webkit-scrollbar:vertical {
    display: none;
}

.custom-scrollbar-track {
    position: absolute;
    right: 0;
    top: 0;
    /* HORIZONTAL_GUTTER_PX = 12 px reserved at the bottom for the native
     * horizontal scrollbar when present. The math layer takes
     * trackHeight = viewportHeight - 12 to match. */
    bottom: 12px;
    width: 12px;
    background: transparent;
    z-index: 3;  /* above sticky header (z-index: 2) */
    user-select: none;
}

.custom-scrollbar-thumb {
    position: absolute;
    left: 2px;
    right: 2px;
    background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
    border-radius: 4px;
    cursor: default;
}

.custom-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
}

.custom-scrollbar-thumb.dragging {
    background: var(--vscode-scrollbarSlider-activeBackground, rgba(191, 191, 191, 0.4));
}
```

### Layout

The viewport is wrapped in a relatively-positioned wrapper so the
`<CustomScrollbar />` overlay (sibling of the viewport) is laid out in
the wrapper's coordinate space rather than the viewport's scroll
content:

```svelte
<div class="viewport-wrapper">
    <div class="viewport"
         class:using-custom-scrollbar={useCustomScrollbar}
         bind:this={viewportEl}
         onscroll={onScroll}
         tabindex="0"
         role="grid"
         aria-rowcount={nrow}>
        <div class="grid">
            <!-- header-row, rows ... -->
        </div>
    </div>
    {#if useCustomScrollbar}
        <CustomScrollbar
            trackHeight={Math.max(0, viewportHeight - HORIZONTAL_GUTTER_PX)}
            scrollTop={scrollTop}
            nrow={nrow}
            rowHeight={ROW_HEIGHT}
            maxPhysical={MAX_SCROLL_PX + ROW_HEIGHT - viewportHeight}
            onScrollTo={(newScrollTop) => {
                if (viewportEl) viewportEl.scrollTop = newScrollTop;
            }}
        />
    {/if}
</div>
```

```css
.viewport-wrapper {
    position: relative;
    flex: 1 1 auto;
    display: flex;
    /* Required so the inner viewport can shrink-to-fit and scroll its
     * own content. Default `min-height/width: auto` on flex items would
     * make the wrapper grow to the inner grid's intrinsic height
     * (potentially MAX_SCROLL_PX!), defeating the overlay-as-fixed-to-
     * scrollport premise. */
    min-height: 0;
    min-width: 0;
}

.viewport-wrapper > .viewport {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
}
```

### `<CustomScrollbar />` widget

A new Svelte component file
`editors/vscode/src/data-viewer/webview/CustomScrollbar.svelte`.
Rationale for a separate file: the pointer-event logic is self-contained
(track + thumb), and isolating it keeps `App.svelte` focused on grid
rendering. Inputs are read-only props derived from `App.svelte`'s state;
the widget reaches back via a callback to set `viewportEl.scrollTop`.

```text
Props:
- trackHeight: number   (= viewportHeight - HORIZONTAL_GUTTER_PX)
- scrollTop: number
- nrow: number
- rowHeight: number
- maxPhysical: number
- onScrollTo: (newScrollTop: number) => void
```

Internal state:
- `dragOffset: number | null` — pointer Y at drag start, relative to the
  thumb's top. `null` when not dragging.
- `pointerId: number | null` — captured pointer id, used to release
  capture safely on cleanup paths.
- `dragTrackTop: number` — `getBoundingClientRect().top` of the track,
  cached at drag start so `pointermove` doesn't have to re-measure each
  frame.

Visual structure (the widget is the track; thumb is its child):

```text
<div class="custom-scrollbar-track">
    <div class="custom-scrollbar-thumb">
    </div>
</div>
```

Pointer event flow:

- `pointerdown` on `.custom-scrollbar-thumb`:
  - Record `pointerId = e.pointerId`, `dragOffset = e.clientY -
    thumbTopAbsolute`, `dragTrackTop = trackEl.getBoundingClientRect().top`.
  - `try { (e.target as Element).setPointerCapture(e.pointerId); }
    catch { /* ignore — synthetic events from the test seam may not be
    eligible for capture */ }`. Real user events always succeed.
  - `e.preventDefault()` and `e.stopPropagation()` — the latter so the
    track-paging handler below doesn't also fire.
- `pointermove` on `.custom-scrollbar-thumb` (only while
  `dragOffset !== null`):
  - Compute `thumbTop = e.clientY - dragTrackTop - dragOffset`,
    clamp to `[0, trackHeight - thumbHeight]`.
  - `onScrollTo(customScrollTopFromThumbTop(thumbTop, trackHeight,
    thumbHeight, maxPhysical))`.
- `pointerup` / `pointercancel` / `lostpointercapture`: cleanup.
  - `if (pointerId !== null && (e.target as Element).hasPointerCapture(pointerId)) {
       (e.target as Element).releasePointerCapture(pointerId);
     }`
  - Clear `dragOffset` and `pointerId`.
  - The `hasPointerCapture` guard is required because
    `lostpointercapture` fires *after* the browser has already released
    the capture; calling `releasePointerCapture` on an already-released
    pointer throws in some browsers.
- `pointerdown` on the track (not on the thumb): page up or down
  depending on whether the click is above or below the current thumb
  position. `onScrollTo(scrollTop ± trackHeight)`. The browser
  clamps the assignment to `viewportEl.scrollTop` at `[0, maxPhysical]`.

The widget does **not** capture wheel or keyboard events; those continue
to flow through the native scroll mechanism (the vertical scrollbar is
hidden but the viewport is still `overflow: auto` and accepts wheel /
keyboard scroll natively, which fires `onScroll` and updates the thumb
position via the derived state).

## Test surface

A new test-only message lets the integration test drive the **real
pointer-event pipeline** rather than just the math layer. The webview
synthesizes pointerdown / pointermove / pointerup events on the thumb
element so the same handlers a user's drag would invoke run end-to-end:

```typescript
| {
    /** Test-only: drive a custom-scrollbar drag-to-fraction (0..1) by
     *  dispatching synthetic pointerdown / pointermove / pointerup
     *  events on the thumb element. fraction=0 jumps to top, fraction=1
     *  jumps to bottom. The webview computes the target thumbTop, then
     *  fires the events to exercise the real pointer handlers (drag
     *  offset capture, pointer capture, drag math, cleanup). */
    type: 'testScrollbarDrag';
    panelGeneration: number;
    fraction: number;   // 0 = top, 1 = bottom
  }
```

The webview's `testScrollbarDrag` handler:

1. Grabs the thumb element via the same internal `bind:this` ref the
   widget uses for itself (or via a `data-test-id="custom-scrollbar-thumb"`
   attribute looked up with `document.querySelector`).
2. Computes `trackHeight = viewportHeight - HORIZONTAL_GUTTER_PX`,
   `thumbHeight = customThumbHeight(trackHeight, ROW_HEIGHT, nrow)`, current
   `thumbTop`, and target `thumbTop = fraction * (trackHeight - thumbHeight)`.
3. Dispatches a `pointerdown` on the thumb at its current position with
   `pointerId: 999, pointerType: 'mouse', clientX: thumbCenterX,
   clientY: thumbCenterY, bubbles: true, cancelable: true`. The
   `pointerId: 999` is chosen high enough to avoid colliding with any
   real mouse pointer (Chromium uses `1` for the primary mouse), and
   the handler's `setPointerCapture` is wrapped in try/catch so a
   synthetic-event capture failure doesn't break the test.
4. Dispatches a `pointermove` at the target position with the same
   pointerId so the drag handler computes the move delta.
5. Dispatches a `pointerup` to terminate the drag.

Because the same thumb-element listener handles all three events, the
real pointer-event glue (move/up cleanup, `lostpointercapture` guard,
`hasPointerCapture` defensive release) is exercised — not just the
underlying math. The `setPointerCapture` call may be a no-op in the
synthetic case, but the rest of the drag pipeline runs end-to-end.

A new method on `RavenExtensionApi`:

```typescript
/** Test-only: drive a custom-scrollbar drag in the named panel.
 *  fraction=0 jumps to top, fraction=1 jumps to bottom. */
dragDataViewerScrollbar(panelName: string, fraction: number): Promise<void>;
```

Plus `manager.ts` and `panel.ts` passthroughs analogous to `pressKey`.

## Tests

### Bun unit tests

Add a new `'custom scrollbar math'` describe block to
`tests/bun/data-viewer-grid-model.test.ts`:

```text
test('customThumbHeight: tiny dataset → full track')
test('customThumbHeight: large dataset → MIN_THUMB_PX floor')
test('customThumbHeight: mid-size proportional')
test('customThumbHeight: nrow === 0 → full track')
test('customThumbHeight: rowHeight === 0 → full track')   // edge
test('customThumbHeight: viewportHeight === 0 → 0')        // edge
test('customThumbHeight: viewportHeight < MIN_THUMB_PX → viewportHeight (no overflow)')

test('customThumbTop: scrollTop=0 → 0')
test('customThumbTop: scrollTop=maxPhysical → viewportHeight - thumbHeight')
test('customThumbTop: midpoint → midpoint')
test('customThumbTop: maxPhysical <= 0 → 0')               // edge
test('customThumbTop: thumbHeight >= viewportHeight → 0')  // edge

test('customScrollTopFromThumbTop: thumbTop=0 → 0')
test('customScrollTopFromThumbTop: thumbTop=trackUsable → maxPhysical')
test('customScrollTopFromThumbTop: round-trip with customThumbTop')
test('customScrollTopFromThumbTop: maxPhysical <= 0 → 0')  // edge
test('customScrollTopFromThumbTop: trackUsable <= 0 → 0')  // edge
```

The round-trip test: for any `scrollTop ∈ [0, maxPhysical]`, the result of
applying `customThumbTop` then `customScrollTopFromThumbTop` should match
the original (within floating-point tolerance). This catches any
asymmetry between the forward and reverse mappings.

The tiny-viewport edge tests guard against the
`Math.max(MIN_THUMB_PX, ...)` regression from the codex review: with the
clamp in the corrected order (`min(viewportHeight, max(MIN_THUMB_PX,
proportional))`), a 20-px viewport gets a 20-px thumb (full track), not
a 30-px thumb that overflows.

### Mocha integration test

Add one test to `editors/vscode/src/test/data-viewer.test.ts`:

```text
test('Drag scrollbar to bottom reaches last row in 700K-row data frame', async () => {
    const N = 700_000;
    // Reuse the 'big' panel from the End-key test if it's still open;
    // otherwise create it.
    if (!api.getDataViewerPanelNames().includes('big')) {
        await api.sendToRTerminal(`big <- as.data.frame(matrix(rnorm(${N} * 5), nrow = ${N}, ncol = 5)); View(big)`);
        const appeared = await pollForPanel(api, 'big', 90000);
        assert.ok(appeared);
        // wait for steady state
    }
    await api.pressDataViewerKey('big', 'Home');
    // wait for end > 0 && end < N/2
    await api.dragDataViewerScrollbar('big', 1.0);
    // poll for end === N
});
```

The test deliberately covers the same outcome as the End-key test (last
row reachable) but via a different code path (drag math + scroll
pipeline). If the End-key test passes but this one fails, the bug is
specifically in the drag math; if both fail together, the bug is in the
shared scroll pipeline.

A second integration assertion adds **drag-to-midpoint**:

```text
test('Drag scrollbar to 50% lands near row N/2', async () => {
    // ... open panel, Home reset ...
    await api.dragDataViewerScrollbar('big', 0.5);
    // poll until visibleRangeStart in [0.4 * N, 0.6 * N]
});
```

This catches asymmetric mappings (e.g. accidentally using `nrow * fraction`
on one side and `(nrow - visibleCount) * fraction` on the other).

## Documentation

`docs/data-viewer.md` — append to the existing **Keyboard shortcuts**
subsection (which already mentions issue #183) with a one-paragraph note
that, on multi-million-row data frames, the scrollbar widget is replaced
with a Raven-rendered overlay so dragging the thumb to the bottom
reaches the last row. The native scrollbar is preserved on smaller
frames.

The "Known limitations / partially-resolved part of #183" section in the
**previous design spec**
(`docs/superpowers/specs/2026-05-16-data-viewer-scroll-to-bottom-design.md`)
will be left intact — that document is a historical record of the prior
PR's scope. This new spec supersedes its known-limitation by closing the
gap.

## Open questions

None — the design follows directly from the architecture analysis in the
in-conversation discussion (mathematical impossibility of small
`MAX_SCROLL_PX` keeping wheel responsive on huge data, plus standard
data-grid practice of custom-scrolling above a threshold).

## Risks

- **Pointer events in VS Code's webview iframe.** Synthetic pointer
  events from outside the iframe wouldn't reach our handlers, but the
  widget runs *inside* the iframe and listens to real user pointer
  events on its own DOM, so this risk is the same as any other
  webview-internal interaction (which already works for cell selection,
  column-resize, and toolbar buttons).
- **`pointercapture` browser support.** All Chromium-based webviews
  support it; we already use it for column resize
  (`onResizeHandlePointerDown` calls `setPointerCapture`). No new
  dependency.
- **Theming drift.** VS Code's `--vscode-scrollbarSlider-*` variables
  may not exactly match every theme's native scrollbar. Mitigation: use
  the canonical names and accept minor visual differences. The
  alternative (perfectly matching every theme) is impossible without
  rendering through the OS scrollbar API, which we're explicitly moving
  away from.
- **Hidden vertical scrollbar gutter.** When `::-webkit-scrollbar:vertical`
  is hidden, the scroll gutter still consumes width if the layout doesn't
  account for it. Mitigation: the custom scrollbar overlays the right
  edge with the same width Chromium reserves (~12 px), so the visual
  layout is unchanged. We test this by inspection.
- **Visual jump at the cap threshold.** Users opening a 624 K-row dataset
  see the native scrollbar; opening a 626 K-row dataset sees the custom
  one. The visual difference is minor (themed via VS Code variables) but
  exists. Mitigation: the threshold is unchanged (it's the existing
  `MAX_SCROLL_PX`), so users only encounter the switch when they're also
  on the boundary of the existing remap behavior — they'd see *some*
  change at this threshold either way.
- **Drag during fast scroll.** If the user wheels rapidly while
  `dragOffset !== null`, both inputs would compete for `scrollTop`. The
  pointer-capture should keep the drag dominant. We don't need to
  explicitly suppress wheel during drag.

## What the mocha test does and does not prove

Unlike the prior PR's keyboard test (which dispatched a synthetic
`KeyboardEvent` on `window` and only proved the handler logic), the
custom-scrollbar test dispatches synthetic **pointer** events on the
**thumb element itself**. That exercises the full pipeline:

- pointerdown → drag-offset capture + `setPointerCapture`
- pointermove → drag math (`customScrollTopFromThumbTop`) →
  `onScrollTo` → `viewportEl.scrollTop` → `onScroll` →
  `scheduleFetchVisible` → `getRows` → `applyRows` →
  `postLifecycle('rows')`
- pointerup → cleanup via `lostpointercapture` / `releasePointerCapture`
  guarded by `hasPointerCapture`

What the test still does **not** exercise:

- VS Code's parent-window → iframe pointer event forwarding (a real user
  click outside the iframe wouldn't reach our handlers; a real user
  click inside the iframe would).
- Trackpad / touchscreen pointer types (the synthetic events use the
  default `pointerType: 'mouse'`).
- Hover-state styling transitions (`:hover`, `.dragging` class).

Those are the legitimate pieces of the pointer pipeline that an
extension-host integration test fundamentally can't reach. The test
covers the failure mode that matters for issue #183: **does dragging the
thumb to the bottom land on the last row?**

## Summary

The bug for huge datasets is in the browser's scrollbar widget, not in
our scroll math. We replace the widget on exactly the cases where the
remap engages, leave everything else untouched, and verify the math via
bun + the integration via a thin test API.
