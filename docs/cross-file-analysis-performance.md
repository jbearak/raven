# Speeding Up Cross-File Analysis

Raven follows `source()` chains so diagnostics, completions, hover, go-to
definition, and find-references can reflect what is actually in scope at a
given line. Most projects do not need any performance-specific directives: a
few sourced helper files are cheap to resolve, and Raven reuses a lot of
intermediate work automatically.

The expensive shape is fan-out — many files sourcing one hub — multiplied by the
depth or breadth of that hub's own `source()` closure. For example:

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
caller-provided variables, loaded packages, or working directory. Raven can then
resolve the file from its own contents and its own forward `source()` closure,
independent of who sourced it.

This is both faster and more precise:

- **Faster**, because Raven resolves the hub once and reuses that result across
  every caller, instead of re-resolving it per caller. In deeply nested,
  high-fan-out source graphs that can cut some analysis work by roughly an
  order of magnitude.
- **More precise**, because the default backward contribution is a *union* over
  all callers' bindings. A symbol that one caller happens to define can mask a
  genuine `undefined` that another caller would expose; isolating the file
  removes that cross-caller masking.

## What Changes

Self-contained isolation is asymmetric:

- Caller facts do not flow into the self-contained file. Raven does not use
  each caller's visible variables, loaded packages, or working directory to
  analyze that file.
- The self-contained file still flows out to callers. Its own definitions and
  its own `library()` / `require()` loads still become visible after the
  `source()` call, just like any other sourced file.
- The file's own forward `source()` calls still participate normally. A
  self-contained setup file can source helper files, and Raven will include
  those helpers when resolving the setup file.
- `# raven: nse` / `# raven: func` propagation is unaffected. Those directives
  propagate along `source()` edges at the graph level, not the scope level, so
  isolating a file's scope never changes which NSE contracts apply across it.

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

## When a File Has External Inputs

The directive is safe-direction, so a wrong guess fails loudly rather than
silently. If you mark a file self-contained but it actually does rely on a
caller-provided binding, the only consequence is a false-positive `undefined`
**inside the self-contained file itself** — never a missed bug in a caller.

If a mostly self-contained file intentionally requires one or two external
values, make that contract executable. Raven treats `exists("name")` as an
automatic variable declaration from the following line onward, so a guard both
fails clearly at runtime and tells Raven that the name is expected:

```r
# helpers.R
# raven: self-contained

if (!exists(".config")) {
  stop("helpers.R requires `.config` to be defined before it is sourced")
}

use_config(.config)
```

For larger data flow, an explicit function argument or moving setup into the
self-contained chain is usually clearer. Avoid bare `# raven: var` directives
for caller-provided values unless there is no runtime check to write; a
directive alone can hide a real missing prerequisite.

## R Workflow Guidance

R projects often pass through a middle stage: repeated analysis code becomes
functions, functions move into a shared helper file, and that helper file is
sourced by many scripts. Raven supports that pattern, and
`# raven: self-contained` is the right directive when the helper file no longer
depends on whichever script sourced it.

For reusable function code, the long-term R best practice is often to make a
small package and place functions under `R/`. In Raven, that layout becomes
special only when [**package mode** is active](r-package-dev.md#configuration),
for example when the workspace root has a `DESCRIPTION` file with a valid
`Package:` field, or `raven.packages.packageMode` is set to `enabled`. In
package mode, top-level symbols in `R/*.R` files are mutually visible without
explicit `source()` calls, matching package-development workflows.

In an ordinary script project, `R/` is just a directory name. Moving helpers
there can still be a nice convention, but Raven will not automatically load
those files merely because they live under `R/`; the project still needs
ordinary `source()` calls, forward directives such as `# raven: source R/helpers.R`,
or package-mode metadata. For project-local analysis repos, a
sourced helper or setup file remains a reasonable intermediate shape. See
[R Packages: The package within](https://r-pkgs.org/package-within.html),
[R Packages: R code](https://r-pkgs.org/code.html), and
[R Package Development](r-package-dev.md).

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

All of these spellings are equivalent. New code should prefer
`# raven: self-contained`.

## See Also

- [Directives → Self-Contained Sourced Files](directives.md#self-contained-sourced-files)
  — full semantics and interactions with `# raven: cd`, package mode, and
  per-call `local = TRUE` / `sys.source()`.
- [Cross-File Analysis](cross-file.md) — the cross-file scope-resolution model
  these directives build on.
