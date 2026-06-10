# Package corpus checkpoint

This document records the package-corpus hardening checkpoint on `prod-test`.

## Plan

The package-corpus effort adds a repeatable ignored integration suite for running `raven check --workspace <package> --format json --max-severity error --no-config` against real R package sources. The workflow:

1. Fetch package sources from a manifest-backed source strategy (SVN, git, CRAN tarball).
2. Run Raven in package mode against each package root.
3. Fail on unclassified diagnostics.
4. Treat accepted real diagnostics as fixture entries with evidence.
5. Turn suspected Raven false positives into failing tests first, then minimal Raven fixes.
6. Re-run affected package slices after each fix.

## Corpus runner

The runner lives in `crates/raven/tests/package_corpus.rs`, with fixtures under `crates/raven/tests/fixtures/package_corpus/`. It is ignored by default because it fetches package sources over the network. Reports are written to `target/package-corpus/`.

Env vars: `RAVEN_CORPUS_GROUPS`, `RAVEN_CORPUS_PACKAGES`, `RAVEN_CORPUS_ALL`, `RAVEN_CORPUS_LIMIT`, `RAVEN_CORPUS_ALLOW_UNCLASSIFIED`, `RAVEN_CORPUS_KEEP_TEMP`, `RAVEN_CORPUS_REPORT_DIR`.

The accepted-real fixture (`accepted_real_diagnostics.toml`) records 102 confirmed diagnostics (post-reclassification; see below). The known-false-positives fixture (`known_false_positives.toml`) records 3590 entries.

## Triage status

### Base (14 packages, 108 total diagnostics)

- **`base` package:** Cleared (10 accepted real diagnostics — 6 mixed precedence, 4 string-literal assignment).
- **Remaining 13 base-priority packages:** Triaged in allow-unclassified mode. 77 real diagnostics (47 datasets/data string-assignment, 16 replacement-fn string-assignment, 9 mixed precedence, others in quote()). 31 false positives (7 platform-specific functions, 12 setGeneric NSE, 6 require'd-package exports, 3 textConnection NSE, 1 metaprogramming template, 1 load() NSE, 1 dynamic source path).

### DT (1 package, 0 diagnostics after fix)

- All 182 original false positives were caused by Raven not recognizing `tests/testit/` as package-test scope.
- **Fixed:** Extended `is_r_source_path` and `is_tracked_package_dir` to classify `tests/testit/**/*.R` as `RFileKind::Test`. DT now passes strict mode with zero diagnostics.

### Recommended (15 packages, 3707 total diagnostics)

- 8 real (7 mixed precedence + 1 genuine typo in survival `R/xtras.R:290`).
- 3699 false positives dominated by: ~2900 `data()`/`library()` dataset loading, ~350 Matrix test helpers via `source(system.file(...))`, ~230 Matrix cross-file generics, ~200 survival `tmerge` NSE, 57 string-literal S3 method definitions, 45 `.Generic` implicit variable, 17 defined-later-on-line in data scripts.

### Tidyverse (31 packages)

- Triaged per idiom (issue #423): every known-FP entry was reviewed against the fetched sources and carries a single-idiom reason (no disjunctive catch-alls).
- 35 accepted real (3 carried over after re-verification + 32 reclassified from the FP ledger: dtplyr's orphaned `vignettes/benchmark.R` with undefined `DF`/`DT` and stray `)` syntax errors — 21; three leftover magrittr `.` placeholders stranded by native-`|>`/pipe refactors (rvest, googledrive, broom); stale googledrive demos against the pre-rename API — 4; ggplot2 `icons/icons.R` use-before-definition; cli fixture calling a C-only symbol; pillar drake plan referencing a function-local). The 2 dbplyr `error_call` acceptances were dropped: with `import(rlang)` warmed the name resolves to rlang's exported `error_call` function, so the (still questionable) copied-from-tidyr sites are no longer name-diagnosable.
- 2154 known FPs, dominated by: uninstalled-package attaches in tests/scripts (~1500, surfaced once import-warming removed an accidental call-position suppression — modeltests `check_*` in broom tests, dtplyr `helpers-library.R` attaches, Depends-chain attaches, archived revdep/internal scripts), dplyr/tidyselect data-masking (~250), pillar `assign()`-generated option accessors (117), `makeActiveBinding()` in `.onLoad` (27), `R/sysdata.rda` internal data, lazy-loaded datasets bundled in `Rdata.rdb`, eval/parse dynamic code, and knitr/Rmd runtime contexts.
- Six fix clusters were converted to Raven fixes instead of ledger entries (see below); 243 entries pruned after the fixes landed.

## Implemented Raven fixes (this checkpoint)

0. **Tidyverse triage fixes (#423):** (a) R6 positional member lists — `R6Class("Cls", list(...))` binds `self`/`private`/`super` in method bodies like the named `public=` form; (b) testthat `setup*.R` files inject top-level defs into sibling test scope like `helper*.R` (`is_test_helper_filename` → `is_test_preamble_filename`); (c) `raven check` and the editor prefetch warm NAMESPACE whole-package `import(pkg)` exports, fixing the call/value-position asymmetry; (d) zeallot `%<-%` and rlang `%<~%` create bindings (nested `c(...)` LHS supported); (e) embedded base-datasets table unioned under the installed-path INDEX fallback (INDEX topics under-enumerate multi-object entries: `state` → `state.x77`); (f) `.Random.seed` treated as an implicit search-path binding. Each TDD-backed with editor + CLI coverage.

1. **testit scope:** Extended package-test scope classification from `tests/testthat/` to `tests/testit/`. Files under `tests/testit/**/*.R` now get namespace injection (package internals + imports + exports), matching testthat behavior. Unit test + process-level regression added.

2. **Stale test fixes:** Updated `namespace_with_sources_activates_package_mode_without_description` derive test to match the intentional `has_namespace_and_sources` fallback. Renamed `test_normalize_preserves_comments` → `test_normalize_strips_comments` to match actual correct normalize behavior.

3. **Clippy cleanup:** Fixed 8 pre-existing lints (`nonminimal_bool`, `collapsible_if`, `too_many_arguments`, `redundant_closure`) in `handlers.rs` and `source_detect.rs`.

## Prior fixes (from earlier checkpoint)

- `.Internal(remove(...))` no longer creates synthetic scope-removal events.
- `.Autoloaded` modeled as implicit startup binding.
- `.External.graphics` treats first argument as native routine name.
- String-literal assignment targets create scope bindings for downstream resolution.

## Ledger reclassification (prod-test)

153 entries were moved from `accepted_real_diagnostics.toml` to `known_false_positives.toml`. All had the message `Assigning to string literal "…"` and fell into one of two idiom classes that Raven over-flagged: (a) S3/replacement/operator method definitions via quoted-string LHS (e.g. `"[.Surv" <- function(...)`, `"coef<-.varPower" <- function(...)`) — semantically identical to the backtick form and standard R practice; (b) R-core's datasets package `data/*.R` files (`"iris" <- ...`, `"AirPassengers" <- ...` — 55 entries) which use the canonical quoted-name form.

The follow-up fix has since landed: `check_invalid_assignment_target` exempts string-literal targets whose assigned value is a function definition (including parenthesized, chained `"a" <- "b" <- function(...)`, and `.Primitive(...)` forms), and top-level string assignments in package `data/*.R` files (URI-based, see `is_package_data_file`). A 16-package corpus re-run (survival, nlme, MASS, datasets, tcltk, lattice, base, methods, stats, dbplyr, foreign, ggplot2, httr, lubridate, mgcv, stringr) confirmed the entries are no longer emitted; 152 were pruned from the FP ledger and 1 (`base R/all.equal.R` `"__all.eq.E__" <- environment()` — a dynGet sentinel, not a function definition) was moved back to accepted-real alongside its sibling sentinel entries. The stale-FP report now also covers run packages with zero observed diagnostics — previously a fully-cleared package was silently skipped by the staleness sweep. Post-fix counts: **72 accepted-real**, **2422 known-FP** (a full-corpus strict run subsequently pruned one dead `tools R/install.R` `File not found: 'install.libs.R'` entry — SVN-trunk line drift had left two entries for the same diagnostic at old and new positions, and only the newer one still matches).

## Validation

- `cargo fmt --all --check` ✓
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings` ✓ (zero warnings)
- `cargo test -p raven`: 4739 lib + auxiliary suites, 0 failures
- Full strict run, all four groups (`RAVEN_CORPUS_GROUPS=base,recommended,tidyverse,dt`, release binary, no `RAVEN_CORPUS_ALLOW_UNCLASSIFIED`): 61 packages, 3642 observed diagnostics — base 108 (28 accepted / 80 known-FP), recommended 1345 (39 / 1306), tidyverse 2189 (35 / 2154), DT 0 — **0 unclassified, 0 stale acceptances, 0 stale FPs**. Observed counts grew vs. the previous checkpoint because warming NAMESPACE `import()` exports removed an accidental call-position suppression of uninstalled-package symbols (classified per idiom); the six triage fixes and the embedded-datasets floor cleared 293 previously-recorded FP entries (243 tidyverse + 50 base/recommended `state.*`/`Seatbelts`/`iris3` INDEX-topic gaps).

## Remaining work

### Immediate

- Accept real diagnostics for the remaining 13 base-priority packages (77 entries needed in triage fixture).
- Decide on FP fixes for base group (platform-specific functions, setGeneric NSE — 31 FPs).

### Broader follow-up

- Triage and fix recommended package false positives (priorities: `.Generic` implicit var — 45 FPs, `tmerge` NSE — 200 FPs, `data()`/`library()` loading — 2900 FPs).
- Update user-facing diagnostics docs for any externally visible behavior changes.
