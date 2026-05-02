# Implementation Plan: Go-to-Definition for the RHS of `$` and `@`

Date: 2026-05-02
Spec: `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`

This is a step-by-step plan for the spec. Each step is small enough to verify
in isolation. Tests are written alongside the code that introduces each piece.

## Step 0 — Confirm AST shapes

Already verified during spec review (no code changes):

- `extract_operator` exposes its RHS via `child_by_field_name("rhs")`
  (`handlers.rs:5118`).
- `argument` exposes its name identifier via `child_by_field_name("name")`
  (`handlers.rs:5085`).
- `WorldState::get_document` and `WorldState::workspace_index` (a
  `HashMap<Url, Document>`) provide the trees needed for cross-file lookup
  (`state.rs:863`, `state.rs:551`).

## Step 1 — Shared helper: `extract_operator_rhs`

Goal: a single AST-shape predicate consumed by both
`is_structural_non_reference` and the new resolver, so the "RHS of `$`/`@`"
classification cannot drift.

- Add `pub(crate) fn extract_operator_rhs(node: Node) -> Option<(Node, ExtractOp)>`
  to a small new module `crates/raven/src/extract_op.rs`.
  - Returns `Some((lhs_node, op))` only when `node.kind() == "identifier"`,
    its parent is `extract_operator`, and the parent's `rhs` field equals
    `node`. Otherwise `None`.
  - `pub(crate) enum ExtractOp { Dollar, At }` is determined by the operator
    text in the parent's children (`$` → `Dollar`, `@` → `At`).
- Declare the module in BOTH `lib.rs` and `main.rs` per the CLAUDE.md
  invariant.
- Refactor the relevant block in `is_structural_non_reference`
  (`handlers.rs:5116-5123`) to call `extract_operator_rhs(node).is_some()`.
- Run `cargo test -p raven` — no behavior change expected.

## Step 2 — New module skeleton: `qualified_resolve.rs`

Goal: stand up the file with an empty resolver that always returns `None`,
wire it into `lib.rs` / `main.rs`, and confirm nothing breaks.

- Create `crates/raven/src/qualified_resolve.rs`:
  ```rust
  use crate::extract_op::ExtractOp;
  use crate::state::WorldState;
  use tower_lsp::lsp_types::{Location, Position, Url};
  use tree_sitter::Node;

  pub fn resolve_qualified_member(
      _state: &WorldState,
      _uri: &Url,
      _position: Position,
      _lhs_node: Node,
      _rhs_name: &str,
      _op: ExtractOp,
  ) -> Option<Location> {
      None
  }
  ```
- Declare in both `lib.rs` and `main.rs`.
- `cargo build -p raven` and `cargo test -p raven` — must remain green.

## Step 3 — Dispatcher in `goto_definition`

Goal: route `$`/`@` RHS through the new resolver, with no fallback to the
free-identifier path.

- In `handlers.rs::goto_definition`, immediately after the `node.kind() != "identifier"` early-return (~line 10704), add:
  ```rust
  if let Some((lhs_node, op)) = crate::extract_op::extract_operator_rhs(node) {
      let name = node_text(node, &text);
      return crate::qualified_resolve::resolve_qualified_member(
          state, uri, position, lhs_node, name, op,
      ).map(GotoDefinitionResponse::Scalar);
  }
  ```
- This unconditionally returns from `goto_definition` for the `$`/`@` RHS case,
  honoring spec point "No fallback to free-identifier lookup".

### Test 3a — regression test

Add a test mirroring the user-reported scenario:

```r
bar <- bleep
bloop <- foo$bar
```

Cmd-click on `bar` in line 2 → returns `None`. (Resolver still returns `None`
at this step; the test pins the no-fallback contract.)

## Step 4 — LHS shape gate

Goal: when LHS is not a bare identifier, return `None`.

- In `resolve_qualified_member`:
  ```rust
  if lhs_node.kind() != "identifier" {
      return None;
  }
  let lhs_name = node_text_owned(lhs_node, &cursor_text);
  ```
- Add tests that `(foo)$bar`, `pkg::obj$bar`, and `make()$bar` all return
  `None` (Required test #11).

## Step 5 — Resolve the LHS via existing scope

Goal: find the symbol record for `foo` from where the cursor sits, using the
already-existing position-aware machinery.

- Reuse `get_cross_file_scope(state, uri, position.line, position.character, &DiagCancelToken::never())`.
- Look up `lhs_name` in `scope.symbols`. If absent → `None`.
- If `symbol.source_uri` starts with `package:` → `None`.
- Capture `defining_uri = symbol.source_uri.clone()` and the symbol's
  `defined_line`, `defined_column`.

## Step 6 — Fetch the defining file's tree

Goal: get a `Tree` and `text` for the defining file, identical to the pattern
`goto_definition` already uses for the cursor's file.

- ```rust
  let defining_doc = state.get_document(&defining_uri)
      .or_else(|| state.workspace_index.get(&defining_uri))?;
  let defining_tree = defining_doc.tree.as_ref()?;
  let defining_text = defining_doc.text();
  ```
- If either fetch fails → `None`.

## Step 7 — Member-assignment candidates

Goal: collect all `foo$bar <- …` and `foo@bar <- …` (matching `op` and
`lhs_name`/`rhs_name`) in the defining file.

- Walk `defining_tree.root_node()` recursively, looking for `binary_operator`
  nodes whose:
  - Operator child text is one of `<-`, `=`, `<<-` (left-assignment), OR `->`
    / `->>` (right-assignment, with target on the *third* child).
  - The assignment **target** is an `extract_operator` whose:
    - `lhs` is an identifier with text `lhs_name`.
    - `rhs` is an identifier with text `rhs_name`.
    - operator (Dollar/At) matches `op`.
- For each match, record:
  - `effect_position`: the (end_line, end_column) of the *full assignment*
    `binary_operator` node — mirrors `assignment_visible_from_position` in
    `cross_file/scope.rs` (~2569-2596).
  - `name_range`: the range of the `rhs` identifier (this is the returned
    `Location`'s range, so the editor highlight lands on `bar`).

This is implemented in a small private helper:

```rust
fn collect_member_assignments(
    tree: &tree_sitter::Tree,
    text: &str,
    lhs_name: &str,
    rhs_name: &str,
    op: ExtractOp,
) -> Vec<Candidate>;
```

## Step 8 — Constructor-literal candidate

Goal: if `foo`'s defining assignment's RHS is a call to one of the allowlisted
constructors, look for a named argument matching `rhs_name`.

- Allowlist (compile-time `&[&str]`):
  ```rust
  const CONSTRUCTOR_ALLOWLIST: &[&str] = &[
      "list", "c", "data.frame", "tibble", "data.table",
      "environment", "list2env", "new",
  ];
  ```
- Locate `foo`'s defining assignment by walking from `(defined_line,
  defined_column)` in `defining_tree` up to a `binary_operator` whose target
  is the `foo` identifier and operator is `<-`/`=`/`<<-`/`->`/`->>`.
  - If we cannot find this (defensive), skip — no constructor candidate.
- Look at the assignment's RHS:
  - If it is a `call` whose `function` field is a *bare identifier* in
    `CONSTRUCTOR_ALLOWLIST`, walk its `arguments`:
    - For each `argument` whose `child_by_field_name("name")` is an identifier
      with text `rhs_name`, record a candidate:
      - `effect_position`: end of the *outer* assignment (so the binding is
        not visible inside its own RHS, matching member-assignment semantics).
      - `name_range`: the range of that name identifier.
  - Namespace-qualified calls (`base::list(...)`) are out of scope for Step 1
    (LHS-shape rule analog: the function expression must be a bare
    identifier).

## Step 9 — Position-aware tie-breaking

Goal: pick the winning candidate.

- All candidates from Step 7 + Step 8 go into a single `Vec<Candidate>`.
- Determine the cursor's effect cutoff:
  - If `uri == defining_uri`: cutoff = `(position.line, position.character)`,
    keep candidates with `effect_position <= cutoff`.
  - Else: keep all candidates (cursor-relative filtering doesn't apply
    cross-file).
- If the kept set is empty → `None`.
- Otherwise return the candidate with the maximum `effect_position`. Wrap its
  `name_range` in a `Location { uri: defining_uri, range: name_range }`.

## Step 10 — Tests

Implement all 12 required cases from the spec, in a new module file
`crates/raven/src/qualified_resolve_tests.rs` (or inline `#[cfg(test)]` if
that fits the existing pattern better — choice made at implementation time
based on what matches surrounding tests in `handlers.rs`).

| # | Scenario                                                      | Expected           |
|---|---------------------------------------------------------------|--------------------|
| 1 | `foo <- list(bar = 1); foo$bar`                               | jumps to `bar = 1` |
| 2 | `foo$bar <- 1; foo$bar`                                       | jumps to assignment|
| 3 | literal then member-assignment, cursor after both             | member-assignment  |
| 4 | literal *after* cursor, member-assignment before cursor       | member-assignment  |
| 5 | bare `bar <- 1` only, no `foo` definition, `foo$bar`          | `None`             |
| 6 | `@` parity for cases 1, 2, 5                                  | parallel           |
| 7 | `foo$bar$baz` chained access (cursor on `baz`)                | `None`             |
| 8 | cross-file: `foo` and `foo$bar <- …` in `helpers.R`           | jumps to helpers.R |
| 9 | cross-file negative: unrelated `other$bar <- …` elsewhere     | `None`             |
| 10| `foo` is `package:…` export                                   | `None`             |
| 11| `(foo)$bar`, `pkg::obj$bar`, `make()$bar`                     | `None`             |
| 12| literal + later member-assignment, cursor *between* them      | jumps to literal   |

For cross-file cases, use the existing test fixture / `WorldState` setup
patterns already used by `test_goto_definition_*` tests in `handlers.rs`.

## Step 11 — Verification

- `cargo build -p raven`
- `cargo test -p raven`
- `cargo test -p raven qualified` (focused run)
- Spot-check that the existing `goto_definition` test suite still passes
  (no regressions in the free-identifier path).

## Step 12 — Documentation touch-ups

- `docs/cross-file.md`: add a short subsection noting that `$`/`@` RHS
  go-to-def is now resolved against the LHS object's defining scope, with
  the constructor allowlist and the position-aware tie-breaking rule.
- No CLAUDE.md changes needed (this is consistent with the existing
  "structural identifier" invariant; the new resolver does not introduce a
  new invariant).

## Build sequence summary

1. `extract_op.rs` + helper extraction (Step 1).
2. `qualified_resolve.rs` skeleton (Step 2).
3. Dispatcher branch in `goto_definition` + regression test (Step 3).
4. LHS-shape gate + tests (Step 4).
5. LHS resolution + package-export early return (Step 5).
6. Defining-file tree fetch (Step 6).
7. Member-assignment collector + tests (Step 7).
8. Constructor-literal collector + tests (Step 8).
9. Tie-breaking + remaining tests (Step 9–10).
10. Verification + docs (Step 11–12).

Each step ends with a green build and tests. If a step's tests fail, fix
before advancing — do not stack steps.

## Out of scope (per spec)

Documented in the spec under "Goal" and "Risk & rollback"; not repeated here.
