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

/// Deserialize a JSON array that may also be `null` into a `Vec`.
///
/// r-universe's per-package endpoint emits an explicit `null` — not an omitted
/// key or `[]` — for fields a package doesn't populate (e.g. `_datasets` on a
/// package shipping no data). Plain `#[serde(default)]` only fills a *missing*
/// key, so a present-but-`null` value would fail with "invalid type: null,
/// expected a sequence" and silently drop the whole package.
///
/// This handles the present-`null` case; the *absent*-key case is still covered
/// by the companion `#[serde(default)]` on each field. Both annotations are
/// load-bearing — `deserialize_with` runs only for a present key, so dropping
/// `default` makes an omitted key a hard "missing field" error
/// (see `tolerates_absent_array_fields`).
fn null_as_empty_vec<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Deserialize)]
struct RUniversePackage {
    #[serde(rename = "Package")]
    package: String,
    #[serde(rename = "Version", default)]
    version: String,
    #[serde(rename = "_exports", default, deserialize_with = "null_as_empty_vec")]
    exports: Vec<String>,
    #[serde(
        rename = "_dependencies",
        default,
        deserialize_with = "null_as_empty_vec"
    )]
    dependencies: Vec<RUniverseDep>,
    #[serde(rename = "_datasets", default, deserialize_with = "null_as_empty_vec")]
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
    Ok(PackageRecord {
        name: pkg.package,
        version: pkg.version,
        exports,
        depends,
        lazy_data,
    })
}

/// Read every `*.json` in `dir` and parse it into a `PackageRecord`. Files that
/// fail to parse are logged and skipped (a single bad package must not fail the
/// whole build).
pub fn ingest_runiverse_dir(dir: &Path) -> anyhow::Result<Vec<PackageRecord>> {
    let mut records = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
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
        assert_eq!(
            dplyr.exports,
            vec![
                "filter".to_string(),
                "mutate".to_string(),
                "select".to_string()
            ]
        );
        // Only Depends-role dependencies are kept (cli is Imports).
        assert_eq!(dplyr.depends, vec!["R".to_string()]);
        // Datasets come from _datasets[].name.
        assert_eq!(
            dplyr.lazy_data,
            vec!["starwars".to_string(), "storms".to_string()]
        );
        // Version is captured from the JSON "Version" field (drives the merge).
        assert_eq!(dplyr.version, "1.1.4");
        assert!(records.iter().any(|r| r.name == "ggplot2"));
    }

    #[test]
    fn tolerates_explicit_null_array_fields() {
        // r-universe's per-package endpoint returns `null` (not an omitted key
        // or `[]`) for a package with no datasets/exports/dependencies. serde's
        // `#[serde(default)]` only fills a *missing* key, not an explicit null,
        // so a naive `Vec` field would fail to parse and silently drop the
        // package. The shipped-DB build feeds this endpoint's raw JSON straight
        // in, so null tolerance is load-bearing for coverage.
        let rec = parse_runiverse_json(
            r#"{"Package":"ympes","Version":"1.0","_exports":["foo"],"_dependencies":null,"_datasets":null}"#,
        )
        .unwrap();
        assert_eq!(rec.name, "ympes");
        assert_eq!(rec.exports, vec!["foo".to_string()]);
        assert!(rec.depends.is_empty());
        assert!(rec.lazy_data.is_empty());
    }

    #[test]
    fn tolerates_absent_array_fields() {
        // A package JSON that omits `_dependencies`/`_datasets` entirely (not
        // null, just absent) must still parse. This path is covered by the
        // `#[serde(default)]` on each field, NOT by `null_as_empty_vec`:
        // `deserialize_with` runs only for a present key, so without `default`
        // an absent key is a hard "missing field" error. This test guards that
        // both annotations stay — dropping `default` regresses absent keys.
        let rec = parse_runiverse_json(r#"{"Package":"bare","Version":"2.0","_exports":["only"]}"#)
            .unwrap();
        assert_eq!(rec.name, "bare");
        assert_eq!(rec.exports, vec!["only".to_string()]);
        assert!(rec.depends.is_empty());
        assert!(rec.lazy_data.is_empty());
    }
}
