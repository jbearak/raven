//! Static (never-executed) scan of a workspace-root `.Rprofile` into a
//! script-scope prelude: the top-level symbol names it binds and the packages
//! it attaches, plus the same harvested transitively from any literal
//! `source()` targets. See `docs/r-package-dev.md` ("`.Rprofile` prelude") and
//! the design spec. Mirrors `scan_own_package_data_dir`: synchronous, disk-only,
//! best-effort, and safe to call when the file is absent.
//!
//! INVARIANT (suppressive-only): this scan only ever *adds* names/packages to a
//! file's scope. Over-harvesting can mask a false positive but can never
//! fabricate a diagnostic, so it deliberately uses Raven's normal top-level
//! scope construction (which includes conditional top-level assignments) and
//! never executes anything.

use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RprofileScan {
    pub symbols: BTreeSet<String>,
    pub attached_packages: BTreeSet<String>,
    /// Canonicalized paths of files followed out of `.Rprofile` via literal
    /// `source()` (the `.Rprofile` file itself is NOT included). Used by the
    /// optional transitive-freshness wiring (Task 12) to rescan when one of
    /// these helper files is edited. Empty in the single-file harvest.
    pub sourced_files: std::collections::BTreeSet<std::path::PathBuf>,
}

/// Maximum depth of `source()` chains followed out of `.Rprofile`. Mirrors the
/// cross-file `max_chain_depth` default (64) so a profile that sources a large
/// helper tree cannot blow up the scan.
#[allow(dead_code)] // used by Task 5 source()-following extension
const RPROFILE_MAX_SOURCE_DEPTH: usize = 64;
/// Maximum number of distinct files visited while following `source()` chains
/// (cycle + fan-out guard). Far above any real `.Rprofile` helper tree.
#[allow(dead_code)] // used by Task 5 source()-following extension
const RPROFILE_MAX_SOURCE_FILES: usize = 1000;

/// Synchronously scan `<workspace_root>/.Rprofile` (never executing it) into a
/// script-scope prelude. Returns empty when the file is absent or unreadable.
pub fn scan_workspace_rprofile(workspace_root: &Path) -> RprofileScan {
    let mut scan = RprofileScan::default();
    let rprofile_path = workspace_root.join(".Rprofile");
    let Ok(text) = std::fs::read_to_string(&rprofile_path) else {
        return scan;
    };
    harvest_file(&text, &mut scan);
    scan
}

/// Harvest top-level defs + attached packages from one file's text into `scan`.
fn harvest_file(text: &str, scan: &mut RprofileScan) {
    for def in crate::roxygen::extract_top_level_defs(text) {
        scan.symbols.insert(def);
    }
    for pkg in crate::cross_file::source_detect::extract_attached_packages(text) {
        scan.attached_packages.insert(pkg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn missing_rprofile_yields_empty() {
        let tmp = TempDir::new().unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert_eq!(scan, RprofileScan::default());
    }

    #[test]
    fn harvests_top_level_assignments() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "my_helper <- function() 1\nCONST = 42\nglob <<- 7\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("my_helper"), "got {:?}", scan.symbols);
        assert!(scan.symbols.contains("CONST"), "got {:?}", scan.symbols);
        assert!(scan.symbols.contains("glob"), "got {:?}", scan.symbols);
    }

    #[test]
    fn harvests_attached_packages() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "library(stringr)\nrequire(dplyr)\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            scan.attached_packages.contains("stringr"),
            "got {:?}",
            scan.attached_packages
        );
        assert!(
            scan.attached_packages.contains("dplyr"),
            "got {:?}",
            scan.attached_packages
        );
    }

    #[test]
    fn function_body_assignments_are_not_harvested() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "outer <- function() { local_only <- 1 }\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("outer"));
        assert!(
            !scan.symbols.contains("local_only"),
            "function-local must not leak: {:?}",
            scan.symbols
        );
    }
}
