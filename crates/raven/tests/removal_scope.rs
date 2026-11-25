//! End-to-end checks that an `rm()` hides its name as widely as it does
//! today, on the inputs where anything narrower went wrong.
//!
//! Raven hides a removed name from the removing frame inward, and a global
//! removal hides it in every frame. R is narrower: `rm()` takes one binding
//! from one frame. So `shadow <- 1; local({ shadow <- 2; rm(shadow);
//! print(shadow) })` prints 1 in R and gets a warning from Raven, and a
//! function's own `` `gizmo<-` `` is lost to a top-level `rm()` (issue #884,
//! items 1 and 4).
//!
//! Three attempts to narrow the rule each turned a true warning into silence
//! on inputs like the ones below, where R does stop and the text gives no
//! sure sign of it. They are kept so the next attempt starts from them. Every
//! fixture is synthetic, was run in R (`Rscript --vanilla main.R` unless a
//! comment says otherwise), and runs through `raven check --format json`.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `(path, 0-based line)` of every "`probe` is not defined" diagnostic.
/// Filtering by name keeps the result independent of whether R is installed
/// to resolve base functions.
fn undefined(root: &Path, probe: &str) -> Vec<(String, u64)> {
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

/// Each input must keep exactly these diagnostics. The first sixteen came
/// from the first review of a narrower rule, the last eight from the review
/// of the narrowest one tried, and the rest from probing in between. R stops
/// at the flagged read on every one except the five noted below.
#[test]
fn removals_keep_their_diagnostics() {
    // (name, files, probe, expected `(path, line)` rows)
    type Case = (
        &'static str,
        &'static [(&'static str, &'static str)],
        &'static str,
        &'static [(&'static str, u64)],
    );
    let cases: &[Case] = &[
        (
            "an earlier inherits = TRUE removal, then a rebind",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe, inherits = TRUE); probe <- 2; rm(probe); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "pos as a string",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe, pos = \".GlobalEnv\"); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "a quoted envir tag",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe, \"envir\" = as.environment(1)); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "pos = globalenv()",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe, pos = globalenv()); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "pos = 1.0",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe, pos = 1.0); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "a quoted envir tag naming the enclosing environment",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe, \"envir\" = parent.env(environment())); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "forwarded dots",
            &[(
                "main.R",
                "f <- function(...) {\n  probe <- 1\n  local({ rm(probe, ...); print(probe) })\n}\nf(inherits = TRUE)\n",
            )],
            "probe",
            &[("main.R", 2)],
        ),
        (
            "the removal piped to evalq",
            &[(
                "main.R",
                "probe <- 1\nlocal({ rm(probe) |> evalq(envir = globalenv()); print(probe) })\n",
            )],
            "probe",
            &[("main.R", 1)],
        ),
        (
            "the removal as an operand of a user operator",
            &[(
                "main.R",
                "\"%inenv%\" <- function(expr, env) eval(substitute(expr), env)\nshadow <- 1\nlocal({\n  rm(shadow) %inenv% globalenv()\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 4)],
        ),
        (
            "the outer binding removed by a sourced file",
            &[
                (
                    "main.R",
                    "probe <- 1\nsource(\"drop.R\")\nlocal({ probe <- 2; rm(probe); print(probe) })\n",
                ),
                ("drop.R", "rm(probe)\n"),
            ],
            "probe",
            &[("main.R", 2)],
        ),
        (
            "the enclosing binding removed before the closure runs",
            &[(
                "main.R",
                "local({\n  shadow <- 1\n  f <- function() {\n    local({\n      shadow <- 2\n      rm(shadow)\n      print(shadow)\n    })\n  }\n  rm(shadow)\n  f()\n})\n",
            )],
            "shadow",
            &[("main.R", 6)],
        ),
        (
            "a second removal with an explicit destination",
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow, shadow)\n  rm(shadow, envir = globalenv())\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        (
            "a function's own binding that is not a function",
            &[(
                "main.R",
                "`gizmo<-` <- function(x, value) value\nf <- function() {\n  `gizmo<-` <- 1\n  x <- 0\n  gizmo(x) <- 42\n  x\n}\nrm(list = \"gizmo<-\")\nprint(f())\n",
            )],
            "gizmo",
            &[("main.R", 4)],
        ),
        (
            "a block-sourced child's global-only definition",
            &[
                (
                    "main.R",
                    "local({\n  source(\"child.R\", local = TRUE)\n  rm(list = \"probe<-\", envir = globalenv())\n  x <- 0\n  probe(x) <- 3\n})\n",
                ),
                ("child.R", "`probe<-` <<- function(x, value) value\n"),
            ],
            "probe",
            &[("main.R", 4)],
        ),
        // R prints 2 here, and Raven is silent.
        (
            "an unrelated rm() beside a block-sourced child",
            &[
                (
                    "main.R",
                    "local({\n  other <- 0; rm(other)\n  source(\"child.R\", local = TRUE)\n  print(probe)\n})\n",
                ),
                (
                    "child.R",
                    "assign(\"probe\", 1, envir = .GlobalEnv)\nprobe <- 2\n",
                ),
            ],
            "probe",
            &[],
        ),
        // R prints 42 here. The point resolvers and the stream disagree on
        // the binding, so the warning is the safe answer.
        (
            "a replacement function bound by one block-sourced child and removed globally by another",
            &[
                (
                    "main.R",
                    "`gizmo<-` <- function(x, value) 0\nlocal({\n  source(\"bind.R\", local = TRUE)\n  source(\"drop.R\", local = TRUE)\n  x <- 0\n  gizmo(x) <- 42\n  print(x)\n  print(is.function(`gizmo<-`))\n})\n",
                ),
                ("bind.R", "`gizmo<-` <- function(x, value) value\n"),
                ("drop.R", "rm(list = \"gizmo<-\", envir = globalenv())\n"),
            ],
            "gizmo",
            &[("main.R", 5)],
        ),
        (
            "a function shown where the block removed a variable's shadow of it",
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- function() 2\n  rm(shadow)\n  shadow()\n})\n",
            )],
            "shadow",
            &[("main.R", 4)],
        ),
        (
            "a variable handed to code that calls it",
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  sapply(1:2, shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 4)],
        ),
        (
            "a top-level binding that only a branch makes",
            &[(
                "main.R",
                "if (FALSE) shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 4)],
        ),
        // R prints 1 when `main.R` runs alone: nothing runs `drop.R`. The
        // directive says something does.
        (
            "the top-level binding removed by a file that says it is sourced by this one",
            &[
                (
                    "main.R",
                    "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
                ),
                ("drop.R", "# raven: sourced-by main.R\nrm(shadow)\n"),
            ],
            "shadow",
            &[("main.R", 4)],
        ),
        // R prints 1 here: `stats` exports neither `local` nor `rm`.
        (
            "a package attached, which could export its own local or rm",
            &[(
                "main.R",
                "library(stats)\nshadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        // Run as `Rscript main.R`, so that R reads the profile.
        (
            "a profile that replaces local with one that runs in the calling frame",
            &[
                (
                    "main.R",
                    "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
                ),
                (
                    ".Rprofile",
                    "local <- function(expr) eval.parent(substitute(expr))\n",
                ),
            ],
            "shadow",
            &[("main.R", 4)],
        ),
        // R prints 3 here: `<<-` replaced the top-level binding.
        (
            "the top-level binding replaced by <<- from the block",
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  shadow <<- 3\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        (
            "the top-level binding removed through a pipe",
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  \"shadow\" |> rm(inherits = TRUE)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        (
            "local replaced by a replacement call on the global environment",
            &[(
                "main.R",
                "`set<-` <- function(x, value) value\ne <- .GlobalEnv\nset(e$local) <- function(expr) expr\nshadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 7)],
        ),
        (
            "the top-level binding removed by code built at run time",
            &[(
                "main.R",
                "shadow <- 1\nlocal({\n  shadow <- 2\n  rm(shadow)\n  eval(parse(text = paste0(\"r\", \"m(shadow, inherits = TRUE)\")))\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        (
            "the top-level function replaced through its environment",
            &[(
                "main.R",
                "shadow <- function() 1\ne <- globalenv(); e$shadow <- 1\nlocal({\n  shadow <- function() 2\n  rm(shadow)\n  print(shadow())\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        (
            "a function body's function that only a branch defines",
            &[(
                "main.R",
                "`gizmo<-` <- function(x, value) value\nrm(list = \"gizmo<-\")\nf <- function() {\n  if (FALSE) `gizmo<-` <- function(x, value) value\n  x <- 0\n  gizmo(x) <- 42\n  x\n}\nprint(f())\n",
            )],
            "gizmo",
            &[("main.R", 5)],
        ),
        (
            "a function body's function removed from its own frame",
            &[(
                "main.R",
                "`gizmo<-` <- function(x, value) value\nrm(list = \"gizmo<-\")\nf <- function() {\n  `gizmo<-` <- function(x, value) value\n  rm(list = \"gizmo<-\", envir = environment())\n  x <- 0\n  gizmo(x) <- 42\n  x\n}\nprint(f())\n",
            )],
            "gizmo",
            &[("main.R", 6)],
        ),
        (
            "a function body's function overwritten through its environment",
            &[(
                "main.R",
                "`gizmo<-` <- function(x, value) value\nrm(list = \"gizmo<-\")\nf <- function() {\n  `gizmo<-` <- function(x, value) value\n  e <- environment(); e[[\"gizmo<-\"]] <- 1\n  x <- 0\n  gizmo(x) <- 42\n  x\n}\nprint(f())\n",
            )],
            "gizmo",
            &[("main.R", 6)],
        ),
        (
            "an earlier top-level removal that spells the name in backticks",
            &[(
                "main.R",
                "shadow <- 1\nrm(`shadow`)\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 5)],
        ),
        (
            "a pipe that supplies local()'s environment",
            &[(
                "main.R",
                "shadow <- 1\n.GlobalEnv |> local(expr = {\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 4)],
        ),
        (
            "braces in local()'s envir slot",
            &[(
                "main.R",
                "shadow <- 1\nlocal(, {\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 4)],
        ),
        (
            "a tagged argument that rm() removes through its dots",
            &[(
                "main.R",
                "shadow <- 1\nrm(unused = shadow)\nlocal({ shadow <- 2; rm(shadow); print(shadow) })\n",
            )],
            "shadow",
            &[("main.R", 2)],
        ),
        (
            "a quoted list tag that removes a second name",
            &[(
                "main.R",
                "shadow <- 1\ndummy <- 0\nrm(dummy, \"list\" = \"shadow\")\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
            )],
            "shadow",
            &[("main.R", 6)],
        ),
        (
            "a print method that is source()",
            &[
                (
                    "main.R",
                    "shadow <- 1\nprint.character <- source\nprint(\"drop.R\")\nlocal({\n  shadow <- 2\n  rm(shadow)\n  print(shadow)\n})\n",
                ),
                ("drop.R", "rm(shadow)\n"),
            ],
            "shadow",
            &[("main.R", 6)],
        ),
        (
            "a function body's function removed through rm()'s dots",
            &[(
                "main.R",
                "`gizmo<-` <- function(x, value) value\nf <- function() {\n  `gizmo<-` <- function(x, value) value\n  rm(tag = `gizmo<-`)\n  x <- 0\n  gizmo(x) <- 42\n  print(x)\n}\nrm(list = \"gizmo<-\")\nf()\n",
            )],
            "gizmo",
            &[("main.R", 5)],
        ),
        (
            "a replacement call that local() runs in the global environment",
            &[(
                "main.R",
                "`gizmo<-` <- function(x, value) value\nrm(list = \"gizmo<-\")\nx <- 0\nf <- function() {\n  `gizmo<-` <- function(x, value) value\n  local(gizmo(x) <- 42, envir = .GlobalEnv)\n}\nf()\n",
            )],
            "gizmo",
            &[("main.R", 5)],
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
