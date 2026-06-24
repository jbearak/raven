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
    // `raven check` exit codes: 0 = no diagnostic exceeded `--max-severity`,
    // 1 = a diagnostic exceeded it (these tests run with `--max-severity off`,
    // so *any* emitted diagnostic yields exit 1 — that is the normal, healthy
    // outcome for the positive-assertion tests here), 2 = operator error
    // (bad path / unreadable workspace). A code outside {0, 1} — or no exit
    // code at all (killed by a signal / crash) — means the binary did not run
    // the analysis to completion. Without this guard, negative
    // `!output.contains(...)` checks would pass vacuously on a crashed binary.
    let code = output.status.code();
    assert!(
        matches!(code, Some(0) | Some(1)),
        "raven check did not complete cleanly (exit {code:?}); \
         expected 0 (clean) or 1 (diagnostic exceeded threshold).\n\
         stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
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
        !output.contains("x is not defined"),
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
        !output.contains("x is not defined"),
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
        !output.contains("x is not defined"),
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
        !output.contains(". is not defined"),
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
        !output.contains(". is not defined"),
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
        output.contains(". is not defined"),
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
        output.contains("totally_undefined_thing is not defined"),
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
        !output.contains("_ is not defined"),
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
        output.contains("_ is not defined"),
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
            !output.contains(&format!("{name} is not defined")),
            "{name} is a base operator and should not be flagged. Output:\n{output}"
        );
    }
}

/// Package tests under `tests/testit/` must see package-internal symbols,
/// namespace imports, and package exports — same as `tests/testthat/`.
/// Regression test for: DT package had 182 false positives because Raven
/// did not classify `tests/testit/**/*.R` as package test scope.
#[test]
fn testit_test_files_see_package_namespace() {
    let dir = TempDir::new().unwrap();
    let pkg = dir.path();
    // Minimal DESCRIPTION
    std::fs::write(
        pkg.join("DESCRIPTION"),
        "Package: mypkg\nVersion: 0.1.0\nTitle: Test\n",
    )
    .unwrap();
    // NAMESPACE with an export and an import
    std::fs::write(
        pkg.join("NAMESPACE"),
        "export(my_fun)\nimportFrom(utils,head)\n",
    )
    .unwrap();
    // R/ source
    std::fs::create_dir_all(pkg.join("R")).unwrap();
    std::fs::write(
        pkg.join("R").join("fun.R"),
        "my_fun <- function(x) x + 1\ninternal_helper <- function(y) y * 2\n",
    )
    .unwrap();
    // tests/testit/ test file that uses package internals and imports
    std::fs::create_dir_all(pkg.join("tests").join("testit")).unwrap();
    std::fs::write(
        pkg.join("tests").join("testit").join("test-fun.R"),
        "a <- my_fun(1)\nb <- internal_helper(2)\nc <- head(1:10)\n",
    )
    .unwrap();

    let output = run_check(pkg);
    assert!(
        !output.contains("my_fun is not defined"),
        "testit test file should see exported my_fun. Output:\n{output}"
    );
    assert!(
        !output.contains("internal_helper is not defined"),
        "testit test file should see package-internal internal_helper. Output:\n{output}"
    );
    assert!(
        !output.contains("head is not defined"),
        "testit test file should see imported head. Output:\n{output}"
    );
}

/// Diamond topology: `main_a.R` sources `helper.R`; `main_c.R` ALSO sources
/// `helper.R` and does `library(dplyr)`. `main_a.R` itself has no library()
/// call anywhere in its ancestor chain or its forward-sourced descendants, and
/// uses `df |> filter(undefined_col > 1)`.
///
/// `main_c.R` is an "uncle" of `main_a.R` (reachable only by going DOWN from A
/// to the shared `helper.R` and then back UP to C). A correct in-play walk runs
/// two separate directional passes — ancestors-only and descendants-only — and
/// must NOT cross from a shared child back up to that child's OTHER parents.
/// So C's `library(dplyr)` must NOT suppress the genuine undefined-variable
/// diagnostic for `undefined_col` in `main_a.R`.
///
/// Regression test for: `collect_in_play_packages` rewritten as a single
/// undirected BFS that pushed both dependents and dependencies onto one shared
/// queue, letting a sibling's `library()` contaminate an unrelated file's
/// in-play set (topology-dependent false negative).
#[test]
fn diamond_sibling_library_does_not_suppress_undefined_in_other_branch() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("main_a.R"),
        "source(\"helper.R\")\n\
         df <- data.frame(x = 1:10)\n\
         result <- df |> filter(undefined_col > 1)\n",
    )
    .unwrap();
    // helper.R is the shared child; it loads nothing.
    std::fs::write(
        dir.path().join("helper.R"),
        "shared_helper <- function() 1\n",
    )
    .unwrap();
    // main_c.R is the sibling/uncle: sources the same helper and loads dplyr.
    std::fs::write(
        dir.path().join("main_c.R"),
        "library(dplyr)\nsource(\"helper.R\")\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("undefined_col is not defined"),
        "A sibling file's library(dplyr) (reached via the shared helper.R) \
         must NOT suppress the genuine undefined-variable diagnostic for \
         undefined_col in main_a.R. Output:\n{output}"
    );
}

/// Positive control for the directional fix: a genuine two-level ancestor
/// chain. `grandparent.R` does `library(dplyr)` and sources `parent.R`, which
/// sources `leaf.R`. `leaf.R` uses `filter(col > 1)`. dplyr must propagate
/// transitively up the ancestor chain (grandparent -> parent -> leaf), so `col`
/// is NOT flagged. This proves the ancestors-only pass still walks
/// transitively after the fix.
#[test]
fn transitive_ancestor_chain_library_propagates_nse() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join("grandparent.R"),
        "library(dplyr)\nsource(\"parent.R\")\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("parent.R"), "source(\"leaf.R\")\n").unwrap();
    std::fs::write(
        dir.path().join("leaf.R"),
        "df <- data.frame(x = 1:10)\nresult <- df |> filter(x > 5)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("x is not defined"),
        "library(dplyr) on the grandparent must propagate transitively down \
         the ancestor chain to leaf.R's filter(). Output:\n{output}"
    );
}

// ---- P8: Rmd diamond sibling-library contamination test ----
//
// Mirrors `diamond_sibling_library_does_not_suppress_undefined_in_other_branch`
// on the Rmd surface: the entry point is an Rmd chunk rather than a plain .R
// file.
//
// Topology:
//   main.Rmd (chunk sources helper.R)
//   other.R  (library(dplyr) + sources helper.R) — the "sibling/uncle"
//   helper.R (shared child, no library calls)
//
// The Rmd chunk uses `df |> filter(undefined_col > 1)`. Because dplyr is only
// loaded in other.R (reachable only via the shared child, not from the Rmd's
// own ancestor chain), it must NOT suppress the undefined-variable for
// `undefined_col` in the Rmd chunk.

/// Rmd variant: sibling's library(dplyr) (via the shared helper.R) must NOT
/// suppress the genuine undefined-variable diagnostic in the Rmd chunk.
#[test]
fn rmd_diamond_sibling_library_does_not_suppress_undefined_in_chunk() {
    let dir = TempDir::new().unwrap();

    // main.Rmd: entry point. Chunk sources helper.R and uses dplyr-style NSE.
    std::fs::write(
        dir.path().join("main.Rmd"),
        "---\ntitle: T\n---\n\n```{r}\nsource(\"helper.R\")\ndf <- data.frame(x = 1:10)\nresult <- df |> filter(undefined_col > 1)\n```\n",
    )
    .unwrap();

    // helper.R: shared child, no library() call.
    std::fs::write(
        dir.path().join("helper.R"),
        "shared_helper <- function() 1\n",
    )
    .unwrap();

    // other.R: sibling/uncle — sources the same helper and loads dplyr.
    std::fs::write(
        dir.path().join("other.R"),
        "library(dplyr)\nsource(\"helper.R\")\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("undefined_col is not defined"),
        "The sibling other.R's library(dplyr) (reached via the shared helper.R) \
         must NOT suppress the genuine undefined-variable diagnostic for \
         undefined_col in the Rmd chunk. Output:\n{output}"
    );
}

/// Positive control for the Rmd diamond fix: when the Rmd chunk's own ancestry
/// includes library(dplyr) (loader.Rmd sources the Rmd, or the Rmd itself
/// calls library(dplyr) in an earlier chunk), NSE is suppressed.
///
/// Simple form: the Rmd chunk itself calls library(dplyr) then filter().
#[test]
fn rmd_own_library_in_chunk_suppresses_filter_nse() {
    let dir = TempDir::new().unwrap();

    std::fs::write(
        dir.path().join("main.Rmd"),
        "---\ntitle: T\n---\n\n```{r}\nlibrary(dplyr)\ndf <- data.frame(x = 1:10)\nresult <- df |> filter(x > 5)\n```\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("x is not defined"),
        "library(dplyr) in the Rmd chunk itself must suppress filter() NSE for x. \
         Output:\n{output}"
    );
}
