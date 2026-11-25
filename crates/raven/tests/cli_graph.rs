//! End-to-end checks of `raven graph` through the real binary: how it ends
//! when stdout can't take the output.

use std::path::Path;
use std::process::{Command, Stdio};

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// A workspace whose graph prints far more than a pipe buffer holds, with no
/// R subprocess.
fn large_graph_workspace() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "raven.toml", "[packages]\nenabled = false\n");
    let main: String = (0..2000).map(|i| format!("source(\"f{i}.R\")\n")).collect();
    write(tmp.path(), "main.R", &main);
    tmp
}

fn graph(ws: &Path, format: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_raven"));
    command.args([
        "graph",
        "--workspace",
        ws.to_str().unwrap(),
        "--format",
        format,
    ]);
    command
}

/// A reader that stops early (`raven graph | head`) ends the output, not the
/// run: no panic, exit 0.
#[test]
fn closed_pipe_ends_the_output_and_exits_0() {
    let ws = large_graph_workspace();
    for format in ["json", "text"] {
        let mut child = graph(ws.path(), format)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Close the read end before the graph is printed.
        drop(child.stdout.take());
        let output = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(0), "{format}: {stderr}");
        assert!(!stderr.contains("panicked"), "{format}: {stderr}");
    }
}

/// A stdout that can't be written at all (a descriptor open for reading only)
/// loses the graph: an operator error, not a silent exit 0.
#[cfg(unix)]
#[test]
fn read_only_stdout_is_an_operator_error() {
    let ws = large_graph_workspace();
    for format in ["json", "text"] {
        let output = graph(ws.path(), format)
            .stdout(std::fs::File::open("/dev/null").unwrap())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(2), "{format}: {stderr}");
        assert!(
            stderr.contains("raven graph: cannot write output"),
            "{format}: {stderr}"
        );
    }
}
