//! Flag lines whose leading whitespace doesn't match the expected indent.
//!
//! Mirrors `lintr::indentation_linter()` with the default "tidy" hanging-indent
//! style. The rule walks the parse tree once, builds a per-line expected indent
//! from the AST scopes it crosses (braced blocks, multi-line argument lists,
//! continuation lines under a binary operator), and reports any line whose
//! actual leading-space count doesn't satisfy that expectation.
//!
//! Scopes and their expected indents:
//! * `braced_expression` — inner lines indent one [`indent_unit`] beyond the
//!   line of the opening `{`. A `}` that starts its own line aligns with the
//!   opening `{`'s line; a `}` trailing other code is left to the inner-line
//!   rule.
//! * Bracketed groups (`call` / `subset` / `subset2` arguments, and
//!   `parenthesized_expression`) — when the opener is followed by content on
//!   the same line (e.g. `foo(a,`), continuation lines may either align with
//!   the column after the opener (`opener_col + 1`) or hang one
//!   [`indent_unit`] below the opener's line; both are accepted to match the
//!   community-common aligned style. When the opener stands alone at end of
//!   line (`foo(`), only the hanging form is accepted.
//! * `binary_operator` — when the operator's RHS lives on a later line than
//!   the LHS, those continuation lines must indent one [`indent_unit`] beyond
//!   the line where the LHS starts. Nested binary operators may push that
//!   expectation deeper (lintr's "tidy" hanging-indent default).
//!
//! Lines skipped without checks:
//! * Suppressed lines (`# nolint`, `# nolint start/end`, `# @lsp-ignore`,
//!   `# @lsp-ignore-next`).
//! * Blank lines.
//! * Lines whose leading whitespace contains any tab — those belong to the
//!   `no_tab` rule.
//! * Lines that start strictly inside a multi-line string literal.
//! * Top-level lines with no enclosing multi-line scope expect indent 0.

use std::collections::{HashMap, HashSet};

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range};
use tree_sitter::Node;

use crate::linting::nolint::Suppressions;
use crate::linting::LINT_SOURCE;

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    indent_unit: u32,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return;
    }

    let mut string_interior: HashSet<u32> = HashSet::new();
    collect_string_interior_lines(root, &mut string_interior);

    let mut expectations: HashMap<u32, Expected> = HashMap::new();
    set_expectations(root, &lines, indent_unit, &mut expectations);

    for (idx, line_text) in lines.iter().enumerate() {
        let line_no = idx as u32;
        if suppressions.is_suppressed(line_no) {
            continue;
        }
        if line_text.trim().is_empty() {
            continue;
        }
        if string_interior.contains(&line_no) {
            continue;
        }
        if has_tab_in_leading(line_text) {
            continue;
        }

        let actual = leading_space_count(line_text);
        let expected = expectations
            .get(&line_no)
            .cloned()
            .unwrap_or_else(Expected::top_level);

        if expected.is_acceptable(actual) {
            continue;
        }

        out.push(Diagnostic {
            range: Range {
                start: Position::new(line_no, 0),
                end: Position::new(line_no, actual),
            },
            severity: Some(severity),
            source: Some(LINT_SOURCE.to_string()),
            message: expected.message(actual),
            ..Default::default()
        });
    }
}

/// Acceptable indent values for a single line.
///
/// Most lines have a single acceptable indent, but multi-line argument lists
/// whose opener carries content on the same line accept either the aligned
/// column or the hanging indent (lintr's tidy default for argument lists).
#[derive(Clone)]
struct Expected {
    primary: u32,
    alternatives: Vec<u32>,
}

impl Expected {
    fn single(value: u32) -> Self {
        Self {
            primary: value,
            alternatives: Vec::new(),
        }
    }

    fn top_level() -> Self {
        Self::single(0)
    }

    fn with_alternative(primary: u32, alternative: u32) -> Self {
        if primary == alternative {
            Self::single(primary)
        } else {
            Self {
                primary,
                alternatives: vec![alternative],
            }
        }
    }

    fn is_acceptable(&self, actual: u32) -> bool {
        actual == self.primary || self.alternatives.contains(&actual)
    }

    fn message(&self, actual: u32) -> String {
        if self.alternatives.is_empty() {
            format!(
                "Indentation should be {} spaces, not {}.",
                self.primary, actual
            )
        } else {
            let mut options: Vec<u32> = std::iter::once(self.primary)
                .chain(self.alternatives.iter().copied())
                .collect();
            options.sort_unstable();
            options.dedup();
            let listed = options
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(" or ");
            format!("Indentation should be {listed} spaces, not {actual}.")
        }
    }
}

/// Walk the tree once, recording an expected indent for each line covered by
/// a multi-line scope. We visit the parent before its children so that nested
/// (innermost) scopes overwrite their ancestor's expectation — the inner scope
/// is what the line actually sits in.
fn set_expectations(
    node: Node<'_>,
    lines: &[&str],
    indent_unit: u32,
    out: &mut HashMap<u32, Expected>,
) {
    match node.kind() {
        "braced_expression" => set_braced(node, lines, indent_unit, out),
        "call" | "subset" | "subset2" => {
            if let Some(args) = node.child_by_field_name("arguments") {
                set_bracketed(args, lines, indent_unit, out);
            }
        }
        "parenthesized_expression" => set_bracketed(node, lines, indent_unit, out),
        "binary_operator" => set_binary_operator(node, lines, indent_unit, out),
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        set_expectations(child, lines, indent_unit, out);
    }
}

fn set_braced(
    node: Node<'_>,
    lines: &[&str],
    indent_unit: u32,
    out: &mut HashMap<u32, Expected>,
) {
    let Some(opener) = node.child_by_field_name("open") else {
        return;
    };
    let Some(closer) = node.child_by_field_name("close") else {
        return;
    };

    let opener_line = opener.start_position().row as u32;
    let closer_line = closer.start_position().row as u32;
    if opener_line >= closer_line {
        return;
    }

    let opener_indent = leading_whitespace_count(line_text(lines, opener_line));
    let inner_indent = opener_indent.saturating_add(indent_unit);
    let closer_col = closer.start_position().column as u32;

    for line in (opener_line + 1)..=closer_line {
        let text = line_text(lines, line);
        let leading_ws = leading_whitespace_count(text);
        let expected = if line == closer_line && closer_col == leading_ws {
            Expected::single(opener_indent)
        } else {
            Expected::single(inner_indent)
        };
        out.insert(line, expected);
    }
}

fn set_bracketed(
    node: Node<'_>,
    lines: &[&str],
    indent_unit: u32,
    out: &mut HashMap<u32, Expected>,
) {
    let Some(opener) = node.child_by_field_name("open") else {
        return;
    };
    let Some(closer) = node.child_by_field_name("close") else {
        return;
    };

    let opener_line = opener.start_position().row as u32;
    let closer_line = closer.start_position().row as u32;
    if opener_line >= closer_line {
        return;
    }

    let opener_line_text = line_text(lines, opener_line);
    let opener_indent = leading_whitespace_count(opener_line_text);
    let opener_end_col = opener.end_position().column as u32;
    let after_opener = opener_line_text
        .get(opener_end_col as usize..)
        .unwrap_or("");
    let has_content_after_opener = after_opener.chars().any(|c| !c.is_whitespace());

    let primary = opener_indent.saturating_add(indent_unit);
    let aligned = opener_end_col;
    let closer_col = closer.start_position().column as u32;

    for line in (opener_line + 1)..=closer_line {
        let text = line_text(lines, line);
        let leading_ws = leading_whitespace_count(text);
        let expected = if line == closer_line && closer_col == leading_ws {
            Expected::single(opener_indent)
        } else if has_content_after_opener {
            Expected::with_alternative(primary, aligned)
        } else {
            Expected::single(primary)
        };
        out.insert(line, expected);
    }
}

fn set_binary_operator(
    node: Node<'_>,
    lines: &[&str],
    indent_unit: u32,
    out: &mut HashMap<u32, Expected>,
) {
    let start_line = node.start_position().row as u32;
    let end_line = node.end_position().row as u32;
    if start_line >= end_line {
        return;
    }

    let opener_indent = leading_whitespace_count(line_text(lines, start_line));
    let expected = Expected::single(opener_indent.saturating_add(indent_unit));

    for line in (start_line + 1)..=end_line {
        out.insert(line, expected.clone());
    }
}

/// Collect line numbers that start strictly inside a multi-line string. For a
/// string spanning rows `[r1, r2]` with `r2 > r1`, lines `r1 + 1 ..= r2` start
/// inside the string and are skipped by the linter.
fn collect_string_interior_lines(node: Node<'_>, set: &mut HashSet<u32>) {
    if node.kind() == "string" {
        let start = node.start_position().row as u32;
        let end = node.end_position().row as u32;
        if end > start {
            for line in (start + 1)..=end {
                set.insert(line);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_string_interior_lines(child, set);
    }
}

fn line_text<'a>(lines: &'a [&'a str], line: u32) -> &'a str {
    lines.get(line as usize).copied().unwrap_or("")
}

fn leading_space_count(line: &str) -> u32 {
    line.chars().take_while(|c| *c == ' ').count() as u32
}

fn leading_whitespace_count(line: &str) -> u32 {
    line.chars().take_while(|c| c.is_whitespace()).count() as u32
}

fn has_tab_in_leading(line: &str) -> bool {
    line.chars()
        .take_while(|c| c.is_whitespace())
        .any(|c| c == '\t')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser_pool::with_parser;

    fn lint(text: &str, indent_unit: u32) -> Vec<Diagnostic> {
        let tree = with_parser(|p| p.parse(text, None)).expect("parse must succeed");
        let suppressions = crate::linting::nolint::Suppressions::from_text(text);
        let mut out = Vec::new();
        collect(
            text,
            tree.root_node(),
            indent_unit,
            DiagnosticSeverity::HINT,
            &suppressions,
            &mut out,
        );
        out
    }

    #[test]
    fn function_body_correctly_indented_passes() {
        let text = "f <- function() {\n  x <- 1\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn function_body_underindented_flagged() {
        let text = "f <- function() {\nx <- 1\n}\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 1);
        assert!(diags[0].message.contains("should be 2 spaces"));
    }

    #[test]
    fn function_body_overindented_flagged() {
        let text = "f <- function() {\n    x <- 1\n}\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 1);
        assert!(diags[0].message.contains("should be 2 spaces"));
    }

    #[test]
    fn nested_braces_each_level_one_unit_deeper() {
        let text = "{\n  if (x) {\n    y <- 1\n  }\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn nested_braces_inner_wrong_flagged() {
        let text = "{\n  if (x) {\n  y <- 1\n  }\n}\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 2);
    }

    #[test]
    fn closing_brace_aligned_with_opener() {
        let text = "{\n  x <- 1\n  }\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 2);
        assert!(diags[0].message.contains("should be 0 spaces"));
    }

    #[test]
    fn continuation_after_binary_operator() {
        let text = "x <- 1 +\n  2\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn continuation_underindented_flagged() {
        let text = "x <- 1 +\n2\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 1);
    }

    #[test]
    fn pipe_continuation_indented() {
        let text = "x |>\n  f()\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn multi_line_call_hanging_indent_passes() {
        let text = "foo(\n  a,\n  b\n)\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn multi_line_call_closing_paren_aligned() {
        let text = "foo(\n  a,\n  b\n  )\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 3);
        assert!(diags[0].message.contains("should be 0 spaces"));
    }

    #[test]
    fn multi_line_call_aligned_with_first_arg_accepted() {
        let text = "foo(a,\n    b)\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn multi_line_call_hanging_when_opener_alone_accepted() {
        let text = "foo(\n  a\n)\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn multi_line_call_misaligned_flagged() {
        let text = "foo(a,\n  b)\n";
        // 2 is the hanging alternative (opener_indent + unit); 4 is aligned.
        // Both are acceptable, so no diagnostic.
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn multi_line_call_wrong_indent_flagged() {
        let text = "foo(a,\n b)\n";
        // 1 is neither aligned (4) nor hanging (2).
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("2 or 4"));
    }

    #[test]
    fn if_else_block_passes() {
        let text = "if (x) {\n  a\n} else {\n  b\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn multi_line_string_skipped() {
        let text = "x <- \"hello\nworld\"\n";
        // Line 1 starts inside the string; should not be flagged.
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn line_with_tab_in_indent_skipped() {
        let text = "f <- function() {\n\tx <- 1\n}\n";
        // Line 1 uses a tab — no_tab handles it; indentation rule stays silent.
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn suppression_nolint_silences_diagnostic() {
        let text = "f <- function() {\nx <- 1 # nolint\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn suppression_lsp_ignore_next_silences_diagnostic() {
        // The marker comment must itself be at the correct indent — the
        // `# @lsp-ignore-next` only suppresses the *following* source line, so
        // a marker placed at column 0 inside a braced block would (correctly)
        // be flagged on its own line.
        let text = "f <- function() {\n  # @lsp-ignore-next\nx <- 1\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn top_level_lines_expect_zero_indent() {
        let text = "  x <- 1\n";
        let diags = lint(text, 2);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.line, 0);
        assert!(diags[0].message.contains("should be 0 spaces"));
    }

    #[test]
    fn empty_braced_block_no_diagnostics() {
        let text = "f <- function() {\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn blank_lines_inside_block_not_flagged() {
        let text = "f <- function() {\n\n  x\n}\n";
        assert!(lint(text, 2).is_empty());
    }

    #[test]
    fn configurable_indent_unit_four() {
        let text = "f <- function() {\n    x <- 1\n}\n";
        assert!(lint(text, 4).is_empty());

        let wrong = "f <- function() {\n  x <- 1\n}\n";
        let diags = lint(wrong, 4);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("should be 4 spaces"));
    }
}
