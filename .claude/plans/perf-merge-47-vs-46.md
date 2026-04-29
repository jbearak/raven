# Plan: pick winner between opus47 and opus46 perf branches

## Branches under comparison

| Branch | Worktree | HEAD | Strategy |
| --- | --- | --- | --- |
| `t3code/incremental-scope-resolution` | `~/repos/wt/raven/opus47` | `8008514` | (1) cache STEP 1 parent walk per snapshot via `ParentPrefixCache`; (2) `ScopeStream` forward-only cursor for diagnostic collectors |
| `t3code/optimize-diagnostic-updates` | `~/repos/wt/raven/opus46` | `ea9c0c5` | (1) `rayon` parallel `scan_workspace`; (2) `ScopeResolutionMemo` HashMap memoization; (3) "breakpoint scope" fast-path at source/library positions |

Common ancestor: `65b2959`. Both branched before the `pin-workspace-indexes` fixes that landed on `main` (`bf78d51`, `196ff6f`, `0892d73`, `9edeae4`, `b0cad12`, `3ea2b69`).

## Benchmark methodology

Workload: `~/repos/worldwide` (referenced by both authors as the regression source). Metric of record: `scripts/data.r` diagnostic compute time (the cold-start outlier). Secondary metrics: `scan_workspace` cold time, `apply_workspace_index`, snapshot build, end-to-end pipeline.

Both worktrees ship their own profiler example:

- opus47: `cargo run --release --example profile_worldwide --features test-support`
- opus46: `cargo run --release --example profile_real_workspace --features test-support`

Both call `diagnostics_via_snapshot_profile(state, &uri, never_cancel)` so the diag-compute number is comparable.

## Steps

1. Build release `+ example` for both worktrees and main in parallel.
2. Run each profiler 3× per branch on `~/repos/worldwide`; record min, median, max.
3. Run criterion `cross_file` and `edit_to_publish` benches in each worktree (sanity check).
4. Pick winner. Heuristic: lowest median data.r diagnostic compute time, with no scan-time regression > 2×.
5. Merge winner into `perf/scope-res`. Resolve conflicts (the merged-in branch is missing `pin-workspace` fixes that already exist on `main`/this branch).
6. Cherry-pick valuable orthogonal items from loser:
   - **From opus46 (if opus47 wins)**: parallel `scan_workspace` (rayon) is orthogonal to scope-resolution caching and likely additive. Property tests, integration tests, and the "breakpoint scope" check could all coexist with `ScopeStream`.
   - **From opus47 (if opus46 wins)**: same-file leak filter robustness, `ScopeStream` could still apply to per-file collectors that the memo doesn't help.
7. Re-run tests + benches; confirm no regression.
8. Update `AGENTS.md` learnings.

## Risks

- Conflicts are concentrated in `crates/raven/src/cross_file/scope.rs` and `crates/raven/src/handlers.rs`.
- opus47's `scope.rs` change is +2,866 / -? lines — large surface area; expect manual merge work if opus47 wins.
- opus46 changes `state.rs` (+259 -94) for parallel scan; if opus47 wins, lifting the rayon change is mechanical but its `scope_cache` micro-opt is intertwined with the breakpoint logic.
