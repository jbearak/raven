# Data viewer prior art

Research behind `2026-10-29-data-viewer-redesign-design.md`. Gathered 2026-10-29. License notes are relative to Raven's GPL-3.0: "copy" means code may be reused with notices, "study" means design only.

## table-viewer (jbearak/table-viewer, GPL-3.0, copy)

A VS Code extension and desktop app for CSV/TSV/XLSX/Arrow. Its grid is a vendored, trimmed Glide Data Grid 6.0.3 (canvas).

- **Theme** (`src/webview/vscode-theme.ts`): Glide tokens mapped from VS Code variables. `bgCell`/`bgCellMedium` come from the editor background, so there's no zebra striping. `bgHeader` uses `editorGroupHeader.tabsBackground`, borders use `editorWidget.border` then `panel.border`, and the accent uses `focusBorder`. The selection fill is `editor.selectionBackground` re-emitted at α 0.35 (0.5 in high contrast) so cell tints show through. A MutationObserver re-reads the theme when it changes.
- **Font:** one `--tv-font-size` variable, with ×0.77/0.85/0.92/1.08 steps, drives both the canvas and the chrome.
- **Sizes:** rows are 24 px at a 13 px font and scale with font size. Headers are 36 px. Column widths default to 120 px, range 40–3200, and auto-fit up to 800.
- **Header and gutter:** a canvas sort glyph with a priority badge (`header-sort-glyph.ts`). The gutter width depends on row count.
- **Chrome:** a state strip of sort/filter chips that can be toggled, reordered and disabled. Text-only toolbar, no codicons. Truncated cells get a hover tooltip.
- **Interaction:**
  - hjkl navigation and Shift+Alt shortcuts for transforms on the focused column.
  - Row, column and range selection.
  - Guarded TSV copy, capped at 100k rows, 1M cells or 32 MiB.
  - Double-click auto-fit by canvas `measureText` (`fit-column-model.ts`).
  - Filter popover with 15 operators, a histogram with draggable thumbs (adapted from Raven's), and a searchable distinct-value checklist.
  - Missing sorts last; strings sort with `Intl.Collator({numeric:true})`.
- **Missing features:** find, go-to-row, freeze panes, zoom, status bar, number right-alignment.
- **Performance:**
  - Row loader (`row-loader.ts`): 100-row page-aligned requests and an LRU capped at 1M cells or 64 MiB, with viewport pages pinned, up to 16 requests in flight, and a generation counter.
  - Host transforms produce a `Uint32Array` display→source permutation. They're chunked with `setImmediate`, can be cancelled, and share a column-analysis cache.
  - Arrow files are decoded 256 rows at a time with an 8-page / 16 MiB cache.
- **Benchmarks** (`benchmarks/grid`): csv-200k×8 scrolls at 16.7 ms p50 / 18.2 ms p95. `compare.mjs` fails a run on a 5% scroll regression or a 10% open-time regression.

## R

- **RStudio View()** (AGPL-3, study):
  - Grid: a hand-written vanilla JS grid. The header shows the name plus the label on a second line.
  - Filters by type: a histogram brush for numerics, checkboxes for factors, a text box for strings. There's also a global search that narrows the previous match set as you extend the term.
  - Summary sidebar (2026.05): n, NA and unique, then per type: min/max/mean/median/sd, factor counts up to 50, string lengths, logical counts, date range plus time zone.
  - Paging: 500-row fetches with a 20k-row cache, and column virtualization (2026.06) after wide frames froze it (#1771, #17806).
  - Budgets: up to 24 category bars, tabulates at most 1e6 rows, skips width scans above 200 columns.
  - `colsFingerprint` decides whether saved state still applies.
  - Known complaints: wide frames, `sf`/list columns hanging, and 1e8 row names materialized (#1705).
- **Positron Data Explorer** (Elastic 2.0, study):
  - Summary panel: type icon, sparkline histogram or frequency table, missing bar and %, expandable stats, its own search and sort, and click to jump. The header has name over type.
  - Pinned rows and columns, a filter-chip bar, and Convert to Code (dplyr).
  - Protocol (OpenRPC): `get_column_profiles` runs async and covers only visible columns, and `format_options` controls number formatting.
  - Complaints: labels only in a tooltip (#14239), a blank screen while slow (#15463), and no difference between failed and loading summaries (#16819).
- **ark** (Positron's R backend, MIT, copy): Rust `data_explorer/format.rs`, `histogram.rs`, `summary_stats.rs`, `convert_to_code.rs`.
- **vscode-R** (MIT, copy):
  - ag-grid with 500-row JSON-RPC blocks.
  - NA shown in light italics. Ordered factors sort by level, and list/complex/raw columns can't be sorted.
  - The gutter header shows filtered/total.
  - A test checks that viewing never changes `.Random.seed`.
  - It reportedly opens 5M × 150 instantly.
- **Packages:**
  - DT (MIT): filters under the header.
  - reactable (MIT): virtual rows and sticky columns.
  - gtExtras `gt_plt_summary` (MIT): type icon, inline histogram, missing %.
  - skimr (GPL-3): stats grouped by type, Unicode histograms.
  - summarytools `dfSummary` (GPL-2-only, study).
  - pillar/tibble (MIT): type tags, NA in red, 3 significant figures.
  - data.table print (MPL-2.0): head/tail, class line, `1:` row numbers.

## Julia

- **julia-vscode** (MIT): ag-grid with an infinite row model. Block size is `max(round(2000/ncols), 50)` rows, and sort/filter are off above 1e7 elements.
- **TableView.jl** (ag-grid over WebIO; doesn't work in VS Code) and **BrowseTables.jl** (static HTML): both MIT.
- **PrettyTables/DataFrames:** element type on a second header line, and "N rows omitted".
- **Pluto:** a row of names, then a row of types, with lazy "more" loading.

## Python and web

- **Data Wrangler** (proprietary, study): a quick-insights header with missing, distinct and a mini histogram or top values, plus a summary panel. Built on react-data-grid (MIT, DOM in both axes), with a lot of accessibility work. Default columns are 200 px.
- **Jupyter VS Code data viewer** (MIT, SlickGrid DOM): deprecated in 2024, partly for poor accessibility.
- **Buckaroo** (BSD-3): pinned summary-stat rows under the header, header histograms, per-column displayer overrides with documented precedence.
- **Perspective / regular-table** (Apache-2.0): WASM engine with Arrow input. A `<table>` virtualized in both axes, whose data listener returns a Promise, with one request in flight.
- **Glide Data Grid** (MIT): canvas, both axes virtualized, a hidden ARIA `role=grid` table, flat theme tokens. Its authors left DOM virtualization over per-frame DOM churn.
- **ipydatagrid / Lumino** (BSD-3): canvas. Serialization, not drawing, was the bottleneck, fixed by a streaming viewport.
- **marimo** (Apache-2.0): column summaries on by default only below 40 columns, with stats or charts in the header.
- **quak** (MIT): Observable-style header summaries with cross-filtering; every interaction compiles to SQL.
- **D-Tale** (LGPL-2.1): describe view with histograms and value counts.
- **VisiData** (GPL-3): frequency sheet (Shift+F), describe sheet (Shift+I), columns sheet (Shift+C).
- **AG Grid** (MIT): DOM in both axes, plus "stretching" to get past the ~33M px height cap.
- **Panel Tabulator:** freezes around 100 columns because it doesn't virtualize columns.
- **Polars/pandas:** a shape line, and a dtype row under the header.
