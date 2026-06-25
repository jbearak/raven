//! End-to-end: with no installed copy and empty/irrelevant libpaths, a Tier 3
//! `names.db` suppresses the undefined-variable storm for package exports
//! (spec §14, §10). Uses a synthetic package name so the test proves Tier 3
//! resolution regardless of what is installed on the build machine.

use raven::package_db::binary_db::{ShippedDbProvenance, write_shipped_db};
use raven::package_db::model::PackageRecord;
use raven::package_library::build_package_library;

/// Serializes the tests in this (separate) integration-test binary that mutate
/// the process-global `RAVEN_NAMES_DB`, or call `build_package_library` (which
/// reads it). The crate-internal lock lives in the lib test binary and can't be
/// reached here, so this file keeps its own. An async mutex is required because
/// the guard is held across `build_package_library(...).await`.
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Save the current `RAVEN_NAMES_DB` and restore it on drop, so a test that
/// points the var at a temp `names.db` doesn't clobber a pre-existing value for
/// other tests sharing this process. `ENV_LOCK` serializes access; this keeps
/// the var hermetic *across* tests, not just within one.
struct NamesDbEnvGuard(Option<std::ffi::OsString>);

impl NamesDbEnvGuard {
    fn set(path: &std::path::Path) -> Self {
        let prior = std::env::var_os("RAVEN_NAMES_DB");
        // SAFETY: test-only; callers hold `ENV_LOCK` for the whole test, which
        // serializes every test in this binary that reads or writes the var, so
        // no other thread touches the environment concurrently.
        unsafe { std::env::set_var("RAVEN_NAMES_DB", path) };
        Self(prior)
    }
}

impl Drop for NamesDbEnvGuard {
    fn drop(&mut self) {
        // SAFETY: this guard is dropped before the test's `ENV_LOCK` guard, so
        // the restore still runs serialized — see `set` above.
        unsafe {
            match self.0.take() {
                Some(v) => std::env::set_var("RAVEN_NAMES_DB", v),
                None => std::env::remove_var("RAVEN_NAMES_DB"),
            }
        }
    }
}

/// Generic save/restore guard for an arbitrary env var, used to point
/// `XDG_DATA_HOME` at an empty temp dir so the user-data `names.db` sidecar
/// candidate is absent during a test. Same `ENV_LOCK` serialization contract as
/// [`NamesDbEnvGuard`].
struct EnvVarGuard {
    key: &'static str,
    prior: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &std::path::Path) -> Self {
        let prior = std::env::var_os(key);
        // SAFETY: caller holds `ENV_LOCK` for the whole test (see NamesDbEnvGuard).
        unsafe { std::env::set_var(key, value) };
        Self { key, prior }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        // SAFETY: dropped before the test's `ENV_LOCK` guard, still serialized.
        unsafe {
            match self.prior.take() {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

#[tokio::test]
async fn tier3_resolves_export_with_no_r() {
    let _guard = ENV_LOCK.lock().await;
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

    let _db_guard = NamesDbEnvGuard::set(&db_path);
    let outcome = build_package_library(None, &[], None, true).await;

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

/// Valid-but-empty offline DBs (zero packages — e.g. a `raven packages freeze`
/// that matched nothing, or an empty `names.db`) must NOT be wired as providers:
/// `has_providers()` is the "real package coverage exists" gate for the
/// degraded-environment note in `cli::check`, so an empty offline file must read
/// as no coverage, not as coverage. Regression for the false-negative where the
/// note would be wrongly suppressed.
///
/// Both tiers are made empty: the Tier-3 env candidate points at a real but
/// empty `names.db` (which opens-empty, is skipped, and the scan continues), and
/// the user-data candidate is neutralized on every platform (`XDG_DATA_HOME` on
/// unix, `LOCALAPPDATA` on Windows) so an ambient `names.db` can't mask the
/// assertion. The Tier-2 `.raven/packages.json` carries zero packages.
#[tokio::test]
async fn empty_offline_dbs_are_not_wired_as_providers() {
    use raven::package_db::json_db::{
        REPO_DB_SCHEMA_VERSION, RepoDb, RepoDbProvenance, write_repo_db_file,
    };

    let _guard = ENV_LOCK.lock().await;

    // Tier 3: a real but empty names.db as the highest-precedence candidate.
    let names_dir = tempfile::tempdir().unwrap();
    let empty_names_db = names_dir.path().join("names.db");
    write_shipped_db(
        &empty_names_db,
        &[],
        ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-30".into(),
            package_count: 0,
            raven_version: "9.9.9".into(),
        },
    )
    .unwrap();
    let _db_guard = NamesDbEnvGuard::set(&empty_names_db);
    // Neutralize the user-data candidate on every platform: `XDG_DATA_HOME`
    // drives it on unix, `LOCALAPPDATA` (\Raven\names.db) on Windows. Setting
    // both — each ignored on the other platform — keeps the test hermetic
    // regardless of an ambient user-installed `names.db`.
    let user_data_dir = tempfile::tempdir().unwrap();
    let _xdg_guard = EnvVarGuard::set("XDG_DATA_HOME", user_data_dir.path());
    let _localappdata_guard = EnvVarGuard::set("LOCALAPPDATA", user_data_dir.path());

    // Tier 2: a valid but empty .raven/packages.json.
    let workspace = tempfile::tempdir().unwrap();
    write_repo_db_file(
        &workspace.path().join(".raven").join("packages.json"),
        &RepoDb {
            schema_version: REPO_DB_SCHEMA_VERSION,
            provenance: RepoDbProvenance {
                raven_version: "test".into(),
                r_version: "test".into(),
                generated_unix: 0,
            },
            packages: vec![],
        },
    )
    .unwrap();

    // The third Tier-3 candidate is the executable-relative sidecar
    // (`<test-binary-dir>/names.db`); like the other tests in this file we rely
    // on it being absent under `cargo test` (a bundled `names.db` ships only in
    // packaged releases, never next to the deps/ test binary). There is no env
    // knob to relocate it, so it is left implicit.
    let outcome =
        build_package_library(None, &[], Some(workspace.path().to_path_buf()), true).await;
    assert!(
        !outcome.library.has_providers(),
        "empty offline DBs must not be wired as providers (has_providers() must \
         mean real coverage)"
    );
}

/// R-gated: capture a Tier 2 record for an installed package and assert the
/// round-tripped record matches the live Tier 1 result. Skips when R is absent
/// (both the skip and the assertion path are green).
#[tokio::test]
async fn freeze_round_trip_matches_tier1_when_r_present() {
    use raven::package_db::json_db::{
        REPO_DB_SCHEMA_VERSION, RepoDb, RepoDbProvenance, read_repo_db_str, write_repo_db_string,
    };
    use raven::package_db::model::PackageRecord;

    let _guard = ENV_LOCK.lock().await;
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

/// End-to-end Tier 2: a real `<workspace>/.raven/packages.json` is wired as a
/// provider (index 0, ahead of Tier 3) and resolves a package. Also proves
/// Tier 2 outranks Tier 3 from actual files, and a Tier-3-only package still
/// resolves — the one tier whose file→provider seam had no integration test.
#[tokio::test]
async fn tier2_repo_db_from_workspace_outranks_tier3() {
    use raven::package_db::json_db::{
        REPO_DB_SCHEMA_VERSION, RepoDb, RepoDbProvenance, write_repo_db_file,
    };

    let _guard = ENV_LOCK.lock().await;
    let shared = "ravenfaketier2shared"; // present in BOTH tiers
    let t3only = "ravenfaketier3only"; // present only in Tier 3

    let workspace = tempfile::tempdir().unwrap();
    // Tier 2: committed .raven/packages.json with the shared package.
    write_repo_db_file(
        &workspace.path().join(".raven").join("packages.json"),
        &RepoDb {
            schema_version: REPO_DB_SCHEMA_VERSION,
            provenance: RepoDbProvenance {
                raven_version: "test".into(),
                r_version: "test".into(),
                generated_unix: 0,
            },
            packages: vec![PackageRecord {
                name: shared.into(),
                version: "2.0.0".into(),
                exports: vec!["from_tier2".into()],
                depends: vec![],
                lazy_data: vec![],
            }],
        },
    )
    .unwrap();

    // Tier 3: a names.db with the SAME shared package (different export) + a
    // Tier-3-only package.
    let names_db = tempfile::tempdir().unwrap();
    let db_path = names_db.path().join("names.db");
    write_shipped_db(
        &db_path,
        &[
            PackageRecord {
                name: shared.into(),
                version: "1.0.0".into(),
                exports: vec!["from_tier3".into()],
                depends: vec![],
                lazy_data: vec![],
            },
            PackageRecord {
                name: t3only.into(),
                version: "1.0.0".into(),
                exports: vec!["t3sym".into()],
                depends: vec![],
                lazy_data: vec![],
            },
        ],
        ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-30".into(),
            package_count: 2,
            raven_version: "9.9.9".into(),
        },
    )
    .unwrap();

    let _db_guard = NamesDbEnvGuard::set(&db_path);
    let outcome =
        build_package_library(None, &[], Some(workspace.path().to_path_buf()), true).await;
    let lib = &outcome.library;

    // Tier 2 wins for the shared package.
    let shared_info = lib.get_package(shared).await.expect("shared resolves");
    assert!(
        shared_info.exports.contains("from_tier2"),
        "Tier 2 must outrank Tier 3"
    );
    assert!(!shared_info.exports.contains("from_tier3"));

    // Tier-3-only package still resolves through the fallback.
    let t3 = lib.get_package(t3only).await.expect("tier3-only resolves");
    assert!(t3.exports.contains("t3sym"));

    // Neither is "installed" — install status stays Tier-1-only.
    assert!(!lib.package_exists(shared));
    assert!(!lib.package_exists(t3only));
}
