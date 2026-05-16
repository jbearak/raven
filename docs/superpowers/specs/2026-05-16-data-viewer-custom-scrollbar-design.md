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
on the same condition via CSS. A single derived flag controls both:

```typescript
const useCustomScrollbar = $derived(totalGridHeight > MAX_SCROLL_PX);
```

When `useCustomScrollbar` is `true`:
- A `class="custom-scrollbar"` is applied to the viewport, which hides
  the native vertical scrollbar via `::-webkit-scrollbar:vertical`.
- A new `<CustomScrollbar />` widget is rendered (positioned absolutely
  inside the viewport, top: 0, right: 0, height: 100%, width: 12 px).
- The widget owns pointer-down / move / up handling on the thumb, plus
  pointer-down on the track for paging.

When `useCustomScrollbar` is `false` (the small/moderate-data case),
nothing changes from today: native scrollbar, no overlay, no hidden
class.

Architecture diagram:

```text
viewport (overflow: auto, native scrollbar hidden when above cap)
├── grid (height: cappedScrollHeight + ROW_HEIGHT)
│   ├── header-row (sticky)
│   └── rows (translateY = visualOffsetPx(...))
└── custom-scrollbar (only when totalGridHeight > MAX_SCROLL_PX)
    └── thumb (size + position derived from scroll state)
```

The horizontal native scrollbar is unchanged on every code path.

## Math additions to `grid-model.ts`

Three new pure functions, all unit-testable under Bun:

```typescript
/** Minimum pixel height for the custom scrollbar thumb. Below this the
 *  thumb is hard to click/drag. Chosen so even a 10 M-row dataset gets a
 *  visible, draggable thumb. */
export const MIN_THUMB_PX = 30;

/** Pixel height of the custom scrollbar thumb. The thumb represents the
 *  fraction of the dataset currently visible (visibleCount / nrow), with
 *  a hard minimum so even a single visible row in a 10 M-row dataset
 *  produces a draggable thumb. */
export function customThumbHeight(
    viewportHeight: number,
    rowHeight: number,
    nrow: number,
): number {
    if (nrow <= 0) return viewportHeight;
    const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
    if (visibleCount >= nrow) return viewportHeight;
    const proportional = viewportHeight * (visibleCount / nrow);
    return Math.max(MIN_THUMB_PX, Math.min(viewportHeight, proportional));
}

/** Pixel offset of the thumb's top from the top of the track. The track
 *  height equals the viewport height; the thumb's top can range from 0
 *  to (viewportHeight - thumbHeight). The mapping is linear in the
 *  *physical* scrollTop so the thumb tracks user scrolling exactly. */
export function customThumbTop(
    scrollTop: number,
    viewportHeight: number,
    thumbHeight: number,
    maxPhysical: number,
): number {
    const trackUsable = Math.max(0, viewportHeight - thumbHeight);
    if (maxPhysical <= 0) return 0;
    const fraction = Math.max(0, Math.min(1, scrollTop / maxPhysical));
    return fraction * trackUsable;
}

/** Convert a thumb-top pixel offset (during a drag) back to the physical
 *  scrollTop the viewport needs. Inverse of customThumbTop. The caller
 *  sets viewportEl.scrollTop = result; the existing onScroll →
 *  scheduleFetchVisible pipeline does the rest. */
export function customScrollTopFromThumbTop(
    thumbTop: number,
    viewportHeight: number,
    thumbHeight: number,
    maxPhysical: number,
): number {
    const trackUsable = Math.max(0, viewportHeight - thumbHeight);
    if (trackUsable <= 0) return 0;
    const fraction = Math.max(0, Math.min(1, thumbTop / trackUsable));
    return fraction * maxPhysical;
}
```

`maxPhysical` here is the same `MAX_SCROLL_PX + ROW_HEIGHT - viewportHeight`
the existing code already computes in `logicalScrollTop`. Exposing the
math layer in `grid-model.ts` keeps the thumb computations DOM-free and
unit-testable.

## App.svelte changes

### CSS hide rule (conditional)

Add a class `custom-scrollbar` that, when applied to the viewport, hides
the native vertical scrollbar via Chromium's pseudo-element. The
horizontal scrollbar is **not** hidden. Firefox can't selectively hide
one direction (`scrollbar-width: none` hides both), but VS Code's webview
runs on Chromium so this is moot in practice.

```css
.viewport.custom-scrollbar::-webkit-scrollbar:vertical {
    display: none;
}
```

The class is applied via `class:custom-scrollbar={useCustomScrollbar}`
on the viewport element.

### `<CustomScrollbar />` widget

A new Svelte component file `editors/vscode/src/data-viewer/webview/CustomScrollbar.svelte`.
Rationale for a separate file: the pointer-event logic is self-contained
(track + thumb), and isolating it keeps `App.svelte` focused on grid
rendering. Inputs are read-only props derived from `App.svelte`'s state;
the widget reaches back via a callback to set `viewportEl.scrollTop`.

```text
Props:
- viewportHeight: number
- scrollTop: number
- nrow: number
- rowHeight: number
- maxPhysical: number
- onScrollTo: (newScrollTop: number) => void
```

Internal state:
- `dragOffset: number | null` — pointer Y at drag start, relative to the
  thumb's top. `null` when not dragging.

Visual structure (positioned absolutely inside the viewport, right edge):

```text
<div class="custom-scrollbar">       ← the track; pointer-down → paging
    <div class="custom-thumb">       ← pointer-down → drag
    </div>
</div>
```

Pointer event flow:

- `pointerdown` on `.custom-thumb`: `setPointerCapture`, record
  `dragOffset = clientY - thumbTopAbsolute`.
- `pointermove` (during drag): compute new `thumbTop` = `clientY -
  trackTopAbsolute - dragOffset`, clamp to `[0, viewportHeight -
  thumbHeight]`, call `onScrollTo(customScrollTopFromThumbTop(...))`.
- `pointerup` / `pointercancel`: clear `dragOffset`,
  `releasePointerCapture`.
- `pointerdown` on the track (not on the thumb): page up or down
  depending on whether the click is above or below the current thumb
  position. `onScrollTo(scrollTop ± viewportHeight)`. The browser handles
  the clamp at `[0, maxPhysical]` automatically when the value is set on
  `viewportEl.scrollTop`.

The widget does **not** capture wheel or keyboard events; those continue
to flow through the native scroll mechanism (the vertical scrollbar is
hidden but the viewport is still `overflow: auto` and accepts wheel /
keyboard scroll natively, which fires `onScroll` and updates the thumb
position).

### App.svelte mounting

```svelte
<div class="viewport"
     class:custom-scrollbar={useCustomScrollbar}
     ...>
    <div class="grid">...</div>
    {#if useCustomScrollbar}
        <CustomScrollbar
            viewportHeight={viewportHeight}
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

`maxPhysical` is computed inline rather than in `grid-model.ts` because
it's only used here; the math functions accept it as a parameter so they
stay DOM-free.

## Test surface

A new test-only message lets the integration test drive the drag math
without simulating raw pointer events (which is fragile inside a webview
iframe):

```typescript
| {
    /** Test-only: drive a custom-scrollbar drag-to-fraction (0..1).
     *  The webview computes the resulting physical scrollTop via
     *  customScrollTopFromThumbTop and applies it to viewportEl. This
     *  tests the math + scroll pipeline; the pointer-handler wiring
     *  itself is exercised by the bun unit tests on the math functions
     *  and verified by inspection. */
    type: 'testScrollbarDrag';
    panelGeneration: number;
    fraction: number;   // 0 = top, 1 = bottom
  }
```

The webview's message handler:
- Computes `thumbHeight = customThumbHeight(viewportHeight, ROW_HEIGHT, nrow)`.
- Computes `thumbTop = fraction * (viewportHeight - thumbHeight)`.
- Computes `physical = customScrollTopFromThumbTop(thumbTop, viewportHeight, thumbHeight, maxPhysical)`.
- Sets `viewportEl.scrollTop = physical`.

This routes through the same `onScrollTo` callback the real pointer
handlers use — the math layer is shared.

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

test('customThumbTop: scrollTop=0 → 0')
test('customThumbTop: scrollTop=maxPhysical → viewportHeight - thumbHeight')
test('customThumbTop: midpoint → midpoint')

test('customScrollTopFromThumbTop: thumbTop=0 → 0')
test('customScrollTopFromThumbTop: thumbTop=trackUsable → maxPhysical')
test('customScrollTopFromThumbTop: round-trip with customThumbTop')
```

The round-trip test: for any `scrollTop ∈ [0, maxPhysical]`, the result of
applying `customThumbTop` then `customScrollTopFromThumbTop` should match
the original (within floating-point tolerance). This catches any
asymmetry between the forward and reverse mappings.

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

Same caveat as the prior PR: the `testScrollbarDrag` mechanism shares the
math + scroll-pipeline path with the real pointer handlers but does not
exercise the pointer event wiring itself (pointer-down → drag offset
capture → pointer-move → drag math → pointer-up). Those are simple
event-glue functions; if the math is right (verified by bun) and the
glue is straightforward (verified by inspection), the integration is
right. A regression purely in the pointer-event wiring would slip
through.

## Summary

The bug for huge datasets is in the browser's scrollbar widget, not in
our scroll math. We replace the widget on exactly the cases where the
remap engages, leave everything else untouched, and verify the math via
bun + the integration via a thin test API.
