//! `raven packages {freeze,build-shipped-db}` — package-database commands.
//!
//! `freeze` (Task 5.3) generates a repo's Tier 2 `.raven/packages.json`.
//! `build-shipped-db` is the maintainer-only Tier 3 builder. It merges, **append-only
//! and version-monotonic**, three sources into `names.db`: the prior DB (the seed),
//! an authoritative reference-R capture of the build machine's installed library,
//! and CRAN + Bioc r-universe JSON. The shipped binary never fetches from the
//! network; a build job supplies the r-universe JSON directories with `curl`.

use std::path::PathBuf;

use crate::cli::shared::absolute_path;
use crate::package_db::binary_db::{write_shipped_db, ShippedDb, ShippedDbProvenance};
use crate::package_db::json_db::{
    read_repo_db_file, write_repo_db_file, RepoDb, RepoDbProvenance, REPO_DB_SCHEMA_VERSION,
};
use crate::package_db::merge::merge_append_only;
use crate::package_db::model::PackageRecord;
use crate::package_db::renv_lock::read_renv_lock_package_names;
use crate::package_db::runiverse::ingest_runiverse_dir;
use crate::r_subprocess::is_valid_package_name;

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

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum FreezeScope {
    Used,
    All,
}

pub struct FreezeArgs {
    pub scope: FreezeScope,
    pub output: PathBuf,
    pub workspace: Option<PathBuf>,
}

pub fn parse_freeze_args(mut argv: impl Iterator<Item = String>) -> Result<FreezeArgs, String> {
    let mut scope = FreezeScope::Used;
    let mut output = PathBuf::from(".raven/packages.json");
    let mut workspace = None;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--used" => scope = FreezeScope::Used,
            "--installed" | "--all" => scope = FreezeScope::All,
            "--output" => output = PathBuf::from(argv.next().ok_or("--output needs a path")?),
            "--workspace" => {
                workspace = Some(PathBuf::from(argv.next().ok_or("--workspace needs a path")?))
            }
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(FreezeArgs {
        scope,
        output,
        workspace,
    })
}

/// Generate a repo's Tier 2 `.raven/packages.json` from installed packages.
///
/// **Provider-less (decision #6):** built with
/// [`build_package_library_tier1_only`](crate::package_library::build_package_library_tier1_only)
/// so a not-installed package can never leak a Tier 2/3 guess into the frozen
/// file — every candidate is gated by `package_exists` (Tier-1) and base
/// packages are skipped.
///
/// For `--used` the candidate set is **maximally inclusive (decision #10):**
/// `library`/`require`/`loadNamespace` call args ∪ `::`/`:::` LHS ∪ the repo's
/// DESCRIPTION Depends+Imports ∪ renv.lock ∪ transitive Depends. No-op when the
/// resulting records are unchanged (decision #11).
pub async fn run_freeze(args: FreezeArgs) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let root = match &args.workspace {
        Some(p) => absolute_path(&cwd, p),
        None => cwd.clone(),
    };
    let outcome =
        crate::package_library::build_package_library_tier1_only(None, &[], Some(root.clone()))
            .await;
    let lib = &outcome.library;

    let mut wanted: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    match args.scope {
        FreezeScope::All => {
            wanted.extend(lib.enumerate_installed_packages());
        }
        FreezeScope::Used => {
            wanted.extend(scan_workspace_referenced_packages(&root));
            wanted.extend(read_description_depends_imports(&root.join("DESCRIPTION")));
            wanted.extend(
                read_renv_lock_package_names(&root.join("renv.lock")).map_err(|e| e.to_string())?,
            );
        }
    }

    let mut records: Vec<PackageRecord> = Vec::new();
    let mut queue: Vec<String> = wanted.iter().cloned().collect();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        if lib.is_base_package(&name) {
            continue;
        }
        if !lib.package_exists(&name) {
            continue;
        }
        if let Some(info) = lib.get_package(&name).await {
            if matches!(args.scope, FreezeScope::Used) {
                for dep in &info.depends {
                    if dep != "R" && !seen.contains(dep) {
                        queue.push(dep.clone());
                    }
                }
            }
            records.push(record_with_version(lib, &name, &info));
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));

    let out = absolute_path(&root, &args.output);
    // `read_repo_db_file` maps a missing file to `Err(Absent)`, so no `exists()`
    // pre-check is needed — an absent/unreadable file simply isn't a no-op match.
    if let Ok(existing) = read_repo_db_file(&out) {
        if existing.packages == records {
            eprintln!("no changes; left {} untouched", out.display());
            return Ok(());
        }
    }

    let r_version = lib
        .r_subprocess()
        .map(|_| "present".to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let generated_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let db = RepoDb {
        schema_version: REPO_DB_SCHEMA_VERSION,
        provenance: RepoDbProvenance {
            raven_version: env!("CARGO_PKG_VERSION").to_string(),
            r_version,
            generated_unix,
        },
        packages: records,
    };
    write_repo_db_file(&out, &db).map_err(|e| e.to_string())?;
    eprintln!("Wrote {} packages to {}", db.packages.len(), out.display());
    Ok(())
}

/// Scan every R file under `root` for the maximally-inclusive referenced set
/// (decision #10): `library`/`require`/`loadNamespace`/`requireNamespace` call
/// args ∪ the `::`/`:::` namespace LHS. A single tree walk
/// ([`collect_referenced_packages`]) collects both — covering `requireNamespace`
/// directly rather than relying on `Document::loaded_packages` (whose detector
/// omits it). Over-inclusion is harmless: the `package_exists` gate in
/// `run_freeze` drops anything not installed.
fn scan_workspace_referenced_packages(root: &std::path::Path) -> Vec<String> {
    use tower_lsp::lsp_types::Url;
    let Ok(workspace_url) = Url::from_file_path(root) else {
        return Vec::new();
    };
    // `scan_workspace` returns a tuple; the `HashMap<Url, Document>` is `.0`.
    let (index, _, _) = crate::state::scan_workspace(std::slice::from_ref(&workspace_url), 0);
    let mut names = std::collections::BTreeSet::new();
    for doc in index.values() {
        if let Some(tree) = &doc.tree {
            let text = doc.contents.to_string();
            collect_referenced_packages(tree, &text, &mut names);
        }
    }
    names.into_iter().collect()
}

/// Collect every referenced package name from one parsed tree (decision #10):
/// - the `namespace_identifier` (LHS) of each `pkg::name` / `pkg:::name`
///   (`namespace_operator` node — the package id is `child(0)`, confirmed against
///   `find_namespace_context` in `handlers.rs`), and
/// - the first argument of each `library`/`require`/`loadNamespace`/
///   `requireNamespace` call (mirrors `state::extract_loaded_packages`, extended
///   to cover `requireNamespace`).
fn collect_referenced_packages(
    tree: &tree_sitter::Tree,
    text: &str,
    out: &mut std::collections::BTreeSet<String>,
) {
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        match node.kind() {
            "namespace_operator" => {
                if let Some(id) = node.child(0) {
                    let name = text[id.byte_range()].trim_matches(|c| c == '"' || c == '\'');
                    if is_valid_package_name(name) {
                        out.insert(name.to_string());
                    }
                }
            }
            "call" => {
                if let Some(func) = node.child_by_field_name("function") {
                    let func_text = &text[func.byte_range()];
                    if matches!(
                        func_text,
                        "library" | "require" | "loadNamespace" | "requireNamespace"
                    ) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            for i in 0..args.child_count() {
                                let Some(arg) = args.child(i) else { continue };
                                if arg.kind() != "argument" {
                                    continue;
                                }
                                if let Some(value) = arg.child_by_field_name("value") {
                                    let name = text[value.byte_range()]
                                        .trim_matches(|c| c == '"' || c == '\'');
                                    if is_valid_package_name(name) {
                                        out.insert(name.to_string());
                                    }
                                    break; // only the first arg names the package
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        for i in (0..node.child_count()).rev() {
            if let Some(c) = node.child(i) {
                stack.push(c);
            }
        }
    }
}

fn read_description_depends_imports(path: &std::path::Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = std::collections::BTreeSet::new();
    out.extend(crate::namespace_parser::parse_description_field_pub(
        &text, "Depends",
    ));
    out.extend(crate::namespace_parser::parse_description_field_pub(
        &text, "Imports",
    ));
    // `parse_description_field_pub` already drops the "R" version requirement,
    // so `out` never contains it.
    out.into_iter()
        .filter(|p| is_valid_package_name(p))
        .collect()
}

/// Build a Tier 2/3 record for an installed package, stamping the `Version` that
/// `PackageRecord::from_info` deliberately leaves empty (`PackageInfo` carries no
/// version). Both capture loops funnel through here so a record can never be
/// pushed with an empty version — an empty version sorts lowest in the
/// append-only monotonic merge, so a missed stamp would silently demote a real
/// package.
fn record_with_version(
    lib: &crate::package_library::PackageLibrary,
    name: &str,
    info: &crate::package_library::PackageInfo,
) -> PackageRecord {
    let mut rec = PackageRecord::from_info(info);
    rec.version = lib.package_version(name).unwrap_or_default();
    rec
}

pub async fn run_build_shipped_db(args: BuildShippedDbArgs) -> Result<(), String> {
    let prior: Vec<PackageRecord> = if args.fresh {
        Vec::new()
    } else {
        let seed_path = args.seed.clone().unwrap_or_else(|| args.output.clone());
        match ShippedDb::open(&seed_path) {
            Ok(db) => db.all_records(),
            // A missing seed is normal (first build / no prior Release). Any
            // OTHER failure (corrupt, or a newer Tier-3 format) means the prior
            // DB's accumulated history would be silently dropped — warn loudly so
            // a maintainer notices rather than shipping a regressed (shrunken) DB.
            Err(crate::package_db::binary_db::ShippedDbError::Absent) => Vec::new(),
            Err(e) => {
                eprintln!(
                    "warning: could not read seed DB {}: {e} — building without the prior DB \
                     (accumulated packages from earlier builds will be dropped unless this is fixed)",
                    seed_path.display()
                );
                Vec::new()
            }
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
                reference_r.push(record_with_version(&outcome.library, &name, &info));
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
        Some("freeze") => {
            let args = parse_freeze_args(argv)?;
            run_freeze(args).await
        }
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
    fn parse_freeze_args_defaults_to_used() {
        let a = super::parse_freeze_args(std::iter::empty()).unwrap();
        assert_eq!(a.scope, super::FreezeScope::Used);
        assert_eq!(a.output, std::path::PathBuf::from(".raven/packages.json"));

        let b = super::parse_freeze_args(["--all".to_string()].into_iter()).unwrap();
        assert_eq!(b.scope, super::FreezeScope::All);

        let c = super::parse_freeze_args(["--installed".to_string(), "--output".to_string(), "x.json".to_string()].into_iter()).unwrap();
        assert_eq!(c.scope, super::FreezeScope::All);
        assert_eq!(c.output, std::path::PathBuf::from("x.json"));
    }

    #[test]
    fn collect_referenced_packages_finds_namespace_and_calls() {
        // R-free: parse a snippet with the tree-sitter R grammar and assert both
        // `::`/`:::` LHS AND library/require/loadNamespace/requireNamespace call
        // args are collected. Proves detection (incl. requireNamespace, the
        // decision-#10 gap) without any installed package.
        let src = "dplyr::mutate(x)\n\
                   utils:::internal()\n\
                   library(ggplot2)\n\
                   require(tibble)\n\
                   loadNamespace(\"jsonlite\")\n\
                   requireNamespace(\"rlang\")\n\
                   bare_var\n";
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .expect("load R grammar");
        let tree = parser.parse(src, None).expect("parse R snippet");

        let mut out = std::collections::BTreeSet::new();
        super::collect_referenced_packages(&tree, src, &mut out);

        for expected in ["dplyr", "utils", "ggplot2", "tibble", "jsonlite", "rlang"] {
            assert!(out.contains(expected), "expected {expected}, got {out:?}");
        }
        assert!(
            !out.contains("bare_var"),
            "bare identifier must not be collected, got {out:?}"
        );
    }

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
