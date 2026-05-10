//! R package mode subsystem.
//!
//! See `docs/superpowers/specs/2026-05-10-r-package-mode-architecture-design.md`
//! for the architectural rationale.
//!
//! This module owns all derived state for R package mode. Outside of this
//! module, `PackageState` is read-only — it can only be replaced as a
//! whole, never partially mutated.

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
#[derive(Default, Debug, Clone)]
pub struct PackageState {
    pub workspace: Option<PackageWorkspace>,
    pub namespace_model: Option<PackageNamespaceModel>,
    pub roxygen_tags_cache: HashMap<PathBuf, RoxygenNamespace>,
    pub internal_symbols_cache: Arc<HashSet<String>>,
    pub workspace_imports: Arc<Vec<(String, String)>>,
}

impl PackageState {
    pub fn new() -> Self {
        Self {
            workspace: None,
            namespace_model: None,
            roxygen_tags_cache: HashMap::new(),
            internal_symbols_cache: Arc::new(HashSet::new()),
            workspace_imports: Arc::new(Vec::new()),
        }
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
