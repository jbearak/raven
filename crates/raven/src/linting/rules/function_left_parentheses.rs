//! Flag whitespace between `function` (or `\`) and its parameter `(`.
//!
//! Mirrors `lintr::function_left_parentheses_linter`. `function (x) ...` and
//! `\ (x) ...` are valid R but the tight `function(x) ...` / `\(x) ...` is
//! the community convention. Tree-sitter-r exposes both forms as
//! `function_definition` with a `name` field holding the `function` keyword
//! (or `\`) and a `parameters` field holding the `(...)` block.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use tree_sitter::Node;

use crate::linting::LINT_SOURCE;
use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    visit(root, text, severity, suppressions, out);
}

fn visit(
    node: Node<'_>,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if node.kind() == "function_definition" {
        check(node, text, severity, suppressions, out);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, severity, suppressions, out);
    }
}

fn check(
    node: Node<'_>,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let Some(params) = node.child_by_field_name("parameters") else {
        return;
    };
    let gap_start = name.end_byte();
    let gap_end = params.start_byte();
    if gap_end <= gap_start {
        return;
    }
    let gap = match text.get(gap_start..gap_end) {
        Some(s) => s,
        None => return,
    };
    if gap.is_empty() {
        return;
    }
    // Any whitespace at all (spaces, tabs, or even newlines) is reported —
    // the rule wants tight `function(`. Use the slice contents rather than a
    // separate "any non-whitespace" check because a non-empty gap that's not
    // whitespace would be a parse anomaly we shouldn't pretend to handle.
    if !gap.chars().all(|c| c.is_whitespace()) {
        return;
    }
    let keyword = text
        .get(name.start_byte()..name.end_byte())
        .unwrap_or("function");
    let line_no = name.end_position().row as u32;
    if suppressions.is_suppressed_code(line_no, rule_ids::FUNCTION_LEFT_PARENTHESES) {
        return;
    }
    let line_text = text.lines().nth(line_no as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line_text, name.end_position().column);
    let end_line = params.start_position().row as u32;
    let end_line_text = text.lines().nth(end_line as usize).unwrap_or("");
    let end_col = byte_offset_to_utf16_column(end_line_text, params.start_position().column);
    out.push(Diagnostic {
        range: Range {
            start: Position::new(line_no, start_col),
            end: Position::new(end_line, end_col),
        },
        severity: Some(severity),
        source: Some(LINT_SOURCE.to_string()),
        code: Some(NumberOrString::String(
            rule_ids::FUNCTION_LEFT_PARENTHESES.to_string(),
        )),
        message: format!("Remove whitespace between `{keyword}` and `(`."),
        ..Default::default()
    });
}
