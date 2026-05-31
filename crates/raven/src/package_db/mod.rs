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
pub mod embedded_base;
pub mod json_db;
pub mod merge;
pub mod model;
pub mod renv_lock;
pub mod runiverse;

#[cfg(test)]
use std::cell::RefCell;
use std::path::PathBuf;

use crate::package_library::PackageInfo;

#[cfg(not(windows))]
const USER_DATA_APP_DIR_UNIX: &str = "raven";
#[cfg(windows)]
const USER_DATA_APP_DIR_WINDOWS: &str = "Raven";

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

/// Resolve ordered `names.db` sidecar candidates.
pub fn locate_shipped_db_candidates() -> Vec<PathBuf> {
    locate_sidecar_candidates("RAVEN_NAMES_DB", "names.db")
}

/// Resolve ordered `base-exports.json` sidecar candidates.
pub fn locate_base_exports_candidates() -> Vec<PathBuf> {
    locate_sidecar_candidates("RAVEN_BASE_EXPORTS", "base-exports.json")
}

pub fn user_data_sidecar_path(file_name: &str) -> Option<PathBuf> {
    user_data_dir().map(|dir| dir.join(file_name))
}

/// Resolve sidecar candidates in precedence order: non-empty env override, user
/// data sidecar, then executable-relative bundled sidecar.
fn locate_sidecar_candidates(env_var: &str, file_name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var(env_var) {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Some(p) = user_data_sidecar_path(file_name) {
        push_unique(&mut out, p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push_unique(&mut out, dir.join(file_name));
        }
    }
    out
}

fn push_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !out.iter().any(|existing| existing == &path) {
        out.push(path);
    }
}

/// The Raven per-user data directory: `%LOCALAPPDATA%\Raven` on Windows,
/// `$XDG_DATA_HOME/raven` (or `$HOME/.local/share/raven`) elsewhere.
///
/// Hand-rolled rather than via the `xdg` crate on purpose: `xdg` is a
/// unix-only dependency, so using it would cover only the non-Windows arm and
/// split this one cfg-unified resolver into two mechanisms. The unix rule is
/// factored into [`unix_user_data_dir`] so it can be unit-tested with injected
/// env values without touching the process environment.
fn user_data_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_USER_DATA_DIR.with(|cell| cell.borrow().clone()) {
        return Some(dir);
    }

    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .and_then(absolute_non_empty_path)
            .map(|p| p.join(USER_DATA_APP_DIR_WINDOWS))
    }

    #[cfg(not(windows))]
    {
        unix_user_data_dir(std::env::var_os("XDG_DATA_HOME"), std::env::var_os("HOME"))
    }
}

/// Derive the Unix user-data directory from `XDG_DATA_HOME` / `HOME` values:
/// an absolute, non-empty `XDG_DATA_HOME` wins, otherwise `HOME/.local/share`.
/// Takes the env values as parameters so both `user_data_dir` and its tests
/// exercise one copy of the rule.
#[cfg(not(windows))]
fn unix_user_data_dir(
    xdg_data_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(path) = xdg_data_home.and_then(absolute_non_empty_path) {
        return Some(path.join(USER_DATA_APP_DIR_UNIX));
    }
    home.and_then(absolute_non_empty_path).map(|home| {
        home.join(".local")
            .join("share")
            .join(USER_DATA_APP_DIR_UNIX)
    })
}

fn absolute_non_empty_path(value: std::ffi::OsString) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

#[cfg(test)]
thread_local! {
    static TEST_USER_DATA_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(crate) struct TestUserDataDirGuard {
    previous: Option<PathBuf>,
}

#[cfg(test)]
pub(crate) fn test_user_data_dir_guard(path: PathBuf) -> TestUserDataDirGuard {
    let previous = TEST_USER_DATA_DIR.with(|cell| cell.replace(Some(path)));
    TestUserDataDirGuard { previous }
}

#[cfg(test)]
impl Drop for TestUserDataDirGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        TEST_USER_DATA_DIR.with(|cell| {
            cell.replace(previous);
        });
    }
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
/// `build_package_library` / `initialize` call (or `locate_shipped_db_candidates`
/// / `locate_base_exports_candidates`), producing spurious failures. Every test in the crate's
/// lib test binary that touches those vars MUST hold this lock. An async
/// (`tokio`) mutex is required because some holders keep the guard across an
/// `.await` on the build. Lives here (not in a test submodule) so both
/// `package_db` and `package_library` tests can share the one instance.
#[cfg(test)]
pub(crate) static RAVEN_NAMES_DB_ENV_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sidecar_candidates_prefer_env_then_user_data_then_exe_relative() {
        let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let user_data = dir.path().join("data");
        let custom = dir.path().join("custom.db");

        std::env::set_var("RAVEN_NAMES_DB", &custom);
        let _user_data_guard = test_user_data_dir_guard(user_data.clone());
        let candidates = locate_shipped_db_candidates();
        std::env::remove_var("RAVEN_NAMES_DB");
        let exe_relative = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("names.db");

        assert_eq!(candidates[0], custom);
        assert_eq!(candidates[1], user_data.join("names.db"));
        assert!(candidates[2..].contains(&exe_relative));
    }

    #[tokio::test]
    async fn empty_env_does_not_shadow_user_data_sidecar() {
        let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let user_data = dir.path().join("data");

        std::env::set_var("RAVEN_NAMES_DB", "");
        let _user_data_guard = test_user_data_dir_guard(user_data.clone());
        let first = locate_shipped_db_candidates().remove(0);
        std::env::remove_var("RAVEN_NAMES_DB");

        assert_eq!(first, user_data.join("names.db"));
    }

    #[tokio::test]
    async fn base_exports_candidates_use_same_precedence() {
        let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let user_data = dir.path().join("data");
        let custom = dir.path().join("base.json");

        std::env::set_var("RAVEN_BASE_EXPORTS", &custom);
        let _user_data_guard = test_user_data_dir_guard(user_data.clone());
        let candidates = locate_base_exports_candidates();
        std::env::remove_var("RAVEN_BASE_EXPORTS");
        let exe_relative = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("base-exports.json");

        assert_eq!(candidates[0], custom);
        assert_eq!(candidates[1], user_data.join("base-exports.json"));
        assert!(candidates[2..].contains(&exe_relative));
    }

    #[cfg(not(windows))]
    #[test]
    fn user_data_roots_ignore_empty_and_relative_values() {
        assert_eq!(
            unix_user_data_dir(Some("".into()), Some("/home/me".into())),
            Some(PathBuf::from("/home/me/.local/share/raven"))
        );
        assert_eq!(
            unix_user_data_dir(Some("relative".into()), Some("/home/me".into())),
            Some(PathBuf::from("/home/me/.local/share/raven"))
        );
        assert_eq!(unix_user_data_dir(None, Some("relative-home".into())), None);
        assert_eq!(
            unix_user_data_dir(Some("/xdg".into()), Some("/home/me".into())),
            Some(PathBuf::from("/xdg/raven"))
        );
        assert_eq!(
            unix_user_data_dir(None, Some("/home/me".into())),
            Some(PathBuf::from("/home/me/.local/share/raven"))
        );
    }

    #[test]
    fn write_base_exports_filters_to_base_packages() {
        use crate::package_db::model::PackageRecord;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("base-exports.json");
        let records = vec![
            PackageRecord {
                name: "datasets".into(),
                version: "4.4.0".into(),
                exports: vec![],
                depends: vec![],
                lazy_data: vec!["mtcars".into()],
            },
            PackageRecord {
                name: "dplyr".into(),
                version: "1.1.4".into(),
                exports: vec!["mutate".into()],
                depends: vec![],
                lazy_data: vec![],
            },
        ];
        write_base_exports_file(&path, &records).unwrap();
        let db = crate::package_db::json_db::read_repo_db_file(&path).unwrap();
        let names: Vec<&str> = db.packages.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"datasets"), "base package datasets is kept");
        assert!(!names.contains(&"dplyr"), "non-base dplyr is filtered out");
    }
}
