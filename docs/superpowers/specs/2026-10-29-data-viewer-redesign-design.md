# Data viewer redesign: look, feel, and performance

Status: plan, revision 12, agreed by both reviewers (Claude Sonnet and GPT-6.1 Terra). Each revision's reviewer objections are folded in, and the closing sections map each one to the edit that addressed it.

## Goal

Make Raven's `View()` beat each surveyed viewer, on the axes below, for an R user. The surveyed viewers are Positron's Data Explorer, RStudio's 2026 viewer, VS Code Data Wrangler, vscode-R, the Julia VS Code table viewer, and the user's own table-viewer. The axes, in priority order:

1. **It never misrepresents the data.** NA is visible and distinct from `""` and from `NaN`, row identity survives sort and filter, rownames are kept, timestamps show their real zone, small numbers don't round to zero, estimates are labelled as estimates.
2. **It reads like R.** Headers carry the pillar type tag and the variable label; value labels, factors, and a named set of Stata/SPSS/SAS display formats are first-class.
3. **It answers "what's in this column?" without a filter round trip.** Missing share, distinct count, distribution, and summary stats for every column, with a navigator for wide frames.
4. **It stays fast on long frames (10M rows) and wide ones (2,000 columns),** with budgets measured end to end from `View()`, checked in CI. The 2,000-column target depends on the F2 spike passing; if it fails, the fallback's narrower contract (F2) applies and the docs say so.

These are targets. The "Acceptance" section turns them into checks on Raven. The "Comparative evaluation" section measures every surveyed tool on the same fixtures, fidelity battery, and tasks, with winning rules fixed in advance. Raven claims an advantage only on an axis and tool pair where it wins that evaluation. There is no blanket "best viewer" claim.

## Prior art and what we take from it

Full notes: `2026-10-29-data-viewer-prior-art.md`. Licenses were checked against Raven's GPL-3.0. "Copy" means code may be reused with notices; "study" means design only.

| Source | License | What we take |
|---|---|---|
| table-viewer (user's project) | GPL-3.0, copy | Theme-token mapping with alpha-clamped selection (`vscode-theme.ts`), one font-size variable driving canvas and chrome, auto-fit measurement (`fit-column-model.ts`), sort glyph drawing (`header-sort-glyph.ts`), page-aligned row loader with a cell- and byte-bounded LRU (`row-loader.ts`), state-strip chip CSS, benchmark gate (`benchmarks/grid`). Not its 8k-line shell or its spreadsheet assumptions. |
| Positron Data Explorer | Elastic 2.0, study | Summary panel (type icon, sparkline, missing bar, expandable stats, click to jump), async profiles for visible columns only, "Convert to Code", failed-vs-loading distinction (positron#16819). Its weak spot, labels only in a tooltip (positron#14239), is one Raven shares today. |
| ark (Positron's R backend) | MIT, copy | `format.rs` number formatting options, `convert_to_code.rs` dplyr emission, `summary_stats.rs` stat set. |
| RStudio 2026 viewer | AGPL-3, study | Label as a visible second header line; per-type summary set; budgets (≤ 24 category bars, skip width scans > 200 columns); never materialize row names (rstudio#1705); `colsFingerprint` to keep or drop saved state. |
| Data Wrangler | proprietary, study | Quick-insights band in the header: missing count, distinct count, mini histogram or top values. |
| pillar / tibble | MIT, copy | Type tags, NA as a styled literal, scientific fallback, decimal alignment within a column. |
| VisiData | GPL-3, copy | Frequency sheet (value, count, %, bar; pick to filter). |
| vscode-R | MIT, copy | NA in muted italics; ordered factors sort by level order; filtered/total in the gutter header; viewing never touches `.Random.seed`. |
| julia-vscode | MIT, copy | Fetch block size inversely proportional to column count. |
| Glide Data Grid | MIT (already a dependency) | Keep as renderer; see "Renderer decision". |
| Perspective / regular-table | Apache-2.0, copy | Viewport data contract: one request in flight per viewport, superseded requests dropped. |

## Where the viewer stands today

Verified in code (paths relative to `editors/vscode/src/data-viewer/` unless rooted):

**Correctness and design**
- NA renders as an empty string (`webview/cell-render.ts:20`); under the default `missingValueStyle: 'foreground'` it is indistinguishable from `""`, and screen readers get nothing. `NaN` is already a separate wire kind (`{_:'nan'}`) and prints `NaN`.
- `View(mtcars)` drops the car names: rownames are kept only for matrices (`editors/vscode/src/plot/r-bootstrap-profile.ts:399-405`).
- The gutter numbers display order, not R row numbers. The host already returns `originalRowIndices` (`arrow-reader.ts:344`, `panel.ts:1338`); the webview ignores them.
- Non-UTC `POSIXct` prints UTC clock time followed by the zone name (`wire-format.ts:75-81`).
- Every column width, including a user's drag, is clamped to 72–320 px (`webview/grid-model.ts:28-36`). Default widths come from the length of the Arrow type string, which is never shown.
- `toFixed(digits)` turns `1e-10` into `0.000` (`webview/cell-render.ts:50`). Whole-number doubles print as `5` next to `5.250`, misaligning the decimal point (`cell-render.ts:49`).
- Source display formats (`format.stata` / `format.sas` / `format.spss`) are captured as `raven.format` but used only to detect integer-formatted doubles (`r-bootstrap-profile.ts:314-328`).
- The header draws the sort glyph over the title and clips without an ellipsis (`webview/App.tsx:1599-1617`). The variable label is an 11 px subtitle only when present; there is no type indicator.
- Chrome uses the editor's monospace font; the canvas ignores `editor.fontSize`; CSS fallbacks are dark-theme colors.
- No empty state for zero rows or a filter that matches nothing.
- `isNotEmpty` keeps NA rows when `includeMissing` is set (`filter.ts:89, 120`), and a test enshrines it (`tests/bun/data-viewer-filter-engine.test.ts:97`). The UI hides the checkbox for that predicate, but a seeded or restored entry can carry `includeMissing: true`.

**Performance**
- R writes 65,536-row batches whatever the width (`r-bootstrap-profile.ts:358`). At 2,000 double columns one batch is ~1 GB decoded.
- Open decodes every record batch to count rows, and decodes batch 0 for dictionaries (`arrow-reader.ts:138-143`), so time to first paint scales with file size.
- `getBatch` decodes a whole batch to serve any window (`arrow-reader.ts:231`). The batch cache is bounded at 16 entries, not bytes (`arrow-reader.ts:104-105`).
- Sort, filter, and histogram scans decode all columns and run through the viewport's cache, evicting it (`batch-iter.ts`). Histograms take two passes per column (`histograms.ts:15`).
- With sort and filter both active, `composeEffective()` allocates `Uint8Array(nrow)` and scans the full permutation on every `getRows` and copy (`panel.ts:1135-1146`).
- Sort runs a closure comparator over a boxed `Array.from(perm)` on the extension-host thread (`sort.ts:97-108`), with `Intl.Collator` per string comparison and nothing cached between sorts.
- `getRows` ships every non-hidden column, not the visible ones (`webview/App.tsx:598-606`). Dictionaries are sent twice on init.
- Every scroll calls `setVisibleRange`, re-rendering the 2,100-line `App`, which re-persists state, re-registers the message listener, and hands Glide a new `getCellContent` (`webview/App.tsx:1914-1923`).
- `RowCache.getRow` scans every entry per drawn cell (`webview/row-cache.ts:62-70`). Small scrolls refetch rows already cached.
- No performance benchmarks or regression thresholds exist.

## Renderer decision: keep Glide

The Python survey recommends DOM virtualization in both axes for accessibility, native selection, and theming. We keep Glide's canvas renderer because:

- It already virtualizes both axes and blits on scroll; table-viewer measures 16.7 ms p50 / 18.2 ms p95 scroll frames at 200k rows on it.
- It ships a hidden `role="grid"` table with full `aria-rowcount`/`aria-colcount`, absolute indices for the visible slice, and roving focus.
- The browser's ~33M px height cap is already handled by Raven's custom scrollbar (`2026-05-16-data-viewer-custom-scrollbar-design.md`), which a DOM grid would need too.
- Theming via tokens is solved by porting table-viewer's mapping, including the theme-change observer.
- A rewrite would put every existing behavior (35 bun test files, the 10M-row scroll tests, restore/cancel) at risk for no visible gain.

What canvas costs, and how we pay for it:
- **Accessibility of custom drawing.** Canvas-drawn header lines and the summary band are invisible to Glide's ARIA table. Every fact drawn there also exists in DOM: the header cell's accessible name includes name, type tag, label, and NA %, and the Columns sidebar (DOM) carries the full profile. Keyboard: Shift+Alt+S on a focused column opens its summary in the sidebar. See "Accessibility".
- **Find.** VS Code's webview find can't see cell text; in-grid find (Phase 5) replaces it.
- **Text selection.** No native selection inside cells; copy and the cell detail view cover it.

## Design

### Grid surface

- **Typography.** Grid text uses `editor.fontFamily` and `editor.fontSize` (from `--vscode-editor-font-*`). Chrome (toolbar, popovers, sidebar) uses `--vscode-font-family` and `--vscode-font-size`. One `--dv-font-size` variable with ×0.85 and ×0.92 steps replaces the hard-coded 9–13 px sizes. Row height = `round(fontSize × 1.85)` (24 px at 13 px), so density follows the user's editor setting.
- **Theme tokens.** Port table-viewer's `build_theme_from_vars`: selection fill from `editor.selectionBackground` at α 0.35 (0.5 in high contrast) so cell tints show through; header background `editorGroupHeader.tabsBackground`; borders `editorWidget.border` → `panel.border`; focus ring `focusBorder`. Fallbacks come from the active theme kind (`body.vscode-light` / `-dark` / `-high-contrast`), not dark-only literals. Under `forced-colors: active` the chrome uses system colors and the canvas reads them through the same token path.
- **Row banding and hover.** A subtle zebra (`bgCellMedium` = editor background mixed 4% toward `foreground`, off in high contrast where borders already separate rows) and a row-hover tint from `list.hoverBackground`.
- **Alignment.** Right-aligned: integer, double, `Date`, `POSIXct`, `difftime`, and labelled numerics when Labels is off. Left-aligned: character, factor, logical, labelled values shown as labels. Matches pillar and the original spec (`2026-05-08-data-viewer-design.md:462`). The grid font is the editor's monospace font, so digits already align.
- **Missing values.** NA renders the literal `NA` in italics, colored `descriptionForeground` under `missingValueStyle: 'foreground'` (default) or on a tinted background under `'background'` (tint from `editorWarning.foreground` at α 0.12, replacing `diffEditor.removedTextBackground`). `'none'` still prints `NA`, unstyled. `NaN` prints `NaN` with the same style and stays a distinct wire kind; R's arrow writes `NA_real_` as null and `NaN` as a NaN value, and a round-trip test pins that. An empty string prints nothing. A missing cell's accessible text is "NA".
- **Numbers.** With Format on, doubles round to the column's decimals: the digits dropdown by default, or the source display format when one is recognized (below). A nonzero value that would round to zero, or |x| ≥ 1e15, prints in scientific (`1.23e-10`). Whole-number doubles in a decimal column keep their short form (`5`, as today, to avoid SPSS's misleading `5.000`) but are padded on the right with the width of `.000` so the decimal points still line up. With Format off, values print at full precision (shortest round-trip) with R-style exponents (`1e-07`). An overflowing numeric cell shows `###` with the full value in the hover tooltip, never its leading digits.
- **Display formats honored** (a named subset, each with a test): Stata `%w.df`, `%w.dfc` (thousands separators), `%w.0f`, `%w.dg` (treated as significant digits); SPSS/SAS `Fw.d`, `COMMAw.d`, `DOLLARw.d` (prefix `$`), `PCTw.d` / `PERCENTw.d` (suffix `%`, value unchanged), `Zw.` (zero-padded integers). Any other format falls back to the digits dropdown. The Format tooltip lists which columns use a source format. A per-column "Use digits instead" item in the context menu overrides it.
- **Timestamps.** Conversion happens in the webview, from the wire value and the column's `tzone`:
  - **Wire value:** `{ms, us}`, where `ms = floor(µs / 1000)` is an integer number of milliseconds and `us = µs − 1000·ms` ∈ [0, 999]. Floor, not truncation, keeps pre-1970 values correct. Both parts are exact doubles across the supported range, unlike raw epoch microseconds, which pass 2^53 around year 2255 and break 9999-12-31 sentinels.
  - **Supported range** is the intersection of three ranges:
    - Arrow `timestamp[us]`: int64, ±292,000 years
    - JS `Date`: ±8.64e15 ms, years −271821 to 275760
    - R's own: wider, but anything R writes to Arrow must fit int64 µs
    
    The effective range is the JS `Date` range. The range check runs on the int64 microsecond value (as a `BigInt`, before decomposition): valid iff −8.64e18 ≤ µs ≤ 8.64e18. That excludes `+8.64e15 ms` with a nonzero `us` remainder. A value outside it renders as `<out of range>` styled like NA, with the raw seconds since 1970 in its tooltip, and is still sorted and filtered correctly on the host (which uses the int64 value). Tests cover `±8.64e15 ms` with `us = 0` (valid) and the next µs outward (invalid), and 9999-12-31 23:59:59.999999.
  - **Years outside 1–9999** print as R's `format()` does: no zero-padding to four digits beyond 9999 (`10000-01-01`), and astronomical year numbering with a minus sign for years ≤ 0, built from `formatToParts` with era handling. Tests compare against R's output for years −44, 0, 1, 9999, and 10000.
  - One cached `Intl.DateTimeFormat` per (column, zone), never per cell, with `hourCycle: 'h23'` so midnight never prints as `24:00`.
  - Output `2024-03-01 09:00:00`. Fractional digits are fixed per column from `raven.subsecond_digits` (0, 3 or 6, computed in R over the whole column), so the display never changes as you scroll. Milliseconds come from `Intl`; digits 4–6 come from `us`.
  - The zone appears in the header tag (`<dttm America/New_York>`), and a cell's tooltip shows the UTC offset in effect (DST-correct, from `Intl`).
  - A column without `tzone` uses the session zone R reports at `View()` time (`Sys.timezone()`, falling back to `TZ`, then UTC with a header note).
  - Zones `Intl` rejects (`RangeError` for R aliases like `UTC+3` or `EST5EDT` on some ICUs) fall back to UTC display, with the header tag reading `<dttm UTC; "UTC+3" unrecognized>`.
- **Cell detail.** Enter or double-click on a truncated cell, a long string, or a list-column placeholder opens a read-only popover with the full value (capped at 64 KiB) and a Copy button.

### Header

A canvas-drawn header with fixed-height slots:

```text
┌──────────────────────┐
│ mpg                ▲2│  name (600 weight), sort glyph in a reserved 18 px slot
│ <dbl>                │  type tag, descriptionForeground, ×0.85 size
│ Miles per gallon     │  variable label, italic, ellipsized; only when any column has a label
├──────────────────────┤
│ ▁▂▅█▆▃▁  12% NA · 31 │  summary band (toggle; see Summaries)
└──────────────────────┘
  ▔▔▔▔ missing bar (2 px)
```

- **Type tags** follow pillar: `<int>`, `<dbl>`, `<chr>`, `<lgl>`, `<fct>`, `<ord>`, `<date>`, `<dttm TZ>`, `<drtn unit>`, `<cpl>`, `<list>`, and `<dbl+lbl>` / `<int+lbl>` / `<chr+lbl>` for value-labelled columns. R writes the tag into the per-field metadata it already emits (`raven.fields`), so it reflects the R class, not the Arrow type.
- **Labels line** shows the variable label in the header itself. It appears only when at least one column has a label, and the Labels toggle does not hide it (Labels governs values). The full label stays in the tooltip.
- Name and label ellipsize with `…`; the sort glyph never overlaps text.
- **Missing bar.** A 2 px bar along the bottom edge of every header, filled in proportion to the column's NA share (from Arrow null counts; see F2), colored like missing cells. Always on.
- Hovering shows name, label, R class, source display format, NA count and %, and for labelled columns the first few value labels.
- The header layout is prototyped in the webview test harness against Glide 6.0.3 (hit-testing for the sort slot, the band, and resize borders) as the first PR of Phase 2, before anything depends on it.

### Gutter and row identity

- Glide's `rowMarkers` can only number display rows, so the gutter becomes a synthetic frozen column, drawn in gutter style (header background, `descriptionForeground`, right-aligned), showing the **R row number** (1-based original index) after sort and filter. For unsorted, unfiltered windows the index is `start + i`; otherwise it's `originalRowIndices`. Its header shows `12 / 32` (shown / total) while a filter is active.
- The synthetic column is a webview concept only. A single mapping module (`display-columns.ts`) owns display index ↔ source column index, and every consumer goes through it: `getCellContent`, column selection, resize, sort and filter targets, hidden columns, pins, keyboard shortcuts on the focused column, context menu, copy, and the ARIA column index. Gutter and `rowname` cells are excluded from column selection and from TSV copy unless "Copy with row names" is chosen.
- Row selection moves from row markers to clicks on the gutter column (`onCellClicked`, Shift/Cmd extension), keeping today's behavior.
- Data frames with explicit rownames get a leading `rowname` column, like matrices today. The test is `.row_names_info(x, type = 1L) > 0L`: negative for compact automatic row names, zero for zero-row frames, positive for explicit ones. Automatic row names are never materialized (rstudio#1705). If the frame already has a `rowname` column, the new one is named `.rowname` (then `..rowname`, …); the matrix path gets the same rule. `rowname` is a real Arrow column, so `schemaHash` (`layout-state.ts:32`) changes for frames with explicit rownames and their saved layout resets once on upgrade; the release notes say so.
- The gutter and `rowname` are frozen (Glide `freezeColumns`). Frozen width (gutter + rowname + pins) is capped at 50% of the viewport; past it, the rowname column ellipsizes and new pins are refused with a message.
- Integration tests: row selection and copy after sort+filter, keyboard navigation across the frozen boundary, and selection at rows past the 33M px custom-scrollbar threshold.

### Toolbar and status line

```text
32 × 11       [Sort: mpg ▲ cyl ▼ ✕] [Filter: cyl ∈ {6,8} ✕]       [Σ] [Labels] [Format 3▾] [Columns 2]  [⋯]
…grid…
rows 1,201–1,240 of 12 (filtered from 32) · 11 cols       sel: 6 cells · Σ 120.4 · mean 20.07
```

- **Shape** on the left of the toolbar: `rows × cols`, or `12 of 32 rows × 11` when filtered.
- **Status line** under the grid: the visible row range (exact values, which the scrollbar doesn't give), filter context, and the selection summary (Phase 5). One line, `descriptionForeground`, ×0.85 size.
- Sort and filter chips keep their current behavior and adopt table-viewer's chip CSS.
- Buttons use codicons plus short text (`graph` Σ for summaries, `tag` Labels, `symbol-numeric` Format, `layout-sidebar-right` Columns), dropping the text first when the toolbar wraps. Codicons ship from `@vscode/codicons` with a CSP `font-src` entry for the webview resource root.
- `⋯` holds Go to row (Cmd/Ctrl+G), Copy as R code, Refresh, and Export (Phase 5).
- "Sorting… Cancel" and "Filtering… Cancel" pills keep their place.

### Empty, loading, and error states

- Zero-row frame: centered "No rows", with columns still listed in the header.
- Filter matches nothing: "No rows match these filters" with a Clear filters button.
- Cells still loading draw Glide's loading skeleton, not blank.
- A summary that failed shows `—` with the error in its tooltip, never the loading state (positron#16819). The filter-popover histogram uses the same three states.

### Columns

- **Widths.** Default width = max(name, type tag, label, the first 200 loaded values), measured with canvas `measureText` (table-viewer `fit-column-model.ts`), clamped to 60–400 px. Skipped above 200 columns (RStudio); those get a type-based default and fit as they scroll into view, without moving columns already on screen. Double-click a border to auto-fit to the loaded rows. A user's drag is clamped to 40–3200 px and persisted.
- **Pin.** Context menu "Pin column" moves the column into the frozen region after `rowname`; unpin restores its position. Pins persist with layout.

### Summaries

**What a profile describes.**
- Profiles always describe the **whole frame**, not the filtered view, and say so ("all 32 rows"). Filtered profiles are a follow-up: they'd need invalidation on every filter change and would make the band flicker.
- A profile carries an `exact` flag per statistic. Estimates print with `≈`.
- **Distinct** means distinct values observed, NA excluded. For factors and labelled columns, the declared level or label count is shown separately ("31 of 32 levels used"), because unused levels are common after subsetting.

**Availability.** Each statistic has one of three states: loading (shimmer), ready, or failed (`—`, error in the tooltip).
- NA counts arrive first, from the header scan (F2).
- Profiles for visible columns arrive next. Deadline for all visible columns' bands: 1 s on fixture D, 4 s on fixture A. Nothing promises profiles at first paint.

**Header summary band** (Σ toggle). Default on when the frame has ≤ 200 columns **and** ≤ 1M rows. Otherwise off, but a cached profile still draws. A 28 px band under the header:
- numeric, date, datetime: a 20-bin sparkline histogram, then `NA%` and the distinct count
- factor, labelled, character: up to 5 top-value bars, then `NA%` and the distinct count (Data Wrangler)
- logical: a TRUE/FALSE/NA stacked bar

**Brushing.** Click a bin to filter to that bin; drag across bins, or Shift-click a second bin, to filter to the range. Bins are half-open `[lo, hi)` except the last, which is closed `[lo, hi]`. The seeded filter uses the same inclusivity (the filter model gains `upperInclusive` on `numBetween` if it lacks it), so the filtered row count equals the brushed bars' total, and a test checks that. Clicking a top-value bar seeds a set filter.

**Columns sidebar** (replaces the Columns popover; DOM, resizable, 260 px default):
- One row per column: visibility checkbox, name, type tag, label, missing bar with %, distinct count, sparkline.
- Search by name or label. Sort by position, name, type, % missing, or distinct.
- Clicking a row scrolls the grid to that column and selects it. Expanding a row shows type-specific stats:
  - numeric: n, NA, NaN, distinct, min, p25, median, mean, p75, max, sd
  - factor/labelled: levels with counts and % for up to 24 levels, then "N more"
  - character: distinct, empty strings, min/max length, top 5 values
  - logical: TRUE / FALSE / NA counts
  - date/datetime: min, max, time zone
- It absorbs show/hide-all from today's popover. The rows are virtualized for 2,000+ columns.

**Value counts** (context menu, VisiData's frequency sheet): a popover listing value, count, %, and a bar, sorted by count, with a toggle for rarest first. Clicking rows builds a set filter.

**Exactness rules:**
- NA count: exact, from Arrow null counts (F2). NaN count: exact, from the stats scan.
- min, max, mean, sd, histogram: exact, from two projected passes (min/max, then binning and moments), the same contract as `histograms.ts` today, sharing its cache.
- Quantiles: exact when the column has cached sorted keys; otherwise from a 100k-value reservoir sample, marked `≈`.
- Distinct count:
  - exact for dictionary and factor columns
  - exact for other columns while a hash set stays under 100k values
  - beyond that, a HyperLogLog estimate marked `≈` (the HLL sketch runs from row 0 alongside the hash set, so crossing the cap needs no rescan)
- Top values: exact counts for dictionary columns and for any column under the 100k-distinct cap. A Space-Saving summary with 1,000 counters runs alongside the hash set from row 0, so crossing the cap needs no rescan; past it, Space-Saving's counts are used. Each reported count shows its guaranteed error bound (`≈ 4,210 ± 12`), and a value is listed as "top" only when its lower bound beats the next counter's upper bound. Otherwise the list is marked "approximate order".

**Scheduling.** Profiles run in the scan worker (F4), lowest priority:
- Viewport reads always preempt; a profile scan yields between batches and checks a priority flag.
- Profiles for columns that scroll out of view are cancelled.
- One profile scan runs at a time, and a sort or filter waits behind none of them.
- The band never triggers more than the visible columns' scans, and never runs when off.

### Workflow (Phase 5)

- **Copy as R code.** The current sort, filter, and hidden columns as dplyr (`df |> filter(...) |> arrange(...) |> select(...)`), with base R and data.table variants in a submenu. The expression passed to `View()` is the data argument; predicate text comes from the typed filter model, so it round-trips (tests evaluate the emitted code in R and compare row indices). ark's `convert_to_code.rs` (MIT) is the reference.
- **Find in grid** (Cmd/Ctrl+F inside the panel): searches the displayed text of visible columns, on the worker, returning row indices; next/previous moves the selection. Extending the query refines the previous match set (RStudio).
- **Go to row** (Cmd/Ctrl+G): by R row number, or by display position with `#`.
- **Selection summary** in the status line: for loaded numeric cells, count, NA, sum, and mean. Larger selections show the count only.
- **Refresh** shows the `View()` expression and asks before re-running it in the console, since expressions can have side effects. It keeps sort, filter, widths, and pins when the schema fingerprint matches. Automatic refresh on reassignment is a follow-up.

## Foundations and performance

### F0. Benchmark harness, budgets, and the pipeline-invariant tests

**Harness.**
- A bun benchmark (`tests/bun/bench/data-viewer/`) drives `ArrowSliceReader`, the worker, the sort/filter/profile engines, and the webview tile cache against Arrow fixtures.
- An R script generates the fixtures with the real `View()` writer, outside the timed sections.
- An end-to-end benchmark times `View()` from the R call to the first painted rows, using the existing integration harness.

**Fixtures.**

| Fixture | Rows × cols | Size |
|---|---|---|
| A, long mixed | 10M × 10 | ~0.8 GB |
| B, wide doubles | 1M × 2,000 | ~16 GB |
| C, categorical | 1M × 20, including a 50k-level factor and a 1M-distinct character column | |
| D, typical | 50k × 30, with Stata labels and display formats | |
| E, wide comparable | 100k × 1,000 doubles | ~0.8 GB; the widest fixture other tools can open |
| F, survey | 5k × 300, Stata `.dta` with variable labels, value labels, display formats | used by the evaluation's tasks |
| G, small wide | 20k × 2,000 doubles | ~320 MB; CI regression check for the wide paths |

We do not target 10M × 2,000 (160 GB). The goal is "10M rows or 2,000 columns".

**Method.**
- Reference hardware is an Apple M-series, 32 GB, warm file cache (the run before timing is discarded).
- Each measure is the median and p95 of 10 samples.
- RSS is `process.memoryUsage().rss` peak in the extension host and worker.
- The host's event-loop blocking is the longest gap measured with `perf_hooks.monitorEventLoopDelay`.

**Budgets.**

| Measure | Fixture | Budget |
|---|---|---|
| `View()` → first rows painted, end to end | D | < 400 ms |
| `View()` → first rows painted, end to end | A | < 4 s, of which viewer side < 300 ms |
| Open → first rows painted, viewer side | B | < 500 ms |
| `getRows` host time, sort + filter active | A | < 5 ms |
| Numeric sort | A | < 2 s; host loop never blocked > 50 ms |
| String sort, 1M distinct | C | budget set by the F4 spike, recorded before P3 merges |
| Profile, one numeric column | A | < 400 ms |
| Header null-count scan, all columns | A / B | < 300 ms / < 2 s, off the open path |
| Sorted 64 × 32 tile gather | A / B | < 15 ms |
| Scroll frame | B | p95 < 20 ms |
| Peak RSS (host + worker), open and scrolled end to end | B | < 1 GB |

**CI gate.**
- A Linux CI job runs fixtures A, C, D, and a small wide fixture G (20k × 2,000 doubles, ~320 MB) that exercises column projection, the header null-count scan, and column virtualization; B is too large for runners and is run manually before each phase merges. The job compares against a baseline recorded on the same runner class.
- It fails on a > 15% median regression that repeats on an automatic re-run.
- The job reports without blocking for its first two weeks, then blocks.
- The absolute budgets are checked on the reference machine before each phase merges, and the numbers go in the PR description.

**Invariant tests first.** Before any pipeline change, add the tests these changes could break:
- restore while a sort is in flight, cancel then reopen, and stale replies after refresh and after reopen
- worker termination during a regex filter
- a debounced save landing after a panel generation change
- the existing #519 restore-cancel suite unchanged

### F1. Writer: width-aware batches and header metadata (R side)

- `chunk_size` scales with width: `max(1024, min(65536, 2^21 %/% w))` rows, where `w` is the estimated bytes per row ÷ 8. Fixed-width columns count their width. Character columns count their mean byte length over a 1,000-value sample. This *targets* ~16 MB per decoded batch; it isn't a bound. The 1,024-row floor applies from ~2,048 double columns (fixture B gets 1,048 rows per batch), and skewed strings can exceed the target. The reader's byte-bounded caches, not the batch size, enforce memory limits.
- The schema metadata gains:
  - `raven.nrow` and `raven.chunk_rows`
  - the type tag and session time zone
  - per `POSIXct`/`difftime` column, `raven.subsecond_digits` ∈ {0, 3, 6}: the fewest digits that represent every value exactly, computed in R with one vectorized pass over `round(x * 1e6) %% 1e6` (integers, since `0.1` s isn't exactly representable as a double)
  - the rowname handling above
- Measure the R-side cost on fixtures A and B. If the per-column metadata loop or `arrow_table()` dominates, fix it in this phase. The end-to-end budget includes R.
- Viewing must not touch `.Random.seed` (test borrowed from vscode-R).
- The file stays uncompressed: random access needs it.
- R writes no per-column NA counts. On fixture B they'd cost R a full pass over 2,000 columns; the reader gets them from batch headers for free (F2).

### F2. Reader: open from metadata, read single columns, gather sorted rows

**Spike contract.** All of F2 is gated by a spike test pinned to apache-arrow 21.1.0 (like `tests/bun/data-viewer-arrow-spike.test.ts`) that must pass before F2 merges. It must demonstrate, on files written by the real `View()` writer:
1. footer block access (`reader.footer.recordBatches()` → `{offset, metaDataLength, bodyLength}`) and message framing (continuation marker, 8-byte body alignment)
2. `Message.decode` of a `RecordBatch` header, with node-to-column mapping that walks child fields depth-first. The writer emits no nested types today, and the spike rejects any file that has them.
3. reconstructing every column type the writer emits from projected buffers with `makeData`, including dictionary columns with the reader's loaded dictionary. The writer emits one dictionary batch per field and no delta dictionaries; the spike asserts that and routes files that violate it to the column-group layout below.
4. element gather: a single value and validity bit read at computed byte offsets, for fixed-width, string (offset pair, then data), and dictionary-index columns
5. pass/fail numbers: open of fixture B < 500 ms viewer side, and a 64 × 32 sorted gather (below) < 15 ms

**Batch geometry.**
- Batch starts are arithmetic from `raven.chunk_rows`, verified two ways: the footer's block count must equal `ceil(nrow / chunk_rows)`, and the last batch's header length must match.
- Why the two checks suffice: the writer never emits a batch longer than `chunk_rows`. With N = `ceil(nrow / chunk_rows)` blocks and a last batch of exactly `nrow − (N−1)·chunk_rows` rows, the first N−1 batches sum to `(N−1)·chunk_rows` with each ≤ `chunk_rows`, so each is exactly `chunk_rows`. Irregular splits (R's `TableBatchReader` also splits at array-chunk boundaries, e.g. a character column over 2 GB) fail one of the checks.
- The premise, no batch longer than `chunk_rows`, is pinned by an R writer test that includes a chunked character column.
- On mismatch, the reader parses every header for exact lengths, the fallback for files without the metadata too.

**Null counts.**
- Each `RecordBatch` header lists a `FieldNode {length, null_count}` per field. Summing them gives exact per-column NA counts without reading data.
- A header is ~16 B per column plus ~16 B per buffer, so ~100 KB per batch at 2,000 columns: ~95 MB of reads across fixture B's ~954 batches. That is off the open path.
- The worker (F4) scans the headers after first paint, reading `nodes(i)` straight from the flatbuffer (no `decodeFieldNodes` object per node). It fills missing bars progressively, visible columns first.
- Until a column's count arrives, its bar shows the loading pattern. Budget: all counts within 300 ms on fixture A, 2 s on fixture B.

**Dictionaries** come from the reader's own dictionary loading at `open()`, not from decoding batch 0.

**Projected chunk reads (unsorted windows and scans).** For batch `i` and columns `S`:
1. Take the block's offset, metadata length and body length from the footer, and parse its header.
2. `pread` only the buffer ranges belonging to `S`, coalescing adjacent ranges.
3. Build `Data` with `makeData` and attach dictionaries.

Unsorted windows are contiguous, so a window touches one or two batches. Chunks go into a byte-bounded LRU (default 128 MB) keyed by `(batch, column)`; scans bypass it.

**Element gather (sorted or filtered windows).**
- Under a permutation, a 64-row window can touch 64 batches, and chunk reads would fetch ~512 KB to use 8 bytes. Permuted windows instead gather individual elements:
  1. group requested rows by batch, using the cached header
  2. for each (batch, column), compute the byte offsets of each row's validity bit and value (or offset pair, then string bytes)
  3. skip the validity read when the cached header shows `null_count == 0` for that (batch, column), which roughly halves the reads on typical data
  4. coalesce reads that fall within 4 KB of each other
  
  Parsed headers are cached in a byte-bounded LRU (32 MB).
- Gather runs on the **reader thread** (F4) with synchronous `fs.readSync` against the page cache, avoiding a libuv round trip per read. A 64 × 32 tile can need thousands of reads, so its budget is a spike-measured target on both fixtures A and B, not an assumption.
- Sorted views use 64-row tiles (F5). Budget: a 64 × 32 tile < 15 ms; `getRows` host time < 5 ms, because the host only forwards the request.
- Chunk reads still serve unsorted windows, where they're cheaper.

**If the spike fails** (projected reads or element gather can't be built on apache-arrow 21.1.0), the fallback is **compatibility mode**, a degraded mode with its own bounded contract. It is narrower than the main design, and the docs say so.

- **Unsorted views** work as today. The reader thread decodes whole batches through apache-arrow's public `readRecordBatch`, which handles every type the writer emits, into a byte-bounded batch cache. F1's batches are ≤ ~16 MB, so a horizontal scroll on fixture B touches only the one or two batches under the viewport and stays within the scroll target.
- **Sorted or filtered views** need random access, so the **scan worker** (never the reader thread) materializes columns: it streams batches through `readRecordBatch` one at a time and copies the needed columns into per-column typed arrays. The reader thread then gathers from the materialized columns by in-memory indexing, through the shared-memory handoff described under F4.
- **Memory cap** = min(1.5 GB, 15% of `os.totalmem()`), covering materialized columns, the transient decoded batch (one at a time, ≤ ~16 MB plus string skew), dictionaries, both threads' caches, and live permutation buffers (4 bytes per row per generation; two generations live during a handoff, 80 MB at 10M rows). It is accounted in one `SharedArrayBuffer` counter updated with `Atomics.add` by the thread that allocates, which is the source of truth.
  - *Admission order:* visible columns, then the sort keys, then columns adjacent to the viewport.
  - *Eviction:* least recently viewed first.
  - When the visible columns alone exceed the cap, the sorted view shows only the columns that fit, starting from the left edge of the viewport. The rest draw a placeholder, and a banner explains: "Sorted view shows 412 of 2,000 columns in compatibility mode". It never exceeds the cap.
- **Latency.** Materializing a column set means reading every batch.
  - Fixture A in compatibility mode: first sorted paint < 3 s.
  - Fixture B: sorted views take about the time to read the file once (~16 GB from page cache, tens of seconds). Cells show loading until their column arrives, the progress pill shows the share done, and Cancel returns to the unsorted view.
  - Peak RSS < cap + 300 MB on both fixtures.
  
  These budgets are measured in compatibility mode itself, in F0, if it's ever adopted.
- **Unsupported input.** The writer never emits nested types or delta dictionaries (R stringifies list columns, and arrow writes one dictionary per field to IPC files), and R writer tests pin that. Compatibility mode doesn't depend on projected reads, so such a file still opens.
- **No new files**, so there's nothing new to clean up.

### F3. Effective permutation and filter

- Compute the effective permutation once per sort/filter change and cache it, owned by the transform generation that produced it. `getRows` and copy read the cache, removing the per-scroll O(nrow) pass.
- When a filter is active, sort only the surviving rows (#328). Sort keys are still materialized and cached over **all** rows, so clearing the filter later recomputes the sort-only permutation from cached keys without re-reading the file.
- Filters cache per-entry masks; changing one entry recombines masks instead of re-evaluating all of them.
- Case-insensitive string predicates fold the dictionary or distinct values once, not each row.
- `isNotEmpty` ignores `includeMissing`, matching `isEmpty`; the test asserting otherwise is corrected.

### F4. Scan worker

- **Two threads.**
  - The **reader thread** serves viewport reads only: unsorted chunk reads and permuted element gather. Each request takes milliseconds, so scrolling never waits behind a sort.
  - The **scan worker** owns all full-column work: sort keys, filters, profiles, find, and the header null-count scan.
  
  Both open their own reader on the file path (a `FileHandle` can't be transferred), so decoding never runs on the host thread.
- **Permutation ownership and commit protocol.**
  - **State.** The scan worker owns the sort and filter state and composes the effective permutation. It writes every permutation into a new `SharedArrayBuffer` (`Uint32Array` view), which is never mutated after it's posted. Sharing, not transfer, means nothing is detached: the scan worker, reader thread, and host all hold the same immutable buffer.
  - **Commit: a two-phase install.** The host is the only commit authority, and transforms are serialized. The existing FIFO `transformChain` lets transform N+1 *compute* while N is pending, but lets the host send `commit N+1` only after N was aborted or the webview has adopted it (`adopted N`, below). So at most two generations are ever live, the one on screen and the one being adopted.
    1. The scan worker posts `{transformGen: N, perm}` to the host.
    2. The host sends `prepare N` to the reader thread. The reader stores N as a *candidate* and keeps serving the committed generation N−1. It acks `prepared N`.
    3. If nothing cancelled N in the meantime, the host sends `commit N`. The reader atomically swaps the candidate in as committed, then acks `committed N`. Sending `commit N` is the point of no return: a cancel that arrives after it is a no-op, as if the sort had finished a moment earlier.
    4. Only after `committed N` does the host tell the webview (which drops tiles from older generations) and drop its own reference to N−1's buffer. Buffers are reference-counted: a buffer is freed, and its bytes subtracted from the memory counter, only when no committed generation, candidate, or rollback descriptor references it. Retained snapshot buffers count toward the memory cap.
    
    If N is cancelled, or the scan worker is terminated, before `commit N` is sent:
    - The host sends `abort N`. The reader discards the candidate and, never having stopped, keeps serving N−1.
    - Acks for an aborted or superseded generation (a late `prepared N`) are ignored by generation number.
    - Webview requests always carry the generation the webview is showing, so they never name a candidate.
    - An aborted or superseded candidate's buffer is released, and its bytes are subtracted from the memory counter.
    - Before sending `commit N`, the host re-checks the panel generation and reader identity. If a refresh or reload superseded N, it sends `abort N` instead.
  - **Restore is one transaction.** Restoring saved preferences (`panel.ts:555-577`: `restoreSort`, then `restoreFilter`, then `postPaint`) becomes a single transform:
    1. The scan worker computes the sort and the filter and composes them into one permutation, with one `prepare`.
    2. The host takes the existing single cancel snapshot (`cancelledBeforePaint`). If it shows a cancel, the host sends `abort` and `resetRestoredPrefs()`, and the reader still serves natural order, because nothing was committed.
    3. Otherwise the host sends `commit`. On `committed`, `postPaint` announces the generation to the webview, so the paint stays the single announcement point.
  - **Reverting to natural order is a transform.** A cancel that lands during the paint (the existing `cancelledNow` branch), clearing sort and filter, and `clearAndForgetNaturalOrder` all submit a *revert* transform: the identity (no permutation). It goes through the same `prepare` / `commit`, serialized behind anything in flight.
  
  So every #519 outcome is reachable: cancel before commit ends with nothing committed, and cancel after commit ends with a committed revert.
  - **Invariant: the reader's committed transform is the transform last painted.**
    - The host's permutation and filter state (`this.permutation`, `this.filteredIndices`, and the resets in `restoreSort`, `restoreFilter`, `resetRestoredPrefs`, and `abortInteractiveTransforms`) is assigned only through the install protocol, never directly.
    - Every paint path (`init` and `replace` sends, webview reload, the queued re-send after a generation bump, `clearAndForgetNaturalOrder`) installs the transform for the state it is about to paint, an identity transform included, and paints only after `committed`. So a re-send that finds nothing to restore (`restoreCancelRequested`, `persistSort` off, a schema change) still commits the identity before painting natural order.
    - After every `committed` await, the host repeats the stale check that follows today's reads (`generation !== this.generation || reader !== this.reader`, `panel.ts:590`).
      - Only **panel or reader supersession** may skip the paint. That's safe because the superseding send installs its own transform.
      - A newer interactive sort or filter (a `sortGeneration`/`filterGeneration` bump, `panel.ts:1602`, `:1614`, `:1753`, `:1760`) aborts N if `commit N` hasn't been sent. Once it has, N is painted and announced as usual, and the newer transform runs after it in the serialized chain. A committed transform is never left unannounced.
    - Rollback snapshots (`recordSortSnapshot`, `applySortSnapshot`, `applyFilterSnapshot`, `panel.ts:363-414`) become descriptors of a committed generation: its id, its immutable buffer, and its sort and filter state. Rolling back installs the descriptor through `prepare`/`commit`, never by assignment.
    - The direct clears (empty sort keys, `panel.ts:1508`; empty filter, `:1676`) install the effective transform of whatever remains: clearing the sort with a filter active installs the filter-only permutation; clearing the filter with a sort active installs the sort-only permutation, which the scan worker recomputes over all rows from its cached keys. Identity is installed only when neither remains. Their `sortStatus`/`filterStatus` idle post and snapshot record happen after `committed`, not before.
    - **The adoption interval.** Between `committed N` and the webview drawing N, the screen still shows N−1. So the reader retains N−1 alongside N until the webview acknowledges `adopted N` (sent once it has dropped old tiles and drawn under N); the host forwards it to the reader.
      - Every reader request (tiles, copy, `originalRowIndices`, gutter numbers) names the generation the webview is showing, and the reader serves exactly that generation, N−1 or N.
      - A request naming any other generation is a protocol error, logged and dropped. It can't happen under this ordering.
      - After `adopted N`, the reader drops its reference to N−1. The buffer is freed when no descriptor references it.
      - A reader restart during the interval is re-seeded with both N and the retained N−1.
      - The webview sends `adopted N` when it processes the announcement, after dropping old tiles, not when it next draws. So a hidden panel acks too: Raven's data-viewer panels keep their context when hidden, and a panel whose context is destroyed comes back through the reload path.
      - A webview reload, panel dispose, or reader re-seed releases every pending adoption, *before* the reload's own install and paint begin, so that install never waits on an ack that can't come. A webview that never acks can't pin buffers or stall the chain.
      - An `adopted` ack still missing after 5 s while the panel is live is logged to the Raven output channel. The host then treats the webview as reloaded and re-sends its current state, which installs and announces afresh.
  - A revert or new paint aborts any transform still in flight (`abort` if prepared, cooperative cancel if computing), rather than queueing behind work it will overwrite.
  - A composed restore reports failure per component. If the sort fails and the filter succeeds (or the reverse), the worker still composes the surviving one, and the host raises today's partial-failure warning (`panel.ts:656`) from the per-component result.
  - **Copy and `originalRowIndices`** are served by the reader thread for the generation the request names, which is the one on screen (see the adoption interval above).
  - **Scan-worker state is staged too.** The worker keeps its *committed* sort and filter state (keys, per-entry masks, and the effective permutation's descriptor) separate from the *candidate* state a transform builds.
    - The host's `commit N` goes to the scan worker as well as the reader, and the worker promotes the candidate.
    - `abort N` makes the worker discard the candidate. The next transform starts from committed state, so a cancelled filter never leaks into the following sort.
    - A restarted scan worker is seeded from the host's own record of the last committed descriptor (the host is the commit authority, so its record is the source of truth even if the worker died between the reader's `commit` and its own) before it accepts a transform.
  - **Cancellation flags** are `Int32Array`s over a `SharedArrayBuffer`, read with `Atomics.load`.
  - **Tests** cover:
    - cancel before `prepare`, between `prepared` and `commit`, and after `commit` was sent (a no-op)
    - a delayed `prepared` ack arriving after abort
    - scan-worker termination at each of those points
    - reader restart with a committed and with a candidate generation
    - a back-to-back transform queued behind an uncommitted one
    - restore: cancel before `prepare`; panel generation bump between `prepared` and `commit`; cancel racing `commit`; cancel during `postPaint` (revert transform); all with the #519 suite unchanged
    - commit a restore, bump the generation, re-send with no saved prefs, and assert the reader's committed transform is identity and matches the painted chips
    - a partial restore failure (sort fails, filter succeeds) still commits the filter and warns
    - commit sort N, supersede it with N+1, cancel N+1: the reader serves N and the chips show N
    - cancel a filter, then sort: the sort uses the committed filter, not the cancelled one
    - terminate the scan worker mid-transform, then run another: it starts from the committed state
    - copy and row-index requests during the adoption interval, with a delayed `adopted` ack and with a reader restart inside the interval: each returns the rows on screen
    - back-to-back transforms with a delayed `adopted N`: `commit N+1` waits, at most two generations are live, copy never hangs; a reload during the wait releases it before its own install; a missing ack past 5 s is logged and recovered
    - clear the sort with a filter active (rows stay filtered, in original order), and clear the filter with a sort active (rows stay sorted, all rows back): rows on screen match the remaining chip
    - roll back through a snapshot descriptor, including to a generation older than N−1, and clear via empty keys and an empty filter: each ends with the reader's committed transform matching the painted chips, and the idle status posts only after `committed`
    - a stale reply after reopen
- **Build.** `scripts/build.js` gains `data-viewer-reader` and `data-viewer-worker` entries bundled to `dist/`. The worker path resolves from `context.extensionUri`, which works in remote and WSL hosts because the worker runs where the extension host runs. A packaging test asserts the file is in the VSIX.
- **Cancellation.** Cooperative cancellation (a shared `Int32Array` flag checked between batches, and every 65,536 comparisons inside a collator ranking or radix pass) handles ordinary aborts and keeps the #519 contract: a cancelled sort or filter leaves the previous state in force.
- **Termination.** A regex filter, or any task past its deadline, is cancelled by terminating the worker, because a busy worker can't read messages.
  - `worker.terminate()` is asynchronous. The host awaits it, rejects every pending request with a cancellation error (callers treat that like a cooperative cancel), then starts a fresh worker.
  - Termination discards the worker's key and rank caches. The next sort rebuilds them, and the progress pill says so.
  - Gather requests queued during the restart are re-issued.
- **Generations.** Every request carries the panel generation and transform generation; replies from an older generation are dropped. That covers worker replies, tile replies, refresh, and cached permutations.
- **Sort algorithm.**
  - **Stability.** Every pass is a stable sort of the current permutation, and the initial permutation is ascending row index, so ties always end in original row order. Row index is never a sort key.
  - **Multi-key sorts** are LSD over keys: a stable pass on the last key, then on each earlier key. Within a key, numeric values use LSD radix (counting sort per byte, which is stable) on order-preserving float bits.
    - `-0` is normalized to `+0` before encoding, so R-equal values tie.
    - Descending order complements the key bits; the permutation is never reversed, which would break tie order.
    - NA goes last in both directions, as today, and NaN just before NA.
  - **Factors** sort by code; ordered factors by level order (vscode-R).
  - **NA and NaN** never enter the bit encoding: rows are partitioned into value, NaN and NA buckets first, the value bucket is radix-sorted (complemented for descending order), and the buckets are concatenated as value, NaN, NA in both directions.
  - **Labelled columns** sort by what's displayed, as `sort.ts` does today: by label rank when Labels is on, by underlying value when it's off.
  - **Strings** sort by rank: sort the distinct values once, map each row to a `Uint32Array` rank, then radix-sort the ranks. Distinct values the collator calls equal (e.g. NFC vs NFD forms) get the same rank, so their rows tie and keep original order. Three orders are offered, chosen from the sort menu and remembered per panel:
    - **Natural** (default, today's behavior, `sort.ts:58`): `Intl.Collator(undefined, {numeric: true})`, so `file_2` comes before `file_10`.
    - **Locale**: the same collator without `numeric`. The string-sort budget is set by the spike and recorded.
    - **C** (what `dplyr::arrange()` uses by default since dplyr 1.1.0, unless `dplyr.legacy_locale` is set, and what `sort(method = "radix")` uses): ranked by Unicode code point, which equals UTF-8 byte order. The comparison walks `codePointAt`, not JS `<`, which compares UTF-16 code units and misorders astral characters against U+E000–U+FFFF. Uppercase sorts before lowercase, and digits and punctuation follow their code points, so it differs from Locale in case, punctuation, and digit runs. It is chosen explicitly, never silently.
    
    Natural and Locale cost O(u log u) collator calls. At 1M distinct values that's ~20M calls, expected to take tens of seconds; it runs in the scan worker, cancellable, with the host never blocked. When either runs past 3 s, the progress pill offers "Switch to C order (fast, as dplyr)". The sort chip shows "C" or "Locale" whenever the order isn't Natural.
    
    **Copy as R code** emits each order faithfully:
    - C → `arrange(..., .locale = "C")`
    - Locale → `arrange(..., .locale = "<ui language>")`
    - Natural → `arrange(stringr::str_rank(x, locale = "<ui language>", numeric = TRUE), ...)`
    
    Descending keys wrap the term in `desc()`. The emitted code's header comment names its requirements: `stringr` ≥ 1.5.0 for Natural, and `stringi` for Locale (dplyr only suggests it). Both sides use ICU. Round-trip tests run on ASCII and Latin-1 data, including a mixed-case, digit-run column (`a`, `A`, `file_2`, `file_10`) in each order, ascending and descending. Where R's and V8's ICU versions could order a value differently, the emitted code carries a comment saying so.
  - Materialized keys and ranks are cached per column, so flipping direction or adding a key reuses them.

### F5. Webview

- Scrolling must not re-render `App`. The visible range lives in a ref plus the small status-line component subscribed to it. `getCellContent` is a stable callback reading refs. The message listener registers once.
- `vscode.setState` persistence is debounced (250 ms) and excludes dictionaries and histograms, which the host resends on restore. Each debounced write carries the schema hash and panel generation current when it was scheduled, and is dropped if either has changed by the time it runs (keeping `panel.ts:885` and `:1242` semantics).
- Replace `RowCache` with a tile cache:
  - keyed by `(rowPage, colPage)`: 256 rows × 32 columns for unsorted views, 64 rows × 32 columns under a sort or filter (F2's element gather), with row pages shrinking further for wide frames as in julia-vscode
  - O(1) lookup, bounded by cells and bytes like table-viewer's `row-loader.ts`, visible tiles pinned
- Fetch only missing tiles, in one request per viewport change. A newer viewport supersedes an in-flight request, and its reply is dropped by generation (regular-table's contract).
- Send dictionaries once.

### F6. Wire format (only if measured)

VS Code's webview `postMessage` has no transfer list (`@types/vscode` `Webview.postMessage(message)`); it serializes the message, and typed arrays avoid JSON encoding but are still copied. F6 is an experiment, not a commitment:
- Measure F5's tile replies on fixture B with JSON `Cell[][]` versus per-column typed arrays (`Float64Array` plus a null bitmap, `Int32Array` dictionary codes, `string[]`) on VS Code 1.82 (the minimum engine) and the current stable.
- Adopt typed arrays only if they cut scroll-path time by > 20%.

## Accessibility

- Glide 6.0.3's hidden table renders `<th>{title}</th>` with no `aria-label`, no row labels, and `aria-rowindex` set to the display index (`data-grid.tsx:1679`). Phase 2 commits to a `patch-package` patch on Glide (MIT; offered upstream) that adds:
  - an accessible name per header cell, e.g. "mpg, double, Miles per gallon, 12% missing, sorted ascending, priority 2", while the drawn `title` stays the plain name
  - an accessible row label carrying the R row number ("row 1,201")
  - removal of the synthetic gutter column from the accessibility tree
- The patch is pinned to 6.0.3, and the build fails if the patch doesn't apply cleanly (`patch-package --error-on-fail`), not just when the version changes. `patch-package` is a new dev dependency. A live region doesn't count as an accessible name: the VoiceOver and NVDA checks below must pass against the patched table.
- Missing cells read "NA"; truncated numbers read their full value.
- Every summary-band fact is reachable in the DOM sidebar. Shift+Alt+S on a focused column opens and focuses its sidebar row.
- Popovers, the sidebar, and value counts are DOM with roles (`dialog`, `listbox`, `tree`), labelled, and keyboard-operable.
- **Test plan:**
  - VoiceOver on macOS and NVDA on Windows walk-throughs per phase: open, navigate cells, hear a header, sort, filter from a summary, use the sidebar
  - automated axe checks on the DOM chrome in the webview harness
  - a forced-colors screenshot

## Phasing

Each phase is one or more PRs, each passing the CI gates and the docs tests.

1. **Foundations.** F0, F1, F2, F3. No visible change except speed and correct `isNotEmpty`. This comes first because the header's missing bar and the band depend on F2.
2. **Truthful display.** Header prototype, then: NA literal, rownames, the R-row-number gutter, time zones, number formatting and display formats, width rules, the header (type, label, missing bar), typography and theme port, banding and hover, alignment, empty states, cell detail, the status line. Updates `docs/data-viewer.md` (Toolbar, Labels, Format sections, new "Reading the header") and its screenshots.
3. **Speed at scale.** F4, F5, then F6 only if measured. `docs/development.md` gets a data-viewer performance section with the budgets and how to run the benchmarks.
4. **Summaries.** Profile engine in the worker, header band with brushing, Columns sidebar, value counts. New docs section "Column summaries".
5. **Workflow.** Copy as R code, find, go to row, pin, selection summary, refresh. The comparative evaluation runs after this phase.

## Testing

- **Unit (bun):**
  - `formatCell` table tests for NA, NaN, Inf, scientific fallback, decimal padding, each named display format, and time zones (DST gaps and overlaps, pre-1970 values with fractional seconds, µs digits, year-9999 sentinels, invalid zones)
  - type-tag mapping per R class
  - the display-column mapping module against sort/filter/hidden/pinned combinations
  - effective-permutation cache invalidation
  - radix and rank sorts against a reference sort on random data with ties, NAs, NaN, `-0`, non-ASCII and astral strings, and collator-equal strings (NFC vs NFD); C order checked against R's `sort(method = "radix")` output
  - tile cache eviction
  - Space-Saving and HyperLogLog error bounds on fixtures with known answers
  - profile engine against R-computed `quantile`, `mean`, `sd`, `table`
  - brushing: the brushed bars' total equals the filtered row count
- **R:**
  - `View()` on frames with explicit, compact, and zero-row rownames, and with an existing `rowname` column
  - compact rownames at 1e7 rows (time and memory bounds; no materialization)
  - non-UTC and alias-zone `POSIXct`
  - NA vs NaN round trip
  - `.Random.seed` unchanged
  - batch geometry and metadata
- **Spikes** (pinned): F2 projected reads and header parsing; F4 collator ranking.
- **Copy-as-code round trip:** evaluate emitted dplyr/base/data.table code in R and compare row indices with the viewer's, including filters and sorts on non-ASCII strings, where the emitted code must state `.locale` to match the viewer's sort order.
- **Integration (VS Code):**
  - the existing 700K and 10M scroll tests
  - gutter selection and copy after sort+filter, past the custom-scrollbar threshold
  - header rendering, and the sidebar's jump-to-column
  - restore, cancel, and reopen
- **Visual:** harness screenshots in light, dark, high-contrast, and forced-colors themes in each PR description.

## Acceptance

Acceptance targets for Raven, each checked before the phase that delivers it merges. Passing them shows Raven has the capability. It does not by itself show Raven is better than another tool; that's the next section.

| Target | Check | Best surveyed tool on that axis |
|---|---|---|
| NA visible, distinct from `""` and `NaN` | formatCell tests; screen reader reads "NA" | vscode-R, RStudio (NA only) |
| R row numbers survive sort/filter | integration test | RStudio |
| Variable label visible in header | screenshot + a11y name test | RStudio |
| Value labels with a toggle; named display formats | R + formatCell tests per format | none surveyed |
| Missing bar and distinct count on every column | fixture B: all missing bars within 2 s of first paint; visible bands within the profile deadline | Data Wrangler (header), Positron (sidebar) |
| Header sparklines **and** a navigator sidebar, with exactness marked | screenshot; estimator tests | Positron (sidebar only), Data Wrangler (header only) |
| Brush a histogram to filter | brushing test | RStudio |
| Cancellable sort/filter, host never blocked > 50 ms | event-loop delay benchmark | table-viewer |
| Copy view as dplyr / base / data.table | round-trip tests | Positron (dplyr) |
| 2,000-column scroll p95 < 20 ms, RSS < 1 GB (requires the F2 spike to pass; otherwise compatibility mode's budgets) | fixture B benchmark | RStudio 2026.06 (column virtualization) |

## Comparative evaluation

Runs once, after Phase 5 (all features exist), before any user-facing comparative claim in the docs, README, or `docs/comparison.md`.

**Tools.** Every surveyed viewer, at its current release on the reference machine:
- Raven
- Positron
- RStudio
- vscode-R
- Data Wrangler (reading the Arrow file through pandas/pyarrow)
- the Julia VS Code table viewer (through Arrow.jl and DataFrames)
- table-viewer, which opens Arrow files natively

A tool that can't open a fixture, or lacks a feature, is recorded as failing that item.

**Inputs per tool.** Each tool gets its most native route, so a lost attribute is attributed correctly:
- **R tools** (Raven, Positron, RStudio, vscode-R) call `View()` on the same R object, loaded from one `.rds` (fidelity) or `haven::read_dta()` (fixture F).
- **Data Wrangler** opens a pandas DataFrame loaded from the same `.dta` with `pandas.read_stata` (keeps value labels as categoricals), or from Parquet for fixtures A, C, D and E.
- **julia-vscode** opens a DataFrame from `ReadStatTables.jl` (keeps labels) or `Arrow.jl`.
- **table-viewer** opens the Arrow file Raven's writer produces.

Each item is scored **pass**, **fail** (the tool received the information and displayed it wrong or not at all), or **N/C** (not comparable: the import route lost the information before the viewer saw it). Only pass-vs-fail counts as a Raven win; N/C is reported separately as an ecosystem difference.

**Fidelity battery** (axis 1). One file, valid in R and Arrow, scored per item:
- a character column holding `NA` and `""`: are they distinguishable?
- a double column holding `NA`, `NaN`, `Inf`: are all three distinguishable?
- a `POSIXct` column with `tzone = "America/New_York"` and fractional seconds: correct local time and zone?
- a double `1e-10` under default formatting: shown as nonzero?
- explicit rownames: shown?
- a two-key sort, then the original row number of row 1: correct?
- a factor with an unused level: is the level visible somewhere?
- a value-labelled Stata column with a variable label: are both shown?

Expected results per tool are written down before the run.

**Performance** (axis 4). Fixtures A, C, D and E. Measures:
- time to first rows
- numeric sort
- string sort, in each tool's default order
- horizontal scroll across E's 1,000 columns

*Method, the same for every tool including Raven:*
- **Timing.** A 60 fps screen recording at a 1600 × 1000 window, measured from the triggering input to the first frame showing the expected cells, five repetitions, median reported.
- **Scroll.** A scripted pointer drag (`cliclick`) moves the horizontal scrollbar thumb from left to right over 5 s.
- **Dropped frames.** The script logs the pointer position for every frame. A frame is counted as dropped only when the pointer moved since the previous frame, the thumb's on-screen position changed by at least one pixel, and the grid region is unchanged. A stationary or quantized thumb never counts. The frame-diff script is checked into the repo.

**Tasks** (axes 2–3). Five scripted tasks on fixture F:
1. find the share missing in a variable
2. filter to one labelled category
3. sort by two keys and read the R row number of the top row
4. find a column by its label among the 300
5. copy the current view as code

*Participants:* the maintainer plus as many R users who didn't work on Raven as can be recruited; the target is at least seven. Each does every task in every tool, with tool order counterbalanced. A task succeeds if the stated answer or result is correct within 3 minutes. Recorded per task and tool: success, time, and steps.

**Look and feel** (axis 2). Each outside participant compares blind pairs of screenshots (same frame and theme, tool chrome cropped) and picks the clearer one in each pair, across light, dark, and high contrast. The maintainer doesn't vote on look.

**Winning rules**, fixed before the run:
- Fidelity: Raven wins an item against a tool when Raven passes and the tool fails.
- Performance: a win means a median at least 10% better, or the other tool failing to open the fixture.
- Tasks and look rest on small samples.
  - With at least seven outside participants, a task win requires a higher success count, or equal success with a lower median time, and a look win requires preference in at least two-thirds of pairs against that tool.
  - With fewer, task and look results are reported descriptively (counts, times, quotes) and support no comparative claim. Only the fidelity and performance axes can support claims at that sample size.
- Results are reported per axis and per tool, with no aggregation into a single score. A loss is published as a loss.

The results go in `docs/superpowers/specs/` as a dated evaluation. `docs/comparison.md` states only the per-axis, per-tool outcomes the evaluation supports.

Where a surveyed tool still leads after this plan, and we accept it:
- **Pinned rows** (Positron): Glide 6.0.3 freezes only trailing rows. Not planned.
- **Native in-cell text selection** (DOM grids such as Data Wrangler): canvas trade-off, covered by copy and cell detail.
- **Filtered-view profiles** (Data Wrangler recomputes on its current view): follow-up.

## Open questions

- Zebra banding on by default, or a setting? This plan ships it on with no setting and revisits if users object.
- Automatic refresh on reassignment: worth an R task callback per top-level call?

## Changes in revision 12

- **Terra:** direct clears install the remaining transform (filter-only or sort-only), with identity only when both are cleared; tests for each (F4).
- **Sonnet** (agreed at revision 11; suggestions taken): pending adoptions are released before a reload's install; a missing ack is logged after 5 s and recovered by a re-send; tests.

## Changes in revision 11

- **Sonnet:**
  - `commit N+1` is gated on `adopted N`, so at most two generations are live.
  - The webview acks on processing the announcement.
  - Reload, dispose or re-seed releases pending adoptions.
  - The stale reject-and-re-request rule is removed, and a cross-reference fixed.
  - A restarted scan worker is re-seeded from the host's record.
  - A test for back-to-back transforms (F4).

## Changes in revision 10 (Terra's review of revision 6)

- **Terra:**
  - Scan-worker sort and filter state is staged as committed vs candidate, promoted on `commit` and discarded on `abort`, with a restarted worker re-seeded from committed state.
  - Adoption interval: the reader retains N−1 until the webview's `adopted N` and serves the generation each request names. This replaces revision 9's reject-and-re-request rule.
  - Tests for both (F4).

## Changes from revision 9

- **Sonnet** (agreed at revision 9; suggestions taken): reference-counted permutation buffers that rollback descriptors keep alive, counted toward the memory cap; idle status and snapshot recorded after `committed` for the direct clears; tests for older-generation rollback and that ordering.

## Changes from revision 8

- **Sonnet:**
  - Post-commit bail → only panel or reader supersession may skip a paint. A newer interactive transform aborts N before commit, and otherwise lets N paint and then runs.
  - Rollback snapshots become committed-generation descriptors installed through the protocol, and the direct clears are identity installs.
  - Rejections carry the committed generation, with no retry loop.
  - Tests added (F4).

## Changes from revision 7

- **Sonnet:**
  - Implicit natural-order resets → invariant that the reader's committed transform is the one last painted. Every paint path installs its transform, identity included, before painting. Host state is assigned only through the protocol. A stale check follows each `committed` await. Test added (F4).
  - Suggestions taken: per-component restore failure keeps the partial-failure warning; a revert aborts in-flight work instead of queueing behind it.

## Changes from revision 6

- **Sonnet:** restore under the two-phase protocol → restore as one transaction with a single prepare/commit gated by the existing cancel snapshot; revert to natural order as an identity transform through the same protocol; `postPaint` stays the announcement point; a generation re-check before commit; candidate buffers released on abort; restore interleavings added to the tests (F4). Editorial: duplicate collator-cost sentence removed; status line corrected.

## Changes from revision 5

- **Terra:**
  - Cancellation after the reader installs a candidate → two-phase `prepare` / `commit` / `abort` install with serialized transforms, a defined point of no return, late acks ignored, and tests at every interleaving (F4).
  - Suggestion taken: dropped frames counted only when the pointer and thumb moved.
- **Sonnet** (agreed at revision 5; suggestions taken):
  - Natural emission names the UI locale and uses `desc()`; requirements named in the emitted code; a digit-run round-trip test.
  - Permutation buffers and the counter's source of truth in the compatibility-mode memory accounting.
  - A small wide CI fixture G.

## Changes from revision 4

- **Both reviewers:**
  - Permutation ownership and commit protocol: immutable `SharedArrayBuffer` permutations, host as commit authority after a reader install ack, held and rejected requests, cancellation and restart semantics, transition tests (F4).
  - Fallback → "compatibility mode": scan-worker materialization only, a memory cap including transients and both threads, admission and eviction with a bounded degraded display, honest fixture-B latency, and the 2,000-column claim made conditional on the spike (F2, Goal, Acceptance).
- **Sonnet:**
  - The `numeric: true` contradiction → explicit Natural / Locale / C orders, each emitted faithfully as code (Natural via `stringr::str_rank(numeric = TRUE)`) (F4).
  - Evaluation validity → fixture F with 300 labelled columns, native import routes and N/C scoring, Raven timed by the same recording method, small-sample rules.
  - Suggestions taken: NA/NaN buckets outside the bit encoding, labelled-column sort keys, years outside 1–9999.
- **Terra:**
  - Comparison on equivalent data → native import routes per tool, a valid fidelity battery (no NaN in a character column), expected results fixed in advance, a reproducible scroll script and dropped-frame counting, transport loss recorded as N/C.
  - Suggestion taken: boundary tests at `±8.64e15 ms` with `us = 0` and `us = 1`.

## Changes from revision 3

- **Sonnet:**
  - Long sorts blocking scroll → separate reader thread for viewport reads; cancellation checks inside ranking and radix loops (F4).
  - Evaluation → wide comparable fixture E, a fidelity battery, a measurement method for tools we can't instrument, and table-viewer and julia-vscode included.
  - Geometry → sufficiency argument plus a writer test of its premise (F2).
  - Sort keys → `-0` normalization, code-point comparison, collator ties, descending by bit complement (F4).
  - Suggestions taken: validity reads skipped when `null_count == 0`, header LRU, HLL from row 0, build fails if the Glide patch fails, `hourCycle: 'h23'`, `subsecond_digits` on rounded integers.
- **Terra:**
  - Column-group fallback → replaced by column materialization with its own read, gather, memory and budget contract, and no new files to orphan (F2).
  - Evaluation → after Phase 5, every surveyed tool, participants, repetitions, success criteria, winning rules fixed in advance, per-axis results, no blanket "best" claim (Goal, Comparative evaluation).
  - Timestamp range bounded to JS `Date`, with out-of-range rendering and boundary tests (Grid surface).
  - Suggestion taken: non-ASCII and collator-equal strings in sort and copy-as-code tests (Testing).

## Changes from revision 2

- **Sonnet:**
  - Sorted-window gather → element gather in the worker with 64-row tiles (F2, F5).
  - Header-scan cost → off the open path, in the worker, read from the flatbuffer, budgeted (F2, F0).
  - Irregular batch geometry → block-count proof with header-parse fallback (F2).
  - False ASCII claim → explicit Locale vs C order, C matching `dplyr::arrange()`'s default (F4).
  - Suggestions taken: committed Glide accessibility patch, `{ms, us}` timestamp wire value, Space-Saving from row 0.
- **Terra:**
  - Profile availability → three states, profile deadlines, a first-paint check limited to missing bars; distinct defined (Summaries, Acceptance).
  - Timestamp precision fixed per column by R; floor decomposition for pre-epoch values; DST tests (Grid surface).
  - Sort stability without a row-index key; C order specified exactly (F4).
  - Spike contract enumerated (framing, alignment, dictionaries, deltas, nested fields); column-group lifecycle with an atomic manifest; batch formula called a target, not a bound (F1, F2).
  - Accessibility: committed patch, no live-region equivalence (Accessibility).
  - Superiority narrowed to acceptance targets plus a comparative evaluation (Goal, Acceptance, Comparative evaluation).
  - Async `terminate()`, pending-request rejection (F4).

## Changes from revision 1

- **Sonnet:**
  - S1 width-aware batches → F1; projected `getRows` → F2.
  - S2 projected-read mechanism and spike, no budget-failing fallback → F2.
  - S3 `raven.nrow`/`chunk_rows`, `FieldNode` null counts, dictionaries without decoding batch 0 → F1, F2.
  - S4 phasing loop → Foundations first; end-to-end `View()` budgets → F0.
  - S5 string-sort budget from a spike, worker reads the file itself, build entry, terminate → F4.
  - S6 two-pass stats, priority, band default by rows → Summaries.
  - S7 gutter mapping, copy exclusion, width cap, schema-hash reset → Gutter.
  - S8 cached formatters, µs digits, `RangeError` fallback, conversion in the webview → Timestamps.
  - Suggestions taken: accessibility section, decimal padding instead of "tabular figures", go to row and cell detail, the F6 wording, failed state in the popover histogram.
- **Terra:**
  - T1 `.row_names_info(x, type = 1L)`, zero rows, name collisions → Gutter.
  - T2 no transfer claim for webviews → F6.
  - T3 projected reads as a prerequisite, with a column-group writer as the alternative → F2.
  - T4 whole-frame profiles, exact/≈ flags, Space-Saving top-K, half-open bins with matching filter inclusivity → Summaries. (Disputed: null counts *are* in the record-batch header — Arrow's `RecordBatch` message carries one `FieldNode {length, null_count}` per field.)
  - T5 display-column mapping module and tests → Gutter.
  - T6 generations, worker termination, packaging, debounced-save guards, invariant tests first → F0, F4, F5.
  - T7 named display-format subset, zone rules, NA/NaN round trip → Grid surface.
  - T8 fixtures, method, CI rules; goal restated as "10M rows or 2,000 columns" → F0.
  - T9 acceptance table, distinct counts, real brushing, accessibility testing; pinned rows conceded → Acceptance, Summaries, Accessibility.
  - Suggestions taken: visible row range in the status line, header prototype first, explicit refresh confirmation.
