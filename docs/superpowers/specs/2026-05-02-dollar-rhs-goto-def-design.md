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
   `foo`, drawn only from `foo`'s scope chain (the file where `foo` is defined,
   plus whatever files that scope already pulls in via the cross-file scope
   resolver). Two candidate kinds:
   - **Member-assignment** — any `foo$bar <- …` (or `foo@bar <- …`) statement.
   - **Constructor-literal** — when `foo`'s defining assignment's RHS is a
     call to an allowlisted constructor, find the named argument whose name
     is `bar`.
3. **Pick a winner**: position-aware single result.
   - If the cursor's file is the same as `foo`'s defining file: the latest
     candidate whose effect position is `<=` the cursor.
   - If different files: the latest candidate in `foo`'s defining file.
   - This mirrors how the position-aware scope resolver decides among
     redefinitions of plain identifiers.
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

Per the design decision (option C from brainstorming), the candidate search
runs in `foo`'s defining scope — not the cursor's file:

- **Member-assignments**: walk the AST of `foo`'s defining file and collect
  `foo$bar <- …` (and `foo@bar <- …`) nodes. The tree is obtained via
  `parameter_resolver::get_text_and_tree` (see "Where the defining file's AST
  comes from" above), since `ScopeArtifacts` does not carry it.
- **Constructor-literals**: only the single assignment that defined `foo`
  matters. We already have its line/column from the resolved symbol; re-fetch
  its RHS in the defining file's tree, then look for an `argument` node whose
  `child_by_field_name("name")` matches `rhs_name`. This is the same field
  shape `is_structural_non_reference` already uses (`handlers.rs:5083-5089`).

This avoids the false-positive risk where an unrelated `other_foo$bar <- …` in
a random file would match.

**Limitation acknowledged**: forward-source merging (where another file
sourced *after* `foo`'s defining file mutates `foo`) is not searched in
Step 1. The full scope-resolution machinery does merge parent and forward
contributions (`cross_file/scope.rs` `parent_prefix_at` ~3053-3245, forward
source merge ~3592-3773); applying that merge model to qualified-member
candidates is in scope for a follow-up. For Step 1 we only walk the defining
file's own AST. This is a deliberate trade-off: covers the common case at
modest implementation cost, with no incorrect *positive* results — only
missed targets.

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

- Cursor in `foo`'s defining file → candidate with the latest effect position
  that is `<= (cursor_line, cursor_col)`. (Equality is fine: by construction
  every effect position lies on a syntactically-prior statement.)
- Cursor in a different file → candidate with the latest effect position in
  the defining file. Cursor-relative filtering does not apply across files.

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

## Risk & rollback

- **Users who relied on the wrong jump** lose it. This is the exact bug the user
  reported; release-notes mention is sufficient.
- **Same-named member in an unrelated `foo`** cannot leak in: candidates are
  collected only from `foo`'s defining scope.
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
