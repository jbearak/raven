# Limitations

Raven is under active development. The gaps below reflect features that exist in comparable tools but aren't yet in Raven, or where Raven's implementation differs meaningfully from the comparable tool's. Each entry links to the doc where it's discussed in context.

## Language server

- **Full `lintr` coverage** — Raven ships a built-in, opt-in style linter that re-implements 18 of `lintr`'s rules natively — most of its default set (see [Linting](./linting.md)). [REditorSupport/languageserver](https://github.com/REditorSupport/languageserver) runs the full `lintr` package, including rules Raven doesn't replicate (`object_usage_linter`, the full set of style checks, etc.). You can run both language servers at once; see [Coexistence: Language servers](./coexistence.md#language-servers-raven-alone-vs-both).
- **Session-aware completions** — Raven's completions are purely static. REditorSupport can complete symbols from the live R session's `globalenv()`, including column names from data frames that only exist at runtime. See [Comparison: Language intelligence](./comparison.md#language-intelligence).
- **`useDynLib` native routine symbols** — When a package registers native routines via `useDynLib(pkg, .registration = TRUE)`, R creates R-level bindings (e.g. rlang's `ffi_enquo`, `ffi_quos_interp`) in the package namespace at load time. These names live in C source (`src/init.c`) and are not statically derivable from R or NAMESPACE files alone, so Raven flags them as undefined. This affects packages that call their own registered routines directly (most notably rlang). Suppress with `# @lsp-ignore-next` or a [directive](./directives.md).

## R Markdown / Quarto

R chunk bodies in `.Rmd` / `.qmd` documents are fully analyzed as first-class R code. The following gaps are accepted limitations of the current implementation:

- **Inline R expressions** (`\`r expr\`` in prose) are not analyzed. Only fenced chunk bodies (```` ```{r} ... ``` ```` ) are treated as R.
- **Cross-chunk delimiter leak** — chunk bodies are analyzed as a single concatenated R program. An unclosed delimiter (`"`, `(`, `{`) in one chunk body can swallow the opening of the next chunk, causing the next chunk's parse to fail. The unclosed delimiter in the offending chunk is itself flagged as a parse error. This is a consequence of Raven's single-parse analysis model (knitr itself evaluates chunks one at a time and would stop at the offending chunk).
- **Non-R chunks not analyzed** — `{python}`, `{bash}`, `{julia}`, and other non-R fenced blocks are never analyzed or linted.
- **knitr chunk-reuse lines** (`<<label>>`) are blanked (treated as empty lines) and not resolved.

## R-session features

- **Workspace viewer** — REditorSupport has a sidebar panel that introspects the live R session, showing objects in `globalenv()` with their types and dimensions, plus attached and loaded namespaces; objects can be viewed or removed from the panel. Raven has no equivalent. See [Comparison: What REditorSupport's VS Code extension offers that Raven doesn't](./comparison.md#what-reditorsupports-vs-code-extension-offers-that-raven-doesnt).
- **htmlwidget / Shiny viewer** — Interactive HTML output (plotly, DT, profvis, etc.) and Shiny apps render in REditorSupport's webview panels. Raven has no equivalent.
- **Auto-refresh knit preview** — Raven ships [`Raven: Knit Preview`](./knit.md) for `.Rmd` files: a static HTML viewer with a manual **Knit again** button (`Shift+Cmd+Enter` / `Shift+Ctrl+Enter` saves and re-knits in one keystroke). REditorSupport's `.Rmd` preview adds an opt-in auto-refresh mode that watches the source file and re-renders on save; the [`quarto.quarto`](https://marketplace.visualstudio.com/items?itemName=quarto.quarto) extension similarly offers `Quarto: Preview` with render-on-save (gated by `quarto.render.renderOnSave`). Raven's preview is deliberately manual — see [Knit](./knit.md) for the design rationale. `.qmd` rendering is the Quarto extension's domain regardless.
- **List / environment viewer** — REditorSupport's `View()` on lists and environments opens a collapsible tree view. Raven's `View()` only handles data frames and matrices. See [Data Viewer](./data-viewer.md).

If you rely on any of the fully-absent features above (workspace viewer, htmlwidget/Shiny viewer, list/environment viewer) and have REditorSupport installed, see [Coexistence](./coexistence.md) for how to run both extensions together.
