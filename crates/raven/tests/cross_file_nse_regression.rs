//! Regression tests for cross-file NSE propagation and magrittr dot pronoun.
//!
//! These tests exercise the `raven check` CLI on temporary workspaces to verify
//! that package-loaded NSE suppression propagates across source() boundaries,
//! and that the magrittr dot pronoun (`.`) is not flagged.
//!
//! Run with: `cargo test --release -p raven --test cross_file_nse_regression`

use std::process::Command;
use tempfile::TempDir;

fn raven_binary() -> std::path::PathBuf {
    // Use the binary in the same target directory as this test.
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

/// When a parent file does `library(dplyr)` and sources a child, the child's
/// `filter(col > 1)` usage must NOT flag `col` as undefined — the NSE
/// suppression from dplyr::filter must propagate across the source() boundary.
///
/// Regression test for: cross-file NSE in_play_packages not including
/// parent-chain library() calls, causing filter() (which shadows stats::filter)
/// to be classified as Standard rather than applying dplyr's NSE policy.
#[test]
fn cross_file_filter_nse_suppressed_via_parent_library() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("main.R"),
        "library(dplyr)\nsource(\"child.R\")\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("child.R"),
        "df <- data.frame(x = 1:10, y = 11:20)\nresult <- df |> filter(x > 5)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Undefined variable: x"),
        "filter(x > 5) in child.R should NOT flag x as undefined \
         when parent loads dplyr. Output:\n{output}"
    );
}

/// Same scenario but with tidyverse (meta-package expansion).
#[test]
fn cross_file_filter_nse_via_tidyverse_meta_package() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("main.R"),
        "library(tidyverse)\nsource(\"child.R\")\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("child.R"),
        "df <- data.frame(x = 1:10)\nresult <- df |> filter(x > 5)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Undefined variable: x"),
        "tidyverse meta-package should expand to include dplyr for NSE. Output:\n{output}"
    );
}

/// Magrittr dot pronoun in curly-brace pipe: `df %>% { .$col }`.
#[test]
fn magrittr_dot_curly_brace_pipe_not_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("test.R"),
        "library(magrittr)\ndf <- data.frame(x = 1:10)\nresult <- df %>% { .$x }\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Undefined variable: ."),
        "dot pronoun in %>% curly-brace pipe must not be flagged. Output:\n{output}"
    );
}

/// Magrittr dot pronoun as explicit argument: `df %>% nrow(.)`.
#[test]
fn magrittr_dot_explicit_arg_not_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("test.R"),
        "library(magrittr)\ndf <- data.frame(x = 1:10)\nresult <- df %>% nrow(.)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Undefined variable: ."),
        "dot pronoun as explicit pipe argument must not be flagged. Output:\n{output}"
    );
}

/// Bare `.` outside a pipe context IS still flagged.
#[test]
fn dot_without_pipe_still_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("test.R"), "x <- .$field\n").unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("Undefined variable: ."),
        "dot without pipe context must still be flagged. Output:\n{output}"
    );
}

/// Genuine undefined variables are still flagged even when parent loads dplyr.
#[test]
fn cross_file_genuine_undefined_still_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("main.R"),
        "library(dplyr)\nsource(\"child.R\")\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("child.R"),
        "result <- totally_undefined_thing\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("Undefined variable: totally_undefined_thing"),
        "genuine undefined must still be flagged. Output:\n{output}"
    );
}
