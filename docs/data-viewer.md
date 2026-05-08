# Data Viewer

Raven includes a data viewer that overrides R's `View()` so calls in a
Raven-managed R terminal open a virtualized grid in a VS Code webview
instead of the default backup viewer. The grid streams row windows from
disk, so it scales smoothly to multi-million-row data frames.

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
[Labels: off|on] [Format: off|on] [digits ▾] | [Columns ▾] | rows: 12,345  cols: 17/24
```

### Labels

When `on`, columns with labels render their labels instead of raw
values:

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

When `on`, non-integer numeric columns are rounded to the digits chosen
in the dropdown (default 3, range 0–15). Integer columns, dates,
timestamps, factors, and string columns are unaffected. `NaN` and ±Inf
are rendered as `NaN` / `Inf` / `-Inf` literally — they aren't
formatted away.

### Columns popover

The `Columns ▾` button opens a popover with one checkbox per column.
Hide/show changes are persisted per panel-name + schema hash, so the
same `View(mtcars)` opened tomorrow remembers the layout.

### Selection and copy

- Click a cell, shift-click another to extend the rectangle.
- Click-drag also extends.
- `Cmd/Ctrl+A` selects every row across all currently-visible columns.
- `Cmd/Ctrl+C` copies the selection as TSV. Copying respects the
  active Labels / Format / digits state — what you see is what you
  copy.
- A 5,000,000-cell hard cap protects against accidental huge clipboard
  writes; over the cap the panel shows a toast and refuses the copy.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `raven.dataViewer.enabled` | `true` | Override `View()` in the Raven-managed R terminal. Set to `false` to disable the viewer entirely. |
| `raven.dataViewer.missingValueStyle` | `foreground` | How NA / NaN cells are highlighted: `foreground` (colorize the text), `background` (tint the cell), or `none`. |
| `raven.dataViewer.maxStoredLayouts` | `10000` | LRU cap on persisted column-width / visibility entries. Each unique panel-name × schema-hash pair counts once. |
| `raven.dataViewer.defaultDigits` | `3` | Initial digits used when the Format toggle is on. |

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
  (`install.packages("arrow")`). If it's missing, the bootstrap logs
  a one-time warning and `View()` retains its default base behavior.
- A Raven-managed R terminal (the standard "R" terminal profile in
  Raven, or one launched via Raven's send-to-R commands). Plain R
  terminals you opened outside Raven won't have the override
  installed.

## Troubleshooting

- **Nothing happens when I call `View(df)`.** Check that the terminal
  was started by Raven (the terminal profile dropdown's "R (Raven)"
  entry, or via send-to-R). Confirm `requireNamespace("arrow")`
  returns `TRUE`. Check `raven.dataViewer.enabled` is true.
- **"data viewer requires the 'arrow' package" message.** Run
  `install.packages("arrow")` in the same R installation.
- **The `Labels` toggle doesn't change a column.** The column has no
  label metadata. For `haven_labelled` columns, this means
  `attr(col, "labels")` is empty.
- **Copying a huge selection refuses with "Selection exceeds copy
  limit".** The 5 M-cell cap is intentional; reduce the selection or
  export the slice through R instead.
