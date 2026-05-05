# Completion

Raven offers context-aware completions for R symbols, package exports, function parameters, and file paths. Completions respect the cross-file dependency graph and position-aware scope.

## What's Offered

| Symbol source | Behavior |
|---|---|
| **Local definitions** | Symbols defined in the current file, above the cursor |
| **Cross-file symbols** | Symbols from sourced files, available after the `source()` call site |
| **Package exports** | Functions and variables from loaded packages, with `{pkg}` attribution |
| **Function parameters** | Parameter names when inside a function call |
| **File paths** | `.R` files and directories inside `source()` strings and path directives |
| **$ members** | Known members after `$` (from assignments and constructors) |

## Position-Aware Filtering

Completions respect execution order. A symbol is only offered if it would be defined at the cursor's position at runtime:

```r
# Line 1: only base + package symbols available
library(dplyr)
# Line 3: dplyr exports now available
source("utils.R")
# Line 5: symbols from utils.R now available
```

Symbols defined below the cursor in the same file are not offered at the global level. Inside function bodies, global definitions are hoisted (see [Global Symbol Hoisting](cross-file.md#global-symbol-hoisting)).

## Package Completions

When a package is loaded via `library()`, its exports appear in completions with `{package}` detail:

```r
library(dplyr)
mut  # Offers: mutate {dplyr}, mutate_all {dplyr}, ...
```

Package completions are position-aware — they only appear after the `library()` call. Packages loaded in parent files (before the `source()` call to the current file) are also available.

## Function Parameter Completions

When the cursor is inside a function call, Raven offers parameter names:

```r
read.csv(  # Offers: file, header, sep, quote, ...
```

Trigger character `(` activates parameter completions automatically (configurable via `raven.completion.triggerOnOpenParen`).

## File Path Completions

Inside `source()` strings and path-taking directives, Raven completes file paths:

```r
source("utils/  # Offers: utils/helpers.R, utils/config.R, ...
```

Path completion respects `@lsp-cd` and workspace-root fallback rules.

## $ Member Completions

After typing `foo$`, Raven offers known members of `foo`:

```r
config <- list(host = "localhost", port = 8080)
config$  # Offers: host, port
```

Members are discovered from:
- Assignments: `foo$bar <- …`, `foo[["bar"]] <- …`
- Constructor literals: named arguments in `list()`, `data.frame()`, `tibble()`, etc.

## Cross-File Completions

Symbols from sourced files appear with their source file indicated:

```r
# main.R
source("utils.R")
help  # Offers: helper_function (from utils.R)
```

## Scope Rules Summary

1. Local definitions: available after their definition line
2. Cross-file symbols: available after the `source()` call site
3. Package exports: available after the `library()` call
4. Inside function bodies: global definitions are hoisted (all visible regardless of position)
5. `rm()` calls: removed symbols are excluded from completions
