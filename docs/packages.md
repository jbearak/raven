# Package Function Awareness

Raven recognizes functions, variables, and datasets exported by R packages loaded via `library()`, `require()`, or `loadNamespace()` calls. This enables accurate diagnostics, completions, hover information, and go-to-definition for package symbols.

## How It Works

When you load a package with `library(dplyr)`, Raven:
1. Detects the library call and extracts the package name
2. Queries R (via subprocess) to get the package's exported symbols
3. Makes those symbols available for completions, hover, and diagnostics
4. Suppresses "undefined variable" warnings for package exports

## Base Package Handling

Base R packages are always available without explicit `library()` calls:
- **base** - Core R functions (`c`, `list`, `print`, `sum`, etc.)
- **methods** - S4 methods and classes
- **utils** - Utility functions (`head`, `tail`, `str`, etc.)
- **grDevices** - Graphics devices
- **graphics** - Base graphics functions
- **stats** - Statistical functions (`lm`, `t.test`, `cor`, etc.)
- **datasets** - Built-in datasets (`mtcars`, `iris`, etc.)

At startup, Raven queries R for the default search path using `.packages()`. If R is unavailable, it falls back to the hardcoded list above.

## Position-Aware Loading

Package exports are only available AFTER the `library()` call, matching R's runtime behavior:

```r
mutate(df, x = 1)  # Warning: undefined variable 'mutate'
library(dplyr)
mutate(df, y = 2)  # OK: dplyr is now loaded
```

## Function-Scoped Loading

When `library()` is called inside a function, the package exports are only available within that function's scope:

```r
my_analysis <- function(data) {
  library(dplyr)
  mutate(data, x = 1)  # OK: dplyr available inside function
}

mutate(df, y = 2)  # Warning: dplyr not available at global scope
```

## Meta-Package Support

Raven recognizes meta-packages that attach multiple packages:

**tidyverse** attaches:
- dplyr, readr, forcats, stringr, ggplot2, tibble, lubridate, tidyr, purrr

**tidymodels** attaches:
- broom, dials, dplyr, ggplot2, infer, modeldata, parsnip, purrr, recipes, rsample, tibble, tidyr, tune, workflows, workflowsets, yardstick

```r
library(tidyverse)
# All tidyverse packages are now available
mutate(df, x = 1)      # dplyr
ggplot(df, aes(x, y))  # ggplot2
str_detect(s, "pat")   # stringr
```

## Cross-File Integration

Packages loaded in parent files are available in sourced child files:

```r
# main.R
library(dplyr)
source("analysis.R")  # dplyr available in analysis.R
library(ggplot2)      # NOT available in analysis.R (loaded after source)
```

```r
# analysis.R
# @lsp-sourced-by main.R
result <- mutate(df, x = 1)  # OK: dplyr loaded in parent before source()
```

Packages loaded in child files do NOT propagate back to parent files (forward-only propagation).

## Diagnostics

Raven provides helpful diagnostics for package-related issues:

| Diagnostic | Description |
|------------|-------------|
| Undefined variable | Symbol used before package is loaded |
| Missing package | `library()` references a package not installed on the system |

## Supported Library Call Patterns

| Pattern | Supported |
|---------|-----------|
| `library(pkgname)` | Yes |
| `library("pkgname")` | Yes |
| `library('pkgname')` | Yes |
| `require(pkgname)` | Yes |
| `loadNamespace("pkgname")` | Yes |
| `library(pkg, character.only = TRUE)` | No (dynamic) |
| `library(get("pkg"))` | No (dynamic) |

Dynamic package names (variables, expressions, `character.only = TRUE`) are skipped gracefully.

## Keeping Packages in Sync

Raven caches each package's exports in memory for the duration of the LSP session. To avoid stale results when you install, upgrade, or remove packages, Raven watches the directories returned by `.libPaths()` at startup and invalidates affected packages automatically:

- **New install** (`install.packages("pkg")` for a package not yet installed): the new top-level directory fires a filesystem event; Raven prefetches the new exports and republishes diagnostics.
- **In-place upgrade** (`install.packages("pkg")` for a package that already exists): only files inside the existing `<libpath>/pkg/` directory change. Raven watches libpaths recursively so these file-level events still arrive and the package is marked `touched`, dropping its cached exports.
- **Removal**: the disappearing directory triggers the same invalidation path.
- **Libpath priority change**: if the same package name starts resolving to a different libpath root, Raven treats it as touched.

### Watcher settings

| Setting | Default | Description |
|---------|---------|-------------|
| `packages.watchLibraryPaths` | `true` | Watch `.libPaths()` directories and invalidate caches on change. |
| `packages.watchDebounceMs` | `500` | Coalesce rapid filesystem events into a single invalidation pass. |

On Linux, recursive watching attaches one inotify watch per descendant directory (not per file). A typical R package has ~10–20 subdirectories; 500 installed packages is ~5–10k watches. If you work with very large CRAN snapshots on an older distro capped at the legacy default of 8192, raise the limit:

```sh
sudo sysctl -w fs.inotify.max_user_watches=524288
```

### Manual refresh: `raven.refreshPackages`

If you change `.libPaths()` inside an active R session (e.g. `renv::activate()` switches to a different project, `.Rprofile` sets `R_LIBS_USER`, or `install.packages` succeeds but events are dropped by a transient FS issue), run the **Raven: Refresh Packages** command from the editor's command palette. It:

1. Re-runs `.libPaths()` to discover the current library roots.
2. Rebuilds Raven's package library over those roots.
3. Restarts the filesystem watcher so future installs/removes in the new libpaths are observed.
4. Clears the in-memory package cache and prefetches exports for packages loaded in open documents.
5. Republishes diagnostics for all open documents.

This command is always available, even if `packages.watchLibraryPaths` is `false`.
