# Package development

[Docs](README.md) › Analysis

When your workspace is an R package, Raven analyzes it the way `devtools::load_all()` loads it: every `R/` file sees the others, tests see the package's internals, and `NAMESPACE` and roxygen imports count as defined. <a id="r-package-development"></a>

```r
# R/helpers.R
validate_input <- function(x) { ... }

# R/main.R
run_analysis <- function(data) {
  validate_input(data)  # No diagnostic: Raven knows this is in R/helpers.R
}
```

| A file in | Sees without `source()` or `library()` |
|---|---|
| `R/` | Every other `R/` file, `NAMESPACE` and roxygen imports, and `Depends:` packages |
| `tests/testthat/` | `R/` symbols and imports, the `helper*.R` and `setup*.R` files, and testthat when `DESCRIPTION` lists it |
| `tests/*.R`, `inst/tinytest/`, `inst/unitTests/` | `R/` symbols and imports |
| `vignettes/`, `demo/`, `data-raw/`, `man/` | `R/` symbols and imports |
| `scripts/`, `analysis/`, `tools/`, plain `inst/`, anything else | Only what `library()`, `load_all()`, `source()`, or `.Rprofile` brings in |

## How it works

Raven turns on **package mode** when the workspace root has a `DESCRIPTION` file with a parseable, non-empty `Package:` field. A `DESCRIPTION` without a valid `Package:` entry isn't enough. In package mode:

1. **Mutual visibility.** All `R/*.R` files see each other's top-level symbols, matching `devtools::load_all()`. A function defined in `R/utils.R` is available in `R/analysis.R` without a `source()` call.
2. **Imports.** Symbols imported through `NAMESPACE` or roxygen (`@import`, `@importFrom`) aren't flagged. Packages in `DESCRIPTION` `Depends:` count as attached, like a `NAMESPACE` `import(pkg)` of each, because R puts their exports on the search path when your package loads. `Imports:` keeps R's stricter rule (loaded, not attached), so an `Imports:`-only package still needs `pkg::fn` or an explicit `@importFrom`/`importFrom(...)`.
3. **Roxygen and `NAMESPACE` together.** Raven combines the imports and exports in the generated `NAMESPACE` file with the roxygen tags in `R/*.R`, so imports resolve whether you edit `NAMESPACE` directly, regenerate it with `devtools::document()`, or are partway between the two.
4. **Your own NSE verbs.** Your package's exported non-standard-evaluation verbs keep their argument policy in the package's own files: any `.R`, `.Rmd`, `.Rmarkdown`, or `.qmd` file in `R/`, `tests/`, vignettes, `man/` examples, `inst/`, `data-raw/`, and so on. If you develop a package named `dplyr`, `filter(df, x > 1)` in its tests doesn't flag the column `x`, even though nothing calls `library(dplyr)`. See [Non-standard evaluation](non-standard-evaluation.md).

Automatic discovery of package definitions, testthat helpers, `.Rprofile`, and data files respects `.gitignore`. Ignored files stay available while open, and an explicit `source()` of an ignored file still works without making it part of the package. Package manifests and installed-library metadata are never discovery candidates. See [Project exclusions](configuration.md#project-exclusions) for inheritance rules and the `workspace.respectGitignore` opt-out.

<a id="whats-supported"></a>
## What each directory sees

### Mutual visibility

All top-level symbols (functions, variables, constants) defined in files under `R/` are visible to every other file under `R/`, so calls between your package's files aren't flagged.

"Under `R/`" means what R loads: the files directly in `R/`, plus the OS-specific subdirectories `R/unix/` and `R/windows/`, and only files whose names start with an ASCII letter or digit (R's `tools::list_files_with_type(.., "code")` filter). So `R/_helper.R` and `R/.hidden.R` aren't package code. R never looks deeper into `R/`: `R CMD INSTALL`, `devtools::load_all()`, and pkgload all use the non-recursive `tools::list_files_with_type()` listing. So a script in another subdirectory, such as `R/scripts/run.R`, isn't package source. Raven treats it as an ordinary script: it adds nothing to the namespace, doesn't see package internals unqualified, and gets the usual `source()` and directive handling.

Files outside `R/` (such as `tests/`, `inst/`, `vignettes/`) aren't part of mutual visibility, but several get one-way read access to `R/` symbols, as described below.

### Internal data (`R/sysdata.rda`)

Objects in `R/sysdata.rda` are internal to the namespace and available to your package's code at runtime, so Raven treats them as in scope for files under `R/` and everywhere else package symbols are visible, such as testthat tests.

Raven finds their names by scanning `data-raw/` for the `usethis::use_data(..., internal = TRUE)` or `save(..., file = "R/sysdata.rda")` call that created them. If there's no such script because the `.rda` is committed directly, Raven loads the file through R to list its objects. The editor and `raven check` both do this. Sysdata objects aren't exported, so a script outside the package that calls `library(yourpkg)` and uses one still gets a diagnostic, as in R.

### Tests directory awareness

Files under `tests/testthat/` get one-way read access to package-internal symbols (`R/*.R`) and to `NAMESPACE` and roxygen imports, so tests can call internal functions without diagnostics. Symbols defined in test files aren't visible from `R/*.R`.

```r
# R/helpers.R
process_data <- function(df) { ... }

# tests/testthat/test-helpers.R
test_that("process_data works", {
  result <- process_data(mtcars)  # No diagnostic: helper visible from tests
  expect_equal(nrow(result), nrow(mtcars))
})
```

Plain top-level `tests/*.R` scripts, the older style that `R CMD check` runs directly (such as `tests/Simple.R`), get the same one-way access, because the package is loaded when they run. Unlike testthat helpers, these scripts **don't** see each other's definitions, since `R CMD check` runs each in its own process, and their definitions never leak into `R/`.

#### Implicit `library(testthat)` under `tests/testthat/`

Raven treats testthat as attached, as if by `library(testthat)`, when all of these hold:

- the workspace is in package mode;
- `DESCRIPTION` lists testthat in `Suggests:`, `Imports:`, or `Depends:`;
- the file is under `tests/testthat/`.

This matches `testthat::test_check()`, which attaches testthat before sourcing each test file. So `test_that(...)`, `expect_equal(...)`, and the rest aren't flagged without an explicit `library(testthat)`. Outside `tests/testthat/`, the same calls are still flagged.

If `DESCRIPTION` doesn't list testthat, nothing is attached implicitly, and the calls stay flagged until you add `Suggests: testthat` (the usual fix) or an explicit `library(testthat)`.

#### Helper and setup files (`tests/testthat/helper*.R`, `setup*.R`)

Before any test runs, testthat sources the files matching `^helper.*\.[Rr]$` in `sort()` order, then the files matching `^setup.*\.[Rr]$` the same way. Raven mirrors this, so a helper's top-level definitions and `library()` calls are available in every test file:

```r
# tests/testthat/helper-fixtures.R
demo_input <- c(1, 2, 3)

# tests/testthat/test-foo.R
test_that("works on demo_input", {
  expect_equal(length(demo_input), 3)  # No diagnostic: visible from helper
})
```

```r
# tests/testthat/helper-lib.R
library(tidyr)

# tests/testthat/test-a.R
test_that("reshaping works", {
  wide <- pivot_wider(long)  # No diagnostic: tidyr attached by the helper
})
```

Helper visibility requires package mode. The [implicit testthat working directory](cross-file.md#implicit-testthattestit-working-directory) and computed-path folding depend only on the folder layout and apply to any workspace with a `tests/testthat/` directory.

<details markdown="1">
<summary>Exactly which helper and setup definitions are visible, and where</summary>

- Top-level definitions in any `tests/testthat/helper*.R` or `setup*.R` file are visible from `test-*.R` and other test files, because every helper and setup file has been sourced by the time a test runs. For example, a setup file containing `CLEAN <- SETUP <- FALSE` makes both `CLEAN` and `SETUP` visible to every test file.
- Top-level code in a helper or setup file sees definitions from the files sourced before it. Helpers come before setup files, each group in `sort()` order, so a top-level call in `helper-b.R` can use `helper-a.R`'s definitions but not `helper-c.R`'s.
- Function bodies in helper and setup files see definitions from every helper and setup file in the same directory, since tests call those functions after all of them have run and R looks names up when the function runs. So `f <- function() later_helper()` in `helper-a.R` can use `later_helper` from `helper-z.R`. This follows Raven's [global hoisting](cross-file.md#global-symbol-hoisting) setting; turning hoisting off keeps source-order visibility inside functions too.
- Only files directly in `tests/testthat/` count. Files in subdirectories, such as `tests/testthat/sub/helper-x.R`, aren't sourced by testthat and aren't treated as helpers.
- Helper and setup definitions never reach `R/`.
- A helper's own `source()` calls are followed. Top-level definitions and `library()` attachments in files the helpers source, directly or indirectly, become visible to test files the same way the helper's own definitions do. That includes computed paths such as `source(file.path(repo_root, "scripts/helpers.R"))` after `repo_root <- normalizePath(file.path("..", ".."))`. Relative paths resolve from `tests/testthat/`. The scan follows open, unsaved edits to the helper or a sourced file, and returns to the disk version when the file closes.
- Top-level `library()` and `require()` calls in helper and setup files **attach** their packages for the test files, in source order between helper files. `require(pkg, quietly = TRUE)` counts too. `loadNamespace()` and `requireNamespace()` don't attach (they only enable `pkg::fn`), a `library()` inside a function body doesn't attach until the function runs, and a call inside a quoting wrapper (`quote()`, `bquote()`, `rlang::expr()`, and so on) never runs, so none of these propagate.
- Attachments reach test files **in the same directory** only. `tests/testthat/` helpers never reach `tests/testit/` files, which don't source them, and never reach `R/`.
- Teardown files (`teardown*.R`) run after all tests finish, so their top-level bindings are never visible to tests.

</details>

### Dev-context directories (`demo/`, `data-raw/`, `vignettes/`, `man/`)

Files in these directories get the same one-way read access as test files: they see all `R/*.R` top-level symbols and `NAMESPACE` imports, so calling your own functions from a vignette, demo, data-preparation script, or man-page Rmd helper isn't flagged. Their definitions never leak into `R/`, and they don't see each other: a function defined in `data-raw/prepare.R` isn't visible from `vignettes/intro.Rmd`, or the reverse.

```r
# R/analysis.R
run_model <- function(data) { ... }

# vignettes/tutorial.Rmd (or vignettes/tutorial.R)
result <- run_model(example_data)  # No diagnostic: visible from R/

# demo/walkthrough.R
output <- run_model(sample_input)  # No diagnostic
```

Names that aren't defined in `R/` or imported are still flagged in these directories.

**`inst/` and `revdep/` aren't dev-context.** Plain `inst/` scripts (Shiny apps, R Markdown template skeletons, example scripts) and reverse-dependency checks don't run with the package loaded, so they need an explicit `library(yourpkg)` or a [directive](directives.md) like any other script, and a bare call to a package function there *is* flagged. The exception is installed test suites: R files under `inst/tinytest/` and `inst/unitTests/` are treated as **test files**, since those suites run with the package loaded.

### Scripts that call `devtools::load_all()`

A script **anywhere** in the package source tree, including places like `inst/`, `tools/`, `debug/`, or `internal/`, that calls `devtools::load_all()`, `pkgload::load_all()`, or a bare `load_all()` attaches the package under development. Raven then makes the package's own symbols visible from the call on: internal and exported `R/` definitions, `R/sysdata.rda` objects, names bound in `.onLoad`/`.onAttach`, and `NAMESPACE` imports. This matches `load_all()` at runtime, so your exploratory and maintenance scripts don't get false positives for your own functions.

```r
# internal/scratch.R
devtools::load_all()
result <- my_internal_helper(data)  # No diagnostic: load_all() attached the package
typo_helper()                       # Still flagged: not a package symbol
```

This is broader than `library(yourpkg)` on purpose: `load_all()` defaults to `export_all = TRUE`, so a helper in `R/` is available after `load_all()` even if `NAMESPACE` doesn't export it. Exports still matter for installed use, `library(yourpkg)`, and `R CMD check`.

The call is what counts, not the location: the same file *without* a `load_all()` call (and outside the dev-context directories above) sees only the usual global and `library()` scope.

#### Transitive propagation through `source()` chains

The `load_all()` symbols propagate exactly like `library()`: forward through `source()` chains, position-aware, and from any of several parents:

```r
# internal/setup.R
devtools::load_all()
source("run.R")      # run.R inherits the package internals

# internal/run.R  (no load_all() here)
result <- my_internal_helper(data)  # No diagnostic: inherited from setup.R
```

A file reached **before** the `load_all()` call, or only through parents that never call `load_all()`, doesn't inherit the internals.

#### R/ source changes trigger diagnostics refresh

When you add, delete, or edit a file under `R/`, Raven re-publishes diagnostics for the file that called `load_all()`, every file it sources, and every file that sources it. The "is this function defined in the package?" check stays current as you work, without restarting the editor.

#### Go-to-definition for `load_all()` internals

Cmd/Ctrl-click (or F12) on a symbol that `load_all()` made available goes to its definition in the package's `R/` source, whether or not that file is open. This works in the same files that get `R/`-to-`R/` navigation in package mode.

Going into external or installed packages, such as a dependency's unexported function used through `:::` after `load_all()`, isn't supported yet. See [Go to definition: package exports](go-to-definition.md#package-exports).

## Ordinary scripts in package workspaces

Directories such as `scripts/`, `analysis/`, `tools/`, `debug/`, and plain `inst/` hold ordinary scripts as far as package mode is concerned. Being inside a package workspace doesn't give them `R/` symbols, so a bare `my_internal_helper()` in `scripts/foo.R` is flagged unless the script makes the name available the way R would:

| Loading mechanism | What becomes visible |
|---|---|
| `library(yourpkg)` | Only exported symbols (`@export` / `NAMESPACE`). Needs the package installed. Internals need `yourpkg:::name`. |
| `devtools::load_all()` / `pkgload::load_all()` | Exported and internal `R/` symbols. `load_all()`'s `export_all = TRUE` default copies all package objects into scope. |
| `source("R/...")` | All top-level definitions in the sourced file. There is no export concept; `source()` has nothing to do with packages. |
| `# raven: source R/...` | A Raven-only hint equivalent to a `source()` call, including chains of `source()` calls. |
| Workspace-root `.Rprofile` | Startup definitions, attached packages, and literal `source()` chains, where the prelude applies. See [.Rprofile startup files](rprofile.md). |

### `load_all()` vs. `library()`

`devtools::load_all()` makes internal functions usable by bare name, while `library(yourpkg)` exposes only exports. Code that works after `load_all()` can still fail under `library()` or `R CMD check`.

Adding `@export` alone doesn't make a function visible to an ordinary `scripts/` file. The file still needs `library(yourpkg)` for exports, or `devtools::load_all()` / `pkgload::load_all()`, `source()`, a `# raven: source` directive, or a workspace-root `.Rprofile` that loads the helpers at startup.

## Imports from NAMESPACE, roxygen, and DESCRIPTION

### Roxygen namespace tags

Raven reads these tags from your source:

| Tag | Effect |
|-----|--------|
| `@export` | Marks the next definition as exported |
| `@import pkg` | All exports of `pkg` are available without qualification |
| `@importFrom pkg sym1 sym2` | Only `sym1` and `sym2` from `pkg` are available |

```r
#' @importFrom dplyr mutate filter
#' @export
transform_data <- function(df) {
  df |> filter(x > 0) |> mutate(y = x * 2)
  # No diagnostics for mutate or filter
}
```

### NAMESPACE + roxygen merge

Raven always reads the generated `NAMESPACE` file, when there is one, and combines its entries with the roxygen tags in `R/*.R`:

- `import(pkg)`: all exports of `pkg` are available.
- `importFrom(pkg, sym1, sym2)`: those symbols are available.
- `export(sym)`: informational, since mutual visibility already makes every symbol available inside the package.

Roxygen `@import`, `@importFrom`, and `@export` in any `R/*.R` file feed the same combined set, and duplicates are merged. So roxygen imports count before you run `devtools::document()`, and `NAMESPACE`-only imports still count if some `R/*.R` files have no roxygen tags.

`DESCRIPTION` `Depends:` packages join this set as whole-package imports, each treated exactly like `import(pkg)`, because R attaches `Depends:` packages when your package loads. Version constraints (`pkg (>= 1.0)`) and the special `R` entry are ignored. `Imports:` is deliberately *not* included: an `Imports:`-only package is loaded but not attached, so it still needs `pkg::fn` or an explicit `importFrom`/`@importFrom`, as in R.

A meta-package in `Depends:` also brings in its members' NSE policies. `Depends: tidyverse` adds dplyr, tidyr, ggplot2, and the rest to the packages whose argument policies apply, so `filter(x > 5)` in your `R/` code doesn't flag the column `x`. This is built in and doesn't need the member packages installed, so it works in CI without R. It applies to `Depends:` (and to `library()` and `require()`) because those *attach* the meta-package. A `NAMESPACE` `import(tidyverse)` or `@import tidyverse` does **not** get this: an import doesn't attach, so it doesn't bring the members' exports into scope. A bare member verb there resolves only if the member is genuinely re-exported and Raven's package database knows it.

### data.table `[` detection in package mode

When your package depends on data.table, through `DESCRIPTION` `Imports:` or `Depends:`, a `NAMESPACE` `import(data.table)` or `importFrom(data.table, ...)`, or the equivalent roxygen tags, Raven treats data.table as in play. Undefined-variable checking of `[` indices then skips indices on **unresolved** objects, such as a function parameter `dt`, so `f <- function(dt) dt[, mean(value), by = grp]` doesn't flag `value` or `grp`.

Objects you build locally with `data.frame()`, `tibble()`, or `read.csv()` still count as plain data frames, so `df[undefined_var, ]` is flagged, unless the call has a direct top-level `:=` argument, which always marks the `[` call as NSE. `[[` is always checked. A statement-level by-reference converter changes the classification from that call on: `setDT(x)` makes `x` a data.table, `setDF(x)` makes it a plain data frame, and `setattr(x, "class", ...)` sets the class explicitly. See [Non-standard evaluation](non-standard-evaluation.md) and [call arguments and bracket indices](diagnostics.md#call-arguments-and-bracket-indices) for the full rules and the `undefinedVariableInBracketIndices` opt-out.

### Shipping NSE metadata with your package

If your package exports data-masking or tidy-selecting functions, or a container whose `[` method quotes its arguments like data.table's, describe that once in `inst/raven/nse.toml` and every user of the package gets the right diagnostics without writing `# raven: nse` directives. `[[function]]` entries declare per-function argument policies, and an optional `[subset]` table declares data.table-style `[` semantics, naming the constructors and by-reference converters that produce such objects.

Inside your package's own files, the `[subset]` declaration applies without a `library()` call, like your own NSE verbs. Raven reads the file from the *installed* copy of your package, though, so install it (for example with `devtools::install()`) for the declaration to take effect while you develop. See [Declaring NSE from a package](non-standard-evaluation.md#declaring-nse-from-a-package).

### Live updates

Raven watches `DESCRIPTION` and `NAMESPACE`. After you run `devtools::document()` or edit these files, diagnostics update without restarting the editor.

## Build commands

In VS Code, when the workspace is an R package (a `DESCRIPTION` with a non-empty `Package:` field, or `raven.packages.packageMode` set to `"enabled"`) **and** Raven's R console is active, Raven adds six Command Palette entries that wrap the standard devtools, testthat, and roxygen2 workflows. Their names follow RStudio's **Build** menu. If Raven's console stepped aside in Positron, these commands are hidden too; use Positron's package workflow instead. See [Using Raven with other R tools](coexistence.md).

| Palette title | Runs in | R call |
|---|---|---|
| `Raven Build: Load All` | active R terminal | `devtools::load_all("<workspace>")` |
| `Raven Build: Document` | active R terminal | `devtools::document("<workspace>")` |
| `Raven Build: Install and Restart` | active R terminal | `devtools::install("<workspace>")` followed by `quit(save = "no")` |
| `Raven Build: Test Package` | `R: Package Tasks` terminal | `devtools::test("<workspace>")` |
| `Raven Build: Check Package` | `R: Package Tasks` terminal | `devtools::check("<workspace>")` |
| `Raven Build: Build Source Package` | `R: Package Tasks` terminal | `devtools::build("<workspace>")` |

Each command passes the first workspace folder's absolute path, so a stray `setwd()` in the R session, or a terminal started in a subdirectory, can't point the build at the wrong project. The six commands also appear as one `$(package)` submenu in the editor title bar when an R, R Markdown, or Quarto file is open in a package workspace.

### Terminal routing

`Load All`, `Document`, and `Install and Restart` change the R session, so they run in the same R terminal that Send-to-R uses, where you'd expect their effects.

`Test Package`, `Check Package`, and `Build Source Package` can take 20 to 60 seconds or more, so they run in a separate `R: Package Tasks` terminal. That keeps your interactive prompt free and separates exploration from batch checks. Raven reuses the tasks terminal across runs, so it doesn't pay R's startup cost on every `devtools::test()`. The tasks terminal runs the console you chose, so `radian` or `arf` carries over. It runs Raven's console if you haven't chosen one yet or chose vscode-R, and it never asks.

### Install and Restart semantics

`Install and Restart` runs `devtools::install()` and then `quit(save = "no")`, so R exits after the install. When the terminal closes, Raven recreates it in the same pane. The next Send-to-R or Build command runs in a fresh R session that loads the newly installed version, which is the point of the command.

If the install fails, the wrapper prints the error with `message()` before R exits, and the output stays in the closed terminal's scrollback so you can read it.

With vscode-R as your console, Raven can't restart vscode-R's R session. It sends only `devtools::install()` to vscode-R's terminal and tells you to restart R there when the install finishes.

## testthat problem matcher

When you run `devtools::test()` or `testthat::test_dir()`, testthat's default progress reporter prints failure headers like:

```text
Failure ('test-helpers.R:12:3'): process_data handles NAs
Expected 1 to equal 2.
Differences:
1/1 mismatches
[1] 1 - 2 == -1
```

Raven provides a `$testthat` problem matcher that reads those headers and lists each failing test in VS Code's Problems panel, with a link to the failing line. To use it, add a task to `.vscode/tasks.json`, or run it from **Terminal → Run Task…**:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "R: Test package",
      "type": "shell",
      "command": "Rscript",
      "args": ["-e", "devtools::test()"],
      "problemMatcher": "$testthat",
      "group": "test"
    }
  ]
}
```

The matcher recognizes the `Failure (…)` and `Error (…)` headers from the default `ProgressReporter`, the `── Failure (…) ──` form from `CompactProgressReporter`, and the all-caps `FAILURE: …` / `ERROR: …` form that testthat's `LlmReporter` prints under an AI coding agent (`CLAUDECODE`, `AGENT`, `GEMINI_CLI`, or `CURSOR_AGENT`). Paths resolve relative to `${workspaceFolder}/tests/testthat`, the working directory testthat uses while a test runs. The Problems entry shows the test name when the reporter prints one; the full expected and actual output stays in the terminal.

## Generating a package database for CI

`raven check` can give package-aware diagnostics in CI without installing anything: symbols from your dependencies resolve against Raven's `names.db` database when it's present, so they don't show up as undefined variables. The database isn't bundled with the binary; run `raven packages update` during CI image setup or cache warmup for broad CRAN and Bioconductor coverage. Builds from source still have embedded coverage of R's base packages.

Generate and commit `.raven/packages.json` (the repo database in the [package database](package-database.md) model) when CI needs reproducible, project-specific package metadata pinned to what your project actually installed. That's different from `raven packages update`, which fetches broad `names.db` coverage from a moving release and isn't pinned by your project. The repo database also improves accuracy when:

1. you depend on packages whose exports **aren't** in `names.db` (GitHub-only, internal, or not yet indexed), or
2. you pin package versions whose exports **differ** from the versions Raven captured, in ways that could change your diagnostics (see the [drift caveat](package-database.md#fidelity-caveats)).

To generate the file:

```bash
raven packages freeze
```

This writes `.raven/packages.json`, a frozen snapshot of your installed packages' export names, `Depends`, and datasets, which `raven check` prefers over `names.db` when no R is present. Run it on a machine with R and the project's dependencies installed. The file is generated, not hand-edited, and meant to be committed and reviewed in pull requests (a `git diff` shows "package X gained export Y").

Generation looks in the renv project library first, and in system libraries only for packages renv doesn't cover. If your project uses [`renv`](https://rstudio.github.io/renv/), run `freeze` after `renv::restore()` for the best coverage: `renv.lock` selects which packages to include, while the exports come from what is actually installed. Re-running it when nothing changed produces no diff.

See [Package database](package-database.md), [`raven packages freeze`](cli.md#raven-packages-freeze), and [`raven packages update`](cli.md#raven-packages-update) for the options and the full resolution model.

## Comparison with script mode

| Feature | Script mode | Package mode |
|---------|-------------|--------------|
| Cross-file visibility | Through `source()` chains and directives | All `R/*.R` files see each other |
| Package imports | Through `library()` calls | Through `NAMESPACE` and roxygen `@import`/`@importFrom` |
| Diagnostics | Position-aware (after `source()`) | All package symbols available everywhere |
| Detection | Default for workspaces that aren't packages | Automatic when `DESCRIPTION` has a valid `Package:` field |

## Troubleshooting

**Imports seem stale after editing roxygen tags.** Run `devtools::document()` to regenerate `NAMESPACE`, or save the file: Raven re-reads roxygen tags on every change.

**False positives persist after adding `@importFrom`.** Make sure Raven knows the imported package's exports: install the package locally, capture it in `.raven/packages.json` with `raven packages freeze`, or rely on `names.db` (run `raven packages update` to download it). Knowing the exports is separate from install status: if `--report-uninstalled` or the editor's missing-package diagnostics are on, they still report what's installed locally and need the package on disk.

If the function is loaded at runtime by a workspace-root `.Rprofile` or a bootstrap `source()`, see [.Rprofile startup files](rprofile.md) and [Ordinary scripts in package workspaces](#ordinary-scripts-in-package-workspaces). Raven reads `.Rprofile` automatically, and a `# raven: source` directive covers other setups.

**Package mode doesn't turn on.** Check that `DESCRIPTION` is at the workspace root (the first workspace folder) and has a `Package:` field. You can also force it with `"raven.packages.packageMode": "enabled"`.

<a id="configuration"></a>
## Settings

| Setting | Default | What it does |
|---|---|---|
| `raven.packages.packageMode` | `"auto"` | When package mode is on (see below) |
| `raven.packages.rprofilePrelude` | `true` | Use the workspace-root `.Rprofile` startup prelude. See [.Rprofile startup files](rprofile.md). |

Values for `packageMode`:

- **`"auto"`** (default): turn on package mode when the workspace root has a `DESCRIPTION` file with a parseable, non-empty `Package:` field.
- **`"enabled"`**: always use package mode, even without a `DESCRIPTION` file. Useful for non-standard package layouts.
- **`"disabled"`**: never use package mode, even with a `DESCRIPTION`. Use this if you prefer script-mode behavior in a package workspace.

See the [settings reference](settings-reference.md) for every `raven.packages.*` setting.

<a id="known-limitations"></a>
## Limitations

- **`Collate:` order isn't respected.** All `R/*.R` files are fully visible to each other regardless of collation order. This rarely matters, since R's namespace doesn't enforce load order for symbol visibility.
- **S4 and R5 method dispatch.** Raven doesn't trace `setGeneric`/`setMethod` relationships to resolve methods.
- **Conditional exports.** Symbols exported conditionally, such as inside `if` blocks, are always treated as available.
- **`useDynLib`.** C and Fortran symbols loaded through `useDynLib` in `NAMESPACE` aren't recognized.
- Going to the definition of a function in an installed package after `load_all()` isn't supported yet.

## Details

### Namespace runtime bindings

R provides `.packageName` inside a package namespace. Raven recognizes it in package source files and in `tests/testthat/`, whose test environment inherits from the namespace. It isn't exported: ordinary scripts, vignettes, and scripts that call `load_all()` don't get it.

Raven also recognizes this load-hook pattern, which box uses:

```r
.onLoad <- function(libname, pkgname) {
  ns <- base::topenv()
  ns$system_mod_path <- system.file("mod", package = pkgname)
}
```

The assigned name becomes package-internal, so other `R/` files can use `system_mod_path`.

<details markdown="1">
<summary>Exact limits of the load-hook pattern</summary>

- Both `<-` and `=` work.
- The qualified form works in direct statements in `.onLoad`/`.onAttach`, with no arguments to `base::topenv()`.
- Aliases follow source order. Reassignment, or unsupported control flow in between, stops them.
- Quoted code and nested function bodies don't contribute.
- This adds to Raven's existing recognition of bare namespace constructors. Raven doesn't run hooks or evaluate arbitrary environment expressions.

</details>

### Non-portable R6 classes

Inside inline methods of `R6::R6Class(portable = FALSE, ...)`, Raven resolves bare public, private, and active member names, including members inherited from classes in other `R/` files. Method parameters and local variables take precedence. Method defaults and nested closures also see the instance members; field initializers and unrelated functions don't.

```r
Base <- R6::R6Class(portable = FALSE, public = list(value = 1))
Child <- R6::R6Class(inherit = Base, portable = FALSE, public = list(
  read = function() value
))
```

<details markdown="1">
<summary>Where it works, and which forms count</summary>

This also works in scripts, with classes in the same file or connected by `source()`. A superclass can be declared later, because R6 captures `inherit` and looks it up in the finished environment. Raven follows class bindings it can prove and rejects ambiguous package definitions. Bare `R6Class(...)` and `list(...)` are recognized when no known local or package definition masks them; qualified calls are recognized even then.

Member bindings feed diagnostics, completion, hover, signature help, and go-to-definition. `portable` must be the literal `FALSE`; `F` or a computed expression doesn't count. Members must come from inline `list(...)` or `base::list(...)` declarations. See [R6 limitations](limitations.md#r6-classes) for dynamic forms.

</details>

<a id="behavior-non-package-namespace-files"></a>
### A NAMESPACE file without DESCRIPTION

<a id="namespace-without-description-no-longer-suppresses-diagnostics"></a>
Package mode needs a `DESCRIPTION` file with a valid `Package:` field at the workspace root. `NAMESPACE` is optional and doesn't affect activation: when present it resolves imported symbols, and when absent package mode still works.

A workspace with a `NAMESPACE` file but no `DESCRIPTION` runs in script mode, and its `import()` and `importFrom()` lines don't suppress diagnostics. Earlier Raven versions did read them in that case; that behavior was removed. To get package-mode behavior without a `DESCRIPTION`, set `"raven.packages.packageMode": "enabled"`.

## See also

- [Cross-file analysis](cross-file.md#devtoolsload_all--virtual-attached-package): how `load_all()` and `library()` propagate
- [.Rprofile startup files](rprofile.md): helpers loaded at startup
- [Package database](package-database.md): resolving package exports in CI
- [Non-standard evaluation](non-standard-evaluation.md): argument policies, including your own package's
