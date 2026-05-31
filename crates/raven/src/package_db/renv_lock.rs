//! Minimal `renv.lock` reader. `renv.lock` is JSON; its `Packages` object's keys
//! are the locked package names. Per spec §7.2, the lockfile is a **set
//! selector** (which packages to include), not a version oracle — so only names
//! are read.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RenvLock {
    #[serde(rename = "Packages", default)]
    packages: HashMap<String, serde_json::Value>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reads_locked_package_names() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/package_db/renv.lock");
        let names = read_renv_lock_package_names(&path).unwrap();
        assert_eq!(names, vec!["dplyr".to_string(), "ggplot2".to_string()]);
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let names = read_renv_lock_package_names(std::path::Path::new("/nonexistent/renv.lock"))
            .unwrap();
        assert!(names.is_empty());
    }
}
