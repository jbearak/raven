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

The accepted-real fixture (`accepted_real_diagnostics.toml`) records 10 confirmed diagnostics for `base`.

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

- Not yet triaged — deferred to follow-up.

## Implemented Raven fixes (this checkpoint)

1. **testit scope:** Extended package-test scope classification from `tests/testthat/` to `tests/testit/`. Files under `tests/testit/**/*.R` now get namespace injection (package internals + imports + exports), matching testthat behavior. Unit test + process-level regression added.

2. **Stale test fixes:** Updated `namespace_with_sources_activates_package_mode_without_description` derive test to match the intentional `has_namespace_and_sources` fallback. Renamed `test_normalize_preserves_comments` → `test_normalize_strips_comments` to match actual correct normalize behavior.

3. **Clippy cleanup:** Fixed 8 pre-existing lints (`nonminimal_bool`, `collapsible_if`, `too_many_arguments`, `redundant_closure`) in `handlers.rs` and `source_detect.rs`.

## Prior fixes (from earlier checkpoint)

- `.Internal(remove(...))` no longer creates synthetic scope-removal events.
- `.Autoloaded` modeled as implicit startup binding.
- `.External.graphics` treats first argument as native routine name.
- String-literal assignment targets create scope bindings for downstream resolution.

## Validation

- `cargo fmt --all --check` ✓
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings` ✓ (zero warnings)
- 4488 lib + 11 regression + 103 indent + 7 corpus + 3 pkg_db + 55 other = 4667 tests pass
- `base` corpus: strict mode pass (10 accepted reals, 0 unclassified)
- DT corpus: strict mode pass (0 diagnostics)

## Remaining work

### Immediate

- Accept real diagnostics for the remaining 13 base-priority packages (77 entries needed in triage fixture).
- Decide on FP fixes for base group (platform-specific functions, setGeneric NSE — 31 FPs).

### Broader follow-up

- Triage and fix recommended package false positives (priorities: `.Generic` implicit var — 45 FPs, `tmerge` NSE — 200 FPs, `data()`/`library()` loading — 2900 FPs).
- Triage tidyverse package group.
- Update user-facing diagnostics docs for any externally visible behavior changes.
