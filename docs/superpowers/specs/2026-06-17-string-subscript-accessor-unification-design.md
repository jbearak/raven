# Unify `x[["name"]]` string-subscript accessor with `` x$`name` `` for navigation (#461)

## Problem

Non-syntactic (backtick-quoted) names are unified across go-to-definition,
hover, find-references, and diagnostics for variables, functions, and the
`$`/`@` accessor form. The **string-subscript accessor form `x[["name"]]`** is
not. Given:

```r
fruit <- list(`macintosh apple` = 1)   # (0) construction site
fruit$`macintosh apple`                 # (1) $-backtick member access
fruit[["macintosh apple"]]              # (2) [[ string-subscript access
```

- From (1): go-to-definition jumps to (0); find-references unions (0) and (1). ✅
- From (2): go-to-definition returns `None`; find-references returns `[]`. ⚠️

This is the exact accessor case where non-syntactic names show up in real code
(`` df$`weird col` `` vs `df[["weird col"]]`), so the asymmetry is surprising.

The resolution machinery *already* treats a `[["lit"]]` subscript as
`$`-equivalent when it appears as an **intermediate** step in a chain
(`fruit[["a"]]$b`) — see `Segment` / `build_qualified_path` in
`qualified_resolve.rs`. The gap is purely at the **terminal cursor entry
points**: when the cursor lands on the `[["name"]]` string itself, the node is a
`string`, not an `identifier`, so none of the three entry points (goto, hover,
find-references) recognize it as a member accessor.

## Decision

Issue #461 deferred whether to unify or merely document. Decision: **unify**
go-to-definition, hover, and find-references for the literal-string `[[`
subscript form, **and** document the new behavior plus its boundaries.

## Core idea

A literal-string `[[` subscript is semantically `$`-equivalent for static member
resolution. Rather than add a parallel resolution path, **synthesize the
equivalent `$`-member query** at each cursor entry point:

- Extract the literal string value `V` from the `[[` subscript.
- Compute the equivalent member *spelling* via
  `directive::callee_name_for_match(V)` — which backtick-wraps a non-syntactic
  name (`macintosh apple` → `` `macintosh apple` ``) and leaves a syntactic name
  bare (`col` → `col`).
- Feed that spelling into the existing `$`-member code path unchanged.

Because `callee_name_for_match(V)` reproduces exactly the canonical spelling the
`$`-rhs identifier node carries, a `[["name"]]` query becomes **identical to the
corresponding `` $`name` `` cursor query** — same container path, same `rhs_name`
spelling, same `ExtractOp::Dollar`. The two *cursor* forms therefore produce
identical results: the `[[` form inherits every present and future behavior of
the `$` cursor (container path matching, cross-file candidate collection,
tie-breaking, position-awareness) **and inherits its blind spots unchanged**.

Concretely, candidate filtering in `qualified_resolve.rs` is **raw string
equality** on the member name (it is not backtick-normalized). So neither cursor
form resolves to:

- a `x[["name"]] <- …` *assignment* whose stored member name is spelling-bare
  (`"name"`) while the synthesized/typed `rhs_name` is backticked; or
- a redundantly-backticked construction `list(\`col\` = 1)` when the query
  spelling is bare `col`.

Both gaps are **pre-existing** raw-equality details that affect the `$` cursor
identically; #461 asks only that the two cursor forms behave the *same as each
other*, which the synthesized-query approach guarantees by construction. Closing
the raw-equality gaps would change `$` behavior too and is out of scope.

## Components

### 1. Shared cursor helper — `qualified_resolve.rs`

```rust
/// If `node` (a cursor target) sits on the sole literal-string subscript of a
/// `[[` (subset2) — `x[["name"]]` — return the container LHS node, the bare
/// member value, and the `string` node (for its range). `None` for `[`
/// (subset), computed/numeric subscripts (`x[[i]]`, `x[[1]]`), multi-argument
/// subscripts (`x[["a", "b"]]`), or non-simple strings (escaped/empty/
/// multiline — see `simple_string_literal_value`).
pub fn string_subscript_member_at(node, text) -> Option<StringSubscriptMember>
```

where `StringSubscriptMember { container: Node, value: String, string_node: Node }`.

Implementation:
- Ascend from `node` to the enclosing `string` node (cursor may land on the
  `string` itself or a child token); bail if none within the immediate ancestry.
- Delegate the "is this a `[[` member subscript" decision to the shared
  predicate below; `container = subset2.child_by_field_name("function")`.

**Shared strict predicate** —
`subset2_sole_string_subscript(subset2: Node, text) -> Option<(value, string_node)>`:
- `subset2.kind() == "subset2"` (`[[`), **not** `subset` (`[`).
- The `arguments` node holds **exactly one** argument, that argument is
  **positional** (no `name` field — rejecting `x[[name = "a"]]` and the
  `exact =`/multi-arg forms like `x[["a", exact = FALSE]]`), and its value is a
  `string`.
- `value = simple_string_literal_value(string_node, text)?` (reuses the existing
  escaping/empty/multiline rejection).

This single predicate is the only definition of "literal-string `[[` member
subscript" and is consumed by **all three** sites so they cannot drift:
1. `string_subscript_member_at` (terminal cursor helper, above);
2. `build_qualified_path`'s `subset2` arm — **tightened** to use it (see below);
3. the find-references per-node string matcher.

**`build_qualified_path` tightening (ISSUE 1):** today the `subset2` arm uses
`first_direct_string_argument` with no comma / sole-argument / positional check,
so an *intermediate* `x[["a", "b"]]$c` or `x[[name = "a"]]$c` is silently
mis-walked as `x$a$c`. Routing the `subset2` arm through
`subset2_sole_string_subscript` makes such malformed/multi-arg intermediates
**decline** (`None`), consistent with the strict terminal helper. This affects
the `$` and `[[` forms equally (a strict improvement). Existing accepted cases
(`alpha@beta[["gamma"]]`, single-literal subscripts) are unchanged; existing
declines (`alpha[[i]]`, `alpha[[1]]`) still decline.

### 2. Go-to-definition — `handlers.rs` (`goto_definition*`, ~20320)

Before the existing `node.kind() != "identifier"` bail, add a branch:

```rust
if let Some(m) = qualified_resolve::string_subscript_member_at(node, &text) {
    let path = qualified_resolve::build_qualified_path(m.container, &text)?;
    let rhs_name = directive::callee_name_for_match(&m.value);
    let location = resolve_qualified_member[_with_cancel](
        state, uri, position, &path, &rhs_name, ExtractOp::Dollar, [cancel]);
    return location.map(GotoDefinitionResponse::Scalar);
}
```

Mirrors the existing `extract_operator_rhs` branch exactly, substituting the
synthesized container + spelling.

### 3. Hover — `handlers.rs` (`hover*`, ~19245, "Step 4")

Add a parallel branch (outside the `node.kind() == "identifier"` gate, since the
target is a `string`) that mirrors goto's Step 4: resolve via
`string_subscript_member_at` → `resolve_qualified_member` → `member_definition_info`
→ `local_definition_hover`. Keeps hover/goto in parity (the existing invariant
that hover Step 4 reuses goto's resolver).

### 4. Find-references — `handlers.rs`

**(a) Cursor entry (`references`, ~20769):** before the
`node.kind() != "identifier"` bail, if `string_subscript_member_at` matches, set
`name = callee_name_for_match(value)` and continue into the existing search
(`find_references_in_tree`). The search machinery canonicalizes `name`, so the
synthesized backticked/bare spelling keys identically to the `$` form.

**(b) Matching (`find_references_in_subtree`):** in addition to the existing
`identifier`-node match, when a node is a `string` whose parent `subset2`
satisfies `subset2_sole_string_subscript`, compute its match key as
`canonical_use_name(&callee_name_for_match(value))` and, if it equals
`canonical_name`, push the **string node's** range. (The per-node walk reaches
the string directly, so it inspects `string.parent()` chain up to the `subset2`
rather than starting from the `subset2`; a thin wrapper over the shared predicate
covers this direction.)

`canonical_use_name(callee_name_for_match(V))` yields the same canonical key the
identifier path produces for the equivalent `$`-rhs / construction-arg spelling
(syntactic → bare `V`; non-syntactic → `` `V` ``), so all three forms collapse to
one reference set. Behavior for existing identifier matching is unchanged
(string matching is purely additive).

This makes find-references symmetric from **any** of the forms: cursor on
`` $`name` ``, `[["name"]]`, or the construction named argument unions all
identifier occurrences **and** all `[["name"]]` occurrences. It is consistent
with find-references' existing **name-based, container-agnostic** semantics
(documented in `find-references.md`): it already pools all same-named members
across containers — and across `$` *and* `@` accessors, since the matcher keys
on identifier text alone, not the operator. Adding `[[` string subscripts
extends that same name pool to the `[[` spelling (ISSUE 5: a `[["slot"]]`
reference will pool with `obj@slot` too — this is the pre-existing
operator-agnostic pooling, not a new conflation, and is documented as such).

### 5. Documentation

- `docs/go-to-definition.md` — in the `$`/`@` member section, note that a
  terminal `x[["name"]]` literal-string subscript also navigates (resolving the
  same way as `` x$`name` ``). The table already lists `[["host"]] <- …`
  assignments as member-assignment targets; add the *cursor-on-subscript* case.
- `docs/find-references.md` — note that `[["name"]]` literal-string subscripts
  are pooled with the `` $`name` `` / construction forms.
- `docs/limitations.md` — record the boundaries: only a **single positional
  literal** string `[[` subscript participates as a *cursor* entry point;
  computed/dynamic subscripts (`x[[i]]`, `x[[paste0(...)]]`), numeric indices
  (`x[[1]]`), escaped/multiline strings, named/multi-arg `[[`
  (`x[[name = "a"]]`, `x[["a", exact = FALSE]]`), and **single-bracket**
  `x["name"]` do **not** initiate navigation (and why — `[[` with a runtime
  expression is not statically a name; `[` returns a sub-container, not the
  element, so it is not `$`-equivalent).
  - ISSUE 3 precision: this is about the **cursor sitting on** `x["name"]`. It
    is distinct from the existing, unchanged behavior that a `foo["bar"] <- …`
    *assignment target* is a resolution candidate for `` foo$bar ``/
    `foo[["bar"]]` (member-assignment collection already accepts both `subset`
    and `subset2` targets). The docs must not imply single-bracket assignments
    stop being candidates.

## Testing (TDD)

Rust unit/integration tests in `handlers.rs` / `qualified_resolve.rs`:

- **Goto resolves:** cursor on `fruit[["macintosh apple"]]` → construction line
  (0); cursor on syntactic `df[["col"]]` → its constructor named arg; nested
  `a$b[["c"]]` and `a[["b"]]$c`.
- **Goto declines (None):** `x[[i]]` (computed), `x[[1]]` (numeric),
  `x["name"]` (single bracket), `f()[["x"]]` (non-static head),
  `x[["a", "b"]]` and `x[["a", exact = FALSE]]` (multi-arg),
  `x[[name = "a"]]` (named subscript), `x[["a\tb"]]` (escaped).
- **Mixed-accessor terminal `[[` (ISSUE 7):** `a@b[["c"]]` and `a[["b"]]@c`
  resolve `c` against the full mixed container path; and an intermediate
  multi-arg/named `[[` (`x[["a", "b"]]$c`, `x[[name = "a"]]$c`) now **declines**
  via the tightened `build_qualified_path`.
- **Find-references symmetry:** from each of (0)/(1)/(2), the result set unions
  all three; the pushed `[[` range covers the string node. Include a
  syntactic-name variant and a cross-file variant.
- **Find-references declines:** a plain string literal that is *not* a `[[`
  subscript (`print("macintosh apple")`) is not matched.
- **Hover parity:** hover on `fruit[["macintosh apple"]]` shows the same local
  definition hover as `` fruit$`macintosh apple` ``.
- **`string_subscript_member_at` unit tests** for each accept/reject shape.

CI gates (`cargo fmt --all --check`, `cargo clippy --workspace --all-targets
--features test-support -- -D warnings`) must stay green.

## Non-goals

- No change to diagnostics (`is_structural_non_reference` etc.): the `[[`
  string subscript is already not flagged as a free-variable reference.
- No resolution of `x[["name"]] <- …` assignments whose member name is stored
  bare; that pre-existing raw-equality detail affects `$` and `[[` equally and
  is orthogonal to making the two cursor forms symmetric.
- No unification of single-bracket `[` or non-literal `[[` subscripts.
- No support for `assign("name", …)` or replacement-function forms
  (`` `[[<-`(x, "name", …) ``) as member definition sites (ISSUE 8): the
  candidate collector only walks `<-`/`=`/`<<-`/`->`/`->>` assignments and
  constructor literals, for both `$` and `[[`. Out of scope.
