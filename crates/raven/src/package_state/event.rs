//! Translation from LSP events to `PackageInputDelta` + input mutations.
//!
//! Handlers call `translate(&mut inputs, event)` to update inputs and
//! receive a delta. The caller then invokes
//! `WorldState::apply_package_event(delta)` to recompute derived state.

use super::*;
use std::path::Path;

pub enum HandlerEvent {
    DidOpen { uri: tower_lsp::lsp_types::Url, version: i32, text: Arc<str> },
    DidChange { uri: tower_lsp::lsp_types::Url, version: i32, text: Arc<str> },
    DidClose { uri: tower_lsp::lsp_types::Url, on_disk_text: Option<Arc<str>> },
    WatchedFileChanged {
        uri: tower_lsp::lsp_types::Url,
        on_disk_text: Option<Arc<str>>,
        deleted: bool,
    },
    SettingChanged { new_mode: crate::cross_file::config::PackageMode },
    Initial,
}

pub fn translate(
    inputs: &mut PackageInputs,
    event: HandlerEvent,
) -> Option<PackageInputDelta> {
    let Some(root) = inputs.workspace_root.clone() else { return None };
    match event {
        HandlerEvent::DidOpen { uri, version, text }
        | HandlerEvent::DidChange { uri, version, text } => {
            let path = uri.to_file_path().ok()?;
            let kind = is_r_source_path(&path, &root)?;
            let digest = ContentDigest::of(&text);
            inputs.r_files.insert(
                path.clone(),
                RFileInput {
                    kind,
                    origin: ContentOrigin::Open { version },
                    text,
                    content_digest: digest,
                },
            );
            Some(PackageInputDelta::RFileChanged { path, kind })
        }
        HandlerEvent::DidClose { uri, on_disk_text } => {
            let path = uri.to_file_path().ok()?;
            let kind = is_r_source_path(&path, &root)?;
            match on_disk_text {
                Some(text) => {
                    let digest = ContentDigest::of(&text);
                    inputs.r_files.insert(
                        path.clone(),
                        RFileInput {
                            kind,
                            origin: ContentOrigin::Disk,
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
        HandlerEvent::SettingChanged { new_mode } => {
            inputs.package_mode = new_mode;
            Some(PackageInputDelta::SettingChanged)
        }
        HandlerEvent::Initial => Some(PackageInputDelta::Initial),
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

    if path == root.join("DESCRIPTION") {
        inputs.description = if deleted {
            None
        } else {
            on_disk_text.map(|t| DescriptionInput { path: path.clone(), text: t })
        };
        return Some(PackageInputDelta::DescriptionChanged);
    }

    if path == root.join("NAMESPACE") {
        inputs.namespace = if deleted {
            None
        } else {
            on_disk_text.map(|t| NamespaceInput { path: path.clone(), text: t })
        };
        return Some(PackageInputDelta::NamespaceChanged);
    }

    if let Some(kind) = is_r_source_path(&path, root) {
        if deleted {
            inputs.r_files.remove(&path);
            return Some(PackageInputDelta::RFileDeleted { path, kind });
        }
        if let Some(text) = on_disk_text {
            let digest = ContentDigest::of(&text);
            inputs.r_files.insert(
                path.clone(),
                RFileInput {
                    kind,
                    origin: ContentOrigin::Disk,
                    text,
                    content_digest: digest,
                },
            );
            return Some(PackageInputDelta::RFileChanged { path, kind });
        }
    }
    None
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
            HandlerEvent::DidChange { uri, version: 1, text: "x <- 1\n".into() },
        );
        assert!(matches!(
            delta,
            Some(PackageInputDelta::RFileChanged { kind: RFileKind::Source, .. })
        ));
        assert_eq!(inputs.r_files.len(), 1);
    }

    #[test]
    fn did_change_for_non_r_file_emits_no_delta() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/inst/data.R").unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::DidChange { uri, version: 1, text: "x <- 1\n".into() },
        );
        assert!(delta.is_none());
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
            path: "/work/pkg/DESCRIPTION".into(),
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
        let _ = translate(&mut inputs, HandlerEvent::DidOpen {
            uri: uri.clone(), version: 1, text: "open\n".into(),
        });
        let _ = translate(&mut inputs, HandlerEvent::DidClose {
            uri: uri.clone(), on_disk_text: Some("disk\n".into()),
        });
        let entry = inputs.r_files.get(&uri.to_file_path().unwrap()).unwrap();
        assert!(matches!(entry.origin, ContentOrigin::Disk));
        assert_eq!(&*entry.text, "disk\n");
    }

    #[test]
    fn did_close_without_disk_removes_file() {
        let mut inputs = root_inputs();
        let uri = tower_lsp::lsp_types::Url::from_file_path("/work/pkg/R/foo.R").unwrap();
        let _ = translate(&mut inputs, HandlerEvent::DidOpen {
            uri: uri.clone(), version: 1, text: "open\n".into(),
        });
        let _ = translate(&mut inputs, HandlerEvent::DidClose {
            uri: uri.clone(), on_disk_text: None,
        });
        assert!(inputs.r_files.is_empty());
    }
}
