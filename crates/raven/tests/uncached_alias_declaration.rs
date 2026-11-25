//! An alias to a package that no checked file attaches,
//! `pick <- pkga::pick`: Raven reads pkga's `raven/nse.toml` for calls of the
//! alias without loading pkga (issue #900, 1a), next to the nearest programs
//! R stops on, which it still reports.
//!
//! Each fixture was run in R 4.6.2 against real packages built like the fake
//! ones here, with `Rscript --vanilla -e 'source("main.R")'`. A comment on
//! each case says what R did. What the tables assert is the names
//! `raven check` calls undefined in the same files.
//!
//! The fake library is the one `package_declaration_choice.rs` uses:
//!
//! - `pkga` exports `%where%` and `pick`, captures their second argument, and
//!   declares that in `raven/nse.toml`.
//! - `pkgb` exports the same two names, forces the second argument, and
//!   declares nothing.
//!
//! plus `pkgs`, which declares both an `[[operator]]` form and a
//! `[[function]]` policy for its `%set%`.
//!
//! As there, the harness appends an undefined `live_control` to every R file
//! and requires a report for each, so "nothing reported" can't mean "file not
//! analyzed". A case whose result comes from pkga's declaration also says
//! what is reported once pkga declares nothing, and the harness checks that
//! against a second library.
//!
//! The binary runs with a cleared environment and an R path that doesn't
//! exist, so the fake library is the only one.

use std::path::Path;
use std::process::Command;

const PKGA_SIDECAR: &str = r#"schema = 1

[[function]]
name = "%where%"
formals = ["data", "cond"]
captured = ["cond"]

[[function]]
name = "pick"
formals = ["data", "cond"]
captured = ["cond"]
"#;

const PKGS_SIDECAR: &str = r#"schema = 1

[[operator]]
name = "%set%"
form = "subset-assign"

[[function]]
name = "%set%"
formals = ["x", "value"]
captured = ["value"]
"#;

/// The name the harness appends to every R file.
const LIVE_CONTROL: &str = "live_control";

struct Case {
    name: &'static str,
    /// The workspace: `--- <path>` starts a file, the lines up to the next
    /// header are its text.
    files: &'static str,
    /// The undefined names Raven reports, [`LIVE_CONTROL`] aside.
    reported: &'static [&'static str],
    /// The names it reports once pkga declares nothing, for a case whose
    /// result depends on that declaration.
    undeclared: Option<&'static [&'static str]>,
}

/// A case that doesn't depend on pkga's declaration.
const fn case(name: &'static str, files: &'static str, reported: &'static [&'static str]) -> Case {
    Case {
        name,
        files,
        reported,
        undeclared: None,
    }
}

/// A case that reports `reported` because of pkga's declaration, and
/// `undeclared` without it.
const fn declared(
    name: &'static str,
    files: &'static str,
    reported: &'static [&'static str],
    undeclared: &'static [&'static str],
) -> Case {
    Case {
        name,
        files,
        reported,
        undeclared: Some(undeclared),
    }
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// `declaring` is whether pkga ships its `raven/nse.toml`.
fn install_fake_packages(lib: &Path, declaring: bool) {
    let exports = "export(\"%where%\")\nexport(pick)\n";
    write(lib, "pkga/DESCRIPTION", "Package: pkga\nVersion: 0.1.0\n");
    write(lib, "pkga/NAMESPACE", exports);
    if declaring {
        write(lib, "pkga/raven/nse.toml", PKGA_SIDECAR);
    }
    write(lib, "pkgb/DESCRIPTION", "Package: pkgb\nVersion: 0.1.0\n");
    write(lib, "pkgb/NAMESPACE", exports);
    write(lib, "pkgs/DESCRIPTION", "Package: pkgs\nVersion: 0.1.0\n");
    write(lib, "pkgs/NAMESPACE", "export(\"%set%\")\n");
    write(lib, "pkgs/raven/nse.toml", PKGS_SIDECAR);
}

/// The fixture's files as `(path, text)`.
fn parse_files(fixture: &str) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = Vec::new();
    for line in fixture.lines() {
        if let Some(path) = line.strip_prefix("--- ") {
            files.push((path.to_owned(), String::new()));
        } else if let Some((_, text)) = files.last_mut() {
            text.push_str(line);
            text.push('\n');
        }
    }
    files
}

/// The undefined names `raven check` reports in the case's workspace with
/// `lib` as the only package library, [`LIVE_CONTROL`] aside.
fn undefined_names(case: &Case, lib: &Path) -> Result<Vec<String>, String> {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("ws");
    let home = dir.path().join("home");
    let empty_path = dir.path().join("bin");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&empty_path).unwrap();

    let mut r_files = Vec::new();
    for (path, mut text) in parse_files(case.files) {
        if path.ends_with(".R") {
            text.push_str(LIVE_CONTROL);
            text.push('\n');
            r_files.push(path.clone());
        }
        write(&root, &path, &text);
    }
    assert!(!r_files.is_empty(), "{}: no R file", case.name);
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
        .args(["--format", "json", "--max-severity", "error"])
        .env_clear()
        .env("NO_COLOR", "1")
        .env("PATH", &empty_path)
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .output()
        .unwrap();
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(format!(
            "{}: raven failed: {}",
            case.name,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("{}: unreadable output: {e}", case.name))?;
    let mut undefined: Vec<(String, String)> = rows
        .iter()
        .filter(|row| row["diagnostic"]["code"] == "undefined-variable")
        .map(|row| {
            let message = row["diagnostic"]["message"].as_str().unwrap();
            (
                row["path"].as_str().unwrap().replace('\\', "/"),
                message
                    .strip_suffix(" is not defined")
                    .unwrap_or(message)
                    .to_owned(),
            )
        })
        .collect();

    for file in &r_files {
        let control = (file.clone(), LIVE_CONTROL.to_owned());
        match undefined.iter().position(|row| *row == control) {
            Some(index) => {
                undefined.remove(index);
            }
            None => return Err(format!("{}: {file} was not analyzed", case.name)),
        }
    }
    let mut names: Vec<String> = undefined.into_iter().map(|(_, name)| name).collect();
    names.sort_unstable();
    Ok(names)
}

/// Compare what Raven reports for the case with the expectation, in the
/// declaring library and, where the case says so, in the other one.
fn run(case: &Case, declaring: &Path, undeclaring: &Path) -> Result<(), String> {
    let sorted = |names: &[&'static str]| {
        let mut names = names.to_vec();
        names.sort_unstable();
        names
    };
    let reported = undefined_names(case, declaring)?;
    let expected = sorted(case.reported);
    if reported != expected {
        return Err(format!(
            "{}: reported {reported:?}, expected {expected:?}",
            case.name
        ));
    }
    if let Some(undeclared) = case.undeclared {
        let reported = undefined_names(case, undeclaring)?;
        let expected = sorted(undeclared);
        if reported != expected {
            return Err(format!(
                "{}: without pkga's declaration reported {reported:?}, expected {expected:?}",
                case.name
            ));
        }
    }
    Ok(())
}

/// Run every case, a few at a time, and fail with all the mismatches.
fn check(cases: &[Case]) {
    let lib_dir = tempfile::tempdir().unwrap();
    let declaring = &lib_dir.path().join("declaring");
    let undeclaring = &lib_dir.path().join("undeclaring");
    install_fake_packages(declaring, true);
    install_fake_packages(undeclaring, false);
    let workers = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
    let chunk = cases.len().div_ceil(workers).max(1);
    let failures: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = cases
            .chunks(chunk)
            .map(|batch| {
                scope.spawn(move || {
                    batch
                        .iter()
                        .filter_map(|case| run(case, declaring, undeclaring).err())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap())
            .collect()
    });
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// An alias to a package no checked file attaches. `raven check` never
/// loaded such a package, so it knew no declaration for the alias and
/// reported the captured argument (issue #900, 1a). The package's
/// declaration is now read for the alias alone, and applies to calls
/// written below an alias that is bound unconditionally.
#[test]
fn an_alias_to_a_package_nothing_attaches_uses_its_declaration() {
    check(&[
        // R: runs.
        declared(
            "operator_alias",
            r#"
--- main.R
library(pkgb)
`%where%` <- pkga::`%where%`
1 %where% a_post
"#,
            &[],
            &["a_post"],
        ),
        // R: runs.
        declared(
            "function_alias",
            r#"
--- main.R
library(pkgb)
pick <- pkga::pick
pick(1, a_fn)
"#,
            &[],
            &["a_fn"],
        ),
        // R: runs. `requireNamespace()` is not a load Raven tracks.
        declared(
            "operator_alias_after_require_namespace",
            r#"
--- main.R
requireNamespace("pkga", quietly = TRUE)
`%where%` <- pkga::`%where%`
1 %where% a_reqns
"#,
            &[],
            &["a_reqns"],
        ),
        // R: object 'a_l' not found, and object 'a_d' not found. The
        // argument pkga evaluates is still checked.
        declared(
            "evaluated_arguments_are_checked",
            r#"
--- main.R
`%where%` <- pkga::`%where%`
pick <- pkga::pick
a_l %where% a_r
pick(a_d, a_c)
"#,
            &["a_l", "a_d"],
            &["a_l", "a_r", "a_d", "a_c"],
        ),
        // R: object 'a_strict' not found, and object 'a_fstrict' not found.
        case(
            "alias_to_the_forcing_package",
            r#"
--- main.R
`%where%` <- pkgb::`%where%`
pick <- pkgb::pick
1 %where% a_strict
pick(1, a_fstrict)
"#,
            &["a_strict", "a_fstrict"],
        ),
        // R: object 'a_pre_c' not found. The calls run under pkgb, above
        // the aliases. (With pkga in the package cache the second argument
        // goes unreported: the later-alias limitation that
        // `package_declaration_choice.rs` pins. Reading the declaration for
        // an uncached package doesn't widen it.)
        case(
            "calls_above_the_alias",
            r#"
--- main.R
library(pkgb)
a_pre_d %where% a_pre_c
pick(a_pre_fd, a_pre_fc)
`%where%` <- pkga::`%where%`
pick <- pkga::pick
"#,
            &["a_pre_d", "a_pre_c", "a_pre_fd", "a_pre_fc"],
        ),
        // R: object 'a_two' not found. `f()` runs under the first alias.
        case(
            "function_body_with_two_aliases",
            r#"
--- main.R
`%where%` <- pkgb::`%where%`
pick <- pkgb::pick
f <- function() 1 %where% a_two
g <- function() pick(1, a_two_fn)
f()
g()
`%where%` <- pkga::`%where%`
pick <- pkga::pick
"#,
            &["a_two", "a_two_fn"],
        ),
        // R: object 'a_inner' not found.
        case(
            "enclosing_function_rebinds_the_alias",
            r#"
--- main.R
pick <- pkga::pick
`%where%` <- pkga::`%where%`
g <- function() {
  pick <- function(a, b) { force(b); a }
  `%where%` <- function(a, b) { force(b); a }
  pick(1, a_inner)
  1 %where% a_inner_op
}
g()
"#,
            &["a_inner", "a_inner_op"],
        ),
        // R: object 'a_formal' not found.
        case(
            "enclosing_function_takes_the_alias_as_a_formal",
            r#"
--- main.R
pick <- pkga::pick
g <- function(pick) pick(1, a_formal)
g(function(a, b) { force(b); a })
"#,
            &["a_formal"],
        ),
        // R: object 'a_called' not found. `f()` runs under pkgb, above the alias.
        case(
            "function_called_above_the_alias",
            r#"
--- main.R
library(pkgb)
f <- function() 1 %where% a_called
f()
`%where%` <- pkga::`%where%`
"#,
            &["a_called"],
        ),
        // R: object 'a_called_fn' not found.
        case(
            "function_called_above_the_function_alias",
            r#"
--- main.R
library(pkgb)
f <- function() pick(1, a_called_fn)
f()
pick <- pkga::pick
"#,
            &["a_called_fn"],
        ),
        // R: object 'a_wrap' not found.
        case(
            "function_called_through_a_wrapper_above_the_alias",
            r#"
--- main.R
library(pkgb)
g <- function() f()
f <- function() 1 %where% a_wrap
g()
`%where%` <- pkga::`%where%`
"#,
            &["a_wrap"],
        ),
        // R: object 'a_lam' not found.
        case(
            "anonymous_function_above_the_alias",
            r#"
--- main.R
library(pkgb)
sapply(1, function(i) 1 %where% a_lam)
`%where%` <- pkga::`%where%`
"#,
            &["a_lam"],
        ),
        // R: object 'a_loop_b' not found, on the first pass.
        case(
            "loop_above_the_alias_under_a_forcing_package",
            r#"
--- main.R
library(pkgb)
d <- 1
for (i in 1:2) {
  d %where% a_loop_b
  `%where%` <- pkga::`%where%`
}
"#,
            &["a_loop_b"],
        ),
        // R: runs.
        declared(
            "function_below_the_alias",
            r#"
--- main.R
library(pkgb)
`%where%` <- pkga::`%where%`
f <- function() 1 %where% a_below
f()
"#,
            &[],
            &["a_below"],
        ),
        // R: object 'a_branch' not found, under pkgb.
        case(
            "alias_in_a_branch_not_taken",
            r#"
--- main.R
library(pkgb)
if (FALSE) pick <- pkga::pick
pick(1, a_branch)
"#,
            &["a_branch"],
        ),
        // R: object 'a_rm' not found, under pkgb.
        case(
            "alias_removed",
            r#"
--- main.R
library(pkgb)
pick <- pkga::pick
rm(pick)
pick(1, a_rm)
"#,
            &["a_rm"],
        ),
        // R: object 'a_src' not found.
        case(
            "alias_replaced_by_a_sourced_file",
            r#"
--- main.R
pick <- pkga::pick
source("helpers.R")
pick(1, a_src)
--- helpers.R
pick <- function(x, y) y
"#,
            &["a_src"],
        ),
        // R: object 'a_partial' not found. `co` matches `cond`, so the other
        // argument is `data`.
        case(
            "argument_label_that_matches_a_formal_by_prefix",
            r#"
--- main.R
pick <- pkga::pick
pick(co = 1, a_partial)
"#,
            &["a_partial"],
        ),
        // R: object 'a_src_rm' not found, under pkgb.
        case(
            "alias_removed_by_a_sourced_file",
            r#"
--- main.R
library(pkgb)
pick <- pkga::pick
source("remove.R")
pick(1, a_src_rm)
--- remove.R
rm(pick)
"#,
            &["a_src_rm"],
        ),
        // R: object 'a_rm_str' not found, under pkgb.
        case(
            "alias_removed_by_name_in_a_string",
            r#"
--- main.R
library(pkgb)
pick <- pkga::pick
rm(list = r"(pick)")
pick(1, a_rm_str)
"#,
            &["a_rm_str"],
        ),
        // R: object 'a_body' not found.
        case(
            "alias_body_replaced",
            r#"
--- main.R
pick <- pkga::pick
body(pick) <- quote(cond)
pick(1, a_body)
"#,
            &["a_body"],
        ),
        // R: object 'a_env' not found.
        case(
            "alias_replaced_through_the_environment",
            r#"
--- main.R
pick <- pkga::pick
.GlobalEnv$pick <- pkgb::pick
pick(1, a_env)
"#,
            &["a_env"],
        ),
        // R: object 'a_dots' not found. The forwarded `cond = 1` leaves the other
        // argument as `data`.
        case(
            "call_that_forwards_dots",
            r#"
--- main.R
pick <- pkga::pick
f <- function(...) pick(..., a_dots)
f(cond = 1)
"#,
            &["a_dots"],
        ),
        // R: object 'a_pipe' not found. The placeholder takes the second slot.
        case(
            "call_fed_by_a_pipe_with_a_placeholder",
            r#"
--- main.R
library(magrittr)
pick <- pkga::pick
1 %>% pick(a_pipe, .)
"#,
            &["a_pipe"],
        ),
    ]);
}

/// Programs R stops on that go unreported once the alias's declaration is
/// read. Each is equally unreported on main whenever pkga is in the package
/// cache (a `library(pkga)` in any checked file, or the language server), so
/// reading the declaration gives `raven check` the answer it already gave
/// there. The guards that keep the new path narrower than the cached one
/// don't reach these.
#[test]
fn programs_r_stops_on_that_the_alias_hides_as_it_does_with_the_package_cached() {
    check(&[
        // R: object 't_dots' not found. The backticked dots forward
        // `cond = 1`, so the other argument is `data`.
        declared(
            "backticked_dots",
            r#"
--- main.R
pick <- pkga::pick
f <- function(...) pick(`...`, t_dots)
f(cond = 1)
"#,
            &[],
            &["t_dots"],
        ),
        // R: object 't_inject' not found. `inject()` evaluates `!!t_inject`
        // before `pick` is called.
        declared(
            "injected_argument",
            r#"
--- main.R
pick <- pkga::pick
rlang::inject(pick(1, !!t_inject))
"#,
            &[],
            &["t_inject"],
        ),
        // R: object 't_assign' not found. The name of the replaced binding is
        // put together at run time.
        declared(
            "alias_replaced_under_a_computed_name",
            r#"
--- main.R
library(pkgb)
pick <- pkga::pick
assign(paste0("pi", "ck"), pkgb::pick)
pick(1, t_assign)
"#,
            &[],
            &["t_assign"],
        ),
    ]);
}

/// A package that declares both an `[[operator]]` form and a `[[function]]`
/// policy for one operator. With the package cached the form reads
/// `x[...] OP value` and still checks the call heads in `value`. The
/// uncached read must not apply the function policy in its place, which
/// would skip `value` whole. (pkgs is not a real package; this pins the two
/// lookups against each other, not against R.)
#[test]
fn an_uncached_alias_never_skips_more_than_the_cached_one() {
    check(&[
        case(
            "operator_form_uncached",
            r#"
--- main.R
`%set%` <- pkgs::`%set%`
x <- 1
x[1, s_col] %set% s_typo_fn(s_v)
"#,
            &["s_col", "s_typo_fn"],
        ),
        case(
            "operator_form_cached",
            r#"
--- main.R
`%set%` <- pkgs::`%set%`
x <- 1
x[1, s_col] %set% s_typo_fn(s_v)
--- warm.R
library(pkgs)
"#,
            &["s_typo_fn"],
        ),
    ]);
}
