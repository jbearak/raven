//! Resolve go-to-definition for the RHS identifier of `$` and `@`.
//!
//! See `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`.
//!
//! For `foo$bar` (or `foo@bar`) where the cursor is on `bar`:
//!
//! 1. Resolve `foo` via the existing position-aware scope.
//! 2. In `foo`'s defining file, collect candidates:
//!    - `foo$bar <- ...` member-assignments (matching the operator).
//!    - Named arguments inside `foo`'s defining call when the call is one of
//!      a small allowlist of constructors.
//! 3. Position-aware tie-break by *effect position* (end of the assignment
//!    that introduces the candidate), not the identifier token position.
//! 4. Return the candidate with the latest effect position; never fall back
//!    to free-identifier lookup.

use tower_lsp::lsp_types::{Location, Position, Range, Url};
use tree_sitter::{Node, Tree};

use crate::extract_op::ExtractOp;
use crate::handlers::DiagCancelToken;
use crate::state::WorldState;
use crate::utf16::{byte_offset_to_utf16_column, utf16_column_to_byte_offset};

/// Identifier we attach to a candidate's enclosing function-definition node,
/// so two candidates can be checked for "same function scope". `None`
/// represents top-level (outside any function_definition).
type FunctionScopeId = Option<usize>;

const CONSTRUCTOR_ALLOWLIST: &[&str] = &[
    "list",
    "c",
    "data.frame",
    "tibble",
    "data.table",
    "environment",
    "list2env",
    "new",
];

/// Position at which a candidate's binding becomes visible. Stored in
/// UTF-16 columns (the LSP `Position.character` unit) so it can be compared
/// directly against an LSP cursor position.
#[derive(Debug, Clone, Copy)]
struct EffectPos {
    line: u32,
    utf16_column: u32,
}

impl EffectPos {
    fn from_node_end(node: Node, text: &str) -> Self {
        let p = node.end_position();
        let line_text = nth_line(text, p.row).unwrap_or("");
        Self {
            line: p.row as u32,
            utf16_column: byte_offset_to_utf16_column(line_text, p.column),
        }
    }
}

#[derive(Debug, Clone)]
struct Candidate {
    effect: EffectPos,
    name_range: Range,
    /// `None` for top-level, else the `function_definition` node id of the
    /// closest enclosing function scope.
    fn_scope: FunctionScopeId,
}

pub fn resolve_qualified_member(
    state: &WorldState,
    uri: &Url,
    position: Position,
    lhs_node_kind: &str,
    lhs_name: &str,
    rhs_name: &str,
    op: ExtractOp,
) -> Option<Location> {
    // LHS shape gate — only bare `identifier` LHS is supported in Step 1.
    if lhs_node_kind != "identifier" {
        return None;
    }

    // Resolve the LHS via the existing position-aware cross-file scope.
    let scope = crate::handlers::get_cross_file_scope(
        state,
        uri,
        position.line,
        position.character,
        &DiagCancelToken::never(),
    );
    let symbol = scope.symbols.get(lhs_name)?;

    // Package exports (pseudo-URIs like `package:dplyr`) are not navigable.
    if symbol.source_uri.as_str().starts_with("package:") {
        return None;
    }

    let defining_uri = symbol.source_uri.clone();

    // Get the defining file's tree + text via the same priority chain
    // `parameter_resolver::get_text_and_tree` uses (covers open documents,
    // workspace index, and the cross-file file cache).
    let (defining_text, defining_tree) =
        crate::parameter_resolver::get_text_and_tree(state, &defining_uri)?;

    // Identify the function scope that owns the resolved `foo` binding. Only
    // candidates in the same scope (i.e. would be reachable from the same
    // `foo`) are kept.
    let symbol_fn_scope = function_scope_at(
        &defining_tree,
        &defining_text,
        symbol.defined_line,
        symbol.defined_column,
    );
    // A symbol's *visible-from* position is the end of its defining
    // assignment, not the position of the LHS identifier — so a member
    // assignment that occurs inside the RHS of `foo <- {...}` was binding the
    // *previous* `foo` and must not match the new one.
    //
    // Fall back to the LHS anchor for non-assignment-defined symbols
    // (parameters, for-variables, declared symbols).
    let symbol_effect = symbol_visible_from_position(
        &defining_tree,
        &defining_text,
        symbol.defined_line,
        symbol.defined_column,
        lhs_name,
    );

    let mut candidates: Vec<Candidate> = Vec::new();
    collect_member_assignments(
        defining_tree.root_node(),
        &defining_text,
        lhs_name,
        rhs_name,
        op,
        &mut candidates,
    );
    if let Some(c) = collect_constructor_candidate(
        &defining_tree,
        &defining_text,
        symbol.defined_line,
        symbol.defined_column,
        lhs_name,
        rhs_name,
    ) {
        candidates.push(c);
    }

    // Filter candidates to those that belong to the resolved `foo`'s scope:
    // - Same enclosing function (or both top-level).
    // - Effect position not before the resolved binding's defined position
    //   (a candidate before the binding cannot have applied to *this* `foo`).
    candidates.retain(|c| {
        c.fn_scope == symbol_fn_scope && effect_at_or_after(c.effect, symbol_effect)
    });

    pick_winner(candidates, uri == &defining_uri, position).map(|c| Location {
        uri: defining_uri,
        range: c.name_range,
    })
}

fn effect_at_or_after(a: EffectPos, b: EffectPos) -> bool {
    (a.line, a.utf16_column) >= (b.line, b.utf16_column)
}

fn pick_winner(
    mut candidates: Vec<Candidate>,
    same_file: bool,
    cursor: Position,
) -> Option<Candidate> {
    if same_file {
        // Both `cursor` and `effect` use UTF-16 columns, so this comparison
        // is unit-consistent.
        candidates.retain(|c| {
            (c.effect.line, c.effect.utf16_column) <= (cursor.line, cursor.character)
        });
    }
    candidates
        .into_iter()
        .max_by_key(|c| (c.effect.line, c.effect.utf16_column))
}

/// Compute the resolved symbol's *visible-from* position: the end of its
/// defining assignment if there is one, else the LHS-anchor position.
///
/// Mirrors the cross-file scope rule that a binding becomes visible only
/// after its full assignment statement, so a candidate inside the RHS of the
/// rebinding belongs to the previous `foo`, not the new one.
fn symbol_visible_from_position(
    tree: &Tree,
    text: &str,
    defined_line: u32,
    defined_column_utf16: u32,
    lhs_name: &str,
) -> EffectPos {
    let fallback = EffectPos {
        line: defined_line,
        utf16_column: defined_column_utf16,
    };
    let Some(line_text) = nth_line(text, defined_line as usize) else { return fallback };
    let byte_col = utf16_column_to_byte_offset(line_text, defined_column_utf16);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(defined_line as usize, byte_col);
    let end = tree_sitter::Point::new(defined_line as usize, (byte_col + 1).min(line_byte_len));
    let Some(id_node) = tree.root_node().descendant_for_point_range(start, end) else { return fallback };
    let Some(assignment) = ascend_to_assignment_for(id_node, text, lhs_name) else { return fallback };
    EffectPos::from_node_end(assignment, text)
}

/// Return the id of the closest enclosing `function_definition` node at the
/// given (UTF-16) position, or `None` if the position is at top-level.
fn function_scope_at(tree: &Tree, text: &str, line: u32, utf16_col: u32) -> FunctionScopeId {
    let line_text = nth_line(text, line as usize)?;
    let byte_col = utf16_column_to_byte_offset(line_text, utf16_col);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(line as usize, byte_col);
    let end = tree_sitter::Point::new(line as usize, (byte_col + 1).min(line_byte_len));
    let node = tree.root_node().descendant_for_point_range(start, end)?;
    enclosing_function_id(node)
}

/// Walk up from `node` and return the id of the nearest enclosing
/// `function_definition`, or `None` if there isn't one.
fn enclosing_function_id(node: Node) -> FunctionScopeId {
    let mut current = node;
    loop {
        if current.kind() == "function_definition" {
            return Some(current.id());
        }
        match current.parent() {
            Some(p) => current = p,
            None => return None,
        }
    }
}

/// Walk `root` recursively, recording every `binary_operator` whose target
/// is `extract_operator` matching `(lhs_name, op, rhs_name)`.
fn collect_member_assignments(
    root: Node,
    text: &str,
    lhs_name: &str,
    rhs_name: &str,
    op: ExtractOp,
    out: &mut Vec<Candidate>,
) {
    let mut stack: Vec<Node> = vec![root];
    while let Some(node) = stack.pop() {
        let mut walker = node.walk();
        for child in node.children(&mut walker) {
            stack.push(child);
        }
        if node.kind() != "binary_operator" {
            continue;
        }
        let Some(op_node) = node.child_by_field_name("operator") else { continue };
        let op_text = node_text(op_node, text);
        let target = match op_text {
            "<-" | "=" | "<<-" => node.child_by_field_name("lhs"),
            "->" | "->>" => node.child_by_field_name("rhs"),
            _ => continue,
        };
        let Some(target) = target else { continue };
        if target.kind() != "extract_operator" {
            continue;
        }
        let Some(target_op) = target.child_by_field_name("operator") else { continue };
        let target_op_kind = match (target_op.kind(), op) {
            ("$", ExtractOp::Dollar) => true,
            ("@", ExtractOp::At) => true,
            _ => false,
        };
        if !target_op_kind {
            continue;
        }
        let Some(t_lhs) = target.child_by_field_name("lhs") else { continue };
        let Some(t_rhs) = target.child_by_field_name("rhs") else { continue };
        if t_lhs.kind() != "identifier" || t_rhs.kind() != "identifier" {
            continue;
        }
        if node_text(t_lhs, text) != lhs_name || node_text(t_rhs, text) != rhs_name {
            continue;
        }
        out.push(Candidate {
            effect: EffectPos::from_node_end(node, text),
            name_range: node_range_in_text(t_rhs, text),
            fn_scope: enclosing_function_id(node),
        });
    }
}

/// If the assignment that defines `lhs_name` at `(defined_line, defined_col)`
/// has a constructor-call RHS in the allowlist, return a candidate for the
/// named argument matching `rhs_name`.
///
/// We use the position only as a hint to find the *intended* defining
/// assignment — descend to the smallest node containing `(defined_line,
/// defined_col + 1)` (a 1-byte-wide range, since a zero-width range at the
/// very start of the line does not reliably descend into a leaf), then
/// ascend to the enclosing `binary_operator` whose target identifier matches
/// `lhs_name`.
fn collect_constructor_candidate(
    tree: &Tree,
    text: &str,
    defined_line: u32,
    defined_column_utf16: u32,
    lhs_name: &str,
    rhs_name: &str,
) -> Option<Candidate> {
    // LSP columns are UTF-16 units; tree-sitter Point columns are byte offsets.
    let line_text = nth_line(text, defined_line as usize)?;
    let byte_col = utf16_column_to_byte_offset(line_text, defined_column_utf16);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(defined_line as usize, byte_col);
    // Use a 1-byte-wide end to ensure we descend into the identifier leaf even
    // when the symbol sits at column 0 of its line.
    let end_col = (byte_col + 1).min(line_byte_len);
    let end = tree_sitter::Point::new(defined_line as usize, end_col);
    let id_node = tree.root_node().descendant_for_point_range(start, end)?;

    // Walk up to the enclosing `binary_operator` whose target identifier is
    // `lhs_name`, then look at its RHS.
    let assignment = ascend_to_assignment_for(id_node, text, lhs_name)?;
    let value_node = assignment_value_node(assignment, text)?;

    if value_node.kind() != "call" {
        return None;
    }
    let func_node = value_node.child_by_field_name("function")?;
    if func_node.kind() != "identifier" {
        return None;
    }
    let func_name = node_text(func_node, text);
    if !CONSTRUCTOR_ALLOWLIST.contains(&func_name) {
        return None;
    }

    let args_node = value_node.child_by_field_name("arguments")?;
    let mut walker = args_node.walk();
    for child in args_node.children(&mut walker) {
        if child.kind() != "argument" {
            continue;
        }
        let Some(name_node) = child.child_by_field_name("name") else { continue };
        if name_node.kind() != "identifier" {
            continue;
        }
        if node_text(name_node, text) != rhs_name {
            continue;
        }
        return Some(Candidate {
            effect: EffectPos::from_node_end(assignment, text),
            name_range: node_range_in_text(name_node, text),
            fn_scope: enclosing_function_id(assignment),
        });
    }
    None
}

fn ascend_to_assignment_for<'a>(start: Node<'a>, text: &str, lhs_name: &str) -> Option<Node<'a>> {
    let mut current = start;
    loop {
        if current.kind() == "binary_operator" {
            let op_text = current
                .child_by_field_name("operator")
                .map(|n| node_text(n, text));
            let target = match op_text {
                Some("<-") | Some("=") | Some("<<-") => current.child_by_field_name("lhs"),
                Some("->") | Some("->>") => current.child_by_field_name("rhs"),
                _ => None,
            };
            if let Some(t) = target {
                if t.kind() == "identifier" && node_text(t, text) == lhs_name {
                    return Some(current);
                }
            }
        }
        current = current.parent()?;
    }
}

fn assignment_value_node<'a>(assignment: Node<'a>, text: &str) -> Option<Node<'a>> {
    let op_text = node_text(assignment.child_by_field_name("operator")?, text);
    match op_text {
        "<-" | "=" | "<<-" => assignment.child_by_field_name("rhs"),
        "->" | "->>" => assignment.child_by_field_name("lhs"),
        _ => None,
    }
}

fn node_text<'a>(node: Node, text: &'a str) -> &'a str {
    &text[node.byte_range()]
}

/// Convert a tree-sitter node's range into an LSP `Range` whose columns are
/// UTF-16 code units (per the LSP spec / `vscode-languageserver-types`).
fn node_range_in_text(node: Node, text: &str) -> Range {
    let s = node.start_position();
    let e = node.end_position();
    let s_line = nth_line(text, s.row).unwrap_or("");
    let e_line = nth_line(text, e.row).unwrap_or("");
    Range {
        start: Position::new(s.row as u32, byte_offset_to_utf16_column(s_line, s.column)),
        end: Position::new(e.row as u32, byte_offset_to_utf16_column(e_line, e.column)),
    }
}

fn nth_line(text: &str, n: usize) -> Option<&str> {
    text.split('\n').nth(n)
}

#[cfg(test)]
mod tests {
    use crate::handlers::goto_definition;
    use crate::state::{Document, WorldState};
    use tower_lsp::lsp_types::{GotoDefinitionResponse, Position, Url};

    fn fresh_state() -> WorldState {
        let mut state = WorldState::new(vec![]);
        state.workspace_scan_complete = true;
        state
    }

    fn add_doc(state: &mut WorldState, uri: &str, text: &str) -> Url {
        let url = Url::parse(uri).expect("uri");
        state.documents.insert(url.clone(), Document::new(text, None));
        url
    }

    fn loc(result: Option<GotoDefinitionResponse>) -> tower_lsp::lsp_types::Location {
        match result {
            Some(GotoDefinitionResponse::Scalar(l)) => l,
            other => panic!("expected Scalar location, got {:?}", other),
        }
    }

    /// Cmd-click on the RHS of `$` in `foo$bar` finds the constructor-literal
    /// member when `foo <- list(bar = ...)`.
    #[test]
    fn dollar_rhs_constructor_literal_match() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1, baz = 2)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 1 col 9 = `bar` in `foo$bar`
        let pos = Position::new(1, 9);
        let result = goto_definition(&state, &uri, pos);
        let l = loc(result);
        assert_eq!(l.uri, uri);
        assert_eq!(l.range.start.line, 0);
        // `bar = 1` lives at col 12 of `foo <- list(bar = 1, baz = 2)`
        assert_eq!(l.range.start.character, 12);
    }

    /// Cmd-click on the RHS of `$` in `foo$bar` finds the member-assignment
    /// when `foo$bar <- ...` exists in scope.
    #[test]
    fn dollar_rhs_member_assignment_match() {
        let mut state = fresh_state();
        let code = "foo <- list()\nfoo$bar <- 99\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 2 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(2, 8);
        let result = goto_definition(&state, &uri, pos);
        let l = loc(result);
        assert_eq!(l.uri, uri);
        assert_eq!(l.range.start.line, 1);
        // `bar` in `foo$bar <- 99` is at col 4
        assert_eq!(l.range.start.character, 4);
    }

    /// Position-aware tie-break: literal then member-assignment, cursor after both
    /// → member-assignment wins (latest effect position before cursor).
    #[test]
    fn dollar_rhs_literal_then_assignment_assignment_wins() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nfoo$bar <- 99\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(2, 8);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 1, "expected member-assignment on line 1");
    }

    /// Cursor between literal and a later member-assignment → literal wins
    /// (member-assignment's effect position is after the cursor).
    #[test]
    fn dollar_rhs_cursor_between_literal_and_assignment() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nuse(foo$bar)\nfoo$bar <- 99\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 1 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(1, 8);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0, "expected literal on line 0");
        assert_eq!(l.range.start.character, 12);
    }

    /// Regression: cmd-click on `bar` in `foo$bar` does NOT jump to a free
    /// `bar <- ...` when no `foo` is in scope. (This is the bug the user
    /// reported.)
    #[test]
    fn dollar_rhs_no_fallback_to_free_identifier() {
        let mut state = fresh_state();
        let code = "bar <- 1\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 8);
        let result = goto_definition(&state, &uri, pos);
        assert!(
            result.is_none(),
            "expected None — must not fall back to free `bar`",
        );
    }

    /// `@` parity: constructor-literal match.
    #[test]
    fn at_rhs_new_call_constructor_literal() {
        let mut state = fresh_state();
        let code = "foo <- new(\"Cls\", bar = 1)\nuse(foo@bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0);
    }

    /// `@` parity: member-assignment match (`foo@bar <- ...`).
    #[test]
    fn at_rhs_member_assignment() {
        let mut state = fresh_state();
        let code = "foo <- list()\nfoo@bar <- 99\nuse(foo@bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(2, 8);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 1);
    }

    /// `@` parity: no fallback when `foo` is unresolvable.
    #[test]
    fn at_rhs_no_fallback_to_free_identifier() {
        let mut state = fresh_state();
        let code = "bar <- 1\nuse(foo@bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 8);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Chained access `foo$bar$baz` returns None (Step-1 limitation,
    /// documented in the spec).
    #[test]
    fn chained_access_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = list(baz = 1))\nuse(foo$bar$baz)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // cursor on `baz`
        let pos = Position::new(1, 13);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// LHS-shape gate: parenthesized LHS → None.
    #[test]
    fn parenthesized_lhs_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\nuse((foo)$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // cursor on `bar`
        let pos = Position::new(1, 11);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// LHS-shape gate: namespaced LHS → None.
    #[test]
    fn namespace_lhs_returns_none() {
        let mut state = fresh_state();
        let code = "use(pkg::obj$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(0, 13);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// LHS-shape gate: call-result LHS → None.
    #[test]
    fn call_result_lhs_returns_none() {
        let mut state = fresh_state();
        let code = "use(make()$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(0, 11);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Negative: a same-named member of an *unrelated* object must not match.
    #[test]
    fn unrelated_object_does_not_match() {
        let mut state = fresh_state();
        let code = "other <- list(bar = 1)\nfoo <- list()\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // cursor on `bar` in `foo$bar`
        let pos = Position::new(2, 8);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }

    /// Constructor allowlist: `c(bar = 1)` is recognized.
    #[test]
    fn constructor_c_named_arg() {
        let mut state = fresh_state();
        let code = "foo <- c(bar = 1L)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0);
    }

    /// Function-scope isolation: a `foo$bar <- ...` inside an unrelated
    /// function must not match a top-level `foo`.
    #[test]
    fn member_assignment_inside_unrelated_function_does_not_match() {
        let mut state = fresh_state();
        let code = "\
foo <- list()
g <- function() {
  foo <- list()
  foo$bar <- 99
}
use(foo$bar)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 5 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(5, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "must not match `foo$bar <- 99` inside g(); that's a different `foo`",
        );
    }

    /// A `foo$bar <- ...` nested inside the RHS of the *current* `foo`
    /// rebinding bound the previous `foo`, so it must not match.
    #[test]
    fn member_assignment_inside_defining_rhs_does_not_match() {
        let mut state = fresh_state();
        let code = "\
foo <- list()
foo <- { foo$bar <- 1; list() }
use(foo$bar)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 2 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(2, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "must not match `foo$bar <- 1` nested inside the rebinding RHS",
        );
    }

    /// Re-binding `foo` invalidates earlier member-assignments and earlier
    /// constructor literals against the *previous* `foo`.
    #[test]
    fn rebinding_foo_invalidates_earlier_candidates() {
        let mut state = fresh_state();
        let code = "\
foo <- list(bar = 1)
foo$bar <- 99
foo <- list()
use(foo$bar)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 3 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(3, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "must not match candidates that bound an earlier `foo`",
        );
    }

    /// Cross-file regression: the defining `foo <- list(bar = 1)` lives in
    /// `helpers.R`, sourced from the cursor's file. Goto-def must resolve to a
    /// `Location` whose `uri` is the *defining* document, exercising the
    /// `same_file = false` branch in `pick_winner`.
    #[test]
    fn dollar_rhs_cross_file_resolves_to_defining_uri() {
        let mut state = fresh_state();

        let main_code = "source(\"helpers.R\")\nuse(foo$bar)\n";
        let helpers_code = "foo <- list(bar = 1)\n";

        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_doc(&mut state, "file:///workspace/helpers.R", helpers_code);

        // Wire up the cross-file graph so `source("helpers.R")` is resolved.
        state.cross_file_graph.update_file(
            &main_uri,
            &crate::cross_file::extract_metadata(main_code),
            None,
            |_| None,
        );
        state.cross_file_graph.update_file(
            &helpers_uri,
            &crate::cross_file::extract_metadata(helpers_code),
            None,
            |_| None,
        );

        // Cursor on `bar` in `foo$bar` (line 1, col 8 in main.R).
        let pos = Position::new(1, 8);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(l.uri, helpers_uri, "must resolve to the defining document");
        assert_eq!(l.range.start.line, 0);
        // `bar = 1` lives at col 12 of `foo <- list(bar = 1)`.
        assert_eq!(l.range.start.character, 12);
    }

    /// UTF-16 regression: a non-BMP character (🦀, 4 bytes / 2 UTF-16 units)
    /// precedes the `bar` token on the defining line, so byte-column ≠
    /// UTF-16-column. Confirms `EffectPos` / `node_range_in_text` correctly
    /// convert tree-sitter byte offsets into UTF-16 LSP columns.
    #[test]
    fn dollar_rhs_utf16_non_bmp_on_defining_line() {
        let mut state = fresh_state();
        // `foo <- list("🦀", bar = 1)` — `🦀` sits before `bar`.
        // Byte offsets: `foo <- list("` = 13, `🦀` = +4 bytes, `", ` = +3,
        //   so `bar` starts at byte 20.
        // UTF-16 cols:  13 + 2 + 3 = 18.
        let code = "foo <- list(\"🦀\", bar = 1)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // Cursor on `bar` in `foo$bar` (line 1 has no non-BMP chars, so col 9).
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.uri, uri);
        assert_eq!(l.range.start.line, 0);
        assert_eq!(
            l.range.start.character, 18,
            "expected UTF-16 column of `bar` after the non-BMP `🦀` literal"
        );
    }

    /// Non-allowlisted constructor: arbitrary `make_thing(bar = 1)` is not
    /// resolved, returns None (we cannot know its semantics).
    #[test]
    fn non_allowlisted_constructor_returns_none() {
        let mut state = fresh_state();
        let code = "foo <- make_thing(bar = 1)\nuse(foo$bar)\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        let pos = Position::new(1, 9);
        assert!(goto_definition(&state, &uri, pos).is_none());
    }
}

