# Data Viewer

Date: 2026-05-08
Status: Draft for review

## Problem

When R users call `View(df)`, Raven has no built-in viewer; they fall back to
the [REditorSupport](https://github.com/REditorSupport/vscode-R) data viewer,
which loads the entire frame into the webview, hangs on large data, and
performs poorly on anything past a few hundred thousand rows.

A second precedent — Sight's data browser for Stata `.dta` files — handles
multi-gigabyte datasets smoothly because it (a) renders a virtualized grid and
(b) reads slices from a slice-friendly on-disk format on demand instead of
shipping the whole dataset to the webview. We want the same efficiency for R
data frames.

## Goals / Non-Goals

Goals:

1. Override `View()` so calls in the Raven-managed R terminal open a Raven
   data viewer panel instead of REditorSupport's, with no setup beyond
   installing the `arrow` R package.
2. Support `data.frame` (including `tibble` and `data.table` subclasses) and
   `matrix`. Other classes raise an error in R, mirroring Positron:
   `` Can't `View()` an object of class `numeric` ``.
3. Render a virtualized grid that scales to gigabyte-class datasets without
   loading whole columns into RAM.
4. Preserve and surface Stata-style metadata when present: variable labels
   (column-level `label` attribute) in the column-header tooltip, and value
   labels (haven `labels` attribute or factor levels) via a Labels toggle.
5. Provide a Format toggle with a digits dropdown for global rounding of
   numeric columns.
6. v1 grid features: column resize (persisted), column show/hide (persisted),
   row numbers + sticky header/first column, range-selection copy as TSV.
7. Keep the Rust LSP server untouched. The data viewer lives entirely in the
   VS Code extension's Node process plus the R bootstrap profile.

Non-goals for v1:

- File-explorer integration (open `.rds`, `.parquet`, `.feather`, `.dta`
  directly). v1 is `View()`-only.
- Sort, filter, search.
- Per-column Stata format strings (`%9.2f`-style). The format metadata is
  *captured* into the Arrow file but not honored; v1 renders the global
  digits dropdown only.
- Editing cells, adding/removing rows or columns, re-typing columns.
- A standalone CLI or out-of-VS-Code surface.
- Multi-range selection or row-/column-only selection by clicking gutter or
  header.
- Auto-installation of the `arrow` package.

## Architecture

### Process boundaries

```text
R bootstrap profile  --POST /view-data-->  Extension session server (loopback)
                                                |
                                                v
                                           DataViewerManager
                                                |
                                                v
                                           DataViewerPanel  <--postMessage-->  Webview (Svelte)
                                                |
                                                v
                                           ArrowSliceReader  (apache-arrow)
                                                |
                                                v
                                           <globalStorage>/data-viewer/<panel>.arrow
```

Everything except the R side runs in the **extension Node process** — no Rust
LSP involvement. The data viewer is independent of LSP startup, identical to
how the plot viewer works.

### Trigger and panel lifecycle

The Raven bootstrap profile (loaded via `R_PROFILE_USER`, the same mechanism
the plot bridge uses) gains a section defining `View` in `globalenv()` after
the user's `.Rprofile` has been sourced.

**Ordering inside the bootstrap matters.** The current bootstrap is one
`local({...})` block with several `return(invisible(NULL))` early exits when
`httpgd` is missing or fails to start. The data-viewer install must not be
gated on the plot bridge succeeding. Two changes:

- The `View()` install runs **before** the plot bridge, in its **own**
  `local({...})` block, so plot-bridge early returns can never short-circuit
  it.
- The data viewer requires the `arrow` package; if `arrow` is unavailable,
  the View() install logs once via `message()` and is skipped — but
  the rest of the bootstrap (including the plot bridge) still runs.

The `View()` override:

1. Resolves the panel name from the call:
   - If a second argument is supplied (`View(x, "title")`), use it.
   - Otherwise use `deparse1(substitute(x), collapse = " ")` truncated to
     **256 characters** with a trailing `…` if longer. The cap is a guard
     against pathological deparse output; VS Code's tab UI handles visual
     ellipsis.
2. Dispatches by class:
   - `is.data.frame(x) || is.matrix(x)` → serialize and POST `/view-data`.
   - Otherwise → `stop("Can't `View()` an object of class `", paste(class(x), collapse = "/"), "`")`.
3. Returns `invisible(NULL)`.

The POST body is intentionally tiny: `{ sessionId, panelName, filePath,
nrow }`. **Schema and column metadata are read directly from the Arrow
file by the extension**, not shipped over HTTP. There is no `schemaJson`
field; the 64 KiB body cap inherited from the plot session server is
sufficient and stays unchanged.

The extension matches by `panelName` (not `sessionId`). Calling
`View(mtcars)` from any session reuses the `mtcars` tab. The replace
algorithm is single-step and serialized through `DataViewerManager`:

1. The manager processes `view-data-requested` events strictly in order on
   Node's event loop.
2. On a name collision, the manager `await`s the existing panel's
   close-and-replace step (it is in-process and synchronous from the
   manager's perspective; no timeout is needed).
3. Only one writer can be installed at a time per `panelName`. The "later
   writer wins" rule is therefore literal — no race window.

This eliminates the spec's earlier ambiguity about a "1 s timeout then
force" fallback.

### Storage format

Arrow IPC (Feather v2) via the R `arrow` package:

```r
arrow::write_feather(x, file, chunk_size = 65536)
```

Properties this gives us:

- Cross-language: mature readers in JavaScript (`apache-arrow`) and Rust
  (`arrow-rs`).
- Memory-mappable, columnar, with built-in dictionary encoding (free
  factor support).
- Schema-level and column-level KV metadata (used for our R type info and
  Stata-style labels).
- Chunked: ~65 k-row record batches enable batch-level seek without loading
  the whole file.

Pre-encoding rules in R (executed in the bootstrap, before `write_feather`):

| R type / class | Arrow encoding | Notes |
|---|---|---|
| `integer`, `double` | int32 / float64 | NaN preserved; ±Inf preserved |
| `logical` | bool | NA preserved |
| `character` | utf8 |  |
| `factor` | dictionary<int32, utf8> | `arrow` does this natively |
| `Date` | date32 |  |
| `POSIXct` | timestamp[us, tz] | tz pulled from `attr(x, "tzone")` |
| `haven_labelled` | encoded as its underlying storage type (`int32`/`float64` for `<dbl>`, `utf8` for `<chr>`) | Class is stripped before write; labels flow into column KV metadata, not into the cell stream |
| `matrix` | `as.data.frame(x)`; rownames included as a leading `rowname` utf8 column **iff** `dimnames(m)[[1]]` is non-`NULL` and not equal to `as.character(seq_len(nrow(m)))` (i.e., not auto-generated 1..N) | Auto-generated rownames are redundant with the viewer's own row-number gutter |
| `integer64` (bit64) | int64 | Honored if the package is loaded |
| `complex`, `raw`, S4, ALTREP whose `as.character` is expensive | utf8 via `format()` with a hard **1 KiB** per-cell truncation (trailing `…`) | Bounded so a single pathological cell can't blow up the writer |
| List-columns (e.g. tibble nested cols, sf geometry) | utf8 via `format()` per cell with the same 1 KiB cap | Same rationale; nested types are not first-class in v1 |

### Schema metadata

The Arrow file is the single source of truth for schema and metadata; the
extension reads it on open. Per-column KV metadata:

- `raven.variable_label` — string. Pulled from `attr(col, "label")`, the
  convention used by `haven`, `foreign`, and `readstata13`.
- `raven.value_labels` — JSON `{"<num>": "<label>", ...}`. Pulled from
  `attr(col, "labels")` (haven) or `attr(col, "value.labels")` (foreign), or
  synthesized from `levels()` for factors.
- `raven.original_class` — original R class chain (e.g.
  `"haven_labelled/vctrs_vctr/double"`) so the viewer can show accurate type
  chips.
- `raven.format` — Stata-style format string from `attr(col, "format.stata")`
  when present. **Captured but unused in v1.**

Schema-level KV: `raven.nrow`, `raven.created_unix`, `raven.r_session_id`.

### Wire format for cells

Row payloads flow extension → webview as JSON. Strict JSON has no
representation for `NaN`, `±Inf`, missing values, dates, or timestamps, so
the protocol uses sentinel objects:

| R / Arrow value | JSON representation |
|---|---|
| valid number / string / bool | the natural JSON value |
| NA / null | `null` |
| `NaN` | `{"_": "nan"}` |
| `Infinity` / `-Infinity` | `{"_": "inf"}` / `{"_": "-inf"}` |
| Date | `{"_": "date", "v": "YYYY-MM-DD"}` |
| Timestamp | `{"_": "ts", "v": "ISO-8601 with offset"}` |
| Dictionary-encoded cell (factor / value-labelled) | the raw 0-based Arrow dictionary index, as an integer |
| 1 KiB-truncated `format()` cell | `{"_": "trunc", "v": "...prefix..."}` so the webview can show an indicator |

R factor codes are 1-based; Arrow dictionary indices are 0-based. The wire
uses the **Arrow 0-based** convention, matching how the file is laid out
on disk. The webview adds 1 on display when "Labels" is `off` so the
shown integer matches what `as.integer(factor_col)` produces in R.

### File lifecycle and path trust

- Files live in `<globalStorageUri>/data-viewer/<sessionId>-<random>.arrow`.
- The R bootstrap supplies the path to `/view-data`. The extension does
  **not** trust an arbitrary path. On every `/view-data` it canonicalizes
  `filePath` (`fs.realpathSync`), and rejects with 400 if the canonical
  path is not strictly contained in the canonical
  `<globalStorageUri>/data-viewer/` directory. This means a malicious or
  stray `View()` call cannot point the extension at, e.g., `/etc/passwd`
  for the deletion-on-replace step.
- A fresh `/view-data` for an existing `panelName` causes the extension to
  delete the old file before installing the new one.
- On extension activation, the directory is swept; files older than 24 hours
  are deleted.
- On panel disposal, the file is deleted.

### Session server reuse

The existing `PlotSessionServer` (`editors/vscode/src/plot/session-server.ts`)
is **renamed to `RSessionServer`** and moved to
`editors/vscode/src/r-session-server/`. It gains one new event:

- `view-data-requested` — `{ sessionId, panelName, filePath, nrow }`

Routing changes:

- New route `POST /view-data`, validated against the existing per-launch
  token.
- The 64 KiB body cap is **unchanged**. Schema and labels are read from the
  Arrow file by the extension on open; no schema travels over HTTP. This
  also means the body is fixed-shape and trivially fits regardless of
  dataset width.
- The route also runs the path-trust check described in *File lifecycle
  and path trust*; failures return 400.

Plot routes (`/session-ready`, `/plot-available`) are unchanged.

### ArrowSliceReader

Owns one Arrow IPC (file format, not stream) file. The exact
`apache-arrow` JS API surface for random batch access is pinned during the
v1 prototype (step 1 of *Implementation order*); this section describes
behavior, not specific class names, since the JS package's reader names
have moved between recent versions.

**File loading model.** On open the reader reads the entire file into a
`Buffer` and hands it to `apache-arrow`'s file-format reader. Decoding
of individual record batches is **lazy** (only the requested batch's
columns are materialized into JS arrays), but the on-disk byte buffer
itself is in process memory. RSS is therefore bounded by the file size
plus the LRU decoded-batch cache. For v1 this is acceptable: the
gigabyte-scale target is met by lazy *decoding*, not by streaming bytes
from disk. True mmap would require a third-party Node addon and is out
of scope for v1. (Apache Arrow IPC compresses well; in practice a 1-GB
data frame is far smaller on disk.) Files larger than free RAM should
not be `View()`-ed.

On open:

1. Read the file into a `Buffer`.
2. Read the file's footer to get the offset/length of every record batch
   (no row data decoded yet).
3. Build an in-memory `batch_starts: Uint32Array` (cumulative row counts).
3. Read the file's schema and column-level KV metadata into a typed
   `ColumnSchema[]`.
4. For each dictionary-encoded column whose dictionary cardinality is
   ≤ a threshold (default `100_000` entries), pre-load the dictionary and
   keep it in memory. Larger dictionaries are marked
   `dictionaryShipped: false`; for those, row payloads still carry the
   index, but the webview is responsible for fetching label strings on
   demand via a new `getLabels(columnIndex, indices[])` request. This keeps
   `init` bounded.

On `getRows(start, end, columns, viewportGeneration)`:

1. Binary-search `batch_starts` for batches that overlap `[start, end)`.
2. Load only those batches; decode only the requested columns into the
   wire format above.
3. Return rows to the webview, tagged with the same `viewportGeneration`.
4. If a newer `viewportGeneration` has arrived before this request was
   produced, abandon the in-flight decode and return a `stale` response
   instead — the webview drops it.

LRU cache of decoded batches (cap by aggregate cell count, not batch count;
default ~1 M cells). Plain `Map` with size-based eviction — no concurrency,
since this runs in Node's single-threaded event loop.

### DataViewerPanel

One panel per `panelName`. Owns:

- The `vscode.WebviewPanel`.
- A monotonically increasing `panelGeneration` integer. It increments on
  every reader replacement. Every postMessage from the panel includes the
  current `panelGeneration`; messages received from the webview tagged with
  an older generation are dropped. This guards against late `getRows`
  responses landing after a `replace` — the bug Sight previously hit and
  fixed via the same generation pattern.
- The `ArrowSliceReader`.
- The persisted layout (column widths, hidden columns) keyed by a composite
  key `<panelName>::<schemaHash>` (FNV-1a or SHA-1 truncated of the
  ordered column-name + arrow-type list). Two unrelated `View(df)` objects
  with different schemas therefore get different layouts. Stored in
  `globalState` with the same LRU eviction Sight uses (`maxStoredLayouts`
  setting, default 10000).
- A `MessageHandler` for the postMessage protocol with the webview.

On `view-data-requested` for an existing `panelName`:

1. Increment `panelGeneration`.
2. Close the old `ArrowSliceReader` and delete its file.
3. Open the new reader; send `replace` with new schema, layout for the
   new schema hash, and the new generation.
4. Webview discards its row cache and refetches the visible window.

On panel disposal: close reader, delete file, persist layout.

### DataViewerManager

Singleton owned by extension activation. Subscribes to the session server's
`view-data-requested` events and routes by `panelName`:

- Existing panel → reveal it and call `replace`.
- New name → create a new panel, register it, wire disposal.

Also owns the activation-time sweep of stale `<globalStorage>/data-viewer/`
files (>24 h old).

### postMessage protocol

Every message in either direction carries `panelGeneration`. Messages
tagged with an older generation than the receiver's current one are
silently dropped.

```text
extension → webview:
  { type: 'init',     panelGeneration, schema, nrow, layout, settings, dictionaries }
  { type: 'rows',     panelGeneration, requestId, viewportGeneration, start, end, rows, stale? }
  { type: 'labels',   panelGeneration, requestId, columnIndex, labels: { [index: number]: string } }
  { type: 'replace',  panelGeneration, schema, nrow, layout, dictionaries }
  { type: 'copyDone', panelGeneration, requestId, ok, error? }

webview → extension:
  { type: 'getRows',    panelGeneration, requestId, viewportGeneration, start, end, columns }
  { type: 'getLabels',  panelGeneration, requestId, columnIndex, indices: number[] }
  { type: 'saveLayout', panelGeneration, layout }                           // debounced 250 ms
  { type: 'copy',       panelGeneration, requestId, range, columns,
                        labelsOn, formatOn, digits }                       // see Selection & copy
```

`columns` in `getRows` is the set of currently-visible column indices so
hidden columns are never decoded. The webview coalesces scroll-driven
requests at ~60 Hz; the most recent `viewportGeneration` supersedes
older ones, so the reader can short-circuit a stale decode.

**Dictionaries.** Factors and `haven_labelled` columns are
dictionary-encoded by Arrow. The reader ships the dictionary in `init` /
`replace` only when its cardinality is ≤ `100_000` entries; row payloads
for such columns carry the 0-based Arrow index (an integer). For columns
above the threshold, `dictionaries` omits the entry; the webview requests
on-demand label strings via `getLabels` for whatever indices currently
need rendering when Labels is `on`. This keeps `init` bounded for
pathological factors (e.g. 10 M unique zip codes) without forcing every
viewer to fall back to per-row strings.

### File layout

```text
editors/vscode/src/data-viewer/
    index.ts                 # registerDataViewer(context)
    manager.ts               # DataViewerManager
    panel.ts                 # DataViewerPanel + an inline build_html() helper
                             # mirroring how plot-viewer-panel.ts and
                             # help-panel.ts build webview HTML inline (no
                             # separate webview-html.ts file in either)
    arrow-reader.ts          # ArrowSliceReader
    layout-state.ts          # column widths + hidden columns persistence
    messages.ts              # protocol types
    csp.ts                   # webview CSP (mirror plot/csp.ts)
    webview/
        App.svelte
        grid.svelte
        toolbar.svelte
        labels-toggle.svelte
        format-toggle.svelte
        grid-model.ts        # virtualization math
        row-cache.ts         # LRU of decoded row windows
        selection-model.ts
        styles.css
        main.ts
        tsconfig.json

editors/vscode/src/r-session-server/   # renamed from plot/session-server.ts
    index.ts
    types.ts
```

The bootstrap profile gains a new section **before** the plot bridge,
defining `globalenv()$View` in its own `local({...})` block so that
plot-bridge early returns cannot prevent the View() override from being
installed. Source stays in
`editors/vscode/src/plot/r-bootstrap-profile.ts` for v1; it remains the
single source of truth for what Raven injects into R. A possible follow-up
move to `editors/vscode/src/r-bootstrap-profile.ts` (no `plot/` prefix) is
out of scope here.

## UI

### Toolbar layout

```text
[panel name]  |  [Labels: off|on]  [Format: off|on]  [digits ▾]  |  [Columns ▾]  |  rows: 12,345  cols: 17/24
```

### Labels toggle

State: `off` | `on`. Default `off` (raw codes/values).

When `on`, a column is rendered using its labels iff the column metadata
supplies them:

- `factor` → display the level string (default R behavior). With toggle
  `off`, render the underlying integer code.
- `haven_labelled` / column with `raven.value_labels` metadata → look up
  the cell's numeric value in the JSON map; show the label when present,
  else show the raw value.
- All other columns → unchanged regardless of toggle.

The variable label (`raven.variable_label`) is **always** shown in the
column-header tooltip, independent of the toggle.

### Format toggle + digits dropdown

State: `off` | `on` (default `off`). Digits: `0..15`, default `3`. The
dropdown is disabled while format is `off`.

When `on`, **non-integer numeric columns** (floats; not `int32`) are rendered
with `Number.prototype.toFixed(digits)`. Dates, logicals, characters,
factors, and integer columns are unaffected. NaN and ±Inf are rendered
as their literal strings, not formatted.

Per-column Stata format strings (`raven.format` metadata) are **captured
but not honored** in v1.

### Columns popover

`[Columns ▾]` opens a popover with one checkbox per column (mirrors
Sight's column-visibility-popover). Hidden columns aren't requested in
`getRows` and aren't rendered. State persisted via `saveLayout`. A
right-click on a column header also offers "Hide column".

### Grid

Virtualized in both directions; only DOM nodes for visible cells exist.
Sticky header row + sticky first column (row numbers, 1..N). Row numbers
are not data; they are an always-present pseudo-column. Cells render
right-aligned for numeric/date/logical, left-aligned for character/factor.

Missing values rendered per the setting
`raven.dataViewer.missingValueStyle`: `foreground` (default), `background`,
`none`.

### Selection & copy

Single rectangular range selection: click a cell, shift-click to extend;
click-drag also extends. Keyboard: arrows extend; `Cmd/Ctrl+A` selects
the whole frame across all currently-visible (non-hidden) columns —
*not* just the viewport. TSV is **materialized in the extension**, not
the webview, so the selection is not bounded by what the webview has
loaded.

On `Cmd/Ctrl+C` the webview posts:

```text
{ type: 'copy', panelGeneration, requestId, range: { rowStart, rowEnd, colIndices: number[] },
  labelsOn, formatOn, digits }
```

The extension's `DataViewerPanel` receives the request, fetches the
required row ranges through `ArrowSliceReader`, applies the same Labels /
Format / digits transforms the webview would apply for display, formats
the result as TSV (tab-separated, with `\n` row terminators; embedded
tabs and newlines in cell values escaped to spaces), writes to
`vscode.env.clipboard`, and replies `copyDone`. Copying respects the
current Labels and Format toggles — what you see is what you copy. A
hard cap (default `5_000_000` cells) protects against accidental
multi-gigabyte clipboard writes; over the cap the panel surfaces an
in-panel toast and refuses the copy.

### Column resize

Drag the right edge of a header. Width persisted via `saveLayout`
(debounced 250 ms). Auto-fit on double-click of the resize handle: width =
max(header text width, sample of first 200 visible cells) clamped to
[60 px, 480 px].

## Error handling

| Failure | Behavior |
|---|---|
| `View(1)` (unsupported class) | R `stop()`: `` Can't `View()` an object of class `numeric` `` |
| `arrow` package missing | First `View()` of the R session: `message()` with `Raven: data viewer requires the 'arrow' package. Install with: install.packages("arrow")`; subsequent calls in the same session warn no more than once per session |
| `arrow::write_feather` throws | R surfaces via `stop()`; no panel opens |
| Disk write succeeds but POST fails | R logs `Raven: data viewer POST failed: …`; temp file is left in place and swept on next activation |
| `filePath` outside `<globalStorageUri>/data-viewer/` | Server replies 400 (path-trust check); R logs the rejection |
| Arrow file fails to open | Reader throws synchronously from its constructor; manager catches, posts a one-time `vscode.window.showErrorMessage`, and refuses to create the panel. Once a panel is open, the file's byte buffer is held in memory, so later disk-side deletions don't affect reads |
| Webview asks for rows past `nrow` | Reader returns empty; webview clamps |
| Two same-name views race | Manager processes events in event-loop order; the second view's `replace` runs after the first's `init` completes. No timeout, no force path |
| Late `getRows` / `copy` arrives after `replace` | Receiver checks `panelGeneration` and drops |
| Copy selection exceeds 5 M cells | Refused with an in-panel toast; nothing written to clipboard |
| Huge frames (e.g. 100 M × 100) | No special path. Arrow chunked write streams; the viewer never loads more than the visible window into RAM |
| R session ends with viewer open | Panel keeps showing the file (already on disk and owned by the extension). No "session ended" indicator needed; data is decoupled from the R session |

## Settings

Added to `editors/vscode/package.json` and read directly by the extension:

| Setting | Default | Description |
|---|---|---|
| `raven.dataViewer.enabled` | `true` | Enable the `View()` override |
| `raven.dataViewer.missingValueStyle` | `"foreground"` | `foreground` \| `background` \| `none` |
| `raven.dataViewer.maxStoredLayouts` | `10000` | LRU cap on persisted column-width/visibility entries |
| `raven.dataViewer.defaultDigits` | `3` | Initial digits when Format is toggled on |

These settings are **not** wired through
`editors/vscode/src/initializationOptions.ts`. The CLAUDE.md three-place
wiring rule applies only to settings the Rust LSP consumes; data viewer
settings are extension-only, mirroring how `raven.plot.enabled` and
`raven.plot.viewerColumn` are not in `initializationOptions.ts` either.

## Testing

### R-side serialization (Rust integration test)

`crates/raven/tests/data_viewer_bootstrap.rs`, gated on `R` being on PATH:

1. Spawn R with `R_PROFILE_USER` pointing at a generated profile.
2. Send `View(df)` for fixtures: `data.frame`, tibble, data.table, matrix
   (with auto and non-auto rownames), factor, `haven_labelled`, dates,
   POSIXct with tz, integer64, complex, raw, list-column, and the
   unsupported-type cases (numeric scalar, list-of-non-data-frame,
   closure, S4).
3. Assert the bootstrap POSTs `/view-data` to a stub HTTP server with the
   expected body shape `{ sessionId, panelName, filePath, nrow }` —
   **no** `schemaJson` field.
4. Assert `filePath` lies under the stub's per-test data-viewer
   directory.
5. Assert the resulting Arrow file is valid and contains the expected
   schema metadata: `raven.variable_label`, `raven.value_labels`
   (covering haven, foreign, and factor sources), `raven.original_class`,
   `raven.format` when present.
6. Assert the matrix-rownames rule: auto-generated 1..N rownames are
   omitted; non-auto rownames are present as a leading `rowname` column.
7. Assert truncated `format()` cells stop at 1 KiB with a trailing `…`.
8. For unsupported types, assert R throws an error with the expected
   message.
9. Assert that when the plot bridge fails (e.g. `httpgd` unavailable)
   the View() override is still installed and works (ordering
   regression test).

### ArrowSliceReader (Bun unit tests)

`editors/vscode/src/data-viewer/__tests__/arrow-reader.test.ts`:

- Reader correctly indexes batch starts.
- `getRows(0, 10)` loads only batch 0.
- `getRows(70000, 70010)` (across 65 536 boundary) loads exactly 2 batches.
- `getRows` with a column subset doesn't decode hidden columns.
- LRU eviction order under sequential window scrolling.
- File-disappeared-mid-session emits the expected error.
- Wire-format encoding: NA → `null`, NaN → `{_:"nan"}`, ±Inf → `{_:"inf"}`/`{_:"-inf"}`,
  Date → `{_:"date",v}`, timestamp → `{_:"ts",v}`, 1 KiB-truncated cell → `{_:"trunc",v}`.
- Factor cell payload is the **0-based** Arrow dictionary index.
- Dictionary cardinality ≤ threshold → dictionary present in `init`;
  cardinality > threshold → dictionary omitted, `getLabels` returns the
  requested labels for the requested indices.
- `viewportGeneration` mismatch causes the reader to short-circuit and
  return `stale: true`.

Fixtures generated by a one-off `editors/vscode/test-fixtures/generate.R`,
regenerated only when the schema changes.

### Session-server route

`editors/vscode/src/r-session-server/__tests__/`:

- `POST /view-data` with valid token + body → emits
  `view-data-requested`.
- Invalid token → 401.
- Missing required fields → 400.
- `filePath` outside `<globalStorageUri>/data-viewer/` (including `..`
  traversal and symlink redirection) → 400.

### DataViewerManager + DataViewerPanel

`editors/vscode/src/data-viewer/__tests__/manager.test.ts` with the
existing mocked-`vscode` harness:

- New `panelName` → creates panel, registers for events.
- Repeat `panelName` → reveals existing panel and replaces; old reader
  closed; old file deleted; `panelGeneration` increments.
- Two same-name views in quick succession: events are processed in
  order; only the last view's reader survives; earlier file is deleted.
- Panel disposal deletes file and persists layout.
- Activation-time sweep deletes files older than 24 h, leaves newer files.
- Late `getRows` reply tagged with the previous `panelGeneration` is
  dropped without crashing the panel.
- Layout key combines `panelName` and the schema hash; two `View(df)`
  calls with different schemas under the same `panelName` get separate
  layouts (regression for the codex-flagged collision risk).
- Extension-side copy: a request that spans multiple batches assembles
  TSV using the reader, applies Labels/Format/digits transforms, and
  writes to the (mocked) clipboard. A request exceeding the 5 M-cell cap
  is refused with a `copyDone` `ok: false`.

### Webview grid model

`editors/vscode/src/data-viewer/webview/__tests__/grid-model.test.ts`:

- Visible-row computation given `scrollTop`, `rowHeight`, `viewportHeight`,
  `nrow`.
- Overscan window expansion.
- Request coalescing: 10 scroll events in 16 ms → 1 fetch.
- LRU row-cache eviction.
- Selection-model rectangle math (anchor + focus).
- Format toggle: integer column unaffected at any digits; float column
  rounds correctly; `NaN` and ±`Inf` (decoded from their wire sentinels)
  preserved literally on display; missing values styled.
- Labels toggle: factor / haven_labelled / plain numeric matrix of
  behaviors. `off` shows the factor's R-style 1-based code (wire index
  + 1); `on` shows the level string.
- High-cardinality column with `dictionaryShipped: false`: the model
  issues `getLabels` for currently-visible indices; missing labels render
  as the index until they arrive.
- Copy request: rectangle math + view state are passed through to the
  extension (the model itself doesn't materialize TSV).

### VS Code integration test

End-to-end suite in `editors/vscode/src/test/`, skipped without `R` on
PATH:

1. Activate the extension and launch a Raven R terminal.
2. Send `View(mtcars)` via the existing send-to-R helper.
3. Poll until the data viewer panel exists; assert title is `mtcars` and
   schema contains the expected columns.
4. Send `View(head(mtcars, 5))` → a new panel name appears.
5. Send `View(mtcars)` again → same tab, replaced reader.

Per CLAUDE.md: run from a wrapper subprocess test from the root; the Bun
runner must not recurse into `editors/vscode/src/test`.

### Manual / not-automated

Verify by hand on real datasets before declaring v1 done:

- 10 M-row × 50-column synthetic frame: scroll smoothly, RSS stays
  bounded.
- A `haven::read_dta`-loaded NHANES extract: variable labels in header
  tooltip; Labels toggle swaps numeric codes for label strings.
- Format toggle at digits=2 vs digits=6 on a wide float column.
- Copy a 1000-row × 5-col selection and paste into a spreadsheet —
  TSV intact.

## Documentation

New `docs/data-viewer.md`:

- User-facing description: triggers, supported types, Labels toggle,
  Format toggle, settings, troubleshooting (`arrow` not installed).
- Linked from `docs/send-to-r.md` as a "Data Viewer" sibling to "Plot
  Viewer".

`CLAUDE.md` "What to read" list gains a pointer to `docs/data-viewer.md`.

## Implementation order

1. **Arrow JS spike.** Add `apache-arrow` to
   `editors/vscode/package.json`, write a 50-line `arrow-spike.test.ts`
   that opens a small Feather v2 file and reads a single record batch by
   index. Pin the exact API surface (class names, footer access pattern,
   dictionary access) here. Spec terminology that referred to specific
   class names is finalized after this step.
2. Rename `PlotSessionServer` → `RSessionServer`; move to
   `editors/vscode/src/r-session-server/`. No new functionality. Plot tests
   continue to pass.
3. Add the `/view-data` route + event to `RSessionServer` (with the
   path-trust check) and its tests.
4. Build the `ArrowSliceReader` against committed Arrow fixtures, with the
   wire-format encoding, `viewportGeneration` cancellation, dictionary
   threshold, and `getLabels` request handling.
5. Build `DataViewerManager` + `DataViewerPanel` with a placeholder webview
   that just lists rows. Includes `panelGeneration`, schema-hashed layout
   keys, and the extension-side copy implementation.
6. Extend the bootstrap profile: add a new top-of-file `local({...})` block
   defining the `View()` override that requires `arrow`, runs *before* the
   plot bridge, and uses the wire encoding from this spec. Wire into the R
   integration test harness.
7. Build the Svelte webview: virtualized grid, row cache, scroll
   coalescing.
8. Add toolbar: Labels toggle, Format toggle + digits dropdown, Columns
   popover.
9. Selection model + copy request glue (the extension side already exists
   from step 5).
10. Layout persistence: column widths, column visibility, schema-hashed
    keys.
11. Settings wiring (`package.json` + extension config tests; **no** init
    options).
12. End-to-end VS Code Mocha test.
13. Documentation: `docs/data-viewer.md`, link from `docs/send-to-r.md`,
    `CLAUDE.md` pointer.
