//! Integration tests for `source(system.file(...))` resolution.
//!
//! Tests that:
//! 1. `source(system.file("helper.R", package = <self>))` resolves the helper's
//!    top-level definitions into the sourcing file's scope (no undefined-variable
//!    false positives, no "Cannot resolve path" diagnostic).
//! 2. An unresolved cross-package `system.file()` produces ZERO diagnostics
//!    (graceful degradation — silent skip, not a spurious error).
//!
//! Run with: `cargo test --release -p raven --test system_file_source`

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

/// source(system.file("helper.R", package = <self>)) resolves the helper's
/// definitions into scope — no undefined-variable FP, no path diagnostic.
#[test]
fn system_file_self_package_resolves_helper_into_scope() {
    let dir = TempDir::new().unwrap();

    // DESCRIPTION makes this a package workspace
    std::fs::write(
        dir.path().join("DESCRIPTION"),
        "Package: testpkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // inst/helper.R defines a function
    std::fs::create_dir_all(dir.path().join("inst")).unwrap();
    std::fs::write(
        dir.path().join("inst").join("helper.R"),
        "my_helper <- function(x) x + 1\n",
    )
    .unwrap();

    // R/main.R sources via system.file and uses the helper
    std::fs::create_dir_all(dir.path().join("R")).unwrap();
    std::fs::write(
        dir.path().join("R").join("main.R"),
        "source(system.file(\"helper.R\", package = \"testpkg\"))\nresult <- my_helper(42)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "system.file(\"helper.R\", package = \"testpkg\") should resolve \
         to inst/helper.R. Output:\n{output}"
    );
    assert!(
        !output.contains("Undefined variable: my_helper")
            && !output.contains("Undefined function: my_helper"),
        "my_helper should be in scope via source(system.file(...)). Output:\n{output}"
    );
}

/// source(system.file("helper.R", package = "otherpkg")) resolves the helper's
/// definitions into scope when otherpkg is present at a configured lib_path —
/// no undefined-variable FP, no path diagnostic.
#[test]
fn system_file_cross_package_installed_resolves_helper_into_scope() {
    let workspace = TempDir::new().unwrap();
    let libdir = TempDir::new().unwrap();

    // Create installed "otherpkg" with helper.R at libdir/otherpkg/helper.R
    // (installed layout: NO inst/ prefix)
    let pkg_dir = libdir.path().join("otherpkg");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("helper.R"),
        "cross_pkg_fn <- function(x) x * 2\n",
    )
    .unwrap();

    // Workspace DESCRIPTION
    std::fs::write(
        workspace.path().join("DESCRIPTION"),
        "Package: mypkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // raven.toml with additionalLibraryPaths
    std::fs::write(
        workspace.path().join("raven.toml"),
        format!(
            "[packages]\nadditionalLibraryPaths = [\"{}\"]\n",
            libdir.path().display()
        ),
    )
    .unwrap();

    // R/main.R sources from otherpkg and uses the symbol
    std::fs::create_dir_all(workspace.path().join("R")).unwrap();
    std::fs::write(
        workspace.path().join("R").join("main.R"),
        "source(system.file(\"helper.R\", package = \"otherpkg\"))\nresult <- cross_pkg_fn(42)\n",
    )
    .unwrap();

    let output = run_check(workspace.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "system.file(\"helper.R\", package = \"otherpkg\") should resolve \
         via additionalLibraryPaths. Output:\n{output}"
    );
    assert!(
        !output.contains("Undefined variable: cross_pkg_fn")
            && !output.contains("Undefined function: cross_pkg_fn"),
        "cross_pkg_fn should be in scope via cross-package system.file(). Output:\n{output}"
    );
}

/// An unresolved cross-package system.file() produces ZERO diagnostics —
/// graceful degradation matching pre-feature behavior (silent skip).
#[test]
fn system_file_cross_package_unresolved_produces_no_diagnostics() {
    let dir = TempDir::new().unwrap();

    // DESCRIPTION for self package
    std::fs::write(
        dir.path().join("DESCRIPTION"),
        "Package: mypkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // R/main.R sources from a different (not-installed) package
    std::fs::create_dir_all(dir.path().join("R")).unwrap();
    std::fs::write(
        dir.path().join("R").join("main.R"),
        "source(system.file(\"scripts/setup.R\", package = \"otherpkg\"))\nx <- 1\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "Unresolved cross-package system.file() must not produce path diagnostics. \
         Output:\n{output}"
    );
    assert!(
        !output.contains("system.file") && !output.contains("otherpkg"),
        "No diagnostic should mention system.file or the unresolved package. \
         Output:\n{output}"
    );
}
