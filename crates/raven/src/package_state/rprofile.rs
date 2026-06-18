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
use tower_lsp::lsp_types::Url;

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
const RPROFILE_MAX_SOURCE_DEPTH: usize = 64;
/// Maximum number of distinct files visited while following `source()` chains
/// (cycle + fan-out guard). Far above any real `.Rprofile` helper tree.
const RPROFILE_MAX_SOURCE_FILES: usize = 1000;

/// Synchronously scan `<workspace_root>/.Rprofile` (never executing it) into a
/// script-scope prelude. Returns empty when the file is absent or unreadable.
pub fn scan_workspace_rprofile(workspace_root: &Path) -> RprofileScan {
    let mut scan = RprofileScan::default();
    let rprofile_path = workspace_root.join(".Rprofile");
    let Ok(text) = std::fs::read_to_string(&rprofile_path) else {
        return scan;
    };
    let workspace_url = Url::from_file_path(workspace_root).ok();
    let renv_activate = workspace_root.join("renv").join("activate.R");

    // Worklist of (file_path, file_text, depth). Visited is keyed by the
    // canonicalized path so cycles and re-sources collapse to one visit.
    let mut visited: BTreeSet<std::path::PathBuf> = BTreeSet::new();
    let mut worklist: Vec<(std::path::PathBuf, String, usize)> =
        vec![(rprofile_path.clone(), text, 0)];
    visited.insert(rprofile_path.canonicalize().unwrap_or(rprofile_path));

    while let Some((path, text, depth)) = worklist.pop() {
        harvest_file(&text, &mut scan);
        if depth >= RPROFILE_MAX_SOURCE_DEPTH || visited.len() >= RPROFILE_MAX_SOURCE_FILES {
            continue;
        }
        for target in literal_source_targets(&text) {
            let Some(file_uri) = Url::from_file_path(&path).ok() else {
                continue;
            };
            let ctx = match crate::cross_file::path_resolve::PathContext::from_metadata(
                &file_uri,
                &crate::cross_file::types::CrossFileMetadata::default(),
                workspace_url.as_ref(),
            ) {
                Some(c) => c,
                None => continue,
            };
            let Some(resolved) =
                crate::cross_file::path_resolve::resolve_path_with_workspace_fallback(
                    &target, &ctx,
                )
            else {
                continue;
            };
            // Skip renv's activate.R (defines internal machinery, no user globals).
            let canonical_resolved = resolved.canonicalize().unwrap_or_else(|_| resolved.clone());
            let canonical_renv = renv_activate
                .canonicalize()
                .unwrap_or_else(|_| renv_activate.clone());
            if canonical_resolved == canonical_renv || resolved == renv_activate {
                continue;
            }
            if !visited.insert(canonical_resolved.clone()) {
                continue;
            }
            if visited.len() > RPROFILE_MAX_SOURCE_FILES {
                break;
            }
            if let Ok(sourced_text) = std::fs::read_to_string(&resolved) {
                // Record the canonical path so a later edit to this helper can
                // trigger a prelude rescan (Task 12 transitive freshness).
                scan.sourced_files.insert(canonical_resolved.clone());
                worklist.push((resolved, sourced_text, depth + 1));
            }
        }
    }
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

/// Literal `source()` target paths in `text` that contribute to the GLOBAL /
/// script scope. Excludes:
/// - `# raven:` directives (`is_directive`);
/// - calls that do not inherit symbols — `source(..., local = TRUE)` and
///   `sys.source(...)` without `envir = globalenv()` (`!inherits_symbols()`);
/// - calls lexically inside a function body (`is_function_scoped`) — they only
///   run when that function is invoked, so they are not load-time globals;
/// - non-literal paths (`detect_source_calls` yields an empty `path` for those).
///
/// `detect_source_calls` walks the WHOLE tree (not just top level), so these
/// filters are load-bearing — without them a `.Rprofile` like
/// `f <- function() source("dev.R")` would wrongly pull `dev.R` into the
/// suppressive prelude.
fn literal_source_targets(text: &str) -> Vec<String> {
    use tree_sitter::Parser;
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_r::LANGUAGE.into())
        .is_err()
    {
        return Vec::new();
    }
    let Some(tree) = parser.parse(text, None) else {
        return Vec::new();
    };
    crate::cross_file::source_detect::detect_source_calls(&tree, text)
        .into_iter()
        .filter(|s| {
            !s.is_directive && s.inherits_symbols() && !s.is_function_scoped && !s.path.is_empty()
        })
        .map(|s| s.path)
        .collect()
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

    #[test]
    fn follows_literal_source_with_workspace_fallback() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(
            tmp.path().join("R").join("functions.r"),
            "r_bind <- function() 1\n",
        )
        .unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"R/functions.r\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("r_bind"), "got {:?}", scan.symbols);
    }

    #[test]
    fn follows_source_transitively() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(
            tmp.path().join("R").join("r.bind.r"),
            "r_bind <- function() 1\n",
        )
        .unwrap();
        // functions.r sources r.bind.r; in R this resolves via cwd (root), which
        // Raven models with the workspace-root fallback.
        fs::write(
            tmp.path().join("R").join("functions.r"),
            "source(\"R/r.bind.r\")\n",
        )
        .unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"R/functions.r\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            scan.symbols.contains("r_bind"),
            "transitive source must resolve: {:?}",
            scan.symbols
        );
    }

    #[test]
    fn attached_packages_followed_through_source() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("setup.R"),
            "library(tidyr)\nhelper <- function() 1\n",
        )
        .unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"setup.R\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            scan.attached_packages.contains("tidyr"),
            "got {:?}",
            scan.attached_packages
        );
        assert!(scan.symbols.contains("helper"));
    }

    #[test]
    fn skips_renv_activate() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("renv")).unwrap();
        // activate.R defines machinery we must NOT harvest as user globals.
        fs::write(
            tmp.path().join("renv").join("activate.R"),
            "should_not_leak <- function() 1\n",
        )
        .unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "source(\"renv/activate.R\")\nlocal_def <- 1\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            !scan.symbols.contains("should_not_leak"),
            "renv/activate.R must be skipped: {:?}",
            scan.symbols
        );
        assert!(
            scan.symbols.contains("local_def"),
            "statements after the renv line still harvest"
        );
    }

    #[test]
    fn local_true_source_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("priv.R"), "private_def <- 1\n").unwrap();
        // source(..., local = TRUE) puts defs in a local env, not globals.
        fs::write(
            tmp.path().join(".Rprofile"),
            "source(\"priv.R\", local = TRUE)\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            !scan.symbols.contains("private_def"),
            "local=TRUE source must not contribute globals: {:?}",
            scan.symbols
        );
    }

    #[test]
    fn dynamic_source_path_is_ignored() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "source(paste0(\"R/\", \"x.R\"))\nstill_here <- 1\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        // No crash; non-literal source() ignored; sibling assignment still harvested.
        assert!(scan.symbols.contains("still_here"));
    }

    #[test]
    fn conditional_top_level_assignment_is_harvested() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "if (interactive()) helper <- function() {}\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            scan.symbols.contains("helper"),
            "conditional top-level assignment must be harvested: {:?}",
            scan.symbols
        );
    }

    #[test]
    fn function_body_source_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("dev.R"), "dev_only <- 1\n").unwrap();
        // source() inside a function body only runs when the fn is called.
        fs::write(
            tmp.path().join(".Rprofile"),
            "f <- function() source(\"dev.R\")\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            !scan.symbols.contains("dev_only"),
            "function-body source() must not be followed: {:?}",
            scan.symbols
        );
        assert!(scan.symbols.contains("f"));
    }

    #[test]
    fn sys_source_without_global_env_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("priv.R"), "priv_only <- 1\n").unwrap();
        // sys.source() defaults to a non-global env → symbols are not inherited.
        fs::write(tmp.path().join(".Rprofile"), "sys.source(\"priv.R\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(
            !scan.symbols.contains("priv_only"),
            "sys.source() (non-global env) must not contribute globals: {:?}",
            scan.symbols
        );
    }
}
