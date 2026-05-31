//! `raven packages {freeze,update,build-shipped-db}` — package-database commands.
//!
//! `freeze` (Task 5.3) generates a repo's Tier 2 `.raven/packages.json`.
//! `build-shipped-db` is the maintainer-only Tier 3 builder. It merges, **append-only
//! and version-monotonic**, three sources into `names.db`: the prior DB (the seed),
//! an authoritative reference-R capture of the build machine's installed library,
//! and CRAN + Bioc r-universe JSON. The shipped binary never fetches from the
//! network; a build job supplies the r-universe JSON directories with `curl`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::{fs::OpenOptions, io::Write};

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

const DEFAULT_NAMES_DB_RELEASE_BASE: &str =
    "https://github.com/jbearak/raven/releases/download/names-db";

pub struct UpdateArgs {
    pub base_url: String,
    pub dest_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub struct InstalledSidecars {
    pub names_db_path: PathBuf,
    pub base_exports_path: PathBuf,
    pub names_db_provenance: ShippedDbProvenance,
}

pub fn parse_update_args(mut argv: impl Iterator<Item = String>) -> Result<UpdateArgs, String> {
    let mut base_url = DEFAULT_NAMES_DB_RELEASE_BASE.to_string();
    let mut dest_dir = None;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--base-url" => base_url = argv.next().ok_or("--base-url needs a URL")?,
            "--dest-dir" => {
                dest_dir = Some(PathBuf::from(argv.next().ok_or("--dest-dir needs a path")?))
            }
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(UpdateArgs { base_url, dest_dir })
}

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
            "--reference-lib" => {
                reference_lib = Some(PathBuf::from(
                    argv.next().ok_or("--reference-lib needs a path")?,
                ))
            }
            "--runiverse-cran" => {
                runiverse_cran = Some(PathBuf::from(
                    argv.next().ok_or("--runiverse-cran needs a path")?,
                ))
            }
            "--runiverse-bioc" => {
                runiverse_bioc = Some(PathBuf::from(
                    argv.next().ok_or("--runiverse-bioc needs a path")?,
                ))
            }
            "--fresh" | "--no-seed" => fresh = true,
            "--seed" => seed = Some(PathBuf::from(argv.next().ok_or("--seed needs a path")?)),
            "--output" => output = Some(PathBuf::from(argv.next().ok_or("--output needs a path")?)),
            "--base-exports-output" => {
                base_exports_output = Some(PathBuf::from(
                    argv.next().ok_or("--base-exports-output needs a path")?,
                ))
            }
            "--snapshot-date" => {
                snapshot_date = argv.next().ok_or("--snapshot-date needs a value")?
            }
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
                workspace = Some(PathBuf::from(
                    argv.next().ok_or("--workspace needs a path")?,
                ))
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

    // Freeze snapshots the INSTALLED library (Tier 1), so it needs R and at
    // least one library path. Without a ready library, the `package_exists`
    // gate below filters every candidate out and we'd overwrite a good
    // `.raven/packages.json` with an empty/partial snapshot — refuse instead.
    if !outcome.status.is_ready() {
        use crate::package_library::PackageLibraryStatus::*;
        let reason = match &outcome.status {
            RNotFound => "no R interpreter was found".to_string(),
            NoLibraryPaths => "R reported no library paths".to_string(),
            InitFailed(e) => format!("R initialization failed: {e}"),
            Disabled => "package support is disabled".to_string(),
            Ready => unreachable!("guarded by is_ready()"),
        };
        return Err(format!(
            "cannot freeze: {reason}. `raven packages freeze` needs R and an installed \
             library to verify packages; refusing to overwrite {} with an unverified snapshot",
            absolute_path(&root, &args.output).display()
        ));
    }

    let lib = &outcome.library;

    // BFS work-list seeded from the scope's sources. `seen` (below) is the sole
    // dedup mechanism and pop order is irrelevant — the reachable set is a
    // transitive closure and `records` is sorted before writing — so the seeds
    // go straight into `queue` with no intermediate dedup set.
    let mut queue: Vec<String> = Vec::new();
    match args.scope {
        FreezeScope::All => queue.extend(lib.enumerate_installed_packages()),
        FreezeScope::Used => {
            queue.extend(scan_workspace_referenced_packages(&root));
            queue.extend(read_description_depends_imports(&root.join("DESCRIPTION")));
            queue.extend(
                read_renv_lock_package_names(&root.join("renv.lock")).map_err(|e| e.to_string())?,
            );
        }
    }

    let mut records: Vec<PackageRecord> = Vec::new();
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
            // A missing seed is the only case safe to treat as "start fresh"
            // (first build / no prior Release). Any OTHER failure (corrupt, or a
            // newer Tier-3 format) means the prior DB's accumulated history would
            // be silently dropped, violating the append-only / version-monotonic
            // contract — so abort rather than ship a regressed (shrunken) DB.
            // `--fresh` is the explicit opt-in for intentionally discarding it.
            Err(crate::package_db::binary_db::ShippedDbError::Absent) => Vec::new(),
            Err(e) => {
                return Err(format!(
                    "could not read seed DB {}: {e}; rerun with --fresh only if dropping \
                     prior history is intentional",
                    seed_path.display()
                ))
            }
        }
    };

    let mut runiverse: Vec<PackageRecord> = Vec::new();
    for dir in [args.runiverse_cran.as_ref(), args.runiverse_bioc.as_ref()]
        .into_iter()
        .flatten()
    {
        runiverse.extend(ingest_runiverse_dir(dir).map_err(|e| e.to_string())?);
    }

    let mut reference_r: Vec<PackageRecord> = Vec::new();
    if let Some(lib) = &args.reference_lib {
        let outcome = crate::package_library::build_package_library_tier1_only(
            None,
            std::slice::from_ref(lib),
            None,
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
    eprintln!(
        "Wrote {} packages to {}",
        merged.len(),
        args.output.display()
    );
    Ok(())
}

pub async fn run_update(args: UpdateArgs) -> Result<(), String> {
    let dest_dir = match args.dest_dir {
        Some(dir) => dir,
        None => crate::package_db::user_data_sidecar_path("names.db")
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .ok_or_else(|| {
                "could not determine Raven user-data directory; rerun with --dest-dir, or set \
                 RAVEN_NAMES_DB/RAVEN_BASE_EXPORTS to override sidecar lookup"
                    .to_string()
            })?,
    };

    let names_bytes = download_asset(&args.base_url, "names.db").await?;
    let base_bytes = download_asset(&args.base_url, "base-exports.json").await?;
    let installed = install_downloaded_sidecars(&dest_dir, names_bytes, base_bytes)?;
    eprintln!(
        "Installed names.db to {}",
        installed.names_db_path.display()
    );
    eprintln!(
        "Installed base-exports.json to {}",
        installed.base_exports_path.display()
    );
    eprintln!(
        "names.db source: {}; snapshot: {}; packages: {}",
        installed.names_db_provenance.source,
        installed.names_db_provenance.snapshot_date,
        installed.names_db_provenance.package_count
    );
    Ok(())
}

async fn download_asset(base_url: &str, name: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}/{}", base_url.trim_end_matches('/'), name);
    tokio::task::spawn_blocking(move || download_asset_blocking(&url))
        .await
        .map_err(|e| format!("download task failed for {name}: {e}"))?
}

fn download_asset_blocking(url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!(
            "refusing to download {url}: only http:// and https:// URLs are supported. {}",
            manual_sidecar_guidance()
        ));
    }

    let output = Command::new("curl")
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=http,https",
            "--proto-redir",
            "=http,https",
            "--connect-timeout",
            "20",
            "--max-time",
            "300",
            "--max-filesize",
            "209715200",
            url,
        ])
        .output()
        .map_err(|e| {
            format!(
                "failed to run curl for {url}: {e}. `raven packages update` requires curl; \
                 {}",
                manual_sidecar_guidance()
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(curl_failure_error(
            url,
            &output.status.to_string(),
            stderr.trim(),
        ));
    }
    Ok(output.stdout)
}

fn curl_failure_error(url: &str, status: &str, stderr: &str) -> String {
    format!(
        "curl failed to download {url} with status {status}: {stderr}. {}",
        manual_sidecar_guidance()
    )
}

fn manual_sidecar_guidance() -> &'static str {
    "Alternatively, set RAVEN_NAMES_DB/RAVEN_BASE_EXPORTS to manually installed sidecars"
}

pub fn install_downloaded_sidecars(
    dest_dir: &Path,
    names_bytes: Vec<u8>,
    base_bytes: Vec<u8>,
) -> Result<InstalledSidecars, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| sidecar_write_error(dest_dir, "create", e))?;
    let names_final = dest_dir.join("names.db");
    let base_final = dest_dir.join("base-exports.json");

    let names_tmp = write_unique_temp(dest_dir, "names.db", names_bytes)?;
    let base_tmp = write_unique_temp(dest_dir, "base-exports.json", base_bytes)?;

    let db = match ShippedDb::open(&names_tmp) {
        Ok(db) => db,
        Err(e) => {
            remove_tmp_sidecars(&names_tmp, &base_tmp);
            return Err(format!(
                "downloaded names.db failed validation: {e}. {}",
                manual_sidecar_guidance()
            ));
        }
    };
    let names_db_provenance = db.provenance().clone();
    drop(db);

    if let Err(e) = read_repo_db_file(&base_tmp) {
        remove_tmp_sidecars(&names_tmp, &base_tmp);
        return Err(format!(
            "downloaded base-exports.json failed validation: {e}. {}",
            manual_sidecar_guidance()
        ));
    }

    replace_verified_sidecars(&names_tmp, &base_tmp, &names_final, &base_final)?;

    Ok(InstalledSidecars {
        names_db_path: names_final,
        base_exports_path: base_final,
        names_db_provenance,
    })
}

fn write_unique_temp(dest_dir: &Path, prefix: &str, bytes: Vec<u8>) -> Result<PathBuf, String> {
    for attempt in 0..100_u32 {
        let path = unique_sidecar_path(dest_dir, prefix, attempt, "tmp");
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&bytes) {
                    let _ = std::fs::remove_file(&path);
                    return Err(sidecar_write_error(&path, "write", e));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(sidecar_write_error(&path, "create", e)),
        }
    }

    Err(format!(
        "could not create unique temporary sidecar in {}; rerun with --dest-dir pointing to a \
         writable directory, or set RAVEN_NAMES_DB/RAVEN_BASE_EXPORTS to override sidecar lookup",
        dest_dir.display()
    ))
}

fn replace_verified_sidecars(
    names_tmp: &Path,
    base_tmp: &Path,
    names_final: &Path,
    base_final: &Path,
) -> Result<(), String> {
    let mut names_backup = None;
    let mut base_backup = None;
    let mut names_installed = false;
    let mut base_installed = false;

    let result = (|| {
        names_backup = backup_existing_final(names_final)?;
        base_backup = backup_existing_final(base_final)?;

        replace_with_tmp(names_tmp, names_final)?;
        names_installed = true;

        replace_with_tmp(base_tmp, base_final)?;
        base_installed = true;

        Ok(())
    })();

    if let Err(e) = result {
        if names_installed {
            let _ = std::fs::remove_file(names_final);
        }
        if base_installed {
            let _ = std::fs::remove_file(base_final);
        }
        restore_backup(names_backup.as_deref(), names_final);
        restore_backup(base_backup.as_deref(), base_final);
        return Err(e);
    }

    remove_backup(names_backup.as_deref());
    remove_backup(base_backup.as_deref());
    Ok(())
}

fn backup_existing_final(final_path: &Path) -> Result<Option<PathBuf>, String> {
    if !final_path.exists() {
        return Ok(None);
    }
    let dir = final_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("sidecar");
    let prefix = format!("{file_name}.backup");

    for attempt in 0..100_u32 {
        let backup = unique_sidecar_path(dir, &prefix, attempt, "bak");
        match std::fs::rename(final_path, &backup) {
            Ok(()) => return Ok(Some(backup)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(sidecar_write_error(final_path, "backup", e)),
        }
    }

    Err(format!(
        "could not create unique backup sidecar for {}; rerun with --dest-dir pointing to a \
         writable directory, or set RAVEN_NAMES_DB/RAVEN_BASE_EXPORTS to override sidecar lookup",
        final_path.display()
    ))
}

fn unique_sidecar_path(dest_dir: &Path, prefix: &str, attempt: u32, suffix: &str) -> PathBuf {
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dest_dir.join(format!(".{prefix}.{pid}.{nanos}.{attempt}.{suffix}"))
}

fn restore_backup(backup: Option<&Path>, final_path: &Path) {
    if let Some(backup) = backup {
        let _ = std::fs::rename(backup, final_path);
    }
}

fn remove_backup(backup: Option<&Path>) {
    if let Some(backup) = backup {
        let _ = std::fs::remove_file(backup);
    }
}

fn replace_with_tmp(tmp: &Path, final_path: &Path) -> Result<(), String> {
    replace_file(tmp, final_path).map_err(|e| sidecar_write_error(final_path, "replace", e))
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, final_path: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp, final_path)
}

#[cfg(windows)]
fn replace_file(tmp: &Path, final_path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let existing: Vec<u16> = tmp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let new: Vec<u16> = final_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            new.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn remove_tmp_sidecars(names_tmp: &Path, base_tmp: &Path) {
    let _ = std::fs::remove_file(names_tmp);
    let _ = std::fs::remove_file(base_tmp);
}

fn sidecar_write_error(path: &Path, action: &str, error: std::io::Error) -> String {
    format!(
        "could not {action} {}: {error}; rerun with --dest-dir pointing to a writable \
         directory, or set RAVEN_NAMES_DB/RAVEN_BASE_EXPORTS to override sidecar lookup",
        path.display()
    )
}

/// Dispatch the `packages` subcommand group on its second token.
pub async fn run(mut argv: impl Iterator<Item = String>) -> Result<(), String> {
    match argv.next().as_deref() {
        Some("update") => {
            let args = parse_update_args(argv)?;
            run_update(args).await
        }
        Some("freeze") => {
            let args = parse_freeze_args(argv)?;
            run_freeze(args).await
        }
        Some("build-shipped-db") => {
            let args = parse_build_shipped_db_args(argv)?;
            run_build_shipped_db(args).await
        }
        Some(other) => Err(format!("unknown packages subcommand: {other}")),
        None => Err("usage: raven packages <freeze|update|build-shipped-db> [OPTIONS]".into()),
    }
}

pub fn print_help() {
    println!(
        "raven packages — package-database commands\n\n\
         Usage:\n  \
         raven packages freeze [--used|--installed|--all] [--output PATH] [--workspace DIR]\n  \
         raven packages update [--base-url URL] [--dest-dir DIR]\n  \
         raven packages build-shipped-db [--reference-lib DIR] [--runiverse-cran DIR] \
[--runiverse-bioc DIR] [--seed names.db | --fresh] --output names.db \
[--base-exports-output base-exports.json] [--snapshot-date S] [--source S]\n"
    );
}

#[cfg(test)]
mod tests {
    use crate::package_db::binary_db::{write_shipped_db, ShippedDb, ShippedDbProvenance};
    use crate::package_db::json_db::{
        read_repo_db_file, write_repo_db_file, RepoDb, RepoDbProvenance, REPO_DB_SCHEMA_VERSION,
    };
    use crate::package_db::model::PackageRecord;

    #[test]
    fn parse_freeze_args_defaults_to_used() {
        let a = super::parse_freeze_args(std::iter::empty()).unwrap();
        assert_eq!(a.scope, super::FreezeScope::Used);
        assert_eq!(a.output, std::path::PathBuf::from(".raven/packages.json"));

        let b = super::parse_freeze_args(["--all".to_string()].into_iter()).unwrap();
        assert_eq!(b.scope, super::FreezeScope::All);

        let c = super::parse_freeze_args(
            [
                "--installed".to_string(),
                "--output".to_string(),
                "x.json".to_string(),
            ]
            .into_iter(),
        )
        .unwrap();
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
            [
                "--runiverse-cran".to_string(),
                "cran".to_string(),
                "--runiverse-bioc".to_string(),
                "bioc".to_string(),
                "--output".to_string(),
                "out.db".to_string(),
                "--base-exports-output".to_string(),
                "base.json".to_string(),
                "--fresh".to_string(),
                "--snapshot-date".to_string(),
                "2026-05-30".to_string(),
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(args.runiverse_cran, Some(std::path::PathBuf::from("cran")));
        assert_eq!(args.runiverse_bioc, Some(std::path::PathBuf::from("bioc")));
        assert_eq!(args.output, std::path::PathBuf::from("out.db"));
        assert_eq!(
            args.base_exports_output,
            Some(std::path::PathBuf::from("base.json"))
        );
        assert!(args.fresh, "--fresh skips the default prior-DB seed");
        assert_eq!(args.snapshot_date, "2026-05-30");
        assert_eq!(args.reference_lib, None);
        assert_eq!(args.seed, None);
    }

    #[test]
    fn parse_update_args_defaults_to_names_db_release() {
        let args = super::parse_update_args(std::iter::empty()).unwrap();
        assert!(args.base_url.contains("github.com"));
        assert_eq!(args.dest_dir, None);
    }

    #[test]
    fn parse_update_args_accepts_base_url_and_dest_dir() {
        let args = super::parse_update_args(
            [
                "--base-url".to_string(),
                "http://127.0.0.1:9/assets".to_string(),
                "--dest-dir".to_string(),
                "/tmp/raven-db".to_string(),
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(args.base_url, "http://127.0.0.1:9/assets");
        assert_eq!(
            args.dest_dir.unwrap(),
            std::path::PathBuf::from("/tmp/raven-db")
        );
    }

    #[test]
    fn atomic_install_rejects_invalid_names_db_and_leaves_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let existing = dir.path().join("names.db");
        std::fs::write(&existing, b"existing").unwrap();
        let err = super::install_downloaded_sidecars(
            dir.path(),
            b"not a raven db".to_vec(),
            b"{}".to_vec(),
        )
        .unwrap_err();
        assert!(err.contains("names.db"));
        assert!(err.contains("RAVEN_NAMES_DB"), "got {err}");
        assert!(err.contains("RAVEN_BASE_EXPORTS"), "got {err}");
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing");
    }

    #[test]
    fn atomic_install_rejects_invalid_base_exports_and_suggests_manual_sidecars() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let records = vec![PackageRecord {
            name: "base".into(),
            version: "4.4.0".into(),
            exports: vec!["mean".into()],
            depends: vec![],
            lazy_data: vec![],
        }];
        let provenance = ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-31".into(),
            package_count: records.len() as u32,
            raven_version: "9.9.9".into(),
        };
        let names_src = source.path().join("names.db");
        write_shipped_db(&names_src, &records, provenance).unwrap();

        let err = super::install_downloaded_sidecars(
            dest.path(),
            std::fs::read(&names_src).unwrap(),
            b"not json".to_vec(),
        )
        .unwrap_err();

        assert!(err.contains("base-exports.json"), "got {err}");
        assert!(err.contains("RAVEN_NAMES_DB"), "got {err}");
        assert!(err.contains("RAVEN_BASE_EXPORTS"), "got {err}");
    }

    #[test]
    fn atomic_install_accepts_valid_sidecars() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let records = vec![PackageRecord {
            name: "base".into(),
            version: "4.4.0".into(),
            exports: vec!["mean".into()],
            depends: vec![],
            lazy_data: vec![],
        }];
        let provenance = ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-31".into(),
            package_count: records.len() as u32,
            raven_version: "9.9.9".into(),
        };
        let names_src = source.path().join("names.db");
        write_shipped_db(&names_src, &records, provenance).unwrap();
        let repo_db = RepoDb {
            schema_version: REPO_DB_SCHEMA_VERSION,
            provenance: RepoDbProvenance {
                raven_version: "9.9.9".into(),
                r_version: "4.4.0".into(),
                generated_unix: 1_800_000_000,
            },
            packages: records,
        };
        let base_src = source.path().join("base-exports.json");
        write_repo_db_file(&base_src, &repo_db).unwrap();

        let installed = super::install_downloaded_sidecars(
            dest.path(),
            std::fs::read(&names_src).unwrap(),
            std::fs::read(&base_src).unwrap(),
        )
        .unwrap();

        assert_eq!(installed.names_db_path, dest.path().join("names.db"));
        assert_eq!(
            installed.base_exports_path,
            dest.path().join("base-exports.json")
        );
        ShippedDb::open(&installed.names_db_path).unwrap();
        read_repo_db_file(&installed.base_exports_path).unwrap();
    }

    #[test]
    fn atomic_install_ignores_preexisting_fixed_temp_names() {
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let fixed_names_tmp = dest.path().join("names.db.tmp");
        let fixed_base_tmp = dest.path().join("base-exports.json.tmp");
        std::fs::write(&fixed_names_tmp, b"do not touch names").unwrap();
        std::fs::write(&fixed_base_tmp, b"do not touch base").unwrap();

        let records = vec![PackageRecord {
            name: "base".into(),
            version: "4.4.0".into(),
            exports: vec!["mean".into()],
            depends: vec![],
            lazy_data: vec![],
        }];
        let provenance = ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-31".into(),
            package_count: records.len() as u32,
            raven_version: "9.9.9".into(),
        };
        let names_src = source.path().join("names.db");
        write_shipped_db(&names_src, &records, provenance).unwrap();
        let repo_db = RepoDb {
            schema_version: REPO_DB_SCHEMA_VERSION,
            provenance: RepoDbProvenance {
                raven_version: "9.9.9".into(),
                r_version: "4.4.0".into(),
                generated_unix: 1_800_000_000,
            },
            packages: records,
        };
        let base_src = source.path().join("base-exports.json");
        write_repo_db_file(&base_src, &repo_db).unwrap();

        super::install_downloaded_sidecars(
            dest.path(),
            std::fs::read(&names_src).unwrap(),
            std::fs::read(&base_src).unwrap(),
        )
        .unwrap();

        assert_eq!(
            std::fs::read(&fixed_names_tmp).unwrap(),
            b"do not touch names"
        );
        assert_eq!(
            std::fs::read(&fixed_base_tmp).unwrap(),
            b"do not touch base"
        );
    }

    #[test]
    fn install_verified_sidecars_rolls_back_when_second_replace_fails() {
        let dir = tempfile::tempdir().unwrap();
        let names_final = dir.path().join("names.db");
        let base_final = dir.path().join("base-exports.json");
        std::fs::write(&names_final, b"old names").unwrap();
        std::fs::write(&base_final, b"old base").unwrap();

        let names_tmp = dir.path().join("new-names.tmp");
        let missing_base_tmp = dir.path().join("missing-base.tmp");
        std::fs::write(&names_tmp, b"new names").unwrap();
        let err = super::replace_verified_sidecars(
            &names_tmp,
            &missing_base_tmp,
            &names_final,
            &base_final,
        )
        .unwrap_err();

        assert!(err.contains("base-exports.json"), "got {err}");
        assert_eq!(std::fs::read(&names_final).unwrap(), b"old names");
        assert_eq!(std::fs::read(&base_final).unwrap(), b"old base");
    }

    #[test]
    fn download_asset_blocking_rejects_non_http_urls() {
        let err = super::download_asset_blocking("file:///tmp/names.db").unwrap_err();
        assert!(err.contains("http://"), "got {err}");
        assert!(err.contains("https://"), "got {err}");
        assert!(err.contains("RAVEN_NAMES_DB"), "got {err}");
        assert!(err.contains("RAVEN_BASE_EXPORTS"), "got {err}");
    }

    #[test]
    fn curl_failure_errors_suggest_manual_sidecars() {
        let err = super::curl_failure_error(
            "https://example.invalid/names.db",
            "exit status: 7",
            "could not connect",
        );
        assert!(err.contains("RAVEN_NAMES_DB"), "got {err}");
        assert!(err.contains("RAVEN_BASE_EXPORTS"), "got {err}");
    }

    #[test]
    fn download_asset_blocking_rejects_ftp_without_network() {
        let err = super::download_asset_blocking("ftp://example.invalid/file").unwrap_err();
        assert!(err.contains("http://"), "got {err}");
        assert!(err.contains("https://"), "got {err}");
        assert!(err.contains("RAVEN_NAMES_DB"), "got {err}");
        assert!(err.contains("RAVEN_BASE_EXPORTS"), "got {err}");
    }

    #[cfg(not(windows))]
    #[test]
    fn replace_with_tmp_preserves_existing_final_when_tmp_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing_tmp = dir.path().join("missing.tmp");
        let final_path = dir.path().join("names.db");
        std::fs::write(&final_path, b"existing").unwrap();

        let err = super::replace_with_tmp(&missing_tmp, &final_path).unwrap_err();

        assert!(err.contains("replace"), "got {err}");
        assert_eq!(std::fs::read(&final_path).unwrap(), b"existing");
    }
}
