//! Resolve go-to-definition for the RHS identifier of `$` and `@`.
//!
//! See `docs/superpowers/specs/2026-05-02-dollar-rhs-goto-def-design.md`.
//!
//! For `foo$bar` (or `foo@bar`) where the cursor is on `bar`:
//!
//! 1. Resolve `foo` via the existing position-aware scope.
//! 2. Collect candidates from the defining file and the cursor's cross-file
//!    neighborhood:
//!    - **Defining file**: `foo$bar <- ...` member-assignments and any
//!      constructor-call named argument from the allowlist. Filtered by
//!      same-function-scope and "effect position at or after the binding".
//!    - **Every non-defining file in the cursor's cross-file neighborhood**:
//!      each `foo$bar <- ...` site is validated by re-resolving `foo` at
//!      that site's position via cross-file scope; only sites where `foo`
//!      resolves to the *same* binding are kept. This handles both the common
//!      "skeleton object defined in helpers.R, members attached in main.R"
//!      pattern and intermediate-file attachments in longer `source()` chains.
//! 3. Tie-break: `pick_winner` partitions all candidates by whether their
//!    `uri` equals the cursor's. The in-cursor-file partition is filtered
//!    by `effect <= cursor`, then the candidate with the latest effect
//!    wins. If no in-cursor-file candidate qualifies, the other-file
//!    partition's max-effect candidate wins as a fallback.
//!
//!    In the **same-file case** (cursor file = defining file), defining-file
//!    candidates live in the cursor partition and are filtered by
//!    `effect <= cursor`. Non-defining neighborhood candidates can still be
//!    used as a fallback if no cursor-file candidate qualifies.
//! 4. Never fall back to free-identifier lookup.

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
    /// File the candidate lives in. For defining-file candidates this is
    /// `defining_uri`; for cross-file candidates this is the file containing
    /// the validated member-assignment site.
    uri: Url,
    effect: EffectPos,
    name_range: Range,
    /// `None` for top-level, else the `function_definition` node id of the
    /// closest enclosing function scope. Tree-local — only meaningful when
    /// comparing candidates collected from the *same* tree (i.e. defining
    /// file vs the binding's `symbol_fn_scope`). For non-defining-file
    /// candidates this is recorded but unused (a per-site scope-resolve
    /// replaces the `fn_scope` correctness gate across files).
    fn_scope: FunctionScopeId,
    /// Position of the LHS identifier (`foo` in `foo$bar <- ...`). Used as
    /// the query position when re-resolving `foo` for non-defining-file
    /// candidates; ignored for defining-file candidates.
    lhs_pos: Position,
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
    let cursor_uri = uri.clone();

    // Phase 1: collect from the defining file. Tree-local correctness gates
    // (`fn_scope`, `effect_at_or_after`) apply because all candidates and
    // the resolved `foo` come from the same AST.
    let mut defining_candidates: Vec<Candidate> = Vec::new();
    {
        let (defining_text, defining_tree) =
            crate::parameter_resolver::get_text_and_tree(state, &defining_uri)?;
        let symbol_fn_scope = function_scope_at(
            &defining_tree,
            &defining_text,
            symbol.defined_line,
            symbol.defined_column,
        );
        // A symbol's *visible-from* position is the end of its defining
        // assignment, not the position of the LHS identifier — so a member
        // assignment that occurs inside the RHS of `foo <- {...}` was binding
        // the *previous* `foo` and must not match the new one. Falls back to
        // the LHS anchor for non-assignment-defined symbols (parameters,
        // for-variables, declared symbols).
        let symbol_effect = symbol_visible_from_position(
            &defining_tree,
            &defining_text,
            symbol.defined_line,
            symbol.defined_column,
            lhs_name,
        );

        collect_member_assignments(
            defining_tree.root_node(),
            &defining_text,
            &defining_uri,
            lhs_name,
            rhs_name,
            op,
            &mut defining_candidates,
        );
        if let Some(c) = collect_constructor_candidate(
            &defining_tree,
            &defining_text,
            &defining_uri,
            symbol.defined_line,
            symbol.defined_column,
            lhs_name,
            rhs_name,
        ) {
            defining_candidates.push(c);
        }

        defining_candidates.retain(|c| {
            c.fn_scope == symbol_fn_scope && effect_at_or_after(c.effect, symbol_effect)
        });
    }

    // Phase 2: collect from every non-defining file in the cursor's cross-file
    // neighborhood. Tree-local IDs are not comparable to those in the defining
    // tree, so we replace the `fn_scope` gate with a per-site scope-resolve:
    // at the LHS identifier's position, does `foo` resolve to the *same*
    // binding we navigated from?
    let mut cross_file_candidates: Vec<Candidate> = Vec::new();
    let mut scanned_uris = state.cross_file_graph.collect_neighborhood(
        &cursor_uri,
        state.cross_file_config.max_chain_depth,
        state.cross_file_config.max_transitive_dependents_visited,
    );
    scanned_uris.insert(cursor_uri.clone());
    scanned_uris.remove(&defining_uri);
    let mut scanned_uris: Vec<Url> = scanned_uris.into_iter().collect();
    scanned_uris.sort_by(|a, b| a.as_str().cmp(b.as_str()));

    for candidate_uri in scanned_uris {
        if let Some((candidate_text, candidate_tree)) =
            crate::parameter_resolver::get_text_and_tree(state, &candidate_uri)
        {
            collect_member_assignments(
                candidate_tree.root_node(),
                &candidate_text,
                &candidate_uri,
                lhs_name,
                rhs_name,
                op,
                &mut cross_file_candidates,
            );
        }
    }
    cross_file_candidates.retain(|c| candidate_lhs_matches_symbol(state, c, lhs_name, symbol));

    let mut all_candidates = defining_candidates;
    all_candidates.extend(cross_file_candidates);
    pick_winner(all_candidates, &cursor_uri, position).map(|c| Location {
        uri: c.uri,
        range: c.name_range,
    })
}

/// Re-resolve `lhs_name` at the candidate's LHS-identifier position via the
/// position-aware cross-file scope, and check it points to the same binding
/// as the one the user navigated from. This is the cross-file replacement
/// for the same-tree `fn_scope` gate: it correctly excludes candidates inside
/// unrelated function bodies (where `foo` shadows the imported one) and
/// candidates appearing before the import is in scope.
fn candidate_lhs_matches_symbol(
    state: &WorldState,
    c: &Candidate,
    lhs_name: &str,
    symbol: &crate::cross_file::scope::ScopedSymbol,
) -> bool {
    let scope = crate::handlers::get_cross_file_scope(
        state,
        &c.uri,
        c.lhs_pos.line,
        c.lhs_pos.character,
        &DiagCancelToken::never(),
    );
    scope
        .symbols
        .get(lhs_name)
        .map(|s| s == symbol)
        .unwrap_or(false)
}

fn effect_at_or_after(a: EffectPos, b: EffectPos) -> bool {
    (a.line, a.utf16_column) >= (b.line, b.utf16_column)
}

/// Pick the best candidate.
///
/// Partitions by `uri`: candidates in the cursor's own file always beat
/// candidates in any other file. When the user is in `main.R` and there's
/// a `foo$bar <- ...` right above the cursor, that's almost always what
/// they meant — even if `helpers.R` (where `foo` was defined) has its own
/// `foo$bar <- ...` somewhere.
///
/// Among cursor-file candidates, filter to those whose effect position is
/// at-or-before the cursor (you can't "see" an assignment that hasn't
/// happened yet) and pick the one with the latest effect position.
///
/// If no cursor-file candidate qualifies, fall back to the non-cursor-file
/// candidate with the latest effect position. Effect positions across
/// different non-cursor files are not directly comparable; if that becomes
/// observable, prefer candidates whose file is closer to the cursor in the
/// dependency graph.
fn pick_winner(
    candidates: Vec<Candidate>,
    cursor_uri: &Url,
    cursor: Position,
) -> Option<Candidate> {
    let (mut in_cursor_file, other): (Vec<_>, Vec<_>) =
        candidates.into_iter().partition(|c| &c.uri == cursor_uri);
    // Cursor file: filter to effect <= cursor (unit-consistent UTF-16 cmp).
    in_cursor_file
        .retain(|c| (c.effect.line, c.effect.utf16_column) <= (cursor.line, cursor.character));
    if let Some(c) = in_cursor_file
        .into_iter()
        .max_by_key(|c| (c.effect.line, c.effect.utf16_column))
    {
        return Some(c);
    }
    other
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
    let Some(line_text) = nth_line(text, defined_line as usize) else {
        return fallback;
    };
    let byte_col = utf16_column_to_byte_offset(line_text, defined_column_utf16);
    let line_byte_len = line_text.len();
    let start = tree_sitter::Point::new(defined_line as usize, byte_col);
    let end = tree_sitter::Point::new(defined_line as usize, (byte_col + 1).min(line_byte_len));
    let Some(id_node) = tree.root_node().descendant_for_point_range(start, end) else {
        return fallback;
    };
    let Some(assignment) = ascend_to_assignment_for(id_node, text, lhs_name) else {
        return fallback;
    };
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
/// is `extract_operator` matching `(lhs_name, op, rhs_name)`. Each candidate
/// records the position of its LHS identifier (`foo` in `foo$bar <- ...`)
/// for use as a query position when validating cross-file candidates.
fn collect_member_assignments(
    root: Node,
    text: &str,
    file_uri: &Url,
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
        let Some(op_node) = node.child_by_field_name("operator") else {
            continue;
        };
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
        let Some(target_op) = target.child_by_field_name("operator") else {
            continue;
        };
        let target_op_kind = match (target_op.kind(), op) {
            ("$", ExtractOp::Dollar) => true,
            ("@", ExtractOp::At) => true,
            _ => false,
        };
        if !target_op_kind {
            continue;
        }
        let Some(t_lhs) = target.child_by_field_name("lhs") else {
            continue;
        };
        let Some(t_rhs) = target.child_by_field_name("rhs") else {
            continue;
        };
        if t_lhs.kind() != "identifier" || t_rhs.kind() != "identifier" {
            continue;
        }
        if node_text(t_lhs, text) != lhs_name || node_text(t_rhs, text) != rhs_name {
            continue;
        }
        let lhs_range = node_range_in_text(t_lhs, text);
        out.push(Candidate {
            uri: file_uri.clone(),
            effect: EffectPos::from_node_end(node, text),
            name_range: node_range_in_text(t_rhs, text),
            fn_scope: enclosing_function_id(node),
            lhs_pos: lhs_range.start,
        });
    }
}

/// If the assignment that defines `lhs_name` at `(defined_line, defined_col)`
/// has a constructor-call RHS in the allowlist, return a candidate for the
/// named argument matching `rhs_name`.
///
/// We use the position only as a hint to find the *intended* defining
/// assignment — convert `defined_column_utf16` to a byte offset and descend
/// to the smallest node containing `(defined_line, byte_col .. byte_col+1)`
/// (a 1-byte-wide range, since a zero-width range at the very start of the
/// line does not reliably descend into a leaf), then ascend to the enclosing
/// `binary_operator` whose target identifier matches `lhs_name`. R
/// identifiers are ASCII (`[A-Za-z_.][A-Za-z0-9_.]*`) so a 1-byte step is
/// always inside the identifier.
fn collect_constructor_candidate(
    tree: &Tree,
    text: &str,
    file_uri: &Url,
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
        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };
        if name_node.kind() != "identifier" {
            continue;
        }
        if node_text(name_node, text) != rhs_name {
            continue;
        }
        // Constructor candidates always live in the defining file. The
        // `lhs_pos` field is unused for them (cross-file scope-check only
        // applies to non-defining-file member-assignment candidates), so we
        // anchor it at the constructor's named-arg position.
        let name_range = node_range_in_text(name_node, text);
        return Some(Candidate {
            uri: file_uri.clone(),
            effect: EffectPos::from_node_end(assignment, text),
            name_range,
            fn_scope: enclosing_function_id(assignment),
            lhs_pos: name_range.start,
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

/// Return the n-th line of `text`, with any trailing `\r` stripped.
///
/// Uses `lines()` (not `split('\n')`) so CRLF line endings produce the same
/// `\r`-stripped slice that the rest of the codebase (e.g. `LineIndex`) sees.
/// Tree-sitter byte columns are measured against the unstripped buffer, but
/// any byte offset *before* the trailing `\r` is unaffected by the strip, so
/// converting via `byte_offset_to_utf16_column` against the stripped slice is
/// safe and consistent.
fn nth_line(text: &str, n: usize) -> Option<&str> {
    text.lines().nth(n)
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
        state
            .documents
            .insert(url.clone(), Document::new(text, None));
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
        assert_eq!(
            l.range.start.line, 1,
            "expected member-assignment on line 1"
        );
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

    /// Helper: wire up a two-file workspace with `source()` from `main.R` to
    /// `helpers.R`, returning both URIs.
    fn setup_two_file_workspace(
        state: &mut WorldState,
        main_code: &str,
        helpers_code: &str,
    ) -> (Url, Url) {
        let main_uri = add_doc(state, "file:///workspace/main.R", main_code);
        let helpers_uri = add_doc(state, "file:///workspace/helpers.R", helpers_code);
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
        (main_uri, helpers_uri)
    }

    /// The "skeleton-and-attach" pattern: `foo` is defined as an empty
    /// `list()` in `helpers.R`, and a member is attached in `main.R`. Cmd-click
    /// on `$bar` in `print(foo$bar)` (also in `main.R`) must resolve to the
    /// `foo$bar <- 1` line in `main.R`, NOT return None.
    #[test]
    fn dollar_rhs_member_assignment_in_cursor_file_cross_file_foo() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo$bar <- 1
print(foo$bar)
";
        let helpers_code = "foo <- list()\n";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        // line 2 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(l.uri, main_uri, "must resolve to the cursor's own file");
        assert_eq!(l.range.start.line, 1, "expected `foo$bar <- 1` on line 1");
        // `bar` in `foo$bar <- 1` is at col 4.
        assert_eq!(l.range.start.character, 4);
    }

    /// Same as above but using `@`-slot assignment.
    #[test]
    fn at_rhs_member_assignment_in_cursor_file_cross_file_foo() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo@bar <- 1
print(foo@bar)
";
        let helpers_code = "foo <- list()\n";
        let (main_uri, _helpers_uri) =
            setup_two_file_workspace(&mut state, main_code, helpers_code);

        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(l.uri, main_uri);
        assert_eq!(l.range.start.line, 1);
    }

    /// Cursor-file candidate beats defining-file candidate: prefer the local
    /// member-assignment over a constructor literal in the imported file.
    #[test]
    fn cursor_file_member_assignment_beats_defining_file_constructor() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
foo$bar <- 99
print(foo$bar)
";
        let helpers_code = "foo <- list(bar = 1)\n";
        let (main_uri, _) = setup_two_file_workspace(&mut state, main_code, helpers_code);

        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(
            l.uri, main_uri,
            "cursor-file candidate should win over defining-file candidate"
        );
        assert_eq!(l.range.start.line, 1);
    }

    /// Negative: `foo$bar <- 99` inside an unrelated function in the cursor
    /// file (where `foo` is shadowed by a local) must NOT match. The per-site
    /// scope-resolve should reject it because `foo` there resolves to the
    /// local, not the imported one.
    #[test]
    fn cursor_file_member_assignment_in_shadowing_function_does_not_match() {
        let mut state = fresh_state();
        let main_code = "\
source(\"helpers.R\")
g <- function() {
  foo <- list()
  foo$bar <- 99
}
print(foo$bar)
";
        let helpers_code = "foo <- list(bar = 1)\n";
        let (main_uri, helpers_uri) = setup_two_file_workspace(&mut state, main_code, helpers_code);

        // line 5 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(5, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        // The cursor-file `foo$bar <- 99` lives inside g(), where `foo` is a
        // local (different binding) — so it must NOT win. The defining-file
        // constructor literal is the correct fallback.
        assert_eq!(
            l.uri, helpers_uri,
            "must not jump to shadowed `foo$bar <- 99` inside g()"
        );
        assert_eq!(l.range.start.line, 0);
    }

    /// Negative: `foo$bar <- 99` in the cursor file appears *before* the
    /// `source()` that brings `foo` into scope. The per-site scope-resolve at
    /// the assignment site sees no `foo` (the import hasn't happened yet) and
    /// must reject the candidate.
    #[test]
    fn cursor_file_member_assignment_before_source_does_not_match() {
        let mut state = fresh_state();
        let main_code = "\
foo$bar <- 99
source(\"helpers.R\")
print(foo$bar)
";
        let helpers_code = "foo <- list(bar = 1)\n";
        let (main_uri, helpers_uri) = setup_two_file_workspace(&mut state, main_code, helpers_code);

        // line 2 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(2, 10);
        let l = loc(goto_definition(&state, &main_uri, pos));
        // Cursor-file candidate is rejected by per-site scope-check; defining
        // file's constructor literal wins.
        assert_eq!(l.uri, helpers_uri);
        assert_eq!(l.range.start.line, 0);
    }

    /// CRLF regression: with `\r\n` line endings, position columns must
    /// remain correct (no off-by-one). The resolved range should match the
    /// LF-equivalent test exactly.
    #[test]
    fn dollar_rhs_crlf_line_endings_preserve_columns() {
        let mut state = fresh_state();
        let code = "foo <- list(bar = 1)\r\nuse(foo$bar)\r\n";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 1 col 9 = `bar` in `foo$bar`
        let pos = Position::new(1, 9);
        let l = loc(goto_definition(&state, &uri, pos));
        assert_eq!(l.range.start.line, 0);
        assert_eq!(
            l.range.start.character, 12,
            "CRLF should not shift the resolved column"
        );
    }

    /// Multiple imports of the same name from different sourced files: pin
    /// the deterministic "first source() wins" behavior. Cross-file scope
    /// merging uses `entry(name).or_insert(symbol)`, so whichever sourced
    /// file the timeline visits first owns `foo`, and qualified resolution
    /// follows that into its defining file. A regression that flipped to
    /// last-wins (or non-deterministic) would silently change which file
    /// cmd-click jumps into.
    #[test]
    fn dollar_rhs_multiple_imports_first_source_wins() {
        let mut state = fresh_state();
        let main_code = "\
source(\"a.R\")
source(\"b.R\")
use(foo$bar)
";
        let a_code = "foo <- list(bar = 1)\n";
        let b_code = "foo <- list(bar = 999)\n";

        let main_uri = add_doc(&mut state, "file:///workspace/main.R", main_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);

        for (uri, code) in [(&main_uri, main_code), (&a_uri, a_code), (&b_uri, b_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 2 col 8 = `bar` in `use(foo$bar)`
        let pos = Position::new(2, 8);
        let l = loc(goto_definition(&state, &main_uri, pos));
        assert_eq!(
            l.uri, a_uri,
            "first-sourced file (`a.R`) should win — `or_insert` in scope merging",
        );
        assert_ne!(
            l.uri, b_uri,
            "second-sourced file (`b.R`) must NOT win under or_insert semantics",
        );
        assert_eq!(l.range.start.line, 0);
        // `bar = 1` lives at col 12 of `foo <- list(bar = 1)`.
        assert_eq!(l.range.start.character, 12);
    }

    /// `foo` is defined in `a.R`, `foo$bar <- 1` lives in the middle file
    /// `b.R`, and the cursor is in `c.R`. The connected-component scan must
    /// find the b.R member assignment even though it is neither the cursor
    /// file nor the defining file.
    #[test]
    fn dollar_rhs_third_file_member_assignment_resolves_to_intermediate_file() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "\
source(\"a.R\")
foo$bar <- 1
";
        let a_code = "foo <- list()\n";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);

        for (uri, code) in [(&c_uri, c_code), (&b_uri, b_code), (&a_uri, a_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        let l = loc(goto_definition(&state, &c_uri, pos));
        assert_eq!(l.uri, b_uri, "must resolve to the intermediate file");
        assert_eq!(l.range.start.line, 1);
        assert_eq!(l.range.start.character, 4);
    }

    /// Negative: the connected-component scan sees `b.R`, but the only
    /// `foo$bar <- 99` candidate there is inside a function where `foo` is
    /// shadowed. The per-site scope-resolve must reject it.
    #[test]
    fn dollar_rhs_third_file_shadowed_assignment_does_not_match() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "\
source(\"a.R\")
g <- function() {
  foo <- list()
  foo$bar <- 99
}
";
        let a_code = "foo <- list()\n";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);

        for (uri, code) in [(&c_uri, c_code), (&b_uri, b_code), (&a_uri, a_code)] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        assert!(
            goto_definition(&state, &c_uri, pos).is_none(),
            "must not match `foo$bar <- 99` inside g(); that's a different `foo`",
        );
    }

    /// Negative: a matching-looking `foo$bar <- 99` in a document outside the
    /// cursor's cross-file connected component is not scanned.
    #[test]
    fn dollar_rhs_member_assignment_outside_connected_component_does_not_match() {
        let mut state = fresh_state();

        let c_code = "\
source(\"b.R\")
print(foo$bar)
";
        let b_code = "source(\"a.R\")\n";
        let a_code = "foo <- list()\n";
        let unrelated_code = "\
foo <- list()
foo$bar <- 99
";

        let c_uri = add_doc(&mut state, "file:///workspace/c.R", c_code);
        let b_uri = add_doc(&mut state, "file:///workspace/b.R", b_code);
        let a_uri = add_doc(&mut state, "file:///workspace/a.R", a_code);
        let unrelated_uri = add_doc(&mut state, "file:///workspace/unrelated.R", unrelated_code);

        for (uri, code) in [
            (&c_uri, c_code),
            (&b_uri, b_code),
            (&a_uri, a_code),
            (&unrelated_uri, unrelated_code),
        ] {
            state.cross_file_graph.update_file(
                uri,
                &crate::cross_file::extract_metadata(code),
                None,
                |_| None,
            );
        }

        // line 1 col 10 = `bar` in `print(foo$bar)`
        let pos = Position::new(1, 10);
        assert!(
            goto_definition(&state, &c_uri, pos).is_none(),
            "must not scan unrelated.R outside c.R's connected component",
        );
    }

    /// Chained-LHS rejection: `collect_member_assignments` requires the
    /// extract's LHS to be a bare identifier, so `foo$inner$bar <- 99` is
    /// silently skipped. With the cursor on `inner` in `foo$inner`, today's
    /// behavior is `None` — we don't treat the chained assignment as a
    /// definition of `foo$inner`. Pin this so a future relaxation that
    /// recognizes the deeper LHS as also defining `foo$inner` has a clear
    /// breaking point.
    #[test]
    fn chained_lhs_member_assignment_not_collected() {
        let mut state = fresh_state();
        let code = "\
foo <- list()
foo$inner$bar <- 99
use(foo$inner)
";
        let uri = add_doc(&mut state, "file:///t.R", code);
        // line 2 col 8 = `inner` in `use(foo$inner)`
        let pos = Position::new(2, 8);
        assert!(
            goto_definition(&state, &uri, pos).is_none(),
            "chained `foo$inner$bar <- 99` (outer extract's LHS is itself \
             an extract, not a bare identifier) must not be collected as a \
             candidate for `foo$inner`",
        );
    }
}
