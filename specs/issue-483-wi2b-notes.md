# Issue #483 (WI2b) — implementation notes / refinements to `specs/issue-479-spec.md`

These notes confirm the locked WI2b design and record the concrete implementation
decisions made during coding. They refine (do not contradict) the WI2b section of
`specs/issue-479-spec.md`.

## Confirmed against current code (post-#479, post-#482)

- **Part 1 shipped** (`scope.rs:5042`): `parent_prefix_at` returns the empty
  `ParentPrefix` for a standalone `uri`. So a standalone file's own backward walk
  is skipped.
- **Part 2 shipped**: both forward-child sites now resolve a standalone child with
  caller-independent inputs — empty packages, no `DataAliasProvider`, and the
  child's OWN `PathContext` (ignoring the caller's `# raven: cd` / inherited
  working directory):
  - recursive forward-source dispatch (`scope_at_position_with_graph_recursive`):
    `scope.rs:6181` (`child_provider = None`), `6188` (`packages_for_child` empty),
    `6206` (`child_ctx` from the child's own metadata), `6275` (`provider_fp` of the
    `None` provider), recursive calls at `6276`/`6294`.
  - `ScopeStream::resolve_source_contribution`: `scope.rs:8308` (`child_provider =
    None`), `8317` (`child_ctx`), packages already empty on this path (`8393`/`8407`),
    `8397` (`provider_fp`), recursive call at `8410`.
- The backward parent walk already resolved a parent caller-independently — with
  `inherited_packages = {}` (`scope.rs:5481`), `data_alias_provider = None` (`5500`),
  and the parent's OWN `PathContext` (`5445`) — so it never needed part 2; part 2
  brought the **forward-child** path to the same caller-independence.
- `interface_hash` is per-file on `ScopeArtifacts` (`scope.rs:755`) and
  `compute_interface_hash` already folds in `standalone` (`scope.rs:4521`) and
  (post-#482) `ScopedSymbol.signature`.
- `edge_revision` (`dependency.rs:535`) is a global monotonic counter; the
  per-snapshot trimmed graph is a **clone** whose `edge_revision` resets to 0
  (`dependency.rs:594`). Therefore the cache key's `edge_revision` MUST be read
  from the real `WorldState.cross_file_graph` under the read lock and carried into
  the snapshot — not read from the snapshot's cloned graph.

## Refinement 1 — single cache hook at the EOF resolution of a standalone file

Rather than two separate hooks (own-diagnostics + forward-child), the persistent
cache is consulted at **one** place: the top of
`scope_at_position_with_graph_recursive`, gated on all of:

- `get_metadata(uri).standalone == true`
- query position is full EOF: `line == u32::MAX && column == u32::MAX`
- `current_depth >= 1` (excludes the **own-root** query, which alone injects
  `base_exports` at depth 0; a standalone file resolved as a child/parent at
  depth ≥ 1 never gets base injected, so all depth-≥1 EOF resolutions share one
  scope shape)
- canonical inputs: `data_alias_provider.is_none()`, `package_contribution.is_none()`,
  `inherited_packages.is_empty()`, and `pre_computed_prefix` is `None`/empty
  (always true for a standalone file, whose prefix is empty)
- graph is acyclic (mirrors `resolve_forward_child_memoized`'s cycle guard;
  a cycle makes the scope visited-dependent)

This single hook covers **(b)** forward-child resolution (`MAX,MAX`, after part 2
makes its inputs canonical) **and** the backward-parent-at-EOF case
(`query_inside_function`, which already resolves the parent at `MAX,MAX` with
canonical inputs). At `MAX,MAX` in an acyclic graph a forward source always
re-resolves (widest position), so the isolated scope is visited-independent and
identical across these reach paths.

**Own-root (depth-0) own-diagnostics is deliberately NOT served** by the cache:
its scope shape differs (base_exports injected at depth 0). It is already fast
post-#479 (WI1 shared prefix memo dedups its closure within the snapshot). All
three reuse wins the spec targets — (a) 84 callers in one pass, (b) ×84
revalidation fan-out, (c) 245 per-file `raven check` snapshots — are
forward-child / backward-parent-EOF reaches, which the single hook serves.

## Refinement 2 — cached value type and reuse rule

Cached value = `(Arc<ScopeAtPosition>, compute_depth: usize)`, mirroring
`ForwardChildMemo` exactly:

- only **truncation-free** scopes are cached (`depth_exceeded.is_empty()`),
- a never-cache-under-cancellation rule,
- reuse a stored entry for a reach at `current_depth` iff
  `current_depth <= compute_depth` (a truncation-free scope is the full closure;
  a shallower-or-equal reach has ≥ budget and resolves the identical full
  subtree); keep the max `compute_depth` seen.

This makes a cache hit byte-identical to the un-memoized resolver under any
`maxChainDepth`, including small ones.

## Refinement 3 — key components, sourced as follows

`key = (callee_uri, edge_revision, closure_interface_fingerprint, package_config_generation)`

- `callee_uri`: the standalone file `uri`.
- `edge_revision`: global value from `WorldState.cross_file_graph`, captured under
  the read lock and stored on the snapshot / threaded into the resolver.
- `closure_interface_fingerprint`: order-sensitive hash over the per-file
  `interface_hash` of C's **contributing set**, with each member's
  `interface_hash` read from `get_artifacts`. The contributing set is NOT just
  `{C} ∪ forward_closure(C)`: a non-standalone forward-closure member runs its
  own backward parent-prefix walk, so the parents of such members (and their
  forward sources), transitively, also feed C's isolated scope — e.g. a file `A`
  that `library()`s a package and also `source()`s a member leaks that package
  into C via the member's prefix. So the set is the closure under: forward
  `source()` edges from every file, plus backward `source()` edges only out of a
  **non-standalone** file (a standalone file's own backward walk is skipped, which
  is exactly what keeps the set — and the key — independent of C's callers).
  Walked over the resolver's (trimmed-snapshot) graph via `get_dependencies` /
  `get_dependents`; computed lazily and memoized per `C_uri` on the per-query
  `ForwardChildMemo` (constant within a query). Sound because the cached value is
  a function of exactly the contributing set's interfaces in this snapshot.
  (Found in WI2b review: a forward-only fingerprint admitted a stale cross-snapshot
  HIT when a member's external backward parent was edited — its `library()` line
  bumps neither `edge_revision` nor a forward-only fingerprint; regression test
  `standalone_cache_invalidates_on_member_backward_parent_edit`.)
- `package_config_generation`: a new coarse `u64` counter on `WorldState`, bumped
  on R/package-library re-init and on `packages_*` / `maxChainDepth` /
  `hoist_globals` / `backward_dependencies` / `base_exports` config changes — the
  isolated scope depends on package/config state the other key parts don't capture.

## Refinement 4 — cache ownership, handle plumbing, lock discipline

- `Arc<StandaloneScopeCache>` is a new `WorldState` field. Internal storage mirrors
  `subgraph_cache`: `RwLock<LruCache<Key, (Arc<ScopeAtPosition>, usize)>>`; read
  path `peek()` (no promotion), write path `push()`.
- The `Arc` handle, plus the captured `edge_revision` and
  `package_config_generation`, are carried on `ForwardChildMemo` (already threaded
  as `&RefCell<ForwardChildMemo>` to every recursive call and to
  `resolve_forward_child_memoized`) — so the deep recursion needs **no** new
  parameters. Only the public entry points and `ScopeStream` constructors gain a
  handle parameter that seeds the memo; the diagnostics path passes the cloned
  handle, every other caller passes `None`.
- Lock discipline (CLAUDE.md): the diagnostics snapshot clones the `Arc` handle and
  reads `edge_revision`/`package_config_generation` under the `WorldState` read
  lock, then the guard is dropped; all cache lookups + miss-computes happen with no
  `WorldState` guard held (the cache's own `RwLock` is independent).

## Part 2 — diagnostic effect (to characterize on worldwide)

Part 2 removes a caller-union over-approximation from a caller's view of a
standalone child (drops caller packages/provider/cd). Safe-direction: it can only
add a false-positive *inside the standalone file's contribution* (a binding the
file actually relied on a caller providing), never hide a real bug in a caller.
The #479-alone baseline with `bootstrap.r` standalone was 367 undefined-variable;
part 2 may change that number — an allowed directive-scoped change to be
characterized and justified against the 367 baseline. Cache-on must equal
cache-off for the same build; the directive-free path stays byte-identical to
pre-#479 main (361).

## Soundness: why the key is a complete determinant of the cached scope

A cache HIT must be byte-identical to the un-memoized resolution. The cached
value is the standalone callee C's isolated EOF scope at depth ≥ 1, which is a
function of exactly:

1. **Each contributing file's interface**, folded into `closure_interface_fingerprint`:
   - symbols (full identity + position + signature + formals, via `interface_hash`, post-#482),
   - package loads as `(name, line, column, function_scope)` (a `library()` contributes
     to a sourced child only when it *precedes* the `source()` and shares/descends its scope),
   - `nse_declarations` and the `standalone` flag.
2. **Source ordering and graph membership**, via `edge_revision` (full-edge equality
   incl. `call_site_line`/`call_site_column`, so a `source()` reorder or retarget bumps it).
3. **The contributing set itself** = forward `source()` closure of C, PLUS the backward
   parents of any *non-standalone* closure member (transitively, never following a
   standalone file's backward edges). A non-standalone member runs its own
   `parent_prefix_at` walk, so its external parents leak packages into C's scope.
4. **Traversal config**: `max_chain_depth`, `hoist_globals`, `backward_dep_mode`,
   `package_config_generation`.

Everything else is gated off on this path: `data_alias_provider` is `None`,
`package_contribution` is `None`, `inherited_packages` is empty, `pre_computed_prefix`
is empty, and `base_exports` is injected only at depth 0 (never on the depth-≥1 cached
path). The graph is acyclic (cycle ⇒ visited-dependent ⇒ not cached).

**Caller-independence is enforced, not assumed.** The cached scope must be the SAME
regardless of which file sourced C; otherwise a URI-keyed cross-snapshot HIT is
unsound. The one channel that can make resolution caller-dependent is the resolver's
shared `visited` map (the caller's forward path): if a contributing file is already
`visited`, the revisit guard truncates its contribution. The contamination guard at
the EOF hook therefore refuses to cache whenever ANY member of the **full contributing
set** (not just the forward closure) is in `visited` — covering both truncation
channels: a visited forward member's `source()` short-circuits, and a visited backward
parent of a non-standalone member loses the packages it *inherited* / had *loaded by
siblings* (its own `library()` calls survive via the direct-artifact read, but the
recursive `parent_scope` is zeroed).

**The fingerprint walks the same (trimmed) graph the resolver uses — and that is sound
even under `max_visited` truncation.** In production both run over the trimmed neighborhood
subgraph. One might fear that under truncation `extract_subgraph` drops an edge to a
contributor the resolver still reaches via its `source.resolved_uri` / path fallback (which
the fingerprint walk lacks), omitting it from the key. It does not, because contribution is
gated by **artifact availability = neighborhood membership**: the resolver's `get_artifacts`
reads only `DiagnosticsSnapshot::artifacts_map`, populated solely from the neighborhood. For
a file outside the neighborhood the fallback may compute its URI, but `get_artifacts` returns
`None`, so it contributes nothing — exactly as the fingerprint (which also omits it) assumes.
For a file inside the neighborhood, `extract_subgraph` keeps every intra-neighborhood edge,
so the resolver reaches it through a real edge the fingerprint also traverses. The resolver's
contributing set therefore equals the fingerprint's set in every regime, so a truncated
resolution is an approximate-but-self-consistent scope that the cache reuses soundly (a fresh
resolution would be truncated identically). See the long-form argument on
`standalone_closure_fingerprint_and_members`.

## Staleness fixes found in WI2b adversarial review (each reproduced with a failing test first)

1. **Contributing-set fingerprint** (`353e819e`): a forward-only fingerprint missed an
   edit to a member's *external* backward parent. Fix: fingerprint over the full
   contributing set. Test `standalone_cache_invalidates_on_member_backward_parent_edit`.
2. **Package-load position** (`7e648833`): hash `(line, column)`. Test
   `standalone_cache_invalidates_on_library_move_across_source`.
3. **Package-load function_scope** (`09f6d6f3`): hash `function_scope`. Test
   `standalone_cache_invalidates_on_package_function_scope_flip`.
4. **Visited backward-parent contamination guard** (this commit): the guard checked only
   the forward closure, so a member's backward parent being on the caller's `visited`
   path dropped its inherited/loaded packages — a caller-dependent scope cached and
   served stale across diagnostic roots in one session. Fix: the guard checks the full
   contributing set. Test `standalone_cache_skips_when_member_backward_parent_is_visited`.
   This guard is **conservatively over-broad**: in a dense graph the contributing set
   frequently intersects the caller's `visited` path even when no package-dropping
   truncation actually occurs, so it skips some sound entries (worldwide A/B: cache hits
   354/10 → 255/8, byte-identity preserved). A precise (package-contribution-aware or
   post-hoc) replacement that recovers those hits is tracked in **#488**.

## Refinement 5 — source-call contribution flags carried on the dependency edge

Review (Codex) surfaced two more inputs that change a `source()`/`sys.source()`
call's *contribution* but were not in the cache key, because they can flip at a
**fixed `(line, column)`** with the file's `interface_hash` unchanged:

- **`sys.source(..., envir = …)`** — a non-global env (`new.env()`) does NOT
  contribute the child's top-level symbols (`should_apply_local_scoping`); editing
  `globalenv()` → `new.env()` is a same-position argument change.
- **function-scope** — a `source()` lexically inside a `function(){}` body does not
  contribute at top level; dropping an enclosing wrapper on a *prior* line can flip
  this without moving the call.

Neither `sys_source_global_env` nor `is_function_scoped` was on `DependencyEdge`,
so such a flip left the edge byte-identical → `edge_revision` did not move → the
persistent cache (keyed on `edge_revision`) could serve a stale isolated scope, and
dependents were not revalidated. Fix: both flags are now carried on `DependencyEdge`
and folded into full-edge equality (`dependency.rs`), so a flip is an edge change
that bumps `edge_revision`. Regression: `edge_revision_bumps_on_source_semantics_flip_at_fixed_position`
and `standalone_cache_invalidates_on_sys_source_envir_toggle`.

Because the edge now carries them, `parent_prefix_at` reads
`edge.sys_source_global_env` / `edge.is_function_scoped` **directly** instead of
re-scanning `parent_meta.sources` — a single source of truth, and correct even with
two `sys.source` calls (one global, one not) on the same line, which the prior
line-only metadata scan misclassified (regression
`sys_source_two_calls_on_one_line_use_per_call_envir`).

## Refuted findings (documented to prevent re-flagging)

- **`rm()` removal column not hashed** (Codex sessions `019ed1e4`, re-flagged later with a
  same-line-reorder reproduction): FALSE POSITIVE on two independent grounds.
  (a) **Edge-position sensitivity** (covers the re-flag's reproduction — C's own
  `source("leaf"); rm(x)` reordered to `rm(x); source("leaf")`): for an `rm()` to flip
  execution order relative to a `source()` call, ONE of them must move. If they swap across
  lines, `rm`'s line changes → `interface_hash` changes (removals hash `(name, line)`). If
  they swap on one line, the `source()` call's **column** necessarily changes (moving `rm`
  before it pushes it right) → `DependencyEdge`/`EdgeKey` differ → `edge_revision` bumps →
  cache MISS. The precondition "same line/UTF-16 column while order flips" is unsatisfiable.
  The `(name, line)` removal hash is also *tighter* than `(name, line, column)` would be: a
  same-line `rm` move that stays on the same side of every `source()` does not change the EOF
  scope and correctly must not invalidate.
  (b) **Backward-parent channel**: a symbol removed from a member's backward parent is
  leak-filtered at the M→C merge (`child_source_symbol_is_leak`), so it never reaches C's
  scope; `rm()` cannot remove packages. `compute_interface_hash` is shared with revalidation,
  so no removal-column plumbing was added.

- **Callee `PathContext` not in the key** (Codex session `019ed229`): a non-bug, shadowed
  by the dependency graph. The resolver resolves forward children from graph edges
  (`scope.rs` STEP 2, "prefer pre-computed dependency graph edges") and only falls back to
  `path_ctx`-based path resolution when the graph lacks an edge — but the graph builder
  resolves every relative `source()` to an absolute target existence-independently, so an
  edge is always present and the `path_ctx` fallback never fires. A standalone callee's
  effective `path_ctx` is `PathContext::from_metadata(C)` (caller-independent: part 2 gives
  it no inherited working directory), and any `# raven: cd` / workspace-root change that
  *redirects* a `source()` retargets the edge and bumps `edge_revision`. So `path_ctx`
  never independently changes the cached outcome; it is deliberately NOT in the key.
  **Tripwire:** if the resolver is ever changed so the inline `path_ctx` fallback can be
  authoritative over (or diverge from) the graph edges, the callee's `path_ctx` fingerprint
  MUST be added to `StandaloneScopeKey` (mirroring `ForwardChildKey::path_fp`).

- **`ScopedSymbol.defined_end_column` not in the interface fingerprint** (Codex session
  `019ed291`): a non-bug, unreachable. `defined_end_column` is deliberately excluded from
  `ScopedSymbol`'s `PartialEq`/`Hash` (`scope.rs:602`) — it is cosmetic positional metadata
  (issue #459: highlight the full `` `foo` `` token vs the bare `foo`), carrying no symbol
  identity. It is read by exactly one consumer, `scoped_symbol_range` (`handlers.rs`), used
  only for **go-to-definition** ranges. Go-to-definition resolves via
  `scope_at_position_with_graph`, which seeds `ForwardChildMemo::default()` with no cache
  handle, so it never reads a cached scope. The standalone cache is consulted only by the
  diagnostics path (`StandaloneCacheCtx` is built only in `DiagnosticsSnapshot::new`), and
  diagnostics never read `defined_end_column`. So a stale cached `defined_end_column` is
  never observed, and `compute_interface_hash` (shared with revalidation) is not widened for
  it. **Tripwire:** if the standalone cache is ever wired into go-to-definition / hover /
  any surface that reads `defined_end_column`, the fingerprint must then cover it.

- **Fingerprint walks the trimmed neighborhood subgraph → "stale hit under `max_visited`
  truncation"** (code-review, CONFIRMED-vote): a non-bug. The concern: `standalone_closure_fingerprint_and_members`
  walks the same trimmed `graph` the resolver uses, so under budget truncation `extract_subgraph`
  drops edges to out-of-neighborhood files; the resolver's `source.resolved_uri` / path fallback
  (`scope.rs` STEP 2) could still reach such a file F and feed its content into C's scope, while the
  fingerprint (no fallback) omits F — so an edit to F would not bump the key. The miss in this
  analysis: **contribution is gated by `get_artifacts`, which equals neighborhood membership.** The
  diagnostics resolver's `get_artifacts` closure reads only `DiagnosticsSnapshot::artifacts_map`,
  populated solely from `payload.neighborhood` (`handlers.rs` precollect loop). For an
  out-of-neighborhood F the fallback may compute F's URI, but `get_artifacts(F)` is `None`, so F
  contributes nothing — exactly as the fingerprint assumes. For an in-neighborhood file,
  `extract_subgraph` retains every intra-neighborhood edge (both endpoints present), so the resolver
  reaches it via a real edge the fingerprint also walks, never only via the fallback. Hence the
  resolver's contributing set equals the fingerprint's set in every regime; a truncated resolution is
  approximate-but-self-consistent and the cache reuses it soundly (a fresh resolution would truncate
  identically). An earlier draft added a `neighborhood_visited_truncated` gate to skip the cache under
  truncation; it was reverted as unnecessary once the `get_artifacts` gating was traced.
  **Tripwire:** if `artifacts_map` is ever seeded beyond the neighborhood (so `get_artifacts` can
  return `Some` for a file absent from the trimmed subgraph), this fingerprint walk must then follow
  the resolver's `resolved_uri` / path fallback, or the truncation gate must be reinstated.

## Benchmarks + directive performance gate

Design: `specs/issue-483-wi2b-benchmarks-design.md`. Implementation:

- **Shared corpus builder** `test_utils::standalone_hub::build_hub_corpus(standalone, width, depth, callers)` (test-support-gated) — a worldwide-shaped hub workspace, directive toggleable.
- **Criterion group** `cross_file_standalone_cache` in `benches/cross_file.rs`: `caller_resolve/{cold_miss,warm_hit,cache_off}`, `fanout/{with,without}_directive`, `completion/{with,without}_directive`. Measured on the deep synthetic corpus: fan-out 6.25×, completion 6.68×, warm-hit vs cache-off 5.7× (worldwide is larger still: completion 203→20 ms ≈ 10×). Tracked in CI via `perf.yml` (filtered, fast).
- **Hard gate** `standalone_cache::tests::standalone_directive_enables_fanout_cache_reuse` — DETERMINISTIC: the directive must let the fan-out reuse the cached hub scope (≥ N−5 hits over N callers; a non-standalone hub consults the cache 0 times). Runs in the normal suite (~0.5 s). The `#[ignore]`d `standalone_directive_fanout_is_faster` is the wall-clock companion (release-run, ≥1.5× vs measured ~6×).
