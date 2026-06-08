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

/// Forward-source pattern: file sources a loader that has library(dplyr),
/// then uses dplyr verbs. The library() in the sourced file must propagate
/// NSE suppression back to the calling file.
#[test]
fn forward_source_library_propagates_nse() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("main.R"),
        "source(\"loader.R\")\ndf <- data.frame(x = 1:10)\nresult <- df |> filter(x > 5)\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("loader.R"), "library(dplyr)\n").unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Undefined variable: x"),
        "source(\"loader.R\") with library(dplyr) must propagate NSE. Output:\n{output}"
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

/// Native pipe placeholder `_` in `df |> lm(data = _)` must not be flagged.
#[test]
fn native_pipe_placeholder_not_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("test.R"),
        "df <- data.frame(x = 1:10, y = 11:20)\nresult <- df |> lm(y ~ x, data = _)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Undefined variable: _"),
        "_ placeholder in native pipe must not be flagged. Output:\n{output}"
    );
}

/// Bare `_` outside a pipe IS still flagged.
#[test]
fn underscore_without_pipe_still_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("test.R"), "x <- _\n").unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("Undefined variable: _"),
        "bare _ without pipe context must still be flagged. Output:\n{output}"
    );
}

/// Backtick-quoted base operators can be used as first-class function values
/// (e.g. `Reduce(`|`, xs)` or `switch(..., AND = `&`)`). They are base
/// builtins, not undefined variables.
#[test]
fn backtick_quoted_base_operators_as_values_not_flagged() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("test.R"),
        "a <- Reduce(`|`, list(TRUE, FALSE))\n\
         b <- switch(\"AND\", AND = `&`, OR = `|`)\n\
         c <- (if (TRUE) identity else `-`)(1)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    for name in ["`|`", "`&`", "`-`"] {
        assert!(
            !output.contains(&format!("Undefined variable: {name}")),
            "{name} is a base operator and should not be flagged. Output:\n{output}"
        );
    }
}
