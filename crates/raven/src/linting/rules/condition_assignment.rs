//! Flag `=` used as a binary operator inside `if` / `while` conditions.
//!
//! In R, `=` inside an `if` or `while` condition is a syntax error at runtime:
//!
//! ```text
//! > if (x = 1) print(x)
//! Error: unexpected '=' in "if (x ="
//! ```
//!
//! tree-sitter-r's grammar accepts it silently (it treats `=` as an assignment
//! binary operator), so Raven would otherwise emit no diagnostic. This rule
//! fills the gap: when `=` appears as the operator of a `binary_operator` node
//! directly inside the condition of an `if_statement` or `while_statement`, it
//! reports the `=` with a suggestion to use `==` (equality) or `<-`
//! (assignment).
//!
//! **Scope:** the condition field of `if_statement` and `while_statement`
//! nodes only. Recursion stops at function-call / subset boundaries so that
//! named-argument `=` inside a call within the condition (`if (f(x = 1) > 0)`)
//! is never flagged.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use tree_sitter::Node;

use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::linting::LINT_SOURCE;
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
    if matches!(node.kind(), "if_statement" | "while_statement") {
        if let Some(cond) = node.child_by_field_name("condition") {
            scan_condition(cond, text, severity, suppressions, out);
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, severity, suppressions, out);
    }
}

fn scan_condition(
    node: Node<'_>,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    // Stop at call/subset boundaries — named-argument `=` is intentional.
    // Stop at parenthesized_expression — `(x = 1)` is a valid R assignment
    // expression that evaluates to its value; `if ((x = 1))` is legal.
    // Stop at braced_expression — `{ x = 1; x > 0 }` is a block, not a
    // simple condition; assignments inside it are not the if/while condition.
    if matches!(
        node.kind(),
        "call" | "subset" | "subset2" | "parenthesized_expression" | "braced_expression"
    ) {
        return;
    }
    if node.kind() == "binary_operator" {
        if let Some(op) = node.child_by_field_name("operator") {
            let op_text = text.get(op.start_byte()..op.end_byte()).unwrap_or("");
            if op_text == "=" {
                emit(op, text, severity, suppressions, out);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        scan_condition(child, text, severity, suppressions, out);
    }
}

fn emit(
    op: Node<'_>,
    text: &str,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let line_no = op.start_position().row as u32;
    if suppressions.is_suppressed(line_no) {
        return;
    }
    let line_text = text.lines().nth(line_no as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line_text, op.start_position().column);
    let end_col = byte_offset_to_utf16_column(line_text, op.end_position().column);
    out.push(Diagnostic {
        range: Range {
            start: Position::new(line_no, start_col),
            end: Position::new(op.end_position().row as u32, end_col),
        },
        severity: Some(severity),
        source: Some(LINT_SOURCE.to_string()),
        code: Some(NumberOrString::String(
            rule_ids::CONDITION_ASSIGNMENT.to_string(),
        )),
        message: "Use `==` to test equality; `=` is not valid in R conditions. \
                  For assignment use `<-`."
            .to_string(),
        ..Default::default()
    });
}
