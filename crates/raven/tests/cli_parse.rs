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
