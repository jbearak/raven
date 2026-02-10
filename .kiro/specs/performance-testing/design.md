# Design: Performance Testing Infrastructure

## Overview

This design adds three layers of performance validation to Raven:

1. **Criterion benchmarks** — statistical microbenchmarks exercising real code paths, with baseline comparison.
2. **Time-budget tests** — `#[test]` functions that assert wall-clock thresholds, runnable via `cargo test --release`.
3. **CI workflow** — automated benchmark execution, regression detection, and baseline management.

Plus a supporting `analysis-stats` CLI command for ad-hoc profiling of real workspaces.

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                    CI Workflow                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ cargo bench   │  │ cargo test   │  │ binary size   │ │
│  │ + critcmp     │  │ --release    │  │ check         │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────────┘ │
│         │                  │                             │
│    baseline diff     time-budget                         │
│    comment on PR     pass/fail                           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  Benchmark Layer                         │
│                                                         │
│  benches/startup.rs      (real implementations)         │
│  benches/lsp_operations.rs (completion, hover, etc.)    │
│  benches/cross_file.rs   (scope resolution, dep graph)  │
│                                                         │
│  All use: fixture_workspace module + Criterion           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│               Time-Budget Test Layer                     │
│                                                         │
│  tests/performance_budgets.rs                           │
│  - parse budgets, scope budgets, completion budgets     │
│  - CI-adapted thresholds (3× when CI=true)              │
│  - median-of-3 measurement                              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│               Analysis-Stats CLI                         │
│                                                         │
│  raven analysis-stats <path> [--csv] [--only <phase>]   │
│  - Reuses perf.rs PerfMetrics                           │
│  - Reports timing + peak RSS per phase                  │
└─────────────────────────────────────────────────────────┘
```

### Design Decisions

1. **Criterion over `#[bench]`**: Criterion provides statistical analysis, HTML reports, and baseline comparison out of the box. It's already a dev-dependency.

2. **Time-budget tests as `#[test]` not benchmarks**: Following Sight's pattern, these run in `cargo test --release` and fail the build on regression. This catches regressions in normal CI without a separate benchmark step. They complement (not replace) Criterion benchmarks.

3. **Fixture workspaces over real codebases**: Unlike rust-analyzer (which benchmarks against ripgrep, diesel, etc.), Raven's R ecosystem doesn't have canonical large open-source projects. Synthetic fixtures with controlled parameters give reproducible results. The `analysis-stats` command fills the "real workspace" gap for ad-hoc use.

4. **`critcmp` for PR regression detection**: Rather than building custom comparison logic, we use the established `critcmp` tool to diff Criterion baselines. This is lightweight and well-tested.

5. **CI-adapted thresholds**: CI runners have variable performance. A 3× relaxation factor (configurable via `RAVEN_PERF_CI_FACTOR`) prevents flaky failures while still catching large regressions. This is the same approach Sight uses.

6. **`analysis-stats` as a subcommand**: Following rust-analyzer's pattern, this is a built-in CLI command rather than a separate binary. It reuses the existing server infrastructure (parser, indexer, scope resolver) without starting the LSP protocol layer.

## Components and Interfaces

### Fixture Workspace Generator

Shared module used by both benchmarks and tests.

```rust
// crates/raven/src/test_utils/fixture_workspace.rs
// (or a shared location accessible from benches/ and tests/)

pub struct FixtureConfig {
    pub file_count: usize,
    pub functions_per_file: usize,
    pub source_chain_depth: usize,   // 0 = no source() calls
    pub library_calls_per_file: usize,
    pub extra_lines_per_file: usize,
}

impl FixtureConfig {
    pub fn small() -> Self;   // 10 files, 5 funcs, depth 3
    pub fn medium() -> Self;  // 50 files, 10 funcs, depth 10
    pub fn large() -> Self;   // 200 files, 20 funcs, depth 15
}

/// Creates a temp directory with generated R files. Returns TempDir (cleanup on drop).
pub fn create_fixture_workspace(config: &FixtureConfig) -> TempDir;
```

### Time-Budget Test Harness

```rust
// crates/raven/tests/performance_budgets.rs

/// Run `f` three times, return median duration.
fn median_of_3<F: FnMut()>(mut f: F) -> Duration;

/// Get the CI relaxation factor (default 3.0 when CI=true, 1.0 otherwise).
fn ci_factor() -> f64;

/// Assert that `measured` is within `budget_ms * ci_factor()`.
/// Panics with a descriptive message on failure.
fn assert_within_budget(label: &str, measured: Duration, budget_ms: u64);
```

### Analysis-Stats Command

```rust
// crates/raven/src/cli/analysis_stats.rs

pub struct AnalysisStatsArgs {
    pub path: PathBuf,
    pub csv: bool,
    pub only: Option<String>,  // "parse", "scope", "packages", etc.
}

pub struct PhaseResult {
    pub name: String,
    pub duration: Duration,
    pub peak_rss_bytes: Option<u64>,
    pub detail: String,  // e.g., "42 files parsed"
}

pub fn run_analysis_stats(args: AnalysisStatsArgs) -> Vec<PhaseResult>;
```

### CI Workflow

```yaml
# .github/workflows/perf.yml
# Triggers: push to main, pull_request
# Steps:
#   1. cargo test --release (runs time-budget tests)
#   2. cargo bench -- --save-baseline (main) or --baseline main (PR)
#   3. critcmp for PR comment
#   4. Record binary size
```

## Data Models

### Benchmark Organization

```text
crates/raven/
├── benches/
│   ├── startup.rs           # Existing (rewritten with real impls)
│   ├── lsp_operations.rs    # New: completion, hover, goto-def, diagnostics
│   └── cross_file.rs        # New: scope resolution, dep graph traversal
├── tests/
│   └── performance_budgets.rs  # New: time-budget regression tests
└── src/
    ├── cli/
    │   └── analysis_stats.rs   # New: analysis-stats subcommand
    ├── perf.rs                 # Existing (extended with RSS tracking)
    └── test_utils/
        └── fixture_workspace.rs # New: shared fixture generator
```

### Time Budgets

| Operation | Input Size | Budget (local) | Budget (CI, 3×) |
|-----------|-----------|----------------|-----------------|
| Tree-sitter parse | 1 KB | 5 ms | 15 ms |
| Tree-sitter parse | 10 KB | 25 ms | 75 ms |
| Tree-sitter parse | 100 KB | 250 ms | 750 ms |
| Metadata extraction | single file | 2 ms | 6 ms |
| Scope resolution | 50-file workspace | 50 ms | 150 ms |
| Single-file completion | 1 file, 50 symbols | 20 ms | 60 ms |

These are initial budgets. They should be calibrated against actual measurements on CI hardware and tightened over time.

## Correctness Properties

### Property 1: Fixture Determinism

*For any* `FixtureConfig`, calling `create_fixture_workspace` twice with the same config SHALL produce files with identical content (byte-for-byte), ensuring benchmark reproducibility.

**Validates: Requirement 3.1**

### Property 2: Time-Budget CI Adaptation

*For any* time-budget test, WHEN `CI=true`, the effective threshold SHALL equal `base_budget × ci_factor` where `ci_factor ≥ 1.0`. WHEN `CI` is unset, the effective threshold SHALL equal `base_budget`.

**Validates: Requirements 2.2, 2.5**

### Property 3: Fixture Validity

*For any* `FixtureConfig` with `file_count > 0`, every generated `.R` file SHALL parse without tree-sitter errors.

**Validates: Requirement 3.2**

## Error Handling

- **Benchmark failures**: Criterion benchmarks don't fail the build; they produce reports. Only time-budget tests fail the build.
- **CI baseline missing**: On the first run (no cached baseline), the PR comparison step is skipped with a warning. The push-to-main step always saves a new baseline.
- **RSS measurement unavailable**: On platforms where RSS cannot be read, `analysis-stats` reports `None` for memory and continues.
- **Fixture creation failure**: Panics immediately with a clear message (benchmarks cannot proceed without fixtures).

## Testing Strategy

- **Fixture generator**: Unit tests verify file count, source-chain structure, and tree-sitter parse validity.
- **Time-budget harness**: Unit test that `assert_within_budget` passes for a trivially fast operation and fails for a `thread::sleep(1s)` operation.
- **Analysis-stats**: Integration test that runs the command on a small fixture workspace and verifies JSON/CSV output structure.
- **CI workflow**: Manual verification on a test PR. The workflow itself is not unit-tested.
