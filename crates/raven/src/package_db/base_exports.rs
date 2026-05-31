//! The bundled base-exports file: base/recommended package exports (incl. base
//! datasets), built from the reference R, loaded when disk base packages are
//! absent (CI). Reuses the Tier 2 `RepoDb` encoding.

use std::collections::HashSet;
use std::path::Path;

use crate::package_db::json_db::{read_repo_db_file, RepoDbError};

/// Merge base-package exports + dataset names from the file at `path` into a
/// flat set, plus the set of base package names. Returns None if absent/unreadable.
/// A present-but-unusable file (e.g. a newer schema, or corrupt) is a packaging
/// bug, so it is logged before degrading — only a plain Absent file is silent.
pub fn load_base_exports(path: &Path) -> Option<(HashSet<String>, HashSet<String>)> {
    let db = match read_repo_db_file(path) {
        Ok(db) => db,
        Err(RepoDbError::Absent) => return None,
        Err(e) => {
            log::warn!("base-exports file unreadable, CI base-export fallback unavailable: {e}");
            return None;
        }
    };
    let mut exports = HashSet::new();
    let mut packages = HashSet::new();
    for rec in db.packages {
        packages.insert(rec.name.clone());
        // Base treats datasets as base exports (mirrors initialize()'s disk merge).
        exports.extend(rec.exports);
        exports.extend(rec.lazy_data);
    }
    Some((exports, packages))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_db::json_db::{
        write_repo_db_file, RepoDb, RepoDbProvenance, REPO_DB_SCHEMA_VERSION,
    };
    use crate::package_db::model::PackageRecord;

    #[test]
    fn loads_exports_and_datasets_as_flat_set_with_package_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("base-exports.json");
        write_repo_db_file(
            &path,
            &RepoDb {
                schema_version: REPO_DB_SCHEMA_VERSION,
                provenance: RepoDbProvenance {
                    raven_version: "t".into(),
                    r_version: "4.4.0".into(),
                    generated_unix: 0,
                },
                packages: vec![
                    PackageRecord {
                        name: "base".into(),
                        version: "4.4.0".into(),
                        exports: vec!["print".into()],
                        depends: vec![],
                        lazy_data: vec![],
                    },
                    PackageRecord {
                        name: "datasets".into(),
                        version: "4.4.0".into(),
                        exports: vec![],
                        depends: vec![],
                        lazy_data: vec!["mtcars".into()],
                    },
                ],
            },
        )
        .unwrap();

        let (exports, packages) = load_base_exports(&path).expect("file loads");
        assert!(exports.contains("print"), "explicit export merged");
        assert!(
            exports.contains("mtcars"),
            "lazy_data dataset merged as export"
        );
        assert!(packages.contains("base"));
        assert!(packages.contains("datasets"));
    }

    #[test]
    fn returns_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert!(load_base_exports(&missing).is_none());
    }
}
