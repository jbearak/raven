# CI: Parallelize test jobs and replace sccache with Swatinem/rust-cache

**Date:** 2026-05-17
**Branch:** `worktree-ci-sccache`
**Related:** PR #288

## Problem

The current `integration.yml` workflow (as of branch HEAD `872fee5`) takes
~12 minutes wall-time for a typical PR run. The bottleneck is the `Build
(release)` job, which compiles the LSP binary plus the full test binary
(including criterion as a dev-dependency) via `cargo test --release --no-run`.
All other jobs (`Cargo Tests`, `Time-Budget Tests`, `VS Code Mocha Suite`,
`Binary Size`) gate on it and then run quickly.

A draft diff already on the branch (uncommitted) addresses the Build-job
bottleneck by splitting it into `cargo build --release -p raven` (LSP only)
and having `Cargo Tests` and `Time-Budget Tests` each compile their own test
binary. With its serial dependency graph, that diff still leaves the critical
path at ~7 minutes (`build` 3m + `cargo` 4m, serialized).

An older architecture seen earlier today (run 25992287993, commit before the
current branch's recent churn) hit **5m29s** wall-time by running `build`,
`Cargo Tests`, and `vscode-mocha` in parallel from `t=0`. That is the
fastest run on this branch so far.

Two distinct slow paths matter to the user:

1. **Mocha critical path** (`integration.yml`): `Build` time + Mocha test
   execution. Currently ~3m + 2m25s = ~5.5m cold.
2. **Criterion compile** (`perf.yml`): the `benchmarks` job currently takes
   ~2m47s, dominated by compiling criterion from scratch. Today's shared
   cache key (`cargo-sccache-${{ runner.os }}-${{ hashFiles('**/Cargo.lock') }}`)
   means that under a stable `Cargo.lock`, only the first job to encounter
   that key actually saves to cache; subsequent runs cannot accumulate
   sccache state, so criterion gets compiled fresh every time.

## Goal

- `integration.yml` critical path: ~5.5m cold, **~3m warm when the cache-
  fallback assumption (§2) holds**.
- `perf.yml` `benchmarks` job: fast on second-and-later runs (criterion warm
  in `benchmarks`'s own cache, typically populated by a prior `main` run).
- No paid infrastructure (free GitHub-hosted runners only).
- No code-level changes to tests or benchmarks; CI-config only.
- Cache health is monitorable post-deploy (§6), so regressions to cold runs
  surface in the UI rather than going unnoticed.

## Design

### 1. Job graph (`integration.yml`)

```text
t=0 ┬─ build         cargo build --release -p raven               ~3m cold, ~5–30s warm
    │      └─ uploads raven-release artifact
    │            ├─→ vscode-mocha    download + Electron tests    ~2.5m
    │            └─→ binary-size     download + ls                ~5s
    │
    ├─ cargo         cargo test --release -p raven                 ~4m cold, ~30–60s warm
    │                  --features test-support
    │
    └─ time-budgets  cargo test --release -p raven                 ~3m cold, ~30–40s warm
                       --features test-support
                       --test performance_budgets

Critical path (warm-cache assumption holding):
  Build → vscode-mocha = ~5.5m cold, ~3m warm
```

Changes from the uncommitted diff:

- **Remove `needs: build`** from the `cargo` and `time-budgets` jobs. They
  run in parallel with `build` from `t=0`.
- Keep `needs: build` on `vscode-mocha` and `binary-size` — those jobs only
  download the LSP artifact.

### 2. Cache strategy

Replace `sccache` + `actions/cache` with `Swatinem/rust-cache` on the
**four** Rust-compiling jobs: `build`, `cargo`, `time-budgets`, and
`benchmarks` (in `perf.yml`).

**Why Swatinem over sccache:**

- sccache caches *rustc invocations* — rustc still runs per crate, just
  short-circuits to a cached output. Warm Build with sccache: ~30s.
- Swatinem caches `target/` directly — Cargo's incremental compilation
  sees "no change" and skips rustc entirely for unchanged crates. Warm
  Build with Swatinem: ~5–10s.
- The previous move *away* from Swatinem (commit `bce15c0` → `238e27a`)
  was about sccache's GHA backend hard-failing on a transient HTTP 400.
  Swatinem itself was not the problem; sccache with the *local-filesystem*
  backend solved the original 400 issue. Swatinem with `actions/cache`
  under the hood has the same graceful-cache-miss semantics.

**Per-job keying:**

Swatinem's default cache key includes workflow + job name + rustc version
+ `Cargo.lock` hash. We accept the default — no `shared-key`, because each
cached job's `target/` content differs legitimately:

- `build`: contains compiled LSP binary + production deps.
- `cargo`: contains LSP + tests + all dev-deps (including criterion).
- `time-budgets`: contains LSP + the `performance_budgets` test binary.
- `benchmarks`: contains LSP + benches + criterion.

Cross-job sharing of `target/` is not safe (Cargo wouldn't know what
to do with foreign artifacts), so each job's cache is independent.
**Notably, `cargo`'s criterion compilation cannot warm `perf.yml`'s
`benchmarks` job** — `benchmarks` only warms from `benchmarks`'s own
prior runs (typically on `main`). Inside a single workflow run, each
cached job is also independent of the others — there is no within-run
warming.

**Jobs we do NOT cache:**

- `vscode-mocha`, `binary-size`: no Rust compilation in these jobs.

**Branch-scoping note (best-effort, not a guarantee):**

GitHub Actions scopes caches by branch, but caches saved on the default
branch (`main`) are readable from any branch. `perf.yml` already runs on
`push: branches: [main]`, so feature branches *can* inherit a warm
criterion cache from `main` — but only when `main` has a fresh cache
entry under the same key.

This main-branch fallback is fragile under realistic conditions:

- GitHub's 10 GB-per-repo cache is LRU-evicted. With four cached jobs in
  `integration.yml` (~2–3 GB per branch) plus `benchmarks` in `perf.yml`
  (~500 MB–1 GB per branch), a handful of active feature branches can
  evict `main`'s entries.
- `Cargo.lock` changes, `rustc` version bumps, and Swatinem internal
  cache-version bumps each produce new cache keys, making prior entries
  unreachable even if still stored.
- A feature branch's first run on a new key is cold (~3m criterion
  compile in `perf.yml`, ~3m test compile in `time-budgets` and `cargo`).

The architecture does not require additional scheduling, but the warm-
cache claims in §4 are *expected* outcomes, not guaranteed ones. The
monitoring step in §6 makes the assumption falsifiable rather than
asserted.

### 3. Workflow file changes

#### `.github/workflows/integration.yml`

- **`env:`** Drop `RUSTC_WRAPPER: sccache` and its comment. Keep
  `CARGO_TERM_COLOR: always` and the `RUSTFLAGS: "-C link-arg=-fuse-ld=mold"`
  block (mold still speeds up the link step that runs even with a warm
  `target/`).
- **`build` job:**
  - Drop the `Set up sccache` step.
  - Replace the `Cache sccache storage and cargo registry` step with
    `Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1`.
  - Keep mold install, `cargo build --release -p raven`, and the artifact
    upload as in the uncommitted diff.
- **`cargo` job:**
  - **Remove `needs: build`**.
  - Drop the `Set up sccache` step.
  - Replace `actions/cache` block with
    `Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1`.
  - Keep mold install and `cargo test --release -p raven --features test-support`.
- **`time-budgets` job:**
  - **Remove `needs: build`**.
  - Drop the `Set up sccache` step.
  - Replace `actions/cache` block with
    `Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1`.
  - Keep mold install and `cargo test --release -p raven --features test-support --test performance_budgets`.
- **`vscode-mocha`, `binary-size`:** unchanged (they already only download
  the artifact and have no cargo/cache setup).
- **Each cached job** gets the Swatinem step assigned an `id` and a
  follow-up `Report cache status` step (see §6) so cache-hit outcomes
  are visible in run timelines.

#### `.github/workflows/perf.yml`

- **`env:`** Drop `RUSTC_WRAPPER: sccache`.
- **`benchmarks` job:**
  - Drop the `Set up sccache` step.
  - Replace the `Cache sccache storage and cargo registry` step with
    `Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1`.
  - Keep mold install, the criterion baseline cache, critcmp install, and
    the bench-run steps.

### 4. Expected timings

These are point estimates derived from prior runs on this branch and from
typical Swatinem warm/cold behavior. They are not guarantees — the warm
rows assume the cache-fallback assumption in §2 holds.

| Scenario | Build | Cargo | Time-Budgets | VSCode Mocha | **Wall time** |
|---|---|---|---|---|---|
| Cold first run (new `Cargo.lock` or evicted key) | 3m | 4m | 3m | Build+2.5m=5.5m | **~5.5m** ← VSCode critical |
| Warm cache on same branch | 30s | 1m | 30–40s | 3m | **~3m** ← VSCode critical with margin |
| New feature branch, `main` cache present and matching | 30s | 1m | 30–40s | 3m | **~3m** ← same |
| Warm-cache fallback fails partway (e.g. `cargo` cold, others warm) | 30s | 4m | 30–40s | 3m | **~4m** ← cargo critical until repopulated |

`perf.yml` `benchmarks` job: ~3m cold, ~30s–1m warm. Same fallback caveats.

### 5. Risks and trade-offs

- **Cold-cache compute duplication.** With `build`, `cargo`, `time-budgets`,
  and `benchmarks` (in `perf.yml`) running in parallel and each with its
  own cache, prod-dep crates compile four times on the first cold run.
  This is wall-time-neutral (they run in parallel) but consumes ~4× CPU-
  minutes. Once caches warm, this disappears.
- **Cache size and eviction.** Four Swatinem caches at ~500 MB–1 GB each =
  ~2.5–4 GB total per branch (integration.yml). Adding `perf.yml`'s
  `benchmarks` cache puts a single branch in the 3–5 GB range. With several
  active branches, this can crowd `main`'s entries out of GitHub's 10 GB
  per-repo cap. If feature-branch cache-hit rates trend down post-merge
  (§6 monitoring will show this), consider narrowing the cache scope —
  dropping the `cargo` cache is the most defensible candidate, since
  `cargo` is not on the critical path.
- **Cold-cache triggers are broader than just `Cargo.lock` changes.**
  Cache misses can also happen from: `rustc` version bumps, Swatinem
  internal cache-version bumps, or GitHub LRU eviction of `main`'s
  entries under branch churn. Any such cold run takes ~5.5m. The next
  run on that key repopulates the cache and subsequent runs warm again.
  This is the most likely silent regression vector — §6 cache-hit
  logging is the mitigation.

### 6. Validation and monitoring

The cache assumptions in this spec (especially "main warms feature branches"
and "warm cache holds across normal repo activity") are *expected* outcomes,
not guaranteed ones. To make them falsifiable rather than asserted:

1. **Log Swatinem cache-hit status per cached job.** Swatinem's action
   exposes `cache-hit` and `cache-key` outputs. Each cached job adds:

   ```yaml
   - name: Rust cache
     id: rust-cache
     uses: Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1

   # …other steps…

   - name: Report cache status
     if: always()
     run: |
       echo "::notice title=Cache status::hit=${{ steps.rust-cache.outputs.cache-hit }} key=${{ steps.rust-cache.outputs.cache-key }}"
   ```

   `::notice` surfaces the status in the Actions UI summary, so cold-run
   regressions are visible without parsing wall-time tables.

2. **Establish baseline timings post-merge.** Within ~1 week of merging,
   capture p50 wall times per job across PR runs. Decisions to be revisited
   if observed:

   - `time-budgets` p50 trending above VSCode Mocha → no action; this is
     the case the cache was supposed to prevent, and Codex's prediction
     would be wrong.
   - Feature-branch first-run cache-hit rate < ~50% on any cached job
     (`build`, `cargo`, `time-budgets`, `benchmarks`) → the main-branch
     fallback is being evicted; narrow the cache scope per the eviction
     risk in §5.
   - Build job p50 over ~1m on warm runs → Swatinem isn't delivering its
     promised gain; consider reverting to sccache with the local backend.

3. **No new performance claims without measurement.** Future tuning
   (e.g., dropping the `cargo` cache, adding `shared-key`, switching back
   to sccache) must be motivated by observed timings, not estimates.

### 7. Out of scope

- **Mocha test execution time (1m51s of pure test running).** Reducing it
  requires test-level changes (parallel mode, sharding, suite splitting)
  rather than CI architecture. Not addressed here; no follow-up issue per
  user direction.
- **Larger GitHub runners.** User chose free runners only.
- **Self-hosted runners.** Out of scope.
- **Combining sccache and Swatinem.** Possible in principle but adds
  complexity for no clear additional win; Swatinem alone covers the warm
  case better than sccache does.

## Testing

After implementation, validate by:

1. Push the change and confirm `Build (release)` drops below 4 min on the
   first run (cold cache). The cache-status notice (§6) should show
   `cache-hit=false` on every cached job.
2. Push a no-op commit on the same branch; confirm `Build` drops to <1 min
   and total wall time to ~3 min. Cache-status notices should show
   `cache-hit=true` on all four cached jobs (`build`, `cargo`,
   `time-budgets`, `benchmarks`).
3. Confirm `Cargo Tests` and `Time-Budget Tests` start at `t=0` (no
   `needs: build`) in the run timeline.
4. Push to `main` (or merge the PR), then open a fresh branch from `main`
   and confirm its first run warms from `main`'s cache: `cache-hit=true`
   on at least the `build` and `cargo` jobs, and Build ~30s rather than
   3m. If `cache-hit=false`, the main-branch fallback didn't work for this
   branch — record the run for the §6 baseline.
5. Confirm `perf.yml`'s `benchmarks` job drops below 1 min on its second
   run after a `Cargo.lock`-stable push, with `cache-hit=true`.
