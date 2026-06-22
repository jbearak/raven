use std::process::Command;

fn run_raven(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(args)
        .output()
        .expect("run raven")
}

#[test]
fn no_args_describes_raven_as_static_analyzer_and_language_server() {
    let output = run_raven(&[]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    let first_line = stdout.lines().next().unwrap_or_default();

    assert_eq!(
        first_line,
        format!(
            "raven {}, a static analyzer and language server for R.",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn top_level_help_points_to_command_help_and_docs() {
    let output = run_raven(&["--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("Run `raven <command> --help` for command-specific help."));
    assert!(stdout.contains("Docs: https://github.com/jbearak/raven"));
}

#[test]
fn help_alias_prints_top_level_help() {
    let output = run_raven(&["help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("Usage: raven [OPTIONS]"));
    assert!(stdout.contains("Docs: https://github.com/jbearak/raven"));
}

#[test]
fn packages_group_help_is_available() {
    let output = run_raven(&["packages", "--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("raven packages — package-database commands"));
    assert!(stdout.contains("Usage:"));
}

#[test]
fn packages_fetch_help_is_command_specific() {
    let output = run_raven(&["packages", "fetch", "--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("raven packages fetch — fetch package exports from r-universe"));
    assert!(stdout.contains("--missing-only"));
    assert!(stdout.contains("--fail-on-missing"));
}

#[test]
fn top_level_fetch_alias_help_is_command_specific() {
    let output = run_raven(&["fetch", "--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("raven packages fetch — fetch package exports from r-universe"));
}

#[test]
fn packages_freeze_help_is_command_specific() {
    let output = run_raven(&["packages", "freeze", "--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("raven packages freeze — capture installed package exports"));
    assert!(stdout.contains("--used"));
    assert!(stdout.contains("--installed"));
}

#[test]
fn packages_update_help_is_command_specific() {
    let output = run_raven(&["packages", "update", "--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("raven packages update — download Raven's package symbol database"));
    assert!(stdout.contains("--dest-dir"));
}

#[test]
fn analysis_stats_help_is_available() {
    let output = run_raven(&["analysis-stats", "--help"]);

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout is valid UTF-8");
    assert!(stdout.contains("raven analysis-stats"));
    assert!(stdout.contains("Usage: raven analysis-stats <path>"));
}
