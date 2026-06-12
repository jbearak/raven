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
- **Follow-up (issue #430):** nine more deterministic recognizers landed for the constructs deferred from #427, clearing 109 ledger entries (2260 → 2151): binding forms — `makeActiveBinding("name", …)` in `.onLoad`/`.onAttach` (27, cli), top-level `delayedAssign("name", …)` (lubridate, Matrix), `env_bind_active`/`env_bind_lazy(current_env(), …)` (rlang), `utils::globalVariables(c(...))` honored package-wide (hms, dbplyr, tidyr, dtplyr, broom, methods, Matrix; the bare `.` pronoun is excluded), and `devtools::load_all()` scripts modeled as attaching the package (googledrive, googlesheets4, readxl); pipe/verb placeholders — `.` in `dplyr::do()` and `all_vars()`/`any_vars()`, the `%$%` exposition operator's data-masked RHS, and the leading `.` of a `. %>% …` functional sequence. All scoped so a bare `.` in a native `|>` pipe stays flagged. 109 = the ~92 targeted entries plus 17 further entries cleared by the same general mechanisms (globalVariables/delayedAssign/load_all). Full 4-group strict run stays green (0 unclassified / 0 stale acceptances / 0 stale FPs).

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

After installing the CRAN-available corpus packages (51 of 51, including
`magick` once system ImageMagick is present), a full four-group strict run was
reconciled against the ledger:

- **998 stale false-positive entries pruned** in the main strict-run sweep (a
  further 3 ragg `image_*` entries pruned afterwards once `magick` was
  installed — see below) — symbols that now resolve because
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
  packages (`revdepcheck`, `googlesheets`, `robust`, in-repo fixtures).

Ledger size: `known_false_positives.toml` 3336 → 2428 entries (1001 pruned, 93
added). `accepted_real_diagnostics.toml` unchanged (0 stale acceptances).
Installing the R `magick` package (against system ImageMagick) pruned the last
3 of those entries — ragg's `image_read`/`image_crop`/`image_sample` in
`vignettes/ragg_quality.Rmd` now resolve.

## Lazy-data ledger prune (#429) — 2026-06-11

This branch's lazy-data enumeration plus `data()` alias expansion lets Raven
resolve a large class of dataset symbols it previously flagged. A full
four-group strict run reported **677 stale false-positive entries** — symbols
Raven no longer emits — which were pruned in a single sweep keyed on the
runner's `stale-fp:` report (package + path + start position + message):
survival 540, broom 81, lattice 15, forcats 12, MASS 6, googlesheets4 5,
reprex 4, dplyr 4, stats 3, KernSmooth 3, rpart 2, readr 1, ragg 1.

Sysdata triage: all 25 remaining `R/sysdata.rda` entries (cli's `emojis`,
`spinners`, `rstudio_themes`, `gfycat_*`, `wide_chars`; readr's `date_symbols`)
are referenced from within their owning package's own `R/` sources, where the
objects are namespace-internal but in-scope under package/`load_all` semantics.
None is a user-level reference, so none was reclassified to `AcceptedReal`;
they remain false positives and a known package-mode machinery gap (Raven does
not yet treat a package's own `sysdata.rda` objects as in-scope for its `R/`
code).

Ledger size: `known_false_positives.toml` 2151 → 1474 entries (677 pruned, 0
reclassified). `accepted_real_diagnostics.toml` unchanged (0 stale
acceptances). The re-run is clean: 0 unclassified, 0 stale acceptances, 0 stale
FPs.

## Sysdata ledger prune (#429) — 2026-06-11

The sysdata gap flagged in the triage above is closed. Two fixes, each keyed
to why the package-mode sysdata machinery missed the fetched sources:

1. **`devtools::use_data` in the AST scan** (`package_state/sysdata.rs`) —
   readr's `data-raw/date-symbols.R` writes sysdata via the historic
   `devtools::use_data(date_symbols, internal = TRUE)` re-export, which the
   scanner only matched as `use_data` / `usethis::use_data`.
2. **R-subprocess sysdata fallback in `raven check`**
   (`cli/check.rs::maybe_load_sysdata_fallback`) — r-lib/cli commits the
   binary `R/sysdata.rda` with no `data-raw/` generating script at all, so
   only the load-the-`.rda` fallback can enumerate its objects. That fallback
   previously ran only in the LSP startup path; the corpus drives the CLI,
   which never invoked it. The trigger predicate is now single-sourced
   (`backend::sysdata_r_fallback_needed`) and both paths run it.

The negative invariant holds: sysdata names feed only package-mode scope, so
`library(cli); emojis` in a user script still flags
(`data_alias_acceptance_with_real_r` pins this).

A full four-group strict run reported **33 stale false-positive entries**, all
pruned keyed on the `stale-fp:` report: the 25 ledgered sysdata entries (cli
23 — `emojis`, `spinners`, `rstudio_themes`, `gfycat_*`, `wide_chars`; readr
2 — `date_symbols`) plus 8 base-group entries the fallback also fixed —
`tools` (`IANA_URI_scheme_db`, `table_of_HTTP_status_codes`) and `utils`
(`MARC_relator_db`), previously ledgered as "lazily loaded dataset in tools
package" but actually `R/sysdata.rda` objects in the R sources.

Ledger size: `known_false_positives.toml` 1474 → 1441 entries (33 pruned, 0
reclassified). `accepted_real_diagnostics.toml` unchanged (0 stale
acceptances). The run is otherwise clean: 0 unclassified, 0 stale acceptances.

## Follow-up fix: data-mask propagation through tidy-eval wrappers (#433)

A locally-defined function that embraces a formal (`{{ param }}`) into a call
argument, defuses its `...` through an `en`-plural capture helper
(`enquos(...)` and friends), or forwards `...` directly into a covered verb's
data-mask position is now itself data-masking: call-site arguments bound to
those formals are exempt from undefined-variable analysis, and the default
expression of a defused formal is exempt at the definition site. Defusal is
lexical, so the inference descends through nested closures
(`lapply(xs, function(d) filter(d, {{ cond }}))`) minus shadowed names; the
dots-forwarding half resolves the inner verb one level deep through the
built-in policy tables, and local shadowing (top-level or body-local) disables
it.

Ledger impact: 71 entries pruned (1441 → 1370) — dplyr test helpers and
vignettes (`programming.Rmd`, `rowwise.Rmd`, `test-join-by.R` dots-forwarding
wrappers, `test-conditions.R` embraces), dbplyr `test-tidyeval-across.R`,
dtplyr, haven (`col_select = {{ x }}`), ggplot2 `ggplot2-in-packages.qmd`, and
the rlang `man/rmd` topic examples. Full 4-group strict run stays green
(0 unclassified / 0 stale acceptances / 0 stale FPs).

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
