//! Two expressions on one line with nothing between them (`x <- 1 y <- 2`),
//! and the malformed hexadecimal numbers the grammar reads the same way
//! (`0x`, `0x1.p`). R's `parse()` rejects all of them; tree-sitter-r accepts
//! them without an ERROR node (issue #886).
//!
//! The grammar's `program` and `braced_expression` are a repeat of
//! expressions, `;` and newlines, so two expressions can follow each other
//! with no separator, and the separators themselves are hidden tokens. The
//! only evidence is the source text between two sibling statements.
//!
//! **Rule.** For two consecutive statements `A` and `B` of a `program` or
//! `braced_expression`, with no comment, ERROR or MISSING node between them
//! and no syntax error inside either:
//!
//! - The text between them is one or more spaces, tabs or form feeds (the
//!   characters R's lexer skips): `B` is a second expression on `A`'s line. A
//!   `;`, a newline or a lone `\r` in the gap is a separator.
//! - Nothing is between them and the tokens at the boundary spell a
//!   hexadecimal number R can't read: `0` then `x`/`X`, or a `0x…` number
//!   then `p`/`P`. Other shapes with no gap (`f()g()`, `1"a"`) are left
//!   alone: they rest on the grammar splitting tokens where R does.
//!
//! Nothing is reported for a tree with an ERROR or MISSING node anywhere:
//! where the parser failed, its statements aren't evidence of R's. A pair
//! around an `else` R can't attach is skipped, since that `else` already has
//! its own diagnostic. So is a pair on a line another syntax diagnostic
//! touches, and every pair after the first on a line.

use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Position, Range};
use tree_sitter::Node;

/// Report every pair the module-level rule matches under `root`, which was
/// parsed from `text`. `diagnostics` holds the syntax diagnostics collected so
/// far; a pair one of them already covers is not reported again.
pub(super) fn collect_juxtaposed_expression_errors(
    root: Node,
    text: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    // A tree with an ERROR or MISSING node says nothing reliable about where
    // statements end: R reads `1 %\% "a` + newline + `b c"` as one call, and
    // the grammar's recovery leaves `b c` as two clean statements lines away
    // from the error. The pair is reported once the file parses.
    if root.has_error() {
        return;
    }
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.is_error() || node.is_missing() {
            continue;
        }
        if matches!(node.kind(), "program" | "braced_expression") {
            check_sequence(node, text, &mut found);
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    // A line that already has a syntax diagnostic (an `else`, a chained
    // comparison) gets no second one.
    let reported: std::collections::HashSet<u32> = diagnostics
        .iter()
        .flat_map(|diagnostic| diagnostic.range.start.line..=diagnostic.range.end.line)
        .collect();
    found.retain(|diagnostic| !reported.contains(&diagnostic.range.start.line));
    // R stops at a line's first error, so `1 2 3` and `{ a b } c` are one
    // diagnostic each: the leftmost.
    found.sort_by_key(|diagnostic| diagnostic.range.start);
    found.dedup_by_key(|diagnostic| diagnostic.range.start.line);
    diagnostics.extend(found);
}

/// Push onto `found` each pair of `sequence`'s statements the rule matches.
fn check_sequence(sequence: Node, text: &str, found: &mut Vec<Diagnostic>) {
    let mut cursor = sequence.walk();
    let mut previous: Option<Node> = None;
    // Only a line's leftmost pair is reported, and the children come in
    // source order, so later pairs on a row that already has one are skipped
    // before their positions are computed. Each position is a scan of the
    // line, which made a line of n juxtaposed tokens cost n scans.
    let mut reported_row: Option<usize> = None;
    for child in sequence.children(&mut cursor) {
        let statement = child.is_named()
            && !child.is_extra()
            && !child.is_missing()
            && !child.has_error()
            && child.start_byte() < child.end_byte();
        if !statement {
            previous = None;
            continue;
        }
        if let Some(first) = previous
            && reported_row != Some(child.start_position().row)
            && let Some(diagnostic) = juxtaposition(first, child, text)
        {
            reported_row = Some(child.start_position().row);
            found.push(diagnostic);
        }
        previous = Some(child);
    }
}

fn juxtaposition(first: Node, second: Node, text: &str) -> Option<Diagnostic> {
    if first.end_position().row != second.start_position().row {
        return None;
    }
    let gap = text.get(first.end_byte()..second.start_byte())?;
    let second_token = leftmost_leaf(second);
    let first_token = rightmost_leaf(first);
    if is_bare_else(first_token, text) || is_bare_else(second_token, text) {
        return None;
    }
    let (range, message) = if gap.is_empty() {
        // The tokens on each side of the boundary: `x <- 0x` is the
        // statements `x <- 0` and `x`.
        let reason = malformed_hex(first_token, second_token, text)?;
        let joined = text.get(first_token.start_byte()..second_token.end_byte())?;
        (
            Range::new(
                position(first_token, text, false),
                position(second_token, text, true),
            ),
            format!("Malformed number `{joined}`: {reason}"),
        )
    } else if gap.bytes().all(|b| matches!(b, b' ' | b'\t' | 0x0c)) {
        let start = position(second_token, text, false);
        // A first token that runs past its line (a multi-line string) is
        // underlined at its first character.
        let end = if second_token.end_position().row == second_token.start_position().row {
            position(second_token, text, true)
        } else {
            Position::new(start.line, start.character + 1)
        };
        (
            Range::new(start, end),
            "Unexpected expression: R needs a newline or `;` between two expressions on one line"
                .to_string(),
        )
    } else {
        return None;
    };
    Some(Diagnostic {
        range,
        severity: Some(DiagnosticSeverity::ERROR),
        code: Some(NumberOrString::String(
            crate::diagnostic_code::SYNTAX_ERROR.to_string(),
        )),
        message,
        ..Default::default()
    })
}

/// Why the token `first` directly followed by the token `second` is a
/// hexadecimal number R can't read, when it is one.
fn malformed_hex(first: Node, second: Node, text: &str) -> Option<&'static str> {
    if first.kind() != "float" || second.kind() != "identifier" {
        return None;
    }
    let number = text.get(first.byte_range())?;
    let name = text.get(second.byte_range())?;
    // The number must start where R starts a token. The grammar reads an
    // `else` at the start of a line in a block as the keyword even when it
    // begins a longer name, so `else0xg <- 2` after an `if` is `else`, `0`,
    // `xg <- 2` to it and one assignment to R.
    let glued = text[..first.start_byte()]
        .chars()
        .next_back()
        .is_some_and(|before| before.is_alphanumeric() || matches!(before, '.' | '_'));
    if glued {
        return None;
    }
    // R's lexer commits to a hexadecimal number at `0x`, and to its exponent
    // at `p`, whatever follows: `0xg` and `0x1.pfoo` are errors too.
    if number == "0" && name.starts_with(['x', 'X']) {
        return Some("a hexadecimal number needs digits after `0x`");
    }
    let hex = number.starts_with("0x") || number.starts_with("0X");
    if hex && !number.contains(['p', 'P']) && name.starts_with(['p', 'P']) {
        return Some("a hexadecimal exponent needs digits after `p`");
    }
    None
}

fn leftmost_leaf(mut node: Node) -> Node {
    while let Some(child) = node.child(0) {
        node = child;
    }
    node
}

fn rightmost_leaf(mut node: Node) -> Node {
    while let Some(child) = node.child(node.child_count().saturating_sub(1) as u32) {
        node = child;
    }
    node
}

/// An unquoted `else` that isn't part of an `if`: see
/// `collect_else_newline_errors`.
fn is_bare_else(node: Node, text: &str) -> bool {
    node.kind() == "identifier" && text.get(node.byte_range()) == Some("else")
}

/// The LSP position of `node`'s start (or end), counting the column in
/// UTF-16 from the line's first byte.
fn position(node: Node, text: &str, end: bool) -> Position {
    let (point, byte) = if end {
        (node.end_position(), node.end_byte())
    } else {
        (node.start_position(), node.start_byte())
    };
    let line_start = byte.saturating_sub(point.column);
    let character = text
        .get(line_start..byte)
        .map_or(point.column, |prefix| prefix.encode_utf16().count());
    Position::new(point.row as u32, character as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostics(code: &str) -> Vec<Diagnostic> {
        let tree = crate::parser_pool::with_parser(|parser| parser.parse(code, None))
            .expect("the R parser has a language and no timeout");
        crate::handlers::r_syntax_diagnostics(tree.root_node(), code)
    }

    fn juxtaposed(code: &str) -> Vec<(u32, u32, u32)> {
        diagnostics(code)
            .into_iter()
            .filter(|d| {
                d.message.starts_with("Unexpected expression")
                    || d.message.starts_with("Malformed number")
            })
            .map(|d| {
                (
                    d.range.start.line,
                    d.range.start.character,
                    d.range.end.character,
                )
            })
            .collect()
    }

    /// The five inputs of issue #886, each rejected by R's `parse()`.
    #[test]
    fn reports_the_issue_examples() {
        assert_eq!(juxtaposed("x <- 1 y <- 2\n"), [(0, 7, 8)]);
        assert_eq!(juxtaposed("f(1) g(2)\n"), [(0, 5, 6)]);
        assert_eq!(juxtaposed("x <- 1 \"a\"\n"), [(0, 7, 8)]);
        assert_eq!(juxtaposed("0x\n"), [(0, 0, 2)]);
        assert_eq!(juxtaposed("0x1.p\n"), [(0, 0, 5)]);
    }

    #[test]
    fn reports_with_the_syntax_error_code_and_error_severity() {
        let found = diagnostics("x <- 1 y <- 2\n");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].severity, Some(DiagnosticSeverity::ERROR));
        assert_eq!(
            found[0].code,
            Some(NumberOrString::String("syntax-error".to_string()))
        );
    }

    /// More shapes R rejects (checked with `parse(text = ...)`, R 4.6).
    #[test]
    fn reports_other_rejected_shapes() {
        for code in [
            "{ a b }",
            "\";\" y",
            "{a} {b}",
            "if (a) {b} {c}",
            "x <- 1 \u{c} y",
            "a\tb",
            "'a' 'b'",
            "function(x) x y",
            "TRUE FALSE",
            "1 2",
            "0 x",
            "0x1 p",
            "`else` x",
            "f <- function() {\n  a b\n}",
        ] {
            assert_eq!(juxtaposed(code).len(), 1, "{code:?}");
        }
        for code in ["0X", "0x1p", "0X1P", "0x.p", "0x1.8p"] {
            assert_eq!(juxtaposed(code), [(0, 0, code.len() as u32)], "{code:?}");
        }
        // The malformed number is the tail of one statement and the head of
        // the next.
        assert_eq!(juxtaposed("x <- 0x\n"), [(0, 5, 7)]);
        assert_eq!(juxtaposed("y <- 0x1.p\n"), [(0, 5, 10)]);
        assert_eq!(juxtaposed("f(1) + 0x + 2\n"), [(0, 7, 9)]);
        // Whatever follows `0x` or the `p`.
        assert_eq!(juxtaposed("0xg\n"), [(0, 0, 3)]);
        assert_eq!(juxtaposed("x <- 0x1.pfoo\n"), [(0, 5, 13)]);
        assert_eq!(juxtaposed("0x1Pq\n"), [(0, 0, 5)]);
    }

    /// Code R accepts must stay clean.
    #[test]
    fn accepts_legal_look_alikes() {
        for code in [
            "if (a) b else c",
            "function(x) x",
            "\\(x) x",
            "x; y",
            "x;y",
            "x ;\ty",
            "{ a; b }",
            "a %op% b",
            "y ~ x + z",
            "~x",
            "-x",
            "x - 1",
            "x |> f()",
            "\"hello\nworld\"",
            "x <- \"a\nb\"; y",
            "a # end\n# middle\nb",
            "a # one\nb",
            "{ if (a) b\nelse c }",
            "function() {\n  if (a) {\n    b\n  }\n  else {\n    c\n  }\n}",
            "#' @examples\n#' x <- 1 y <- 2\nf <- function() 1",
            "x\ny",
            "x\r\ny",
            "x\ry",
            "(f\n)(2)",
            "f(1) (2)",
            "0x1.fp2",
            "0x1p2",
            "0x1L",
            "0x1i",
            "0X.8P-3",
            "0x.",
            "0x1.",
            "0x1.8",
            "0x1.p1",
            "0x1.p-1",
            // One name to R; the grammar splits it at `else`.
            "{\n  if (TRUE) 1\n  else0xg <- 2\n}",
            "{\n  if (TRUE) 1\n  else0x <- 2\n}",
            "{\n  if (TRUE) 1\n  else0x1.pfoo <- 2\n}",
            "f <- function(a) {\n  if (a) 1\n  elsewhere <- 2\n}",
            "x <- 0x1.p1",
            "x <- 0x10; p <- 2",
            "0xAL",
            "1e-3",
            "x <- r\"(a b)\"",
            "é <- 1; ü <- 2",
            "x <- 1\n\ny <- 2\n",
            "x <- function(a) a; y <- 2",
            "repeat break",
            "for (i in x) i",
            "while (a) b",
            "a$b; c@d",
            "x[1] [2]",
        ] {
            assert_eq!(juxtaposed(code), [], "{code:?}");
        }
    }

    /// A top-level `else` on its own line already has the orphan-`else`
    /// diagnostic; the pair it forms with what follows adds nothing.
    #[test]
    fn leaves_an_orphan_else_to_its_own_diagnostic() {
        for code in [
            "if (a) b\nelse c",
            "if (a) {\n  b\n}\nelse {\n  c\n}",
            "else c",
            "x else",
            "x else$y",
        ] {
            let found = diagnostics(code);
            assert_eq!(juxtaposed(code), [], "{code:?}: {found:?}");
            assert!(!found.is_empty(), "{code:?} keeps its else diagnostic");
        }
    }

    /// A file the parser couldn't read gets nothing from this rule, on any
    /// line: what recovery makes of the text isn't R's reading of it.
    #[test]
    fn reports_nothing_for_a_tree_with_a_parser_error() {
        for code in [
            "x <- (1 y",
            "f(a b)",
            "x <- 1 )",
            "x <- 1 y <-",
            "\"abc",
            "f(\na b\n)\nx y\n",
            // R reads `%\ a b c%` as one operator; the grammar doesn't.
            "1 %\\ a b c% 2\nx y\n",
            // Valid R: one call whose string argument spans three lines.
            "1 %\\% \"hello\na b c\nworld\"\n",
            "x <- 'abc\na b\n",
        ] {
            let found = diagnostics(code);
            assert_eq!(juxtaposed(code), [], "{code:?}: {found:?}");
            assert!(!found.is_empty(), "{code:?} has a parser error");
        }
        // Once the other error is fixed, the pair is reported.
        assert_eq!(juxtaposed("f(\na, b\n)\nx y\n"), [(3, 2, 3)]);
    }

    /// A chained comparison is a syntax diagnostic with no parser error; a
    /// pair on its line isn't reported on top of it.
    #[test]
    fn does_not_stack_on_another_syntax_diagnostic() {
        let found = diagnostics("0 < x < 1 y\na b\n");
        assert_eq!(juxtaposed("0 < x < 1 y\na b\n"), [(1, 2, 3)], "{found:?}");
        assert_eq!(found.len(), 2, "{found:?}");
    }

    /// One diagnostic per line, at the first pair, as R stops there.
    #[test]
    fn reports_a_line_once() {
        assert_eq!(juxtaposed("12 14 33 50\n"), [(0, 3, 5)]);
        assert_eq!(juxtaposed("a b\nc d e\n"), [(0, 2, 3), (1, 2, 3)]);
        assert_eq!(juxtaposed("{ a b }; c d\n"), [(0, 4, 5)]);
        assert_eq!(juxtaposed("{ a b } c\n"), [(0, 4, 5)]);
        assert_eq!(
            juxtaposed("f <- function() { a b }\ng <- function() { c d }\n").len(),
            2
        );
    }

    #[test]
    fn range_counts_utf16_columns() {
        // `"😀"` is 4 UTF-16 units; `y` follows it and a space.
        assert_eq!(juxtaposed("\"😀\" y\n"), [(0, 5, 6)]);
        assert_eq!(juxtaposed("é <- 1 ü <- 2\n"), [(0, 7, 8)]);
        assert_eq!(juxtaposed("x <- 1\n  a  bb\n"), [(1, 5, 7)]);
    }

    /// The second expression's first token is what's underlined, cut to one
    /// character when it runs past the line.
    #[test]
    fn underlines_the_second_expressions_first_token() {
        assert_eq!(juxtaposed("x <- 1 yy <- 2\n"), [(0, 7, 9)]);
        assert_eq!(juxtaposed("x \"a\nb\"\n"), [(0, 2, 3)]);
    }
}
