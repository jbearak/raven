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
}
