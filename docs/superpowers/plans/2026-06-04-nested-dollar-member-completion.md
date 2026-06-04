# Nested `$`/`@`/`[[]]` Member Completion + Goto-Def Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve completion and go-to-definition for the RHS of a `$`/`@`/`[["lit"]]` chain against the full container path at arbitrary depth, with reassignment-aware (establishing-site) member sets, and eliminate the wrong-variable completion bug.

**Architecture:** Generalize the single-identifier LHS into a `QualifiedPath` (head + intermediate segments) everywhere the resolver keys on `lhs_name`. A shared left-spine walker builds the path for both surfaces. The existing position-aware/cross-file candidate machinery is reused; the three discovery collectors widen from "LHS is `head`" to "LHS spine equals a path prefix"; a new establishing-site cutoff makes a whole-value (re)write replace earlier members.

**Tech Stack:** Rust (workspace crate `raven`), tree-sitter-r, tower-lsp. Tests are `#[cfg(test)]` units in `crates/raven/src/qualified_resolve.rs` (harness: `fresh_state()`, `add_indexed_doc()`, `completion_names()`, `loc()`) plus completion/goto-def integration tests in `handlers.rs`.

**Spec:** `docs/superpowers/specs/2026-06-04-nested-dollar-member-completion-design.md`

**Reference reading before starting:**
- `crates/raven/src/qualified_resolve.rs` — module doc (lines 1-40), the collectors (121-229), the core collector (456-708), public APIs (285-453), test harness (~1430-1620).
- `crates/raven/src/extract_op.rs` — `ExtractOp`, `extract_operator_rhs`.
- `crates/raven/src/handlers.rs` — `detect_dollar_member_completion_context` (12365-12424), `dollar_member_completion_items` (12456-12500), the completion call site (12664), the goto-def call site (14848-14874).

**CI gates (run before every commit):**
```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
cargo test -p raven qualified_resolve
```

---

## File Structure

- **Modify** `crates/raven/src/extract_op.rs` — add `op_from_node` helper (maps a `$`/`@` operator node to `ExtractOp`); already has `ExtractOp` + `extract_operator_rhs`.
- **Modify** `crates/raven/src/qualified_resolve.rs` — new `Segment`/`QualifiedPath` types + `build_qualified_path` spine-walker; generalize the core collector and the three discovery collectors to a path; add the establishing-site cutoff; update public API signatures; extend the test module.
- **Modify** `crates/raven/src/handlers.rs` — rebuild `detect_dollar_member_completion_context` to seed the spine-walker from the AST; update the two resolver call sites; add integration tests.
- **Modify** `docs/completion.md`, `docs/go-to-definition.md`, the `qualified_resolve.rs` module doc, and add a forward-reference in `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`.

The whole change stays inside these files. No new modules; no changes to scope resolution, the dependency graph, or the diagnostics gate.

---

## Task 1: `QualifiedPath` / `Segment` types + the shared spine-walker

**Files:**
- Modify: `crates/raven/src/extract_op.rs`
- Modify: `crates/raven/src/qualified_resolve.rs`

- [ ] **Step 1: Add `op_from_node` to `extract_op.rs`**

Append below `extract_operator_rhs`:

```rust
/// Map a `$`/`@` operator node to [`ExtractOp`]. Returns `None` for any other
/// node kind.
pub fn op_from_node(op_node: Node) -> Option<ExtractOp> {
    match op_node.kind() {
        "$" => Some(ExtractOp::Dollar),
        "@" => Some(ExtractOp::At),
        _ => None,
    }
}
```

- [ ] **Step 2: Write the failing test for `build_qualified_path`**

In the `qualified_resolve.rs` test module (inside `mod tests`), add a parse helper if one is not already present, then the tests. Use the project's parser pool exactly as the existing tests construct trees (via `add_indexed_doc` you can get a parsed `doc.tree`; for a pure unit test of the walker, parse directly):

```rust
fn parse_r(text: &str) -> tree_sitter::Tree {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .expect("load tree-sitter-r");
    parser.parse(text, None).expect("parse")
}

/// Find the deepest `extract_operator`/`subset`/`subset2` node whose byte range
/// ends at `end_byte` (the LHS of a trailing access in these tests).
fn lhs_node_ending_at(tree: &tree_sitter::Tree, end_byte: usize) -> tree_sitter::Node<'_> {
    fn rec<'a>(n: tree_sitter::Node<'a>, end: usize, best: &mut Option<tree_sitter::Node<'a>>) {
        if n.end_byte() == end
            && matches!(n.kind(), "extract_operator" | "subset" | "subset2" | "identifier")
        {
            *best = Some(n);
        }
        let mut c = n.walk();
        for ch in n.children(&mut c) {
            rec(ch, end, best);
        }
    }
    let mut best = None;
    rec(tree.root_node(), end_byte, &mut best);
    best.expect("no lhs node ends at end_byte")
}

#[test]
fn build_path_single_identifier() {
    let text = "alpha";
    let tree = parse_r(text);
    let lhs = lhs_node_ending_at(&tree, text.len());
    let path = super::build_qualified_path(lhs, text).expect("path");
    assert_eq!(path.head, "alpha");
    assert!(path.segments.is_empty());
}

#[test]
fn build_path_two_dollar_segments() {
    let text = "alpha$beta";
    let tree = parse_r(text);
    let lhs = lhs_node_ending_at(&tree, text.len());
    let path = super::build_qualified_path(lhs, text).expect("path");
    assert_eq!(path.head, "alpha");
    assert_eq!(path.segments.len(), 1);
    assert_eq!(path.segments[0].name, "beta");
    assert_eq!(path.segments[0].op, crate::extract_op::ExtractOp::Dollar);
}

#[test]
fn build_path_mixed_dollar_at_and_subscript() {
    let text = "alpha@beta[[\"gamma\"]]";
    let tree = parse_r(text);
    let lhs = lhs_node_ending_at(&tree, text.len());
    let path = super::build_qualified_path(lhs, text).expect("path");
    assert_eq!(path.head, "alpha");
    let names: Vec<_> = path.segments.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["beta", "gamma"]);
    assert_eq!(path.segments[0].op, crate::extract_op::ExtractOp::At);
    // `[["lit"]]` is `$`-equivalent for member purposes.
    assert_eq!(path.segments[1].op, crate::extract_op::ExtractOp::Dollar);
}

#[test]
fn build_path_bails_on_non_static_segment() {
    for text in ["f()$x", "alpha[[i]]$x", "alpha[[1]]$x"] {
        let tree = parse_r(text);
        let lhs = lhs_node_ending_at(&tree, text.len());
        assert!(
            super::build_qualified_path(lhs, text).is_none(),
            "expected None for {text:?}"
        );
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail to compile (types/fn missing)**

Run: `cargo test -p raven qualified_resolve::tests::build_path 2>&1 | head -30`
Expected: compile error — `build_qualified_path`, `Segment`, `QualifiedPath` not found.

- [ ] **Step 4: Implement the types + walker**

Near the top of `qualified_resolve.rs` (after the `use` block), add:

```rust
/// One intermediate step in a `$`/`@`/`[["lit"]]` access chain. `op` is the
/// operator that produced this segment from its parent; a `[["lit"]]` subscript
/// is recorded as [`ExtractOp::Dollar`] because it is `$`-equivalent for member
/// resolution (mirrors `member_assignment_candidate_from_string_subscript`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub name: String,
    pub op: ExtractOp,
}

/// The container an `$`/`@` member is being resolved against: a head identifier
/// plus zero or more intermediate [`Segment`]s. `segments.is_empty()` is the
/// single-level (depth-1) case and reproduces the pre-Step-2 behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualifiedPath {
    pub head: String,
    pub segments: Vec<Segment>,
}

/// Walk the left-spine of an `extract_operator`/`subset`/`subset2` node into a
/// [`QualifiedPath`]. Bails to `None` on any non-static step: a computed index
/// (`alpha[[i]]`, `alpha[[1]]`), a call (`f()$x`), or a non-literal subscript.
/// The spine must bottom out at a single `identifier` (the head).
pub fn build_qualified_path(lhs: Node, text: &str) -> Option<QualifiedPath> {
    let mut rev_segments: Vec<Segment> = Vec::new();
    let mut node = lhs;
    loop {
        match node.kind() {
            "identifier" => {
                rev_segments.reverse();
                return Some(QualifiedPath {
                    head: node_text(node, text).to_string(),
                    segments: rev_segments,
                });
            }
            "extract_operator" => {
                let op = crate::extract_op::op_from_node(node.child_by_field_name("operator")?)?;
                let rhs = node.child_by_field_name("rhs")?;
                if rhs.kind() != "identifier" {
                    return None;
                }
                rev_segments.push(Segment {
                    name: node_text(rhs, text).to_string(),
                    op,
                });
                node = node.child_by_field_name("lhs")?;
            }
            "subset2" => {
                // `foo[["lit"]]` — `$`-equivalent. Reject computed/numeric indices.
                let func = node.child_by_field_name("function")?;
                let args = node.child_by_field_name("arguments")?;
                let string_node = first_direct_string_argument(args)?;
                let name = simple_string_literal_value(string_node, text)?;
                rev_segments.push(Segment {
                    name: name.to_string(),
                    op: ExtractOp::Dollar,
                });
                node = func;
            }
            _ => return None,
        }
    }
}
```

(Place it above `member_assignment_candidate_from_extract`. `first_direct_string_argument` and `simple_string_literal_value` already exist in this file.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p raven qualified_resolve::tests::build_path`
Expected: 4 tests pass.

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/extract_op.rs crates/raven/src/qualified_resolve.rs
git commit -m "feat(qualified-resolve): QualifiedPath types + shared spine-walker"
```

---

## Task 2: Thread `QualifiedPath` through the core collector and public APIs (no behavior change)

This is a pure refactor: replace the `(lhs_node_kind, lhs_name)` parameters with a `&QualifiedPath`. With empty `segments`, behavior is identical to today. The existing test suite is the safety net.

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs`
- Modify: `crates/raven/src/handlers.rs` (call sites + the goto-def path)

- [ ] **Step 1: Change the core collector signature**

`collect_qualified_member_candidates_with_cancel` (line 456): replace params `lhs_node_kind: &str, lhs_name: &str` with `path: &QualifiedPath`. Delete the early gate:

```rust
if lhs_node_kind != "identifier" || cancel.is_cancelled() {
    return None;
}
```

Replace with:

```rust
if cancel.is_cancelled() {
    return None;
}
let lhs_name = path.head.as_str();
```

Leave the rest of the body untouched for this task (the body already uses `lhs_name`). All three `collect_member_assignments(... lhs_name ...)` calls and `collect_constructor_candidate(s)(... lhs_name ...)` calls continue to compile because `lhs_name` is still in scope. (Segments are wired into discovery in Tasks 3-5.)

- [ ] **Step 2: Change the public API signatures**

`resolve_qualified_member` / `resolve_qualified_member_with_cancel` (285, 318): replace `lhs_node_kind: &str, lhs_name: &str` with `path: &QualifiedPath`, and forward `path` to the collector instead of `lhs_node_kind, lhs_name`.

`complete_qualified_members` / `complete_qualified_members_with_cancel` (355, 379): same change.

- [ ] **Step 3: Update the goto-def call site in `handlers.rs`**

At `handlers.rs:14848`, replace the body that calls `resolve_qualified_member(..., lhs_node.kind(), lhs_name, ...)` with a spine-walked path:

```rust
if let Some((lhs_node, op)) = crate::extract_op::extract_operator_rhs(node) {
    let rhs_name = node_text(node, &text);
    let Some(path) = crate::qualified_resolve::build_qualified_path(lhs_node, &text) else {
        return None;
    };
    let location = if cancel.is_never() {
        crate::qualified_resolve::resolve_qualified_member(state, uri, position, &path, rhs_name, op)
    } else {
        crate::qualified_resolve::resolve_qualified_member_with_cancel(
            state, uri, position, &path, rhs_name, op, cancel,
        )
    };
    return location.map(GotoDefinitionResponse::Scalar);
}
```

This already enables nested goto-def: for `alpha$beta$gamma`, `lhs_node` is `alpha$beta`, `build_qualified_path` yields `head=alpha, segments=[beta:$]` (previously this bailed on `lhs_node_kind != "identifier"`).

- [ ] **Step 4: Update the completion call site in `handlers.rs`**

`dollar_member_completion_items` (12456) currently calls `complete_qualified_members(..., "identifier", &context.lhs_name, Dollar)`. Change `DollarMemberCompletionContext` to carry a `QualifiedPath` + terminal `op` (full rework happens in Task 7; for now, keep `lhs_name` but build a depth-1 path inline so it compiles):

```rust
let path = crate::qualified_resolve::QualifiedPath {
    head: context.lhs_name.clone(),
    segments: Vec::new(),
};
crate::qualified_resolve::complete_qualified_members(
    state, uri, position, &path, crate::extract_op::ExtractOp::Dollar,
)
```

- [ ] **Step 5: Update the test harness**

In `qualified_resolve.rs` `completion_names` helper (1465) and the perf test (1490-1529), replace the `"identifier", lhs_name` arguments with a path:

```rust
fn completion_names(state: &WorldState, uri: &Url, position: Position, lhs_name: &str) -> Vec<String> {
    let path = super::QualifiedPath { head: lhs_name.to_string(), segments: Vec::new() };
    super::complete_qualified_members(state, uri, position, &path, crate::extract_op::ExtractOp::Dollar)
        .into_iter()
        .map(|c| c.name)
        .collect()
}
```

For the perf test's two direct `complete_qualified_members(... "identifier", "df", ...)` calls, build `let df_path = super::QualifiedPath { head: "df".into(), segments: Vec::new() };` once and pass `&df_path`.

Grep for any other callers and update them:

Run: `grep -rn "resolve_qualified_member\|complete_qualified_members" crates/raven/src | grep -v "fn \|///\|//!"`
Update each call site to pass a `&QualifiedPath` (depth-1 for goto-def-on-identifier helpers).

- [ ] **Step 6: Build + run the full module test suite (must stay green)**

Run: `cargo test -p raven qualified_resolve`
Expected: all existing tests pass (behavior unchanged).

Run: `cargo test -p raven dollar` (completion/goto-def integration tests)
Expected: pass.

- [ ] **Step 7: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add -A
git commit -m "refactor(qualified-resolve): thread QualifiedPath through core + APIs (no behavior change)"
```

---

## Task 3: Path-prefixed assignment discovery (`alpha$beta$gamma <- …`)

Generalize the extract and string-subscript assignment matchers from "target LHS is `identifier(head)`" to "target's left-spine equals `head + segments`, and the final extract step is the member".

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn nested_assignment_members_depth2() {
    let mut state = fresh_state();
    let code = "\
alpha <- list()
alpha$beta <- list()
alpha$beta$gamma <- 1
alpha$beta$delta <- 2
alpha$beta$
";
    let uri = add_indexed_doc(&mut state, "file:///n.R", code);
    // Cursor on the trailing `alpha$beta$` line (0-based line 4, after the `$`).
    let mut names = completion_path_names(&state, &uri, Position::new(4, 11), "alpha", &["beta"]);
    names.sort();
    assert_eq!(names, vec!["delta".to_string(), "gamma".to_string()]);
}
```

Add a path-aware completion helper next to `completion_names`:

```rust
fn completion_path_names(
    state: &WorldState,
    uri: &Url,
    position: Position,
    head: &str,
    segments: &[&str],
) -> Vec<String> {
    let path = super::QualifiedPath {
        head: head.to_string(),
        segments: segments
            .iter()
            .map(|s| super::Segment { name: s.to_string(), op: crate::extract_op::ExtractOp::Dollar })
            .collect(),
    };
    super::complete_qualified_members(state, uri, position, &path, crate::extract_op::ExtractOp::Dollar)
        .into_iter()
        .map(|c| c.name)
        .collect()
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven qualified_resolve::tests::nested_assignment_members_depth2`
Expected: FAIL — returns `[]` (segments are not yet matched).

- [ ] **Step 3: Add a spine-prefix matcher and generalize the extract matcher**

Add a helper:

```rust
/// Does `target`'s left-spine equal `path` (`head` + `segments`)? `target` is
/// the LHS/RHS assignment target node. Each spine step must match the
/// corresponding segment by name and op (an `$`/`@` extract matches exactly; a
/// `[["lit"]]` subscript matches a `Dollar` segment). Returns the matched
/// container node count only as success/failure.
fn target_spine_is_path(target: Node, text: &str, path: &QualifiedPath) -> bool {
    // Build the target's spine bottom-up, then compare to head + segments.
    let Some(actual) = build_qualified_path(target, text) else {
        return false;
    };
    actual.head == path.head && actual.segments == path.segments
}
```

In `member_assignment_candidate_from_extract` (121): change the signature to take `path: &QualifiedPath` instead of `lhs_name: &str`. Replace the identifier-only LHS check:

```rust
let t_lhs = target.child_by_field_name("lhs")?;
let t_rhs = target.child_by_field_name("rhs")?;
if t_lhs.kind() != "identifier" || t_rhs.kind() != "identifier" {
    return None;
}
let member_name = node_text(t_rhs, text);
if node_text(t_lhs, text) != lhs_name
    || rhs_name.is_some_and(|rhs_name| member_name != rhs_name)
{
    return None;
}
```

with:

```rust
let t_rhs = target.child_by_field_name("rhs")?;
if t_rhs.kind() != "identifier" {
    return None;
}
let member_name = node_text(t_rhs, text);
if rhs_name.is_some_and(|rhs_name| member_name != rhs_name) {
    return None;
}
let t_lhs = target.child_by_field_name("lhs")?;
if !target_spine_is_path(t_lhs, text, path) {
    return None;
}
```

Keep `lhs_pos` as the head identifier position. Since `t_lhs` may now be an `extract_operator`, derive the head identifier position by walking to the leftmost identifier:

```rust
let head_id = leftmost_identifier(t_lhs)?;
let lhs_range = node_range(head_id, col_mapper);
```

Add the helper:

```rust
/// Leftmost `identifier` on a node's left-spine (the head of an access chain).
fn leftmost_identifier(mut node: Node) -> Option<Node> {
    loop {
        match node.kind() {
            "identifier" => return Some(node),
            "extract_operator" => node = node.child_by_field_name("lhs")?,
            "subset" | "subset2" => node = node.child_by_field_name("function")?,
            _ => return None,
        }
    }
}
```

- [ ] **Step 4: Generalize the string-subscript matcher**

In `member_assignment_candidate_from_string_subscript` (164): change `lhs_name: &str` → `path: &QualifiedPath`. Replace:

```rust
let t_lhs = target.child_by_field_name("function")?;
if t_lhs.kind() != "identifier" || node_text(t_lhs, text) != lhs_name {
    return None;
}
```

with:

```rust
let t_lhs = target.child_by_field_name("function")?;
if !target_spine_is_path(t_lhs, text, path) {
    return None;
}
let head_id = leftmost_identifier(t_lhs)?;
```

and use `head_id` for `lhs_range`.

- [ ] **Step 5: Thread `path` through the callers**

`try_extract_member_assignment` (1187) and `collect_member_assignments` (1122): change their `lhs_name: &str` params to `path: &QualifiedPath` and forward to the two candidate matchers. In `collect_qualified_member_candidates_with_cancel`, change the three `collect_member_assignments(... lhs_name ...)` calls to pass `path`. (The cross-file `lhs_arc`/`candidate_lhs_matches_symbol` logic still keys on `path.head` = `lhs_name`, unchanged.)

- [ ] **Step 6: Run the test to verify it passes + suite stays green**

Run: `cargo test -p raven qualified_resolve`
Expected: new test passes; depth-1 tests still pass (empty segments → `target_spine_is_path` reduces to head-identifier match).

- [ ] **Step 7: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/qualified_resolve.rs
git commit -m "feat(qualified-resolve): path-prefixed assignment discovery"
```

---

## Task 4: Constructor descent (`alpha <- list(beta = list(gamma = …))`)

Generalize `collect_constructor_candidates` to descend `segments` through nested allowlisted constructors before enumerating named args.

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn nested_constructor_descent_depth2() {
    let mut state = fresh_state();
    let code = "\
alpha <- list(beta = list(gamma = 1, delta = 2))
alpha$beta$
";
    let uri = add_indexed_doc(&mut state, "file:///c.R", code);
    let mut names = completion_path_names(&state, &uri, Position::new(1, 11), "alpha", &["beta"]);
    names.sort();
    assert_eq!(names, vec!["delta".to_string(), "gamma".to_string()]);
}

#[test]
fn nested_constructor_descent_depth3() {
    let mut state = fresh_state();
    let code = "\
alpha <- list(beta = list(gamma = list(epsilon = 1, zeta = 2)))
alpha$beta$gamma$
";
    let uri = add_indexed_doc(&mut state, "file:///c3.R", code);
    let mut names =
        completion_path_names(&state, &uri, Position::new(1, 17), "alpha", &["beta", "gamma"]);
    names.sort();
    assert_eq!(names, vec!["epsilon".to_string(), "zeta".to_string()]);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven qualified_resolve::tests::nested_constructor_descent`
Expected: FAIL — returns `[]`.

- [ ] **Step 3: Implement descent**

In `collect_constructor_candidates` (1259): change `lhs_name: &str` → `path: &QualifiedPath`. After locating `value_node` (the head assignment's RHS) and validating it is a `call` to an allowlisted constructor, **descend** through `path.segments` before enumerating:

```rust
// Descend the constructor following the intermediate segments. Each segment
// must be a named argument whose value is itself an allowlisted constructor.
let mut current_args = args_node;
for seg in &path.segments {
    let Some(child_call) = named_arg_constructor_value(current_args, text, &seg.name) else {
        return; // segment not present as a nested constructor → no members here
    };
    let Some(child_args) = child_call.child_by_field_name("arguments") else {
        return;
    };
    current_args = child_args;
}
// `current_args` is now the arg list of the terminal constructor; enumerate it.
```

Then change the existing enumeration loop to iterate `current_args` instead of `args_node`. Add the helper:

```rust
/// In `args` (a constructor call's argument list), find a named argument
/// `name = <call>` whose value is a call to an allowlisted constructor, and
/// return that call node.
fn named_arg_constructor_value<'a>(args: Node<'a>, text: &str, name: &str) -> Option<Node<'a>> {
    let mut walker = args.walk();
    for child in args.children(&mut walker) {
        if child.kind() != "argument" {
            continue;
        }
        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };
        if name_node.kind() != "identifier" || node_text(name_node, text) != name {
            continue;
        }
        let value = child.child_by_field_name("value")?;
        if value.kind() != "call" {
            return None;
        }
        let func = value.child_by_field_name("function")?;
        if func.kind() == "identifier" && CONSTRUCTOR_ALLOWLIST.contains(&node_text(func, text)) {
            return Some(value);
        }
        return None;
    }
    None
}
```

Thread `path` through `collect_constructor_candidate` (1221) and the two call sites in the core collector (passing `path` instead of `lhs_name`).

- [ ] **Step 4: Run the tests + suite**

Run: `cargo test -p raven qualified_resolve`
Expected: depth-2 and depth-3 descent tests pass; existing tests green (empty segments → loop is a no-op, identical to today).

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/qualified_resolve.rs
git commit -m "feat(qualified-resolve): nested constructor descent"
```

---

## Task 5: Intermediate constructor assignment (`alpha$beta <- list(gamma = …)`)

A whole-value write to a prefix of the path, with a constructor RHS, contributes the constructor's named args (descended to the path). This reuses Task 3's spine matcher and Task 4's descent.

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn intermediate_constructor_assignment() {
    let mut state = fresh_state();
    let code = "\
alpha <- list()
alpha$beta <- list(gamma = 1, delta = 2)
alpha$beta$
";
    let uri = add_indexed_doc(&mut state, "file:///i.R", code);
    let mut names = completion_path_names(&state, &uri, Position::new(2, 11), "alpha", &["beta"]);
    names.sort();
    assert_eq!(names, vec!["delta".to_string(), "gamma".to_string()]);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven qualified_resolve::tests::intermediate_constructor_assignment`
Expected: FAIL — returns `[]`.

- [ ] **Step 3: Implement prefix-write constructor collection**

Add `collect_prefix_write_constructor_candidates`, invoked from the core collector for the defining file (and reused by the establishing-site logic in Task 6). It scans the tree for assignments whose target spine is a **prefix** of `path` (length `≥ 1` segment, i.e. longer than the head and up to the full path), and whose RHS is an allowlisted constructor; it then descends the remaining segments and enumerates named args:

```rust
/// Collect members contributed by an assignment whose target spine is a prefix
/// of `path` longer than the head (`alpha$beta <- list(...)` for path
/// `[alpha, beta, ...]`), with an allowlisted-constructor RHS, descended to the
/// full path. `out` receives one candidate per terminal named argument.
#[allow(clippy::too_many_arguments)]
fn collect_prefix_write_constructor_candidates(
    root: Node,
    text: &str,
    col_mapper: &ColMapper,
    file_uri: &Url,
    path: &QualifiedPath,
    rhs_name: Option<&str>,
    out: &mut Vec<Candidate>,
    skip_functions: bool,
) {
    for k in 1..=path.segments.len() {
        let prefix = QualifiedPath {
            head: path.head.clone(),
            segments: path.segments[..k].to_vec(),
        };
        let remaining = &path.segments[k..];
        visit_prefix_assignments(root, text, &prefix, skip_functions, &mut |assignment, value_node| {
            enumerate_constructor_at_path(
                value_node, text, col_mapper, file_uri, assignment, remaining, rhs_name, out,
            );
        });
    }
}
```

where:
- `visit_prefix_assignments` walks the tree (same traversal shape as `collect_member_assignments`, honoring `skip_functions`), and for each `binary_operator` whose assignment target spine equals `prefix` (via `target_spine_is_path`) with a `call` RHS to an allowlisted constructor, invokes the callback with `(assignment_node, constructor_call_node)`.
- `enumerate_constructor_at_path` descends `remaining` segments via `named_arg_constructor_value` (Task 4) and pushes a `Candidate` per terminal named arg, with `effect = EffectPos::from_node_end(assignment, col_mapper)`, `fn_scope = enclosing_function_id(assignment)`, `lhs_pos = leftmost_identifier(target).start`.

Implement both helpers concretely (mirror the traversal in `collect_member_assignments` lines 1122-1182 for `visit_prefix_assignments`; mirror the enumeration loop in `collect_constructor_candidates` lines 1313-1342 for `enumerate_constructor_at_path`).

Call `collect_prefix_write_constructor_candidates` from the defining-file block of the core collector (alongside `collect_member_assignments` + `collect_constructor_candidates`) and from the cross-file blocks (into `needs_validation` for redefining files, into `cross_file_candidates` for non-redefining files), so prefix-write members are validated by the same `candidate_lhs_matches_symbol` head check.

- [ ] **Step 4: Run the test + suite**

Run: `cargo test -p raven qualified_resolve`
Expected: new test passes; existing tests green (empty segments → the `1..=0` range is empty → no-op).

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/qualified_resolve.rs
git commit -m "feat(qualified-resolve): intermediate constructor assignment discovery"
```

---

## Task 6: Establishing-site cutoff (reassignment delete semantics)

The riskiest task. A whole-value (re)write of a prefix of the path is an *establishing site*; members declared before the latest visible establishing site are excluded. Implement the cutoff fully for the same-file case; cross-file ordering reuses the existing `visible_positions`/contributor machinery.

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn reassignment_replaces_earlier_members_same_file() {
    let mut state = fresh_state();
    let code = "\
alpha <- list(beta = list(gamma = 1))
alpha$beta <- list(delta = 2)
alpha$beta$epsilon <- 3
alpha$beta$
";
    let uri = add_indexed_doc(&mut state, "file:///r.R", code);
    let mut names = completion_path_names(&state, &uri, Position::new(3, 11), "alpha", &["beta"]);
    names.sort();
    // gamma was replaced by the whole-value rewrite on line 1; delta + epsilon survive.
    assert_eq!(names, vec!["delta".to_string(), "epsilon".to_string()]);
}

#[test]
fn extension_before_reassignment_is_excluded() {
    let mut state = fresh_state();
    let code = "\
alpha <- list(beta = list())
alpha$beta$old <- 1
alpha$beta <- list(fresh = 2)
alpha$beta$
";
    let uri = add_indexed_doc(&mut state, "file:///r2.R", code);
    let names = completion_path_names(&state, &uri, Position::new(3, 11), "alpha", &["beta"]);
    // `old` was added before the rewrite on line 2 → excluded. Only `fresh`.
    assert_eq!(names, vec!["fresh".to_string()]);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p raven qualified_resolve::tests::reassignment`
Expected: FAIL — `gamma`/`old` are still offered (current behavior unions everything).

- [ ] **Step 3: Implement the establishing-site cutoff**

Tag each `Candidate` with the source kind it came from. Add a field to `Candidate`:

```rust
/// Where this candidate's value was established. `Extension` candidates
/// (member-assignments to exactly the path) are subject to the establishing-site
/// cutoff; `Establishing` candidates (head-binding constructor descent or a
/// prefix-write constructor) define the cutoff.
kind: CandidateKind,
```

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateKind {
    /// `path$m <- ...` / `path[["m"]] <- ...` — extends an existing value.
    Extension,
    /// Head-binding constructor descent, or `prefix <- list(...)` — establishes
    /// the whole value at the path.
    Establishing,
}
```

Set `kind` at each push site: `collect_member_assignments`-derived candidates whose matched spine equals the full path are `Extension`; constructor-descent (Task 4) and prefix-write (Task 5) candidates are `Establishing`.

After all candidates are collected in `collect_qualified_member_candidates_with_cancel` (before building `CandidateBatch`), apply the cutoff **per partition the winner logic already trusts**:

```rust
apply_establishing_cutoff(&mut all_candidates, &cursor_uri, &scope.visible_positions);
```

```rust
/// Drop `Extension` candidates whose effect precedes the latest visible
/// `Establishing` candidate (the establishing-site cutoff). Establishing
/// candidates are never dropped here (they are the cutoff and also contribute
/// their own members). Comparison uses effect position within a file and the
/// per-file `visible_positions` cutoff; candidates in different files are
/// ordered by their visible-position cutoff, matching `pick_winner`'s basis.
fn apply_establishing_cutoff(
    candidates: &mut Vec<Candidate>,
    cursor_uri: &Url,
    visible_positions: &HashMap<Url, (u32, u32)>,
) {
    // Find the latest visible establishing site. Key: (file-visible rank, effect).
    let latest = candidates
        .iter()
        .filter(|c| c.kind == CandidateKind::Establishing)
        .max_by(|a, b| establishing_order(a, cursor_uri, visible_positions)
            .cmp(&establishing_order(b, cursor_uri, visible_positions)));
    let Some(latest) = latest else { return };
    let cutoff = establishing_order(latest, cursor_uri, visible_positions);
    candidates.retain(|c| {
        c.kind == CandidateKind::Establishing
            || establishing_order(c, cursor_uri, visible_positions) >= cutoff
    });
}
```

`establishing_order` returns a comparable key: candidates in the cursor file rank after candidates in other files (cursor-file changes are always "latest" relative to upstream contributors), and within a file the key is `(effect.line, effect.utf16_column)`. Concretely:

```rust
fn establishing_order(
    c: &Candidate,
    cursor_uri: &Url,
    _visible_positions: &HashMap<Url, (u32, u32)>,
) -> (u8, u32, u32) {
    let in_cursor_file = if &c.uri == cursor_uri { 1 } else { 0 };
    (in_cursor_file, c.effect.line, c.effect.utf16_column)
}
```

(Same-file correctness is exact: line/column ordering. Cross-file uses the cursor-file-last tier, consistent with how `pick_winner` treats cursor-file candidates as latest; the spec documents the residual cross-file imprecision.)

- [ ] **Step 4: Run the tests + suite**

Run: `cargo test -p raven qualified_resolve`
Expected: both reassignment tests pass; depth-1 tests green (a single head-binding establishing site never cuts its own later extensions, reproducing today's behavior).

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/qualified_resolve.rs
git commit -m "feat(qualified-resolve): establishing-site cutoff for reassignment semantics"
```

---

## Task 7: Completion path parity — seed the spine-walker from the AST

Rework `detect_dollar_member_completion_context` so the container path comes from the AST (full `$`/`@`/`[["lit"]]` parity), while the text scan still finds the trigger `$`, typed prefix, and replace range.

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Write the failing integration tests**

In `handlers.rs` tests (near the existing `detect_dollar_member_completion_context` test at 46206), add:

```rust
#[test]
fn completion_nested_dollar_chain() {
    // alpha$beta$<cursor>
    let (state, uri, pos) = setup_completion_doc(
        "alpha <- list(beta = list(gamma = 1, delta = 2))\nalpha$beta$\n",
        Position::new(1, 11),
    );
    let names = dollar_completion_labels(&state, &uri, pos);
    assert!(names.contains(&"gamma".to_string()) && names.contains(&"delta".to_string()));
}

#[test]
fn completion_subscript_segment_parity() {
    // alpha[["beta"]]$<cursor>
    let (state, uri, pos) = setup_completion_doc(
        "alpha <- list(beta = list(gamma = 1))\nalpha[[\"beta\"]]$\n",
        Position::new(1, 16),
    );
    let names = dollar_completion_labels(&state, &uri, pos);
    assert!(names.contains(&"gamma".to_string()));
}

#[test]
fn completion_no_false_positive_on_collision() {
    // Unrelated top-level `beta` must NOT leak its members into alpha$beta$.
    let (state, uri, pos) = setup_completion_doc(
        "beta <- list(zeta = 1)\nalpha <- list(beta = list(gamma = 2))\nalpha$beta$\n",
        Position::new(2, 11),
    );
    let names = dollar_completion_labels(&state, &uri, pos);
    assert!(names.contains(&"gamma".to_string()));
    assert!(!names.contains(&"zeta".to_string()), "leaked unrelated beta member");
}
```

Add `setup_completion_doc` + `dollar_completion_labels` test helpers in `handlers.rs` if not present (use the existing completion test harness pattern in that file — search for how other completion tests build a `WorldState` + `Url` and call the completion entry point or `dollar_member_completion_items`).

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p raven completion_nested_dollar_chain completion_subscript_segment_parity completion_no_false_positive_on_collision`
Expected: `completion_subscript_segment_parity` fails (subscript chains not recognized) and the nested chain returns nothing; the collision test currently leaks `zeta`.

- [ ] **Step 3: Rework the context struct + detector**

Change `DollarMemberCompletionContext` (12365) to carry the path and terminal op:

```rust
struct DollarMemberCompletionContext {
    path: crate::qualified_resolve::QualifiedPath,
    op: crate::extract_op::ExtractOp,
    typed_prefix: String,
    replace_range: Range,
}
```

In `detect_dollar_member_completion_context` (12371): keep the text scan that locates the trigger operator (`$` today; also accept `@`), the typed prefix, and the replace range. Then build the path from the AST node ending just before the trigger operator:

```rust
// `op_byte` is the byte offset of the trigger `$`/`@`. The LHS subexpression
// ends just before it. Descend to the node ending at `op_byte` and walk it.
let lhs_end_point = Point::new(line_idx, op_byte);
let lhs_node = tree
    .root_node()
    .descendant_for_point_range(
        Point::new(line_idx, op_byte.saturating_sub(1)),
        lhs_end_point,
    )?;
// Ascend to the largest node ending exactly at the operator (the full LHS).
let mut lhs = lhs_node;
while let Some(parent) = lhs.parent() {
    if parent.end_byte() <= line_byte_offset(&text, line_idx) + op_byte
        && matches!(parent.kind(), "extract_operator" | "subset" | "subset2" | "identifier")
    {
        lhs = parent;
    } else {
        break;
    }
}
let path = crate::qualified_resolve::build_qualified_path(lhs, text)?;
```

(Compute `op_byte` from the existing `dollar_byte` logic, generalized to also match `@`. Helper `line_byte_offset` converts a line index to an absolute byte offset; if a simpler local computation is available from the existing code, use it. If the AST descent or `build_qualified_path` fails, return `None` — bail rather than guess.)

Populate `Some(DollarMemberCompletionContext { path, op, typed_prefix, replace_range })`.

- [ ] **Step 4: Update `dollar_member_completion_items`**

Use `context.path` + `context.op` directly:

```rust
crate::qualified_resolve::complete_qualified_members(state, uri, position, &context.path, context.op)
```

and update the `detail` strings to render the path (e.g. join head + segment names with the segment ops) instead of `context.lhs_name`. A simple rendering: `format!("member of {}", render_path(&context.path))` where `render_path` joins `head` and each segment as `op + name` (`$beta`, `@slot`).

- [ ] **Step 5: Run the tests + suite**

Run: `cargo test -p raven completion_nested_dollar_chain completion_subscript_segment_parity completion_no_false_positive_on_collision`
Expected: all pass.

Run: `cargo test -p raven` (full crate) — ensure no regression in existing completion tests.
Expected: pass.

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs
git commit -m "feat(completion): nested $/@/[[]] member completion via shared spine-walker"
```

---

## Task 8: Goto-def nested integration tests

Task 2 already wired nested goto-def. This task locks it with tests.

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs` (test module)

- [ ] **Step 1: Write the tests**

```rust
#[test]
fn goto_def_nested_member_jumps_to_assignment() {
    let mut state = fresh_state();
    let code = "\
alpha <- list(beta = list())
alpha$beta$gamma <- 1
x <- alpha$beta$gamma
";
    let uri = add_indexed_doc(&mut state, "file:///g.R", code);
    // Cursor on `gamma` in the use on line 2 (0-based), column within `gamma`.
    let result = crate::handlers::goto_definition_for_test(&state, &uri, Position::new(2, 17));
    let location = loc(result);
    assert_eq!(location.uri, uri);
    assert_eq!(location.range.start.line, 1); // the `alpha$beta$gamma <- 1` line
}

#[test]
fn goto_def_nested_no_false_positive() {
    let mut state = fresh_state();
    let code = "\
gamma <- 99
alpha <- list(beta = list(gamma = 1))
y <- alpha$beta$gamma
";
    let uri = add_indexed_doc(&mut state, "file:///g2.R", code);
    // `gamma` here must resolve to the constructor member (line 1), not the
    // top-level `gamma <- 99` on line 0.
    let result = crate::handlers::goto_definition_for_test(&state, &uri, Position::new(2, 16));
    let location = loc(result);
    assert_eq!(location.range.start.line, 1);
}
```

If no `goto_definition_for_test` shim exists, call the same goto-def entry point existing goto-def tests use (search `crates/raven/src/qualified_resolve.rs` and `handlers.rs` for how current `$`-member goto-def tests invoke it — reuse that exact path). Adjust the expected columns to the fixture.

- [ ] **Step 2: Run + verify pass**

Run: `cargo test -p raven qualified_resolve::tests::goto_def_nested`
Expected: pass (wiring landed in Task 2; discovery in Tasks 3-4).

- [ ] **Step 3: commit**

```bash
cargo fmt --all
git add crates/raven/src/qualified_resolve.rs
git commit -m "test(goto-def): nested member resolution coverage"
```

---

## Task 9: Cross-file, position-awareness, bail-case + mixed-chain regression tests

**Files:**
- Modify: `crates/raven/src/qualified_resolve.rs` (test module)

- [ ] **Step 1: Write the position-awareness + cross-file tests**

```rust
#[test]
fn nested_member_below_cursor_not_offered() {
    let mut state = fresh_state();
    let code = "\
alpha <- list(beta = list())
alpha$beta$gamma <- 1
alpha$beta$
alpha$beta$delta <- 2
";
    let uri = add_indexed_doc(&mut state, "file:///p.R", code);
    // Cursor on line 2; `delta` is assigned on line 3 (below) and must not appear.
    let names = completion_path_names(&state, &uri, Position::new(2, 11), "alpha", &["beta"]);
    assert_eq!(names, vec!["gamma".to_string()]);
}

#[test]
fn nested_member_cross_file() {
    // `alpha` + its nested structure declared in utils.R; extended in main.R
    // after the source() call. Mirror the multi-doc + source() setup used by the
    // existing cross-file `$`-member tests in this module (search the test module
    // for `source(` fixtures and reuse that exact harness shape).
    let mut state = fresh_state();
    let _utils = add_indexed_doc(
        &mut state,
        "file:///utils.R",
        "alpha <- list(beta = list(gamma = 1))\n",
    );
    let main = add_indexed_doc(
        &mut state,
        "file:///main.R",
        "source(\"utils.R\")\nalpha$beta$delta <- 2\nalpha$beta$\n",
    );
    let mut names = completion_path_names(&state, &main, Position::new(2, 11), "alpha", &["beta"]);
    names.sort();
    // gamma from utils.R (the establishing site) + delta extended in main.R.
    assert_eq!(names, vec!["delta".to_string(), "gamma".to_string()]);
}
```

If the multi-doc `source()` harness needs more than `add_indexed_doc` (e.g.
registering the dependency edge), copy the setup from the nearest existing
cross-file `$`-member test in this module verbatim and adapt the fixtures.

- [ ] **Step 2: Write the bail-case + mixed-chain tests**

```rust
#[test]
fn non_static_chain_yields_nothing() {
    let mut state = fresh_state();
    let code = "\
make <- function() list(x = 1)
alpha <- list(beta = list(gamma = 1))
i <- \"beta\"
";
    let uri = add_indexed_doc(&mut state, "file:///b.R", code);
    // f()$x$ and alpha[[i]]$ must produce no completions. Build those paths via
    // the AST path-builder failing → empty. Here we assert the resolver returns
    // empty for a path whose head does not resolve.
    let names = completion_path_names(&state, &uri, Position::new(2, 0), "nonexistent", &["x"]);
    assert!(names.is_empty());
}

#[test]
fn mixed_dollar_at_chain_depth2() {
    let mut state = fresh_state();
    let code = "\
setClass(\"K\", representation(slot = \"list\"))
alpha <- list(beta = new(\"K\"))
alpha$beta@slot$
";
    let uri = add_indexed_doc(&mut state, "file:///m.R", code);
    // At minimum this must not panic and must not leak unrelated symbols.
    let path = super::QualifiedPath {
        head: "alpha".to_string(),
        segments: vec![
            super::Segment { name: "beta".into(), op: crate::extract_op::ExtractOp::Dollar },
            super::Segment { name: "slot".into(), op: crate::extract_op::ExtractOp::At },
        ],
    };
    let _ = super::complete_qualified_members(
        &state, &uri, Position::new(2, 16), &path, crate::extract_op::ExtractOp::Dollar,
    );
}
```

(The non-static AST bail is already covered by Task 1's `build_path_bails_on_non_static_segment`; this task adds resolver-level robustness coverage.)

- [ ] **Step 3: Run + verify all Task 9 tests pass**

Run: `cargo test -p raven qualified_resolve::tests::nested_member_below_cursor_not_offered qualified_resolve::tests::nested_member_cross_file qualified_resolve::tests::non_static_chain_yields_nothing qualified_resolve::tests::mixed_dollar_at_chain_depth2`
Expected: pass.

- [ ] **Step 4: commit**

```bash
git add crates/raven/src/qualified_resolve.rs
git commit -m "test(qualified-resolve): cross-file, position-aware, bail-case coverage"
```

---

## Task 10: Documentation

**Files:**
- Modify: `docs/completion.md`, `docs/go-to-definition.md`
- Modify: `crates/raven/src/qualified_resolve.rs` (module doc)
- Modify: `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`

- [ ] **Step 1: `docs/completion.md` — `$ Member Completions`**

Add after the existing constructor-literal bullet:

```markdown
Member completion follows nested access at any depth — `alpha$beta$` and
`alpha[["beta"]]$gamma$` complete against the value at the full path. Members
reflect the value live at the cursor, so a whole reassignment of an intermediate
value (`alpha$beta <- list(...)`) replaces its earlier members.
```

- [ ] **Step 2: `docs/go-to-definition.md`**

Add a sentence to the `$`/`@` member section noting that nested members
(`alpha$beta$gamma`) resolve against the full container path and never fall
back to a free identifier of the same name.

- [ ] **Step 3: `qualified_resolve.rs` module doc**

Update the header doc (lines 1-40) to describe the `QualifiedPath` model: the
single-identifier case is the base case (`segments == []`); discovery matches
path prefixes; the establishing-site cutoff delivers reassignment semantics.
Reference `docs/superpowers/specs/2026-06-04-nested-dollar-member-completion-design.md`.

- [ ] **Step 4: Forward-reference in the Step-1 spec**

In `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`, under the
out-of-scope "Chained access" bullet, add: "Implemented in Step 2 —
`2026-06-04-nested-dollar-member-completion-design.md`."

- [ ] **Step 5: commit**

```bash
git add docs/ crates/raven/src/qualified_resolve.rs
git commit -m "docs: nested member completion + goto-def"
```

---

## Self-Review notes (for the implementer)

- **Backward compatibility is the safety net.** After Tasks 2, 3, 4, 5, 6 the depth-1 behavior must be byte-identical — every existing `qualified_resolve` test must stay green at each commit. If one breaks, the generalization changed depth-1 semantics and must be corrected before proceeding.
- **`segments == []` reductions:** `target_spine_is_path` → head-identifier match; constructor descent loop → no-op; prefix-write range `1..=0` → empty; establishing cutoff with only the head-binding establishing site → no extensions dropped.
- **The cursor columns in the fixtures are 0-based UTF-16.** Verify each `Position::new(line, col)` points just after the trailing `$` (for completion) or inside the member identifier (for goto-def); adjust to the actual fixture text.
- **Risk concentration:** Task 6 (establishing-site) and Task 7 (AST-seeded completion context). Review these most carefully; they carry the subtle position/ordering logic.
