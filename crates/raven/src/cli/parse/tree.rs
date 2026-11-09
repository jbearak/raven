//! The expression tree on each statement.
//!
//! Every node has `kind` and `range`; the rest of its fields follow in a fixed
//! order: scalar details first (`op`, `text`, `name`, ...), then child nodes in
//! source order. The tree is the source as written, not R's desugared form:
//! `|>` stays a `pipe`, `->` keeps its direction, `**` stays `**`, and
//! parentheses are a node. `docs/cli.md` (`raven parse`, "Parse syntax tree")
//! is the node reference; keep it in step with [`Builder::node`].
//!
//! A `block` node holds its statements and its `block_end` comments, which is
//! how statements inside braces hang on the tree (see `statements`).
//!
//! A statement R's parser can't read is a single `unparsed` node: the
//! innermost statement holding an `error`-severity entry of the `errors`
//! list, or a syntax error in its own structure (see [`Builder::parses`]).
//! Enclosing statements keep their trees, and comments inside an `unparsed`
//! node are its statement's `interior` comments.
//!
//! Literal types and decoded values come from `literals`, which mirrors R's
//! lexer. Where R reads a literal but its value isn't Unicode text (`"\xe9"`),
//! the node omits the value.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use tree_sitter::Node as TsNode;

use super::document::Range;
use super::literals;
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
    /// A scalar detail: `op`, `text`, a decoded `name` or `value`, ...
    Value(serde_json::Value),
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
            Field::Value(value) => value.serialize(serializer),
        }
    }
}

/// A JSON number for a literal's value: an integer when the value is whole
/// and exactly representable, otherwise the shortest form that round-trips;
/// `null` for infinity.
fn json_number(value: f64) -> serde_json::Value {
    const EXACT: f64 = 9_007_199_254_740_992.0; // 2^53
    if value.fract() == 0.0 && value.abs() < EXACT {
        serde_json::Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(serde_json::Value::Null, Into::into)
    }
}

fn resolution_field(resolution: &super::resolve::Resolution) -> Field {
    Field::Value(serde_json::to_value(resolution).expect("a resolution serializes"))
}

fn value(value: impl Into<serde_json::Value>) -> Field {
    Field::Value(value.into())
}

/// Whether `node`'s own structure, outside the statements nested in its
/// blocks, is free of ERROR and MISSING nodes. Collects those nested
/// statements' byte ranges into `nested`.
fn own_structure_parses(node: TsNode<'_>, nested: &mut Vec<std::ops::Range<usize>>) -> bool {
    if node.is_error() || node.is_missing() {
        return false;
    }
    let statements = if node.kind() == "braced_expression" {
        sequence_children(node)
    } else {
        Vec::new()
    };
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if statements.contains(&child) {
            nested.push(child.byte_range());
        } else if child.kind() != "comment" && !own_structure_parses(child, nested) {
            return false;
        }
    }
    true
}

impl Builder<'_> {
    /// A statement's expression. `pool` holds the comments inside the
    /// statement; blocks take theirs out, and the rest are its `interior`.
    pub(super) fn statement_expression(
        &self,
        node: TsNode<'_>,
        pool: &mut Vec<CommentSpan>,
    ) -> Node {
        if self.parses(node) {
            self.node(node, pool)
        } else {
            self.leaf(node, "unparsed")
        }
    }

    /// Whether a statement keeps its tree. It does unless R's parser would
    /// stop in it outside every statement nested in its blocks: an ERROR or
    /// MISSING node in its own structure (a missing `}` of one of its blocks
    /// included), or an `error`-severity entry of the `errors` list that
    /// starts inside it but in none of its nested statements. A nested
    /// statement is judged the same way when its block is built, so the
    /// innermost statement that doesn't parse is the `unparsed` one.
    ///
    /// The span is tree-sitter's: where its recovery can't find a statement's
    /// end (an unclosed bracket), the statement, and so the `unparsed` node,
    /// runs on to where recovery picked up again, which can be the end of the
    /// file.
    fn parses(&self, node: TsNode<'_>) -> bool {
        let inside: Vec<usize> = self
            .error_spans
            .iter()
            .filter(|&&(start, end)| {
                node.start_byte() <= start
                    && (start < node.end_byte() || (start == end && start == node.end_byte()))
            })
            .map(|&(start, _)| start)
            .collect();
        if inside.is_empty() && !node.has_error() {
            return true;
        }
        let mut nested = Vec::new();
        if !own_structure_parses(node, &mut nested) {
            return false;
        }
        inside.iter().all(|&at| {
            nested
                .iter()
                .any(|range: &std::ops::Range<usize>| range.start <= at && at < range.end)
        })
    }

    fn source(&self, node: TsNode<'_>) -> &str {
        &self.text[node.byte_range()]
    }

    fn with_fields(
        &self,
        node: TsNode<'_>,
        kind: &'static str,
        fields: Vec<(&'static str, Field)>,
    ) -> Node {
        Node {
            kind,
            range: self.lines.range(node.byte_range()),
            fields,
        }
    }

    /// A node with no children: its kind and its `text`.
    fn leaf(&self, node: TsNode<'_>, kind: &'static str) -> Node {
        self.with_fields(node, kind, vec![("text", value(self.source(node)))])
    }

    fn optional(&self, node: Option<TsNode<'_>>, pool: &mut Vec<CommentSpan>) -> Field {
        Field::Node(node.map(|node| Box::new(self.node(node, pool))))
    }

    fn optional_name(&self, node: Option<TsNode<'_>>, argument: bool) -> Field {
        Field::Node(node.map(|node| Box::new(self.name(node, argument))))
    }

    /// An `identifier` node. `name` is `None` when R rejects the name (an
    /// invalid escape in backticks), and then isn't printed.
    fn identifier_node(&self, node: TsNode<'_>, name: Option<String>, form: &'static str) -> Node {
        let mut fields = vec![("text", value(self.source(node)))];
        if let Some(name) = name {
            fields.push(("name", value(name)));
        }
        fields.push(("form", value(form)));
        self.with_fields(node, "identifier", fields)
    }

    /// A name token (`identifier`, `dots`, `dot_dot_i`): an identifier, or the
    /// pipe placeholder. A plain `_` is always R's placeholder token; R
    /// rejects it outside the places the pipe allows, and the parse-errors
    /// list says so.
    fn identifier(&self, node: TsNode<'_>) -> Node {
        let text = self.source(node);
        if text == "_" {
            return self.leaf(node, "placeholder");
        }
        if text.starts_with('`') {
            return self.identifier_node(node, literals::backtick_name(text).text(), "backtick");
        }
        self.identifier_node(node, Some(text.to_string()), "plain")
    }

    /// A name where R also accepts a string (an argument name, either side of
    /// `::`, the right side of `$` and `@`) or, for an argument name, `NULL`.
    /// A string there is an identifier with form `string`. An empty argument
    /// name is one R rejects, so it has no `name`.
    fn name(&self, node: TsNode<'_>, argument: bool) -> Node {
        match node.kind() {
            "string" => {
                let (_, decoded) = literals::string(self.source(node));
                let name = decoded.text().filter(|name| !(argument && name.is_empty()));
                self.identifier_node(node, name, "string")
            }
            "null" => self.identifier_node(node, Some("NULL".into()), "plain"),
            _ => self.identifier(node),
        }
    }

    fn number(&self, node: TsNode<'_>) -> Node {
        let text = self.source(node);
        let number = literals::number(text);
        let mut fields = vec![
            ("text", value(text)),
            ("type", value(number.class.r_type())),
        ];
        if let Some(v) = number.value {
            fields.push(("value", Field::Value(json_number(v))));
        }
        self.with_fields(node, "number", fields)
    }

    fn string(&self, node: TsNode<'_>) -> Node {
        let text = self.source(node);
        let (form, decoded) = literals::string(text);
        let mut fields = vec![("text", value(text))];
        if let Some(decoded) = decoded.text() {
            fields.push(("value", value(decoded)));
        }
        fields.push(("quote", value(form.quote.to_string())));
        fields.push(("raw", value(form.raw)));
        fields.push((
            "delimiters",
            value(serde_json::json!({"open": form.open, "close": form.close})),
        ));
        self.with_fields(node, "string", fields)
    }

    fn constant(&self, node: TsNode<'_>) -> Node {
        let text = self.source(node);
        let r_type = match text {
            "TRUE" | "FALSE" | "NA" => "logical",
            "NA_integer_" => "integer",
            "NA_real_" | "Inf" | "NaN" => "double",
            "NA_complex_" => "complex",
            "NA_character_" => "character",
            _ => "NULL",
        };
        self.with_fields(
            node,
            "constant",
            vec![("text", value(text)), ("type", value(r_type))],
        )
    }

    /// The node for one syntax-error-free expression.
    fn node(&self, node: TsNode<'_>, pool: &mut Vec<CommentSpan>) -> Node {
        let field = |name: &str| node.child_by_field_name(name);
        let op = || value(field("operator").map_or("", |op| self.source(op)));
        let kind: &'static str;
        let mut fields: Vec<(&'static str, Field)> = Vec::new();
        match node.kind() {
            "identifier" | "dots" | "dot_dot_i" => {
                let mut identifier = self.identifier(node);
                if let Some(resolution) = self.resolutions.value(node) {
                    identifier
                        .fields
                        .push(("resolution", resolution_field(resolution)));
                }
                return identifier;
            }
            "integer" | "float" | "complex" => return self.number(node),
            "string" => return self.string(node),
            "true" | "false" | "null" | "inf" | "nan" | "na" => return self.constant(node),
            "next" => return self.leaf(node, "next"),
            "break" => return self.leaf(node, "break"),
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
            "call" => {
                kind = "call";
                fields.push(("function", self.optional(field("function"), pool)));
                let resolution = self.resolutions.call(node).cloned().unwrap_or(
                    super::resolve::Resolution::Unresolved {
                        reason: None,
                        packages: Vec::new(),
                    },
                );
                fields.push(("resolution", resolution_field(&resolution)));
                fields.push(("arguments", self.arguments(field("arguments"), pool)));
            }
            "subset" | "subset2" => {
                kind = "index";
                let op = if node.kind() == "subset" { "[" } else { "[[" };
                fields.push(("op", value(op)));
                fields.push(("target", self.optional(field("function"), pool)));
                fields.push(("arguments", self.arguments(field("arguments"), pool)));
            }
            "namespace_operator" => {
                kind = "namespace";
                fields.push(("op", op()));
                fields.push(("left", self.optional_name(field("lhs"), false)));
                fields.push(("right", self.optional_name(field("rhs"), false)));
            }
            "extract_operator" => {
                kind = "extract";
                fields.push(("op", op()));
                fields.push(("left", self.optional(field("lhs"), pool)));
                fields.push(("right", self.optional_name(field("rhs"), false)));
            }
            "binary_operator" => {
                let operator = field("operator").map_or("", |op| op.kind());
                let (lhs, rhs) = (field("lhs"), field("rhs"));
                fields.push(("op", op()));
                // `%op%` and `:=`: the function the operator calls.
                if let Some(resolution) = self.resolutions.operator(node) {
                    fields.push(("resolution", resolution_field(resolution)));
                }
                match operator {
                    "<-" | "<<-" | "=" | ":=" => {
                        kind = "assignment";
                        fields.push(("target", self.optional(lhs, pool)));
                        fields.push(("value", self.optional(rhs, pool)));
                    }
                    // As written: the value is on the left.
                    "->" | "->>" => {
                        kind = "assignment";
                        fields.push(("value", self.optional(lhs, pool)));
                        fields.push(("target", self.optional(rhs, pool)));
                    }
                    _ => {
                        kind = match operator {
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
                let operator = field("operator").map_or("", |op| op.kind());
                fields.push(("op", op()));
                if operator == "~" {
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
                let keyword = field("name").map_or("function", |k| self.source(k));
                fields.push(("keyword", value(keyword)));
                fields.push(("parameters", self.parameters(field("parameters"), pool)));
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
            _ => return self.leaf(node, "unparsed"),
        }
        self.with_fields(node, kind, fields)
    }

    /// A call's or index's `arguments`, in order, with an entry for each
    /// empty argument. As in R, the commas delimit the arguments: `f()` has
    /// none, `f(,)` two empty ones, `x[i, ]` an `i` and an empty one. An
    /// empty argument's range is empty, just after the `(`, `[`, `[[` or `,`
    /// before it.
    fn arguments(&self, list: Option<TsNode<'_>>, pool: &mut Vec<CommentSpan>) -> Field {
        let Some(list) = list else {
            return Field::Entries(Vec::new());
        };
        let close = list.child_by_field_name("close");
        let empty = |at: usize| Entry {
            range: self.lines.range(at..at),
            fields: vec![("name", Field::Node(None)), ("value", Field::Node(None))],
        };
        let mut entries = Vec::new();
        let mut slot_start = list
            .child_by_field_name("open")
            .map_or(list.start_byte(), |open| open.end_byte());
        let mut slot_filled = false;
        let mut commas = 0;
        let mut cursor = list.walk();
        for child in list.children(&mut cursor) {
            if child.is_extra() {
                continue;
            }
            if child.kind() == "argument" {
                entries.push(Entry {
                    range: self.lines.range(child.byte_range()),
                    fields: vec![
                        (
                            "name",
                            self.optional_name(child.child_by_field_name("name"), true),
                        ),
                        (
                            "value",
                            self.optional(child.child_by_field_name("value"), pool),
                        ),
                    ],
                });
                slot_filled = true;
            } else if child.kind() == "comma" {
                if !slot_filled {
                    entries.push(empty(slot_start));
                }
                commas += 1;
                slot_filled = false;
                slot_start = child.end_byte();
            } else if Some(child) == close && !slot_filled && commas > 0 {
                entries.push(empty(slot_start));
            }
        }
        Field::Entries(entries)
    }

    /// A function's `parameters`: each with its `name` and its `default`.
    fn parameters(&self, list: Option<TsNode<'_>>, pool: &mut Vec<CommentSpan>) -> Field {
        let Some(list) = list else {
            return Field::Entries(Vec::new());
        };
        let mut cursor = list.walk();
        let entries = list
            .named_children(&mut cursor)
            .filter(|child| child.kind() == "parameter")
            .map(|parameter| Entry {
                range: self.lines.range(parameter.byte_range()),
                fields: vec![
                    (
                        "name",
                        self.optional_name(parameter.child_by_field_name("name"), false),
                    ),
                    (
                        "default",
                        self.optional(parameter.child_by_field_name("default"), pool),
                    ),
                ],
            })
            .collect();
        Field::Entries(entries)
    }
}
