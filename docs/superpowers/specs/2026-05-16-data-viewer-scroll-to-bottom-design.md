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

- A custom overlay scrollbar that bypasses the native widget. (The issue lists
  it as an option; out of scope here. Once End/Home/PageUp/PageDown work, the
  remaining "drag the pill to the bottom" gap is a UX nice-to-have, not a
  blocker.)
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
                                          → viewportEl.scrollTop = maxPhysical
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
existing Cmd-A / Cmd-C branches so the new keys win when no modifier is
pressed:

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
is already height-capped at `MAX_SCROLL_PX`, so `scrollHeight - clientHeight`
yields exactly `maxPhysical`, which after the existing `logicalScrollTop`
remap drives `visibleRange.end === nrow` — the bottom-row math already
verified by `tests/bun/data-viewer-grid-model.test.ts` ("bottom: max
scrollTop reaches the last row").

A doc comment on the new branches notes that `scrollHeight - clientHeight`
is the canonical browser-clamped maximum and works regardless of the
container's content height.

### 2. Clamp `logicalScrollTop` in `grid-model.ts`

The current implementation:

```typescript
return (scrollTop / maxPhysical) * maxLogical;
```

becomes:

```typescript
const scaled = (scrollTop / maxPhysical) * maxLogical;
return Math.max(0, Math.min(maxLogical, scaled));
```

Without the clamp, a macOS rubber-band overshoot (`scrollTop > maxPhysical`)
maps to `logical > maxLogical`. `visibleRange` then computes
`start = floor(logical / rowHeight) - overscan`, which may exceed `nrow`,
and the resulting range is empty. With the clamp, `logical` saturates at
`maxLogical`, `visibleRange.end` stays at `nrow`, and the bottom row keeps
rendering through the bounce.

The clamp is also defensive against negative `scrollTop` values — Chromium
shouldn't report them, but the clamp removes the assumption.

The function's existing doc comment is extended with a one-line note
explaining the clamp's purpose.

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
extends to also update `lastVisibleRange` from the now-required
`visibleRangeStart` / `visibleRangeEnd` fields. `lastVisibleRange` is
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
test('End key reaches the last row in a 1M-row data frame', async () => {
    await api.sendToRTerminal(
        'big <- as.data.frame(matrix(rnorm(1e6 * 5), nrow = 1e6, ncol = 5)); View(big)'
    );
    // poll until panel "big" exists
    // poll until visibleRange is reported (initial fetch landed)
    await api.pressDataViewerKey('big', 'End');
    // poll until visibleRange.end === 1_000_000
});
```

`1_000_000 rows × 5 cols` is `~38 MB` of doubles; well below the cap and
small enough that R can compute and write it in a few seconds. The suite
already runs at a 120 s timeout. The test inherits the same R-availability
and `arrow`-package-availability skips the existing tests use.

`1 M rows × 24 px = 24 M px > MAX_SCROLL_PX (15 M)`, so the cap is engaged
and the remap is exercised — exactly the failure mode from the issue.

### Bun unit tests

Three additions to the existing `'scroll height capping'` group in
`tests/bun/data-viewer-grid-model.test.ts`:

- `logicalScrollTop: clamps overshoot above maxPhysical to maxLogical` —
  `logicalScrollTop(maxPhysical * 1.1, LARGE, VH, RH)` should equal
  `maxLogicalLarge` exactly.
- `logicalScrollTop: clamps negative scrollTop to 0` — `logicalScrollTop(-50,
  LARGE, VH, RH)` should equal `0`.
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
that pin behavior — that `End` uses `scrollHeight - clientHeight` to reach
exactly `maxPhysical`, and that `logicalScrollTop` clamps overshoot — go in
doc comments on the relevant code, not in `AGENTS.md`.

## Open questions

None — the fix is small enough and the protocol extension narrow enough that
the design is fully determined by the existing code.

## Risks

- **Mocha test runtime.** R startup + 1 M-row matrix construction +
  Arrow write can take 5–10 s on slow machines. The 120 s suite timeout has
  ample headroom, but the new test extends total suite runtime by roughly
  that amount. Acceptable; the existing `View(mtcars)` tests already pay R
  startup cost once.
- **Synthetic `KeyboardEvent` reaching `<svelte:window onkeydown>`.** In
  Svelte 5, `<svelte:window>` attaches a window-level listener;
  `window.dispatchEvent` is the documented way to deliver synthetic events
  to such listeners and is verified by Chromium. If the binding ever moves
  off `window`, the test handler must move with it.
- **`testKey` discoverability.** A future contributor could call this from
  production code. Mitigation: the doc comment marks it test-only and the
  branch is the only `testKey` consumer; a lint/grep check at PR time would
  catch new callers, but no automated guard is added (the surface is
  small).
