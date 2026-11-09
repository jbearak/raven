//! End-to-end checks of `raven parse` through the real binary: JSON Lines
//! framing, exit codes, the error document, and `path` values equal to
//! `raven graph --format json`'s `files[].path`.

use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

fn write(root: &Path, relative: &str, contents: &[u8]) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// A workspace with no R subprocess: `packages.enabled = false`.
fn workspace() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    write(&ws, "raven.toml", b"[packages]\nenabled = false\n");
    (tmp, ws)
}

fn raven(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(args)
        .output()
        .unwrap()
}

fn parse_in(ws: &Path, files: &[&str]) -> Output {
    let mut args = vec!["parse", "--workspace", ws.to_str().unwrap()];
    args.extend_from_slice(files);
    raven(&args)
}

/// Each stdout line as JSON, after checking the framing: newline-terminated,
/// one compact object per line.
fn documents(output: &Output) -> Vec<Value> {
    let stdout = String::from_utf8(output.stdout.clone()).unwrap();
    if stdout.is_empty() {
        return Vec::new();
    }
    assert!(stdout.ends_with('\n'), "output must end with a newline");
    stdout
        .lines()
        .map(|line| {
            let value: Value = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("not one JSON document per line ({e}): {line}"));
            assert!(value.is_object());
            value
        })
        .collect()
}

fn paths(documents: &[Value]) -> Vec<String> {
    documents
        .iter()
        .map(|d| d["path"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn workspace_mode_prints_one_document_per_line_sorted_by_path() {
    let (_tmp, ws) = workspace();
    write(&ws, "main.R", b"source(\"R/clean.R\")\nx <- 1\n");
    write(&ws, "R/clean.R", b"# clean\ny <- 2\n");
    write(&ws, "R/Z.r", b"z <- 3\n");
    write(&ws, "report.Rmd", b"```{r}\n1\n```\n");
    let output = parse_in(&ws, &[]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let docs = documents(&output);
    assert_eq!(paths(&docs), ["R/Z.r", "R/clean.R", "main.R"]);
    for doc in &docs {
        assert_eq!(doc["schema_version"], 1);
        assert_eq!(doc["raven_version"], env!("CARGO_PKG_VERSION"));
        assert!(doc.get("error").is_none());
    }
    assert_eq!(docs[1]["statements"][0]["text"], "y <- 2");
    assert_eq!(
        docs[1]["statements"][0]["comments"]["leading"][0]["text"],
        "# clean"
    );
    assert_eq!(docs[2]["line_count"], 2);
}

#[test]
fn unreadable_files_get_error_documents_in_order_and_exit_3() {
    let (_tmp, ws) = workspace();
    write(&ws, "a.R", b"a <- 1\n");
    write(&ws, "latin1.R", b"x <- \"caf\xe9\"\n");
    write(&ws, "notes.Rmd", b"text\n");
    write(&ws, "b.R", b"b <- 2\n");
    let output = parse_in(&ws, &["a.R", "missing.R", "latin1.R", "notes.Rmd", "b.R"]);
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let docs = documents(&output);
    assert_eq!(
        paths(&docs),
        ["a.R", "missing.R", "latin1.R", "notes.Rmd", "b.R"]
    );
    for (index, doc) in docs.iter().enumerate() {
        let is_error = (1..=3).contains(&index);
        assert_eq!(doc.get("error").is_some(), is_error, "{doc}");
        assert_eq!(doc.get("statements").is_none(), is_error, "{doc}");
        assert_eq!(doc["schema_version"], 1);
    }
    assert_eq!(
        docs[2]["error"]["message"],
        "not valid UTF-8: first invalid byte 0xe9 at offset 9"
    );
    assert_eq!(
        docs[3]["error"]["message"],
        "only .R and .r files are supported"
    );
    assert_eq!(docs[4]["statements"][0]["text"], "b <- 2");
}

#[test]
fn syntax_errors_still_exit_0() {
    let (_tmp, ws) = workspace();
    write(&ws, "broken.R", b"x <- 1\ny <- )\nz <- 2\n");
    let output = parse_in(&ws, &["broken.R"]);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let docs = documents(&output);
    assert!(docs[0].get("error").is_none());
    assert!(!docs[0]["statements"].as_array().unwrap().is_empty());
}

#[test]
fn usage_errors_exit_1_and_operator_errors_exit_2() {
    let (tmp, ws) = workspace();
    write(&ws, "a.R", b"a <- 1\n");
    for args in [
        &["parse", "--format", "text"][..],
        &["parse", "--bogus"][..],
        &["parse", "--workspace"][..],
    ] {
        let output = raven(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("raven parse:"));
    }

    let missing = tmp.path().join("no-such-dir");
    let output = raven(&["parse", "--workspace", missing.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty());

    write(&ws, "bad.toml", b"[[[ not toml\n");
    let bad_config = ws.join("bad.toml");
    let output = raven(&[
        "parse",
        "--workspace",
        ws.to_str().unwrap(),
        "--config",
        bad_config.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty());
}

/// `parse`'s `path` values are the graph's `files[].path`, byte for byte,
/// for a nested `source()` and a file outside the root.
#[test]
fn paths_equal_the_graph_files_paths() {
    let (tmp, ws) = workspace();
    write(
        &ws,
        "main.R",
        b"source(\"R/clean.R\")\nsource(\"../outside.R\")\n",
    );
    write(&ws, "R/clean.R", b"source(\"R/util/helpers.R\")\n");
    write(&ws, "R/util/helpers.R", b"h <- function() 1\n");
    write(tmp.path(), "outside.R", b"o <- 1\n");

    let graph = raven(&[
        "graph",
        "--workspace",
        ws.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert_eq!(graph.status.code(), Some(0), "{graph:?}");
    let graph: Value = serde_json::from_slice(&graph.stdout).unwrap();
    let graph_paths: Vec<String> = graph["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap().to_string())
        .collect();
    assert!(graph_paths.iter().any(|p| p == "R/util/helpers.R"));
    let outside = graph_paths
        .iter()
        .find(|p| p.ends_with("outside.R"))
        .expect("the graph lists the file outside the root");
    assert!(Path::new(outside).is_absolute(), "{outside}");

    // Each graph path, passed back as a FILE argument.
    let args: Vec<&str> = graph_paths.iter().map(String::as_str).collect();
    let output = parse_in(&ws, &args);
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(paths(&documents(&output)), graph_paths);

    // Workspace mode prints the graph's paths for the files under the root.
    let output = parse_in(&ws, &[]);
    let in_root: Vec<String> = graph_paths
        .iter()
        .filter(|p| !Path::new(p).is_absolute())
        .cloned()
        .collect();
    assert_eq!(paths(&documents(&output)), in_root);
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

/// A workspace with no R and frozen package data: `.raven/packages.json`
/// lists `packages` (name and exports), and `packages.rPath` points at no R.
/// `ravenpkga` and `ravenpkgb` both export `clash`.
fn package_workspace() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    write(
        &ws,
        "raven.toml",
        b"[packages]\nenabled = true\nrPath = \"/nonexistent/raven-test/R\"\n",
    );
    let packages: &[(&str, &[&str])] = &[
        (
            "dplyr",
            &["case_when", "filter", "lag", "mutate", "n", "summarise"],
        ),
        ("ravenpkga", &["clash", "onlya"]),
        ("ravenpkgb", &["clash", "onlyb"]),
    ];
    let records: Vec<Value> = packages
        .iter()
        .map(|(name, exports)| {
            serde_json::json!({"name": name, "version": "1.0.0", "exports": exports,
                               "depends": [], "lazy_data": []})
        })
        .collect();
    let db = serde_json::json!({
        "schema_version": 1,
        "provenance": {"raven_version": "0", "r_version": "0", "generated_unix": 0},
        "packages": records,
    });
    write(&ws, ".raven/packages.json", db.to_string().as_bytes());
    (tmp, ws)
}

/// `raven parse` with no names database: `RAVEN_NAMES_DB` empty and the
/// user-data directory pointed into the temp dir, or at `names_db`.
fn parse_isolated(ws: &Path, files: &[&str], names_db: Option<&Path>) -> Vec<Value> {
    let user_data = ws.parent().unwrap().join("user-data");
    let mut command = Command::new(env!("CARGO_BIN_EXE_raven"));
    command
        .args(["parse", "--workspace", ws.to_str().unwrap()])
        .args(files)
        .env(
            "RAVEN_NAMES_DB",
            names_db.map_or("".as_ref(), Path::as_os_str),
        )
        .env("XDG_DATA_HOME", &user_data)
        .env("LOCALAPPDATA", &user_data);
    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    documents(&output)
}

/// Every `call` node in a document, depth first.
fn calls(value: &Value) -> Vec<&Value> {
    fn walk<'v>(value: &'v Value, out: &mut Vec<&'v Value>) {
        match value {
            Value::Object(map) => {
                if map.get("kind").and_then(Value::as_str) == Some("call") {
                    out.push(value);
                }
                map.values().for_each(|child| walk(child, out));
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

/// Every identifier node named `name` on 0-based `line`.
fn identifiers<'d>(doc: &'d Value, name: &str, line: u64) -> Vec<&'d Value> {
    fn walk<'v>(value: &'v Value, name: &str, line: u64, out: &mut Vec<&'v Value>) {
        match value {
            Value::Object(map) => {
                if map.get("kind").and_then(Value::as_str) == Some("identifier")
                    && map.get("name").and_then(Value::as_str) == Some(name)
                    && value["range"]["start"]["line"] == line
                {
                    out.push(value);
                }
                map.values().for_each(|child| walk(child, name, line, out));
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, name, line, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(doc, name, line, &mut out);
    out
}

/// The resolution of the one call on 0-based `line` whose function is the
/// plain name `function`.
fn resolution_of<'d>(doc: &'d Value, function: &str, line: u64) -> &'d Value {
    let found: Vec<&Value> = calls(doc)
        .into_iter()
        .filter(|call| {
            call["function"]["name"] == function && call["range"]["start"]["line"] == line
        })
        .collect();
    assert_eq!(found.len(), 1, "one `{function}()` call on line {line}");
    &found[0]["resolution"]
}

fn package(name: &str) -> Value {
    serde_json::json!({"kind": "package", "package": name})
}

fn by_path<'d>(docs: &'d [Value], path: &str) -> &'d Value {
    docs.iter()
        .find(|doc| doc["path"] == path)
        .unwrap_or_else(|| panic!("no document for {path}"))
}

#[test]
fn every_call_has_a_resolution_and_values_only_package_ones() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        b"library(dplyr)\nf <- function(x) g(h(x), k = function() m(1))\ny <- x ~ s(z)\n",
    );
    let docs = parse_isolated(&ws, &["main.R"], None);
    let all = calls(&docs[0]);
    assert_eq!(all.len(), 5);
    for call in all {
        assert!(call["resolution"]["kind"].is_string(), "{call}");
    }
    // `x`, `y`, `z` and `f` resolve to no package object: no resolution.
    for (name, line) in [("x", 1), ("x", 2), ("z", 2), ("f", 1)] {
        for identifier in identifiers(&docs[0], name, line) {
            assert!(identifier.get("resolution").is_none(), "{identifier}");
        }
    }
}

#[test]
fn filter_is_stats_until_dplyr_is_attached() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        b"filter(d, x > 1)\nlibrary(dplyr)\nfilter(d, x > 1)\nstats::filter(d)\ndplyr::filter(d)\n",
    );
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    assert_eq!(*resolution_of(doc, "filter", 0), package("stats"));
    assert_eq!(*resolution_of(doc, "library", 1), package("base"));
    assert_eq!(*resolution_of(doc, "filter", 2), package("dplyr"));
    // A namespace access is the package as written.
    let qualified: Vec<&Value> = calls(doc)
        .into_iter()
        .filter(|call| call["function"]["kind"] == "namespace")
        .map(|call| &call["resolution"])
        .collect();
    assert_eq!(qualified, [&package("stats"), &package("dplyr")]);
}

#[test]
fn a_later_attach_masks_an_earlier_one() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "ab.R",
        b"library(ravenpkga)\nlibrary(ravenpkgb)\nclash()\nonlya()\n",
    );
    write(
        &ws,
        "ba.R",
        b"library(ravenpkgb)\nlibrary(ravenpkga)\nclash()\n",
    );
    // Attaching an attached package again doesn't move it.
    write(
        &ws,
        "again.R",
        b"library(ravenpkga)\nlibrary(ravenpkgb)\nlibrary(ravenpkga)\nclash()\n",
    );
    let docs = parse_isolated(&ws, &["ab.R", "ba.R", "again.R"], None);
    assert_eq!(*resolution_of(&docs[0], "clash", 2), package("ravenpkgb"));
    assert_eq!(*resolution_of(&docs[0], "onlya", 3), package("ravenpkga"));
    assert_eq!(*resolution_of(&docs[1], "clash", 2), package("ravenpkga"));
    assert_eq!(*resolution_of(&docs[2], "clash", 3), package("ravenpkgb"));
}

#[test]
fn a_sourced_file_attaches_in_its_own_order() {
    let (_tmp, ws) = package_workspace();
    write(&ws, "main.R", b"source(\"setup.R\")\nclash()\n");
    write(&ws, "setup.R", b"library(ravenpkga)\nlibrary(ravenpkgb)\n");
    write(&ws, "rev.R", b"source(\"setup_rev.R\")\nclash()\n");
    write(
        &ws,
        "setup_rev.R",
        b"library(ravenpkgb)\nlibrary(ravenpkga)\n",
    );
    let docs = parse_isolated(&ws, &["main.R", "rev.R"], None);
    assert_eq!(*resolution_of(&docs[0], "clash", 1), package("ravenpkgb"));
    assert_eq!(*resolution_of(&docs[1], "clash", 1), package("ravenpkga"));
}

#[test]
fn attaching_a_caller_attached_package_again_doesnt_move_it() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        b"library(ravenpkga)\nlibrary(ravenpkgb)\nsource(\"kid.R\")\n",
    );
    write(&ws, "kid.R", b"library(ravenpkga)\nclash()\n");
    let docs = parse_isolated(&ws, &["kid.R"], None);
    assert_eq!(*resolution_of(&docs[0], "clash", 1), package("ravenpkgb"));
}

/// Each caller's view includes the file's own attachments: `kid.R`'s
/// `library(ravenpkga)` doesn't move `one.R`'s, and masks `two.R`'s
/// `ravenpkgb`, so both callers agree.
#[test]
fn each_caller_sees_the_files_own_attachments() {
    let (_tmp, ws) = package_workspace();
    write(&ws, "one.R", b"library(ravenpkga)\nsource(\"kid.R\")\n");
    write(&ws, "two.R", b"library(ravenpkgb)\nsource(\"kid.R\")\n");
    write(&ws, "kid.R", b"library(ravenpkga)\nclash()\n");
    let docs = parse_isolated(&ws, &["kid.R"], None);
    assert_eq!(*resolution_of(&docs[0], "clash", 1), package("ravenpkga"));
}

#[test]
fn nested_calls_formulas_and_t_and_f_resolve() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        concat!(
            "library(dplyr)\n",
            "d |> summarise(m = mean(x, na.rm = T), k = n(), z = case_when(is.na(x) ~ 0))\n",
            "y <- F\n",
            "T <- FALSE\n",
            "w <- T\n",
        )
        .as_bytes(),
    );
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    assert_eq!(*resolution_of(doc, "summarise", 1), package("dplyr"));
    assert_eq!(*resolution_of(doc, "mean", 1), package("base"));
    assert_eq!(*resolution_of(doc, "n", 1), package("dplyr"));
    assert_eq!(*resolution_of(doc, "case_when", 1), package("dplyr"));
    // Inside a formula inside a data-masking argument.
    assert_eq!(*resolution_of(doc, "is.na", 1), package("base"));
    // `T` and `F` are base's, inside a data-masking argument too, until
    // reassigned.
    let t = identifiers(doc, "T", 1);
    assert_eq!(t[0]["resolution"], package("base"));
    assert_eq!(identifiers(doc, "F", 2)[0]["resolution"], package("base"));
    assert!(identifiers(doc, "T", 4)[0].get("resolution").is_none());
    // `x` inside the data-masking arguments has none.
    for x in identifiers(doc, "x", 1) {
        assert!(x.get("resolution").is_none());
    }
}

#[test]
fn workspace_local_and_dynamic_calls() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        concat!(
            "helper <- function(a) a + 1\n",
            "helper(2)\n",
            "source(\"R/tools.R\")\n",
            "tool(1)\n",
            "apply_it <- function(fn, v) { inner <- function() 1; inner(); fn(v) }\n",
            "f()(x)\n",
            "(\\(x) x)(1)\n",
            "x$f(1)\n",
        )
        .as_bytes(),
    );
    write(&ws, "R/tools.R", b"# Tools.\ntool <- function(v) v\n");
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    let range = |line: u64, start: u64, end: u64| {
        serde_json::json!({"start": {"line": line, "character": start},
                           "end": {"line": line, "character": end}})
    };
    assert_eq!(
        *resolution_of(doc, "helper", 1),
        serde_json::json!({"kind": "workspace", "path": "main.R", "range": range(0, 0, 6)})
    );
    assert_eq!(
        *resolution_of(doc, "tool", 3),
        serde_json::json!({"kind": "workspace", "path": "R/tools.R", "range": range(1, 0, 4)})
    );
    assert_eq!(
        *resolution_of(doc, "inner", 4),
        serde_json::json!({"kind": "local", "range": range(4, 30, 35)})
    );
    assert_eq!(
        *resolution_of(doc, "fn", 4),
        serde_json::json!({"kind": "local", "range": range(4, 21, 23)})
    );
    let dynamic = serde_json::json!({"kind": "dynamic"});
    let outer: Vec<&Value> = calls(doc)
        .into_iter()
        .filter(|call| call["function"]["kind"] != "identifier")
        .map(|call| &call["resolution"])
        .collect();
    assert_eq!(outer, [&dynamic, &dynamic, &dynamic]);
    // `f()` inside `f()(x)` is a call of its own, resolved by name.
    assert_eq!(
        *resolution_of(doc, "f", 5),
        serde_json::json!({"kind": "unresolved", "reason": "not_found"})
    );
}

/// The `target` range of top-level statement `index`'s assignment.
fn target_range(doc: &Value, index: usize) -> &Value {
    &doc["statements"][index]["expression"]["target"]["range"]
}

/// A definition's `range` counts lines as the rest of the document does,
/// in the file that holds the definition, whatever its line endings.
#[test]
fn definition_ranges_count_lone_cr_line_endings() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        b"x <- 1\rhelper <- function(x) x\rhelper(1)\r",
    );
    write(
        &ws,
        "local.R",
        b"f <- function(a) {\r  inner <- function() 1\r  inner()\r}\r",
    );
    // A lone-CR file sourcing an LF file, and an LF file sourcing a lone-CR one.
    write(
        &ws,
        "cr_sources_lf.R",
        b"x <- 1\rsource(\"lf.R\")\rlf_tool(1)\r",
    );
    write(&ws, "lf.R", b"\n\nlf_tool <- function() 1\n");
    write(&ws, "lf_sources_cr.R", b"source(\"cr.R\")\ncr_tool(1)\n");
    write(&ws, "cr.R", b"x <- 1\r\r cr_tool <- function() 1\r");
    // A caller with lone-CR line endings lends a definition.
    write(
        &ws,
        "caller.R",
        b"a <- 1\rcaller_fn <- function() 1\rsource(\"child.R\")\r",
    );
    write(&ws, "child.R", b"caller_fn(1)\n");
    // A CRLF file keeps its ranges.
    write(
        &ws,
        "crlf.R",
        b"x <- 1\r\nhelper2 <- function(x) x\r\nhelper2(1)\r\n",
    );
    let docs = parse_isolated(
        &ws,
        &[
            "main.R",
            "local.R",
            "cr_sources_lf.R",
            "lf_sources_cr.R",
            "child.R",
            "crlf.R",
        ],
        None,
    );
    let range = |line: u64, start: u64, end: u64| {
        serde_json::json!({"start": {"line": line, "character": start},
                           "end": {"line": line, "character": end}})
    };
    let workspace = |path: &str, line: u64, start: u64, end: u64| serde_json::json!({"kind": "workspace", "path": path, "range": range(line, start, end)});

    let main = by_path(&docs, "main.R");
    assert_eq!(main["encoding"]["line_endings"], "cr");
    assert_eq!(
        *resolution_of(main, "helper", 2),
        workspace("main.R", 1, 0, 6)
    );
    assert_eq!(
        resolution_of(main, "helper", 2)["range"],
        *target_range(main, 1)
    );

    let local = by_path(&docs, "local.R");
    assert_eq!(
        *resolution_of(local, "inner", 2),
        serde_json::json!({"kind": "local", "range": range(1, 2, 7)})
    );

    let cr_sources_lf = by_path(&docs, "cr_sources_lf.R");
    assert_eq!(
        *resolution_of(cr_sources_lf, "lf_tool", 2),
        workspace("lf.R", 2, 0, 7)
    );
    let lf_sources_cr = by_path(&docs, "lf_sources_cr.R");
    assert_eq!(
        *resolution_of(lf_sources_cr, "cr_tool", 1),
        workspace("cr.R", 2, 1, 8)
    );

    let child = by_path(&docs, "child.R");
    assert_eq!(
        *resolution_of(child, "caller_fn", 0),
        workspace("caller.R", 1, 0, 9)
    );

    let crlf = by_path(&docs, "crlf.R");
    assert_eq!(
        *resolution_of(crlf, "helper2", 2),
        workspace("crlf.R", 1, 0, 7)
    );
    assert_eq!(
        resolution_of(crlf, "helper2", 2)["range"],
        *target_range(crlf, 1)
    );
}

#[test]
fn unresolved_says_why() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        b"nowhere()\nlater()\nlater <- function() 1\nlibrary(ravennodata)\nnodata()\nmutate(d)\n",
    );
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    let unresolved = |reason: &str| serde_json::json!({"kind": "unresolved", "reason": reason});
    assert_eq!(*resolution_of(doc, "nowhere", 0), unresolved("not_found"));
    assert_eq!(*resolution_of(doc, "later", 1), unresolved("defined_later"));
    let no_data = serde_json::json!({"kind": "unresolved", "reason": "no_package_data",
                                     "packages": ["ravennodata"]});
    assert_eq!(*resolution_of(doc, "nodata", 4), no_data);
    // A package Raven has data for doesn't count: `mutate` would be dplyr's.
    assert_eq!(*resolution_of(doc, "mutate", 5), no_data);
}

/// The `library()` rules `docs/cli.md` states, as `raven check`'s scope
/// applies them.
#[test]
fn library_in_a_function_or_a_branch() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        concat!(
            "f <- function() {\n",         // 0
            "  onlya()\n",                 // 1
            "  library(ravenpkga)\n",      // 2
            "  onlya()\n",                 // 3
            "}\n",                         // 4
            "onlya()\n",                   // 5
            "if (cond) {\n",               // 6
            "  library(ravenpkgb)\n",      // 7
            "}\n",                         // 8
            "onlyb()\n",                   // 9
            "g <- function() mutate(d)\n", // 10
            "mutate(d)\n",                 // 11
            "library(dplyr)\n",            // 12
        )
        .as_bytes(),
    );
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    let not_found = serde_json::json!({"kind": "unresolved", "reason": "not_found"});
    // Inside a function: from the call to the end of that body only.
    assert_eq!(*resolution_of(doc, "onlya", 1), not_found);
    assert_eq!(*resolution_of(doc, "onlya", 3), package("ravenpkga"));
    assert_eq!(*resolution_of(doc, "onlya", 5), not_found);
    // In a branch: attached after it, whether or not the branch runs.
    assert_eq!(*resolution_of(doc, "onlyb", 9), package("ravenpkgb"));
    // A function body sees every top-level attach in the file, later ones
    // included; top-level code only the earlier ones.
    assert_eq!(*resolution_of(doc, "mutate", 10), package("dplyr"));
    assert_eq!(*resolution_of(doc, "mutate", 11), not_found);
}

/// A file whose function bodies use names it defines later at top level,
/// directly or in a file it sources after the function.
fn later_definitions_workspace(raven_toml_extra: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let (tmp, ws) = package_workspace();
    let config = std::fs::read_to_string(ws.join("raven.toml")).unwrap();
    write(
        &ws,
        "raven.toml",
        format!("{config}{raven_toml_extra}").as_bytes(),
    );
    write(
        &ws,
        "main.R",
        concat!(
            "library(dplyr)\n",                  // 0
            "f <- function() g()\n",             // 1
            "h <- function() {\n",               // 2
            "  k <- function() mutate(n, pi)\n", // 3
            "  k()\n",                           // 4
            "}\n",                               // 5
            "y <- local(late())\n",              // 6
            "g(pi)\n",                           // 7
            "s <- function() fromkid()\n",       // 8
            "source(\"kid.R\")\n",               // 9
            "g <- function() 1\n",               // 10
            "mutate <- function(...) 1\n",       // 11
            "n <- 2\n",                          // 12
            "pi <- 3\n",                         // 13
            "late <- function() 1\n",            // 14
        )
        .as_bytes(),
    );
    write(&ws, "kid.R", b"fromkid <- function() 1\n");
    (tmp, ws)
}

fn range_json(line: u64, start: u64, end: u64) -> Value {
    serde_json::json!({"start": {"line": line, "character": start},
                       "end": {"line": line, "character": end}})
}

/// The single identifier `name` on `line`'s resolution, if it has one.
fn value_resolution<'d>(doc: &'d Value, name: &str, line: u64) -> Option<&'d Value> {
    let found = identifiers(doc, name, line);
    assert_eq!(found.len(), 1, "one `{name}` on line {line}");
    found[0].get("resolution")
}

/// docs/cli.md: "A function body sees its file's whole top level, as R does
/// when the function runs later: every top-level `library()` call and
/// definition, later ones included." The global environment comes before
/// the attached packages, so a later top-level definition also masks a
/// package export of the same name inside a body.
#[test]
fn a_function_body_sees_later_top_level_definitions() {
    let (_tmp, ws) = later_definitions_workspace("");
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    let workspace = |path: &str, range: Value| serde_json::json!({"kind": "workspace", "path": path, "range": range});
    let defined_later = serde_json::json!({"kind": "unresolved", "reason": "defined_later"});
    assert_eq!(
        *resolution_of(doc, "g", 1),
        workspace("main.R", range_json(10, 0, 1))
    );
    // A nested function too, and the later definition masks dplyr's export.
    assert_eq!(
        *resolution_of(doc, "mutate", 3),
        workspace("main.R", range_json(11, 0, 6))
    );
    // Values: the later global `n` masks `dplyr::n`, and `pi <- 3` masks
    // base's `pi`, so neither is a package object.
    assert_eq!(value_resolution(doc, "n", 3), None);
    assert_eq!(value_resolution(doc, "pi", 3), None);
    // A definition in a file sourced after the function.
    assert_eq!(
        *resolution_of(doc, "fromkid", 8),
        workspace("kid.R", range_json(0, 0, 7))
    );
    // Top-level code, and an immediate `local()` body, run where they stand.
    assert_eq!(*resolution_of(doc, "late", 6), defined_later);
    assert_eq!(*resolution_of(doc, "g", 7), defined_later);
    assert_eq!(value_resolution(doc, "pi", 7), Some(&package("base")));
}

/// With `hoistGlobalsInFunctions` off, a body sees only what is defined
/// before it, as top-level code does.
#[test]
fn without_hoisting_a_function_body_sees_only_earlier_definitions() {
    let (_tmp, ws) = later_definitions_workspace("[crossFile]\nhoistGlobalsInFunctions = false\n");
    let docs = parse_isolated(&ws, &["main.R"], None);
    let doc = &docs[0];
    let defined_later = serde_json::json!({"kind": "unresolved", "reason": "defined_later"});
    assert_eq!(*resolution_of(doc, "g", 1), defined_later);
    assert_eq!(*resolution_of(doc, "mutate", 3), package("dplyr"));
    assert_eq!(value_resolution(doc, "n", 3), Some(&package("dplyr")));
    assert_eq!(value_resolution(doc, "pi", 3), Some(&package("base")));
    assert_eq!(
        *resolution_of(doc, "fromkid", 8),
        serde_json::json!({"kind": "unresolved", "reason": "not_found"})
    );
}

#[test]
fn a_caller_attachment_counts_before_its_source_call() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "main.R",
        b"library(dplyr)\nsource(\"kid.R\")\nlibrary(ravenpkga)\n",
    );
    write(
        &ws,
        "kid.R",
        b"filter(d)\nmutate(d)\nonlya()\nk <- function() onlya()\n",
    );
    let docs = parse_isolated(&ws, &["kid.R"], None);
    let doc = &docs[0];
    // The caller's attachment outranks the default-attached packages.
    assert_eq!(*resolution_of(doc, "filter", 0), package("dplyr"));
    assert_eq!(*resolution_of(doc, "mutate", 1), package("dplyr"));
    // Attached after the `source()` call: not yet, at top level...
    assert_eq!(
        *resolution_of(doc, "onlya", 2),
        serde_json::json!({"kind": "unresolved", "reason": "not_found"})
    );
    // ...but a function body sees the caller's whole top level.
    assert_eq!(*resolution_of(doc, "onlya", 3), package("ravenpkga"));
}

#[test]
fn disagreeing_callers_are_ambiguous() {
    let (_tmp, ws) = package_workspace();
    write(
        &ws,
        "a.R",
        b"library(dplyr)\nhelper <- function() 1\nsource(\"kid.R\")\n",
    );
    write(&ws, "b.R", b"source(\"kid.R\")\n");
    write(&ws, "kid.R", b"mutate(d)\nfilter(d)\nhelper()\nmean(1)\n");
    let docs = parse_isolated(&ws, &["kid.R"], None);
    let doc = &docs[0];
    let ambiguous = |first: Value, second: Value| {
        serde_json::json!({"kind": "ambiguous", "candidates": [
            {"path": "a.R", "resolution": first},
            {"path": "b.R", "resolution": second},
        ]})
    };
    let not_found = serde_json::json!({"kind": "unresolved", "reason": "not_found"});
    assert_eq!(
        *resolution_of(doc, "mutate", 0),
        ambiguous(package("dplyr"), not_found.clone())
    );
    assert_eq!(
        *resolution_of(doc, "filter", 1),
        ambiguous(package("dplyr"), package("stats"))
    );
    let helper = serde_json::json!({"kind": "workspace", "path": "a.R", "range":
        {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 6}}});
    assert_eq!(
        *resolution_of(doc, "helper", 2),
        ambiguous(helper, not_found)
    );
    // Callers that agree give one resolution.
    assert_eq!(*resolution_of(doc, "mean", 3), package("base"));
}

#[test]
fn ambiguous_candidates_sort_by_printed_path() {
    // `ü.R`'s URI percent-encodes the `ü` (`%C3%BC.R`), which sorts before
    // `b.R`; its printed path sorts after it in byte order. Candidates follow
    // the printed path, as docs/cli.md says.
    let (_tmp, ws) = package_workspace();
    write(&ws, "ü.R", b"library(dplyr)\nsource(\"kid.R\")\n");
    write(&ws, "b.R", b"source(\"kid.R\")\n");
    write(&ws, "kid.R", b"mutate(d)\n");
    let docs = parse_isolated(&ws, &["kid.R"], None);
    let not_found = serde_json::json!({"kind": "unresolved", "reason": "not_found"});
    assert_eq!(
        *resolution_of(&docs[0], "mutate", 0),
        serde_json::json!({"kind": "ambiguous", "candidates": [
            {"path": "b.R", "resolution": not_found},
            {"path": "ü.R", "resolution": package("dplyr")},
        ]})
    );
}

#[test]
fn package_data_says_which_sources_loaded() {
    let (tmp, ws) = package_workspace();
    write(&ws, "main.R", b"library(ravendbonly)\ndbfn()\n");
    let docs = parse_isolated(&ws, &["main.R"], None);
    assert_eq!(
        docs[0]["package_data"],
        serde_json::json!({"enabled": true, "r_found": false, "names_db": false,
                           "frozen": true})
    );
    // Without the names database, its package is one Raven has no data for.
    assert_eq!(
        *resolution_of(&docs[0], "dbfn", 1),
        serde_json::json!({"kind": "unresolved", "reason": "no_package_data",
                           "packages": ["ravendbonly"]})
    );

    let names_db = tmp.path().join("names.db");
    raven::package_db::binary_db::write_shipped_db(
        &names_db,
        &[raven::package_db::model::PackageRecord {
            name: "ravendbonly".into(),
            version: "1.0.0".into(),
            exports: vec!["dbfn".into()],
            depends: vec![],
            lazy_data: vec![],
        }],
        raven::package_db::binary_db::ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-11-08".into(),
            package_count: 1,
            raven_version: "0".into(),
        },
    )
    .unwrap();
    let docs = parse_isolated(&ws, &["main.R"], Some(&names_db));
    assert_eq!(docs[0]["package_data"]["names_db"], true);
    assert_eq!(*resolution_of(&docs[0], "dbfn", 1), package("ravendbonly"));

    // Package awareness off: no source of package data at all.
    let (_tmp, ws) = workspace();
    write(&ws, "main.R", b"library(dplyr)\nmutate(d)\nfilter(d)\n");
    let docs = parse_isolated(&ws, &["main.R"], None);
    assert_eq!(
        docs[0]["package_data"],
        serde_json::json!({"enabled": false, "r_found": false, "names_db": false,
                           "frozen": false})
    );
    assert_eq!(
        *resolution_of(&docs[0], "mutate", 1),
        serde_json::json!({"kind": "unresolved", "reason": "no_package_data",
                           "packages": ["dplyr"]})
    );
    // R's builtins are known without package data.
    assert_eq!(*resolution_of(&docs[0], "filter", 2), package("stats"));
}

// ---------------------------------------------------------------------------
// Joining a parsed document to `raven graph`
// ---------------------------------------------------------------------------

fn graph_of(ws: &Path) -> Value {
    let graph = raven(&[
        "graph",
        "--workspace",
        ws.to_str().unwrap(),
        "--format",
        "json",
    ]);
    assert_eq!(graph.status.code(), Some(0), "{graph:?}");
    serde_json::from_slice(&graph.stdout).unwrap()
}

/// Each `source()` call that made an edge starts at its edge's
/// `call_site.position`; a dropped one at its `dropped` `position`; each
/// directive comment starts on its edge's `directive.line`.
#[test]
fn source_calls_and_directives_join_the_graph() {
    let (_tmp, ws) = workspace();
    write(
        &ws,
        "raven.toml",
        b"[packages]\nenabled = false\n[workspace]\nexclude = [\"vendor/**\"]\n",
    );
    write(
        &ws,
        "main.R",
        b"x <- 1\n  source(\"R/a.R\")\ny <- sys.source(\"R/d.R\", envir = globalenv())\nsource(\"vendor/v.R\")\nz <- base::source(\"R/e.R\")\notherpkg::source(\"R/e.R\")\n",
    );
    write(
        &ws,
        "R/a.R",
        b"# raven: sourced-by ../main.R\nlocal({\n  source(\"R/b.R\")\n})\n# raven: source R/c.R\n",
    );
    write(&ws, "R/b.R", b"b <- 1\n");
    write(&ws, "R/c.R", b"c1 <- 1\n");
    write(&ws, "R/d.R", b"d <- 1\n");
    write(&ws, "vendor/v.R", b"v <- 1\n");
    write(&ws, "R/e.R", b"e <- 1\n");

    let graph = graph_of(&ws);
    let docs = documents(&parse_in(&ws, &["main.R", "R/a.R"]));
    let source_calls = |path: &str| -> Vec<Value> {
        calls(by_path(&docs, path))
            .into_iter()
            .filter(|call| {
                // `base::source()` names its function through a namespace
                // node; another package's `source()` isn't a source call.
                let function = &call["function"];
                let name = if function["kind"] == "namespace" && function["left"]["name"] == "base"
                {
                    &function["right"]["name"]
                } else {
                    &function["name"]
                };
                matches!(name.as_str(), Some("source" | "sys.source"))
            })
            .map(|call| call["range"]["start"].clone())
            .collect()
    };

    let mut joined = Vec::new();
    for edge in graph["edges"].as_array().unwrap() {
        if edge["call_site"]["basis"] == "call" {
            let caller = edge["caller"].as_str().unwrap();
            let position = &edge["call_site"]["position"];
            assert!(
                source_calls(caller).contains(position),
                "no source() call in {caller} starts at {position}"
            );
            joined.push((caller.to_string(), position.clone()));
        }
        if !edge["directive"].is_null() {
            let file = edge["directive"]["file"].as_str().unwrap();
            let line = &edge["directive"]["line"];
            let doc = by_path(&docs, file);
            let directives: Vec<&Value> = comments_of(doc)
                .into_iter()
                .filter(|comment| !comment["directive"].is_null())
                .filter(|comment| comment["range"]["start"]["line"] == *line)
                .collect();
            assert_eq!(directives.len(), 1, "no directive on {file} line {line}");
        }
    }
    let dropped = graph["dropped"].as_array().unwrap();
    assert_eq!(dropped.len(), 1, "{dropped:?}");
    assert_eq!(dropped[0]["reason"], "excluded");
    let caller = dropped[0]["caller"].as_str().unwrap();
    assert!(source_calls(caller).contains(&dropped[0]["position"]));
    joined.push((caller.to_string(), dropped[0]["position"].clone()));

    // Every source() call in the two files is accounted for, the indented
    // one, the `base::`-qualified one, and the nested one inside
    // `local({ ... })` included.
    let mut all: Vec<(String, Value)> = ["main.R", "R/a.R"]
        .into_iter()
        .flat_map(|path| {
            source_calls(path)
                .into_iter()
                .map(move |start| (path.to_string(), start))
        })
        .collect();
    let key = |entry: &(String, Value)| entry.0.clone() + &entry.1.to_string();
    all.sort_by_key(key);
    joined.sort_by_key(key);
    assert_eq!(all, joined);
    assert_eq!(all.len(), 5);
    let directive_edges = graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|edge| !edge["directive"].is_null())
        .count();
    assert_eq!(directive_edges, 2);
}

/// Every comment in a parsed document, in any list.
fn comments_of(doc: &Value) -> Vec<&Value> {
    fn walk<'v>(value: &'v Value, out: &mut Vec<&'v Value>) {
        match value {
            Value::Object(map) => {
                if map.contains_key("directive") && map.contains_key("text") {
                    out.push(value);
                }
                map.values().for_each(|child| walk(child, out));
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(doc, &mut out);
    out
}
