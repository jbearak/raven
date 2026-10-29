# Completion

[Docs](README.md) › Navigation and editing

Raven completes the names that exist at your cursor: your variables and functions, symbols from sourced files and loaded packages, arguments, `$` members, and file paths.

| You type | Raven offers |
|---|---|
| `mut` after `library(dplyr)` | `mutate {dplyr}`, `mutate_all {dplyr}`, … |
| `dplyr::` | dplyr's exports, with or without `library(dplyr)` |
| `read.csv(` | `file`, `header`, `sep`, `quote`, … |
| `config$` after `config <- list(host = "localhost", port = 8080)` | `host`, `port` |
| `source("utils/` | `utils/helpers.R`, `utils/config.R`, … |
| `help` after `source("utils.R")` | `helper_function`, with "from utils.R" as the detail |

A name is offered only where it would exist when the line runs. A variable assigned on line 50 isn't offered on line 10.

## What's offered

| Symbol source | Behavior |
|---|---|
| Local definitions | Symbols defined in the current file, above the cursor |
| Cross-file symbols | Symbols from sourced files, available after the `source()` call or `# raven: source` directive |
| Package exports | Functions and variables from loaded packages, with `{pkg}` attribution |
| Namespace-qualified exports | A package's exported symbols after `pkg::` (for example `dplyr::`) |
| box imports | Static namespace aliases and attached or renamed exports; known exports after `alias$`, `alias@`, or literal `alias[["…"]]` access |
| import package bindings | Static selected, renamed, and known `.all` bindings from packages or literal script modules; named destinations contribute fallback names only |
| Function parameters | Parameter names when inside a function call |
| File paths | `.R` and `.r` files and directories inside `source()` strings and path directives |
| `$` members | Known members after `$`, from assignments and constructors |

## Position-aware filtering

Completions follow execution order. A symbol is offered only if it would be defined at the cursor when the code runs:

```r
# Before this line: only base symbols and earlier local definitions
library(dplyr)
# After the library() call: dplyr exports are available
source("utils.R")
# After the source() call: symbols from utils.R are available
```

At the top level, Raven doesn't offer symbols defined below the cursor in the same file. Inside function bodies, global definitions are hoisted, so a function body sees them all (see [Global symbol hoisting](cross-file.md#global-symbol-hoisting)). Names removed with `rm()` or `remove()` are no longer offered.

## Package completions

When `library()` loads a package, its exports appear in completions with `{package}` as the detail:

```r
library(dplyr)
mut  # Offers: mutate {dplyr}, mutate_all {dplyr}, ...
```

Package completions are position-aware: they appear only after the `library()` call. Packages loaded in a parent file before the `source()` call that runs the current file are also available. Package completions need package awareness (`raven.packages.enabled`, on by default). Base-package symbols also wait until the package library has finished loading.

### Namespace-qualified completions (`pkg::`)

After `pkg::`, Raven completes the package's exported symbols:

```r
dplyr::  # Offers: mutate {dplyr}, filter {dplyr}, select {dplyr}, ...
```

Each item is attributed `{package}` and resolves to that topic's help, like other package completions. The list covers the package's `NAMESPACE` exports. Exports that aren't valid bare names, such as the operator `%>%`, are inserted in backticks, so accepting `magrittr::%>%` produces `` magrittr::`%>%` `` and the result is valid R.

`pkg::` doesn't need an earlier `library(pkg)` call. Any installed package resolves on demand from its `NAMESPACE`, the same way `pkg::name` works in R without attaching the package. Inside a `pkg::` expression, Raven offers nothing else: no keywords, local symbols, or other packages. Like other package completions, this needs `raven.packages.enabled`.

If Raven holds a complete export set for the package and `pkg::member` isn't in it, the [`namespace-member-not-found`](diagnostics.md#namespace-member-references-pkgmember) diagnostic flags it.

<details markdown="1">
<summary>Background loading, datasets, <code>exportPattern()</code>, and <code>pkg:::</code></summary>

Writing `pkg::` or `pkg:::` loads `pkg`'s metadata into the package cache in the background, as a `library(pkg)` call would. This never attaches `pkg` for bare names; it only fills in metadata.

Two refinements arrive once a package's metadata has loaded, in the background or from an earlier `library()` or `pkg::` use in the session:

- the package's exported datasets, which live in `data/` rather than the `NAMESPACE`
- the complete export set for packages that export through `exportPattern()` (about 6% of packages). Those packages offer their explicitly exported names right away.

`pkg:::` (internal, non-exported access) loads the package's metadata but isn't completed, and its members are never checked against the export set.

</details>

### box namespace and attached completions

A static [`box::use()` import](modules.md#box-modules-boxuse) contributes only the bindings it asks for. A namespace import offers known exported members after `$` or `@`; a literal `[["member"]]` access resolves the same member for hover and navigation. Selective and renamed attachments appear under their local names, and a wildcard attachment expands to the known export set.

```r
box::use(./model, ./format[render, fmt = format_value])
model$   # Offers only known exports of ./model
rend     # Can offer render
fmt      # Can offer the renamed attachment
```

Private or merely transitive module names are never offered. Complete export metadata can prove a member absent; partial or unknown metadata contributes the members Raven knows without guessing the rest. Installed-package box imports use Raven's normal installed, frozen, or downloaded package metadata, but don't attach the whole package for bare names.

## Function parameter completions

Inside a function call, Raven offers the function's parameter names:

```r
read.csv(  # Offers: file, header, sep, quote, ...
```

Typing `(` opens parameter completions automatically. Turn that off with `raven.completion.triggerOnOpenParen`.

## File path completions

Inside `source()` strings and path-taking directives, Raven completes file paths:

```r
source("utils/  # Offers: utils/helpers.R, utils/config.R, ...
```

Path completion uses the same rules as path resolution. `source()` calls and forward directives (`# raven: source`, `# raven: run`, `# raven: include`) respect `# raven: cd` and fall back to the workspace root. Backward directives (`# raven: sourced-by`, `# raven: run-by`, `# raven: included-by`) resolve relative to the file's own directory. See [Cross-file analysis](cross-file.md) for the full rules.

In files under `tests/testthat/` or `tests/testit/`, forward-path completion starts from that test directory. For files nested deeper, Raven also lists entries from the file's own directory; a name in both places appears once, from the test directory. An explicit or inherited `# raven: cd` overrides both.

## `$` member completions

After `foo$`, Raven offers the known members of `foo`:

```r
config <- list(host = "localhost", port = 8080)
config$  # Offers: host, port
```

Raven finds members in:

- assignments: `foo$bar <- …`, `foo[["bar"]] <- …`
- constructor calls: named arguments in `list()`, `data.frame()`, `tibble()`, and similar

A member name that isn't a valid bare name appears without quotes in the list but is inserted in backticks, so the code still parses:

```r
df <- list(`alpha beta` = 1)
df$  # Offers: alpha beta; accepting inserts df$`alpha beta`
```

Member completion follows nested access to any depth, and `$`, `@`, and `[["lit"]]` steps are interchangeable in the chain:

```r
config <- list(db = list(host = "localhost", port = 8080))
config$db$              # Offers: host, port
config[["db"]]$         # Same, because [["db"]] is equivalent to $db
```

Members reflect the value at the cursor, so reassigning an intermediate value replaces its earlier members:

```r
config$db <- list(url = "…")   # whole-value rewrite
config$db$                     # Offers: url (earlier host/port are replaced)
```

Raven resolves the container by its full path, so an unrelated top-level variable named `db` never adds its members to `config$db$`.

## Cross-file completions

Symbols from sourced files show their source file as the item detail:

```r
# main.R
source("utils.R")
help  # Offers: helper_function, with "from utils.R" as the item detail
```

<a id="r-markdown--quarto"></a>

## R Markdown and Quarto

In `.Rmd` and `.qmd` documents, completion works inside R chunks. Local definitions, cross-file symbols, package exports, function parameters, and `$` members resolve across chunks as if the document were one R script. On prose, YAML front matter, or non-R chunks, completion offers nothing rather than treating the line as R.

## JAGS and Stan

In `.stan`, `.jags`, `.bugs`, and `.bug` files, Raven offers completions for each language. JAGS extensions are matched case-insensitively and mean strict JAGS, not general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE compatibility.

| Language | What's offered |
|---|---|
| JAGS | Syntax keywords (`var`, `data`, `model`, `for`, `in`), truncation and censoring forms (`T`, `I`) where they apply, the distributions and functions JAGS loads automatically (including aliases), and symbols from the current file |
| Stan | Types (`int`, `real`, `vector`, …), block keywords (`data`, `parameters`, `model`, …), control flow (`if`, `for`, `while`, …), bare distribution names for sampling statements (`normal`, `poisson`, `multi_normal`, …), compiler-known functions including normalized and unnormalized variants (`normal_lpdf`, `normal_lupdf`, `poisson_lpmf`, `poisson_lupmf`, …), and symbols from the current file |

Neither language needs JAGS or Stan installed: the built-in names come from catalogs bundled with Raven. Stan completions are the same throughout a file rather than depending on context. R-specific reserved words are left out of JAGS completions.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `raven.completion.triggerOnOpenParen` | `true` | Open parameter completions when you type `(` after a function name |
| `raven.packages.enabled` | `true` | Package awareness, needed for package and `pkg::` completions |
| `raven.crossFile.hoistGlobalsInFunctions` | `true` | Offer global definitions anywhere inside function bodies |

See [Settings reference](settings-reference.md) for every setting and its `raven.toml` key.

## Details

### Scope rules summary

1. Local definitions: available after their definition line.
2. Cross-file symbols: available after the `source()` call or `# raven: source` directive.
3. Package exports: available after the `library()` call.
4. Inside function bodies: global definitions are hoisted, so all of them are visible regardless of position.
5. `rm()` and `remove()` calls: removed symbols are excluded from completions.

<details markdown="1">
<summary>Where the JAGS and Stan built-in catalogs come from</summary>

JAGS completion, [hover](hover.md#jags-hover), and signature help share one catalog pinned to JAGS 4.3.2. It covers the `basemod` and `bugs` modules that JAGS loads automatically, including the compiler-special `length()` and `dim()`, the `pow()` alias, distribution aliases, and the `d`, `p`, `q`, and `logdensity` functions those modules expose. Optional modules aren't included. A name that is both a function and a distribution appears once. A symbol from the current file takes precedence over a catalog entry with the same name. The catalog is static: it needs no local JAGS installation, subprocess, network request, or R analysis.

Stan's built-in function and distribution catalogs are generated from the compiler metadata in Raven's pinned `stanc3` npm dependency (package 2.39.1, bundled compiler 2.39.0). Unnormalized `_lupdf` and `_lupmf` aliases are included where the compiler has the matching normalized density or mass function. This avoids invalid combinations such as `poisson_lpdf` and keeps completions and [Stan hover](hover.md#stan-hover) on the same versioned source. Symbols from the current file are found by scanning it for variable declarations and assignments.

</details>

## See also

- [Hover](hover.md)
- [Cross-file analysis](cross-file.md)
- [Package database](package-database.md)
- [box and import modules](modules.md)
