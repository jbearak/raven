//! Executable documentation examples.
//!
//! Every directory under `docs/examples/snippets/` is a self-contained
//! mini-workspace whose output a user doc page shows verbatim. This test runs
//! the real `raven` binary on each one and compares the result with the
//! committed expectation, so the README demo, the getting-started tutorial,
//! and the diagnostic-code examples cannot drift from what Raven prints. The
//! Bun test `tests/bun/docs/examples.test.ts` checks the other half: that each
//! marked doc block equals the corpus files byte-for-byte.
//!
//! Each example directory holds:
//! - `cmd`: the arguments after `raven`, exactly as the page displays them
//! - the workspace files (`.R`, optional `raven.toml`, ...)
//! - `stdout.txt`, `stderr.txt`: exact expected streams; `{{version}}` stands
//!   for the crate version so release bumps don't churn the corpus
//! - `exit`: the expected exit code
//!
//! Isolation: the harness never adds flags. It copies the example into a
//! fresh temp directory (asserting no ancestor holds a `raven.toml`/`.lintr`),
//! writes `<tmp>/raven.toml` with `packages.enabled = false` forced so no R
//! subprocess runs, and executes with a cleared environment whose `PATH` is an
//! empty directory and whose `HOME`/`XDG_*` point into the temp directory. So
//! installed R, `RAVEN_NAMES_DB`, user config, and caches cannot leak in.
//!
//! Regenerate expectations after an intended output change with:
//! `UPDATE_DOCS_EXAMPLES=1 cargo test -p raven --test docs_examples`

use std::path::{Path, PathBuf};
use std::process::Command;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/examples/snippets")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(
            name.as_ref(),
            "cmd" | "stdout.txt" | "stderr.txt" | "exit" | "raven.toml"
        ) {
            continue;
        }
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}

/// The example's own `raven.toml` with `packages.enabled = false` forced.
fn effective_config(example: &Path) -> Result<String, String> {
    let own = example.join("raven.toml");
    let mut table: toml::Table = if own.exists() {
        std::fs::read_to_string(&own)
            .unwrap()
            .parse()
            .map_err(|e| format!("raven.toml does not parse: {e}"))?
    } else {
        toml::Table::new()
    };
    let packages = table
        .entry("packages")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or("`packages` must be a table")?;
    if packages.contains_key("enabled") {
        return Err(
            "examples must not set packages.enabled; the harness forces it to false".into(),
        );
    }
    packages.insert("enabled".into(), toml::Value::Boolean(false));
    Ok(toml::to_string(&table).unwrap())
}

fn assert_no_ancestor_config(dir: &Path) {
    for ancestor in dir.ancestors().skip(1) {
        for name in ["raven.toml", ".lintr"] {
            assert!(
                !ancestor.join(name).exists(),
                "{} exists above the example temp dir and would be discovered",
                ancestor.join(name).display()
            );
        }
    }
}

struct Run {
    stdout: String,
    stderr: String,
    exit: i32,
}

fn run_example(example: &Path) -> Result<Run, String> {
    let cmd =
        std::fs::read_to_string(example.join("cmd")).map_err(|e| format!("missing cmd: {e}"))?;
    let args: Vec<&str> = cmd.split_whitespace().collect();

    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    copy_dir(example, &ws);
    assert_no_ancestor_config(&ws);
    std::fs::write(ws.join("raven.toml"), effective_config(example)?).unwrap();
    let home = tmp.path().join("home");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&bin).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(&args)
        .current_dir(&ws)
        .env_clear()
        .env("NO_COLOR", "1")
        .env("PATH", &bin)
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .output()
        .map_err(|e| format!("failed to run raven: {e}"))?;
    Ok(Run {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        exit: out.status.code().unwrap_or(-1),
    })
}

fn read_expected(example: &Path, file: &str) -> String {
    std::fs::read_to_string(example.join(file))
        .unwrap_or_default()
        .replace("{{version}}", VERSION)
}

fn write_expected(example: &Path, run: &Run) {
    let tokenize = |s: &str| s.replace(VERSION, "{{version}}");
    std::fs::write(example.join("stdout.txt"), tokenize(&run.stdout)).unwrap();
    std::fs::write(example.join("stderr.txt"), tokenize(&run.stderr)).unwrap();
    std::fs::write(example.join("exit"), format!("{}\n", run.exit)).unwrap();
}

#[test]
fn docs_examples_match_raven_output() {
    let update = std::env::var_os("UPDATE_DOCS_EXAMPLES").is_some();
    let mut examples: Vec<PathBuf> = std::fs::read_dir(corpus_dir())
        .expect("docs/examples/snippets exists")
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    examples.sort();
    assert!(!examples.is_empty(), "no docs examples found");

    let mut failures = Vec::new();
    for example in &examples {
        let name = example.file_name().unwrap().to_string_lossy().into_owned();
        let run = match run_example(example) {
            Ok(run) => run,
            Err(e) => {
                failures.push(format!("{name}: {e}"));
                continue;
            }
        };
        if update {
            write_expected(example, &run);
            continue;
        }
        let want_exit: i32 = read_expected(example, "exit").trim().parse().unwrap_or(-1);
        for (stream, got, want) in [
            ("stdout", &run.stdout, read_expected(example, "stdout.txt")),
            ("stderr", &run.stderr, read_expected(example, "stderr.txt")),
        ] {
            if *got != want {
                failures.push(format!(
                    "{name}: {stream} differs\n--- expected\n{want}\n--- actual\n{got}"
                ));
            }
        }
        if run.exit != want_exit {
            failures.push(format!("{name}: exit {} (expected {want_exit})", run.exit));
        }
    }
    assert!(
        failures.is_empty(),
        "{} docs example(s) out of date. If the change is intended, run \
         `UPDATE_DOCS_EXAMPLES=1 cargo test -p raven --test docs_examples` and review the diff.\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// The tutorial and README demos promise that Raven works without R. That
/// depends on the embedded base-R symbol coverage, so check it directly.
#[test]
fn base_symbols_resolve_without_r() {
    let tmp = tempfile::tempdir().unwrap();
    let ex = tmp.path().join("base-only");
    std::fs::create_dir_all(&ex).unwrap();
    std::fs::write(ex.join("cmd"), "check .\n").unwrap();
    std::fs::write(
        ex.join("base.R"),
        "x <- data.frame(a = 1:3)\ny <- lapply(x$a, function(v) paste(v, mean(x$a)))\nprint(y)\n",
    )
    .unwrap();
    let run = run_example(&ex).unwrap();
    assert_eq!(
        run.exit, 0,
        "stdout:\n{}\nstderr:\n{}",
        run.stdout, run.stderr
    );
}
