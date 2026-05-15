//! Shared "does this text parse as real R code?" gate.
//!
//! Used by both the `commented_code` rule and the inline-`# nolint`
//! fallback in `nolint`, so the definition of "parsable R code" lives in
//! one place. The gate is intentionally conservative: bare identifiers,
//! literals, and parse errors are treated as prose.

use tree_sitter::Node;

use crate::parser_pool::with_parser;

/// Try-parse `text` and decide whether it looks like real R code.
///
/// Requirements:
/// 1. The parsed tree contains no `ERROR` nodes (`Node::has_error()` covers
///    both syntax errors and `MISSING` placeholders).
/// 2. The tree contains at least one node whose kind is in the "code-like"
///    set: function calls, binary/unary operators, assignment, function
///    definition, control flow, formula, or extract/namespace operators.
///    Pure identifiers, literals, and strings on their own do not qualify.
pub(crate) fn looks_like_code(stripped: &str) -> bool {
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
    fn flags_obvious_call() {
        assert!(looks_like_code("foo(bar, baz)"));
        assert!(looks_like_code("x <- 1"));
        assert!(looks_like_code("x + y"));
        assert!(looks_like_code("function(x) x + 1"));
    }

    #[test]
    fn skips_prose() {
        assert!(!looks_like_code("foo"));
        assert!(!looks_like_code("returns NULL"));
        assert!(!looks_like_code("x in {1, 2, 3}"));
        assert!(!looks_like_code(""));
        assert!(!looks_like_code("   "));
        assert!(!looks_like_code("42"));
    }
}
