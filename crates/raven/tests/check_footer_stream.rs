//! End-to-end test for `raven check`'s post-render context-note stream routing.
//!
//! The traversal-budget and missing-export-metadata notes annotate the
//! diagnostics above them, so for the human-readable `text` format they must
//! ride the diagnostics' own stream (stdout). Otherwise a merged consumer (a
//! terminal, `2>&1`, or GitHub Actions — which timestamps each line at read
//! time across two independent pipe readers) interleaves the note lines with
//! the findings, splitting the multi-line block apart. For the machine formats
//! (`json`/`sarif`) stdout is reserved for the parsed document, so the note
//! stays on stderr.
//!
//! This drives the traversal-budget note (issue #473), which needs no R
//! subprocess: a `maxTransitiveDependentsVisited = 1` budget over a short
//! `source()` chain truncates the neighborhood walk and emits the note.
//!
//! Run with: `cargo test -p raven --test check_footer_stream`

use std::process::{Command, Output};
use tempfile::TempDir;

const TRUNCATION_NOTE: &str = "a bounded cross-file neighborhood traversal was truncated";

fn raven_binary() -> std::path::PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // remove test binary name
    path.pop(); // remove `deps`
    path.push("raven");
    path
}

/// A workspace whose `a.R` → `b.R` → `c.R` chain truncates under a
/// visited-budget of 1, so checking `a.R` emits the traversal-budget note.
fn truncating_workspace() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    std::fs::write(
        p.join("raven.toml"),
        "[crossFile]\nmaxTransitiveDependentsVisited = 1\n",
    )
    .unwrap();
    std::fs::write(p.join("a.R"), "source(\"b.R\")\nx <- helper_b()\n").unwrap();
    std::fs::write(
        p.join("b.R"),
        "source(\"c.R\")\nhelper_b <- function() helper_c()\n",
    )
    .unwrap();
    std::fs::write(p.join("c.R"), "helper_c <- function() 1\n").unwrap();
    dir
}

fn run_check(workspace: &std::path::Path, extra: &[&str]) -> Output {
    let mut args = vec![
        "check",
        "--workspace",
        workspace.to_str().unwrap(),
        "--no-color",
    ];
    args.extend_from_slice(extra);
    args.push("a.R");
    Command::new(raven_binary())
        .args(&args)
        .output()
        .expect("run raven check")
}

#[test]
fn text_format_emits_traversal_note_on_stdout_not_stderr() {
    let ws = truncating_workspace();
    let out = run_check(ws.path(), &[]);
    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");
    let stderr = String::from_utf8(out.stderr).expect("stderr utf-8");

    // The note rides the diagnostics' stream (stdout) so a merged consumer
    // can't interleave it with the findings it annotates.
    assert!(
        stdout.contains(TRUNCATION_NOTE),
        "traversal note must be on stdout for text format; stdout was:\n{stdout}"
    );
    assert!(
        !stderr.contains(TRUNCATION_NOTE),
        "traversal note must NOT be on stderr for text format; stderr was:\n{stderr}"
    );
    // It is a footer: the diagnostic line precedes it on the same stream.
    let diag = stdout
        .find("undefined-variable")
        .expect("expected an undefined-variable diagnostic on stdout");
    let note = stdout.find(TRUNCATION_NOTE).unwrap();
    assert!(
        diag < note,
        "the note must follow the diagnostics it annotates"
    );
}

#[test]
fn json_format_keeps_traversal_note_on_stderr() {
    let ws = truncating_workspace();
    let out = run_check(ws.path(), &["--format", "json"]);
    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");
    let stderr = String::from_utf8(out.stderr).expect("stderr utf-8");

    // stdout must remain a parseable JSON document — no prose note in it.
    assert!(
        !stdout.contains(TRUNCATION_NOTE),
        "the note must not pollute the json document on stdout; stdout was:\n{stdout}"
    );
    assert!(
        serde_json::from_str::<serde_json::Value>(stdout.trim()).is_ok(),
        "stdout must be valid JSON; got:\n{stdout}"
    );
    assert!(
        stderr.contains(TRUNCATION_NOTE),
        "the note must be on stderr for json format; stderr was:\n{stderr}"
    );
}
