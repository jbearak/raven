//! End-to-end checks that `base::source()` and `base::sys.source()` work like
//! the bare calls: the sourced file's definitions reach the caller, and a
//! missing target gets the same diagnostic. Another package's `source()` isn't
//! a source call. Every fixture is synthetic and runs through
//! `raven check --format json`.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `(code, 0-based line, character, message)` for every diagnostic in
/// `main.R` whose code is `unresolved-source-path`, or that says one of
/// `probes` is not defined. Filtering keeps the result independent of whether
/// R is installed to resolve base functions.
fn diagnostics(root: &Path, probes: &[&str]) -> Vec<(String, u64, u64, String)> {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["check", "--workspace"])
        .arg(root)
        .args(["--format", "json", "--max-severity", "off", "--no-color"])
        .output()
        .unwrap();
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "raven check did not complete cleanly.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    let mut found: Vec<_> = rows
        .into_iter()
        .filter(|row| row["path"] == "main.R")
        .filter_map(|row| {
            let diagnostic = &row["diagnostic"];
            let code = diagnostic["code"].as_str().unwrap_or_default();
            let message = diagnostic["message"].as_str().unwrap();
            let keep = match code {
                "unresolved-source-path" => true,
                "undefined-variable" => probes
                    .iter()
                    .any(|probe| message == format!("{probe} is not defined")),
                _ => false,
            };
            keep.then(|| {
                let start = &diagnostic["range"]["start"];
                (
                    code.to_owned(),
                    start["line"].as_u64().unwrap(),
                    start["character"].as_u64().unwrap(),
                    message.to_owned(),
                )
            })
        })
        .collect();
    found.sort();
    found
}

/// Definitions from `base::source()`d and `base::sys.source(envir =
/// globalenv())`d files are in scope; `otherpkg::source()` lends nothing.
#[test]
fn base_qualified_sources_lend_definitions() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        "base::source(\"b.R\")\n\
         base:::source(\"c.R\")\n\
         base::sys.source(\"d.R\", envir = globalenv())\n\
         otherpkg::source(\"e.R\")\n\
         print(bb)\nprint(cc)\nprint(dd)\nprint(ee)\n",
    );
    for name in ["b", "c", "d", "e"] {
        write(
            dir.path(),
            &format!("{name}.R"),
            &format!("{name}{name} <- 1\n"),
        );
    }
    assert_eq!(
        diagnostics(dir.path(), &["bb", "cc", "dd", "ee"]),
        vec![(
            "undefined-variable".to_owned(),
            7,
            6,
            "ee is not defined".to_owned()
        )]
    );
}

/// A missing `base::source()` target gets the bare call's diagnostic, at the
/// same place relative to the call.
#[test]
fn missing_base_qualified_target_is_reported_like_the_bare_call() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        "source(\"missing.R\")\n\
         base::source(\"missing.R\")\n\
         y <- base::sys.source(\"missing.R\", envir = globalenv())\n",
    );
    let found = diagnostics(dir.path(), &[]);
    let bare = &found[0];
    assert_eq!(bare.0, "unresolved-source-path", "{found:?}");
    let expected: Vec<_> = [(0, 0), (1, 0), (2, 5)]
        .into_iter()
        .map(|(line, character)| (bare.0.clone(), line, character, bare.3.clone()))
        .collect();
    assert_eq!(found, expected);
}
