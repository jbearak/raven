# Data Viewer

Raven includes a data viewer that overrides R's `View()` so calls in a
Raven-managed R terminal open a virtualized grid in a VS Code webview
instead of the default backup viewer. The grid streams row windows from
disk, keeping scrolling responsive on multi-million-row data frames.

## Why we built this

Raven serializes the frame to an Apache Arrow IPC (Feather v2) file and
decodes only the rows currently visible, so the webview's memory and
decode time scale with the visible viewport rather than the size of the
frame. Writing to an on-disk Arrow file also means paging doesn't have
to go back through R, which keeps scrolling on multi-million-row frames
smooth.

Other R data viewers in VS Code take different staging routes — the
REditorSupport extension's [`sess`](https://github.com/REditorSupport/vscode-R/tree/master/sess)
helper, for example, materializes the whole frame in R memory and serves
row windows from there to the webview over JSON-RPC. Both extensions
paginate the wire, but the staging is different: Raven snapshots the
frame to disk once as Arrow and the webview reads windows from the file
directly, bypassing R for paging; `sess` keeps everything live in R. In
our own smoke tests, the on-disk Arrow path has stayed responsive on
multi-million-row frames where the R-staged path can hit memory limits.
The two viewers also differ on value-labelled data: Raven recognizes
`haven_labelled` plus `foreign` / `readstata13` label maps and
substitutes the label when its Labels toggle is on (see
[Labels](#labels)); `sess` classifies labelled columns as formatted
numerics and renders the underlying codes. See
[Comparison: Data viewer](./comparison.md#data-viewer) for the
side-by-side.

> [!NOTE]
> The data viewer is reached through Raven's R console: it activates only
> when Raven's R console activates (`raven.rConsole.activation`, default:
> `auto`). When the REditorSupport extension is enabled or VS Code is
> running as Positron, Raven's R console — and therefore the data viewer
> — is off by default. See
> [Coexistence](./coexistence.md) for details.

## What it shows

- `data.frame` (including `tibble` and `data.table` subclasses).
- `matrix`. If the matrix has non-default rownames, they appear as a
  leading `rowname` column; auto-generated `1..N` rownames are dropped
  in favor of the viewer's row-number gutter.
- **Atomic vectors and scalars** (`numeric`, `integer`, `character`,
  `logical`, `complex`, `Date`, `POSIXct`), plus standalone `factor` and
  `haven_labelled` vectors. A vector renders as a `values` column (a
  `value` column when it has length 1). If the vector has `names()`,
  those appear in a leading `name` column — the same role the `rowname`
  column plays for a matrix. A standalone `factor` / `haven_labelled`
  vector keeps its labels, so the [Labels](#labels) toggle works on it.
- **Flat lists** — a list whose elements are all scalars/vectors. Each
  element becomes a column, padded with empty (`NA`) cells to the length
  of the longest element, and each column keeps its own type. Unnamed
  elements get `V1`, `V2`, … headers. A named vector and a list of
  scalars therefore render differently — `c(a = 1, b = 2)` is a two-row
  `name`/`values` table, while `list(a = 1, b = 2)` is a one-row,
  two-column table — matching `as.data.frame(list(a = 1, b = 2))`.
- Other classes — including nested/recursive lists (an element that is
  itself a list or `data.frame`), `raw` vectors, environments, and
  functions — raise an error in R:

  ```r
  > View(sum)
  Error: Can't `View()` an object of class `function`
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
rows: 12,345 | Sort: mpg▲ cyl▼ ✕ | Filter: cyl ∈ {6,8} ✕ | [Labels] [Format] [3 digits ▾] | [Columns ▾ <7>]
```

The `Sort` and `Filter` strips are hidden entirely when no sort or filter is active.

When the panel is too narrow to fit the chip strips beside the action
buttons, the strips drop onto their own second row so Labels / Format /
Columns stay reachable. Each strip still scrolls horizontally on its own
row when its chips overflow even that full-width row. The wrap decision
holds a small hysteresis band so the toolbar doesn't flap between one
and two rows as the panel is resized across the boundary.

Each toggle is filled when active; clicking flips it. The Labels and
Format buttons (and the digits dropdown) are hidden when no column in the
current data set would be affected by them — e.g. an all-integer matrix
hides all three, while a frame with only factors hides Format and digits
but keeps Labels. The small badge on `Columns` shows the count of
currently hidden columns (absent when none are hidden).

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
are rounded to the digits chosen in the dropdown (0–6, default 3).
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
- Click the `#` corner cell (top-left) to select every row across all
  currently-visible columns (a *row* selection — see the copy note
  below).
- `Cmd/Ctrl+A` also selects every row across all currently-visible
  columns, but as a *column* selection. The two are visually identical
  but copy differently: a column selection includes the column-name
  row, a row selection doesn't.
- `Cmd/Ctrl+C` copies the selection as TSV. Copying respects the
  active Labels / Format / digits state — what you see is what you
  copy.
- Column-header selections and `Cmd/Ctrl+A` selections include the
  column-name row when copied. Cell, row-header, and `#`-corner
  selections copy data only, matching spreadsheet conventions.
- Right-click a cell, column header, or row-gutter cell to show a Copy
  menu that copies the current selection. Right-clicking a column
  header always replaces the selection with that one column (so the
  menu's Copy copies that column, even if other columns were
  previously selected). For cell right-clicks, if the target isn't
  already in the selection it gets selected first; right-clicking a
  cell inside the existing selection leaves the selection unchanged.
  The column-header menu also offers **Hide column**, plus the sort
  and filter items described under [Sorting](#sorting) and
  [Filtering](#filtering). The platform's default Cut/Copy/Paste menu
  is suppressed elsewhere in the panel.
- A 5,000,000-cell hard cap protects against accidental huge clipboard
  writes; over the cap the panel shows a toast and refuses the copy.

### Keyboard shortcuts

| Key                | Action                                          |
| ------------------ | ----------------------------------------------- |
| `Home`             | Jump to the first column of the current row.    |
| `End`              | Jump to the last column of the current row.     |
| `Cmd/Ctrl+Home`    | Jump to the first cell (top-left of the grid).  |
| `Cmd/Ctrl+End`     | Jump to the last cell (bottom-right).           |
| `PageUp`           | Scroll one viewport up.                         |
| `PageDown`         | Scroll one viewport down.                       |
| `Cmd/Ctrl+A`       | Select all rows across visible columns.         |
| `Cmd/Ctrl+C`       | Copy the current selection as TSV.              |
| `Shift+Alt+A`      | Sort focused column ascending.                  |
| `Shift+Alt+D`      | Sort focused column descending.                 |
| `Shift+Alt+0`      | Clear all sorts.                                |

These are the data grid's built-in spreadsheet bindings: `Home` / `End`
move within the current row (first / last column), while `Cmd`/`Ctrl`
+`Home` / `End` jump to the first / last cell of the whole grid.

## Sorting

Right-click a column header to sort. The menu offers **Sort
ascending**, **Sort descending**, and the corresponding **Add
ascending to sort** / **Add descending to sort** when another column
is already sorted, plus **Clear sort on this column** (only when that
column is in the sort) and **Clear all sorts** (only when some sort is
active). Picking *Sort* replaces the sort with that column; picking
*Add to sort* appends it as the next priority key. Holding **Shift**
when picking *Sort ascending* / *Sort descending* is a shortcut for the
*Add* items.

A sorted column shows a hairline triangle on the right edge of its
header — ▲ for ascending, ▼ for descending. When more than one column
is in the sort, each sorted header also shows a small priority badge
(1, 2, 3 …) so you can see which key takes precedence at a glance.

A chip strip appears in the toolbar listing the active keys in
priority order. Click any chip to open a small popover with **Flip
direction**, **Remove from sort**, and (when applicable) **Move to
first**. The trailing **✕** on the strip clears every sort key.

### NA / NaN

Missing values — R's `NA`, floating-point `NaN`, and `NULL` — always
sort to the bottom in both ascending and descending order, matching
`order(..., na.last = TRUE)`. The `±Inf` sentinels sort numerically.

### Labels and Format

Sort follows what you see in the grid:

- A **factor** column sorts by integer level when Labels is off and by
  label string when Labels is on.
- A **value-labelled** column (`haven_labelled`, `foreign::value.labels`,
  `readstata13::read.dta13`) sorts by the underlying numeric when
  Labels is off and by the displayed label (or the raw value when no
  label exists for a cell) when Labels is on.
- **Numeric** columns always sort by the underlying double, even when
  the Format toggle is rounding the display.

Toggling Labels with a sort active on a labelled column will re-sort
the rows.

### Persistence

Sort state is persisted per panel-name + schema-hash alongside layout
and toolbar state, so a later `View(df)` against the same dataset
restores the sort. Only the sort keys (plus a snapshot of the Labels
state) are stored — the row
permutation is always recomputed against the current data on restore,
because schema-hash equality is not evidence that two datasets share
row values (column names and types can match while values differ).
Set `raven.dataViewer.persistSort` to `false` to make every panel
open unsorted.

### Reopening with a saved sort or filter

The grid itself paints instantly because it is virtualized — only the
visible window of rows is read at a time. Restoring a saved **sort** or
**filter**, however, requires reading the relevant column(s) in full to
recompute the permutation / survivor set, which on a multi-million-row
frame can take a few seconds. During that time the toolbar shows
**"Applying your saved sort & filter…"** (worded for whichever applies)
with a **Cancel** button, instead of a bare `Loading…`. The message only
appears if the restore takes longer than ~200 ms, so small datasets never
flash it. Rows still appear only in their final order — there is no
unsorted-then-sorted "jump".

**Cancel** abandons the restore, **forgets** the saved sort/filter for
that panel (clears the persisted entries), and shows the data in its
natural, unsorted/unfiltered order. This is distinct from a genuine read
failure: if reapplying the saved sort/filter fails for a real reason (a
corrupt or unreadable column), the panel opens in natural order, a notice
explains that the saved sort/filter could not be reapplied, and the saved
preferences are **kept** so the next reopen can retry.

### Sort indicator

The active sort keys appear as chips in the toolbar — one per key, in
priority order. While the host is building a large permutation, a
`Sorting…` pill appears beside the chips; it is the only progress cue,
as the data viewer has no bottom status bar.

## Filtering

Right-click a column header and choose **Filter…** to open the filter editor
for that column. You can also press **⇧⌥F** to open the editor for the
currently focused column.

When the column already has an active filter, the editor opens pre-populated
with that filter's current settings — the same predicate, values, and **Include
NA / NaN** state it had when you last applied it — so you edit in place rather
than starting over. In that case the context-menu item reads **Edit filter…**,
and applying updates the existing filter (it does not add a second one — see
[Composition](#composition)). On an unfiltered column the item reads
**Filter…** and the editor opens empty.

### Per-type predicates

| Column type | Available predicates |
| --- | --- |
| Numeric (Int, Float) | `=`, `≠`, `<`, `≤`, `>`, `≥`, `between`, `not between` |
| Labelled numeric (`haven_labelled`, `foreign`, `readstata13`) | `is one of`, `is not one of` (label checklist, matched by code) **plus** the full numeric set above |
| Factor | `is one of`, `is not one of` |
| Character | `contains`, `does not contain`, `starts with`, `ends with`, `=`, `≠`, `matches regex` |
| Boolean | `is true`, `is false` |
| Date / Timestamp | `=`, `≠`, `<`, `≤`, `>`, `≥`, `between`, `not between` |
| Any column | `is empty`, `is not empty` |

For numeric `between` / `not between`, the editor shows a histogram of the
column's distribution with draggable range thumbs alongside the numeric
input fields. The histogram is computed the first time you open that
column's filter (not up front when the table loads), so on a very large
frame it may appear a moment after the popover opens; it is cached
thereafter. This keeps the histogram scan off the initial load path, so
opening a table paints the grid without waiting for every numeric column to
be scanned.

For factor columns, the editor shows a searchable checklist of levels when
the column's value dictionary has been shipped; large or unshipped
dictionaries fall back to a free-text value list. For labelled numeric
columns the editor defaults to a searchable checklist of the labelled
values, each shown as label + underlying code, and also offers the full
set of numeric predicates via the condition dropdown.

The `matches regex` predicate for character columns uses ECMAScript (JavaScript)
regex syntax — not PCRE or R regex syntax. A **Case sensitive** toggle
controls whether all character predicates match case-sensitively.

Use `is empty` to select rows where a column is missing; `is not empty`
selects only non-missing rows.

### NA / NaN

By default, missing values (`NA`, `NaN`) fail every predicate and are
excluded from filtered results. Each filter editor has an **Include NA /
NaN** checkbox that re-includes missing rows for that specific filter.

### Labels and Format

Filters on labelled columns match the displayed string — the label when
Labels is on, the underlying code or value when Labels is off. This is the
same WYSIWYG rule as sorting: what you see is what is matched. Toggling
Labels with an active filter on a labelled column will re-evaluate the
filter.

Labelled **numeric** columns are the exception: their `is one of` /
`is not one of` checklist matches the **underlying numeric code**, not the
displayed label, so toggling Labels never changes which rows a labelled-numeric
filter keeps. The chip still shows the labels (for example `gender ∈ {Male,
Female}`). The numeric `compare` / `between` predicates likewise match the
underlying value, as for any numeric column.

The Format toggle and digits setting never affect filtering. Numeric
predicates always match the underlying double, regardless of how many digits
are shown in the grid.

### Chip strip

Active filters appear as chips in the toolbar. Each chip shows a short
summary of the filter condition (for example, `cyl ∈ {6, 8}` or `mpg > 20`).
Click a chip to re-open its editor. The kebab menu on each chip offers
**Edit**, **Enable** / **Disable** (disabled chips are shown greyed-out
and are not applied), and **Remove**. The trailing **✕** on the strip
clears all filters.

### Composition

Filters across different columns are combined with AND — a row must satisfy
all active filters to appear. At most one filter is allowed per column;
adding a second filter for the same column replaces the first.

### Filter indicator

Active filters appear as chips in the toolbar. The row-count readout in
the top-left reflects the filtered total — `Showing X-Y of N`, where `N`
is the count of rows passing all filters. While the host is rebuilding the
filter index a `Filtering…` pill appears beside the chips.

### Persistence

Active filters are persisted per panel-name × schema-hash alongside layout,
toolbar state, and sort, so a later `View(df)` against the same dataset
restores the filter configuration. Only the chip descriptors (predicate
type, values, enabled state, and the Include NA / NaN flag) are stored —
filter membership is always recomputed against the
current data on restore. Set `raven.dataViewer.persistFilters` to `false` to
open every panel unfiltered.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Shift+Alt+F` | Open filter editor for the focused column. |
| `Shift+Alt+X` | Clear filter on the focused column. |
| `Shift+Alt+9` | Clear all active filters. |
| `Enter` (in editor) | Apply the filter and close the editor. |
| `Escape` (in editor) | Cancel without applying. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `raven.dataViewer.missingValueStyle` | `foreground` | How NA / NaN cells are highlighted: `foreground` (colorize the text), `background` (tint the cell), or `none`. |
| `raven.dataViewer.maxStoredLayouts` | `10000` | LRU cap on persisted column-width / visibility entries. Each unique panel-name × schema-hash pair counts once. |
| `raven.dataViewer.defaultDigits` | `3` | Initial digits used when the Format toggle is on (Format defaults to on). Accepts `0`–`15`; the toolbar's digits dropdown only exposes `0`–`6`, so values above `6` only take effect as the *initial* digits and can't be picked from the dropdown afterwards. |
| `raven.dataViewer.persistSort` | `true` | Persist the active row sort per panel-name × schema hash. Set to `false` to make every `View(df)` open unsorted. |
| `raven.dataViewer.persistFilters` | `true` | Persist active filters per panel-name × schema hash. Set to `false` to open every panel unfiltered. |

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
  `"disabled"`, or `"auto"` while REditorSupport is enabled or
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
