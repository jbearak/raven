# Data viewer: explain (and let users cancel) the saved sort/filter restore (#519)

Port of [sight#228](https://github.com/jbearak/sight/pull/228) into raven's
data viewer, adapted to raven's architecture.

## Problem

Raven's data viewer opens instantly because the grid is virtualized: only the
visible window of rows is read from the Arrow file at any moment. Sort and
filter break that frugality — to apply either, the host must read the relevant
column(s) **in their entirety** to compute a sort permutation or a filter
survivor set.

Sort and filter preferences are persisted per `panelName × schemaHash` and
**re-applied automatically on reopen**. On reopen of a panel with saved
preferences, `DataViewerPanel.sendInit` (and `sendReplace`) does the heavy
column reads *before* it posts the `init` / `replace` message:

```
webviewReady → sendInit():
    load stores (layout, toolbar, sort, filter)
    restoreSort(savedSort)      // computePermutation: reads sort column(s) fully
    restoreFilter(savedFilter)  // computeFilteredIndices: scans filter column(s) fully
    postMessage(init)           // only now does the grid populate
    postMessage(filterApplied)  // if a filter was restored
```

Until `init` arrives the webview has no schema, so the toolbar shows a bare
`Loading…` (`describeVisibleRows(..., loading=true)` in `grid-model.ts`).

This is the same shape of regression #518 fixed (O(nrow) work awaited before the
paint-enabling message), but gated on **persisted sort/filter** rather than
always-on. A fresh `View()` with no persisted state short-circuits both restores
and is unaffected (that is why #518 alone made the smoke demo instant). On a
multi-million-row frame, reopening a panel that has a saved sort or filter shows
seconds of empty grid with:

1. **No explanation.** No hint that the wait exists *because* raven is reapplying
   the remembered sort/filter and reading whole columns to do it. (There is
   already a `Sorting…` / `Filtering…` progress pill, but it is wired only to
   *interactive* sort/filter changes made after the grid is up — never to this
   initial restore.)
2. **No escape hatch.** No way to say "skip it, just show me the data."

## Goal

On reopen with saved preferences:

1. Replace the bare `Loading…` with an explanation — e.g. *"Applying your saved
   sort & filter…"* — so the wait is self-explanatory.
2. Offer a **Cancel** control. Cancelling abandons the restore, **forgets** the
   saved preferences for this panel (clears the persisted sort/filter), and shows
   the data in its natural (unsorted, unfiltered) order.
3. Keep today's "no visible reorder" property: rows must never appear in the
   wrong order and then jump. Data appears only once its final order is known
   (or, on cancel, in natural order).

For Cancel to be meaningful, the column read it interrupts must yield the event
loop so the abort message is observed.

## Non-goals

- **Showing the grid in natural order first, then re-sorting** (the issue's
  "option 1"). Rejected: it causes a visible reorder "jump," which goal #3
  forbids. This matches sight's rejection of the same alternative.
- **Cancel for interactive sort/filter** (`handleSetSort` / `handleSetFilters`,
  applied after the grid is up). Out of scope; those keep their single-shot
  reads. Possible follow-up.
- **Interruptible permutation/index computation.** Cancel interrupts the
  *column-reading* phase (the dominant cost). The final synchronous
  `permutation.sort()` and the filter `compact()` scan over nrow remain
  uninterruptible; they are comparatively cheap. Acceptable, documented
  limitation.
- **"Remember but don't auto-apply" semantics.** Cancel means *forget entirely*.
- **A dependency/library bump.** Unlike sight (whose `@jbearak/dta-parser`
  `read_rows` was synchronous `fs.readSync` and had to be made chunked in the
  library), raven's reader is in-repo and its restore reads already iterate Arrow
  record batches via `await getBatch(i)`. Interruptibility is added directly in
  raven's `sort.ts` / `filter.ts`. There is no "Part 1" here.

## Why Cancel works without a library change

Sight needed a library change because `DtaFile.read_rows` ran to completion
synchronously (`fs.readSync`), blocking the host event loop so a `cancelRestore`
message sat unprocessed until the read it targeted had already finished.

Raven differs. `computePermutation` (`sort.ts`) iterates batches with
`for await (const batch of iterateBatches(reader))`, and `computeFilteredIndices`
(`filter.ts`) calls `await reader.getBatch(bi)` per batch. Each `getBatch`
awaits `AsyncRecordBatchFileReader.readRecordBatch(i)` — genuine async I/O on a
cold cache (the restore-on-open case). So the loop already yields between
batches. To make cancellation robust even on a warm batch cache (where the
`await` resolves on a microtask and would not drain the macrotask IPC queue), we
add an explicit `await setImmediate` yield **between batches, only when a signal
is present**. `setImmediate` runs in the check phase after the poll phase, so a
pending webview→host IPC message (the Cancel) is delivered and its handler runs
`controller.abort()` before the next batch's `signal.aborted` check.

## Part 1 — interruptible restore reads (`sort.ts`, `filter.ts`)

### API

```ts
// sort.ts
export function computePermutation(
    reader: ArrowSliceReader,
    keys: readonly SortKey[],
    ctx: SortContext,
    opts?: { signal?: AbortSignal },
): Promise<Uint32Array>;

// filter.ts
export function computeFilteredIndices(
    reader: ArrowSliceReader,
    state: FilterState,
    ctx: FilterContext,
    opts?: { signal?: AbortSignal },
): Promise<Uint32Array | undefined>;
```

The `signal` threads down into every full-column read:

- `sort.ts`: `computePermutation` → `buildSortColumn` →
  `buildNumericSortColumn` / the string/bool variants → the `iterateBatches`
  loop. `iterateBatches` gains an optional signal and performs the per-batch
  check + yield.
- `filter.ts`: `computeFilteredIndices` → `applyEntry` →
  `acceptorFor` / `missingMaskFor` → `loadNumeric` / `loadString` / `loadBool`.
  Each load helper performs the per-batch check + yield.

### Behavior

- **No `signal` (default / existing callers, incl. the viewport `getRows`
  path):** unchanged — no per-batch checks, no yields, byte-identical results.
  This is the critical backward-compat guarantee; all existing sort/filter perf
  and tests are untouched.
- **With `signal`:** at each batch boundary, in order:
  1. If `signal.aborted`, throw `new DOMException('The restore was aborted',
     'AbortError')` (Node provides global `DOMException`).
  2. Process the batch as today.
  3. `await new Promise<void>(resolve => setImmediate(resolve))` to release the
     event loop so a queued abort is observed on the next batch's check.

  A final `signal.aborted` check after the loop, before returning, throws if the
  abort landed on the last batch.

A small shared helper keeps the two files consistent:

```ts
// A single source of truth for "throw if aborted, else yield the loop."
export function checkpoint(signal?: AbortSignal): Promise<void> {
    if (!signal) return Promise.resolve();
    if (signal.aborted) {
        return Promise.reject(
            new DOMException('The restore was aborted', 'AbortError'),
        );
    }
    return new Promise<void>(resolve => setImmediate(resolve));
}
```

`isAbortError(err)` matches on `name === 'AbortError'` (the abort is a
`DOMException`, not an `Error` subclass on every runtime), used by the panel to
distinguish a cancel from a genuine read failure.

### Tests (Part 1)

- **Signal-less equivalence:** `computePermutation` / `computeFilteredIndices`
  with no signal returns identical output to before (covers the fast path).
- **Abort before first batch:** an already-aborted signal rejects with
  `AbortError` having read nothing observable.
- **Abort mid-read:** aborting after the first yield rejects with `AbortError`.
- **Completion with signal but no abort:** identical result to the signal-less
  call (signal presence alone must not change output).

## Part 2 — panel state machine (`panel.ts`)

### Protocol (`messages.ts`)

```ts
// Extension → Webview
| { type: 'restorePending'; panelGeneration: number; restoreId: number;
    sort: boolean; filter: boolean }

// Webview → Extension
| { type: 'cancelRestore'; panelGeneration: number; restoreId: number }
```

`restoreId` is the panel's `generation` captured when `restorePending` is
posted. It is the dedicated handshake key (distinct from the per-message
`panelGeneration`) so a stale or crossed cancel from a prior lifecycle is
dropped at the protocol level. `sort` / `filter` say which prefs are being
applied (for the wording). `restorePending` is posted whenever an applicable
stored pref **exists** for this `panelName × schemaHash` — gated on existence,
not on whether the filter ultimately yields a non-empty survivor set (unknowable
without the read the UI exists to explain).

### State

```ts
private restoreAbort: AbortController | null = null;
private restoring = false;
private restoreId = -1;                       // -1 === no cancellable restore
private sendChain: Promise<void> = Promise.resolve();
```

`sendChain` serializes **both** `sendInit` and `sendReplace` (raven's two
paint-enabling entry points; sight had one `send_metadata`). Without it, a
webview reload during a slow restore starts a concurrent send that overwrites
the shared `restoreAbort`, so a Cancel could abort the wrong restore.

```ts
private sendInit(): Promise<boolean> {
    const next = this.sendChain.catch(() => {}).then(() => this.sendInitImpl());
    // Coerce to void for the chain; callers still get the boolean from `next`.
    this.sendChain = next.then(() => {}, () => {});
    return next;
}
// sendReplace wraps sendReplaceImpl identically, sharing the same chain.
```

### `sendInitImpl` / `sendReplaceImpl` flow

Both share one restore helper. Structure (init shown; replace identical except
the message `type` and the existing `webviewInitialized` guard):

1. Capture `const generation = this.generation; const reader = this.reader;`
2. Load stores (layout, toolbar, sort, filter) as today; bail on
   generation/reader change.
3. `const began = this.maybeBeginRestore(generation, savedSort, savedFilter);`
   — posts `restorePending` before the reads if an applicable pref exists; arms
   `restoreAbort`/`restoreId`/`restoring`; returns whether begun.
4. `const myAbort = began ? this.restoreAbort : null;`
   `const isCancelled = () => myAbort?.signal.aborted === true;`
   (Read cancellation from the **captured** controller, not `this.restoreAbort`,
   which a concurrent send could reassign.)
5. `try { ... } finally { if (began && this.restoreAbort === myAbort) {
   this.restoring = false; this.restoreAbort = null; } }`
   The ownership guard keeps a superseded call from clobbering a restore a
   concurrent refresh started; the `finally` guarantees an early throw cannot
   strand `restoring`.
6. Inside the try:
   - `const sortFailed = await this.restoreSort(savedSort, toolbar, generation,
     reader, myAbort?.signal);`
   - bail if `generation !== this.generation || reader !== this.reader` (a
     refresh/reload supersedes this attempt — leave prefs intact for the queued
     re-send).
   - `let filterFailed = false; if (!isCancelled()) { filterFailed = await
     this.restoreFilter(savedFilter, toolbar, generation, reader,
     myAbort?.signal); bail-if-stale; }`
     (Skip the filter read entirely if the sort read was cancelled.)
   - `if (isCancelled()) this.resetRestoredPrefs();` — undo a sort that
     completed before the cancel landed during the filter read.
   - `this.recomputeEffective();` (or raven's equivalent recompute; see note).
   - Post `init`/`replace` with `sort`/`filter` reflecting current in-memory
     state (EMPTY after a cancel → no chips).
   - `if (!isCancelled() && this.filteredIndices) postFilterApplied(...)`
     (`fromPersistence: true`, as today).
   - `if (!isCancelled() && (sortFailed || filterFailed))` →
     `vscode.window.showWarningMessage("Could not reapply the saved <what> for
     this dataset; it was not applied.")` where `<what>` names only what failed.
   - `if (isCancelled()) await this.forgetPersistedPrefs(generation-derived
     schemaHash);` — persist the forget **after** the post, so a store-write
     failure cannot strand the webview waiting on an `init` it never receives.

### `restoreSort` / `restoreFilter` changes

Today both `catch { return EMPTY }`, silently swallowing every error. They now:

- take an optional `signal` and thread it into `computePermutation` /
  `computeFilteredIndices`;
- return `boolean` — `true` iff a **genuine (non-abort)** failure occurred:

```ts
} catch (err) {
    // Abort → silent natural order. Real failure → natural order, but report
    // so the caller can warn and KEEP the saved pref for next time.
    return !isAbortError(err);
}
```

On a generation/reader change after the await they return `false` (stale, not a
failure). The success path is unchanged except for returning `false`.

### Helpers

- `maybeBeginRestore(generation, savedSort, savedFilter): boolean` — returns
  false if neither an applicable stored sort (keys.length > 0, columns in range)
  nor an applicable stored filter (≥1 entry whose predicate still fits its
  column's current kind, mirroring `restoreFilter`'s keep logic) exists, or if
  persistence is disabled for both. Otherwise arms a fresh `AbortController`,
  sets `restoreId = generation`, `restoring = true`, posts `restorePending`,
  returns true.
- `resetRestoredPrefs()` — synchronous: `restoreId = -1; sort = EMPTY_SORT;
  permutation = undefined; filter = EMPTY_FILTER; filteredIndices = undefined`.
- `consumeRestoreHandshake()` — `restoreId = -1` only (no sort/filter reset).
  Deliberately distinct from `resetRestoredPrefs` (which shares the `-1` line but
  must also clear sort/filter); the two must not be merged.
- `abortAndClearRestore()` — `restoreAbort?.abort(); restoreAbort = null;
  restoring = false; restoreId = -1`. Used by lifecycle-interruption paths.
- `forgetPersistedPrefs(schemaHash)` — `if persistSort:
  sortStore.clear(panelName, hash)` and `if persistFilters:
  filterStore.clear(panelName, hash)`. Raven's stores delete the entry on
  `clear`; that is "forget entirely."

### Message handling

- **`cancelRestore`** → `handleCancelRestore(msg)`:
  - `if (msg.restoreId !== this.restoreId) return;` (stale/consumed id).
  - `if (this.restoring) { this.restoreAbort?.abort(); return; }` — the
    in-flight reads observe the aborted signal and `sendInitImpl` takes its
    cancelled path (forget + natural-order `init`).
  - else (the restore already completed and posted `init` in the cross-window
    race): honor the click as an explicit **clear-and-forget** so it is never
    silently dropped. Synchronously: `resetRestoredPrefs(); generation++;
    rowCache.clear(); recomputeEffective(); postSortApplied(); postFilterApplied()`
    (and an updated `init`/`replace` only if chips must disappear and
    `*Applied` does not already drop them), **then** `await
    forgetPersistedPrefs(...)`. Invalidate (bump generation + clear cache)
    **before** awaiting the store writes so no in-flight `getRows` lands stale
    sorted/filtered rows after the cancel.
- **`webviewReady`** while `this.restoring` → `abortAndClearRestore()` before
  the queued `sendInit` re-runs. Raven re-loads sort/filter from the store on
  every `sendInit`, so there are no one-shot flags to re-arm — the re-send
  re-restores naturally; the abort just lets the serialized chain advance at once
  instead of waiting behind the dropped read.
- **`replace` / refresh to a new dataset** → `abortAndClearRestore()` after the
  generation bump (the bump makes the abandoned restore bail before
  posting/forgetting, so prefs survive; the abort frees the chain).
- **`handleSetSort` / `handleSetFilters`** → `if (this.restoring) return;` (a
  generation bump here would strand the restore with no `init` posted). When not
  restoring, call `consumeRestoreHandshake()` so a delayed `cancelRestore`
  carrying the old id cannot wipe a manually-applied sort/filter.

> Note on raven specifics: raven uses `permutation` / `filteredIndices`
> (undefined === identity) and `EMPTY_SORT` / `EMPTY_FILTER`. The "recompute
> effective" step is whatever raven already does to combine sort+filter for the
> reader (it does not maintain a single `effective_perm` field the way sight
> does; the implementer follows the existing `restoreSort`/`restoreFilter`
> assignment pattern). `postSortApplied` is a new tiny helper mirroring the
> existing `filterApplied` post; if the existing code updates chips purely via
> `init`/`replace`, the late-cancel branch posts a fresh `replace` instead of a
> `sortApplied`/`filterApplied` pair — the implementer picks whichever matches
> the webview's existing chip-update path.

## Part 3 — webview (`webview/App.tsx`, `webview/grid-model.ts`, `styles.css`)

Raven's webview keeps message handling and state in `App.tsx` (no
`use-row-loader.ts` hook). Add:

- State `restorePending: { restoreId: number; sort: boolean; filter: boolean } |
  null` and `restoreCancelling: boolean`, plus a `restoreTimer` ref and a
  `restoreIdRef`.
- On `restorePending`: record `restoreId`; clear `restoreCancelling`; (re)start a
  `RESTORE_DEBOUNCE_MS = 200` timer that sets `restorePending`. **Debounce:**
  only reveal the UI if the signal persists past ~200 ms, so fast files never
  flash it. If a banner is already visible, swap its wording immediately.
- On `init` / `replace`: clear the timer, `restorePending = null`,
  `restoreCancelling = false`, `restoreIdRef = null` (both the normal and
  cancelled paths end by posting `init`/`replace`).
- `cancelRestore()` handler: post `{ type: 'cancelRestore', panelGeneration,
  restoreId }`, set `restoreCancelling = true` (optimistic *"Cancelling…"*).
- Render: while `restorePending` is set and the grid is not yet showing, render —
  in place of the bare `Loading…`, reusing the `toolbar-progress` styling — an
  explanatory line plus an inline **Cancel** button:
  - both → *"Applying your saved sort & filter…"*
  - sort only → *"Applying your saved sort…"*
  - filter only → *"Applying your saved filter…"*
  - while cancelling → *"Cancelling…"* (no button).
- Suppress the bare `Loading…` row-count while the banner is up so it does not
  stack above the explanation.

`grid-model.ts` gains two pure, unit-testable helpers:

```ts
export function describeRestoreMessage(sort: boolean, filter: boolean): string;
// 'Applying your saved sort & filter…' | '…sort…' | '…filter…'

// Returns '' while a restore banner is showing, else the normal row count.
export function describeToolbarRowCount(
    nrow: number, range: VisibleRange, loading: boolean, restoreActive: boolean,
): string;
```

`styles.css` gains `.toolbar-restore` (flex row, `min-width: 0`, ellipsis on the
message span) and `.restore-cancel` (secondary button), matching sight's CSS
adapted to raven's existing toolbar variables.

## Tests

Ported from sight's `restore-cancel.test.ts` (19 tests) and the `grid-model`
helper tests, adapted to raven method/field names. Headless: construct a
`DataViewerPanel` via `Object.create(DataViewerPanel.prototype)` with stubbed
`reader`, stores, and `panel.webview.postMessage`, then drive the private
methods (the sight suite does exactly this).

Extension-side cases:
1. **maybeBeginRestore** posts `restorePending` + arms when prefs apply; no-op
   when none stored; sort-only vs filter-only flags.
2. **Completed sort + cancelled filter** ends fully natural — `permutation`
   undefined, `filteredIndices` undefined, `init` carries no chips, no
   `filterApplied`, stores cleared. (Guards against the naive "only omit
   stored_sort" bug.)
3. **Normal completion** applies + ships saved prefs; `restorePending` precedes
   `init`; nothing forgotten; `filterApplied` posted when filtered.
4. **Throws before posting `init`** → `restoring` cleared, `restoreAbort` nulled
   (the `finally`).
5. **Serialization** — two overlapping sends post exactly one `restorePending`.
6. **Generation bump mid-restore** → no `init` posted, prefs intact.
7. **Real read error vs cancel** — non-`AbortError` failure opens natural order,
   warns (naming only what failed), and **keeps** stores; cancel **clears**
   them.
8. **Cancel suppresses the failure warning** — a real failure before a cancel →
   no popup, prefs forgotten.
9. **handleCancelRestore** — ignores stale id; aborts in-flight on match; late
   cancel after completion = clear-and-forget (+ duplicate late cancel ignored,
   id consumed).
10. **Late-cancel ordering** — generation bumped + cache cleared **before**
    awaiting store writes.
11. **webviewReady during restore** aborts the in-flight restore so the chain
    advances; **refresh during restore** aborts before discarding the
    controller.
12. **handleSetSort / handleSetFilters** consume `restoreId` (a later stale
    cancel cannot clear manual prefs) and are no-ops while restoring.
13. **Stale restore state does not leak** — a later `sendInit` with no restore
    begun does not forget manually-applied prefs.

Part-1 cases: the four `sort.ts` / `filter.ts` signal cases above.

Webview-side: `describeRestoreMessage` wording per flag combo;
`describeToolbarRowCount` returns '' while restore active, else the normal label.

## Docs

- `docs/data-viewer.md` — describe the restore banner + Cancel behavior, the
  forget-on-cancel semantics, and the keep-prefs-on-genuine-error distinction.
- This spec under `docs/superpowers/specs/`.

## Sequence summary

Normal reopen with saved prefs:

```
webview: webviewReady
host:    restorePending {restoreId, sort, filter}   ← webview shows explanation after 200ms
host:    [chunked, cancellable column reads]
host:    init (sort/filter set)                      ← webview clears banner, renders sorted
host:    filterApplied (if filtered)
```

Cancelled reopen:

```
webview: webviewReady
host:    restorePending {restoreId, sort, filter}
webview: [Cancel] → cancelRestore {restoreId}
host:    restoreId matches & restoring → controller.abort()
host:      reads reject AbortError → reset in-memory sort+filter, recompute, prefs forgotten
host:    init (no sort/filter)                       ← webview renders natural order, no chips
```
