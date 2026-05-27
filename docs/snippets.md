# Snippets

Raven's VS Code extension includes built-in snippets for common R patterns. They appear in the normal completion popup for R documents and expand only when you explicitly accept them.

The snippet set covers:

- Control flow: `if`, `ife`, `el`, `for`, `while`, `repeat`, `switch`, `trycatch`, `wch`
- Functions and apply helpers: `fun`, `lam`, `lapply`, `sapply`, `vapply`, `mapply`, `Map`, `Reduce`, `Filter`, `apply`, `docall`
- Data structures and sequences: `df`, `lst`, `mat`, `vec`, `seq`, `seq_along`, `seq_len`, `rep`
- Pipes and I/O: `pipe`, `magrittr`, `readcsv`, `writecsv`, `readrds`, `saverds`, `source`, `lib`, `req`
- Output and strings: `cat`, `msg`, `warn`, `stop`, `print`, `paste`, `paste0`, `sprintf`
- Plotting: `plot`, `ggplot`, `geom_point`, `geom_line`, `geom_bar`
- Modeling: `lm`, `glm`, `loess`
- Testing and devtools: `tc` (test_that), `loadall` (devtools::load_all)
- Roxygen2: `rox` (full block), `@param`, `@return`, `@export`, `@examples`, and more

For the exact trigger list and expansion bodies, see `editors/vscode/snippets/r.json`.

## R Markdown and Quarto

Raven contributes dedicated `rmd` and `quarto` language IDs for `.Rmd` and `.qmd` files. Plain-R snippets from `r.json` (`for` / `fun` / `if` etc.) are registered unconditionally for `.R` files via `package.json` — no console activation required. Inside `.Rmd` / `.qmd` buffers the same snippets are also made available, but only when Raven's R console is active, because they overlap directly with REditorSupport's `r-snippets.json` triggers (`if`, `for`, etc.) inside fenced R chunks. That gating is controlled by `raven.rConsole.activation`; see [Coexistence](./coexistence.md). The R Markdown and Quarto chunk / helper snippets below use distinct, compact prefixes (`rchunk`, `setupchunk`, etc.) — REditorSupport ships its own R Markdown snippets, but they use different, longer-form prefixes (`r code chunk`, `inline r code`, etc.), so the two sets coexist without trigger collisions and Raven's snippets register unconditionally.

The R Markdown set (`rmd`) adds:

- Code chunks: `rchunk`, `rchunkopts`, `setupchunk`, `pychunk`, `sqlchunk`, `bashchunk`
- YAML frontmatter: `rmdyaml`
- knitr helpers: `kable`, `incgraphics`, `inliner`

The Quarto set (`quarto`) covers the same chunk and helper triggers, but `rchunk` / `rchunkopts` / `setupchunk` use the Quarto `#| key: value` option syntax, and the YAML snippet is `qyaml`.

For the exact trigger list and expansion bodies, see `editors/vscode/snippets/rmarkdown.json` and `editors/vscode/snippets/quarto.json`.
