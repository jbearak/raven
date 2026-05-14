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

Raven contributes dedicated `rmd` and `quarto` language IDs for `.Rmd` and `.qmd` files. Each language ID gets its own snippet set; plain-R snippets are only registered under the `r` language ID, so they do not appear inside `.Rmd` / `.qmd` buffers (they will surface inside an R chunk only if another extension provides Markdown injection that switches the languageId to `r` within the chunk).

The R Markdown set (`rmd`) covers:

- Code chunks: `rchunk`, `rchunkopts`, `setupchunk`, `pychunk`, `sqlchunk`, `bashchunk`
- YAML frontmatter: `rmdyaml`
- knitr helpers: `kable`, `incgraphics`, `inliner`

The Quarto set (`quarto`) covers the same chunk and helper triggers, but `rchunk` / `rchunkopts` / `setupchunk` use the Quarto `#| key: value` option syntax, and the YAML snippet is `qyaml`.

For the exact trigger list and expansion bodies, see `editors/vscode/snippets/rmarkdown.json` and `editors/vscode/snippets/quarto.json`.
