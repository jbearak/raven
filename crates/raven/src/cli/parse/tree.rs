//! The expression tree on each statement.
//!
//! Every node has `kind` and `range`; its child nodes sit in named fields in
//! source order. This version gives the structure: which construct each node
//! is, and where its sub-expressions and blocks are. Leaf details (names and
//! how they're written, literal types and values, operators as written,
//! argument names, empty arguments, the pipe placeholder) are not reported
//! yet; they are added as new fields and kinds, so nothing here changes
//! meaning.
//!
//! A `block` node holds its statements and its `block_end` comments, which is
//! how statements inside braces hang on the tree (see `statements`).
//!
//! A statement whose source has a syntax error anywhere in it is, for now, a
//! single `unparsed` node: its blocks aren't descended into, so comments
//! inside it are its `interior` comments.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use tree_sitter::Node as TsNode;

use super::document::Range;
use super::statements::{Builder, Comment, CommentSpan, Statement, sequence_children};

#[derive(Debug)]
pub(crate) struct Node {
    /// Open enum; see `docs/cli.md`.
    pub(crate) kind: &'static str,
    pub(crate) range: Range,
    /// Named fields after `kind` and `range`, in source order.
    pub(crate) fields: Vec<(&'static str, Field)>,
}

/// A call's argument or a function's parameter: not an expression node, so no
/// `kind`, but it has the whole entry's `range`.
#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) range: Range,
    pub(crate) fields: Vec<(&'static str, Field)>,
}

#[derive(Debug)]
pub(crate) enum Field {
    /// A child node, or `null` where the construct has none (an `if` without
    /// `else`, a parameter without a default).
    Node(Option<Box<Node>>),
    Entries(Vec<Entry>),
    Statements(Vec<Statement>),
    BlockComments(BlockComments),
}

#[derive(Debug, Serialize)]
pub(crate) struct BlockComments {
    pub(crate) block_end: Vec<Comment>,
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2 + self.fields.len()))?;
        map.serialize_entry("kind", self.kind)?;
        map.serialize_entry("range", &self.range)?;
        for (name, field) in &self.fields {
            map.serialize_entry(name, field)?;
        }
        map.end()
    }
}

impl Serialize for Entry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1 + self.fields.len()))?;
        map.serialize_entry("range", &self.range)?;
        for (name, field) in &self.fields {
            map.serialize_entry(name, field)?;
        }
        map.end()
    }
}

impl Serialize for Field {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Field::Node(node) => node.serialize(serializer),
            Field::Entries(entries) => entries.serialize(serializer),
            Field::Statements(statements) => statements.serialize(serializer),
            Field::BlockComments(comments) => comments.serialize(serializer),
        }
    }
}

impl Builder<'_> {
    /// A statement's expression. `pool` holds the comments inside the
    /// statement; blocks take theirs out, and the rest are its `interior`.
    pub(super) fn statement_expression(
        &self,
        node: TsNode<'_>,
        pool: &mut Vec<CommentSpan>,
    ) -> Node {
        if node.has_error() {
            return self.leaf(node, "unparsed");
        }
        self.node(node, pool)
    }

    fn leaf(&self, node: TsNode<'_>, kind: &'static str) -> Node {
        Node {
            kind,
            range: self.lines.range(node.byte_range()),
            fields: Vec::new(),
        }
    }

    fn optional(&self, node: Option<TsNode<'_>>, pool: &mut Vec<CommentSpan>) -> Field {
        Field::Node(node.map(|node| Box::new(self.node(node, pool))))
    }

    /// The node for one syntax-error-free expression.
    fn node(&self, node: TsNode<'_>, pool: &mut Vec<CommentSpan>) -> Node {
        let field = |name: &str| node.child_by_field_name(name);
        let kind: &'static str;
        let mut fields: Vec<(&'static str, Field)> = Vec::new();
        match node.kind() {
            "identifier" | "dots" | "dot_dot_i" => kind = "identifier",
            "integer" | "float" | "complex" => kind = "number",
            "string" => kind = "string",
            "true" | "false" | "null" | "inf" | "nan" | "na" => kind = "constant",
            "next" => kind = "next",
            "break" => kind = "break",
            "braced_expression" => {
                kind = "block";
                let comments =
                    Builder::take_comments_within(pool, node.start_byte(), node.end_byte());
                let (statements, block_end) = self.sequence(
                    &sequence_children(node),
                    comments,
                    Some(self.line(node.start_byte())),
                );
                fields.push(("statements", Field::Statements(statements)));
                fields.push((
                    "comments",
                    Field::BlockComments(BlockComments { block_end }),
                ));
            }
            "call" | "subset" | "subset2" => {
                let (head, kind_name) = if node.kind() == "call" {
                    ("function", "call")
                } else {
                    ("target", "index")
                };
                kind = kind_name;
                fields.push((head, self.optional(field("function"), pool)));
                fields.push((
                    "arguments",
                    self.entries(field("arguments"), "argument", "value", pool),
                ));
            }
            "namespace_operator" | "extract_operator" => {
                kind = if node.kind() == "namespace_operator" {
                    "namespace"
                } else {
                    "extract"
                };
                fields.push(("left", self.optional(field("lhs"), pool)));
                fields.push(("right", self.optional(field("rhs"), pool)));
            }
            "binary_operator" => {
                let op = field("operator").map_or("", |op| op.kind());
                let (lhs, rhs) = (field("lhs"), field("rhs"));
                match op {
                    "<-" | "<<-" | "=" | ":=" => {
                        kind = "assignment";
                        fields.push(("target", self.optional(lhs, pool)));
                        fields.push(("value", self.optional(rhs, pool)));
                    }
                    "->" | "->>" => {
                        kind = "assignment";
                        fields.push(("value", self.optional(lhs, pool)));
                        fields.push(("target", self.optional(rhs, pool)));
                    }
                    _ => {
                        kind = match op {
                            "|>" => "pipe",
                            "~" => "formula",
                            _ => "binary",
                        };
                        fields.push(("left", self.optional(lhs, pool)));
                        fields.push(("right", self.optional(rhs, pool)));
                    }
                }
            }
            "unary_operator" => {
                let op = field("operator").map_or("", |op| op.kind());
                if op == "~" {
                    kind = "formula";
                    fields.push(("left", Field::Node(None)));
                    fields.push(("right", self.optional(field("rhs"), pool)));
                } else {
                    kind = "unary";
                    fields.push(("operand", self.optional(field("rhs"), pool)));
                }
            }
            "parenthesized_expression" => {
                kind = "parenthesized";
                fields.push(("body", self.optional(field("body"), pool)));
            }
            "function_definition" => {
                kind = "function";
                fields.push((
                    "parameters",
                    self.entries(field("parameters"), "parameter", "default", pool),
                ));
                fields.push(("body", self.optional(field("body"), pool)));
            }
            "if_statement" => {
                kind = "if";
                fields.push(("condition", self.optional(field("condition"), pool)));
                fields.push(("consequence", self.optional(field("consequence"), pool)));
                fields.push(("alternative", self.optional(field("alternative"), pool)));
            }
            "for_statement" => {
                kind = "for";
                fields.push(("variable", self.optional(field("variable"), pool)));
                fields.push(("sequence", self.optional(field("sequence"), pool)));
                fields.push(("body", self.optional(field("body"), pool)));
            }
            "while_statement" => {
                kind = "while";
                fields.push(("condition", self.optional(field("condition"), pool)));
                fields.push(("body", self.optional(field("body"), pool)));
            }
            "repeat_statement" => {
                kind = "repeat";
                fields.push(("body", self.optional(field("body"), pool)));
            }
            // Not reached for an error-free statement; reported honestly if a
            // grammar update adds a construct this table doesn't know.
            _ => kind = "unparsed",
        }
        Node {
            kind,
            range: self.lines.range(node.byte_range()),
            fields,
        }
    }

    /// The `arguments` of a call or index, or the `parameters` of a function:
    /// one entry per `entry_kind` child, with its `value_field` child.
    fn entries(
        &self,
        list: Option<TsNode<'_>>,
        entry_kind: &str,
        value_field: &'static str,
        pool: &mut Vec<CommentSpan>,
    ) -> Field {
        let Some(list) = list else {
            return Field::Entries(Vec::new());
        };
        let mut cursor = list.walk();
        let entries = list
            .named_children(&mut cursor)
            .filter(|child| child.kind() == entry_kind)
            .map(|entry| Entry {
                range: self.lines.range(entry.byte_range()),
                fields: vec![(
                    value_field,
                    self.optional(entry.child_by_field_name(value_field), pool),
                )],
            })
            .collect();
        Field::Entries(entries)
    }
}
