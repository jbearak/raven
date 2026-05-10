# R Package Development

Raven automatically detects R package workspaces and provides enhanced code intelligence tailored to package development workflows.

## How It Works

When Raven detects a `DESCRIPTION` file at the workspace root, it activates **package mode**:

1. **Mutual visibility** — All `R/*.R` files see each other's top-level symbols, matching `devtools::load_all()` semantics. A function defined in `R/utils.R` is available in `R/analysis.R` without any `source()` call.

2. **Import resolution** — Symbols imported via `NAMESPACE` or roxygen annotations (`@import`, `@importFrom`) suppress undefined-variable diagnostics.

3. **Roxygen awareness** — When any `R/*.R` file contains `#' @export`, Raven treats the package as roxygen-managed and parses namespace tags directly from source files rather than the generated `NAMESPACE` file.

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

### NAMESPACE Fallback

If no roxygen blocks are detected (no `#' @export` in any `R/*.R` file), Raven falls back to parsing the `NAMESPACE` file directly. It recognizes:

- `import(pkg)` — all exports of `pkg` are available
- `importFrom(pkg, sym1, sym2)` — specific symbols are available
- `export(sym)` — informational (mutual visibility makes all symbols available internally regardless)

### Live Updates

Raven watches for changes to `DESCRIPTION` and `NAMESPACE` files. After running `devtools::document()` or editing these files directly, diagnostics update automatically without restarting the editor.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.packages.packageMode` | `"auto"` | Controls package mode activation |

Values for `packageMode`:

- **`auto`** (default) — Enable package mode when `DESCRIPTION` is found at the workspace root.
- **`enabled`** — Always enable package mode, even without a `DESCRIPTION` file. Useful for non-standard package layouts.
- **`disabled`** — Never enable package mode, even if `DESCRIPTION` exists. Use this if you prefer script-mode behavior in a package workspace.

## Comparison with Script Mode

| Feature | Script Mode | Package Mode |
|---------|-------------|--------------|
| Cross-file visibility | Via `source()` chains and directives | All `R/*.R` files mutually visible |
| Package imports | Via `library()` calls | Via NAMESPACE/roxygen `@import`/`@importFrom` |
| Diagnostics | Position-aware (after `source()`) | All package symbols available everywhere |
| Detection | Default for non-package workspaces | Automatic when `DESCRIPTION` exists |

## Behavior: Non-Package NAMESPACE Files

### NAMESPACE without DESCRIPTION no longer suppresses diagnostics

Prior to this version, a workspace containing a `NAMESPACE` file but no
`DESCRIPTION` would still have its `import()` and `importFrom()` directives
parsed and used to suppress undefined-variable diagnostics. Now: package
mode activates only when both `DESCRIPTION` (with a `Package:` field) and
`NAMESPACE` are present. Non-package workspaces run as script mode regardless
of `NAMESPACE` presence.

If you need this behavior, set `"raven.packages.packageMode": "enabled"` to
force package mode, which activates even without a `DESCRIPTION` file.

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
