# Snippets

[Docs](README.md) › Navigation and editing

Raven's VS Code extension adds snippets for common R code, R Markdown chunks, and Quarto chunks: type a short prefix and accept it from the completion list.

| You type | You accept | You get |
|---|---|---|
| `fun` | Function definition | `name <- function(args) {` … `}`, with the cursor on `name` |
| `for` | for loop | `for (i in seq_along(x)) {` … `}` |
| `rchunk` (in `.Rmd`) | R code chunk | An empty `{r label}` chunk |

A snippet expands only when you accept it. Press Tab to move between the placeholders it inserts.

## R snippets

These work in `.R` files. Each line shows the prefix and what it inserts.

### Control flow

| Prefix | Inserts |
|---|---|
| `if` | `if (condition) { }` |
| `ife` | `if (condition) { } else { }` |
| `el` | `else if (condition) { }`, for after a closing brace |
| `for` | `for (i in seq_along(x)) { }` |
| `while` | `while (condition) { }` |
| `repeat` | `repeat { }` with an `if (condition) break` inside |
| `switch` | `switch(expr, case1 = , default)` |
| `trycatch` | `tryCatch(expr, error = function(e) NULL)` |
| `wch` | `withCallingHandlers(expr, warning = function(w) )` |

### Functions and apply helpers

| Prefix | Inserts |
|---|---|
| `fun` | `name <- function(args) { }` |
| `lam` | `\(x) `, the anonymous-function shorthand from R 4.1 |
| `lapply`, `sapply` | `lapply(x, function(el) )`, and the same for `sapply` |
| `vapply` | `vapply(x, function(el) , character(1))` |
| `mapply`, `Map` | `mapply(function(a, b) , x, y)`, and the same for `Map` |
| `Reduce` | `Reduce(function(acc, x) , x, init)` |
| `Filter` | `Filter(function(x) , x)` |
| `apply` | `apply(X, MARGIN, FUN)` |
| `docall` | `do.call(what, args)` |

### Data structures and sequences

| Prefix | Inserts |
|---|---|
| `df` | `data.frame(col1 = , )` over several lines |
| `lst` | `list(name = , )` over several lines |
| `mat` | `matrix(data, nrow = , ncol = )` |
| `vec` | `c()` |
| `seq` | `seq(from, to, by = 1)` |
| `seq_along`, `seq_len` | `seq_along(x)`, `seq_len(n)` |
| `rep` | `rep(x, times)` |

### Pipes, files, and packages

| Prefix | Inserts |
|---|---|
| `pipe` | `\|>` |
| `magrittr` | `%>%` |
| `readcsv`, `writecsv` | `read.csv("path.csv")`, `write.csv(x, "path.csv", row.names = FALSE)` |
| `readrds`, `saverds` | `readRDS("path.rds")`, `saveRDS(object, "path.rds")` |
| `source` | `source("path.R")` |
| `lib`, `req` | `library(pkg)`, `require(pkg)` |

### Output and strings

| Prefix | Inserts |
|---|---|
| `cat` | `cat(..., sep = "\n")` |
| `print` | `print(x)` |
| `msg`, `warn`, `stop` | `message("...")`, `warning("...")`, `stop("...")` |
| `paste`, `paste0` | `paste(..., sep = " ")`, `paste0(...)` |
| `sprintf` | `sprintf("%s", args)` |

### Plotting and models

| Prefix | Inserts |
|---|---|
| `plot` | `plot(x, y)` |
| `ggplot` | `ggplot(data, aes(x = , y = )) +` and a new line |
| `geom_point`, `geom_line`, `geom_bar` | `geom_point()`, `geom_line()`, `geom_bar()` |
| `lm` | `lm(y ~ x, data = df)` |
| `glm` | `glm(y ~ x, data = df, family = gaussian())` |
| `loess` | `loess(y ~ x, data = df)` |

### Testing and package development

| Prefix | Inserts |
|---|---|
| `tc` | `test_that("description", { })` |
| `loadall` | `devtools::load_all()` |

### Roxygen

| Prefix | Inserts |
|---|---|
| `rox` | A full roxygen block: title, description, `@param`, `@return`, `@export`, and `@examples` |
| `@param` | `@param name description` |
| `@return` | `@return description` |
| `@export` | `@export` |
| `@title` | `@title title` |
| `@description` | `@description description` |
| `@examples` | `@examples` and an example line |
| `@inheritParams` | `@inheritParams source_fun` |
| `@seealso` | `@seealso \code{\link{fun}}` |
| `@noRd` | `@noRd` |

## R Markdown and Quarto

In `.Rmd` and `.qmd` files, Raven adds chunk and document snippets. Their prefixes don't collide with REditorSupport's R Markdown snippets, which use longer prefixes such as `r code chunk`, so the two sets work side by side.

| Prefix | R Markdown (`.Rmd`) | Quarto (`.qmd`) |
|---|---|---|
| `rchunk` | `{r label}` chunk | `{r}` chunk with `#\| label: label` |
| `rchunkopts` | `{r label, echo = FALSE, message = FALSE, warning = FALSE}` chunk | `{r}` chunk with `#\| label`, `#\| echo`, `#\| message`, and `#\| warning` options |
| `setupchunk` | `{r setup, include = FALSE}` chunk with `knitr::opts_chunk$set(echo = TRUE)` | The same setup chunk, with `#\| label: setup` and `#\| include: false` |
| `pychunk`, `sqlchunk`, `bashchunk` | Python, SQL (`connection=con`), and Bash chunks | The same |
| `rmdyaml` | YAML front matter with title, author, date, and output format | — |
| `qyaml` | — | YAML front matter with title, author, `date: today`, and format |
| `kable` | `knitr::kable(df, caption = "Caption")` | The same |
| `incgraphics` | `knitr::include_graphics("path/to/img.png")` | The same |
| `inliner` | An inline R expression, `` `r expr` `` | The same |

Inside R chunks of `.Rmd` and `.qmd` files, the [R snippets](#r-snippets) above are also offered, but only while Raven's R console features are active. Next to REditorSupport they are active by default, so its snippets with the same prefixes, such as `if` and `for`, may appear next to Raven's in R chunks. [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting) explains when the console features are active. In `.R` files the R snippets are always available.

## Sort or hide snippets

Snippets appear in the same completion list as Raven's code completions. To list them after other completions, set this in your VS Code settings:

```json
"editor.snippetSuggestions": "bottom"
```

Other values are `"top"`, `"inline"` (the default, sorted with everything else), and `"none"`, which hides snippets from the completion list. To limit a setting to R files, put it inside an `"[r]"` block.

## Limitations

- Snippets come from the VS Code extension. Other editors don't get them from the language server.
- Raven doesn't add snippets for JAGS or Stan files.

## See also

- [Completion](completion.md)
- [Code chunks](chunks.md)
- [Coexistence](coexistence.md)
