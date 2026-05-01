# Benchmark Baseline for Issue #135

**Captured on:** 2026-04-30
**Commit:** 89b7ab9ee70a58318b2365da463c55587d16cf54
**Branch:** refactor/issue-135-route-diagnostics-through-snapshot
**Phase:** 1 (legacy path, before delegation)

## Command

```bash
cargo bench --bench lsp_operations --features test-support -- lsp_diagnostics
```

## Results

All times in nanoseconds.

| Fixture | Mean | Std Dev | 95% CI lower | 95% CI upper | Median |
|---|---|---|---|---|---|
| `lsp_diagnostics/diagnostics/small_10` | 1,402,478 (≈1.40 ms) | 5,653 | 1,399,995 | 1,404,848 | 1,403,700 |
| `lsp_diagnostics/diagnostics/medium_50` | 11,217,056 (≈11.22 ms) | 52,528 | 11,194,021 | 11,238,737 | 11,218,752 |

## Raw Criterion summary

```
lsp_diagnostics/diagnostics/small_10
                        time:   [1.3989 ms 1.4013 ms 1.4041 ms]

lsp_diagnostics/diagnostics/medium_50
                        time:   [11.212 ms 11.232 ms 11.254 ms]
```

(Bracketed values are [95% CI lower, point estimate, 95% CI upper].)

Sample size: 20 per fixture; warm-up: 3 s; analyzed iterations: 3570 (small_10), 630 (medium_50).

## Phase 4 comparison

Filled in during Phase 4. Acceptance gates:

1. CI lower bound on percent change ≤ 15% on `medium_50` (or `large` if added).
2. Per-iteration mean increase ≤ 5 ms on every fixture, regardless of percentage.
3. Same gates apply to any fanout-shaped fixture added in Phase 2.
