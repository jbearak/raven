//! End-to-end checks for a `source()` call on the line a `# raven: source X
//! line=N` directive points at (issue #814). The directive stands in for the
//! call only when both name the same file; a call to another file keeps its
//! own edge, scope, and missing-file check. Every fixture is synthetic and
//! runs through `raven check` and `raven graph`.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn run_json(root: &Path, args: &[&str]) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(args)
        .arg("--workspace")
        .arg(root)
        .args(["--format", "json"])
        .output()
        .unwrap();
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "raven {args:?} did not complete cleanly.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

/// `(code, 0-based line, message)` for every diagnostic in `m.R` that is an
/// `unresolved-source-path`, a redundant-directive hint, or says a `from_*`
/// probe is not defined. Filtering keeps the result independent of whether R
/// is installed to resolve base functions.
fn diagnostics(root: &Path) -> Vec<(String, u64, String)> {
    let rows = run_json(root, &["check", "--max-severity", "off", "--no-color"]);
    let mut found: Vec<_> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["path"] == "m.R")
        .filter_map(|row| {
            let diagnostic = &row["diagnostic"];
            let code = diagnostic["code"].as_str().unwrap_or_default();
            let message = diagnostic["message"].as_str().unwrap();
            let keep = code == "unresolved-source-path"
                || message.starts_with("Redundant source directive")
                || (code == "undefined-variable" && message.starts_with("from_"));
            keep.then(|| {
                (
                    code.to_owned(),
                    diagnostic["range"]["start"]["line"].as_u64().unwrap(),
                    message.to_owned(),
                )
            })
        })
        .collect();
    found.sort();
    found
}

type Rows = Vec<(String, String)>;

/// `(target, origin)` for every edge out of `m.R`, and `(target, reason)` for
/// every call site in `m.R` that produced no edge.
fn graph(root: &Path) -> (Rows, Rows) {
    let graph = run_json(root, &["graph"]);
    let field = |row: &serde_json::Value, key: &str| row[key].as_str().unwrap().to_owned();
    let rows = |section: &str, second: &str| {
        let mut rows: Vec<_> = graph[section]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["caller"] == "m.R")
            .map(|row| (field(row, "target"), field(row, second)))
            .collect();
        rows.sort();
        rows
    };
    (rows("edges", "origin"), rows("dropped", "reason"))
}

fn pair(a: &str, b: &str) -> (String, String) {
    (a.to_owned(), b.to_owned())
}

/// A call to a different file than the directive keeps its edge, and both
/// files' definitions are in scope after the line, wherever the call starts.
#[test]
fn call_to_another_file_on_the_directive_line_is_kept() {
    for call in ["source(\"b.R\")", "  source(\"b.R\")"] {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "m.R",
            &format!("# raven: source other.R line=2\n{call}\nprint(from_b)\nprint(from_other)\n"),
        );
        write(dir.path(), "b.R", "from_b <- 1\n");
        write(dir.path(), "other.R", "from_other <- 2\n");

        assert_eq!(diagnostics(dir.path()), [], "call: {call:?}");
        let (edges, dropped) = graph(dir.path());
        assert_eq!(
            edges,
            [pair("b.R", "call"), pair("other.R", "directive")],
            "call: {call:?}"
        );
        assert_eq!(dropped, [], "call: {call:?}");
    }
}

/// A call to a missing file on the directive's line is still reported.
#[test]
fn missing_file_call_on_the_directive_line_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "m.R",
        "# raven: source other.R line=2\nsource(\"missing.R\")\nprint(from_other)\n",
    );
    write(dir.path(), "other.R", "from_other <- 2\n");

    let found = diagnostics(dir.path());
    assert_eq!(found.len(), 1, "{found:?}");
    let (code, line, message) = &found[0];
    assert_eq!((code.as_str(), *line), ("unresolved-source-path", 1));
    assert!(message.contains("missing.R"), "{message}");
}

/// A call to the same file as the directive is superseded by it, however the
/// call spells the path and wherever it starts: one directive edge, the file's
/// definitions in scope, and no redundant-directive hint.
#[test]
fn call_to_the_directive_target_is_superseded() {
    for call in [
        "source(\"b.R\")",
        "  source(\"b.R\")",
        "source(\"./b.R\")",
        "  source(\"./b.R\")",
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "m.R",
            &format!("# raven: source b.R line=2\n{call}\nprint(from_b)\n"),
        );
        write(dir.path(), "b.R", "from_b <- 1\n");

        assert_eq!(diagnostics(dir.path()), [], "call: {call:?}");
        let (edges, dropped) = graph(dir.path());
        assert_eq!(edges, [pair("b.R", "directive")], "call: {call:?}");
        assert_eq!(dropped, [pair("b.R", "superseded")], "call: {call:?}");
    }
}

/// When the directive and the call on its line name the same missing file,
/// the file is reported once.
#[test]
fn missing_directive_target_is_reported_once() {
    for call in ["source(\"gone.R\")", "  source(\"./gone.R\")"] {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "m.R",
            &format!("# raven: source gone.R line=2\n{call}\n"),
        );

        let found = diagnostics(dir.path());
        assert_eq!(found.len(), 1, "call: {call:?}: {found:?}");
        assert_eq!(found[0].0, "unresolved-source-path", "call: {call:?}");
    }
}

/// Under `# raven: cd`, the directive and the call resolve from the same
/// directory, so they still agree on which file each names: a same-file call
/// is superseded, another file's call is kept, and a missing file is reported
/// once.
#[test]
fn working_directory_applies_to_both_sides() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "m.R",
        "# raven: cd sub\n# raven: source b.R line=3\nsource(\"./b.R\")\nprint(from_b)\n",
    );
    write(dir.path(), "sub/b.R", "from_b <- 1\n");
    assert_eq!(diagnostics(dir.path()), []);
    let (edges, dropped) = graph(dir.path());
    assert_eq!(edges, [pair("sub/b.R", "directive")]);
    assert_eq!(dropped, [pair("sub/b.R", "superseded")]);

    write(
        dir.path(),
        "m.R",
        "# raven: cd sub\n# raven: source b.R line=3\nsource(\"c.R\")\nprint(from_b)\nprint(from_c)\n",
    );
    write(dir.path(), "sub/c.R", "from_c <- 1\n");
    assert_eq!(diagnostics(dir.path()), []);
    let (edges, dropped) = graph(dir.path());
    assert_eq!(
        edges,
        [pair("sub/b.R", "directive"), pair("sub/c.R", "call")]
    );
    assert_eq!(dropped, []);

    write(
        dir.path(),
        "m.R",
        "# raven: cd sub\n# raven: source gone.R line=3\nsource(\"./gone.R\")\n",
    );
    let found = diagnostics(dir.path());
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, "unresolved-source-path");
}

/// The file `raven parse` resolves each `from_*()` call statement of `m.R` to
/// (`None` when it isn't a workspace file), by the statement's text.
fn probe_files(root: &Path) -> Vec<(String, Option<String>)> {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["parse", "--workspace"])
        .arg(root)
        .arg("m.R")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let document: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    document["statements"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|statement| {
            let text = statement["text"].as_str().unwrap();
            text.starts_with("from_").then(|| {
                (
                    text.to_owned(),
                    statement["expression"]["resolution"]["path"]
                        .as_str()
                        .map(str::to_owned),
                )
            })
        })
        .collect()
}

fn probe(call: &str, file: &str) -> (String, Option<String>) {
    (call.to_owned(), Some(file.to_owned()))
}

// The tests below pin what already works when a `source()` call, forward
// directives and backward directives share one call site. An attempt to give
// two directives on one line a file each (issue #886, item 3) broke each of
// them in turn; a second attempt has to keep them.

/// A backward directive can sit on a call that names another file: `a.R`
/// says the `source("c.R")` call in `m.R` runs it too (through a path `c.R`
/// computes). The call lends `a.R`.
#[test]
fn backward_directive_on_a_call_to_another_file_lends() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "m.R", "source(\"c.R\")\nfrom_a()\nfrom_c()\n");
    write(
        dir.path(),
        "c.R",
        "from_c <- function() 3\np <- paste0(\"a\", \".R\")\nsource(p)\n",
    );
    write(
        dir.path(),
        "a.R",
        "# raven: sourced-by m.R match='source(\"c.R\")'\nfrom_a <- function() 1\n",
    );
    assert_eq!(diagnostics(dir.path()), []);
}

/// Two directives name the line of a `source("b.R")` call that a backward
/// directive in `a.R` also matches. What `b.R` sources is still in scope.
#[test]
fn covered_call_with_a_backward_edge_from_a_directive_target() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "m.R",
        "# raven: source b.R line=3\n# raven: source a.R line=3\nsource(\"b.R\")\nfrom_deep()\n",
    );
    write(
        dir.path(),
        "a.R",
        "# raven: sourced-by m.R match='source(\"b.R\")'\nfrom_a <- function() 1\n",
    );
    write(dir.path(), "b.R", "source(\"deep.R\")\n");
    write(dir.path(), "deep.R", "from_deep <- function() 1\n");

    assert_eq!(diagnostics(dir.path()), []);
    assert_eq!(probe_files(dir.path()), [probe("from_deep()", "deep.R")]);
}

/// The same with the backward directive in a third file: `c.R` says the
/// `source("a.R")` call runs it. Both `a.R` and `c.R` are lent.
#[test]
fn covered_call_with_a_backward_edge_from_a_third_file() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "m.R",
        "# raven: source a.R line=3\n# raven: source b.R line=3\nsource(\"a.R\")\n\
         from_a()\nfrom_c()\n",
    );
    write(
        dir.path(),
        "a.R",
        "from_a <- function() 1\np <- paste0(\"c\", \".R\")\nsource(p)\n",
    );
    write(dir.path(), "b.R", "from_b <- function() 2\n");
    write(
        dir.path(),
        "c.R",
        "# raven: sourced-by m.R match='source(\"a.R\")'\nfrom_c <- function() 3\n",
    );

    assert_eq!(diagnostics(dir.path()), []);
    assert_eq!(
        probe_files(dir.path()),
        [probe("from_a()", "a.R"), probe("from_c()", "c.R")]
    );
}

/// Both directives' files define the same name, and R runs the one the call
/// names last: `a.R` sources `b.R`, then redefines it. The call resolves to
/// `a.R`'s definition.
#[test]
fn same_name_in_both_directive_targets_resolves_to_the_calls_file() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "m.R",
        "# raven: source a.R line=3\n# raven: source b.R line=3\n\
         if (TRUE) source(\"a.R\")\nfrom_shared()\n",
    );
    write(
        dir.path(),
        "a.R",
        "source(\"b.R\")\nfrom_shared <- function() \"a\"\n",
    );
    write(dir.path(), "b.R", "from_shared <- function() \"b\"\n");
    assert_eq!(probe_files(dir.path()), [probe("from_shared()", "a.R")]);

    // Two calls on the line, the later one to `a.R`.
    write(
        dir.path(),
        "m.R",
        "# raven: source a.R line=3\n# raven: source b.R line=3\n  \
         source(\"./b.R\"); source(\"a.R\")\nfrom_shared()\n",
    );
    write(dir.path(), "a.R", "from_shared <- function() \"a\"\n");
    assert_eq!(probe_files(dir.path()), [probe("from_shared()", "a.R")]);
}

/// The calls the directives stand for are inside a function, and `a.R`
/// assigns with `<<-`, so its definition is global after the function runs.
#[test]
fn directives_for_calls_inside_a_function_lend_a_global_assignment() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "m.R",
        "# raven: source a.R line=4\n# raven: source b.R line=4\nload_helpers <- function() {\n  \
         source(\"./b.R\"); source(\"a.R\", local = TRUE)\n}\nload_helpers()\nfrom_a()\n",
    );
    write(dir.path(), "a.R", "from_a <<- function() \"a\"\n");
    write(dir.path(), "b.R", "from_b <- function() \"b\"\n");
    assert_eq!(probe_files(dir.path()), [probe("from_a()", "a.R")]);
}
