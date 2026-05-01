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

## Fanout fixture (added in Phase 2 per codex:rescue)

Captured on 2026-04-30 against the same legacy code path as the chain fixtures
above. The fanout fixture exercises the production watched-file revalidation
cascade: a single `shared.R` (defining 5 functions, one `library(stats)` call)
is sourced by N parent files (`parent_0.R` … `parent_{N-1}.R`). Each parent
calls `shared_func_{i mod 5}(i)`. The benchmark builds the workspace once,
opens every file, runs the workspace scan, and then **per iteration loops
over all parent URIs in order and calls `raven::handlers::diagnostics(...)`
on each**, accumulating diagnostic counts to defeat dead-code elimination.

This shape is what Phase 4 needs to detect regressions for: changes to a
shared sourced file republish diagnostics across many parent URIs in a
single batch, so a per-parent slowdown multiplies across the cascade.

### Results

All times in nanoseconds (per full pass over all parent URIs).

| Fixture | Parents | Mean | Std Dev | 95% CI lower | 95% CI upper | Median | Per-parent (mean / N) |
|---|---|---|---|---|---|---|---|
| `lsp_diagnostics/fanout_diagnostics/fanout_50` | 50 | 65,659,744 (≈65.66 ms) | 338,721 | 65,518,423 | 65,808,513 | 65,625,547 | ≈1.31 ms |
| `lsp_diagnostics/fanout_diagnostics/fanout_200` | 200 | 949,524,134 (≈949.52 ms) | 3,967,745 | 947,845,954 | 951,249,752 | 949,190,605 | ≈4.75 ms |

### Raw Criterion summary

```text
lsp_diagnostics/fanout_diagnostics/fanout_50
                        time:   [65.518 ms 65.660 ms 65.809 ms]
Found 3 outliers among 20 measurements (15.00%)
  1 (5.00%) low mild
  2 (10.00%) high mild

lsp_diagnostics/fanout_diagnostics/fanout_200
                        time:   [947.85 ms 949.52 ms 951.25 ms]
Found 2 outliers among 20 measurements (10.00%)
  1 (5.00%) low mild
  1 (5.00%) high mild
```

(Bracketed values are [95% CI lower, point estimate, 95% CI upper].)

Sample size: 20 per fixture; warm-up: 3 s; analyzed iterations: 80
(fanout_50), 20 (fanout_200). Criterion auto-extended the
`fanout_200` measurement window to ~19 s so 20 samples could complete.

Per-parent cost is superlinear (1.31 ms at N=50 vs. 4.75 ms at N=200),
consistent with cross-file scope resolution scanning a denser dependency
neighborhood as fanout grows — exactly the cascade interaction Phase 4
must guard against.

## Phase 4 results (post-delegation)

**Captured on:** 2026-04-30
**Commit:** 7fcb1d4
**Phase:** 4 (snapshot path, post-delegation)

The snapshot pipeline is dramatically faster than the legacy collector
path on every fixture. The delegation is unambiguously a net win.

### Chain fixtures

| Fixture | Mean (post) | Std Dev | 95% CI lower | 95% CI upper | % change | Mean Δ |
|---|---|---|---|---|---|---|
| `lsp_diagnostics/diagnostics/small_10` | 286,545 ns (≈0.287 ms) | 4,716 | 284,885 | 288,813 | −79.57% (CI [−79.70%, −79.39%]) | −1.12 ms |
| `lsp_diagnostics/diagnostics/medium_50` | 918,740 ns (≈0.919 ms) | 1,902 | 917,940 | 919,561 | −91.81% (CI [−91.83%, −91.79%]) | −10.30 ms |

### Fanout fixtures

| Fixture | Mean (post) | Std Dev | 95% CI lower | 95% CI upper | % change | Mean Δ | Per-parent (mean / N) |
|---|---|---|---|---|---|---|---|
| `lsp_diagnostics/fanout_diagnostics/fanout_50` | 8,993,872 ns (≈8.99 ms) | 29,278 | 8,981,625 | 9,006,602 | −86.30% (CI [−86.34%, −86.27%]) | −56.67 ms | ≈0.18 ms |
| `lsp_diagnostics/fanout_diagnostics/fanout_200` | 127,141,555 ns (≈127.14 ms) | 535,131 | 126,919,787 | 127,375,314 | −86.61% (CI [−86.65%, −86.58%]) | −822.38 ms | ≈0.64 ms |

### Raw Criterion change lines

```text
lsp_diagnostics/diagnostics/small_10
                        time:   [285.01 µs 286.16 µs 287.96 µs]
                        change: [-79.699% -79.569% -79.394%] (p = 0.00 < 0.05)
                        Performance has improved.

lsp_diagnostics/diagnostics/medium_50
                        time:   [917.80 µs 918.40 µs 919.04 µs]
                        change: [-91.827% -91.809% -91.791%] (p = 0.00 < 0.05)
                        Performance has improved.

lsp_diagnostics/fanout_diagnostics/fanout_50
                        time:   [8.9710 ms 8.9873 ms 9.0043 ms]
                        change: [-86.339% -86.302% -86.267%] (p = 0.00 < 0.05)
                        Performance has improved.

lsp_diagnostics/fanout_diagnostics/fanout_200
                        time:   [126.92 ms 127.14 ms 127.38 ms]
                        change: [-86.645% -86.610% -86.576%] (p = 0.00 < 0.05)
                        Performance has improved.
```

### Acceptance gates

- [x] **Gate 1: CI lower bound on percent change ≤ 15% on `medium_50`** — the upper bound of the change CI is −91.79%; the change is overwhelmingly negative (faster). Gate trivially passes (≪ 15%).
- [x] **Gate 2: Per-iteration mean increase ≤ 5 ms on every fixture.** — every fixture's mean DECREASED by ≥ 1.12 ms (small_10), ≥ 10.30 ms (medium_50), ≥ 56.67 ms (fanout_50), ≥ 822.38 ms (fanout_200). Gate trivially passes.
- [x] **Gate 3: Same gates apply to fanout-shaped fixtures.** — both fanout_50 and fanout_200 show −86% change. Gate trivially passes.

### Verdict

**PASS.** All three gates pass with massive headroom. The snapshot path is 5–12× faster than the legacy chain-of-collectors path; the cumulative win on the production-shaped fanout fixtures is dramatic (827 ms → 127 ms at fanout_200).

The snapshot pipeline already incorporates the optimizations from earlier
work (parent-prefix cache, ScopeStream forward-only cursor, parallel
workspace scan, document_store sizing) — the legacy `pub fn diagnostics()`
re-walked dependencies per collector and primed a per-(line, column)
scope cache that the snapshot's stream replaces with cheaper amortized
work.
