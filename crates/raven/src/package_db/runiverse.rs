//! Build-side ingestion of r-universe metadata into `PackageRecord`s.
//!
//! The shipped binary never fetches from the network. A build job (`curl`,
//! `scripts/build-names-db.sh`) downloads the metadata; this module reads it in
//! two interchangeable layouts, dispatched by `ingest_runiverse_path`:
//!
//! - **Bulk BSON dump** (`parse_runiverse_dbdump`) — one `/api/dbdump` file per
//!   universe, the full-coverage single-artifact path the build script uses (see
//!   issue #371). This is the primary path.
//! - **Per-package JSON directory** (`ingest_runiverse_dir`) — one `<pkg>.json`
//!   per package, the legacy layout the test fixtures still use.
//!
//! Both layouts carry the *same object shape* (same field names, same per-element
//! structure), so they share one deserializer and one projection. The shape is
//! pinned by the fixtures under `tests/fixtures/package_db/runiverse/`; if
//! r-universe changes its schema, the ingester test (and the §14 differential
//! test) catch the drift.

use std::path::Path;

use serde::Deserialize;

use crate::package_db::model::{PackageRecord, sorted_unique};

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

/// Project a deserialized r-universe package into the build's `PackageRecord`.
///
/// Shared by both ingest paths — the per-package JSON endpoint
/// (`parse_runiverse_json`) and the bulk BSON dump (`parse_runiverse_dbdump`) —
/// because r-universe emits the **same object shape** in both: identical field
/// names (`Package`, `Version`, `_exports`, `_dependencies`, `_datasets`) and
/// the same per-element structure (`{package, version, role}` deps, `{name,…}`
/// datasets). Only the container differs (one JSON object vs. concatenated BSON
/// documents), so the projection is identical.
fn record_from_runiverse(pkg: RUniversePackage) -> PackageRecord {
    let exports = sorted_unique(pkg.exports);
    let depends = sorted_unique(
        pkg.dependencies
            .into_iter()
            .filter(|d| d.role.as_deref() == Some("Depends"))
            .map(|d| d.package),
    );
    let lazy_data = sorted_unique(pkg.datasets.into_iter().filter_map(|d| d.name));
    PackageRecord {
        name: pkg.package,
        version: pkg.version,
        exports,
        depends,
        lazy_data,
    }
}

/// Parse a single r-universe package JSON string into a `PackageRecord`.
pub fn parse_runiverse_json(text: &str) -> anyhow::Result<PackageRecord> {
    let pkg: RUniversePackage = serde_json::from_str(text)?;
    Ok(record_from_runiverse(pkg))
}

/// Parse r-universe's bulk `/api/dbdump` payload — concatenated, length-prefixed
/// BSON documents with no envelope — into `PackageRecord`s.
///
/// This is the **full-coverage** bulk path. The per-package `/api/packages/<pkg>`
/// endpoint is complete but needs ~24k requests; the array/stream
/// `/api/packages` endpoint is one request but on the `cran.r-universe.dev`
/// meta-universe returns only the directly-hosted subset (~13% of CRAN). The
/// BSON dump is the single artifact that carries every package (verified against
/// the live dump: 24,347 distinct packages == `/api/ls`), the same one
/// crates.io's `db-dump.tar.gz` plays for Cargo.
///
/// Two distinct failure policies, deliberately:
///
/// - **BSON framing corruption is FATAL.** If a document can't be read off the
///   stream at all (bad length prefix, truncated tail of real content bytes), the
///   whole stream is suspect — almost always a truncated download — so we error
///   rather than return a silently-shorter result. The dump is a single
///   authoritative artifact; a cut-off stream that "succeeds" with partial
///   coverage is exactly the degraded-`names.db` outcome we must avoid. The
///   caller's distinct-count gate (`ingest_runiverse_path`) is the second line of
///   defense. **Exception:** an all-whitespace trailing remainder is treated as
///   benign padding (a stray newline some producers append), not truncation —
///   every record framed cleanly before it. (NUL stays fatal: a zero-padded tail
///   is a truncation signature, not text padding.)
/// - **A single unprojectable *record* is tolerated.** A document that reads
///   fine but whose fields don't map to `RUniversePackage` (e.g. a wrong-typed
///   `Package`) is logged and skipped — one odd package must not fail the build,
///   matching `ingest_runiverse_dir`.
///
/// Records are returned sorted by name; de-duplication across versions is the
/// merge layer's job, not this function's.
pub fn parse_runiverse_dbdump(bytes: &[u8]) -> anyhow::Result<Vec<PackageRecord>> {
    let mut cursor = std::io::Cursor::new(bytes);
    let mut records = Vec::new();
    while (cursor.position() as usize) < bytes.len() {
        // Capture the offset *before* the read so a framing failure can inspect
        // the true trailing remainder (a failed `from_reader` leaves the cursor
        // at an unspecified position).
        let pos = cursor.position() as usize;
        let doc = match bson::Document::from_reader(&mut cursor) {
            Ok(d) => d,
            Err(e) => {
                // Benign trailing padding (a stray newline some producers append)
                // is not truncation — stop cleanly. Restrict the exception to
                // whitespace: a NUL run is exactly what a truncated/zero-extended
                // or block-padded buffer leaves, so NUL stays fatal. Any other
                // unframed remainder is real content bytes → a cut-off download.
                if bytes[pos..].iter().all(|b| b.is_ascii_whitespace()) {
                    break;
                }
                return Err(anyhow::anyhow!(
                    "malformed BSON in dbdump at offset {pos}: {e} (truncated or corrupt download?)"
                ));
            }
        };
        match bson::from_document::<RUniversePackage>(doc) {
            Ok(pkg) => records.push(record_from_runiverse(pkg)),
            Err(e) => log::warn!("skipping unparseable dbdump record: {}", e),
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}

/// Ingest an r-universe source path, dispatching on its kind so the
/// `build-shipped-db` CLI accepts either layout behind one `--runiverse-*` flag:
///
/// - a **directory** → the per-package JSON layout (`ingest_runiverse_dir`),
///   used by the test fixtures and the legacy per-package fetch path;
/// - a **file** → a bulk BSON `/api/dbdump` payload (`parse_runiverse_dbdump`),
///   the full-coverage single-artifact path the build script now downloads.
///
/// `min_distinct` is the **authoritative coverage gate**: the caller passes the
/// universe's `/api/ls` count (less a small tolerance) as a floor, and a source
/// yielding fewer distinct package names aborts rather than shipping a degraded
/// `names.db`. It is the *only* coverage check (the build script no longer
/// marker-counts the dump). `None` skips the check; whether a floorless dbdump is
/// allowed is a build-policy decision enforced by the caller
/// (`run_build_shipped_db` rejects a dbdump file with no floor), not here.
pub fn ingest_runiverse_path(
    path: &Path,
    min_distinct: Option<usize>,
) -> anyhow::Result<Vec<PackageRecord>> {
    let records = if path.is_dir() {
        ingest_runiverse_dir(path)?
    } else {
        parse_runiverse_dbdump(&std::fs::read(path)?)?
    };
    if let Some(min) = min_distinct {
        let distinct = records
            .iter()
            .map(|r| r.name.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        if distinct < min {
            anyhow::bail!(
                "r-universe source {} yielded {distinct} distinct packages, below the \
                 required minimum {min} (truncated or corrupt dump?)",
                path.display()
            );
        }
    }
    Ok(records)
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

    /// Concatenate BSON documents the way r-universe's `/api/dbdump` does:
    /// length-prefixed documents back-to-back, no envelope.
    fn concat_bson(docs: &[bson::Document]) -> Vec<u8> {
        let mut buf = Vec::new();
        for d in docs {
            d.to_writer(&mut buf).unwrap();
        }
        buf
    }

    #[test]
    fn ingest_runiverse_path_dispatches_on_file_vs_dir() {
        // A directory routes to the per-package JSON ingester (existing fixtures).
        let from_dir = ingest_runiverse_path(&fixture_dir(), None).unwrap();
        assert!(from_dir.iter().any(|r| r.name == "dplyr"));

        // A regular file is treated as a BSON `/api/dbdump` payload.
        let bytes = concat_bson(&[bson::doc! {
            "Package": "frombson",
            "Version": "9.9",
            "_exports": ["z"],
        }]);
        let tmp = tempfile::Builder::new().suffix(".bson").tempfile().unwrap();
        std::fs::write(tmp.path(), &bytes).unwrap();
        let from_file = ingest_runiverse_path(tmp.path(), None).unwrap();
        assert_eq!(
            from_file
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            vec!["frombson"]
        );
    }

    /// Maintainer smoke test against a live `/api/dbdump` capture. Ignored by
    /// default (needs a multi-hundred-MB local file); run after an r-universe
    /// schema change to confirm the bulk path still parses the real artifact:
    ///   curl -A 'raven-names-db' https://cran.r-universe.dev/api/dbdump -o /tmp/cran-dbdump.bson
    ///   RAVEN_DBDUMP_PROBE=/tmp/cran-dbdump.bson cargo test -p raven --lib \
    ///     parse_real_dbdump_capture -- --ignored --nocapture
    #[test]
    #[ignore = "needs a local /api/dbdump capture; set RAVEN_DBDUMP_PROBE"]
    fn parse_real_dbdump_capture() {
        let Ok(path) = std::env::var("RAVEN_DBDUMP_PROBE") else {
            panic!("set RAVEN_DBDUMP_PROBE to a downloaded /api/dbdump file");
        };
        let bytes = std::fs::read(&path).unwrap();
        let records = parse_runiverse_dbdump(&bytes).unwrap();
        let with_exports = records.iter().filter(|r| !r.exports.is_empty()).count();
        eprintln!(
            "parsed {} records ({} with exports) from {}",
            records.len(),
            with_exports,
            path
        );
        // CRAN is ~24k packages; assert we got the full set, not a truncated
        // subset (the failure mode the array/stream endpoint exhibits).
        assert!(
            records.len() > 20_000,
            "expected full-coverage dump, got only {} records",
            records.len()
        );
        assert!(
            records
                .iter()
                .any(|r| r.name == "dplyr" && !r.exports.is_empty())
        );
    }

    #[test]
    fn parses_concatenated_bson_dump() {
        // Mirrors the real `/api/dbdump` shape verified against the live CRAN
        // dump: `_dependencies[i]` is `{package, version, role}`, `_datasets[i]`
        // is `{name, ...extra}`, and each record carries dozens of extra
        // top-level fields (`_id`, `Title`, `_score`, …) that must be ignored.
        let docs = vec![
            bson::doc! {
                "_id": "junk-objectid-stand-in",
                "Package": "dplyr",
                "Title": "A Grammar of Data Manipulation",
                "Version": "1.1.4",
                "_score": 42.0,
                "_exports": ["select", "mutate", "filter", "select"],
                "_dependencies": [
                    { "package": "R", "version": ">= 4.1.0", "role": "Depends" },
                    { "package": "cli", "version": ">= 3.0.0", "role": "Imports" },
                ],
                "_datasets": [
                    { "name": "storms", "rows": 19537, "class": ["tbl_df"] },
                    { "name": "starwars", "rows": 87 },
                ],
            },
            bson::doc! {
                "Package": "ggplot2",
                "Version": "4.0.3",
                "_exports": ["aes", "ggplot"],
                "_dependencies": [
                    { "package": "R", "version": ">= 4.1", "role": "Depends" },
                ],
                "_datasets": [ { "name": "diamonds" } ],
            },
        ];
        let records = parse_runiverse_dbdump(&concat_bson(&docs)).unwrap();

        // Sorted by name, like `ingest_runiverse_dir`.
        assert_eq!(
            records.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["dplyr", "ggplot2"]
        );
        let dplyr = records.iter().find(|r| r.name == "dplyr").unwrap();
        // De-duplicated and sorted exports; extra top-level fields ignored.
        assert_eq!(dplyr.exports, vec!["filter", "mutate", "select"]);
        // Only Depends-role deps are kept (cli is Imports); `version` ignored.
        assert_eq!(dplyr.depends, vec!["R"]);
        assert_eq!(dplyr.lazy_data, vec!["starwars", "storms"]);
        assert_eq!(dplyr.version, "1.1.4");
    }

    #[test]
    fn dbdump_tolerates_null_and_absent_array_fields() {
        // r-universe emits explicit BSON `null` for unpopulated arrays on some
        // records, and omits the key entirely on others. Both must parse — the
        // same dual coverage `null_as_empty_vec` + `#[serde(default)]` gives the
        // per-package JSON path.
        let docs = vec![
            bson::doc! {
                "Package": "ympes",
                "Version": "1.0",
                "_exports": ["foo"],
                "_dependencies": bson::Bson::Null,
                "_datasets": bson::Bson::Null,
            },
            bson::doc! {
                "Package": "bare",
                "Version": "2.0",
                "_exports": ["only"],
            },
        ];
        let records = parse_runiverse_dbdump(&concat_bson(&docs)).unwrap();
        let ympes = records.iter().find(|r| r.name == "ympes").unwrap();
        assert_eq!(ympes.exports, vec!["foo"]);
        assert!(ympes.depends.is_empty());
        assert!(ympes.lazy_data.is_empty());
        let bare = records.iter().find(|r| r.name == "bare").unwrap();
        assert_eq!(bare.exports, vec!["only"]);
        assert!(bare.depends.is_empty());
        assert!(bare.lazy_data.is_empty());
    }

    #[test]
    fn dbdump_fails_on_framing_corruption() {
        // BSON *framing* corruption (a truncated/garbage document at any offset)
        // means the stream itself is broken — most likely a truncated download —
        // so it must be FATAL, not a silently-shorter result. The dump is a single
        // authoritative artifact; shipping a partial DB from a cut-off stream is
        // exactly the "silently degraded names.db" failure we must avoid. (A bad
        // *field* on one package is different — that's tolerated below.)
        let mut bytes = concat_bson(&[bson::doc! {
            "Package": "good",
            "Version": "1.0",
            "_exports": ["x"],
        }]);
        // Append a bogus 4-byte length header claiming a huge document.
        bytes.extend_from_slice(&[0xff, 0xff, 0xff, 0x7f]);
        let err = parse_runiverse_dbdump(&bytes).unwrap_err().to_string();
        assert!(
            err.contains("malformed BSON") && err.contains("offset"),
            "expected a fatal framing error naming the offset, got: {err}"
        );
    }

    #[test]
    fn dbdump_tolerates_benign_trailing_whitespace() {
        // A stray trailing newline after the last document (some producers append
        // one) is NOT truncation — every record framed cleanly — so it must parse,
        // not abort. The exception is whitespace-only: a NUL tail stays fatal (see
        // `dbdump_fails_on_framing_corruption`), since a cut-off / zero-padded
        // download is exactly what a NUL run looks like.
        let mut bytes = concat_bson(&[bson::doc! {
            "Package": "good",
            "Version": "1.0",
            "_exports": ["x"],
        }]);
        bytes.extend_from_slice(b"\n  \n"); // newline + spaces
        let records = parse_runiverse_dbdump(&bytes).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "good");
    }

    #[test]
    fn dbdump_tolerates_a_single_unprojectable_record() {
        // A record whose *fields* don't project (here: `Package` is the wrong
        // type) is logged and skipped — one weird package must not fail the build
        // — while its well-formed neighbors still parse. This is the record-level
        // tolerance, distinct from the fatal framing policy above.
        let bytes = concat_bson(&[
            bson::doc! { "Package": 12345, "Version": "1.0", "_exports": ["x"] },
            bson::doc! { "Package": "ok", "Version": "2.0", "_exports": ["y"] },
        ]);
        let records = parse_runiverse_dbdump(&bytes).unwrap();
        assert_eq!(
            records.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["ok"]
        );
    }

    #[test]
    fn ingest_runiverse_path_enforces_min_distinct() {
        // The authoritative coverage gate: the build passes the `/api/ls` count
        // as a floor, and a dump yielding fewer distinct packages aborts rather
        // than shipping a degraded names.db. (Replaces sole reliance on the shell
        // marker-count preflight, which can't tell top-level from nested keys.)
        let bytes = concat_bson(&[
            bson::doc! { "Package": "a", "Version": "1", "_exports": ["x"] },
            bson::doc! { "Package": "b", "Version": "1", "_exports": ["y"] },
        ]);
        let tmp = tempfile::Builder::new().suffix(".bson").tempfile().unwrap();
        std::fs::write(tmp.path(), &bytes).unwrap();

        // 2 distinct packages: a floor of 2 passes, 3 fails, None skips the check.
        assert_eq!(ingest_runiverse_path(tmp.path(), Some(2)).unwrap().len(), 2);
        assert_eq!(ingest_runiverse_path(tmp.path(), None).unwrap().len(), 2);
        let err = ingest_runiverse_path(tmp.path(), Some(3))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("distinct") && err.contains('3'),
            "expected a coverage-shortfall error citing the floor, got: {err}"
        );
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
