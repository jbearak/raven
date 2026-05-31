# R Package Development

Raven automatically detects R package workspaces and provides enhanced code intelligence tailored to package development workflows.

## How It Works

Raven activates **package mode** when the workspace root contains a `DESCRIPTION` file with a parseable, non-empty `Package:` field. Mere presence of `DESCRIPTION` is not sufficient — the file must carry a valid `Package:` entry. In package mode:

1. **Mutual visibility** — All `R/*.R` files see each other's top-level symbols, matching `devtools::load_all()` semantics. A function defined in `R/utils.R` is available in `R/analysis.R` without any `source()` call.

2. **Import resolution** — Symbols imported via `NAMESPACE` or roxygen annotations (`@import`, `@importFrom`) suppress undefined-variable diagnostics.

3. **Roxygen + NAMESPACE merge** — Raven unions imports and exports parsed from the generated `NAMESPACE` file with roxygen tags (`@import`, `@importFrom`, `@export`) parsed from `R/*.R` files. Imports visible to your code are the combined set from both sources, so you get correct import resolution whether you edit `NAMESPACE` directly, rely on `devtools::document()` to regenerate it from roxygen, or are mid-edit between the two.

## What's Supported

### Mutual Visibility

All top-level symbols (functions, variables, constants) defined in files under `R/` are visible to every other file under `R/`. This eliminates false-positive "undefined variable" diagnostics for cross-file function calls within your package.

```r
# R/helpers.R
validate_input <- function(x) { ... }

# R/main.R
run_analysis <- function(data) {
  validate_input(data)  # No diagnostic — Raven knows this is in R/helpers.R
}
```

Files outside `R/` (e.g., `tests/`, `inst/`, `vignettes/`) are not included in mutual visibility.

### Tests directory awareness

Files under `tests/testthat/` get one-way read access to package-internal
symbols (`R/*.R`) and to symbols imported via NAMESPACE/roxygen. Tests can
call internal package functions without "undefined variable" diagnostics.
Symbols defined in test files are not visible from `R/*.R`.

```r
# R/helpers.R
process_data <- function(df) { ... }

# tests/testthat/test-helpers.R
test_that("process_data works", {
  result <- process_data(mtcars)  # No diagnostic — helper visible from tests
  expect_equal(nrow(result), nrow(mtcars))
})
```

In contrast, a function defined in `tests/testthat/test-helpers.R` is **not**
visible to `R/helpers.R` — symbols in `R/` are visible from `tests/testthat/`,
but not the other way around.

#### Implicit `library(testthat)` under `tests/testthat/`

Raven treats `testthat` as if it were attached (via `library(testthat)`) when
all of the following hold:

- the workspace is in package mode (DESCRIPTION with a valid `Package:` field), and
- the DESCRIPTION declares `testthat` in `Suggests:`, `Imports:`, or `Depends:`, and
- the queried file is under `tests/testthat/`.

This matches `testthat::test_check`'s loader, which attaches testthat before
sourcing each test file. Test files therefore do not need (and conventionally
do not include) an explicit `library(testthat)` — calling `test_that(...)`,
`expect_equal(...)`, etc. produces no "undefined variable" diagnostic. Outside
`tests/testthat/`, the same calls remain flagged: implicit attachment is scoped
to the testthat directory.

If the DESCRIPTION does not declare testthat, no implicit attachment happens —
the diagnostic stays as "undefined variable" until the user either adds
`Suggests: testthat` (the conventional fix) or adds an explicit `library(testthat)`.

#### Helper files (`tests/testthat/helper*.R`)

`testthat::source_test_helpers` sources files matching `^helper.*\.[Rr]$`
in `sort()` order before each test runs. Raven mirrors this:

- Top-level definitions in any `tests/testthat/helper*.R` file are visible
  from `test-*.R` (and other non-helper test files), because by the time a
  test runs all helpers have been sourced.
- Between helpers, visibility follows sourcing order: a helper sees
  earlier-sorted peers but not later ones. For example, `helper-b.R`
  sees `helper-a.R`'s top-level defs, but `helper-a.R` does NOT see
  `helper-b.R`'s — `helper-b.R` is sourced strictly later.
- Helpers are matched by filename only at the top level of
  `tests/testthat/`; files in subdirectories (e.g.
  `tests/testthat/sub/helper-x.R`) are not auto-sourced by testthat and
  are NOT treated as helpers here either.
- Helper defs never propagate into `R/` (the one-way visibility into `R/`
  stays asymmetric).

```r
# tests/testthat/helper-fixtures.R
demo_input <- c(1, 2, 3)

# tests/testthat/test-foo.R
test_that("works on demo_input", {
  expect_equal(length(demo_input), 3)  # No diagnostic — visible from helper
})
```

Setup files (`setup-*.R`, `teardown-*.R`) are not currently treated as helpers
for visibility purposes; declare any cross-file fixtures in `helper*.R`.

### Build commands

When the workspace is detected as an R package (DESCRIPTION with a non-empty
`Package:` field, or `raven.packages.packageMode` set to `enabled`) **and**
Raven's R console is active (see [Coexistence](./coexistence.md)), Raven
contributes six Command Palette entries that wrap the standard
`devtools` / `testthat` / `roxygen2` workflows. Names mirror RStudio's
**Build** menu so existing muscle memory carries over. The Command Palette
and editor-title submenu entries are gated on
`raven.rConsoleEnabled && raven.isRPackage`; if `raven.rConsole.activation`
is on the default `"auto"` and REditorSupport's R extension is enabled (or
you're running Positron), the build commands stay hidden and you should
use REditorSupport's or Positron's package-development workflow instead.

| Palette title | Runs in | R call |
|---|---|---|
| `Raven Build: Load All` | active R terminal | `devtools::load_all("<workspace>")` |
| `Raven Build: Document` | active R terminal | `devtools::document("<workspace>")` |
| `Raven Build: Install and Restart` | active R terminal | `devtools::install("<workspace>")` followed by `quit(save = "no")` |
| `Raven Build: Test Package` | `R: Package Tasks` terminal | `devtools::test("<workspace>")` |
| `Raven Build: Check Package` | `R: Package Tasks` terminal | `devtools::check("<workspace>")` |
| `Raven Build: Build Source Package` | `R: Package Tasks` terminal | `devtools::build("<workspace>")` |

Each command passes the first workspace folder's absolute path explicitly,
so a stray `setwd()` in the R session — or a terminal launched from a
subdirectory — can't redirect the build at the wrong project.

The six commands also appear as a single `$(package)` submenu in the
editor title bar when an R, R Markdown, or Quarto file is open in a package workspace.

#### Terminal routing

The three session-mutating commands (`Load All`, `Document`,
`Install and Restart`) run in the same R terminal that Send-to-R uses,
so their side effects land where you'd expect.

The three long-running commands (`Test Package`, `Check Package`,
`Build Source Package`) run in a dedicated `R: Package Tasks` terminal.
This avoids tying up the interactive prompt for the 20–60s+ these
commands can take, and keeps a clean separation between exploratory
work and batch-style package checks. The tasks terminal is reused
across invocations — Raven doesn't pay R-startup cost on every
`devtools::test()`. Both terminals respect `raven.rTerminal.program`,
so a configured `radian` or `arf` carries over.

#### Install and Restart semantics

`Install and Restart` chains `devtools::install()` with
`quit(save = "no")` so the R process exits after install completes.
When the terminal closes, Raven recreates it in the same pane. The next
Send-to-R or Build command runs in a fresh R session that picks up the
newly installed version of the package — which is the whole point of
the command.

If the install fails, the wrapper surfaces the error via `message()`
before R exits; the failure output stays visible in the closed-terminal
scrollback so you can read it before dismissing.

### testthat problem matcher

When you run `devtools::test()` or `testthat::test_dir()`, testthat's
default progress reporter prints failure headers like:

```text
Failure ('test-helpers.R:12:3'): process_data handles NAs
Expected 1 to equal 2.
Differences:
1/1 mismatches
[1] 1 - 2 == -1
```

Raven contributes a `$testthat` problem matcher that parses those headers
and surfaces each failing test in VS Code's Problems panel, with a
clickable file:line link that jumps to the failing assertion.

To wire it up, add a task to `.vscode/tasks.json` (or run it ad hoc via
**Terminal → Run Task…**):

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

The matcher recognises `Failure (…)` / `Error (…)` headers from the
default `ProgressReporter`, the `── Failure (…) ──` form from the
`CompactProgressReporter`, and the all-caps `FAILURE: …` / `ERROR: …`
shape that testthat's `LlmReporter` emits when running under an AI
coding agent (`CLAUDECODE` / `AGENT` / `GEMINI_CLI` / `CURSOR_AGENT`).
Paths resolve relative to `${workspaceFolder}/tests/testthat`, matching
the directory testthat sets as the working directory while a test
runs. The Problems-panel entry's message is the test name (when the
reporter emits one); the full expected/actual output stays in the
terminal where you can read it alongside any other context the test
printed.

### Roxygen Namespace Tags

When roxygen is detected, Raven parses these tags from source:

| Tag | Effect |
|-----|--------|
| `@export` | Marks the next definition as an exported symbol |
| `@import pkg` | All exports of `pkg` are available without qualification |
| `@importFrom pkg sym1 sym2` | Only `sym1`, `sym2` from `pkg` are available |

```r
#' @importFrom dplyr mutate filter
#' @export
transform_data <- function(df) {
  df |> filter(x > 0) |> mutate(y = x * 2)
  # No diagnostics for mutate or filter
}
```

### NAMESPACE + roxygen merge

Raven always parses the generated `NAMESPACE` file (when present) and
unions its entries with roxygen tags extracted from `R/*.R`:

- `import(pkg)` — all exports of `pkg` are available
- `importFrom(pkg, sym1, sym2)` — specific symbols are available
- `export(sym)` — informational (mutual visibility makes all symbols available internally regardless)

Roxygen `@import`, `@importFrom`, and `@export` in any `R/*.R` file
contribute to the same merged model; duplicate entries across NAMESPACE
and roxygen are deduped. This means roxygen-annotated imports are
visible to diagnostics and completions even before you run
`devtools::document()` to regenerate `NAMESPACE`, and NAMESPACE-only
imports remain visible if some `R/*.R` files don't carry roxygen tags.

### Live Updates

Raven watches for changes to `DESCRIPTION` and `NAMESPACE` files. After running `devtools::document()` or editing these files directly, diagnostics update automatically without restarting the editor.

## Package Database for CI Gating

> **Status: planned — tracking [the CI package-exports DB work]. Not yet available in a released build.**

When running `raven check` inside a CI/CD pipeline, the runner usually does not have your package's full set of dependencies (including external CRAN/Bioconductor packages) installed. To prevent spurious \"undefined variable\" diagnostics, you can generate and commit a static \"frozen\" package export database.

Run the following command on a provisioned machine or container where your package's dependencies are fully installed (e.g. immediately after `renv::restore()`):

```bash
raven packages freeze
```

This scans your codebase and reads from your local library paths (prioritizing `renv` environments when present — the **renv-first library order**), writing a deterministic, diff-friendly list of exports and datasets to `.raven/packages.json` (Tier 2).

Committing this file enables zero-install, completely offline export resolution in your CI pipeline, ensuring that only undefined symbols from *unreferenced* packages or real code typos are flagged, while everything else resolves seamlessly.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.packages.packageMode` | `"auto"` | Controls package mode activation |

Values for `packageMode`:

- **`auto`** (default) — Enable package mode when a `DESCRIPTION` file with a parseable, non-empty `Package:` field is found at the workspace root.
- **`enabled`** — Always enable package mode, even without a `DESCRIPTION` file. Useful for non-standard package layouts.
- **`disabled`** — Never enable package mode, even if `DESCRIPTION` exists. Use this if you prefer script-mode behavior in a package workspace.

## Comparison with Script Mode

| Feature | Script Mode | Package Mode |
|---------|-------------|--------------|
| Cross-file visibility | Via `source()` chains and directives | All `R/*.R` files mutually visible |
| Package imports | Via `library()` calls | Via NAMESPACE/roxygen `@import`/`@importFrom` |
| Diagnostics | Position-aware (after `source()`) | All package symbols available everywhere |
| Detection | Default for non-package workspaces | Automatic when `DESCRIPTION` has a valid `Package:` field |

## Behavior: Non-Package NAMESPACE Files

### NAMESPACE without DESCRIPTION no longer suppresses diagnostics

Package mode activates when the workspace root contains a `DESCRIPTION` file
with a valid `Package:` field. `NAMESPACE` presence is optional and does not
affect activation — it is used (when present) to resolve imported symbols,
but its absence does not disable package mode.

Prior to this version, a workspace containing a `NAMESPACE` file but no
`DESCRIPTION` would still have its `import()` and `importFrom()` directives
parsed and used to suppress undefined-variable diagnostics. That behavior was
removed: non-package workspaces (no `DESCRIPTION` with a `Package:` field)
run as script mode regardless of `NAMESPACE` presence.

If you need package-mode behavior in a workspace without `DESCRIPTION`, set
`"raven.packages.packageMode": "enabled"` to force package mode.

## Known Limitations

- **`Collate:` ordering is not respected** — All `R/*.R` files are treated as fully mutually visible regardless of collation order. In practice this rarely matters since R's namespace mechanism doesn't enforce load order for symbol visibility.
- **S4/R5 method dispatch** — Raven doesn't trace `setGeneric`/`setMethod` relationships for method resolution.
- **Conditional exports** — Symbols exported conditionally (e.g., inside `if` blocks) are always treated as available.
- **`useDynLib`** — C/Fortran symbols loaded via `useDynLib` in NAMESPACE are not recognized.

## Troubleshooting

**Imports seem stale after editing roxygen tags:**
Run `devtools::document()` to regenerate the NAMESPACE file, or save the file — Raven re-parses roxygen tags from source on each file change.

**False positives persist after adding `@importFrom`:**
Ensure the imported package is actually installed. Raven only suppresses diagnostics for symbols from installed packages (it verifies the package exists on disk).

**Package mode not activating:**
Check that `DESCRIPTION` is at the workspace root (the first workspace folder) and contains a `Package:` field. You can also force it with `"raven.packages.packageMode": "enabled"`.
