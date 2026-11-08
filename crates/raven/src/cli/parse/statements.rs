//! Statements and the comments they own.
//!
//! A statement is each expression in the file's top-level sequence and each
//! expression directly inside a pair of braces, wherever the braces stand. A
//! statement's `text` is the source slice of its `range`; `;` separators are
//! outside every statement because the grammar keeps them out of the
//! expression nodes.
//!
//! Every comment in the file lands in exactly one list. For a sequence (the
//! file, or one block), a comment is, in order of precedence:
//!
//! 1. inside a statement's range: in the block it falls in, if the statement's
//!    tree holds a block containing it (handled recursively), otherwise that
//!    statement's `interior`;
//! 2. on the line where the previous statement in the sequence ends: that
//!    statement's `trailing`;
//! 3. before a later statement in the sequence: that statement's `leading`
//!    (this includes a comment on a block's `{` line before its first
//!    statement);
//! 4. otherwise: the block's `block_end`, or the file-level list.
//!
//! `blank_line_before` on a statement, and on each comment in a `leading`,
//! `block_end` or file-level list, is true when a whitespace-only line sits
//! between it and the previous item in the same sequence (previous comment in
//! the list, previous statement, the block's `{` line, or the file start).
//! For a statement the gap measured is the one before its first leading
//! comment, if it has one.

use serde::Serialize;
use tree_sitter::Node as TsNode;

use super::document::{LineIndex, Range};
use super::tree::Node;

/// A comment's byte span in the decoded text. The grammar's comment token
/// includes the `\r` of a `\r\n`; the span leaves it out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CommentSpan {
    pub(super) start: usize,
    pub(super) end: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct Comment {
    /// `comment`, or `roxygen` for a comment starting `#'`. Open enum.
    pub(crate) kind: &'static str,
    /// The comment as written, with its `#`.
    pub(crate) text: String,
    pub(crate) range: Range,
    /// Only on own-line comments (`leading`, `block_end`, file-level).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) blank_line_before: Option<bool>,
}

#[derive(Debug, Serialize)]
pub(crate) struct StatementComments {
    pub(crate) leading: Vec<Comment>,
    pub(crate) trailing: Vec<Comment>,
    pub(crate) interior: Vec<Comment>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Statement {
    pub(crate) text: String,
    pub(crate) range: Range,
    pub(crate) blank_line_before: bool,
    pub(crate) comments: StatementComments,
    pub(crate) expression: Node,
}

/// What building a sequence produces: its statements and the comments no
/// statement owns (a block's `block_end`, or the file-level list).
pub(super) type Sequence = (Vec<Statement>, Vec<Comment>);

/// Builds statements, comments and the tree over one decoded text.
pub(super) struct Builder<'a> {
    /// The decoded text, BOM removed. Every slice comes from here.
    pub(super) text: &'a str,
    pub(super) lines: &'a LineIndex<'a>,
}

/// Parse `text` and build the document's top-level statements and file-level
/// comments.
pub(crate) fn build_document_body(text: &str, lines: &LineIndex<'_>) -> Sequence {
    // The grammar treats a lone `\r` as whitespace, so a comment before one
    // would run on through the next line. R ends a line there, so parse a copy
    // with each lone `\r` read as `\n`: same length, so every byte offset holds.
    let parse_text = lone_cr_as_lf(text);
    let tree = crate::parser_pool::with_parser(|parser| parser.parse(parse_text.as_ref(), None))
        .expect("the R parser has a language and no timeout");
    let root = tree.root_node();
    let builder = Builder { text, lines };
    let mut comments = Vec::new();
    builder.collect_comments(root, &mut comments);
    builder.sequence(&sequence_children(root), comments, None)
}

fn lone_cr_as_lf(text: &str) -> std::borrow::Cow<'_, str> {
    let bytes = text.as_bytes();
    let lone = |i: usize| bytes[i] == b'\r' && bytes.get(i + 1) != Some(&b'\n');
    if !(0..bytes.len()).any(lone) {
        return std::borrow::Cow::Borrowed(text);
    }
    let replaced: Vec<u8> = (0..bytes.len())
        .map(|i| if lone(i) { b'\n' } else { bytes[i] })
        .collect();
    // Swapping one ASCII byte for another keeps the text valid UTF-8.
    std::borrow::Cow::Owned(String::from_utf8(replaced).expect("ASCII-for-ASCII swap"))
}

/// The statements of a sequence node (`program` or `braced_expression`): its
/// named children other than comments. Syntax-error nodes count, so no source
/// is lost; the parser's recovery attaches some of them as extras.
pub(super) fn sequence_children(node: TsNode<'_>) -> Vec<TsNode<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter(|child| child.kind() != "comment" && (!child.is_extra() || child.is_error()))
        .collect()
}

impl Builder<'_> {
    fn collect_comments(&self, node: TsNode<'_>, out: &mut Vec<CommentSpan>) {
        if node.kind() == "comment" {
            let start = node.start_byte();
            let mut end = node.end_byte();
            if self.text.as_bytes()[start..end].ends_with(b"\r") {
                end -= 1;
            }
            out.push(CommentSpan { start, end });
            return;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.collect_comments(child, out);
        }
    }

    pub(super) fn line(&self, byte: usize) -> usize {
        self.lines.line_of(byte)
    }

    pub(super) fn comment(&self, span: CommentSpan, blank_line_before: Option<bool>) -> Comment {
        let text = &self.text[span.start..span.end];
        Comment {
            kind: if text.starts_with("#'") {
                "roxygen"
            } else {
                "comment"
            },
            text: text.to_string(),
            range: self.lines.range(span.start..span.end),
            blank_line_before,
        }
    }

    /// Own-line comments, each with `blank_line_before` measured from the
    /// previous one (the first from `prev_line`).
    fn own_line_comments(
        &self,
        spans: &[CommentSpan],
        mut prev_line: Option<usize>,
    ) -> Vec<Comment> {
        spans
            .iter()
            .map(|&span| {
                let line = self.line(span.start);
                let blank = self.lines.blank_between(prev_line, line);
                prev_line = Some(line);
                self.comment(span, Some(blank))
            })
            .collect()
    }

    /// Build one sequence. `comments` are the comments inside it, in source
    /// order; `open_line` is the line of the block's `{`, or `None` for the
    /// file.
    pub(super) fn sequence(
        &self,
        statements: &[TsNode<'_>],
        comments: Vec<CommentSpan>,
        open_line: Option<usize>,
    ) -> Sequence {
        let count = statements.len();
        let mut inside = vec![Vec::new(); count];
        let mut leading = vec![Vec::new(); count];
        let mut trailing = vec![Vec::new(); count];
        let mut unowned = Vec::new();
        for span in comments {
            // Statements that start at or before the comment.
            let before = statements.partition_point(|s| s.start_byte() <= span.start);
            if before > 0 {
                let previous = statements[before - 1];
                if span.start < previous.end_byte() {
                    inside[before - 1].push(span);
                    continue;
                }
                if self.line(span.start) == self.line(previous.end_byte()) {
                    trailing[before - 1].push(span);
                    continue;
                }
            }
            if before < count {
                leading[before].push(span);
            } else {
                unowned.push(span);
            }
        }

        let mut built = Vec::with_capacity(count);
        let mut prev_line = open_line;
        for (index, node) in statements.iter().enumerate() {
            let first_line = leading[index]
                .first()
                .map_or_else(|| self.line(node.start_byte()), |c| self.line(c.start));
            let blank_line_before = self.lines.blank_between(prev_line, first_line);
            let leading_comments = self.own_line_comments(&leading[index], prev_line);
            let mut pool = std::mem::take(&mut inside[index]);
            let expression = self.statement_expression(*node, &mut pool);
            built.push(Statement {
                text: self.text[node.byte_range()].to_string(),
                range: self.lines.range(node.byte_range()),
                blank_line_before,
                comments: StatementComments {
                    leading: leading_comments,
                    trailing: trailing[index]
                        .iter()
                        .map(|&span| self.comment(span, None))
                        .collect(),
                    // What the expression's blocks didn't take.
                    interior: pool.iter().map(|&span| self.comment(span, None)).collect(),
                },
                expression,
            });
            prev_line = Some(self.line(node.end_byte()));
        }
        let unowned = self.own_line_comments(&unowned, prev_line);
        (built, unowned)
    }

    /// Take the comments inside `[start, end)` out of `pool`, in order.
    pub(super) fn take_comments_within(
        pool: &mut Vec<CommentSpan>,
        start: usize,
        end: usize,
    ) -> Vec<CommentSpan> {
        let (within, rest): (Vec<_>, Vec<_>) = pool
            .iter()
            .partition(|span| span.start >= start && span.end <= end);
        *pool = rest;
        within
    }
}
