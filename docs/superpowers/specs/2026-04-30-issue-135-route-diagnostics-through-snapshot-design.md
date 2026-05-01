# Design: Route `diagnostics()` Through the Snapshot Path; Delete Legacy Collectors

**Date:** 2026-04-30
**Issue:** [#135](https://github.com/jbearak/raven/issues/135)
**Branch:** TBD (off `main`)

---

## Problem

`crates/raven/src/handlers.rs` has two parallel diagnostic implementations that have drifted apart:

- **Legacy path** — `pub fn diagnostics()` (handlers.rs:3603) calls per-collector legacy fns:
  `collect_out_of_scope_diagnostics`, `collect_undefined_variables_position_aware`,
  `collect_max_depth_diagnostics`, `collect_missing_file_diagnostics`,
  `collect_missing_package_diagnostics`, `collect_redundant_directive_diagnostics`.
- **Snapshot path** — `diagnostics_from_snapshot()` (handlers.rs:264), driven by
  `DiagnosticsSnapshot::build`, calls the `*_from_snapshot` collector variants. Used
  in production by the debounced pipeline `run_debounced_diagnostics`.

CLAUDE.md flags the burden ("BOTH must be fixed") and PR #134 is the most recent
example: it had to fix five rm()-related call sites across both paths, and during
that PR five legacy↔snapshot deviations surfaced in `collect_out_of_scope_diagnostics`
alone. PR #134 ported three of them in-place (commit `2ce059f`); two remain
(see issue #135 for details).

Drift survived because the legacy out-of-scope tests are narrow: severity-off,
local parameter/loop-name suppression, and dedup across multiple source calls.
None exercise `@lsp-cd`, workspace-root fallback, `local=TRUE`, or non-global
`sys.source`. Every drift fix is one missing check away from the next regression.

## Goal

Eliminate the legacy diagnostic path:

1. `pub fn diagnostics()` becomes a thin wrapper around the snapshot path.
2. Legacy-only collectors and their direct-call tests are deleted.
3. New tests cover the parity gaps that allowed the drift to survive.
4. CLAUDE.md is updated to drop the "BOTH must be fixed" note.

## Non-goals

- No changes to `diagnostics_from_snapshot()` or any `*_from_snapshot` collector.
- No new diagnostic categories. No changes to `DiagCancelToken` semantics.
- No changes to the watched-files revalidation walk (`compute_affected_dependents_after_edit`).
- No regression test or benchmark for the watched-files cascade beyond what
  `cargo bench --bench lsp_operations -- lsp_diagnostics` already covers (we may
  add a `large` fixture variant in Phase 2 if existing fixtures don't surface
  snapshot-build cost; see Phase 2 below).

---

## Approach

### Phasing

Single feature branch off `main`. Each phase is a commit (or small commit
series) followed by a `codex:rescue` review gate before proceeding.

#### Phase 1 — Add gap-coverage tests against the legacy path

Two test categories. PR #134 fixed three of the five originally-reported
deviations in-place (memoization, `inherits_symbols()` filter, and
`PathContext::from_metadata` path resolution — all confirmed present in legacy
as of `main`). Two deviations remain. Phase 1 covers both.

**Category A — Regression locks** (already pass on legacy as of `main`; we lock
them in so the path resolution and `inherits_symbols()` filter cannot regress):

| Area | Test shape | Status on legacy |
|---|---|---|
| `@lsp-cd` resolves AST `source()` targets relative to the directive's base | parent file declares `@lsp-cd subdir/`; sources `helper.R` from there; child uses a sibling-not-yet-sourced symbol | Passes (handlers.rs:5677 uses `PathContext::from_metadata`) |
| Workspace-root fallback for unannotated `source("rel.R")` | parent file at `<workspace>/scripts/main.R` does `source("scripts/helper.R")`; resolves via workspace root | Passes (handlers.rs:5731 uses `resolve_path_with_workspace_fallback`) |
| `source(..., local=TRUE)` does not flag "used before sourced" | parent uses a symbol the local-sourced file defines; should be a true undefined, not a "used before sourced" | Passes (handlers.rs:5721 filters via `inherits_symbols()`) |
| `sys.source(..., envir=new.env())` does not flag "used before sourced" | same shape, with `sys.source` and a non-global env | Passes (same filter at 5721; `inherits_symbols()` returns false) |
| `sys.source(..., envir=globalenv())` DOES participate in "used before sourced" | confirms the filter distinguishes global from non-global env | Passes |

**Category B — Failing-on-legacy parity gaps** (the two remaining deviations
from issue #135):

| Area | Test shape | Status on legacy | Mark |
|---|---|---|---|
| Broader "already in scope" suppression (deviation #4) | a symbol is in scope through some non-source mechanism (e.g., a parent-file declaration via backward edge) AND is also defined in a file sourced after the use site; legacy flags "used before sourced," snapshot suppresses | Fails | `#[ignore = "legacy parity gap; un-ignored in Phase 3 (issue #135)"]` |
| Source-call-site defense-in-depth (deviation #5) | the `xyz <- xyz` self-leak shape: queried URI defines `xyz` at top-level, AST-sources another file that ALSO defines `xyz`; legacy emits "used before sourced" without verifying `source_uri` differs | Fails | `#[ignore = "legacy parity gap; un-ignored in Phase 3 (issue #135)"]` |

Tests run through `pub fn diagnostics()` so they exercise the legacy path during
Phases 1–2 and the snapshot path from Phase 3 onward. The full test suite must
pass — failing-on-legacy tests are ignored, so the tree is green.

**Why this order?** The tests document the parity gap before the legacy code
goes away. After Phase 3 the ignored tests un-ignore and prove parity by
passing.

→ **codex:rescue gate:** review test coverage adequacy; confirm tests actually
exercise the deviation areas (not just lookalike shapes); flag any missed
sub-cases.

#### Phase 2 — Capture pre-delegation benchmark baseline

Run `cargo bench --bench lsp_operations -- lsp_diagnostics` on Phase-1's tip
(legacy path still in place). Save Criterion's mean/median output to
`docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` and commit. This
captures the legacy-path numbers for `small_10` and `medium_50` fixtures.

If `bench_diagnostics` doesn't exercise a workspace large enough to surface
snapshot-build cost (e.g. neighborhood pre-collection), add a `large` fixture
variant or extend existing fixtures in this phase. The decision is informed by
codex:rescue's recommendation in the gate below.

→ **codex:rescue gate:** sanity-check baseline numbers; recommend whether to
add a `large` fixture or a new bench targeting the watched-files cascade. The
production sync caller is `Backend::publish_diagnostics` at backend.rs:4135;
watched-files fanout reaches it via `publish_diagnostics_via_arc` /
`publish_diagnostics`. The fanout itself (one publish per affected URI per
edit) is the cost characteristic the existing per-URI bench may not cover; if
needed, propose a new bench shape.

#### Phase 3 — Delegate `diagnostics()` to the snapshot path

1. Lift `diagnostics_via_snapshot` out of `#[cfg(feature = "test-support")]`
   (handlers.rs:3558–3569). Drop the `#[allow(dead_code)]` since it now has a
   real production caller.
2. Replace the body of `pub fn diagnostics()` (handlers.rs:3603) with the
   early-return guards (master switch off, non-R, no document, no tree) followed
   by a call to `diagnostics_via_snapshot(state, uri, cancel)`. The early returns
   are preserved because they short-circuit before `DiagnosticsSnapshot::build`
   does any work.
3. Un-ignore the Phase 1 Category-B tests that were marked failing-on-legacy.
   Update their `#[ignore]` attributes — remove them entirely.
4. Add `#[allow(dead_code)]` to the six legacy collectors that Phase 5 will
   delete (`collect_out_of_scope_diagnostics`, `collect_undefined_variables_position_aware`,
   `collect_max_depth_diagnostics`, `collect_missing_file_diagnostics`,
   `collect_missing_package_diagnostics`, `collect_redundant_directive_diagnostics`).
   The annotations are temporary and removed in Phase 5; they keep the tree
   warning-free during the inter-phase window. Each annotation gets a comment
   `// removed in Phase 5 (issue #135)`.
5. Run `cargo test -p raven` and `cargo build -p raven`. Both must be green
   (no warnings).

**Definition of "green phase boundary":** zero compiler warnings, zero test
failures, zero ignored tests added by this PR (the Category-B tests are
un-ignored in step 3; the Category-A tests were never ignored).

→ **codex:rescue gate:** parity audit of:
- `crates/raven/src/backend.rs:4135` — the only direct production caller, inside
  `Backend::publish_diagnostics`. Watched-file fanout reaches this site
  indirectly through `publish_diagnostics_via_arc` / `publish_diagnostics`
  (backend.rs ~3183, ~3196, ~4099).
- `crates/raven/benches/lsp_operations.rs:263` — bench harness.
- `handlers::diagnostics_async_standalone` (handlers.rs:3843) is the live async
  caller in both debounced and sync publish paths; it consumes the `Vec<Diagnostic>`
  returned by `diagnostics()` and adds async missing-file checks. After Phase 3
  the input `Vec<Diagnostic>` comes from the snapshot path; behavior should be
  unchanged because `diagnostics_async_standalone` does not introspect the
  passed diagnostics.
Plus: confirm `DiagnosticsSnapshot::build` acquires no fresh `state.write()`
or `state.read()` locks (verified at handlers.rs:115, 147, 198 — it takes
`&WorldState` and reads from already-borrowed fields).

#### Phase 4 — Re-run benchmarks; confirm no regression

Re-run `cargo bench --bench lsp_operations -- lsp_diagnostics`. Append results
to the baseline doc with a delta column.

**Acceptance threshold (compound; ALL conditions must hold to proceed):**

1. **Confidence-interval gate, not point-estimate.** Use Criterion's
   `change.lower_bound` and `change.upper_bound` from its noise-detection
   output. The 95% CI's lower bound on percent change must be `<= 15%` on
   `medium_50` (or the new `large` fixture, if added in Phase 2). Mean-only
   comparisons at sample size 20 are too noisy to gate on.
2. **Absolute floor.** Per-iteration mean increase must be `<= 5 ms` on every
   fixture, regardless of the percentage. This catches scenarios where a small
   workspace's `+30%` is meaningless (200µs → 260µs) but a `medium_50`'s `+10%`
   is meaningful (40ms → 44ms).
3. **No regression on a fanout-shaped fixture.** If Phase 2 added a `large`
   fixture or new bench targeting the watched-files cascade, that fixture is
   subject to (1) and (2) too.

If any gate fails, investigate before proceeding:
- Profile the snapshot build: cycle detection (`detect_cycle`) and neighborhood
  collection (`cached_neighborhood_subgraph`) are the candidates.
- Determine if a sync caller can hold a `DiagnosticsSnapshot` and reuse it
  across multiple `diagnostics()` calls (relevant only if many calls happen for
  the same URI back-to-back, which is unlikely in production).
- Worst case: revert Phase 3 and re-scope the issue.

→ **codex:rescue gate:** review CI bounds and absolute deltas against all three
gates; recommend proceed-to-5 or investigate.

#### Phase 5 — Delete legacy collectors and migrate tests

Delete (and remove their `#[allow(dead_code)]` annotations from Phase 3):
- `collect_out_of_scope_diagnostics` (handlers.rs:5609)
- `collect_undefined_variables_position_aware` (handlers.rs:8196)
- `collect_max_depth_diagnostics` (handlers.rs:4471)
- `collect_missing_file_diagnostics` (handlers.rs:4113)
- `collect_missing_package_diagnostics` (handlers.rs:4573)
- `collect_redundant_directive_diagnostics` (handlers.rs:4651)
- Any helpers exclusively used by the above (e.g. legacy `get_cross_file_scope`
  shapes if no snapshot caller). Use `cargo build` warnings to find them.

**Do NOT delete:**
- `collect_syntax_errors`, `collect_else_newline_errors`,
  `collect_invalid_line_param_diagnostics` — shared by both paths.
- The async missing-file helpers around handlers.rs:3867 (e.g. the body
  consumed by `diagnostics_async_standalone`). Despite the name overlap, these
  are distinct from `collect_missing_file_diagnostics` and remain live.
- `diagnostics_async_standalone` itself (handlers.rs:3843) — live async caller.
  `diagnostics_async` (handlers.rs ~3796) is dead code and a candidate for
  deletion, but is OUT OF SCOPE for this PR.

Migrate or delete the ~57 in-file tests that call these legacy collectors
directly. The migration target is one of:

1. **Replace direct call with `diagnostics_via_snapshot`** — the test asserts
   on resulting `Diagnostic` shape. Lifts identically into the snapshot path.
2. **Replace direct call with the matching `*_from_snapshot` variant** — the
   test threads a `DiagnosticsSnapshot` and asserts a single collector's
   output. Use `DiagnosticsSnapshot::build(&state, &uri).unwrap()`.
3. **Delete** — the test asserts on a behavior that the snapshot path covers
   in another test, and the duplication is not worth keeping.

For each test, the choice is mechanical: if the test does multi-collector
assertions, use option 1; if it isolates one collector, use option 2; if it's
duplicated, option 3.

Update CLAUDE.md to drop the "BOTH must be fixed" note (the long Learning entry
about the dual-path drift; search for "BOTH must be fixed; a fix that only
touches one"). Replace it with a single-line entry noting that `diagnostics()`
now delegates to the snapshot path and the legacy collectors are gone.

→ **codex:rescue gate:** dead-code scan (`cargo build -p raven` should produce
zero new warnings); sanity-check the CLAUDE.md edit; confirm no `*_from_snapshot`
caller still has a legacy fallback.

### Architecture summary

After all phases:

```
pub fn diagnostics(state, uri, cancel) -> Vec<Diagnostic>
    early returns: master switch off, non-R, no doc, no tree
    -> diagnostics_via_snapshot(state, uri, cancel)
       -> DiagnosticsSnapshot::build(state, uri)
       -> diagnostics_from_snapshot(snapshot, uri, cancel)
          -> {syntax_errors, else_newline, cycle, max_depth_from_snapshot,
              missing_file_from_snapshot, missing_package_from_snapshot,
              redundant_directive_from_snapshot, invalid_line_param,
              out_of_scope_from_snapshot, undefined_variables_from_snapshot}
```

`diagnostics_via_snapshot` ceases to be `#[cfg(feature = "test-support")]` and
becomes the single entry point. Legacy collectors (`collect_*` non-snapshot
variants except shared ones: `collect_syntax_errors`, `collect_else_newline_errors`,
`collect_invalid_line_param_diagnostics`) are deleted.

### Components / files affected

| File | Change |
|---|---|
| `crates/raven/src/handlers.rs` | Replace `diagnostics()` body, lift `diagnostics_via_snapshot` cfg, delete six legacy collectors, migrate ~57 in-file tests. |
| `crates/raven/src/backend.rs` | No code changes expected. Audit only — confirm the single direct caller at `:4135` continues to work and that watched-file fanout via `publish_diagnostics_via_arc` is unaffected. |
| `crates/raven/benches/lsp_operations.rs` | No code changes expected (bench already calls `diagnostics()` which now routes through the snapshot path). Optional: add `large` fixture variant in Phase 2. |
| `CLAUDE.md` | Drop the "BOTH must be fixed" Learning; add a brief replacement entry. |
| `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` | New file — pre/post bench numbers. |

### Data flow

`diagnostics()` has exactly one direct production caller and one bench caller:

- `crates/raven/src/backend.rs:4135` — inside `Backend::publish_diagnostics`,
  computes sync diagnostics under `state.read().await` and hands them to
  `diagnostics_async_standalone` (which adds async missing-file checks).
  Watched-file fanout reaches this function indirectly through
  `publish_diagnostics_via_arc` (backend.rs ~3183, ~3196) and
  `publish_diagnostics` (backend.rs ~4099).
- `crates/raven/benches/lsp_operations.rs:263` — `bench_diagnostics`.

After Phase 3, each call builds a `DiagnosticsSnapshot` (which takes
`&WorldState` and acquires no fresh locks; verified at handlers.rs:115, 147,
198) and threads it through `diagnostics_from_snapshot`. The debounced
per-keystroke pipeline (`run_debounced_diagnostics`) already uses the
snapshot path directly; this PR does not affect that path.

The snapshot build cost is therefore paid once per affected file per
revalidation event, not per keystroke.

### Behavioral parity vs structural parity

The legacy and snapshot paths share a `HashMap<(u32, u32), ScopeAtPosition>`
between the out-of-scope and undefined-variable collectors, but they populate
it differently. The legacy path primes per-usage scopes before the source
loops and passes the cache forward (handlers.rs:3733, 5643). The snapshot
path uses `ScopeStream` and materializes only source-site/fallback/slow-path
entries (handlers.rs:349, 5096, 5120, 5451).

**The required parity is behavioral, not structural.** Both paths must emit
the same set of `Diagnostic` shapes for the same input; they need not
populate the same cache entries in the same order. Phase 1 tests assert on
emitted diagnostics (`Vec<Diagnostic>`), not on cache state. Phase 4's bench
covers performance; behavioral divergence flowing from cache-priming
differences would surface as test failures, not bench regressions.

### Error / cancellation handling

Unchanged. `DiagCancelToken::is_cancelled()` is checked at the same boundaries
in `diagnostics_from_snapshot` as in the legacy path, plus at finer granularity
inside the `_from_snapshot` collectors (every 64 iterations in hot loops).

### Testing strategy

Three categories:

1. **New gap-coverage tests (Phase 1).** Cover `@lsp-cd`, workspace-root
   fallback, `local=TRUE`, non-global `sys.source`, source-site defense-in-depth.
   Initially run through `diagnostics()`; after Phase 3 they prove parity.
2. **Existing snapshot-path tests.** Untouched. Continue to validate the
   snapshot path.
3. **Migrated legacy tests (Phase 5).** ~57 in-file tests that called legacy
   collectors directly are migrated to `diagnostics_via_snapshot` or the
   matching `*_from_snapshot` variant, or deleted as duplicates.

Coverage criterion: every Phase 1 test must pass on the snapshot path, and the
full suite (`cargo test -p raven`) must be green at the end of every phase.

### Risks

| Risk | Mitigation |
|---|---|
| Snapshot build cost regresses sync callers (watched-files cascade). | Phase 2 baseline + Phase 4 comparison; CI lower-bound + absolute floor + fanout-fixture gates. |
| Subtle behavioral drift not caught by Phase 1 tests. | codex:rescue gate after Phase 3 specifically audits parity, not just compilation. The cache-priming difference (legacy primes-per-usage, snapshot uses `ScopeStream`) is behavioral parity territory — Phase 1 tests assert on emitted `Diagnostic` shapes, which is the right level. |
| Lock semantics change in watched-files async loop. | Audit confirms `DiagnosticsSnapshot::build` takes `&WorldState` and does no fresh `state.write()` acquisition. |
| Test migration introduces shape mismatches (snapshot collector signatures differ from legacy). | One test at a time; full suite after each batch. |
| CLAUDE.md edit removes a Learning that's still load-bearing for other code. | The Learning is specifically about dual-path drift, which is what we're eliminating. Replace with a single-line entry noting the consolidation. |

---

## Open questions

None at design time.

## Acceptance criteria (from issue #135)

- [ ] `pub fn diagnostics()` body is a thin wrapper around `diagnostics_via_snapshot()`. (Phase 3)
- [ ] Legacy collectors deleted; no compiler warnings about dead code. (Phase 5)
- [ ] Full lib test suite passes (`cargo test -p raven`) at every phase boundary.
- [ ] CLAUDE.md updated to remove the "BOTH must be fixed" note. (Phase 5)
- [ ] A regression test or benchmark confirms diagnostics latency on the watched-files path has not regressed. (Phases 2 + 4)
- [ ] Add explicit test coverage for `@lsp-cd`, workspace-root fallback, `local=TRUE`, and non-global `sys.source` interactions with out-of-scope diagnostics. (Phase 1)

## Related

- Issue #135
- PR #134 — in-place port of three filters (memoization, `inherits_symbols()`,
  `PathContext::from_metadata`) into the legacy out-of-scope collector.
