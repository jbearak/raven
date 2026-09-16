use super::*;
use std::path::Path;

fn service() -> tower_lsp::LspService<Backend> {
    use futures_util::{SinkExt, StreamExt};
    let (service, socket) = tower_lsp::LspService::new(Backend::new);
    let (mut requests, mut responses) = socket.split();
    tokio::spawn(async move {
        while let Some(request) = requests.next().await {
            if let Some(id) = request.id().cloned() {
                let _ = responses
                    .send(tower_lsp::jsonrpc::Response::from_ok(
                        id,
                        serde_json::Value::Null,
                    ))
                    .await;
            }
        }
    });
    service
}

fn write(root: &Path, name: &str, text: &str) -> Url {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
    Url::from_file_path(path).unwrap()
}

async fn initialize(backend: &Backend, root: &Path, index: bool) {
    backend.initialize(InitializeParams {
        workspace_folders: Some(vec![WorkspaceFolder { uri: Url::from_file_path(root).unwrap(), name: "test".into() }]),
        initialization_options: Some(serde_json::json!({"packages": {"enabled": false}, "crossFile": {"indexWorkspace": index}})),
        ..Default::default()
    }).await.unwrap();
    let mut state = backend.state.write().await;
    establish_package_event_translation_state(&mut state, root.into());
    state.workspace_scan_complete = true;
}

async fn open(backend: &Backend, uri: &Url, text: &str) {
    backend
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: "r".into(),
                version: 1,
                text: text.into(),
            },
        })
        .await;
}

async fn settle(backend: &Backend) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !backend.routing_tasks.tracker.is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

async fn ignore_event(backend: &Backend, uri: Url, typ: FileChangeType) {
    backend
        .did_change_watched_files(DidChangeWatchedFilesParams {
            changes: vec![FileEvent { uri, typ }],
        })
        .await;
    settle(backend).await;
}

#[tokio::test]
async fn gitignore_reload_removes_dynamic_cycles_but_preserves_explicit_sources() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let main = write(root, "main.R", "source('helper.R')\n");
    let helper = write(root, "helper.R", "helper <- function() 1\n");
    let a = write(root, "a.R", "source('b.R')\n");
    let b = write(root, "b.R", "source('a.R')\nsource('main.R')\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, true).await;
    run_workspace_scan_transaction_inline(&backend.state)
        .await
        .expect_committed();
    for uri in [&helper, &a, &b] {
        let _ = resync_file_from_disk(
            &backend.state,
            uri,
            None,
            None,
            false,
            None,
            ResyncCommitMode::Immediate,
        )
        .await;
    }
    let ignore = write(root, ".gitignore", "helper.R\na.R\nb.R\n");
    ignore_event(backend, ignore, FileChangeType::CREATED).await;
    let state = backend.state.read().await;
    assert!(state.workspace_index.contains_artifacts(&main));
    assert!(state.workspace_index.contains_artifacts(&helper));
    assert!(!state.workspace_index.contains_artifacts(&a));
    assert!(!state.workspace_index.contains_artifacts(&b));
    assert!(state.cross_file_graph.get_dependencies(&a).is_empty());
    assert!(state.cross_file_graph.get_dependencies(&b).is_empty());
}

#[tokio::test]
async fn gitignored_first_open_close_drops_buffer_only_graph_and_package_input() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".gitignore", "tests/testthat/helper.R\n");
    let uri = write(
        root,
        "tests/testthat/helper.R",
        "source('../../other.R')\nhelper_fn <- function() 1\n",
    );
    write(root, "other.R", "other_fn <- function() 1\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, true).await;
    open(
        backend,
        &uri,
        "source('../../other.R')\nhelper_fn <- function() 2\n",
    )
    .await;
    assert!(
        !backend
            .state
            .read()
            .await
            .is_unreferenced_gitignored_uri(&uri)
    );
    backend
        .did_close(DidCloseTextDocumentParams {
            text_document: TextDocumentIdentifier { uri: uri.clone() },
        })
        .await;
    settle(backend).await;
    let state = backend.state.read().await;
    assert!(!state.workspace_index.contains_artifacts(&uri));
    assert!(state.cross_file_graph.get_dependencies(&uri).is_empty());
    assert!(
        !state
            .package_inputs
            .r_files
            .contains_key(&uri.to_file_path().unwrap())
    );
    assert!(state.package_inputs.preamble_sourced_symbols.is_empty());
}

#[tokio::test]
async fn ignored_prelude_source_remains_watched_without_becoming_automatic_package_input() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".gitignore", "R/ignored.R\n");
    write(root, ".Rprofile", "source('R/ignored.R')\n");
    let helper = write(root, "R/ignored.R", "before <- 1\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, false).await;
    let exclusions = backend.state.read().await.workspace_exclusions.clone();
    {
        let mut state = backend.state.write().await;
        initialize_package_inputs_from_state_with_exclusions(
            &mut state,
            root.into(),
            None,
            None,
            Default::default(),
            None,
            None,
            &exclusions,
        );
        assert_eq!(
            watched_change_admission(&state, &helper),
            WatchedChangeAdmission::PackageInputOnly
        );
        assert!(state.package_inputs.rprofile_symbols.contains("before"));
    }
    write(root, "R/ignored.R", "after <- 1\n");
    ignore_event(backend, helper.clone(), FileChangeType::CHANGED).await;
    let state = backend.state.read().await;
    assert!(state.package_inputs.rprofile_symbols.contains("after"));
    assert!(!state.package_inputs.rprofile_symbols.contains("before"));
    assert!(
        !state
            .package_inputs
            .r_files
            .contains_key(&helper.to_file_path().unwrap())
    );
    assert!(!state.workspace_index.contains_artifacts(&helper));
}

#[tokio::test]
async fn gitignore_policy_swap_rejects_old_analysis_scan_and_package_candidates() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let uri = write(root, "file.R", "file_fn <- function() 1\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, true).await;
    let (analysis, scan, seed, exclusions) = {
        let mut state = backend.state.write().await;
        let intent = state.begin_workspace_scan_intent();
        (
            state.capture_closed_removal_analysis_basis(&uri),
            WorkspaceScanInputs::capture(&state, intent).unwrap(),
            PackageSeedInputSnapshot::capture(&state, &state.workspace_exclusions),
            state.workspace_exclusions.clone(),
        )
    };
    write(root, ".gitignore", "file.R\n");
    assert!(backend.refresh_discovery_policy().await);
    let mut state = backend.state.write().await;
    assert!(!state.workspace_scan_input_basis_is_current(&scan.basis));
    assert!(!seed.is_current_for(&state, root, &exclusions));
    let recaptured_with_stale_policy = PackageSeedInputSnapshot::capture(&state, &exclusions);
    assert!(!recaptured_with_stale_policy.is_current_for(&state, root, &exclusions));
    assert!(
        state
            .try_commit_analysis(crate::state::PreparedAnalysisCommit::Remove {
                basis: Box::new(analysis),
                uri
            })
            .is_err()
    );
}

#[tokio::test]
async fn gitignore_setting_and_file_deletion_reinclude_sources() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let uri = write(root, "file.R", "file_fn <- function() 1\n");
    let ignore = write(root, ".gitignore", "file.R\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, true).await;
    run_workspace_scan_transaction_inline(&backend.state)
        .await
        .expect_committed();
    assert!(
        !backend
            .state
            .read()
            .await
            .workspace_index
            .contains_artifacts(&uri)
    );
    backend.did_change_configuration(DidChangeConfigurationParams { settings: serde_json::json!({"packages": {"enabled": false}, "workspace": {"respectGitignore": false}}) }).await;
    settle(backend).await;
    assert!(
        backend
            .state
            .read()
            .await
            .workspace_index
            .contains_artifacts(&uri)
    );
    backend.did_change_configuration(DidChangeConfigurationParams { settings: serde_json::json!({"packages": {"enabled": false}, "workspace": {"respectGitignore": true}}) }).await;
    settle(backend).await;
    assert!(
        !backend
            .state
            .read()
            .await
            .workspace_index
            .contains_artifacts(&uri)
    );
    std::fs::remove_file(ignore.to_file_path().unwrap()).unwrap();
    ignore_event(backend, ignore, FileChangeType::DELETED).await;
    assert!(
        backend
            .state
            .read()
            .await
            .workspace_index
            .contains_artifacts(&uri)
    );
}

#[tokio::test]
async fn gitignore_workspace_folder_changes_move_package_root_and_clear_removed_entries() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    write(
        first.path(),
        "DESCRIPTION",
        "Package: first\nVersion: 0.0.1\n",
    );
    let old = write(first.path(), "R/old.R", "old_fn <- function() 1\n");
    write(
        second.path(),
        "DESCRIPTION",
        "Package: second\nVersion: 0.0.1\n",
    );
    let new = write(second.path(), "R/new.R", "new_fn <- function() 1\n");
    let ignored = write(second.path(), "R/ignored.R", "ignored_fn <- function() 1\n");
    write(second.path(), ".gitignore", "R/ignored.R\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, first.path(), true).await;
    run_workspace_scan_transaction_inline(&backend.state)
        .await
        .expect_committed();
    let folder = |path: &Path| WorkspaceFolder {
        uri: Url::from_file_path(path).unwrap(),
        name: "test".into(),
    };
    backend
        .did_change_workspace_folders(DidChangeWorkspaceFoldersParams {
            event: WorkspaceFoldersChangeEvent {
                added: vec![folder(second.path())],
                removed: vec![folder(first.path())],
            },
        })
        .await;
    settle(backend).await;
    {
        let state = backend.state.read().await;
        assert_eq!(
            state.package_inputs.workspace_root.as_deref(),
            Some(second.path())
        );
        assert_eq!(state.package_state.workspace().unwrap().name, "second");
        assert!(!state.workspace_index.contains_artifacts(&old));
        assert!(state.workspace_index.contains_artifacts(&new));
        assert!(!state.workspace_index.contains_artifacts(&ignored));
    }
    backend
        .did_change_workspace_folders(DidChangeWorkspaceFoldersParams {
            event: WorkspaceFoldersChangeEvent {
                added: vec![],
                removed: vec![folder(second.path())],
            },
        })
        .await;
    settle(backend).await;
    let state = backend.state.read().await;
    assert!(state.package_inputs.workspace_root.is_none());
    assert!(state.package_state.workspace().is_none());
    assert!(!state.workspace_index.contains_artifacts(&new));
}

#[tokio::test]
async fn gitignore_package_seed_prunes_inputs_even_without_workspace_indexing() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, "DESCRIPTION", "Package: demo\nVersion: 0.0.1\n");
    write(
        root,
        ".gitignore",
        "R/generated/\ntests/testthat/helper-hidden.R\ndata/hidden.csv\n",
    );
    write(root, "R/visible.R", "visible_fn <- function() 1\n");
    write(root, "R/generated/huge.R", "hidden_fn <- function() 1\n");
    write(
        root,
        "tests/testthat/helper-hidden.R",
        "hidden_helper <- function() 1\n",
    );
    write(root, "data/hidden.csv", "hidden\n1\n");
    write(root, "data/visible.csv", "visible\n1\n");
    write(root, "data-raw/.build/.gitignore", "generate.R\n");
    write(
        root,
        "data-raw/.build/generate.R",
        "hidden_sysdata <- 1\nusethis::use_data(hidden_sysdata, internal = TRUE)\n",
    );
    let service = service();
    let backend = service.inner();
    initialize(backend, root, false).await;
    let exclusions = backend.state.read().await.workspace_exclusions.clone();
    let seed = PrecomputedPackageSeed::compute_from_state(&backend.state, root, &exclusions, true)
        .await
        .unwrap();
    assert!(
        seed.install
            .disk_r_files
            .contains_key(&root.join("R/visible.R"))
    );
    assert!(
        !seed
            .install
            .disk_r_files
            .contains_key(&root.join("R/generated/huge.R"))
    );
    assert!(
        !seed
            .install
            .disk_r_files
            .contains_key(&root.join("tests/testthat/helper-hidden.R"))
    );
    assert!(!seed.install.dataset_names.contains("hidden"));
    assert!(seed.install.dataset_names.contains("visible"));
    assert!(!seed.install.sysdata_names.contains("hidden_sysdata"));
    let projection = seed.disk_projection.unwrap();
    assert!(
        !projection
            .entries
            .contains_key(&root.join("R/generated/huge.R"))
    );
    assert!(
        !projection
            .entries
            .contains_key(&root.join("data/hidden.csv"))
    );
    assert!(
        !projection
            .entries
            .contains_key(&root.join("data-raw/.build/generate.R"))
    );
}

#[tokio::test]
async fn gitignored_owner_close_prunes_descendants_and_hidden_cycles() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".gitignore", "owner.R\nhelper.R\n");
    let owner = write(
        root,
        "owner.R",
        "source('helper.R')\nsource('.hidden/back.R')\n",
    );
    let helper = write(root, "helper.R", "helper_fn <- function() 1\n");
    let back = write(root, ".hidden/back.R", "source('../owner.R')\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, true).await;
    open(
        backend,
        &owner,
        "source('helper.R')\nsource('.hidden/back.R')\n",
    )
    .await;
    for uri in [&helper, &back] {
        let _ = resync_file_from_disk(
            &backend.state,
            uri,
            None,
            None,
            false,
            None,
            ResyncCommitMode::Immediate,
        )
        .await;
    }
    assert!(
        backend
            .state
            .read()
            .await
            .workspace_index
            .contains_artifacts(&helper)
    );
    backend
        .did_close(DidCloseTextDocumentParams {
            text_document: TextDocumentIdentifier { uri: owner.clone() },
        })
        .await;
    settle(backend).await;
    let state = backend.state.read().await;
    assert!(!state.workspace_index.contains_artifacts(&owner));
    assert!(!state.workspace_index.contains_artifacts(&helper));
    assert!(state.cross_file_graph.get_dependencies(&helper).is_empty());
}

#[tokio::test]
async fn ignored_manifests_remain_package_only_watched_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".gitignore", "DESCRIPTION\nNAMESPACE\n");
    let manifest = write(root, "DESCRIPTION", "Package: before\nVersion: 0.0.1\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, false).await;
    assert_eq!(
        watched_change_admission(&*backend.state.read().await, &manifest),
        WatchedChangeAdmission::PackageInputOnly
    );
    write(root, "DESCRIPTION", "Package: after\nVersion: 0.0.1\n");
    ignore_event(backend, manifest, FileChangeType::CHANGED).await;
    assert_eq!(
        backend
            .state
            .read()
            .await
            .package_state
            .workspace()
            .unwrap()
            .name,
        "after"
    );
}

#[tokio::test]
async fn gitignored_dependencies_are_pruned_after_watched_owner_changes() {
    for delete_owner in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root, ".gitignore", "helper.R\nleaf.R\n");
        let owner = write(root, "owner.R", "source('helper.R')\n");
        let helper = write(root, "helper.R", "source('leaf.R')\n");
        let leaf = write(root, "leaf.R", "leaf_fn <- function() 1\n");
        let service = service();
        let backend = service.inner();
        initialize(backend, root, true).await;
        run_workspace_scan_transaction_inline(&backend.state)
            .await
            .expect_committed();
        for uri in [&helper, &leaf] {
            assert!(backend.index_file_on_demand(uri).await.is_some());
        }
        {
            let state = backend.state.read().await;
            assert!(state.workspace_index.contains_artifacts(&helper));
            assert!(state.workspace_index.contains_artifacts(&leaf));
            assert!(
                state
                    .cross_file_graph
                    .get_dependencies(&helper)
                    .iter()
                    .any(|edge| edge.to == leaf)
            );
        }

        let change = if delete_owner {
            std::fs::remove_file(root.join("owner.R")).unwrap();
            FileChangeType::DELETED
        } else {
            write(root, "owner.R", "owner_value <- 1\n");
            FileChangeType::CHANGED
        };
        ignore_event(backend, owner.clone(), change).await;

        let state = backend.state.read().await;
        assert_eq!(
            state.workspace_index.contains_artifacts(&owner),
            !delete_owner
        );
        for uri in [&helper, &leaf] {
            assert!(
                !state.workspace_index.contains_artifacts(uri),
                "ignored dependency survived watched owner change: {uri}, deleted={delete_owner}"
            );
            assert!(state.cross_file_graph.get_dependencies(uri).is_empty());
            assert!(state.cross_file_file_cache.get_snapshot(uri).is_none());
        }
    }
}

#[tokio::test]
async fn gitignored_prerequisite_chain_survives_until_open_owner_commits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    write(root, ".gitignore", "helper.R\nleaf.R\n");
    let owner = write(root, "owner.R", "source('helper.R')\n");
    let helper = write(root, "helper.R", "source('leaf.R')\n");
    let leaf = write(root, "leaf.R", "leaf_fn <- function() 1\n");
    let service = service();
    let backend = service.inner();
    initialize(backend, root, false).await;
    let pause = backend
        .state
        .write()
        .await
        .did_open_pre_commit_test_pause
        .arm(owner.clone());
    let handler = open(backend, &owner, "source('helper.R')\nleaf_fn()\n");
    tokio::pin!(handler);
    tokio::select! {
        _ = pause.wait_arrived() => {}
        _ = &mut handler => panic!("didOpen skipped the prerequisite inspection barrier"),
        _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
            panic!("didOpen did not finish prerequisite indexing")
        }
    }
    {
        let state = backend.state.read().await;
        assert!(!state.documents.contains_key(&owner));
        assert!(state.cross_file_graph.get_dependencies(&owner).is_empty());
        for uri in [&helper, &leaf] {
            assert!(
                state.workspace_index.contains_artifacts(uri),
                "ignored prerequisite was pruned before its open owner committed: {uri}"
            );
        }
        assert!(
            state
                .cross_file_graph
                .get_dependencies(&helper)
                .iter()
                .any(|edge| edge.to == leaf)
        );
    }
    pause.release();
    handler.await;
    settle(backend).await;
    let state = backend.state.read().await;
    assert!(state.documents.contains_key(&owner));
    assert!(state.workspace_index.contains_artifacts(&helper));
    assert!(state.workspace_index.contains_artifacts(&leaf));
    assert!(
        state
            .cross_file_graph
            .get_dependencies(&owner)
            .iter()
            .any(|edge| edge.to == helper)
    );
}
