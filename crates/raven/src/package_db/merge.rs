//! Append-only, version-monotonic merge for the Tier 3 build (decision #16).

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::package_db::model::PackageRecord;

/// Compare two R package version strings numerically.
///
/// R version syntax is one or more non-negative integers separated by `.` **or**
/// `-` (the two separators are equivalent, as in R's own `numeric_version`, so
/// `1.1-3` == `1.1.3`). Components are compared left-to-right as integers; if one
/// is a prefix of the other the longer (more components) is greater (`1.1.0` >
/// `1.1`). An empty or unparseable version sorts **lowest**, so any known version
/// beats an unknown one. (Unlike SemVer, R has no pre-release ordering.)
pub fn version_cmp(a: &str, b: &str) -> Ordering {
    fn parts(v: &str) -> Vec<i64> {
        v.split(|c| c == '.' || c == '-')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<i64>().unwrap_or(-1)) // non-numeric component sorts low
            .collect()
    }
    parts(a).cmp(&parts(b))
}

/// Merge three sources into one append-only, version-monotonic set.
///
/// For each package name the record with the **highest version across all three
/// sources** is kept; equal versions tiebreak **reference-R → r-universe → prior**.
/// A name present in only one source is retained — nothing is ever dropped, and no
/// package is ever moved to an older version than it already had.
pub fn merge_append_only(
    prior: Vec<PackageRecord>,
    runiverse: Vec<PackageRecord>,
    reference_r: Vec<PackageRecord>,
) -> Vec<PackageRecord> {
    // Priority encodes the equal-version tiebreak: prior(0) < r-universe(1) < reference-R(2).
    // Iterating in that order means a later, higher-priority source overwrites only
    // when its version is >= the incumbent's.
    let mut best: BTreeMap<String, (u8, PackageRecord)> = BTreeMap::new();
    for (prio, recs) in [(0u8, prior), (1u8, runiverse), (2u8, reference_r)] {
        for rec in recs {
            let take = match best.get(&rec.name) {
                None => true,
                Some((cur_prio, cur)) => match version_cmp(&rec.version, &cur.version) {
                    Ordering::Greater => true,
                    Ordering::Equal => prio >= *cur_prio,
                    Ordering::Less => false,
                },
            };
            if take {
                best.insert(rec.name.clone(), (prio, rec));
            }
        }
    }
    best.into_values().map(|(_, rec)| rec).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(name: &str, version: &str, export: &str) -> PackageRecord {
        PackageRecord {
            name: name.into(),
            version: version.into(),
            exports: vec![export.into()],
            depends: vec![],
            lazy_data: vec![],
        }
    }

    #[test]
    fn version_cmp_is_numeric_and_separator_agnostic() {
        assert_eq!(version_cmp("1.1.10", "1.1.9"), Ordering::Greater);
        assert_eq!(version_cmp("1.1-3", "1.1.3"), Ordering::Equal);
        assert_eq!(version_cmp("1.1.0", "1.1"), Ordering::Greater);
        assert_eq!(version_cmp("", "0.0.1"), Ordering::Less);
    }

    #[test]
    fn prior_only_package_is_retained() {
        let merged = merge_append_only(vec![rec("orphan", "1.0", "old")], vec![], vec![]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "orphan");
    }

    #[test]
    fn runiverse_newer_than_reference_r_wins() {
        let merged = merge_append_only(
            vec![],
            vec![rec("dplyr", "1.1.4", "from_runiverse")],
            vec![rec("dplyr", "1.1.0", "from_reference")],
        );
        assert_eq!(merged[0].exports, vec!["from_runiverse".to_string()]);
    }

    #[test]
    fn reference_r_newer_than_runiverse_wins() {
        let merged = merge_append_only(
            vec![],
            vec![rec("dplyr", "1.1.0", "from_runiverse")],
            vec![rec("dplyr", "1.2.0", "from_reference")],
        );
        assert_eq!(merged[0].exports, vec!["from_reference".to_string()]);
    }

    #[test]
    fn prior_higher_than_both_is_not_regressed() {
        let merged = merge_append_only(
            vec![rec("dplyr", "2.0.0", "from_prior")],
            vec![rec("dplyr", "1.1.4", "from_runiverse")],
            vec![rec("dplyr", "1.1.0", "from_reference")],
        );
        assert_eq!(merged[0].exports, vec!["from_prior".to_string()]);
    }

    #[test]
    fn equal_version_tiebreaks_to_reference_r() {
        let merged = merge_append_only(
            vec![rec("dplyr", "1.1.4", "from_prior")],
            vec![rec("dplyr", "1.1.4", "from_runiverse")],
            vec![rec("dplyr", "1.1.4", "from_reference")],
        );
        assert_eq!(merged[0].exports, vec!["from_reference".to_string()]);
    }
}
