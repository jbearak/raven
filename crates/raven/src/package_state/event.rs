//! Translation from LSP events to `PackageInputDelta` + input mutations.
//!
//! Handlers call `translate(&mut inputs, event)` to update inputs and
//! receive a delta. The caller then invokes
//! `WorldState::apply_package_event(delta)` to recompute derived state.

use super::*;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[derive(Debug)]
pub enum HandlerEvent {
    DidOpen {
        uri: tower_lsp::lsp_types::Url,
        text: Arc<str>,
    },
    DidChange {
        uri: tower_lsp::lsp_types::Url,
        text: Arc<str>,
    },
    DidClose {
        uri: tower_lsp::lsp_types::Url,
        on_disk_text: Option<Arc<str>>,
    },
    WatchedFileChanged {
        uri: tower_lsp::lsp_types::Url,
        on_disk_text: Option<Arc<str>>,
        deleted: bool,
    },
    SettingChanged {
        new_mode: crate::cross_file::config::PackageMode,
    },
}

pub fn translate(inputs: &mut PackageInputs, event: HandlerEvent) -> Option<PackageInputDelta> {
    // Events that can fire before a workspace root is known (or that don't
    // require one) are handled up front. Previously, the early
    // `let Some(root) = ... else { return None }` dropped these silently.
    if let HandlerEvent::SettingChanged { new_mode } = event {
        inputs.package_mode = new_mode;
        return Some(PackageInputDelta::SettingChanged);
    }

    let Some(root) = inputs.workspace_root.clone() else {
        return None;
    };
    match event {
        HandlerEvent::DidOpen { uri, text } | HandlerEvent::DidChange { uri, text } => {
            let path = uri.to_file_path().ok()?;
            if path == root.join("DESCRIPTION") {
                inputs.description = Some(DescriptionInput { text });
                return Some(PackageInputDelta::DescriptionChanged);
            }
            if path == root.join("NAMESPACE") {
                inputs.namespace = Some(NamespaceInput { text });
                return Some(PackageInputDelta::NamespaceChanged);
            }
            let kind = is_r_source_path(&path, &root)?;
            let digest = ContentDigest::of(&text);
            inputs.r_files.insert(
                path.clone(),
                RFileInput {
                    kind,
                    text,
                    content_digest: digest,
                },
            );
            Some(PackageInputDelta::RFileChanged { path, kind })
        }
        HandlerEvent::DidClose { uri, on_disk_text } => {
            let path = uri.to_file_path().ok()?;
            if path == root.join("DESCRIPTION") {
                inputs.description = on_disk_text.map(|text| DescriptionInput { text });
                return Some(PackageInputDelta::DescriptionChanged);
            }
            if path == root.join("NAMESPACE") {
                inputs.namespace = on_disk_text.map(|text| NamespaceInput { text });
                return Some(PackageInputDelta::NamespaceChanged);
            }
            let kind = is_r_source_path(&path, &root)?;
            match on_disk_text {
                Some(text) => {
                    let digest = ContentDigest::of(&text);
                    inputs.r_files.insert(
                        path.clone(),
                        RFileInput {
                            kind,
                            text,
                            content_digest: digest,
                        },
                    );
                    Some(PackageInputDelta::RFileChanged { path, kind })
                }
                None => {
                    inputs.r_files.remove(&path);
                    Some(PackageInputDelta::RFileDeleted { path, kind })
                }
            }
        }
        HandlerEvent::WatchedFileChanged {
            uri,
            on_disk_text,
            deleted,
        } => translate_watched(inputs, &root, uri, on_disk_text, deleted),
        // SettingChanged handled above.
        HandlerEvent::SettingChanged { .. } => None,
    }
}

fn translate_watched(
    inputs: &mut PackageInputs,
    root: &Path,
    uri: tower_lsp::lsp_types::Url,
    on_disk_text: Option<Arc<str>>,
    deleted: bool,
) -> Option<PackageInputDelta> {
    let path = uri.to_file_path().ok()?;

    // Normalize root and path once so comparisons against `<root>/DESCRIPTION`
    // and `<root>/NAMESPACE` aren't foiled by symlinks, casing, or trailing
    // separators. `canonicalize` requires the target to exist; fall back to
    // the original path on failure (e.g. when the file has just been deleted).
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.clone());
    let canonical_desc = canonical_root.join("DESCRIPTION");
    let canonical_ns = canonical_root.join("NAMESPACE");

    if canonical_path == canonical_desc || path == root.join("DESCRIPTION") {
        inputs.description = if deleted {
            None
        } else {
            on_disk_text
                .or_else(|| fs::read_to_string(&path).ok().map(Arc::from))
                .map(|t| DescriptionInput { text: t })
        };
        return Some(PackageInputDelta::DescriptionChanged);
    }

    if canonical_path == canonical_ns || path == root.join("NAMESPACE") {
        inputs.namespace = if deleted {
            None
        } else {
            on_disk_text
                .or_else(|| fs::read_to_string(&path).ok().map(Arc::from))
                .map(|t| NamespaceInput { text: t })
        };
        return Some(PackageInputDelta::NamespaceChanged);
    }

    if let Some(kind) = is_r_source_path(&path, root) {
        if deleted {
            inputs.r_files.remove(&path);
            return Some(PackageInputDelta::RFileDeleted { path, kind });
        }
        let text = on_disk_text.or_else(|| fs::read_to_string(&path).ok().map(Arc::from))?;
        let digest = ContentDigest::of(&text);
        inputs.r_files.insert(
            path.clone(),
            RFileInput {
                kind,
                text,
                content_digest: digest,
            },
        );
        return Some(PackageInputDelta::RFileChanged { path, kind });
    }

    translate_watched_directory(inputs, root, &path, deleted)
}

fn translate_watched_directory(
    inputs: &mut PackageInputs,
    root: &Path,
    path: &Path,
    deleted: bool,
) -> Option<PackageInputDelta> {
    if !deleted && !path.is_dir() {
        return None;
    }
    if !is_tracked_package_dir(path, root) {
        return None;
    }

    let mut deltas = Vec::new();
    let existing_under_path: Vec<_> = inputs
        .r_files
        .keys()
        .filter(|candidate| candidate.starts_with(path))
        .cloned()
        .collect();
    let mut seen = BTreeSet::new();

    if !deleted {
        collect_r_file_inputs_from_dir(inputs, root, path, &mut seen, &mut deltas);
    }

    for existing in existing_under_path {
        if seen.contains(&existing) {
            continue;
        }
        if let Some(kind) = inputs.r_files.remove(&existing).map(|entry| entry.kind) {
            deltas.push(PackageInputDelta::RFileDeleted {
                path: existing,
                kind,
            });
        }
    }

    if deltas.is_empty() {
        None
    } else {
        Some(PackageInputDelta::Batch(deltas))
    }
}

fn is_tracked_package_dir(path: &Path, root: &Path) -> bool {
    let r_dir = root.join("R");
    let testthat_dir = root.join("tests").join("testthat");
    path == r_dir
        || path.starts_with(&r_dir)
        || path == testthat_dir
        || path.starts_with(testthat_dir)
}

fn collect_r_file_inputs_from_dir(
    inputs: &mut PackageInputs,
    root: &Path,
    dir: &Path,
    seen: &mut BTreeSet<std::path::PathBuf>,
    deltas: &mut Vec<PackageInputDelta>,
) {
    for entry in walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.into_path();
        let Some(kind) = is_r_source_path(&path, root) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let text: Arc<str> = text.into();
        let digest = ContentDigest::of(&text);
        seen.insert(path.clone());
        inputs.r_files.insert(
            path.clone(),
            RFileInput {
                kind,
                text,
                content_digest: digest,
            },
        );
        deltas.push(PackageInputDelta::RFileChanged { path, kind });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cross_file::config::PackageMode;

    fn root_inputs() -> PackageInputs {
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some("/work/pkg".into());
        inputs.package_mode = PackageMode::Auto;
        inputs
    }

    #[test]
    fn did_change_for_r_file_emits_rfile_changed() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/R/foo.R").unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::DidChange {
                uri,
                text: "x <- 1\n".into(),
            },
        );
        assert!(matches!(
            delta,
            Some(PackageInputDelta::RFileChanged {
                kind: RFileKind::Source,
                ..
            })
        ));
        assert_eq!(inputs.r_files.len(), 1);
    }

    #[test]
    fn did_change_for_non_r_file_emits_no_delta() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/inst/data.R").unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::DidChange {
                uri,
                text: "x <- 1\n".into(),
            },
        );
        assert!(delta.is_none());
    }

    #[test]
    fn did_change_for_description_updates_input() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/DESCRIPTION").unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::DidChange {
                uri,
                text: "Package: foo\nImports: stats\n".into(),
            },
        );
        assert!(matches!(delta, Some(PackageInputDelta::DescriptionChanged)));
        assert_eq!(
            inputs.description.as_ref().map(|d| &*d.text),
            Some("Package: foo\nImports: stats\n")
        );
    }

    #[test]
    fn did_change_for_namespace_updates_input() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/NAMESPACE").unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::DidChange {
                uri,
                text: "importFrom(stats, median)\n".into(),
            },
        );
        assert!(matches!(delta, Some(PackageInputDelta::NamespaceChanged)));
        assert_eq!(
            inputs.namespace.as_ref().map(|d| &*d.text),
            Some("importFrom(stats, median)\n")
        );
    }

    #[test]
    fn description_change_updates_inputs_and_emits_delta() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/DESCRIPTION").unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged {
                uri,
                on_disk_text: Some("Package: foo\n".into()),
                deleted: false,
            },
        );
        assert!(matches!(delta, Some(PackageInputDelta::DescriptionChanged)));
        assert!(inputs.description.is_some());
    }

    #[test]
    fn description_deletion_clears_input() {
        let mut inputs = root_inputs();
        inputs.description = Some(DescriptionInput {
            text: "Package: foo\n".into(),
        });
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/DESCRIPTION").unwrap();
        let _ = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged {
                uri,
                on_disk_text: None,
                deleted: true,
            },
        );
        assert!(inputs.description.is_none());
    }

    #[test]
    fn did_close_with_disk_text_keeps_file_in_inputs() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/R/foo.R").unwrap();
        let _ = translate(
            &mut inputs,
            HandlerEvent::DidOpen {
                uri: uri.clone(),
                text: "open\n".into(),
            },
        );
        let _ = translate(
            &mut inputs,
            HandlerEvent::DidClose {
                uri: uri.clone(),
                on_disk_text: Some("disk\n".into()),
            },
        );
        let entry = inputs.r_files.get(&uri.to_file_path().unwrap()).unwrap();
        assert_eq!(&*entry.text, "disk\n");
    }

    #[test]
    fn did_close_without_disk_removes_file() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/R/foo.R").unwrap();
        let _ = translate(
            &mut inputs,
            HandlerEvent::DidOpen {
                uri: uri.clone(),
                text: "open\n".into(),
            },
        );
        let _ = translate(
            &mut inputs,
            HandlerEvent::DidClose {
                uri: uri.clone(),
                on_disk_text: None,
            },
        );
        assert!(inputs.r_files.is_empty());
    }

    #[test]
    fn watched_directory_change_hydrates_disk_r_files() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let r_dir = root.join("R");
        let test_dir = root.join("tests").join("testthat");
        std::fs::create_dir_all(&r_dir).unwrap();
        std::fs::create_dir_all(&test_dir).unwrap();
        std::fs::write(r_dir.join("foo.R"), "foo <- 1\n").unwrap();
        std::fs::write(test_dir.join("test-foo.R"), "test_that('foo', foo)\n").unwrap();

        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.package_mode = PackageMode::Auto;

        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged {
                uri: tower_lsp::lsp_types::Url::from_file_path(&r_dir).unwrap(),
                on_disk_text: None,
                deleted: false,
            },
        );

        assert!(matches!(delta, Some(PackageInputDelta::Batch(_))));
        assert!(inputs.r_files.contains_key(&r_dir.join("foo.R")));

        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged {
                uri: tower_lsp::lsp_types::Url::from_file_path(&test_dir).unwrap(),
                on_disk_text: None,
                deleted: false,
            },
        );

        assert!(matches!(delta, Some(PackageInputDelta::Batch(_))));
        assert!(inputs.r_files.contains_key(&test_dir.join("test-foo.R")));
    }

    #[test]
    fn watched_directory_delete_removes_existing_subtree_inputs() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let r_dir = root.join("R");
        let nested = r_dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();

        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.package_mode = PackageMode::Auto;
        for path in [r_dir.join("foo.R"), nested.join("bar.R")] {
            let text: std::sync::Arc<str> = "x <- 1\n".into();
            inputs.r_files.insert(
                path,
                RFileInput {
                    kind: RFileKind::Source,
                    content_digest: ContentDigest::of(&text),
                    text,
                },
            );
        }

        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged {
                uri: tower_lsp::lsp_types::Url::from_file_path(&r_dir).unwrap(),
                on_disk_text: None,
                deleted: true,
            },
        );

        assert!(matches!(delta, Some(PackageInputDelta::Batch(_))));
        assert!(inputs.r_files.is_empty());
    }

    #[test]
    fn watched_file_change_without_text_reads_from_disk() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        let r_dir = root.join("R");
        std::fs::create_dir_all(&r_dir).unwrap();
        let path = r_dir.join("foo.R");
        std::fs::write(&path, "foo <- 2\n").unwrap();

        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.package_mode = PackageMode::Auto;

        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged {
                uri: tower_lsp::lsp_types::Url::from_file_path(&path).unwrap(),
                on_disk_text: None,
                deleted: false,
            },
        );

        assert!(matches!(
            delta,
            Some(PackageInputDelta::RFileChanged { .. })
        ));
        let entry = inputs.r_files.get(&path).expect("file input");
        assert_eq!(&*entry.text, "foo <- 2\n");
    }

    #[test]
    fn setting_changed_without_workspace_root_is_applied() {
        let mut inputs = PackageInputs::default();
        assert!(inputs.workspace_root.is_none());
        // Start in the default Auto mode.
        assert_eq!(inputs.package_mode, PackageMode::Auto);
        let delta = translate(
            &mut inputs,
            HandlerEvent::SettingChanged {
                new_mode: PackageMode::Disabled,
            },
        );
        assert!(matches!(delta, Some(PackageInputDelta::SettingChanged)));
        assert_eq!(inputs.package_mode, PackageMode::Disabled);
    }
}
