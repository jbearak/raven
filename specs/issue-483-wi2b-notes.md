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
  `interface_hash` of `{C} ∪ forward_closure(C)`, walked over the resolver's
  (trimmed-snapshot) graph via `get_dependencies`, with each member's
  `interface_hash` read from `get_artifacts`. Computed lazily and memoized per
  `C_uri` on the per-query `ForwardChildMemo` (constant within a query). Sound
  because the cached value is a function of exactly these inputs in this snapshot;
  a differently-trimmed snapshot yields a different fingerprint and safely misses.
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
