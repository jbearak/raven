# Package corpus checkpoint
This document records the current package-corpus hardening checkpoint on `prod-test`. It is an early checkpoint requested before the DT slice was fully cleared, so it intentionally documents both completed work and unfinished follow-up.
## Plan
The package-corpus effort adds a repeatable ignored integration suite for running `raven check --workspace <package> --format json --max-severity error --no-config` against real R package sources. The intended workflow is:
1. Fetch package sources from a manifest-backed source strategy.
2. Run Raven in package mode against each package root.
3. Fail on unclassified diagnostics.
4. Treat accepted real diagnostics as fixture entries with evidence.
5. Turn suspected Raven false positives into failing tests first, then minimal Raven fixes.
6. Re-run affected package slices after each fix.
Base and DT were chosen as the first review checkpoint before continuing with the recommended and tidyverse groups.
## Corpus runner status
The runner lives in `crates/raven/tests/package_corpus.rs`, with fixtures under `crates/raven/tests/fixtures/package_corpus/`. It is ignored by default because it fetches package sources and runs a long static-analysis corpus. Reports are written under `target/package-corpus/`, including command metadata, package source metadata, stderr notes, and JSON diagnostics.
The accepted-real fixture currently records confirmed diagnostics for the `base` package in `accepted_real_diagnostics.toml`.
## Triage findings so far
Package-group triage identified these recurring diagnostic classes:
* Real style diagnostics in upstream package code, especially mixed `&&`/`||` precedence warnings and intentional string-literal assignment targets.
* Native-interface NSE gaps where the first argument names a C/native routine rather than an R symbol.
* Package-test scope gaps where tests need package namespace and helper-file context.
* Scope-removal false positives when internal R primitives look syntactically like user-level calls.
* Environment-modeling gaps for startup/search-path bindings that are available at runtime but not defined in the package namespace.
## Implemented Raven fixes
The checkpoint includes these TDD-backed fixes:
* `.Internal(remove(...))` no longer creates synthetic `rm`/`remove` scope-removal events for formal arguments.
* `.Autoloaded` is modeled as an implicit startup search-path binding.
* `.External.graphics` now treats the first argument as a native routine name, matching existing native-interface handling.
* String-literal assignment targets still warn, but also create scope bindings so downstream uses, including replacement functions, resolve correctly.
* Package-corpus parsing and accepted-real fixture validation were added around the new runner.
## Base package status
The `base` package slice was cleared to only accepted real diagnostics. The accepted entries are:
* Mixed `&&`/`||` precedence warnings in `R/RNG.R`, `R/character.R`, `R/dataframe.R`, and `R/match.fun.R`.
* String-literal assignment warnings in `R/all.equal.R`, `R/library.R`, and `R/namespace.R`.
Each accepted entry was confirmed by applying a minimal edit in a temporary package checkout and verifying that the corresponding diagnostic disappeared.
## DT status
`testit` was installed locally because DT's test suite uses `testit::test_pkg`. After installation, the previous missing `assert` and `test_pkg` export noise disappeared, but DT still reports undefined variables in `tests/testit/*`.
The current diagnosis is that Raven does not yet model `tests/testit/` with the package namespace and test helper environment that `testit::test_pkg` creates. The likely next fix is to extend the package-test scope classification and helper contribution logic from `tests/testthat/` to `tests/testit/`, with regressions proving that DT-style testit files can see package internals, imports, and helper definitions.
## Remaining work
Immediate follow-up:
* Finish the DT `tests/testit/` package-test context fix.
* Re-run the DT corpus slice in strict mode.
* Update accepted-real fixtures only for confirmed real DT diagnostics, if any.
* Run targeted regressions, `cargo fmt --all --check`, and clippy.
Broader follow-up:
* Continue classifying the remaining base-priority packages outside the `base` package itself.
* Re-run and triage the recommended package group.
* Re-run and triage DT plus tidyverse after the package-test modeling changes.
* Update user-facing diagnostics docs only for externally visible behavior changes, and development docs only for internal architecture/debugging guidance.
## Useful report paths from this checkpoint
* `target/package-corpus/base-package-cleared/latest.json`
* `target/package-corpus/base-group-after-graphics-string-binding-fixes/latest.json`
* `target/package-corpus/dt-after-testit-install/latest.json`
