//! Hover provenance for the location-free helper contributions introduced by #759.
use crate::handlers::hover;
use crate::package_state::{PackageScopeContribution, PackageState};
use crate::state::{Document, WorldState};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tempfile::TempDir;
use tower_lsp::lsp_types::{HoverContents, Position, Url};

struct Fixture {
    dir: TempDir,
    state: WorldState,
    helpers: BTreeMap<std::path::PathBuf, Arc<BTreeSet<String>>>,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let mut state = WorldState::new();
        state.workspace_folders = vec![Url::from_directory_path(dir.path()).unwrap()];
        state.workspace_scan_complete = true;
        Self {
            dir,
            state,
            helpers: BTreeMap::new(),
        }
    }

    fn file(&mut self, path: &str, code: &str, open: bool) -> Url {
        let path = self.dir.path().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, code).unwrap();
        let uri = Url::from_file_path(path).unwrap();
        if open {
            self.state
                .open_document_with_language_id(uri.clone(), code, Some(1), Some("r"));
        } else {
            self.state.insert_workspace_document_for_test(
                uri.clone(),
                Document::new_with_uri(code, None, &uri),
            );
        }
        uri
    }

    fn helper(&mut self, path: &str, code: &str, names: &[&str], open: bool) -> Url {
        let uri = self.file(path, code, open);
        self.helpers.insert(
            self.dir.path().join(path),
            Arc::new(names.iter().map(|name| (*name).to_owned()).collect()),
        );
        self.state.package_state.set_from(PackageState {
            scope_contribution: PackageScopeContribution {
                workspace_root: Some(self.dir.path().to_path_buf()),
                test_helper_symbols: Arc::new(self.helpers.clone()),
                ..Default::default()
            },
            ..Default::default()
        });
        uri
    }

    async fn hover(&self, uri: &Url, line: u32, character: u32) -> String {
        match hover(&self.state, uri, Position::new(line, character))
            .await
            .expect("hover resolves")
            .contents
        {
            HoverContents::Markup(content) => content.value,
            other => panic!("expected markdown, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn later_helper_hover_has_definition_and_location_open_or_closed() {
    for open in [true, false] {
        let mut f = Fixture::new();
        let target = f.helper(
            "tests/testthat/helper-z.R",
            "# A fixture\nlater_helper <- function(value = 42) value\n",
            &["later_helper"],
            open,
        );
        let query = f.file(
            "tests/testthat/helper-a.R",
            "caller <- function() later_helper()\n",
            true,
        );
        let value = f.hover(&query, 0, 24).await;
        assert!(
            value.contains("later_helper <- function(value = 42) value"),
            "{value}"
        );
        assert!(
            value.contains(&format!("[tests/testthat/helper-z.R]({target}), line 2")),
            "{value}"
        );
        assert!(!value.contains("Defined in internal"), "{value}");
    }
}

#[tokio::test]
async fn helper_hover_respects_source_order_and_hoisting() {
    let mut f = Fixture::new();
    f.helper(
        "tests/testthat/helper-a.R",
        "peer <- function(early) early\n",
        &["peer"],
        false,
    );
    f.helper(
        "tests/testthat/setup-z.R",
        "peer <- function(late) late\n",
        &["peer"],
        false,
    );
    let query = f.file(
        "tests/testthat/helper-m.R",
        "peer()\ncaller <- function() peer()\n",
        true,
    );
    assert!(f.hover(&query, 0, 1).await.contains("function(early)"));
    assert!(f.hover(&query, 1, 22).await.contains("function(late)"));
    f.state.cross_file_config.hoist_globals_in_functions = false;
    assert!(f.hover(&query, 1, 22).await.contains("function(early)"));
    let test = f.file("tests/testthat/test-peer.R", "peer()\n", true);
    assert!(f.hover(&test, 0, 1).await.contains("function(late)"));
}

#[tokio::test]
async fn local_definition_keeps_precedence_over_helpers() {
    let mut f = Fixture::new();
    f.helper(
        "tests/testthat/helper-z.R",
        "peer <- function(foreign) foreign\n",
        &["peer"],
        false,
    );
    let query = f.file(
        "tests/testthat/helper-a.R",
        "peer <- function(local) local\ncaller <- function() peer()\n",
        true,
    );
    let value = f.hover(&query, 1, 22).await;
    assert!(value.contains("function(local)"), "{value}");
    assert!(value.contains("this file, line 1"), "{value}");
}

#[tokio::test]
async fn helper_hover_follows_static_sources_and_backtick_names() {
    let mut f = Fixture::new();
    let target = f.file(
        "scripts/definitions.R",
        "`peer name` <- function(value) value\n",
        false,
    );
    f.helper(
        "tests/testthat/helper-z.R",
        "source('../../scripts/definitions.R')\n",
        &["peer name"],
        false,
    );
    let query = f.file(
        "tests/testthat/helper-a.R",
        "caller <- function() `peer name`()\n",
        true,
    );
    let value = f.hover(&query, 0, 25).await;
    assert!(
        value.contains("`peer name` <- function(value) value"),
        "{value}"
    );
    assert!(
        value.contains(&format!("[scripts/definitions.R]({target}), line 1")),
        "{value}"
    );
}

#[tokio::test]
async fn removed_or_function_local_helper_does_not_invent_a_definition() {
    for code in [
        "peer <- function(removed) removed\nrm(peer)\n",
        "wrapper <- function() { peer <- function(hidden) hidden }\n",
    ] {
        let mut f = Fixture::new();
        f.helper(
            "tests/testthat/helper-a.R",
            "peer <- function(older) older\n",
            &["peer"],
            false,
        );
        // Contributions may lag edits or retain rm'd names; provenance must
        // still use the authoritative, position-aware helper scope.
        f.helper("tests/testthat/helper-z.R", code, &["peer"], false);
        f.file(
            "unrelated.R",
            "peer <- function(unrelated) unrelated\n",
            true,
        );
        let query = f.file("tests/testthat/test-peer.R", "peer()\n", true);
        let value = f.hover(&query, 0, 1).await;
        assert!(!value.contains("function("), "{value}");
        assert!(!value.contains("internal"), "{value}");
    }
}

#[tokio::test]
async fn helper_hover_does_not_cross_directories() {
    let mut f = Fixture::new();
    f.helper(
        "tests/testthat/helper-a.R",
        "peer <- function(right) right\n",
        &["peer"],
        false,
    );
    f.helper(
        "tests/testit/helper-z.R",
        "peer <- function(wrong) wrong\n",
        &["peer"],
        false,
    );
    let query = f.file("tests/testthat/test-peer.R", "peer()\n", true);
    let value = f.hover(&query, 0, 1).await;
    assert!(value.contains("function(right)"), "{value}");
    assert!(!value.contains("function(wrong)"), "{value}");
}

#[tokio::test]
async fn helper_hover_uses_the_resolved_conditional_deferred_phase() {
    let mut f = Fixture::new();
    f.helper(
        "tests/testthat/helper-a.R",
        "library(shiny)\npeer <- function(early) early\n",
        &["peer"],
        false,
    );
    f.helper(
        "tests/testthat/helper-z.R",
        "peer <- function(late) late\n",
        &["peer"],
        false,
    );
    let mut contribution = f.state.package_state.scope_contribution().clone();
    contribution.test_helper_attached_packages = Arc::new(BTreeMap::from([(
        f.dir.path().join("tests/testthat/helper-a.R"),
        Arc::new(BTreeSet::from(["shiny".to_owned()])),
    )]));
    f.state.package_state.set_from(PackageState {
        scope_contribution: contribution,
        ..Default::default()
    });
    let query = f.file("tests/testthat/helper-m.R", "reactive({ peer() })\n", true);
    let value = f.hover(&query, 0, 12).await;
    assert!(value.contains("function(late)"), "{value}");
}

#[tokio::test]
async fn helper_hover_does_not_export_attachment_dependent_deferred_locals() {
    let mut f = Fixture::new();
    f.helper("tests/testthat/helper-a.R", "library(shiny)\n", &[], false);
    f.helper(
        "tests/testthat/helper-z.R",
        "reactive({ peer <- function(hidden) hidden })\n",
        &["peer"],
        false,
    );
    let mut contribution = f.state.package_state.scope_contribution().clone();
    contribution.test_helper_attached_packages = Arc::new(BTreeMap::from([(
        f.dir.path().join("tests/testthat/helper-a.R"),
        Arc::new(BTreeSet::from(["shiny".to_owned()])),
    )]));
    f.state.package_state.set_from(PackageState {
        scope_contribution: contribution,
        ..Default::default()
    });
    let query = f.file("tests/testthat/test-peer.R", "peer()\n", true);
    let value = f.hover(&query, 0, 1).await;
    assert!(!value.contains("function("), "{value}");
    assert!(!value.contains("internal"), "{value}");
}

#[tokio::test]
async fn helper_hover_does_not_export_a_parent_only_binding() {
    let mut f = Fixture::new();
    let helper = f.helper(
        "tests/testthat/helper-z.R",
        "wrapper <- function() { peer <- function(hidden) hidden }\n",
        &["peer"],
        false,
    );
    let parent_code =
        "peer <- function(unrelated) unrelated\nsource('tests/testthat/helper-z.R')\n";
    let parent = f.file("parent.R", parent_code, true);
    f.state.cross_file_graph.update_file(
        &parent,
        &crate::cross_file::extract_metadata(parent_code),
        f.state.workspace_folders.first(),
        |_| None,
    );
    let scope = super::get_cross_file_scope(
        &f.state,
        &helper,
        u32::MAX,
        u32::MAX,
        &super::DiagCancelToken::never(),
        None,
    );
    assert!(
        scope.parent_prefix_symbol_names.contains("peer"),
        "fixture must expose the unrelated parent binding"
    );
    let query = f.file("tests/testthat/test-peer.R", "peer()\n", true);
    let value = f.hover(&query, 0, 1).await;
    assert!(!value.contains("function("), "{value}");
    assert!(!value.contains("internal"), "{value}");
}

#[cfg(unix)]
#[tokio::test]
async fn helper_hover_uses_unsaved_text_opened_through_an_alias() {
    let mut f = Fixture::new();
    let target = f.helper(
        "tests/testthat/helper-z.R",
        "peer <- function(saved) saved\n",
        &["peer"],
        false,
    );
    let alias_path = f.dir.path().join("alias.R");
    std::os::unix::fs::symlink(target.to_file_path().unwrap(), &alias_path).unwrap();
    let alias = Url::from_file_path(alias_path).unwrap();
    f.state.open_document_with_language_id(
        alias.clone(),
        "# Unsaved buffer\npeer <- function(unsaved) unsaved\n",
        Some(1),
        Some("r"),
    );
    assert_eq!(
        f.state.open_document_uri_for_authoritative_uri(&target),
        Some(alias.clone())
    );
    let query = f.file("tests/testthat/test-peer.R", "peer()\n", true);
    let value = f.hover(&query, 0, 1).await;
    assert!(
        value.contains("peer <- function(unsaved) unsaved"),
        "{value}"
    );
    assert!(
        value.contains(&format!("[alias.R]({alias}), line 2")),
        "{value}"
    );
}
