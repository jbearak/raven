//! R package mode subsystem.
//!
//! See `docs/superpowers/specs/2026-05-10-r-package-mode-architecture-design.md`
//! for the architectural rationale.
//!
//! This module owns all derived state for R package mode. Outside of this
//! module, `PackageState` is read-only — it can only be replaced as a
//! whole, never partially mutated.

pub mod digest;
pub use digest::ContentDigest;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use crate::package_namespace::{PackageNamespaceModel, PackageWorkspace};
use crate::roxygen::RoxygenNamespace;

/// Derived state for R package mode. Owned by `WorldState`.
///
/// Phase 1: holds the five fields previously on `WorldState` directly.
/// Phase 2: gains `derive_package_state` derivation.
/// Phase 5: drops legacy `workspace_imports` field.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct PackageState {
    // Phase 1 fields (legacy; consumed by handlers via passthrough accessors)
    pub workspace: Option<PackageWorkspace>,
    pub namespace_model: Option<PackageNamespaceModel>,
    pub roxygen_tags_cache: HashMap<PathBuf, RoxygenNamespace>,
    pub internal_symbols_cache: Arc<HashSet<String>>,
    pub workspace_imports: Arc<Vec<(String, String)>>,

    // Phase 2 additions (populated by derive_package_state in later tasks)
    pub r_file_facts: BTreeMap<PathBuf, RFileFacts>,
    pub scope_contribution: PackageScopeContribution,
}

impl PackageState {
    pub fn new() -> Self {
        Self {
            workspace: None,
            namespace_model: None,
            roxygen_tags_cache: HashMap::new(),
            internal_symbols_cache: Arc::new(HashSet::new()),
            workspace_imports: Arc::new(Vec::new()),
            r_file_facts: BTreeMap::new(),
            scope_contribution: PackageScopeContribution::default(),
        }
    }

    /// Rebuild the package namespace model from the in-memory roxygen tags cache.
    /// No filesystem I/O — uses only the cached per-file tags.
    /// Returns whether the namespace model changed (imports or full_imports).
    pub fn rebuild_namespace_model_from_cache(&mut self) -> bool {
        let old_imports = self.workspace_imports.clone();
        let old_full_imports = self
            .namespace_model
            .as_ref()
            .map(|m| m.full_imports.clone());

        // Build the model directly from cache references — no Vec allocation
        // or RoxygenNamespace cloning needed.
        let mut model = crate::package_namespace::PackageNamespaceModel::default();
        let mut seen_imports: HashSet<(String, String)> = HashSet::new();
        let mut seen_full: HashSet<String> = HashSet::new();
        for ns in self.roxygen_tags_cache.values() {
            for sym in &ns.exports {
                model.exports.insert(sym.clone());
            }
            for (pkg, sym) in &ns.import_from {
                if seen_imports.insert((pkg.clone(), sym.clone())) {
                    model.imports.push((pkg.clone(), sym.clone()));
                }
            }
            for pkg in &ns.imports {
                if seen_full.insert(pkg.clone()) {
                    model.full_imports.push(pkg.clone());
                }
            }
        }

        let new_imports = Arc::new(model.imports.clone());
        // Compare as sets to avoid false-positive change detection from
        // non-deterministic HashMap iteration order.
        let imports_changed = {
            let old_set: std::collections::HashSet<&(String, String)> =
                old_imports.iter().collect();
            let new_set: std::collections::HashSet<&(String, String)> =
                new_imports.iter().collect();
            old_set != new_set
        };
        let full_imports_changed = {
            let old_set: Option<std::collections::HashSet<&String>> =
                old_full_imports.as_ref().map(|v| v.iter().collect());
            let new_set: std::collections::HashSet<&String> = model.full_imports.iter().collect();
            old_set.as_ref() != Some(&new_set)
        };
        self.workspace_imports = new_imports;
        self.namespace_model = Some(model);
        imports_changed || full_imports_changed
    }

    /// Rebuild the cached package-internal symbols set from the workspace index
    /// AND open documents. Open files' exports are authoritative — the workspace
    /// index may hold stale entries for files that are currently open (e.g., a
    /// symbol was removed but the index hasn't been refreshed yet). We exclude
    /// open URIs from the workspace index scan and merge their live exports
    /// separately.
    pub fn rebuild_internal_symbols_cache(
        &mut self,
        workspace_index: &crate::cross_file::workspace_index::CrossFileWorkspaceIndex,
        document_store: &crate::document_store::DocumentStore,
    ) {
        let Some(pkg) = self.workspace.as_ref() else {
            if !self.internal_symbols_cache.is_empty() {
                self.internal_symbols_cache = Arc::new(HashSet::new());
            }
            return;
        };
        let r_dir = pkg.root.join("R");
        let open_uris: HashSet<tower_lsp::lsp_types::Url> =
            document_store.uris().into_iter().collect();
        // Collect from workspace index, skipping open files (their entries may be stale).
        let mut symbols =
            workspace_index.collect_exported_symbols(&r_dir, &open_uris);
        // Merge open documents' exports (authoritative).
        for uri in &open_uris {
            if let Ok(p) = uri.to_file_path() {
                if p.starts_with(&r_dir) {
                    if let Some(doc) = document_store.get_without_touch(uri) {
                        for name in doc.artifacts.exported_interface.keys() {
                            symbols.insert(name.to_string());
                        }
                    }
                }
            }
        }
        self.internal_symbols_cache = Arc::new(symbols);
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
    pub path: PathBuf,
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct NamespaceInput {
    pub path: PathBuf,
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct RFileInput {
    pub kind: RFileKind,
    pub origin: ContentOrigin,
    pub text: Arc<str>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum RFileKind {
    Source,
    Test,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContentOrigin {
    Open { version: i32 },
    Disk,
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

    let is_r_extension = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("R" | "r"),
    );
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

/// Returns true if `path` is anywhere inside the package workspace.
pub fn is_inside_package(path: &Path, workspace_root: &Path) -> bool {
    path.starts_with(workspace_root)
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
            is_r_source_path(Path::new("/work/pkg/tests/testthat/test-utils.R"), Path::new("/work/pkg")),
            Some(RFileKind::Test),
        );
    }

    #[test]
    fn r_source_path_rejects_non_R_files() {
        let root = Path::new("/work/pkg");
        assert_eq!(is_r_source_path(Path::new("/work/pkg/R/utils.txt"), root), None);
        assert_eq!(is_r_source_path(Path::new("/work/pkg/inst/data.R"), root), None);
        assert_eq!(is_r_source_path(Path::new("/elsewhere/utils.R"), root), None);
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
            is_r_source_path(Path::new("/work/pkg/R/unix/utils.R"), Path::new("/work/pkg")),
            Some(RFileKind::Source),
        );
    }
}

// ============== OUTPUTS (continued) ==============

use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RFileFacts {
    pub roxygen_namespace: RoxygenNamespace,
    pub top_level_defs: Arc<BTreeSet<String>>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackageScopeContribution {
    pub r_internal_symbols: Arc<BTreeSet<String>>,
    pub imported_symbols: Arc<BTreeMap<String, BTreeSet<String>>>,
    pub full_imports: Arc<BTreeSet<String>>,
}
