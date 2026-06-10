# Tidyverse Corpus Triage Report

**Date:** 2026-06-08  
**Run:** `RAVEN_CORPUS_GROUPS=tidyverse RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1`  
**Result:** 31 packages fetched (all succeeded), 29 with diagnostics, 2 clean (jsonlite, rstudioapi)  
**Total diagnostics:** 1483  

## Summary by message prefix

| Prefix | Count |
|--------|-------|
| Undefined variable | 1452 |
| Assigning to string literal | 19 |
| Missing opening brace/paren | 4 |
| File not found | 3 |
| Cannot assign to numeric literal | 2 |
| Mixed `&` and `|` | 1 |
| Unclosed `(` | 1 |
| Cannot assign to reserved word | 1 |

## Summary by file location

| Location | Count |
|----------|-------|
| R/ | 419 |
| vignettes/ | 386 |
| tests/testthat/ | 340 |
| other (.github/, etc.) | 111 |
| man/ | 106 |
| inst/ | 64 |
| data-raw/ | 22 |
| revdep/ | 20 |
| demo/ | 15 |

## Summary by package (top 15)

| Package | Count |
|---------|-------|
| dplyr | 289 |
| rlang | 193 |
| cli | 174 |
| ggplot2 | 170 |
| dbplyr | 88 |
| rvest | 82 |
| broom | 69 |
| httr | 58 |
| tidyr | 56 |
| googledrive | 49 |
| lubridate | 44 |
| ragg | 31 |
| dtplyr | 28 |
| readr | 27 |
| forcats | 20 |

## Classification

### Accepted-Real (20 diagnostics)

Genuine code-style issues Raven correctly flags:

- **Assigning to string literal** (19): Using `"name" <- value` instead of `` `name` <- value ``.
  Packages: lubridate (10), ggplot2 (4), httr (3), dbplyr (1), stringr (1).
- **Mixed `&` and `|` without parentheses** (1): ggplot2 `R/geom-text.R:230`.

### Known-FP (1463 diagnostics)

Correct code that Raven cannot resolve statically. Breakdown by root cause:

#### R6 `self`/`private` (226 total)
R6 class method bodies reference `self` and `private` which are injected by R6 at construction time.
- rvest: 69 (52 self, 17 private)
- dbplyr: 51 (49 self, 2 private)  
- dplyr: 44 (all self)
- httr: 41 (all self)
- readr: 21 (all private)

**Status:** Known-FP. Suppressing R6 `self`/`private` would require recognizing the enclosing R6Class definition and injecting those names — a bounded infrastructure fix (not an NSE policy entry). Already tracked as a gap.

#### Missing NAMESPACE imports (57 total)
Functions imported via `importFrom(pkg, fn)` in NAMESPACE but not resolved by Raven because the source packages aren't installed in the analysis environment.
- dbplyr: 14 (rlang functions)
- ggplot2: 22 (rlang, vctrs, gtable functions)
- tidyr: 11 (rlang, vctrs functions)
- dplyr: 2 (rlang functions)
- googledrive: 3 (rlang, vctrs)
- dtplyr: 3 (rlang functions)
- purrr: 3 (rlang functions)

**Status:** Known-FP. These would resolve if the package library had rlang/vctrs/gtable installed. Not an NSE-policy gap.

#### Sysdata.rda / .onLoad bindings (62 total)
Internal package data from `R/sysdata.rda` or variables created in `.onLoad()`.
- cli: 50 (`symbol`, `spinners`, `rstudio_themes`, `gfycat_*`, `wide_chars`, `deferred_run`, `cli_keypress`, `clic_tick_reset`)
- googlesheets4: 6 (`.endpoints`, `.tidy_schemas`)
- googledrive: 3 (`.endpoints`)
- lubridate: 4 (`lubridate_shared_empty_*`)

**Status:** Known-FP. Would require parsing `R/sysdata.rda` or `.onLoad` bodies.

#### Standalone/vendored file gaps (28 total)
Vendored `import-standalone-*.R` and `compat-purrr.R` files with conditional definitions.
- `is_true` (20 across 10 packages): conditionally defined helper in standalone-purrr
- `na_chr` (7 across 6 packages): conditionally defined in standalone-types-check
- `deferred_run` (1 in rlang): conditionally defined in standalone-defer

**Status:** Known-FP. These are conditionally defined (e.g., `if (!exists("is_true")) is_true <- ...`) which static analysis can't trace.

#### Native/FFI routine bindings (8 total)
- rlang: 8 (`ffi_enquo`, `ffi_enexpr`, `ffi_exprs_interp`, `ffi_quos_interp`)

**Status:** Known-FP. Registered via `.Call` native routine registration at load time.

#### S4 dispatch magic (2 total)
- lubridate: 2 (`.Generic` — S3/S4 dispatch-provided variable)

**Status:** Known-FP. `.Generic` is injected by R's method dispatch system.

#### Vignette/man/test/inst runtime context (1080 total)
The largest bucket. These are valid code that runs in a context where package datasets are attached, data-masking is active, or previous chunks have created objects.

Breakdown:
- **Package datasets in vignettes** (~300): `mpg`, `starwars`, `diamonds`, `relig_income`, etc. used after `library(pkg)` in prior chunks
- **Data-masked columns in vignettes** (~23): column names inside dplyr/ggplot2 calls
- **Data-masked columns in tests** (~109): column names in test `filter(df, col > 0)` patterns
- **Package datasets in tests** (~62): `lung`, `mgus`, `starwars` etc. from Suggests packages
- **Test fixtures/cross-chunk vars** (~97): variables created in setup blocks or earlier test code
- **inst/ example scripts** (64): standalone scripts lacking `library()` calls
- **man/ Rmd examples** (106): rlang documentation Rmds with cross-chunk dependencies
- **revdep/ scripts** (20): `revdep_check` etc. from devtools
- **data-raw/ scripts** (22): column names in data-processing scripts
- **demo/ scripts** (15): deprecated demo scripts
- **.github/ action scripts** (3): GitHub Actions R scripts

**Status:** Known-FP. These are all runtime-context dependencies that static analysis cannot resolve (cross-chunk state in Rmd, attached package datasets, etc.).

#### File not found (3 total)
- hms, pillar, tibble: `.github/workflows/versions-matrix/action.R` references `.github/versions-matrix.R` which doesn't exist at the repo root (it's a relative path from a different CWD at runtime).

**Status:** Known-FP. Workspace-root resolution doesn't match the runtime CWD in GitHub Actions.

#### Syntax diagnostics in Rmd/test fixtures (8 total)
- dtplyr `vignettes/benchmark.R` (3): Missing opening `(` — extracted R code from benchmark
- tidyr `vignettes/in-packages.Rmd` (1): Missing opening `{` — Rmd extraction artifact
- readxl `vignettes/sheet-geometry.Rmd` (1): Unclosed `(` — Rmd extraction artifact
- rlang `tests/testthat/test-deparse.R` (3): Deliberately malformed R syntax being tested for deparse behavior

**Status:** Known-FP. Either Rmd extraction artifacts or intentionally malformed test fixtures.

### Tractable-FP (0 diagnostics)

**No tractable false positives were identified in this triage.**

The dominant FP categories (R6 self/private, missing NAMESPACE imports, sysdata.rda, standalone-file conditionals) are all infrastructure gaps that require new recognizer machinery, not NSE policy entries. None of the undefined-variable diagnostics are caused by uncatalogued data-masking/tidy-select verbs — the existing `nse.rs` policy table already covers the tidyverse surface adequately for external callers, and these packages use their own functions on themselves (which would be resolved by NAMESPACE imports if the packages were installed).

**Bottom line:** The existing NSE policy table is sufficient. The tidyverse corpus FPs are dominated by:
1. R6 self/private (226) — infrastructure gap, not NSE
2. NAMESPACE import resolution without installed packages (57) — infrastructure gap
3. Sysdata.rda/.onLoad bindings (62) — infrastructure gap
4. Vignette/test/man cross-chunk context (1080) — inherent limitation of static analysis
5. Standalone-file conditional defs (28) — inherent limitation

## Git references (for reproducibility)

All packages fetched successfully from GitHub dev branches:
- broom @ 6230a90, cli @ 86bdefe, conflicted @ 4d759ac, dbplyr @ f52aaa9
- dplyr @ d5e94e7, dtplyr @ bffe46e, forcats @ f83e0e6, ggplot2 @ 6870419
- googledrive @ 8de11bf, googlesheets4 @ 55cd9fd, haven @ f067fb2, hms @ b89649d
- httr @ 34b9565, jsonlite 2.0.0 (CRAN), lubridate @ 80980e8, magrittr @ 73d66ee
- modelr @ 28e13ca, pillar @ 6e9deda, purrr @ cb3afba, ragg @ 2850b7e
- readr @ 238ea87, readxl @ 47f8aea, reprex @ 0dcf301, rlang @ e9279f4
- rstudioapi @ df4e683, rvest @ 6c955c0, stringr @ ae054b1, tibble @ c51fe5d
- tidyr @ 26f83e8, xml2 1.5.2 (CRAN), tidyverse @ 0231aaf
