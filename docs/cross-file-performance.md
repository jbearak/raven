# Cross-File Performance

Raven follows `source()` chains so diagnostics, completions, hover, go-to
definition, and find-references can reflect what is actually in scope at a
given line. Most projects do not need any performance-specific directives: a
few sourced helper files are cheap to resolve, and Raven reuses a lot of
intermediate work automatically.

The expensive shape is fan-out multiplied by depth or breadth. For example:

```r
# analysis_01.R
source("setup.R")

# analysis_02.R
source("setup.R")

# ...dozens more scripts...
```

```r
# setup.R
source("R/imports.R")
source("R/helpers.R")
source("R/models.R")
source("R/reporting.R")
```

If `setup.R` is sourced by dozens of scripts and also sources dozens of other
files, possibly through a deeply nested chain, Raven normally has to ask:
"what was visible in each caller at the moment it sourced `setup.R`?" That
caller-dependent question is important for ordinary script fragments, but it
can be unnecessarily expensive for a true helper or setup hub.

Mark that hub as self-contained:

```r
# setup.R
# raven: self-contained

source("R/imports.R")
source("R/helpers.R")
source("R/models.R")
source("R/reporting.R")
```

`# raven: self-contained` tells Raven that this file does not depend on
caller-provided symbols, packages, working directory, or data aliases. Raven can
then resolve the file from its own contents and its own forward `source()`
closure, independent of who sourced it. In deeply nested, high-fan-out source
graphs, marking true hubs as self-contained can improve some Raven operations by
an order of magnitude.

## What Changes

Self-contained isolation is asymmetric:

- Caller facts do not flow into the self-contained file. Raven does not use
  each caller's visible variables, loaded packages, working directory, or data
  aliases to analyze that file.
- The self-contained file still flows out to callers. Its own definitions and
  its own `library()` / `require()` loads still become visible after the
  `source()` call, just like any other sourced file.
- The file's own forward `source()` calls still participate normally. A
  self-contained setup file can source helper files, and Raven will include
  those helpers when resolving the setup file.

The directive changes static analysis only. It does not change how R executes
the file.

## Good Fits

Use `# raven: self-contained` when a sourced file behaves like a project-local
module:

- A shared helper file sourced by many scripts.
- A setup/bootstrap file that loads packages and defines helpers for callers.
- A hub file with a deep or broad forward `source()` closure.
- A project-local library file whose inputs come from its own code, its own
  sourced files, package calls, or explicit function arguments.

This is especially useful when a file sits at the center of the source graph:
many callers source it, and it in turn sources many files or a deeply nested
chain. Without the directive, Raven may re-resolve the same closure in many
caller-dependent contexts. With the directive, Raven can reuse the isolated
scope for every caller.

## Bad Fits

Do not mark a file self-contained if it intentionally consumes caller state:

```r
# run-model.R
fit <- lm(y ~ x, data = analysis_data)
```

If each caller creates `analysis_data` before sourcing `run-model.R`, that file
is not self-contained. Raven should analyze it with caller scope, because that
is how the project is written.

Prefer an explicit function boundary when possible:

```r
run_model <- function(analysis_data) {
  lm(y ~ x, data = analysis_data)
}
```

Also avoid `# raven: self-contained` on ordered pipeline fragments such as
`01-load.R`, `02-clean.R`, and `03-model.R` when each script relies on objects
created by earlier scripts in the same session. Those files are intentionally
stateful script steps, not self-contained helpers.

## R Workflow Guidance

R projects often pass through a middle stage: repeated analysis code becomes
functions, functions move into a shared helper file, and that helper file is
sourced by many scripts. Raven supports that pattern, and
`# raven: self-contained` is the right directive when the helper file no longer
depends on whichever script sourced it.

For reusable function code, the long-term R best practice is often to make a
small package and place functions under `R/`. That gives you package metadata,
dependency declarations, tests, documentation, and a clearer boundary than a
large `functions.R` sourced everywhere. See [R Packages: The package
within](https://r-pkgs.org/package-within.html) and [R Packages: R
code](https://r-pkgs.org/code.html).

For project-local analysis repos, a sourced helper or setup file can still be a
reasonable intermediate shape. A project `.Rprofile` can bootstrap project
setup, but keep it small and explicit: base R sources startup profiles into the
workspace, so top-level assignments can create hidden session state that later
scripts depend on. See [R Startup](https://stat.ethz.ch/R-manual/R-devel/library/base/html/Startup.html).

## Syntax

`self-contained` is header-only and takes no arguments:

```r
# raven: self-contained
```

These alternative spellings are supported:

```r
# raven: standalone
# @lsp-standalone
# @lsp-self-contained
```

Both spellings mean the same thing. New code should prefer
`# raven: self-contained`.
