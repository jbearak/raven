//! End-to-end checks that global assignments made outside the global frame
//! define their name for the rest of the run.
//!
//! Covers `assign("name", value, envir = globalenv())` (or `.GlobalEnv`),
//! `name <<- value`, and calls whose destination is the global environment by
//! default or by argument (`data()`, `delayedAssign(assign.env =)`,
//! write-mode `textConnection()`, `rm(envir =)`) running inside `local()`, or
//! at the top level of a file that a caller sources with `local = TRUE` from
//! inside `local()`. Every fixture is synthetic and runs through
//! `raven check --format json`.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `(path, 0-based line, message)` for every undefined-variable diagnostic
/// about one of `probes` ("not defined", or "used before it is defined" for a
/// same-file read before the definition). Filtering by name keeps the result
/// independent of whether R is installed to resolve base functions.
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
        .map(|row| {
            (
                row["path"].as_str().unwrap().replace('\\', "/"),
                row["diagnostic"]["range"]["start"]["line"]
                    .as_u64()
                    .unwrap(),
                row["diagnostic"]["message"].as_str().unwrap().to_owned(),
            )
        })
        .filter(|(_, _, message)| {
            probes.iter().any(|probe| {
                message == &format!("{probe} is not defined")
                    || message.starts_with(&format!("{probe} is used before it is defined"))
            })
        })
        .collect();
    found.sort();
    found
}

fn row(path: &str, line: u64, name: &str) -> (String, u64, String) {
    (path.into(), line, format!("{name} is not defined"))
}

#[test]
fn global_assign_inside_local_defines_name_after_the_call() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"print(via_globalenv)
local({ assign("via_globalenv", 1, envir = globalenv()) })
print(via_globalenv)
local({ assign("via_dot_global", 1, envir = .GlobalEnv) })
print(via_dot_global)
local({ via_superassign <<- 1 })
print(via_superassign)
make_value <- function() 2
local({
  value <- make_value()
  assign("after_call", value, envir = globalenv())
  assign("second", value, envir = globalenv())
})
print(after_call)
print(second)
"#,
    );
    assert_eq!(
        undefined(
            dir.path(),
            &[
                "via_globalenv",
                "via_dot_global",
                "via_superassign",
                "after_call",
                "second",
            ],
        ),
        vec![(
            "main.R".into(),
            0,
            "via_globalenv is used before it is defined (defined on line 2)".into(),
        )],
        "only the read before the local() call is undefined"
    );
}

#[test]
fn non_global_or_dynamic_assignments_inside_local_define_nothing() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"target <- "dynamic_name"
local({ assign(target, 1, envir = globalenv()) })
print(dynamic_name)
local({ assign("other_env", 1, envir = new.env()) })
print(other_env)
outer <- function() {
  bound_by_function <- 0
  local({ bound_by_function <<- 1 })
  bound_by_function
}
outer()
print(bound_by_function)
"#,
    );
    assert_eq!(
        undefined(
            dir.path(),
            &["dynamic_name", "other_env", "bound_by_function"]
        ),
        vec![
            row("main.R", 2, "dynamic_name"),
            row("main.R", 4, "other_env"),
            row("main.R", 11, "bound_by_function"),
        ]
    );
}

#[test]
fn local_source_brings_back_the_childs_global_assignments() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"print(from_assign)
local({ source("R/assign_global.R", local = TRUE) })
print(from_assign)
local({ source("R/superassign.R", local = TRUE) })
print(from_superassign)
local({ source("R/dot_global.R", local = TRUE) })
print(from_dot_global)
source("R/top_level.R", local = TRUE)
print(from_top_level)
"#,
    );
    // Each child also reads its name after the assignment: the rest of the
    // child sees it too.
    write(
        dir.path(),
        "R/assign_global.R",
        "assign(\"from_assign\", 1, envir = globalenv())\nprint(from_assign)\n",
    );
    write(
        dir.path(),
        "R/superassign.R",
        "from_superassign <<- 1\nprint(from_superassign)\n",
    );
    write(
        dir.path(),
        "R/dot_global.R",
        "compute <- function() 2\nvalue <- compute()\n\
         assign(\"from_dot_global\", value, envir = .GlobalEnv)\nprint(from_dot_global)\n",
    );
    write(
        dir.path(),
        "R/top_level.R",
        "assign(\"from_top_level\", 1, envir = globalenv())\n",
    );
    assert_eq!(
        undefined(
            dir.path(),
            &[
                "from_assign",
                "from_superassign",
                "from_dot_global",
                "from_top_level",
            ],
        ),
        vec![row("main.R", 0, "from_assign")],
        "only the read before the source() call is undefined"
    );
}

#[test]
fn local_source_does_not_bring_back_other_child_definitions() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"local({ source("R/child.R", local = TRUE) })
print(ordinary)
print(dynamic_name)
print(other_env)
print(bound_by_function)
print(bound_by_outer_local)
"#,
    );
    write(
        dir.path(),
        "R/child.R",
        r#"ordinary <- 1
target <- "dynamic_name"
assign(target, 1, envir = globalenv())
assign("other_env", 1, envir = new.env())
outer <- function() {
  bound_by_function <- 0
  inner <- function() bound_by_function <<- 1
  inner()
}
outer()
local({
  bound_by_outer_local <- 0
  local({ bound_by_outer_local <<- 1 })
})
"#,
    );
    assert_eq!(
        undefined(
            dir.path(),
            &[
                "ordinary",
                "dynamic_name",
                "other_env",
                "bound_by_function",
                "bound_by_outer_local",
            ],
        ),
        vec![
            row("main.R", 1, "ordinary"),
            row("main.R", 2, "dynamic_name"),
            row("main.R", 3, "other_env"),
            row("main.R", 4, "bound_by_function"),
            row("main.R", 5, "bound_by_outer_local"),
        ]
    );
}

/// Calls that put a binding in the global environment, by default or by
/// argument, define it after a `local()` block, as they do in R. The same
/// calls aimed at the block's own frame keep the binding in the block. Each
/// of those is in its own file, and the positive cases use `base::local()`:
/// after a call that may bind any name (such as `data()`), Raven no longer
/// proves a later bare `local` is base's.
#[test]
fn global_destination_calls_inside_local_define_name_after_the_block() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"base::local({ data(raven_dataset, package = "ravenpkg") })
print(raven_dataset)
base::local({ delayedAssign("delayed_global", 42, assign.env = globalenv()) })
print(delayed_global)
base::local({ connection <- textConnection("captured", "w"); close(connection) })
print(captured)
"#,
    );
    // An earlier `delayedAssign()` anywhere in the file stops Raven proving
    // a later `.GlobalEnv` unshadowed, so this one gets its own file.
    write(
        dir.path(),
        "partial.R",
        "base::local({ delayedAssign(\"delayed_partial\", 42, assign = .GlobalEnv) })\n\
         print(delayed_partial)\n",
    );
    write(
        dir.path(),
        "data_block.R",
        "local({ data(block_dataset, envir = environment()); print(block_dataset) })\n\
         print(block_dataset)\n",
    );
    write(
        dir.path(),
        "delayed_block.R",
        "local({ delayedAssign(\"delayed_block\", 1); print(delayed_block) })\n\
         print(delayed_block)\n",
    );
    write(
        dir.path(),
        "connection_block.R",
        "local({ connection <- textConnection(\"captured_block\", \"w\", local = TRUE) })\n\
         print(captured_block)\n",
    );
    assert_eq!(
        undefined(
            dir.path(),
            &[
                "raven_dataset",
                "delayed_global",
                "delayed_partial",
                "captured",
                "block_dataset",
                "delayed_block",
                "captured_block",
            ],
        ),
        vec![
            row("connection_block.R", 1, "captured_block"),
            row("data_block.R", 1, "block_dataset"),
            row("delayed_block.R", 1, "delayed_block"),
        ]
    );
}

/// `rm(envir = globalenv())` or `rm(pos = 1)` inside `local()` removes the
/// global binding, so a later read is reported; a plain `rm()` there removes
/// only the block's own binding.
#[test]
fn global_removal_inside_local_removes_the_global_binding() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"gone <- 1
local({ rm(gone, envir = globalenv()) })
print(gone)
gone_pos <- 1
local({ rm(gone_pos, pos = 1) })
print(gone_pos)
kept <- 1
local({ kept <- 2; rm(kept) })
print(kept)
local({ shadow <- 2; rm(shadow, envir = globalenv()); print(shadow) })
"#,
    );
    // With `globalenv` rebound the destination is unknown: neither the
    // block's binding nor the global one is removed.
    write(
        dir.path(),
        "rebound.R",
        r#"other <- new.env()
globalenv <- function() other
probe <- 1
base::local({
  probe <- 2
  rm(probe, envir = globalenv())
  print(probe)
})
print(probe)
"#,
    );
    assert_eq!(
        undefined(dir.path(), &["gone", "gone_pos", "kept", "shadow", "probe"]),
        vec![row("main.R", 2, "gone"), row("main.R", 5, "gone_pos")]
    );
}

/// The child of a `local()`-block `source(local = TRUE)` puts these bindings
/// in the global environment too, and a plain `source()` of a file whose own
/// `local()` block calls `data()` lends the dataset.
#[test]
fn local_source_brings_back_the_childs_global_destination_calls() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "main.R",
        r#"local({ source("R/child.R", local = TRUE) })
print(child_dataset)
print(child_captured)
print(child_delayed)
print(child_ordinary)
source("R/data_in_local.R")
print(nested_dataset)
"#,
    );
    write(
        dir.path(),
        "R/child.R",
        r#"data(child_dataset)
connection <- textConnection("child_captured", "w")
close(connection)
delayedAssign("child_delayed", 1, assign.env = globalenv())
child_ordinary <- 1
"#,
    );
    write(
        dir.path(),
        "R/data_in_local.R",
        "local({ data(nested_dataset) })\n",
    );
    assert_eq!(
        undefined(
            dir.path(),
            &[
                "child_dataset",
                "child_captured",
                "child_delayed",
                "child_ordinary",
                "nested_dataset",
            ],
        ),
        vec![row("main.R", 4, "child_ordinary")]
    );
}
