# Tier 3 Source Install Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make raw Cargo/source installs usable for R platform symbols while keeping broad ecosystem metadata as an explicit, user-downloaded sidecar.

**Architecture:** Extend sidecar lookup into an ordered locator that yields all candidate paths, then load Tier 3 candidates in order while falling through corrupt or incompatible files. Add a user-data installer command for `names.db` and `base-exports.json`, and add an embedded base/recommended fallback that is used only after installed R packages and base sidecars miss.

**Tech Stack:** Rust 2021, Tokio, `memmap2`, `postcard`, `serde_json`, `xdg` on Unix, standard-library HTTP fallback through a small injectable downloader seam, existing Raven CLI/test harness.

---

## File Structure

- Modify `crates/raven/src/package_db/mod.rs`: user-data path helpers, ordered sidecar candidate locators, test overrides for user-data paths.
- Modify `crates/raven/src/package_db/binary_db.rs`: expose `ShippedDb::provenance()` for `packages update` output.
- Modify `crates/raven/src/package_db/base_exports.rs`: load base exports from ordered candidates and expose embedded fallback helpers.
- Create `crates/raven/src/package_db/embedded_base.rs`: compact built-in R platform floor and conversion to flat exports/package names.
- Modify `crates/raven/src/package_library.rs`: load all Tier 3 candidates with fallback notes; use embedded base floor after sidecar miss.
- Modify `crates/raven/Cargo.toml`: add the blocking HTTP client used only by the explicit `packages update` command.
- Modify `crates/raven/src/cli/packages.rs`: parse and run `raven packages update`; add injectable downloader and atomic install helper tests.
- Modify `crates/raven/src/main.rs`: include `packages update` in top-level usage.
- Modify `crates/raven/src/cli/check.rs`: add targeted package-export metadata warnings after diagnostics are produced.
- Modify `docs/cli.md`, `docs/package-database.md`, `docs/r-package-dev.md`, `docs/development.md`, and `README.md`: distinguish packaged installs from Cargo/source installs and document `packages update`.

Do not commit during execution unless the user explicitly asks. At each checkpoint, inspect `git diff` instead of creating a commit.

---

### Task 1: Ordered Sidecar Locators

**Files:**
- Modify: `crates/raven/src/package_db/mod.rs:26-159`

- [ ] **Step 1: Write failing locator tests**

Add tests in `crates/raven/src/package_db/mod.rs` under the existing `#[cfg(test)] mod tests`:

```rust
#[tokio::test]
async fn sidecar_candidates_prefer_env_then_user_data_then_exe_relative() {
    let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let user_data = dir.path().join("data");
    let custom = dir.path().join("custom.db");

    std::env::set_var("RAVEN_NAMES_DB", &custom);
    set_test_user_data_dir(Some(user_data.clone()));
    let candidates = locate_shipped_db_candidates();
    std::env::remove_var("RAVEN_NAMES_DB");
    set_test_user_data_dir(None);

    assert_eq!(candidates[0], custom);
    assert_eq!(candidates[1], user_data.join("names.db"));
    assert!(candidates.iter().any(|p| p.file_name().unwrap() == "names.db"));
}

#[tokio::test]
async fn empty_env_does_not_shadow_user_data_sidecar() {
    let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let user_data = dir.path().join("data");

    std::env::set_var("RAVEN_NAMES_DB", "");
    set_test_user_data_dir(Some(user_data.clone()));
    let first = locate_shipped_db_candidates().remove(0);
    std::env::remove_var("RAVEN_NAMES_DB");
    set_test_user_data_dir(None);

    assert_eq!(first, user_data.join("names.db"));
}

#[tokio::test]
async fn base_exports_candidates_use_same_precedence() {
    let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let user_data = dir.path().join("data");
    let custom = dir.path().join("base.json");

    std::env::set_var("RAVEN_BASE_EXPORTS", &custom);
    set_test_user_data_dir(Some(user_data.clone()));
    let candidates = locate_base_exports_candidates();
    std::env::remove_var("RAVEN_BASE_EXPORTS");
    set_test_user_data_dir(None);

    assert_eq!(candidates[0], custom);
    assert_eq!(candidates[1], user_data.join("base-exports.json"));
    assert!(candidates.iter().any(|p| p.file_name().unwrap() == "base-exports.json"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven package_db::tests::sidecar_candidates_prefer_env_then_user_data_then_exe_relative package_db::tests::empty_env_does_not_shadow_user_data_sidecar package_db::tests::base_exports_candidates_use_same_precedence`

Expected: FAIL because `locate_shipped_db_candidates`, `locate_base_exports_candidates`, and `set_test_user_data_dir` do not exist.

- [ ] **Step 3: Implement ordered locator helpers**

Replace the single-path locator area in `crates/raven/src/package_db/mod.rs` with this shape, preserving the old `locate_shipped_db()` / `locate_base_exports()` wrappers for callers that still need one path:

```rust
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const USER_DATA_APP_DIR_UNIX: &str = "raven";
const USER_DATA_APP_DIR_WINDOWS: &str = "Raven";

pub fn locate_shipped_db() -> Option<PathBuf> {
    locate_shipped_db_candidates().into_iter().next()
}

pub fn locate_shipped_db_candidates() -> Vec<PathBuf> {
    locate_sidecar_candidates("RAVEN_NAMES_DB", "names.db")
}

pub fn locate_base_exports() -> Option<PathBuf> {
    locate_base_exports_candidates().into_iter().next()
}

pub fn locate_base_exports_candidates() -> Vec<PathBuf> {
    locate_sidecar_candidates("RAVEN_BASE_EXPORTS", "base-exports.json")
}

pub fn user_data_sidecar_path(file_name: &str) -> Option<PathBuf> {
    user_data_dir().map(|dir| dir.join(file_name))
}

fn locate_sidecar_candidates(env_var: &str, file_name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var(env_var) {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Some(p) = user_data_sidecar_path(file_name) {
        push_unique(&mut out, p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push_unique(&mut out, dir.join(file_name));
        }
    }
    out
}

fn push_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !out.iter().any(|existing| existing == &path) {
        out.push(path);
    }
}

fn user_data_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_USER_DATA_DIR
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("test user data dir lock")
        .clone()
    {
        return Some(dir);
    }

    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join(USER_DATA_APP_DIR_WINDOWS))
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(home).join(USER_DATA_APP_DIR_UNIX));
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".local").join("share").join(USER_DATA_APP_DIR_UNIX))
    }
}

#[cfg(test)]
static TEST_USER_DATA_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn set_test_user_data_dir(path: Option<PathBuf>) {
    *TEST_USER_DATA_DIR
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("test user data dir lock") = path;
}
```

- [ ] **Step 4: Run locator tests**

Run: `cargo test -p raven package_db::tests::sidecar_candidates_prefer_env_then_user_data_then_exe_relative package_db::tests::empty_env_does_not_shadow_user_data_sidecar package_db::tests::base_exports_candidates_use_same_precedence`

Expected: PASS.

---

### Task 2: Fall Through Bad Higher-Priority Tier 3 DBs

**Files:**
- Modify: `crates/raven/src/package_library.rs:1794-1828`

- [ ] **Step 1: Write failing provider fallback test**

Add this test near `build_library_reports_unreadable_shipped_db_in_load_notes` in `crates/raven/src/package_library.rs`:

```rust
#[tokio::test]
async fn build_library_falls_back_from_bad_user_db_to_lower_candidate() {
    use crate::package_db::binary_db::{write_shipped_db, ShippedDbProvenance};
    use crate::package_db::model::PackageRecord;

    let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let user_data = dir.path().join("data");
    let bad_env_db = dir.path().join("bad.db");
    let good_user_db = user_data.join("names.db");
    std::fs::create_dir_all(&user_data).unwrap();
    std::fs::write(&bad_env_db, b"not a raven db").unwrap();

    let pkg = "ravenlowercandidatepkg";
    write_shipped_db(
        &good_user_db,
        &[PackageRecord {
            name: pkg.into(),
            version: "1.0.0".into(),
            exports: vec!["lower_export".into()],
            depends: vec![],
            lazy_data: vec![],
        }],
        ShippedDbProvenance {
            source: "test".into(),
            snapshot_date: "2026-05-31".into(),
            package_count: 1,
            raven_version: "9.9.9".into(),
        },
    )
    .unwrap();

    crate::package_db::set_test_user_data_dir(Some(user_data));
    std::env::set_var("RAVEN_NAMES_DB", &bad_env_db);
    let outcome = build_package_library(None, &[], None, true).await;
    std::env::remove_var("RAVEN_NAMES_DB");
    crate::package_db::set_test_user_data_dir(None);

    assert!(outcome.load_notes.iter().any(|n| n.contains("names.db")));
    assert!(outcome
        .library
        .get_package(pkg)
        .await
        .expect("lower candidate provider resolves")
        .exports
        .contains("lower_export"));
}
```

- [ ] **Step 2: Run test to verify current single-path behavior fails**

Run: `cargo test -p raven package_library::tests::build_library_falls_back_from_bad_user_db_to_lower_candidate`

Expected: FAIL until `build_package_library` iterates ordered Tier 3 candidates and continues after corrupt/incompatible files.

- [ ] **Step 3: Implement candidate iteration in `build_package_library`**

Change the shipped DB path logic to move a `Vec<PathBuf>` into `spawn_blocking`:

```rust
let shipped_db_paths = crate::package_db::locate_shipped_db_candidates();
let (providers, notes) = tokio::task::spawn_blocking(move || {
    let mut providers: Vec<Box<dyn crate::package_db::PackageMetadataProvider>> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if let Some(path) = repo_db_path {
        match crate::package_db::json_db::RepoDbProvider::from_file(&path) {
            Ok(Some(p)) => providers.push(Box::new(p)),
            Ok(None) => {}
            Err(e) => notes.push(e.to_string()),
        }
    }
    for path in shipped_db_paths {
        match crate::package_db::binary_db::ShippedDbProvider::from_file(&path) {
            Ok(Some(p)) => {
                providers.push(Box::new(p));
                break;
            }
            Ok(None) => {}
            Err(e) => notes.push(format!("{}: {e}", path.display())),
        }
    }
    (providers, notes)
})
```

- [ ] **Step 4: Run provider fallback tests**

Run: `cargo test -p raven package_library::tests::build_library_wires_shipped_db_provider_from_env package_library::tests::build_library_reports_unreadable_shipped_db_in_load_notes package_library::tests::build_library_falls_back_from_bad_user_db_to_lower_candidate`

Expected: PASS after adjusting the test to use actual ordered candidates.

---

### Task 3: Embedded Base/Recommended Floor

**Files:**
- Create: `crates/raven/src/package_db/embedded_base.rs`
- Modify: `crates/raven/src/package_db/mod.rs:18-24`
- Modify: `crates/raven/src/package_db/base_exports.rs:1-91`
- Modify: `crates/raven/src/package_library.rs:1158-1175`

- [ ] **Step 1: Write failing embedded fallback test**

Add in `crates/raven/src/package_library.rs` tests:

```rust
#[tokio::test]
async fn initialize_uses_embedded_base_exports_when_disk_and_sidecars_absent() {
    let _env_guard = RAVEN_NAMES_DB_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    crate::package_db::set_test_user_data_dir(Some(dir.path().join("missing-data")));
    std::env::set_var("RAVEN_BASE_EXPORTS", dir.path().join("missing-base.json"));

    let outcome = build_package_library(None, &[], None, true).await;

    std::env::remove_var("RAVEN_BASE_EXPORTS");
    crate::package_db::set_test_user_data_dir(None);

    assert!(outcome.library.base_exports().contains("print"));
    assert!(outcome.library.base_exports().contains("mtcars"));
    assert!(outcome.library.is_base_package("base"));
    assert!(outcome.library.is_base_package("datasets"));
}
```

- [ ] **Step 2: Run test to verify it fails if no sidecar is available**

Run: `cargo test -p raven package_library::tests::initialize_uses_embedded_base_exports_when_disk_and_sidecars_absent`

Expected: FAIL until embedded fallback is added. On machines with R installed, force no disk packages by constructing `PackageLibrary::with_subprocess(None)` with empty lib paths in the test if needed.

- [ ] **Step 3: Add embedded base module**

Create `crates/raven/src/package_db/embedded_base.rs`:

```rust
//! Compact built-in base/recommended export floor used only when installed R
//! packages and base-exports sidecars are unavailable.

use std::collections::HashSet;

const BASE_EXPORTS: &[&str] = &[
    "::", ":::", "[", "[[", "$", "<-", "=", "{", "(", "if", "for", "while", "repeat",
    "function", "break", "next", "TRUE", "FALSE", "NULL", "NA", "NaN", "Inf", "print", "cat",
    "sum", "mean", "median", "min", "max", "length", "seq", "seq_len", "seq_along", "c",
    "list", "data.frame", "matrix", "array", "factor", "as.character", "as.numeric",
    "as.integer", "as.logical", "is.na", "is.null", "isTRUE", "stop", "warning", "message",
    "library", "require", "source", "get", "exists", "assign", "ls", "rm", "paste", "paste0",
    "sprintf", "format", "names", "colnames", "rownames", "nrow", "ncol", "dim", "str",
    "summary", "head", "tail", "help", "set.seed", "sample", "runif", "rnorm", "dnorm",
    "pnorm", "qnorm", "lm", "glm", "predict", "plot", "hist", "lines", "points", "title",
];

const BASE_DATASETS: &[&str] = &[
    "AirPassengers", "BOD", "CO2", "ChickWeight", "DNase", "EuStockMarkets", "Formaldehyde",
    "HairEyeColor", "InsectSprays", "JohnsonJohnson", "LakeHuron", "LifeCycleSavings",
    "Loblolly", "Nile", "Orange", "OrchardSprays", "PlantGrowth", "Puromycin", "Theoph",
    "Titanic", "ToothGrowth", "UCBAdmissions", "UKDriverDeaths", "UKgas", "USAccDeaths",
    "USArrests", "USJudgeRatings", "USPersonalExpenditure", "UScitiesD", "VADeaths",
    "WWWusage", "WorldPhones", "airmiles", "airquality", "anscombe", "attenu", "attitude",
    "austres", "beaver1", "beaver2", "cars", "chickwts", "co2", "crimtab", "discoveries",
    "esoph", "euro", "euro.cross", "eurodist", "faithful", "fdeaths", "freeny", "infert",
    "iris", "iris3", "islands", "ldeaths", "lh", "longley", "lynx", "mdeaths", "morley",
    "mtcars", "nhtemp", "nottem", "occupationalStatus", "precip", "presidents", "pressure",
    "quakes", "randu", "rivers", "rock", "sleep", "stack.loss", "stack.x", "stackloss",
    "state.abb", "state.area", "state.center", "state.division", "state.name", "state.region",
    "state.x77", "sunspot.month", "sunspot.year", "sunspots", "swiss", "treering", "trees",
    "uspop", "volcano", "warpbreaks", "women",
];

const BASE_PACKAGES: &[&str] = &[
    "base", "compiler", "datasets", "graphics", "grDevices", "grid", "methods", "parallel",
    "splines", "stats", "stats4", "tcltk", "tools", "utils",
];

pub fn load() -> (HashSet<String>, HashSet<String>) {
    let exports = BASE_EXPORTS
        .iter()
        .chain(BASE_DATASETS.iter())
        .map(|s| (*s).to_string())
        .collect();
    let packages = BASE_PACKAGES.iter().map(|s| (*s).to_string()).collect();
    (exports, packages)
}
```

Add `pub mod embedded_base;` to `crates/raven/src/package_db/mod.rs`.

- [ ] **Step 4: Load base sidecar candidates then embedded fallback**

In `PackageLibrary::initialize`, replace the single `locate_base_exports()` load with ordered sidecar candidates and embedded final fallback:

```rust
if all_base_exports.is_empty() {
    for path in crate::package_db::locate_base_exports_candidates() {
        if let Some((file_exports, file_packages)) =
            crate::package_db::base_exports::load_base_exports(&path)
        {
            log::info!("Loaded base exports from {:?}", path);
            all_base_exports.extend(file_exports);
            self.base_packages.extend(file_packages);
            break;
        }
    }
}

if all_base_exports.is_empty() {
    let (embedded_exports, embedded_packages) = crate::package_db::embedded_base::load();
    all_base_exports.extend(embedded_exports);
    self.base_packages.extend(embedded_packages);
}
```

- [ ] **Step 5: Run embedded fallback tests**

Run: `cargo test -p raven package_library::tests::initialize_uses_embedded_base_exports_when_disk_absent package_library::tests::initialize_uses_embedded_base_exports_when_disk_and_sidecars_absent`

Expected: PASS. If an existing test name differs, run the nearest existing base-export fallback tests from `package_library.rs`.

---

### Task 4: `raven packages update` Download and Atomic Install

**Files:**
- Modify: `crates/raven/Cargo.toml:15-46`
- Modify: `crates/raven/src/package_db/binary_db.rs:269-283`
- Modify: `crates/raven/src/cli/packages.rs:1-456`
- Modify: `crates/raven/src/main.rs:15-49`

- [ ] **Step 1: Write failing parser and atomic install tests**

Add tests in `crates/raven/src/cli/packages.rs`:

```rust
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
    assert_eq!(args.dest_dir.unwrap(), std::path::PathBuf::from("/tmp/raven-db"));
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
    assert_eq!(std::fs::read(&existing).unwrap(), b"existing");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p raven cli::packages::tests::parse_update_args_defaults_to_names_db_release cli::packages::tests::parse_update_args_accepts_base_url_and_dest_dir cli::packages::tests::atomic_install_rejects_invalid_names_db_and_leaves_existing_file`

Expected: FAIL because update parser and install helper do not exist.

- [ ] **Step 3: Add provenance accessor**

In `crates/raven/src/package_db/binary_db.rs`, add:

```rust
pub fn provenance(&self) -> &ShippedDbProvenance {
    &self.provenance
}
```

inside `impl ShippedDb`.

- [ ] **Step 4: Add the explicit-update-only HTTP dependency**

In `crates/raven/Cargo.toml`, add:

```toml
ureq = "2"
```

This dependency is used only inside `raven packages update`; no startup, LSP, or `raven check` path calls it.

- [ ] **Step 5: Implement update args and dispatch**

In `crates/raven/src/cli/packages.rs`, add:

```rust
const DEFAULT_NAMES_DB_RELEASE_BASE: &str =
    "https://github.com/jbearak/raven/releases/download/names-db";

pub struct UpdateArgs {
    pub base_url: String,
    pub dest_dir: Option<PathBuf>,
}

pub fn parse_update_args(mut argv: impl Iterator<Item = String>) -> Result<UpdateArgs, String> {
    let mut base_url = DEFAULT_NAMES_DB_RELEASE_BASE.to_string();
    let mut dest_dir = None;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--base-url" => base_url = argv.next().ok_or("--base-url needs a URL")?,
            "--dest-dir" => dest_dir = Some(PathBuf::from(argv.next().ok_or("--dest-dir needs a path")?)),
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(UpdateArgs { base_url, dest_dir })
}
```

Update `run`:

```rust
Some("update") => {
    let args = parse_update_args(argv)?;
    run_update(args).await
}
```

Update help strings in `packages.rs` and `main.rs` to include `update`.

- [ ] **Step 6: Implement injectable downloader and atomic installer**

Add helpers in `crates/raven/src/cli/packages.rs`:

```rust
use std::io::Read;

type DownloadedBytes = Vec<u8>;

async fn download_asset(base_url: &str, name: &str) -> Result<DownloadedBytes, String> {
    let url = format!("{}/{}", base_url.trim_end_matches('/'), name);
    tokio::task::spawn_blocking(move || download_asset_blocking(&url))
        .await
        .map_err(|e| format!("download task failed: {e}"))?
}

fn download_asset_blocking(url: &str) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("unsupported URL scheme for {url}"));
    }
    let response = ureq::get(url).call().map_err(|e| format!("download failed for {url}: {e}"))?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("download failed for {url}: HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("download failed for {url}: {e}"))?;
    Ok(bytes)
}

pub async fn run_update(args: UpdateArgs) -> Result<(), String> {
    let dest_dir = match args.dest_dir {
        Some(p) => p,
        None => crate::package_db::user_data_sidecar_path("names.db")
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .ok_or_else(|| "could not determine Raven user data directory; set --dest-dir or use RAVEN_NAMES_DB / RAVEN_BASE_EXPORTS".to_string())?,
    };
    let names = download_asset(&args.base_url, "names.db").await?;
    let base = download_asset(&args.base_url, "base-exports.json").await?;
    let installed = install_downloaded_sidecars(&dest_dir, names, base)?;
    eprintln!("Installed names.db to {}", installed.names_db.display());
    eprintln!("Installed base-exports.json to {}", installed.base_exports.display());
    Ok(())
}

pub struct InstalledSidecars {
    pub names_db: PathBuf,
    pub base_exports: PathBuf,
}

pub fn install_downloaded_sidecars(
    dest_dir: &std::path::Path,
    names_bytes: Vec<u8>,
    base_bytes: Vec<u8>,
) -> Result<InstalledSidecars, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| {
        format!(
            "could not create {}: {e}; choose a writable directory with --dest-dir, or set RAVEN_NAMES_DB / RAVEN_BASE_EXPORTS",
            dest_dir.display()
        )
    })?;
    let names_tmp = dest_dir.join("names.db.tmp");
    let base_tmp = dest_dir.join("base-exports.json.tmp");
    let names_final = dest_dir.join("names.db");
    let base_final = dest_dir.join("base-exports.json");

    std::fs::write(&names_tmp, names_bytes).map_err(|e| e.to_string())?;
    std::fs::write(&base_tmp, base_bytes).map_err(|e| e.to_string())?;

    let db = ShippedDb::open(&names_tmp).map_err(|e| format!("downloaded names.db failed verification: {e}"))?;
    read_repo_db_file(&base_tmp).map_err(|e| format!("downloaded base-exports.json failed verification: {e}"))?;

    std::fs::rename(&names_tmp, &names_final).map_err(|e| e.to_string())?;
    std::fs::rename(&base_tmp, &base_final).map_err(|e| e.to_string())?;
    eprintln!(
        "names.db snapshot: source={}, snapshot={}, packages={}",
        db.provenance().source,
        db.provenance().snapshot_date,
        db.provenance().package_count
    );
    Ok(InstalledSidecars { names_db: names_final, base_exports: base_final })
}
```

- [ ] **Step 7: Run parser and install tests**

Run: `cargo test -p raven cli::packages::tests::parse_update_args_defaults_to_names_db_release cli::packages::tests::parse_update_args_accepts_base_url_and_dest_dir cli::packages::tests::atomic_install_rejects_invalid_names_db_and_leaves_existing_file`

Expected: PASS.

---

### Task 5: Targeted `raven check` Metadata Warnings

**Files:**
- Modify: `crates/raven/src/package_library.rs`
- Modify: `crates/raven/src/cli/check.rs`

- [ ] **Step 1: Add query helpers to `PackageLibrary` tests**

Add tests in `crates/raven/src/package_library.rs` that drive the desired API:

```rust
#[tokio::test]
async fn missing_export_metadata_reports_provider_miss() {
    let lib = PackageLibrary::new_empty();
    assert!(lib.export_metadata_missing("ravenmissingpkg").await);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raven package_library::tests::missing_export_metadata_reports_provider_miss`

Expected: FAIL because `export_metadata_missing` does not exist.

- [ ] **Step 3: Implement minimal metadata-miss API**

Add to `impl PackageLibrary`:

```rust
pub async fn export_metadata_missing(&self, package: &str) -> bool {
    if self.package_exists(package) {
        return false;
    }
    self.get_cached_package(package).await.is_none()
        && self.resolve_from_providers(package).is_none()
        && !self.is_base_package(package)
}
```

If `resolve_from_providers` is private and synchronous, keep this method in the same `impl` block so it can call it without changing the provider seam.

- [ ] **Step 4: Add `raven check` warning tests**

In `crates/raven/src/cli/check.rs`, add a unit test for the formatter helper rather than full stderr capture:

```rust
#[test]
fn formats_missing_metadata_warning_for_absent_tier3() {
    let msg = super::format_missing_export_metadata_warning(&["foo".into(), "bar".into()], false);
    assert!(msg.contains("package export metadata is missing for bar, foo") || msg.contains("package export metadata is missing for foo, bar"));
    assert!(msg.contains("Tier 3 names.db is not installed"));
    assert!(msg.contains("raven packages update"));
}

#[test]
fn formats_missing_metadata_warning_for_present_tier3_miss() {
    let msg = super::format_missing_export_metadata_warning(&["foo".into()], true);
    assert!(msg.contains("Raven checked installed packages, .raven/packages.json, and names.db"));
    assert!(msg.contains("raven packages freeze"));
}
```

- [ ] **Step 5: Implement warning formatter and collector**

Add in `check.rs`:

```rust
fn format_missing_export_metadata_warning(packages: &[String], tier3_present: bool) -> String {
    let mut packages = packages.to_vec();
    packages.sort();
    packages.dedup();
    packages.truncate(8);
    let names = packages.join(", ");
    if tier3_present {
        format!(
            "raven check: package export metadata is missing for {names}.\n\
Raven checked installed packages, .raven/packages.json, and names.db, but these packages were not found.\n\n\
`raven packages update` can refresh coverage for base/recommended, CRAN, and Bioconductor packages.\n\
For GitHub-only, internal, or version-exact packages, run `raven packages freeze` locally and commit .raven/packages.json, or install R and the relevant packages in the CI image."
        )
    } else {
        format!(
            "raven check: package export metadata is missing for {names}.\n\
Tier 3 names.db is not installed, so undefined-variable diagnostics from these packages may be false positives.\n\n\
To cover base/recommended, CRAN, and Bioconductor packages, run:\n  raven packages update\n\n\
For GitHub-only, internal, or version-exact packages, run:\n  raven packages freeze\n\
and commit .raven/packages.json, or install R and the relevant packages in the CI image."
        )
    }
}
```

After diagnostics are computed in `run`, collect packages from reported documents' `loaded_packages`, filter with `export_metadata_missing`, and print the formatter once when the package set is non-empty and at least one undefined-variable diagnostic was emitted. Use `crate::package_db::locate_shipped_db_candidates().into_iter().any(|p| p.exists())` as the initial Tier 3 presence signal.

- [ ] **Step 6: Run check warning tests**

Run: `cargo test -p raven cli::check::tests::formats_missing_metadata_warning_for_absent_tier3 cli::check::tests::formats_missing_metadata_warning_for_present_tier3_miss package_library::tests::missing_export_metadata_reports_provider_miss`

Expected: PASS.

---

### Task 6: User-Facing Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/cli.md`
- Modify: `docs/package-database.md`
- Modify: `docs/r-package-dev.md`
- Modify: `docs/development.md`

- [ ] **Step 1: Update install-path language**

Make these doc edits:

```markdown
Release archives, VSIX installs, and package-manager builds ship `names.db` and `base-exports.json` next to the Raven executable. Source installs through `cargo install --git` install only the executable; run `raven packages update` once in the user account or CI image to populate the mutable user-data copy.
```

```markdown
For reproducible CI, commit `.raven/packages.json` generated by `raven packages freeze`. `raven packages update` restores broad CRAN/Bioconductor coverage for zero-adoption scans, but it follows the moving `names-db` Release and is not version-pinned by the project.
```

```sh
cargo install --git https://github.com/jbearak/raven raven
raven packages update
raven check --format sarif > raven.sarif
```

- [ ] **Step 2: Update CLI docs for `packages update`**

Add a subsection in `docs/cli.md`:

```markdown
### `raven packages update`

Downloads Raven's mutable Tier 3 sidecars (`names.db` and `base-exports.json`) from the `names-db` GitHub Release into Raven's user data directory. This is the explicit network boundary for source/Cargo installs; `raven check`, LSP startup, completion, hover, and normal package lookup do not fetch package metadata.
```

- [ ] **Step 3: Review docs for unqualified “bundled DB is always present” claims**

Run: `rg "bundled.*names.db|always.*names.db|shipped.*names.db|base-exports" README.md docs`

Expected: All matches either describe packaged installs or explain source installs need `raven packages update`.

---

### Task 7: Verification

**Files:**
- No edits expected unless verification reveals a failure.

- [ ] **Step 1: Format Rust**

Run: `cargo fmt --all --check`

Expected: PASS. If it fails, run `cargo fmt --all`, inspect the diff, then rerun `cargo fmt --all --check`.

- [ ] **Step 2: Run focused Rust tests**

Run: `cargo test -p raven package_db:: package_library::tests::build_library_ cli::packages::tests:: cli::check::tests::formats_missing_metadata_warning`

Expected: PASS for the focused package DB, package library, packages CLI, and warning formatter tests.

- [ ] **Step 3: Run the full Rust crate tests if focused tests pass**

Run: `cargo test -p raven`

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run: `git diff --stat` and `git diff -- crates/raven/src/package_db/mod.rs crates/raven/src/package_library.rs crates/raven/src/cli/packages.rs crates/raven/src/cli/check.rs docs/cli.md docs/package-database.md docs/r-package-dev.md docs/development.md README.md`

Expected: Diff contains only the Tier 3 source-install delivery changes and docs. Do not commit unless the user explicitly requests it.

---

## Self-Review

- Spec coverage: locator precedence and fallback are covered by Tasks 1-2; embedded base floor by Task 3; explicit update command by Task 4; targeted `raven check` warning by Task 5; documentation by Task 6; verification by Task 7.
- Scope note: Homebrew formula packaging is documented but not implemented here because this repository currently has no formula/tap files in the inspected tree.
- Risk: the downloader step needs a real HTTP client choice during implementation. The plan starts with an injectable installer seam so atomic writes and validation are testable without network.
- Completeness scan: no deferred work markers remain; each task has concrete files, code snippets, commands, and expected results.
