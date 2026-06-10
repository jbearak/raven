# Package corpus: re-examining known false positives

The package-corpus effort accumulated a `known_false_positives.toml` fixture
of diagnostics that are incorrect but not yet fixed. They were triaged once for
"is this a real diagnostic?" This document drives a second triage on a different
axis: **can Raven suppress this without a live R session?** Tractable cases
become TDD-backed Raven fixes and leave the FP fixture; only genuinely
out-of-reach cases remain, documented as limitations.

## FP inventory by root cause (base + recommended)

| Count | Root cause | Tractability |
|------:|-----------|--------------|
| 3,247 | `data()`/`library()`/attach in test & script scope | Mostly out of reach; one tractable sub-case |
| 195 | "cross-file R/ symbol" — almost all Matrix generics from `setGeneric()` | Tractable (same cause as the 12 below) |
| 155 | `tmerge()` NSE (`tdc`/`event`/`cumevent`/`id`) in survival | Tractable as an NSE policy entry |
| 45 | `.Generic` in S4 group generics (Matrix) | Tractable |
| 12 | `setGeneric()` creates a binding | Tractable |
| 7 | Windows-only base functions (`shell.exec`, `Sys.junction`) | Tractable (static builtin list) |
| 3 | `textConnection("name", ...)` creates a var | Tractable NSE |
| ~6 | metaprogramming/`load()`/`require()`d/`plot.formula` one-offs | Mixed |
| 2 | mislabeled genuine R bugs (`x1`, `lreg1`) | Not FPs at all |

## Tiers and order of work

### Tier 0 — Fix the mislabeling (no code change)
`stats demo/smooth.R:36 x1` and `stats tests/drop1-polr.R:20 lreg1` are genuine
source bugs, not FPs. Move to accepted-reals or drop; correct the fixture.

### Tier 1 — `setGeneric()` modeling (highest value: ~207 FPs)
`setGeneric("foo", ...)` binds `foo` in the namespace. Model it so generics
defined in one R/ file resolve in sibling files and in the calling scope.
Re-run Matrix + methods slices; re-triage the remainder (`.TO`, `.CL`, `%&%`,
`TODO` in `if(FALSE)`) individually.

### Tier 2 — `.Generic`/`.Method`/`.Class` implicit variables (~45 FPs)
Inside `setMethod("Ops"|"Math"|"Summary"|"Complex", ...)` bodies (and S3 group
generics), inject `.Generic` et al. as in-scope.

### Tier 3 — Static base/platform builtins (~7 FPs)
Add Windows-only base functions (`shell.exec`, `Sys.junction`, …) to the
builtin list. Cheap, self-contained.

### Tier 4 — Tractable NSE patterns (~158 FPs)
- `textConnection("name", ...)` → bind `name` (3).
- `tmerge()` NSE policy (155): data-mask policy for `survival::tmerge`'s
  `tdc`/`event`/`cumevent`/`cumtdc`/`id`. Decide whether it belongs in Raven's
  NSE table or stays a limitation (survival-specific).

### Tier 5 — `data()` same-package sub-case (subset of 3,247)
When `data(foo)` references a dataset that exists in the same package's `data/`
dir, Raven can statically know `data()` injects `foo`. Measure coverage before
committing. Does not touch cross-package `data()`/`library()`.

### Tier 6 — Document the rest as limitations
Cross-package `data()`/`library()` attach, `load()`-restored vars,
`eval(parse())`, dynamic `source()` paths. Keep in the FP fixture; write up in
`docs/limitations.md` / `docs/diagnostics.md` NSE coverage.

## Process per tier (TDD)
1. Pull the tier's entries from `known_false_positives.toml` into a worklist.
2. Write the smallest failing test at the right seam — `nse.rs` policy test,
   in-process diagnostic test in `handlers.rs`, or process-level fixture in
   `cross_file_nse_regression.rs`. Watch it fail.
3. Implement the minimal Raven fix. Watch it pass.
4. Re-run the affected package slice; delete each now-resolved entry from
   `known_false_positives.toml`.
5. Re-run the full base + recommended strict corpus; confirm no accepted-real or
   other FP regressed.
6. `cargo fmt` + clippy + targeted tests before moving on.

## Orchestration
- Examination fans out by category (independent, read-only): child agents take a
  tier, confirm tractability against kept temp checkouts (`RAVEN_CORPUS_KEEP_TEMP=1`),
  and return a worklist + proposed test seam.
- Fixes stay centralized with the lead — they all touch `handlers.rs`/`nse.rs`/
  scope code and would conflict if parallelized.

## Definition of done
- FP fixture shrinks to only genuinely-static-undecidable cases, each with a
  clear reason.
- Each removed category has a regression test.
- `docs/diagnostics.md` (NSE coverage) and `docs/limitations.md` updated.
- Base + recommended corpus still pass strict mode.

## Expected impact
`setGeneric` + `.Generic` + builtins + `textConnection` ≈ 260 FPs are clearly
tractable. `tmerge` (155) and the `data()` same-package sub-case are
tractable-but-need-a-design-call. The ~3,200 cross-package runtime-attach cases
are the genuine static-analysis floor.

## Results (executed 2026-06)

Tiers 0–4 were implemented; Tier 5 was assessed and deferred. The known-FP
fixture shrank from 3,680 to 3,306 (**374 FPs resolved**), with zero accepted-real
diagnostics regressing.

| Tier | Fix | FPs resolved |
|------|-----|-------------:|
| 0 | Reclassified `x1`/`lreg1` as genuine R bugs (true positives) | 2 (moved to accepted-reals) |
| 1 | `setGeneric()`/`setGroupGeneric()` bind the generic name (`cross_file/scope.rs`) | 176 |
| 2 | `.Generic`/`.Method`/`.Class` in S4 `setMethod(...)` bodies (`handlers.rs`) | 45 |
| 3 | Windows-only base functions in the builtin wrapper (`handlers.rs`) | 7 |
| 4 | `textConnection("x","w")` binding + `survival::tmerge` NSE policy | 3 + 114 |
| — | (setGeneric also resolved 29 mislabeled "test-scope" methods-test FPs) | 29 |

Each fix has a red→green regression test (`scope.rs`, `handlers.rs`, `nse.rs`).

### Tier 5 (`data()` same-package) — assessed, deferred
Implementing it requires new infrastructure: exposing each package's `data/`
directory dataset names into package-mode scope resolution, plus a `data(name)`
call recognizer that consults that listing. The candidate FPs are also entangled
in a heterogeneous ~3,200-entry bucket (e.g. Matrix's ~1,100 are
`source(system.file("test-tools-Matrix.R"))` helpers, not `data()`). This is the
recommended next enhancement but was out of scope for this pass.

### Genuine static-analysis floor (kept as FPs)
The remaining 3,306 FPs are dominated by cross-package `data()`/`library()`
runtime attach in `tests/`/`inst/` scripts, test helpers loaded via
`source(system.file(...))`, `load()`-restored objects, `eval(parse())`, and
plain `tests/*.R` scripts (not `testthat`/`testit`) that reference package
internals. These need a running R session or runtime file knowledge to resolve
and are out of reach for pure static analysis.

