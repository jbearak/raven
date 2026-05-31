//! `raven packages {freeze,build-shipped-db}` — package-database commands.
//!
//! `freeze` (Task 5.3) generates a repo's Tier 2 `.raven/packages.json`.
//! `build-shipped-db` is the maintainer-only Tier 3 builder. It merges, **append-only
//! and version-monotonic**, three sources into `names.db`: the prior DB (the seed),
//! an authoritative reference-R capture of the build machine's installed library,
//! and CRAN + Bioc r-universe JSON. The shipped binary never fetches from the
//! network; a build job supplies the r-universe JSON directories with `curl`.

use std::path::PathBuf;

use crate::package_db::binary_db::{write_shipped_db, ShippedDb, ShippedDbProvenance};
use crate::package_db::merge::merge_append_only;
use crate::package_db::model::PackageRecord;
use crate::package_db::runiverse::ingest_runiverse_dir;

pub struct BuildShippedDbArgs {
    pub reference_lib: Option<PathBuf>,
    pub runiverse_cran: Option<PathBuf>,
    pub runiverse_bioc: Option<PathBuf>,
    pub fresh: bool,
    pub seed: Option<PathBuf>,
    pub output: PathBuf,
    pub base_exports_output: Option<PathBuf>,
    pub snapshot_date: String,
    pub source: String,
}

pub fn parse_build_shipped_db_args(
    mut argv: impl Iterator<Item = String>,
) -> Result<BuildShippedDbArgs, String> {
    let mut reference_lib = None;
    let mut runiverse_cran = None;
    let mut runiverse_bioc = None;
    let mut fresh = false;
    let mut seed = None;
    let mut output = None;
    let mut base_exports_output = None;
    let mut snapshot_date = String::new();
    let mut source = "reference-R ∪ r-universe".to_string();
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--reference-lib" => reference_lib = Some(PathBuf::from(argv.next().ok_or("--reference-lib needs a path")?)),
            "--runiverse-cran" => runiverse_cran = Some(PathBuf::from(argv.next().ok_or("--runiverse-cran needs a path")?)),
            "--runiverse-bioc" => runiverse_bioc = Some(PathBuf::from(argv.next().ok_or("--runiverse-bioc needs a path")?)),
            "--fresh" | "--no-seed" => fresh = true,
            "--seed" => seed = Some(PathBuf::from(argv.next().ok_or("--seed needs a path")?)),
            "--output" => output = Some(PathBuf::from(argv.next().ok_or("--output needs a path")?)),
            "--base-exports-output" => base_exports_output = Some(PathBuf::from(argv.next().ok_or("--base-exports-output needs a path")?)),
            "--snapshot-date" => snapshot_date = argv.next().ok_or("--snapshot-date needs a value")?,
            "--source" => source = argv.next().ok_or("--source needs a value")?,
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(BuildShippedDbArgs {
        reference_lib,
        runiverse_cran,
        runiverse_bioc,
        fresh,
        seed,
        output: output.ok_or("--output is required")?,
        base_exports_output,
        snapshot_date,
        source,
    })
}

pub async fn run_build_shipped_db(args: BuildShippedDbArgs) -> Result<(), String> {
    let prior: Vec<PackageRecord> = if args.fresh {
        Vec::new()
    } else {
        let seed_path = args.seed.clone().unwrap_or_else(|| args.output.clone());
        match ShippedDb::open(&seed_path) {
            Ok(db) => db.all_records(),
            Err(_) => Vec::new(),
        }
    };

    let mut runiverse: Vec<PackageRecord> = Vec::new();
    for dir in [args.runiverse_cran.as_ref(), args.runiverse_bioc.as_ref()].into_iter().flatten() {
        runiverse.extend(ingest_runiverse_dir(dir).map_err(|e| e.to_string())?);
    }

    let mut reference_r: Vec<PackageRecord> = Vec::new();
    if let Some(lib) = &args.reference_lib {
        let outcome = crate::package_library::build_package_library_tier1_only(
            None, std::slice::from_ref(lib), None,
        )
        .await;
        for name in outcome.library.enumerate_installed_packages() {
            if let Some(info) = outcome.library.get_package(&name).await {
                let mut rec = PackageRecord::from_info(&info);
                rec.version = outcome.library.package_version(&name).unwrap_or_default();
                reference_r.push(rec);
            }
        }
    }

    let merged = merge_append_only(prior, runiverse, reference_r);

    let provenance = ShippedDbProvenance {
        source: args.source,
        snapshot_date: args.snapshot_date,
        package_count: merged.len() as u32,
        raven_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    write_shipped_db(&args.output, &merged, provenance).map_err(|e| e.to_string())?;
    if let Some(base_out) = &args.base_exports_output {
        crate::package_db::write_base_exports_file(base_out, &merged).map_err(|e| e.to_string())?;
    }
    eprintln!("Wrote {} packages to {}", merged.len(), args.output.display());
    Ok(())
}

/// Dispatch the `packages` subcommand group on its second token.
pub async fn run(mut argv: impl Iterator<Item = String>) -> Result<(), String> {
    match argv.next().as_deref() {
        Some("build-shipped-db") => {
            let args = parse_build_shipped_db_args(argv)?;
            run_build_shipped_db(args).await
        }
        Some(other) => Err(format!("unknown packages subcommand: {other}")),
        None => Err("usage: raven packages <freeze|build-shipped-db> [OPTIONS]".into()),
    }
}

pub fn print_help() {
    println!(
        "raven packages — package-database commands\n\n\
         Usage:\n  \
         raven packages freeze [--used|--installed|--all] [--output PATH] [--workspace DIR]\n  \
         raven packages build-shipped-db [--reference-lib DIR] [--runiverse-cran DIR] \
[--runiverse-bioc DIR] [--seed names.db | --fresh] --output names.db \
[--base-exports-output base-exports.json] [--snapshot-date S] [--source S]\n"
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_build_shipped_db_args() {
        let args = super::parse_build_shipped_db_args(
            ["--runiverse-cran".to_string(), "cran".to_string(),
             "--runiverse-bioc".to_string(), "bioc".to_string(),
             "--output".to_string(), "out.db".to_string(),
             "--base-exports-output".to_string(), "base.json".to_string(),
             "--fresh".to_string(),
             "--snapshot-date".to_string(), "2026-05-30".to_string()]
                .into_iter(),
        )
        .unwrap();
        assert_eq!(args.runiverse_cran, Some(std::path::PathBuf::from("cran")));
        assert_eq!(args.runiverse_bioc, Some(std::path::PathBuf::from("bioc")));
        assert_eq!(args.output, std::path::PathBuf::from("out.db"));
        assert_eq!(args.base_exports_output, Some(std::path::PathBuf::from("base.json")));
        assert!(args.fresh, "--fresh skips the default prior-DB seed");
        assert_eq!(args.snapshot_date, "2026-05-30");
        assert_eq!(args.reference_lib, None);
        assert_eq!(args.seed, None);
    }
}
