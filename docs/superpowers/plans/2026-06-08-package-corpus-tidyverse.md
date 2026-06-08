# Plan: tidyverse corpus false-positive triage + fixes

## Goal
Bring the `tidyverse` corpus group to the same clean, strict-mode state as
`base` and `recommended`: every observed `raven check` diagnostic is either an
**accepted real** diagnostic (a genuine bug Raven correctly flags) or a
**known false positive** (documented, out of static reach), and every
statically-tractable false-positive *category* is converted into a TDD-backed
Raven fix. End state: `RAVEN_CORPUS_GROUPS=base,recommended,tidyverse` passes in
strict mode with no unclassified diagnostics and no stale accepted-reals.

## Group contents (from `crates/raven/tests/package_corpus.rs`)
~33 packages, mostly GitHub dev versions: broom, cli, conflicted, dbplyr,
dplyr, dtplyr, forcats, ggplot2, googledrive, googlesheets4, haven, hms, httr,
jsonlite (CRAN), lubridate, magrittr, modelr, pillar, purrr, ragg, readr,
readxl, reprex, rlang, rstudioapi, rvest, stringr, tibble, tidyr, xml2 (CRAN),
tidyverse. (DT is its own `Dt` group, already clean — not in scope.)

## Why this group is different
These are the most NSE-heavy packages in R. Expect the dominant FP source to be
**data-masking / tidy-select / rlang injection** patterns, not undefined
locals. The existing `nse.rs` policy table already covers the common
dplyr/tidyr/ggplot2/tibble/rlang surface, and the recently added recognizers
(`data()`, same- and cross-package `system.file()`, plain `tests/*.R`
package-symbol injection) should pre-clear several categories. The new work is
mostly **extending the NSE policy table** for uncatalogued internal verbs and
helpers these packages use on themselves, plus identifying genuinely-dynamic
patterns that stay known-FPs.

## Process (mirrors the base/recommended effort)

### Phase 1 — Capture + triage (NO code changes)
1. Run `RAVEN_CORPUS_GROUPS=tidyverse RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1 cargo
   test -p raven --test package_corpus -- --ignored --nocapture` to write
   `target/package-corpus/latest.json`. (Network + the tidyverse packages must
   be fetchable; many are GitHub dev versions. If fetch fails, report which.)
2. Bucket every diagnostic by `(message-prefix, package)` and by file location
   (`R/`, `tests/`, `tests/testthat/`, `inst/`, `vignettes/`, `data-raw/`).
3. Classify representative samples in each bucket into:
   - **accepted-real** — genuine bug (undefined symbol that is truly undefined,
     a real used-before-defined, etc.). Add to `accepted_real_diagnostics.toml`
     with evidence + minimal_edit.
   - **known-FP** — correct code Raven can't resolve statically. Add to
     `known_false_positives.toml` with a `reason`.
   - **tractable-FP** — a category Raven *could* suppress with a bounded fix
     (almost always an NSE policy gap). Collect into a fix list with the
     proposed `package_policy` entry.
4. Produce a written triage report (`docs/superpowers/plans/2026-06-08-tidyverse-triage.md`)
   with bucket counts and the tractable-FP fix list. This report drives Phase 2.

### Phase 2 — Implement tractable fixes (TDD)
For each tractable category from the triage report, add/extend the relevant
recognizer — overwhelmingly `nse.rs::package_policy` entries (e.g. an
uncatalogued data-masking or tidy-select verb gets a `PerFormal`/blanket-capture
policy). Each fix gets a red→green unit test in `nse.rs`. Stay conservative:
only suppress arguments that are genuinely captured/data-masked; never blanket-
suppress a standard-eval callee (that would hide real bugs). Anything not
clearly tractable stays a known-FP.

Likely categories to expect (confirm against triage, do not pre-implement):
- internal data-mask verbs/helpers used package-on-itself not yet in the table;
- `.data` / `.env` pronoun edge cases;
- tidyselect helpers beyond the catalogued set;
- glue/`str_glue` interpolated names (likely known-FP, not tractable);
- `rlang::`/`purrr` injection helpers (`inject`, `exec`, `as_function`/`as_mapper`
  lambda `.x`/`.y`/`..1`) — check whether already modeled.

### Phase 3 — Regenerate + verify
1. Re-run with `RAVEN_CORPUS_GROUPS=base,recommended,tidyverse
   RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1` and regenerate `known_false_positives.toml`
   keeping only still-observed entries (key = package/path/message/0-based
   range). Preserve base+recommended entries that are still observed.
2. Verify ZERO accepted-reals went stale (across all three groups) and ZERO
   `Cannot resolve path` entries.
3. **Over-suppression guard:** confirm the Phase-2 NSE additions did not erase
   any accepted-real diagnostic in any group. Any accepted-real that vanished is
   a regression to investigate, not a win.
4. Strict mode: `RAVEN_CORPUS_GROUPS=base,recommended,tidyverse cargo test -p
   raven --test package_corpus -- --ignored` must PASS.

### Phase 4 — Docs
- `docs/diagnostics.md`: add any new NSE-policy coverage to the limitations
  paragraph's enumerated list.
- Record final counts in this plan / the triage report.

## Gating (every code stage)
`cargo fmt --all --check`; `cargo clippy --workspace --all-targets --features
test-support -- -D warnings` (zero warnings); `cargo test -p raven`; root-level
`bun test`. Independent reviewer must APPROVE.

## Constraints
- Follow AGENTS.md. Prefer fixing lint root cause; narrowly-scoped `#[allow]`
  with a one-line reason only for genuine exceptions.
- Do NOT git commit unless explicitly asked.
- Do NOT regress base/recommended: their accepted-reals and still-valid known-FPs
  must survive the regeneration.
- Bias toward NO false positives but NEVER at the cost of masking a real bug:
  when unsure whether a category is data-masked, leave it as a known-FP rather
  than adding an over-broad policy.

## Out of scope
- The `Dt` group (already clean).
- New recognizer *infrastructure* beyond NSE policy entries, unless triage
  reveals a high-volume tractable category that genuinely needs it (escalate
  with a sub-plan rather than improvising).
