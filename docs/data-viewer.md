# Data Viewer

Raven includes a data viewer that overrides R's `View()` so calls in a
Raven-managed R terminal open a virtualized grid in a VS Code webview
instead of the default backup viewer. The grid streams row windows from
disk, keeping scrolling responsive on multi-million-row data frames.

## Why we built this

Many webview-based R data viewers transport data frames from R to the
webview by serializing the entire frame to JSON and shipping it into the
page in one shot. That works for small frames but can freeze the editor
on large ones; in some reported cases, large `View()` calls have hung the
whole VS Code window. Raven serializes the frame to an Apache Arrow IPC
(Feather v2) file and decodes only the rows currently visible, so the
webview's memory and decode time scale with the visible viewport rather
than the size of the frame. See
[Comparison: Data viewer](./comparison.md#data-viewer) for details.

> [!NOTE]
> The data viewer is reached through Raven's R console: it activates only
> when Raven's R console activates (`raven.rConsole.activation`, default:
> `auto`). When the REditorSupport (R) extension is enabled or VS Code is
> running as Positron, Raven's R console — and therefore the data viewer
> — is off by default. See
> [Coexistence](./coexistence.md) for details.

## What it shows

- `data.frame` (including `tibble` and `data.table` subclasses).
- `matrix`. If the matrix has non-default rownames, they appear as a
  leading `rowname` column; auto-generated `1..N` rownames are dropped
  in favor of the viewer's row-number gutter.
- Other classes raise an error in R, mirroring Positron:

  ```r
  > View(1)
  Error in `View()`:
  ! Can't `View()` an object of class `numeric`
  ```

## Triggering

Call `View()` in a Raven-managed R terminal:

```r
View(mtcars)
View(head(iris, 50))
View(my_df, "Custom panel name")
```

The panel title comes from the second argument when supplied, otherwise
from the deparsed expression (truncated to 256 bytes with `…` if longer).
A second `View(mtcars)` reuses the existing `mtcars` tab; a different
expression opens a new tab.

## Toolbar

```text
[Labels] [Format] [3 digits ▾] | [Columns ▾ <7>] | rows: 12,345
```

Each toggle is filled when active; clicking flips it. The Labels and
Format buttons are hidden entirely when no column in the current data
set would be affected by them — e.g. an all-integer matrix hides both,
while a frame with only factors hides Format but keeps Labels. The
small badge on `Columns` shows the count of currently hidden columns
(absent when none are hidden).

### Labels

Defaults to **on** in new panels. When on, columns with labels render
their labels instead of raw values:

- `factor` columns swap the integer code (1-based, matching
  `as.integer(factor_col)` in R) for the level string.
- `haven_labelled` columns (from `haven::read_dta`) and other columns
  with `attr(col, "labels")` (haven) or `attr(col, "value.labels")`
  (`foreign::read.dta`, `readstata13::read.dta13`) swap the cell value
  for the matching label, falling back to the raw value when no label
  is mapped.
- Columns without label metadata are unchanged.

The variable label (`attr(col, "label")`) is **always** shown in the
column-header tooltip, regardless of the toggle.

### Format

Defaults to **on** in new panels. When on, non-integer numeric columns
are rounded to the digits chosen in the dropdown (default 3, range 0–15).
Integer columns, dates, timestamps, factors, and string columns are
unaffected. `NaN` and ±Inf are rendered as `NaN` / `Inf` / `-Inf`
literally — they aren't formatted away.

A Float column that the source file flagged as integer-display (Stata
`%w.0f`, SAS/SPSS `F8.0`, `COMMA10.0`, `Z3.`, etc.) is treated like an
integer column — Format does nothing to it, and the toggle is hidden
when no other column would be affected. Independently, a single
integer-valued cell inside an otherwise-decimal Float column (e.g. `5`
in a column whose other rows are `1.5`, `2.25`) is rendered as `5` —
not `5.000` — to avoid the misleading trailing-zero look common in
SPSS/SAS files that store integer-valued data as doubles.

### Columns popover

The `Columns ▾` button opens a popover with one checkbox per column.
Hide/show changes are persisted per panel-name + schema hash, so the
same `View(mtcars)` opened tomorrow remembers the layout.

### Selection and copy

- Click a cell, shift-click another to extend the rectangle.
- Click-drag also extends.
- Click a column header to select that column; click-drag across
  column headers to select multiple contiguous columns.
- Click a row-number gutter cell to select that row; click-drag across
  row headers to select multiple contiguous rows.
- Click the `#` corner cell (top-left) to select the whole table.
- `Cmd/Ctrl+A` selects every row across all currently-visible columns
  (equivalent to clicking `#`).
- `Cmd/Ctrl+C` copies the selection as TSV. Copying respects the
  active Labels / Format / digits state — what you see is what you
  copy.
- Column-header selections and whole-table selections (via `#` or
  `Cmd/Ctrl+A`) include the column-name row when copied. Cell and
  row-header selections copy data only, matching spreadsheet
  conventions.
- Right-click a cell, column header, or row header to show a Copy menu
  (which copies the current selection, or the right-clicked target if
  the click landed outside the selection). The platform's default
  Cut/Copy/Paste menu is suppressed elsewhere in the panel.
- A 5,000,000-cell hard cap protects against accidental huge clipboard
  writes; over the cap the panel shows a toast and refuses the copy.

### Keyboard shortcuts

| Key                | Action                                  |
| ------------------ | --------------------------------------- |
| `Home`             | Jump to the first row.                  |
| `End`              | Jump to the last row.                   |
| `PageUp`           | Scroll one viewport up.                 |
| `PageDown`         | Scroll one viewport down.               |
| `Cmd/Ctrl+A`       | Select all rows across visible columns. |
| `Cmd/Ctrl+C`       | Copy the current selection as TSV.      |

`Home` and `End` are the recommended way to reach the very first or very
last row in a large data frame. The native scrollbar's minimum thumb
size prevents dragging the pill all the way to the bottom of a multi-
million-row grid (see [issue #183](https://github.com/jbearak/raven/issues/183)),
but `End` jumps there in one keystroke. Modifier combinations (`Shift`,
`Cmd`/`Ctrl`, `Alt` on these navigation keys) fall through to the
browser/OS unchanged so platform shortcuts are not hijacked.

On data frames with more than ~625 K rows, Raven also replaces the
native vertical scrollbar with an overlay so dragging the scrollbar
thumb to the bottom reaches the last row. The native scrollbar is
preserved on smaller frames.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `raven.dataViewer.missingValueStyle` | `foreground` | How NA / NaN cells are highlighted: `foreground` (colorize the text), `background` (tint the cell), or `none`. |
| `raven.dataViewer.maxStoredLayouts` | `10000` | LRU cap on persisted column-width / visibility entries. Each unique panel-name × schema-hash pair counts once. |
| `raven.dataViewer.defaultDigits` | `3` | Initial digits used when the Format toggle is on (Format defaults to on). |

The data viewer's overall enable/disable is controlled by `raven.rConsole.activation` — there is no separate `raven.dataViewer.enabled` toggle.

Changes apply to newly-opened panels.

## How it works

1. The Raven bootstrap profile (loaded via `R_PROFILE_USER` when you
   start a Raven-managed R terminal) installs a custom `View()` in
   `globalenv()` before the plot bridge runs. A failure in the plot
   bridge does not affect `View()`.
2. On `View(df)`, R writes the data frame to an Apache Arrow IPC
   (Feather v2) file in `<extension globalStorage>/data-viewer/`.
   Per-column variable-label and value-label metadata is captured into
   a single schema-level JSON blob (R's `arrow` package doesn't expose
   per-field metadata writes through its public API).
3. R POSTs the path to the extension's loopback HTTP server
   (`POST /view-data` with `{ sessionId, panelName, filePath, nrow }`).
   The route validates that the canonical path is under the
   per-extension data-viewer directory, rejecting anything else.
4. The extension opens the file via `apache-arrow` (JS), indexes
   record-batch starts, and serves row windows on demand to the
   webview over postMessage. Decoded batches are LRU-cached.

The same Arrow file backs the panel for its lifetime; closing the
panel deletes the file. On extension activation the data-viewer
directory is swept of files older than 24 hours.

## Requirements

- The R [`arrow`](https://arrow.apache.org/docs/r/) package
  (`install.packages("arrow")`). If it's missing, Raven prints a
  warning in R and shows a VS Code warning notification when you call
  `View()`, then returns without interrupting the rest of your code.
- A Raven-managed R terminal (the standard "R" terminal profile in
  Raven, or one launched via Raven's send-to-R commands). Plain R
  terminals you opened outside Raven won't have the override
  installed.

## Troubleshooting

- **Nothing happens when I call `View(df)`.** Check that the terminal
  was started by Raven (the terminal profile dropdown's "R" entry,
  or via send-to-R). Confirm `requireNamespace("arrow")`
  returns `TRUE`. Check `raven.rConsole.activation`: if it's
  `"disabled"`, or `"auto"` while REditorSupport (R) is enabled or
  you're in Positron, Raven's R console — and the data viewer — won't
  activate.
- **"Raven data viewer requires the 'arrow' package" warning.** Run
  `install.packages("arrow")` in the same R installation.
- **The `Labels` toggle doesn't change a column.** The column has no
  label metadata. For `haven_labelled` columns, this means
  `attr(col, "labels")` is empty.
- **Copying a huge selection refuses with "Selection exceeds copy
  limit".** The 5 M-cell cap is intentional; reduce the selection or
  export the slice through R instead.
