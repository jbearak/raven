//! End-to-end tests for F2 per-code suppression on the analyzer track.
//!
//! Exercises the `raven check` CLI to verify that a `[code]` selector on a
//! `# raven: ignore` / `# @lsp-ignore` directive targets only the named
//! diagnostic code, while a bare directive blankets the line.
//!
//! Run with: `cargo test -p raven --test suppression_per_code`

use std::process::Command;
use tempfile::TempDir;

fn raven_binary() -> std::path::PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // remove test binary name
    path.pop(); // remove `deps`
    path.push("raven");
    path
}

fn run_check(workspace: &std::path::Path) -> String {
    let output = Command::new(raven_binary())
        .args(["check", "--workspace"])
        .arg(workspace)
        .args(["--max-severity", "off", "--no-color"])
        .output()
        .expect("failed to execute raven check");
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn check_one(source: &str) -> String {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("main.R"), source).unwrap();
    run_check(dir.path())
}

#[test]
fn matching_code_suppresses_undefined_variable() {
    let out = check_one("result <- totally_undefined_thing # raven: ignore[undefined-variable]\n");
    assert!(
        !out.contains("Undefined variable: totally_undefined_thing"),
        "ignore[undefined-variable] should suppress the undefined-variable diagnostic. Output:\n{out}"
    );
}

#[test]
fn non_matching_code_does_not_suppress_undefined_variable() {
    let out = check_one("result <- totally_undefined_thing # raven: ignore[line-length]\n");
    assert!(
        out.contains("Undefined variable: totally_undefined_thing"),
        "ignore[line-length] must NOT suppress an undefined-variable diagnostic. Output:\n{out}"
    );
}

#[test]
fn bare_ignore_blankets_undefined_variable() {
    let out = check_one("result <- totally_undefined_thing # raven: ignore\n");
    assert!(
        !out.contains("Undefined variable: totally_undefined_thing"),
        "a bare `# raven: ignore` should blanket the line. Output:\n{out}"
    );
}

#[test]
fn lsp_ignore_with_matching_code_suppresses() {
    let out = check_one("result <- totally_undefined_thing # @lsp-ignore[undefined-variable]\n");
    assert!(
        !out.contains("Undefined variable: totally_undefined_thing"),
        "@lsp-ignore[undefined-variable] should suppress the diagnostic. Output:\n{out}"
    );
}

#[test]
fn ignore_next_with_code_targets_following_line() {
    let out =
        check_one("# raven: ignore-next[undefined-variable]\nresult <- totally_undefined_thing\n");
    assert!(
        !out.contains("Undefined variable: totally_undefined_thing"),
        "ignore-next[undefined-variable] should suppress the next line. Output:\n{out}"
    );
}

// ---- F2 Step 3: `expect` flavor + `unused-suppression` (HINT) ----

#[test]
fn expect_that_suppresses_a_diagnostic_is_not_reported_unused() {
    // The `expect` actually suppresses an undefined-variable, so no
    // unused-suppression hint should appear.
    let out = check_one("result <- totally_undefined_thing # raven: expect[undefined-variable]\n");
    assert!(
        !out.contains("Undefined variable: totally_undefined_thing"),
        "expect should suppress the undefined-variable diagnostic. Output:\n{out}"
    );
    assert!(
        !out.contains("unused-suppression") && !out.contains("Unused"),
        "a used `expect` must NOT be reported as unused. Output:\n{out}"
    );
}

#[test]
fn expect_that_suppresses_nothing_is_reported_unused() {
    // `defined_value` IS defined, so the expect suppresses nothing → it must be
    // reported as unused (HINT).
    let out = check_one(
        "defined_value <- 1\nresult <- defined_value # raven: expect[undefined-variable]\n",
    );
    assert!(
        out.contains("unused-suppression") || out.contains("Unused `expect` suppression"),
        "an `expect` that suppressed nothing must be reported as unused. Output:\n{out}"
    );
}

#[test]
fn ignore_that_suppresses_nothing_is_not_reported_by_default() {
    // A plain `ignore` that suppresses nothing is silent by default (the
    // reportUnusedSuppressions sweep is off).
    let out = check_one(
        "defined_value <- 1\nresult <- defined_value # raven: ignore[undefined-variable]\n",
    );
    assert!(
        !out.contains("unused-suppression") && !out.contains("Unused"),
        "a silent `ignore` must NOT be reported as unused by default. Output:\n{out}"
    );
}
