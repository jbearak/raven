# Spec — #472: Memoize forward-source child contributions in the recursive scope resolver

## Problem

#471 (`isolate_forward_source_visits = true`) fixed a correctness bug: an
earlier-sourced sibling's symbol was dropped from a later sibling's scope
because the shared `visited` map marked it already-visited. The fix gives each
forward `source()` branch a *path-local* clone of `visited` (the ancestor
snapshot taken before STEP 1), so one sibling's recursion can no longer
short-circuit another.

Side effect: that shared `visited` map previously also deduped files the
**backward** (parent-prefix) walk had already resolved. With isolation, a
forward-sourced child re-resolves files the backward walk already visited.
Measured: **~+7% on `raven check`** of the dense `worldwide` workspace
(~5.01s → ~5.35s). Per-file editor latency is unaffected (~0%). A lazy-clone
experiment showed the cost is the **re-resolution**, not the `visited.clone()`.

## Goal

Eliminate the re-resolution cost by memoizing the EOF resolution of each
forward-sourced child file, **without** reintroducing the #471 sibling bug and
without changing any resolved scope (symbols, packages, package origins, chain,
depth_exceeded, visible_positions) for any query.

## Key invariant we exploit (revised after adversarial review)

A forward `source()` always resolves the child at EOF `(u32::MAX, u32::MAX)`
(scope.rs:5518/5541). The child's **resolved scope** (symbols, packages,
package_origins, chain, depth_exceeded, visible_positions) is a *deterministic
function* of these inputs, all fixed within one top-level query except the
first three:

- `child_uri`
- the child's effective `PathContext` — governs which files the child's own
  `source()` calls resolve to (depends on caller `# raven: cd` / chdir / workdir,
  **and** the workspace-root fallback, which keys on *both* `working_directory`
  and `inherited_working_directory` being absent — path_resolve.rs:252/258).
- the **attached package set** seeded into the child (`packages_for_child`).
  Adversarial review (Codex) disproved the original "package-independent" claim:
  bare `data(stem)` expansion reads `loaded_packages ∪ inherited_packages` to
  bind dataset symbols (scope.rs:5742-5748), so the caller's seed **can** change
  the child's *symbols*; and `package_origins` is behaviorally observable — it
  drives `package_only_origin_is_uri` leak filtering (scope.rs:~944) and the
  final merged package set that determines symbol resolution. So the seed is a
  real input and must be in the key.
- `hoist_globals`, `max_depth`, `backward_dep_mode`, and the presence/identity
  of the `DataAliasProvider` — all fixed within one top-level query (this is why
  the memo is per-query, not per-snapshot; a snapshot-shared memo would have to
  add the provider to the key).

**Soundness by construction**: because the key captures every input that varies
the result, a memo *hit* returns a value byte-for-byte identical to a fresh
resolution. No empty-seed normalization, no package re-seeding, no `data()`
special-casing — the child is computed with its *real* inputs and the cached
value is exactly what recomputation would produce. The only exclusion is the
cyclic case (below).

## Design

Add a **per-top-level-query** memo of forward-child EOF contributions, threaded
through `scope_at_position_with_graph_recursive` and consulted at every forward
`source()` resolution (STEP 2 of the recursive resolver, and the equivalent
parent-frame STEP 2 reached via `parent_prefix_at`). Scope: one top-level
resolve call (it recovers the regression, which is *within-query*
re-resolution; it does not attempt cross-query/snapshot reuse, which carries the
`data_alias_provider`/provider-consistency hazards described in Risks).

### Cache shape

```rust
// Per-query memo of forward-sourced child EOF scopes. Created fresh at each
// top-level entry; threaded by &mut/&RefCell through the recursion; NEVER
// shared across top-level queries.
type ForwardChildMemo = HashMap<MemoKey, Arc<ScopeAtPosition>>;

struct MemoKey {
    child_uri: Url,
    path_fp: PathFingerprint,      // full effective path-resolution state
    pkg_fp: u64,                   // order-independent hash of attached pkg set
}
```

- `PathFingerprint` captures the **full** path-resolution state that changes
  which files the child's own `source()` calls resolve to: `file_path`,
  `working_directory`, `inherited_working_directory`, `workspace_root`, and the
  `chdir`-derived child-context bits (path_resolve.rs:38). It must distinguish
  two parents that yield the same *effective* dir but different workspace-root
  fallback applicability (one has an explicit `working_directory`, the other
  only an inherited one). Simplest correct implementation: hash the
  `PathContext`'s relevant fields directly. When no `# raven: cd`/chdir is in
  play (the common case and the `worldwide` perf target) every reaching frame
  yields the same fingerprint → full reuse.
- `pkg_fp` is an order-independent hash of the `packages_for_child` set passed
  into the child. This makes `data()` symbol-binding and `package_origins`
  attribution part of the key, so a hit is byte-identical.
- The memo is created fresh at the top-level entry points and threaded as
  `&RefCell<ForwardChildMemo>` (mirroring `prefix_cache`) through **every** site
  that recurses into a forward child. **Never** shared across top-level queries.

### Threading (Codex NQ1, NQ2 — required for the memo to be effective)

The memo must reach every forward-child recursion or it won't fire on the path
that carries the regression:

- **`ScopeStream`** (handlers.rs:5330/6157 — the production undefined-variable
  path): add a `forward_child_memo` field, created in `ScopeStream::new`, and
  pass it into `resolve_source_contribution`'s child recursion (scope.rs:~7407).
  Without this the memo is unreachable from the path where the +7% lives.
- **`parent_prefix_at`** (scope.rs:4720) and **`compute_or_get_cached_prefix`**
  (scope.rs:7600): thread the memo so STEP 1's backward-walk expansion of each
  ancestor's forward sources **populates the same memo** STEP 2 reads. On a
  `ParentPrefixCache` hit STEP 1 isn't re-run (won't populate), but STEP 2's own
  forward subtree still dedups internally — the dominant win (the hub's shared
  children resolved once even when reached by many paths).
- **`scope_at_position_with_graph`** / **`_cached`** / **`_recursive`**: create
  at the top entries, thread through the recursion. Each gains one
  `&RefCell<ForwardChildMemo>` parameter, consistent with `prefix_cache`.

**Expected hit rate**: the regression is *within-query* re-resolution of files
the backward walk (STEP 1) already expanded. STEP 1 expands each ancestor's
forward sources at EOF; STEP 2 re-resolves this file's own forward sources. In a
hub-and-spoke repo, querying an interior/hub file walks its many ancestors
(STEP 1), each of which re-resolves the hub's shared children; STEP 2 resolves
them again. By the time the resolver reaches deep shared children, the attached
package set has converged (all paths went through the same bootstrap), so
`pkg_fp` matches across reaching frames → the memo hits and the children are
resolved once. (To be validated by the bench + hit-rate logging.)

### Computation & merge

1. At a forward `source()` site, build `MemoKey` from `child_ctx` and the
   `packages_for_child` set.
2. **Cyclic exclusion (sound predicate)**: memoize child `C` iff
   `graph.detect_cycle(&C).is_none()`. Rationale: a child's scope is
   ancestor-dependent only if its forward subtree can reach `Q` or an ancestor
   of `Q` (the only entries in its `forward_visited_base` snapshot —
   scope.rs:5218 takes it before STEP 1, so it holds exactly the current forward
   path `Q → … → caller`). Any such reach `X → … → C → X` is a **source cycle
   through `C`**, so `detect_cycle(C)` returns `Some`. Contrapositive:
   `detect_cycle(C).is_none()` ⟹ `C`'s subtree touches no path member ⟹ `C`'s
   scope is a pure function of `(child_uri, path_fp, pkg_fp)` ⟹ memo-sound. The
   "child on the live `visited` stack" predicate the first draft proposed is
   **insufficient** (a child not on the stack can still source back to an
   ancestor). `detect_cycle` is cached per `(uri, edge_revision)`
   (dependency.rs:1606), so per-child checks are cheap. In an acyclic repo
   (worldwide, and the common case) every child qualifies → full memoization.
3. On memo **hit**: reuse the `Arc<ScopeAtPosition>`.
4. On memo **miss**: resolve the child via the existing recursive call with its
   **real** inputs (real `packages_for_child`, real `child_ctx`), wrap in `Arc`,
   insert. Population happens *after* the recursive call returns, so the memo
   never holds a partial scope.
5. **Leak filters stay at the merge site, entirely unchanged.** The cached value
   is the child's full `ScopeAtPosition` (including `parent_prefix_symbol_names`).
   The existing merge loop applies `child_source_symbol_is_leak(&symbol, &name,
   caller_uri, &child.parent_prefix_symbol_names)` and `merge_child_source_packages(...)`
   with the caller's `uri` — caller-dependent, so they run per merge, never
   baked into the cache.

### Cycle handling

Covered by the cyclic-exclusion gate (step 2). The memo only ever stores scopes
for children NOT on the current ancestor path, which are pure functions of the
key. Regression-test a wrapper↔queried-file source cycle: identical result with
and without the memo, no infinite recursion.

## Acceptance criteria (from the issue)

1. **Bench**: extend `crates/raven/benches/cross_file.rs` with a *leaf-query*
   fixture that exercises the backward walk + forward re-resolution (a dense
   hub: one hub file sourcing N children, a bootstrap sourcing the hub, many
   leaves sourcing the bootstrap; query a leaf at EOF). The new arm shows the
   regression eliminated (≤ pre-#471 timing), and ideally faster than pre-#471
   baseline (children resolved once per query, not per reaching frame).
2. **Whole-workspace**: `raven check` on a dense fixture returns to ≤ pre-#471
   timing. (Validated via the bench + a release-build timing check on a generated
   dense workspace.)
3. **All existing cross-file scope tests stay green**, especially
   `sibling_source_symbol_visible_through_shared_hub_parent_walk`
   (scope.rs:15472).

## Test plan (new tests)

- **Cache-vs-uncached equivalence (MASTER GATE, property-style)**: for a battery
  of dense workspaces (with/without `# raven: cd`, with/without `library()`,
  with/without bare `data(stem)`, with cyclic source-backs), assert the memoized
  resolver returns a `ScopeAtPosition` **byte-for-byte equal** (symbols,
  loaded_packages, inherited_packages, package_origins, chain, depth_exceeded,
  visible_positions) to the un-memoized resolver for every file's EOF query.
  This is the master correctness gate and directly tests the `data()`,
  package-origin, path-context, and cycle concerns. Implement as a reusable
  helper run over all existing cross-file fixtures, not just new ones.
- **#471 regression pinned**: `sibling_source_symbol_visible_through_shared_hub_parent_walk`
  stays green; add a variant where the shared hub is queried by two siblings in
  one workspace scan and both see all hub symbols.
- **cd-discriminant**: a child sourced by two parents with *different*
  `# raven: cd` such that `source("x.r")` resolves to different files; assert the
  memo does not cross-contaminate (different discriminants → different slots).
- **Cycle**: wrapper ↔ queried-file source cycle resolves identically with and
  without the memo, no infinite recursion. Reuse the existing revisit-cycle
  fixtures (scope.rs:~15462). Cycle members are excluded from the memo
  (`detect_cycle` is `Some`); assert correctness, not a perf win, on cyclic
  inputs.
- **Cycle-heavy dense hub** (Codex NQ3): a dense hub where some edges form
  cycles. Assert the master equivalence still holds (acyclic children still
  memoize; cyclic ones fall through). Document that perf gains are scoped to the
  acyclic majority of the graph.

## Risks / adversarial-review focus (Codex findings, resolved)

1. **[C1, resolved] `data()` symbol-dependence on caller packages**: real, but
   handled by putting `pkg_fp` in the key — the cached value is computed with the
   real seed, so a hit is identical. Master gate includes a bare-`data(stem)`
   fixture.
2. **[C2, resolved] `package_origins` observability**: real; same resolution —
   `pkg_fp` in the key + real-input computation makes the cached `package_origins`
   identical to a fresh one. Master gate asserts `package_origins` equality.
3. **[C3, resolved] PathFingerprint completeness**: key on the FULL path state
   (file_path, working_directory, inherited_working_directory, workspace_root,
   chdir bits), not just effective dir, so workspace-root-fallback differences
   don't collide. Master gate includes a `# raven: cd` divergence fixture.
4. **[M1, resolved] cycles**: sound predicate `detect_cycle(C).is_none()` (not
   "on the stack" — a child off-stack can still source back to an ancestor).
   Master gate includes cycle + cycle-heavy-hub fixtures.
5. **[M2, OPEN — empirical] per-query sufficiency**: the regression is described
   as within-query (forward children re-resolving files the backward walk
   visited). Per-query memo targets exactly that. VALIDATE with the bench; if the
   bench shows the win is actually cross-target (hub re-resolved per CLI target),
   escalate to a snapshot/run-scoped memo that additionally keys on the
   `DataAliasProvider` identity. Add hit-rate logging behind a debug flag to
   confirm.
6. **[M4, resolved] two cache layers**: the new memo lives **below** the stream,
   at the recursive-resolver level (key = child_uri + path_fp + pkg_fp), storing
   raw child EOF scopes. `ScopeStream::source_contributions` stays **above**, a
   per-call-site cache of post-leak, caller-specific contributions. They are
   distinct layers with distinct keys; the new memo does not replace the stream
   cache. Document both.
7. **`visible_positions` / `chain` accumulation**: merged additively at call
   sites; a hit must contribute the same as a miss. Master gate covers this.
