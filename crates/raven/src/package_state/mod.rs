//! R package mode subsystem.
//!
//! See `docs/superpowers/specs/2026-05-10-r-package-mode-architecture-design.md`
//! for the architectural rationale.
//!
//! This module owns all derived state for R package mode. Outside of this
//! module, `PackageState` is read-only — it can only be replaced as a
//! whole, never partially mutated.

pub mod derive;
pub use derive::derive_package_state;
pub mod digest;
pub use digest::ContentDigest;
pub mod event;

#[cfg(test)]
mod proptest_machine;

use std::path::PathBuf;
use std::sync::Arc;

use crate::package_namespace::{PackageNamespaceModel, PackageWorkspace};
use crate::roxygen::RoxygenNamespace;

/// Derived state for R package mode. Owned by `WorldState`.
/// Fully derive-based since Phase 5b: all fields are computed by `derive_package_state`.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct PackageState {
    pub(super) workspace: Option<PackageWorkspace>,
    pub(super) namespace_model: Option<PackageNamespaceModel>,

    // Populated by derive_package_state
    pub(super) r_file_facts: BTreeMap<PathBuf, RFileFacts>,
    pub(super) scope_contribution: PackageScopeContribution,
}

impl PackageState {
    pub fn new() -> Self {
        Self {
            workspace: None,
            namespace_model: None,
            r_file_facts: BTreeMap::new(),
            scope_contribution: PackageScopeContribution::default(),
        }
    }

    pub fn workspace(&self) -> Option<&PackageWorkspace> {
        self.workspace.as_ref()
    }

    pub fn namespace_model(&self) -> Option<&PackageNamespaceModel> {
        self.namespace_model.as_ref()
    }

    #[allow(dead_code)]
    pub fn r_file_facts(&self) -> &BTreeMap<PathBuf, RFileFacts> {
        &self.r_file_facts
    }

    pub fn scope_contribution(&self) -> &PackageScopeContribution {
        &self.scope_contribution
    }

    /// Replace all derived package-mode state in one step.
    ///
    /// `PackageState` fields stay non-public so consumers cannot update one
    /// derived cache without the others. Event handlers update
    /// `PackageInputs`, call `derive_package_state`, and then install the
    /// complete result through this method.
    pub(super) fn set_from(&mut self, new: PackageState) {
        *self = new;
    }
}

// ============== INPUTS ==============

use crate::cross_file::config::PackageMode;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct PackageInputs {
    pub workspace_root: Option<PathBuf>,
    pub package_mode: PackageMode,
    pub description: Option<DescriptionInput>,
    pub namespace: Option<NamespaceInput>,
    pub r_files: BTreeMap<PathBuf, RFileInput>,
}

#[derive(Clone, Debug)]
pub struct DescriptionInput {
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct NamespaceInput {
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct RFileInput {
    pub kind: RFileKind,
    pub text: Arc<str>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum RFileKind {
    Source,
    Test,
}

#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn default_inputs_are_empty() {
        let inputs = PackageInputs::default();
        assert!(inputs.workspace_root.is_none());
        assert!(inputs.r_files.is_empty());
    }
}

// ============== DELTA ==============

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PackageInputDelta {
    Initial,
    RFileChanged { path: PathBuf, kind: RFileKind },
    RFileDeleted { path: PathBuf, kind: RFileKind },
    NamespaceChanged,
    DescriptionChanged,
    SettingChanged,
    Batch(Vec<PackageInputDelta>),
}

// ============== PATH HELPERS ==============

use std::path::Path;

/// Returns `Some(kind)` if `path` is a package source/test file we track,
/// based on the workspace root. Returns `None` otherwise.
///
/// Rules:
/// - `<root>/R/**/*.R` (or `*.r`) → `Source`
/// - `<root>/tests/testthat/**/*.R` (or `*.r`) → `Test`
/// - everything else → `None`
pub fn is_r_source_path(path: &Path, workspace_root: &Path) -> Option<RFileKind> {
    let rel = path.strip_prefix(workspace_root).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?.as_os_str().to_str()?;

    let is_r_extension = matches!(path.extension().and_then(|e| e.to_str()), Some("R" | "r"),);
    if !is_r_extension {
        return None;
    }

    match first {
        "R" => Some(RFileKind::Source),
        "tests" => {
            let second = comps.next()?.as_os_str().to_str()?;
            if second == "testthat" {
                Some(RFileKind::Test)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn r_source_path_recognizes_R_dir() {
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.R"), Path::new("/work/pkg")),
            Some(RFileKind::Source),
        );
    }

    #[test]
    fn r_source_path_recognizes_testthat() {
        assert_eq!(
            is_r_source_path(
                Path::new("/work/pkg/tests/testthat/test-utils.R"),
                Path::new("/work/pkg")
            ),
            Some(RFileKind::Test),
        );
    }

    #[test]
    fn r_source_path_rejects_non_R_files() {
        let root = Path::new("/work/pkg");
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.txt"), root),
            None
        );
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/inst/data.R"), root),
            None
        );
        assert_eq!(
            is_r_source_path(Path::new("/elsewhere/utils.R"), root),
            None
        );
    }

    #[test]
    fn r_source_path_handles_lowercase_extension() {
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.r"), Path::new("/work/pkg")),
            Some(RFileKind::Source),
        );
    }

    #[test]
    fn r_source_path_recognizes_subdirs_in_R() {
        assert_eq!(
            is_r_source_path(
                Path::new("/work/pkg/R/unix/utils.R"),
                Path::new("/work/pkg")
            ),
            Some(RFileKind::Source),
        );
    }
}

// ============== OUTPUTS (continued) ==============

use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RFileFacts {
    /// Canonical `Source` vs `Test` classification for this file,
    /// carried through from the corresponding `RFileInput`. Consumers
    /// that need to partition facts by location (e.g. `build_scope_contribution`,
    /// `merge_namespace_model`) MUST filter on `kind` rather than re-deriving
    /// the classification from the path, so there is a single source of truth.
    pub kind: RFileKind,
    pub roxygen_namespace: RoxygenNamespace,
    pub top_level_defs: Arc<BTreeSet<String>>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackageScopeContribution {
    /// The workspace root for this package, if known. Carried here so that
    /// scope-injection logic (Phase 5) can check whether the queried file is
    /// under `R/` or `tests/testthat/` without requiring a separate parameter.
    pub workspace_root: Option<PathBuf>,
    pub r_internal_symbols: Arc<BTreeSet<String>>,
    pub imported_symbols: Arc<BTreeMap<String, BTreeSet<String>>>,
    pub full_imports: Arc<BTreeSet<String>>,
}
