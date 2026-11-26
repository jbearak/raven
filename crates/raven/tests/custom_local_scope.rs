//! End-to-end pins for `local()` blocks whose `local` comes from another
//! file (issue #907, item 1). They record today's results so the next attempt
//! starts from them.
//!
//! Raven takes a bare `local({ ... })` for base R's `local()` unless the same
//! file rebinds `local`, and scopes the block's assignments to the block. When
//! another file supplies a `local` that evaluates its argument in the caller,
//! such as `local <- function(expr) eval.parent(substitute(expr))`, R runs the
//! block in the calling frame, so a later read works in R and is reported by
//! Raven. That is a documented limitation (`docs/cross-file.md`,
//! "Limitations"); v0.21.1 had no block scoping and accepted these scripts.
//!
//! Two designs for #907 were planned and dropped. One deleted the single
//! warning when the whole program was provably inert, and shrank to nothing.
//! The other treated the block as an ordinary call once a graph proof showed
//! a caller-evaluating wrapper; it never stopped finding ordinary programs
//! that break the proof. The issue comment records both designs. Every input
//! below was run in R 4.6.2 (`Rscript --vanilla`, from the file the comment
//! names, or `main.R`).

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `(path, 0-based line)` of every "`probe` is not defined" diagnostic.
fn undefined(root: &Path, probe: &str) -> Vec<(String, u64)> {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["check", "--workspace"])
        .arg(root)
        .args([
            "--no-config",
            "--format",
            "json",
            "--max-severity",
            "off",
            "--no-color",
        ])
        .output()
        .unwrap();
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "raven check did not complete cleanly.\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    let mut found: Vec<(String, u64)> = rows
        .into_iter()
        .filter(|row| {
            row["diagnostic"]["code"] == "undefined-variable"
                && row["diagnostic"]["message"] == format!("{probe} is not defined")
        })
        .map(|row| {
            (
                row["path"].as_str().unwrap().replace('\\', "/"),
                row["diagnostic"]["range"]["start"]["line"]
                    .as_u64()
                    .unwrap(),
            )
        })
        .collect();
    found.sort();
    found
}

const EVAL_PARENT: &str = "local <- function(expr) eval.parent(substitute(expr))\n";
const FORCE: &str = "local <- function(expr) force(expr)\n";

#[test]
fn custom_local_from_another_file_keeps_todays_results() {
    // (name, files, probe, expected `(path, line)` rows)
    type Case = (
        &'static str,
        &'static [(&'static str, &'static str)],
        &'static str,
        &'static [(&'static str, u64)],
    );
    let cases: &[Case] = &[
        // Documented limitation: R prints 1 in each, and Raven warns.
        (
            "the wrapper comes from a sourced file",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ xx <- 1 })\nprint(xx)\n",
                ),
                ("mask.R", EVAL_PARENT),
            ],
            "xx",
            &[("main.R", 2)],
        ),
        // R prints 1 run as `Rscript driver.R`, and stops on `xx` run as
        // `Rscript main.R`; Raven judges `main.R` through its caller.
        (
            "the wrapper comes from the file that sources this one",
            &[
                (
                    "driver.R",
                    "local <- function(expr) eval.parent(substitute(expr))\nsource(\"main.R\")\n",
                ),
                ("main.R", "local({ xx <- 1 })\nprint(xx)\n"),
            ],
            "xx",
            &[("main.R", 1)],
        ),
        (
            "the wrapper comes from load()",
            &[(
                "main.R",
                "mask <- function(expr) eval.parent(substitute(expr))\ne <- new.env()\ne$local <- mask\nsave(list = \"local\", file = \"saved.RData\", envir = e)\nload(\"saved.RData\")\nlocal({ xx <- 1 })\nprint(xx)\n",
            )],
            "xx",
            &[("main.R", 6)],
        ),
        // Correct warnings: the sourced `local` discards its argument, and R
        // stops on `xx`.
        (
            "a sourced local that quotes its argument",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ xx <- 1 })\nprint(xx)\n",
                ),
                ("mask.R", "local <- function(expr) quote(expr)\n"),
            ],
            "xx",
            &[("main.R", 2)],
        ),
        // Run as `Rscript driver.R`.
        (
            "a caller's local that quotes its argument",
            &[
                (
                    "driver.R",
                    "local <- function(expr) quote(expr)\nsource(\"main.R\")\n",
                ),
                ("main.R", "local({ xx <- 1 })\nprint(xx)\n"),
            ],
            "xx",
            &[("main.R", 1)],
        ),
        // Same-file control: the file rebinds `local`, so the block isn't
        // scoped. R prints 1.
        (
            "the same file defines the wrapper",
            &[(
                "main.R",
                "local <- function(expr) eval.parent(substitute(expr))\nlocal({ xx <- 1 })\nprint(xx)\n",
            )],
            "xx",
            &[],
        ),
        // The documented workaround.
        (
            "a declaration after the block, wrapper from a sourced file",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ xx <- 1 })\n# raven: var xx\nprint(xx)\n",
                ),
                ("mask.R", EVAL_PARENT),
            ],
            "xx",
            &[],
        ),
        (
            "a declaration after the block, wrapper from the caller",
            &[
                (
                    "driver.R",
                    "local <- function(expr) eval.parent(substitute(expr))\nsource(\"main.R\")\n",
                ),
                ("main.R", "local({ xx <- 1 })\n# raven: var xx\nprint(xx)\n"),
            ],
            "xx",
            &[],
        ),
        // Warnings that are right today, and that any design making the
        // block's bindings visible would lose. With the block removed, R gives
        // the same result and Raven reports nothing, because it admits
        // conditional definitions, doesn't apply a sourced child's or a
        // computed `rm()`, and doesn't model a caught error or an empty loop.
        // R stops on `xx` in each.
        (
            "an assignment under if (FALSE) in the block",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ if (FALSE) xx <- 1 })\nprint(xx)\n",
                ),
                ("mask.R", EVAL_PARENT),
            ],
            "xx",
            &[("main.R", 2)],
        ),
        (
            "a child sourced after the block removes the name",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ xx <- 1 })\nsource(\"drop.R\")\nprint(xx)\n",
                ),
                ("mask.R", EVAL_PARENT),
                ("drop.R", "rm(xx)\n"),
            ],
            "xx",
            &[("main.R", 3)],
        ),
        // Run as `Rscript driver.R`.
        (
            "the caller removes the name after sourcing the block",
            &[
                (
                    "driver.R",
                    "local <- function(expr) eval.parent(substitute(expr))\nsource(\"main.R\")\nrm(xx)\nprint(xx)\n",
                ),
                ("main.R", "local({ xx <- 1 })\n"),
            ],
            "xx",
            &[("driver.R", 3)],
        ),
        (
            "a caught error before the assignment completes",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ try(xx <- stop(\"no result\"), silent = TRUE) })\nprint(xx)\n",
                ),
                ("mask.R", FORCE),
            ],
            "xx",
            &[("main.R", 2)],
        ),
        (
            "an assignment in a loop that runs zero times",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ for (item in integer()) xx <- item })\nprint(xx)\n",
                ),
                ("mask.R", FORCE),
            ],
            "xx",
            &[("main.R", 2)],
        ),
        (
            "a removal by a computed name after the block",
            &[
                (
                    "main.R",
                    "source(\"mask.R\")\nlocal({ xx <- 1 })\nkey <- \"xx\"\nrm(list = key)\nprint(xx)\n",
                ),
                ("mask.R", FORCE),
            ],
            "xx",
            &[("main.R", 4)],
        ),
        // Wrong today: R stops on `outside`, because the wrapper runs the
        // `rm()` in the calling frame. Raven keeps the removal inside the
        // block. v0.21.1 warned here.
        (
            "a removal inside the block of an outer name",
            &[
                (
                    "main.R",
                    "outside <- 1\nsource(\"mask.R\")\nlocal({ rm(outside) })\nprint(outside)\n",
                ),
                ("mask.R", EVAL_PARENT),
            ],
            "outside",
            &[],
        ),
    ];
    for (name, files, probe, expected) in cases {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in *files {
            write(dir.path(), path, text);
        }
        let expected: Vec<(String, u64)> = expected
            .iter()
            .map(|(path, line)| ((*path).to_owned(), *line))
            .collect();
        assert_eq!(undefined(dir.path(), probe), expected, "{name}");
    }
}
