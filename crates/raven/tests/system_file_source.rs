//! Integration tests for `source(system.file(...))` resolution.
//!
//! Tests that:
//! 1. `source(system.file("helper.R", package = <self>))` resolves the helper's
//!    top-level definitions into the sourcing file's scope (no undefined-variable
//!    false positives, no "Cannot resolve path" diagnostic).
//! 2. An unresolved cross-package `system.file()` produces ZERO diagnostics
//!    (graceful degradation — silent skip, not a spurious error).
//! 3. Resolution is recoverable across package lifecycle events: a package
//!    installed/removed after startup, or a workspace `Package:` rename, must
//!    re-resolve via `resolve_system_file_in_workspace` (the call the
//!    `LibpathEvent::Changed` consumer and the DESCRIPTION manifest branch
//!    make) without the user editing the sourcing file.
//!
//! Run with: `cargo test --release -p raven --test system_file_source`

use std::process::Command;
use tempfile::TempDir;

fn raven_binary() -> std::path::PathBuf {
    let mut path = std::env::current_exe().unwrap();
    path.pop(); // remove test binary name
    path.pop(); // remove `deps`
    path.push("raven");
    path
}

fn run_check(workspace: &std::path::Path) -> String {
    let output = Command::new(raven_binary())
        .args(["check", "--workspace"])
        .arg(workspace)
        .args(["--max-severity", "off", "--no-color"])
        .output()
        .expect("failed to execute raven check");
    // `raven check` exits 0 (clean) or 1 (diagnostics emitted; under
    // `--max-severity off` any diagnostic trips this). Only exit 2 (operator
    // error) or a signal indicate a genuine failure — without this guard the
    // string assertions below would pass vacuously on empty stdout.
    assert!(
        matches!(output.status.code(), Some(0) | Some(1)),
        "raven check failed (status {:?}). stderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

/// Escape a filesystem path for embedding in a TOML basic string. On Windows a
/// raw path contains backslashes (and may contain quotes) that TOML would
/// otherwise treat as escape sequences, producing invalid config.
fn toml_escape(path: &std::path::Path) -> String {
    path.display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// source(system.file("helper.R", package = <self>)) resolves the helper's
/// definitions into scope — no undefined-variable FP, no path diagnostic.
#[test]
fn system_file_self_package_resolves_helper_into_scope() {
    let dir = TempDir::new().unwrap();

    // DESCRIPTION makes this a package workspace
    std::fs::write(
        dir.path().join("DESCRIPTION"),
        "Package: testpkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // inst/helper.R defines a function
    std::fs::create_dir_all(dir.path().join("inst")).unwrap();
    std::fs::write(
        dir.path().join("inst").join("helper.R"),
        "my_helper <- function(x) x + 1\n",
    )
    .unwrap();

    // R/main.R sources via system.file and uses the helper
    std::fs::create_dir_all(dir.path().join("R")).unwrap();
    std::fs::write(
        dir.path().join("R").join("main.R"),
        "source(system.file(\"helper.R\", package = \"testpkg\"))\nresult <- my_helper(42)\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "system.file(\"helper.R\", package = \"testpkg\") should resolve \
         to inst/helper.R. Output:\n{output}"
    );
    assert!(
        !output.contains("Undefined variable: my_helper")
            && !output.contains("Undefined function: my_helper"),
        "my_helper should be in scope via source(system.file(...)). Output:\n{output}"
    );
}

/// source(system.file("helper.R", package = "otherpkg")) resolves the helper's
/// definitions into scope when otherpkg is present at a configured lib_path —
/// no undefined-variable FP, no path diagnostic.
#[test]
fn system_file_cross_package_installed_resolves_helper_into_scope() {
    let workspace = TempDir::new().unwrap();
    let libdir = TempDir::new().unwrap();

    // Create installed "otherpkg" with helper.R at libdir/otherpkg/helper.R
    // (installed layout: NO inst/ prefix)
    let pkg_dir = libdir.path().join("otherpkg");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("helper.R"),
        "cross_pkg_fn <- function(x) x * 2\n",
    )
    .unwrap();

    // Workspace DESCRIPTION
    std::fs::write(
        workspace.path().join("DESCRIPTION"),
        "Package: mypkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // raven.toml with additionalLibraryPaths
    std::fs::write(
        workspace.path().join("raven.toml"),
        format!(
            "[packages]\nadditionalLibraryPaths = [\"{}\"]\n",
            toml_escape(libdir.path())
        ),
    )
    .unwrap();

    // R/main.R sources from otherpkg and uses the symbol
    std::fs::create_dir_all(workspace.path().join("R")).unwrap();
    std::fs::write(
        workspace.path().join("R").join("main.R"),
        "source(system.file(\"helper.R\", package = \"otherpkg\"))\nresult <- cross_pkg_fn(42)\n",
    )
    .unwrap();

    let output = run_check(workspace.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "system.file(\"helper.R\", package = \"otherpkg\") should resolve \
         via additionalLibraryPaths. Output:\n{output}"
    );
    assert!(
        !output.contains("Undefined variable: cross_pkg_fn")
            && !output.contains("Undefined function: cross_pkg_fn"),
        "cross_pkg_fn should be in scope via cross-package system.file(). Output:\n{output}"
    );
}

/// An unresolved cross-package system.file() produces ZERO diagnostics —
/// graceful degradation matching pre-feature behavior (silent skip).
#[test]
fn system_file_cross_package_unresolved_produces_no_diagnostics() {
    let dir = TempDir::new().unwrap();

    // DESCRIPTION for self package
    std::fs::write(
        dir.path().join("DESCRIPTION"),
        "Package: mypkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // R/main.R sources from a different (not-installed) package
    std::fs::create_dir_all(dir.path().join("R")).unwrap();
    std::fs::write(
        dir.path().join("R").join("main.R"),
        "source(system.file(\"scripts/setup.R\", package = \"otherpkg\"))\nx <- 1\n",
    )
    .unwrap();

    let output = run_check(dir.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "Unresolved cross-package system.file() must not produce path diagnostics. \
         Output:\n{output}"
    );
    assert!(
        !output.contains("system.file") && !output.contains("otherpkg"),
        "No diagnostic should mention system.file or the unresolved package. \
         Output:\n{output}"
    );
}

/// Transitive system.file() resolution: a closed child reached via
/// source(system.file(...)) itself contains another source(system.file(...)),
/// and both hops resolve correctly so the grandchild's definitions are in scope.
#[test]
fn system_file_transitive_nested_resolution() {
    let workspace = TempDir::new().unwrap();
    let libdir = TempDir::new().unwrap();

    // Create installed "otherpkg" with two files:
    //   otherpkg/entry.R -> source(system.file("impl.R", package = "otherpkg"))
    //   otherpkg/impl.R  -> defines `deep_fn`
    let pkg_dir = libdir.path().join("otherpkg");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("entry.R"),
        "source(system.file(\"impl.R\", package = \"otherpkg\"))\nentry_fn <- function() deep_fn()\n",
    )
    .unwrap();
    std::fs::write(pkg_dir.join("impl.R"), "deep_fn <- function() 42\n").unwrap();

    // Workspace DESCRIPTION
    std::fs::write(
        workspace.path().join("DESCRIPTION"),
        "Package: mypkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();

    // raven.toml with additionalLibraryPaths
    std::fs::write(
        workspace.path().join("raven.toml"),
        format!(
            "[packages]\nadditionalLibraryPaths = [\"{}\"]\n",
            toml_escape(libdir.path())
        ),
    )
    .unwrap();

    // R/main.R sources entry.R which itself sources impl.R
    std::fs::create_dir_all(workspace.path().join("R")).unwrap();
    std::fs::write(
        workspace.path().join("R").join("main.R"),
        "source(system.file(\"entry.R\", package = \"otherpkg\"))\nresult <- entry_fn()\n",
    )
    .unwrap();

    let output = run_check(workspace.path());
    assert!(
        !output.contains("Cannot resolve path"),
        "Transitive system.file() should resolve both hops. Output:\n{output}"
    );
    assert!(
        !output.contains("Undefined variable: entry_fn")
            && !output.contains("Undefined function: entry_fn"),
        "entry_fn should be in scope via transitive system.file(). Output:\n{output}"
    );
}

/// `collect_diagnostics_blocking` (the test helper in check.rs) now resolves
/// workspace system.file() edges, matching `run()`. Previously it skipped
/// `resolve_system_file_in_workspace`, so installed-package system.file() edges
/// stayed unresolved in the test harness.
#[test]
fn system_file_collect_diagnostics_blocking_resolves_installed_package() {
    let workspace = TempDir::new().unwrap();
    let libdir = TempDir::new().unwrap();

    // Installed package with a helper
    let pkg_dir = libdir.path().join("instpkg");
    std::fs::create_dir_all(&pkg_dir).unwrap();
    std::fs::write(
        pkg_dir.join("helper.R"),
        "inst_helper <- function(x) x + 1\n",
    )
    .unwrap();

    // Workspace
    std::fs::write(
        workspace.path().join("DESCRIPTION"),
        "Package: mypkg\nTitle: Test\nVersion: 0.1.0\n",
    )
    .unwrap();
    std::fs::write(
        workspace.path().join("raven.toml"),
        format!(
            "[packages]\nadditionalLibraryPaths = [\"{}\"]\n",
            toml_escape(libdir.path())
        ),
    )
    .unwrap();

    std::fs::create_dir_all(workspace.path().join("R")).unwrap();
    std::fs::write(
        workspace.path().join("R").join("main.R"),
        "source(system.file(\"helper.R\", package = \"instpkg\"))\nresult <- inst_helper(1)\n",
    )
    .unwrap();

    // Use raven check (which exercises both run() and, implicitly, the same
    // resolve path as collect_diagnostics_blocking after our fix).
    let output = run_check(workspace.path());
    assert!(
        !output.contains("Undefined variable: inst_helper")
            && !output.contains("Undefined function: inst_helper"),
        "inst_helper should be resolved via system.file() in raven check. Output:\n{output}"
    );
}

// ---------------------------------------------------------------------------
// Lifecycle recoverability: `WorldState`-level tests exercising
// `resolve_system_file_in_workspace`, the exact call the
// `LibpathEvent::Changed` consumer and the DESCRIPTION manifest branch make
// after a package install/removal or `Package:` rename. No file edits happen
// between resolution passes — recovery must come from re-resolution alone.
// ---------------------------------------------------------------------------

mod lifecycle {
    use std::sync::Arc;

    use raven::cross_file::FileSnapshot;
    use raven::cross_file::source_detect::SystemFileCall;
    use raven::cross_file::types::{CrossFileMetadata, ForwardSource};
    use raven::package_library::PackageLibrary;
    use raven::state::WorldState;
    use raven::workspace_index::IndexEntry;
    use tower_lsp::lsp_types::Url;

    /// Index entry whose only source is `source(system.file(<part>, package = <pkg>))`.
    fn system_file_entry(part: &str, pkg: &str) -> IndexEntry {
        let metadata = CrossFileMetadata {
            sources: vec![ForwardSource {
                system_file: Some(SystemFileCall {
                    parts: vec![part.to_string()],
                    package: pkg.to_string(),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };
        IndexEntry {
            contents: ropey::Rope::from_str(&format!(
                "source(system.file(\"{part}\", package = \"{pkg}\"))\n"
            )),
            tree: None,
            loaded_packages: Vec::new(),
            snapshot: FileSnapshot {
                mtime: std::time::SystemTime::UNIX_EPOCH,
                size: 1,
                content_hash: Some(1),
            },
            metadata: Arc::new(metadata),
            artifacts: Arc::new(raven::cross_file::scope::ScopeArtifacts::default()),
            indexed_at_version: 1,
        }
    }

    fn state_with_lib(libdir: &std::path::Path) -> WorldState {
        let mut state = WorldState::new();
        let mut lib = PackageLibrary::new_empty();
        lib.set_lib_paths(vec![libdir.to_path_buf()]);
        state.package_library = Arc::new(lib);
        state
    }

    /// Package installed AFTER startup: the first resolution pass runs with
    /// non-empty lib_paths and fails (package not installed). The
    /// `LibpathEvent::Changed` consumer then re-runs resolution — the edge must
    /// form without any edit to the sourcing file.
    #[test]
    fn edge_forms_after_package_install_without_edit() {
        let libdir = tempfile::tempdir().unwrap();
        let uri = Url::parse("file:///workspace/uses_helper.R").unwrap();

        let mut state = state_with_lib(libdir.path());
        state
            .workspace_index_new
            .insert(uri.clone(), system_file_entry("helper.R", "otherpkg"));

        // Startup pass: lib_paths non-empty, otherpkg not installed.
        state.resolve_system_file_in_workspace();

        // The source entry must survive the failed attempt — dropping it makes
        // the staleness unrecoverable.
        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        assert_eq!(
            entry.metadata.sources.len(),
            1,
            "unresolved system.file source must be retained for later re-resolution"
        );

        // "Install" the package (what LibpathEvent::Changed reports), then
        // re-run resolution exactly as the Changed consumer does.
        let pkg_dir = libdir.path().join("otherpkg");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("helper.R"), "helper_fn <- function() 42\n").unwrap();
        state.resolve_system_file_in_workspace();

        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        let resolved_uri = entry.metadata.sources[0]
            .resolved_uri
            .clone()
            .expect("source must resolve after the package install event");
        let resolved_path = resolved_uri.to_file_path().unwrap();
        assert!(
            resolved_path.ends_with("otherpkg/helper.R"),
            "must resolve into the installed package, got {resolved_path:?}"
        );
        assert!(
            state
                .cross_file_graph
                .get_dependencies(&uri)
                .iter()
                .any(|e| e.to == resolved_uri),
            "dependency edge must form after the install event"
        );
    }

    /// Package REMOVED after a successful resolution: the stale resolved_uri
    /// and dependency edge must be cleared by the next resolution pass, and a
    /// reinstall must bring them back.
    #[test]
    fn resolution_clears_after_package_removal_and_recovers_on_reinstall() {
        let libdir = tempfile::tempdir().unwrap();
        let pkg_dir = libdir.path().join("otherpkg");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("helper.R"), "helper_fn <- function() 42\n").unwrap();

        let uri = Url::parse("file:///workspace/uses_helper.R").unwrap();
        let mut state = state_with_lib(libdir.path());
        state
            .workspace_index_new
            .insert(uri.clone(), system_file_entry("helper.R", "otherpkg"));

        state.resolve_system_file_in_workspace();
        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        let resolved_uri = entry.metadata.sources[0]
            .resolved_uri
            .clone()
            .expect("source must resolve while the package is installed");

        // Remove the package, then re-run resolution as the Changed consumer does.
        std::fs::remove_dir_all(&pkg_dir).unwrap();
        state.resolve_system_file_in_workspace();

        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        assert_eq!(
            entry.metadata.sources.len(),
            1,
            "source entry must be retained after the package removal"
        );
        assert!(
            entry.metadata.sources[0].resolved_uri.is_none(),
            "stale resolved_uri must be cleared after the package removal"
        );
        assert!(
            !state
                .cross_file_graph
                .get_dependencies(&uri)
                .iter()
                .any(|e| e.to == resolved_uri),
            "stale dependency edge must be removed after the package removal"
        );

        // Reinstall: resolution must recover.
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("helper.R"), "helper_fn <- function() 42\n").unwrap();
        state.resolve_system_file_in_workspace();

        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        assert!(
            entry.metadata.sources[0].resolved_uri.is_some(),
            "source must re-resolve after the package is reinstalled"
        );
    }

    /// Open transitive dependents of a file whose system.file resolution
    /// changed must be in the republish set: file_b sources file_a, file_a's
    /// system.file edge forms after a package install — file_b's cross-file
    /// scope now includes the helper's definitions, so its diagnostics are
    /// stale unless it is republished too.
    #[test]
    fn open_dependents_of_changed_files_are_in_republish_set() {
        use raven::state::Document;

        let libdir = tempfile::tempdir().unwrap();
        let child_uri = Url::parse("file:///workspace/uses_helper.R").unwrap();
        let parent_uri = Url::parse("file:///workspace/parent.R").unwrap();

        let mut state = state_with_lib(libdir.path());
        state
            .workspace_index_new
            .insert(child_uri.clone(), system_file_entry("helper.R", "otherpkg"));

        // parent.R sources uses_helper.R (ordinary path source).
        let parent_meta = CrossFileMetadata {
            sources: vec![ForwardSource {
                path: "uses_helper.R".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        state
            .cross_file_graph
            .update_file(&parent_uri, &parent_meta, None, |_| None);

        // Both files are open documents.
        state.documents.insert(
            parent_uri.clone(),
            Document::new_with_uri("source(\"uses_helper.R\")\n", None, &parent_uri),
        );
        state.documents.insert(
            child_uri.clone(),
            Document::new_with_uri(
                "source(system.file(\"helper.R\", package = \"otherpkg\"))\n",
                None,
                &child_uri,
            ),
        );

        // Startup pass fails (otherpkg not installed), then the install event.
        state.resolve_system_file_in_workspace();
        let pkg_dir = libdir.path().join("otherpkg");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("helper.R"), "helper_fn <- function() 42\n").unwrap();
        let changed = state.resolve_system_file_in_workspace();
        assert_eq!(
            changed,
            vec![child_uri.clone()],
            "only the file with the system.file source changes resolution"
        );

        let republish = state.system_file_republish_set(&changed);
        assert!(
            republish.contains(&child_uri),
            "the changed file itself must be republished, got {republish:?}"
        );
        assert!(
            republish.contains(&parent_uri),
            "an open dependent sourcing the changed file must be republished, got {republish:?}"
        );
    }

    /// The package-filtered resolution variant (used by the libpath-event
    /// consumer) must only re-probe entries referencing the changed packages,
    /// leaving unrelated resolved entries untouched.
    #[test]
    fn filtered_resolution_skips_unrelated_packages() {
        use std::collections::HashSet;

        let libdir = tempfile::tempdir().unwrap();
        for pkg in ["pkga", "pkgb"] {
            let dir = libdir.path().join(pkg);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("helper.R"), "f <- function() 1\n").unwrap();
        }

        let uri_a = Url::parse("file:///workspace/a.R").unwrap();
        let uri_b = Url::parse("file:///workspace/b.R").unwrap();
        let mut state = state_with_lib(libdir.path());
        state
            .workspace_index_new
            .insert(uri_a.clone(), system_file_entry("helper.R", "pkga"));
        state
            .workspace_index_new
            .insert(uri_b.clone(), system_file_entry("helper.R", "pkgb"));

        state.resolve_system_file_in_workspace();
        for uri in [&uri_a, &uri_b] {
            assert!(
                state.workspace_index_new.get(uri).unwrap().metadata.sources[0]
                    .resolved_uri
                    .is_some(),
                "both packages installed → both entries resolve"
            );
        }

        // Both packages disappear from disk, but the event names only pkgb.
        std::fs::remove_dir_all(libdir.path().join("pkga")).unwrap();
        std::fs::remove_dir_all(libdir.path().join("pkgb")).unwrap();
        let only_b: HashSet<String> = std::iter::once("pkgb".to_string()).collect();
        let changed = state.resolve_system_file_in_workspace_for_packages(Some(&only_b));

        assert_eq!(
            changed,
            vec![uri_b.clone()],
            "only the entry referencing the filtered package may change"
        );
        assert!(
            state
                .workspace_index_new
                .get(&uri_a)
                .unwrap()
                .metadata
                .sources[0]
                .resolved_uri
                .is_some(),
            "entry for a package outside the filter must not be re-probed"
        );
        assert!(
            state
                .workspace_index_new
                .get(&uri_b)
                .unwrap()
                .metadata
                .sources[0]
                .resolved_uri
                .is_none(),
            "entry for the filtered package must be re-resolved (cleared)"
        );

        // A later event naming pkga clears the remaining stale entry.
        let only_a: HashSet<String> = std::iter::once("pkga".to_string()).collect();
        let changed = state.resolve_system_file_in_workspace_for_packages(Some(&only_a));
        assert_eq!(changed, vec![uri_a.clone()]);
        assert!(
            state
                .workspace_index_new
                .get(&uri_a)
                .unwrap()
                .metadata
                .sources[0]
                .resolved_uri
                .is_none()
        );
    }

    /// Workspace `Package:` rename: a self-package `system.file()` reference
    /// that could not resolve under the old name (and ran with non-empty
    /// lib_paths, the previously-dropped case) must resolve via branch 1 once
    /// DESCRIPTION names the matching package — the call the manifest-change
    /// branch makes after `apply_package_event`.
    #[test]
    fn branch1_resolution_recovers_after_package_rename() {
        use raven::package_state::{DescriptionInput, PackageInputDelta};

        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("inst")).unwrap();
        std::fs::write(
            workspace.path().join("inst").join("helper.R"),
            "helper_fn <- function() 42\n",
        )
        .unwrap();

        // Non-empty lib_paths so the failed cross-package attempt is the
        // "attempted, not deferred" case.
        let libdir = tempfile::tempdir().unwrap();
        let mut state = state_with_lib(libdir.path());
        state.package_inputs.workspace_root = Some(workspace.path().to_path_buf());
        state.package_inputs.description = Some(DescriptionInput {
            text: Arc::from("Package: oldpkg\nTitle: T\nVersion: 0.1.0\n"),
        });
        state.apply_package_event(&PackageInputDelta::DescriptionChanged);

        let uri = Url::from_file_path(workspace.path().join("R").join("main.R")).unwrap();
        state
            .workspace_index_new
            .insert(uri.clone(), system_file_entry("helper.R", "newpkg"));

        // Under "Package: oldpkg" the reference to "newpkg" cannot resolve.
        state.resolve_system_file_in_workspace();
        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        assert_eq!(
            entry.metadata.sources.len(),
            1,
            "unresolved system.file source must be retained across the rename"
        );

        // Rename the workspace package, then re-resolve as the manifest branch does.
        state.package_inputs.description = Some(DescriptionInput {
            text: Arc::from("Package: newpkg\nTitle: T\nVersion: 0.1.0\n"),
        });
        state.apply_package_event(&PackageInputDelta::DescriptionChanged);
        state.resolve_system_file_in_workspace();

        let entry = state
            .workspace_index_new
            .get(&uri)
            .expect("entry still indexed");
        assert_eq!(
            entry.metadata.sources[0].path, "/inst/helper.R",
            "self-package system.file must resolve via branch 1 after the rename"
        );
    }
}
