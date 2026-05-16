# Data Viewer: Scroll to Last Row (issue #183)

Date: 2026-05-16
Status: Draft for review
Issue: [#183](https://github.com/jbearak/raven/issues/183) — "Data viewer:
can't scroll to the very last row in large datasets"

## Problem

In a large data frame (issue example: 10 M rows × 50 cols), the user cannot
reach the very last row by any of the available means:

- Dragging the scrollbar pill to the bottom stops short of the last row.
- Holding `ArrowDown` stops short.
- On macOS, an inertia-scroll overshoot briefly reveals the last row but the
  grid blanks during the rubber-band bounce ("row 10,000,000 flickers and
  disappears").

Two distinct root causes from the issue:

1. **Scrollbar thumb compression.** The scroll container is capped at
   `MAX_SCROLL_PX = 15_000_000` to stay below Chrome/Electron's `2^24` pixel
   limit. For a 600 px viewport, the calculated thumb height is
   `600² / 15_000_024 ≈ 0.024 px`. The browser enforces a ~17 px minimum, so
   the bottom of the drag track maps to a `scrollTop` below `maxPhysical` and
   the last rows are never reached by dragging.
2. **Elastic-scroll overshoot.** macOS rubber-band can briefly push
   `scrollTop > maxPhysical`. Because `logicalScrollTop` is unclamped, the
   scaled value exceeds `maxLogical`; `visibleRange` then returns
   `end < start` and the grid blanks until the scroll bounces back.

PRs ea84482 and 69bdd3c fixed the math at the bottom of the remap so that
*if* a `scrollTop` of `maxPhysical` is reached, `visibleRange.end === nrow`.
What's left is making it possible to *reach* `maxPhysical` deterministically,
and stopping the overshoot from blanking the grid.

## Goals / Non-Goals

Goals:

1. Provide a deterministic way for the user to reach the very last row of any
   data frame, regardless of dataset size or scrollbar widget quirks.
2. Stop the elastic-scroll bounce from blanking the grid on macOS.
3. Cover both fixes with automated tests:
   - A mocha integration test that opens a large data frame in a real R
     session, drives `End`, and asserts the last row enters the visible
     range.
   - Bun unit tests for the new clamp behavior.

Non-goals for this change:

- A custom overlay scrollbar that bypasses the native widget. (See "Known
  limitations" — the native-drag-to-bottom symptom from the issue is
  *partially* unresolved by this change. End-key support fully addresses
  the keyboard / programmatic case; dragging the scrollbar pill is a
  separate fix that lives outside this PR.)
- Sort/filter/search semantics. Unrelated.
- Adjusting `MAX_SCROLL_PX`. The issue notes this trades resolution for thumb
  size with non-trivial side effects — out of scope until a custom scrollbar
  is on the table.
- Cmd-arrow / Cmd-End spreadsheet conventions. Plain `End` already covers the
  "reach the last row" use case; spreadsheet shortcuts are a follow-up.

## Architecture

Two production-code changes plus an extension to the existing webview ↔
extension postMessage protocol so the mocha test can drive a key event and
read back the visible row range. No new processes, no new caches, no new
threads.

```text
mocha test (extension host)               webview (App.svelte)
─────────────────────────────             ───────────────────────────────
api.pressDataViewerKey('big','End')  →    msg handler dispatches synthetic
                                          KeyboardEvent on window
                                          → onKeyDown('End')
                                          → viewportEl.scrollTop =
                                              scrollHeight - clientHeight
                                              (≈ maxPhysical; clamp in
                                              logicalScrollTop absorbs
                                              any rounding mismatch)
                                          → onScroll → scheduleFetchVisible
                                          → getRows
                                          ← rows
                                          → applyRows updates
                                            visibleRangeStart
                                          → postLifecycle('rows', {
                                              visibleRangeStart,
                                              visibleRangeEnd,
                                            })

DataViewerPanel caches latest      ←      lifecycle event
{start, end}
api.getDataViewerPanelVisibleRange  →     poll until end === nrow
```

## Production fixes

### 1. Keyboard shortcuts in `App.svelte`

Add Home / End / PageUp / PageDown branches to `onKeyDown`, **before** the
existing Cmd-A / Cmd-C branches. Each branch fires only when no modifier is
pressed (`!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey`) so platform
shortcuts like `Shift-End` (extend selection in spreadsheets) and
`Cmd-Shift-End` (jump-and-extend) don't get hijacked into a plain "scroll to
last row" — those combinations fall through unchanged for the browser/OS to
handle. Selection-extension while scrolling is intentionally **not** wired
in this PR (see non-goals); a future PR can add it by widening the
key-handler branches and integrating with the existing `Selection` model:

- `End` → `viewportEl.scrollTop = viewportEl.scrollHeight - viewportEl.clientHeight`
- `Home` → `viewportEl.scrollTop = 0`
- `PageDown` → `viewportEl.scrollTop += viewportEl.clientHeight`
- `PageUp` → `viewportEl.scrollTop -= viewportEl.clientHeight`

Each branch calls `e.preventDefault()` so the browser's default page-scroll
behavior doesn't double-fire on a focused scrollable element. Each branch
guards on `viewportEl !== null` (it's bound asynchronously after the first
render).

The existing `onScroll` handler does the rest — we don't bypass
`scheduleFetchVisible` or call `visibleRange` directly. The inner `.grid` div
is height-capped at `MAX_SCROLL_PX + ROW_HEIGHT`, so
`scrollHeight - clientHeight` lands at or near the model's `maxPhysical`. The
two values can differ slightly under sub-pixel layout rounding or when a
horizontal scrollbar reduces `clientHeight`; the new `logicalScrollTop` clamp
(below) absorbs the difference so `visibleRange.end` still resolves to
`nrow`.

A doc comment on the new branches notes that `scrollHeight - clientHeight`
is the canonical browser-clamped maximum and works regardless of the
container's content height; the clamp in `logicalScrollTop` makes the math
robust to any DOM-vs-model rounding mismatch.

### 2. Clamp `logicalScrollTop` in `grid-model.ts`

Both branches of `logicalScrollTop` get a clamp. The current implementation:

```typescript
if (totalGridHeight <= MAX_SCROLL_PX) return scrollTop;
const maxPhysical = MAX_SCROLL_PX + rowHeight - viewportHeight;
if (maxPhysical <= 0) return 0;
const maxLogical = totalGridHeight + rowHeight - viewportHeight;
return (scrollTop / maxPhysical) * maxLogical;
```

becomes:

```typescript
const maxLogicalSmall = Math.max(0, totalGridHeight + rowHeight - viewportHeight);
if (totalGridHeight <= MAX_SCROLL_PX) {
    return Math.max(0, Math.min(maxLogicalSmall, scrollTop));
}
const maxPhysical = MAX_SCROLL_PX + rowHeight - viewportHeight;
if (maxPhysical <= 0) return 0;
const maxLogical = totalGridHeight + rowHeight - viewportHeight;
const scaled = (scrollTop / maxPhysical) * maxLogical;
return Math.max(0, Math.min(maxLogical, scaled));
```

Without a clamp on the large path, a macOS rubber-band overshoot
(`scrollTop > maxPhysical`) maps to `logical > maxLogical`. `visibleRange`
then computes `start = floor(logical / rowHeight) - overscan`, which may
exceed `nrow`, and the resulting range is empty. With the clamp, `logical`
saturates at `maxLogical`, `visibleRange.end` stays at `nrow`, and the
bottom row keeps rendering through the bounce.

Clamping the small-data fast path is defensive: Chromium shouldn't report
`scrollTop < 0` or `scrollTop > totalGridHeight - viewportHeight` in normal
flow, but rubber-band overshoot has been observed to do so under macOS
elastic scroll, and the cost of the clamp is two `Math.min/max` calls.

The function's existing doc comment is extended with a note explaining the
clamp's purpose.

## Test surface

A small extension to the postMessage protocol so the mocha test can:

1. Drive a key event that flows through the real `onKeyDown` handler.
2. Observe the resulting visible-row range.

Both are gated to the test API; production code paths never post `testKey`,
and `getDataViewerPanelVisibleRange` is only called from the test harness.
Because the webview can only receive messages from its own extension host,
exposing `testKey` does not introduce an external attack surface.

### `messages.ts`

Extend the `lifecycle` `WebviewToExtension` variant:

```typescript
| {
    type: 'lifecycle';
    event: string;
    panelGeneration: number;
    nrow: number;
    columns: number;
    visibleRows: number;
    visibleRangeStart: number;   // NEW
    visibleRangeEnd: number;     // NEW
    timestamp: number;
  }
```

`App.svelte`'s `postLifecycle` already has both numbers in scope
(`visibleRangeStart` is `$state`; `visibleRangeEnd` is
`visibleRangeStart + visibleRows.length`). The change is wire-format
compatible with rolling reloads because consumers ignore unknown fields.

Add a new `ExtensionToWebview` variant for test-driven key events (the
extension posts it to the webview, which then dispatches a synthetic
keyboard event on `window`):

```typescript
| {
    type: 'testKey';
    panelGeneration: number;
    key: string;
  }
```

A doc comment marks it test-only.

### `App.svelte`

Add a message-handler branch for `testKey` that dispatches a synthetic
`KeyboardEvent` on `window`:

```typescript
case 'testKey':
    window.dispatchEvent(new KeyboardEvent('keydown', {
        key: m.key, code: m.key, bubbles: true, cancelable: true,
    }));
    return;
```

This routes through the real `<svelte:window onkeydown={onKeyDown}>` binding,
exercising the same code path a user keypress would.

`postLifecycle(event)` is updated to include `visibleRangeStart` and
`visibleRangeEnd: visibleRangeStart + visibleRows.length`.

`scheduleFetchVisible` currently posts a lifecycle event from `applyRows`
but **not** from its own cache-hit fast path (where rows come from
`rowCache.get`). Without a fix, an `End` keypress that lands on a
pre-cached window — e.g., re-pressing `End` after a brief scroll-up — would
update `visibleRangeStart` in the webview but never tell the host, leaving
the polling test stuck on a stale range. Add `postLifecycle('cache-hit')`
to the cache-hit branch so every change to `visibleRangeStart` is
observable from the host. The same call goes in the empty-range branch so
the host sees a `{start, end}` even when the visible window is empty (e.g.,
`nrow === 0`).

### `panel.ts`

`DataViewerPanel` gains:

- A private `lastVisibleRange: { start: number; end: number } | undefined`,
  updated from each lifecycle event whose `panelGeneration` matches the
  current generation.
- `getVisibleRange(): { start: number; end: number } | undefined`.
- `async pressKey(key: string): Promise<void>` — posts a `testKey` message
  carrying the current generation. Awaiting it waits for the message to be
  queued, not for a reply; the test polls `getVisibleRange` after.

The lifecycle handler in `handleInner` (which today only traces the event)
extends to also update `lastVisibleRange`. Because `panel.ts` is the
extension-side trust boundary for messages from the webview, the handler
narrows defensively: it only writes `lastVisibleRange` when both
`m.visibleRangeStart` and `m.visibleRangeEnd` are finite numbers, leaving
the previous value (or `undefined`) otherwise. `lastVisibleRange` is
cleared on `replace()` so a stale range from the previous dataset is never
returned for the new one.

### `manager.ts`

Add passthroughs:

```typescript
getPanelVisibleRange(panelName: string): { start: number; end: number } | undefined {
    return this.panels.get(panelName)?.getVisibleRange();
}
async pressKeyOnPanel(panelName: string, key: string): Promise<void> {
    await this.panels.get(panelName)?.pressKey(key);
}
```

### `extension.ts`

Two new methods on `RavenExtensionApi`, doc-commented `Used by integration
tests` like the existing `getDataViewerPanelNames` /
`getDataViewerPanelColumnNames`:

```typescript
getDataViewerPanelVisibleRange(panelName: string):
    { start: number; end: number } | undefined;
pressDataViewerKey(panelName: string, key: string): Promise<void>;
```

Each delegates to the manager.

## Tests

### Mocha integration test

Add one test to `editors/vscode/src/test/data-viewer.test.ts`:

```text
test('End key reaches the last row in a 700K-row data frame', async () => {
    const N = 700_000;
    await api.sendToRTerminal(
        `big <- as.data.frame(matrix(rnorm(${N} * 5), nrow = ${N}, ncol = 5)); View(big)`
    );
    // poll until panel "big" exists
    // explicitly reset scroll to the top so the test is independent of any
    //   retained scroll state from a prior --watch run that re-View()s the
    //   same dataset (a same-shape replace doesn't reset visibleRangeStart
    //   inside applyInitOrReplace)
    await api.pressDataViewerKey('big', 'Home');
    // poll until lastVisibleRange.end < N / 2 (the Home reset has landed
    //   AND the rows for the top of the grid have been fetched —
    //   distinguishes 'panel exists' from 'panel reached steady state')
    await api.pressDataViewerKey('big', 'End');
    // poll until lastVisibleRange.end === N (the bottom-row fetch arrived)
});
```

`700_000 rows × 5 cols` is `~28 MB` of doubles, the smallest size that
engages the cap (`700_000 × 24 = 16.8 M > MAX_SCROLL_PX`) — exactly the
failure mode from the issue. R can compute and write it in a few seconds.
The suite already runs at a 120 s timeout. The test inherits the same
R-availability and `arrow`-package-availability skips the existing tests
use.

The Home-then-poll pre-step makes the test robust to retained scroll state.
A `View(big)` after a previous `View(big)` with the same shape goes through
`applyInitOrReplace`'s `sameDataset` branch, which intentionally preserves
`visibleRangeStart` so the user's scroll position survives a refresh — but
that means an unconditional "wait for end < N" gate could observe a stale
near-bottom range. Pressing `Home` first is cheap, deterministic, and tests
that the new `Home` key works as a side benefit.

### Bun unit tests

Four additions to the existing `'scroll height capping'` group in
`tests/bun/data-viewer-grid-model.test.ts`:

- `logicalScrollTop: clamps overshoot above maxPhysical to maxLogical (large)` —
  `logicalScrollTop(maxPhysical * 1.1, LARGE, VH, RH)` should equal
  `maxLogicalLarge` exactly.
- `logicalScrollTop: clamps negative scrollTop to 0 (large)` —
  `logicalScrollTop(-50, LARGE, VH, RH)` should equal `0`.
- `logicalScrollTop: clamps negative scrollTop to 0 (small)` —
  `logicalScrollTop(-50, SMALL, VH, RH)` should equal `0` (the small-data
  fast path now clamps too).
- `visibleRange after clamped overshoot still includes the last row` —
  round-trip test asserting `end === nrow` even with an overshooting
  `scrollTop`.

The existing "bottom: max scrollTop reaches the last row" test continues to
pass unchanged (clamping at `maxLogical` is a no-op for the in-range case).

## Documentation

`docs/data-viewer.md` — add a short "Keyboard shortcuts" subsection:

> - `Home` / `End` — jump to the first / last row.
> - `PageUp` / `PageDown` — scroll one viewport up / down.
> - `Cmd/Ctrl-A` — select all visible cells.
> - `Cmd/Ctrl-C` — copy the current selection as TSV.

Per AGENTS.md ("prefer code comments over Learnings entries"), the invariants
that pin behavior — that `End` sets `scrollTop = scrollHeight - clientHeight`
(the canonical browser-clamped bottom), and that `logicalScrollTop` clamps
overshoot/undershoot to `[0, maxLogical]` so any DOM-vs-model rounding still
lands on the last row — go in doc comments on the relevant code, not in
`AGENTS.md`.

## Open questions

None — the fix is small enough and the protocol extension narrow enough that
the design is fully determined by the existing code.

## What the mocha test does and does not prove

The `testKey` mechanism dispatches a synthetic `KeyboardEvent` against
`window` from inside the webview's iframe. That reaches the
`<svelte:window onkeydown={onKeyDown}>` listener and exercises the full
`onKeyDown` → `viewportEl.scrollTop = …` → `onScroll` → `scheduleFetchVisible`
→ `getRows` → `applyRows` → `postLifecycle('rows')` pipeline.

It does **not** exercise:

- VS Code's parent-window → iframe key forwarding.
- Iframe focus acquisition (we already pull focus on mount via
  `focusViewport()`, but this isn't tested here).
- Chromium's default behavior for End / Home / PageUp / PageDown on a
  focused scrollable element — the synthetic event fires our handler
  *after* the browser would have its turn at a real key event.

Those are the legitimate pieces of the keyboard pipeline that an
extension-host integration test fundamentally can't reach. The synthetic
mechanism is the closest a mocha test can get without spawning a UI
automation driver. A regression in any of the un-covered layers (focus
loss, key forwarding) would be caught by manual testing or higher-level
end-to-end harnesses, not this test.

## Known limitations / partially-resolved part of #183

Issue #183's first listed failure mode — "dragging the scrollbar pill to
the very bottom" — is **not** addressed by this PR. The browser's minimum
thumb size compresses the bottom of the drag track, so even with the
clamp in place the pill cannot map a drag to `scrollTop = maxPhysical`.
Closing this gap requires a custom overlay scrollbar (issue option 1) and
is tracked as a follow-up rather than rolled into this change.

The new `End` key gives users a deterministic way to reach the last row
in the meantime, and the clamp ensures the grid no longer blanks during
elastic-scroll overshoot. Pointer wheel and `ArrowDown` continue to work
within the native scrollbar's range (which is the same as before this PR).

## Risks

- **Mocha test runtime.** R startup + 700 K-row matrix construction +
  Arrow write can take 5–8 s on slow machines. The 120 s suite timeout has
  ample headroom, but the new test extends total suite runtime by roughly
  that amount. Acceptable; the existing `View(mtcars)` tests already pay R
  startup cost once. If timing becomes flaky on slower CI runners, the
  test can be split into its own describe block with a tighter
  per-test timeout, or moved behind a `RAVEN_RUN_LARGE_TESTS` env-gate.
- **Synthetic `KeyboardEvent` reaching `<svelte:window onkeydown>`.** In
  Svelte 5, `<svelte:window>` attaches a window-level listener;
  `window.dispatchEvent` is the documented way to deliver synthetic events
  to such listeners and is verified by Chromium. If the binding ever moves
  off `window`, the test handler must move with it. See "What the mocha
  test does and does not prove" for what this synthetic path covers.
- **`testKey` discoverability.** A future contributor could call this from
  production code. Mitigation: the doc comment marks it test-only and the
  branch is the only `testKey` consumer; a lint/grep check at PR time would
  catch new callers, but no automated guard is added (the surface is
  small).
- **Lifecycle event volume.** Adding a `postLifecycle('cache-hit')` to
  `scheduleFetchVisible` increases the rate of lifecycle messages by one
  per cached scroll. Lifecycle handling is trace-only on the host side
  (no I/O, no state writes besides `lastVisibleRange`), and
  `scheduleFetchVisible` is already coalesced at 16 ms, so the worst
  case is one extra message per coalesce window — negligible.
