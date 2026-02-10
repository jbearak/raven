# Requirements: Performance Testing Infrastructure

## Introduction

Raven needs a performance testing infrastructure that detects regressions, validates time budgets, and tracks performance over time. Today Raven has a single benchmark file (`benches/startup.rs`) where most benchmarks are stubs (measuring `string.len()` instead of actual operations), a `perf.rs` timing module, and two profiling scripts—but no CI integration, no regression detection, and no runtime operation benchmarks.

This spec draws on analysis of four LSP codebases:

- **rust-analyzer** — the gold standard: real-world benchmarks on actual codebases, an `analysis-stats` CLI, a CI metrics workflow on every push to master, hierarchical profiling, and multi-metric tracking (time, memory, CPU instructions).
- **Sight** (Raven's sister Stata LSP) — time-budget regression tests with specific thresholds, CI-adapted thresholds (3× relaxed), cache-effectiveness benchmarks, and algorithm-comparison benchmarks.
- **pyright** — a cautionary example: no benchmarks, no profiling, no performance CI despite being a widely-used LSP.

The goal is a layered system: (1) real Criterion benchmarks that exercise actual code paths, (2) in-tree time-budget tests that fail on regression, (3) a CI workflow that runs benchmarks and detects regressions, and (4) a lightweight analysis command for ad-hoc profiling.

## Glossary

- **Time_Budget_Test**: A `#[test]` that asserts an operation completes within a wall-clock threshold, with CI-adapted thresholds (relaxed multiplier when `CI=true`).
- **Criterion_Benchmark**: A Criterion.rs benchmark that measures throughput/latency with statistical rigor and supports baseline comparison.
- **Fixture_Workspace**: A directory of synthetic R files with controlled characteristics (file count, function count, source chains, library calls) used as reproducible benchmark input.
- **CI_Regression_Gate**: A CI job that compares benchmark results against a stored baseline and fails the build if any metric regresses beyond a configurable threshold.
- **Analysis_Command**: A CLI subcommand (`raven analysis-stats`) that loads a workspace and reports timing/memory metrics for each analysis phase, inspired by rust-analyzer's `analysis-stats`.

## Requirements

### Requirement 1: Real Criterion Benchmarks

**User Story:** As a developer, I want benchmarks that exercise actual Raven code paths, so that I can measure real performance and detect regressions with `cargo bench`.

#### Acceptance Criteria

1. THE startup benchmark SHALL call actual Raven functions (tree-sitter parsing, metadata extraction, NAMESPACE parsing, batch-init output parsing) instead of stub proxies.
2. THE System SHALL include a `benches/lsp_operations.rs` benchmark file measuring completion, hover, go-to-definition, and diagnostics on fixture workspaces.
3. EACH benchmark SHALL use fixture workspaces of at least two sizes (small: ~10 files, medium: ~50 files) to validate scaling behavior.
4. THE System SHALL include a `benches/cross_file.rs` benchmark measuring scope resolution and dependency-graph traversal on workspaces with source() chains of depth 1, 5, and 15.
5. ALL benchmarks SHALL be runnable with `cargo bench` and produce Criterion HTML reports.

### Requirement 2: Time-Budget Regression Tests

**User Story:** As a developer, I want in-tree tests that fail when an operation exceeds its time budget, so that `cargo test` catches performance regressions without needing a separate benchmark run.

#### Acceptance Criteria

1. THE System SHALL include time-budget tests for: tree-sitter parsing (1KB < 5ms, 10KB < 25ms, 100KB < 250ms), metadata extraction (per-file < 2ms), scope resolution for a 50-file workspace (< 50ms), and single-file completion (< 20ms).
2. WHEN the `CI` environment variable is set, thresholds SHALL be multiplied by a configurable relaxation factor (default 3×).
3. EACH time-budget test SHALL run the operation at least 3 times and use the median elapsed time for comparison, to reduce noise.
4. Time-budget tests SHALL be gated behind a `#[cfg(not(debug_assertions))]` or `--release` requirement, since debug-mode timings are not meaningful.
5. WHEN a time-budget test fails, the error message SHALL include the measured time, the threshold, and whether CI relaxation was applied.

### Requirement 3: Fixture Workspace Generator

**User Story:** As a developer, I want a deterministic fixture generator, so that benchmarks and time-budget tests use reproducible, realistic workspaces.

#### Acceptance Criteria

1. THE generator SHALL accept parameters: file count, functions per file, source-chain depth, library calls per file, and lines of non-function code per file.
2. THE generator SHALL produce valid R files that tree-sitter parses without errors.
3. THE generator SHALL create source() chains of the requested depth (file_0 sources file_1, file_1 sources file_2, etc.).
4. THE generator SHALL be usable from both benchmarks and tests (shared crate or module).

### Requirement 4: CI Performance Workflow

**User Story:** As a maintainer, I want CI to run benchmarks on every push to `main` and on PRs, so that performance regressions are caught before merge.

#### Acceptance Criteria

1. THE CI workflow SHALL run `cargo bench` on pushes to `main` and on pull requests.
2. ON pull requests, THE workflow SHALL compare results against the `main` baseline using `critcmp` or Criterion's built-in baseline comparison, and post a comment summarizing changes > 5%.
3. ON pushes to `main`, THE workflow SHALL store benchmark results as the new baseline (GitHub Actions cache or artifact).
4. THE workflow SHALL run time-budget tests (`cargo test --release`) as a required check.
5. THE workflow SHALL record and display binary size for the release build to detect bloat.

### Requirement 5: Analysis-Stats Command

**User Story:** As a developer, I want a CLI command that profiles Raven against a real workspace, so that I can identify bottlenecks without setting up custom instrumentation.

#### Acceptance Criteria

1. THE `raven analysis-stats <path>` command SHALL load the workspace at `<path>` and report: file count, total parse time, total metadata extraction time, scope resolution time, package loading time, and peak memory (via `peak_rss_bytes()` using `getrusage`/`ru_maxrss` on macOS, `/proc/self/status` `VmHWM` on Linux).
2. THE command SHALL accept a `--csv` flag to output machine-readable results.
3. THE command SHALL accept a `--only <phase>` flag to run a single phase (e.g., `--only parse`, `--only scope`).
4. THE command SHALL reuse the existing `perf.rs` `PerfMetrics` infrastructure for timing collection.

### Requirement 6: Memory Awareness

**User Story:** As a developer, I want visibility into memory usage during benchmarks and analysis, so that I can detect memory leaks and excessive allocation.

#### Acceptance Criteria

1. THE analysis-stats command SHALL report peak RSS after each phase.
2. THE Criterion benchmarks SHALL optionally report allocation counts when run with `RAVEN_BENCH_ALLOC=1`, using a global allocator wrapper.
3. THE System SHALL document how to generate heap profiles (e.g., with `jemalloc` or `dhat`) in `docs/development.md`.
