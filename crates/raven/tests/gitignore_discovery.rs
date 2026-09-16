use std::path::Path;
use std::process::{Command, Output};

fn write(root: &Path, name: &str, contents: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_raven"))
        .current_dir(root)
        .args(args)
        .output()
        .unwrap()
}

fn output_text(output: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn check_ignores_discovery_but_follows_explicit_sources_and_reports_named_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".gitignore", "ignored/\n");
    write(root, "raven.toml", "[packages]\nenabled = false\n");
    write(root, "main.R", "source('ignored/helper.R')\nhelper_fn()\n");
    write(
        root,
        "ignored/helper.R",
        "helper_fn <- function() 1\nmissing_gitignore_test_function()\n",
    );
    for extra in [vec![], vec!["."], vec!["--no-config"], vec!["main.R"]] {
        let mut args = vec!["check", "--no-color"];
        args.extend(extra);
        let output = run(root, &args);
        assert_eq!(output.status.code(), Some(0), "{}", output_text(&output));
    }
    let explicit = run(root, &["check", "--no-color", "ignored/helper.R"]);
    assert_eq!(
        explicit.status.code(),
        Some(1),
        "{}",
        output_text(&explicit)
    );
    assert!(output_text(&explicit).contains("missing_gitignore_test_function"));
    write(
        root,
        "raven.toml",
        "[packages]\nenabled = false\n[workspace]\nrespectGitignore = false\n",
    );
    let disabled = run(root, &["check", "--no-color"]);
    assert_eq!(
        disabled.status.code(),
        Some(1),
        "{}",
        output_text(&disabled)
    );
    assert!(output_text(&disabled).contains("missing_gitignore_test_function"));
}

#[test]
fn lint_directory_dotdot_and_explicit_file_have_consistent_discovery_policy() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir(root.join("child")).unwrap();
    write(root, ".gitignore", "/ignored.R\n");
    write(root, "ignored.R", "x <- 1   \n");
    for directory in [".", "child/.."] {
        let output = run(
            root,
            &[
                "lint",
                "--no-config",
                "--no-color",
                "--max-severity",
                "hint",
                directory,
            ],
        );
        assert_eq!(output.status.code(), Some(0), "{}", output_text(&output));
    }
    let explicit = run(
        root,
        &[
            "lint",
            "--no-config",
            "--no-color",
            "--max-severity",
            "hint",
            "ignored.R",
        ],
    );
    assert_eq!(
        explicit.status.code(),
        Some(1),
        "{}",
        output_text(&explicit)
    );
}

#[test]
fn explicit_external_directories_use_their_own_gitignore_context() {
    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    write(
        workspace.path(),
        "raven.toml",
        "[packages]\nenabled = false\n",
    );
    write(external.path(), ".gitignore", "ignored.R\n");
    write(external.path(), "ignored.R", "missing_external_test()   \n");
    let directory = external.path().to_str().unwrap();
    for command in ["check", "lint"] {
        let result = run(
            workspace.path(),
            &[command, "--no-color", "--max-severity", "hint", directory],
        );
        assert_eq!(result.status.code(), Some(0), "{}", output_text(&result));
    }
}

#[cfg(unix)]
#[test]
fn lint_unreadable_directory_is_an_operator_error() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let locked = root.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = std::fs::read_dir(&locked).is_err();
    let output = run(root, &["lint", "--no-config", "--no-color", "locked"]);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
    if unreadable {
        // Root can still read mode 000 on some CI environments.
        assert_eq!(output.status.code(), Some(2), "{}", output_text(&output));
    }
}
