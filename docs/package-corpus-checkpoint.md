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

## Follow-up fix: testthat helper `library()` attach propagation (#432)

PR #427 made top-level **definitions** in `tests/testthat/helper*.R` / `setup*.R`
visible to sibling test files, but `library()`/`require()` **attaches** in those
same preamble files still didn't propagate. Issue #432 closes that gap: a
top-level attach in a preamble file (e.g. dtplyr's
`tests/testthat/helpers-library.R` attaching dplyr + tidyr) now flows into the
`inherited_packages` of every sibling test file, mirroring testthat sourcing the
preamble before each test. One-way visibility is preserved (attaches never reach
`R/`), the source-order gate matches the helper-symbol path, and the
CLI/editor export prefetch is fed so the attached package's exports are warmed.

Two correctness refinements from pre-PR review: (1) attaches captured by a
non-evaluating quoting wrapper (`quote()`/`bquote()`/`substitute()`/
`expression()`, rlang's `expr`/`quo`/…) are excluded — they never evaluate at
source time, so propagating them would falsely suppress diagnostics; (2)
propagation is restricted to test files in the *same directory* as the preamble,
so `tests/testthat/` preambles never leak into `tests/testit/` siblings (testit
does not source them). The same-directory gate lives in the shared
`visible_preamble_entries` helper, so it applies to preamble *definitions*
(PR #427) as well as attaches — closing the same latent cross-framework leak for
both.

Ledger impact: the 204 dtplyr known-FP entries carrying
`reason = "function from a package attached by a testthat helper file, package
not installed in the analysis environment"` (203) and
`"package attached via library() in testthat helper file"` (1) were pruned —
the "not installed" framing was wrong (dplyr/tidyr are installed); the actual
cause was the attach-propagation gap, now fixed. The remaining 8 dtplyr entries
(data-masked columns, an `enquo()` default, a standalone vignette script) are
unrelated idioms and stay. Other groups' "library()-attached package not
installed" entries are a *different* idiom (attach in the test/script file
itself, not a preamble file) and are unaffected by this fix.

## Prior fixes (from earlier checkpoint)

- `.Internal(remove(...))` no longer creates synthetic scope-removal events.
- `.Autoloaded` modeled as implicit startup binding.
- `.External.graphics` treats first argument as native routine name.
- String-literal assignment targets create scope bindings for downstream resolution.

## Ledger reclassification (prod-test)

153 entries were moved from `accepted_real_diagnostics.toml` to `known_false_positives.toml`. All had the message `Assigning to string literal "…"` and fell into one of two idiom classes that Raven over-flagged: (a) S3/replacement/operator method definitions via quoted-string LHS (e.g. `"[.Surv" <- function(...)`, `"coef<-.varPower" <- function(...)`) — semantically identical to the backtick form and standard R practice; (b) R-core's datasets package `data/*.R` files (`"iris" <- ...`, `"AirPassengers" <- ...` — 55 entries) which use the canonical quoted-name form.

The follow-up fix has since landed: `check_invalid_assignment_target` exempts string-literal targets whose assigned value is a function definition (including parenthesized, chained `"a" <- "b" <- function(...)`, and `.Primitive(...)` forms), and top-level string assignments in package `data/*.R` files (URI-based, see `is_package_data_file`). A 16-package corpus re-run (survival, nlme, MASS, datasets, tcltk, lattice, base, methods, stats, dbplyr, foreign, ggplot2, httr, lubridate, mgcv, stringr) confirmed the entries are no longer emitted; 152 were pruned from the FP ledger and 1 (`base R/all.equal.R` `"__all.eq.E__" <- environment()` — a dynGet sentinel, not a function definition) was moved back to accepted-real alongside its sibling sentinel entries. The stale-FP report now also covers run packages with zero observed diagnostics — previously a fully-cleared package was silently skipped by the staleness sweep. Post-fix counts: **72 accepted-real**, **2422 known-FP** (a full-corpus strict run subsequently pruned one dead `tools R/install.R` `File not found: 'install.libs.R'` entry — SVN-trunk line drift had left two entries for the same diagnostic at old and new positions, and only the newer one still matches).

## Environment provisioning and ledger reconcile (#428)

The corpus only produces a reproducible strict run on a machine where the
packages the corpus sources `library()`-attach are installed: Raven resolves an
attached package's exported symbols only when that package is installed in the
analysis environment's R library. The provisioning step (the `install.packages`
list, the `magick` → system-ImageMagick prerequisite, and the four
not-installable packages — `async`, `css`, `googlesheets`, `revdepcheck`) is
documented at the top of the corpus runner module (`crates/raven/tests/package_corpus.rs`),
where a contributor sees it alongside the run commands.

After installing the CRAN-available corpus packages (50 of 51; `magick` still
needs system ImageMagick), a full four-group strict run was reconciled against
the ledger:

- **998 stale false-positive entries pruned** — symbols that now resolve because
  their package is installed (and entries re-anchored after upstream git-source
  line drift). Stale FPs are informational in the runner, so this is a manual
  sweep driven by the `stale-fp:` report.
- **93 newly-surfaced diagnostics classified**, all false positives, by idiom:
  29 lazy-loaded datasets of installed packages (the #429 LazyData gap —
  `lung`, `ovarian`, `dat.bcg`, `HolzingerSwineford1939`, `wine`, …); 27
  data-masked column names in model-fitting NSE (`metafor::escalc`/`rma`,
  `drc::drm`); 20 objects loaded from a binary `.rda` fixture via
  `load(test_path(...))` (broom's joineRML tests); 15 drake NSE references
  (`drake_plan()` target cross-references and `readd()`/`loadd()` target names)
  in pillar's revdep scripts; 2 cli symbols attached by `library()` inside a
  `load_packages()` helper function.
- **38 entries re-reasoned** to drop a now-false "package not installed" claim:
  32 dataset entries whose packages are installed (datasets shift to the
  lazy-data idiom rather than clearing — `starwars`→dplyr, `gapminder`→gapminder,
  `dat.yusuf1985`→metadat, `pigs`/`oranges`/`auto.noise`→emmeans, `diamonds`→
  ggplot2, `heart.valve`→joineRML), plus 6 function entries (broom `test-car.R`
  `leveneTest` — car is installed but attached only via an earlier test file's
  Depends chain, not in this file; dtplyr `benchmark.R` `summarise_at` — dplyr is
  installed but the standalone script has no `library()` attach). After this, no
  ledger entry claims a package is uninstalled when it is installed: the only
  remaining "not installed" function symbols belong to genuinely uninstalled
  packages (`magick`, `revdepcheck`, `googlesheets`, `robust`, in-repo fixtures).

Ledger size: `known_false_positives.toml` 3336 → 2431 entries (998 pruned, 93
added). `accepted_real_diagnostics.toml` unchanged (0 stale acceptances).

## Validation

- `cargo fmt --all --check` ✓
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings` ✓ (zero warnings)
- `cargo test -p raven`: full lib + auxiliary suites, 0 failures
- Corpus non-ignored tests (`fp_fixture_is_parseable`, `triage_fixture_is_parseable_and_unique`, `manifest_*`) ✓
- Full strict run, all four groups (`RAVEN_CORPUS_GROUPS=base,recommended,tidyverse,dt`, release binary, no `RAVEN_CORPUS_ALLOW_UNCLASSIFIED`): **0 unclassified, 0 stale acceptances, 0 stale FPs** on the provisioned machine.

## Remaining work

### Immediate

- Accept real diagnostics for the remaining 13 base-priority packages (77 entries needed in triage fixture).
- Decide on FP fixes for base group (platform-specific functions, setGeneric NSE — 31 FPs).

### Broader follow-up

- Triage and fix recommended package false positives (priorities: `.Generic` implicit var — 45 FPs, `tmerge` NSE — 200 FPs, `data()`/`library()` loading — 2900 FPs).
- Update user-facing diagnostics docs for any externally visible behavior changes.
