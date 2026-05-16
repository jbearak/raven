//! Flag `&` / `&&` mixed with `|` / `||` in the same expression without
//! explicit parentheses.
//!
//! In R `&` binds more tightly than `|` (and `&&` more tightly than `||`), so
//! `a & b | c` is always `(a & b) | c`. Writers who intend the alternative
//! grouping — `a & (b | c)` — need explicit parentheses; without them the
//! expression silently does the wrong thing. Flagging the mix encourages the
//! author to make the intended precedence explicit.
//!
//! **Detection rule:** a `|` / `||` binary_operator node whose immediate
//! left-hand or right-hand operand is itself a bare `&` / `&&`
//! binary_operator (i.e. not wrapped in a `parenthesized_expression`) is
//! flagged. The diagnostic is placed on the `|` / `||` operator token.
//!
//! **Scope:** the entire AST — the check is not limited to `if`/`while`
//! conditions because the precedence surprise applies everywhere. Mirroring
//! lintr's `outer_negation_linter` / Sight's MIXED_LOGICAL_OPERATORS (6004).

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
    // Stop at call/subset boundaries — vectorized data-mask patterns like
    // `dplyr::filter(df, a | b & c)` are intentional.
    if matches!(node.kind(), "call" | "subset" | "subset2") {
        return;
    }
    if node.kind() == "binary_operator" {
        if let Some(op) = node.child_by_field_name("operator") {
            let op_text = text.get(op.start_byte()..op.end_byte()).unwrap_or("");
            if matches!(op_text, "|" | "||") {
                let lhs = node.child_by_field_name("lhs");
                let rhs = node.child_by_field_name("rhs");
                let lhs_bare = lhs.is_some_and(|n| is_bare_and(n, text));
                let rhs_bare = rhs.is_some_and(|n| is_bare_and(n, text));
                if lhs_bare || rhs_bare {
                    let and_node = if lhs_bare { lhs.unwrap() } else { rhs.unwrap() };
                    let and_op_text = and_node
                        .child_by_field_name("operator")
                        .and_then(|n| text.get(n.start_byte()..n.end_byte()))
                        .unwrap_or("&");
                    emit(op, op_text, and_op_text, text, severity, suppressions, out);
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, severity, suppressions, out);
    }
}

/// Returns `true` if `node` is a `binary_operator` whose operator is `&` or
/// `&&` and is not wrapped in a `parenthesized_expression`.
fn is_bare_and(node: Node<'_>, text: &str) -> bool {
    if node.kind() != "binary_operator" {
        return false;
    }
    node.child_by_field_name("operator").is_some_and(|op| {
        matches!(
            text.get(op.start_byte()..op.end_byte()).unwrap_or(""),
            "&" | "&&"
        )
    })
}

fn emit(
    op: Node<'_>,
    op_text: &str,
    and_op: &str,
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
        code: Some(NumberOrString::String(rule_ids::MIXED_LOGICAL.to_string())),
        message: format!(
            "Mixed `{and_op}` and `{op_text}` without parentheses; `{and_op}` binds \
             tighter than `{op_text}`. Add parentheses to clarify intent: \
             `(a {and_op} b) {op_text} c` or `a {and_op} (b {op_text} c)`."
        ),
        ..Default::default()
    });
}
