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

/// Serializes tests that mutate the process-global `RAVEN_NAMES_DB` env var.
/// Without this, parallel test threads race: one test's `set_var` / `remove_var`
/// window can be observed by another's `build_package_library` call (or
/// `locate_shipped_db`), producing spurious failures. Every test in the crate's
/// lib test binary that touches `RAVEN_NAMES_DB` MUST hold this lock. An async
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
}
