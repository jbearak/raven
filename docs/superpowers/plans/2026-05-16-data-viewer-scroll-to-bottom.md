# Data Viewer Scroll-to-Last-Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #183 (data viewer can't scroll to the last row of a large
data frame) by adding Home/End/PageUp/PageDown keyboard shortcuts, clamping
`logicalScrollTop` so macOS rubber-band overshoot doesn't blank the grid, and
covering both fixes with automated tests — including a mocha integration
test that drives `End` against a real R-loaded 700K-row data frame.

**Architecture:** Two production-code changes (Svelte webview keyboard
handler + `grid-model.ts` clamp), plus a small extension to the existing
postMessage protocol so the mocha test can dispatch a synthetic
`KeyboardEvent` from the extension host and read back the resulting visible
row range. No new processes, caches, or threads. See
`docs/superpowers/specs/2026-05-16-data-viewer-scroll-to-bottom-design.md`.

**Tech Stack:** TypeScript + Svelte 5 in the data-viewer webview;
TypeScript + VS Code APIs in the extension host; Bun (`bun:test`) for
pure-function unit tests; Mocha + `@vscode/test-electron` for integration
tests; R + the `arrow` R package for the integration fixture.

---

## File Structure

Files created or modified by this plan:

```text
editors/vscode/src/data-viewer/
├── webview/
│   ├── grid-model.ts                          # MODIFY — clamp logicalScrollTop
│   └── App.svelte                             # MODIFY — testKey handler,
│                                              #   keyboard shortcuts,
│                                              #   postLifecycle visibleRange,
│                                              #   cache-hit lifecycle post
├── messages.ts                                # MODIFY — extend lifecycle +
│                                              #   add testKey ExtensionToWebview
├── panel.ts                                   # MODIFY — lastVisibleRange,
│                                              #   getVisibleRange, pressKey
├── manager.ts                                 # MODIFY — passthroughs

editors/vscode/src/extension.ts                # MODIFY — RavenExtensionApi
                                               #   adds two methods

editors/vscode/src/test/data-viewer.test.ts    # MODIFY — new End-key test

tests/bun/data-viewer-grid-model.test.ts       # MODIFY — 4 new clamp tests

docs/data-viewer.md                            # MODIFY — Keyboard shortcuts
                                               #   subsection

docs/superpowers/plans/
└── 2026-05-16-data-viewer-scroll-to-bottom.md # THIS PLAN
```

Each file has one responsibility:

- `grid-model.ts` — pure scroll math; the clamp lives here so it's
  unit-testable under Bun without DOM.
- `App.svelte` — UI behavior (key bindings, scroll → fetch pipeline).
- `messages.ts` — wire types only, no behavior.
- `panel.ts` — extension-side panel state + protocol handling.
- `manager.ts` — multiplexing across panels by name.
- `extension.ts` — the public test API surface.
- `data-viewer.test.ts` — integration coverage of the runtime pipeline.
- `data-viewer-grid-model.test.ts` — coverage of the math layer.
- `docs/data-viewer.md` — user-facing keyboard shortcut docs.

---

## Task 1: Bun unit tests for the new clamp behavior (RED)

**Files:**
- Modify: `tests/bun/data-viewer-grid-model.test.ts`

This task runs in parallel with Task 2 as a TDD pair (RED → GREEN). We
write the tests first and watch them fail before implementing the clamp.

- [ ] **Step 1: Add four new tests inside the existing `'scroll height capping'` describe block**

Open `tests/bun/data-viewer-grid-model.test.ts`. Locate the
`describe('scroll height capping', ...)` block. Right after the existing
test `'bottom: max scrollTop reaches the last row'` (around line 110), add
four new tests. The full new block to insert is:

```typescript
    test('logicalScrollTop: clamps overshoot above maxPhysical to maxLogical (large)', () => {
        // macOS rubber-band can briefly push scrollTop above maxPhysical.
        // Without the clamp, the scaled value exceeds maxLogical and
        // visibleRange would return an empty window.
        expect(logicalScrollTop(maxPhysical * 1.1, LARGE, VH, RH))
            .toBe(maxLogicalLarge);
    });

    test('logicalScrollTop: clamps negative scrollTop to 0 (large)', () => {
        // Defensive: Chromium shouldn't report negative scrollTop, but the
        // clamp removes the assumption.
        expect(logicalScrollTop(-50, LARGE, VH, RH)).toBe(0);
    });

    test('logicalScrollTop: clamps negative scrollTop to 0 (small)', () => {
        // The small-data fast path also clamps now, so a stray negative
        // scrollTop never propagates to visibleRange's floor() math.
        expect(logicalScrollTop(-50, SMALL, VH, RH)).toBe(0);
    });

    test('visibleRange after clamped overshoot still includes the last row', () => {
        const nrow = 10_000_000;
        const totalGridHeight = nrow * RH;
        // Simulate rubber-band overshoot: scrollTop 10% past maxPhysical.
        const logical = logicalScrollTop(maxPhysical * 1.1, totalGridHeight, VH, RH);
        const range = visibleRange({
            scrollTop: logical, viewportHeight: VH,
            rowHeight: RH, nrow, overscan: 8,
        });
        expect(range.end).toBe(nrow);
    });
```

- [ ] **Step 2: Run the bun tests to verify the new ones fail**

From the repo root, run:

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: the 4 new tests FAIL with messages like
- `expected maxLogicalLarge, received <some number > maxLogicalLarge>`
- `expected 0, received -50` (the small-path test)
- `expected nrow, received <smaller number>` (the round-trip test)

The pre-existing tests in the suite should still PASS. Do not commit yet —
the implementation in Task 2 will make these green and the commit happens
there.

---

## Task 2: Implement the clamp in `grid-model.ts` (GREEN)

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/grid-model.ts`

- [ ] **Step 1: Replace `logicalScrollTop`'s body with the clamping version**

Open `editors/vscode/src/data-viewer/webview/grid-model.ts`. Locate the
existing `logicalScrollTop` function (lines 22–34). Replace its body
**and** extend its doc comment so the clamp invariant is recorded next to
the code. The full new function:

```typescript
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
```

- [ ] **Step 2: Run the bun tests and verify they all pass**

```bash
bun test tests/bun/data-viewer-grid-model.test.ts
```

Expected: all tests PASS, including the 4 new ones from Task 1 and the
original `'bottom: max scrollTop reaches the last row'` (unchanged behavior
since clamping at `maxLogical` is a no-op when `scrollTop ≤ maxPhysical`).

- [ ] **Step 3: Commit**

```bash
git add editors/vscode/src/data-viewer/webview/grid-model.ts \
        tests/bun/data-viewer-grid-model.test.ts
git commit -m "fix(data-viewer): clamp logicalScrollTop to [0, maxLogical] (#183)

macOS rubber-band overshoot briefly pushes scrollTop above maxPhysical.
Without a clamp the scaled value exceeds maxLogical, visibleRange returns
end < start, and the grid blanks until the bounce resolves. Clamp both
branches of logicalScrollTop. Add bun tests covering both branches and a
visibleRange round-trip from an overshooting scrollTop."
```

---

## Task 3: Extend `messages.ts` protocol

**Files:**
- Modify: `editors/vscode/src/data-viewer/messages.ts`

This task is types-only; no runtime behavior changes yet. Subsequent
tasks (4-6) make the new fields/types live.

- [ ] **Step 1: Add `visibleRangeStart` / `visibleRangeEnd` to the lifecycle variant**

Open `editors/vscode/src/data-viewer/messages.ts`. Locate the `lifecycle`
variant of `WebviewToExtension` (around lines 92–100). Add the two new
fields **before** `timestamp`:

```typescript
    | {
        type: 'lifecycle';
        event: string;
        panelGeneration: number;
        nrow: number;
        columns: number;
        visibleRows: number;
        /** Start row index of the currently rendered window (inclusive).
         *  Used by the test API to verify scroll position. Always reflects
         *  visibleRangeStart at the moment postLifecycle was called. */
        visibleRangeStart: number;
        /** End row index of the currently rendered window (exclusive).
         *  Equal to visibleRangeStart + visibleRows.length. */
        visibleRangeEnd: number;
        timestamp: number;
    }
```

- [ ] **Step 2: Add the `testKey` `ExtensionToWebview` variant**

Locate the `ExtensionToWebview` union (starts at line 30). At the end of
the union — after the `error` variant (around line 86) — add:

```typescript
    | {
        /** Test-only: dispatch a synthetic KeyboardEvent on `window` from
         *  inside the webview, so the integration test harness can drive
         *  the same onKeyDown handler a real keypress would invoke.
         *  Production code paths never post this message; the webview can
         *  only receive messages from its own extension host, so exposing
         *  it does not introduce an external attack surface. */
        type: 'testKey';
        panelGeneration: number;
        key: string;
    }
```

The doc comment is required — it's the discoverability signal that warns
future contributors not to call this from production code (per the spec's
Risks section).

- [ ] **Step 3: Verify the file still type-checks**

From `editors/vscode/`:

```bash
bun run typecheck
```

Expected: PASS. (TypeScript will flag any consumer that destructures the
old lifecycle shape, but no current consumer does — `panel.ts` only reads
the legacy fields, and App.svelte's `postLifecycle` constructs the message
inline. New required fields will surface as compile errors in Tasks 4-5,
which is the point.)

Actually, this WILL fail because App.svelte's `postLifecycle` does not yet
populate the new required fields. That's expected at this stage. Continue
to Task 4 (which fixes panel.ts to consume the new fields) and Task 5
(which fixes App.svelte to populate them) before re-running typecheck. Do
not commit until those tasks complete.

---

## Task 4: Add `panel.ts` test infrastructure (lastVisibleRange + getVisibleRange + pressKey)

**Files:**
- Modify: `editors/vscode/src/data-viewer/panel.ts`

- [ ] **Step 1: Add the `lastVisibleRange` private field**

Open `editors/vscode/src/data-viewer/panel.ts`. Locate the
`DataViewerPanel` class fields (around line 30). Add a new private field
after `private readonly traceId`:

```typescript
    /** Latest visible-row range observed via lifecycle events. Used by
     *  the integration test API. `undefined` until the first lifecycle
     *  message arrives; cleared on `replace()` so a stale range from the
     *  previous dataset is never returned for the new one. */
    private lastVisibleRange: { start: number; end: number } | undefined;
```

- [ ] **Step 2: Update the lifecycle handler to cache the range and add new public methods**

Locate the `if (m.type === 'lifecycle')` branch in `handleInner` (around
line 232). Replace it with the version that also caches the range, with
defensive narrowing:

```typescript
        if (m.type === 'lifecycle') {
            this.trace(`webview-${m.event}`, {
                generation: m.panelGeneration,
                nrow: m.nrow,
                columns: m.columns,
                visibleRows: m.visibleRows,
                visibleRangeStart: m.visibleRangeStart,
                visibleRangeEnd: m.visibleRangeEnd,
                timestamp: m.timestamp,
            });
            // Cache the range only when both fields are finite numbers.
            // panel.ts is the trust boundary for messages from the webview;
            // narrow defensively so a malformed message can never store
            // {start: NaN, end: undefined as number} into lastVisibleRange.
            if (m.panelGeneration === this.generation
                && Number.isFinite(m.visibleRangeStart)
                && Number.isFinite(m.visibleRangeEnd)) {
                this.lastVisibleRange = {
                    start: m.visibleRangeStart,
                    end: m.visibleRangeEnd,
                };
            }
            return;
        }
```

Then locate the existing `getColumnNames()` method (search for
`/** Column names in schema order — used by the test harness. */`) and add
two new methods immediately above it:

```typescript
    /** Latest visible-row range from the most recent lifecycle message,
     *  or undefined if none has arrived yet. Used by the test harness to
     *  verify scroll position. */
    getVisibleRange(): { start: number; end: number } | undefined {
        return this.lastVisibleRange;
    }

    /** Test-only: post a `testKey` message to the webview so it dispatches
     *  a synthetic KeyboardEvent on `window`. Awaiting the returned promise
     *  waits for the message to be queued, not for any reply; tests should
     *  poll `getVisibleRange()` to observe the result. */
    async pressKey(key: string): Promise<void> {
        if (this.disposed) return;
        const msg: ExtensionToWebview = {
            type: 'testKey',
            panelGeneration: this.generation,
            key,
        };
        await this.webviewPanel.webview.postMessage(msg);
    }
```

- [ ] **Step 3: Clear `lastVisibleRange` on `replace()`**

Locate the `async replace(...)` method (around line 95). Inside the method,
right after the `this.generation += 1;` line, add:

```typescript
        this.generation += 1;
        // Clear cached visible range so a stale range from the previous
        // dataset is never returned for the new one. The next lifecycle
        // event from the webview will repopulate it.
        this.lastVisibleRange = undefined;
```

- [ ] **Step 4: Verify the file type-checks against the new messages**

From `editors/vscode/`:

```bash
bun run typecheck
```

Expected: still failing because App.svelte doesn't populate the new
required lifecycle fields yet. That's expected; Task 5 fixes it.

---

## Task 5: Update `App.svelte` — testKey handler, postLifecycle range, cache-hit lifecycle

**Files:**
- Modify: `editors/vscode/src/data-viewer/webview/App.svelte`

This task adds all the webview-side infrastructure the test needs, but
**not** the keyboard shortcuts themselves (those come in Task 7). After
this task, the testKey message dispatches a synthetic KeyboardEvent that
flows through `onKeyDown` — but `onKeyDown` only handles Cmd-A/Cmd-C, so
nothing scrolls. That's the RED state Task 7 will turn GREEN.

- [ ] **Step 1: Extend `postLifecycle` to include the visible range**

Open `editors/vscode/src/data-viewer/webview/App.svelte`. Locate
`function postLifecycle` (around line 117). Replace its body:

```typescript
    function postLifecycle(event: string): void {
        vscode.postMessage({
            type: 'lifecycle',
            event,
            panelGeneration,
            nrow,
            columns: columns.length,
            visibleRows: visibleRows.length,
            visibleRangeStart,
            visibleRangeEnd: visibleRangeStart + visibleRows.length,
            timestamp: Date.now(),
        });
    }
```

- [ ] **Step 2: Add the `testKey` message-handler branch**

Locate the message handler in `onMount` (the `switch (m.type)` block around
lines 142–155). Add a new case **after** `case 'copyDone'`:

```typescript
                case 'copyDone':
                    applyCopyDone(m);
                    return;
                case 'testKey':
                    // Test-only: dispatch a synthetic KeyboardEvent on
                    // `window` so the same onKeyDown handler a real
                    // keypress would invoke runs end-to-end. The
                    // <svelte:window onkeydown={onKeyDown}> binding
                    // listens at the window level, so window.dispatchEvent
                    // is the canonical delivery path for synthetic events.
                    window.dispatchEvent(new KeyboardEvent('keydown', {
                        key: m.key,
                        code: m.key,
                        bubbles: true,
                        cancelable: true,
                    }));
                    return;
```

- [ ] **Step 3: Add `postLifecycle('cache-hit')` and `postLifecycle('empty-range')` to `scheduleFetchVisible`'s fast paths**

Locate the `scheduleFetchVisible = coalesceScroll(...)` call (around line
300). Replace the empty-range and cache-hit branches so each posts a
lifecycle event before returning:

```typescript
    const scheduleFetchVisible = coalesceScroll(() => {
        const range = visibleRange({
            scrollTop: logicalScrollTop(scrollTop, totalGridHeight, viewportHeight, ROW_HEIGHT),
            viewportHeight, rowHeight: ROW_HEIGHT, nrow, overscan: 8,
        });
        if (range.end <= range.start) {
            visibleRows = [];
            visibleRangeStart = range.start;
            persistWebviewState();
            // Tell the host every change to visibleRangeStart, including
            // the empty-range case — otherwise the test API can stall on
            // a stale range when nrow shrinks to 0 or the viewport
            // collapses.
            postLifecycle('empty-range');
            return;
        }
        const cached = rowCache.get(range.start, range.end);
        if (cached) {
            visibleRows = cached;
            visibleRangeStart = range.start;
            persistWebviewState();
            // Without this, an End keypress that lands on a pre-cached
            // window (e.g., re-pressing End after a scroll-up) would
            // never tell the host its range changed, leaving the polling
            // test stuck on a stale lastVisibleRange.
            postLifecycle('cache-hit');
            return;
        }
        viewportGeneration += 1;
```

(The rest of the function is unchanged.)

- [ ] **Step 4: Verify everything type-checks**

From `editors/vscode/`:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Verify the bundle builds**

From `editors/vscode/`:

```bash
bun run bundle
```

Expected: PASS. The data-viewer webview is built from `App.svelte` via
`esbuild-svelte`; if any Svelte syntax or TypeScript type is wrong, this
step will fail.

- [ ] **Step 6: Commit (test infrastructure complete; mocha test will follow)**

```bash
git add editors/vscode/src/data-viewer/messages.ts \
        editors/vscode/src/data-viewer/panel.ts \
        editors/vscode/src/data-viewer/webview/App.svelte
git commit -m "feat(data-viewer): add test-only protocol for driving keys + reading visible range

Extends the postMessage protocol with:
- visibleRangeStart / visibleRangeEnd on lifecycle events (always sent)
- testKey ExtensionToWebview variant (test-only, gated by doc comment)

DataViewerPanel caches lastVisibleRange from lifecycle messages and
exposes getVisibleRange() / pressKey() for the test harness. The webview
posts lifecycle events from scheduleFetchVisible's cache-hit and empty-
range fast paths so every change to visibleRangeStart is observable from
the host (without this, an End keypress into a pre-cached window would
silently update only the webview).

No user-visible behavior change."
```

---

## Task 6: Wire up `manager.ts` and `extension.ts` test API

**Files:**
- Modify: `editors/vscode/src/data-viewer/manager.ts`
- Modify: `editors/vscode/src/extension.ts`

- [ ] **Step 1: Add passthrough methods to `DataViewerManager`**

Open `editors/vscode/src/data-viewer/manager.ts`. Locate `getPanelColumnNames`
(around line 71). Add two new methods immediately after:

```typescript
    /** Latest visible-row range for a named panel — used by the test
     *  harness to verify scroll position. */
    getPanelVisibleRange(panelName: string): { start: number; end: number } | undefined {
        return this.panels.get(panelName)?.getVisibleRange();
    }

    /** Test-only: dispatch a synthetic key event in a named panel's
     *  webview. Awaiting waits for the message to be queued, not for any
     *  reply; tests should poll `getPanelVisibleRange()` to observe
     *  results. */
    async pressKeyOnPanel(panelName: string, key: string): Promise<void> {
        await this.panels.get(panelName)?.pressKey(key);
    }
```

- [ ] **Step 2: Extend `RavenExtensionApi` with two new methods**

Open `editors/vscode/src/extension.ts`. Locate the `RavenExtensionApi`
interface (around line 125). Add two new methods at the end of the
interface, immediately after `_disposeCachedRTerminalForTest`:

```typescript
    /** Latest visible-row range for a data viewer panel, or undefined if
     *  none has arrived yet. Used by integration tests to verify scroll
     *  position. */
    getDataViewerPanelVisibleRange(panelName: string):
        { start: number; end: number } | undefined;
    /** Test-only: dispatch a synthetic key event in a data viewer panel.
     *  Used by integration tests to drive End / Home / PageDown / PageUp.
     *  Awaiting waits for the message to be queued; poll
     *  getDataViewerPanelVisibleRange to observe the result. */
    pressDataViewerKey(panelName: string, key: string): Promise<void>;
```

Then locate the `return { ... }` block at the bottom of `activate()`
(around line 387). Add the two new methods to the returned object,
immediately after `getDataViewerPanelColumnNames`:

```typescript
    return {
        getLanguageClient: () => client,
        sendToRTerminal: async (code: string) => {
            const terminal = await get_or_create_r_terminal();
            terminal.sendText(code, true);
        },
        getDataViewerPanelNames: () => data_viewer_manager?.getPanelNames() ?? [],
        getDataViewerPanelColumnNames: (panelName: string) =>
            data_viewer_manager?.getPanelColumnNames(panelName),
        getDataViewerPanelVisibleRange: (panelName: string) =>
            data_viewer_manager?.getPanelVisibleRange(panelName),
        pressDataViewerKey: async (panelName: string, key: string) => {
            await data_viewer_manager?.pressKeyOnPanel(panelName, key);
        },
        _disposeCachedRTerminalForTest: () => _dispose_cached_r_terminal_for_test(),
    };
```

- [ ] **Step 3: Verify everything type-checks**

```bash
cd editors/vscode && bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Verify the bundle builds**

```bash
cd editors/vscode && bun run bundle
```

Expected: PASS.

- [ ] **Step 5: Commit (extension API surface complete)**

```bash
git add editors/vscode/src/data-viewer/manager.ts \
        editors/vscode/src/extension.ts
git commit -m "feat(data-viewer): expose visible range + key dispatch on test API

Adds getDataViewerPanelVisibleRange / pressDataViewerKey to
RavenExtensionApi so integration tests can drive scroll keys against a
real panel and observe the resulting visible row range.

No user-visible behavior change."
```

---

## Task 7: Write the mocha integration test (RED) and add keyboard shortcuts (GREEN)

**Files:**
- Modify: `editors/vscode/src/test/data-viewer.test.ts`
- Modify: `editors/vscode/src/data-viewer/webview/App.svelte`

This task is the TDD pair for the runtime path. We add the failing test
first (it can't reach the last row because no key handlers exist), then
implement Home / End / PageDown / PageUp and watch it pass.

- [ ] **Step 1: Add a `pollFor<T>` helper if one isn't already in scope**

Open `editors/vscode/src/test/data-viewer.test.ts`. The existing
`pollForPanel` is hard-coded to wait for a panel name. We need a more
general polling helper. Add it at the top of the file, immediately after
the existing `pollForPanel` function:

```typescript
/** Poll a predicate at 100 ms intervals until it returns a truthy value or
 *  the deadline elapses. Returns the truthy value on success or `undefined`
 *  on timeout (caller asserts). */
async function pollFor<T>(
    predicate: () => T | undefined,
    timeoutMs: number,
    intervalMs = 100,
): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value !== undefined && value !== null && value !== false) {
            return value as T;
        }
        await sleep(intervalMs);
    }
    return undefined;
}
```

- [ ] **Step 2: Add the new test at the end of the suite**

Inside the same `suite('data-viewer smoke tests', ...)` block, after the
last existing `test(...)` (the "View(mtcars) a second time replaces"
test), add:

```typescript
    test('End key reaches the last row in a 700K-row data frame', async function () {
        // Smallest size that engages the cap (700_000 × 24 = 16.8 M >
        // MAX_SCROLL_PX of 15 M) — exactly the failure mode from #183.
        const N = 700_000;

        await api.sendToRTerminal(
            `big <- as.data.frame(matrix(rnorm(${N} * 5), `
            + `nrow = ${N}, ncol = 5)); View(big)`,
        );

        // Wait for the panel to exist. R startup + matrix rnorm + Arrow
        // write can take several seconds on a cold runner.
        const panelAppeared = await pollForPanel(api, 'big', 60000);
        assert.ok(panelAppeared, 'panel "big" did not appear within 60 s');

        // Reset scroll to the top. A previous --watch run could have left
        // the same-shape panel scrolled to the bottom; applyInitOrReplace's
        // sameDataset branch intentionally preserves visibleRangeStart, so
        // an unconditional 'end < N/2' gate would deadlock on that.
        // Press Home as a deterministic reset (this also exercises Home
        // as a bonus side check).
        await api.pressDataViewerKey('big', 'Home');

        // Wait for the Home reset to land AND rows for the top of the
        // grid to be fetched. A mount/init lifecycle reports
        // {start: 0, end: 0}, which would satisfy 'end < N/2' alone — so
        // require end > 0 too.
        const topRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end > 0 && r.end < N / 2 ? r : undefined;
        }, 30000);
        assert.ok(topRange, `Home reset did not land at the top within 30 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);

        // Drive End and wait for the bottom-row fetch to land.
        await api.pressDataViewerKey('big', 'End');

        const bottomRange = await pollFor(() => {
            const r = api.getDataViewerPanelVisibleRange('big');
            return r && r.end === N ? r : undefined;
        }, 30000);
        assert.ok(bottomRange,
            `End key did not reach the last row within 30 s; `
            + `last range: ${JSON.stringify(api.getDataViewerPanelVisibleRange('big'))}`);
    });
```

- [ ] **Step 3: Run the data-viewer test suite to confirm the new test fails**

The full suite is gated on R + `arrow` being installed; if either is
missing, the suite skips and there's nothing to verify. From
`editors/vscode/`:

```bash
bun run pretest && bun run test --grep 'data-viewer smoke tests'
```

Expected: the new test FAILS (or times out at 30 s on the bottom-range
poll), with an error that the `End` key did not reach the last row. The
existing three tests should still PASS. This is the RED state of TDD.

If R is not installed locally, the suite will skip entirely; in that case
this step is "no-op verified by inspection" — just make sure the test
file compiles via `bun run typecheck`. Note this in the commit message.

- [ ] **Step 4: Add the keyboard shortcut branches to `onKeyDown` in `App.svelte`**

Open `editors/vscode/src/data-viewer/webview/App.svelte`. Locate
`function onKeyDown` (around line 468). Replace its body with:

```typescript
    function onKeyDown(e: KeyboardEvent): void {
        const meta = e.metaKey || e.ctrlKey;
        if (e.key === 'Escape' && contextMenu) {
            closeContextMenu();
            return;
        }
        // Plain (no-modifier) navigation keys — added for issue #183.
        // We deliberately ignore any modifier so platform shortcuts
        // (Shift+End to extend selection, Cmd+End in some apps to jump-
        // and-extend) fall through to the browser/OS unchanged. The
        // viewportEl null guard handles the brief window between mount
        // and the bind:this assignment.
        if (!meta && !e.shiftKey && !e.altKey && viewportEl) {
            switch (e.key) {
                case 'End':
                    e.preventDefault();
                    // scrollHeight - clientHeight is the canonical
                    // browser-clamped maximum. The inner .grid div is
                    // height-capped at MAX_SCROLL_PX + ROW_HEIGHT, so
                    // this lands at or near the model's maxPhysical;
                    // logicalScrollTop's clamp absorbs any DOM-vs-model
                    // rounding mismatch.
                    viewportEl.scrollTop = viewportEl.scrollHeight - viewportEl.clientHeight;
                    return;
                case 'Home':
                    e.preventDefault();
                    viewportEl.scrollTop = 0;
                    return;
                case 'PageDown':
                    e.preventDefault();
                    viewportEl.scrollTop += viewportEl.clientHeight;
                    return;
                case 'PageUp':
                    e.preventDefault();
                    viewportEl.scrollTop -= viewportEl.clientHeight;
                    return;
            }
        }
        if (meta && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            selection.selectAll(nrow, visibleCols);
            bumpSelection();
            return;
        }
        if (meta && (e.key === 'c' || e.key === 'C')) {
            if (!selection.rect()) return;
            e.preventDefault();
            copySelection();
        }
    }
```

- [ ] **Step 5: Rebuild the bundle and re-run the test to confirm GREEN**

```bash
cd editors/vscode && bun run pretest && bun run test --grep 'data-viewer smoke tests'
```

Expected: all four data-viewer tests PASS, including the new End-key
test. The bottom range poll should land within seconds (the End-key
scrollTop set fires onScroll → scheduleFetchVisible → getRows → applyRows
→ postLifecycle('rows')).

If R is not installed locally, the suite skips. In that case verify by
inspection that:
- Plain `End` / `Home` / `PageDown` / `PageUp` no longer fall through to
  the browser default (they're handled and `preventDefault` is called).
- `Shift+End`, `Cmd+End`, `Alt+End` etc. still fall through to the Cmd-A /
  Cmd-C branches or the browser default (they don't enter the switch
  because of the `!meta && !e.shiftKey && !e.altKey` guard).

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/src/test/data-viewer.test.ts \
        editors/vscode/src/data-viewer/webview/App.svelte
git commit -m "feat(data-viewer): add Home/End/PageDown/PageUp keyboard shortcuts (#183)

Issue #183: dragging the scrollbar pill, holding ArrowDown, and macOS
inertia-scroll all fail to reach the last row of a large data frame
because the browser's minimum scrollbar-thumb size compresses the bottom
of the drag track. Add Home / End / PageUp / PageDown as a deterministic
keyboard path to any row regardless of widget quirks.

End sets viewportEl.scrollTop to scrollHeight - clientHeight, which after
logicalScrollTop's clamp resolves to the last row. Modifier-shift / cmd /
alt combinations fall through unchanged so platform shortcuts aren't
hijacked.

Adds a 700K-row mocha integration test that drives Home then End via the
testKey protocol and asserts the visible-row range reaches nrow.
Skips automatically when R or the arrow package is unavailable."
```

---

## Task 8: Update `docs/data-viewer.md` with keyboard shortcuts

**Files:**
- Modify: `docs/data-viewer.md`

- [ ] **Step 1: Locate the right insertion point**

Open `docs/data-viewer.md`. Find the existing copy/selection section (search
for `Cmd-A` or `Cmd+A` or `Cmd/Ctrl-A`). The keyboard shortcuts subsection
goes immediately after the section that documents copy/selection.

If no such section exists yet (the file's current structure may differ),
insert the new subsection before any "Limitations" or "Known issues"
section near the bottom.

- [ ] **Step 2: Insert the keyboard shortcuts subsection**

Add this Markdown block:

```markdown
## Keyboard shortcuts

| Key                | Action                                  |
| ------------------ | --------------------------------------- |
| `Home`             | Jump to the first row.                  |
| `End`              | Jump to the last row.                   |
| `PageUp`           | Scroll one viewport up.                 |
| `PageDown`         | Scroll one viewport down.               |
| `Cmd/Ctrl-A`       | Select all visible cells.               |
| `Cmd/Ctrl-C`       | Copy the current selection as TSV.      |

`Home` and `End` are the recommended way to reach the very first or very
last row in a large data frame: the native scrollbar's minimum thumb size
prevents dragging the pill all the way to the bottom of a multi-million-
row grid (see [issue #183](https://github.com/jbearak/raven/issues/183)),
but `End` jumps there in one keystroke.
```

- [ ] **Step 3: Verify the markdown lints clean (if a markdown linter is
   configured for the repo)**

If the repo has markdownlint, run it. If not, skip this step.

- [ ] **Step 4: Commit**

```bash
git add docs/data-viewer.md
git commit -m "docs(data-viewer): document Home/End/PageUp/PageDown shortcuts (#183)"
```

---

## Task 9: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full bun test suite**

From the repo root:

```bash
bun test
```

Expected: all bun tests PASS, including the 4 new data-viewer-grid-model
tests. No regressions.

- [ ] **Step 2: Run the full VS Code extension test suite**

```bash
cd editors/vscode && bun run pretest && bun run test
```

Expected: all suites PASS or skip cleanly (data-viewer suite skips if R or
arrow are missing). No new failures.

- [ ] **Step 3: Run the typecheck**

```bash
cd editors/vscode && bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the bundle build**

```bash
cd editors/vscode && bun run bundle
```

Expected: PASS. The data-viewer webview compiles cleanly from
`App.svelte`.

- [ ] **Step 5: Run the Rust build (sanity check that no Rust changes
   slipped in)**

From the repo root:

```bash
cargo build -p raven
```

Expected: PASS (this PR doesn't touch Rust, but the umbrella build should
still be clean).

- [ ] **Step 6: Confirm git log is clean**

```bash
git log --oneline -10
```

Expected output (commit hashes will differ):

```text
<hash> docs(data-viewer): document Home/End/PageUp/PageDown shortcuts (#183)
<hash> feat(data-viewer): add Home/End/PageDown/PageUp keyboard shortcuts (#183)
<hash> feat(data-viewer): expose visible range + key dispatch on test API
<hash> feat(data-viewer): add test-only protocol for driving keys + reading visible range
<hash> fix(data-viewer): clamp logicalScrollTop to [0, maxLogical] (#183)
<hash> docs(spec): address codex pass 3 — Home readiness needs end > 0 too
<hash> docs(spec): address codex pass 2 — readiness gate, diagram, shift-key example
<hash> docs(spec): address codex adversarial review pass on scroll-to-bottom design
<hash> docs(spec): data viewer scroll-to-last-row design (#183)
…
```

Five implementation commits + four spec commits, all referencing #183 or
the spec. No accidental WIP commits.

---

## Out of scope (for issue #183 follow-up)

These items are explicitly **not** in this plan, per the design's
"Non-goals" and "Known limitations" sections:

- A custom overlay scrollbar that maps thumb position directly to
  `[0, nrow]`. Required to fix the "drag the pill to the bottom" symptom
  from #183 (which `End` works around but does not eliminate).
- Spreadsheet-style `Cmd-Down` / `Cmd-End` chord shortcuts.
- Sort, filter, or search semantics.
- Adjusting `MAX_SCROLL_PX`.

Each of these is a meaningful follow-up but has its own design surface
that would balloon this change.
