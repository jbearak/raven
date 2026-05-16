//! Enforce a single string-literal delimiter (`"` or `'`).
//!
//! Mirrors `lintr::quotes_linter` / `lintr::single_quotes_linter` — the
//! configured delimiter is required for every regular string literal. Raw
//! strings (`r"(...)"`, `R'(...)'`, `r"---(...)---"`) are skipped: their outer
//! quote choice is constrained by the body, not by user style.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use tree_sitter::Node;

use crate::linting::config::StringDelimiter;
use crate::linting::nolint::Suppressions;
use crate::linting::rule_ids;
use crate::linting::LINT_SOURCE;
use crate::utf16::byte_offset_to_utf16_column;

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    delimiter: StringDelimiter,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    visit(root, text, delimiter, severity, suppressions, out);
}

fn visit(
    node: Node<'_>,
    text: &str,
    delimiter: StringDelimiter,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    if node.kind() == "string" {
        check_string(node, text, delimiter, severity, suppressions, out);
        // Strings have no relevant descendants for this rule.
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, text, delimiter, severity, suppressions, out);
    }
}

fn check_string(
    node: Node<'_>,
    text: &str,
    delimiter: StringDelimiter,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let lit = match text.get(node.start_byte()..node.end_byte()) {
        Some(s) => s,
        None => return,
    };
    if is_raw_string(lit) {
        return;
    }
    let first = match lit.as_bytes().first() {
        Some(b) => *b,
        None => return,
    };
    let (wanted, got) = match (delimiter, first) {
        (StringDelimiter::Double, b'\'') => ('"', '\''),
        (StringDelimiter::Single, b'"') => ('\'', '"'),
        _ => return,
    };
    let line_no = node.start_position().row as u32;
    if suppressions.is_suppressed(line_no) {
        return;
    }
    let line_text = text.lines().nth(line_no as usize).unwrap_or("");
    let start_col = byte_offset_to_utf16_column(line_text, node.start_position().column);
    // End column is on the start line only if the string is single-line; for
    // multi-line strings the end position spans rows, which the LSP supports
    // natively via `Range::end.line`.
    let end_line = node.end_position().row as u32;
    let end_line_text = text.lines().nth(end_line as usize).unwrap_or("");
    let end_col = byte_offset_to_utf16_column(end_line_text, node.end_position().column);
    out.push(Diagnostic {
        range: Range {
            start: Position::new(line_no, start_col),
            end: Position::new(end_line, end_col),
        },
        severity: Some(severity),
        source: Some(LINT_SOURCE.to_string()),
        code: Some(NumberOrString::String(rule_ids::QUOTES.to_string())),
        message: format!("String uses `{got}`; configured delimiter is `{wanted}`."),
        ..Default::default()
    });
}

/// Detect R raw-string literals: `r"(...)"`, `R"[...]"`, `r"---(...)---"` etc.
/// They start with `r`/`R`, then a quote, then optional dashes, then `(` / `[`
/// / `{`. We only need a minimal prefix check to skip the rule.
fn is_raw_string(lit: &str) -> bool {
    let bytes = lit.as_bytes();
    if bytes.len() < 2 {
        return false;
    }
    if bytes[0] != b'r' && bytes[0] != b'R' {
        return false;
    }
    matches!(bytes[1], b'"' | b'\'')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_string_prefix_is_detected() {
        assert!(is_raw_string("r\"(hi)\""));
        assert!(is_raw_string("R\"[hi]\""));
        assert!(is_raw_string("r'---(hi)---'"));
        assert!(!is_raw_string("\"hi\""));
        assert!(!is_raw_string("'hi'"));
        // `r` alone (e.g. identifier) is not a raw string.
        assert!(!is_raw_string("r"));
        assert!(!is_raw_string(""));
    }
}
