# Cross-File & Package Awareness

Raven builds a dependency graph of your R project and uses it to provide accurate completions, diagnostics, and navigation across file boundaries. This page explains how the system works.

## How It Works

Most R projects consist of multiple files connected by `source()` calls. Raven detects these relationships automatically:

```r
# main.R
library(dplyr)
source("utils.R")
result <- helper_function(42)  # Raven knows this comes from utils.R
```

```r
# utils.R
helper_function <- function(x) { x * 2 }
```

When you open any file, Raven:
1. Scans the workspace for `source()` calls and builds a dependency graph
2. Resolves which symbols are available at each position in each file
3. Provides completions, diagnostics, hover, and go-to-definition using the full graph

This happens automatically — no configuration needed for standard `source()` patterns.

## Automatic source() Detection

Raven detects `source()` and `sys.source()` calls:
- Single and double quotes: `source("path.R")` or `source('path.R')`
- Named arguments: `source(file = "path.R")`
- `local = TRUE` and `chdir = TRUE` parameters
- Dynamic paths (variables, expressions) are skipped gracefully

Raven also provides **file path intellisense** inside `source()` strings and path-taking directives: completion for `.R` files and directories, and cmd-click navigation to the target file.

For dynamic or conditional paths that Raven can't detect, use [directives](directives.md) to declare relationships explicitly.

## Package Awareness

Raven recognizes `library()`, `require()`, and `loadNamespace()` calls and makes package exports available for completions, hover, and diagnostics.

### How It Works

When you write `library(dplyr)`, Raven:
1. Detects the call and extracts the package name
2. Queries R (via subprocess) for the package's exported symbols
3. Makes those symbols available with `{dplyr}` attribution in completions
4. Suppresses "undefined variable" warnings for package exports

### Base Packages

Base R packages are always available without explicit `library()` calls: **base**, **methods**, **utils**, **grDevices**, **graphics**, **stats**, **datasets**. At startup, Raven queries R for the default search path. If R is unavailable, it falls back to a hardcoded list.

### Position-Aware Loading

Package exports are only available after the `library()` call:

```r
mutate(df, x = 1)  # Warning: undefined variable 'mutate'
library(dplyr)
mutate(df, y = 2)  # OK: dplyr is now loaded
```

### Function-Scoped Loading

When `library()` is called inside a function, exports are only available within that function's scope:

```r
my_analysis <- function(data) {
  library(dplyr)
  mutate(data, x = 1)  # OK: dplyr available inside function
}
mutate(df, y = 2)  # Warning: dplyr not available at global scope
```

### Meta-Package Support

Raven recognizes meta-packages that attach multiple packages:

- **tidyverse** attaches: dplyr, readr, forcats, stringr, ggplot2, tibble, lubridate, tidyr, purrr
- **tidymodels** attaches: broom, dials, dplyr, ggplot2, infer, modeldata, parsnip, purrr, recipes, rsample, tibble, tidyr, tune, workflows, workflowsets, yardstick

### Cross-File Package Propagation

Packages loaded in parent files are available in sourced children:

```r
# main.R
library(dplyr)
source("analysis.R")  # dplyr available in analysis.R
library(ggplot2)      # NOT available in analysis.R (loaded after source)
```

Packages loaded in child files do NOT propagate back to parents (forward-only).

### Supported Call Patterns

| Pattern | Supported |
|---|---|
| `library(pkgname)` | Yes |
| `library("pkgname")` | Yes |
| `require(pkgname)` | Yes |
| `loadNamespace("pkgname")` | Yes |
| `library(pkg, character.only = TRUE)` | No (dynamic) |
| `sapply(c("a","b"), library, character.only = TRUE)` | Yes (apply family) |
| `sapply(libs, library, character.only = TRUE)` where `libs <- c("a","b")` | Yes (same-file variable) |
| `purrr::map(c("a","b"), library, character.only = TRUE)` | Yes (purrr family) |
| `sapply(paste0(...), library, character.only = TRUE)` | No (dynamic vector) |

### Apply-Family Loads

Raven also recognizes package loads expressed through apply-family calls when
all the package names are statically determinable:

```r
libs <- c("dplyr", "tidyr")
sapply(libs, require, character.only = TRUE)
```

This works for `sapply`, `lapply`, `vapply`, `mapply`, and the purrr forms
(`map`, `walk`, `map_chr`, etc., bare or `purrr::`-qualified). The package
vector must be either an inline `c("a","b",...)` of string literals, or a
same-file variable assigned exactly once via `<-`, `=`, or `assign()` to such
a literal vector. `character.only = TRUE` must be present (without it, R
itself would not load the strings as packages). Dynamic constructions such as
`paste0(...)`, `tolower(x)`, `c(libs1, libs2)`, function-parameter origins,
or values defined in another file are silently ignored.

### Keeping Packages in Sync

Raven watches `.libPaths()` directories and invalidates caches when packages are installed, upgraded, or removed. If the watcher misses a change (e.g., after `renv::activate()`), run **Raven: Refresh package cache** from the command palette.

See [Configuration](configuration.md) for watcher settings (`packages.watchLibraryPaths`, `packages.watchDebounceMs`).

## Position-Aware Scope

Symbols from sourced files are only available **after** the `source()` call:

```r
x <- 1
source("a.R")  # Symbols from a.R available after this line
y <- foo()     # foo() from a.R is now in scope
```

This applies to both `source()` calls and forward directives. The scope model ensures that completions and diagnostics reflect what would actually be available at runtime.

## Symbol Recognition

Raven recognizes these R constructs as definitions:

- `name <- expr` / `name <<- expr` / `expr -> name` / `expr ->> name`
- `name = expr` (in assignment context)
- `assign("name", expr)` (string-literal only)

For dynamically-created symbols (`eval()`, `load()`, dynamic `assign()`), use [declaration directives](directives.md#declaration-directives).

### Symbol Removal (rm/remove)

Raven tracks `rm()` and `remove()` calls to maintain accurate scope:

```r
x <- 1
rm(x)
x  # Warning: undefined variable
```

Supported: `rm(x)`, `rm(x, y)`, `rm(list = c("x", "y"))`. Dynamic patterns like `rm(list = ls())` are skipped.

## How This Feeds Into Features

The dependency graph and scope model power several features:

- **[Diagnostics](diagnostics.md)** — undefined variable warnings respect cross-file scope and loaded packages
- **[Completions](completion.md)** — symbols from sourced files and packages appear with source attribution
- **[Find References](find-references.md)** — locates usages across the dependency graph
- **Go-to-definition** — navigates to definitions in other files
- **Hover** — shows where a symbol is defined and which package it comes from

## Advanced

### Backward Dependency Modes

The `raven.crossFile.backwardDependencies` setting controls how Raven discovers which files source the current file.

**`"auto"` (default):** Raven scans the workspace for `source()` calls and infers backward relationships automatically. No `@lsp-sourced-by` directives needed. Diagnostics are deferred until the workspace scan completes to avoid false positives.

**`"explicit"`:** Only relationships declared via `@lsp-sourced-by` directives are used. Use this if auto-inference produces unwanted results (e.g., a file sourced by multiple parents with conflicting scopes).

**Per-file opt-out:** Adding an explicit `@lsp-sourced-by` directive to a file disables auto-inference for that file.

See [Configuration](configuration.md) for the setting.

### Global Symbol Hoisting

R has late-binding semantics — a function can reference another function that hasn't been defined yet at the time of the function's *definition*, as long as it exists by the time the function is *called*:

```r
main <- function() {
  helper()  # helper doesn't exist yet, but will when main() is called
}
helper <- function() { 42 }
main()  # works fine
```

Raven supports this by hoisting global definitions inside function bodies. When the cursor is inside a function body, all global definitions are visible regardless of position. Function-local variables remain strictly positional.

This is enabled by default. Disable with `raven.crossFile.hoistGlobalsInFunctions: false` (see [Configuration](configuration.md)).

### $ and @ Member Resolution

When you cmd-click on `foo$bar`, Raven resolves `bar` as a member of `foo` — not as a free variable. It looks for:
- Member assignments: `foo$bar <- …`, `foo[["bar"]] <- …`
- Constructor-literal members: named arguments in `list()`, `data.frame()`, `tibble()`, etc.

Scope-aware completions after `$` use the same rules: typing `foo$` offers known members of `foo`.
