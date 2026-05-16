# Custom Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken native vertical scrollbar with a custom overlay
on data frames where `totalGridHeight > MAX_SCROLL_PX`, so dragging the
thumb reaches the very last row. Native scrollbar preserved for smaller
frames. Closes the "Known limitation" from the prior issue #183 PR.

**Architecture:** Custom scrollbar widget rendered as a sibling of the
viewport inside a relatively-positioned wrapper (so the overlay stays
fixed in viewport coordinates while the scroll content scrolls). Math
functions in `grid-model.ts` are pure and bun-testable. Pointer event
handling is in a new `CustomScrollbar.svelte` component. Test API drives
synthetic pointer events on the thumb to exercise the real handler
pipeline.

**Tech Stack:** TypeScript + Svelte 5 in the data-viewer webview;
TypeScript + VS Code APIs in the extension host; Bun for unit tests;
Mocha + `@vscode/test-electron` for the integration test.

See `docs/superpowers/specs/2026-05-16-data-viewer-custom-scrollbar-design.md`
for the full design rationale.

---

## File Structure

```text
editors/vscode/src/data-viewer/
├── webview/
│   ├── grid-model.ts                          # MODIFY — 3 new pure
│   │                                          #   functions + 2 constants
│   ├── App.svelte                             # MODIFY — wrapper layout,
│   │                                          #   gate, conditional render,
│   │                                          #   CSS classes
│   ├── CustomScrollbar.svelte                 # NEW — overlay widget with
│   │                                          #   pointer handlers
│   └── styles.css                             # MODIFY — new selectors
├── messages.ts                                # MODIFY — testScrollbarDrag
├── panel.ts                                   # MODIFY — pressKey-style
│                                              #   passthrough for drag
├── manager.ts                                 # MODIFY — passthrough

editors/vscode/src/extension.ts                # MODIFY — RavenExtensionApi
                                               #   adds dragDataViewerScrollbar

editors/vscode/src/test/data-viewer.test.ts    # MODIFY — integration test

tests/bun/data-viewer-grid-model.test.ts       # MODIFY — math unit tests

docs/data-viewer.md                            # MODIFY — note the custom
                                               #   scrollbar on huge frames

docs/superpowers/plans/
└── 2026-05-16-data-viewer-custom-scrollbar.md # THIS PLAN
```

Each file has one responsibility:
- `grid-model.ts` — pure scroll/thumb math.
- `CustomScrollbar.svelte` — overlay widget (rendering + pointer events).
- `App.svelte` — viewport, wrapper, gate, conditional rendering.
- `styles.css` — declarative styling.
- `messages.ts` — wire types only.
- `panel.ts` / `manager.ts` / `extension.ts` — extension-host plumbing.
- Tests + docs.

---

## Task 1: Bun unit tests for the new scrollbar math (RED)

**Files:**
- Modify: `tests/bun/data-viewer-grid-model.test.ts`

This task and Task 2 are a TDD pair.

- [ ] **Step 1: Add the imports the new tests need**

At the top of `tests/bun/data-viewer-grid-model.test.ts`, extend the
existing import:

```typescript
import {
    visibleRange,
    coalesceScroll,
    MAX_SCROLL_PX,
    cappedScrollHeight,
    logicalScrollTop,
    visualOffsetPx,
    MIN_THUMB_PX,
    HORIZONTAL_GUTTER_PX,
    customThumbHeight,
    customThumbTop,
    customScrollTopFromThumbTop,
} from '../../editors/vscode/src/data-viewer/webview/grid-model';
```

The tests will fail to load until Task 2 adds these exports — that's
expected RED for an import-level failure.

- [ ] **Step 2: Append a new describe block at the end of the file**

After the existing top-level describe blocks, add:

```typescript
describe('custom scrollbar math', () => {
    const VH = 600;
    const RH = 24;
    const TRACK = VH - HORIZONTAL_GUTTER_PX;  // 588

    test('customThumbHeight: tiny dataset → full track', () => {
        // 5 rows fit in the track many times over → thumb fills track.
        expect(customThumbHeight(TRACK, RH, 5)).toBe(TRACK);
    });
    test('customThumbHeight: large dataset → MIN_THUMB_PX floor', () => {
        // 10M rows on 600 px viewport: proportional thumb = TRACK *
        // visibleCount/nrow ≈ TRACK * 25/10_000_000 ≈ 0.0015 px.
        // Clamped up to MIN_THUMB_PX.
        expect(customThumbHeight(TRACK, RH, 10_000_000)).toBe(MIN_THUMB_PX);
    });
    test('customThumbHeight: mid-size proportional', () => {
        // 100 rows: visibleCount = ceil(588/24) = 25.
        // proportional = 588 * (25/100) = 147. Above MIN_THUMB.
        expect(customThumbHeight(TRACK, RH, 100)).toBeCloseTo(147);
    });
    test('customThumbHeight: nrow === 0 → full track', () => {
        expect(customThumbHeight(TRACK, RH, 0)).toBe(TRACK);
    });
    test('customThumbHeight: rowHeight === 0 → full track', () => {
        expect(customThumbHeight(TRACK, 0, 1000)).toBe(TRACK);
    });
    test('customThumbHeight: trackHeight === 0 → 0', () => {
        expect(customThumbHeight(0, RH, 1000)).toBe(0);
    });
    test('customThumbHeight: trackHeight < MIN_THUMB_PX → trackHeight', () => {
        // 20-px track gets a 20-px thumb, not a 30-px overflowing one.
        expect(customThumbHeight(20, RH, 10_000_000)).toBe(20);
    });

    test('customThumbTop: scrollTop=0 → 0', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        expect(customThumbTop(0, TRACK, th, 14_999_424)).toBe(0);
    });
    test('customThumbTop: scrollTop=maxPhysical → trackHeight - thumbHeight', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        const maxPhysical = 14_999_424;
        expect(customThumbTop(maxPhysical, TRACK, th, maxPhysical))
            .toBeCloseTo(TRACK - th);
    });
    test('customThumbTop: midpoint → midpoint', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        const maxPhysical = 14_999_424;
        expect(customThumbTop(maxPhysical / 2, TRACK, th, maxPhysical))
            .toBeCloseTo((TRACK - th) / 2);
    });
    test('customThumbTop: maxPhysical <= 0 → 0', () => {
        expect(customThumbTop(100, TRACK, MIN_THUMB_PX, 0)).toBe(0);
        expect(customThumbTop(100, TRACK, MIN_THUMB_PX, -10)).toBe(0);
    });
    test('customThumbTop: thumbHeight >= trackHeight → 0', () => {
        // Whole track is thumb; nothing to scroll.
        expect(customThumbTop(100, TRACK, TRACK, 14_999_424)).toBe(0);
    });

    test('customScrollTopFromThumbTop: thumbTop=0 → 0', () => {
        expect(customScrollTopFromThumbTop(0, TRACK, MIN_THUMB_PX, 14_999_424))
            .toBe(0);
    });
    test('customScrollTopFromThumbTop: thumbTop=trackUsable → maxPhysical', () => {
        const th = MIN_THUMB_PX;
        const maxPhysical = 14_999_424;
        expect(customScrollTopFromThumbTop(TRACK - th, TRACK, th, maxPhysical))
            .toBeCloseTo(maxPhysical);
    });
    test('customScrollTopFromThumbTop: round-trip with customThumbTop', () => {
        const th = customThumbHeight(TRACK, RH, 10_000_000);
        const maxPhysical = 14_999_424;
        for (const scrollTop of [0, 1234, maxPhysical / 3, maxPhysical / 2,
                                 maxPhysical * 0.99, maxPhysical]) {
            const top = customThumbTop(scrollTop, TRACK, th, maxPhysical);
            const back = customScrollTopFromThumbTop(top, TRACK, th, maxPhysical);
            expect(back).toBeCloseTo(scrollTop);
        }
    });
    test('customScrollTopFromThumbTop: maxPhysical <= 0 → 0', () => {
        expect(customScrollTopFromThumbTop(100, TRACK, MIN_THUMB_PX, 0)).toBe(0);
    });
    test('customScrollTopFromThumbTop: trackUsable <= 0 → 0', () => {
        expect(customScrollTopFromThumbTop(100, TRACK, TRACK, 14_999_424)).toBe(0);
    });
});
```

- [ ] **Step 3: Run the bun tests to verify the new ones fail**

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: bun fails to LOAD the test file (the new symbols don't exist
yet). The error message should be like `MIN_THUMB_PX is not exported`
or similar. That's the RED state — Task 2 will add the exports and run
the tests for real.

---

## Task 2: Implement scrollbar math in `grid-model.ts` (GREEN)

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/grid-model.ts`

- [ ] **Step 1: Add the constants and three functions**

At the bottom of `editors/vscode/src/data-viewer/webview/grid-model.ts`,
**after** the existing `coalesceScroll` function, append:

```typescript

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
```

- [ ] **Step 2: Run bun tests, expect 100% pass**

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: all tests PASS, including the 17 new ones from Task 1 plus
the existing 44.

- [ ] **Step 3: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/grid-model.ts \
        tests/bun/data-viewer-grid-model.test.ts
git commit -m "feat(data-viewer): add custom-scrollbar math (#183)

Adds MIN_THUMB_PX, HORIZONTAL_GUTTER_PX, customThumbHeight,
customThumbTop, customScrollTopFromThumbTop. All pure functions, all
unit-tested under Bun. Math layer for the upcoming custom scrollbar
overlay; no behavior change yet."
```

---

## Task 3: Create the `CustomScrollbar.svelte` component

**Files:**
- Create: `editors/vscode/src/data-viewer/webview/CustomScrollbar.svelte`

- [ ] **Step 1: Create the file with the full component**

```svelte
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
    let thumbEl: HTMLDivElement | null = $state(null);

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
        dragOffset = e.clientY - (trackEl.getBoundingClientRect().top + thumbTop);
        dragTrackTop = trackEl.getBoundingClientRect().top;
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
        bind:this={thumbEl}
        data-test-id="custom-scrollbar-thumb"
        style="top: {thumbTop}px; height: {thumbHeight}px;"
        onpointerdown={onThumbPointerDown}
        onpointermove={onThumbPointerMove}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onlostpointercapture={endDrag}
    ></div>
</div>
```

- [ ] **Step 2: Verify the component file is syntactically valid**

```bash
cd editors/vscode && bun run typecheck
```

Expected: typecheck PASSES (the component file compiles in isolation;
it's not yet imported by App.svelte so its type errors won't show up
yet, but the underlying TS in the script block does type-check).

- [ ] **Step 3: Verify the bundle builds**

```bash
cd editors/vscode && bun run bundle
```

Expected: PASS. esbuild-svelte processes the new file even though
nothing imports it yet.

---

## Task 4: Update `styles.css` with scrollbar selectors

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/styles.css`

- [ ] **Step 1: Append the new selectors at the end of the file**

```css

/* ---------- Custom scrollbar (issue #183) ----------
 * Engaged only when totalGridHeight > MAX_SCROLL_PX, via the
 * `using-custom-scrollbar` class on `.viewport`. Below the cap we leave
 * the native scrollbar alone. */

.viewport-wrapper {
    /* Wraps the viewport so the custom scrollbar overlay (sibling, not
     * descendant) is laid out in the wrapper's coordinate space rather
     * than the viewport's scroll-content coordinate space. min-height:
     * 0 + min-width: 0 are required so flex shrink-to-fit allows the
     * inner viewport to scroll its own content rather than growing the
     * wrapper to the inner grid's intrinsic height. */
    position: relative;
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
    min-width: 0;
}
.viewport-wrapper > .viewport {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
}

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
     * trackHeight = viewportHeight - 12 to match (see grid-model.ts). */
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

---

## Task 5: Update `App.svelte` — wrapper layout, gate, conditional render

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/App.svelte`

- [ ] **Step 1: Extend the imports**

Locate the existing import (around line 11):

```typescript
import {
    visibleRange, coalesceScroll,
    cappedScrollHeight, logicalScrollTop, visualOffsetPx,
} from './grid-model';
```

Replace with:

```typescript
import {
    visibleRange, coalesceScroll,
    cappedScrollHeight, logicalScrollTop, visualOffsetPx,
    MAX_SCROLL_PX, HORIZONTAL_GUTTER_PX,
} from './grid-model';
import CustomScrollbar from './CustomScrollbar.svelte';
```

- [ ] **Step 2: Add the `useCustomScrollbar` derived flag**

Locate the existing `const totalGridHeight = $derived(...)` line (around
line 100). Add **immediately below** it:

```typescript
const totalGridHeight = $derived(nrow * ROW_HEIGHT);
const useCustomScrollbar = $derived(totalGridHeight > MAX_SCROLL_PX);
```

- [ ] **Step 3: Wrap the viewport with `.viewport-wrapper` and conditionally render the scrollbar**

Locate the `<div class="viewport"` (around line 857). Wrap it with a
new `<div class="viewport-wrapper">` and conditionally render
`<CustomScrollbar />` as a sibling. The existing viewport's class list
also gains `class:using-custom-scrollbar={useCustomScrollbar}`.

Find:

```svelte
    <div class="viewport"
         role="grid"
         aria-rowcount={nrow}
         bind:this={viewportEl}
         onscroll={onScroll}
         tabindex="0">
        <div class="grid" style="height: {cappedScrollHeight(totalGridHeight) + ROW_HEIGHT}px;">
```

Replace with:

```svelte
    <div class="viewport-wrapper">
        <div class="viewport"
             class:using-custom-scrollbar={useCustomScrollbar}
             role="grid"
             aria-rowcount={nrow}
             bind:this={viewportEl}
             onscroll={onScroll}
             tabindex="0">
            <div class="grid" style="height: {cappedScrollHeight(totalGridHeight) + ROW_HEIGHT}px;">
```

Then locate the matching closing `</div>` for the existing viewport
(it's the one that closes after the grid's contents — search for
`</div>\n    </div>` near the bottom of the template). Add the
conditional scrollbar render and a closing wrapper `</div>`. The full
closing pattern becomes:

```svelte
        </div>  <!-- /.grid -->
    </div>  <!-- /.viewport -->
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
</div>  <!-- /.viewport-wrapper -->
```

Visually verify the resulting tree: `.data-viewer > .viewport-wrapper >
.viewport > .grid` plus the optional `<CustomScrollbar />` sibling of
`.viewport`. The `{#if contextMenu}` block (which was already a sibling
of `.viewport`) stays a sibling of `.viewport-wrapper` — i.e. don't
move it inside the wrapper.

- [ ] **Step 4: Verify typecheck and bundle**

```bash
cd editors/vscode && bun run typecheck && bun run bundle
```

Expected: both PASS.

- [ ] **Step 5: Commit Tasks 3-5**

```bash
git add editors/vscode/src/data-viewer/webview/CustomScrollbar.svelte \
        editors/vscode/src/data-viewer/webview/App.svelte \
        editors/vscode/src/data-viewer/webview/styles.css
git commit -m "feat(data-viewer): custom scrollbar overlay for huge frames (#183)

Renders an overlay scrollbar on the right edge of the viewport when
totalGridHeight > MAX_SCROLL_PX. Native vertical scrollbar is hidden
in that regime; below the cap, native scrollbar is unchanged.

The overlay is a sibling of the viewport (not a descendant) so it
stays fixed in viewport coordinates while the scroll content scrolls.
Pointer-down/move/up handlers manage the drag with setPointerCapture
wrapped in try/catch (synthetic test events may not be eligible for
capture). Track-click pages by trackHeight in the click direction.

Math is in grid-model.ts. CustomScrollbar.svelte handles the pointer
events. App.svelte wires the gate."
```

---

## Task 6: Extend `messages.ts` protocol

**Files:**
- Modify: `editors/vscode/src/data-viewer/messages.ts`

- [ ] **Step 1: Add the `testScrollbarDrag` ExtensionToWebview variant**

Locate the existing `testKey` variant (added in the prior PR, near the
end of the `ExtensionToWebview` union). Append a new variant
**immediately after** `testKey`:

```typescript
    | {
        /** Test-only: drive a custom-scrollbar drag-to-fraction (0..1)
         *  by dispatching synthetic pointerdown/move/up events on the
         *  thumb element. fraction=0 jumps to top, fraction=1 jumps to
         *  bottom. The webview computes the target thumbTop, then fires
         *  the events to exercise the real pointer handlers (drag
         *  offset capture, drag math, cleanup).
         *
         *  Production code paths never post this message; the webview
         *  can only receive messages from its own extension host, so
         *  exposing it does not introduce an external attack surface. */
        type: 'testScrollbarDrag';
        panelGeneration: number;
        fraction: number;
    };
```

The trailing semicolon ends the union. Make sure the prior variant's
trailing `;` becomes a `|` (the same diff pattern the prior PR used for
adding `testKey`).

- [ ] **Step 2: Verify typecheck**

```bash
cd editors/vscode && bun run typecheck
```

Expected: PASS. (No consumers of the new variant yet; that's Task 7+.)

---

## Task 7: panel.ts + manager.ts + extension.ts: drag passthrough

**Files:**
- Modify: `editors/vscode/src/data-viewer/panel.ts`
- Modify: `editors/vscode/src/data-viewer/manager.ts`
- Modify: `editors/vscode/src/extension.ts`

- [ ] **Step 1: Add `dragScrollbar` method to `DataViewerPanel`**

Open `panel.ts`. Locate the existing `pressKey` method (added in the
prior PR). Add a new method **immediately after** it:

```typescript
    /** Test-only: post a `testScrollbarDrag` message to the webview so
     *  it dispatches synthetic pointer events on the thumb element.
     *  fraction=0 jumps to top, fraction=1 jumps to bottom. Awaiting
     *  waits for the message to be queued, not for any reply; tests
     *  should poll `getVisibleRange()` to observe the result. */
    async dragScrollbar(fraction: number): Promise<void> {
        if (this.disposed) return;
        const msg: ExtensionToWebview = {
            type: 'testScrollbarDrag',
            panelGeneration: this.generation,
            fraction,
        };
        await this.webviewPanel.webview.postMessage(msg);
    }
```

- [ ] **Step 2: Add `dragScrollbarOnPanel` passthrough to `DataViewerManager`**

Open `manager.ts`. Locate the existing `pressKeyOnPanel` method. Add
**immediately after** it:

```typescript
    /** Test-only: drive a custom-scrollbar drag in the named panel.
     *  fraction=0 jumps to top, fraction=1 jumps to bottom. Awaiting
     *  waits for message queuing; tests should poll
     *  `getPanelVisibleRange()` to observe results. */
    async dragScrollbarOnPanel(panelName: string, fraction: number): Promise<void> {
        await this.panels.get(panelName)?.dragScrollbar(fraction);
    }
```

- [ ] **Step 3: Add `dragDataViewerScrollbar` to `RavenExtensionApi`**

Open `extension.ts`. Locate the existing `pressDataViewerKey` declaration
in the `RavenExtensionApi` interface. Add **immediately after** it:

```typescript
    /** Test-only: drive a custom-scrollbar drag in a data viewer panel.
     *  fraction=0 jumps to top, fraction=1 jumps to bottom. Used by
     *  integration tests to exercise the drag math + scroll pipeline.
     *  Awaiting waits for the message to be queued; poll
     *  getDataViewerPanelVisibleRange to observe the result. */
    dragDataViewerScrollbar(panelName: string, fraction: number): Promise<void>;
```

Then locate the `return { ... }` block at the bottom of `activate()` (you
added entries here in the prior PR). Add the implementation
**immediately after** `pressDataViewerKey`:

```typescript
        pressDataViewerKey: async (panelName: string, key: string) => {
            await data_viewer_manager?.pressKeyOnPanel(panelName, key);
        },
        dragDataViewerScrollbar: async (panelName: string, fraction: number) => {
            await data_viewer_manager?.dragScrollbarOnPanel(panelName, fraction);
        },
```

- [ ] **Step 4: Add the `testScrollbarDrag` handler in `App.svelte`**

Open `App.svelte`. Locate the existing `case 'testKey':` branch (added
in the prior PR). Add a new case **immediately after** the `return;` for
`testKey`:

```typescript
                case 'testScrollbarDrag': {
                    // Test-only: dispatch synthetic pointerdown/move/up
                    // events on the thumb element so the same drag
                    // handlers a real user pointer would invoke run
                    // end-to-end. pointerId 999 avoids colliding with
                    // any real mouse pointer (Chromium primary mouse is
                    // pointerId 1).
                    const thumb = document.querySelector('[data-test-id="custom-scrollbar-thumb"]');
                    if (!(thumb instanceof HTMLElement)) return;
                    const trackHeight = Math.max(0, viewportHeight - HORIZONTAL_GUTTER_PX);
                    const thumbHeightPx = thumb.getBoundingClientRect().height;
                    const trackRect = (thumb.parentElement as HTMLElement).getBoundingClientRect();
                    const thumbRect = thumb.getBoundingClientRect();
                    // Current thumb center.
                    const startX = thumbRect.left + thumbRect.width / 2;
                    const startY = thumbRect.top + thumbRect.height / 2;
                    // Target thumb-top, then target Y for the pointer.
                    const targetThumbTop = m.fraction * Math.max(0, trackHeight - thumbHeightPx);
                    const targetY = trackRect.top + targetThumbTop + thumbHeightPx / 2;
                    const opts = {
                        pointerId: 999,
                        pointerType: 'mouse',
                        bubbles: true,
                        cancelable: true,
                    } as const;
                    thumb.dispatchEvent(new PointerEvent('pointerdown', {
                        ...opts, clientX: startX, clientY: startY, button: 0,
                    }));
                    thumb.dispatchEvent(new PointerEvent('pointermove', {
                        ...opts, clientX: startX, clientY: targetY, button: 0,
                    }));
                    thumb.dispatchEvent(new PointerEvent('pointerup', {
                        ...opts, clientX: startX, clientY: targetY, button: 0,
                    }));
                    return;
                }
```

`HORIZONTAL_GUTTER_PX` is already imported by Task 5; if not, add it
to the existing `from './grid-model'` import.

- [ ] **Step 5: Verify typecheck and bundle**

```bash
cd editors/vscode && bun run typecheck && bun run bundle
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/data-viewer/messages.ts \
        editors/vscode/src/data-viewer/panel.ts \
        editors/vscode/src/data-viewer/manager.ts \
        editors/vscode/src/extension.ts \
        editors/vscode/src/data-viewer/webview/App.svelte
git commit -m "feat(data-viewer): test-only scrollbar drag protocol (#183)

Adds testScrollbarDrag ExtensionToWebview variant + DataViewerPanel
dragScrollbar + DataViewerManager dragScrollbarOnPanel +
RavenExtensionApi dragDataViewerScrollbar. The webview's handler
dispatches synthetic pointerdown/move/up events on the thumb so the
real CustomScrollbar pointer handlers run end-to-end.

No user-visible behavior change."
```

---

## Task 8: Mocha integration test

**Files:**
- Modify: `editors/vscode/src/test/data-viewer.test.ts`

- [ ] **Step 1: Add the new test at the end of the suite**

Locate the existing `End key reaches the last row...` test (added in the
prior PR). Add **immediately after** it:

```typescript
    test('Drag scrollbar to bottom reaches last row in 700K-row data frame',
        async function () {
            this.timeout(240000);
            const N = 700_000;

            // Reuse the panel from the End-key test if still open;
            // otherwise the prior test created and left it in place.
            // pollForPanel returns immediately if it already exists.
            if (!api.getDataViewerPanelNames().includes('big')) {
                await api.sendToRTerminal(
                    `big <- as.data.frame(matrix(rnorm(${N} * 5), `
                    + `nrow = ${N}, ncol = 5)); View(big)`,
                );
                const appeared = await pollForPanel(api, 'big', 90000);
                assert.ok(appeared, 'panel "big" did not appear within 90 s');
            }

            // Reset to top, wait for steady state.
            await api.pressDataViewerKey('big', 'Home');
            const topRange = await pollFor(() => {
                const r = api.getDataViewerPanelVisibleRange('big');
                return r && r.end > 0 && r.end < N / 2 ? r : undefined;
            }, 60000);
            assert.ok(topRange,
                `pre-drag Home reset did not land at the top within 60 s; `
                + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);

            // Drag the scrollbar thumb to the bottom.
            await api.dragDataViewerScrollbar('big', 1.0);

            const bottomRange = await pollFor(() => {
                const r = api.getDataViewerPanelVisibleRange('big');
                return r && r.end === N ? r : undefined;
            }, 60000);
            assert.ok(bottomRange,
                `Drag-to-bottom did not reach the last row within 60 s; `
                + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);
        });

    test('Drag scrollbar to 50% lands near row N/2 in 700K-row data frame',
        async function () {
            this.timeout(240000);
            const N = 700_000;

            if (!api.getDataViewerPanelNames().includes('big')) {
                await api.sendToRTerminal(
                    `big <- as.data.frame(matrix(rnorm(${N} * 5), `
                    + `nrow = ${N}, ncol = 5)); View(big)`,
                );
                const appeared = await pollForPanel(api, 'big', 90000);
                assert.ok(appeared, 'panel "big" did not appear within 90 s');
            }

            await api.pressDataViewerKey('big', 'Home');
            const topRange = await pollFor(() => {
                const r = api.getDataViewerPanelVisibleRange('big');
                return r && r.end > 0 && r.end < N / 2 ? r : undefined;
            }, 60000);
            assert.ok(topRange);

            await api.dragDataViewerScrollbar('big', 0.5);

            const midRange = await pollFor(() => {
                const r = api.getDataViewerPanelVisibleRange('big');
                if (!r) return undefined;
                // Allow a generous 10% band around N/2 — the exact value
                // depends on thumb-height / track-usable arithmetic.
                return r.start >= 0.40 * N && r.start <= 0.60 * N ? r : undefined;
            }, 60000);
            assert.ok(midRange,
                `Drag-to-50% did not land near N/2 within 60 s; `
                + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);
        });
```

- [ ] **Step 2: Run the data-viewer mocha suite**

```bash
cd editors/vscode && bun run pretest && bun run test --grep "data-viewer smoke"
```

Expected: all 6 data-viewer tests pass (4 prior + 2 new). The drag tests
typically complete in 1-2 s once R + Arrow are warm.

If R isn't installed locally, the suite skips entirely. Verify by
inspection that the test file compiles via `bun run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add editors/vscode/src/test/data-viewer.test.ts
git commit -m "test(data-viewer): drag-scrollbar integration tests (#183)

Two new tests on a 700K-row frame: drag-to-bottom reaches the last
row, and drag-to-50% lands near row N/2. Both reuse the 'big' panel
from the End-key test if still open, or create it. Each test gets
its own 240s timeout (per-test) to handle R startup + matrix rnorm
+ Arrow write under suite load."
```

---

## Task 9: Update `docs/data-viewer.md`

**Files:**
- Modify: `docs/data-viewer.md`

- [ ] **Step 1: Append a sentence to the existing keyboard-shortcuts section**

Open `docs/data-viewer.md`. Locate the existing "Keyboard shortcuts"
subsection (added in the prior PR). The paragraph after the shortcuts
table currently mentions `End` jumps to the last row. **Append** at the
end of that paragraph:

```markdown
On data frames with more than ~625 K rows, Raven also replaces the
native vertical scrollbar with an overlay so dragging the scrollbar
thumb to the bottom reaches the last row. The native scrollbar is
preserved on smaller frames.
```

- [ ] **Step 2: Commit**

```bash
git add docs/data-viewer.md
git commit -m "docs(data-viewer): note custom scrollbar on huge frames (#183)"
```

---

## Task 10: Final verification

**Files:** none

- [ ] **Step 1: Run the full bun test suite**

```bash
bun test
```

Expected: all bun tests PASS.

- [ ] **Step 2: Run the full VS Code mocha suite**

```bash
cd editors/vscode && bun run pretest && bun run test
```

Expected: all data-viewer tests PASS. Other suites should be unchanged.

- [ ] **Step 3: Typecheck + bundle + cargo**

```bash
cd editors/vscode && bun run typecheck && bun run bundle
cd ../.. && cargo build -p raven
```

Expected: all PASS.

- [ ] **Step 4: Inspect git log**

```bash
git log --oneline -15
```

Expected: a clean sequence of (~7) commits, each scoped to one logical
change, all referencing #183.
