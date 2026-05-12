# Design: R snippets (issue #204)

**Date:** 2026-05-12
**Status:** Approved, ready for implementation

## Overview

Add a VS Code snippets file with ~60 R code snippets, registered under the `r` language ID. Pure declarative contribution (JSON + a `package.json` entry) — no TypeScript or Rust changes. Covers the snippet categories listed in issue #204: control flow, functions, data structures, I/O, strings/output, pipes, plotting, and roxygen2.

R Markdown / Quarto snippets are deliberately out of scope for this PR — `.rmd` / `.qmd` files share the `r` language ID, so chunk-creation and YAML snippets would also appear in plain `.r` files. The cleanest place to add them is alongside the R Markdown / Quarto chunk work in issue #209, which is the natural place to introduce dedicated language IDs.

## Background

Raven currently ships zero snippets. vscode-R ships ~60 snippets across base R control flow, common functions, data structures, plotting, and package-development comments. Snippets are a low-risk, high-value contribution: they reduce keystrokes for common patterns without affecting parsing, diagnostics, or the language server.

## Files

```text
editors/vscode/snippets/
  r.json                          # new

editors/vscode/package.json       # add contributes.snippets entry

editors/vscode/src/test/
  snippets.test.ts                # new — structural validation
```

## Snippet file: `editors/vscode/snippets/r.json`

Standard VS Code snippet format. Each entry has the shape:

```json
"snippet-name": {
  "prefix": "trigger",
  "body": ["line one", "line two with $1 tab stop"],
  "description": "Short human-readable description"
}
```

### Content

The following table lists every snippet to ship. The trigger column is what the user types; the description column is what shows in the completion popup.

#### Control flow (9)

| Trigger | Description | Body |
|---|---|---|
| `if` | `if` block | `if (${1:condition}) {\n\t${0}\n}` |
| `ifelse` | `if`/`else` block | `if (${1:condition}) {\n\t${2}\n} else {\n\t${0}\n}` |
| `el` | `else if` chain | `else if (${1:condition}) {\n\t${0}\n}` |
| `for` | `for` loop | `for (${1:i} in ${2:seq_along(${3:x})}) {\n\t${0}\n}` |
| `while` | `while` loop | `while (${1:condition}) {\n\t${0}\n}` |
| `repeat` | `repeat`/`break` loop | `repeat {\n\t${1}\n\tif (${2:condition}) break\n}` |
| `switch` | `switch` expression | `switch(${1:expr},\n\t${2:case1} = ${3},\n\t${0:default}\n)` |
| `try` | `tryCatch` block | `tryCatch(\n\t${1:expr},\n\terror = function(e) ${2:NULL},\n\twarning = function(w) ${3:NULL},\n\tfinally = ${0}\n)` |
| `wch` | `withCallingHandlers` | `withCallingHandlers(\n\t${1:expr},\n\twarning = function(w) ${0}\n)` |

#### Functions (8)

| Trigger | Description | Body |
|---|---|---|
| `fun` | Function definition | `${1:name} <- function(${2:args}) {\n\t${0}\n}` |
| `lam` | Anonymous lambda (R ≥ 4.1) | `\\(${1:x}) ${0}` |
| `lapply` | `lapply` over list | `lapply(${1:x}, function(${2:el}) ${0})` |
| `sapply` | `sapply` over list | `sapply(${1:x}, function(${2:el}) ${0})` |
| `vapply` | `vapply` (type-safe) | `vapply(${1:x}, function(${2:el}) ${3}, ${0:FUN.VALUE})` |
| `mapply` | `mapply` multi-arg | `mapply(function(${1:a}, ${2:b}) ${3}, ${4:x}, ${0:y})` |
| `apply` | `apply` over matrix | `apply(${1:X}, ${2:MARGIN}, ${0:FUN})` |
| `docall` | `do.call` | `do.call(${1:what}, ${0:args})` |

#### Higher-order helpers (3)

| Trigger | Description | Body |
|---|---|---|
| `Map` | `Map` over multiple | `Map(function(${1:a}, ${2:b}) ${3}, ${4:x}, ${0:y})` |
| `Reduce` | `Reduce` to scalar | `Reduce(function(${1:acc}, ${2:x}) ${3}, ${4:x}, ${0:init})` |
| `Filter` | `Filter` by predicate | `Filter(function(${1:x}) ${2}, ${0:x})` |

#### Data structures (8)

| Trigger | Description | Body |
|---|---|---|
| `df` | `data.frame` | `data.frame(\n\t${1:col1} = ${2},\n\t${0}\n)` |
| `lst` | Named `list` | `list(\n\t${1:name} = ${2},\n\t${0}\n)` |
| `mat` | `matrix` | `matrix(${1:data}, nrow = ${2}, ncol = ${0})` |
| `vec` | `c()` vector | `c(${0})` |
| `seq` | `seq()` | `seq(${1:from}, ${2:to}, by = ${0:1})` |
| `seq_along` | `seq_along(x)` | `seq_along(${0:x})` |
| `seq_len` | `seq_len(n)` | `seq_len(${0:n})` |
| `rep` | `rep()` | `rep(${1:x}, ${0:times})` |

#### Pipes (2)

| Trigger | Description | Body |
|---|---|---|
| `pipe` | Native pipe `\|>` | `\|> ${0}` |
| `magrittr` | Magrittr pipe `%>%` | `%>% ${0}` |

(Assignment `<-` is omitted — it's a single-character pair, snippet overhead is worse than typing it.)

#### I/O (6)

| Trigger | Description | Body |
|---|---|---|
| `readcsv` | `read.csv` | `read.csv(${0:"path.csv"})` |
| `writecsv` | `write.csv` | `write.csv(${1:x}, ${2:"path.csv"}, row.names = ${0:FALSE})` |
| `readrds` | `readRDS` | `readRDS(${0:"path.rds"})` |
| `saverds` | `saveRDS` | `saveRDS(${1:object}, ${0:"path.rds"})` |
| `lib` | `library` call | `library(${0:pkg})` |
| `req` | `require` call | `require(${0:pkg})` |

#### Strings / output (8)

| Trigger | Description | Body |
|---|---|---|
| `cat` | `cat` | `cat(${1:...}, ${0:sep = "\\n"})` |
| `print` | `print` | `print(${0:x})` |
| `paste` | `paste` | `paste(${1:...}, sep = ${0:" "})` |
| `paste0` | `paste0` | `paste0(${0:...})` |
| `sprintf` | `sprintf` | `sprintf(${1:"%s"}, ${0:args})` |
| `msg` | `message` | `message(${0:"..."})` |
| `warn` | `warning` | `warning(${0:"..."})` |
| `stop` | `stop` | `stop(${0:"..."})` |

#### Plotting (5)

| Trigger | Description | Body |
|---|---|---|
| `plot` | Base `plot` | `plot(${1:x}, ${0:y})` |
| `ggplot` | ggplot scaffold | `ggplot(${1:data}, aes(${2:x = , y = })) +\n\t${0}` |
| `geom_point` | `geom_point()` | `geom_point(${0})` |
| `geom_line` | `geom_line()` | `geom_line(${0})` |
| `geom_bar` | `geom_bar()` | `geom_bar(${0})` |

#### Roxygen (10)

These are roxygen2 tags. Triggers include the `@` so typing `@p` after `#'` filters down to `@param` etc. naturally.

| Trigger | Description | Body |
|---|---|---|
| `rox` | Full roxygen block | full multi-line block: title, description, `@param`, `@return`, `@examples`, `@export` |
| `@param` | `@param name desc` | `@param ${1:name} ${0:description}` |
| `@return` | `@return desc` | `@return ${0:description}` |
| `@export` | `@export` tag | `@export` |
| `@title` | `@title desc` | `@title ${0:title}` |
| `@description` | `@description desc` | `@description ${0:description}` |
| `@examples` | `@examples block` | `@examples\n#' ${0:example}` |
| `@inheritParams` | `@inheritParams source` | `@inheritParams ${0:source_fun}` |
| `@seealso` | `@seealso \\code{\\link{}}` | `@seealso \\code{\\link{${0:fun}}}` |
| `@noRd` | `@noRd` tag | `@noRd` |

#### Testing / devtools (2)

| Trigger | Description | Body |
|---|---|---|
| `tc` | `test_that` block | `test_that("${1:description}", {\n\t${0}\n})` |
| `loadall` | `devtools::load_all()` | `devtools::load_all(${0})` |

**Total: 61 snippets.**

### Snippet style conventions

- Triggers are lowercase, short, and either match a keyword (`if`, `for`, `while`) or use a 3–5 letter mnemonic (`fun`, `lst`, `req`).
- Placeholders use `${N:default}` where `N` is the tab stop order and `default` is a helpful hint.
- Final cursor position is `${0}` and is placed where the user is most likely to continue typing.
- Multi-line bodies use literal `\t` for indent so VS Code's tab-vs-space setting decides the rendered indent.
- No trailing whitespace inside `body` strings.

### Conflicts with R keywords

R has no reserved-word lookup for `if`, `for`, `while`, etc., the same way IDEs autocomplete them. Snippets with those triggers will appear in the completion list alongside any matching symbol. Snippets only expand when explicitly accepted (Tab/Enter on the snippet completion), so this is safe — they don't hijack normal typing.

## `package.json` registration

Add to `contributes`:

```json
"snippets": [
  {
    "language": "r",
    "path": "./snippets/r.json"
  }
]
```

This block belongs after `contributes.grammars` and before `contributes.configurationDefaults` (i.e., keeping declarative contributions grouped together).

## Tests: `editors/vscode/src/test/snippets.test.ts`

A new Mocha-style suite (matching the existing `*.test.ts` pattern) that:

1. **Parses the snippets file.** Reads `editors/vscode/snippets/r.json` and asserts the JSON parses.
2. **Validates each snippet entry.** For each top-level key, asserts:
   - `prefix` is a non-empty string.
   - `body` is a string or array of strings; if an array, every element is a string.
   - `description` is a non-empty string.
3. **Asserts unique prefixes.** Build a `Set` from all prefixes; assert size equals snippet count. (Two snippets sharing a prefix would silently overwrite each other in VS Code's completion.)
4. **Asserts package.json wiring.** Reads `package.json`, navigates to `contributes.snippets`, asserts there is exactly one entry with `language: "r"` and `path: "./snippets/r.json"`.
5. **Asserts snippet file exists at registered path.** Resolve the path from `package.json` and assert the file exists on disk.

Tests are pure file/JSON assertions — no `vscode` API needed beyond what the existing settings test uses. They run inside the `vscode-test` harness like the other `*.test.ts` files.

## Documentation updates

### README updates

Add `Snippets` to the **Code intelligence** section of `editors/vscode/README.md`:

> - **Snippets** — Built-in snippets for common R patterns (control flow, apply family, ggplot2 scaffolds, roxygen2 tags)

(Single bullet — a full doc page is overkill for ~60 snippets that auto-discover via VS Code's completion popup.)

### CHANGELOG / Learnings

This PR doesn't introduce any invariant that belongs in `CLAUDE.md`. No changes to that file.

## Out of scope

- R Markdown / Quarto chunk snippets — deferred to #209.
- Snippet user customization UI — VS Code already supports user snippets via `Preferences: Configure User Snippets`; users can override or extend ours there.
- Language-server-driven snippet completions — VS Code's built-in snippet engine is sufficient.
- Auto-trigger snippets (e.g., expanding `fun` to `function() {}` on space). VS Code requires manual completion acceptance for snippets; this is the standard UX.

## Acceptance criteria

1. The 61 snippets ship under `editors/vscode/snippets/r.json`, registered for the `r` language in `package.json`.
2. `bun run typecheck` and the VS Code test suite pass.
3. New `snippets.test.ts` passes, covering structural validation and registration.
4. Manually verified: opening an `.R` file and typing each category prefix shows the snippet in the completion popup with the right preview.
5. README's Code intelligence section mentions snippets.
