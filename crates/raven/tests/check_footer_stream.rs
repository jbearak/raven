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
//! Two footer paths are driven, both without an R subprocess:
//! - the traversal-budget note (issue #473): a `maxTransitiveDependentsVisited = 1`
//!   budget over a short `source()` chain truncates the neighborhood walk;
//! - the package-DB load note: a corrupt `.raven/packages.json` makes the
//!   package library report an unreadable Tier-2 DB. This is the only footer
//!   entry in that case, so it proves a lone load note still surfaces on the
//!   right stream.
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

/// `raven check` must finish with a findings-based exit code — `0` (nothing over
/// threshold) or `1` (some) — never the operator-error code `2`. Asserting this
/// guards the footer tests against an exit-code regression that still happened
/// to emit the note on the expected stream (Codex review).
fn assert_findings_exit(out: &Output) {
    assert!(
        matches!(out.status.code(), Some(0) | Some(1)),
        "raven check exited with an unexpected (operator-error) status: {:?}",
        out.status.code()
    );
}

#[test]
fn text_format_emits_traversal_note_on_stdout_not_stderr() {
    let ws = truncating_workspace();
    let out = run_check(ws.path(), &[]);
    assert_findings_exit(&out);
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
    assert_findings_exit(&out);
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

const LOAD_NOTE: &str = ".raven/packages.json is unreadable";

/// A workspace whose committed Tier-2 package DB (`.raven/packages.json`) is
/// corrupt, so `maybe_init_r` emits a package-DB load note. No R subprocess and
/// no `names.db` required — this drives the load-note footer path that
/// `footer_stream` must keep on the diagnostics' stream. `a.R` is
/// diagnostic-free so the load note is the ONLY footer entry, proving it
/// surfaces on its own (a regression that reverted `maybe_init_r` to print it
/// inline on stderr would fail this).
fn corrupt_package_db_workspace() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    std::fs::create_dir(p.join(".raven")).unwrap();
    std::fs::write(
        p.join(".raven/packages.json"),
        "this is not valid json {{{\n",
    )
    .unwrap();
    std::fs::write(p.join("a.R"), "x <- 1\n").unwrap();
    dir
}

#[test]
fn text_format_emits_load_note_on_stdout_not_stderr() {
    let ws = corrupt_package_db_workspace();
    let out = run_check(ws.path(), &[]);
    assert_findings_exit(&out);
    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");
    let stderr = String::from_utf8(out.stderr).expect("stderr utf-8");

    assert!(
        stdout.contains(LOAD_NOTE),
        "package-DB load note must be on stdout for text format; stdout was:\n{stdout}"
    );
    assert!(
        !stderr.contains(LOAD_NOTE),
        "package-DB load note must NOT be on stderr for text format; stderr was:\n{stderr}"
    );
}

#[test]
fn json_format_keeps_load_note_on_stderr() {
    let ws = corrupt_package_db_workspace();
    let out = run_check(ws.path(), &["--format", "json"]);
    assert_findings_exit(&out);
    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");
    let stderr = String::from_utf8(out.stderr).expect("stderr utf-8");

    assert!(
        !stdout.contains(LOAD_NOTE),
        "the load note must not pollute the json document on stdout; stdout was:\n{stdout}"
    );
    assert!(
        serde_json::from_str::<serde_json::Value>(stdout.trim()).is_ok(),
        "stdout must be valid JSON; got:\n{stdout}"
    );
    assert!(
        stderr.contains(LOAD_NOTE),
        "the load note must be on stderr for json format; stderr was:\n{stderr}"
    );
}
