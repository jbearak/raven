# Issue #483 (WI2b) — implementation notes / refinements to `specs/issue-479-spec.md`

These notes confirm the locked WI2b design and record the concrete implementation
decisions made during coding. They refine (do not contradict) the WI2b section of
`specs/issue-479-spec.md`.

## Confirmed against current code (post-#479, post-#482)

- **Part 1 shipped** (`scope.rs:5042`): `parent_prefix_at` returns the empty
  `ParentPrefix` for a standalone `uri`. So a standalone file's own backward walk
  is skipped.
- **Part 2 NOT shipped**: both forward-child sites still thread the caller's
  packages / `DataAliasProvider` / working directory into a standalone child:
  - streaming/recursive forward-source dispatch: `scope.rs:5810` (`packages_for_child`),
    `5826` (`child_ctx`), `5877` (`provider_fp`), `5896`/`5922` recursive calls.
  - `ScopeStream::resolve_source_contribution`: `scope.rs:7844` (`child_ctx`),
    `7911` (`provider_fp`), `7924` recursive call.
- The backward parent walk already resolves a parent at `scope.rs:5199` with
  `inherited_packages = {}` (`5211`), `data_alias_provider = None` (`5238`),
  and the parent's OWN `PathContext` (`5175`). So the **backward-parent** path is
  already caller-independent; only the **forward-child** path needs part 2.
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

## Refuted findings (documented to prevent re-flagging)

- **`rm()` removal column not hashed** (Codex session `019ed1e4`): FALSE POSITIVE. `rm()`
  removes a *symbol*, and symbols from a member's backward parent are leak-filtered at the
  M→C merge (`child_source_symbol_is_leak`), so a removed symbol never reaches C's scope;
  `rm()` cannot remove packages. `compute_interface_hash` is shared with revalidation, so
  no removal-column plumbing was added.

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
