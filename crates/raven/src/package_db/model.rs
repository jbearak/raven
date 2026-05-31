//! The on-disk projection of [`PackageInfo`] shared by both encodings.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::package_library::PackageInfo;

/// On-disk record for one package, shared by the Tier 2 (JSON) and Tier 3
/// (binary) encodings.
///
/// Vectors are kept **sorted and de-duplicated** so the Tier 2 JSON is
/// deterministic and diff-friendly (a `git diff` then shows "package gained
/// export X"). `is_meta_package` / `attached_packages` are a pure function of
/// the package name (see `meta_package_fields`), so they are re-derived on read
/// via `PackageInfo::with_details` rather than stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageRecord {
    pub name: String,
    /// Package version (`DESCRIPTION` `Version`); `""` when unknown. Drives the
    /// Tier 3 monotonic merge (Task 4.2) and rides in both encodings, so a Tier 2
    /// `git diff` shows version bumps too. Filled by the capture paths
    /// (reference-R seed, `freeze`, r-universe ingest), not by `from_info`.
    pub version: String,
    /// Sorted, de-duplicated export names.
    pub exports: Vec<String>,
    /// Sorted, de-duplicated `Depends` package names.
    pub depends: Vec<String>,
    /// Sorted, de-duplicated dataset (lazy-data) names.
    pub lazy_data: Vec<String>,
}

fn sorted_unique<I: IntoIterator<Item = String>>(items: I) -> Vec<String> {
    let mut v: Vec<String> = items.into_iter().collect();
    v.sort_unstable();
    v.dedup();
    v
}

impl PackageRecord {
    /// Build a record from a fully-resolved `PackageInfo` (e.g. the Tier 1
    /// authoritative result), normalizing all vectors to sorted/unique.
    pub fn from_info(info: &PackageInfo) -> Self {
        Self {
            name: info.name.clone(),
            // PackageInfo carries no version; capture paths fill this in.
            version: String::new(),
            exports: sorted_unique(info.exports.iter().cloned()),
            depends: sorted_unique(info.depends.iter().cloned()),
            lazy_data: sorted_unique(info.lazy_data.iter().cloned()),
        }
    }

    /// Decode this record back into a `PackageInfo`. `with_details` re-derives
    /// `is_meta_package` / `attached_packages` from the name.
    pub fn into_info(self) -> PackageInfo {
        PackageInfo::with_details(
            self.name,
            self.exports.into_iter().collect::<HashSet<String>>(),
            self.depends,
            self.lazy_data,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_library::PackageInfo;
    use std::collections::HashSet;

    #[test]
    fn record_round_trips_through_package_info_and_sorts() {
        let info = PackageInfo::with_details(
            "dplyr".to_string(),
            HashSet::from(["mutate".to_string(), "filter".to_string(), "filter".to_string()]),
            vec!["R".to_string()],
            vec!["starwars".to_string()],
        );

        let rec = PackageRecord::from_info(&info);
        // Exports are sorted and de-duplicated for deterministic encoding.
        assert_eq!(rec.exports, vec!["filter".to_string(), "mutate".to_string()]);
        assert_eq!(rec.name, "dplyr");
        // from_info has no version to read; capture paths fill it in later.
        assert_eq!(rec.version, "");

        let back = rec.clone().into_info();
        assert_eq!(back.name, "dplyr");
        assert_eq!(back.exports, HashSet::from(["mutate".to_string(), "filter".to_string()]));
        assert_eq!(back.depends, vec!["R".to_string()]);
        assert_eq!(back.lazy_data, vec!["starwars".to_string()]);
    }

    #[test]
    fn meta_package_fields_are_rederived_not_stored() {
        // tidyverse is a known meta-package; attached_packages must come back
        // even though PackageRecord never stores them.
        let info = PackageInfo::new("tidyverse".to_string(), HashSet::new());
        let back = PackageRecord::from_info(&info).into_info();
        assert!(back.is_meta_package);
        assert!(!back.attached_packages.is_empty());
    }
}
