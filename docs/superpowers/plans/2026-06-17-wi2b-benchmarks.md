# WI2b Standalone-Cache Benchmarks + Directive Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic CI gate proving `# raven: standalone` makes hub-heavy resolution cheaper, plus criterion benches tracking WI2b resolution cost over time.

**Architecture:** A shared `test-support` corpus builder produces a deep/wide hub workspace (with/without the directive). Criterion benches in `cross_file.rs` time the cache hit/miss/off and fan-out paths. A `#[cfg(test)]` gate asserts the cache reuse mechanism scales with fan-out (deterministic, primary) and that the directive path is ≥1.5× faster (timing, secondary). perf.yml is extended to track the new bench group.

**Tech Stack:** Rust, criterion, `tempfile`, the public `raven::cross_file` resolver API.

## Global Constraints

- Toolchain pinned `1.96.0`; both CI gates must stay green: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --features test-support -- -D warnings` (zero warnings).
- Benches require `--features test-support` (see `crates/raven/Cargo.toml` `[[bench]]`).
- No new `pub` surface needed: use `raven::cross_file::scope_at_position_with_graph_cached_with_standalone_cache`, `ParentPrefixCache::new()`, `standalone_cache::{StandaloneCacheCtx, StandaloneScopeCache}`, `DependencyGraph::edge_revision()`.
- `StandaloneCacheCtx { cache: Arc<StandaloneScopeCache>, edge_revision: u64, package_config_generation: u64 }` — all fields `pub`.
- Self-contained: no dependence on `worldwide`.

## File Structure

- `crates/raven/src/test_utils/standalone_hub.rs` (new) — shared corpus builder, `#[cfg(any(test, feature = "test-support"))]`. Reachable by benches (test-support) and crate tests.
- `crates/raven/src/test_utils/mod.rs` (modify) — declare `pub mod standalone_hub;`.
- `crates/raven/benches/cross_file.rs` (modify) — `cross_file_standalone_cache` group + register in `criterion_group!`.
- `crates/raven/src/cross_file/standalone_cache.rs` (modify) — append the gate test to the existing `#[cfg(test)] mod tests`.
- `.github/workflows/perf.yml` (modify) — add `--bench cross_file` to the baseline + critcmp steps.
- `specs/issue-483-wi2b-notes.md` (modify) — one-line cross-reference to the design.

---

### Task 1: Shared corpus builder + margin verification

**Files:**
- Create: `crates/raven/src/test_utils/standalone_hub.rs`
- Modify: `crates/raven/src/test_utils/mod.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct HubCorpus {
      pub _dir: tempfile::TempDir,            // keep alive; drop deletes files
      pub hub_uri: url::Url,
      pub caller_uris: Vec<url::Url>,
      pub artifacts: std::collections::HashMap<url::Url, std::sync::Arc<raven::cross_file::ScopeArtifacts>>,
      pub metadata: std::collections::HashMap<url::Url, std::sync::Arc<raven::cross_file::types::CrossFileMetadata>>,
      pub graph: raven::cross_file::DependencyGraph,
      pub folder: url::Url,
  }
  /// `standalone` toggles the `# raven: standalone` header on the hub.
  /// `width` children in the hub's forward closure, `depth` chain levels,
  /// `callers` files sourcing the hub.
  pub fn build_hub_corpus(standalone: bool, width: usize, depth: usize, callers: usize) -> HubCorpus
  ```
  Inside the crate the paths are `crate::cross_file::…`; the signature above shows the `raven::` names benches use.

- [ ] **Step 1: Implement `build_hub_corpus`** mirroring `benches/cross_file.rs::{precompute_artifacts, build_dependency_graph}` but using public APIs (`extract_metadata`, `compute_artifacts`, and the same `DependencyGraph` construction the bench uses — copy that helper's body). Corpus shape (flat dir; "depth" is logical via `source()` chains):
  - `hub.R`: optional first line `# raven: standalone`; then `source("mid_0.R") … source("mid_{width-1}.R")`; then a function using some child symbols.
  - chain: `mid_i.R` sources `leaf_i_0.R` which sources `leaf_i_1.R` … up to `depth` levels; each leaf does `library(stats)` + defines a top-level function `sym_i_l <- function(x) x`.
  - `caller_k.R`: `source("hub.R")` + a function referencing a hub/child symbol.
- [ ] **Step 2: Declare the module** — add `pub mod standalone_hub;` to `crates/raven/src/test_utils/mod.rs` (check whether it is already `#[cfg(any(test, feature = "test-support"))]`-gated at the parent; match the existing gating of sibling modules like `fixture_workspace`).
- [ ] **Step 3: Compile-check** — `cargo build --features test-support` and `cargo build --tests --features test-support`. Expected: clean.
- [ ] **Step 4: Margin verification spike (temporary)** — add a temporary `#[test]` that builds `build_hub_corpus(true, 50, 3, 80)` and `build_hub_corpus(false, …)`, runs the fan-out loop from Task 3's helper (resolve all `caller_uris`), times both with `std::time::Instant` (median of 11, 2 warmup), and `eprintln!`s the ratio. Run with `cargo test --features test-support standalone_hub_margin -- --nocapture`. Record the ratio.
- [ ] **Step 5: Decide threshold** — if ratio robustly > 1.5× (target ≈2–3×), keep Task 3's 1.5× timing assertion. If not, tune `width`/`depth` upward and re-measure; if still not, note in the gate test that the timing secondary is dropped (deterministic primary stands alone). Delete the temporary spike test.
- [ ] **Step 6: Commit** — `git add crates/raven/src/test_utils/standalone_hub.rs crates/raven/src/test_utils/mod.rs && git commit -m "test(#483): shared standalone-hub corpus builder for WI2b benches"`

---

### Task 2: Criterion bench group `cross_file_standalone_cache`

**Files:**
- Modify: `crates/raven/benches/cross_file.rs`

**Interfaces:**
- Consumes: `raven::test_utils::standalone_hub::{build_hub_corpus, HubCorpus}` (Task 1); `scope_at_position_with_graph_cached_with_standalone_cache`, `ParentPrefixCache`, `standalone_cache::{StandaloneCacheCtx, StandaloneScopeCache}`, `BackwardDependencyMode`.

- [ ] **Step 1: Add imports** to `cross_file.rs`:
  ```rust
  use raven::cross_file::standalone_cache::{StandaloneCacheCtx, StandaloneScopeCache};
  use raven::cross_file::{BackwardDependencyMode, ParentPrefixCache, scope_at_position_with_graph_cached_with_standalone_cache};
  use raven::test_utils::standalone_hub::build_hub_corpus;
  ```
- [ ] **Step 2: Add resolve helpers** (file-local). The query is a **caller** at EOF (the
  depth≥1 forward-child path the cache serves), never the hub directly:
  ```rust
  fn resolve_caller(c: &raven::test_utils::standalone_hub::HubCorpus,
                    caller: &url::Url, ctx: Option<StandaloneCacheCtx>) {
      let mut prefix_cache = ParentPrefixCache::new();
      let base: std::collections::HashSet<String> = std::collections::HashSet::new();
      black_box(scope_at_position_with_graph_cached_with_standalone_cache(
          caller, u32::MAX, u32::MAX,
          &|u| c.artifacts.get(u).cloned(),
          &|u| c.metadata.get(u).cloned(),
          &c.graph, Some(&c.folder), 64, &base, true,
          BackwardDependencyMode::Auto, &|| false, &mut prefix_cache, None, None, ctx,
      ));
  }
  fn ctx_for(c: &raven::test_utils::standalone_hub::HubCorpus, cache: std::sync::Arc<StandaloneScopeCache>) -> StandaloneCacheCtx {
      StandaloneCacheCtx { cache, edge_revision: c.graph.edge_revision(), package_config_generation: 0 }
  }
  ```
- [ ] **Step 3: Add `bench_standalone_cache`**:
  ```rust
  fn bench_standalone_cache(c: &mut Criterion) {
      let mut group = c.benchmark_group("cross_file_standalone_cache");
      group.sample_size(20);
      let corpus = build_hub_corpus(true, 50, 3, 80);
      let c0 = corpus.caller_uris[0].clone();

      // caller_resolve: one caller, cache cold-miss vs warm-hit vs off
      group.bench_function("caller_resolve/cold_miss", |b| {
          b.iter(|| resolve_caller(&corpus, &c0, Some(ctx_for(&corpus, std::sync::Arc::new(StandaloneScopeCache::new())))))
      });
      let warm = std::sync::Arc::new(StandaloneScopeCache::new());
      resolve_caller(&corpus, &c0, Some(ctx_for(&corpus, warm.clone()))); // populate
      group.bench_function("caller_resolve/warm_hit", |b| {
          b.iter(|| resolve_caller(&corpus, &c0, Some(ctx_for(&corpus, warm.clone()))))
      });
      group.bench_function("caller_resolve/cache_off", |b| {
          b.iter(|| resolve_caller(&corpus, &c0, None))
      });

      // fanout: resolve all callers, directive+shared cache vs no-directive
      let nodir = build_hub_corpus(false, 50, 3, 80);
      group.bench_function("fanout/with_directive", |b| {
          b.iter(|| { let cache = std::sync::Arc::new(StandaloneScopeCache::new());
              for u in &corpus.caller_uris { resolve_caller(&corpus, u, Some(ctx_for(&corpus, cache.clone()))); } })
      });
      group.bench_function("fanout/without_directive", |b| {
          b.iter(|| { for u in &nodir.caller_uris { resolve_caller(&nodir, u, None); } })
      });

      // completion: single caller resolve, warm shared cache (hit) vs no-directive.
      // Mirrors the steady-state per-completion scope-resolution cost (worldwide 203→20ms).
      let warm2 = std::sync::Arc::new(StandaloneScopeCache::new());
      resolve_caller(&corpus, &corpus.caller_uris[0], Some(ctx_for(&corpus, warm2.clone())));
      group.bench_function("completion/with_directive_warm", |b| {
          b.iter(|| resolve_caller(&corpus, &corpus.caller_uris[0], Some(ctx_for(&corpus, warm2.clone()))))
      });
      group.bench_function("completion/without_directive", |b| {
          b.iter(|| resolve_caller(&nodir, &nodir.caller_uris[0], None))
      });
      group.finish();
  }
  ```
  (Add a `resolve_caller(corpus, caller_uri, ctx)` helper that queries `caller_uri` at `u32::MAX,u32::MAX` — it re-resolves the standalone hub as a forward child, the depth≥1 path the cache serves. This is the only resolve helper needed; there is no separate `resolve_hub` because resolving the hub directly is the depth-0 own-root path the cache excludes.)
- [ ] **Step 4: Register** in the `criterion_group!(...)` macro at the bottom of `cross_file.rs` — add `bench_standalone_cache` to the list.
- [ ] **Step 5: Run** — `cargo bench --features test-support --bench cross_file -- cross_file_standalone_cache`. Expected: 5 benchmarks report; `warm_hit` < `cold_miss`; `fanout/with_directive` < `fanout/without_directive`.
- [ ] **Step 6: Commit** — `git commit -am "bench(#483): cross_file_standalone_cache group (hit/miss/off + fanout)"`

---

### Task 3: Deterministic gate test (+ generous timing secondary)

**Files:**
- Modify: `crates/raven/src/cross_file/standalone_cache.rs` (append to `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `crate::test_utils::standalone_hub::build_hub_corpus`; `crate::cross_file::scope_at_position_with_graph_cached_with_standalone_cache`; `super::{StandaloneCacheCtx, StandaloneScopeCache}`; `ParentPrefixCache`.

- [ ] **Step 1: Write the failing gate test.** Add a `resolve_caller` helper in the test module (crate-internal `crate::cross_file::…` paths), then:
  ```rust
  #[test]
  fn standalone_directive_enables_fanout_cache_reuse() {
      let n = 80;
      let dir = crate::test_utils::standalone_hub::build_hub_corpus(true, 50, 3, n);
      let cache = std::sync::Arc::new(StandaloneScopeCache::new());
      for u in &dir.caller_uris {
          resolve_caller(&dir, u, Some(StandaloneCacheCtx {
              cache: cache.clone(), edge_revision: dir.graph.edge_revision(),
              package_config_generation: 0 }));
      }
      // PRIMARY (deterministic): reuse scales with fan-out — hub computed ~once,
      // reused for the rest. Allow a small slack for legitimate distinct keys.
      assert!(cache.hits() as usize >= n - 5,
          "directive fan-out should reuse the cached hub scope: {} hits over {} callers", cache.hits(), n);

      // No-directive: the standalone cache is never consulted.
      let nodir = crate::test_utils::standalone_hub::build_hub_corpus(false, 50, 3, n);
      let cache_off = std::sync::Arc::new(StandaloneScopeCache::new());
      for u in &nodir.caller_uris {
          resolve_caller(&nodir, u, Some(StandaloneCacheCtx {
              cache: cache_off.clone(), edge_revision: nodir.graph.edge_revision(),
              package_config_generation: 0 }));
      }
      assert_eq!(cache_off.hits() + cache_off.misses(), 0,
          "non-standalone hub must not consult the standalone cache");
  }
  ```
- [ ] **Step 2: Run to verify it fails** if the builder/wiring is wrong — `cargo test --features test-support standalone_directive_enables_fanout_cache_reuse`. (It should pass once Task 1 is correct; if the hit count is off, adjust the corpus or the `n - 5` slack based on observed `cache.hits()`.)
- [ ] **Step 3: Add the timing secondary** (only if Task 1 Step 5 confirmed ≥1.5×). Median-of-11 (2 warmup) `Instant`-timed fan-out for both corpora; `assert!(without_median >= with_median * 3 / 2, …)`. Keep it in the same test or a sibling `#[test]`. If the spike showed an insufficient/noisy margin, omit this step and add a code comment citing the design's "timing secondary optional" clause.
- [ ] **Step 4: Run the gate** — `cargo test --features test-support standalone` (runs the cache module tests). Expected: PASS. Run twice to confirm stability.
- [ ] **Step 5: Commit** — `git commit -am "test(#483): gate — standalone directive must enable fan-out cache reuse"`

---

### Task 4: CI wiring + docs cross-reference

**Files:**
- Modify: `.github/workflows/perf.yml`
- Modify: `specs/issue-483-wi2b-notes.md`

- [ ] **Step 1: Track the new bench in perf.yml.** In the "save baseline" and "compare (pr)" steps, change the bench invocation to run both targets, e.g.:
  ```yaml
  run: cargo bench -p raven --features test-support --bench startup --bench cross_file -- --save-baseline main
  ```
  and the matching `--save-baseline pr` line. (critcmp `main pr --threshold 5` then covers both.)
- [ ] **Step 2: Cross-reference the design** — add a one-line bullet to `specs/issue-483-wi2b-notes.md` pointing at `specs/issue-483-wi2b-benchmarks-design.md` and the gate test name.
- [ ] **Step 3: Final gates** — run:
  - `cargo fmt --all`
  - `cargo clippy --workspace --all-targets --features test-support -- -D warnings` → zero warnings.
  - `cargo test --features test-support standalone` → PASS.
- [ ] **Step 4: Commit** — `git commit -am "ci(#483): track cross_file bench in perf.yml; xref benchmark design"`

---

## Self-Review

- **Spec coverage:** corpus builder (Task 1) ✓; criterion hit/miss/off + fanout (Task 2) ✓; deterministic gate + timing secondary (Task 3) ✓; perf.yml tracking (Task 4) ✓; threshold verification (Task 1 Step 4–5) ✓; fmt/clippy/test green (Task 4 Step 3) ✓.
- **Placeholders:** the only deferred decision is the timing threshold, which is explicitly resolved by the Task 1 verification spike before Task 3 Step 3 — not a placeholder.
- **Type consistency:** `build_hub_corpus(standalone, width, depth, callers)` and `HubCorpus` fields are used identically in Tasks 2–3; `StandaloneCacheCtx` constructed with the same three fields throughout; `resolve_caller(corpus, uri, ctx)` signature consistent across bench and test (defined once per crate boundary, since benches and tests can't share a fn).
