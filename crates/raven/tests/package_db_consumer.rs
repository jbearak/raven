//! End-to-end: with no installed copy and empty/irrelevant libpaths, a Tier 3
//! `names.db` suppresses the undefined-variable storm for package exports
//! (spec §14, §10). Uses a synthetic package name so the test proves Tier 3
//! resolution regardless of what is installed on the build machine.

use raven::package_db::binary_db::{write_shipped_db, ShippedDbProvenance};
use raven::package_db::model::PackageRecord;
use raven::package_library::build_package_library;

#[tokio::test]
async fn tier3_resolves_export_with_no_r() {
    let pkg = "ravenfaketier3consumer";
    let sym = "ravenfakeexportsym";

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("names.db");
    write_shipped_db(
        &db_path,
        &[PackageRecord {
            name: pkg.into(),
            version: "1.1.4".into(),
            exports: vec![sym.into()],
            depends: vec![],
            lazy_data: vec![],
        }],
        ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-30".into(),
            package_count: 1,
            raven_version: "9.9.9".into(),
        },
    )
    .unwrap();

    std::env::set_var("RAVEN_NAMES_DB", &db_path);
    let outcome = build_package_library(None, &[], None, true).await;
    std::env::remove_var("RAVEN_NAMES_DB");

    let lib = &outcome.library;
    // Warm the loaded package (mirrors the check-path prefetch).
    lib.prefetch_packages(&[pkg.to_string()]).await;

    // The synchronous diagnostic hot path now sees the export as the package's symbol.
    assert!(lib.is_symbol_from_loaded_packages(sym, &[pkg.to_string()]));
    assert_eq!(
        lib.find_package_for_symbol(sym, &[pkg.to_string()]),
        Some(pkg.to_string())
    );
    // And the package is NOT considered installed (install status stays Tier-1-only).
    assert!(!lib.package_exists(pkg));
}

/// R-gated: capture a Tier 2 record for an installed package and assert the
/// round-tripped record matches the live Tier 1 result. Skips when R is absent
/// (both the skip and the assertion path are green).
#[tokio::test]
async fn freeze_round_trip_matches_tier1_when_r_present() {
    use raven::package_db::json_db::{
        read_repo_db_str, write_repo_db_string, RepoDb, RepoDbProvenance, REPO_DB_SCHEMA_VERSION,
    };
    use raven::package_db::model::PackageRecord;

    let outcome = build_package_library(None, &[], None, true).await;
    let lib = &outcome.library;
    if lib.r_subprocess().is_none() {
        eprintln!("skipping freeze_round_trip: R not available");
        return;
    }
    // 'stats' is a base package present wherever R is.
    let Some(live) = lib.get_package("stats").await else {
        eprintln!("skipping freeze_round_trip: stats not resolvable");
        return;
    };
    let rec = PackageRecord::from_info(&live);
    let db = RepoDb {
        schema_version: REPO_DB_SCHEMA_VERSION,
        provenance: RepoDbProvenance {
            raven_version: "test".into(),
            r_version: "present".into(),
            generated_unix: 0,
        },
        packages: vec![rec.clone()],
    };
    let text = write_repo_db_string(&db);
    let parsed = read_repo_db_str(&text).unwrap();
    let back = parsed.packages.into_iter().next().unwrap().into_info();

    // Parity: same export set + name after the round-trip.
    assert_eq!(back.exports, live.exports);
    assert_eq!(back.name, live.name);
}
