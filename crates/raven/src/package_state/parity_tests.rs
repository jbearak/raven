//! Parity tests comparing `derive_package_state` to legacy `rebuild_*` paths.
//!
//! These tests are temporary scaffolding for Phase 2/3 of the migration.
//! They will be deleted in Phase 3 (Task 3.11) once the legacy paths are gone.
//!
//! The tests construct synthetic inputs, run `derive_package_state` on them,
//! and assert specific properties of the resulting `PackageState`. We don't
//! literally compare against the legacy in-place mutation path (which would
//! require constructing a full `WorldState`); instead, we lock in observable
//! invariants that the legacy path produces today, by checking the new
//! `derive` output.

#![cfg(test)]

use super::*;
use crate::cross_file::config::PackageMode;

fn make_inputs(r_files: Vec<(PathBuf, RFileKind, &str)>, namespace: Option<&str>) -> PackageInputs {
    let mut inputs = PackageInputs {
        workspace_root: Some("/work/pkg".into()),
        package_mode: PackageMode::Auto,
        description: Some(DescriptionInput {
            path: "/work/pkg/DESCRIPTION".into(),
            text: "Package: foo\n".into(),
        }),
        namespace: namespace.map(|t| NamespaceInput {
            path: "/work/pkg/NAMESPACE".into(),
            text: t.into(),
        }),
        r_files: BTreeMap::new(),
    };
    for (path, kind, text) in r_files {
        let arc: Arc<str> = text.into();
        let digest = ContentDigest::of(&arc);
        inputs.r_files.insert(path, RFileInput {
            kind,
            origin: ContentOrigin::Disk,
            text: arc,
            content_digest: digest,
        });
    }
    inputs
}

#[test]
fn parity_export_via_roxygen_matches_export_via_namespace() {
    // Two equivalent inputs should produce the same export set.
    let via_roxygen = derive_package_state(
        &PackageState::default(),
        &make_inputs(vec![
            ("/work/pkg/R/foo.R".into(), RFileKind::Source, "#' @export\nfoo <- function() 1\n"),
        ], None),
        &PackageInputDelta::Initial,
    );
    let via_namespace = derive_package_state(
        &PackageState::default(),
        &make_inputs(vec![
            ("/work/pkg/R/foo.R".into(), RFileKind::Source, "foo <- function() 1\n"),
        ], Some("export(foo)\n")),
        &PackageInputDelta::Initial,
    );
    let r_set: &std::collections::HashSet<String> = &via_roxygen.namespace_model.as_ref().unwrap().exports;
    let n_set: &std::collections::HashSet<String> = &via_namespace.namespace_model.as_ref().unwrap().exports;
    assert!(r_set.contains("foo"));
    assert!(n_set.contains("foo"));
}

#[test]
fn parity_importFrom_in_both_sources_unioned() {
    let s = derive_package_state(
        &PackageState::default(),
        &make_inputs(
            vec![("/work/pkg/R/foo.R".into(), RFileKind::Source, "#' @importFrom dplyr filter\nfoo <- function() 1\n")],
            Some("importFrom(stats, filter)\n"),
        ),
        &PackageInputDelta::Initial,
    );
    let pkgs = s.scope_contribution.imported_symbols.get("filter").unwrap();
    assert!(pkgs.contains("dplyr"));
    assert!(pkgs.contains("stats"));
}

#[test]
fn parity_internal_symbols_only_from_R_dir() {
    let s = derive_package_state(
        &PackageState::default(),
        &make_inputs(
            vec![
                ("/work/pkg/R/utils.R".into(), RFileKind::Source, "helper <- function() 1\n"),
                ("/work/pkg/tests/testthat/test-utils.R".into(), RFileKind::Test, "test_helper <- function() 2\n"),
            ],
            None,
        ),
        &PackageInputDelta::Initial,
    );
    assert!(s.scope_contribution.r_internal_symbols.contains("helper"));
    assert!(!s.scope_contribution.r_internal_symbols.contains("test_helper"));
}

#[test]
fn parity_no_workspace_means_empty_state() {
    let inputs = PackageInputs {
        workspace_root: Some("/work/pkg".into()),
        package_mode: PackageMode::Auto,
        description: None, // no DESCRIPTION
        namespace: None,
        r_files: BTreeMap::new(),
    };
    let s = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
    assert!(s.workspace.is_none());
    assert!(s.namespace_model.is_none());
    assert!(s.r_file_facts.is_empty());
    assert!(s.scope_contribution.r_internal_symbols.is_empty());
}
