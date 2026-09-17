//! Non-portable R6 instance bindings belong to methods, never package globals.

use std::path::Path;
use std::process::Command;

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn diagnostics(root: &Path) -> Vec<(String, String)> {
    let output = Command::new(env!("CARGO_BIN_EXE_raven"))
        .args(["check", "--workspace"])
        .arg(root)
        .args(["--format", "json", "--max-severity", "error"])
        .env_remove("R_BOX_PATH")
        .output()
        .unwrap();
    assert!(
        matches!(output.status.code(), Some(0 | 1)),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    rows.into_iter()
        .filter(|row| row["diagnostic"]["code"] == "undefined-variable")
        .map(|row| {
            (
                row["path"].as_str().unwrap().replace('\\', "/"),
                row["diagnostic"]["message"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn package(root: &Path) {
    write(
        root,
        "DESCRIPTION",
        "Package: r6scopeprobe\nVersion: 0.0.1\n",
    );
    write(root, "raven.toml", "[packages]\nenabled = false\n");
}

#[test]
fn nonportable_members_and_inheritance_resolve_in_methods_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    package(root);
    write(
        root,
        "R/base.R",
        r#"Base <- R6::R6Class("Base", portable = FALSE,
  public = list(inherited_field = 1, base_method = function() inherited_field),
  private = list(secret_field = 2),
  active = list(active_field = function() inherited_field * 2))
"#,
    );
    write(
        root,
        "R/child.R",
        r#"Child <- R6::R6Class("Child", inherit = Base, portable = FALSE,
  public = list(own_field = 3,
    run = function(value = inherited_field) {
      nested <- function() c(own_field, inherited_field, secret_field,
                            active_field, base_method(), missing_r6_probe)
      nested()
    }))
"#,
    );
    assert_eq!(
        diagnostics(root),
        vec![("R/child.R".into(), "missing_r6_probe is not defined".into())]
    );
}

#[test]
fn own_members_support_late_bases_and_literal_argument_matching() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    package(root);
    write(
        root,
        "R/classes.R",
        r#"Child <- R6 :: R6Class(public = base::list(
  own = 1, run = function() c(own, inherited, missing_r6_probe)),
  classname = "Child", inherit = Base, portable = FALSE)
Base <- R6::R6Class("Base", list(inherited = 2), portable = FALSE)
"#,
    );
    assert_eq!(
        diagnostics(root),
        vec![(
            "R/classes.R".into(),
            "missing_r6_probe is not defined".into()
        )]
    );
}

#[test]
fn portable_unknown_and_outside_references_remain_diagnostics() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    package(root);
    write(
        root,
        "R/negative.R",
        r#"Portable <- R6::R6Class("Portable", public = list(
  portable_field = 1, run = function() portable_field))
Unknown <- R6::R6Class("Unknown", portable = F, public = list(
  unknown_field = 1, run = function() unknown_field))
F <- TRUE
Nonportable <- R6::R6Class("Nonportable", portable = FALSE, public = list(
  own_field = 1, initializer = own_field, run = function() own_field))
outside <- function() own_field
"#,
    );
    let rows = diagnostics(root);
    let names: Vec<_> = rows.iter().map(|(_, message)| message.as_str()).collect();
    assert_eq!(
        names,
        [
            "portable_field is not defined",
            "unknown_field is not defined",
            "own_field is not defined",
            "own_field is not defined"
        ]
    );
}

#[test]
fn package_namespace_collisions_do_not_guess_a_superclass() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    package(root);
    write(
        root,
        "R/a.R",
        r#"Base <- R6::R6Class(public = list(ambiguous_member = 1), portable = FALSE)
Child <- R6::R6Class(inherit = Base, portable = FALSE, public = list(
  own = 1, run = function() c(own, ambiguous_member)))
"#,
    );
    write(root, "R/z.R", "Base <- NULL\n");
    assert_eq!(
        diagnostics(root),
        vec![("R/a.R".into(), "ambiguous_member is not defined".into())]
    );
}

#[test]
fn nested_classes_respect_sibling_constructor_and_list_masks() {
    for (helper, constructor, list) in [
        ("R6Class", "R6Class", "base::list"),
        ("list", "R6::R6Class", "list"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        package(root);
        write(
            root,
            "R/factory.R",
            &format!(
                // A sibling-only bare function otherwise has unknown NSE policy.
                "# raven: nse R6Class(portable)\nmake <- function() {constructor}(portable = FALSE, public = {list}(masked_member = 1, run = function() masked_member))\n"
            ),
        );
        write(
            root,
            "R/shadow.R",
            &format!("{helper} <- function(...) base::list(...)\n"),
        );
        assert_eq!(
            diagnostics(root),
            vec![("R/factory.R".into(), "masked_member is not defined".into())],
            "{helper}"
        );
    }
}

#[test]
fn source_parent_completed_environment_supplies_late_superclass() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "raven.toml", "[packages]\nenabled = false\n");
    write(
        root,
        "main.R",
        r#"source("child.R")
Base <- R6::R6Class(portable = FALSE, public = list(parent_member = 1))
Child$new()
"#,
    );
    write(
        root,
        "child.R",
        r#"Child <- R6::R6Class(inherit = Base, portable = FALSE, public = list(
  run = function(Base = NULL) c(parent_member, missing_r6_probe)))
"#,
    );
    assert_eq!(
        diagnostics(root),
        vec![("child.R".into(), "missing_r6_probe is not defined".into())]
    );
}

#[test]
fn a_masked_member_list_does_not_disable_qualified_sibling_lists() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    package(root);
    write(root, "R/mask.R", "list <- function(...) base::list(...)\n");
    write(
        root,
        "R/class.R",
        r#"C <- R6::R6Class(portable=FALSE,
  public=base::list(x=1, run=function() { x; self; masked_private }),
  private=list(masked_private=2))
"#,
    );
    assert_eq!(
        diagnostics(root),
        vec![("R/class.R".into(), "masked_private is not defined".into())]
    );
}

#[test]
fn sourced_replacements_override_package_superclass_candidates() {
    for (replacement, expected) in [
        (
            "Base <- R6::R6Class(portable=FALSE, public=list(new_field=2))\n",
            vec!["old_field is not defined"],
        ),
        (
            "Base <- NULL\n",
            vec!["old_field is not defined", "new_field is not defined"],
        ),
        (
            "rm(Base)\n",
            vec!["old_field is not defined", "new_field is not defined"],
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        package(root);
        write(
            root,
            "R/main.R",
            r#"Base <- R6::R6Class(portable=FALSE, public=list(old_field=1))
source('scripts/shadow.R', local=TRUE)
Child <- R6::R6Class(portable=FALSE, inherit=Base,
  public=list(run=function() c(old_field, new_field)))
"#,
        );
        write(root, "R/scripts/shadow.R", replacement);
        assert_eq!(
            diagnostics(root)
                .into_iter()
                .map(|(_, message)| message)
                .collect::<Vec<_>>(),
            expected,
            "{replacement}"
        );
    }
}

#[test]
fn creator_lookup_follows_successive_sources_and_later_local_definitions() {
    for restore_local in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        package(root);
        let restore = if restore_local {
            "Base <- R6::R6Class(portable=FALSE, public=list(restored=4))\n"
        } else {
            ""
        };
        write(
            root,
            "R/main.R",
            &format!(
                r#"Base <- R6::R6Class(portable=FALSE, public=list(first=1))
source('scripts/first.R')
source('scripts/second.R', local=TRUE)
{restore}Child <- R6::R6Class(inherit=Base, portable=FALSE,
  public=list(run=function() c(first, middle, last, restored)))
"#
            ),
        );
        write(
            root,
            "R/scripts/first.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(middle=2))\n",
        );
        write(
            root,
            "R/scripts/second.R",
            "source('final.R', local=TRUE)\n",
        );
        write(
            root,
            "R/scripts/final.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(last=3))\n",
        );
        assert_eq!(
            diagnostics(root)
                .into_iter()
                .map(|(_, message)| message)
                .collect::<Vec<_>>(),
            if restore_local {
                vec![
                    "first is not defined",
                    "middle is not defined",
                    "last is not defined",
                ]
            } else {
                vec![
                    "first is not defined",
                    "middle is not defined",
                    "restored is not defined",
                ]
            }
        );
    }
}

#[test]
fn completed_parent_removal_vetoes_package_superclass_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    package(root);
    write(
        root,
        "R/base.R",
        "Base <- R6::R6Class(portable=FALSE, public=list(stale=1))\n",
    );
    write(
        root,
        "R/main.R",
        "source('R/child.R', local=TRUE)\nrm(Base)\n",
    );
    write(
        root,
        "R/child.R",
        "Child <- R6::R6Class(inherit=Base, portable=FALSE, public=list(run=function() stale))\n",
    );
    assert_eq!(
        diagnostics(root),
        vec![("R/child.R".into(), "stale is not defined".into())]
    );
}

#[test]
fn unavailable_sibling_creator_effects_do_not_restore_obsolete_members() {
    for effect in ["source('scripts/override.R', local=TRUE)", "rm(Base)"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        package(root);
        write(
            root,
            "R/base.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(original=1))\n",
        );
        write(
            root,
            "R/mid.R",
            &format!(
                "{effect}\nMid <- R6::R6Class(inherit=Base, portable=FALSE, public=base::list(mid_own=1))\n"
            ),
        );
        write(
            root,
            "R/scripts/override.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(replacement=1))\n",
        );
        write(
            root,
            "R/child.R",
            "Child <- R6::R6Class(inherit=Mid, portable=FALSE, public=base::list(child_own=1, run=function() c(original, mid_own, child_own, typo)))\n",
        );
        assert_eq!(
            diagnostics(root),
            vec![
                ("R/child.R".into(), "original is not defined".into()),
                ("R/child.R".into(), "typo is not defined".into()),
            ],
            "{effect}"
        );
    }
}

#[test]
fn caller_replacements_are_not_overwritten_by_child_creator_replay() {
    for replacement in [
        "Base <- NULL",
        "rm(Base)",
        "Base <- R6::R6Class(portable=FALSE, public=list(replacement=1))",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "raven.toml", "[packages]\nenabled = false\n");
        write(
            root,
            "main.R",
            &format!("source('child.R')\n{replacement}\n"),
        );
        write(
            root,
            "child.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(stale=1))\nChild <- R6::R6Class(inherit=Base, portable=FALSE, public=base::list(own=1, run=function() c(stale, own)))\n",
        );
        assert_eq!(
            diagnostics(root),
            vec![("child.R".into(), "stale is not defined".into())],
            "{replacement}"
        );
    }
}

#[test]
fn package_fallback_does_not_invent_isolation_from_a_trimmed_graph() {
    for directive in ["", "# raven: sourced-by ../parent.R\n"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        package(root);
        write(
            root,
            "R/base.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(original=1))\n",
        );
        write(
            root,
            "R/mid.R",
            &format!(
                "{directive}Mid <- R6::R6Class(inherit=Base, portable=FALSE, public=base::list(mid_own=1))\n"
            ),
        );
        write(
            root,
            "parent.R",
            "source('R/base.R')\nsource('R/mid.R')\nBase <- R6::R6Class(portable=FALSE, public=list(replacement=1))\n",
        );
        write(
            root,
            "R/child.R",
            "Child <- R6::R6Class(inherit=Mid, portable=FALSE, public=base::list(run=function() c(original, mid_own, typo)))\n",
        );
        assert_eq!(
            diagnostics(root),
            vec![
                ("R/child.R".into(), "original is not defined".into()),
                ("R/child.R".into(), "typo is not defined".into()),
            ],
            "{directive}"
        );
    }
}

#[test]
fn completed_creator_walk_honors_grandparents_and_truncation() {
    for budget in [2, 3, 100] {
        for mutation_after_source in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            package(root);
            write(
                root,
                "raven.toml",
                &format!(
                    "[packages]\nenabled = false\n[crossFile]\nmaxTransitiveDependentsVisited = {budget}\n"
                ),
            );
            write(
                root,
                "R/base.R",
                "Base <- R6::R6Class(portable=FALSE, public=list(stale=1))\n",
            );
            write(
                root,
                "R/child.R",
                "Child <- R6::R6Class(inherit=Base, portable=FALSE, public=base::list(own=1, run=function() c(stale, own, typo)))\n",
            );
            write(root, "parent.R", "source('R/child.R')\n");
            write(
                root,
                "grandparent.R",
                if mutation_after_source {
                    "source('parent.R')\nBase <- NULL\n"
                } else {
                    "Base <- NULL\nsource('parent.R')\n"
                },
            );
            assert_eq!(
                diagnostics(root),
                vec![
                    ("R/child.R".into(), "stale is not defined".into()),
                    ("R/child.R".into(), "typo is not defined".into()),
                ],
                "budget={budget}, mutation_after_source={mutation_after_source}"
            );
        }
    }
}

#[test]
fn script_creators_also_fail_closed_on_truncated_parent_context() {
    for budget in [2, 3, 100] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            "raven.toml",
            &format!(
                "[packages]\nenabled = false\n[crossFile]\nmaxTransitiveDependentsVisited = {budget}\n"
            ),
        );
        write(
            root,
            "child.R",
            "Base <- R6::R6Class(portable=FALSE, public=list(stale=1))\nChild <- R6::R6Class(inherit=Base, portable=FALSE, public=base::list(own=1, run=function() c(stale, own, typo)))\n",
        );
        write(root, "parent.R", "source('child.R')\n");
        write(root, "grandparent.R", "source('parent.R')\nBase <- NULL\n");
        assert_eq!(
            diagnostics(root),
            vec![
                ("child.R".into(), "stale is not defined".into()),
                ("child.R".into(), "typo is not defined".into()),
            ],
            "budget={budget}"
        );
    }
}

#[test]
fn ancestor_replay_conflicts_propagate_to_the_child_creator() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "raven.toml", "[packages]\nenabled = false\n");
    write(
        root,
        "child.R",
        "Child <- R6::R6Class(inherit=Base, portable=FALSE, public=base::list(own=1, run=function() c(stale, own, typo)))\n",
    );
    write(
        root,
        "parent.R",
        "Base <- R6::R6Class(portable=FALSE, public=base::list(stale=1))\nsource('child.R')\n",
    );
    write(root, "grandparent.R", "source('parent.R')\nBase <- NULL\n");
    assert_eq!(
        diagnostics(root),
        vec![
            ("child.R".into(), "stale is not defined".into()),
            ("child.R".into(), "typo is not defined".into()),
        ]
    );
}
