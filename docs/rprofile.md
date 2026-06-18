# `.Rprofile` Startup Prelude

Raven statically analyzes the workspace-root `.Rprofile` and treats it as a
startup prelude. When an R session or `Rscript` starts from the workspace root,
R reads that file before user code. Raven mirrors the parts it can infer
statically: helpers defined there, packages attached there, and setup files
sourced there become available to ordinary scripts where that startup context
applies.

## What Raven Reads

Raven reads only the `.Rprofile` file at the workspace root. It does not read
`~/.Rprofile`, `Rprofile.site`, or `.Renviron`, because those files are
machine-local or process-global rather than project-local.

The same model is used in the editor and by `raven check`.

## What Contributes To Scope

The startup prelude contributes:

- names assigned at top level, including `x <- ...`, `x = ...`, `x <<- ...`,
  and `assign("x", ...)` with a literal name;
- names assigned inside top-level conditionals, such as
  `if (interactive()) helper <- function() {}`;
- packages attached by top-level `library(pkg)` or `require(pkg)`, making their
  exports available by bare name;
- top-level definitions reachable through literal `source("path")` calls,
  followed transitively through those files' own literal `source()` calls.

Raven ignores dynamic `source()` paths, `source()` calls inside function bodies,
and calls that do not put symbols into the global script scope, such as
`source(..., local = TRUE)` and `sys.source(...)` without
`envir = globalenv()` or `.GlobalEnv`. It also recognizes `renv`'s
`source("renv/activate.R")` line and does not follow it, since that file
activates the project library rather than defining user globals.

## Where It Applies

The prelude applies to analyzed `.R`, `.Rmd`, and `.qmd` files under the
workspace root where Raven models the normal project startup context. Common
examples are `scripts/`, `analysis/`, `tools/`, `debug/`, plain `inst/`, and
an `R/` directory in a non-package workspace.

In an R package workspace, Raven withholds the `.Rprofile` prelude from files
whose canonical run context is a clean package check or build session:

- namespace files under `R/`;
- package tests, including `tests/testthat/`, plain top-level `tests/*.R`,
  `inst/tinytest/`, and `inst/unitTests/`;
- built documentation/example directories: `vignettes/`, `man/`, and `demo/`.

`data-raw/` is different: it is package-development code, but it is normally run
interactively from the project root rather than by `R CMD check`, so Raven still
applies the `.Rprofile` prelude there.

## Safety Model

The `.Rprofile` model is suppressive only. It can silence a false
`undefined-variable` diagnostic or enrich completion and hover, but it never
introduces a diagnostic.

Prelude symbols are additive and do not overwrite more precise facts. Local
definitions, definitions from sourced files, directives, and package-mode
contributions still win over a name harvested from `.Rprofile`.

## Live Updates

Editing `.Rprofile` in the editor refreshes the prelude as you type. Open files
that consume the prelude re-resolve immediately, without waiting for a save.

Closing `.Rprofile` with unsaved edits reverts the prelude to the on-disk
content, because those edits have been discarded.

Editing a helper file that `.Rprofile` sources refreshes the prelude when that
helper changes on disk, either from a save or an external edit. Unsaved edits in
an open helper reach the prelude on the next save.

## Configuration

The `.Rprofile` startup prelude is enabled by default:

```toml
[packages]
rprofilePrelude = true
```

Set `raven.packages.rprofilePrelude` to `false` to disable it.

```toml
[packages]
rprofilePrelude = false
```
