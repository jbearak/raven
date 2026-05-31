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

pub mod binary_db;
pub mod json_db;
pub mod model;
pub mod renv_lock;
pub mod runiverse;

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
