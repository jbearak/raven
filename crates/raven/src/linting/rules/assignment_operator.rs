//! Enforce a single assignment operator at top-level.
//!
//! Walks the tree-sitter AST for `binary_operator` nodes whose `operator`
//! field is `<-` or `=`. A `=` whose `binary_operator` lives *directly* under
//! an `argument` node is named-argument syntax (`f(name = value)`) and is
//! never reported. Assignments inside nested expressions — function bodies,
//! braced blocks, control flow — are reported normally even when they appear
//! inside an argument list. This matches `lintr::assignment_linter`'s default
//! behavior.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range};
use tree_sitter::Node;

use crate::linting::config::AssignmentOperatorStyle;
use crate::linting::nolint::Suppressions;
use crate::linting::LINT_SOURCE;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    style: AssignmentOperatorStyle,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    visit(root, text, style, severity, suppressions, out);
}

fn visit(
    node: Node<'_>,
    text: &str,
    style: AssignmentOperatorStyle,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if node.kind() == "binary_operator" {
        if let Some(op_node) = node.child_by_field_name("operator") {
            let op_text = node_text(op_node, text);
            if !is_named_argument(node, op_text) {
                let bad = match style {
                    AssignmentOperatorStyle::LeftArrow => op_text == "=",
                    AssignmentOperatorStyle::Equals => op_text == "<-",
                };
                if bad {
                    let line_no = op_node.start_position().row as u32;
                    if !suppressions.is_suppressed(line_no) {
                        let line_text = text.lines().nth(line_no as usize).unwrap_or("");
                        let start_col = byte_offset_to_utf16_column(
                            line_text,
                            op_node.start_position().column,
                        );
                        let end_col =
                            byte_offset_to_utf16_column(line_text, op_node.end_position().column);
                        let preferred = match style {
                            AssignmentOperatorStyle::LeftArrow => "<-",
                            AssignmentOperatorStyle::Equals => "=",
                        };
                        out.push(Diagnostic {
                            range: Range {
                                start: Position::new(line_no, start_col),
                                end: Position::new(op_node.end_position().row as u32, end_col),
                            },
                            severity: Some(severity),
                            source: Some(LINT_SOURCE.to_string()),
                            message: format!(
                                "Use `{preferred}` for assignment instead of `{op_text}`."
                            ),
                            ..Default::default()
                        });
                    }
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, style, severity, suppressions, out);
    }
}

/// True if the given `binary_operator` node represents a named argument like
/// `name = value` inside a call. Tree-sitter-r wraps each top-level
/// expression in a call's argument list in an `argument` node, so a named
/// argument's `=` `binary_operator` has `argument` as its direct parent.
///
/// Anything nested deeper — assignments inside a function body
/// (`lapply(xs, function(x) { y = x; y })`), inside a braced block
/// (`f({ y = 1 })`), or inside control flow (`f(if (cond) y = 1)`) — is a
/// real assignment and must be reported.
fn is_named_argument(binop: Node<'_>, op_text: &str) -> bool {
    if op_text != "=" {
        return false;
    }
    binop
        .parent()
        .is_some_and(|p| p.kind() == "argument")
}

fn node_text<'a>(node: Node<'_>, text: &'a str) -> &'a str {
    let start = node.start_byte();
    let end = node.end_byte();
    text.get(start..end).unwrap_or("")
}
