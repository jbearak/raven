# Issue #483 (WI2b) — performance benchmarks + standalone-directive gate (design)

Companion to `specs/issue-483-wi2b-notes.md`. Defines the benchmark + regression-gate
work to land alongside the WI2b standalone-scope cache (PR #491), so future changes
can be assessed for performance impact and the `# raven: standalone` directive is
proven to pay off.

## Goal

1. **Hard gate:** a CI test that fails if the `# raven: standalone` directive stops
   making hub-heavy cross-file resolution cheaper. ("If performance isn't better,
   that's a test failure.")
2. **Tracking:** criterion benchmarks recording the WI2b-relevant resolution costs so
   future changes surface as measurable deltas.

Self-contained — no dependence on the private `worldwide` corpus.

## Empirical basis (measured 2026-06-17, claude binary, real LSP server)

Edit→publish IDE latency, directive on `bootstrap.r` + `scripts/functions.r` + `main.r`:

| Scenario | WITHOUT directive | WITH directive | speedup |
|---|---|---|---|
| edit a caller of the hub (diagnostics) | 143.7 ms | 83.0 ms | 1.73× |
| edit the hub → fan-out (84 callers) | 235.2 ms | 81.0 ms | 2.9× |
| **completion in `main.r`** (req→resp) | **203.3 ms** | **20.1 ms** | **10.1×** |

Crucially, the margin is **corpus-depth-dependent**: a shallow synthetic hub (1 level,
trivial bodies) showed only ~1.1–1.2× on every scenario (diagnostics *and* completion),
too small to gate without flaking. The gate corpus must reproduce worldwide-like
depth/width to give a robust margin.

Completion latency is dominated by resolving the cross-file scope at the cursor — the
same standalone-hub resolution the cache serves — so it benefits from the directive just
like diagnostics, and most dramatically (10×) because a single completion re-resolves
the full deep closure on every keystroke when uncached. (The directive also reduces the
candidate set — 8,811 → 7,177 on worldwide — by removing caller-union leakage; faster
*and* more precise.)

## Non-goals

- No dependence on `worldwide` (private; not in CI).
- Not re-benchmarking codex (#490); this lands on claude #491.
- No new public API surface — the cache-threading entry points
  (`scope_at_position_with_graph_cached`, `…_cached_with_standalone_cache`) and
  `StandaloneCacheCtx` / `StandaloneScopeCache` are already `pub`.

## Components

### 1. Synthetic corpus helper

A helper building a worldwide-shaped hub workspace in a `tempfile::TempDir`:

- A **hub** that sources a wide + deep forward closure (~50 children across several
  chained levels), with real top-level symbols and `library()` calls so resolution
  does non-trivial work (the cost per resolution is what makes the with/without margin
  large).
- ~80 **caller** files that `source()` the hub.
- Two variants: hub header **with** `# raven: standalone` vs **without**.

**Location:** because both the criterion bench (built with `--features test-support`)
and the gate test must share it, the builder is hoisted into the crate behind
`#[cfg(any(test, feature = "test-support"))]` (a small `standalone_bench_support`
module), returning the corpus's artifacts/metadata maps + dependency graph (it composes
the same primitives the existing bench-local `precompute_artifacts` /
`build_dependency_graph` use). Width/depth are tuned so the with/without margin
reproduces the worldwide ~2–3× (see Verification).

### 2. Criterion benchmarks

New group `cross_file_standalone_cache` in `crates/raven/benches/cross_file.rs`:

- `resolve_hub_eof/{cold_miss, warm_hit, cache_off}` — single isolated-scope resolution
  of the standalone hub: cold (fresh cache, miss), warm (pre-populated cache, hit), and
  cache-off (`scope_at_position_with_graph_cached`, no ctx). Guards the cache
  mechanism's per-call cost.
- `fanout/{with_directive, without_directive}` — the aggregate: resolve N callers,
  directive + one shared `StandaloneScopeCache` vs no-directive (cache never engages).
  The headline tracked number; mirrors the gate scenario.
- `completion/{with_directive_warm, without_directive}` — resolve a single caller at a
  mid-file cursor (after its `source()` call) — the scope resolution a completion request
  performs. With a warm shared cache (directive) the hub is a hit; without the directive
  it re-resolves. Tracks the completion path the user observed (worldwide 203→20 ms).

### 3. Hard gate test (deterministic primary + generous timing secondary)

A `#[test]` in the normal suite (so integration.yml runs it on every PR and a failure
blocks merge). It asserts the **causal mechanism**, not wall-clock:

- **Primary (deterministic, non-flaky):** in the N-caller fan-out, the directive path
  resolves the hub closure once and the shared `StandaloneScopeCache` records **≥ N−1
  hits** (reuse scales with fan-out); the no-directive path consults the cache **zero**
  times (N full resolutions). Read via `StandaloneScopeCache::hits()` / `misses()`.
  This fails exactly when the directive stops delivering reuse — i.e. stops being
  faster — and never flakes on CI timing noise.
- **Secondary (timing, generous margin):** median-of-K wall-clock of the fan-out is
  ≥ 1.5× faster with the directive than without (real margin ~3×, so headroom is large).
  Catches gross constant-factor regressions the hit-count can't see. Ratio-based, warmed,
  median-of-K.

Rationale for deterministic-primary: perf.yml only tracks the `startup` bench and its
critcmp step posts a PR comment without hard-failing, so a wall-clock-only gate could
neither hard-fail reliably nor avoid shared-runner timing noise. The deterministic
assertion gives a true hard-fail with zero flakiness.

### 4. CI wiring

- **Gate test:** runs under `cargo test` (integration.yml) — hard-fails on regression,
  every PR. No workflow change needed.
- **Criterion tracking:** extend perf.yml's existing baseline/critcmp steps to also run
  `--bench cross_file` (alongside `startup`), so the new group's numbers appear in the
  PR perf comment (informational, `--threshold 5`).

## Threshold / margin rationale + verification

Before fixing the 1.5× secondary threshold, **measure** the with/without margin on the
synthetic corpus and confirm it robustly exceeds 1.5× (target ≈2–3×, matching worldwide).
If a self-contained corpus cannot robustly exceed the threshold, drop the timing
secondary and rely on the deterministic primary alone (which does not depend on absolute
timing) — the gate's correctness does not hinge on the timing assertion.

## Risks & mitigations

- **Synthetic corpus can't reproduce the margin** → tune depth/width; worst case, keep
  only the deterministic gate (timing secondary is optional).
- **Timing flakiness on CI** → deterministic primary is the hard-fail; timing secondary
  uses a generous ratio + median-of-K and lives in the same test (skippable/looser if
  it ever flakes).
- **Bench runtime** → criterion benches are local/perf-job only; the gate test uses a
  modest N and K to stay within unit-test time budgets.

## Acceptance criteria

- `cargo test` includes a gate test that fails if the directive's fan-out cache reuse
  regresses (deterministic) and, secondarily, if the with-directive fan-out is not
  ≥1.5× faster.
- `cargo bench --bench cross_file` includes the `cross_file_standalone_cache` group.
- perf.yml runs `--bench cross_file` so the group is tracked in PR perf comments.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --features
  test-support -- -D warnings` stay green.
- Verified: synthetic with/without margin measured and threshold set with headroom.

## Files touched

- `crates/raven/src/cross_file/` — new `standalone_bench_support` module (or section)
  behind `#[cfg(any(test, feature = "test-support"))]`: the shared corpus builder.
- `crates/raven/benches/cross_file.rs` — `cross_file_standalone_cache` group calling the
  shared builder.
- `crates/raven/src/cross_file/standalone_cache.rs` — the deterministic + timing gate as
  an in-crate `#[cfg(test)]` test (reuses the shared builder; has access to the `pub`
  resolver entry points and `StandaloneScopeCache::hits()`/`misses()`).
- `.github/workflows/perf.yml` — add `--bench cross_file` to baseline/critcmp steps.
- `specs/issue-483-wi2b-notes.md` — cross-reference this design.
