//! Flag identifier names longer than the configured maximum.
//!
//! Mirrors `lintr::object_length_linter`. Length is measured in characters
//! after stripping the same decorative leading-dot that `object_name` accepts
//! ("hidden identifier" convention). Backtick-quoted names and non-ASCII
//! identifiers are skipped — matching `object_name`'s carve-outs.
//!
//! Only positions that introduce a new symbol are checked:
//! assignment targets (`<-`, `<<-`, top-level `=`, `->`, `->>`) and formal
//! parameters of `function_definition`. Compound assignment targets like
//! `obj$field <- ...` are skipped (the assignment doesn't introduce a new
//! symbol name — only the LHS field does, and `object_name` already won't
//! flag those for the same reason).

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range};
use tree_sitter::Node;

use crate::linting::nolint::Suppressions;
use crate::linting::LINT_SOURCE;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    max_length: u32,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    visit(root, text, max_length, severity, suppressions, out);
}

fn visit(
    node: Node<'_>,
    text: &str,
    max_length: u32,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    match node.kind() {
        "binary_operator" => check_assignment(node, text, max_length, severity, suppressions, out),
        "function_definition" => check_parameters(node, text, max_length, severity, suppressions, out),
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, max_length, severity, suppressions, out);
    }
}

fn check_assignment(
    node: Node<'_>,
    text: &str,
    max_length: u32,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let Some(op) = node.child_by_field_name("operator") else {
        return;
    };
    let op_text = text.get(op.start_byte()..op.end_byte()).unwrap_or("");
    let target = match op_text {
        "<-" | "<<-" | "=" => node.child_by_field_name("lhs"),
        "->" | "->>" => node.child_by_field_name("rhs"),
        _ => return,
    };
    // Note: tree-sitter-r parses `f(name = value)` as an `argument` node
    // whose `=` is an internal token, not as a `binary_operator`. So named
    // arguments never reach this branch and need no explicit guard.
    let Some(target) = target else {
        return;
    };
    if target.kind() != "identifier" {
        return;
    }
    let name = text.get(target.start_byte()..target.end_byte()).unwrap_or("");
    check_name(target, name, max_length, text, severity, suppressions, out);
}

fn check_parameters(
    node: Node<'_>,
    text: &str,
    max_length: u32,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let Some(params) = node.child_by_field_name("parameters") else {
        return;
    };
    let mut cursor = params.walk();
    for child in params.children(&mut cursor) {
        // Tree-sitter-r exposes formal parameters as `parameter` nodes (whether
        // or not they carry a default value), so this is the only kind we
        // need to match. The `dots` token (`...`) is not a user-chosen name.
        if child.kind() != "parameter" {
            continue;
        }
        let Some(ident) = child.child_by_field_name("name") else {
            continue;
        };
        if ident.kind() != "identifier" {
            continue;
        }
        let name = text.get(ident.start_byte()..ident.end_byte()).unwrap_or("");
        check_name(ident, name, max_length, text, severity, suppressions, out);
    }
}

fn check_name(
    name_node: Node<'_>,
    name: &str,
    max_length: u32,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if name.is_empty() || should_skip_name(name) {
        return;
    }
    // Strip the optional leading `.` (hidden identifier convention) before
    // measuring, matching `object_name`'s carve-out.
    let body = match name.strip_prefix('.') {
        Some(rest) if !rest.starts_with('.') && !rest.is_empty() => rest,
        Some(_) => name,
        None => name,
    };
    let len = body.chars().count() as u32;
    if len <= max_length {
        return;
    }
    let line_no = name_node.start_position().row as u32;
    if suppressions.is_suppressed(line_no) {
        return;
    }
    let line_text = text.lines().nth(line_no as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line_text, name_node.start_position().column);
    let end_col = byte_offset_to_utf16_column(line_text, name_node.end_position().column);
    out.push(Diagnostic {
        range: Range {
            start: Position::new(line_no, start_col),
            end: Position::new(name_node.end_position().row as u32, end_col),
        },
        severity: Some(severity),
        source: Some(LINT_SOURCE.to_string()),
        message: format!(
            "Identifier `{name}` is {len} characters long; maximum is {max_length}."
        ),
        ..Default::default()
    });
}

fn should_skip_name(name: &str) -> bool {
    if name.starts_with('`') {
        return true;
    }
    if !name.is_ascii() {
        return true;
    }
    false
}
