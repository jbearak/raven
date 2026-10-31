# Data viewer

[Docs](README.md) › R session (VS Code)

Browse, sort, and filter data frames of any size in a VS Code panel by calling `View()` in Raven's R console.

<a id="why-we-built-this"></a>

```r
View(mtcars)
```

The data frame opens in a grid beside your editor. Raven writes it once to an Apache Arrow file on disk, and the grid reads only the rows you can see, so scrolling stays responsive on multi-million-row frames and paging never waits on R. Value labels from Stata and SPSS imports show as labels, not codes (see [Labels](#labels)). For how this compares with other R data viewers, see [Comparison: Data viewer](comparison.md#data-viewer).

The data viewer works only when Raven's R console is active, which by default it isn't when REditorSupport is enabled or you're in Positron; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting).

## Requirements

- The R [`arrow`](https://arrow.apache.org/docs/r/) package (`install.packages("arrow")`). If it's missing, Raven prints a warning in R and shows a VS Code warning notification when you call `View()`, then returns without interrupting the rest of your code.
- An R terminal Raven manages (the "R" terminal profile, or one launched by Raven's send-to-R commands). Plain R terminals you opened outside Raven don't have Raven's `View()`.

<a id="triggering"></a>

## Open a data frame

Call `View()` in the R terminal:

```r
View(mtcars)
View(head(iris, 50))
View(my_df, "Custom panel name")
```

The panel title is the second argument when you give one, otherwise the expression you passed (cut to 256 bytes, with `…`, if longer). A second `View(mtcars)` reuses the existing `mtcars` tab; a different expression opens a new tab.

## What it shows

- `data.frame`, including `tibble` and `data.table` subclasses. A frame with explicit row names (`View(mtcars)` shows the car names) gets a leading `rowname` column. Automatic row names (`1..N`) are never turned into a column; the row-number gutter shows them instead. If the frame already has a column called `rowname`, the new one is called `.rowname` (then `..rowname`, and so on).
- `matrix`. Non-default rownames appear as a leading `rowname` column, named the same way; automatic `1..N` rownames are dropped in favor of the row-number gutter.
- Atomic vectors and scalars (`numeric`, `integer`, `character`, `logical`, `complex`, `Date`, `POSIXct`), plus standalone `factor` and `haven_labelled` vectors. A vector renders as a `values` column (a `value` column when it has length 1). If the vector has `names()`, they appear in a leading `name` column, the same role the `rowname` column plays for a matrix. A standalone `factor` or `haven_labelled` vector keeps its labels, so the [Labels](#labels) toggle works on it. A 1-D array (`array(1:3)`) renders the same way as a vector, with its `dimnames` as the `name` column.
- Flat lists, where every element is a scalar or vector. Each element becomes a column, padded with empty (`NA`) cells to the length of the longest element, and each column keeps its own type. Unnamed elements get `V1`, `V2`, … headers. So `c(a = 1, b = 2)` is a two-row `name`/`values` table, while `list(a = 1, b = 2)` is a one-row, two-column table, matching `as.data.frame(list(a = 1, b = 2))`.

Other objects raise an error in R that says why:

```r
> View(sum)
Error: Can't `View()` an object of class `function`
```

- A nested list (an element that is itself a list or `data.frame`, or otherwise not a plain vector) names the offending element rather than the `list` class, for example `` Can't `View()` this list: element `b` has class `list`. Only flat lists (every element a vector) are supported. `` An empty list reports `` Can't `View()` an empty list. ``
- An array with more than two dimensions (a 3-D or higher array, or a 3-way or higher `table`) reports its dimension count: `` Can't `View()` an array with 3 dimensions; the data viewer shows 2-dimensional tables only. ``
- `raw` vectors, environments, functions, and other unsupported classes get the class-based message shown above.

## Reading the header

Each column header has up to three lines and a thin bar along its bottom edge:

```text
┌──────────────────────┐
│ mpg                ▲2│  column name; sort direction and priority at the right
│ <dbl>                │  type
│ Miles per gallon     │  variable label
│ ▁▂▅█▆▃▁  3% NA · 25  │  summary band (Σ), see Column summaries
└──────────────────────┘
  ▔▔▔▔                    share of NA values
```

- The **type** line uses the same short tags as tibble: `<int>`, `<dbl>`, `<chr>`, `<lgl>`, `<fct>`, `<ord>`, `<date>`, `<dttm>`, `<drtn>`, `<cpl>`, and `<list>`. Columns with value labels add `+lbl` (`<dbl+lbl>`). A date-time column names the time zone its values are shown in (`<dttm America/New_York>`), and a duration names its unit (`<drtn secs>`).
- The **label** line shows the variable label (`attr(col, "label")`). It appears only when at least one column has a label, and the Labels toggle doesn't hide it.
- The **missing bar** fills in proportion to the column's share of NA values. Raven counts them in the background after the grid first appears; until the count is done, the bar is dashed.
- The **summary band** appears while the Σ toggle is on. See [Column summaries](#column-summaries).
- Long names and labels end in `…`. Hover over a header for the full name and label, the R class, the source display format, the exact NA count and share, and the first few value labels.

## Missing values and row numbers

- A missing value shows the literal `NA` in italics, so it never looks like an empty string. `NaN` shows as `NaN`, also in italics, and stays distinct from `NA`. An empty string shows nothing. The `raven.dataViewer.missingValueStyle` setting picks muted text, a tinted background, or plain italics.
- The gutter on the left shows each row's R row number, the number you'd use in `df[i, ]`. It keeps that number after you sort or filter, so row 18 stays 18 wherever it lands. While a filter is active, the gutter's header shows how many rows pass, such as `12 / 32`.
- The gutter and any `rowname` column stay in place when you scroll right. Together they take at most half the panel's width; past that, the `rowname` column is shortened with `…`.

## Toolbar

```text
32 × 11   Sort: mpg ▲ cyl ▼ ✕   Filter: cyl ∈ {6,8} ✕    [Σ] [Labels] [Format] [3 ▾] [Columns 2] [⋯]
…grid…
rows 1–20 of 12 (filtered from 32) · 11 cols                 6 cells · Σ 120.4 · mean 20.07
```

The left end of the toolbar shows the frame's shape, rows × columns, or `12 of 32 rows × 11` while a filter is active. The status line under the grid shows the exact range of rows on screen and the filter context, and, on the right, a summary of the selection (see [Selection and copy](#selection-and-copy)). The ⋯ button holds [Find](#find), [Go to row](#go-to-row), [Copy as R code](#copy-as-r-code), and [Refresh](#refresh).

The Sort and Filter strips are hidden when no sort or filter is active. When the panel is too narrow for the strips beside the buttons, the strips move to a second row so Σ, Labels, Format, and Columns stay reachable. Each strip scrolls horizontally on its own row if its chips still overflow. The toolbar doesn't flicker between one and two rows as you resize the panel across that width.

Each toggle is filled when active; click to flip it. The Labels and Format buttons (and the digits dropdown) are hidden when no column in the data would be affected. For example, an all-integer matrix hides all three, while a frame with only factors hides Format and digits but keeps Labels. The badge on Columns counts the hidden columns and is absent when none are hidden.

### Labels

On by default in new panels. When on, columns with labels show their labels instead of raw values:

- `factor` columns show the level string instead of the integer code (1-based, matching `as.integer(factor_col)` in R).
- `haven_labelled` columns (from `haven::read_dta`) and other columns with `attr(col, "labels")` (haven) or `attr(col, "value.labels")` (`foreign::read.dta`, `readstata13::read.dta13`) show the matching label, or the raw value when no label is mapped.
- Columns without label metadata are unchanged.

Labels shown as text are left-aligned; with Labels off, labelled numbers are right-aligned like other numbers. The variable label (`attr(col, "label")`) always appears in the header's label line and tooltip, whatever the toggle says.

### Format

On by default in new panels. When on, non-integer numeric columns are rounded to the digits chosen in the dropdown (0–6, default 3). Integer columns, dates, timestamps, factors, and string columns are unaffected. `NaN` and ±Inf show as `NaN`, `Inf`, and `-Inf`; they aren't formatted away.

- A nonzero value never shows as zero. A value that would round to zero, or one of 1e15 or more in size, switches to scientific notation (`1.23e-10`).
- A whole number in a decimal column (for example `5` among `1.5` and `2.25`) shows as `5`, not `5.000`, which avoids the misleading trailing zeros common in SPSS and SAS files. It's padded so the decimal points still line up.
- A number too wide for its column shows `###` rather than its leading digits. Hover over it for the full value, or widen the column.
- With Format off, numbers show at full precision, with R-style exponents (`1e-07`).

When a column carries a display format from Stata, SPSS, or SAS (`haven` keeps it), Format uses it instead of the dropdown. Raven honors Stata `%w.df`, `%w.dfc` (with thousands separators), and `%w.dg` (significant digits), and SPSS and SAS `Fw.d`, `COMMAw.d`, `DOLLARw.d` (with a `$`), `PCTw.d` and `PERCENTw.d` (with a `%`, value unchanged), and `Zw.` (zero-padded). Other formats fall back to the dropdown. A column formatted for whole numbers (`%9.0f`, `F8.0`) is treated like an integer column, and the toggle is hidden when no other column would be affected.

### Dates and times

Dates print as `2024-03-01`, and date-times as `2024-03-01 09:00:00` in the column's own time zone (its `tzone` attribute), or the R session's zone when it has none. Hover over a date-time for the UTC offset in effect at that moment, so the two 01:30s on the night clocks fall back are told apart. Fractional seconds show 0, 3, or 6 digits, chosen once per column so the width doesn't change as you scroll. Years before 1 and after 9999 print as R prints them (`-044`, `10000`). A value too far from 1970 for the viewer to show reads `<out of range>`; hover for its raw seconds. If a time zone name isn't recognized, values show in UTC and the type line says so.

<a id="columns-popover"></a>

### Columns sidebar

The Columns button opens a sidebar at the right of the grid with one row per column: a checkbox to show or hide it, its name, type, and label, a bar and percentage for its missing values, its distinct count, and a small chart of its values (the same chart as the [summary band](#column-summaries)).

- Type in the search box to find columns by name or label. The Sort menu orders the list by position, name, type, % missing, or distinct count; the arrow button flips the order.
- Click a row to scroll the grid to that column and select it. Clicking a hidden column's row shows it first.
- Click the ▸ at the start of a row, or press `→`, to see the column's summary. See [What a summary shows](#what-a-summary-shows).
- Show all and Hide all change every column at once.
- Drag the sidebar's left edge to resize it (260 px to start). It lists thousands of columns without slowing down, because only the rows on screen are drawn.
- With the list focused, `↑` and `↓` move between rows, `Enter` jumps to the column, `Space` shows or hides it, and `Escape` closes the sidebar. `Shift+Alt+S` in the grid opens the sidebar on the focused column's row.

Hidden and shown columns are remembered for the panel name and the data's column layout, so the same `View(mtcars)` opened tomorrow keeps the layout.

### Pinned columns

Right-click a column header and choose Pin column to keep it in place when you scroll right. Pinned columns sit after the row numbers and any `rowname` column, in the order you pinned them. Choose Unpin column to put a column back where it was. Pins are remembered with the widths and hidden columns.

The row numbers, `rowname` column, and pinned columns together take at most half the panel's width. When pinning another column would pass that, Raven doesn't pin it and says why; unpin a column or narrow one first.

Columns start wide enough for their name, type, label, and first loaded values, up to 400 px. Drag a header border to resize (40 to 3,200 px), or double-click it to fit the loaded values; dragged widths are remembered with the layout. Frames whose row names became a `rowname` column count as a new column layout, so their saved widths, hidden columns, sort, and filters reset once after updating Raven.

### Selection and copy

- Click a cell, then Shift-click another to select the rectangle between them. Click-drag also extends the selection.
- Click a column header to select that column; drag across headers to select several adjacent columns.
- Click a row number in the gutter to select that row. Shift-click another row number to extend the selection, and Cmd/Ctrl-click to add or remove one row.
- `Cmd/Ctrl+A` selects every row across all visible columns.
- `Cmd/Ctrl+C` copies the selection as tab-separated text. Copying follows the current Labels, Format, and digits settings, so you copy what you see. Missing values copy as empty fields.
- Column-header selections and `Cmd/Ctrl+A` selections include the column-name row when copied. Cell and row selections copy data only, as in spreadsheets.
- Row numbers and the `rowname` column aren't copied. Choose Copy with row names from the right-click menu to include the `rowname` column, or, for a frame without one, the R row numbers.
- Double-click a cell, or press `Enter`, to see a long or cut-off value in full (up to 64 KiB) with a Copy button.
- Right-click a cell or column header for a Copy menu that copies the current selection. Right-clicking a column header always selects just that column first. Right-clicking a cell outside the selection selects it first; right-clicking a cell inside the selection keeps the selection.
- The column-header menu also offers Hide column, [Pin column](#pinned-columns), and [Value counts](#value-counts), plus the items described under [Sorting](#sorting) and [Filtering](#filtering). The default Cut/Copy/Paste menu is turned off elsewhere in the panel.
- Copying is capped at 5,000,000 cells. Over the cap, the panel shows a message and doesn't copy.
- The status line sums up the selection. With numbers loaded on screen, it reads like `6 cells · 1 NA · Σ 120.4 · mean 20.07`: the cell count, the missing numeric cells (`NA` and `NaN`), and the sum and mean of the rest. Text and label columns count toward the cells but not the sum. A selection over more than 100,000 cells, or one that reaches rows not loaded yet, shows only the cell count.

<a id="keyboard-shortcuts"></a>

### Grid shortcuts

| Key | Action |
| --- | --- |
| `Home` | Jump to the first column of the current row. |
| `End` | Jump to the last column of the current row. |
| `Cmd/Ctrl+Home` | Jump to the first cell (top-left of the grid). |
| `Cmd/Ctrl+End` | Jump to the last cell (bottom-right). |
| `PageUp` | Scroll one screen up. |
| `PageDown` | Scroll one screen down. |
| `Cmd/Ctrl+A` | Select all rows across visible columns. |
| `Cmd/Ctrl+C` | Copy the current selection as tab-separated text. |
| `Cmd/Ctrl+F` | [Find](#find) in the visible columns. |
| `Cmd/Ctrl+G` | [Go to row](#go-to-row). |
| `Enter` | Show the focused cell's full value when it's long or cut off. |
| `Shift+Alt+A` | Sort the focused column ascending. |
| `Shift+Alt+D` | Sort the focused column descending. |
| `Shift+Alt+0` | Clear all sorts. |
| `Shift+Alt+S` | Open the Columns sidebar on the focused column. |

## Sorting

Right-click a column header to sort. The menu offers:

- Sort ascending and Sort descending, which replace the current sort with this column.
- Add ascending to sort and Add descending to sort, when another column is already sorted. These add this column as the next key. Holding Shift while choosing Sort ascending or Sort descending does the same.
- Clear sort on this column, when this column is sorted.
- Clear all sorts, when any sort is active.
- Sort text by: Natural, Alphabetical, or As dplyr (fast), for how text and labels sort (see [Text order](#text-order)). Explain… at the bottom of the submenu opens that section.

A sorted column shows a thin triangle at the right edge of its header: ▲ for ascending, ▼ for descending. When more than one column is sorted, each sorted header also shows a small priority badge (1, 2, 3 …) so you can see which key comes first.

The toolbar's Sort strip lists the active keys in priority order. Click a chip for Flip direction, Remove from sort, and, when it applies, Move to first. The ✕ at the end of the strip clears every sort key.

<a id="sort-indicator"></a>

While Raven sorts a large frame, a `Sorting…` pill appears beside the chips. It is the only progress cue; the data viewer has no status bar. Sorting and filtering run on a background thread, so the editor and the grid stay responsive, and you can keep scrolling the current rows until the new order arrives.

<a id="text-order"></a>

### Text order

Text columns, and labelled columns sorted by label, sort in one of three orders. Pick one under Sort text by in the column header menu. Each item shows a short example of its order. The panel remembers your choice for the panel name and the data's column layout, and the next sort uses it.

| Order | Sorts like | Example |
|---|---|---|
| Natural (default) | Your VS Code display language's collation, with runs of digits compared as numbers | `a`, `A`, `file_2`, `file_10` |
| Alphabetical | Your VS Code display language's collation, character by character | `a`, `A`, `file_10`, `file_2` |
| As dplyr (fast) | Unicode code points, with every uppercase letter before every lowercase one, as `dplyr::arrange()` (dplyr 1.1.0 and later) and `sort(method = "radix")` | `A`, `a`, `file_10`, `file_2` |

When the order isn't Natural, the Sort strip shows an `Alphabetical` or `As dplyr` chip. Natural and Alphabetical compare every distinct value with a collator, which can take tens of seconds on a column with a million distinct values. When such a sort runs past 3 seconds, the `Sorting…` pill offers Switch to dplyr order (fast), which re-sorts in As dplyr order instead. Text that the collator treats as equal, such as an accented letter typed as one character or as a letter plus a combining accent, ties and keeps its original row order.

<a id="na--nan"></a>

### Missing values in sorts

Missing values always sort to the bottom, ascending or descending, matching `order(..., na.last = TRUE)`: `NaN` rows come just below every value, and `NA` rows below them. `Inf` and `-Inf` sort as numbers, and `-0` ties with `0`. Rows that tie keep their original order.

<a id="labels-and-format"></a>

### Sorting with Labels and Format

Sort follows what you see in the grid:

- A factor column sorts by integer level when Labels is off and by label when Labels is on.
- A value-labelled column (`haven_labelled`, `foreign` value labels, `readstata13::read.dta13`) sorts by the underlying number when Labels is off and by the displayed label (or the raw value where a cell has no label) when Labels is on.
- Numeric columns always sort by the underlying number, even when Format rounds the display.

Toggling Labels while a labelled column is sorted re-sorts the rows.

<a id="persistence"></a>

### Saved sorts

The sort is remembered for the panel name and the data's column layout, along with the column layout and toolbar state, so a later `View(df)` of the same data restores it. Only the sort keys (and the Labels state) are saved. The row order is always recomputed from the current data, because two data frames can have the same column names and types but different values. Set `raven.dataViewer.persistSort` to `false` to open every panel unsorted.

### Reopening with a saved sort or filter

The grid itself appears at once, because only the visible rows are read. Restoring a saved sort or filter, though, reads the affected columns in full, which can take a few seconds on a multi-million-row frame. If it takes longer than about 200 ms, the toolbar shows "Applying your saved sort & filter…" (worded for whichever applies) with a Skip and show data now link.

Skip and show data now stops the restore, forgets the saved sort and filter for that panel, and shows the data in its original order. A real read failure is different: if a corrupt or unreadable column stops the saved sort or filter from being applied, the panel opens in the original order with a notice, and keeps the saved settings so the next reopen can try again.

## Filtering

Right-click a column header and choose Filter… to open the filter editor for that column, or press `Shift+Alt+F` (⇧⌥F) for the focused column.

If the column already has a filter, the menu item reads Edit filter…, and the editor opens with that filter's predicate, values, and Include NA / NaN setting, so you edit it in place. Applying updates the existing filter rather than adding a second one (see [Composition](#composition)). On an unfiltered column the item reads Filter… and the editor opens empty.

### Per-type predicates

| Column type | Available predicates |
| --- | --- |
| Numeric (Int, Float) | `=`, `≠`, `<`, `≤`, `>`, `≥`, `between`, `not between` |
| Labelled numeric (`haven_labelled`, `foreign`, `readstata13`) | `is one of`, `is not one of` (label checklist, matched by code), plus the full numeric set above |
| Factor | `is one of`, `is not one of` |
| Character | `contains`, `does not contain`, `starts with`, `ends with`, `=`, `≠`, `matches regex` |
| Boolean | `is true`, `is false` |
| Date / Timestamp | `=`, `≠`, `<`, `≤`, `>`, `≥`, `between`, `not between` |
| Any column | `is empty`, `is not empty` |

For numeric `between` and `not between`, the editor shows a histogram of the column with draggable range handles beside the number fields. The histogram is computed the first time you open that column's filter, not when the table loads, so on a very large frame it may appear a moment after the editor opens. It is cached after that, and opening a table never waits for histograms.

For factor columns, the editor shows a searchable checklist of levels when the levels are available to the panel; columns with very many levels fall back to a free-text value list. For labelled numeric columns, the editor defaults to a searchable checklist of the labelled values, each shown as label plus code, and also offers the numeric predicates in the condition dropdown.

`matches regex` uses JavaScript regular-expression syntax, not PCRE or R regex syntax. A Case sensitive toggle controls whether all character predicates match case-sensitively.

Use `is empty` to keep rows where a column is missing, and `is not empty` to keep only rows where it isn't.

<a id="na--nan-1"></a>

### Missing values in filters

By default, missing values (`NA`, `NaN`) fail every predicate and are left out of filtered results. Each filter editor has an Include NA / NaN checkbox that keeps missing rows for that filter.

<a id="labels-and-format-1"></a>

### Filtering with Labels and Format

Filters on labelled columns match the displayed text: the label when Labels is on, the underlying code or value when it is off. This is the same what-you-see rule as sorting. Toggling Labels while a labelled column is filtered re-evaluates the filter.

Labelled numeric columns are the exception. Their `is one of` and `is not one of` checklist matches the underlying numeric code, not the label, so toggling Labels never changes which rows such a filter keeps. The chip still shows the labels (for example `gender ∈ {Male, Female}`). Comparisons and `between` also match the underlying value, as for any numeric column.

Format and the digits setting never affect filtering. Numeric predicates always match the underlying number, however many digits the grid shows.

### Chip strip

Active filters appear as chips in the toolbar, each with a short summary such as `cyl ∈ {6, 8}` or `mpg > 20`. Click a chip to reopen its editor. Each chip's menu offers Edit, Enable / Disable (disabled chips are greyed out and not applied), and Remove. The ✕ at the end of the strip clears all filters.

### Composition

Filters on different columns combine with AND: a row must pass all active filters to appear. Each column has at most one filter; adding a second filter for the same column replaces the first.

### Filter indicator

The shape at the top left shows the filtered total as `N of M rows × C`, where `N` is the number of rows that pass all filters, and the gutter's header shows `N / M`. If no row passes, the grid says "No rows match these filters" and offers Clear filters. While Raven recomputes the filter, a `Filtering…` pill appears beside the chips.

<a id="persistence-1"></a>

### Saved filters

Active filters are remembered for the panel name and the data's column layout, along with the column layout, toolbar state, and sort, so a later `View(df)` of the same data restores them. Only the filter definitions (predicate, values, enabled state, and the Include NA / NaN setting) are saved; which rows pass is always recomputed from the current data. Set `raven.dataViewer.persistFilters` to `false` to open every panel unfiltered.

<a id="keyboard-shortcuts-1"></a>

### Filter shortcuts

| Key | Action |
| --- | --- |
| `Shift+Alt+F` | Open the filter editor for the focused column. |
| `Shift+Alt+X` | Clear the filter on the focused column. |
| `Shift+Alt+9` | Clear all active filters. |
| `Enter` (in editor) | Apply the filter and close the editor. |
| `Escape` (in editor) | Cancel without applying. |

## Column summaries

Every column can show a summary of its values: a small chart in the header, and the numbers behind it in the Columns sidebar. Summaries always describe all the rows of the data, not the rows a filter leaves, and the tooltip says so ("Summary of all 32 rows").

### Summary band

The Σ button adds a band under each header. It's on by default for data with up to 200 columns and up to 1,000,000 rows, and off for anything larger. Click Σ to turn it on or off; the choice is remembered with the other toolbar toggles.

```text
mpg  <dbl>   ▁▂▅█▆▃▁  3% NA · 25       numbers, dates, date-times: a 20-bar histogram
origin <fct> █ ▆ ▃    0% NA · 3        factors, labelled and text columns: the 5 most common values
am  <lgl>    ████▒▒▒  5% NA · 2        logicals: TRUE, FALSE and NA shares
```

After the chart, the band shows the share of missing values (`NA` and `NaN`) and the number of distinct values. A summary appears a moment after its column comes into view, while a faint placeholder marks the ones still being computed. Raven summarizes only the columns on screen, one at a time, and only while the panel is visible; scrolling and sorting never wait for a summary. A summary that can't be computed shows `—`, and its tooltip gives the reason.

Hover over a bar to see the range or value it counts and how many rows it holds.

### Filter from the band

- Click a histogram bar to filter to the rows in it. Drag across bars, or click one and Shift-click another, to filter to the range they cover.
- Each bar counts values from its lower edge up to, but not including, its upper edge; the last bar includes its upper edge. The filter uses the same edges, so the number of rows it keeps equals the bars' total. The chip reads like `mpg ∈ [15.2, 19.4)`, and you can edit it like any other filter.
- Click one of the most-common-value bars to filter to that value.
- Date and date-time histograms don't filter when clicked; use the column's filter instead.

### What a summary shows

Expand a column in the Columns sidebar to see its summary:

- **Numbers**: rows with a value, NA, NaN, distinct count, minimum, 25th percentile, median, mean, 75th percentile, maximum, and standard deviation. Percentiles use R's default `quantile()` method.
- **Factors and labelled columns**: how many of the declared levels or labels occur ("31 of 32 used", since unused levels are common after subsetting), and the count and share of each level, for up to 24 levels.
- **Text**: distinct count, empty strings, shortest and longest length in characters, and the 5 most common values.
- **Logicals**: TRUE, FALSE, and NA counts.
- **Dates and date-times**: earliest, latest, and the time zone.

Distinct counts leave out `NA` and `NaN`, as `length(unique(x[!is.na(x)]))` does in R.

### Exact and estimated values

Most numbers in a summary are exact. On very large or very varied columns, a few are estimated so the summary stays fast, and every estimate starts with `≈`:

- Counts of NA and NaN, minimum, maximum, mean, standard deviation, and the histogram are always exact.
- Percentiles are exact up to 100,000 values, or once the column has been sorted in this panel. Beyond that they come from a random sample of 100,000 values.
- Distinct counts are exact for factors, and for other columns up to 100,000 distinct values. Beyond that they're estimated, usually within 1 to 2%.
- Most-common values have exact counts up to 100,000 distinct values. Beyond that, each count shows how far off it can be, as `≈ 4,210 ± 12`. When those margins mean two values could be in either order, the list says "approximate order".

### Value counts

Right-click a column header and choose Value counts… to list the column's values with their count, share of rows with a value, and a bar, most common first. Check Rarest first to reverse the order; it's available when every count is exact.

Click values to select them, then click Filter to keep only the rows with those values. This replaces any filter already on the column. For a date column, pick one date.

## Find, go to row, and R code

### Find

Press `Cmd/Ctrl+F` in the panel, or choose Find… from ⋯, and type. Raven searches the text the grid shows in the visible columns, so with Labels on it finds labels, with Format on it finds rounded numbers, and `NA` finds missing cells. Case doesn't matter.

- The first match at or below the selected row is selected and scrolled into view. The bar shows which match it is and how many there are, such as `3 of 120`.
- `Enter` or ↓ goes to the next match, `Shift+Enter` or ↑ to the previous one; both wrap around. Matches run top to bottom in the grid's current order.
- Typing more letters searches only the rows that already matched, so a long search narrows quickly.
- The search runs in the background on large data; Cancel stops it. Sorting, filtering, or changing Labels, Format, or the visible columns searches again.
- `Escape` closes the bar.

### Go to row

Press `Cmd/Ctrl+G`, or choose Go to row… from ⋯, then type a row number and press `Enter`.

- A plain number is the R row number, the one in the gutter and in `df[i, ]`: `120` goes to row 120 wherever a sort put it. If a filter hides that row, the bar says so.
- `#` and a number counts rows as they're shown: `#1` is the top row and `#120` the 120th from the top, whatever its R row number.

### Copy as R code

Choose Copy as R code (dplyr) from ⋯, or base R or data.table from the Copy as R code submenu. Raven copies R code that rebuilds the view from the expression you passed to `View()`: the filters, the sort, and the hidden columns.

```r
# mtcars as shown in Raven's data viewer
# Requires R >= 4.1 (|>), dplyr >= 1.1.0

library(dplyr)

mtcars |>
  filter(
    cyl %in% c(6, 8),
    mpg > 20
  ) |>
  arrange(desc(mpg), is.na(mpg) & !is.nan(mpg)) |>
  select(-c(disp, hp))
```

The code returns the same rows in the same order as the grid:

- Missing values are handled as the viewer handles them. A filter drops `NA` (and `NaN` in numbers) unless you checked "Include missing", which the code writes as `is.na(x) | …`.
- Filters on factor and labelled columns use labels when Labels was on and codes or values when it was off, as in the viewer.
- Missing values sort last in both directions, with `NaN` before `NA`. dplyr and base R otherwise mix the two, so a sort on a column that might hold `NaN` adds an `is.na(x) & !is.nan(x)` term. Once a column's summary shows it has no `NaN`, the term is left out.
- Text sorts follow the [text order](#text-order): As dplyr becomes `.locale = "C"`, Alphabetical becomes `.locale` with your VS Code display language, and Natural becomes `stringr::str_rank(x, locale = …, numeric = TRUE)`. Natural and Alphabetical use the same collation library (ICU) in R and in the viewer, but R and VS Code can ship different versions of it, which can order rare characters differently; the code says so in a comment.
- A frame's row names become a `rowname` column with `tibble::rownames_to_column()` (dplyr) or `keep.rownames` (data.table) when a filter or sort uses them; base R uses `rownames()`.
- The comment at the top names the packages the code needs.

Copy as R code works for data frames and matrices. Raven needs the expression you passed to `View()`, so a panel opened before updating Raven, or from an expression longer than 64 KiB, can't produce code until you call `View()` again. A filter Raven can't write faithfully (for example, a value list on a date column) is left out and named in a comment rather than approximated.

### Refresh

The data in a panel is a copy taken when you called `View()`. To see new values, choose Refresh… from ⋯. Raven shows the `View()` call it will run and asks first, because running the expression again repeats anything it does, such as reading a file. After you confirm, it runs the call in the R console.

If the new data has the same columns (same names and types, in the same order), the sort, filters, widths, hidden columns, and pins stay. If the columns changed, the panel opens like a new one. A panel opened with a title, as in `View(df, "Survey")`, refreshes into the same panel.

## Troubleshooting

- Nothing happens when you call `View(df)`. Check that Raven started the terminal (the "R" entry in the terminal profile dropdown, or a send-to-R command), and that `requireNamespace("arrow")` returns `TRUE`. Also check that Raven's R console is active; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting).
- You see "Raven data viewer requires the 'arrow' package". Run `install.packages("arrow")` in the same R installation.
- The Labels toggle doesn't change a column. The column has no label metadata. For `haven_labelled` columns, this means `attr(col, "labels")` is empty.
- A frame with zero rows shows "No rows" under its column headers.
- Copying fails with "Selection exceeds copy limit". The 5,000,000-cell cap is intentional; select less, or export the slice from R.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `raven.dataViewer.missingValueStyle` | `foreground` | How NA / NaN cells are highlighted: `foreground` (colored text), `background` (tinted cell), or `none`. |
| `raven.dataViewer.maxStoredLayouts` | `10000` | Maximum saved column-width and visibility entries; the least recently used are dropped first. Each panel name and column layout counts once. |
| `raven.dataViewer.defaultDigits` | `3` | Initial digits when Format is on. Accepts `0`–`15`, but the toolbar dropdown offers only `0`–`6`, so higher values apply only as the initial setting. |
| `raven.dataViewer.persistSort` | `true` | Remember the sort per panel name and column layout. `false` opens every `View(df)` unsorted. |
| `raven.dataViewer.persistFilters` | `true` | Remember filters per panel name and column layout. `false` opens every panel unfiltered. |

Changes apply to newly opened panels. There is no separate on/off setting for the data viewer; it follows Raven's R console. See the [settings reference](settings-reference.md) for all settings.

## Details

### How it works

1. When Raven starts an R terminal, its startup profile (loaded through `R_PROFILE_USER`) installs Raven's `View()` in the global environment before it sets up the plot viewer. If plot-viewer setup fails, `View()` still works.
2. `View(df)` writes the data frame to an Apache Arrow (Feather v2) file in the extension's storage folder, including variable labels and value labels.
3. The panel reads rows from that file on demand as you scroll, without going back to R. Reads for the visible rows and full-column work (sorting, filtering, counting missing values) each run on their own background thread, so neither blocks the editor or the other. Raven only accepts files from its own data-viewer folder.

The same file backs the panel for as long as it's open, and closing the panel deletes it. When the extension starts, it removes leftover data-viewer files older than 24 hours.

## See also

- [R console](r-console.md)
- [Debugger](debugger.md): open a data frame from the Variables view
- [Comparison: Data viewer](comparison.md#data-viewer)
- [Coexistence with other R extensions](coexistence.md)
