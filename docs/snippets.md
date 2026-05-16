# Snippets

Raven's VS Code extension includes built-in snippets for common R patterns. They appear in the normal completion popup for R documents and expand only when you explicitly accept them.

The snippet set covers:

- Control flow: `if`, `ife`, `for`, `while`, `repeat`, `switch`, `trycatch`, `wch`
- Functions and apply helpers: `fun`, `lam`, `lapply`, `sapply`, `vapply`, `mapply`, `apply`, `docall`
- Data structures and sequences: `df`, `lst`, `mat`, `vec`, `seq`, `seq_along`, `seq_len`, `rep`
- Pipes and I/O: `pipe`, `magrittr`, `readcsv`, `writecsv`, `readrds`, `saverds`, `source`, `lib`, `req`
- Strings, output, plotting, modeling, testthat, devtools, and roxygen2 tags

For the exact trigger list and expansion bodies, see `editors/vscode/snippets/r.json`.

## R Markdown and Quarto

Raven contributes dedicated `rmd` and `quarto` language IDs for `.Rmd` and `.qmd` files. Plain-R snippets from `r.json` (`for` / `fun` / `if` etc.) also expand inside `.Rmd` / `.qmd` buffers when Raven's R console is active — typically what you want when the cursor sits inside an R chunk. These overlap with REditorSupport's snippet contributions, so they are gated behind `raven.rConsole.activation`; see [Coexistence](./coexistence.md). The R Markdown and Quarto chunk / helper snippets below register unconditionally, since REditorSupport doesn't ship equivalents.

The R Markdown set (`rmd`) adds:

- Code chunks: `rchunk`, `rchunkopts`, `setupchunk`, `pychunk`, `sqlchunk`, `bashchunk`
- YAML frontmatter: `rmdyaml`
- knitr helpers: `kable`, `incgraphics`, `inliner`

The Quarto set (`quarto`) covers the same chunk and helper triggers, but `rchunk` / `rchunkopts` / `setupchunk` use the Quarto `#| key: value` option syntax, and the YAML snippet is `qyaml`.

For the exact trigger list and expansion bodies, see `editors/vscode/snippets/rmarkdown.json` and `editors/vscode/snippets/quarto.json`.
