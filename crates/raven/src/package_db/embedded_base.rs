//! Built-in export/dataset floor for R's 14 base-priority packages, used when
//! installed base packages are absent (CI without R). A `// @generated`
//! per-package table embedded in the binary (see ADR 1 in the consolidation
//! spec) — regenerate with `raven packages build-embedded-base`. The package
//! set MUST equal `r_subprocess::get_base_priority_packages()`. Only the 7
//! default-attached packages (`get_fallback_base_packages()`) seed the flat
//! always-in-scope set; the other 7 (compiler, grid, parallel, splines, stats4,
//! tcltk, tools) live in the per-package cache so `library(grid)` etc. resolve
//! offline without being in scope by default.

use std::collections::HashSet;

/// One base package's compile-time export floor. `datasets` map to
/// `PackageInfo.lazy_data`; export *kind* is deliberately not tracked.
pub struct EmbeddedBasePackage {
    pub name: &'static str,
    pub exports: &'static [&'static str],
    pub datasets: &'static [&'static str],
    pub depends: &'static [&'static str],
}

// Defines `static EMBEDDED_BASE_PACKAGES: &[EmbeddedBasePackage]`.
include!("embedded_base_generated.rs");

/// The per-package embedded records (for `initialize()` cache population).
pub fn packages() -> &'static [EmbeddedBasePackage] {
    EMBEDDED_BASE_PACKAGES
}

/// Flat always-in-scope set (exports ∪ datasets, default-attached 7 only) plus
/// the full base package-name set (all 14 base-priority packages, for callers
/// that skip "is this base?" — e.g. r-universe fetch). Return shape is
/// unchanged from the prior floor so callers are unaffected.
pub fn load() -> (HashSet<String>, HashSet<String>) {
    let attached: HashSet<String> = crate::r_subprocess::get_fallback_base_packages()
        .into_iter()
        .collect();
    let mut exports = HashSet::new();
    let mut pkgs = HashSet::new();
    for p in EMBEDDED_BASE_PACKAGES {
        pkgs.insert(p.name.to_string());
        if attached.contains(p.name) {
            exports.extend(p.exports.iter().map(|s| s.to_string()));
            exports.extend(p.datasets.iter().map(|s| s.to_string()));
        }
    }
    (exports, pkgs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_set_equals_base_priority_packages() {
        let canonical: HashSet<String> = crate::r_subprocess::get_base_priority_packages()
            .into_iter()
            .collect();
        let derived: HashSet<String> = packages().iter().map(|p| p.name.to_string()).collect();
        assert_eq!(derived, canonical);
    }

    #[test]
    fn load_unions_exports_and_datasets_into_flat_set() {
        let (exports, pkgs) = load();
        assert!(exports.contains("print"), "namespace export in flat set");
        assert!(exports.contains("mtcars"), "dataset folded into flat set");
        assert!(pkgs.contains("base") && pkgs.contains("datasets"));
    }

    #[test]
    fn non_attached_packages_are_cached_but_not_in_flat_set() {
        let (exports, pkgs) = load();
        // grid is base-priority (known) but not default-attached.
        assert!(pkgs.contains("grid"), "grid is a base-priority package");
        let grid = packages().iter().find(|p| p.name == "grid").unwrap();
        assert!(grid.exports.contains(&"gpar"), "grid::gpar is captured");
        assert!(
            !exports.contains("gpar"),
            "grid exports must NOT be always-in-scope (require library(grid))"
        );
    }

    #[test]
    fn datasets_are_kept_distinct_from_exports() {
        let datasets = packages().iter().find(|p| p.name == "datasets").unwrap();
        assert!(datasets.datasets.contains(&"mtcars"));
        assert!(!datasets.exports.contains(&"mtcars"));
    }
}
