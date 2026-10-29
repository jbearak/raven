# .Rprofile startup files

[Docs](README.md) › Analysis

Raven reads your project's `.Rprofile` the way R does at startup, so helpers it defines, packages it attaches, and files it sources count as available in your scripts. <a id="rprofile-startup-prelude"></a>

```r
# .Rprofile
library(dplyr)
source("R/helpers.R")   # defines clean_names()
```

```r
# scripts/analysis.R
df <- clean_names(read.csv("data.csv"))   # not flagged: defined via .Rprofile
df <- mutate(df, total = a + b)           # not flagged: dplyr attached in .Rprofile
```

When an R session or `Rscript` starts from the workspace root, R reads `.Rprofile` before any of your code. Raven treats that file as a startup prelude and mirrors the parts it can infer statically, in the files where that startup context applies.

## What Raven reads

Raven reads only the `.Rprofile` at the workspace root. It doesn't read `~/.Rprofile`, `Rprofile.site`, or `.Renviron`, because those belong to one machine or process rather than the project.

The editor and `raven check` use the same model. `.Rprofile` is recognized as an R file, so it gets R syntax highlighting and its own diagnostics like any other script.

## What contributes to scope

The startup prelude contributes:

- Names assigned at top level, including `x <- ...`, `x = ...`, `x <<- ...`, and `assign("x", ...)` with a literal name.
- Names assigned inside top-level conditionals, such as `if (interactive()) helper <- function() {}`.
- Packages attached by top-level `library(pkg)` or `require(pkg)`, whose exports become available by bare name.
- Top-level definitions reachable through `source()` and `sys.source()` calls whose paths are literal or can be [folded to literal paths](cross-file.md#how-raven-reads-source-calls), followed through those files' own such calls.

Top-level `source()` and `sys.source()` calls use the same `local` and `envir` rules as [automatic `source()` detection](cross-file.md#automatic-source-detection). Only calls whose symbols land in the global scope contribute. Calls inside function bodies are ignored, because Raven doesn't run or model function calls while reading `.Rprofile`.

Raven recognizes `renv`'s `source("renv/activate.R")` line and doesn't follow it, since that file activates the project library rather than defining your globals.

## `devtools::load_all()` in `.Rprofile`

A `devtools::load_all()` or `pkgload::load_all()` call in the workspace-root `.Rprofile` attaches the package under development. Raven then makes the package's internal symbols available by bare name in ordinary scripts, as an explicit `load_all()` call in the script would: exported and internal `R/` definitions, `R/sysdata.rda` objects, names bound in `.onLoad`/`.onAttach`, and `NAMESPACE` imports.

```r
# .Rprofile
devtools::load_all()   # package internals available in scripts/ and analysis/
```

This helps package authors who want every internal helper in scope during interactive work without repeating `load_all()` in each script.

The package-mode exclusions in [Where it applies](#where-it-applies) hold here too: files under `R/`, `tests/`, and built-documentation directories (`vignettes/`, `man/`, `demo/`) don't receive internals through `.Rprofile`. Package mode already gives those files the package internals, so Raven doesn't add them a second way.

## Where it applies

The prelude applies to analyzed `.R`, `.Rmd`, and `.qmd` files under the workspace root wherever Raven models the normal project startup context. Common examples are `scripts/`, `analysis/`, `tools/`, `debug/`, plain `inst/`, and an `R/` directory in a workspace that isn't a package.

In an R package workspace, Raven withholds the prelude from files that normally run in a clean package check or build session:

- namespace files under `R/`;
- package tests, including `tests/testthat/`, plain top-level `tests/*.R`, `inst/tinytest/`, and `inst/unitTests/`;
- built documentation and example directories: `vignettes/`, `man/`, and `demo/`.

`data-raw/` is different. It is package-development code, but you normally run it interactively from the project root rather than through `R CMD check`, so Raven still applies the prelude there.

## Safety model

The `.Rprofile` model only ever removes warnings. It can silence a false `undefined-variable` diagnostic or add to completion and hover, but it never introduces a diagnostic.

Prelude symbols are added on top of what Raven already knows and never overwrite more precise facts. Local definitions, definitions from sourced files, directives, and package-mode symbols all win over a name taken from `.Rprofile`.

## Live updates

Editing `.Rprofile` refreshes the prelude as you type: open files that use it re-resolve right away, without waiting for a save. This also works when the editor opened `.Rprofile` through a case or symlink alias. Raven keeps publishing diagnostics to the path you opened, but uses the workspace `.Rprofile` as the prelude.

Closing `.Rprofile` with unsaved edits reverts the prelude to the file on disk, because those edits were discarded.

A helper file that `.Rprofile` sources refreshes the prelude when it changes on disk, through a save or an outside edit. Raven keeps track of the `source()` call even while the helper is missing or unreadable, so creating a missing helper, or deleting and recreating one, also refreshes the prelude. Unsaved edits in an open helper reach the prelude on the next save.

## Static box search paths

Raven also reads simple top-level `options(box.path = ...)` calls in the workspace-root `.Rprofile` as the search path for [box modules](modules.md). This is separate from the scope prelude. It applies even when `packages.enabled` or `packages.rprofilePrelude` is `false`, including to imports in package files and tests. Excluded or gitignored profiles don't contribute, and no R code runs.

Only the root `.Rprofile` supplies these paths; files it sources don't. A conditional or dynamic write makes the value unknown rather than keeping an earlier literal. Live edits to the root `.Rprofile`, and closing it without saving, update resolution. See [Custom search paths](modules.md#custom-search-paths) for the accepted syntax, precedence, relative-path bases, and explicit overrides.

<a id="configuration"></a>
## Settings

The startup prelude is on by default. Set `raven.packages.rprofilePrelude` to `false` to turn it off:

```toml
[packages]
rprofilePrelude = false
```

See the [settings reference](settings-reference.md) for the VS Code and `raven.toml` forms.

## See also

- [Cross-file analysis](cross-file.md): how `source()` calls and packages flow between files
- [Package development](r-package-dev.md): what package mode makes visible without `.Rprofile`
- [box and import modules](modules.md): search paths for `box::use()`
