# Issue #460 — Cross-file propagation of `# raven: nse` directives (design spec)

**Status:** Draft for adversarial review
**Issue:** #460 "Make `# raven: nse` directives propagate across source graphs"
**Builds on:** #455 (user-declared `# raven: nse` call policies), branch `issue455`

---

## 1. Problem and goal

`# raven: nse` directives added in #455 suppress undefined-variable diagnostics
**only in the file that physically contains the directive**. In cross-file
projects, the NSE contract for a helper is often declared next to the
`library()` call, the function definition, or in a sourced setup file — while
the *call sites* live in a different file in the same `source()` graph.

Two directions must work (issue examples):

- **Down (ancestor declares, descendant calls):** `parent.R` has
  `# raven: nse: lmer`; `child.R` does `source("parent.R"); lmer(undef)`. The
  `undef` diagnostic must be suppressed in `child.R`.
- **Up (descendant declares, ancestor calls):** `parent.R` does
  `source("child.R"); lmer(undef)`; `child.R` has `# raven: nse: lmer`. The
  `undef` diagnostic must be suppressed in `parent.R`.

Plus transitivity (≥ 2 source edges), shared sourced helpers reaching all the
files that source them, and order-independence of the context (`library()`,
function definition, `# raven: func`) that makes a directive resolvable.

**Goal:** make a `# raven: nse` declaration govern undefined-variable checks in
every file connected to it through the resolved `source()` / forward-directive
dependency chains — reusing the existing dependency graph, path-resolution, and
revalidation machinery so behavior stays consistent with how `library()` loads
and defined symbols already propagate.

---

## 2. How it works today (verified, with citations)

### 2.1 Per-file NSE pipeline

- Directives parse into `CrossFileMetadata.nse_declarations: Vec<NseDeclaration>`
  and `CrossFileMetadata.declared_functions: Vec<DeclaredSymbol>` (with optional
  `formals`) — `crates/raven/src/cross_file/types.rs`,
  `crates/raven/src/cross_file/directive.rs`.
- `NseDeclaration { name, package: Option<String>, scope: NseScope, line }`,
  `NseScope::{WholeCall, Formals(Vec<String>)}` — `types.rs:108`.
- The undefined-variable collector builds an `NseAnalysis` per diagnostic pass
  and feeds it the **current file's** declarations only:
  `crates/raven/src/handlers.rs:5712` passes
  `&snapshot.directive_meta.nse_declarations` and
  `&snapshot.directive_meta.declared_functions`.
- `NseAnalysis::build` (`handlers.rs:12935`) translates each `NseDeclaration`
  into a `DirectiveNsePolicy { line, package, policy }` stored in
  `directive_nse: HashMap<String, Vec<DirectiveNsePolicy>>` (sorted by line),
  resolving per-formal order from (a) `declared_function_formals(declared_functions, …)`
  then (b) the current file's local `name <- function(…)` defs
  (`local_function_defs`), falling back to **named-only matching** when neither
  is available.
- `directive_nse_policy(name, qualifier, call_line)` (`handlers.rs:13220`) is
  **position-gated**: `entries.iter().rev().find(|e| e.line < call_line && …)`.
  The latest applicable declaration before the call wins.

### 2.2 What already crosses file boundaries — the precedent to mirror

`collect_in_play_packages(snapshot, uri)` (`handlers.rs:5511`) already gathers
the package context for NSE resolution across the source graph using **two
separate directed passes** over `snapshot.cross_file_graph`:

1. **ancestors-only** — follow `get_dependents` edges (parents that source
   `uri`) transitively *up*.
2. **descendants-only** — follow `get_dependencies` edges (files `uri` sources)
   transitively *down*.

The two passes are **deliberately kept separate**, each with its own `visited`
set, precisely so the walk cannot cross from a shared child back up to that
child's *other* parents (an "uncle"/sibling-via-shared-parent). The in-code
comment (`handlers.rs:5537-5549`) documents why: a merged/undirected walk would
let an unrelated sibling's `library()` silently suppress genuine diagnostics —
a topology-dependent false negative. Per-file metadata for every neighbor is
already available in `snapshot.metadata_map` (populated from the cached
neighborhood subgraph, `handlers.rs:236-243`).

**This is exactly the propagation shape #460 needs**, and reusing it keeps NSE
propagation consistent with package propagation (issue user story 6).

### 2.3 Revalidation gaps discovered (these block correct behavior today)

Dependent files are re-diagnosed when an edited file's `interface_hash` changes
(or its edges change) — `compute_affected_dependents_after_edit`,
`crates/raven/src/cross_file/revalidation.rs`. `compute_interface_hash`
(`scope.rs:4162`) hashes the exported symbol interface, loaded packages,
declared symbols (name + `is_function` + line), top-level removals, and
`data()` loads. **It does not hash `nse_declarations`, and it does not hash a
declared symbol's `formals`.**

Consequences once NSE/func facts become cross-file-relevant:

- **Gap A:** editing a file so its *only* change is a `# raven: nse` directive
  (add / remove / change shape) does not change its `interface_hash`, so
  connected files are **not** revalidated. The issue's revalidation test would
  fail.
- **Gap B:** changing a `# raven: func name(a, b)` declaration's *formal list*
  (e.g. to `name(b, a)`) does not change `interface_hash` (only `name` /
  `is_function` / `line` are hashed). After #460 a connected file uses those
  formals to decide *which positional argument* a per-formal directive
  suppresses, so a formal-order edit in file A must revalidate file B.

Both must be closed by this change (Section 6).

---

## 3. Locked design decisions

**D1 — Reuse the directed two-pass walk.** Propagated ("foreign") NSE
declarations for a file `U` are collected from `U`'s true **ancestor** chain
(`get_dependents`, transitive) and **descendant** chain (`get_dependencies`,
transitive), using the same separate-passes discipline as
`collect_in_play_packages`. Sibling-via-shared-parent leakage is **excluded**,
matching `library()` propagation. (Open decision OD1 stress-tests this reading
of "siblings through shared sourced files".)

**D2 — Foreign declarations are file-level; own declarations keep position
semantics.** A declaration collected from another file governs the *entire*
current file regardless of line (cross-file line numbers are meaningless against
the current file's call lines, and the issue explicitly permits coarse,
file-level propagation). A declaration physically in the current file keeps the
existing position-gated, latest-wins behavior.

**D3 — Precedence: own-applicable beats foreign.** At a call site, if a *own*
declaration for that callee+qualifier applies (its line < call line, latest
wins), it is used. Otherwise the matching *foreign* declaration applies. This
preserves "the latest applicable directive for a callee wins" within a file
(issue Implementation Decisions) while letting connected files fill gaps.

**D4 — Determinism.** Foreign declarations are collected in a stable order
(neighbor URIs sorted; per-file declaration order preserved) so that when two
connected files declare conflicting shapes for the same callee, resolution is
reproducible. (No ordering by the foreign file's line — that is meaningless
cross-file.)

**D5 — Propagate the resolution context too, via the same graph.**
  - `in_play_packages` is *already* cross-file (`collect_in_play_packages`) — no
    change. This makes the "`library()` before or after the directive, possibly
    in another file" requirement work for package-qualified matching.
  - `# raven: func` declarations (`declared_functions`) **become cross-file**:
    `NseAnalysis::build` receives the union of the current file's and the
    connected files' func declarations, so a foreign `# raven: func name(a, b)`
    supplies positional order to an own or foreign `# raven: nse name(a)`.
    (`declared_function_formals` is name+package-keyed, so a union slice is
    correct.)
  - Local `name <- function(…)` definitions in *other* files are **not**
    propagated for formal order (Limitation L1). When a per-formal directive's
    only available signature is a real function definition in a different file,
    resolution falls back to the existing safe **named-only matching**
    (positional arguments are *not* suppressed; named arguments still are).

**D6 — Order-independence of context within the collected set.**
`NseAnalysis::build` already resolves `in_play_packages`, `declared_functions`,
and `local_function_defs` from file-/set-level collections, *not* gated on the
directive's line. So whether the `library()`, function definition, or
`# raven: func` appears before or after the `# raven: nse` directive already
does not matter within a file; extending the func/package sets across the graph
preserves that property cross-file. No new ordering logic is required — the
ordering tests are regression guards plus cross-file coverage.

**D7 — No new path-resolution behavior.** Propagation reuses
`snapshot.cross_file_graph`, whose edges already encode the correct
forward/backward path semantics (forward directives + AST `source()` get
workspace-root fallback and respect `# raven: cd`; backward directives do not
gain fallback). NSE propagation traverses *edges* and never resolves paths
itself, so all path invariants are inherited unchanged. Backward-directive edges
participate (they are ordinary edges in the graph), which is what makes the
"descendant declares, ancestor calls" direction work when the relationship is
expressed via `# raven: sourced-by`.

**D8 — Scope is call-argument NSE only.** `# raven: nse` governs the call-arg
suppression path (`undefined_variable_in_call_arguments`). Bracket-index
behavior (`undefined_variable_in_bracket_indices`, data.table `[`) is unchanged.

---

## 4. Propagation model (mechanics)

### 4.1 Collecting foreign facts

Add a collector that walks the same two directed passes as
`collect_in_play_packages` and returns, from the union of the ancestor and
descendant chains (excluding `uri` itself):

- `foreign_nse: Vec<NseDeclaration>` — every connected file's
  `metadata.nse_declarations`.
- `foreign_funcs: Vec<DeclaredSymbol>` — every connected file's
  `metadata.declared_functions` (for cross-file formal order).

Collection order is deterministic (D4). To avoid walking the graph twice and to
keep the two collectors provably identical in topology, the preferred
implementation extracts a shared helper that yields the ordered set of
ancestor∪descendant neighbor URIs (two separate passes internally), consumed by
both `collect_in_play_packages` and the new NSE collector. (The plan may instead
add a parallel walk if the refactor proves noisy; the *observable* requirement
is identical topology and determinism.)

### 4.2 Threading into `NseAnalysis::build`

`build` gains the foreign declarations. Minimal shape:

- Keep the existing `nse_declarations` parameter as the **own** (position-gated)
  declarations.
- Add a `foreign_nse_declarations: &[NseDeclaration]` parameter, translated into
  `DirectiveNsePolicy` entries marked **file-level**.
- Pass the **union** of own + foreign `declared_functions` to the existing
  `declared_functions` parameter (name+package-keyed lookup; order irrelevant).

`DirectiveNsePolicy` gains a `file_level: bool` (own = false, foreign = true).
Foreign entries set `file_level = true`; their `line` is irrelevant.

### 4.3 Lookup precedence (`directive_nse_policy`)

```
let entries = self.directive_nse.get(name)?;
// Tier 1 — own declarations: position-gated, latest wins (unchanged behavior)
if let Some(p) = entries.iter().rev()
    .find(|e| !e.file_level && e.line < call_line && qualifier_matches(e, qualifier)) {
    return Some(p.policy.clone());
}
// Tier 2 — foreign declarations: file-level, first in deterministic order
entries.iter()
    .find(|e| e.file_level && qualifier_matches(e, qualifier))
    .map(|e| e.policy.clone())
```

`qualifier_matches` is the existing `(package, CallQualifier)` logic
(`handlers.rs:13232-13246`) extracted unchanged. Because `in_play_packages` is
cross-file, the `BareInPlayQualified` arm already lets a foreign
`# raven: nse pkg::name` match a bare `name` call when `pkg` is in play through
the graph — no extra work.

Entry storage must keep own entries sorted by line and foreign entries in their
deterministic insertion order (e.g. sort key `(file_level, line, seq)` so own
sort by line first, foreign keep insertion order after). The plan locks the
exact mechanic; the requirement is: Tier-1 finds the latest applicable own
declaration; Tier-2 finds the first foreign declaration in deterministic order.

---

## 5. Behavior matrix (maps to issue's required tests)

| # | Scenario | Graph | Expected | Issue test |
|---|----------|-------|----------|-----------|
| B1 | Ancestor declares, descendant calls | `child → parent` (child sources parent); `# raven: nse: lmer` in parent; `lmer(undef)` in child | `undef` suppressed in child | "parent/setup declares, child suppressed" |
| B2 | Descendant declares, ancestor calls | `parent → child`; `# raven: nse: lmer` in child; `lmer(undef)` in parent | `undef` suppressed in parent | "child declares, parent suppressed" |
| B3 | Transitive (≥ 2 edges) | `A → B → C`; directive in A, call in C (and the mirror: directive in C, call in A) | suppressed in both directions | "≥ two source edges" |
| B4 | Shared sourced helper | `A → H`, `B → H`; `# raven: nse` in H | suppressed in both A and B | user story 3 |
| B5 | Unconnected files | no path between files | **not** suppressed; real diagnostic reported | negative test |
| B6 | Per-formal after propagation | foreign `# raven: nse f(x)` + `# raven: func f(x, y)` (possibly in different connected files); call `f(undef_x, undef_y)` | only the `x`-bound arg suppressed; `y`-bound arg still reported | per-formal policy-shape test |
| B7 | Ordering of context | `library()` / `function` def / `# raven: func` appears before *or* after the `# raven: nse` directive (within file and across the connected set) | directive governs regardless | ordering tests |
| B8 | Revalidation on directive edit | connected file's `# raven: nse` (or `# raven: func` formals) added/removed/changed | dependent file's diagnostics update | revalidation test |

Sibling-via-shared-parent (`P → A`, `P → B`; directive in A, call in B) is
**not** cross-pollinated (consistent with `library()`; see OD1). A directive in
the shared parent `P` reaches both A and B (covered by B1/down-propagation).

---

## 6. Revalidation changes (close Gaps A and B)

In `compute_interface_hash` (`scope.rs:4162`):

1. **Add `nse_declarations` to the hash.** New parameter
   `nse_declarations: &[NseDeclaration]`; hash each declaration's `name`,
   `package`, and `scope` (the `NseScope` discriminant and, for `Formals`, the
   ordered formal names). **Omit `line`** — cross-file propagation is file-level
   (line-insensitive), and the declaring file always re-diagnoses itself on its
   own edit, so a pure line move need not invalidate dependents. (Conservative
   alternative: include `line` to mirror `declared_symbols`; rejected as
   imprecise — see OD2.) Sort declarations by `(name, package, scope)` for
   deterministic hashing.
2. **Add `formals` to the declared-symbol hashing.** In the existing
   declared-symbols loop (`scope.rs:4194-4198`), also hash `decl.formals`. This
   closes Gap B: a `# raven: func` formal-order edit now invalidates dependents
   that rely on it for cross-file NSE positional matching.

Call sites: `compute_artifacts` (no metadata) passes `&[]` for
`nse_declarations`; `compute_artifacts_with_metadata` passes
`&meta.nse_declarations`.

Edge-set changes (a new/removed `source()` / directive) already trigger
dependent revalidation via `edges_changed`, so reachability changes are covered
without new work.

---

## 7. Files to change

- `crates/raven/src/handlers.rs`
  - New foreign-NSE collector (shared directed-neighbor traversal preferred).
  - `NseAnalysis::build` — `foreign_nse_declarations` param; union of own+foreign
    `declared_functions`; `DirectiveNsePolicy.file_level`; updated
    `directive_nse_policy` precedence; updated call at `handlers.rs:5712`.
  - Unit/integration tests for B1–B8.
- `crates/raven/src/cross_file/scope.rs`
  - `compute_interface_hash` — add `nse_declarations` param + hash `formals`;
    update both call sites; hash-change unit tests (Gaps A and B).
- `docs/cross-file.md`, `docs/directives.md`, `docs/diagnostics.md` — document
  that `# raven: nse` propagates through source graphs and that cross-file
  propagation is intentionally coarse/file-level (issue requires this).
- `CLAUDE.md` "Key invariants" — add a one-line note that NSE directives
  propagate over the same graph as `library()`/scope facts, ancestor+descendant
  only (no sibling-via-shared-parent), if reviewers find it invariant-worthy.

No new LSP settings, no syntax changes, no built-in policy-table changes
(all explicitly out of scope per the issue).

---

## 8. Out of scope / limitations

- **L1 — Cross-file local-definition formal order.** A per-formal directive
  whose function's signature exists only as a real `function(…)` definition in a
  *different* file resolves via named-only matching (positionals not suppressed).
  Supply `# raven: func` to get cross-file positional matching. Documented.
- Sibling-via-shared-parent cross-pollination (OD1) — excluded by design.
- Diagnostic hint / quick-fix wording stays file-local (still suggests adding
  `# raven: nse`; adding it in any connected file now also works, but the
  suggestion need not advertise that). No behavior change.
- Built-in/package NSE policy tables, `# raven: nse` syntax, and treating
  `# raven: run`/`# raven: include` as execution-time `source()` equivalents are
  all unchanged (issue Out of Scope).

---

## 9. Open decisions for adversarial review

- **OD1 — "siblings through shared sourced files".** This spec reads it as: a
  directive in a *shared sourced file* (a common child/helper) reaches every
  file that sources it (down-propagation, B4) — and **not** as "two files that
  share a child cross-pollinate each other's directives". Rationale: the latter
  requires the merged/undirected walk that `collect_in_play_packages` explicitly
  rejects as a false-negative hazard, and user story 6 demands consistency with
  the existing machinery. Is this the intended reading? If A-declares-→B-calls
  through only a shared child must work, the two-pass model is insufficient and
  we would need (a documented, bounded) connected-component walk instead.
- **OD2 — `line` in the NSE interface hash.** Omitting `line` is semantically
  precise (file-level propagation) but diverges from `declared_symbols`, which
  hashes line. Is the divergence acceptable, or prefer the conservative
  (line-included) form for consistency?
- **OD3 — Foreign-conflict resolution.** When connected files declare different
  shapes for the same callee (one `WholeCall`, one `Formals`), Tier-2 picks the
  first in deterministic order. Is "first deterministic foreign wins" acceptable,
  or should conflicts prefer the most/least suppressive shape?
- **OD4 — Bound reuse.** Propagation honors `max_chain_depth` /
  `max_transitive_dependents_visited` (same as `collect_in_play_packages`). A
  directive beyond the depth bound silently won't propagate. Acceptable (matches
  package propagation), or should NSE be exempt? Recommend: keep the bound;
  `log`/document the truncation behavior already applies.

---

## 10. Risks

- **Performance:** one extra directed graph traversal per diagnostic pass.
  Mitigated by sharing the traversal with `collect_in_play_packages` (same
  neighbor set) and by the existing depth/visited bounds. No new locking — all
  inputs already live on `DiagnosticsSnapshot` (`metadata_map`,
  `cross_file_graph`), snapshotted under the read lock then iterated lock-free
  (CLAUDE.md locking invariant respected).
- **Over-suppression:** foreign whole-call directives are file-level, so a
  connected file's broad `# raven: nse f` suppresses *all* args of every `f`
  call in the current file. This is the intended coarse behavior; user story 5
  (real undefined vars *outside* NSE-captured args keep reporting) is preserved
  because suppression is still scoped to the named callee's arguments, not the
  whole file.
- **Revalidation churn:** adding `nse_declarations` + `formals` to
  `interface_hash` slightly widens what invalidates dependents. Correct and
  necessary; magnitude is small (directive/formal edits are rare).
