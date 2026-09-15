//! Package helper facts must survive full-document cache eviction in CLI checks.

use std::process::Command;
use tempfile::TempDir;

#[test]
fn helper_scope_survives_workspace_cache_pressure_in_both_report_modes() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path();
    std::fs::create_dir_all(root.join("tests/testthat")).unwrap();
    std::fs::create_dir(root.join("vendor")).unwrap();
    std::fs::write(root.join("DESCRIPTION"), "Package: repro\nVersion: 0.0.1\n").unwrap();
    std::fs::write(
        root.join("tests/testthat/helper-aaa.R"),
        "a_helper <- function() 1\n",
    )
    .unwrap();
    std::fs::write(root.join("tests/testthat/test-a.R"), "a_helper()\n").unwrap();

    // With the two testthat files, 999 later-sorted files exceed the 1,000
    // full-document cache slots and evict the helper before package seeding.
    for index in 0..999 {
        std::fs::write(root.join(format!("vendor/{index:04}.R")), "").unwrap();
    }

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
            Some(0),
            "explicit={explicit}, stdout:\n{stdout}\nstderr:\n{stderr}"
        );
        assert!(stdout.starts_with("0 issues"), "{stdout}");
    }
}
