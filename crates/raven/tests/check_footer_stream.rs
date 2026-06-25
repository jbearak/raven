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
        // Pin the logger to `error` so an inherited `RUST_LOG=warn`+ in the test
        // environment can't make `env_logger` mirror the package-DB load note
        // (logged at `warn` in `build_package_library`) onto stderr — which
        // would defeat these tests' "note is absent from stderr for text"
        // assertions. We are testing footer-stream routing, not logger config.
        .env("RUST_LOG", "error")
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

/// Distinctive lead fragment of the NSE footer. The hint appears ONLY here (the
/// reframed `text` footer) — never inline on a finding, never in `json`/`sarif`.
const NSE_FOOTER_LEAD: &str = "sit inside calls to package functions whose source raven can't see";

/// A workspace whose `a.R` flags three undefined variables inside call
/// arguments of qualified package callees (whose bodies raven cannot see), so
/// each carries an NSE discoverability hint. Two share the same
/// `somepkg::my_filter(x = ...)` named-arg suggestion (to exercise footer
/// dedup); the third is positional (the two-directive placeholder form).
fn nse_hint_workspace() -> TempDir {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("a.R"),
        "f <- function() {\n  somepkg::my_filter(x = aaa)\n  somepkg::my_filter(x = bbb)\n  \
         somepkg::other(ccc)\n}\n",
    )
    .unwrap();
    dir
}

#[test]
fn text_format_keeps_findings_clean_and_emits_reframed_deduped_footer() {
    let ws = nse_hint_workspace();
    let out = run_check(ws.path(), &[]);
    assert_findings_exit(&out);
    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");

    // No per-finding directive: the finding lines are just "<name> is not
    // defined", with the directives reserved for the single footer below.
    for line in stdout
        .lines()
        .filter(|l| l.contains("[undefined-variable]"))
    {
        assert!(
            !line.contains("# raven:"),
            "finding lines must carry no inline directive; offending line:\n{line}"
        );
    }
    // One reframed footer summarizes all three hinted findings...
    assert!(
        stdout.contains(&format!(
            "3 undefined-variable findings above {NSE_FOOTER_LEAD}"
        )),
        "footer counts all hinted findings; stdout was:\n{stdout}"
    );
    // ...leading with the universal escape hatches, NSE as one possibility.
    assert!(
        stdout.contains("# raven: ignore")
            && stdout.contains("# nolint")
            && stdout.contains("# raven: expect")
            && stdout.contains("non-standard evaluation (NSE)"),
        "footer frames suppression generally + names NSE; stdout was:\n{stdout}"
    );
    // The two named-arg findings collapse to a single copy-pasteable suggestion.
    assert_eq!(
        stdout.matches("# raven: nse somepkg::my_filter(x)").count(),
        1,
        "duplicate suggestions must dedup; stdout was:\n{stdout}"
    );
    // The positional finding gets the two-directive placeholder form, rendered
    // on separate lines (each `# raven:` directive must own its line to parse).
    assert!(
        stdout.contains("# raven: func somepkg::other(<formals>)")
            && stdout.contains("# raven: nse somepkg::other(<nse-formals>)"),
        "positional suggestion present; stdout was:\n{stdout}"
    );
    // ...and the footer explains why that case needs two directives.
    assert!(
        stdout.contains("needs the function's parameter list"),
        "footer explains the positional two-directive form; stdout was:\n{stdout}"
    );
    // Both docs URLs are present (directives + handling false positives).
    assert!(
        stdout.contains("https://github.com/jbearak/raven/blob/main/docs/directives.md")
            && stdout.contains("https://github.com/jbearak/raven/blob/main/docs/diagnostics.md"),
        "docs URLs present; stdout was:\n{stdout}"
    );
    // It is a footer: the findings precede it on the same stream.
    let diag = stdout
        .find("undefined-variable")
        .expect("expected an undefined-variable diagnostic on stdout");
    assert!(
        diag < stdout.find(NSE_FOOTER_LEAD).unwrap(),
        "the footer must follow the findings it annotates; stdout was:\n{stdout}"
    );
}

#[test]
fn json_format_carries_no_nse_hint_text_and_no_footer() {
    let ws = nse_hint_workspace();
    let out = run_check(ws.path(), &["--format", "json"]);
    assert_findings_exit(&out);
    let stdout = String::from_utf8(out.stdout).expect("stdout utf-8");
    let stderr = String::from_utf8(out.stderr).expect("stderr utf-8");

    // The machine document is clean JSON with no directive prose in any message
    // (the hint suggestion is text-only; structured `data` carries no directive
    // string), and no NSE footer leaks onto either stream.
    assert!(
        serde_json::from_str::<serde_json::Value>(stdout.trim()).is_ok(),
        "stdout must be valid JSON; got:\n{stdout}"
    );
    assert!(
        !stdout.contains("# raven:") && !stdout.contains("non-standard evaluation"),
        "json must carry no NSE directive prose; stdout was:\n{stdout}"
    );
    // The internal NSE hint is a text-footer / editor-quick-fix concern; it is
    // stripped from `data` before serialization, so no trace reaches machine output.
    assert!(
        !stdout.contains("nseHint"),
        "json must not leak the internal nseHint marker; stdout was:\n{stdout}"
    );
    assert!(
        !stdout.contains(NSE_FOOTER_LEAD) && !stderr.contains(NSE_FOOTER_LEAD),
        "the NSE footer is text-only; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
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
