//! The document's `errors` list: what R's parser would reject or warn about.
//!
//! Three sources feed it, each entry with a `source`, `code`, `severity`,
//! `message` and `range`:
//!
//! - `parser`: the syntax errors `raven check` reports
//!   (`handlers::r_syntax_diagnostics`), with the same codes and messages,
//!   and R's rules for the native pipe's right side and its `_` placeholder,
//!   which tree-sitter's grammar doesn't check.
//! - `lexer`: literals R's lexer rejects or warns about (`literals`): an
//!   invalid escape in a string or backticked name, a zero-length name, a
//!   number R can't read, an unpaired surrogate escape, and R's three warnings
//!   about `L` literals (`1.0L`, `1.5L`, `1e-3L`).
//!
//! Messages are R's (without R's location suffix) or `raven check`'s. An
//! `error`-severity entry is one R's parser stops at, so the statement holding
//! it is `unparsed` (see `statements`). Entries are in source order.

use std::collections::HashSet;

use serde::Serialize;
use tower_lsp::lsp_types::{DiagnosticSeverity, NumberOrString};
use tree_sitter::Node as TsNode;

use super::document::{LineIndex, Position, Range};
use super::literals::{self, Decoded, LiteralError, NumberClass};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ParseError {
    /// `parser` or `lexer`. Open enum.
    pub(crate) source: &'static str,
    /// Kebab-case. Open enum.
    pub(crate) code: String,
    /// `error`, `warning`, `information`, or `hint`. Open enum.
    pub(crate) severity: &'static str,
    pub(crate) message: String,
    pub(crate) range: Range,
    /// The byte span, for finding the statement that holds it.
    #[serde(skip)]
    pub(crate) bytes: std::ops::Range<usize>,
}

impl ParseError {
    pub(crate) fn is_error(&self) -> bool {
        self.severity == "error"
    }
}

/// Codes for the entries this module adds (the `parser` codes from
/// `raven check` are its own).
pub(crate) mod code {
    pub(crate) const INVALID_ESCAPE: &str = "invalid-escape";
    pub(crate) const ZERO_LENGTH_NAME: &str = "zero-length-name";
    pub(crate) const INVALID_NUMBER: &str = "invalid-number";
    pub(crate) const UNPAIRED_SURROGATE: &str = "unpaired-surrogate";
    pub(crate) const INTEGER_UNNECESSARY_DECIMAL: &str = "integer-literal-unnecessary-decimal";
    pub(crate) const INTEGER_DECIMAL: &str = "integer-literal-decimal";
    pub(crate) const INTEGER_NON_INTEGER: &str = "integer-literal-non-integer";
    pub(crate) const PIPE_RHS: &str = "pipe-rhs";
    pub(crate) const PIPE_PLACEHOLDER: &str = "pipe-placeholder";
}

/// Every entry for the tree rooted at `root`, parsed from `text` (the decoded
/// text with each lone `\r` read as `\n`, so tree-sitter's rows are the
/// document's lines), in source order.
pub(crate) fn collect(root: TsNode<'_>, text: &str, lines: &LineIndex<'_>) -> Vec<ParseError> {
    let mut collector = Collector {
        text,
        lines,
        errors: Vec::new(),
    };
    for diagnostic in crate::handlers::r_syntax_diagnostics(root, text) {
        let position = |p: tower_lsp::lsp_types::Position| Position {
            line: p.line,
            character: p.character,
        };
        let range = Range {
            start: position(diagnostic.range.start),
            end: position(diagnostic.range.end),
        };
        let code = match diagnostic.code {
            Some(NumberOrString::String(code)) => code,
            Some(NumberOrString::Number(code)) => code.to_string(),
            None => crate::diagnostic_code::SYNTAX_ERROR.to_string(),
        };
        collector.errors.push(ParseError {
            source: "parser",
            code,
            severity: severity_name(diagnostic.severity),
            message: diagnostic.message,
            range,
            bytes: lines.offset(range.start)..lines.offset(range.end),
        });
    }

    let mut pipes = Vec::new();
    let mut placeholders = Vec::new();
    for_each_node(root, |node| match node.kind() {
        "string" => collector.string(node),
        "identifier" if collector.source(node).starts_with('`') => collector.backtick_name(node),
        "identifier" if collector.source(node) == "_" => placeholders.push(node),
        "argument" => collector.argument_name(node),
        "integer" | "float" | "complex" => collector.number(node),
        "binary_operator"
            if node
                .child_by_field_name("operator")
                .is_some_and(|op| op.kind() == "|>") =>
        {
            pipes.push(node)
        }
        _ => {}
    });
    collector.pipes(&pipes, &placeholders);

    let mut errors = collector.errors;
    errors.sort_by_key(|e| (e.range.start, e.range.end));
    errors
}

fn severity_name(severity: Option<DiagnosticSeverity>) -> &'static str {
    match severity {
        Some(DiagnosticSeverity::WARNING) => "warning",
        Some(DiagnosticSeverity::INFORMATION) => "information",
        Some(DiagnosticSeverity::HINT) => "hint",
        _ => "error",
    }
}

/// Visit every node, parents before children, without recursion.
fn for_each_node<'t>(root: TsNode<'t>, mut visit: impl FnMut(TsNode<'t>)) {
    let mut cursor = root.walk();
    loop {
        visit(cursor.node());
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

struct Collector<'a> {
    text: &'a str,
    lines: &'a LineIndex<'a>,
    errors: Vec<ParseError>,
}

impl Collector<'_> {
    fn source(&self, node: TsNode<'_>) -> &str {
        &self.text[node.byte_range()]
    }

    fn push(
        &mut self,
        source: &'static str,
        code: &str,
        severity: &'static str,
        message: String,
        bytes: std::ops::Range<usize>,
    ) {
        self.errors.push(ParseError {
            source,
            code: code.to_string(),
            severity,
            message,
            range: self.lines.range(bytes.clone()),
            bytes,
        });
    }

    /// A [`LiteralError`] from a token starting at `token_start`.
    fn literal(&mut self, token_start: usize, error: LiteralError, severity: &'static str) {
        let code = if severity == "warning" {
            code::UNPAIRED_SURROGATE
        } else if error.message == ZERO_LENGTH_MESSAGE {
            code::ZERO_LENGTH_NAME
        } else {
            code::INVALID_ESCAPE
        };
        let range = token_start + error.range.start..token_start + error.range.end;
        self.push("lexer", code, severity, error.message, range);
    }

    fn string(&mut self, node: TsNode<'_>) {
        let (_, decoded, warnings) = literals::string_with_warnings(self.source(node));
        for warning in warnings {
            self.literal(node.start_byte(), warning, "warning");
        }
        if let Decoded::Error(error) = decoded {
            self.literal(node.start_byte(), error, "error");
        }
    }

    fn backtick_name(&mut self, node: TsNode<'_>) {
        if let Decoded::Error(error) = literals::backtick_name(self.source(node)) {
            self.literal(node.start_byte(), error, "error");
        }
    }

    /// R rejects an empty string as an argument name (`f("" = 1)`), though
    /// it accepts one as an assignment target, a `$` name, or a namespace.
    fn argument_name(&mut self, node: TsNode<'_>) {
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        if name.kind() == "string"
            && literals::string(self.source(name)).1 == Decoded::Text(String::new())
        {
            self.push(
                "lexer",
                code::ZERO_LENGTH_NAME,
                "error",
                ZERO_LENGTH_MESSAGE.to_string(),
                name.byte_range(),
            );
        }
    }

    fn number(&mut self, node: TsNode<'_>) {
        let text = self.source(node);
        let number = literals::number(text);
        let (code, message) = match number.class {
            _ if number.value.is_none() => {
                // tree-sitter takes `1e` as a number; R's lexer doesn't.
                let message = "unexpected input".to_string();
                return self.push(
                    "lexer",
                    code::INVALID_NUMBER,
                    "error",
                    message,
                    node.byte_range(),
                );
            }
            NumberClass::IntegerWithDecimal => (
                code::INTEGER_UNNECESSARY_DECIMAL,
                format!("integer literal {text} contains unnecessary decimal point"),
            ),
            NumberClass::DoubleFromDecimalL => (
                code::INTEGER_DECIMAL,
                format!("integer literal {text} contains decimal; using numeric value"),
            ),
            NumberClass::DoubleFromNonIntegerL => (
                code::INTEGER_NON_INTEGER,
                format!("non-integer value {text} qualified with L; using numeric value"),
            ),
            NumberClass::Double | NumberClass::Integer | NumberClass::Complex => return,
        };
        self.push("lexer", code, "warning", message, node.byte_range());
    }

    /// R's checks on each `|>`'s right side, and on every `_`: R's parser
    /// replaces each placeholder a pipe accepts with the pipe's left side,
    /// then rejects any `_` left over. Pipes are checked innermost first, as
    /// R substitutes them, so a placeholder an inner pipe takes is gone by
    /// the time an outer pipe looks.
    fn pipes(&mut self, pipes: &[TsNode<'_>], placeholders: &[TsNode<'_>]) {
        let mut taken: HashSet<usize> = HashSet::new();
        // `pipes` is in pre-order, so reversed, each pipe comes after every
        // pipe nested inside it.
        for pipe in pipes.iter().rev() {
            let Some(rhs) = pipe.child_by_field_name("rhs") else {
                continue;
            };
            if rhs.is_error() || rhs.is_missing() {
                continue;
            }
            let check = PipeCheck {
                text: self.text,
                taken: &taken,
            };
            match check.rhs(rhs) {
                Ok(Some(placeholder)) => {
                    taken.insert(placeholder.start_byte());
                }
                Ok(None) => {}
                Err((at, message, code)) => {
                    // R stops at the first error; the right side's other
                    // placeholders aren't reported again as left over.
                    for placeholder in placeholders {
                        if rhs.start_byte() <= placeholder.start_byte()
                            && placeholder.end_byte() <= rhs.end_byte()
                        {
                            taken.insert(placeholder.start_byte());
                        }
                    }
                    self.push("parser", code, "error", message, at.byte_range());
                }
            }
        }
        for placeholder in placeholders {
            if !taken.contains(&placeholder.start_byte()) {
                self.push(
                    "parser",
                    code::PIPE_PLACEHOLDER,
                    "error",
                    "invalid use of pipe placeholder".to_string(),
                    placeholder.byte_range(),
                );
            }
        }
    }
}

const ZERO_LENGTH_MESSAGE: &str = "attempt to use zero-length variable name";

/// R's function symbols a pipe can't call (`IS_SPECIAL_SYMBOL` in R's
/// `names.c`): `x |> if (a) b`, `x |> -1` and `x |> y::z` are errors. The
/// set is R 4.6's, found by parsing ``x |> `op`(a)`` for each symbol.
const SPECIAL_SYMBOLS: &[&str] = &[
    "if", "while", "repeat", "for", "break", "next", "return", "function", "(", "{", "+", "-", "*",
    "/", "^", "%%", "%/%", "%*%", ":", "==", "!=", "<", ">", "<=", ">=", "&", "|", "&&", "||", "!",
    "<-", "<<-", "=", "$", "[", "[[", "$<-", "[<-", "[[<-", "@", "::", ":::", "~", "?", "|>",
];

/// One pipe's right side, checked as R's `xxpipe` does.
struct PipeCheck<'a> {
    text: &'a str,
    /// Placeholders inner pipes already took.
    taken: &'a HashSet<usize>,
}

type PipeError<'t> = (TsNode<'t>, String, &'static str);

impl PipeCheck<'_> {
    fn source(&self, node: TsNode<'_>) -> &str {
        &self.text[node.byte_range()]
    }

    fn is_placeholder(&self, node: TsNode<'_>) -> bool {
        node.kind() == "identifier"
            && self.source(node) == "_"
            && !self.taken.contains(&node.start_byte())
    }

    /// The first placeholder in `node`'s subtree that no inner pipe took.
    fn first_placeholder<'t>(&self, node: TsNode<'t>) -> Option<TsNode<'t>> {
        let mut found = None;
        for_each_node(node, |n| {
            if found.is_none() && self.is_placeholder(n) {
                found = Some(n);
            }
        });
        found
    }

    /// The right side's verdict: the placeholder it takes, if any, or R's
    /// error and where it points.
    fn rhs<'t>(&self, rhs: TsNode<'t>) -> Result<Option<TsNode<'t>>, PipeError<'t>> {
        let Some(function) = r_function(rhs, self.text) else {
            return Err((
                rhs,
                "The pipe operator requires a function call as RHS".into(),
                code::PIPE_RHS,
            ));
        };
        // `x |> _$a[[1]]`: an extraction chain headed by the placeholder.
        if let Some(placeholder) = self.extractor_chain(rhs)? {
            return Ok(Some(placeholder));
        }
        if rhs.kind() == "call"
            && let Some(callee) = rhs.child_by_field_name("function")
            && let Some(placeholder) = self.first_placeholder(callee)
        {
            return Err((
                placeholder,
                "pipe placeholder cannot be used in the RHS function".into(),
                code::PIPE_PLACEHOLDER,
            ));
        }
        let mut taken = None;
        for (named, argument) in r_arguments(rhs) {
            if !self.is_placeholder(argument) {
                continue;
            }
            if taken.is_some() {
                return Err((
                    argument,
                    "pipe placeholder may only appear once".into(),
                    code::PIPE_PLACEHOLDER,
                ));
            }
            if !named {
                return Err((
                    argument,
                    "pipe placeholder can only be used as a named argument".into(),
                    code::PIPE_PLACEHOLDER,
                ));
            }
            taken = Some(argument);
        }
        if taken.is_none()
            && let RFunction::Symbol(name) = function
            && SPECIAL_SYMBOLS.contains(&name.as_str())
        {
            return Err((
                rhs,
                format!("function '{name}' not supported in RHS call of a pipe"),
                code::PIPE_RHS,
            ));
        }
        Ok(taken)
    }

    /// R's `findExtractorChainPHCell`: walk the targets of `$`, `@`, `[` and
    /// `[[` down from `expr`; a placeholder at the head is the one the pipe
    /// takes, and then any other placeholder in the chain is a second use.
    fn extractor_chain<'t>(&self, expr: TsNode<'t>) -> Result<Option<TsNode<'t>>, PipeError<'t>> {
        let (head, rest) = match expr.kind() {
            "subset" | "subset2" => (
                expr.child_by_field_name("function"),
                expr.child_by_field_name("arguments"),
            ),
            "extract_operator" => (
                expr.child_by_field_name("lhs"),
                expr.child_by_field_name("rhs"),
            ),
            _ => return Ok(None),
        };
        let Some(head) = head else { return Ok(None) };
        let found = if self.is_placeholder(head) {
            Some(head)
        } else {
            self.extractor_chain(head)?
        };
        if found.is_some()
            && let Some(second) = rest.and_then(|rest| self.first_placeholder(rest))
        {
            return Err((
                second,
                "pipe placeholder may only appear once".into(),
                code::PIPE_PLACEHOLDER,
            ));
        }
        Ok(found)
    }
}

/// What R calls when it evaluates a node it reads as a call.
enum RFunction {
    /// A symbol, by its name: `f` in `f(x)`, `+` in `a + b`, `if`, `[`.
    Symbol(String),
    /// Any other expression: `pkg::f`, `f()` in `f()(x)`.
    Expression,
}

/// The function of a node R reads as a call (every operator and control-flow
/// construct is one), or `None` for a name or a constant.
fn r_function(node: TsNode<'_>, text: &str) -> Option<RFunction> {
    let symbol = |name: &str| Some(RFunction::Symbol(name.to_string()));
    let operator = || {
        node.child_by_field_name("operator")
            .map_or("", |op| &text[op.byte_range()])
    };
    match node.kind() {
        "call" => {
            let callee = node.child_by_field_name("function")?;
            match callee.kind() {
                "identifier" => {
                    let written = &text[callee.byte_range()];
                    match literals::backtick_name(written) {
                        _ if !written.starts_with('`') => symbol(written),
                        Decoded::Text(name) => symbol(&name),
                        _ => Some(RFunction::Expression),
                    }
                }
                "string" => match literals::string(&text[callee.byte_range()]).1 {
                    Decoded::Text(name) => symbol(&name),
                    _ => Some(RFunction::Expression),
                },
                _ => Some(RFunction::Expression),
            }
        }
        "subset" => symbol("["),
        "subset2" => symbol("[["),
        "extract_operator" | "namespace_operator" => symbol(operator()),
        // R reads `->` as `<-` and `**` as `^`.
        "binary_operator" => symbol(match operator() {
            "->" => "<-",
            "->>" => "<<-",
            "**" => "^",
            op => op,
        }),
        "unary_operator" => symbol(operator()),
        "parenthesized_expression" => symbol("("),
        "braced_expression" => symbol("{"),
        "if_statement" => symbol("if"),
        "for_statement" => symbol("for"),
        "while_statement" => symbol("while"),
        "repeat_statement" => symbol("repeat"),
        "function_definition" => symbol("function"),
        "next" => symbol("next"),
        "break" => symbol("break"),
        _ => None,
    }
}

/// The arguments of a node R reads as a call, in order, each with whether
/// it is named. A call's own arguments; an operator's operands; an index's
/// target then its arguments.
fn r_arguments<'t>(node: TsNode<'t>) -> Vec<(bool, TsNode<'t>)> {
    let field = |name: &str| node.child_by_field_name(name);
    let unnamed = |nodes: &[Option<TsNode<'t>>]| -> Vec<(bool, TsNode<'t>)> {
        nodes.iter().flatten().map(|&n| (false, n)).collect()
    };
    let call_arguments = |list: Option<TsNode<'t>>| -> Vec<(bool, TsNode<'t>)> {
        let Some(list) = list else { return Vec::new() };
        let mut cursor = list.walk();
        list.named_children(&mut cursor)
            .filter(|child| child.kind() == "argument")
            .filter_map(|argument| {
                let value = argument.child_by_field_name("value")?;
                Some((argument.child_by_field_name("name").is_some(), value))
            })
            .collect()
    };
    match node.kind() {
        "call" => call_arguments(field("arguments")),
        "subset" | "subset2" => {
            let mut arguments = unnamed(&[field("function")]);
            arguments.extend(call_arguments(field("arguments")));
            arguments
        }
        "extract_operator" | "namespace_operator" | "binary_operator" => {
            unnamed(&[field("lhs"), field("rhs")])
        }
        "unary_operator" => unnamed(&[field("rhs")]),
        "parenthesized_expression" => unnamed(&[field("body")]),
        "if_statement" => unnamed(&[
            field("condition"),
            field("consequence"),
            field("alternative"),
        ]),
        "for_statement" => unnamed(&[field("variable"), field("sequence"), field("body")]),
        "while_statement" => unnamed(&[field("condition"), field("body")]),
        "repeat_statement" | "function_definition" => unnamed(&[field("body")]),
        "braced_expression" => super::statements::sequence_children(node)
            .into_iter()
            .map(|n| (false, n))
            .collect(),
        _ => Vec::new(),
    }
}
