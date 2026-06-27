# Data viewer: explain (and let users cancel) the saved sort/filter restore (#519)

Port of [sight#228](https://github.com/jbearak/sight/pull/228) into raven's
data viewer, adapted to raven's architecture.

> **Revision 3** — folds in two rounds of adversarial spec review (codex). The
> key corrections: `restoreId` is a dedicated monotonic counter, **not** the
> generation (raven's `webviewReady` does not bump `generation`, so reusing it
> would alias restores across reloads); reload/refresh paths **bump generation
> AND abort** so the in-flight send bails as *stale* (keeping prefs) rather than
> as *cancelled* (forgetting them); the `sendInit`/`sendReplace` serialization
> wraps only the public entry points while internal delegation calls the *impl*
> (no self-deadlock); the late clear-and-forget posts a full natural-order
> `replace` so the webview adopts the bumped generation; `maybeBeginRestore`'s
> applicability mirrors raven's *actual* restore guards (column-in-range +
> non-empty), not sight's predicate-fits-kind logic. See "Review notes" at the
> end for the finding-by-finding mapping.

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
- **Fully interruptible restore.** Cancel interrupts the *column-loading* phase
  at **Arrow record-batch granularity** (the dominant cost). The following
  remain synchronous and uninterruptible once entered, and are accepted,
  documented limitations:
  - a single oversized record batch (cancel is observed only at its end);
  - `filter.ts` `applyEntry`'s per-row mask scan and regex/string predicate
    evaluation over the loaded column;
  - the dictionary-code set building after the batch loop in both files;
  - the final `permutation.sort()` (sort) and `compact()` (filter) over nrow.

  These are comparatively cheap relative to the column I/O; cancel latency is
  bounded by "the rest of the current column read + the synchronous tail," not
  "the whole restore."
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
(`filter.ts`) loops `for (let bi = 0; bi < numBatches; bi++) { await
reader.getBatch(bi) }`. On a **cold** batch cache (the restore-on-open case)
`getBatch` awaits `AsyncRecordBatchFileReader.readRecordBatch(i)` — genuine async
I/O — so the loop already yields between batches. On a **warm** cache `getBatch`
returns synchronously (`arrow-reader.ts` LRU), so the `await` only drains a
microtask and would *not* deliver a macrotask IPC message. To make cancellation
robust in both cases we add an explicit `await setImmediate` yield **between
batches, only when a signal is present**. `setImmediate` schedules a check-phase
callback that runs after the poll phase, so a pending webview→host IPC message
(the Cancel) is delivered and its handler runs `controller.abort()` before the
next batch's abort check.

> The IPC-ordering reasoning is a claim about Node's event-loop phases, not
> something unit tests can prove. The test plan therefore includes a real
> extension-host integration test (open a panel with a persisted sort on a large
> frame, click Cancel, assert natural-order `init` + forgotten prefs) in
> addition to the unit tests.

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
  loop.
- `filter.ts`: `computeFilteredIndices` → `applyEntry` →
  `acceptorFor` / `missingMaskFor` → `loadNumeric` / `loadString` / `loadBool`.

### Behavior and checkpoint placement

Two tiny shared helpers are the single source of truth:

```ts
export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new DOMException('The restore was aborted', 'AbortError');
    }
}

export function yieldToEventLoop(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
}
```

Each batch loop is instrumented as:

```
for (each record batch) {
    throwIfAborted(signal);          // (a) catch an abort raised since last yield
    ...process this batch...
    if (signal) await yieldToEventLoop();   // (b) release the loop so a Cancel lands
}
throwIfAborted(signal);              // (c) catch an abort during the final batch
```

- **(a) at the top of each iteration** catches an already-aborted signal *before*
  any read (so an abort before the first batch reads nothing) and an abort that
  landed during the previous batch's processing/yield.
- **(b) at the bottom, only when `signal` is set** keeps the no-signal path
  byte-identical (no extra turns) and releases the loop exactly once per batch on
  the restore path.
- **(c) after the loop** catches an abort that landed during the last batch.

The `iterateBatches` generator in `sort.ts` is the natural home for the sort-side
instrumentation; the filter-side load helpers (`loadNumeric` etc.) instrument
their own `for (bi …)` loops. Throwing propagates up through
`computePermutation` / `computeFilteredIndices` to the panel, which classifies it
with:

```ts
export function isAbortError(err: unknown): boolean {
    return typeof err === 'object' && err !== null
        && (err as { name?: unknown }).name === 'AbortError';
}
```

(Matched on `name` because the abort is a `DOMException`, not an `Error`
subclass on every runtime.)

### Backward-compat invariant

With no `signal` there are **no** `throwIfAborted` effects (the guard is cheap
and never throws) and **no** yields. The viewport `getRows` path passes no
signal and is byte-identical. All existing sort/filter perf and tests are
untouched.

### Tests (Part 1)

- **Signal-less equivalence:** `computePermutation` / `computeFilteredIndices`
  with no signal returns identical output to before (covers the fast path).
- **Signal-but-no-abort equivalence:** completion with a never-aborted signal
  returns identical output (signal presence alone must not change results).
- **Abort before first batch:** an already-aborted signal rejects with
  `AbortError`.
- **Abort mid-read:** aborting after the first yield rejects with `AbortError`.

## Part 2 — panel state machine (`panel.ts`)

### Protocol (`messages.ts`)

```ts
// Extension → Webview
| { type: 'restorePending'; panelGeneration: number; restoreId: number;
    sort: boolean; filter: boolean }

// Webview → Extension
| { type: 'cancelRestore'; panelGeneration: number; restoreId: number }
```

`restoreId` is a **dedicated monotonic counter** (`++this.restoreSeq`), assigned
when `restorePending` is posted. It is *not* the `generation`: raven bumps
`generation` only on dataset `replace()` (`panel.ts:159`), **not** on a
`webviewReady` reload (`panel.ts:442`), so reusing `generation` would alias two
different restore attempts across a reload and let a stale `cancelRestore` abort
or clear the wrong one. The counter is monotonic and unique per restore, so a
crossed/stale cancel never matches a newer restore. `sort` / `filter` say which
prefs are being applied (for the wording). `restorePending` is posted whenever an
applicable stored pref **exists** for this `panelName × schemaHash` — gated on
existence, not on whether the filter ultimately yields a non-empty survivor set
(unknowable without the read the UI exists to explain).

### State

```ts
private restoreAbort: AbortController | null = null;
private restoring = false;
private restoreId = -1;          // -1 === no active cancellable restore
private restoreSeq = 0;          // monotonic source of restoreId
private sendChain: Promise<void> = Promise.resolve();
// Last active toolbar posted to the webview, captured so the late
// clear-and-forget path can rebuild a `replace` without an async store
// load. (Raven has no persistent host-side toolbar field today; the
// toolbar is otherwise a local in sendInit/sendReplace, panel.ts:217,281.)
private lastToolbar: ToolbarState | undefined;
```

`sendInitImpl` / `sendReplaceImpl` set `this.lastToolbar = activeToolbar` just
before posting `init` / `replace`. A small `currentSchemaHash()` helper returns
`schemaHash(this.reader.schema.columns)` for the forget/late-cancel paths (raven
recomputes the hash from the live reader rather than threading the `layoutHash`
local out of the send methods).

### Serialization without self-deadlock

`sendChain` serializes the two paint-enabling entry points so two restores never
overlap (a webview reload during a slow restore must not start a concurrent send
that overwrites `restoreAbort`). The wrapping is applied to the **public** methods
only; the existing internal delegation in `sendReplace` (which calls `sendInit`
when uninitialized, `panel.ts:259`) is rewritten to call the **impl** directly so
it does not await a job queued behind itself:

```ts
private sendInit(): Promise<boolean> {
    const next = this.sendChain.catch(() => {}).then(() => this.sendInitImpl());
    this.sendChain = next.then(() => {}, () => {});
    return next;
}
private sendReplace(): Promise<void> {
    const next = this.sendChain.catch(() => {}).then(() => this.sendReplaceImpl());
    this.sendChain = next.then(() => {}, () => {});
    return next;
}
// inside sendReplaceImpl: if (!this.webviewInitialized) { await this.sendInitImpl(); return; }
```

### `sendInitImpl` / `sendReplaceImpl` flow

Both share one restore helper. Structure (init shown; replace identical except
the message `type` and the `webviewInitialized` guard above):

1. `const generation = this.generation; const reader = this.reader;`
2. Load stores (layout, toolbar, sort, filter) as today; bail on
   generation/reader change.
3. `const began = this.maybeBeginRestore(savedSort, savedFilter);` — posts
   `restorePending` before the reads if an applicable pref exists; arms
   `restoreAbort` / `restoreId` / `restoring`; returns whether begun.
4. `const myAbort = began ? this.restoreAbort : null;`
   `const isCancelled = () => myAbort?.signal.aborted === true;`
   (Cancellation is read from the **captured** controller, not
   `this.restoreAbort`, which a concurrent send could reassign.)
5. `try { … } finally { if (began && this.restoreAbort === myAbort) {
   this.restoring = false; this.restoreAbort = null; } }`
   The ownership guard keeps a superseded call from clobbering a restore a
   concurrent refresh started; the `finally` guarantees an early throw cannot
   strand `restoring`.
6. Inside the try, **generation check before cancel handling** (this ordering is
   load-bearing — see below):
   - `const sortFailed = await this.restoreSort(savedSort, toolbar, generation,
     reader, myAbort?.signal);`
   - `if (generation !== this.generation || reader !== this.reader) return;`
     (a refresh/reload superseded this attempt — bail *stale*, leaving prefs
     intact for the queued re-send).
   - `let filterFailed = false;`
     `if (!isCancelled()) { filterFailed = await this.restoreFilter(savedFilter,
     toolbar, generation, reader, myAbort?.signal);
     if (generation !== this.generation || reader !== this.reader) return; }`
     (Skip the filter read entirely if the sort read was cancelled.)
   - `if (isCancelled()) this.resetRestoredPrefs();` — undo a sort that completed
     before the cancel landed during the filter read.
   - recompute the effective order (raven's existing combine step; see note).
   - Post `init` / `replace`. **The message's `sort` / `filter` come from the
     in-memory `this.sort` / `this.filter`** (which `restoreSort` / `restoreFilter`
     assign on success and `resetRestoredPrefs` clears) — *not* from a returned
     `SortState`. After a cancel/failure they are `EMPTY_SORT` / `EMPTY_FILTER`,
     so no chips render. (This is the wiring change implied by `restoreSort` /
     `restoreFilter` now returning a boolean instead of the state.)
   - `if (!isCancelled() && this.filteredIndices) postFilterApplied(...)`
     (`fromPersistence: true`, exactly as today).
   - `if (!isCancelled() && (sortFailed || filterFailed))` →
     `vscode.window.showWarningMessage("Could not reapply the saved <what> for
     this dataset; it was not applied.")` where `<what>` is `"sort"`,
     `"filter"`, or `"sort and filter"` — naming only what actually failed.
   - `if (isCancelled()) await this.forgetPersistedPrefs(layoutHash);` — persist
     the forget **after** the post, so a store-write failure cannot strand the
     webview waiting on an `init` it never receives.

#### Why the generation check must precede the cancel check

A user Cancel and a reload/refresh **both** abort `restoreAbort`, so
`isCancelled()` is true in both. The *only* discriminator is `generation`:

- **User Cancel** does not bump generation → the generation check passes → the
  cancelled path runs → prefs forgotten. (Intended.)
- **Reload/refresh** bumps generation (see Message handling) → the generation
  check fails first → the send bails *stale* before the cancel path → prefs
  **kept**. (Intended — a reload must not forget the user's prefs.)

This mirrors sight, whose `ready` path bumped generation for the same reason. The
correction for raven is that we must *add* the generation bump on the reload
path, because raven's `webviewReady` does not bump it today.

### Helpers

- `maybeBeginRestore(savedSort, savedFilter): boolean` — returns false unless an
  **applicable** stored pref exists, gating on raven's *actual* restore guards
  (not sight's predicate-fits-kind logic, which raven's restore does not do):
  - applicable sort ⟺ `persistSort` && `savedSort.keys.length > 0` && every
    `key.columnIndex` is in `[0, columns.length)` (matches `restoreSort`'s
    early-returns);
  - applicable filter ⟺ `persistFilters` && `savedFilter.entries.length > 0` &&
    **every** entry's `columnIndex` is in range && **at least one** entry is
    `enabled`. The "every entry in range" clause matches `restoreFilter`, which
    rejects the *entire* saved filter if **any** entry — enabled or not — is out
    of range (`panel.ts:380-382`); the "≥1 enabled" clause matches
    `computeFilteredIndices`, which filters to enabled entries and does the heavy
    read only if at least one survives (`filter.ts:48-49`). Together they make
    the banner appear iff a heavy filter read will actually run — no false
    positive for an all-disabled or any-out-of-range saved filter (which
    `restoreFilter` would silently drop before reading).

  If neither applies, return false. Otherwise arm a fresh `AbortController`, set
  `restoreId = ++this.restoreSeq`, `restoring = true`, post `restorePending {
  panelGeneration: generation, restoreId, sort, filter }`, return true.
- `resetRestoredPrefs()` — synchronous: `restoreId = -1; sort = EMPTY_SORT;
  permutation = undefined; filter = EMPTY_FILTER; filteredIndices = undefined`.
- `consumeRestoreHandshake()` — `restoreId = -1` only (no sort/filter reset).
  Deliberately distinct from `resetRestoredPrefs` (shares the `-1` line but must
  also clear sort/filter); the two must not be merged.
- `abortAndClearRestore()` — `restoreAbort?.abort(); restoreAbort = null;
  restoring = false; restoreId = -1`. Used by lifecycle-interruption paths.
- `forgetPersistedPrefs(hash)` — `if persistSort: sortStore.clear(panelName,
  hash)` and `if persistFilters: filterStore.clear(panelName, hash)`. Raven's
  stores delete the entry on `clear`; that is "forget entirely."
- `postReplaceNaturalOrder(generation)` — builds and posts a `replace` from
  in-memory `this.columns` / `this.layout` / `this.dictionaries` /
  `this.lastToolbar ?? this.defaultToolbar()` / `currentSchemaHash()` with
  `EMPTY_SORT` / `EMPTY_FILTER` at the given (already-bumped) generation, used by
  the late clear-and-forget so the webview adopts the new generation and drops
  chips coherently. (Requires `webviewInitialized`, always true on the late path
  since the restore already posted `init`/`replace`.)

### Message handling

- **`cancelRestore`** → `handleCancelRestore(msg)`:
  - `if (msg.restoreId !== this.restoreId) return;` (stale/consumed id).
  - `if (this.restoring) { this.restoreAbort?.abort(); return; }` — the in-flight
    reads observe the aborted signal and `sendInitImpl` takes its cancelled path
    (forget + natural-order `init`). Generation is *not* bumped here, so the
    in-flight send does **not** bail stale and correctly runs the cancel path.
  - else (the restore already completed and posted `init`/`replace` in the
    cross-window race): honor the click as an explicit **clear-and-forget** so it
    is never silently dropped. In order: `resetRestoredPrefs(); this.generation++;
    postReplaceNaturalOrder(this.generation);` (a full natural-order `replace`,
    so the webview adopts the bumped generation — a bare `sortApplied`/
    `filterApplied` would leave the webview on the old generation and its
    subsequent messages would be dropped by `panel.ts:540`); **then** `await
    this.forgetPersistedPrefs(currentSchemaHash())`. The `generation++` (before
    the await) is the invalidation: any in-flight `getRows` reply computed under
    the old effective permutation is captured at the old generation and dropped
    by `panel.ts:540` / by the webview (which adopts the new generation from the
    `replace`). Raven has **no host-side row cache** (the row cache is
    webview-side, `App.tsx:311`, and is cleared when the webview applies
    `replace`), so there is nothing host-side to clear — only the generation bump
    and the `replace` are needed.
- **`webviewReady`** (`panel.ts:442`): if `this.restoring`, treat as a
  lifecycle interruption — `this.generation++; abortAndClearRestore();`
  **before** `await this.sendInit()`. The generation
  bump makes the abandoned in-flight restore bail *stale* (prefs kept); the abort
  frees the serialized chain so the re-send (which re-reads from the store and
  re-restores, since raven has no one-shot flags) can post its own
  `restorePending` immediately instead of waiting behind the dropped read.
- **`replace()`** (`panel.ts:153`) already bumps generation at line 159; add
  `this.abortAndClearRestore();` right after the bump so any in-flight restore
  from the previous dataset bails stale and the chain advances before
  `sendReplace()`.
- **`handleSetSort` / `handleSetFilters`** → `if (this.restoring) return;` (a
  generation bump here would strand the restore with no `init` posted). When not
  restoring, call `consumeRestoreHandshake()` so a delayed `cancelRestore`
  carrying the old id cannot wipe a manually-applied sort/filter.

> Note on raven specifics: raven uses `permutation` / `filteredIndices`
> (undefined === identity) and `EMPTY_SORT` / `EMPTY_FILTER`. "Recompute
> effective" is raven's existing `composeEffective()` path (`panel.ts:558`);
> there is no single `effective_perm` field as in sight. `restoreSort` /
> `restoreFilter` already assign `this.sort` / `this.permutation` /
> `this.filter` / `this.filteredIndices`; the only behavioral change is they now
> additionally return a genuine-failure boolean and accept a `signal`.

### `restoreSort` / `restoreFilter` changes

Today both `catch { return EMPTY }`, silently swallowing every error. They now:

- take an optional `signal` and thread it into `computePermutation` /
  `computeFilteredIndices` (as `{ signal }`);
- still set `this.sort` / `this.permutation` (resp. `this.filter` /
  `this.filteredIndices`) exactly as today on success, and reset them to EMPTY at
  the top (unchanged);
- return `boolean` — `true` iff a **genuine (non-abort)** failure occurred:

```ts
} catch (err) {
    // Abort → silent natural order. Real failure → natural order, but report
    // so the caller can warn and KEEP the saved pref for next time.
    return !isAbortError(err);
}
```

On a generation/reader change after the await they return `false` (stale, not a
failure) and leave state as-is for the caller's stale check to discard. The
success path returns `false`.

## Part 3 — webview (`webview/App.tsx`, `webview/grid-model.ts`, `styles.css`)

Raven's webview keeps message handling and state in `App.tsx` (no
`use-row-loader.ts` hook). Add:

- State `restorePending: { restoreId: number; sort: boolean; filter: boolean } |
  null`, `restoreCancelling: boolean`, plus a `restoreTimer` ref and a
  `restoreIdRef`.
- On `restorePending`: record `restoreId` in the ref; clear `restoreCancelling`;
  (re)start a `RESTORE_DEBOUNCE_MS = 200` timer that sets `restorePending`.
  **Debounce:** only reveal the UI if the signal persists past ~200 ms, so fast
  files never flash it. If a banner is already visible (a prior restore whose
  debounce elapsed), swap its wording immediately.
- On `init` / `replace`: clear the timer, `restorePending = null`,
  `restoreCancelling = false`, `restoreIdRef = null` (both the normal and
  cancelled/late-cancel paths end by posting `init`/`replace`).
- `cancelRestore()` handler: if `restoreIdRef` is null, no-op; else post
  `{ type: 'cancelRestore', panelGeneration, restoreId }` and set
  `restoreCancelling = true` (optimistic *"Cancelling…"*).
- Cleanup: clear the debounce timer on unmount.
- Render: while `restorePending` is set, render — in place of the bare
  `Loading…`, reusing the existing toolbar-progress styling — an explanatory line
  plus an inline **Cancel** button:
  - both → *"Applying your saved sort & filter…"*
  - sort only → *"Applying your saved sort…"*
  - filter only → *"Applying your saved filter…"*
  - while `restoreCancelling` → *"Cancelling…"* (no button).
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

Ported from sight's `restore-cancel.test.ts` and the `grid-model` helper tests,
adapted to raven method/field names. Headless: construct a `DataViewerPanel` via
`Object.create(DataViewerPanel.prototype)` with stubbed `reader`, stores, and
`webviewPanel.webview.postMessage`, then drive the private methods.

Extension-side cases:
1. **maybeBeginRestore** posts `restorePending` + arms when prefs apply; no-op
   when none stored / persistence disabled / columns out of range; sort-only vs
   filter-only flags; `restoreId` increments per call.
2. **Completed sort + cancelled filter** ends fully natural — `permutation`
   undefined, `filteredIndices` undefined, `init` carries `EMPTY` sort/filter, no
   `filterApplied`, stores cleared. (Guards against the naive "only omit
   stored_sort" bug.)
3. **Normal completion** applies + ships saved prefs; `restorePending` precedes
   `init`; nothing forgotten; `filterApplied` posted when filtered.
4. **Throws before posting `init`** → `restoring` cleared, `restoreAbort` nulled
   (the `finally`).
5. **Serialization** — two overlapping sends post exactly one `restorePending`;
   `sendReplaceImpl` delegating to `sendInitImpl` when uninitialized does not
   deadlock.
6. **Reload bumps generation → keeps prefs (not forgotten).** A `webviewReady`
   during an in-flight restore bumps generation + aborts; the in-flight send
   bails stale; stores are **unchanged** (contrast with user-cancel). This is the
   raven-specific regression codex flagged.
7. **Generation bump mid-restore** (refresh) → no `init` posted, prefs intact,
   in-flight controller aborted before discard.
8. **Real read error vs cancel** — non-`AbortError` failure opens natural order,
   warns (naming only what failed), and **keeps** stores; cancel **clears** them.
9. **Cancel suppresses the failure warning** — a real failure before a cancel →
   no popup, prefs forgotten.
10. **handleCancelRestore** — ignores stale/mismatched `restoreId`; aborts
    in-flight on match; late cancel after completion = clear-and-forget that
    bumps generation **before** awaiting the store writes, posts a natural-order
    `replace` (asserts the posted `replace` carries the bumped generation and
    EMPTY sort/filter), and is a no-op on a duplicate (id consumed).
11. **handleSetSort / handleSetFilters** consume `restoreId` (a later stale
    cancel cannot clear manual prefs) and are no-ops while restoring.
12. **Stale restore state does not leak** — a later `sendInit` that begins no
    restore does not forget manually-applied prefs (the captured `myAbort` is
    null, so `isCancelled()` is false even if a stale aborted controller lingers
    on the instance).

Part-1 cases: the four `sort.ts` / `filter.ts` signal cases above.

Webview-side: `describeRestoreMessage` wording per flag combo;
`describeToolbarRowCount` returns '' while restore active, else the normal label.

Integration (vscode test harness, `editors/vscode/src/test`): open a panel with a
persisted sort on a large frame; assert `restorePending` precedes `init` and,
without cancel, the restored order is applied; then a second panel where a
`cancelRestore` posted during the restore yields a natural-order `init` with no
chips and forgotten prefs. This is the only test that exercises the real
event-loop/IPC ordering the "Why Cancel works" section relies on.

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
host:    init (EMPTY sort/filter)                    ← webview renders natural order, no chips
```

## Review notes (adversarial review — codex)

Findings from the round-1 spec review and how this revision resolves them:

1. **`webviewReady` mistaken for user Cancel** (High) — reload now bumps
   generation; the in-flight send bails *stale* before the cancel path (generation
   check precedes the cancel check). Prefs kept. Test #6.
2. **`restoreId = generation` not unique** (High) — `restoreId` is now a
   dedicated monotonic `restoreSeq`, independent of generation. Protocol section.
3. **`sendChain` self-deadlock via `sendReplace → sendInit`** (High) — wrapping
   is on the public methods only; internal delegation calls `sendInitImpl`
   directly. Serialization section + test #5.
4. **Late clear-and-forget strands the webview on an old generation** (High) —
   the late path posts a full natural-order `replace` (`postReplaceNaturalOrder`)
   so the webview adopts the bumped generation. Message handling + test #10.
5. **`maybeBeginRestore` applicability diverges from real restore** (High) —
   gating now mirrors raven's actual guards (column-in-range + non-empty +
   enabled), not sight's predicate-fits-kind logic. Helpers section.
6. **Interruptibility granularity overstated** (Med-High) — non-goals now
   enumerate the synchronous tails (single large batch, per-row mask scan, regex,
   dictionary-set building, final sort/compact) as accepted limitations.
7. **IPC-ordering claim unprovable by unit tests** (Med-High) — added an
   extension-host integration test; the claim is scoped as event-loop-phase
   reasoning, not a unit-test assertion.
8. **Return-shape wiring underspecified** (Med) — the `init`/`replace` message
   now explicitly reads `sort`/`filter` from in-memory `this.sort`/`this.filter`;
   `restoreSort`/`restoreFilter` return only the failure boolean.
9. **Checkpoint ordering underspecified** (Med) — pinned to top-of-iteration
   `throwIfAborted`, bottom-of-iteration `yieldToEventLoop` (signal only), and a
   post-loop `throwIfAborted`.

Round-2 review (after Revision 2) confirmed findings 1–4 resolved and raised
three more, all addressed in Revision 3:

10. **`maybeBeginRestore` filter guard still mismatched** (High) — the guard now
    requires *every* entry in range (matching `restoreFilter`'s all-or-nothing
    reject, `panel.ts:380-382`) **and** ≥1 enabled (matching the actual heavy
    read), so the banner cannot false-positive on a saved filter that
    `restoreFilter` would silently drop.
11. **`postReplaceNaturalOrder` toolbar/schemaHash source unspecified** (Med) —
    added a `lastToolbar` field (set before each post) and a `currentSchemaHash()`
    helper; the helper now names exact sources.
12. **Phantom host-side `rowCache`** (Low) — removed; raven's row cache is
    webview-side and self-clears on `replace`. The generation bump alone is the
    host-side invalidation.
```
