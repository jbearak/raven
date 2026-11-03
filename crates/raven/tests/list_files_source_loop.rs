//! End-to-end regressions for bounded `list.files()` source loops.
//!
//! Every fixture is synthetic and self-contained. The tests pin both ordered
//! shared scope between members and post-loop visibility in the driver.

use std::process::Command;

fn raven_binary() -> std::path::PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop();
    path.pop();
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
    assert!(
        matches!(output.status.code(), Some(0) | Some(1)),
        "raven check failed unexpectedly:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn write_fixture(root: &std::path::Path, driver_prefix: &str) {
    std::fs::create_dir(root.join("functions")).unwrap();
    std::fs::write(root.join("functions/01_helpers.R"), "shared_value <- 41\n").unwrap();
    std::fs::write(
        root.join("functions/02_consumer.R"),
        "derived_value <- shared_value + 1\n",
    )
    .unwrap();
    std::fs::write(
        root.join("main.R"),
        format!(
            "{driver_prefix}files <- list.files(\"functions\", pattern = \"\\\\.R$\", \
             full.names = TRUE)\n\
             for (file in files) source(file)\n\
             result <- derived_value\n"
        ),
    )
    .unwrap();
}

#[test]
fn ordered_members_share_scope_and_lend_it_after_the_loop() {
    let dir = tempfile::tempdir().unwrap();
    write_fixture(dir.path(), "");

    let output = run_check(dir.path());
    assert!(
        !output.contains("shared_value is not defined")
            && !output.contains("derived_value is not defined"),
        "ordered members and the driver must share source scope:\n{output}"
    );
}

#[test]
fn batch_scope_starts_at_the_source_loop_not_before_it() {
    let dir = tempfile::tempdir().unwrap();
    write_fixture(dir.path(), "before <- derived_value\n");

    let output = run_check(dir.path());
    assert_eq!(
        output.matches("derived_value is not defined").count(),
        1,
        "only the pre-loop use should remain undefined:\n{output}"
    );
}

/// The exact `tests/testthat/setup.R` a non-package project (DESCRIPTION has
/// `Type: project` and no `Package:` field) uses to load its functions.
const PROJECT_SETUP_LOOP: &str = "\
for (file in list.files(file.path(\"..\", \"..\", \"R\"), pattern = \"[.]R$\", full.names = TRUE)) {
  source(file)
}
";

fn write_project_fixture(root: &std::path::Path, setup: &str) {
    std::fs::write(
        root.join("DESCRIPTION"),
        "Type: project\nTitle: Analysis project\nSuggests: testthat\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("R")).unwrap();
    std::fs::create_dir_all(root.join("tests/testthat")).unwrap();
    std::fs::write(
        root.join("R/rates.R"),
        "compute_rate <- function(births, women) births / women\n",
    )
    .unwrap();
    std::fs::write(root.join("tests/testthat/setup.R"), setup).unwrap();
    std::fs::write(
        root.join("tests/testthat/test-rates.R"),
        "library(testthat)\n\
         rate <- compute_rate(10, 100)\n\
         test_that(\"rates divide\", {\n\
         \x20 expect_equal(compute_rate(10, 100), 0.1)\n\
         })\n",
    )
    .unwrap();
}

#[test]
fn project_setup_loop_lends_r_functions_to_test_files() {
    let dir = tempfile::tempdir().unwrap();
    write_project_fixture(dir.path(), PROJECT_SETUP_LOOP);

    let output = run_check(dir.path());
    assert!(
        !output.contains("compute_rate is not defined"),
        "setup.R's list.files() loop must make R/ functions visible to tests:\n{output}"
    );
}

#[test]
fn project_setup_loop_keeps_undefined_names_and_lowercase_files_out() {
    let dir = tempfile::tempdir().unwrap();
    write_project_fixture(dir.path(), PROJECT_SETUP_LOOP);
    std::fs::write(
        dir.path().join("R/lower.r"),
        "lowercase_only <- function() 1\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("tests/testthat/test-other.R"),
        "lowercase_only()\nnever_defined()\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        output.contains("lowercase_only is not defined"),
        "`[.]R$` must not select lowercase .r files:\n{output}"
    );
    assert!(
        output.contains("never_defined is not defined"),
        "names the loop does not define stay undefined:\n{output}"
    );
    assert!(!output.contains("compute_rate is not defined"), "{output}");
}

#[test]
fn either_case_pattern_also_sources_lowercase_r_files() {
    let dir = tempfile::tempdir().unwrap();
    write_project_fixture(
        dir.path(),
        "for (file in list.files(file.path(\"..\", \"..\", \"R\"), pattern = \"\\\\.[Rr]$\", full.names = TRUE)) {\n  source(file)\n}\n",
    );
    std::fs::write(
        dir.path().join("R/lower.r"),
        "lowercase_only <- function() 1\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("tests/testthat/test-other.R"),
        "lowercase_only()\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("lowercase_only is not defined")
            && !output.contains("compute_rate is not defined"),
        "`\\\\.[Rr]$` selects both .R and .r files:\n{output}"
    );
}

#[test]
fn project_setup_loop_fails_closed_on_a_dynamic_directory() {
    let dir = tempfile::tempdir().unwrap();
    write_project_fixture(
        dir.path(),
        "for (file in list.files(file.path(getwd(), \"R\"), pattern = \"[.]R$\", full.names = TRUE)) {\n  source(file)\n}\n",
    );

    let output = run_check(dir.path());
    assert!(
        output.contains("compute_rate is not defined"),
        "a directory Raven cannot fold must contribute nothing:\n{output}"
    );
}
