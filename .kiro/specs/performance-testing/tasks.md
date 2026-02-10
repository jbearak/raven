# Implementation Plan: Performance Testing Infrastructure

## Overview

Build Raven's performance testing in layers: fixture generator → real benchmarks → time-budget tests → analysis-stats CLI → CI workflow. Each layer builds on the previous one.

## Tasks

- [x] 1. Create the fixture workspace generator
  - [x] 1.1 Create `crates/raven/src/test_utils/fixture_workspace.rs` with `FixtureConfig` and `create_fixture_workspace()`
    - Implement `small()`, `medium()`, `large()` presets
    - Generate valid R files with functions, source() chains, library() calls
    - Ensure deterministic output (no randomness)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 1.2 Add unit tests for fixture generator
    - Verify file count matches config
    - Verify source chain depth (file_0 sources file_1, etc.)
    - Verify generated files parse without tree-sitter errors
    - _Requirements: 3.2, 3.3_

- [x] 2. Rewrite startup benchmarks with real implementations
  - [x] 2.1 Replace stub benchmarks in `benches/startup.rs` with actual function calls
    - `bench_metadata_extraction`: call real metadata extraction on generated R code
    - `bench_tree_sitter_parsing`: use actual tree-sitter parser
    - `bench_batch_init_parsing`: keep as-is (already exercises real parsing logic)
    - `bench_workspace_scan`: call actual workspace scanning on fixture workspaces
    - _Requirements: 1.1, 1.3_

- [x] 3. Add LSP operation benchmarks
  - [x] 3.1 Create `benches/lsp_operations.rs`
    - Benchmark completion on small and medium fixture workspaces
    - Benchmark hover on small and medium fixture workspaces
    - Benchmark go-to-definition across source() chains
    - Benchmark diagnostics generation on small and medium workspaces
    - _Requirements: 1.2, 1.3, 1.5_

  - [x] 3.2 Create `benches/cross_file.rs`
    - Benchmark scope resolution with source chain depths 1, 5, 15
    - Benchmark dependency graph traversal on small and medium workspaces
    - _Requirements: 1.4, 1.3_

- [x] 4. Checkpoint — verify all benchmarks run
  - Run `cargo bench` and verify Criterion HTML reports are generated. Ask the user if questions arise.

- [x] 5. Add time-budget regression tests
  - [x] 5.1 Create `tests/performance_budgets.rs` with test harness
    - Implement `median_of_3()`, `ci_factor()`, `assert_within_budget()`
    - Gate with `#[cfg(not(debug_assertions))]`
    - _Requirements: 2.2, 2.3, 2.4, 2.5_

  - [x] 5.2 Add time-budget tests for each operation
    - Tree-sitter parsing: 1KB < 5ms, 10KB < 25ms, 100KB < 250ms
    - Metadata extraction: single file < 2ms
    - Scope resolution: 50-file workspace < 50ms
    - Single-file completion: < 20ms
    - _Requirements: 2.1_

- [x] 6. Checkpoint — verify time-budget tests pass
  - Run `cargo test --release` and verify time-budget tests pass locally. Ask the user if questions arise.

- [x] 7. Add analysis-stats CLI command
  - [x] 7.1 Add `analysis-stats` subcommand to Raven's CLI
    - Parse workspace, run each phase, collect timing via `perf.rs`
    - Report: file count, parse time, metadata time, scope time, package time
    - Support `--csv` and `--only <phase>` flags
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 7.2 Add peak RSS measurement to `perf.rs`
    - macOS: `mach_task_info` / `rusage`
    - Linux: `/proc/self/status` VmHWM
    - Fallback: `None` on unsupported platforms
    - _Requirements: 6.1_

  - [x] 7.3 Document heap profiling in `docs/development.md`
    - Instructions for `jemalloc` profiling and `dhat`
    - _Requirements: 6.3_

- [x] 8. Add CI performance workflow
  - [x] 8.1 Create `.github/workflows/perf.yml`
    - Trigger on push to `main` and pull requests
    - Run `cargo test --release` (time-budget tests)
    - Run `cargo bench` with baseline management
    - Record and display release binary size
    - _Requirements: 4.1, 4.4, 4.5_

  - [x] 8.2 Add PR regression comment via `critcmp`
    - On PRs: compare against cached `main` baseline
    - Post comment summarizing changes > 5%
    - On push to `main`: save new baseline to cache
    - _Requirements: 4.2, 4.3_

- [x] 9. Add optional allocation tracking
  - [x] 9.1 Add global allocator wrapper gated behind `RAVEN_BENCH_ALLOC=1`
    - Count allocations during benchmark runs
    - Report in Criterion custom metrics
    - _Requirements: 6.2_

- [x] 10. Final checkpoint — end-to-end verification
  - Run full benchmark suite, time-budget tests, and analysis-stats on a fixture workspace. Verify CI workflow YAML is valid. Ask the user if questions arise.

## Notes

- The fixture generator is the foundation — benchmarks and time-budget tests both depend on it.
- Time budgets are initial estimates. Calibrate against actual CI hardware measurements after the first few runs, then tighten.
- The `analysis-stats` command is intentionally simple in v1. It can be extended later with per-function breakdowns, memory deltas per phase, etc.
- `critcmp` must be installed in CI (`cargo install critcmp`). Cache the binary to avoid rebuilding on every run.
