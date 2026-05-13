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

Raven registers snippets for VS Code's `r` language ID. Since `.rmd` and `.qmd` files are treated as R documents, both the plain R snippets above and an R Markdown / Quarto set are available in those buffers.

The R Markdown / Quarto set covers:

- Code chunks: `rchunk`, `rchunkopts`, `setupchunk`, `pychunk`, `sqlchunk`, `bashchunk`
- YAML frontmatter: `rmdyaml`, `qyaml`
- knitr helpers: `kable`, `incgraphics`, `inliner`

For the exact trigger list and expansion bodies, see `editors/vscode/snippets/rmarkdown.json`.
