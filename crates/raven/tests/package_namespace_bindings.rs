//! Package-runtime bindings must resolve without leaking into ordinary scripts.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn diagnostics(root: &Path) -> Vec<(String, String)> {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["check", "--workspace"])
        .arg(root)
        .args(["--format", "json", "--max-severity", "error"])
        .env_remove("R_BOX_PATH")
        .output()
        .unwrap();
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "scanner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    rows.into_iter()
        .filter(|row| row["diagnostic"]["code"] == "undefined-variable")
        .map(|row| {
            (
                row["path"].as_str().unwrap().replace('\\', "/"),
                row["diagnostic"]["message"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn box_namespace_bindings_resolve_without_namespace_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "DESCRIPTION",
        "Package: namespaceprobe\nVersion: 0.0.1\n",
    );
    write(
        root,
        "R/hooks.R",
        ".onLoad = function(libname, pkgname) {\n  ns = base::topenv()\n  ns$system_mod_path = system.file('mod', package = pkgname)\n}\n",
    );
    write(
        root,
        "R/paths.R",
        "paths <- function() {\n  .packageName\n  system_mod_path\n  missing_namespace_probe\n}\n",
    );
    assert_eq!(
        diagnostics(root),
        vec![(
            "R/paths.R".into(),
            "missing_namespace_probe is not defined".into()
        )]
    );

    // A removed hook assignment must not survive in the package contribution.
    write(
        root,
        "R/hooks.R",
        ".onLoad <- function(libname, pkgname) NULL\n",
    );
    let rows = diagnostics(root);
    assert!(rows.contains(&("R/paths.R".into(), "system_mod_path is not defined".into())));
    assert!(
        !rows
            .iter()
            .any(|(_, message)| message.starts_with(".packageName "))
    );
}

#[test]
fn package_name_is_namespace_local_and_tracks_package_mode() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "DESCRIPTION",
        "Package: namespaceprobe\nVersion: 0.0.1\nSuggests: testthat\n",
    );
    let paths = [
        "R/main.R",
        "R/unix/main.R",
        "tests/testthat/test-main.R",
        "scripts/main.R",
        "vignettes/main.R",
        "tests/plain.R",
        "inst/tinytest/test-main.R",
        "R/scripts/main.R",
    ];
    for path in paths {
        write(root, path, "probe <- function() .packageName\n");
    }
    let expected: Vec<_> = paths[3..]
        .iter()
        .map(|p| ((*p).to_owned(), ".packageName is not defined".to_owned()))
        .collect();
    let rows = diagnostics(root);
    assert_eq!(rows.len(), expected.len(), "{rows:?}");
    for row in expected {
        assert!(rows.contains(&row), "missing {row:?}: {rows:?}");
    }
    write(root, "raven.toml", "[packages]\npackageMode = 'disabled'\n");
    assert_eq!(diagnostics(root).len(), paths.len());
}

#[test]
fn load_all_does_not_export_package_name() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "DESCRIPTION",
        "Package: namespaceprobe\nVersion: 0.0.1\n",
    );
    write(root, "R/main.R", "probe <- function() .packageName\n");
    write(
        root,
        "scripts/main.R",
        "pkgload::load_all()\nprobe()\n.packageName\n",
    );
    assert_eq!(
        diagnostics(root),
        vec![(
            "scripts/main.R".into(),
            ".packageName is not defined".into()
        )]
    );
}
