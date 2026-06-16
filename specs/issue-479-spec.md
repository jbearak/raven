# Spec — #479: Behavior-preserving performance for hub-heavy workspaces

Make Raven performant on hub-heavy workspaces **without changing diagnostic
behavior**. Bar: IDE completions/diagnostics with no perceptible pause, and
`raven check .` in single-digit seconds, on the case study repo.

Case study (the benchmark): `~/repos/worldwide` (~245 R files). ~84 files
`source("bootstrap.r")`; `bootstrap.r` → `scripts/functions.r` → ~52
single-function files; `bootstrap.r` is itself sourced by ~84 files (a dense
hub). Baseline (release, merged #476 at `d15afd67`):

- `raven check .` ≈ **25.6s** (measured on this build), **361 undefined-variable**
  findings (saved sorted to `/tmp/baseline_undefined.txt` as the byte-identical
  reference).
- `raven check scripts/functions.r` ≈ **3.54s** wall (incl. ~0.4s scan) while
  `DiagnosticsSnapshot::build` ≈ **1.56ms** (neighborhood 211 files, 162µs) —
  the cost is in `diagnostics_from_snapshot` / scope resolution, not the
  snapshot build.

**Hard constraint — behavior-preserving.** Diagnostics must stay byte-identical
(`raven check . 2>/dev/null | grep undefined-variable | sort` unchanged
before/after each change, **except** in files where the new directive is added).
The #472 forward-child-memo equivalence tests and the recursive/streaming
equivalence tests must stay green. A real bug found while refactoring is fixed
or filed separately — never silently changed output.

This issue has **three** work items, done in this order. #480 (the general,
automatic cross-query scope cache) is **out of scope** — high-risk, separate
review gate.

---

## Work item 1 — Tier 1: share the prefix `ForwardChildMemo` within a snapshot

**Status: validated in the #476 session (8.4× on `functions.r`, byte-identical).
Low risk. Do this first — it proves memo-sharing is behavior-preserving.**

### Root cause (re-verified against code)

`compute_or_get_cached_prefix` (`scope.rs:8000`) memoizes STEP-1 backward-walk
prefixes per `(uri, query_inside_function)` in the per-snapshot
`ParentPrefixCache`. But at **`scope.rs:8034` it allocates a fresh
`ForwardChildMemo` per prefix computation**:

```rust
let prefix_forward_child_memo = std::cell::RefCell::new(ForwardChildMemo::default());
```

Each of the ~54 prefix slots therefore re-resolves the hub's forward children
from scratch → O(N²) re-resolution of the hub closure. For `functions.r`:
~115k forward-child computes, 98% inside prefix resolution.

### Why sharing is safe (the invariant that licenses it)

The doc comment at `scope.rs:8024-8034` explains why the memo is currently
fresh-per-prefix: the prefix is computed at a **canonical `current_depth = 0`
origin**, whose forward-child depths do NOT match the actual depth a streaming
forward sweep reaches the same child at. Reusing prefix-resolved children in the
**stream's actual-depth memo** could perturb depth-dependent bookkeeping
(`depth_exceeded`, `chain`) under a small `maxChainDepth`.

Crucially, that hazard is **prefix-memo ↔ stream-memo**, not **prefix ↔ prefix**.
*All* prefix computations within a snapshot share the same canonical depth-0
origin, so a child resolved for one prefix slot is byte-identical to the same
child resolved for another prefix slot. Sharing one memo **across all prefix
computations** is therefore sound, provided it stays **separate** from the
stream's actual-depth `forward_child_memo`.

The depth-reuse rule (`scope.rs:1159-1192`, reuse only when
`child_depth <= compute_depth`, cache only `depth_exceeded.is_empty()` scopes)
and the cycle-disable (`scope.rs:1138-1152`, `graph_has_cycle` cell → bypass
memo on any cyclic graph) are properties of `ForwardChildMemo` itself and carry
over unchanged to a shared instance.

### Design

Give the prefix memo the **snapshot** lifetime instead of the
**per-prefix-call** lifetime, keyed to the same scope as `ParentPrefixCache`
(which is already one-per-snapshot, see its doc at `scope.rs:4767`). Concretely:
add a `prefix_forward_child_memo: RefCell<ForwardChildMemo>` field to
`ParentPrefixCache`, and at `scope.rs:8034` (the **streaming** entry point's
prefix path, the diagnostics hot path) borrow that field instead of allocating a
fresh memo.

**Scope of WI1 — stream path only.** The other prefix entry point,
`scope_at_position_with_graph_cached` (`scope.rs:4846`), allocates ONE
`forward_child_memo` *per position query* and shares it between its single
prefix computation (`scope.rs:4867`) and STEP 2 (`scope.rs:4902`). Both legs run
at `current_depth = 0` there, so that local memo is already correct and is NOT
the O(N²) site (it is per-query, not per-prefix). The validated 8.4× prototype
touched only the stream path. Sharing a memo *across* position queries within a
snapshot is a separate, unvalidated optimization (interactive hover/completion
latency) and is **explicitly out of WI1** to preserve its "validated,
byte-identical, low-risk" property. Leave `scope.rs:4846` unchanged.

- It rides `ParentPrefixCache`'s existing one-per-snapshot discipline and
  snapshot-boundary warning (`scope.rs:4767-4798`), so it cannot leak across
  snapshots.
- It stays strictly separate from the stream's actual-depth
  `forward_child_memo` (a different `RefCell`, never passed where the stream's
  memo is expected). The separation the doc comment requires is preserved.
- The shared memo accumulates across all `compute_or_get_cached_prefix` calls
  within the snapshot, collapsing the O(N²) re-resolution to O(N).

`ParentPrefixCache` is constructed in ~30 sites (production: `handlers.rs:393`
`DiagnosticsSnapshot`, the streaming collectors; plus `qualified_resolve.rs` and
many tests). Because the new field is `Default`, `ParentPrefixCache::new()` /
`::default()` keep working at every site with no signature change.

### Verification

- `cargo test --lib --features test-support` green, **including** the #472
  forward-child-memo equivalence tests and the recursive/streaming equivalence
  tests.
- `raven check . 2>/dev/null | grep undefined-variable | sort` **byte-identical**
  before/after (diff empty) on worldwide.
- Re-measure `raven check scripts/functions.r` and `raven check .`; report the
  delta. Expectation from the prototype: `functions.r` ~2.8s → ~0.3s, internal
  child computes ~113k → ~1.7k, `raven check .` ~25s → ~21s.
- Re-run `cargo bench --bench cross_file --features test-support --
  cross_file_forward_child_memo` and report the delta vs main.

---

## Work item 2 — Callee-side `# raven: standalone` directive (REQUIRED)

A file-level directive placed at the top of a sourced *library* file (e.g.
`scripts/functions.r`) declaring it self-contained. Final name: **`# raven:
standalone`** (callee-side only; a caller-side per-`source()` variant is
explicitly deferred).

### Semantics (three knobs — only knob 1 is a behavior change)

1. **(LOAD-BEARING) The callee is resolved in isolation.** When computing scope
   for a position *inside* a standalone file C, Raven does **not** walk backward
   to the files that `source()` C (no STEP-1 parent-prefix walk), **and** does
   **not** inherit any caller-provided inputs: caller packages
   (`scope.rs:5412,5715`), the caller's `DataAliasProvider`, or the caller's
   working directory. C's scope is computed from C's own definitions, C's own
   loaded packages, C's own `# raven: cd`, and C's own forward closure — nothing
   from any caller. This is what makes C's EOF scope a pure function of
   `(C, C's forward closure)` and therefore caller-independent (the precondition
   for both correctness and caching).
2. **It only ADDS to a caller's scope.** Already the default forward behavior
   (the forward merge at `scope.rs:5905` only *inserts* the child's surviving
   symbols). `standalone` does not change this. Recorded for completeness; no
   code.
3. **C's `rm()`/`remove()` effects do not propagate out to callers.** **Already
   guaranteed by the existing additive merge** — verified at `scope.rs:5905`,
   which iterates `child_scope.symbols` (C's EOF map, with C's own removals
   already applied during C's resolution at `scope.rs:5992`) and never replays
   C's `Removal` events against the caller's accumulated scope. A caller's own
   bindings are therefore untouched by C's `rm()` regardless of `standalone`.
   No code; asserted as part of the contract.

**Net:** the only behavioral switch is knob 1 (skip backward walk + drop
caller-inherited packages/provider/cd for C). Knobs 2 and 3 are pre-existing
properties of the additive forward merge, documented here so the contract is
explicit.

### Why required (perf + correctness)

- **Perf:** knob 1 makes C's EOF scope a **pure function of `(C, C's forward
  closure)`**, independent of who sources it. So it is cacheable and reused by
  all 84 callers and across keystrokes (see Caching below). It is the direct fix
  for the bootstrap/`functions.r` hub: computing `functions.r`'s own diagnostics
  no longer resolves the ~84-caller backward union.
- **Correctness:** the caller-union over-approximation that knob 1 removes is the
  same class that produced #476's `getArray` false positive. Declaring the hub
  standalone prevents that class.

**Opt-in safety (safe direction).** The user vouches for the property. If a
"standalone" callee actually relies on a caller-provided binding, the worst case
is a false-positive *undefined inside the callee* — never a hidden real bug in a
caller. This is why it needs no over-approximation/provider/trimmed-view
soundness machinery (those are #480's traps): the directive *asserts* the
independence rather than inferring it.

### Parsing & metadata

- Parse in `crates/raven/src/cross_file/directive.rs` alongside the other
  `# raven:` families. The directive is **file-level** and **header-only**: it
  must appear in the header region (consecutive blank/comment lines from file
  start). Note the existing parser has two precedents: backward/working-dir
  directives are gated on an `in_header` flag (`directive.rs:549`), while
  `ignore-file` is parsed *without* that gate (`directive.rs:737`). `standalone`
  follows the **backward/cd precedent**: add an explicit `in_header` gate.
  Accept the `@lsp-standalone` alias for parity (`DIRECTIVE_PREFIX`
  alternation). No payload; an optional trailing `# comment` is allowed.
- Add `pub standalone: bool` (`#[serde(default)]`) to `CrossFileMetadata`
  (`types.rs:185`). `false` by default = today's behavior everywhere.
- Test: a `# raven: standalone` appearing *after* code is silently ignored
  (header-only gate).

### WI2a — knob 1 hook (the load-bearing semantic; the correctness+perf core)

The STEP-1 backward walk is `parent_prefix_at` / `compute_or_get_cached_prefix`.
When the **queried URI** C has `metadata(C).standalone == true`, short-circuit
the backward walk: return an **empty `ParentPrefix`** for C (no walk to C's
`backward` edges). Additionally, when C is resolved as a forward child of a
caller A, resolve C with **canonical, caller-independent inputs** (empty/base
package set, `None` provider, C's own `PathContext`) rather than A's inherited
packages/provider/cd (`scope.rs:5412,5715`) — so C's scope is byte-identical
whether computed for C's own diagnostics or as A's forward child. This canonical
resolution is the precondition that makes the WI2b cache key (C's URI alone)
sound.

This alone removes the ~84-caller backward union when computing `functions.r`'s
own diagnostics and fixes the caller-union over-approximation class (#476
`getArray`). Combined with WI1's shared prefix memo, `functions.r`'s own
diagnostic cost drops sharply with **no caching machinery at all**.

Interface-hash wiring (revalidation): `standalone` changes cross-file scope, so
it MUST feed `compute_interface_hash` (`scope.rs:4493`) — add the `standalone`
bool so toggling the directive in any connected file revalidates dependents. The
metadata-free hash path passes `false`; the metadata-aware path passes
`metadata.standalone`.

### WI2b — persistent isolated-scope cache (the cross-snapshot/IDE win) — MEASURE-GATED

Knob 1 (WI2a) makes C's isolated EOF scope a pure function of `(C, C's forward
closure)`. WI2b caches that scope so it is computed once and reused (a) across
all 84 callers within one diagnostic pass, (b) across the ×84 revalidation
fan-out when the hub is edited, and (c) across the 245 separate per-file
snapshots of `raven check .` (each caller's snapshot would otherwise re-resolve
C). Within-pass reuse alone kills the IDE hub-edit pause; cross-snapshot reuse is
what additionally speeds `raven check .` for the hub.

**Soundness of the cache key.** Because WI2a resolves C with caller-independent
inputs, C's isolated scope does NOT depend on any of the caller-varying fields
in `ForwardChildKey` (`path_fp`/`pkg_fp`/`provider_fp`, `scope.rs:1015`). So C's
URI is a sufficient key *for the scope value* — provided invalidation correctly
detects changes to C or its forward closure.

**Invalidation — staged, measure-driven:**

1. **Start sound and simple: coarse content-edit generation bump.** Maintain one
   global monotonic `content_generation` counter, bumped on every document
   content change. Cache key = `(C_uri, edge_revision, content_generation)`.
   This is **unconditionally sound** (any edit anywhere invalidates) and is the
   exact mechanism the issue calls for. It delivers (a) and (b) fully — within
   one snapshot/pass the generation is stable, so C is computed once and shared
   ×84. For `raven check .` (c), the generation is stable for the whole run
   (no edits mid-run), so C is computed once and reused by all 245 files. The
   only thing it sacrifices: cross-*keystroke* reuse while editing an unrelated
   file (the next snapshot recomputes C once — shared, not ×84).
   **Do NOT reuse `interface_hash` as a scope-value fingerprint:**
   `Hash for ScopedSymbol` omits `signature` (`scope.rs:619` vs `PartialEq` at
   `scope.rs:614`), so a formals-only edit changes the scope without changing
   `interface_hash` — unsound for hover/completion/signature consumers.
2. **Tighten only if measurement demands it: per-closure source fingerprint.**
   If after WI1 + WI2a + the coarse bump, editing a *caller* still leaves a
   perceptible pause (re-resolving C once per keystroke), replace the
   `content_generation` component with a fingerprint over the **source-text
   content hash** of `{C} ∪ forward_closure(C)` (membership pinned by
   `edge_revision`). Source-text hashing captures *everything* observable
   (including signatures), so it is sound where `interface_hash` is not. Editing
   a caller (not in C's closure) leaves the fingerprint unchanged → hit. This is
   the only part that approaches #480's territory; gate it behind a measurement
   that shows it is needed.

**Where the cache lives & lock discipline.** The per-snapshot `DependencyGraph`
is cloned and resets its caches (`dependency.rs:585-610`), so a cross-snapshot
cache must NOT live there. Store it as an `Arc<StandaloneScopeCache>` owned by
`WorldState`. Per CLAUDE.md's locking-discipline invariant and `handlers.rs`
(read lock must not be held across cross-file scope resolution): **clone the
`Arc` handle out of `WorldState` under the read lock, drop the guard, then do
lookup + miss-compute holding no `WorldState` guard.** The cache's own internal
`RwLock`/LRU follows the `subgraph_cache` pattern (`dependency.rs:521-547`):
read locks `peek()` (no promotion), write locks `push()`.

> **Codex review targets (round 2):** (a) the canonical-input resolution in WI2a
> — is there any other caller-varying input beyond packages/provider/cd that
> feeds C's scope? (b) the source-text fingerprint (option 2) — is per-file
> source hash sound and is the closure membership truly pinned by edge_revision?
> (c) the `Arc`-handle-out lock discipline.

### Interactions (resolved; Codex round 2 to stress-test)

- **`# raven: cd`** — `standalone` only suppresses C's *backward* parent-prefix
  walk and caller-inherited inputs; backward directives already ignore
  `# raven: cd` (`PathContext::new`). C's own forward path resolution respects
  C's own `# raven: cd` exactly as today. No change to path resolution. (Note
  knob 1 explicitly drops the *caller's* inherited working directory for C — C
  uses only its own.)
- **`# raven: nse` / `# raven: func`** — NSE/func propagation is **graph-only**:
  `collect_cross_file_nse` walks the revalidation-consistent set `S(Q)` over the
  source graph and reads only `nse_declarations`/`declared_functions`, never
  scope data (`handlers.rs`). `standalone` changes *scope content* resolution,
  not graph edges, so the two are independent: `standalone` does NOT sever NSE
  propagation. **Scope boundary to document explicitly:** because knob 1 also
  drops caller-inherited *packages*, a package the caller loads that an NSE
  policy depends on is no longer in-play *inside* C (ancestor packages are
  otherwise included, `handlers.rs:5607`). This is intended isolation
  (safe-direction: worst case a false-positive inside C). Document that
  `standalone` isolates C's lexical scope **and** its in-play package set from
  callers, while leaving NSE/func *directive* propagation over graph edges
  intact.
- **Package mode** — orthogonal; `standalone` is about `source()` topology, not
  package exports. No change.
- **`sys.source` / `local = TRUE`** — these already get local scoping
  (`should_apply_local_scoping`, `scope.rs:1201`). `standalone` is about the
  *callee's* backward walk, independent of how a caller sources it. Document that
  `standalone` and per-call local scoping compose without conflict.

### Docs

- `docs/directives.md`: add `# raven: standalone` (header-only, file-level,
  `@lsp-standalone` alias, three-knob semantics, opt-in safety note).
- `docs/cross-file.md`: explain the standalone callee model and the caching it
  enables; cross-link from the hub-pattern discussion.
- Behavior identical across editor and CLI (it is a directive, not a setting —
  the three-places settings rule does not apply).

### Verification

- New unit/integration tests: (a) standalone callee with a deliberately
  caller-provided binding → false-positive *inside the callee* (proves knob 1);
  (b) a standalone callee's scope is byte-identical whether computed for its own
  diagnostics or as a forward child of two different callers with *different*
  loaded packages (proves caller-independent canonical resolution); (c) toggling
  `standalone` revalidates dependents (interface-hash wiring); (d) header-only
  gate: `# raven: standalone` after code is ignored; (e) `# raven: cd` / `nse` /
  `local=TRUE` interaction tests; (f) WI2b cache: editing a caller does NOT
  change C's cached isolated scope value (under option 2, a cache-hit; under the
  coarse bump, a recompute that yields the identical value); editing C or a
  closure member changes it.
- On worldwide: add `# raven: standalone` to `scripts/functions.r` (and/or
  `bootstrap.r` per measurement), re-measure `functions.r` and `raven check .`,
  report deltas. Diagnostics byte-identical except in the directive-bearing file.

---

## Work item 3 — Tier 2: parallelize the CLI per-file loop

**Independent of items 1–2. CLI-only (does not help the IDE, already async).**

### Design

The per-file loop in `cli/check.rs:366` (`run()`) is sequential
(`compute_file_diagnostics` per target). The graph caches are
`RwLock`/atomic (Send+Sync) and immutable after the workspace scan, so per-file
diagnostics parallelize with rayon.

**Codex caveat (load-bearing):** do **not** open all targets into shared
`state.documents`. Open documents outrank index content in the content provider
for content, metadata, AND artifacts (`content_provider.rs:103-117`, and the
open-doc-wins branches at the content/metadata/artifacts accessors). If every
target were open at once, each worker's cross-file resolution would treat
*other* targets as open and use the wrong artifacts source, changing output.
Today the loop opens **exactly one** target at a time (`open` → `compute` →
`close_document`, `check.rs:337-367`) and mutates shared `state.documents`
(`check.rs:315`) — which is exactly what must NOT be shared-mutable across rayon
workers.

Preserve the invariant under parallelism with a **per-task read-only overlay**
that overrides content + metadata + artifacts for **exactly one** URI, layered
over a shared immutable view of the scanned index/graph (computed once, before
the parallel region). No worker mutates shared `state.documents`. Each task
computes `{shared index/graph} + {this one open target}` → `(path,
Vec<Diagnostic>)`.

**Async/rayon bridge (must be explicit):** `compute_file_diagnostics` is
`async` (`check.rs:366`) while rayon is sync. Resolve deliberately — either keep
the orchestration on the async runtime and parallelize with bounded
`tokio` tasks / `spawn_blocking`, or `block_on` per rayon worker. Pick one in
the implementation plan; do not leave it implicit.

**Shared-state aggregation:** `reported_loaded_packages` (`check.rs:363`) is
accumulated in the loop today; under parallelism, collect per-task and merge
after the join. Budget counters live on the shared graph as atomics
(`check.rs:404`) — confirm they remain correct under concurrent access, or
return per-task counts and sum. The package-metadata warm-up
(`prefetch_reported_packages`) runs before the loop and is unaffected.

Output is already sorted after collection (`check.rs:374`), so result order is
deterministic regardless of completion order.

> **Codex review target (round 2):** the exact overlay type (a per-task content
> provider / cheap `state` view holding one open doc) that avoids cloning the
> whole index per task; the chosen async/rayon bridge; and that
> `reported_loaded_packages` / budget counters aggregate correctly.

### Verification

- `raven check . 2>/dev/null | grep undefined-variable | sort` **byte-identical**
  before/after (full output diff empty: same findings, same order).
- Re-measure `raven check .`; expect ~3–5× → single-digit seconds.
- Determinism: run `raven check .` 3× and diff — identical (the #476 sort fix +
  post-loop sort must hold under parallel completion).

---

## Workflow & gates

1. Tier 1 → measure → prove byte-identical.
2. Directive → spec interactions resolved with Codex → implement → measure.
3. Tier 2 → implement → measure.

CI gates before each commit:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings`
- `cargo test --lib --features test-support`

Final gate: two consecutive clean `/code-review` rounds + a final Codex
adversarial pass before merge. Report the #472 bench delta vs main. Never claim a
speedup without a before/after number on worldwide.
