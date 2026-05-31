//! Build-side ingestion of r-universe per-package JSON into `PackageRecord`s.
//!
//! The shipped binary never fetches from the network. A build job (`curl`)
//! writes one `<pkg>.json` file per package into a directory; this module reads
//! that directory. The JSON shape is pinned by the fixtures under
//! `tests/fixtures/package_db/runiverse/`; if r-universe changes its schema, the
//! ingester test (and the §14 differential test) catch the drift.

use std::path::Path;

use serde::Deserialize;

use crate::package_db::model::{sorted_unique, PackageRecord};

#[derive(Debug, Deserialize)]
struct RUniversePackage {
    #[serde(rename = "Package")]
    package: String,
    #[serde(rename = "Version", default)]
    version: String,
    #[serde(rename = "_exports", default)]
    exports: Vec<String>,
    #[serde(rename = "_dependencies", default)]
    dependencies: Vec<RUniverseDep>,
    #[serde(rename = "_datasets", default)]
    datasets: Vec<RUniverseDataset>,
}

#[derive(Debug, Deserialize)]
struct RUniverseDep {
    package: String,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RUniverseDataset {
    #[serde(default)]
    name: Option<String>,
}

/// Parse a single r-universe package JSON string into a `PackageRecord`.
pub fn parse_runiverse_json(text: &str) -> anyhow::Result<PackageRecord> {
    let pkg: RUniversePackage = serde_json::from_str(text)?;
    let exports = sorted_unique(pkg.exports);
    let depends = sorted_unique(
        pkg.dependencies
            .into_iter()
            .filter(|d| d.role.as_deref() == Some("Depends"))
            .map(|d| d.package),
    );
    let lazy_data = sorted_unique(pkg.datasets.into_iter().filter_map(|d| d.name));
    Ok(PackageRecord { name: pkg.package, version: pkg.version, exports, depends, lazy_data })
}

/// Read every `*.json` in `dir` and parse it into a `PackageRecord`. Files that
/// fail to parse are logged and skipped (a single bad package must not fail the
/// whole build).
pub fn ingest_runiverse_dir(dir: &Path) -> anyhow::Result<Vec<PackageRecord>> {
    let mut records = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        // A single unreadable directory entry must not fail the whole build,
        // same as the read/parse failures below — only an unopenable `dir`
        // (the `?` above) is fatal.
        let path = match entry {
            Ok(e) => e.path(),
            Err(e) => {
                log::warn!("skipping unreadable entry in {:?}: {}", dir, e);
                continue;
            }
        };
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A single unreadable/unparseable package must not fail the whole build.
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("skipping {:?}: {}", path, e);
                continue;
            }
        };
        match parse_runiverse_json(&text) {
            Ok(rec) => records.push(rec),
            Err(e) => log::warn!("skipping {:?}: {}", path, e),
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/package_db/runiverse")
    }

    #[test]
    fn ingests_directory_of_runiverse_json() {
        let records = ingest_runiverse_dir(&fixture_dir()).unwrap();
        let dplyr = records.iter().find(|r| r.name == "dplyr").unwrap();
        assert_eq!(dplyr.exports, vec!["filter".to_string(), "mutate".to_string(), "select".to_string()]);
        // Only Depends-role dependencies are kept (cli is Imports).
        assert_eq!(dplyr.depends, vec!["R".to_string()]);
        // Datasets come from _datasets[].name.
        assert_eq!(dplyr.lazy_data, vec!["starwars".to_string(), "storms".to_string()]);
        // Version is captured from the JSON "Version" field (drives the merge).
        assert_eq!(dplyr.version, "1.1.4");
        assert!(records.iter().any(|r| r.name == "ggplot2"));
    }
}
