//! End-to-end checks that `source(..., local = TRUE)` lends the child's
//! definitions exactly where R puts them.
//!
//! At the top level of a script, `local = TRUE` evaluates the child in the
//! script's own (global) environment, so its definitions are visible to the
//! rest of the script, as with a plain `source()`. Inside a function body the
//! child's definitions stay in the function's frame, and `local = new.env()`
//! keeps them in a fresh environment. Every fixture is synthetic and runs
//! through `raven check --format json`.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `(path, 0-based line, name)` for every "`name` is not defined" diagnostic
/// about one of `probes`. Filtering by name keeps the result independent of
/// whether R is installed to resolve base functions.
fn undefined(root: &Path, probes: &[&str]) -> Vec<(String, u64, String)> {
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
    let mut found: Vec<(String, u64, String)> = rows
        .into_iter()
        .filter(|row| row["diagnostic"]["code"] == "undefined-variable")
        .filter_map(|row| {
            let message = row["diagnostic"]["message"].as_str().unwrap();
            let name = probes
                .iter()
                .find(|probe| message == format!("{probe} is not defined"))?;
            Some((
                row["path"].as_str().unwrap().replace('\\', "/"),
                row["diagnostic"]["range"]["start"]["line"]
                    .as_u64()
                    .unwrap(),
                (*name).to_owned(),
            ))
        })
        .collect();
    found.sort();
    found
}

/// The reported layout: a script at `R/main.R` sources `R/helpers.R` with
/// `local = TRUE` at the top level, then calls a function the helper defines.
#[test]
fn top_level_local_true_lends_child_functions_to_the_script() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "R/main.R",
        "source(\"R/helpers.R\", local = TRUE)\nx <- ll(1)\n",
    );
    write(
        dir.path(),
        "R/helpers.R",
        "ll <- function(model) {\n  log(2 * pi)\n}\n",
    );
    assert_eq!(undefined(dir.path(), &["ll"]), vec![]);
}

/// `local = TRUE` inside a function body and `local = new.env()` at the top
/// level keep the child's definitions out of the script's global scope.
#[test]
fn function_body_and_new_env_local_sources_do_not_lend_to_the_script() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"f <- function() {
  source("R/in_function.R", local = TRUE)
  from_function()
}
source("R/new_env.R", local = new.env())
from_function()
from_new_env()
"#,
    );
    write(
        dir.path(),
        "R/in_function.R",
        "from_function <- function() 1\n",
    );
    write(dir.path(), "R/new_env.R", "from_new_env <- function() 2\n");
    assert_eq!(
        undefined(dir.path(), &["from_function", "from_new_env"]),
        vec![
            ("main.R".to_owned(), 5, "from_function".to_owned()),
            ("main.R".to_owned(), 6, "from_new_env".to_owned()),
        ],
    );
}
