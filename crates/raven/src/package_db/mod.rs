//! Pre-built package-export databases for tiered, R-free export resolution.
//!
//! This module owns everything that lets Raven resolve package **export names**
//! without an installed package or a running R: one serializable record
//! ([`model::PackageRecord`]) and two on-disk encodings that decode back into the
//! existing [`crate::package_library::PackageInfo`]:
//!
//! - **Tier 2** ([`json_db`]): a committed, diff-friendly `.raven/packages.json`
//!   the user generates locally (`raven packages freeze`). "Frozen Tier 1".
//! - **Tier 3** ([`binary_db`]): a Raven-bundled, memory-mapped `names.db` built
//!   from r-universe latest. Export-only; the R-free floor.
//!
//! Consumers query these through the [`PackageMetadataProvider`] seam, which
//! `PackageLibrary` consults in tier order **after** the installed (Tier 1) path
//! misses. Providers feed *export resolution* only; they never affect
//! install-status (the missing-package diagnostic), which stays Tier-1-only.

pub mod base_exports;
pub mod binary_db;
pub mod json_db;
pub mod merge;
pub mod model;
pub mod renv_lock;
pub mod runiverse;

use std::path::PathBuf;

use crate::package_library::PackageInfo;

/// A source of pre-built package metadata, consulted in tier order when the
/// installed (Tier 1) path does not resolve a package.
///
/// Implementations are pure, synchronous reads of pre-built data (an in-memory
/// map for Tier 2, a memory-mapped + lazily-decoded payload for Tier 3). They
/// MUST NOT block or perform I/O beyond a memory-mapped read, because the async
/// resolution path that calls them must stay cheap.
pub trait PackageMetadataProvider: Send + Sync {
    /// Return this source's `PackageInfo` for `name`, or `None` if it does not
    /// know the package.
    fn lookup(&self, name: &str) -> Option<PackageInfo>;
}

/// Resolve the bundled `names.db` path.
///
/// Order: the `RAVEN_NAMES_DB` environment variable (used by tests and custom
/// layouts), else a file named `names.db` next to the current executable (where
/// both the standalone CLI and the VS Code extension bundle it). Returns `None`
/// if neither yields a path (existence is checked by the caller via the
/// provider's `from_file`, which logs and returns `None` if the file is absent).
pub fn locate_shipped_db() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RAVEN_NAMES_DB") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("names.db"))
}

/// Resolve the bundled `base-exports.json` path: the `RAVEN_BASE_EXPORTS` env
/// var if set, else `base-exports.json` next to the current executable.
pub fn locate_base_exports() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RAVEN_BASE_EXPORTS") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("base-exports.json"))
}

/// Write the base/recommended subset of `records` to a base-exports file at
/// `path`, reusing the Tier 2 JSON encoding. The Tier 3 build calls this with
/// its merged record set so CI can resolve base symbols/datasets without R
/// (loaded by `initialize()` when disk base packages are absent — decision #7).
/// The base set is the canonical one used everywhere else
/// (`r_subprocess::get_fallback_base_packages`).
pub fn write_base_exports_file(
    path: &std::path::Path,
    records: &[crate::package_db::model::PackageRecord],
) -> std::io::Result<()> {
    use std::collections::HashSet;
    let base: HashSet<String> = crate::r_subprocess::get_fallback_base_packages()
        .into_iter()
        .collect();
    let packages: Vec<crate::package_db::model::PackageRecord> = records
        .iter()
        .filter(|r| base.contains(&r.name))
        .cloned()
        .collect();
    let db = crate::package_db::json_db::RepoDb {
        schema_version: crate::package_db::json_db::REPO_DB_SCHEMA_VERSION,
        provenance: crate::package_db::json_db::RepoDbProvenance {
            raven_version: env!("CARGO_PKG_VERSION").to_string(),
            r_version: String::new(),
            generated_unix: 0,
        },
        packages,
    };
    crate::package_db::json_db::write_repo_db_file(path, &db)
}

/// Serializes tests that mutate the process-global package-DB env vars
/// (`RAVEN_NAMES_DB`, `RAVEN_BASE_EXPORTS`). Without this, parallel test threads
/// race: one test's `set_var` / `remove_var` window can be observed by another's
/// `build_package_library` / `initialize` call (or `locate_shipped_db` /
/// `locate_base_exports`), producing spurious failures. Every test in the crate's
/// lib test binary that touches those vars MUST hold this lock. An async
/// (`tokio`) mutex is required because some holders keep the guard across an
/// `.await` on the build. Lives here (not in a test submodule) so both
/// `package_db` and `package_library` tests can share the one instance.
#[cfg(test)]
pub(crate) static RAVEN_NAMES_DB_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn env_override_wins_over_exe_relative() {
        // RAVEN_NAMES_DB, when set, is returned verbatim.
        let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
        std::env::set_var("RAVEN_NAMES_DB", "/tmp/custom-names.db");
        let p = locate_shipped_db().expect("override path");
        assert_eq!(p, std::path::PathBuf::from("/tmp/custom-names.db"));
        std::env::remove_var("RAVEN_NAMES_DB");
    }

    #[test]
    fn write_base_exports_filters_to_base_packages() {
        use crate::package_db::model::PackageRecord;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("base-exports.json");
        let records = vec![
            PackageRecord { name: "datasets".into(), version: "4.4.0".into(), exports: vec![], depends: vec![], lazy_data: vec!["mtcars".into()] },
            PackageRecord { name: "dplyr".into(), version: "1.1.4".into(), exports: vec!["mutate".into()], depends: vec![], lazy_data: vec![] },
        ];
        write_base_exports_file(&path, &records).unwrap();
        let db = crate::package_db::json_db::read_repo_db_file(&path).unwrap();
        let names: Vec<&str> = db.packages.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"datasets"), "base package datasets is kept");
        assert!(!names.contains(&"dplyr"), "non-base dplyr is filtered out");
    }
}
