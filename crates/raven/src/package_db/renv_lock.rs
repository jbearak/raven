//! Minimal `renv.lock` reader. `renv.lock` is JSON; its `Packages` object's keys
//! are the locked package names. Per spec §7.2, the lockfile is a **set
//! selector** (which packages to include), not a version oracle — so only names
//! are read.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RenvLockEntry {
    #[serde(rename = "Version", default)]
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RenvLock {
    #[serde(rename = "Packages", default)]
    packages: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RenvLockVersioned {
    #[serde(rename = "Packages", default)]
    packages: HashMap<String, RenvLockEntry>,
}

/// Return the sorted, de-duplicated set of package names listed in `renv.lock`.
/// A missing file yields an empty list (not an error): a repo may have no lock.
pub fn read_renv_lock_package_names(path: &Path) -> anyhow::Result<Vec<String>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(path)?;
    let lock: RenvLock = serde_json::from_str(&text)?;
    let mut names: Vec<String> = lock.packages.into_keys().collect();
    names.sort_unstable();
    names.dedup();
    Ok(names)
}

/// Return a map of package name → pinned version from `renv.lock`.
/// A missing file yields an empty map (not an error), mirroring the names reader.
/// Entries missing a `Version` field are omitted.
pub fn read_renv_lock_package_versions(path: &Path) -> anyhow::Result<HashMap<String, String>> {
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(path)?;
    let lock: RenvLockVersioned = serde_json::from_str(&text)?;
    Ok(lock
        .packages
        .into_iter()
        .filter_map(|(name, entry)| entry.version.filter(|v| !v.is_empty()).map(|v| (name, v)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reads_locked_package_names() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/package_db/renv.lock");
        let names = read_renv_lock_package_names(&path).unwrap();
        assert_eq!(names, vec!["dplyr".to_string(), "ggplot2".to_string()]);
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let names =
            read_renv_lock_package_names(std::path::Path::new("/nonexistent/renv.lock")).unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn reads_locked_package_versions() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/package_db/renv.lock");
        let versions = read_renv_lock_package_versions(&path).unwrap();
        assert_eq!(versions.get("dplyr").unwrap(), "1.1.4");
        assert_eq!(versions.get("ggplot2").unwrap(), "3.5.0");
    }

    #[test]
    fn missing_file_versions_is_empty_not_error() {
        let versions =
            read_renv_lock_package_versions(std::path::Path::new("/nonexistent/renv.lock"))
                .unwrap();
        assert!(versions.is_empty());
    }
}
