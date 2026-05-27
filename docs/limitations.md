# Limitations

Raven is under active development. The gaps below reflect features that exist in comparable tools but aren't yet in Raven, or where Raven's implementation differs meaningfully from the comparable tool's. Each entry links to the doc where it's discussed in context.

## Language server

- **Full `lintr` coverage** — Raven ships a built-in, opt-in style linter that re-implements a subset of `lintr` rules natively (see [Linting](./linting.md)). [REditorSupport/languageserver](https://github.com/REditorSupport/languageserver) runs the full `lintr` package, including rules Raven doesn't replicate (`object_usage_linter`, the full set of style checks, etc.). You can run both language servers at once; see [Coexistence: Language servers](./coexistence.md#language-servers-raven-alone-vs-both).
- **Session-aware completions** — Raven's completions are purely static. REditorSupport can complete symbols from the live R session's `globalenv()`, including column names from data frames that only exist at runtime. See [Comparison: Language intelligence](./comparison.md#language-intelligence).

## R-session features

- **Workspace viewer** — REditorSupport has a sidebar panel that introspects the live R session, showing objects in `globalenv()` with their types and dimensions, plus attached and loaded namespaces; objects can be viewed or removed from the panel. Raven has no equivalent. See [Comparison: What REditorSupport's VS Code extension offers that Raven doesn't](./comparison.md#what-reditorsupports-vs-code-extension-offers-that-raven-doesnt).
- **htmlwidget / Shiny viewer** — Interactive HTML output (plotly, DT, profvis, etc.) and Shiny apps render in REditorSupport's webview panels. Raven has no equivalent.
- **Auto-refresh knit preview** — Raven ships [`Raven: Knit Preview`](./knit.md) for `.Rmd` files: a static HTML viewer with a manual **Knit again** button (`Shift+Cmd+Enter` / `Shift+Ctrl+Enter` saves and re-knits in one keystroke). REditorSupport's `.Rmd` preview adds an opt-in auto-refresh mode that watches the source file and re-renders on save; the [`quarto.quarto`](https://marketplace.visualstudio.com/items?itemName=quarto.quarto) extension similarly offers `Quarto: Preview` with render-on-save (gated by `quarto.render.renderOnSave`). Raven's preview is deliberately manual — see [Knit](./knit.md) for the design rationale. `.qmd` rendering is the Quarto extension's domain regardless.
- **List / environment viewer** — REditorSupport's `View()` on lists and environments opens a collapsible tree view. Raven's `View()` only handles data frames and matrices. See [Data Viewer](./data-viewer.md).

If you rely on any of the fully-absent features above (workspace viewer, htmlwidget/Shiny viewer, list/environment viewer) and have REditorSupport installed, see [Coexistence](./coexistence.md) for how to run both extensions together.

If you're interested in any of these features in Raven, please [file an issue](https://github.com/jbearak/raven/issues) — I'd consider them if there's interest.
