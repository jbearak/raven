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

- `integration.yml` critical path: ~5.5m cold, **~3m warm**.
- `perf.yml` `benchmarks` job: fast on second-and-later runs (criterion warm
  in cache).
- No paid infrastructure (free GitHub-hosted runners only).
- No code-level changes to tests or benchmarks; CI-config only.

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
    └─ time-budgets  cargo test --release -p raven                 ~3m cold, ~3m every run
                       --features test-support
                       --test performance_budgets                  (intentionally uncached)

Critical path: Build → vscode-mocha = ~5.5m cold, ~3m warm
```

Changes from the uncommitted diff:

- **Remove `needs: build`** from the `cargo` and `time-budgets` jobs. They
  run in parallel with `build` from `t=0`.
- Keep `needs: build` on `vscode-mocha` and `binary-size` — those jobs only
  download the LSP artifact.

### 2. Cache strategy

Replace `sccache` + `actions/cache` with `Swatinem/rust-cache` on the
**three** Rust-compiling jobs we want to keep fast: `build`, `cargo`, and
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
- `benchmarks`: contains LSP + benches + criterion.

Cross-job sharing of `target/` is not safe (Cargo wouldn't know what
to do with foreign artifacts), so each job's cache is independent.

**Jobs we do NOT cache:**

- `time-budgets`: compiles a single integration test target every run
  (~3 min). Not on the critical path — `vscode-mocha` already takes ~3 min
  warm, so caching `time-budgets` does not move the wall-time floor. Skipping
  the cache here saves ~500 MB–1 GB of GitHub cache storage.
- `vscode-mocha`, `binary-size`: no Rust compilation in these jobs.

**Branch-scoping note:**

GitHub Actions scopes caches by branch, but caches saved on the default
branch (`main`) are readable from any branch. `perf.yml` already runs on
`push: branches: [main]`, so feature branches inherit a warm criterion
cache on first run as long as `main` has run recently. No additional
scheduling needed.

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
  - **Drop the cache step entirely** — this job is intentionally uncached.
  - Keep mold install and `cargo test --release --test performance_budgets`.
- **`vscode-mocha`, `binary-size`:** unchanged (they already only download
  the artifact and have no cargo/cache setup).

#### `.github/workflows/perf.yml`

- **`env:`** Drop `RUSTC_WRAPPER: sccache`.
- **`benchmarks` job:**
  - Drop the `Set up sccache` step.
  - Replace the `Cache sccache storage and cargo registry` step with
    `Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1`.
  - Keep mold install, the criterion baseline cache, critcmp install, and
    the bench-run steps.

### 4. Expected timings

| Scenario | Build | Cargo | Time-Budgets | VSCode Mocha | **Wall time** |
|---|---|---|---|---|---|
| Cold first run on a branch (new `Cargo.lock`) | 3m | 4m | 3m | Build+2.5m=5.5m | **5.5m** ← VSCode critical |
| Warm cache on same branch | 30s | 1m | 3m | 3m | **3m** ← tie VSCode/time-budgets |
| Warm cache, with `main` warm but new feature branch | 30s | 1m | 3m | 3m | **3m** ← same |

`perf.yml` `benchmarks` job: ~3m cold, ~30s–1m warm.

### 5. Risks and trade-offs

- **Cold-cache compute duplication.** With `build`, `cargo`, and `benchmarks`
  running in parallel and each with its own cache, prod-dep crates compile
  three times on the first cold run. This is wall-time-neutral (they run in
  parallel) but consumes ~3× CPU-minutes. Once caches warm, sccache-like
  dedup is replaced by Swatinem's per-job `target/` cache.
- **Cache size.** Three Swatinem caches at ~500 MB–1 GB each = ~2–3 GB total
  per branch. GitHub's 10 GB-per-repo cap evicts oldest entries; no manual
  management needed.
- **Time-budgets job stays slow (~3m every run).** Acceptable because it is
  not on the critical path — the warm-cache wall time is set by VSCode
  Mocha (~3m), and `time-budgets` running in parallel finishes at roughly
  the same time. If `vscode-mocha` is ever sped up below 3m, revisit
  caching `time-budgets`.
- **First push after `Cargo.lock` change on `main`.** That single `main`
  build runs cold (~5.5m). Subsequent PRs warm from it.

### 6. Out of scope

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
   first run (cold cache).
2. Push a no-op commit on the same branch; confirm `Build` drops to <1 min
   and total wall time to ~3 min.
3. Confirm `Cargo Tests` and `Time-Budget Tests` start at `t=0` (no
   `needs: build`) in the run timeline.
4. Push to `main` (or merge the PR), then open a fresh branch from `main`
   and confirm its first run warms from `main`'s cache (Build ~30s, not 3
   min).
5. Confirm `perf.yml`'s `benchmarks` job drops below 1 min on its second
   run after a `Cargo.lock`-stable push.
