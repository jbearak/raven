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
