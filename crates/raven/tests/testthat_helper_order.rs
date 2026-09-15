//! Exercise testthat helper visibility through the production CLI in both
//! workspace-wide and explicit-directory report modes.

use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn workspace(earlier: &str, later: &str, test: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("tests/testthat")).unwrap();
    std::fs::write(
        dir.path().join("DESCRIPTION"),
        "Package: repro\nVersion: 0.0.1\n",
    )
    .unwrap();
    // Whole-workspace mode reports an additional file, exercising a different
    // target set while both modes must retain the same helper diagnostics.
    std::fs::create_dir(dir.path().join("vendor")).unwrap();
    std::fs::write(dir.path().join("vendor/unrelated.R"), "unrelated <- 1\n").unwrap();
    for (name, text) in [
        ("helper-aaa.R", earlier),
        ("helper-zzz.R", later),
        ("test-helpers.R", test),
    ] {
        std::fs::write(dir.path().join("tests/testthat").join(name), text).unwrap();
    }
    dir
}

fn check_both_modes(root: &Path, expected: &[&str]) {
    let mut outputs = Vec::new();
    for explicit in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_raven"));
        command
            .current_dir(root)
            .args(["check", "--no-config", "--no-color"]);
        if explicit {
            command.arg("tests/testthat");
        }
        let output = command.output().expect("run raven check");
        let stdout = String::from_utf8(output.stdout).unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(
            output.status.code(),
            Some(i32::from(!expected.is_empty())),
            "explicit={explicit}, stdout:\n{stdout}\nstderr:\n{stderr}"
        );
        let findings: Vec<_> = stdout
            .lines()
            .filter(|line| line.contains("[undefined-variable]"))
            .collect();
        assert_eq!(findings.len(), expected.len(), "{stdout}");
        for name in expected {
            assert!(
                findings.iter().any(|line| line.contains(name)),
                "missing diagnostic for {name}:\n{stdout}"
            );
        }
        outputs.push(stdout);
    }
    assert_eq!(outputs[0], outputs[1], "report modes must agree");
}

#[test]
fn earlier_helper_closure_sees_later_helper() {
    let dir = workspace(
        "uses_later <- function() later_helper(\"x\")\n",
        "later_helper <- function(name) name\n",
        "",
    );
    check_both_modes(dir.path(), &[]);
}

#[test]
fn helper_closure_still_warns_for_genuinely_missing_names() {
    let dir = workspace(
        "uses_later <- function() { later_helper; genuinely_missing }\n",
        "later_helper <- function(name) name\n",
        "",
    );
    check_both_modes(dir.path(), &["genuinely_missing is not defined"]);
}

#[test]
fn later_helper_closure_sees_earlier_helper() {
    let dir = workspace(
        "uses_later <- function() 1\n",
        "uses_earlier <- function() uses_later()\n",
        "",
    );
    check_both_modes(dir.path(), &[]);
}

#[test]
fn earlier_helper_top_level_still_warns_for_later_helper() {
    let dir = workspace(
        "x <- later_helper(\"x\")\n",
        "later_helper <- function(name) name\n",
        "",
    );
    check_both_modes(dir.path(), &["later_helper is not defined"]);
}

#[test]
fn test_file_sees_all_helpers() {
    let dir = workspace(
        "earlier_helper <- function() 1\n",
        "later_helper <- function() 2\n",
        "x <- earlier_helper()\ny <- later_helper()\n",
    );
    check_both_modes(dir.path(), &[]);
}
