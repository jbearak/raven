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

Add tests that exercise the four parity-gap areas listed in issue #135:

| Area | Why it matters |
|---|---|
| `@lsp-cd` directive | Legacy collector used plain parent-dir join; snapshot uses `PathContext::from_metadata`. Files declaring `@lsp-cd` resolve source targets relative to the wrong base in legacy. |
| Workspace-root fallback | AST-detected `source()` calls in unannotated workspaces fall back to workspace-root resolution; snapshot honors this, legacy may not. |
| `local=TRUE` / non-global `sys.source` | Snapshot uses `inherits_symbols()` to skip non-inheriting source calls; legacy did not skip these and would flag "used before sourced" for symbols never actually inherited. |
| Source-call-site defense-in-depth | Snapshot verifies the symbol at the source position actually comes from another URI before emitting (deviation #5 in issue #135); legacy does not. |

Each area gets at least one test. Tests run through `pub fn diagnostics()`
(legacy path). For each test that we expect to fail under the current legacy
behavior, mark `#[ignore = "legacy parity gap; un-ignored when diagnostics() delegates to snapshot in Phase 3"]`
with a comment pointing to issue #135. Tests that already pass on legacy stay
un-ignored.

The full test suite must pass — failing-on-legacy tests are ignored, so the
tree is green.

**Why this order?** The tests document the parity gap before the legacy code
goes away. After Phase 3 deletes the legacy path, the tests un-ignore and
prove parity by passing.

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

→ **codex:rescue gate:** sanity-check baseline numbers; recommend whether to add
a `large` fixture or a new bench targeting `backend.rs:3125` (watched-files
child publish path) specifically. The watched-files path is the only sync caller
of `diagnostics()` likely to fan out across many files per edit; if the existing
benches don't cover it, propose what would.

#### Phase 3 — Delegate `diagnostics()` to the snapshot path

1. Lift `diagnostics_via_snapshot` out of `#[cfg(feature = "test-support")]`
   (handlers.rs:3558–3569). Drop the `#[allow(dead_code)]` since it now has a
   real production caller.
2. Replace the body of `pub fn diagnostics()` (handlers.rs:3603) with the
   early-return guards (master switch off, non-R, no document, no tree) followed
   by a call to `diagnostics_via_snapshot(state, uri, cancel)`. The early returns
   are preserved because they short-circuit before `DiagnosticsSnapshot::build`
   does any work.
3. Un-ignore the Phase 1 tests that were marked failing-on-legacy. Update their
   `#[ignore]` attributes — remove them entirely.
4. Run `cargo test -p raven`. Must pass green.

This phase touches only the public `diagnostics()` and the cfg gate on
`diagnostics_via_snapshot`. Legacy collectors remain in the file (will become
dead-code after the binding to `diagnostics()` is severed; `cargo` will warn).

→ **codex:rescue gate:** parity audit of:
- `backend.rs:3125` — `did_change_watched_files` child publish path
- `backend.rs:4152` — sync publish path
- `crates/raven/benches/lsp_operations.rs:263` — bench harness
Plus: lock semantics in the watched-files async loop (no fresh locks acquired
inside `DiagnosticsSnapshot::build`), and confirm the scope_cache reuse
semantics match what the legacy path provided.

#### Phase 4 — Re-run benchmarks; confirm no regression

Re-run `cargo bench --bench lsp_operations -- lsp_diagnostics`. Append results
to the baseline doc with a delta column.

**Acceptance threshold:** any per-fixture mean increase >15% on `medium_50` (or
the new `large` fixture if added) blocks Phase 5; investigate before
proceeding. Smaller workspaces are noisier and a sub-1ms increase is not
load-bearing — the absolute numbers are recorded for reference but not gated.

If a regression is found, options:
- Investigate whether the snapshot build is dominated by cycle detection or
  neighborhood collection; tune cache shapes if needed.
- Determine if a sync caller can hold a `DiagnosticsSnapshot` and reuse it
  across multiple `diagnostics()` calls (only relevant if many calls happen for
  the same URI back-to-back, which is unlikely in production).
- Worst case: revert Phase 3 and re-scope the issue.

→ **codex:rescue gate:** review delta and the absolute numbers; recommend
whether to proceed to Phase 5 or investigate further.

#### Phase 5 — Delete legacy collectors and migrate tests

Delete:
- `collect_out_of_scope_diagnostics` (handlers.rs:5609)
- `collect_undefined_variables_position_aware` (handlers.rs:8196)
- `collect_max_depth_diagnostics` (handlers.rs:4471)
- `collect_missing_file_diagnostics` (handlers.rs:4113)
- `collect_missing_package_diagnostics` (handlers.rs:4573)
- `collect_redundant_directive_diagnostics` (handlers.rs:4651)
- Any helpers exclusively used by the above (e.g. legacy `get_cross_file_scope`
  shapes if no snapshot caller). Use `cargo build` warnings to find them.

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
| `crates/raven/src/backend.rs` | No code changes expected. Audit only. |
| `crates/raven/benches/lsp_operations.rs` | No code changes expected (bench already calls `diagnostics()` which now routes through the snapshot path). Optional: add `large` fixture variant in Phase 2. |
| `CLAUDE.md` | Drop the "BOTH must be fixed" Learning; add a brief replacement entry. |
| `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` | New file — pre/post bench numbers. |

### Data flow

`diagnostics()` is called synchronously from two sites:
- `backend.rs:3125` — `did_change_watched_files` child publish path. Iterates
  affected URIs and publishes diagnostics for each. Inside an async task that
  holds `state.read().await`. After the change, each iteration builds a
  `DiagnosticsSnapshot` (which already takes `&WorldState` and does no fresh
  lock acquisition).
- `backend.rs:4152` — sync publish path called from `Backend::publish_diagnostics`.
  Same pattern.

Both callers are outside the per-keystroke hot path (debounced pipeline uses
`run_debounced_diagnostics` which already calls `diagnostics_from_snapshot`).
The snapshot build cost is therefore paid once per affected file per
revalidation event, not per keystroke.

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
| Snapshot build cost regresses sync callers (watched-files cascade). | Phase 2 baseline + Phase 4 comparison; >15% block. |
| Subtle behavioral drift not caught by Phase 1 tests. | codex:rescue gate after Phase 3 specifically audits parity, not just compilation. |
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
