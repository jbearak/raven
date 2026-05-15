//! Flag comments that appear to contain commented-out R code.
//!
//! Mirrors `lintr::commented_code_linter`. A comment is flagged when:
//!
//! 1. It is the only content on its line (end-of-line comments next to real
//!    code are left alone — those are annotations on the statement, not dead
//!    code).
//! 2. After stripping the leading `#` characters and whitespace, the remaining
//!    text parses cleanly as R (no `ERROR` nodes) and contains at least one
//!    "code-like" construct — a call, an assignment, a binary or unary
//!    operator, or a function definition. Bare identifiers, literals, and
//!    parse errors are treated as prose.
//!
//! Multi-line comment blocks (consecutive standalone comment lines) are
//! grouped and parsed as a unit, so commented-out code that spans several
//! lines is detected even when no single line is by itself a valid expression.
//!
//! The following are always skipped:
//!
//! * **Roxygen** lines (`#'`). Documentation, not code.
//! * **Shebangs** (`#!/usr/bin/env Rscript`) on the first line.
//! * **Annotation comments** prefixed with one of `TODO`, `FIXME`, `NOTE`,
//!   `XXX`, `HACK`, `BUG`, `WARNING`, or `OPTIMIZE` (case-insensitive,
//!   followed by `:`, `(`, or `-`). `TODO` happens to be a valid identifier,
//!   so without this gate `# TODO: rewrite parse_args` would parse as code.
//! * **Suppression / directive markers** — `# nolint`, `# nolint start`,
//!   `# nolint end`, `# nolint: rule`, `# @lsp-ignore`, `# @lsp-ignore-next`,
//!   and any other `# @lsp-…` directive. These wouldn't pass the code-like
//!   heuristic anyway, but skipping them up front keeps the rule from
//!   competing with the suppression infrastructure.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range};
use tree_sitter::Node;

use crate::linting::nolint::Suppressions;
use crate::linting::LINT_SOURCE;
use crate::parser_pool::with_parser;
use crate::utf16::byte_offset_to_utf16_column;

/// Annotation prefixes (case-insensitive). `TODO`, `FIXME`, etc. — these are
/// almost always prose even though `TODO` happens to be a syntactically valid
/// R identifier.
const ANNOTATION_PREFIXES: &[&str] = &[
    "TODO", "FIXME", "NOTE", "XXX", "HACK", "BUG", "WARNING", "OPTIMIZE",
];

pub(crate) fn collect(
    text: &str,
    root: Node<'_>,
    severity: DiagnosticSeverity,
    suppressions: &Suppressions,
    out: &mut Vec<Diagnostic>,
) {
    // Collect every standalone comment node — comments where the only thing
    // preceding the `#` on its line is whitespace. End-of-line comments next
    // to code (`x <- 1 # explain`) are intentionally left alone.
    let mut standalone: Vec<StandaloneComment> = Vec::new();
    collect_standalone(root, text, &mut standalone);

    // Group consecutive standalone comments (adjacent lines, nothing else in
    // between) so a multi-line block is parsed and reported as one unit.
    let groups = group_contiguous(&standalone);

    let lines: Vec<&str> = text.lines().collect();

    for group in groups {
        let first_line_idx = group.first().expect("group is non-empty").line as usize;
        let last_line_idx = group.last().expect("group is non-empty").line as usize;

        // Suppressions on the first or last comment line of the group cover
        // the whole block — easier than asking "did the user mean to suppress
        // an arbitrary middle line".
        if suppressions.is_suppressed(first_line_idx as u32)
            || suppressions.is_suppressed(last_line_idx as u32)
        {
            continue;
        }

        let group_lines: Vec<&str> = group
            .iter()
            .map(|c| lines.get(c.line as usize).copied().unwrap_or(""))
            .collect();

        if should_skip(&group_lines, first_line_idx == 0) {
            continue;
        }

        let stripped = strip_and_join(&group_lines);
        if !looks_like_code(&stripped) {
            continue;
        }

        // Build the diagnostic range from the first character of the first
        // comment line to the end of the last comment line.
        let first = &group[0];
        let last = &group[group.len() - 1];
        let start_line_text = lines.get(first.line as usize).copied().unwrap_or("");
        let end_line_text = lines.get(last.line as usize).copied().unwrap_or("");
        let start_col = byte_offset_to_utf16_column(start_line_text, first.start_byte_on_line);
        let end_col = byte_offset_to_utf16_column(end_line_text, end_line_text.len());

        out.push(Diagnostic {
            range: Range {
                start: Position::new(first.line, start_col),
                end: Position::new(last.line, end_col),
            },
            severity: Some(severity),
            source: Some(LINT_SOURCE.to_string()),
            message: "Commented code should be removed.".to_string(),
            ..Default::default()
        });
    }
}

/// Comment node that is the only non-whitespace content on its line.
#[derive(Debug, Clone, Copy)]
struct StandaloneComment {
    line: u32,
    /// Byte offset of the `#` within its line (used to build the diagnostic
    /// start position).
    start_byte_on_line: usize,
}

fn collect_standalone<'a>(node: Node<'a>, text: &str, out: &mut Vec<StandaloneComment>) {
    if node.kind() == "comment" {
        let start = node.start_position();
        let line_idx = start.row;
        // Locate the line in `text` and check that everything before the
        // comment is whitespace.
        if let Some(line) = nth_line(text, line_idx) {
            let col_bytes = start.column;
            if col_bytes <= line.len()
                && line[..col_bytes].bytes().all(|b| b == b' ' || b == b'\t')
            {
                out.push(StandaloneComment {
                    line: line_idx as u32,
                    start_byte_on_line: col_bytes,
                });
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_standalone(child, text, out);
    }
}

/// Borrow the `line_idx`-th line of `text` (zero-indexed) without allocating.
fn nth_line(text: &str, line_idx: usize) -> Option<&str> {
    text.lines().nth(line_idx)
}

/// Group standalone comments that occupy consecutive lines.
fn group_contiguous(comments: &[StandaloneComment]) -> Vec<Vec<StandaloneComment>> {
    let mut groups: Vec<Vec<StandaloneComment>> = Vec::new();
    for c in comments {
        if let Some(last_group) = groups.last_mut() {
            let prev_line = last_group.last().expect("group is non-empty").line;
            if c.line == prev_line + 1 {
                last_group.push(*c);
                continue;
            }
        }
        groups.push(vec![*c]);
    }
    groups
}

/// Decide whether a comment block should be skipped before we try to parse it
/// as code.
fn should_skip(lines: &[&str], is_first_block: bool) -> bool {
    if is_first_block {
        if let Some(first) = lines.first() {
            if first.trim_start().starts_with("#!") {
                return true;
            }
        }
    }
    lines.iter().any(|line| {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#'") {
            return true;
        }
        if is_directive_marker(trimmed) {
            return true;
        }
        if is_mode_line(trimmed) {
            return true;
        }
        is_annotation_comment(trimmed)
    })
}

/// `# nolint`, `# nolint start`, `# nolint end`, `# nolint: rule`, and any
/// `# @lsp-…` directive (`@lsp-ignore`, `@lsp-source`, `@lsp-var`, etc.).
fn is_directive_marker(trimmed_line: &str) -> bool {
    let body = match strip_hash_prefix(trimmed_line) {
        Some(b) => b,
        None => return false,
    };
    let body_lower = body.to_ascii_lowercase();
    if let Some(after) = body_lower.strip_prefix("nolint") {
        // Accept the bare keyword followed by EOL, whitespace, `:`, or `-`.
        // Same rule used by [`crate::linting::nolint::matches_keyword`].
        return match after.chars().next() {
            None => true,
            Some(c) => c.is_whitespace() || c == ':' || c == '-',
        };
    }
    body.starts_with("@lsp-")
}

/// Emacs-style mode line, e.g. `# -*- coding: utf-8 -*-`. R code rarely uses
/// these, but they parse as a chain of unary minuses and `:` and would trip
/// the code-like heuristic.
fn is_mode_line(trimmed_line: &str) -> bool {
    let body = match strip_hash_prefix(trimmed_line) {
        Some(b) => b,
        None => return false,
    };
    let first = body.find("-*-");
    let last = body.rfind("-*-");
    matches!((first, last), (Some(s), Some(e)) if s != e)
}

/// `# TODO:` / `# fixme(...)` and friends. The marker keyword must be followed
/// by `:`, `(`, `-`, or whitespace so we don't false-positive on identifiers
/// that happen to share a prefix (`TODOS`, `FIXMETOO`).
fn is_annotation_comment(trimmed_line: &str) -> bool {
    let body = match strip_hash_prefix(trimmed_line) {
        Some(b) => b,
        None => return false,
    };
    for prefix in ANNOTATION_PREFIXES {
        if body.len() < prefix.len() {
            continue;
        }
        let head = &body[..prefix.len()];
        if !head.eq_ignore_ascii_case(prefix) {
            continue;
        }
        let tail = &body[prefix.len()..];
        if tail.is_empty() {
            return true;
        }
        if let Some(c) = tail.chars().next() {
            if c.is_whitespace() || c == ':' || c == '(' || c == '-' {
                return true;
            }
        }
    }
    false
}

/// Strip leading `#` characters and following whitespace, returning the
/// comment body. Returns `None` if the input is not a comment line.
fn strip_hash_prefix(line: &str) -> Option<&str> {
    let mut rest = line.trim_start();
    if !rest.starts_with('#') {
        return None;
    }
    while let Some(stripped) = rest.strip_prefix('#') {
        rest = stripped;
    }
    Some(rest.trim_start())
}

/// Join the bodies of a comment block (one stripped line per row) into a
/// single string suitable for try-parsing.
fn strip_and_join(lines: &[&str]) -> String {
    let mut out = String::new();
    for (idx, line) in lines.iter().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        if let Some(body) = strip_hash_prefix(line) {
            out.push_str(body);
        }
    }
    out
}

/// Try-parse `text` and decide whether it looks like real R code.
///
/// Requirements:
/// 1. The parsed tree contains no `ERROR` nodes (`Node::has_error()` covers
///    both syntax errors and `MISSING` placeholders).
/// 2. The tree contains at least one node whose kind is in the "code-like"
///    set: function calls, binary/unary operators, assignment, function
///    definition, control flow, formula, or extract/namespace operators.
///    Pure identifiers, literals, and strings on their own do not qualify.
fn looks_like_code(stripped: &str) -> bool {
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return false;
    }

    let tree = match with_parser(|p| p.parse(stripped, None)) {
        Some(t) => t,
        None => return false,
    };
    let root = tree.root_node();
    if root.has_error() {
        return false;
    }

    contains_code_like(root)
}

fn contains_code_like(node: Node<'_>) -> bool {
    if is_code_like_kind(node.kind()) {
        return true;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if contains_code_like(child) {
            return true;
        }
    }
    false
}

fn is_code_like_kind(kind: &str) -> bool {
    matches!(
        kind,
        "call"
            | "binary_operator"
            | "unary_operator"
            | "function_definition"
            | "if_statement"
            | "for_statement"
            | "while_statement"
            | "repeat_statement"
            | "extract_operator"
            | "namespace_operator"
            | "subset"
            | "subset2"
            | "braced_expression"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_hash_prefix_handles_double_hash() {
        assert_eq!(strip_hash_prefix("## hello"), Some("hello"));
        assert_eq!(strip_hash_prefix("   # foo"), Some("foo"));
        assert_eq!(strip_hash_prefix("not a comment"), None);
    }

    #[test]
    fn annotation_detector_recognizes_common_prefixes() {
        assert!(is_annotation_comment("# TODO: write tests"));
        assert!(is_annotation_comment("# fixme(123)"));
        assert!(is_annotation_comment("## NOTE - check this"));
        assert!(is_annotation_comment("# XXX"));
        // Not annotations:
        assert!(!is_annotation_comment("# todoist <- list()"));
        assert!(!is_annotation_comment("# x <- 1"));
    }

    #[test]
    fn directive_detector_recognizes_nolint_and_lsp() {
        assert!(is_directive_marker("# nolint"));
        assert!(is_directive_marker("# nolint: line_length"));
        assert!(is_directive_marker("# nolint start"));
        assert!(is_directive_marker("# @lsp-ignore"));
        assert!(is_directive_marker("# @lsp-source ../helpers.R"));
        assert!(!is_directive_marker("# nolinter"));
        assert!(!is_directive_marker("# lsp-ignore"));
    }

    #[test]
    fn looks_like_code_flags_obvious_call() {
        assert!(looks_like_code("foo(bar, baz)"));
        assert!(looks_like_code("x <- 1"));
        assert!(looks_like_code("x + y"));
        assert!(looks_like_code("function(x) x + 1"));
    }

    #[test]
    fn looks_like_code_skips_prose() {
        assert!(!looks_like_code("foo"));
        assert!(!looks_like_code("returns NULL"));
        assert!(!looks_like_code("x in {1, 2, 3}"));
        assert!(!looks_like_code(""));
        assert!(!looks_like_code("   "));
        assert!(!looks_like_code("42"));
    }
}
