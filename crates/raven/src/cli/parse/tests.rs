//! Unit tests for `raven parse`'s documents. End-to-end tests of the binary
//! (framing, exit codes, paths against `raven graph`) are in
//! `crates/raven/tests/cli_parse.rs`.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::document::{document_for_file, document_from_text};
use super::*;

const NO_PACKAGE_DATA: crate::cli::check::PackageData = crate::cli::check::PackageData {
    enabled: false,
    r_found: false,
    names_db: false,
    frozen: false,
};

fn file_doc(path: &Path, printed: &str) -> Value {
    serde_json::to_value(document_for_file(
        path,
        printed.into(),
        NO_PACKAGE_DATA,
        &mut |_| Box::new(resolve::NoScope),
    ))
    .unwrap()
}

fn doc_of_bytes(bytes: &[u8]) -> Value {
    let detected = crate::state::detect_source_encoding(bytes);
    let text = crate::state::decode_source(bytes.to_vec()).unwrap();
    serde_json::to_value(document_from_text(
        "t.R".into(),
        detected,
        &text,
        NO_PACKAGE_DATA,
        &resolve::NoScope,
    ))
    .unwrap()
}

fn doc(text: &str) -> Value {
    doc_of_bytes(text.as_bytes())
}

/// Byte offset of an LSP-style position, computed independently of
/// `LineIndex`: lines end at `\n`, `\r\n` or a lone `\r`; characters are
/// UTF-16 units.
fn offset(text: &str, position: &Value) -> usize {
    let line = position["line"].as_u64().unwrap() as usize;
    let character = position["character"].as_u64().unwrap() as usize;
    let mut line_start = 0;
    let mut current = 0;
    let bytes = text.as_bytes();
    let mut i = 0;
    while current < line {
        assert!(i < bytes.len(), "line {line} is past the end");
        if bytes[i] == b'\n' || (bytes[i] == b'\r' && bytes.get(i + 1) != Some(&b'\n')) {
            current += 1;
            line_start = i + 1;
        }
        i += 1;
    }
    let mut units = 0;
    for (index, ch) in text[line_start..].char_indices() {
        if units == character {
            return line_start + index;
        }
        assert!(
            ch != '\n' && ch != '\r',
            "character {character} is past the line end"
        );
        units += ch.len_utf16();
    }
    assert_eq!(units, character);
    text.len()
}

fn slice<'t>(text: &'t str, range: &Value) -> &'t str {
    &text[offset(text, &range["start"])..offset(text, &range["end"])]
}

/// Every statement object in the document, depth first.
fn statements(value: &Value) -> Vec<&Value> {
    fn walk<'v>(value: &'v Value, out: &mut Vec<&'v Value>) {
        match value {
            Value::Object(map) => {
                if map.contains_key("expression") && map.contains_key("text") {
                    out.push(value);
                }
                for child in map.values() {
                    walk(child, out);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

/// Every comment in every list: statements' three lists, blocks'
/// `block_end`, and the file-level list.
fn comments(document: &Value) -> Vec<&Value> {
    fn walk<'v>(value: &'v Value, out: &mut Vec<&'v Value>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if matches!(
                        key.as_str(),
                        "leading" | "trailing" | "interior" | "block_end"
                    ) {
                        out.extend(child.as_array().unwrap());
                    } else {
                        walk(child, out);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out: Vec<&Value> = document["comments"].as_array().unwrap().iter().collect();
    for statement in document["statements"].as_array().unwrap() {
        walk(statement, &mut out);
    }
    out
}

/// Every `#` comment the grammar sees, as `(start, end)` byte offsets (a
/// `\r` before `\n` excluded): the oracle for "every comment exactly once".
fn grammar_comments(text: &str) -> Vec<(usize, usize)> {
    fn walk(node: tree_sitter::Node<'_>, text: &str, out: &mut Vec<(usize, usize)>) {
        if node.kind() == "comment" {
            let end = node.end_byte() - usize::from(text[..node.end_byte()].ends_with('\r'));
            out.push((node.start_byte(), end));
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            walk(child, text, out);
        }
    }
    // R ends a line at a lone `\r`; the grammar needs it spelled `\n`.
    let as_r_reads = text
        .replace("\r\n", "\u{0}\u{0}")
        .replace('\r', "\n")
        .replace("\u{0}\u{0}", "\r\n");
    let tree = crate::parser_pool::with_parser(|p| p.parse(&as_r_reads, None)).unwrap();
    let mut out = Vec::new();
    walk(tree.root_node(), text, &mut out);
    out
}

/// The invariants every document holds: each statement's and comment's
/// `text` is its range's slice, and every comment appears exactly once.
fn assert_invariants(text: &str, document: &Value) {
    for statement in statements(document) {
        assert_eq!(
            slice(text, &statement["range"]),
            statement["text"].as_str().unwrap(),
            "statement range doesn't slice to its text"
        );
    }
    assert_tree_invariants(text, document);
    let listed = comments(document);
    for comment in &listed {
        assert_eq!(
            slice(text, &comment["range"]),
            comment["text"].as_str().unwrap()
        );
    }
    let mut listed: Vec<(usize, usize)> = listed
        .iter()
        .map(|c| {
            (
                offset(text, &c["range"]["start"]),
                offset(text, &c["range"]["end"]),
            )
        })
        .collect();
    listed.sort();
    assert_eq!(listed, grammar_comments(text), "every comment exactly once");

    // No source is lost: every byte other than whitespace and `;` lies in a
    // top-level statement or a comment.
    let mut covered: Vec<(usize, usize)> = listed;
    for statement in document["statements"].as_array().unwrap() {
        covered.push((
            offset(text, &statement["range"]["start"]),
            offset(text, &statement["range"]["end"]),
        ));
    }
    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() || ch == ';' {
            continue;
        }
        assert!(
            covered
                .iter()
                .any(|&(start, end)| start <= index && index < end),
            "{ch:?} at byte {index} is in no statement or comment"
        );
    }
}

/// The tree's invariants, over every statement's expression: every node has
/// `kind` and `range`; every node, argument or parameter entry, and nested
/// statement lies inside its parent's range; and a node's `text`, where it
/// has one, is its range's slice.
fn assert_tree_invariants(text: &str, document: &Value) {
    type Span = (usize, usize);
    fn check(text: &str, value: &Value, parent: Span, entry: bool) {
        let Value::Object(map) = value else { return };
        let mut own = parent;
        if let Some(range) = map.get("range") {
            let span = (offset(text, &range["start"]), offset(text, &range["end"]));
            assert!(
                parent.0 <= span.0 && span.0 <= span.1 && span.1 <= parent.1,
                "{value} at {span:?} isn't inside its parent at {parent:?}"
            );
            let statement = map.contains_key("expression");
            if !entry && !statement {
                assert!(map["kind"].is_string(), "a node without `kind`: {value}");
            }
            if let Some(Value::String(written)) = map.get("text") {
                assert_eq!(
                    &text[span.0..span.1],
                    written,
                    "`text` isn't the range's slice"
                );
            }
            own = span;
        }
        for (key, child) in map {
            match (key.as_str(), child) {
                // Comments aren't tree nodes: a leading comment precedes its
                // statement.
                ("comments", _) => {}
                ("arguments" | "parameters", Value::Array(items)) => {
                    items.iter().for_each(|item| check(text, item, own, true));
                }
                (_, Value::Array(items)) => {
                    items.iter().for_each(|item| check(text, item, own, false));
                }
                (_, other) => check(text, other, own, false),
            }
        }
    }
    for statement in document["statements"].as_array().unwrap() {
        check(text, statement, (0, text.len()), false);
    }
}

fn texts(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|c| c["text"].as_str().unwrap())
        .collect()
}

fn blanks(list: &Value) -> Vec<bool> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|c| c["blank_line_before"].as_bool().unwrap())
        .collect()
}

/// Covers multiline pipe chains and calls, every comment list, braced
/// arguments, `{{ }}`, and `;`.
const FIXTURE: &str = "\
# file header

# group two
x <- 1 # trailing x

#' Roxygen title
#' @export
y <- df |>
  # between steps
  filter(a) |>
  summarise(n = n()) # trailing y
f(a, # after a
  b)
if (cond) {
  p()
  # end of if block
} else {
  q()

  # end of else block
}
res <- local({
  a <- 1
  # note
  a + 1
})
g({{ v }})
s1 <- 1; s2 <- 2 # after s2
# after everything
";

fn top(document: &Value, index: usize) -> &Value {
    &document["statements"][index]
}

#[test]
fn lf_and_crlf_ranges_slice_to_text_and_comments_appear_once() {
    let lf = doc(FIXTURE);
    assert_eq!(lf["encoding"]["line_endings"], "lf");
    assert_invariants(FIXTURE, &lf);

    let crlf_text = FIXTURE.replace('\n', "\r\n");
    let crlf = doc(&crlf_text);
    assert_eq!(crlf["encoding"]["line_endings"], "crlf");
    assert_invariants(&crlf_text, &crlf);
    // `\r\n` stays in a multiline statement's text.
    assert!(top(&crlf, 1).text().contains("df |>\r\n"));
    // Same lines and characters as the LF file: a line ending isn't part of
    // a line's characters.
    assert_eq!(lf["line_count"], crlf["line_count"]);
    for (a, b) in statements(&lf).iter().zip(statements(&crlf)) {
        assert_eq!(a["range"], b["range"]);
    }
}

trait Text {
    fn text(&self) -> &str;
}

impl Text for Value {
    fn text(&self) -> &str {
        self["text"].as_str().unwrap()
    }
}

#[test]
fn statements_and_comment_placement() {
    let d = doc(FIXTURE);
    let tops: Vec<&str> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.text())
        .collect();
    assert_eq!(
        tops,
        [
            "x <- 1",
            "y <- df |>\n  # between steps\n  filter(a) |>\n  summarise(n = n())",
            "f(a, # after a\n  b)",
            "if (cond) {\n  p()\n  # end of if block\n} else {\n  q()\n\n  # end of else block\n}",
            "res <- local({\n  a <- 1\n  # note\n  a + 1\n})",
            "g({{ v }})",
            "s1 <- 1",
            "s2 <- 2",
        ]
    );

    // Leading groups keep the blank line between them.
    let x = top(&d, 0);
    assert_eq!(
        texts(&x["comments"]["leading"]),
        ["# file header", "# group two"]
    );
    assert_eq!(blanks(&x["comments"]["leading"]), [false, true]);
    assert_eq!(x["blank_line_before"], false);
    assert_eq!(texts(&x["comments"]["trailing"]), ["# trailing x"]);

    // Roxygen leading comments; interior between pipe steps.
    let y = top(&d, 1);
    assert_eq!(y["blank_line_before"], true);
    let leading = y["comments"]["leading"].as_array().unwrap();
    assert!(leading.iter().all(|c| c["kind"] == "roxygen"));
    assert_eq!(blanks(&y["comments"]["leading"]), [true, false]);
    assert_eq!(texts(&y["comments"]["interior"]), ["# between steps"]);
    assert_eq!(texts(&y["comments"]["trailing"]), ["# trailing y"]);
    assert_eq!(x["comments"]["trailing"][0]["kind"], "comment");
    // Trailing and interior comments carry no `blank_line_before`.
    assert!(
        x["comments"]["trailing"][0]
            .get("blank_line_before")
            .is_none()
    );

    // Interior between arguments.
    let f = top(&d, 2);
    assert_eq!(texts(&f["comments"]["interior"]), ["# after a"]);
    assert_eq!(f["blank_line_before"], false);

    // Block-end comments per block of `if ... else`.
    let branch = &top(&d, 3)["expression"];
    assert_eq!(branch["kind"], "if");
    let then_block = &branch["consequence"];
    let else_block = &branch["alternative"];
    assert_eq!(then_block["kind"], "block");
    assert_eq!(then_block["statements"][0].text(), "p()");
    assert_eq!(
        texts(&then_block["comments"]["block_end"]),
        ["# end of if block"]
    );
    assert_eq!(blanks(&then_block["comments"]["block_end"]), [false]);
    assert_eq!(else_block["statements"][0].text(), "q()");
    assert_eq!(
        texts(&else_block["comments"]["block_end"]),
        ["# end of else block"]
    );
    assert_eq!(blanks(&else_block["comments"]["block_end"]), [true]);
    assert!(
        top(&d, 3)["comments"]["interior"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // `local({ ... })`: statements inside a braced argument, on its block.
    let local = &top(&d, 4)["expression"];
    assert_eq!(local["kind"], "assignment");
    let call = &local["value"];
    assert_eq!(call["kind"], "call");
    let block = &call["arguments"][0]["value"];
    assert_eq!(block["kind"], "block");
    let inner: Vec<&str> = block["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.text())
        .collect();
    assert_eq!(inner, ["a <- 1", "a + 1"]);
    assert_eq!(
        texts(&block["statements"][1]["comments"]["leading"]),
        ["# note"]
    );
    assert_eq!(block["statements"][0]["blank_line_before"], false);

    // `{{ v }}` is a block whose one statement is a block.
    let outer = &top(&d, 5)["expression"]["arguments"][0]["value"];
    assert_eq!(outer["kind"], "block");
    let inner_block = &outer["statements"][0];
    assert_eq!(inner_block.text(), "{ v }");
    assert_eq!(inner_block["expression"]["kind"], "block");
    assert_eq!(inner_block["expression"]["statements"][0].text(), "v");

    // `;` separates two statements; the trailing comment is the last one's.
    assert!(
        top(&d, 6)["comments"]["trailing"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(texts(&top(&d, 7)["comments"]["trailing"]), ["# after s2"]);

    // Own-line comments after the last statement are file-level.
    assert_eq!(texts(&d["comments"]), ["# after everything"]);
    assert_eq!(blanks(&d["comments"]), [false]);
}

#[test]
fn non_ascii_ranges_count_utf16_units() {
    let text = "größe <- 1\n`größe` <- \"😀\"; z <- 1\n";
    let d = doc(text);
    assert_invariants(text, &d);
    let range = |i: usize| top(&d, i)["range"].clone();
    // `größe <- 1`: 10 characters (12 bytes).
    assert_eq!(
        range(0)["end"],
        serde_json::json!({"line": 0, "character": 10})
    );
    // `` `größe` <- "😀" ``: the emoji is two UTF-16 units, so 15.
    assert_eq!(
        range(1)["end"],
        serde_json::json!({"line": 1, "character": 15})
    );
    assert_eq!(
        range(2)["start"],
        serde_json::json!({"line": 1, "character": 17})
    );

    // The example in docs/cli.md: 13 UTF-16 units, 12 code points, 17 bytes.
    let text = "größe <- \"😀\"";
    assert_eq!((text.chars().count(), text.len()), (12, 17));
    let d = doc(text);
    assert_eq!(
        top(&d, 0)["range"]["end"],
        serde_json::json!({"line": 0, "character": 13})
    );
}

#[test]
fn documented_kinds_for_each_operator_and_constant() {
    let text = "?x; a ? b; x@y; pkg:::f; x ->> y; x <<- 1; x := 1; +x; \
                TRUE; FALSE; NA; NA_integer_; NA_real_; NA_character_; Inf; NaN; \
                1i; 0x10L; 'q'; ...; ..1\n";
    let d = doc(text);
    let kinds: Vec<&str> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["expression"]["kind"].as_str().unwrap())
        .collect();
    let mut expected = vec![
        "unary",
        "binary",
        "extract",
        "namespace",
        "assignment",
        "assignment",
        "assignment",
        "unary",
    ];
    expected.extend(["constant"; 8]);
    expected.extend(["number", "number", "string", "identifier", "identifier"]);
    assert_eq!(kinds, expected);
}

#[test]
fn bom_is_reported_and_not_counted() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(b"x <- 1 # one\r\n");
    let d = doc_of_bytes(&bytes);
    assert_eq!(
        d["encoding"],
        serde_json::json!({"name": "UTF-8", "bom": true, "line_endings": "crlf"})
    );
    assert_eq!(
        top(&d, 0)["range"]["start"],
        serde_json::json!({"line": 0, "character": 0})
    );
    assert_invariants("x <- 1 # one\r\n", &d);
    assert_eq!(texts(&top(&d, 0)["comments"]["trailing"]), ["# one"]);

    let plain = doc("x\n");
    assert_eq!(
        plain["encoding"],
        serde_json::json!({"name": "UTF-8", "bom": false, "line_endings": "lf"})
    );

    let mut utf16 = vec![0xFF, 0xFE];
    for unit in "x <- 1\n".encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    let d = doc_of_bytes(&utf16);
    assert_eq!(d["encoding"]["name"], "UTF-16LE");
    assert_eq!(d["encoding"]["bom"], true);
    assert_eq!(top(&d, 0).text(), "x <- 1");
}

#[test]
fn lone_cr_ends_a_line() {
    let text = "# a\rx <- 1\r";
    let d = doc(text);
    assert_invariants(text, &d);
    assert_eq!(d["encoding"]["line_endings"], "cr");
    assert_eq!(d["line_count"], 2);
    assert_eq!(top(&d, 0).text(), "x <- 1");
    assert_eq!(texts(&top(&d, 0)["comments"]["leading"]), ["# a"]);
}

#[test]
fn empty_and_comment_only_files() {
    let empty = doc("");
    assert_eq!(empty["line_count"], 0);
    assert_eq!(empty["encoding"]["line_endings"], "none");
    assert_eq!(empty["statements"], serde_json::json!([]));
    assert_eq!(empty["comments"], serde_json::json!([]));

    let text = "# one\n\n# two\n";
    let d = doc(text);
    assert_invariants(text, &d);
    assert_eq!(texts(&d["comments"]), ["# one", "# two"]);
    assert_eq!(blanks(&d["comments"]), [false, true]);
}

#[test]
fn blank_line_before_counts_from_the_block_and_file_start() {
    let text = "\nx <- 1\nf <- function() {\n\n  y\n  { # opening\n    z\n  }\n}\n";
    let d = doc(text);
    assert_invariants(text, &d);
    assert_eq!(top(&d, 0)["blank_line_before"], true);
    assert_eq!(top(&d, 1)["blank_line_before"], false);
    let body = &top(&d, 1)["expression"]["value"]["body"];
    assert_eq!(body["kind"], "block");
    assert_eq!(body["statements"][0]["blank_line_before"], true);
    // A comment on a block's `{` line, before its first statement, leads it.
    let nested = &body["statements"][1]["expression"];
    assert_eq!(nested["kind"], "block");
    assert_eq!(
        texts(&nested["statements"][0]["comments"]["leading"]),
        ["# opening"]
    );
    assert_eq!(
        blanks(&nested["statements"][0]["comments"]["leading"]),
        [false]
    );
}

#[test]
fn syntax_error_still_gets_a_full_document() {
    let text = "x <- 1\ny <- )\n# inside\nz <- 2\nw <- 3\n";
    let d = doc(text);
    assert!(d.get("error").is_none());
    assert_invariants(text, &d);
    let kinds: Vec<&str> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["expression"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds.first(), Some(&"assignment"));
    assert!(kinds.contains(&"unparsed"), "{kinds:?}");
    assert_eq!(kinds.last(), Some(&"assignment"));
}

#[test]
fn recovery_errors_are_unparsed_statements_not_dropped() {
    for text in [")\n", "x <- )\n", "x <- 1\n)\ny <- 2\n", "f({ a\n)\n# c\n"] {
        let d = doc(text);
        assert_invariants(text, &d);
        assert!(
            d["statements"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["expression"]["kind"] == "unparsed"),
            "{text:?}: {d}"
        );
    }
    let d = doc("x <- 1\n)\ny <- 2\n");
    let texts: Vec<&str> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.text())
        .collect();
    assert_eq!(texts, ["x <- 1", ")", "y <- 2"]);
}

/// A tree with `range` removed everywhere, for comparing shapes.
fn shape(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "range")
                .map(|(key, child)| (key.clone(), shape(child)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(shape).collect()),
        other => other.clone(),
    }
}

/// Each top-level statement's expression, with the document's invariants
/// (child ranges inside their parents, `text` matching ranges) checked.
fn expressions(text: &str) -> Vec<Value> {
    let d = doc(text);
    assert_invariants(text, &d);
    d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["expression"].clone())
        .collect()
}

fn ident(name: &str) -> Value {
    json!({"kind": "identifier", "text": name, "name": name, "form": "plain"})
}

fn start_character(node: &Value) -> u64 {
    node["range"]["start"]["character"].as_u64().unwrap()
}

#[test]
fn number_literals_report_r_types_and_values() {
    let cases = [
        ("1", "double", json!(1)),
        ("1e3", "double", json!(1000)),
        ("0.1", "double", json!(0.1)),
        ("1L", "integer", json!(1)),
        ("1e3L", "integer", json!(1000)),
        ("1.0L", "integer", json!(1)),
        ("0x10", "double", json!(16)),
        ("0x10L", "integer", json!(16)),
        ("0x1p3", "double", json!(8)),
        ("1.5L", "double", json!(1.5)),
        ("1e-3L", "double", json!(0.001)),
        ("100000000000L", "double", json!(100000000000_i64)),
        ("1e999", "double", Value::Null),
        ("1i", "complex", json!(1)),
        ("2.5i", "complex", json!(2.5)),
    ];
    let text: Vec<&str> = cases.iter().map(|case| case.0).collect();
    let text = text.join("; ");
    let nodes = expressions(&text);
    assert_eq!(nodes.len(), cases.len());
    for (node, (written, r_type, value)) in nodes.iter().zip(&cases) {
        assert_eq!(
            shape(node),
            json!({"kind": "number", "text": written, "type": r_type, "value": value}),
            "{written}"
        );
    }
    // Whole values print as JSON integers; others in shortest round-trip form.
    let printed = serde_json::to_string(&nodes).unwrap();
    assert!(printed.contains(r#""text":"100000000000L","type":"double","value":100000000000}"#));
    assert!(printed.contains(r#""text":"1e-3L","type":"double","value":0.001}"#));
    assert!(printed.contains(r#""text":"1e999","type":"double","value":null}"#));
}

#[test]
fn reserved_constants_have_types_and_t_and_f_are_identifiers() {
    let cases = [
        ("TRUE", "logical"),
        ("FALSE", "logical"),
        ("NA", "logical"),
        ("NA_integer_", "integer"),
        ("NA_real_", "double"),
        ("NA_character_", "character"),
        ("NA_complex_", "complex"),
        ("Inf", "double"),
        ("NaN", "double"),
        ("NULL", "NULL"),
    ];
    let text: Vec<&str> = cases.iter().map(|case| case.0).collect();
    let nodes = expressions(&format!("{}; T; F", text.join("; ")));
    for (node, (written, r_type)) in nodes.iter().zip(&cases) {
        assert_eq!(
            shape(node),
            json!({"kind": "constant", "text": written, "type": r_type})
        );
    }
    assert_eq!(shape(&nodes[cases.len()]), ident("T"));
    assert_eq!(shape(&nodes[cases.len() + 1]), ident("F"));
}

#[test]
fn negative_numbers_are_unary_minus_over_a_literal() {
    let nodes = expressions("-1; -Inf; - 2L");
    assert_eq!(
        shape(&nodes[0]),
        json!({"kind": "unary", "op": "-",
               "operand": {"kind": "number", "text": "1", "type": "double", "value": 1}})
    );
    assert_eq!(start_character(&nodes[0]["operand"]), 1);
    assert_eq!(
        shape(&nodes[1]),
        json!({"kind": "unary", "op": "-",
               "operand": {"kind": "constant", "text": "Inf", "type": "double"}})
    );
    assert_eq!(nodes[2]["operand"]["type"], "integer");
}

#[test]
fn strings_decode_escapes_and_keep_their_delimiters() {
    let text = concat!(
        r#""a\tb\x41\\\"\101\xc3\xa9"; 'it\'s'; "#,
        r#"r"(a\nb)"; R"[x]"; r"---(a)"b)---"; r'{y}'; "\q"; "\xe9"; ""; "#,
        r#""\u{00e9}\U{1F600}"; "\u{00e9}\x41""#,
    );
    let nodes = expressions(text);
    let string = |text: &str, value: &str, quote: &str, raw: bool, open: &str, close: &str| {
        json!({"kind": "string", "text": text, "value": value, "quote": quote, "raw": raw,
               "delimiters": {"open": open, "close": close}})
    };
    assert_eq!(
        shape(&nodes[0]),
        string(
            r#""a\tb\x41\\\"\101\xc3\xa9""#,
            "a\tbA\\\"Aé",
            "\"",
            false,
            "\"",
            "\""
        )
    );
    assert_eq!(
        shape(&nodes[1]),
        string(r"'it\'s'", "it's", "'", false, "'", "'")
    );
    assert_eq!(
        shape(&nodes[2]),
        string(r#"r"(a\nb)""#, r"a\nb", "\"", true, "r\"(", ")\"")
    );
    assert_eq!(
        shape(&nodes[3]),
        string(r#"R"[x]""#, "x", "\"", true, "R\"[", "]\"")
    );
    assert_eq!(
        shape(&nodes[4]),
        string(
            r#"r"---(a)"b)---""#,
            "a)\"b",
            "\"",
            true,
            "r\"---(",
            ")---\""
        )
    );
    assert_eq!(
        shape(&nodes[5]),
        string("r'{y}'", "y", "'", true, "r'{", "}'")
    );
    // R rejects `\q`: the statement doesn't parse (see
    // `literal_errors_and_warnings_are_listed`).
    assert_eq!(nodes[6]["kind"], "unparsed");
    // R reads `\xe9`, but alone it isn't UTF-8: no `value`.
    assert_eq!(nodes[7]["kind"], "string");
    assert!(nodes[7].get("value").is_none(), "{}", nodes[7]);
    assert_eq!(nodes[7]["raw"], false);
    assert_eq!(nodes[8]["value"], "");
    assert_eq!(nodes[9]["value"], "é😀");
    // R rejects mixing Unicode and byte escapes in one string.
    assert_eq!(nodes[10]["kind"], "unparsed");

    // A line ending inside a string reads as `\n`, in a CRLF file too.
    let crlf = "x <- \"a\r\nb\"\r\n";
    let nodes = expressions(crlf);
    assert_eq!(nodes[0]["value"]["value"], "a\nb");
    assert_eq!(nodes[0]["value"]["text"], "\"a\r\nb\"");
}

#[test]
fn names_in_every_form() {
    let text = concat!(
        "`größe` <- 1; `_merge`; `a\\`b`; `a\\nb`; `\\u{e9}`; d$\"x\"; ",
        "f(\"msg\" = e); c(\"a\" = \"b\"); \"dplyr\"::filter; pkg:::f; x@`s t`; ",
        "...; ..1; .; .data; `_`; f(NULL = 1)",
    );
    let nodes = expressions(text);
    let name = |text: &str, name: &str, form: &str| json!({"kind": "identifier", "text": text, "name": name, "form": form});
    assert_eq!(
        shape(&nodes[0]["target"]),
        name("`größe`", "größe", "backtick")
    );
    assert_eq!(shape(&nodes[1]), name("`_merge`", "_merge", "backtick"));
    // Backslash escapes in backticks decode as R decodes them.
    assert_eq!(shape(&nodes[2]), name("`a\\`b`", "a`b", "backtick"));
    assert_eq!(shape(&nodes[3]), name("`a\\nb`", "a\nb", "backtick"));
    // R rejects `\u` in backticks: the statement doesn't parse.
    assert_eq!(
        shape(&nodes[4]),
        json!({"kind": "unparsed", "text": "`\\u{e9}`"})
    );
    // Strings in a name's place.
    assert_eq!(
        shape(&nodes[5]),
        json!({"kind": "extract", "op": "$", "left": ident("d"),
               "right": name("\"x\"", "x", "string")})
    );
    assert_eq!(
        shape(&nodes[6]["arguments"][0]["name"]),
        name("\"msg\"", "msg", "string")
    );
    assert_eq!(
        shape(&nodes[7]["arguments"][0]),
        json!({"name": name("\"a\"", "a", "string"),
               "value": {"kind": "string", "text": "\"b\"", "value": "b", "quote": "\"",
                         "raw": false, "delimiters": {"open": "\"", "close": "\""}}})
    );
    assert_eq!(
        shape(&nodes[8]),
        json!({"kind": "namespace", "op": "::",
               "left": name("\"dplyr\"", "dplyr", "string"), "right": ident("filter")})
    );
    assert_eq!(nodes[9]["op"], ":::");
    assert_eq!(
        shape(&nodes[10]),
        json!({"kind": "extract", "op": "@", "left": ident("x"),
               "right": name("`s t`", "s t", "backtick")})
    );
    for (node, written) in nodes[11..15].iter().zip(["...", "..1", ".", ".data"]) {
        assert_eq!(shape(node), ident(written));
    }
    // A backticked `_` is a name, not the placeholder.
    assert_eq!(shape(&nodes[15]), name("`_`", "_", "backtick"));
    assert_eq!(
        shape(&nodes[16]["arguments"][0]["name"]),
        name("NULL", "NULL", "plain")
    );
}

#[test]
fn name_ranges_count_utf16_units() {
    let text = "`größe` <- \"😀\"; größe\nf(größe = 1)";
    let nodes = expressions(text);
    let range = |node: &Value| {
        let r = &node["range"];
        (
            r["start"]["character"].as_u64().unwrap(),
            r["end"]["character"].as_u64().unwrap(),
        )
    };
    assert_eq!(range(&nodes[0]["target"]), (0, 7));
    // The emoji is two UTF-16 units.
    assert_eq!(range(&nodes[0]["value"]), (11, 15));
    assert_eq!(range(&nodes[1]), (17, 22));
    let argument = &nodes[2]["arguments"][0];
    assert_eq!(range(&argument["name"]), (2, 7));
    assert_eq!(range(argument), (2, 11));
}

#[test]
fn pipes_placeholders_and_operators_as_written() {
    let nodes = expressions(concat!(
        "x |> f(y = _); x |> _$a; x %>% f(a, .); x %>% f(a, g(.)); ",
        "x -> y; x ->> y; 2 ** 3; 2 ^ 3; \\(x) x; function(a, b = 1, ...) NULL",
    ));
    assert_eq!(
        shape(&nodes[0]),
        json!({"kind": "pipe", "op": "|>", "left": ident("x"),
               "right": {"kind": "call", "function": ident("f"),
                         "resolution": {"kind": "unresolved"}, "arguments": [
                   {"name": ident("y"), "value": {"kind": "placeholder", "text": "_"}}]}})
    );
    assert_eq!(
        shape(&nodes[1]),
        json!({"kind": "pipe", "op": "|>", "left": ident("x"),
               "right": {"kind": "extract", "op": "$",
                         "left": {"kind": "placeholder", "text": "_"}, "right": ident("a")}})
    );
    // `.` in a `%>%` step is an identifier, kept where it stands.
    assert_eq!(nodes[2]["kind"], "binary");
    assert_eq!(nodes[2]["op"], "%>%");
    assert_eq!(
        shape(&nodes[2]["right"]["arguments"][1]["value"]),
        ident(".")
    );
    let nested = &nodes[3]["right"]["arguments"][1]["value"];
    assert_eq!(
        shape(nested),
        json!({"kind": "call", "function": ident("g"),
               "resolution": {"kind": "unresolved"},
               "arguments": [{"name": null, "value": ident(".")}]})
    );
    // `->` and `->>` keep their direction: the value is on the left.
    for (node, op) in nodes[4..6].iter().zip(["->", "->>"]) {
        assert_eq!(
            shape(node),
            json!({"kind": "assignment", "op": op, "value": ident("x"), "target": ident("y")})
        );
        assert_eq!(node["value"]["range"]["start"], node["range"]["start"]);
    }
    assert_eq!(nodes[6]["op"], "**");
    assert_eq!(nodes[7]["op"], "^");
    assert_eq!(
        shape(&nodes[8]),
        json!({"kind": "function", "keyword": "\\",
               "parameters": [{"name": ident("x"), "default": null}], "body": ident("x")})
    );
    assert_eq!(
        shape(&nodes[9]),
        json!({"kind": "function", "keyword": "function", "parameters": [
                   {"name": ident("a"), "default": null},
                   {"name": ident("b"), "default":
                       {"kind": "number", "text": "1", "type": "double", "value": 1}},
                   {"name": ident("..."), "default": null}],
               "body": {"kind": "constant", "text": "NULL", "type": "NULL"}})
    );
    // A parameter entry's range covers its name and default.
    assert_eq!(
        slice(
            "function(a, b = 1, ...) NULL",
            &expressions("function(a, b = 1, ...) NULL")[0]["parameters"][1]["range"]
        ),
        "b = 1"
    );
}

#[test]
fn every_operator_is_reported_as_written() {
    let binary = [
        "+", "-", "*", "/", "^", "**", "%%", "%/%", "%in%", "%>%", "%<>%", "%T>%", "%$%", ":",
        "==", "!=", "<", "<=", ">", ">=", "&", "&&", "|", "||", "?",
    ];
    let text: Vec<String> = binary.iter().map(|op| format!("a {op} b")).collect();
    for (node, op) in expressions(&text.join("; ")).iter().zip(binary) {
        let mut expected =
            json!({"kind": "binary", "op": op, "left": ident("a"), "right": ident("b")});
        // A `%...%` operator names a function, so it has a resolution
        // (`NoScope`'s here); the fixed operators don't.
        if op.starts_with('%') {
            expected["resolution"] = json!({"kind": "unresolved"});
        }
        assert_eq!(shape(node), expected);
    }
    let nodes = expressions("x <- 1; x <<- 1; x = 1; x := 1; ~ y; y ~ x; ?a; +a; -a; !a");
    for (node, op) in nodes[..4].iter().zip(["<-", "<<-", "=", ":="]) {
        assert_eq!(node["kind"], "assignment");
        assert_eq!(node["op"], op);
        assert_eq!(node.get("resolution").is_some(), op == ":=");
        assert_eq!(shape(&node["target"]), ident("x"));
    }
    assert_eq!(
        shape(&nodes[4]),
        json!({"kind": "formula", "op": "~", "left": null, "right": ident("y")})
    );
    assert_eq!(
        shape(&nodes[5]),
        json!({"kind": "formula", "op": "~", "left": ident("y"), "right": ident("x")})
    );
    for (node, op) in nodes[6..].iter().zip(["?", "+", "-", "!"]) {
        assert_eq!(
            shape(node),
            json!({"kind": "unary", "op": op, "operand": ident("a")})
        );
    }
}

#[test]
fn equals_assignment_is_told_apart_from_a_named_argument() {
    let nodes = expressions("f(x = 1); x = 1; (x = 1); f((x = 1))");
    let one = json!({"kind": "number", "text": "1", "type": "double", "value": 1});
    let assignment = json!({"kind": "assignment", "op": "=", "target": ident("x"), "value": one});
    assert_eq!(
        shape(&nodes[0]["arguments"]),
        json!([{"name": ident("x"), "value": one}])
    );
    assert_eq!(shape(&nodes[1]), assignment);
    assert_eq!(
        shape(&nodes[2]),
        json!({"kind": "parenthesized", "body": assignment})
    );
    assert_eq!(
        shape(&nodes[3]["arguments"]),
        json!([{"name": null, "value": {"kind": "parenthesized", "body": assignment}}])
    );
}

#[test]
fn arguments_keep_order_and_empty_arguments() {
    let text = "x[i, ]; d[, y := e]; d[i, y, by = g]; x[[1]]; f(); f(,); f(a = ); f(b, a = 1, c)";
    let nodes = expressions(text);
    let empty = json!({"name": null, "value": null});
    let unnamed = |name: &str| json!({"name": null, "value": ident(name)});
    assert_eq!(
        shape(&nodes[0]),
        json!({"kind": "index", "op": "[", "target": ident("x"),
               "arguments": [unnamed("i"), empty]})
    );
    // The empty argument's range is empty, just after the comma.
    let range = &nodes[0]["arguments"][1]["range"];
    assert_eq!(range["start"], json!({"line": 0, "character": 4}));
    assert_eq!(range["end"], range["start"]);
    assert_eq!(
        shape(&nodes[1]["arguments"]),
        json!([empty, {"name": null, "value": {"kind": "assignment", "op": ":=",
                                               "resolution": {"kind": "unresolved"},
                                               "target": ident("y"), "value": ident("e")}}])
    );
    assert_eq!(
        nodes[1]["arguments"][0]["range"]["start"],
        json!({"line": 0, "character": 10})
    );
    assert_eq!(
        shape(&nodes[2]["arguments"]),
        json!([unnamed("i"), unnamed("y"), {"name": ident("by"), "value": ident("g")}])
    );
    assert_eq!(nodes[3]["op"], "[[");
    assert_eq!(nodes[3]["arguments"].as_array().unwrap().len(), 1);
    assert_eq!(nodes[4]["arguments"], json!([]));
    assert_eq!(shape(&nodes[5]["arguments"]), json!([empty, empty]));
    // A named argument with no value.
    assert_eq!(
        shape(&nodes[6]["arguments"]),
        json!([{"name": ident("a"), "value": null}])
    );
    let names: Vec<&Value> = nodes[7]["arguments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["name"])
        .collect();
    assert_eq!(names[0], &Value::Null);
    assert_eq!(names[1]["name"], "a");
    assert_eq!(names[2], &Value::Null);
}

#[test]
fn nested_unary_operators_and_double_braces_stay_nested() {
    let nodes = expressions("!!x; !!!x; !(!x); f({{ x }})");
    let not = |operand: Value| json!({"kind": "unary", "op": "!", "operand": operand});
    assert_eq!(shape(&nodes[0]), not(not(ident("x"))));
    assert_eq!(shape(&nodes[1]), not(not(not(ident("x")))));
    // Each `!` starts one column after its parent.
    let three = &nodes[1];
    let starts = [
        start_character(three),
        start_character(&three["operand"]),
        start_character(&three["operand"]["operand"]),
        start_character(&three["operand"]["operand"]["operand"]),
    ];
    assert_eq!(starts, [5, 6, 7, 8]);
    assert_eq!(
        shape(&nodes[2]),
        not(json!({"kind": "parenthesized", "body": not(ident("x"))}))
    );
    // `{{ x }}` is a block whose one statement is a block.
    let outer = &nodes[3]["arguments"][0]["value"];
    assert_eq!(outer["kind"], "block");
    let inner = &outer["statements"][0]["expression"];
    assert_eq!(inner["kind"], "block");
    assert_eq!(shape(&inner["statements"][0]["expression"]), ident("x"));
}

#[test]
fn any_expression_can_be_called() {
    let nodes = expressions("f()(x); (\\(x) x)(1); pkg::f(1); x$f(1)");
    assert_eq!(
        shape(&nodes[0]),
        json!({"kind": "call",
               "function": {"kind": "call", "function": ident("f"),
                            "resolution": {"kind": "unresolved"}, "arguments": []},
               "resolution": {"kind": "dynamic"},
               "arguments": [{"name": null, "value": ident("x")}]})
    );
    // Only a name or a namespace access in the function position resolves;
    // `pkg::f` is `pkg`'s, as written, whatever the workspace holds.
    assert_eq!(nodes[1]["resolution"], json!({"kind": "dynamic"}));
    assert_eq!(
        nodes[2]["resolution"],
        json!({"kind": "package", "package": "pkg"})
    );
    assert_eq!(nodes[3]["resolution"], json!({"kind": "dynamic"}));
    let head = &nodes[1]["function"];
    assert_eq!(head["kind"], "parenthesized");
    assert_eq!(head["body"]["kind"], "function");
    assert_eq!(head["body"]["keyword"], "\\");
    assert_eq!(nodes[2]["function"]["kind"], "namespace");
    assert_eq!(nodes[3]["function"]["kind"], "extract");
}

#[test]
fn control_flow_is_an_expression() {
    let nodes = expressions(concat!(
        "y <- if (c) a else b; if (a) 1 else if (b) 2 else 3; if (p) q; ",
        "for (i in s) next; while (TRUE) break; repeat {}; f(for (i in 1) i)",
    ));
    assert_eq!(
        shape(&nodes[0]),
        json!({"kind": "assignment", "op": "<-", "target": ident("y"),
               "value": {"kind": "if", "condition": ident("c"), "consequence": ident("a"),
                         "alternative": ident("b")}})
    );
    // `else if`: an `else` whose branch is an `if`.
    let alternative = &nodes[1]["alternative"];
    assert_eq!(alternative["kind"], "if");
    assert_eq!(alternative["alternative"]["text"], "3");
    assert!(nodes[2]["alternative"].is_null());
    assert_eq!(
        shape(&nodes[3]),
        json!({"kind": "for", "variable": ident("i"), "sequence": ident("s"),
               "body": {"kind": "next", "text": "next"}})
    );
    assert_eq!(
        shape(&nodes[4]),
        json!({"kind": "while", "condition": {"kind": "constant", "text": "TRUE", "type": "logical"},
               "body": {"kind": "break", "text": "break"}})
    );
    assert_eq!(nodes[5]["body"]["kind"], "block");
    assert_eq!(nodes[6]["arguments"][0]["value"]["kind"], "for");
}

/// Every fixture in this file, for the tree invariants.
#[test]
fn child_ranges_lie_inside_their_parents_in_every_fixture() {
    let crlf = FIXTURE.replace('\n', "\r\n");
    let fixtures = [
        FIXTURE,
        crlf.as_str(),
        "x <- function(a, b = c(1, 2), ...) {\n  if (a) b[a, ] else d[[1]]$e@f\n}\n",
        "`größe` <- \"😀\" |> f(y = _)\n",
        "y <- df |>\n  filter(a,\n    b) %>%\n  g(., x = 'q')\n",
    ];
    for text in fixtures {
        assert_invariants(text, &doc(text));
    }
}
#[test]
fn unreadable_and_undecodable_files_get_the_error_document() {
    let dir = tempfile::tempdir().unwrap();
    let missing = file_doc(&dir.path().join("gone.R"), "gone.R");
    assert_eq!(missing["path"], "gone.R");
    assert_eq!(missing["schema_version"], SCHEMA_VERSION);
    assert!(missing.get("statements").is_none());
    assert!(!missing["error"]["message"].as_str().unwrap().is_empty());

    let latin1 = dir.path().join("latin1.R");
    std::fs::write(&latin1, b"x <- \"caf\xe9\"\n").unwrap();
    let bad = file_doc(&latin1, "latin1.R");
    assert_eq!(
        bad["error"]["message"],
        "not valid UTF-8: first invalid byte 0xe9 at offset 9"
    );
    assert!(bad.get("statements").is_none());
}

#[test]
fn parse_args_accepts_files_and_only_json() {
    let parse = |argv: &[&str]| super::parse_args(argv.iter().map(|s| s.to_string()));
    assert_eq!(
        parse(&[
            "a.R",
            "--workspace",
            "w",
            "--format",
            "json",
            "b.R",
            "--no-config"
        ])
        .unwrap(),
        ParseArgs {
            files: vec![PathBuf::from("a.R"), PathBuf::from("b.R")],
            workspace: Some(PathBuf::from("w")),
            config_path: None,
            no_config: true,
        }
    );
    assert!(parse(&["--format", "text"]).unwrap_err().contains("text"));
    assert_eq!(parse(&["--help"]).unwrap_err(), "HELP");
    assert!(parse(&["--bogus"]).is_err());
}

#[cfg(unix)]
#[test]
fn requested_paths_resolve_lexically_against_the_root() {
    let root = Path::new("/ws");
    assert_eq!(
        requested_path(Path::new("R/a.R"), root),
        Path::new("/ws/R/a.R")
    );
    assert_eq!(
        requested_path(Path::new("R/../b.R"), root),
        Path::new("/ws/b.R")
    );
    assert_eq!(
        requested_path(Path::new("../out.R"), root),
        Path::new("/out.R")
    );
    assert_eq!(printed_path(Path::new("/ws/R/a.R"), root), "R/a.R");
    assert_eq!(printed_path(Path::new("/out.R"), root), "/out.R");
}

mod errors_and_directives;
