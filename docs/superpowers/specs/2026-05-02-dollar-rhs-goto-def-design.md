# Go-to-Definition for the RHS of `$` and `@` (Step 1)

Date: 2026-05-02
Status: Draft for review

## Problem

In R code like:

```r
bar <- bleep
bloop <- foo$bar
```

Cmd-clicking on `bar` in `foo$bar` currently jumps to `bar <- bleep`. This is wrong:
the `bar` in `foo$bar` is structurally a *member name of `foo`*, not a use of the
free variable `bar`. Worse, even if a more relevant target exists (e.g.
`foo$bar <- boop` somewhere else in the file or in a sibling file), the current
implementation ignores it.

The diagnostics path already treats `bar` here as structural via the
`is_structural_non_reference` predicate (`crates/raven/src/handlers.rs:35679`)
and skips it for "undefined variable" checks. Go-to-definition is therefore
inconsistent with how the rest of the LSP classifies the same token.

## Goal (Step 1 scope)

Make go-to-definition for the RHS of `$` and `@`:

1. **Stop jumping to a free identifier** that happens to share the member name.
2. **Resolve qualified members** when there is a real, scoped definition for them:
   - `foo$bar <- …` member-assignment statements.
   - Named arguments inside the *defining* assignment of `foo`, when its RHS is
     a call to one of a small allowlist of constructors
     (`list`, `c`, `data.frame`, `tibble`, `data.table`, `environment`,
     `list2env`, `new`).

The same rule applies symmetrically to `@`.

Out of scope for Step 1:

- S4 slot resolution from `setClass(representation = …)` / `slots = c(…)`.
- R6 fields/methods from `R6::R6Class(public/private = list(…))`.
- Aliasing (`foo <- bar; foo$x`).
- Function-return inference (`foo <- make_thing()`).
- Package-data introspection (`pkg::dataset$col`).
- Chained access (`foo$bar$baz` — returns `None`).
- Hover / completion / find-references for qualified members (go-to-def only).

## Behavior contract

When the cursor is on the RHS identifier `bar` of an `extract_operator` node
`foo$bar` or `foo@bar`:

1. **Resolve `foo`** using the existing position-aware scope
   (`get_cross_file_scope`). If unresolved → return `None`.
2. **Build a candidate set** of qualified definitions of `bar` against this
   `foo`, drawn from `foo`'s defining file and the resolved scope's contributor
   chain, not every non-defining file in the cursor file's cross-file connected
   component. Per-file `visible_positions` cutoffs are applied, and
   non-defining-file member assignment sites are retained only when a per-site
   `get_cross_file_scope` check resolves their LHS `foo` to the same
   `ScopedSymbol`. The contributor-chain scan yields two candidate kinds:
   - **Member-assignment** — any `foo$bar <- …` (or `foo@bar <- …`) statement.
   - **Constructor-literal** — when `foo`'s defining assignment's RHS is a
     call to an allowlisted constructor, find the named argument whose name
     is `bar`.
3. **Pick a winner**: position-aware single result.
   - If the cursor file has a visible candidate, the latest cursor-file
     candidate wins. This includes defining-file candidates when the cursor is
     in the file where `foo` is defined.
   - Otherwise, `pick_winner` ranks non-cursor candidates by shortest
     contributor-chain (forward-edge) distance from the cursor file. Within the
     winning file, it takes that file's latest-effect candidate. Contributor-chain
     rank and URI are used only to break equal-distance or unavailable-distance
     ties. This includes the defining-file candidate when appropriate and
     deliberately avoids choosing a globally latest non-cursor candidate from
     the whole connected component.
   - This mirrors the existing resolver's local-position preference and aligns
     `pick_winner` with the cursor file / defining-file behavior pinned by the
     `a.R`/`b.R` regression tests.
4. **No fallback to free-identifier lookup.** If no qualified candidate exists,
   return `None`. The whole point of this fix is that the RHS of `$`/`@` is not
   a reference to a free variable; reintroducing that lookup as a fallback would
   reintroduce the bug.

If `foo` resolves to a package export (`source_uri` starts with `package:`),
return `None`. Same convention as the existing plain-identifier path.

## Constructor allowlist

Recognized constructors (matched on the *bare* function-name identifier of the
call; no namespace-qualified forms in Step 1):

```text
list, c, data.frame, tibble, data.table, environment, list2env, new
```

Selection rationale: these are the cases where a named argument *is* the member
under R's evaluation semantics — `new()` covers S4 construction, the rest cover
list/frame construction. Dynamic constructions like `setNames(list(...), ...)`
are explicitly out of scope; they require dataflow we do not have.

A "named argument" is an `argument` AST node whose
`child_by_field_name("name")` is an identifier that matches `bar`. The
returned `Location` is the range of that name identifier. (This is the same
field-name shape that `is_structural_non_reference` already keys on at
`handlers.rs:5083-5089`.)

## LHS shape restriction

In Step 1, the resolver only fires when the LHS of the `extract_operator` is a
bare `identifier` node. All of the following return `None`:

- `(foo)$bar` — parenthesized LHS
- `pkg::obj$bar` — namespaced LHS
- `make()$bar` — call-result LHS
- `foo$bar$baz` — nested extract on the LHS (already covered by the chained-access
  rule, repeated here for clarity)

Broader LHS shapes are explicit follow-up work.

## Where the defining file's AST comes from

`ScopeArtifacts` (`cross_file/scope.rs`) does not carry AST or text — it carries
exported symbols, a timeline, an interface hash, and per-function scope trees.
The resolver therefore obtains the defining file's tree via the shared helper
`parameter_resolver::get_text_and_tree`, which already encapsulates the priority
chain (enriched/legacy open documents → workspace indexes → cross-file file
cache, parsing on demand):

```rust
let defining_uri = symbol.source_uri.clone();
let (defining_text, defining_tree) =
    crate::parameter_resolver::get_text_and_tree(state, &defining_uri)?;
```

Reusing this helper keeps the lookup path consistent with parameter resolution
and avoids reaching into `WorldState`'s document/workspace fields directly.

## Module / file layout

New file: `crates/raven/src/qualified_resolve.rs`. Public surface:

```rust
// `ExtractOp` lives in its own module (`crate::extract_op`) and is shared
// with the structural-detection helpers in `handlers.rs`.
use crate::extract_op::ExtractOp;

pub fn resolve_qualified_member(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    rhs_name: &str,
    op: ExtractOp,
) -> Option<Location>;
```

Per the CLAUDE.md invariant, the module is declared in *both*
`crates/raven/src/lib.rs` and `crates/raven/src/main.rs`.

`goto_definition` (`handlers.rs:10609`) gains a small dispatcher: if the node
under the cursor is an `identifier` whose parent is an `extract_operator` and
the node is the operator's RHS, call `resolve_qualified_member` and return its
result *unconditionally* — including `None`. No subsequent fallback to the
existing free-identifier branch.

## Detection of "RHS of extract_operator"

`is_structural_non_reference` (`handlers.rs:35679`) already encodes the
structural check. We extract a small shared helper:

```rust
fn extract_operator_rhs(node: tree_sitter::Node) -> Option<(tree_sitter::Node /* lhs */, ExtractOp)>;
```

Both `is_structural_non_reference` and the new dispatcher call this helper.
CLAUDE.md names `is_structural_non_reference` as the single source of truth for
"structural identifier; not a reference"; sharing the AST-shape check preserves
that.

## Cross-file behavior

Candidate search has two tiers:

- **Defining-file member-assignments**: walk the AST of `foo`'s defining file
  and collect `foo$bar <- …` (and `foo@bar <- …`) nodes. The tree is obtained
  via `parameter_resolver::get_text_and_tree` (see "Where the defining file's
  AST comes from" above), since `ScopeArtifacts` does not carry it. These
  candidates use same-tree function-scope and effect-position checks.
- **Contributor-chain member-assignments**: walk every non-defining file in the
  resolved scope's contributor chain. Each matching text site is filtered by
  that file's `visible_positions` cutoff and validated by re-resolving `foo` at
  the assignment's LHS position via `get_cross_file_scope`; only sites where
  `foo` resolves to the exact same `ScopedSymbol` are retained.
- **Constructor-literals**: only the single assignment that defined `foo`
  matters. We already have its line/column from the resolved symbol; re-fetch
  its RHS in the defining file's tree, then look for an `argument` node whose
  `child_by_field_name("name")` matches `rhs_name`. This is the same field
  shape `is_structural_non_reference` already uses (`handlers.rs:5083-5089`).

The per-site scope gate avoids the false-positive risk where a same-looking
`foo$bar <- …` in a random file, or inside a function that shadows `foo`, would
match the symbol the user navigated from.

## Position-aware tie-breaking

Each candidate carries an **effect position** — the position at which its
binding becomes visible — not the position of the `bar` token itself. This
mirrors `assignment_visible_from_position` in `cross_file/scope.rs`
(~2569-2596), which uses the *end* of the full assignment so that the new
binding is not visible inside its own RHS.

- **Member-assignment candidate** (`foo$bar <- expr`): effect position = end of
  the assignment statement (after `expr`).
- **Constructor-literal candidate** (`bar = …` inside `foo <- list(bar = …)`):
  effect position = end of the enclosing assignment that defines `foo`.

Selection:

- Candidates in the cursor file are filtered to effect positions
  `<= (cursor_line, cursor_col)`, then the latest cursor-file candidate wins.
  (Equality is fine: by construction every effect position lies on a
  syntactically-prior statement.)
- If no cursor-file candidate qualifies, `pick_winner` prefers the candidate
  file with the shortest contributor-chain (forward-edge) distance from the
  cursor file, then takes that file's latest-effect candidate. Contributor-chain
  rank and URI are only deterministic fallback tiebreakers. This avoids comparing
  file-local effect positions across the connected component and matches the
  defining-file / cursor file behavior covered by the `a.R`/`b.R` regression
  tests.

Returned `Location` is still the range of the `bar` *identifier token* (so the
editor highlight lands on the name); only the *ranking* uses the effect
position.

## Error handling

Pure best-effort. Any AST shape we do not recognize → `None`. The resolver does
**not** attempt to evaluate R semantics, follow aliasing, infer function
returns, or guess across dynamic constructions.

## Testing

Tests live alongside the existing `test_goto_definition_*` suite in
`handlers.rs` (or a new module file imported there, depending on what fits the
existing pattern best).

Required cases:

1. `foo <- list(bar = 1); foo$bar` → jumps to `bar = 1`.
2. `foo$bar <- 1; foo$bar` → jumps to the member-assignment.
3. Both present, member-assignment *after* literal → member-assignment wins
   (position-aware).
4. Both present, member-assignment before cursor but literal after → literal
   wins.
5. `bar <- 1; foo$bar` with no `foo` definition → returns `None` (the regression
   case the user reported).
6. `foo@bar` parity for cases 1, 2, and 5.
7. Chained `foo$bar$baz` → returns `None` (documented limitation; ensures the
   resolver does not crash or wrongly jump).
8. Cross-file: `foo` defined in `helpers.R` with `foo$bar <- …`, `foo$bar`
   referenced from `main.R` → jumps into `helpers.R`.
9. Cross-file negative: unrelated `other$bar <- …` in a sibling file does *not*
   match for `foo$bar`.
10. Package object: `foo` resolves with `source_uri` of `package:…` → returns
    `None`.
11. LHS-shape rejection: `(foo)$bar`, `pkg::obj$bar`, `make()$bar` → returns
    `None` (does not crash, does not fall through to free-identifier lookup).
12. Effect-position correctness: `foo <- list(bar = 1); use(foo$bar); foo$bar <- 2`
    with cursor on the *middle* `foo$bar` → jumps to the `bar = 1` literal,
    not the later `foo$bar <- 2` (which has an effect position after the
    cursor).
13. Three-file chain: `c.R` sources `b.R`, `b.R` sources `a.R`, `a.R` defines
    `foo`, and `b.R` attaches `foo$bar <- 1` → cursor in `c.R` jumps to `b.R`.
14. Connected-component negatives: a shadowed `foo$bar <- 99` inside an
    unrelated function in an intermediate file does not match, and a
    matching-looking assignment in a document outside the cursor file's
    connected component does not match.
15. Graph-distance tiebreak: if traversal reaches an indirect contributing file
    before a directly sourced file, the directly sourced file wins even when the
    indirect file appears earlier in the contributor chain or has a later local
    line number.

## Risk & rollback

- **Users who relied on the wrong jump** lose it. This is the exact bug the user
  reported; release-notes mention is sufficient.
- **Same-named member in an unrelated `foo`** cannot leak in: non-defining-file
  candidates are validated against the exact `foo` binding the user navigated
  from.
- **Rollback**: revert the dispatcher branch in `goto_definition`. The new
  module becomes dead code with no external callers; safe to leave or delete.

## Future work

The following are explicit deferrals, not omissions:

- S4 slot resolution via class index over `setClass` / `representation` / `slots`.
- R6 field/method resolution via class index over `R6::R6Class`.
- Aliasing & function-return inference (would benefit hover and references too).
- Package-data introspection (`pkg::dataset$col`).
- Hover, completion, and find-references for qualified members.
- Promote the dispatcher to index-time enrichment (Approach 3 from
  brainstorming) once multiple features need qualified-member resolution.
