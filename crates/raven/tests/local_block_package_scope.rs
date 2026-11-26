//! End-to-end pins for a package attached by a file that is sourced inside a
//! `local()` block (issue #884, item 2). They record today's results so the
//! next attempt starts from them.
//!
//! A `source("child.R", local = TRUE)` inside `local({ ... })` runs the child
//! in the block's frame. Raven keeps the packages the child attaches in that
//! frame, as it keeps the child's ordinary variables, so they are visible in
//! the rest of the block and forgotten when it ends. In R, `library()`
//! attaches for the whole session, so a later `ns()` runs. Raven reports it.
//! That is a documented limitation (`docs/cross-file.md`, "Limitations"). A
//! `library()` written directly in the block does carry past it. Inside a
//! function body, v0.21.1 accepted these scripts; at the top level it
//! reported them too. A fix was planned and dropped; the record is the
//! comment on #884 that accompanies these pins.
//!
//! The binary runs with a cleared environment, an R path that doesn't exist,
//! and a fake library, so the results don't depend on the machine's R. The
//! stubs export the names the fixtures call. `aa884` and `zz884` both export
//! `%pick884%`; their `raven/nse.toml` files say `aa884`'s operator checks
//! its right operand and `zz884`'s doesn't, as the real test packages behave.
//! Every input was run in R 4.6.2 with real packages
//! (`Rscript --vanilla main.R`).

use std::path::Path;
use std::process::Command;

/// The name appended to every `main.R`. R never sees it, and every run must
/// report it, so "nothing reported" can't mean "file not analyzed".
const LIVE_CONTROL: &str = "live_control";

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn install_fake_packages(lib: &Path) {
    write(
        lib,
        "splines/DESCRIPTION",
        "Package: splines\nVersion: 4.6.2\n",
    );
    write(lib, "splines/NAMESPACE", "export(ns)\nexport(bs)\n");
    write(lib, "shiny/DESCRIPTION", "Package: shiny\nVersion: 1.8.0\n");
    write(
        lib,
        "shiny/NAMESPACE",
        "export(observe)\nexport(reactive)\n",
    );
    for (package, captured) in [("aa884", "x"), ("zz884", "y")] {
        write(
            lib,
            &format!("{package}/DESCRIPTION"),
            &format!("Package: {package}\nVersion: 0.1.0\n"),
        );
        write(
            lib,
            &format!("{package}/NAMESPACE"),
            "export(\"%pick884%\")\n",
        );
        write(
            lib,
            &format!("{package}/raven/nse.toml"),
            &format!(
                "schema = 1\n\n[[function]]\nname = \"%pick884%\"\nformals = [\"x\", \"y\"]\ncaptured = [\"{captured}\"]\n"
            ),
        );
    }
}

/// `(path, 0-based line, name)` of every undefined-variable diagnostic,
/// the live control aside.
fn undefined(files: &[(&str, &str)], lib: &Path) -> Vec<(String, u64, String)> {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ws");
    let home = dir.path().join("home");
    let empty_path = dir.path().join("bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&empty_path).unwrap();
    for (path, text) in files {
        let mut text = (*text).to_owned();
        if *path == "main.R" {
            text.push_str(LIVE_CONTROL);
            text.push('\n');
        }
        write(&root, path, &text);
    }
    let toml_string = |path: &Path| toml::Value::String(path.display().to_string()).to_string();
    write(
        &root,
        "raven.toml",
        &format!(
            "[packages]\nadditionalLibraryPaths = [{}]\nrPath = {}\n",
            toml_string(lib),
            toml_string(&dir.path().join("no-such-R"))
        ),
    );

    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["check", "--workspace"])
        .arg(&root)
        .args(["--format", "json", "--max-severity", "off"])
        .env_clear()
        .env("NO_COLOR", "1")
        .env("PATH", &empty_path)
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
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
        .map(|row| {
            let message = row["diagnostic"]["message"].as_str().unwrap();
            (
                row["path"].as_str().unwrap().replace('\\', "/"),
                row["diagnostic"]["range"]["start"]["line"]
                    .as_u64()
                    .unwrap(),
                message
                    .strip_suffix(" is not defined")
                    .unwrap_or(message)
                    .to_owned(),
            )
        })
        .collect();
    let control = found
        .iter()
        .position(|(path, _, name)| path == "main.R" && name == LIVE_CONTROL)
        .expect("main.R was not analyzed");
    found.remove(control);
    found.sort();
    found
}

const CHILD: &str = "library(splines)\nprivate884 <- 3\n";
const OBSERVE: &str = "observe <- function(expr) force(expr)\n";
const SHINY_CHILD: &str = "suppressPackageStartupMessages(library(shiny))\n";

#[test]
fn package_attached_by_a_child_sourced_in_a_block_keeps_todays_results() {
    // (name, files, expected `(path, line, name)` rows)
    type Case = (
        &'static str,
        &'static [(&'static str, &'static str)],
        &'static [(&'static str, u64, &'static str)],
    );
    let cases: &[Case] = &[
        // Documented limitation: R prints the spline basis twice in both.
        // Raven accepts the `ns()` inside the block and reports the one after
        // it. v0.21.1 accepted both calls in the first input, and reported
        // both in the second.
        (
            "in a function, a child attaches the package in a block",
            &[
                (
                    "main.R",
                    "f <- function() {\n  local({\n    source(\"child.R\", local = TRUE)\n    print(ns(1:10, df = 3)[1, ])\n  })\n  ns(1:10, df = 3)[1, ]\n}\nprint(f())\n",
                ),
                ("child.R", CHILD),
            ],
            &[("main.R", 5, "ns")],
        ),
        (
            "at the top level, a child attaches the package in a block",
            &[
                (
                    "main.R",
                    "local({\n  source(\"child.R\", local = TRUE)\n  print(ns(1:10, df = 3)[1, ])\n})\nprint(ns(1:10, df = 3)[1, ])\n",
                ),
                ("child.R", CHILD),
            ],
            &[("main.R", 4, "ns")],
        ),
        // Correct: the child's other names stay in the block, and R stops on
        // `private884`.
        (
            "the child's variables don't leak past the block",
            &[
                (
                    "main.R",
                    "f <- function() { local({ source(\"child.R\", local = TRUE) }); print(private884) }\nf()\n",
                ),
                ("child.R", CHILD),
            ],
            &[("main.R", 0, "private884")],
        ),
        // Controls: a `library()` written in the block carries past it. R
        // prints the spline basis.
        (
            "in a function, library() directly in the block",
            &[(
                "main.R",
                "f <- function() { local({ library(splines) }); ns(1:10, df = 3)[1, ] }\nprint(f())\n",
            )],
            &[],
        ),
        (
            "at the top level, library() directly in the block",
            &[(
                "main.R",
                "local({ library(splines) })\nprint(ns(1:10, df = 3)[1, ])\n",
            )],
            &[],
        ),
        // The documented workarounds. R prints the spline basis in each.
        (
            "workaround: attach the package in the function",
            &[
                (
                    "main.R",
                    "f <- function() { library(splines); local({ source(\"child.R\", local = TRUE) }); ns(1:10, df = 3)[1, ] }\nprint(f())\n",
                ),
                ("child.R", CHILD),
            ],
            &[],
        ),
        (
            "workaround: attach the package in the file",
            &[
                (
                    "main.R",
                    "library(splines)\nlocal({ source(\"child.R\", local = TRUE) })\nprint(ns(1:10, df = 3)[1, ])\n",
                ),
                ("child.R", CHILD),
            ],
            &[],
        ),
        (
            "workaround: declare the function after the block",
            &[
                (
                    "main.R",
                    "f <- function() {\n  local({ source(\"child.R\", local = TRUE) })\n  # raven: func ns\n  ns(1:10, df = 3)[1, ]\n}\nprint(f())\n",
                ),
                ("child.R", CHILD),
            ],
            &[],
        ),
        // Right today only because the package is forgotten. A sourced
        // `observe` that forces its argument masks Shiny's, so R prints 1 in
        // both of the next two inputs. When Raven sees the child's shiny
        // attached at the `observe()` call, it takes the call for Shiny's,
        // because `observe` is defined in another file, scopes the braces
        // as a deferred body, and reports `made884`.
        // A fix that lets the remembered package reach that rule would turn
        // the first input into the second.
        (
            "a child attaches shiny in a block; a sourced observe masks it",
            &[
                (
                    "main.R",
                    "source(\"defs.R\")\nf <- function() { local({ source(\"child.R\", local = TRUE) }); observe({ made884 <- 1 }); print(made884) }\nf()\n",
                ),
                ("defs.R", OBSERVE),
                ("child.R", SHINY_CHILD),
            ],
            &[],
        ),
        // Wrong on both v0.21.1 and main. The same child sourced outside a
        // block, so the clean result above is the block's doing.
        (
            "a child attaches shiny outside a block; a sourced observe masks it",
            &[
                (
                    "main.R",
                    "source(\"defs.R\")\nf <- function() { source(\"child.R\", local = TRUE); observe({ made884 <- 1 }); print(made884) }\nf()\n",
                ),
                ("defs.R", OBSERVE),
                ("child.R", SHINY_CHILD),
            ],
            &[("main.R", 1, "made884")],
        ),
        // The same for an infix operator. The child attaches `aa884`, whose
        // `%pick884%` checks its right operand; the function then attaches
        // `zz884`, whose operator doesn't, and R finds `zz884`'s first, so R
        // prints 1 in both inputs. When Raven sees both packages attached
        // here, it takes `aa884`'s policy, not the last-attached `zz884`'s,
        // and reports `missing884`.
        (
            "a child attaches aa884 in a block; zz884's operator is the one found",
            &[
                (
                    "main.R",
                    "f <- function() { local({ source(\"child.R\", local = TRUE) }); suppressPackageStartupMessages(library(zz884)); 1 %pick884% missing884 }\nprint(f())\n",
                ),
                ("child.R", "library(aa884)\n"),
            ],
            &[],
        ),
        // Wrong on both v0.21.1 and main.
        (
            "a child attaches aa884 outside a block; zz884's operator is the one found",
            &[
                (
                    "main.R",
                    "f <- function() { source(\"child.R\", local = TRUE); suppressPackageStartupMessages(library(zz884)); 1 %pick884% missing884 }\nprint(f())\n",
                ),
                ("child.R", "library(aa884)\n"),
            ],
            &[("main.R", 0, "missing884")],
        ),
        // Pairs that differ only in a value Raven doesn't evaluate: a
        // literal condition, and a loop count. Raven reports all four; R
        // stops only in the second of each pair. A fix that accepts the first
        // of a pair has to tell the two apart.
        //
        // R prints the spline basis; v0.21.1 accepted it.
        (
            "the child attaches under if (TRUE)",
            &[
                (
                    "main.R",
                    "f <- function() { local({ source(\"child.R\", local = TRUE) }); ns(1:10, df = 3)[1, ] }\nprint(f())\n",
                ),
                ("child.R", "if (TRUE) library(splines)\n"),
            ],
            &[("main.R", 0, "ns")],
        ),
        // R stops on `ns`.
        (
            "the child attaches under if (FALSE)",
            &[
                (
                    "main.R",
                    "f <- function() { local({ source(\"child.R\", local = TRUE) }); ns(1:10, df = 3)[1, ] }\nprint(f())\n",
                ),
                ("child.R", "if (FALSE) library(splines)\n"),
            ],
            &[("main.R", 0, "ns")],
        ),
        // R prints the spline basis; v0.21.1 accepted it.
        (
            "the block runs in a loop over seq_len(2)",
            &[
                (
                    "main.R",
                    "f <- function(n = 2) { for (i in seq_len(n)) local({ source(\"child.R\", local = TRUE) }); ns(1:10, df = 3)[1, ] }\nprint(f())\n",
                ),
                ("child.R", "library(splines)\n"),
            ],
            &[("main.R", 0, "ns")],
        ),
        // R stops on `ns`: the loop runs zero times.
        (
            "the block runs in a loop over seq_len(0)",
            &[
                (
                    "main.R",
                    "f <- function(n = 0) { for (i in seq_len(n)) local({ source(\"child.R\", local = TRUE) }); ns(1:10, df = 3)[1, ] }\nprint(f())\n",
                ),
                ("child.R", "library(splines)\n"),
            ],
            &[("main.R", 0, "ns")],
        ),
    ];
    let lib_dir = tempfile::tempdir().unwrap();
    install_fake_packages(lib_dir.path());
    for (name, files, expected) in cases {
        let expected: Vec<(String, u64, String)> = expected
            .iter()
            .map(|(path, line, probe)| ((*path).to_owned(), *line, (*probe).to_owned()))
            .collect();
        assert_eq!(undefined(files, lib_dir.path()), expected, "{name}");
    }
}
