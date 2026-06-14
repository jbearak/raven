# Issue #460 — Cross-file propagation of `# raven: nse` directives (design spec)

**Status:** v3 — revised after adversarial review (codex rounds 1 & 2)
**Issue:** #460 "Make `# raven: nse` directives propagate across source graphs"
**Builds on:** #455 (user-declared `# raven: nse` call policies), branch `issue455`

> **Changelog v1 → v2 (codex round 1):** replaced the narrow two-pass
> (ancestor+descendant) propagation with the **revalidation-consistent set**
> (§4.1); foreign declarations collapse per-file by within-file latest-wins
> (§4.4); formal order resolves **own-first**, never by cross-file raw line
> (§4.5); `FormalOrderTracker` enablement widened (§4.6); NSE interface hash
> **includes line** (§6); hint governance handles file-level foreign entries
> (§4.7); B7 contradiction fixed and L1 clarified.
>
> **Changelog v2 → v3 (codex round 2):** compute `S(Q)` over the snapshot's
> **trimmed neighborhood subgraph** so collection never references a file absent
> from `metadata_map` (closes the snapshot-bounds BLOCKER; §4.1) — propagation is
> bounded by `max_chain_depth` (default **20**, so siblings/transitive cases are
> always covered; the residual is a bounded *missed* suppression, never a wrong
> one). Resolved OD5: the foreign tier sits **after built-in tables, before the
> step-4 resolvable-standard-eval classification** (§4.3) — required so a
> directive can suppress a loaded-package export like `lmer` (which resolves at
> step 4) while still deferring to precise built-in policies. Code-action
> governance (`backend.rs`) aligned with the foreign-aware hint (§4.7).

---

## 1. Problem and goal

`# raven: nse` directives added in #455 suppress undefined-variable diagnostics
**only in the file that physically contains the directive**. In cross-file
projects the NSE contract for a helper is often declared next to the
`library()` call, the function definition, or in a sourced setup file — while
the *call sites* live in a different file in the same `source()` graph.

Two directions must work (issue examples):

- **Down (ancestor declares, descendant calls):** `parent.R` has
  `# raven: nse: lmer`; `child.R` does `source("parent.R"); lmer(undef)`. The
  `undef` diagnostic must be suppressed in `child.R`.
- **Up (descendant declares, ancestor calls):** `parent.R` does
  `source("child.R"); lmer(undef)`; `child.R` has `# raven: nse: lmer`. The
  `undef` diagnostic must be suppressed in `parent.R`.

Plus transitivity (≥ 2 source edges), shared sourced helpers reaching every
file that sources them, and order-independence of the context (`library()`,
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
  `&snapshot.directive_meta.declared_functions`. This is the only **production**
  `NseAnalysis::build` call site (the build at `handlers.rs:15342` is
  `#[cfg(test)]`).
- `NseAnalysis::build` (`handlers.rs:12935`) translates each `NseDeclaration`
  into a `DirectiveNsePolicy { line, package, policy }` stored in
  `directive_nse: HashMap<String, Vec<DirectiveNsePolicy>>` (sorted by line),
  resolving per-formal order from (a) `declared_function_formals(declared_functions, …)`
  — which picks `.max_by_key(|d| d.line)` (`handlers.rs:~13892`) — then (b) the
  current file's local `name <- function(…)` defs (`local_function_defs`),
  falling back to **named-only matching** when neither is available.
- `directive_nse_policy(name, qualifier, call_line)` (`handlers.rs:13220`) is
  **position-gated**: `entries.iter().rev().find(|e| e.line < call_line && …)`.
  The latest applicable declaration before the call wins.
- `resolve_call_arg_policy` precedence (verified `handlers.rs:~14726`): (0) own
  exact unqualified directive (authoritative) → (1) local function defs →
  (1b) local non-literal aliases → (1c) own qualified directive
  (`BareInPlayQualified`) → (2–3.5) built-in/package tables → (4) resolvable
  standard-eval → (5) Shiny deferred helpers → (6) unresolved ⇒ suppress.

### 2.2 What already crosses file boundaries

`collect_in_play_packages(snapshot, uri)` (`handlers.rs:5511`) gathers the
package context across the source graph using **two separate directed passes**
(ancestors via `get_dependents`, descendants via `get_dependencies`), kept
separate so the walk cannot cross a shared child up to its *other* parents — a
deliberate conservatism for **inferred** package policy (a sibling's
`library()` should not silently change this file's verb resolution;
`handlers.rs:5537-5549`). Per-file metadata for the bounded neighborhood is in
`snapshot.metadata_map`, populated from `cached_neighborhood_subgraph`
(`handlers.rs:223-243`); that neighborhood is an **undirected** BFS over forward
*and* backward edges (`dependency.rs:1480 collect_neighborhood_multi`).

### 2.3 Revalidation gaps discovered (these block correct behavior)

Dependent files are re-diagnosed when an edited file's `interface_hash` changes
or its edges change (`compute_affected_dependents_after_edit`,
`crates/raven/src/cross_file/revalidation.rs`). `compute_interface_hash`
(`scope.rs:4162`) hashes the exported symbol interface, loaded packages,
declared symbols (**name + `is_function` + `line` only**), top-level removals,
and `data()` loads. **It does not hash `nse_declarations`, and it does not hash
a `DeclaredSymbol`'s `formals`** (verified `scope.rs:4162-4223`, `types.rs`
`DeclaredSymbol` fields `name/line/is_function/formals`).

- **Gap A:** editing a file so its only change is a `# raven: nse` directive
  (add / remove / reshape / move) does not change `interface_hash`, so connected
  files are **not** revalidated.
- **Gap B:** changing a `# raven: func name(a, b)` declaration's *formal list*
  (e.g. to `name(b, a)`) does not change `interface_hash`. After #460 a connected
  file uses those formals to decide which positional argument a per-formal
  directive suppresses, so a formal-order edit in file A must revalidate file B.

Both are closed in §6.

---

## 3. Locked design decisions

**D1 — Propagate over the revalidation-consistent set (not the package
two-pass).** Foreign NSE declarations for a queried file `Q` are collected from
`S(Q) = ancestors(Q) ∪ descendants(ancestors(Q) ∪ {Q})` (§4.1). This is exactly
the inverse of the existing `compute_affected_dependents_after_edit` relation,
so for every file `D ∈ S(Q)`, editing `D` already revalidates `Q` — **no
revalidation-traversal changes are needed**, and sibling-via-shared-parent
(`P → A`, `P → B`; declare in A, call in B) is handled because A and B share an
ancestor `P` (A ∈ descendants(P), P ∈ ancestors(B)). It also matches **scope
symbol visibility**, which already flows a sibling's exports to a later sibling
through the parent's accumulated scope. NSE is intentionally broader than
`collect_in_play_packages` here: a `# raven: nse` is an **explicit user
declaration** (coarse propagation is blessed by the issue), whereas in-play
package inference stays conservative. (OD1 records the alternative readings.)

**D2 — Foreign declarations are file-level; own declarations keep position
semantics.** A declaration collected from another file governs the *entire*
current file regardless of line (cross-file line numbers are meaningless against
the current file's call lines; the issue permits coarse, file-level
propagation). A declaration physically in the current file keeps the existing
position-gated, latest-wins behavior.

**D3 — Precedence: own beats foreign; foreign sits below local definitions and
below built-in tables.** At a call site: own exact directive (authoritative,
position-gated) → local function definitions → local aliases → own qualified
directive → built-in/package tables → **foreign directives (file-level)** →
resolvable-standard-eval classification → … (full ladder in §4.3). Placing
foreign *below* local definitions prevents a connected file's `# raven: nse f`
from suppressing a locally-defined standard-eval `f` (review finding #4).
Placing it *below* built-in tables (OD5 resolved) preserves the precise,
verified data-mask policies for known verbs (e.g. `dplyr::filter`) while still
letting a directive override the step-4 *resolvable-standard-eval* classification
— which is exactly what the issue's examples require, since `lmer` is a
loaded-package export that resolves to `Standard` at step 4
(`handlers.rs:14814-14822`) and must be suppressible by a propagated directive.

**D4 — Determinism.** Each foreign file's declarations are first collapsed by
the within-file latest-wins rule (highest line per `callee+qualifier` wins,
§4.4); across files, conflicts resolve by lexicographically smallest origin URI.
Foreign formal-order lookup is likewise deterministic and never compares raw
line numbers across files (§4.5).

**D5 — Propagate resolution context via the same set.**
  - `in_play_packages` is already cross-file (`collect_in_play_packages`) — no
    change. (Note: its set is the narrower two-pass set, so a foreign
    `pkg::name` directive's *bare-call* match via `BareInPlayQualified` only
    fires when `pkg` is in play through that narrower set; acceptable coarseness,
    see Risks.)
  - `# raven: func` declarations become cross-file: a separate `foreign_funcs`
    list feeds formal-order resolution as a fallback after own context (§4.5).
  - Local `name <- function(…)` definitions in *other* files are **not**
    propagated for formal order (Limitation L1); resolution falls back to the
    existing safe **named-only matching** (positionals not suppressed).

**D6 — Order-independence of context is already satisfied within a file.**
`NseAnalysis::build` resolves `in_play_packages`, `declared_functions`
(`declared_function_formals`), and `local_function_defs` from file-/set-level
collections that are **not** gated on the directive's line (verified
`handlers.rs:5711-5727`, `12947-13003`, `~13892`). So whether the `library()`,
function definition, or `# raven: func` appears before or after the
`# raven: nse` directive already does not matter **within a file**. The only new
ordering logic is cross-file `# raven: func` conflict resolution (§4.5); §4.1
extends the *sets* across the graph without adding within-file ordering logic.

**D7 — No new path-resolution behavior.** Propagation reuses the dependency
graph, whose edges already encode correct path semantics (forward directives +
AST `source()` get workspace-root fallback and respect `# raven: cd`; backward
directives do not gain fallback). NSE propagation traverses *edges* and never
resolves paths itself, so all path invariants are inherited unchanged. Backward
edges participate (they are ordinary edges), which is what makes the
"descendant declares, ancestor calls" direction work when expressed via
`# raven: sourced-by`.

**D8 — Scope is call-argument NSE only.** `# raven: nse` governs the call-arg
suppression path (`undefined_variable_in_call_arguments`). Bracket-index
behavior is unchanged.

---

## 4. Mechanics

### 4.1 Collecting foreign facts — the set `S(Q)`

```
g              = snapshot.cross_file_graph   // the TRIMMED neighborhood subgraph
ancestors      = g.get_transitive_dependents(Q, max_depth, max_visited)
roots          = ancestors ∪ {Q}
descendants    = g.get_transitive_dependencies_multi_root(roots, max_depth, max_visited)
S(Q)           = (ancestors ∪ descendants) \ {Q}
```

Both helpers already exist (`dependency.rs:1163`, `:1258`) and are the same ones
`compute_affected_dependents_after_edit` uses, so `S(Q)` is the directed inverse
of the revalidation relation: for any `D ∈ S(Q)`, editing `D` revalidates `Q`.

**Why compute over the trimmed subgraph, not the full graph
(codex round 2 fix):** `snapshot.metadata_map` holds the *undirected* bounded
neighborhood (`cached_neighborhood_subgraph`, `handlers.rs:223`), which can be
narrower than a directed `S(Q)` computed on the full graph — a deep up-then-down
chain could name a file the snapshot never precollected, leaving its metadata
unreadable. Computing `S(Q)` over `snapshot.cross_file_graph` (the trimmed
neighborhood subgraph, `handlers.rs:110-113`) restricts `S(Q)` to nodes that are
provably present in `metadata_map`, so every collected member is readable and
no full-graph traversal or snapshot-precollection change is needed.

**Bound (OD4).** Propagation is therefore limited to `max_chain_depth` (default
**20**) undirected hops. Every required behavior (B1–B4b) is within undirected
distance 2, so the bound never bites for them. A directive on an `S(Q)` member
beyond the neighborhood bound (a source chain deeper than 20 hops in an
up-then-down shape) silently does not propagate — a *bounded missed
suppression* (the real diagnostic still shows), never a wrong suppression, and
identical in spirit to the existing scope/in-play depth bounds.

For each `uri ∈ S(Q)`, read `snapshot.metadata_map.get(uri)`. Collect, into
deterministic (sorted-URI) order:

- `foreign_nse: Vec<(Url, NseDeclaration)>` — every member's
  `metadata.nse_declarations`.
- `foreign_funcs: Vec<(Url, DeclaredSymbol)>` — every member's
  `metadata.declared_functions` (for cross-file formal order).

No new locking: all inputs (`metadata_map`, `cross_file_graph`) already live on
`DiagnosticsSnapshot`, snapshotted under the read lock then iterated lock-free
(CLAUDE.md locking invariant).

### 4.2 Threading into `NseAnalysis::build`

`build` gains two parameters: `foreign_nse_declarations` and `foreign_funcs`.
The existing `nse_declarations` / `declared_functions` parameters remain the
**own** (current-file) data. Foreign NSE declarations translate into
`DirectiveNsePolicy` entries flagged `file_level: true`; the existing own
entries stay `file_level: false`. The call at `handlers.rs:5712` passes the
foreign data from §4.1.

### 4.3 Resolution precedence ladder (`resolve_call_arg_policy`)

Bare-identifier callee branch (`handlers.rs:14752-14839`):

```
0.  own exact unqualified directive       (position-gated, latest-wins)   [unchanged]
1.  local function definitions             (current file)                  [unchanged]
1b. local non-literal aliases                                              [unchanged]
1c. own qualified directive                (BareInPlayQualified, gated)    [unchanged]
2.  built-in / package tables              (table_verb_policy)             [unchanged]
3.6 FOREIGN directives (file-level):       exact-unqualified, then
    qualified-when-in-play                 (deterministic, §4.4)           [NEW]
4.  resolvable standard-eval               (builtin/base/loaded export)    [unchanged]
5.  Shiny deferred helper                                                  [unchanged]
6.  unresolved ⇒ suppress (WholeCall)                                      [unchanged]
```

Namespace-qualified callee branch (`handlers.rs:14737-14750`), foreign inserted
to keep the same below-tables ordering for `pkg::name` calls:

```
own qualified directive  →  table_verb_policy  →  FOREIGN qualified directive [NEW]  →  Standard
```

`directive_nse_policy` splits into:
- `own_directive_nse_policy(name, qualifier, call_line)` — own entries only;
  identical to today (`rev().find(line < call_line && qualifier_matches)`).
- `foreign_directive_nse_policy(name, call_qualifier_info)` — file-level entries
  only; tries exact-unqualified, then qualified-when-`pkg`-in-play; no line gate.

Putting foreign at tier 3.6 (below local defs/aliases/own-qualified **and** below
built-in tables, above the step-4 resolvable-standard-eval classification) keeps
every own resolution and every precise built-in policy authoritative, prevents
foreign override of a local standard-eval definition, and still lets a connected
file's directive govern a callee that resolves to standard-eval at step 4 — the
issue's examples (`lmer` is a loaded-package export resolved at step 4). Because
`lmer` has no built-in table policy, tier 2 returns `None` and tier 3.6 fires.

### 4.4 Foreign NSE collapse + conflict order

For each foreign file independently, reduce its declarations to **one per
`(callee, qualifier)`** using the within-file latest-wins rule (the
highest-line declaration wins, i.e. the file's final NSE intent — there is no
call line in a foreign file, so "latest" = last). This honors the same
latest-wins semantics the own file uses (review finding #2). Across files, when
two members declare conflicting shapes for the same `(callee, qualifier)`, the
lexicographically smallest origin URI wins (deterministic; OD3).

### 4.5 Formal-order resolution (own-first, deterministic foreign fallback)

For both own and foreign per-formal directives, resolve the callee's formal
order — the order is **call-site-relative**, so the current file's signature
info is most authoritative:

```
own  `# raven: func`        (declared_function_formals over OWN funcs; max-line within own file)
  else own local `name <- function(...)`   (bare names only; skip if FormalOrderTracker ambiguous)
  else foreign `# raven: func`  (deterministic: smallest origin URI; within that file, max-line)
  else named-only matching      (positionals NOT suppressed)
```

This preserves existing within-file behavior and adds foreign `# raven: func`
strictly as a fallback, so a foreign func declaration can never out-vote the
current file's own signature and raw cross-file line numbers are never compared
(review findings #3, #7).

### 4.6 `FormalOrderTracker` enablement

Currently `enabled = call_args_enabled && !nse_declarations.is_empty()`
(`handlers.rs:12968`). Widen to
`call_args_enabled && (!own_nse.is_empty() || !foreign_nse.is_empty())`, because
a foreign per-formal directive may borrow the current file's local definition
for formal order (§4.5) and must still see ambiguous local redefinitions
(review finding #6). Update its doc comment accordingly.

### 4.7 Hint / quick-fix governance

Two governance touch points must agree so the inline hint and the lightbulb
quick-fix stay in lockstep (they already do for own directives):

- **Hint** — `nse_hint_for_usage` (`handlers.rs:14553`) → `nse_directive_governs`
  (`handlers.rs:14497`) over `analysis.directive_nse`.
- **Code action** — the backend quick-fix (`backend.rs:~5734`) currently calls
  `nse_directive_governs` over only the *current file's*
  `state.get_enriched_metadata(uri).nse_declarations` (review finding #7).

Extend `nse_directive_governs` to treat `file_level` foreign entries as
governing **regardless of line** (package-exact still), so the hint steps aside
when a connected file already declares NSE for the callee — instead of relying
on a fabricated line passing/failing the `< call_line` gate. For the code-action,
feed it the **foreign** governing set too: the backend has graph + metadata
access, so it computes the same `S(uri)` foreign declarations (§4.1) and passes
own+foreign entries to the shared check. If that proves too costly on the
code-action path, the documented fallback is a *harmless* redundant suggestion
(re-declaring `# raven: nse` locally is valid, never conflicting). Either way the
quick-fix still inserts a *local* directive. The existing "omit
`BareInPlayQualified`, err toward showing the hint" safety note still holds.

---

## 5. Behavior matrix (maps to issue's required tests)

| # | Scenario | Graph | Expected | Issue test |
|---|----------|-------|----------|-----------|
| B1 | Ancestor declares, descendant calls | `child → parent`; `# raven: nse: lmer` in parent; `lmer(undef)` in child | suppressed in child | parent/setup declares, child suppressed |
| B2 | Descendant declares, ancestor calls | `parent → child`; `# raven: nse: lmer` in child; `lmer(undef)` in parent | suppressed in parent | child declares, parent suppressed |
| B3 | Transitive (≥ 2 edges) | `A → B → C`; directive in A, call in C **and** directive in C, call in A | suppressed both directions | ≥ two source edges |
| B4 | Shared sourced helper | `A → H`, `B → H`; `# raven: nse` in H | suppressed in A and B | user story 3 |
| B4b | Sibling via shared parent | `P → A`, `P → B`; directive in A, call in B | suppressed in B (A ∈ descendants(P), P ∈ ancestors(B)) | "reachability through the source graph"; common setup-sibling pattern |
| B5 | Unconnected files | no path | **not** suppressed; real diagnostic reported | negative test |
| B6 | Per-formal after propagation | foreign `# raven: nse f(x)` + `# raven: func f(x, y)` (may be in different connected files); call `f(undef_x, undef_y)` | only `x`-bound arg suppressed; `y`-bound arg still reported | per-formal policy-shape test |
| B7a | Ordering **within a file** | `library()` / local `function` def / `# raven: func` before *or* after the `# raven: nse` directive | directive governs regardless | ordering tests (within-file def + lib + func) |
| B7b | Ordering **across files** | the relevant `library()` or `# raven: func` lives in a connected file, declared before/after the `nse` directive's file in the chain | directive governs regardless | ordering tests (cross-file lib + func; cross-file real `function` def is L1) |
| B8 | Revalidation on connected edit | connected file's `# raven: nse` or `# raven: func` formals added/removed/changed | dependent file's diagnostics update | revalidation test |

### 6. Revalidation changes (close Gaps A and B)

In `compute_interface_hash` (`scope.rs:4162`):

1. **Add `nse_declarations` to the hash.** New parameter; hash each
   declaration's `name`, `package`, `scope` (the `NseScope` discriminant and, for
   `Formals`, the ordered formal names), **and `line`**. Line is included
   (OD2 **resolved**): under file-level collapse the highest-line declaration per
   callee wins (§4.4), so a pure line-move that changes which declaration is
   "last" must invalidate dependents — a set-only hash would miss it
   (review finding #9). Sort declarations by `(name, package, line, scope)` for
   deterministic hashing.
2. **Add `formals` to the declared-symbol hashing.** In the existing loop
   (`scope.rs:4194-4198`), also hash `decl.formals` (closes Gap B).

Call sites: `compute_artifacts` (no metadata) passes `&[]`;
`compute_artifacts_with_metadata` passes `&meta.nse_declarations`.

Edge-set changes already trigger dependent revalidation via `edges_changed`, so
reachability changes are covered without new work.

---

## 7. Files to change

- `crates/raven/src/handlers.rs`
  - New foreign-NSE/func collector computing `S(Q)` (§4.1).
  - `NseAnalysis::build` — `foreign_nse_declarations` + `foreign_funcs` params;
    `DirectiveNsePolicy.file_level`; split own/foreign policy lookups; foreign
    tier 1d in `resolve_call_arg_policy`; own-first formal-order helper (§4.5);
    `FormalOrderTracker` enablement (§4.6); updated call at `handlers.rs:5712`.
  - `nse_directive_governs` / `nse_hint_for_usage` — file-level foreign handling
    (§4.7).
  - Unit/integration tests for B1–B8.
- `crates/raven/src/backend.rs`
  - Code-action quick-fix governance (`backend.rs:~5734`) — pass own+foreign
    governing entries to the shared `nse_directive_governs` so the lightbulb
    stays in lockstep with the foreign-aware hint (§4.7). Acceptable documented
    fallback: harmless redundant local suggestion if foreign set is not threaded.
- `crates/raven/src/cross_file/scope.rs`
  - `compute_interface_hash` — add `nse_declarations` param (incl. line) + hash
    `formals`; update both call sites; hash-change unit tests (Gaps A and B).
- `docs/cross-file.md`, `docs/directives.md`, `docs/diagnostics.md` — document
  that `# raven: nse` propagates through source graphs and that cross-file
  propagation is intentionally coarse/file-level (issue requires this).
- `CLAUDE.md` "Key invariants" — optional one-line note that NSE directives
  propagate over the revalidation-consistent source-graph set.

No new LSP settings, no syntax changes, no built-in policy-table changes.

---

## 8. Out of scope / limitations

- **L1 — Cross-file local-definition formal order.** A per-formal directive
  whose function signature exists only as a real `function(…)` definition in a
  *different* file resolves via named-only matching (positionals not suppressed).
  Supply `# raven: func` for cross-file positional matching. Documented; B7b
  tests cross-file `# raven: func` (not cross-file real defs), removing the v1
  B7 contradiction.
- Diagnostic hint / quick-fix wording stays file-local (suggests adding
  `# raven: nse`; adding it in any connected file now also works). No behavior
  change beyond §4.7 governance.
- Built-in/package NSE policy tables, `# raven: nse` syntax, and treating
  `# raven: run`/`# raven: include` as execution-time `source()` equivalents are
  unchanged (issue Out of Scope).

---

## 9. Open decisions for adversarial review (round 2)

- **OD1 — propagation breadth.** This spec uses `S(Q)` (revalidation-consistent:
  ancestors + descendants-of-ancestors-and-self). Narrower (package two-pass)
  fails sibling-via-shared-parent; broader (full undirected neighborhood) would
  collect a co-parent's directive that revalidation does **not** cover (stale).
  `S(Q)` is the unique choice consistent with existing revalidation. Confirm this
  reading of "siblings through shared sourced files."
- **OD3 — foreign conflict order.** Conflicting shapes for the same callee across
  connected files resolve by smallest origin URI (after per-file latest-wins
  collapse). Acceptable, or prefer most/least suppressive?
- **OD4 — bounds (resolved: accept).** `S(Q)` is computed over the trimmed
  neighborhood subgraph, bounded by `max_chain_depth` (default 20). Required
  behaviors are within distance 2, so the bound is academic; deep up-then-down
  chains past the bound yield a bounded *missed* suppression (never wrong),
  matching package/scope behavior.
- **OD5 — foreign vs. built-in tables (resolved: below tables).** Foreign
  directives sit at tier 3.6 (below built-in tables, above step-4
  resolvable-standard-eval), so precise built-in policies (e.g. `dplyr::filter`)
  are preserved and a coarse foreign whole-call cannot clobber them, while a
  directive can still suppress a step-4-resolvable export like `lmer` (the
  issue's examples). This is the unique placement that satisfies the issue
  without over-suppressing known verbs.

---

## 10. Risks

- **Performance:** one extra directed traversal (one `get_transitive_dependents`
  + one multi-root `get_transitive_dependencies`) per diagnostic pass, over the
  already-snapshotted graph, bounded by existing limits. No new locking.
- **Over-suppression:** foreign whole-call directives are file-level, so a
  connected file's broad `# raven: nse f` suppresses all args of every `f` call
  in `Q`. Intended coarse behavior; user story 5 (real undefined vars *outside*
  NSE-captured args keep reporting) is preserved because suppression stays scoped
  to the named callee's arguments — never the whole file — foreign sits below
  local definitions (so a local standard-eval `f` is never wrongly suppressed)
  **and** below built-in tables (so a known verb keeps its precise per-arg policy
  instead of being coarsely whole-call-suppressed).
- **`in_play` asymmetry:** the bare-call match of a foreign `pkg::name` directive
  depends on `pkg` being in the (narrower) in-play set; a directive sourced only
  from a sibling whose `library()` is not in-play won't match bare calls. Rare;
  documented; the directive still matches `pkg::name` calls.
- **Revalidation churn:** adding `nse_declarations` (incl. line) and `formals` to
  `interface_hash` slightly widens dependent invalidation. Correct and necessary;
  directive/formal edits are rare.
