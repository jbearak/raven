use std::process::Command;

#[test]
fn no_args_describes_raven_as_static_analyzer_and_language_server() {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .output()
        .expect("run raven with no arguments");

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
