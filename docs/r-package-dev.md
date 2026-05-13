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
