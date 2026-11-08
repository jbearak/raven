//! Unit tests for `raven parse`'s documents. End-to-end tests of the binary
//! (framing, exit codes, paths against `raven graph`) are in
//! `crates/raven/tests/cli_parse.rs`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::document::{document_for_file, document_from_text};
use super::*;

fn doc_of_bytes(bytes: &[u8]) -> Value {
    let detected = crate::state::detect_source_encoding(bytes);
    let text = crate::state::decode_source(bytes.to_vec()).unwrap();
    serde_json::to_value(document_from_text("t.R".into(), detected, &text)).unwrap()
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

#[test]
fn tree_nodes_all_have_kind_and_range_within_their_parent() {
    fn check(node: &Value, parent: Option<(&Value, &Value)>) {
        let Value::Object(map) = node else { return };
        if map.contains_key("kind") {
            assert!(map.contains_key("range"), "{node}");
            if let Some((start, end)) = parent {
                let key = |p: &Value| (p["line"].as_u64(), p["character"].as_u64());
                assert!(key(&node["range"]["start"]) >= key(start));
                assert!(key(&node["range"]["end"]) <= key(end));
            }
        }
        let own = map
            .get("range")
            .map(|r| (&r["start"], &r["end"]))
            .or(parent);
        // Comments aren't tree nodes: a leading comment precedes its
        // statement.
        for (key, child) in map {
            match child {
                _ if key == "comments" => {}
                Value::Array(items) => items.iter().for_each(|item| check(item, own)),
                other => check(other, own),
            }
        }
    }
    let d = doc(FIXTURE);
    for statement in d["statements"].as_array().unwrap() {
        check(&statement["expression"], None);
    }
    // Kinds this version gives, as decided in docs/cli.md.
    let text = "a$b; pkg::f; x[1]; x[[1]]; !x; -1; ~y; y ~ x; (z); \\(q) q; \
                for (i in s) next; while (TRUE) break; repeat break; x -> y; \
                \"s\"; NULL; 1L; x |> f(); x %in% y\n";
    let d = doc(text);
    let kinds: Vec<&str> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["expression"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "extract",
            "namespace",
            "index",
            "index",
            "unary",
            "unary",
            "formula",
            "formula",
            "parenthesized",
            "function",
            "for",
            "while",
            "repeat",
            "assignment",
            "string",
            "constant",
            "number",
            "pipe",
            "binary",
        ]
    );
    // `->`: the value is on the left as written.
    let arrow = &top(&d, 13)["expression"];
    assert_eq!(arrow["value"]["range"]["start"], arrow["range"]["start"]);
    assert_eq!(arrow["target"]["range"]["end"], arrow["range"]["end"]);
    assert!(top(&d, 6)["expression"]["left"].is_null());
}

#[test]
fn unreadable_and_undecodable_files_get_the_error_document() {
    let dir = tempfile::tempdir().unwrap();
    let missing = serde_json::to_value(document_for_file(
        &dir.path().join("gone.R"),
        "gone.R".into(),
    ))
    .unwrap();
    assert_eq!(missing["path"], "gone.R");
    assert_eq!(missing["schema_version"], SCHEMA_VERSION);
    assert!(missing.get("statements").is_none());
    assert!(!missing["error"]["message"].as_str().unwrap().is_empty());

    let latin1 = dir.path().join("latin1.R");
    std::fs::write(&latin1, b"x <- \"caf\xe9\"\n").unwrap();
    let bad = serde_json::to_value(document_for_file(&latin1, "latin1.R".into())).unwrap();
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
