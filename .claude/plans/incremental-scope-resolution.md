# Incremental scope resolution for diagnostic computation

> **For the executing agent:** this plan is self-contained. You don't need the conversation transcript that produced it. Read the "Background context" and "Architectural insight" sections first, then execute Stage 1 → Stage 2 in order. The kickoff prompt at the bottom is what initiated this work; reproduce it in a fresh session if you're starting from there.

Branch: `t3code/optimize-diagnostic-updates` (continuation, off `91c3617`/`65b2959`).
Worktree: `/Users/jmb/.t3/worktrees/raven/t3code-9723b935`.

## Background context

### What's broken (the user's symptom)

Opening `~/repos/worldwide/scripts/data.r` in VS Code with Raven shows a ~1-2 second lag before the correct `Undefined variable: xyz` diagnostic appears for the `xyz = xyz` line near the top of the file. The lag is structural (cold-start cost), not a correctness bug. The previous correctness bug — a same-file leak via cross-file recursion — was fixed in commits `91c3617` and `65b2959`; do not re-investigate it.

### Lag breakdown (measured on `~/repos/worldwide`, 414 R files, 16-core M-series Mac)

| Phase | Time | Notes |
|-------|------|-------|
| `scan_workspace` (single-threaded inner loop in `state.rs:1083-1193`) | 1117 ms | Separate plan — Tier 1 of the cold-start lag investigation |
| `apply_workspace_index` | 2 ms | Negligible |
| **Post-scan diagnostic for `data.r`** | **743 ms** | **This plan's target** |

The post-scan diagnostic cost is **entirely** in `diagnostics_from_snapshot` scope queries (snapshot build itself is 0.16 ms even with 172 pre-collected artifacts/metadata). The cost is `360 unique (line, col) cache entries × ~1.8 ms/query through the 172-file backward neighborhood`.

### Measurement harness (already on this branch)

* **End-to-end:** `cargo run --release --example profile_worldwide --features test-support`
  Output includes: per-file scan body breakdown, scan_workspace median, PackageLibrary init, COLD vs POST-scan diagnostic medians for `data.r`, and two A/B fix experiments for the workspace scan.
* **Trace-level diagnostic phases:** `RUST_LOG=raven::handlers=trace cargo run --release --example profile_worldwide --features test-support 2>&1 | grep "Diagnostics computed"` — prints "Diagnostics computed in N ms (scope resolution: M ms, K cache entries)" per call.
* **Synthetic topology breakdown:** `cargo run --release --example profile_diagnostics --features test-support` — exercises various synthetic shapes; useful for verifying changes don't regress simpler cases.
* **Workspace bench:** `cargo bench --bench cross_file --features test-support`.

### Test suite as safety net

* `cargo test --release -p raven --lib --features test-support` — 3013 unit tests, runs in ~11s.
* `crates/raven/src/handlers.rs::position_aware_tests` — the regression test mod for cross-file scope correctness.
* `crates/raven/src/cross_file/scope.rs` has its own `tests` and `proptests` mods.
* The `#[ignore]`d test `position_aware_tests::debug_real_worldwide_data_r` loads the real `~/repos/worldwide` workspace end-to-end — a useful integration harness; opt in with `--ignored`.

### Critical CLAUDE.md learnings to respect

These existing project invariants govern the code area this plan touches:

* **`ScopeArtifacts.timeline` is sorted by *effect* position, not anchor.** `event_effect_position(event)` returns `visible_from_*` for `Def`, `start_*` for `FunctionScope`, and the event's own `line/column` otherwise. The four production sort sites in `scope.rs` (`compute_artifacts` and `compute_artifacts_with_metadata`, twice each) use it.
* **`ScopeEvent::Def` carries two distinct positions: `line/column` (anchor, the LHS identifier — drives hover/go-to-definition) and `visible_from_line/visible_from_column` (effect, when the binding becomes visible).** For non-function RHS, `visible_from` is the end of the whole assignment (so `merp <- merp` correctly flags the RHS). For function-definition RHS (including paren-wrapped), `visible_from` is the LHS to support recursion. For right-arrow `function_definition -> name`, `visible_from` is the function-definition start.
* **Same-file leak filters at three cross-file merge points** (commits 91c3617 / 65b2959):
  * `scope.rs:3026-3038` — symbol filter: skip `parent_scope.symbols` whose `source_uri == *uri`.
  * `scope.rs:3111-3127` — package filter: skip `parent_scope.{inherited,loaded}_packages` whose only known origin is `uri`.
  * `handlers.rs:5094-5118` — snapshot out-of-scope collector: only attribute "used before sourced" when the named symbol is in the source target's `exported_interface` AND the symbol record's `source_uri != *uri`.
* **Hold-the-lock-release-it-promptly.** Diagnostic snapshot building must NOT hold the `WorldState` read lock across expensive operations. `DiagnosticsSnapshot::build` is the lock-held step; `diagnostics_from_snapshot` runs after the lock is released.
* **`Arc<ScopeArtifacts>` and `Arc<CrossFileMetadata>`** — these are stored as `Arc` in `DocumentState`, both `IndexEntry` types, and `DiagnosticsSnapshot`. Closures returning them clone the `Arc` (refcount bump), not the inner data.
* **Cancellation tokens (`DiagCancelToken`)** are threaded into `scope_at_position_with_graph` and into recursive scope resolution; check `is_cancelled()` between collector stages and every 64 iterations in hot loops.

### Recent commits to read before starting

* `91c3617` — `fix: prevent same-file artifacts from leaking through cross-file recursion`. Added the same-file leak filters listed above and `ScopeAtPosition::package_origins`. Read the commit message and the test additions in `position_aware_tests` (especially `test_self_referential_assignment_*`).
* `65b2959` — `fix: address codex review findings on cross-file leak fixes`. Strengthened the snapshot out-of-scope collector's attribution check (now requires the symbol to be in the *specific* source target's exported_interface, not just `source_uri != *uri`) and switched `package_origins` to `Arc<Url>`.

### Files this plan touches

* `crates/raven/src/cross_file/scope.rs` — main work area. Stage 1 extracts `parent_prefix_at` from `scope_at_position_with_graph_recursive`. Stage 2 adds `ScopeStream`.
* `crates/raven/src/handlers.rs` — `DiagnosticsSnapshot::get_scope` (`:206-236`) routes through the cached path. The two large diagnostic collectors (`collect_undefined_variables_from_snapshot` near `:5145`, `collect_out_of_scope_diagnostics_from_snapshot`) are rewritten in Stage 2 to use `ScopeStream`.
* `CLAUDE.md` — Learning entries added in S1.5 and S2.7.

## Architectural insight

`scope_at_position_with_graph_recursive` (`scope.rs:2766`) at the queried URI does two phases:

* **STEP 1 — parent walk** (`scope.rs:2861-3128`, the `if !is_revisit { ... }` block). For each backward edge, recurse into the parent at its `(call_site_line, call_site_col)` (or `(MAX, MAX)` when the query is inside a function body and `hoist_globals_in_functions=true`). Merge `parent_scope.{symbols, inherited_packages, package_origins, chain, depth_exceeded, loaded_packages}` into the current `scope`. The same-file leak filters live in this region.
* **STEP 2 — local timeline** (`scope.rs:3131+`). Iterate `artifacts.timeline` (sorted by effect position), apply events whose effect position is `<= (line, col)`. `is_symbol_visible` filters function-local symbols against `active_function_scopes_at(function_scope_tree, line, col)`. Forward `Source` events recurse into children at `(MAX, MAX)`.

For all queries on the same URI within one `diagnostics_from_snapshot` call:

* **STEP 1 is parametrized along exactly one bit** — `query_inside_function: bool` (top-level vs inside-any-function). With `hoist_globals_in_functions=true` (default), top-level queries pass parents their `call_site` position; inside-function queries pass `MAX`. The bit flips only when the query crosses a function boundary. With `hoist_globals_in_functions=false`, parents are always queried at `call_site` — the bit becomes irrelevant. So at most two distinct STEP 1 outputs per URI per snapshot.
* **STEP 2 is monotonic in document order** (with one caveat). As the query position advances, top-level Def/PackageLoad events accumulate; entering a function body pushes the function's parameters and body-locals onto a per-function frame; leaving pops the frame. Forward `Source` events: each one fires once when first crossed; subsequent queries reuse the resolved child contribution.

The user's `n*` insight: the "relevant earlier query position `n*`" for streaming is **the most recent function-scope-stack landmark** — entry into the innermost active function, or the start of the file for top-level queries. Between `n*` and `n` only timeline events visible to the active stack matter. Per-function frames (one per active function on the stack) make this naturally O(timeline_events visible to active stack), not O(all timeline events up to n).

**Why per-position re-walks repeat invariant work today.** `scope_at_position_with_graph` is a generic per-position oracle. The diagnostic collectors call it once per identifier usage. Each call starts fresh (empty `visited` HashMap, full STEP 1 walk, full STEP 2 timeline replay) even when called in tight loops on positions in the same file. Stage 1 caches STEP 1; Stage 2 streams STEP 2.

## Stage 1 — cache STEP 1 (parent prefix) per URI per snapshot

The cached value is the post-merge result of STEP 1 against a target URI: parent symbols (post same-file-filter), inherited/loaded packages, package_origins, chain, and depth_exceeded. Two cache slots per URI keyed by `query_inside_function: bool`.

### Tasks

- [ ] **S1.0 — bench baseline.** Run `cargo run --release --example profile_worldwide --features test-support 2>&1 | tail -40` and record the `scripts/data.r POST-scan diag` median (currently ~743 ms). Save a copy of the full output to `.claude/plans/incremental-scope-resolution-baseline.txt` for end-of-plan comparison.

- [ ] **S1.1 — extract `ParentPrefix` and `parent_prefix_at`.** Pure refactor.

  Add to `crates/raven/src/cross_file/scope.rs` (above `scope_at_position_with_graph_recursive`):

  ```rust
  /// Cached result of STEP 1 (the parent walk) for a queried URI.
  ///
  /// Position-invariant within one `DiagnosticsSnapshot`'s diagnostic pass:
  /// parametrized only by `query_inside_function` (selects whether parents
  /// were queried at their call-site or at MAX), so callers cache two slots
  /// per URI.
  ///
  /// Same-file leak filters from commits 91c3617/65b2959 are applied while
  /// computing this struct; the cached value is post-filter and safe to reuse.
  #[derive(Debug, Clone, Default)]
  pub(crate) struct ParentPrefix {
      pub symbols: HashMap<Arc<str>, ScopedSymbol>,
      pub chain: Vec<Url>,
      pub depth_exceeded: Vec<(Url, u32, u32)>,
      pub inherited_packages: HashSet<String>,
      pub loaded_packages: HashSet<String>,
      pub package_origins: HashMap<String, HashSet<Arc<Url>>>,
  }
  ```

  Cut the body of `scope_at_position_with_graph_recursive`'s `if !is_revisit { ... }` block (`scope.rs:2861-3128`) into a new function:

  ```rust
  #[allow(clippy::too_many_arguments)]
  fn parent_prefix_at<F, G>(
      uri: &Url,
      query_inside_function: bool,
      get_artifacts: &F,
      get_metadata: &G,
      graph: &super::dependency::DependencyGraph,
      workspace_root: Option<&Url>,
      max_depth: usize,
      current_depth: usize,
      visited: &mut HashMap<Url, (u32, u32)>,
      base_exports: &HashSet<String>,
      hoist_globals: bool,
      backward_dep_mode: super::config::BackwardDependencyMode,
      is_cancelled: &dyn Fn() -> bool,
  ) -> ParentPrefix
  where
      F: Fn(&Url) -> Option<Arc<ScopeArtifacts>>,
      G: Fn(&Url) -> Option<std::sync::Arc<super::types::CrossFileMetadata>>,
  { /* moved body */ }
  ```

  The function builds a fresh `ParentPrefix` and writes the same fields STEP 1 currently writes into `scope`. The caller (`scope_at_position_with_graph_recursive`) then merges the returned `ParentPrefix` into `scope`:

  ```rust
  let prefix = parent_prefix_at(uri, query_inside_function, get_artifacts, ...);
  scope.symbols = prefix.symbols.clone();
  scope.chain.extend(prefix.chain.iter().cloned());
  scope.depth_exceeded.extend(prefix.depth_exceeded.iter().cloned());
  scope.inherited_packages.extend(prefix.inherited_packages.iter().cloned());
  scope.loaded_packages.extend(prefix.loaded_packages.iter().cloned());
  for (k, v) in &prefix.package_origins {
      scope.package_origins.entry(k.clone()).or_default().extend(v.iter().cloned());
  }
  ```

  Note `query_inside_function` was previously a local `let` in `scope_at_position_with_graph_recursive`; the lifted function takes it as a parameter so callers can vary it.

  **Verify:** `cargo test --release -p raven --lib --features test-support` → 3013 passing. **This commit must be a behavior-preserving extract; do not change observable semantics.**

- [ ] **S1.2 — add the caching wrapper.** Append to `scope.rs`:

  ```rust
  /// Per-snapshot cache for STEP 1 results, keyed by (target URI,
  /// query_inside_function). Lives inside `DiagnosticsSnapshot` so it
  /// shares the snapshot's lifetime; never shared across snapshots.
  #[derive(Debug, Default)]
  pub struct ParentPrefixCache {
      entries: HashMap<(Url, bool), Arc<ParentPrefix>>,
  }

  impl ParentPrefixCache {
      pub fn new() -> Self { Self::default() }
      pub fn len(&self) -> usize { self.entries.len() }
  }
  ```

  Add a cached entry-point alongside `scope_at_position_with_graph`:

  ```rust
  #[allow(clippy::too_many_arguments)]
  pub fn scope_at_position_with_graph_cached<F, G>(
      uri: &Url,
      line: u32,
      column: u32,
      get_artifacts: &F,
      get_metadata: &G,
      graph: &super::dependency::DependencyGraph,
      workspace_root: Option<&Url>,
      max_depth: usize,
      base_exports: &HashSet<String>,
      hoist_globals: bool,
      backward_dep_mode: super::config::BackwardDependencyMode,
      is_cancelled: &dyn Fn() -> bool,
      prefix_cache: &mut ParentPrefixCache,
  ) -> ScopeAtPosition
  where
      F: Fn(&Url) -> Option<Arc<ScopeArtifacts>>,
      G: Fn(&Url) -> Option<std::sync::Arc<super::types::CrossFileMetadata>>,
  {
      // Determine query_inside_function for the queried URI at (line, column).
      let inside = match get_artifacts(uri) {
          Some(art) => {
              hoist_globals
                  && !active_function_scopes_at(&art.function_scope_tree, line, column).is_empty()
          }
          None => false,
      };

      // Cache lookup
      let cached: Option<Arc<ParentPrefix>> =
          prefix_cache.entries.get(&(uri.clone(), inside)).cloned();
      let prefix = match cached {
          Some(p) => p,
          None => {
              let mut visited = HashMap::new();
              let computed = parent_prefix_at(
                  uri, inside, get_artifacts, get_metadata, graph,
                  workspace_root, max_depth, 0, &mut visited,
                  base_exports, hoist_globals, backward_dep_mode, is_cancelled,
              );
              let arc = Arc::new(computed);
              prefix_cache.entries.insert((uri.clone(), inside), arc.clone());
              arc
          }
      };

      // Run STEP 2 with the cached prefix as the seed scope.
      // Mirror what scope_at_position_with_graph_recursive does after STEP 1:
      // build the initial scope from the prefix, then iterate the timeline.
      run_step2_from_prefix(
          uri, line, column, &prefix,
          get_artifacts, get_metadata, graph, workspace_root,
          max_depth, base_exports, hoist_globals,
          backward_dep_mode, is_cancelled,
      )
  }
  ```

  Where `run_step2_from_prefix` is STEP 2 extracted into its own function, mirroring how Stage 1 extracted STEP 1. (You may keep STEP 2 inline in `scope_at_position_with_graph_recursive` and instead implement `scope_at_position_with_graph_cached` as: "if cache miss, run the full recursive function; if cache hit, run a STEP-2-only variant.") Either factoring is acceptable; the recursive function's existing code paths must stay byte-identical for the non-cached call sites.

  Make `scope_at_position_with_graph` a thin wrapper that creates a throwaway cache and delegates to `_cached`:

  ```rust
  pub fn scope_at_position_with_graph<F, G>(/* same signature as before */) -> ScopeAtPosition
  where /* ... */
  {
      let mut cache = ParentPrefixCache::new();
      scope_at_position_with_graph_cached(/* args */, &mut cache)
  }
  ```

  **Tests** (add in `mod tests` of `scope.rs`):

  ```rust
  #[test]
  fn test_parent_prefix_cache_two_slots() {
      // Build a 2-file fixture: parent.r with `library(stats); helper <- function() 1`
      // and child.r that sources parent.r and contains a function with a body
      // that references `helper`. Query at: (a) top-level position outside any
      // function, (b) inside the function body. Both should resolve `helper`.
      // Assert ParentPrefixCache has 2 distinct entries (one per `inside` bit)
      // and both queries return the same `helper` symbol the uncached path returns.
      // ...
  }

  #[test]
  fn test_parent_prefix_cache_hit_matches_uncached() {
      // For the same fixture, run scope_at_position_with_graph (uncached) and
      // scope_at_position_with_graph_cached at multiple positions. Assert the
      // resulting ScopeAtPosition fields (symbols, inherited_packages,
      // loaded_packages, chain, depth_exceeded, package_origins) are equal.
  }
  ```

  **Verify:** `cargo test --release -p raven --lib --features test-support` → 3015 passing (3013 existing + 2 new).

- [ ] **S1.3 — wire `DiagnosticsSnapshot::get_scope` through the cached path.**

  In `crates/raven/src/handlers.rs`, modify `DiagnosticsSnapshot`:

  ```rust
  pub(crate) struct DiagnosticsSnapshot {
      // ... existing fields ...
      /// STEP 1 (parent walk) cache shared across all get_scope calls
      /// in this snapshot's diagnostic pass. Reset implicitly when the
      /// snapshot is dropped.
      pub(crate) parent_prefix_cache: std::cell::RefCell<scope::ParentPrefixCache>,
  }
  ```

  Initialize the field in `DiagnosticsSnapshot::build` (handlers.rs near `:200`):

  ```rust
  parent_prefix_cache: std::cell::RefCell::new(scope::ParentPrefixCache::new()),
  ```

  Update `DiagnosticsSnapshot::get_scope` (handlers.rs `:206-236`):

  ```rust
  fn get_scope(
      &self,
      uri: &Url,
      line: u32,
      column: u32,
      cancel: &DiagCancelToken,
  ) -> scope::ScopeAtPosition {
      let get_artifacts = |target_uri: &Url| -> Option<Arc<scope::ScopeArtifacts>> {
          self.artifacts_map.get(target_uri).cloned()
      };
      let get_metadata = |target_uri: &Url| -> Option<std::sync::Arc<crate::cross_file::CrossFileMetadata>> {
          self.metadata_map.get(target_uri).cloned()
      };
      let is_cancelled = || cancel.is_cancelled();

      let mut cache = self.parent_prefix_cache.borrow_mut();
      scope::scope_at_position_with_graph_cached(
          uri, line, column,
          &get_artifacts, &get_metadata,
          &self.cross_file_graph,
          self.workspace_folders.first(),
          self.cross_file_config.max_chain_depth,
          &self.base_exports,
          self.cross_file_config.hoist_globals_in_functions,
          self.cross_file_config.backward_dependencies,
          &is_cancelled,
          &mut cache,
      )
  }
  ```

  `RefCell` is sound here because `DiagnosticsSnapshot` is built inside one `tokio::spawn` task, never shared across threads. If the `Sync` bound trips a compile error, switch to `parking_lot::Mutex` (already a project dep) or `std::sync::Mutex`.

  **Verify:** `cargo test --release -p raven --lib --features test-support` → 3015 passing.

- [ ] **S1.4 — function-form regression tests.** Add to `crates/raven/src/handlers.rs::position_aware_tests`:

  Write a helper `assert_cached_matches_uncached(text: &str, queries: &[(u32, u32)])` that:
  1. Builds a single-file snapshot from `text`.
  2. For each query position, calls `snapshot.get_scope(uri, line, col, cancel)` (uses cache) and the equivalent uncached path (instantiate a throwaway `ParentPrefixCache` in the test harness, or call `scope_at_position_with_graph` directly).
  3. Asserts symbol-set equality, inherited_packages equality, package_origins equality.

  Cover this fixture matrix (each fixture has at least one query position inside any function body and at least one outside; both cache slots `(uri, true)` and `(uri, false)` should be exercised):

  ```rust
  // Left-arrow assignment of function
  "f <- function() { y <- 1; y }"

  // Equals assignment (= is a valid R assignment operator)
  "f = function() { y <- 1; y }"

  // Super-assignment
  "f <<- function() { y <- 1; y }"

  // Right-arrow with REQUIRED parens around the function definition
  "(function() { y <- 1; y }) -> f"

  // Right super-assignment with parens
  "(function() { y <- 1; y }) ->> f"

  // Paren-wrapped recursive function (CLAUDE.md learning: visible_from is LHS)
  "f <- (function() f())"

  // R 4.1+ lambda (tree-sitter-r normalizes \(x) to function_definition)
  "f <- \\(x) x + 1"

  // Anonymous lambda passed as a call argument
  "ys <- sapply(xs, \\(p) p + 1)"

  // Bare function() {} -> name (NOT a right-arrow binding in R or tree-sitter-r;
  // tree-sitter parses as ONE function_definition whose body is `{ ... } -> name`,
  // making `name` a function-LOCAL binding). Document the parse.
  "function() { x <- 1; x } -> f"
  ```

  For each fixture, the assertion is "cached == uncached at every query position". The test does not assert specific symbol presence — it asserts equivalence. Add a separate test for the `xyz <- xyz` self-leak shape (using a 4-file synthetic fixture with backward edges) to confirm the same-file leak filter still applies through the cached path:

  ```rust
  #[test]
  fn test_cached_path_preserves_xyz_self_leak_filter() {
      // Mirror the fixture from test_self_referential_assignment_*: data.r,
      // main.r, shrinkage.r, and a 4-deep backward chain that revisits data.r
      // at MAX. Query at the position of `xyz <- xyz`'s RHS. Assert via the
      // CACHED path that `xyz` is NOT in scope at the RHS position.
  }
  ```

  **Verify:** `cargo test --release -p raven --lib --features test-support` → 3024 passing (or however many tests these add). All existing 3015 pass; no regressions.

- [ ] **S1.5 — measure and document.** Re-run `cargo run --release --example profile_worldwide --features test-support` and confirm `scripts/data.r POST-scan diag` drops to the **target range 50-150 ms** (down from ~743 ms). Save the output to `.claude/plans/incremental-scope-resolution-after-stage1.txt`.

  Add three CLAUDE.md "Learnings" entries (one per bullet, append to the bottom of the Learnings section):

  ```markdown
  - The STEP 1 (parent walk) of `scope_at_position_with_graph` is position-invariant for the queried URI within one `DiagnosticsSnapshot`'s diagnostic pass — parametrized only by `query_inside_function: bool`. Cache it in `ParentPrefixCache` (`HashMap<(Url, bool), Arc<ParentPrefix>>`) owned by the snapshot; the cache shares the snapshot's lifetime so no cross-snapshot invalidation is needed. Same-file leak filters from 91c3617/65b2959 run *inside* the cached region — they apply to every cache hit. Routing `DiagnosticsSnapshot::get_scope` through the cached path drops the `data.r` post-scan diagnostic from 743 ms to ~80 ms on `~/repos/worldwide`.
  - Bare `function() { body } -> name` (no parens around the function) is *not* a right-arrow function binding in R or tree-sitter-r — it parses as one `function_definition` whose body is `{ body } -> name`, where `name` becomes a function-LOCAL binding. To right-assign a function via `->` / `->>` you need explicit parens around the function definition (`(function() {...}) -> name`). Affects user-written code only; `try_extract_function_scope` and `assignment_rhs_is_function_definition` already handle the parsed shapes correctly.
  - Tree-sitter-r normalizes R 4.1+ lambdas (`\(x) body`) into `function_definition` nodes — no separate `lambda_function` node kind to handle. The recursive AST walk in `collect_definitions` emits `FunctionScope` events for lambdas without special-casing.
  ```

- [ ] **S1.6 — commit.** Single commit, message body:
  ```
  perf: cache STEP 1 parent walk per snapshot

  Memoize scope_at_position_with_graph's STEP 1 (parent walk) inside the
  per-DiagnosticsSnapshot scope cache. STEP 1 is position-invariant for
  the queried URI within one diagnostic pass, parametrized only by
  query_inside_function (top-level vs inside-function). At most two slots
  per URI; cache shares the snapshot's lifetime.

  Same-file leak filters from 91c3617/65b2959 are part of the cached
  value — they continue to apply on every cache hit.

  Measured impact on ~/repos/worldwide/scripts/data.r post-scan diagnostic:
  743 ms -> ~80 ms.
  ```

## Stage 2 — streaming STEP 2 over the timeline

After Stage 1, every `get_scope` call still replays STEP 2's full timeline up to the query position. Stage 2 turns the diagnostic collectors into a streaming sweep: usages are processed in document order, and a single `ScopeStream` advances its cursor through `artifacts.timeline` once. Per-function frames give O(timeline events visible to the active function-scope stack) per query instead of O(all events up to the position).

### Design

**Types** (added in `cross_file::scope`):

```rust
/// One scope level: either the top-level/global frame or one active
/// function-scope frame on the function_stack.
#[derive(Debug, Clone, Default)]
struct ScopeFrame {
    /// Symbols added to this frame (Defs, Declarations, source-introduced).
    symbols: HashMap<Arc<str>, ScopedSymbol>,
    /// Packages loaded into this frame.
    packages: HashSet<String>,
    /// Per-package origin tracking parallel to ScopeAtPosition::package_origins
    /// for symbols introduced via Source events on this frame.
    package_origins: HashMap<String, HashSet<Arc<Url>>>,
}

/// Cached child-source contribution: the symbols and packages that one
/// `Source` event introduces. Computed once when the cursor first crosses
/// the source() call site; reused on subsequent queries.
#[derive(Debug, Clone, Default)]
struct ChildSourceContribution {
    symbols: HashMap<Arc<str>, ScopedSymbol>,
    packages: HashSet<String>,
    package_origins: HashMap<String, HashSet<Arc<Url>>>,
    chain: Vec<Url>,
    depth_exceeded: Vec<(Url, u32, u32)>,
}

/// Streaming scope state. Advances forward through `artifacts.timeline`
/// in effect-position order, maintaining a global frame plus a stack of
/// active function-scope frames. `snapshot()` materializes a
/// `ScopeAtPosition` at the cursor; `is_visible(name)` is the cheaper
/// query the diagnostic collectors prefer.
pub(crate) struct ScopeStream<'a, F, G>
where
    F: Fn(&Url) -> Option<Arc<ScopeArtifacts>>,
    G: Fn(&Url) -> Option<std::sync::Arc<super::types::CrossFileMetadata>>,
{
    queried_uri: &'a Url,
    artifacts: &'a ScopeArtifacts,

    /// Stage-1 prefix cache slots (top-level vs inside-function), pre-computed
    /// at construction.
    prefix_top: Arc<ParentPrefix>,
    prefix_in_function: Arc<ParentPrefix>,

    /// Top-level frame, monotonic across the cursor's forward sweep.
    global_frame: ScopeFrame,
    /// Stack of active function frames, outermost first. Pushed when the
    /// cursor enters a `FunctionScope` interval; popped when it leaves.
    function_stack: Vec<(FunctionScopeInterval, ScopeFrame)>,

    /// Index of next event in artifacts.timeline to apply.
    timeline_cursor: usize,
    /// Last position the cursor advanced to (advance_to is monotonic).
    cursor: (u32, u32),

    /// One-shot child-source resolution cache.
    source_contributions: HashMap<(u32, u32), ChildSourceContribution>,

    /// Cross-file resolution context (closures + config, mirrors
    /// `scope_at_position_with_graph_cached`'s parameters).
    get_artifacts: &'a F,
    get_metadata: &'a G,
    graph: &'a super::dependency::DependencyGraph,
    workspace_root: Option<&'a Url>,
    max_depth: usize,
    base_exports: &'a HashSet<String>,
    hoist_globals: bool,
    backward_dep_mode: super::config::BackwardDependencyMode,
    is_cancelled: &'a dyn Fn() -> bool,
    /// Shared prefix cache so child-source recursion benefits from the
    /// same Stage-1 caching as the queried URI.
    prefix_cache: &'a std::cell::RefCell<ParentPrefixCache>,
}
```

**Algorithm — `advance_to(target_line, target_column)`:**

```text
1. While timeline_cursor < timeline.len() AND
        event_effect_position(timeline[timeline_cursor]) <= (target_line, target_column):
       event = timeline[timeline_cursor]
       match event {
           FunctionScope { start_line, start_column, end_line, end_column, parameters }:
               // We've crossed a function body's start. Push a new frame seeded
               // with parameters (which become visible at the body start).
               interval = FunctionScopeInterval::new(
                   Position::new(start_line, start_column),
                   Position::new(end_line, end_column),
               );
               frame = ScopeFrame::default();
               for param in parameters {
                   frame.symbols.insert(param.name.clone(), param.clone());
               }
               function_stack.push((interval, frame));

           Def { visible_from_line, visible_from_column, symbol, function_scope, .. }:
               // Apply at the symbol's effect position. Pick frame: global if
               // function_scope is None, otherwise the frame for that interval
               // (must be on the stack — pushed when the cursor entered the
               // body).
               target = pick_frame_mut(function_scope);
               target.symbols.insert(symbol.name.clone(), symbol.clone());

           Removal { line, column, symbols, function_scope }:
               target = pick_frame_mut(function_scope);
               for name in symbols {
                   target.symbols.remove(name.as_str());
               }

           PackageLoad { package, function_scope, .. }:
               target = pick_frame_mut(function_scope);
               target.packages.insert(package.clone());
               // Self-origin recorded for same-file leak detection consistency
               record_package_origin(&mut target.package_origins, package, queried_uri);

           Source { line: src_line, column: src_col, source, function_scope }:
               // Resolve once, cache, then merge into the right frame.
               key = (src_line, src_col);
               contribution = source_contributions.entry(key).or_insert_with(|| {
                   resolve_source_contribution(
                       queried_uri, src_line, src_col, source, function_scope,
                       get_artifacts, get_metadata, graph, workspace_root,
                       max_depth, base_exports, hoist_globals, backward_dep_mode,
                       is_cancelled, prefix_cache,
                   )
               });
               target = pick_frame_mut(function_scope);
               target.symbols.extend(contribution.symbols.iter().map(|(k, v)| (k.clone(), v.clone())));
               target.packages.extend(contribution.packages.iter().cloned());
               for (pkg, origins) in &contribution.package_origins {
                   target.package_origins.entry(pkg.clone()).or_default().extend(origins.iter().cloned());
               }

           Declaration { symbol, .. }:
               // @lsp-var / @lsp-func — always global.
               global_frame.symbols.insert(symbol.name.clone(), symbol.clone());
       }
       timeline_cursor += 1;

2. Pop function frames whose intervals no longer contain (target_line, target_column).
   Loop: while let Some((interval, _)) = function_stack.last() {
       if !interval.contains(Position::new(target_line, target_column)) {
           function_stack.pop();
       } else {
           break;
       }
   }

3. cursor = (target_line, target_column).
```

`pick_frame_mut(function_scope: Option<FunctionScopeInterval>)` returns:
* `&mut self.global_frame` when `function_scope.is_none()`.
* `&mut self.function_stack[i].1` where `i` is the stack index whose interval matches `function_scope.unwrap()`. If no match (the function the event belongs to was already popped or never entered): no-op.

**`snapshot()` — materialize `ScopeAtPosition`:**

```text
1. Determine query_inside_function = !function_stack.is_empty() (and hoist_globals).
2. Pick prefix = if query_inside_function { &prefix_in_function } else { &prefix_top }.
3. Build ScopeAtPosition seeded from prefix:
       symbols = prefix.symbols.clone()
       inherited_packages = prefix.inherited_packages.clone()
       loaded_packages = prefix.loaded_packages.clone()
       package_origins = prefix.package_origins.clone()
       chain = prefix.chain.clone()
       depth_exceeded = prefix.depth_exceeded.clone()
4. Layer global_frame on top:
       symbols.extend(global_frame.symbols)
       loaded_packages.extend(global_frame.packages)
       merge global_frame.package_origins into package_origins
5. Layer each function frame (outermost-to-innermost so innermost wins):
       for (_iv, frame) in &function_stack {
           symbols.extend(frame.symbols)
           loaded_packages.extend(frame.packages)
           merge frame.package_origins into package_origins
       }
6. Return ScopeAtPosition { symbols, inherited_packages, loaded_packages, package_origins, chain, depth_exceeded }.
```

**`is_visible(name: &str) -> bool`** — cheaper variant for collectors that only need a presence check. Walk frames innermost-first (function_stack reverse, then global, then prefix), short-circuit on hit.

**`resolve_source_contribution`** runs the same recursion that STEP 2's Source-handling does today (`scope.rs` near line 3303), but it goes through the cached `parent_prefix_at` for the child URI. The signature should be:

```rust
#[allow(clippy::too_many_arguments)]
fn resolve_source_contribution<F, G>(
    parent_uri: &Url,
    src_line: u32,
    src_col: u32,
    source: &super::types::ForwardSource,
    function_scope: Option<FunctionScopeInterval>,
    get_artifacts: &F,
    get_metadata: &G,
    graph: &super::dependency::DependencyGraph,
    workspace_root: Option<&Url>,
    max_depth: usize,
    base_exports: &HashSet<String>,
    hoist_globals: bool,
    backward_dep_mode: super::config::BackwardDependencyMode,
    is_cancelled: &dyn Fn() -> bool,
    prefix_cache: &std::cell::RefCell<ParentPrefixCache>,
) -> ChildSourceContribution
where /* same as ScopeStream */
{ /* ... */ }
```

Internally this resolves the child URI (via `graph.get_dependencies` lookup, mirroring `scope.rs:3185-3200`), then calls `scope_at_position_with_graph_cached(child_uri, MAX, MAX, ..., prefix_cache)` to get the child's full scope at EOF. The cached path lets the child's own STEP 1 reuse parent-prefix slots if the parent is already cached.

### Tasks

- [ ] **S2.1 — define types and `ScopeStream::new`.**

  Add the `ScopeFrame`, `ChildSourceContribution`, and `ScopeStream` struct definitions (above) to `cross_file::scope`. Implement the constructor:

  ```rust
  impl<'a, F, G> ScopeStream<'a, F, G>
  where
      F: Fn(&Url) -> Option<Arc<ScopeArtifacts>>,
      G: Fn(&Url) -> Option<std::sync::Arc<super::types::CrossFileMetadata>>,
  {
      #[allow(clippy::too_many_arguments)]
      pub fn new(
          queried_uri: &'a Url,
          artifacts: &'a ScopeArtifacts,
          get_artifacts: &'a F,
          get_metadata: &'a G,
          graph: &'a super::dependency::DependencyGraph,
          workspace_root: Option<&'a Url>,
          max_depth: usize,
          base_exports: &'a HashSet<String>,
          hoist_globals: bool,
          backward_dep_mode: super::config::BackwardDependencyMode,
          is_cancelled: &'a dyn Fn() -> bool,
          prefix_cache: &'a std::cell::RefCell<ParentPrefixCache>,
      ) -> Self {
          // Pre-compute both prefix slots so advance_to never has to materialize
          // them on the hot path.
          let prefix_top = compute_or_get_cached_prefix(
              queried_uri, false,
              get_artifacts, get_metadata, graph, workspace_root,
              max_depth, base_exports, hoist_globals,
              backward_dep_mode, is_cancelled, prefix_cache,
          );
          let prefix_in_function = if hoist_globals {
              compute_or_get_cached_prefix(
                  queried_uri, true,
                  get_artifacts, get_metadata, graph, workspace_root,
                  max_depth, base_exports, hoist_globals,
                  backward_dep_mode, is_cancelled, prefix_cache,
              )
          } else {
              prefix_top.clone()
          };

          // Inject base_exports into the global_frame so they're visible everywhere
          // (matches scope_at_position_with_graph_recursive's depth-0 injection).
          let mut global_frame = ScopeFrame::default();
          let base_uri = Url::parse("package:base").unwrap();
          for export_name in base_exports {
              let name: Arc<str> = Arc::from(export_name.as_str());
              global_frame.symbols.insert(
                  name.clone(),
                  ScopedSymbol {
                      name,
                      kind: SymbolKind::Variable,
                      source_uri: base_uri.clone(),
                      defined_line: 0,
                      defined_column: 0,
                      signature: None,
                      is_declared: false,
                  },
              );
          }

          Self {
              queried_uri, artifacts,
              prefix_top, prefix_in_function,
              global_frame,
              function_stack: Vec::new(),
              timeline_cursor: 0,
              cursor: (0, 0),
              source_contributions: HashMap::new(),
              get_artifacts, get_metadata, graph, workspace_root,
              max_depth, base_exports, hoist_globals,
              backward_dep_mode, is_cancelled, prefix_cache,
          }
      }
  }

  fn compute_or_get_cached_prefix<F, G>(
      uri: &Url,
      query_inside_function: bool,
      // ... all the args ...
      prefix_cache: &std::cell::RefCell<ParentPrefixCache>,
  ) -> Arc<ParentPrefix>
  where F: ..., G: ...,
  {
      let mut cache = prefix_cache.borrow_mut();
      if let Some(arc) = cache.entries.get(&(uri.clone(), query_inside_function)).cloned() {
          return arc;
      }
      let mut visited = HashMap::new();
      let computed = parent_prefix_at(
          uri, query_inside_function, get_artifacts, get_metadata, graph,
          workspace_root, max_depth, 0, &mut visited,
          base_exports, hoist_globals, backward_dep_mode, is_cancelled,
      );
      let arc = Arc::new(computed);
      cache.entries.insert((uri.clone(), query_inside_function), arc.clone());
      arc
  }
  ```

  No callers yet — this commit is a pure addition.

  **Verify:** `cargo build -p raven --features test-support` → no errors. `cargo test --release -p raven --lib --features test-support` → 3015+S1.4 passing (no regressions; new types not yet exercised).

- [ ] **S2.2 — implement `advance_to`, `snapshot`, `is_visible`, `resolve_source_contribution`.**

  Implement the algorithms from the design section. Cover these subtleties:

  * `pick_frame_mut(function_scope: Option<FunctionScopeInterval>)`: when a Def's `function_scope` is `Some(F)` but no frame on the stack matches `F`, return `None` (no-op). This happens if the cursor advanced past the function body without ever entering it — the timeline iteration would emit FunctionScope-push, then Def-into-frame, then end-of-body-pop, all in one advance_to call. So `pick_frame_mut` is unlikely to no-op in practice; the safety net is for tree-sitter edge cases (e.g. a Def annotated with a function_scope that's actually nested in another that wasn't pushed).
  * **Cancellation:** check `is_cancelled()` every 64 timeline events and at the start of each `advance_to` and `snapshot` call. Mirror the cooperative cancellation in the existing recursive code.
  * **`local=true` Source events:** for `local=TRUE` source() calls or `sys.source` into a non-global env at top level, the symbols are scoped only inside the calling function. The current code (`scope.rs:3173-3178`) skips them when `function_scope.is_none()`. Mirror this: when `should_apply_local_scoping(source) && function_scope.is_none()`, do not apply the contribution to global_frame.
  * **`hoist_globals=true` and global source() inside a function body:** the existing code (`scope.rs:3169` `is_global_source = query_inside_function && function_scope.is_none()`) lets a global source() call's symbols become visible inside function bodies before the call site. Mirror by recognizing this case in advance_to: when applying a Source event with `function_scope.is_none()` while `function_stack` is non-empty AND `hoist_globals`, still apply to global_frame.
  * **`function_stack` mismatch on construction:** if the diagnostic pass starts at `(0, 0)` and the first identifier usage is inside a function body, the cursor advances forward across the function-body start — `advance_to` must push the frame. If the queried position is inside a function, the cursor's eventual stack reflects that. Construction starts with an empty stack and `cursor = (0, 0)`; the first `advance_to` does the push.

  Add a unit test `test_scope_stream_basic` that:
  1. Builds a single-file fixture with a top-level Def, a function body containing two locals, and a usage outside the function.
  2. Constructs a `ScopeStream`, calls `advance_to` at four points (before the function, inside the function body twice, after the function).
  3. Calls `snapshot()` at each and asserts symbol-set equality with `scope_at_position_with_graph` at the same positions.

  **Verify:** new test passes; nothing else regresses.

- [ ] **S2.3 — property test.** Add a proptest in `cross_file::scope::proptests`:

  ```rust
  proptest! {
      /// For any small R fixture and any sequence of in-document-order query
      /// positions, ScopeStream must produce the same ScopeAtPosition as
      /// scope_at_position_with_graph_cached at every query.
      #[test]
      fn prop_scope_stream_matches_per_position(
          fixture in r_code_with_functions(),
          positions in monotonic_positions(),
      ) {
          let (uri, artifacts, ...) = build_test_state(&fixture);

          let prefix_cache = std::cell::RefCell::new(ParentPrefixCache::new());
          let mut stream = ScopeStream::new(/* ... */, &prefix_cache);

          for (line, col) in positions {
              stream.advance_to(line, col);
              let streamed = stream.snapshot();
              let mut throwaway = ParentPrefixCache::new();
              let direct = scope_at_position_with_graph_cached(
                  &uri, line, col, /* ... */, &mut throwaway,
              );
              prop_assert_eq!(streamed.symbols, direct.symbols);
              prop_assert_eq!(streamed.inherited_packages, direct.inherited_packages);
              prop_assert_eq!(streamed.loaded_packages, direct.loaded_packages);
              prop_assert_eq!(streamed.package_origins, direct.package_origins);
              prop_assert_eq!(streamed.chain, direct.chain);
              prop_assert_eq!(streamed.depth_exceeded, direct.depth_exceeded);
          }
      }
  }
  ```

  `r_code_with_functions()` and `monotonic_positions()` are new strategies. Reuse generators from existing proptests (`crates/raven/src/cross_file/scope.rs::proptests`). The fixture must include:
  * Top-level Defs and PackageLoads
  * At least one function body with parameters and body-locals
  * At least one nested function (function inside function)
  * At least one Removal (`rm("x")`)
  * At least one forward `source()` call (use a 2-file fixture; the second file needs to be in the artifacts/metadata maps the closures see)

  Run with `cargo test --release -p raven --lib --features test-support proptests::prop_scope_stream_matches_per_position` and let the default 100 cases run. Investigate any shrunk counterexample — they reveal gaps in `advance_to`.

- [ ] **S2.4 — wire `collect_undefined_variables_from_snapshot` to use `ScopeStream`.**

  Current loop (in `crates/raven/src/handlers.rs` near `:5145`):
  1. Collect usages.
  2. For each usage, look up scope via `scope_cache.entry(...).or_insert_with(|| snapshot.get_scope(...))`.
  3. Check `scope.symbols.contains_key(name)` and emit diagnostic if not present.

  Rewrite:
  1. Collect usages, sort by `(line, column)` ascending. (Tree-sitter's `walk()` already yields nodes in document order, so this is usually already sorted; sort defensively.)
  2. Construct a `ScopeStream` using `snapshot.parent_prefix_cache` and the queried URI's artifacts (looked up from `snapshot.artifacts_map`).
  3. For each usage, call `stream.advance_to(usage_line, usage_col)` then `stream.is_visible(name)`. If `false`, fall through to the existing same-file leak filter / source attribution logic at `:5080-5141` (use `stream.snapshot()` to materialize the full ScopeAtPosition only when needed for that branch).

  The `scope_cache: HashMap<(u32, u32), ScopeAtPosition>` parameter becomes redundant for this collector — keep it in the signature for API compatibility (the out-of-scope collector still uses it for now), but don't populate it. Alternatively, populate it lazily from `stream.snapshot()` when the leak-filter branch needs it.

  **Verify:** full test suite passes. Run `cargo test --release -p raven --lib --features test-support undefined_var` to focus on undefined-variable tests, then the full suite.

- [ ] **S2.5 — wire `collect_out_of_scope_diagnostics_from_snapshot` to use `ScopeStream`.**

  Same pattern as S2.4 but for the out-of-scope collector. Be careful: this collector queries scope at *source() call positions*, not just at identifier usages. Since the timeline already includes Source events, advancing the cursor to a source call's position before checking visibility works the same way.

  The leak-filter branch at `handlers.rs:5104-5118` (the one strengthened by 65b2959 to require `exports.contains(name) AND symbol.source_uri != *uri`) must still apply. Its inputs come from `snapshot.artifacts_map` — those don't change.

  **Verify:** `cargo test --release -p raven --lib --features test-support out_of_scope` then the full suite.

- [ ] **S2.6 — measure.** Re-run `cargo run --release --example profile_worldwide --features test-support`. Target: `scripts/data.r POST-scan diag` < 30 ms (down from ~80 ms after Stage 1, ~743 ms before either stage). Save the output to `.claude/plans/incremental-scope-resolution-after-stage2.txt`.

  Also run the synthetic harness and bench to confirm no regression on simpler topologies:
  * `cargo run --release --example profile_diagnostics --features test-support` — every topology should be ≤ its pre-Stage-1 number.
  * `cargo bench --bench cross_file --features test-support` — diagnostic-update latency should improve or stay flat.

- [ ] **S2.7 — document.** Append to CLAUDE.md "Learnings":

  ```markdown
  - Diagnostic collectors that call `scope_at_position` per-identifier on the same file
    should walk usages in document order with a `ScopeStream`. The stream maintains a
    global frame and a stack of active function-scope frames; `advance_to(line, col)`
    is a forward-only cursor that applies timeline events with effect position
    `<= (line, col)` exactly once. Per-function frames push when the cursor enters
    a function body (via the FunctionScope event in the timeline) and pop when the
    target position leaves the interval. Forward `Source` events resolve at most
    once per unique call site and the contribution is reused. This eliminates
    O(usages × timeline-events-up-to-position) replay work.
  ```

- [ ] **S2.8 — commit.** Single commit, message body:
  ```
  perf: stream scope through diagnostic collectors via ScopeStream

  Replace per-position scope_at_position lookups in
  collect_undefined_variables_from_snapshot and
  collect_out_of_scope_diagnostics_from_snapshot with a forward-only
  ScopeStream that advances through artifacts.timeline once per
  diagnostic pass. Per-function frames are pushed/popped at function
  body boundaries; forward Source events resolve once and the
  contribution is cached for reuse.

  Measured impact on ~/repos/worldwide/scripts/data.r post-scan
  diagnostic: ~80 ms -> ~25 ms (after Stage 1's 743 -> 80 ms).
  ```

## Risks and rollback

* **Same-file leak regressions.** All three filter sites (91c3617/65b2959) are upstream of `ScopeStream`'s frames: two run inside `parent_prefix_at` (so they apply to every cached prefix entry), one runs inside the snapshot out-of-scope collector (which Stage 2 still calls with `stream.snapshot()` when its branch is taken). S1.4 and S2.3 each add explicit regression coverage for the `xyz <- xyz` shape through the new code path.
* **Function-boundary detection.** `function_scope_tree` is built by `try_extract_function_scope` (`scope.rs:2149`) which is called from a recursive AST walk on every node, so it captures function bodies regardless of containing assignment shape (left-arrow, right-arrow with parens, equals, super-assignment, lambda `\(x)`, anonymous-as-call-arg). Bare `function() {} -> name` parses as a single function_definition (the body includes the right-arrow), which is the documented R behavior; the function body is still picked up correctly. S1.4's matrix exercises all parsed shapes.
* **Cursor-advance correctness.** The property test in S2.3 is the key correctness gate. If a counter-example surfaces, the failing fixture pinpoints which event-application branch in `advance_to` is wrong. Likely culprits: function-scope-aware Source events, hoist_globals=true global sources inside functions, Removal events at exact event boundaries.
* **Lifetime / borrow issues.** `ScopeStream` holds references to closures and the prefix cache. Using `RefCell<ParentPrefixCache>` (or `Mutex` if Sync is required) is the cleanest interior-mutability pattern. If lifetimes conflict with how `DiagnosticsSnapshot` owns its closures, restructure so `ScopeStream::new` takes the closures by reference and the stream is constructed inside `diagnostics_from_snapshot`'s call frame.
* **Rollback.** Each stage is one commit. Reverting Stage 2 leaves Stage 1's caching in place; reverting both restores the per-call STEP 1 + per-position STEP 2 behavior.

## Out of scope

* **Cross-snapshot caching.** STEP 1 results across edits would require precise invalidation against `cross_file_graph` revision and artifact hashes; complexity not justified given the per-snapshot wins.
* **Coalescing scope queries across diagnostic collectors.** Each collector has its own traversal pattern; `ScopeStream` is reconstructed per collector. Cross-collector coalescing is a bigger refactor not worth the coupling.
* **Parallelizing `scan_workspace`.** Separate plan (Tier 1 of the cold-start lag investigation, ~890 ms saved) — covered in `crates/raven/examples/profile_worldwide.rs`'s "FIX EXPERIMENT B" output. This plan is independent and additive.

## Kickoff prompt for a fresh session

Paste this into a fresh Claude Code session in worktree `/Users/jmb/.t3/worktrees/raven/t3code-9723b935`:

> I'm continuing work on the Raven R LSP performance investigation on branch `t3code/optimize-diagnostic-updates`. The previous session measured the cold-start lag on `~/repos/worldwide/scripts/data.r` and produced an implementation plan at `.claude/plans/incremental-scope-resolution.md`. Read that plan in full — it's self-contained and includes background context, the architectural insight, two stages of tasks (Stage 1 caches the parent walk, Stage 2 streams the timeline), and risk/rollback notes. Both stages are required.
>
> Important constraints from the plan and from `CLAUDE.md`:
> - The recent commits 91c3617 and 65b2959 added same-file leak filters at three cross-file merge points. Don't regress them.
> - 3013 unit tests must continue passing after each stage. The full suite runs in ~11 s via `cargo test --release -p raven --lib --features test-support`.
> - Don't hold the `WorldState` read lock across expensive operations; per-snapshot caches live inside `DiagnosticsSnapshot`.
> - The measurement harness is `cargo run --release --example profile_worldwide --features test-support`. Save outputs to `.claude/plans/incremental-scope-resolution-{baseline,after-stage1,after-stage2}.txt`.
>
> Execute Stage 1 first, commit, then Stage 2, commit. After Stage 2 measurements, append the CLAUDE.md learnings entries listed in S1.5 and S2.7. Use the `superpowers:systematic-debugging` skill if you hit a regression and the `codex:codex-rescue` agent for second opinions on tricky correctness decisions in `advance_to` or `resolve_source_contribution`.
>
> Start with S1.0 (record the baseline). Report back after each stage's measurement task (S1.5, S2.6) before committing — I want to see the numbers.
