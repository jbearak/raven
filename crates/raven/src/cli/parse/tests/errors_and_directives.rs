//! Tests for comments' `directive`, the `errors` list, and `unparsed` spans.

use serde_json::{Value, json};

use super::{Text, assert_invariants, comments, doc, offset, slice};

/// Every comment's text and `directive`, in source order, with the
/// document's invariants (every comment exactly once included) checked.
fn directives(text: &str) -> Vec<(String, Value)> {
    let d = doc(text);
    assert_invariants(text, &d);
    let mut listed = comments(&d);
    listed.sort_by_key(|c| offset(text, &c["range"]["start"]));
    listed
        .into_iter()
        .map(|c| (c.text().to_string(), c["directive"].clone()))
        .collect()
}

/// The `directive` of the comment whose text is `comment`.
fn directive<'a>(all: &'a [(String, Value)], comment: &str) -> &'a Value {
    &all.iter()
        .find(|(text, _)| text == comment)
        .unwrap_or_else(|| panic!("no comment {comment:?}"))
        .1
}

/// A range over whole lines: `first`'s start to `last`'s `end` character.
fn lines(first: u32, last: u32, end: u32) -> Value {
    json!({"start": {"line": first, "character": 0}, "end": {"line": last, "character": end}})
}

/// `directive`'s fields after the common five, checked separately.
fn common(d: &Value) -> Value {
    json!([
        d["kind"],
        d["prefix"],
        d["keyword"],
        d["honored"],
        d["reason"]
    ])
}

#[test]
fn forward_directives_in_every_spelling() {
    let text = "\
x <- 1
# raven: source a.R
# raven: run b.R line=3
# raven: include 'c d.R' line=eof
# @lsp-source: \"e.R\" line=end
# @lsp-run f.R
# @lsp-include g.R line=10
";
    let all = directives(text);
    let expect = [
        (
            "# raven: source a.R",
            "raven",
            "source",
            "source",
            "a.R",
            Value::Null,
        ),
        (
            "# raven: run b.R line=3",
            "raven",
            "run",
            "run",
            "b.R",
            json!(3),
        ),
        (
            "# raven: include 'c d.R' line=eof",
            "raven",
            "include",
            "include",
            "c d.R",
            json!("eof"),
        ),
        (
            "# @lsp-source: \"e.R\" line=end",
            "lsp",
            "source",
            "source",
            "e.R",
            json!("end"),
        ),
        ("# @lsp-run f.R", "lsp", "run", "run", "f.R", Value::Null),
        (
            "# @lsp-include g.R line=10",
            "lsp",
            "include",
            "include",
            "g.R",
            json!(10),
        ),
    ];
    for (comment, prefix, keyword, call_type, path, line) in expect {
        assert_eq!(
            directive(&all, comment),
            &json!({"kind": "forward", "prefix": prefix, "keyword": keyword, "honored": true,
                    "reason": null, "call_type": call_type, "path": path, "line": line}),
            "{comment}"
        );
    }
}

#[test]
fn backward_directives_in_every_spelling_and_outside_the_header() {
    let text = "\
# raven: sourced-by ../main.R line=12
# raven: run-by ../a.R line=eof
# raven: included-by ../b.R line=end
# @lsp-sourced-by: \"../c d.R\" match=\"source(\"
# @lsp-run-by ../e.R
# @lsp-included-by ../f.R line=2 match='x'
x <- 1
# raven: sourced-by ../late.R
";
    let all = directives(text);
    let expect = [
        (
            "# raven: sourced-by ../main.R line=12",
            "raven",
            "sourced-by",
            "source",
            "../main.R",
            json!(12),
            Value::Null,
        ),
        (
            "# raven: run-by ../a.R line=eof",
            "raven",
            "run-by",
            "run",
            "../a.R",
            json!("eof"),
            Value::Null,
        ),
        (
            "# raven: included-by ../b.R line=end",
            "raven",
            "included-by",
            "include",
            "../b.R",
            json!("end"),
            Value::Null,
        ),
        (
            "# @lsp-sourced-by: \"../c d.R\" match=\"source(\"",
            "lsp",
            "sourced-by",
            "source",
            "../c d.R",
            Value::Null,
            json!("source("),
        ),
        (
            "# @lsp-run-by ../e.R",
            "lsp",
            "run-by",
            "run",
            "../e.R",
            Value::Null,
            Value::Null,
        ),
        (
            "# @lsp-included-by ../f.R line=2 match='x'",
            "lsp",
            "included-by",
            "include",
            "../f.R",
            json!(2),
            json!("x"),
        ),
    ];
    for (comment, prefix, keyword, call_type, path, line, pattern) in expect {
        assert_eq!(
            directive(&all, comment),
            &json!({"kind": "backward", "prefix": prefix, "keyword": keyword, "honored": true,
                    "reason": null, "call_type": call_type, "path": path, "line": line,
                    "match": pattern}),
            "{comment}"
        );
    }
    // After the first line of code, a backward directive is ignored, and
    // reported with the reason.
    assert_eq!(
        directive(&all, "# raven: sourced-by ../late.R"),
        &json!({"kind": "backward", "prefix": "raven", "keyword": "sourced-by", "honored": false,
                "reason": "outside_header", "call_type": "source", "path": "../late.R",
                "line": null, "match": null})
    );
}

#[test]
fn working_directory_and_self_contained_in_every_spelling() {
    let text = "\
# raven: cd /data
# raven: working-directory ../w
# raven: working-dir w2
# raven: current-directory w3
# raven: current-dir w4
# raven: wd w5
# @lsp-cd: \"w 6\"
# raven: self-contained
# raven: standalone
# @lsp-self-contained
# @lsp-standalone
x <- 1
# raven: cd late
# raven: standalone
";
    let all = directives(text);
    let cd = [
        ("# raven: cd /data", "raven", "cd", "/data"),
        (
            "# raven: working-directory ../w",
            "raven",
            "working-directory",
            "../w",
        ),
        ("# raven: working-dir w2", "raven", "working-dir", "w2"),
        (
            "# raven: current-directory w3",
            "raven",
            "current-directory",
            "w3",
        ),
        ("# raven: current-dir w4", "raven", "current-dir", "w4"),
        ("# raven: wd w5", "raven", "wd", "w5"),
        ("# @lsp-cd: \"w 6\"", "lsp", "cd", "w 6"),
    ];
    for (comment, prefix, keyword, path) in cd {
        assert_eq!(
            directive(&all, comment),
            &json!({"kind": "working_directory", "prefix": prefix, "keyword": keyword,
                    "honored": true, "reason": null, "path": path}),
            "{comment}"
        );
    }
    for (comment, prefix, keyword) in [
        ("# raven: self-contained", "raven", "self-contained"),
        ("# raven: standalone", "raven", "standalone"),
        ("# @lsp-self-contained", "lsp", "self-contained"),
        ("# @lsp-standalone", "lsp", "standalone"),
    ] {
        let d = all.iter().find(|(t, _)| t == comment).unwrap();
        assert_eq!(
            d.1,
            json!({"kind": "self_contained", "prefix": prefix, "keyword": keyword,
                   "honored": true, "reason": null}),
            "{comment}"
        );
    }
    assert_eq!(
        directive(&all, "# raven: cd late"),
        &json!({"kind": "working_directory", "prefix": "raven", "keyword": "cd",
                "honored": false, "reason": "outside_header", "path": "late"})
    );
    // The second `# raven: standalone` is after the code.
    let late = &all
        .iter()
        .filter(|(t, _)| t == "# raven: standalone")
        .nth(1)
        .unwrap()
        .1;
    assert_eq!(late["honored"], false);
    assert_eq!(late["reason"], "outside_header");
}

#[test]
fn declarations_in_every_spelling() {
    let text = "\
# raven: var a
# raven: variable \"b c\"
# raven: declare-var 'd'
# raven: declare-variable e
# @lsp-var f
# raven: func g
# raven: function pkg::h(x, y = 1)
# raven: declare-func \"my fn\"
# raven: declare-function i()
# @lsp-func j(a)
# raven: func some-func
# raven: nse k
# raven: nse pkg::l(x, ...)
# @lsp-nse: \"m n\"(x)
# raven: nse o()
# raven: nse p(x,,y)
";
    let all = directives(text);
    for (comment, prefix, keyword, name) in [
        ("# raven: var a", "raven", "var", "a"),
        ("# raven: variable \"b c\"", "raven", "variable", "b c"),
        ("# raven: declare-var 'd'", "raven", "declare-var", "d"),
        (
            "# raven: declare-variable e",
            "raven",
            "declare-variable",
            "e",
        ),
        ("# @lsp-var f", "lsp", "var", "f"),
    ] {
        assert_eq!(
            directive(&all, comment),
            &json!({"kind": "variable", "prefix": prefix, "keyword": keyword, "honored": true,
                    "reason": null, "name": name}),
            "{comment}"
        );
    }
    let function = |prefix: &str, keyword: &str, name: &str, package: Value, formals: Value| {
        json!({"kind": "function", "prefix": prefix, "keyword": keyword, "honored": true,
               "reason": null, "name": name, "package": package, "formals": formals})
    };
    assert_eq!(
        directive(&all, "# raven: func g"),
        &function("raven", "func", "g", Value::Null, Value::Null)
    );
    // Defaults are dropped from the formals, as Raven reads them.
    assert_eq!(
        directive(&all, "# raven: function pkg::h(x, y = 1)"),
        &function("raven", "function", "h", json!("pkg"), json!(["x", "y"]))
    );
    assert_eq!(
        directive(&all, "# raven: declare-func \"my fn\""),
        &function("raven", "declare-func", "my fn", Value::Null, Value::Null)
    );
    assert_eq!(
        directive(&all, "# raven: declare-function i()"),
        &function("raven", "declare-function", "i", Value::Null, Value::Null)
    );
    assert_eq!(
        directive(&all, "# @lsp-func j(a)"),
        &function("lsp", "func", "j", Value::Null, json!(["a"]))
    );
    // Raven drops a name the unquoted form truncates (`some-func`).
    assert_eq!(
        common(directive(&all, "# raven: func some-func")),
        json!(["function", "raven", "func", false, "malformed"])
    );

    let nse = |prefix: &str, declaration: &str, name: &str, package: Value, formals: Value| {
        json!({"kind": "nse", "prefix": prefix, "keyword": "nse", "honored": true,
               "reason": null, "declaration": declaration, "name": name, "package": package,
               "formals": formals})
    };
    assert_eq!(
        directive(&all, "# raven: nse k"),
        &nse("raven", "k", "k", Value::Null, Value::Null)
    );
    assert_eq!(
        directive(&all, "# raven: nse pkg::l(x, ...)"),
        &nse(
            "raven",
            "pkg::l(x, ...)",
            "l",
            json!("pkg"),
            json!(["x", "..."])
        )
    );
    assert_eq!(
        directive(&all, "# @lsp-nse: \"m n\"(x)"),
        &nse("lsp", "\"m n\"(x)", "m n", Value::Null, json!(["x"]))
    );
    // Empty parentheses mean the whole call, as no parentheses do.
    assert_eq!(
        directive(&all, "# raven: nse o()"),
        &nse("raven", "o()", "o", Value::Null, Value::Null)
    );
    // A blank slot in the formal list: Raven drops the directive.
    assert_eq!(
        common(directive(&all, "# raven: nse p(x,,y)")),
        json!(["nse", "raven", "nse", false, "malformed"])
    );
}

/// Every suppression form and alias, each with its target, a `-start`/`-end`
/// pair, a nested `-start`, an unpaired `-end` and `-start`, and lintr's
/// `# nolint` forms.
#[test]
fn suppressions_with_scopes_codes_and_targets() {
    let text = "\
x <- 1 # raven: ignore
y <- 2 # raven: expect[undefined-variable, line_length]
z <- 3 # @lsp-ignore
w <- 4 # @lsp-expect[undefined-variable]
# raven: ignore-next
a <- b
# @lsp-ignore-next[undefined-variable]
c <- d
# raven: expect-next
e <- f
# @lsp-expect-next
g <- h
# raven: ignore-start
i <- j
# raven: ignore-start
# raven: ignore-end
# raven: expect-end
# raven: ignore-file[undefined-variable]
# raven: expect-file
# raven: expect-start[undefined-variable]
k <- l
m <- n # nolint
o <- p # nolint: line_length, object_usage
# nolint start
q <- r
# nolint end
# nolint end
# nolint start: line_length
s <- t
# raven: ignore-chunk[undefined-variable]
";
    let all = directives(text);
    let line_end = |line: usize| text.lines().nth(line).unwrap().len() as u32;
    let last = text.lines().count() as u32 - 1;
    let suppression = |prefix: &str,
                       keyword: &str,
                       honored: bool,
                       reason: Value,
                       family: &str,
                       scope: &str,
                       codes: Value,
                       target: Value| {
        json!({"kind": "suppression", "prefix": prefix, "keyword": keyword, "honored": honored,
               "reason": reason, "family": family, "scope": scope, "codes": codes,
               "target": target})
    };
    let at = |line: u32| lines(line, line, line_end(line as usize));
    let none = json!([]);
    let cases = [
        (
            "# raven: ignore",
            suppression(
                "raven",
                "ignore",
                true,
                Value::Null,
                "ignore",
                "line",
                none.clone(),
                at(0),
            ),
        ),
        (
            "# raven: expect[undefined-variable, line_length]",
            suppression(
                "raven",
                "expect",
                true,
                Value::Null,
                "expect",
                "line",
                json!(["undefined-variable", "line-length"]),
                at(1),
            ),
        ),
        (
            "# @lsp-ignore",
            suppression(
                "lsp",
                "ignore",
                true,
                Value::Null,
                "ignore",
                "line",
                none.clone(),
                at(2),
            ),
        ),
        (
            "# @lsp-expect[undefined-variable]",
            suppression(
                "lsp",
                "expect",
                true,
                Value::Null,
                "expect",
                "line",
                json!(["undefined-variable"]),
                at(3),
            ),
        ),
        (
            "# raven: ignore-next",
            suppression(
                "raven",
                "ignore-next",
                true,
                Value::Null,
                "ignore",
                "next",
                none.clone(),
                at(5),
            ),
        ),
        (
            "# @lsp-ignore-next[undefined-variable]",
            suppression(
                "lsp",
                "ignore-next",
                true,
                Value::Null,
                "ignore",
                "next",
                json!(["undefined-variable"]),
                at(7),
            ),
        ),
        (
            "# raven: expect-next",
            suppression(
                "raven",
                "expect-next",
                true,
                Value::Null,
                "expect",
                "next",
                none.clone(),
                at(9),
            ),
        ),
        (
            "# @lsp-expect-next",
            suppression(
                "lsp",
                "expect-next",
                true,
                Value::Null,
                "expect",
                "next",
                none.clone(),
                at(11),
            ),
        ),
        (
            "# raven: ignore-end",
            suppression(
                "raven",
                "ignore-end",
                true,
                Value::Null,
                "ignore",
                "end",
                none.clone(),
                lines(12, 15, line_end(15)),
            ),
        ),
        // `expect-end` after the block closed: nothing to close.
        (
            "# raven: expect-end",
            suppression(
                "raven",
                "expect-end",
                false,
                json!("unpaired"),
                "expect",
                "end",
                none.clone(),
                Value::Null,
            ),
        ),
        (
            "# raven: ignore-file[undefined-variable]",
            suppression(
                "raven",
                "ignore-file",
                true,
                Value::Null,
                "ignore",
                "file",
                json!(["undefined-variable"]),
                lines(0, last, line_end(last as usize)),
            ),
        ),
        (
            "# raven: expect-file",
            suppression(
                "raven",
                "expect-file",
                true,
                Value::Null,
                "expect",
                "file",
                none.clone(),
                lines(0, last, line_end(last as usize)),
            ),
        ),
        // No `-end` closes it: it runs to the last line.
        (
            "# raven: expect-start[undefined-variable]",
            suppression(
                "raven",
                "expect-start",
                true,
                json!("unpaired"),
                "expect",
                "start",
                json!(["undefined-variable"]),
                lines(19, last, line_end(last as usize)),
            ),
        ),
        (
            "# nolint",
            suppression(
                "nolint",
                "nolint",
                true,
                Value::Null,
                "nolint",
                "line",
                none.clone(),
                at(21),
            ),
        ),
        (
            "# nolint: line_length, object_usage",
            suppression(
                "nolint",
                "nolint",
                true,
                Value::Null,
                "nolint",
                "line",
                json!(["line-length", "object-usage"]),
                at(22),
            ),
        ),
        (
            "# nolint start: line_length",
            suppression(
                "nolint",
                "nolint",
                true,
                json!("unpaired"),
                "nolint",
                "start",
                json!(["line-length"]),
                lines(27, last, line_end(last as usize)),
            ),
        ),
        // Raven reads `ignore-chunk` only in R Markdown and Quarto chunks.
        (
            "# raven: ignore-chunk[undefined-variable]",
            suppression(
                "raven",
                "ignore-chunk",
                false,
                json!("chunk_only"),
                "ignore",
                "chunk",
                json!(["undefined-variable"]),
                Value::Null,
            ),
        ),
    ];
    for (comment, expected) in cases {
        assert_eq!(directive(&all, comment), &expected, "{comment}");
    }

    // The first `-start` pairs with the `-end`; the second, while the block
    // is open, is ignored.
    let starts: Vec<&Value> = all
        .iter()
        .filter(|(t, _)| t == "# raven: ignore-start")
        .map(|(_, d)| d)
        .collect();
    assert_eq!(
        starts[0],
        &suppression(
            "raven",
            "ignore-start",
            true,
            Value::Null,
            "ignore",
            "start",
            none.clone(),
            lines(12, 15, line_end(15))
        )
    );
    assert_eq!(
        starts[1],
        &suppression(
            "raven",
            "ignore-start",
            false,
            json!("nested"),
            "ignore",
            "start",
            none.clone(),
            Value::Null
        )
    );

    let nolint_ends: Vec<&Value> = all
        .iter()
        .filter(|(t, _)| t == "# nolint end")
        .map(|(_, d)| d)
        .collect();
    assert_eq!(
        nolint_ends[0],
        &suppression(
            "nolint",
            "nolint",
            true,
            Value::Null,
            "nolint",
            "end",
            none.clone(),
            lines(23, 25, line_end(25))
        )
    );
    assert_eq!(
        nolint_ends[1],
        &suppression(
            "nolint",
            "nolint",
            false,
            json!("unpaired"),
            "nolint",
            "end",
            none,
            Value::Null
        )
    );
    assert_eq!(
        directive(&all, "# nolint start"),
        &suppression(
            "nolint",
            "nolint",
            true,
            Value::Null,
            "nolint",
            "start",
            json!([]),
            lines(23, 25, line_end(25))
        )
    );
}

#[test]
fn unread_and_unknown_directives_are_reported() {
    let text = "\
x <- 1 # raven: source a.R
y <- 2 # raven: ignore-next
# raven: sorce x.R
# @lsp-frobnicate now
# raven: source
# just a comment
#' @export
f <- function() NULL
";
    let all = directives(text);
    // Full-line directives as trailing comments: Raven doesn't read them.
    assert_eq!(
        directive(&all, "# raven: source a.R"),
        &json!({"kind": "forward", "prefix": "raven", "keyword": "source", "honored": false,
                "reason": "not_own_line", "call_type": "source", "path": "a.R", "line": null})
    );
    assert_eq!(
        directive(&all, "# raven: ignore-next"),
        &json!({"kind": "suppression", "prefix": "raven", "keyword": "ignore-next",
                "honored": false, "reason": "not_own_line", "family": "ignore", "scope": "next",
                "codes": [], "target": null})
    );
    // Looks like a directive, but no grammar reads it.
    let unknown = |prefix: &str, keyword: &str| {
        json!({"kind": "unknown", "prefix": prefix, "keyword": keyword, "honored": false,
               "reason": null})
    };
    assert_eq!(
        directive(&all, "# raven: sorce x.R"),
        &unknown("raven", "sorce")
    );
    assert_eq!(
        directive(&all, "# @lsp-frobnicate now"),
        &unknown("lsp", "frobnicate")
    );
    assert_eq!(
        directive(&all, "# raven: source"),
        &unknown("raven", "source")
    );
    assert_eq!(directive(&all, "# just a comment"), &Value::Null);
    assert_eq!(directive(&all, "#' @export"), &Value::Null);
}

/// Each `errors` entry as `(source, code, severity, message, source text)`.
fn errors(text: &str) -> Vec<(String, String, String, String, String)> {
    let d = doc(text);
    assert_invariants(text, &d);
    d["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["source"].as_str().unwrap().to_string(),
                e["code"].as_str().unwrap().to_string(),
                e["severity"].as_str().unwrap().to_string(),
                e["message"].as_str().unwrap().to_string(),
                slice(text, &e["range"]).to_string(),
            )
        })
        .collect()
}

fn entry(
    source: &str,
    code: &str,
    severity: &str,
    message: &str,
    at: &str,
) -> (String, String, String, String, String) {
    (
        source.into(),
        code.into(),
        severity.into(),
        message.into(),
        at.into(),
    )
}

/// Messages checked against R 4.6's parser.
#[test]
fn literal_errors_and_warnings_are_listed() {
    let text = concat!(
        "a <- 1.0L\nb <- 1.5L\nc <- 1e-3L\nd <- 100000000000L\n",
        "e <- \"x\\q\"\nf <- \"\\u{d800}\"\ng <- \"\\u{d83d}\\u{de00}\"\n",
        "h <- f(\"\" = 1)\ni <- 1e\nj <- `\\u{e9}`\nk <- ``\n",
    );
    assert_eq!(
        errors(text),
        [
            entry(
                "lexer",
                "integer-literal-unnecessary-decimal",
                "warning",
                "integer literal 1.0L contains unnecessary decimal point",
                "1.0L"
            ),
            entry(
                "lexer",
                "integer-literal-decimal",
                "warning",
                "integer literal 1.5L contains decimal; using numeric value",
                "1.5L"
            ),
            entry(
                "lexer",
                "integer-literal-non-integer",
                "warning",
                "non-integer value 1e-3L qualified with L; using numeric value",
                "1e-3L"
            ),
            entry(
                "lexer",
                "integer-literal-non-integer",
                "warning",
                "non-integer value 100000000000L qualified with L; using numeric value",
                "100000000000L"
            ),
            entry(
                "lexer",
                "invalid-escape",
                "error",
                "'\\q' is an unrecognized escape in character string",
                "\\q"
            ),
            entry(
                "lexer",
                "unpaired-surrogate",
                "warning",
                "unpaired surrogate Unicode point d800",
                "\\u{d800}"
            ),
            entry(
                "lexer",
                "zero-length-name",
                "error",
                "attempt to use zero-length variable name",
                "\"\""
            ),
            entry("lexer", "invalid-number", "error", "unexpected input", "1e"),
            entry(
                "lexer",
                "invalid-escape",
                "error",
                "\\uxxxx sequences not supported inside backticks",
                "\\u"
            ),
            entry(
                "lexer",
                "zero-length-name",
                "error",
                "attempt to use zero-length variable name",
                "``"
            ),
        ]
    );
    let d = doc(text);
    let kinds: Vec<&str> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["expression"]["kind"].as_str().unwrap())
        .collect();
    // A warning leaves the statement's tree; an error makes it `unparsed`.
    assert_eq!(
        kinds,
        [
            "assignment",
            "assignment",
            "assignment",
            "assignment",
            "unparsed",
            "assignment",
            "assignment",
            "unparsed",
            "unparsed",
            "unparsed",
            "unparsed",
        ]
    );
    let value = |index: usize| &d["statements"][index]["expression"]["value"];
    assert_eq!(value(0)["type"], "integer");
    assert_eq!(value(1)["type"], "double");
    // A lone surrogate isn't Unicode text: no `value`. A pair is one
    // character, as R reads it.
    assert!(value(5).get("value").is_none());
    assert_eq!(value(6)["value"], "😀");
}

/// R's rules for `|>`'s right side and its `_` placeholder, which the grammar
/// doesn't check. Messages checked against R 4.6's parser.
#[test]
fn pipe_right_sides_and_placeholders_follow_r() {
    let ok = [
        "x |> f(y = _)",
        "x |> _$a[[1]]",
        "x |> _@a",
        "x |> f(y = _) |> g(z = _)",
        "x |> f()()",
        "x |> pkg::f()",
        "x |> `_`(1)",
    ];
    for text in ok {
        assert_eq!(errors(text), [], "{text}");
        assert_eq!(
            doc(text)["statements"][0]["expression"]["kind"],
            "pipe",
            "{text}"
        );
    }
    let rejected = [
        (
            "x |> f(_)",
            "pipe-placeholder",
            "pipe placeholder can only be used as a named argument",
            "_",
        ),
        (
            "x |> (_)",
            "pipe-placeholder",
            "pipe placeholder can only be used as a named argument",
            "_",
        ),
        (
            "x |> f(y = _, z = _)",
            "pipe-placeholder",
            "pipe placeholder may only appear once",
            "_",
        ),
        (
            "x |> _$a[_]",
            "pipe-placeholder",
            "pipe placeholder may only appear once",
            "_",
        ),
        (
            "x |> _$a(1)",
            "pipe-placeholder",
            "pipe placeholder cannot be used in the RHS function",
            "_",
        ),
        (
            "x |> f",
            "pipe-rhs",
            "The pipe operator requires a function call as RHS",
            "f",
        ),
        (
            "x |> 1",
            "pipe-rhs",
            "The pipe operator requires a function call as RHS",
            "1",
        ),
        (
            "x |> (f)",
            "pipe-rhs",
            "function '(' not supported in RHS call of a pipe",
            "(f)",
        ),
        (
            "x |> f()$b",
            "pipe-rhs",
            "function '$' not supported in RHS call of a pipe",
            "f()$b",
        ),
        (
            "x |> return()",
            "pipe-rhs",
            "function 'return' not supported in RHS call of a pipe",
            "return()",
        ),
        (
            "x |> f(y = g(_))",
            "pipe-placeholder",
            "invalid use of pipe placeholder",
            "_",
        ),
        (
            "f(_)",
            "pipe-placeholder",
            "invalid use of pipe placeholder",
            "_",
        ),
    ];
    for (text, code, message, at) in rejected {
        assert_eq!(
            errors(text),
            [entry("parser", code, "error", message, at)],
            "{text}"
        );
        assert_eq!(
            doc(text)["statements"][0]["expression"]["kind"],
            "unparsed",
            "{text}"
        );
    }
}

/// The syntax errors `raven check` reports are in the list with its codes
/// and messages, including the two R rejects that the grammar accepts.
#[test]
fn syntax_errors_match_raven_check() {
    let text = "x <- )\n0 < y < 1\nif (z) 1\nelse 2\n";
    let parse_text = text.to_string();
    let tree = crate::parser_pool::with_parser(|parser| parser.parse(&parse_text, None)).unwrap();
    let mut expected: Vec<(String, String)> =
        crate::handlers::r_syntax_diagnostics(tree.root_node(), text)
            .into_iter()
            .map(|d| {
                // `raven check`'s orphan-`else` error has no code; the list
                // gives it the umbrella code.
                let code = match d.code {
                    Some(tower_lsp::lsp_types::NumberOrString::String(code)) => code,
                    None => "syntax-error".to_string(),
                    other => panic!("{other:?}"),
                };
                (code, d.message)
            })
            .collect();
    let mut listed: Vec<(String, String)> = errors(text)
        .into_iter()
        .map(|(source, code, _, message, _)| {
            assert_eq!(source, "parser");
            (code, message)
        })
        .collect();
    // The list is in source order; `raven check` collects by kind.
    listed.sort();
    expected.sort();
    assert_eq!(listed, expected);
    let codes: Vec<&str> = listed.iter().map(|(code, _)| code.as_str()).collect();
    assert!(codes.contains(&"chained-comparison"), "{codes:?}");
    let d = doc(text);
    for statement in d["statements"].as_array().unwrap() {
        if statement.text().starts_with("0 <") || statement.text() == "else" {
            assert_eq!(statement["expression"]["kind"], "unparsed", "{statement}");
        }
    }
}

#[test]
fn one_broken_statement_among_good_ones() {
    let text = "x <- 1\ny <- c(1 2)\nz <- 2\n";
    let d = doc(text);
    assert_invariants(text, &d);
    let statements: Vec<(&str, &str)> = d["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s.text(), s["expression"]["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(
        statements,
        [
            ("x <- 1", "assignment"),
            ("y <- c(1 2)", "unparsed"),
            ("z <- 2", "assignment")
        ]
    );
    let unparsed = &d["statements"][1]["expression"];
    assert_eq!(unparsed["text"], "y <- c(1 2)");
    assert_eq!(d["errors"][0]["severity"], "error");
}

/// Inside a block, the innermost statement that doesn't parse is the
/// `unparsed` one; the function and its block keep their structure.
#[test]
fn broken_statement_inside_a_block_keeps_the_enclosing_tree() {
    let text = "f <- function() {\n  a <- 1\n  b <- c(1 2)\n  if (a) {\n    d <- \"\\q\"\n  }\n  e <- 2\n}\n";
    let d = doc(text);
    assert_invariants(text, &d);
    let function = &d["statements"][0]["expression"]["value"];
    assert_eq!(function["kind"], "function");
    let body = &function["body"]["statements"];
    let kinds: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["expression"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["assignment", "unparsed", "if", "assignment"]);
    assert_eq!(body[1].text(), "b <- c(1 2)");
    // Two levels down: the `if` keeps its tree, and only the statement with
    // the invalid escape is `unparsed`.
    let inner = &body[2]["expression"]["consequence"]["statements"][0];
    assert_eq!(inner["expression"]["kind"], "unparsed");
    assert_eq!(inner.text(), "d <- \"\\q\"");
}

/// A directive in a statement that doesn't parse is still parsed: an
/// `ignore` on a broken line is seen, as the broken statement's interior
/// comment.
#[test]
fn directive_inside_an_unparsed_statement_is_still_parsed() {
    let text = "x <- 1\ny <- c(1 2, # raven: ignore\n  3)\nz <- 2\n";
    let d = doc(text);
    assert_invariants(text, &d);
    let broken = &d["statements"][1];
    assert_eq!(broken["expression"]["kind"], "unparsed");
    let interior = broken["comments"]["interior"].as_array().unwrap();
    assert_eq!(interior.len(), 1);
    assert_eq!(
        interior[0]["directive"],
        json!({"kind": "suppression", "prefix": "raven", "keyword": "ignore", "honored": true,
               "reason": null, "family": "ignore", "scope": "line", "codes": [],
               "target": lines(1, 1, 27)})
    );
    assert_eq!(d["statements"][2]["expression"]["kind"], "assignment");
}

/// Every comment appears exactly once, and every byte is in a statement or
/// a comment, with errors of every kind in the file.
#[test]
fn every_comment_once_with_errors_present() {
    for text in [
        "# a\nx <- c(1 2) # b\n# c\nf <- function() {\n  # d\n  y <- ) # e\n  # f\n}\n# g\n",
        "x |> f(_) # a\n# b\nw <- \"\\q\" # c\nif (a) {\n  0 < b < 1 # d\n} else {\n  # e\n}\n",
        "{ a <- 1\n# unclosed\n",
        "f({ a\n)\n# c\n",
    ] {
        let d = doc(text);
        assert_invariants(text, &d);
        assert!(!d["errors"].as_array().unwrap().is_empty(), "{text:?}");
    }
}
