//! Which package's `raven/nse.toml` declaration applies to a call, checked
//! against what R does with the same files (issue #883).
//!
//! Three fake installed packages stand in for the real ones:
//!
//! - `pkga` exports `%where%` and `pick`, captures their second argument, and
//!   declares that in `raven/nse.toml`.
//! - `pkgb` exports the same two names, forces the second argument, and
//!   declares nothing.
//! - `wrapplain` exports `wrap_id` and lists pkgb under `Depends:`.
//!
//! Stubs of targets and testthat export the few names the fixtures call.
//!
//! Five more stand in for issue #900's packages, in which two attached
//! packages both declare the same name:
//!
//! - `aa884` exports `%pick884%`, which evaluates its right operand, and
//!   declares the left one captured.
//! - `zz884` exports `%pick884%`, which never evaluates its right operand,
//!   and declares that one captured.
//! - `zmask900` exports `%pick884%`, which evaluates its right operand in a
//!   data mask. Its declaration is the same as zz884's.
//! - `ap900` exports `pick900(d, v)`, which never evaluates `v`, and declares
//!   `v` captured.
//! - `zp900` exports `pick900(d, v)`, which evaluates `v`, and declares `d`
//!   captured.
//!
//! Each fixture below was run in R 4.6.2 against real packages built that
//! way: `Rscript --vanilla -e 'source("main.R")'` (or `"_targets.R"`), the
//! package's exported `f(1)`, or `testthat::test_local()`, as the fixture
//! needs. What the tables assert is the names `raven check` calls undefined
//! in the same files.
//!
//! Three of the tests hold programs R runs to completion. In all of them
//! the function R calls captures its second argument (pkga's, or in one
//! fixture the file's own), so nothing may be reported. Each one defeats
//! some rule for picking the declaration from the text of the file, such as
//! "the last `library()` call wins" or "a namespace load doesn't count".
//! [`programs_r_stops_on_apply_the_declaration_anyway`] holds the three kinds
//! of program from issue #883, which R stops on and Raven doesn't report, and
//! says why they stay that way. The last test pins issue #900's programs.
//!
//! Two checks keep a fixture from passing for the wrong reason. The harness
//! appends an undefined `live_control` to every R file, which R never saw,
//! and requires a report for each, so "nothing reported" can't mean "file
//! not analyzed". And it runs every fixture that expects no report a second
//! time against a library where no package ships a declaration, and
//! requires Raven to report exactly the names the declarations hide, so the
//! silence is a declaration's and not a call Raven skips anyway.
//!
//! The binary runs with a cleared environment and an R path that doesn't
//! exist, so the fake library is the only one.

use std::path::Path;
use std::process::Command;

/// Prepended to every fixture `DESCRIPTION`, which lists only the fields
/// that vary.
const DESCRIPTION_HEAD: &str = "Package: casepkg\nVersion: 0.1.0\nTitle: t\nDescription: t.\n\
                                License: MIT\nAuthor: x\nMaintainer: x <x@x.x>\n";

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

/// `name` declared with the formals `formals` and the one captured formal
/// `captured`.
fn one_capture_sidecar(name: &str, formals: [&str; 2], captured: &str) -> String {
    format!(
        "schema = 1\n\n[[function]]\nname = \"{name}\"\nformals = [\"{}\", \"{}\"]\ncaptured = [\"{captured}\"]\n",
        formals[0], formals[1]
    )
}

/// The name the harness appends to every R file.
const LIVE_CONTROL: &str = "live_control";

struct Case {
    name: &'static str,
    /// The workspace: `--- <path>` starts a file, the lines up to the next
    /// header are its text.
    files: &'static str,
    /// The undefined names Raven reports, [`LIVE_CONTROL`] aside.
    reported: &'static [&'static str],
    /// For a case that reports nothing: the names Raven reports once pkga
    /// declares nothing, which are the ones the declaration hides.
    hidden: &'static [&'static str],
}

/// A case Raven reports nothing for, because pkga's declaration hides
/// `hidden`.
const fn quiet(name: &'static str, files: &'static str, hidden: &'static [&'static str]) -> Case {
    Case {
        name,
        files,
        reported: &[],
        hidden,
    }
}

const fn reports(
    name: &'static str,
    files: &'static str,
    reported: &'static [&'static str],
) -> Case {
    Case {
        name,
        files,
        reported,
        hidden: &[],
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
    write(
        lib,
        "wrapplain/DESCRIPTION",
        "Package: wrapplain\nVersion: 0.1.0\nDepends: pkgb\n",
    );
    write(lib, "wrapplain/NAMESPACE", "export(wrap_id)\n");
    // Issue #900's packages: two declarations for one name.
    for (package, name, formals, captured) in [
        ("aa884", "%pick884%", ["x", "y"], "x"),
        ("zz884", "%pick884%", ["x", "y"], "y"),
        ("zmask900", "%pick884%", ["x", "y"], "y"),
        ("ap900", "pick900", ["d", "v"], "v"),
        ("zp900", "pick900", ["d", "v"], "d"),
    ] {
        write(
            lib,
            &format!("{package}/DESCRIPTION"),
            &format!("Package: {package}\nVersion: 0.1.0\n"),
        );
        write(
            lib,
            &format!("{package}/NAMESPACE"),
            &format!("export(\"{name}\")\n"),
        );
        if declaring {
            write(
                lib,
                &format!("{package}/raven/nse.toml"),
                &one_capture_sidecar(name, formals, captured),
            );
        }
    }
    // The two real packages the fixtures call into.
    write(
        lib,
        "targets/DESCRIPTION",
        "Package: targets\nVersion: 0.1.0\n",
    );
    write(lib, "targets/NAMESPACE", "export(tar_source)\n");
    write(
        lib,
        "testthat/DESCRIPTION",
        "Package: testthat\nVersion: 0.1.0\n",
    );
    write(
        lib,
        "testthat/NAMESPACE",
        "export(test_that)\nexport(expect_true)\n",
    );
}

/// The fixture's files as `(path, text)`.
fn parse_files(fixture: &str) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = Vec::new();
    for line in fixture.lines() {
        if let Some(path) = line.strip_prefix("--- ") {
            let head = if path == "DESCRIPTION" {
                DESCRIPTION_HEAD
            } else {
                ""
            };
            files.push((path.to_owned(), head.to_owned()));
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

/// Compare what Raven reports for the case with the expectation. A case
/// that expects no report must report exactly its hidden names once pkga
/// declares nothing.
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
    if expected.is_empty() {
        assert!(!case.hidden.is_empty(), "{}: no hidden names", case.name);
        let undeclared = undefined_names(case, undeclaring)?;
        let hidden = sorted(case.hidden);
        if undeclared != hidden {
            return Err(format!(
                "{}: without package declarations reported {undeclared:?}, expected {hidden:?}",
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

/// The fixtures aren't quiet because nothing is checked. Where R reaches a
/// function that forces its argument and R stops on the undefined name,
/// Raven reports that name.
#[test]
fn a_forced_argument_is_reported() {
    check(&[
        // pkgb alone: R stops on the right operand.
        reports(
            "undeclared_operator_alone",
            r#"
--- main.R
library(pkgb)
d <- 1
d %where% m1_only
"#,
            &["m1_only"],
        ),
        // The same for an ordinary function.
        reports(
            "undeclared_function_alone",
            r#"
--- main.R
library(pkgb)
d <- 1
pick(d, f1_only)
"#,
            &["f1_only"],
        ),
        // `conflicts_prefer()` names pkga's operator, but pkga isn't attached.
        reports(
            "undeclared_operator_preferred_but_not_attached",
            r#"
--- main.R
library(pkgb)
conflicted::conflicts_prefer(pkga::`%where%`)
d <- 1
d %where% c1_conflicted
"#,
            &["c1_conflicted"],
        ),
        // The file's own strict operator is defined before `f` runs.
        reports(
            "strict_definition_before_the_function_runs",
            r#"
--- main.R
library(pkga)
f <- function() 1 %where% m3_called
`%where%` <- function(x, y) force(y)
f()
"#,
            &["m3_called"],
        ),
    ]);
}

/// pkga and pkgb both provide `%where%` somewhere in the program, and R
/// calls pkga's. Which one R calls depends on the order the packages were
/// first attached, by whom, with which `library()` arguments, and on what
/// was attached, detached or rebound by code the file doesn't show. Scope
/// resolution keeps the attached packages as a set, so the lookup applies
/// pkga's declaration whenever pkga is among them.
#[test]
fn masked_exporter_programs_r_accepts_report_nothing() {
    check(&[
        // pkga is attached last, so its operator masks pkgb's.
        quiet(
            "b_then_a",
            r#"
--- main.R
library(pkgb)
library(pkga)
d <- 1
d %where% m1_ba
"#,
            &["m1_ba"],
        ),
        // pkgb is attached only after the call.
        quiet(
            "call_before_b",
            r#"
--- main.R
library(pkga)
d <- 1
d %where% m1_early
library(pkgb)
"#,
            &["m1_early"],
        ),
        // A second `library(pkgb)` doesn't move pkgb ahead of pkga.
        quiet(
            "reattach",
            r#"
--- main.R
library(pkgb)
library(pkga)
library(pkgb)
d <- 1
d %where% m1_re
"#,
            &["m1_re"],
        ),
        // pkgb is attached without its operator.
        quiet(
            "exclude",
            r#"
--- main.R
library(pkga)
library(pkgb, exclude = "%where%")
d <- 1
d %where% m1_excl
"#,
            &["m1_excl"],
        ),
        // Nothing is attached from pkgb.
        quiet(
            "include_only",
            r#"
--- main.R
library(pkga)
library(pkgb, include.only = character())
d <- 1
d %where% m1_incl
"#,
            &["m1_incl"],
        ),
        // pkgb is attached behind pkga.
        quiet(
            "pos",
            r#"
--- main.R
library(pkga)
library(pkgb, pos = 3)
d <- 1
d %where% m1_pos
"#,
            &["m1_pos"],
        ),
        quiet(
            "require",
            r#"
--- main.R
require(pkgb)
require(pkga)
d <- 1
d %where% m1_req
"#,
            &["m1_req"],
        ),
        // wrapplain `Depends:` on pkgb, so pkgb is attached before pkga and the
        // later `library(pkgb)` changes nothing.
        quiet(
            "wrapper_first",
            r#"
--- main.R
library(wrapplain)
library(pkga)
library(pkgb)
d <- 1
d %where% m1_wrapfirst
"#,
            &["m1_wrapfirst"],
        ),
        // pkgb is already attached when wrapplain asks for it.
        quiet(
            "wrapper_noop",
            r#"
--- main.R
library(pkgb)
library(pkga)
library(wrapplain)
d <- 1
d %where% m1_wrapnoop
"#,
            &["m1_wrapnoop"],
        ),
        // A sourced file attaches pkga after the parent attached pkgb.
        quiet(
            "child_attaches_a",
            r#"
--- main.R
library(pkgb)
source("attach.R")
d <- 1
d %where% m1_childa
--- attach.R
library(pkga)
"#,
            &["m1_childa"],
        ),
        // A sourced file attached pkgb first; the parent's later `library(pkgb)`
        // changes nothing.
        quiet(
            "child_first_b",
            r#"
--- main.R
source("child.R")
library(pkga)
d <- 1
d %where% m1_childfirst
library(pkgb)
--- child.R
library(pkgb)
"#,
            &["m1_childfirst"],
        ),
        // A sourced file attaches both, pkga last; a top-level call and a
        // function body.
        quiet(
            "setup_b_a",
            r#"
--- main.R
source("setup.R")
d <- 1
d %where% m1_setupba
f <- function() d %where% m1_setupba_body
f()
--- setup.R
library(pkgb)
library(pkga)
"#,
            &["m1_setupba", "m1_setupba_body"],
        ),
        // The call is in a child of the file that attaches pkgb, then pkga.
        quiet(
            "parent_b_a",
            r#"
--- main.R
library(pkgb)
library(pkga)
source("child.R")
--- child.R
# raven: sourced-by main.R
d <- 1
d %where% m1_parentba
"#,
            &["m1_parentba"],
        ),
        // `common.R` attaches pkgb and is sourced before and after
        // `library(pkga)`; only the first run attaches.
        quiet(
            "repeated_source",
            r#"
--- main.R
source("a.R")
library(pkga)
source("b.R")
d <- 1
d %where% m1_repeat
--- a.R
source("common.R")
--- b.R
source("common.R")
--- common.R
library(pkgb)
"#,
            &["m1_repeat"],
        ),
        // A function nothing calls sources a file that attaches pkga.
        quiet(
            "uncalled_fn_source",
            r#"
--- main.R
setup <- function() source("setup.R")
library(pkgb)
library(pkga)
d <- 1
d %where% m1_uncalled
--- setup.R
library(pkga)
"#,
            &["m1_uncalled"],
        ),
        // The function runs before pkgb is attached.
        quiet(
            "fn_called_before_b",
            r#"
--- main.R
library(pkga)
f <- function() 1 %where% m1_fnbefore
f()
library(pkgb)
"#,
            &["m1_fnbefore"],
        ),
        // The function attaches pkga itself before its call.
        quiet(
            "body_attaches_a",
            r#"
--- main.R
library(pkgb)
f <- function() {
  library(pkga)
  1 %where% m1_body
}
f()
"#,
            &["m1_body"],
        ),
        // The parent only loads pkga's namespace; the child attaches pkgb, then
        // pkga.
        quiet(
            "parent_ns_only",
            r#"
--- main.R
loadNamespace("pkga")
source("child.R")
--- child.R
library(pkgb)
library(pkga)
1 %where% m1_parentns
"#,
            &["m1_parentns"],
        ),
        // A helper attached pkgb first. The file's own `library()` calls read
        // pkga, pkgb; R's search path has pkga in front.
        quiet(
            "helper_attaches_b",
            r#"
--- main.R
source("helpers.R")
setup()
library(pkga)
library(pkgb)
d <- 1
d %where% m1_helper
--- helpers.R
setup <- function() library(pkgb)
"#,
            &["m1_helper"],
        ),
        // The first attach of pkgb is an argument of another call.
        quiet(
            "suppress_startup",
            r#"
--- main.R
suppressPackageStartupMessages(library(pkgb))
library(pkga)
library(pkgb)
d <- 1
d %where% m1_supp
"#,
            &["m1_supp"],
        ),
        // pkgb is detached before the call.
        quiet(
            "detach_b",
            r#"
--- main.R
library(pkga)
library(pkgb)
detach("package:pkgb")
d <- 1
d %where% m1_detach
"#,
            &["m1_detach"],
        ),
        // conflicted binds pkga's operator ahead of both packages.
        quiet(
            "conflicted",
            r#"
--- main.R
library(pkga)
library(pkgb)
conflicted::conflicts_prefer(pkga::`%where%`)
d <- 1
d %where% m1_conflicted
"#,
            &["m1_conflicted"],
        ),
        // `tar_source()` runs `R/01.R`, then `R/02.R`.
        quiet(
            "tar_b_a",
            r#"
--- _targets.R
library(targets)
tar_source()
d <- 1
d %where% m1_tarba
--- R/01.R
library(pkgb)
--- R/02.R
library(pkga)
"#,
            &["m1_tarba"],
        ),
        // The package imports pkga's operator by name; its function attaches
        // pkgb. Imports are found before the search path.
        quiet(
            "pkg_importfrom_a_body_attaches_b",
            r#"
--- DESCRIPTION
Imports: pkga, pkgb
Suggests: testthat
Config/testthat/edition: 3
--- NAMESPACE
export(f)
importFrom(pkga,"%where%")
--- R/f.R
f <- function(d) {
  library(pkgb)
  d %where% m1_pkg_if
}
"#,
            &["m1_pkg_if"],
        ),
        // The package imports pkga and `Depends:` on pkgb. Imports are found
        // before the search path.
        quiet(
            "pkg_import_a_depends_b",
            r#"
--- DESCRIPTION
Imports: pkga
Depends: pkgb
Suggests: testthat
Config/testthat/edition: 3
--- NAMESPACE
export(f)
import(pkga)
--- R/f.R
f <- function(d) d %where% m1_pkg_iadb
"#,
            &["m1_pkg_iadb"],
        ),
        // `import(pkgb)` then `import(pkga)`: the later import wins.
        quiet(
            "pkg_imports_b_a",
            r#"
--- DESCRIPTION
Imports: pkga, pkgb
Suggests: testthat
Config/testthat/edition: 3
--- NAMESPACE
export(f)
import(pkgb)
import(pkga)
--- R/f.R
f <- function(d) d %where% m1_pkg_ba
"#,
            &["m1_pkg_ba"],
        ),
        // A test of a package that imports pkga attaches pkgb. The call is
        // qualified because Raven doesn't check the body of a bare
        // `test_that()` here.
        quiet(
            "test_import_a_library_b",
            r#"
--- DESCRIPTION
Imports: pkga
Depends: pkgb
Suggests: testthat
Config/testthat/edition: 3
--- NAMESPACE
export(f)
import(pkga)
--- R/f.R
f <- function(d) d
--- tests/testthat/test-op.R
testthat::test_that("operator", {
library(pkgb)
1 %where% m1_test_ia
testthat::expect_true(TRUE)
})
"#,
            &["m1_test_ia"],
        ),
        // A test body attaches pkgb, then pkga.
        quiet(
            "test_body_b_a",
            r#"
--- DESCRIPTION
Imports: stats
Suggests: testthat
Config/testthat/edition: 3
--- NAMESPACE
export(f)

--- R/f.R
f <- function(d) d
--- tests/testthat/test-op.R
testthat::test_that("operator", {
library(pkgb)
library(pkga)
1 %where% m1_test_ba
testthat::expect_true(TRUE)
})
"#,
            &["m1_test_ba"],
        ),
    ]);
}

/// The file loads pkga's namespace and the operator is on the search path
/// anyway, attached in a way `library()` tracking doesn't see.
#[test]
fn namespace_load_programs_r_accepts_report_nothing() {
    check(&[
        // The namespace object is attached.
        quiet(
            "attach_namespace",
            r#"
--- main.R
ns <- loadNamespace("pkga")
attachNamespace(ns)
1 %where% m2_attachns
"#,
            &["m2_attachns"],
        ),
        quiet(
            "attach_namespace_string",
            r#"
--- main.R
loadNamespace("pkga")
attachNamespace("pkga")
1 %where% m2_attachstr
"#,
            &["m2_attachstr"],
        ),
        // The parent loads and attaches; the call is in the child.
        quiet(
            "parent_attach_namespace",
            r#"
--- main.R
ns <- loadNamespace("pkga")
attachNamespace(ns)
source("child.R")
--- child.R
d <- 1
d %where% m2_parentattach
"#,
            &["m2_parentattach"],
        ),
        // A list holding pkga's operator is attached.
        quiet(
            "attach_list",
            r#"
--- main.R
loadNamespace("pkga")
attach(list(`%where%` = pkga::`%where%`))
d <- 1
d %where% m2_attachlist
"#,
            &["m2_attachlist"],
        ),
        // A helper defined in a sourced file attaches the namespace.
        quiet(
            "helper_attaches",
            r#"
--- main.R
source("helper.R")
ns <- loadNamespace("pkga")
use_ns(ns)
1 %where% m2_helper
--- helper.R
use_ns <- function(ns) attachNamespace(ns)
"#,
            &["m2_helper"],
        ),
        quiet(
            "character_only",
            r#"
--- main.R
loadNamespace("pkga")
pkg <- "pkga"
library(pkg, character.only = TRUE)
1 %where% m2_charonly
"#,
            &["m2_charonly"],
        ),
        quiet(
            "do_call",
            r#"
--- main.R
loadNamespace("pkga")
do.call("library", list("pkga"))
1 %where% m2_docall
"#,
            &["m2_docall"],
        ),
        // The child loads and attaches; the call is in the parent.
        quiet(
            "child_attach_namespace",
            r#"
--- main.R
source("child.R")
d <- 1
d %where% m2_childattach
--- child.R
ns <- loadNamespace("pkga")
attachNamespace(ns)
"#,
            &["m2_childattach"],
        ),
        // The parent loads, the child attaches, the parent calls.
        quiet(
            "parent_loads_child_attaches",
            r#"
--- main.R
loadNamespace("pkga")
source("child.R")
d <- 1
d %where% m2_split
--- child.R
attachNamespace("pkga")
"#,
            &["m2_split"],
        ),
        // The child loads and defines `f`; the parent attaches, then calls `f`.
        quiet(
            "child_loads_parent_attaches",
            r#"
--- main.R
source("child.R")
attachNamespace("pkga")
f(1)
--- child.R
loadNamespace("pkga")
f <- function(d) d %where% m2_childfn
"#,
            &["m2_childfn"],
        ),
        // One sourced file loads, the next attaches.
        quiet(
            "siblings",
            r#"
--- main.R
source("load.R")
source("attach.R")
1 %where% m2_siblings
--- load.R
ns <- loadNamespace("pkga")
--- attach.R
attachNamespace(ns)
"#,
            &["m2_siblings"],
        ),
    ]);
}

/// The file binds `` `%where%` <- pkga::`%where%` `` at top level. The call
/// is written below that line, above it, or under a different binding, and
/// in every fixture it reaches a capturing operator when it is evaluated:
/// pkga's, or in `local_lazy_operator` the file's own. Some fixtures have a
/// `warm.R`, a second checked file with a load call for pkga. Where
/// `main.R` names pkga only in the alias, that call is what puts pkga's
/// declaration in the package cache for a `raven check` run.
#[test]
fn alias_programs_r_accepts_report_nothing() {
    check(&[
        // The call comes after the alias.
        quiet(
            "post_alias_only_warm",
            r#"
--- main.R
library(pkgb)
`%where%` <- pkga::`%where%`
1 %where% m3_postw
library(pkga)
"#,
            &["m3_postw"],
        ),
        quiet(
            "alias_only_first_half",
            r#"
--- main.R
`%where%` <- pkga::`%where%`
d <- 1
d %where% m3_alias_half
--- warm.R
library(pkga)
"#,
            &["m3_alias_half"],
        ),
        // R skips a non-function binding when it looks up a function, so the
        // attached pkga provides the operator.
        quiet(
            "computed_nonfunction",
            r#"
--- main.R
library(pkga)
`%where%` <- identity(1)
1 %where% m3_computed
`%where%` <- pkga::`%where%`
"#,
            &["m3_computed"],
        ),
        // The assignment of pkgb's operator never runs.
        quiet(
            "dead_branch",
            r#"
--- main.R
library(pkga)
if (FALSE) `%where%` <- pkgb::`%where%`
1 %where% m3_dead
`%where%` <- pkga::`%where%`
"#,
            &["m3_dead"],
        ),
        // The call runs on the second iteration, after the first made the alias.
        quiet(
            "loop_warm",
            r#"
--- main.R
d <- 1
for (i in 1:2) {
  if (i == 2) d %where% m3_loopw
  `%where%` <- pkga::`%where%`
}
library(pkgb)
--- warm.R
library(pkga)
"#,
            &["m3_loopw"],
        ),
        // The function is defined above the alias and called below it.
        quiet(
            "fn_called_after_alias_warm",
            r#"
--- main.R
library(pkgb)
f <- function(d) d %where% m3_fnw
`%where%` <- pkga::`%where%`
f(1)
--- warm.R
library(pkga)
"#,
            &["m3_fnw"],
        ),
        // The promise is forced after the alias.
        quiet(
            "delayed_assign",
            r#"
--- main.R
library(pkgb)
loadNamespace("pkga")
d <- 1
delayedAssign("v", d %where% m3_delayed)
`%where%` <- pkga::`%where%`
v
"#,
            &["m3_delayed"],
        ),
        // The file's own operator, which never evaluates its right operand, is
        // the one called.
        quiet(
            "local_lazy_operator",
            r#"
--- main.R
`%where%` <- function(data, cond) { substitute(cond); data }
1 %where% m3_lazy
`%where%` <- pkga::`%where%`
--- warm.R
library(pkga)
"#,
            &["m3_lazy"],
        ),
        // A helper attached pkga before the call.
        quiet(
            "helper_attaches_a",
            r#"
--- main.R
setup <- function() library(pkga)
setup()
1 %where% m3_opaque
`%where%` <- pkga::`%where%`
--- warm.R
library(pkga)
"#,
            &["m3_opaque"],
        ),
        quiet(
            "alias_qualified_warm_sibling",
            r#"
--- main.R
`%where%` <- pkga::`%where%`
1 %where% m3_qual
--- warm.R
loadNamespace("pkga")
"#,
            &["m3_qual"],
        ),
        quiet(
            "alias_after_load_namespace",
            r#"
--- main.R
loadNamespace("pkga")
`%where%` <- pkga::`%where%`
1 %where% m3_loadns
"#,
            &["m3_loadns"],
        ),
    ]);
}

/// Known limitations, pinned so that a change to any of them is deliberate.
/// After three controls come three numbered groups. R stops on every call
/// in them, and Raven applies pkga's declaration anyway.
///
/// The groups hold the operator, a declared function, and (where it shows
/// anything) the operator called by name. The declaration is chosen from
/// the same facts for all of them, and v0.21.1 already chose it this way
/// for the function.
///
/// 1. pkgb is attached last and masks pkga. R calls pkgb's function and
///    stops on the second argument. Raven would need the order of R's search
///    path to tell this from the programs in
///    [`masked_exporter_programs_r_accepts_report_nothing`], and scope
///    resolution keeps a set.
/// 2. Only pkga's namespace is loaded. R can't find the function and stops
///    there, before it looks at an argument. Raven counts a loaded package's
///    exports as available, which is what keeps the programs in
///    [`namespace_load_programs_r_accepts_report_nothing`] unreported.
/// 3. The call runs under pkgb, above the line that rebinds the name to
///    pkga's, and R stops on the second argument. Raven keeps one alias per
///    name for the file, which is what keeps the programs in
///    [`alias_programs_r_accepts_report_nothing`] unreported.
///
/// In groups 1 and 3 the first argument is undefined as well. Raven reports
/// it and skips the second, which is pkga's declaration at work: under pkgb
/// alone, both arguments of the operator and of the function are reported.
/// In group 2 R never reaches an argument, so the first is defined, and the
/// harness's second run shows the declaration is what hides the other.
#[test]
fn programs_r_stops_on_apply_the_declaration_anyway() {
    check(&[
        // No declaring package: the control for the rows below.
        reports(
            "control_operator_under_pkgb_alone",
            r#"
--- main.R
library(pkgb)
l0o_data %where% l0o_cond
"#,
            &["l0o_data", "l0o_cond"],
        ),
        reports(
            "control_function_under_pkgb_alone",
            r#"
--- main.R
library(pkgb)
pick(l0f_data, l0f_cond)
"#,
            &["l0f_data", "l0f_cond"],
        ),
        // A sibling file that attaches pkga doesn't apply its declaration.
        reports(
            "control_function_with_sibling_attaching_pkga",
            r#"
--- main.R
library(pkgb)
pick(l0w_data, l0w_cond)
--- warm.R
library(pkga)
"#,
            &["l0w_data", "l0w_cond"],
        ),
        // 1. Masked exporter. R: object 'l1o_cond' not found, and so on.
        reports(
            "masked_operator",
            r#"
--- main.R
library(pkga)
library(pkgb)
l1o_data %where% l1o_cond
"#,
            &["l1o_data"],
        ),
        reports(
            "masked_function",
            r#"
--- main.R
library(pkga)
library(pkgb)
pick(l1f_data, l1f_cond)
"#,
            &["l1f_data"],
        ),
        reports(
            "masked_backtick_call",
            r#"
--- main.R
library(pkga)
library(pkgb)
`%where%`(l1b_data, l1b_cond)
"#,
            &["l1b_data"],
        ),
        // 2. Namespace-only load. R: could not find function "%where%", or
        // "pick".
        quiet(
            "namespace_only_operator",
            r#"
--- main.R
loadNamespace("pkga")
d <- 1
d %where% m2_ns
"#,
            &["m2_ns"],
        ),
        quiet(
            "namespace_only_function",
            r#"
--- main.R
loadNamespace("pkga")
d <- 1
pick(d, f2_ns)
"#,
            &["f2_ns"],
        ),
        // 3. Later alias. R: object 'l3o_cond' not found, and so on.
        reports(
            "later_alias_operator",
            r#"
--- main.R
library(pkgb)
l3o_data %where% l3o_cond
`%where%` <- pkga::`%where%`
--- warm.R
library(pkga)
"#,
            &["l3o_data"],
        ),
        reports(
            "later_alias_function",
            r#"
--- main.R
library(pkgb)
pick(l3f_data, l3f_cond)
pick <- pkga::pick
--- warm.R
library(pkga)
"#,
            &["l3f_data"],
        ),
        reports(
            "later_alias_backtick_call",
            r#"
--- main.R
library(pkgb)
`%where%`(l3b_data, l3b_cond)
`%where%` <- pkga::`%where%`
--- warm.R
library(pkga)
"#,
            &["l3b_data"],
        ),
    ]);
}

/// Issue #900: when two packages Raven counts at the call both declare a
/// name, Raven applies the declaration of the package whose name sorts
/// first, not the one R finds (the one attached last). Pinned at today's
/// results, which are R's in some cases and not in others. The comment on
/// each case says what R does with real packages built like the fakes. A
/// change that makes a case agree with R should update its pin.
///
/// The data-mask pair is why this wasn't fixed by following the attach
/// order. zmask900 and zz884 ship the same declaration (the right operand is
/// captured), and Raven doesn't read package code, so it can't tell
/// `two_declarers_function_body` from `data_mask_function_body` or
/// `two_declarers_zz_last` from `data_mask_last`. R runs the zz884 programs
/// and stops on the data-mask ones, where both v0.21.1 and today's Raven
/// report the name. Any rule that picks the last-attached package's
/// declaration loses those reports.
///
/// In a quiet case, the harness's second run (no sidecars) shows the
/// declaration is what hides the name.
#[test]
fn two_declaring_packages_follow_package_names_not_attach_order() {
    check(&[
        // R prints 1: zz884 was attached last and never evaluates
        // r1_operand. Raven applies aa884's declaration.
        reports(
            "two_declarers_zz_last",
            r#"
--- main.R
library(aa884)
suppressPackageStartupMessages(library(zz884))
print(1 %pick884% r1_operand)
"#,
            &["r1_operand"],
        ),
        // Both operands undefined, so the pin shows whose declaration
        // applies: aa884's captures the left one. R: object 'lr1_left' not
        // found (zz884 attached last evaluates the left operand).
        reports(
            "two_declarers_zz_last_both_operands",
            r#"
--- main.R
library(aa884)
suppressPackageStartupMessages(library(zz884))
print(lr1_left %pick884% lr1_right)
"#,
            &["lr1_right"],
        ),
        // R: object 'lr2_right' not found (aa884 attached last).
        reports(
            "two_declarers_aa_last_both_operands",
            r#"
--- main.R
library(zz884)
suppressPackageStartupMessages(library(aa884))
print(lr2_left %pick884% lr2_right)
"#,
            &["lr2_right"],
        ),
        // R: object 'r2_operand' not found (aa884 attached last).
        reports(
            "two_declarers_aa_last",
            r#"
--- main.R
library(zz884)
suppressPackageStartupMessages(library(aa884))
print(1 %pick884% r2_operand)
"#,
            &["r2_operand"],
        ),
        // R prints 1.
        quiet(
            "zz884_alone",
            r#"
--- main.R
library(zz884)
print(1 %pick884% r3_operand)
"#,
            &["r3_operand"],
        ),
        // R: object 'r4_operand' not found.
        reports(
            "aa884_alone",
            r#"
--- main.R
library(aa884)
print(1 %pick884% r4_operand)
"#,
            &["r4_operand"],
        ),
        // R prints 1, as in `two_declarers_zz_last`.
        reports(
            "two_declarers_function_body",
            r#"
--- main.R
f <- function() { library(aa884); suppressPackageStartupMessages(library(zz884)); 1 %pick884% r5_operand }
print(f())
"#,
            &["r5_operand"],
        ),
        // R prints 1. Raven doesn't carry aa884 past the `local()` block
        // (issue #884), so it sees zz884 alone.
        quiet(
            "child_attaches_aa_in_local_block",
            r#"
--- main.R
f <- function() { local({ source("child.R", local = TRUE) }); suppressPackageStartupMessages(library(zz884)); 1 %pick884% r6_operand }
print(f())
--- child.R
library(aa884)
"#,
            &["r6_operand"],
        ),
        // R: object 'vaule' not found. zmask900, attached last, evaluates
        // the right operand in a data mask that holds only `value`.
        reports(
            "data_mask_last",
            r#"
--- main.R
library(aa884)
suppressPackageStartupMessages(library(zmask900))
print(1 %pick884% vaule)
"#,
            &["vaule"],
        ),
        // R: object 'vaule2' not found.
        reports(
            "data_mask_function_body",
            r#"
--- main.R
f <- function() { library(aa884); suppressPackageStartupMessages(library(zmask900)); 1 %pick884% vaule2 }
print(f())
"#,
            &["vaule2"],
        ),
        // R: object 'vaule3' not found. Today's Raven sees zmask900 alone
        // here (issue #884) and applies its declaration; v0.21.1 reports
        // the name.
        quiet(
            "data_mask_child_in_local_block",
            r#"
--- main.R
f <- function() { local({ source("child.R", local = TRUE) }); suppressPackageStartupMessages(library(zmask900)); 1 %pick884% vaule3 }
print(f())
--- child.R
library(aa884)
"#,
            &["vaule3"],
        ),
        // An ordinary function has the same order. R: object 'fn1_value'
        // not found (zp900 attached last); Raven applies ap900's
        // declaration.
        quiet(
            "two_declaring_functions_zp_last",
            r#"
--- main.R
library(ap900)
suppressPackageStartupMessages(library(zp900))
print(pick900(1, fn1_value))
"#,
            &["fn1_value"],
        ),
        // R prints 1.
        quiet(
            "two_declaring_functions_ap_last",
            r#"
--- main.R
library(zp900)
suppressPackageStartupMessages(library(ap900))
print(pick900(1, fn2_value))
"#,
            &["fn2_value"],
        ),
    ]);
}
