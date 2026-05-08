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
the plot bridge uses) gains a new section that defines `View` in
`globalenv()` after the user's `.Rprofile` has been sourced. The override:

1. Resolves the panel name from the call:
   - If a second argument is supplied (`View(x, "title")`), use it.
   - Otherwise use `deparse1(substitute(x), collapse = " ")` truncated to
     **256 characters** with a trailing `…` if longer. This matches
     REditorSupport's deparse behavior; the cap is a guard against
     pathological deparse output, not a visual width concern (VS Code's tab
     UI handles its own ellipsis).
2. Dispatches by class:
   - `is.data.frame(x) || is.matrix(x)` → serialize and POST `/view-data`.
   - Otherwise → `stop("Can't `View()` an object of class `", paste(class(x), collapse = "/"), "`")`.
3. Returns `invisible(NULL)`.

The override POSTs `/view-data` to the existing loopback HTTP server with
`{ sessionId, panelName, filePath, schemaJson, nrow }`.

The extension matches by `panelName` (not `sessionId`). Calling
`View(mtcars)` from any session reuses the `mtcars` tab; the second writer
wins when two sessions race the same name. This is the user's stated
preference (per-name tab) and matches REditorSupport.

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
| `matrix` | `as.data.frame(x)`; rownames preserved as a virtual `rowname` column iff present | Avoids reinventing matrix serialization |
| Other (list-cols, S4, sf-geometry, etc.) | utf8 via `format()` per cell | Non-fatal fallback so unusual columns don't kill the viewer |

### Schema metadata

Each column's KV metadata:

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

### File lifecycle

- Files live in `<globalStorageUri>/data-viewer/<sessionId>-<random>.arrow`.
- A fresh `/view-data` for an existing `panelName` causes the extension to
  delete the old file before installing the new one.
- On extension activation, the directory is swept; files older than 24 hours
  are deleted.
- On panel disposal, the file is deleted.

### Session server reuse

The existing `PlotSessionServer` (`editors/vscode/src/plot/session-server.ts`)
is **renamed to `RSessionServer`** and moved to
`editors/vscode/src/r-session-server/`. It gains one new event:

- `view-data-requested` — `{ sessionId, panelName, filePath, schemaJson, nrow }`

Routing changes:

- New route `POST /view-data`, validated against the existing per-launch
  token.
- Body limit raised from 64 KiB to **1 MiB** to accommodate wide schemas
  (thousands of columns each carrying labels). Bodies above that limit get
  413 and an R-side log.

Plot routes (`/session-ready`, `/plot-available`) are unchanged.

### ArrowSliceReader

Owns one Arrow IPC file. On open:

1. Read the file's footer via `apache-arrow`'s `RecordBatchFileReader` to get
   the offset/length of every record batch (no row data loaded yet).
2. Build an in-memory `batch_starts: Uint32Array` (cumulative row counts).

On `getRows(start, end, columns)`:

1. Binary-search `batch_starts` for batches that overlap `[start, end)`.
2. Load only those batches; decode only the requested columns.
3. Return rows as JSON to the webview.

LRU cache of decoded batches (cap by aggregate cell count, not batch count;
default ~1 M cells). Plain `Map` with size-based eviction — no concurrency,
since this runs in Node's single-threaded event loop.

### DataViewerPanel

One panel per `panelName`. Owns:

- The `vscode.WebviewPanel`.
- The `ArrowSliceReader`.
- The persisted layout (column widths, hidden columns) keyed by
  `panelName`, stored in `globalState` with the same LRU eviction Sight uses
  (`maxStoredLayouts` setting, default 10000).
- A `MessageHandler` for the postMessage protocol with the webview.

On `view-data-requested` for an existing `panelName`:

1. Close the old `ArrowSliceReader` and delete its file.
2. Send the new schema to the webview.
3. Webview discards its row cache and refetches the visible window.

On panel disposal: close reader, delete file, persist layout.

### DataViewerManager

Singleton owned by extension activation. Subscribes to the session server's
`view-data-requested` events and routes by `panelName`:

- Existing panel → reveal it and call `replace`.
- New name → create a new panel, register it, wire disposal.

Also owns the activation-time sweep of stale `<globalStorage>/data-viewer/`
files (>24 h old).

### postMessage protocol

```text
extension → webview:
  { type: 'init',    schema, nrow, layout, settings, dictionaries }
  { type: 'rows',    requestId, start, end, rows }
  { type: 'replace', schema, nrow, layout, dictionaries }

webview → extension:
  { type: 'getRows',    requestId, start, end, columns }   // columns = visible only
  { type: 'saveLayout', layout }                            // debounced 250 ms
  { type: 'copy',       tsv }                               // request clipboard write
```

`columns` in `getRows` is the set of currently-visible column indices so
hidden columns are never decoded. The webview coalesces scroll-driven
requests at ~60 Hz so rapid scrolling doesn't fire dozens of concurrent
reads.

Dictionary columns (factors and any `haven_labelled` column with
`raven.value_labels`) ship the dictionary itself **once**, in `init` /
`replace`, as `dictionaries: { <columnIndex>: string[] }`. Row payloads
for those columns carry **integer indices**, not decoded strings. The
webview chooses what to render by looking up the index in the dictionary
when Labels is `on` and showing the index directly when Labels is
`off`. This keeps row payloads compact regardless of label length.

### File layout

```text
editors/vscode/src/data-viewer/
    index.ts                 # registerDataViewer(context)
    manager.ts               # DataViewerManager
    panel.ts                 # DataViewerPanel
    arrow-reader.ts          # ArrowSliceReader
    layout-state.ts          # column widths + hidden columns persistence
    messages.ts              # protocol types
    csp.ts                   # webview CSP (mirror plot/csp.ts)
    webview-html.ts          # mirror plot/webview-html.ts
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

The bootstrap profile gains a new section after the plot bridge, defining
`globalenv()$View`. Source stays in
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
*not* just the viewport — but the TSV is materialized lazily on copy.
`Cmd/Ctrl+C` posts `{type:'copy', tsv}`
to the extension, which writes to `vscode.env.clipboard`. Copying respects
the current Labels and Format toggles — what you see is what you copy.

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
| `/view-data` body > 1 MiB | Server replies 413; R logs `Raven: schema too large to send to viewer` |
| Arrow file vanishes mid-session | Reader emits an error to the webview which shows an in-panel banner: "Data file no longer available. Re-run View() to refresh." |
| Webview asks for rows past `nrow` | Reader returns empty; webview clamps |
| Two same-name views race | New panel awaits old panel disposal (Promise) before claiming the name; bounded 1 s timeout, then force |
| Huge frames (e.g. 100 M × 100) | No special path. Arrow chunked write streams; the viewer never loads more than the visible window into RAM |
| R session ends with viewer open | Panel keeps showing the file (already on disk and owned by the extension). No "session ended" indicator needed; data is decoupled from the R session |

## Settings

Added to `editors/vscode/package.json` and wired through
`editors/vscode/src/initializationOptions.ts`:

| Setting | Default | Description |
|---|---|---|
| `raven.dataViewer.enabled` | `true` | Enable the `View()` override |
| `raven.dataViewer.missingValueStyle` | `"foreground"` | `foreground` \| `background` \| `none` |
| `raven.dataViewer.maxStoredLayouts` | `10000` | LRU cap on persisted column-width/visibility entries |
| `raven.dataViewer.defaultDigits` | `3` | Initial digits when Format is toggled on |

Per CLAUDE.md, all four settings must be wired in three places: the schema
in `package.json`, the shared init-options factory at
`editors/vscode/src/initializationOptions.ts`, and the `SETTINGS_MAPPING`
plus named-value tests in `editors/vscode/src/test/settings.test.ts`.

## Testing

### R-side serialization (Rust integration test)

`crates/raven/tests/data_viewer_bootstrap.rs`, gated on `R` being on PATH:

1. Spawn R with `R_PROFILE_USER` pointing at a generated profile.
2. Send `View(df)` for fixtures: `data.frame`, tibble, data.table, matrix,
   factor, `haven_labelled`, dates, POSIXct with tz, list-column, and the
   unsupported-type cases (numeric scalar, list, closure, S4).
3. Assert the bootstrap POSTs `/view-data` to a stub HTTP server with the
   expected `panelName`, `nrow`, and that the resulting Arrow file is valid
   and contains the expected schema metadata.
4. For unsupported types, assert R throws an error with the expected
   message.

### ArrowSliceReader (Bun unit tests)

`editors/vscode/src/data-viewer/__tests__/arrow-reader.test.ts`:

- Reader correctly indexes batch starts.
- `getRows(0, 10)` loads only batch 0.
- `getRows(70000, 70010)` (across 65 536 boundary) loads exactly 2 batches.
- `getRows` with a column subset doesn't decode hidden columns.
- LRU eviction order under sequential window scrolling.
- File-disappeared-mid-session emits the expected error.

Fixtures generated by a one-off `editors/vscode/test-fixtures/generate.R`,
regenerated only when the schema changes.

### Session-server route

`editors/vscode/src/r-session-server/__tests__/`:

- `POST /view-data` with valid token + body → emits
  `view-data-requested`.
- Invalid token → 401.
- Body > 1 MiB → 413.
- Missing required fields → 400.

### DataViewerManager + DataViewerPanel

`editors/vscode/src/data-viewer/__tests__/manager.test.ts` with the
existing mocked-`vscode` harness:

- New `panelName` → creates panel, registers for events.
- Repeat `panelName` → reveals existing panel and replaces; old reader
  closed; old file deleted.
- Two concurrent same-name views: later view wins; earlier file deleted.
- Panel disposal deletes file and persists layout.
- Activation-time sweep deletes files older than 24 h, leaves newer files.

### Webview grid model

`editors/vscode/src/data-viewer/webview/__tests__/grid-model.test.ts`:

- Visible-row computation given `scrollTop`, `rowHeight`, `viewportHeight`,
  `nrow`.
- Overscan window expansion.
- Request coalescing: 10 scroll events in 16 ms → 1 fetch.
- LRU row-cache eviction.
- Selection-model rectangle math (anchor + focus).
- Format toggle: integer column unaffected at any digits; float column
  rounds correctly; `NaN` and ±`Inf` preserved literally; missing values
  styled.
- Labels toggle: factor / haven_labelled / plain numeric matrix of
  behaviors.
- TSV copy honors current toggles.

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

1. Rename `PlotSessionServer` → `RSessionServer`; move to
   `editors/vscode/src/r-session-server/`. No new functionality. Plot tests
   continue to pass.
2. Add the `/view-data` route + event to `RSessionServer` and its tests.
3. Build the `ArrowSliceReader` against committed Arrow fixtures.
4. Build `DataViewerManager` + `DataViewerPanel` with a placeholder webview
   that just lists rows.
5. Extend the bootstrap profile with the `View()` override; wire into the
   R integration test harness.
6. Build the Svelte webview: virtualized grid, row cache, scroll
   coalescing.
7. Add toolbar: Labels toggle, Format toggle + digits dropdown, Columns
   popover.
8. Selection model + copy as TSV.
9. Layout persistence: column widths, column visibility.
10. Settings wiring in all three required places.
11. End-to-end VS Code Mocha test.
12. Documentation: `docs/data-viewer.md`, link from `docs/send-to-r.md`,
    `CLAUDE.md` pointer.
