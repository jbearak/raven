# Tier 3 Sidecar Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two Tier 3 sidecars into one — embed base-7 exports in the binary as generated Rust, make `names.db` strictly non-base, delete `base-exports.json` everywhere, add `build-embedded-base` + a shared build script + an LFS `names.db` seed, and turn on the weekly refresh.

**Architecture:** Base-7 exports/datasets move from a hand-maintained const floor + an eager-loaded `base-exports.json` sidecar into a `// @generated` per-package table compiled into the binary. `initialize()` loads it directly (no sidecar, no startup-ordering problem). `build-shipped-db` filters base-7 out of `names.db` post-merge and gains a maintainer `build-embedded-base` subcommand; the single remaining sidecar (`names.db`) is bootstrapped from a Git-LFS seed and refreshed weekly via a shared `scripts/build-names-db.sh`.

**Tech Stack:** Rust (crate `raven`), Node bundle script, GitHub Actions YAML, bash, Git LFS, Markdown docs.

**Spec:** `docs/superpowers/specs/2026-06-01-tier3-sidecar-consolidation-design.md`. **Glossary:** `CONTEXT.md`.

> **Two maintainer-run artifacts are OUT OF SCOPE for an automated agent** (need R + the maintainer's rich library, and `curl` for the seed). The agent builds the commands, the script, and all wiring, plus a *compiling placeholder* `embedded_base_generated.rs`. The maintainer later runs:
> 1. `raven packages build-embedded-base --reference-lib <DIR>` → overwrite & commit `embedded_base_generated.rs`.
> 2. `scripts/build-names-db.sh` (M1) → commit `crates/raven/data/names-db-seed.db` via Git LFS.

---

### Task 1: Generated embedded-base table — struct, data file, `load()`, accessor

Replace the hand-maintained const floor in `embedded_base.rs` with a per-package table. Split the file: hand-written logic + struct in `embedded_base.rs`, the `// @generated` data table `include!`d from `embedded_base_generated.rs`. The agent writes a compiling *placeholder* data file (existing flat floor reshaped: all current exports under `base`, all current datasets under `datasets`, the other five base packages empty) so the build and tests pass before the maintainer regenerates it.

**Files:**
- Modify: `crates/raven/src/package_db/embedded_base.rs` (full rewrite)
- Create: `crates/raven/src/package_db/embedded_base_generated.rs` (placeholder, `// @generated`)

- [ ] **Step 1: Write the failing tests** in `embedded_base.rs` (replace the existing `tests` module)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_set_equals_fallback_base_packages() {
        let canonical: HashSet<String> = crate::r_subprocess::get_fallback_base_packages()
            .into_iter()
            .collect();
        let derived: HashSet<String> = packages().iter().map(|p| p.name.to_string()).collect();
        assert_eq!(derived, canonical);
    }

    #[test]
    fn load_unions_exports_and_datasets_into_flat_set() {
        let (exports, pkgs) = load();
        assert!(exports.contains("print"), "namespace export in flat set");
        assert!(exports.contains("mtcars"), "dataset folded into flat set");
        assert!(pkgs.contains("base") && pkgs.contains("datasets"));
    }

    #[test]
    fn datasets_are_kept_distinct_from_exports() {
        let datasets = packages().iter().find(|p| p.name == "datasets").unwrap();
        assert!(datasets.datasets.contains(&"mtcars"));
        assert!(!datasets.exports.contains(&"mtcars"));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven embedded_base`
Expected: FAIL — `packages` not found / new shape absent.

- [ ] **Step 3: Rewrite `embedded_base.rs`** to the new shape

```rust
//! Built-in base-7 export/dataset floor, used when installed base packages are
//! absent (CI without R). A `// @generated` per-package table embedded in the
//! binary (see ADR 1 in the consolidation spec) — regenerate with
//! `raven packages build-embedded-base`. The package set MUST equal
//! `r_subprocess::get_fallback_base_packages()`.

use std::collections::HashSet;

/// One base package's compile-time export floor. `datasets` map to
/// `PackageInfo.lazy_data`; export *kind* is deliberately not tracked.
pub struct EmbeddedBasePackage {
    pub name: &'static str,
    pub exports: &'static [&'static str],
    pub datasets: &'static [&'static str],
    pub depends: &'static [&'static str],
}

// Defines `static EMBEDDED_BASE_PACKAGES: &[EmbeddedBasePackage]`.
include!("embedded_base_generated.rs");

/// The per-package embedded records (for `initialize()` cache population).
pub fn packages() -> &'static [EmbeddedBasePackage] {
    EMBEDDED_BASE_PACKAGES
}

/// Flat always-in-scope set (exports ∪ datasets) + the base package-name set.
/// Return shape is unchanged from the prior floor so callers are unaffected.
pub fn load() -> (HashSet<String>, HashSet<String>) {
    let mut exports = HashSet::new();
    let mut pkgs = HashSet::new();
    for p in EMBEDDED_BASE_PACKAGES {
        pkgs.insert(p.name.to_string());
        exports.extend(p.exports.iter().map(|s| s.to_string()));
        exports.extend(p.datasets.iter().map(|s| s.to_string()));
    }
    (exports, pkgs)
}
```

- [ ] **Step 4: Write the placeholder generated data file** `embedded_base_generated.rs`

Header + table. `base` carries the current `BASE_EXPORTS` list, `datasets` carries the current `BASE_DATASETS` list, the other five are empty. (Copy the exact string lists from the pre-rewrite `embedded_base.rs`.) Each literal is fine as a plain `"..."`; the maintainer's regen will emit via `{:?}`.

```rust
// @generated by `raven packages build-embedded-base` — DO NOT EDIT BY HAND.
// PLACEHOLDER: reshaped from the prior flat floor; attribution to individual
// base packages is approximate until a maintainer regenerates from a reference R.
// Reference R version: (placeholder)
static EMBEDDED_BASE_PACKAGES: &[EmbeddedBasePackage] = &[
    EmbeddedBasePackage {
        name: "base",
        exports: &["::", ":::", "[", /* …all prior BASE_EXPORTS… */ "title"],
        datasets: &[],
        depends: &[],
    },
    EmbeddedBasePackage { name: "methods", exports: &[], datasets: &[], depends: &[] },
    EmbeddedBasePackage { name: "utils", exports: &[], datasets: &[], depends: &[] },
    EmbeddedBasePackage { name: "grDevices", exports: &[], datasets: &[], depends: &[] },
    EmbeddedBasePackage { name: "graphics", exports: &[], datasets: &[], depends: &[] },
    EmbeddedBasePackage { name: "stats", exports: &[], datasets: &[], depends: &[] },
    EmbeddedBasePackage {
        name: "datasets",
        exports: &[],
        datasets: &["AirPassengers", /* …all prior BASE_DATASETS… */ "women"],
        depends: &[],
    },
];
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p raven embedded_base`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/package_db/embedded_base.rs crates/raven/src/package_db/embedded_base_generated.rs
git commit -m "feat(package_db): embedded base-7 as a generated per-package table"
```

---

### Task 2: `initialize()` falls back to embedded per-package records

Collapse the CI/runtime base fallback: a non-empty on-disk base merge still wins; otherwise load from `EMBEDDED_BASE_PACKAGES` into **both** the flat `base_exports` set **and** the per-package cache (datasets → `lazy_data`). Remove the `base-exports.json` sidecar branch entirely.

**Files:**
- Modify: `crates/raven/src/package_library.rs` — the base-fallback block inside `initialize()` (currently ~lines 1196–1216, the `if all_base_exports.is_empty()` sidecar loop + the embedded fallback).
- Test: same file's `tests` module.

- [ ] **Step 1: Write the failing test** (add to `package_library.rs` tests)

```rust
#[tokio::test]
async fn initialize_without_disk_base_loads_embedded_records_into_cache() {
    // No lib paths → no disk base → embedded fallback.
    let mut lib = PackageLibrary::with_subprocess(None);
    lib.set_lib_paths(vec![std::path::PathBuf::from("/nonexistent-xyz")]);
    lib.initialize().await.unwrap();

    // Flat always-in-scope set includes a base export and a base dataset.
    assert!(lib.base_exports().contains("print"));
    assert!(lib.base_exports().contains("mtcars"));
    // Per-package cache populated from the embedded table, datasets in lazy_data.
    let datasets = lib.get_cached_package("datasets").await.expect("datasets cached");
    assert!(datasets.lazy_data.contains(&"mtcars".to_string()));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven initialize_without_disk_base_loads_embedded_records_into_cache`
Expected: FAIL — `datasets` not cached (embedded path doesn't populate the cache yet).

- [ ] **Step 3: Replace the fallback block** with the embedded-only path

Delete the `for path in crate::package_db::locate_base_exports_candidates()` loop and the separate trailing embedded block, replacing both with:

```rust
        // CI/runtime fallback: with no base exports found on disk, load the
        // embedded base-7 table into both the flat always-in-scope set and the
        // per-package cache (datasets → lazy_data). A non-empty disk merge (a
        // real install) always wins and skips this entirely. No sidecar, so
        // initialize() never depends on names.db and the startup ordering
        // problem is gone (ADR 1).
        if all_base_exports.is_empty() {
            for p in crate::package_db::embedded_base::packages() {
                self.base_packages.insert(p.name.to_string());
                let exports: HashSet<String> = p
                    .exports
                    .iter()
                    .chain(p.datasets.iter())
                    .map(|s| s.to_string())
                    .collect();
                all_base_exports.extend(exports.iter().cloned());
                let info = PackageInfo::with_details(
                    p.name.to_string(),
                    p.exports.iter().map(|s| s.to_string()).collect(),
                    p.depends.iter().map(|s| s.to_string()).collect(),
                    p.datasets.iter().map(|s| s.to_string()).collect(),
                );
                self.insert_package(info).await;
            }
        }
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p raven initialize_without_disk_base_loads_embedded_records_into_cache`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "feat(package_library): load embedded base-7 into flat set + cache, drop sidecar branch"
```

---

### Task 3: `build-shipped-db` excludes base-7 post-merge; drop base-exports emission

Filter `get_fallback_base_packages()` out of the merged record set before `write_shipped_db` (no `FORMAT_VERSION` bump). Remove `--base-exports-output`, the `base_exports_output` field, and the `write_base_exports_file` call.

**Files:**
- Modify: `crates/raven/src/cli/packages.rs` — `BuildShippedDbArgs`, `parse_build_shipped_db_args`, `run_build_shipped_db`, `print_help`, and the `parse_build_shipped_db_args` test.

- [ ] **Step 1: Write the failing test** (add to `packages.rs` tests)

```rust
#[tokio::test]
async fn build_shipped_db_excludes_base_seven() {
    use crate::package_db::binary_db::ShippedDb;
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("names.db");
    // Seed a DB containing a base package + a non-base package.
    let seed = dir.path().join("seed.db");
    let recs = vec![
        PackageRecord { name: "base".into(), version: "4.4.0".into(),
            exports: vec!["c".into()], depends: vec![], lazy_data: vec![] },
        PackageRecord { name: "dplyr".into(), version: "1.1.4".into(),
            exports: vec!["mutate".into()], depends: vec![], lazy_data: vec![] },
    ];
    let prov = ShippedDbProvenance { source: "t".into(), snapshot_date: "2026-06-01".into(),
        package_count: 2, raven_version: "9.9.9".into() };
    write_shipped_db(&seed, &recs, prov).unwrap();

    super::run_build_shipped_db(super::BuildShippedDbArgs {
        reference_lib: None, runiverse_cran: None, runiverse_bioc: None,
        fresh: false, seed: Some(seed), output: out.clone(),
        snapshot_date: "2026-06-01".into(), source: "t".into(),
    }).await.unwrap();

    let db = ShippedDb::open(&out).unwrap();
    let names: Vec<String> = db.all_records().into_iter().map(|r| r.name).collect();
    assert!(names.contains(&"dplyr".to_string()));
    assert!(!names.contains(&"base".to_string()), "base-7 must be excluded");
}
```

(Also delete the obsolete `parse_build_shipped_db_args` assertions about `--base-exports-output` / `base_exports_output`, and the `--base-exports-output` arg from that test's input.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven build_shipped_db_excludes_base_seven`
Expected: FAIL — `base` still present (and a compile error in the test until the struct field is dropped).

- [ ] **Step 3: Edit `packages.rs`**

In `BuildShippedDbArgs`, delete `pub base_exports_output: Option<PathBuf>,`. In `parse_build_shipped_db_args`, delete the `let mut base_exports_output = None;` line, the `"--base-exports-output" => { … }` match arm, and the field from the returned struct. In `run_build_shipped_db`, after `let merged = merge_append_only(...)`, filter base-7 and drop the base-exports emission:

```rust
    let base: std::collections::HashSet<String> =
        crate::r_subprocess::get_fallback_base_packages().into_iter().collect();
    let merged: Vec<PackageRecord> =
        merged.into_iter().filter(|r| !base.contains(&r.name)).collect();
```

Delete the `if let Some(base_out) = &args.base_exports_output { … write_base_exports_file … }` block. In `print_help`, drop `[--base-exports-output base-exports.json]` from the `build-shipped-db` usage line.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p raven build_shipped_db_excludes_base_seven`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cli/packages.rs
git commit -m "feat(build-shipped-db): exclude base-7 post-merge; drop base-exports emission"
```

---

### Task 4: Add the `build-embedded-base` maintainer subcommand

Capture the base-7 from a reference R and emit the generated data file. Reuses `get_package` on a **fresh, non-initialized** `PackageLibrary` (so datasets stay in `lazy_data` rather than being lumped into exports the way `initialize()` does). Each literal is emitted via `{:?}` (Debug) so operator/exotic names (`%in%`, `[.data.frame`, `if`) escape correctly. Agent cannot run this end-to-end (needs R); test only the pure emitter.

**Files:**
- Modify: `crates/raven/src/cli/packages.rs` — add `BuildEmbeddedBaseArgs`, `parse_build_embedded_base_args`, `run_build_embedded_base`, an `emit_embedded_base_source` helper, the `run()` dispatch arm, and `print_help`.

- [ ] **Step 1: Write the failing test** (emitter only — deterministic, R-free)

```rust
#[test]
fn emit_embedded_base_source_escapes_and_separates() {
    let pkgs = vec![
        ("base".to_string(), vec!["c".to_string(), "%in%".to_string()],
         Vec::<String>::new(), Vec::<String>::new()),
        ("datasets".to_string(), Vec::<String>::new(),
         vec!["mtcars".to_string()], Vec::<String>::new()),
    ];
    let src = super::emit_embedded_base_source(&pkgs, "R 4.4.0");
    assert!(src.contains("// @generated"));
    assert!(src.contains("Reference R version: R 4.4.0"));
    assert!(src.contains(r#""%in%""#), "operator export emitted as a string literal");
    assert!(src.contains(r#"name: "datasets""#));
    assert!(src.contains(r#"datasets: &["mtcars"]"#));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven emit_embedded_base_source_escapes_and_separates`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement** in `packages.rs`

```rust
pub struct BuildEmbeddedBaseArgs {
    pub reference_lib: PathBuf,
    pub output: PathBuf,
}

pub fn parse_build_embedded_base_args(
    mut argv: impl Iterator<Item = String>,
) -> Result<BuildEmbeddedBaseArgs, String> {
    let mut reference_lib = None;
    let mut output = PathBuf::from("crates/raven/src/package_db/embedded_base_generated.rs");
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--reference-lib" => {
                reference_lib =
                    Some(PathBuf::from(argv.next().ok_or("--reference-lib needs a path")?))
            }
            "--output" => output = PathBuf::from(argv.next().ok_or("--output needs a path")?),
            "--help" => return Err("HELP".into()),
            s => return Err(format!("unknown flag: {s}")),
        }
    }
    Ok(BuildEmbeddedBaseArgs {
        reference_lib: reference_lib.ok_or("--reference-lib is required")?,
        output,
    })
}

/// Emit the `// @generated` `embedded_base_generated.rs` source from captured
/// per-package `(name, exports, datasets, depends)` buckets. Each name is
/// rendered with `{:?}` so exotic/operator identifiers escape correctly.
fn emit_embedded_base_source(
    pkgs: &[(String, Vec<String>, Vec<String>, Vec<String>)],
    r_version: &str,
) -> String {
    fn arr(items: &[String]) -> String {
        let parts: Vec<String> = items.iter().map(|s| format!("{s:?}")).collect();
        format!("&[{}]", parts.join(", "))
    }
    let mut out = String::from(
        "// @generated by `raven packages build-embedded-base` — DO NOT EDIT BY HAND.\n",
    );
    out.push_str(&format!("// Reference R version: {r_version}\n"));
    out.push_str("static EMBEDDED_BASE_PACKAGES: &[EmbeddedBasePackage] = &[\n");
    for (name, exports, datasets, depends) in pkgs {
        out.push_str(&format!(
            "    EmbeddedBasePackage {{ name: {name:?}, exports: {}, datasets: {}, depends: {} }},\n",
            arr(exports), arr(datasets), arr(depends),
        ));
    }
    out.push_str("];\n");
    out
}

pub async fn run_build_embedded_base(args: BuildEmbeddedBaseArgs) -> Result<(), String> {
    use crate::package_library::PackageLibrary;
    let r = crate::r_subprocess::RSubprocess::new(None);
    let r_version = match &r {
        Some(sub) => sub
            .execute_r_code("cat(as.character(getRversion()))")
            .await
            .unwrap_or_else(|_| "unknown".to_string()),
        None => "unknown".to_string(),
    };
    // Fresh library (NOT initialize()d): get_package keeps datasets in lazy_data.
    let mut lib = PackageLibrary::with_subprocess(r);
    lib.set_lib_paths(vec![args.reference_lib.clone()]);
    let mut pkgs = Vec::new();
    for name in crate::r_subprocess::get_fallback_base_packages() {
        let info = lib.get_package(&name).await.ok_or_else(|| {
            format!("base package {name} not found under {}", args.reference_lib.display())
        })?;
        let mut exports: Vec<String> = info.exports.iter().cloned().collect();
        let mut datasets = info.lazy_data.clone();
        let mut depends = info.depends.clone();
        exports.sort();
        datasets.sort();
        depends.sort();
        pkgs.push((name, exports, datasets, depends));
    }
    let src = emit_embedded_base_source(&pkgs, &r_version);
    std::fs::write(&args.output, src).map_err(|e| e.to_string())?;
    eprintln!("Wrote embedded base table to {}", args.output.display());
    Ok(())
}
```

Add the dispatch arm in `run()`:

```rust
        Some("build-embedded-base") => {
            let args = parse_build_embedded_base_args(argv)?;
            run_build_embedded_base(args).await
        }
```

Update the `None =>` usage string to include `build-embedded-base`, and add a `build-embedded-base` line to `print_help`:

```
         raven packages build-embedded-base --reference-lib DIR [--output PATH]\n
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p raven emit_embedded_base_source_escapes_and_separates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cli/packages.rs
git commit -m "feat(packages): add build-embedded-base maintainer subcommand"
```

---

### Task 5: Single-file `update`/install; remove `base_exports.rs`, `RAVEN_BASE_EXPORTS`, locator

Collapse the two-file sidecar install to `names.db` only. Delete the `base_exports.rs` module, `write_base_exports_file`, `locate_base_exports_candidates`, the `RAVEN_BASE_EXPORTS` override, `InstalledSidecars.base_exports_path`, and all their tests/mentions.

**Files:**
- Modify: `crates/raven/src/cli/packages.rs` — `InstalledSidecars`, `run_update`, `install_downloaded_sidecars`, `replace_verified_sidecars`/`replace_with_tmp` usage, `manual_sidecar_guidance`, `sidecar_write_error`, `parse_update_args` error text, and affected tests.
- Modify: `crates/raven/src/package_db/mod.rs` — drop `pub mod base_exports;`, `locate_base_exports_candidates`, `write_base_exports_file`, the `RAVEN_BASE_EXPORTS` mentions in the env-lock doc comment, and the two obsolete tests (`base_exports_candidates_use_same_precedence`, `write_base_exports_filters_to_base_packages`).
- Delete: `crates/raven/src/package_db/base_exports.rs`.

- [ ] **Step 1: Update the install test** (replace the two-file tests with a single-file round-trip)

Replace `atomic_install_accepts_valid_sidecars`, `atomic_install_rejects_invalid_base_exports_and_suggests_manual_sidecars`, `install_verified_sidecars_rolls_back_when_second_replace_fails`, and `atomic_install_ignores_preexisting_fixed_temp_names` with a single-file equivalent, and drop the `base_bytes` arg from `atomic_install_rejects_invalid_names_db_and_leaves_existing_file`:

```rust
#[test]
fn atomic_install_round_trips_single_names_db() {
    use crate::package_db::binary_db::{write_shipped_db, ShippedDb, ShippedDbProvenance};
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let recs = vec![PackageRecord { name: "dplyr".into(), version: "1.1.4".into(),
        exports: vec!["mutate".into()], depends: vec![], lazy_data: vec![] }];
    let prov = ShippedDbProvenance { source: "t".into(), snapshot_date: "2026-06-01".into(),
        package_count: 1, raven_version: "9.9.9".into() };
    let names_src = source.path().join("names.db");
    write_shipped_db(&names_src, &recs, prov).unwrap();

    let installed = super::install_downloaded_sidecars(
        dest.path(), std::fs::read(&names_src).unwrap()).unwrap();
    assert_eq!(installed.names_db_path, dest.path().join("names.db"));
    ShippedDb::open(&installed.names_db_path).unwrap();
}
```

Also drop the `RAVEN_BASE_EXPORTS` assertions from the remaining error-message tests (`download_asset_blocking_rejects_*`, `curl_failure_errors_*`, `atomic_install_rejects_invalid_names_db_*`).

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p raven -- install`
Expected: FAIL/compile error (signature still two-arg).

- [ ] **Step 3: Edit `packages.rs`**

- `InstalledSidecars`: delete `pub base_exports_path: PathBuf,`.
- `run_update`: delete `let base_bytes = download_asset(&args.base_url, "base-exports.json").await?;` and the `base_exports.json` install/print lines; call `install_downloaded_sidecars(&dest_dir, names_bytes)`. Drop `RAVEN_BASE_EXPORTS` from the `--dest-dir` fallback error.
- `install_downloaded_sidecars`: change signature to `(dest_dir: &Path, names_bytes: Vec<u8>)`; write/validate/replace only `names.db` (replace the two-file `replace_verified_sidecars` dance with a single `write_unique_temp` + validate `ShippedDb::open` + `replace_with_tmp`, backing up/restoring the one existing file). Return `InstalledSidecars { names_db_path, names_db_provenance }`.
- `manual_sidecar_guidance`: `"Alternatively, set RAVEN_NAMES_DB to a manually installed names.db"`.
- `sidecar_write_error`, `write_unique_temp` error, `parse_update_args` `--base-url`/help text: drop `RAVEN_BASE_EXPORTS`, keep `RAVEN_NAMES_DB`.
- Delete now-unused helpers if the single-file path makes them dead: `replace_verified_sidecars`, `backup_existing_final`/`restore_backup`/`remove_backup` may be reused for the one file — keep what the single-file path needs, delete the rest. Update `print_help` `update` line text if it names base-exports.

- [ ] **Step 4: Edit `package_db/mod.rs`** — delete `pub mod base_exports;`, the `locate_base_exports_candidates` fn, the `write_base_exports_file` fn, fix the env-lock doc comment to mention only `RAVEN_NAMES_DB`, and delete the two obsolete tests.

- [ ] **Step 5: Delete the module file**

```bash
git rm crates/raven/src/package_db/base_exports.rs
```

- [ ] **Step 6: Run to verify pass**

Run: `cargo test -p raven`
Expected: PASS (whole crate compiles; install round-trip green).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(packages): single-file names.db install; remove base-exports sidecar"
```

---

### Task 6: Delivery & packaging — one sidecar, shared script, LFS seed, weekly schedule

No Rust here; config/workflow/script edits. No new test code — verified by `cargo build` (Task 8) and review.

**Files:**
- Modify: `editors/vscode/scripts/bundle-binary.js`
- Modify: `editors/vscode/.vscodeignore`
- Modify: `crates/raven/src/main.rs` (help text)
- Modify: `.github/workflows/release-build.yml`
- Modify: `.github/workflows/build-names-db.yml`
- Create: `scripts/build-names-db.sh`
- Create: `.gitattributes`

- [ ] **Step 1: `bundle-binary.js`** — bundle only `names.db`

Change the sidecar loop to a single file and update the comment:

```js
// Bundle the Tier 3 package-export database (names.db) next to the binary, if
// present. In dev builds it is usually absent (Tier 3 unavailable, which is
// fine — the extension degrades to Tier 1/2; base-7 is embedded in the binary).
const distDir = path.join(__dirname, '..', '..', '..', 'dist');
const sidecar = 'names.db';
const src = process.env.RAVEN_NAMES_DB_SRC || path.join(distDir, sidecar);
const dest = path.join(binDir, sidecar);
if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Bundled ${sidecar} from ${src}`);
} else {
    console.log(`${sidecar} not found at ${src}; Tier 3 will be unavailable in this build`);
}
```

- [ ] **Step 2: `.vscodeignore`** — drop the base-exports mention in the trailing comment

```
# bin/ is intentionally NOT excluded so the raven binary and the Tier 3 sidecar
# (bin/names.db) are included in the VSIX.
```

- [ ] **Step 3: `main.rs` help** — line 49: `update   Download the names.db sidecar` (drop "and base-exports.json").

- [ ] **Step 4: `release-build.yml`** — both `Download package DB from the names-db Release` steps: drop `--pattern 'base-exports.json'`, keep `--pattern 'names.db'`. Fix the fallback echo text to not promise base-exports.

- [ ] **Step 5: Create `scripts/build-names-db.sh`** (shared fetch + build; binary stays network-free)

```bash
#!/usr/bin/env bash
# Fetch CRAN + Bioc r-universe JSON, then build names.db via the (network-free)
# raven binary. Used by both the weekly workflow and local seed generation.
# Usage: build-names-db.sh --raven PATH --output PATH [--seed PATH] [--reference-lib DIR] [--work DIR]
set -euo pipefail

RAVEN="" OUT="" SEED="" REF_LIB="" WORK="$(mktemp -d)"
while [ $# -gt 0 ]; do
  case "$1" in
    --raven) RAVEN="$2"; shift 2;;
    --output) OUT="$2"; shift 2;;
    --seed) SEED="$2"; shift 2;;
    --reference-lib) REF_LIB="$2"; shift 2;;
    --work) WORK="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$RAVEN" ] && [ -n "$OUT" ] || { echo "--raven and --output are required" >&2; exit 2; }

for host in cran.r-universe.dev bioc.r-universe.dev; do
  dest="$WORK/runiverse/${host%%.*}"; mkdir -p "$dest"
  curl -sf "https://${host}/api/ls" -o "$WORK/pkglist-${host}.json"
  jq -r '.[]' "$WORK/pkglist-${host}.json" | while read -r pkg; do
    curl -sf "https://${host}/api/packages/${pkg}" -o "${dest}/${pkg}.json" || echo "skip ${host}/${pkg}"
  done
done

args=( packages build-shipped-db
  --runiverse-cran "$WORK/runiverse/cran"
  --runiverse-bioc "$WORK/runiverse/bioc"
  --output "$OUT"
  --snapshot-date "$(date -u +%Y-%m-%d)"
  --source "r-universe+reference" )
[ -n "$SEED" ] && args+=( --seed "$SEED" )
[ -n "$REF_LIB" ] && args+=( --reference-lib "$REF_LIB" )
"$RAVEN" "${args[@]}"
```

Make it executable: `chmod +x scripts/build-names-db.sh` (and `git update-index --chmod=+x` on commit).

- [ ] **Step 6: Create `.gitattributes`** — scoped to the exact seed path (NOT `*.db`)

```
crates/raven/data/names-db-seed.db filter=lfs diff=lfs merge=lfs -text
```

- [ ] **Step 7: `build-names-db.yml`** — enable the weekly schedule, call the shared script, prefer-Release-else-LFS seed, drop base-exports

Replace the `on:` block:

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1"   # Mondays 06:00 UTC
```

Keep `actions/checkout` default (no `lfs: true`). Add `jq` is preinstalled on `ubuntu-latest`; `git-lfs` is too. Replace the "Seed", "Fetch", and "Build" steps with a prefer-Release-else-LFS seed step + a single script call:

```yaml
      - name: Resolve seed (prefer Release, fall back to committed LFS seed)
        run: |
          mkdir -p seed
          if gh release download names-db --repo "$GITHUB_REPOSITORY" \
               --pattern 'names.db' --dir seed; then
            echo "SEED=seed/names.db" >> "$GITHUB_ENV"
          elif git lfs pull --include=crates/raven/data/names-db-seed.db; then
            echo "SEED=crates/raven/data/names-db-seed.db" >> "$GITHUB_ENV"
          else
            echo "no prior Release and no committed seed; building fresh"
          fi
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Build names.db (reference-R seed ∪ CRAN+Bioc, append-only)
        run: |
          mkdir -p dist
          REF_LIB="$(Rscript -e 'cat(.Library)')"
          scripts/build-names-db.sh \
            --raven ./target/release/raven \
            --output dist/names.db \
            --reference-lib "$REF_LIB" \
            ${SEED:+--seed "$SEED"}
```

Update the checksums step to `sha256sum names.db > checksums.sha256` and the upload step to `gh release upload names-db dist/names.db dist/checksums.sha256 --clobber` (drop `base-exports.json`).

- [ ] **Step 8: Commit**

```bash
git add editors/vscode/scripts/bundle-binary.js editors/vscode/.vscodeignore \
  crates/raven/src/main.rs .github/workflows/release-build.yml \
  .github/workflows/build-names-db.yml scripts/build-names-db.sh .gitattributes
git commit -m "build: one-sidecar delivery, shared names.db script, LFS seed, weekly schedule"
```

---

### Task 7: Documentation

Drop `base-exports.json` everywhere; describe embedded base + one sidecar + the LFS seed + `build-embedded-base`.

**Files:** `docs/package-database.md`, `README.md`, `docs/development.md`, `docs/cli.md`.

- [ ] **Step 1: `docs/package-database.md`**
  - Tier 3 table row / §"Tier 3 — sidecar `names.db`": "ship `names.db` and `base-exports.json`" → "ship `names.db`". Note base coverage is **embedded in the binary**; the floor is one sidecar. `names.db` is strictly non-base.
  - §"Base packages and datasets": base/recommended fallback is the **embedded binary table** (base-7), not a sidecar; recommended packages stay in `names.db` (do **not** claim recommended are embedded). Base datasets resolve via the embedded `datasets` records.
  - §"See also": `build-shipped-db` and the new `build-embedded-base`.

- [ ] **Step 2: `README.md`** — the two Installation passages naming "`names.db` and `base-exports.json`" → just `names.db`. Source installs: base-7 is embedded; `raven packages update` adds the `names.db` sidecar for broad coverage.

- [ ] **Step 3: `docs/development.md`** — Tier 3 pipeline section:
  - Replace "Companion base-exports file (decision #7)" bullet with "Embedded base-7 (ADR 1)": generated `embedded_base.rs` / `embedded_base_generated.rs`, regen via `raven packages build-embedded-base`, loaded by `initialize()` into the flat set + cache; `names.db` excludes base-7 post-merge.
  - Delivery bullet: one sidecar (`names.db` + checksums) on the Release; add the `git lfs` seed note (`crates/raven/data/names-db-seed.db`, bootstrap/disaster-recovery only, not a build input) and the shared `scripts/build-names-db.sh`; weekly schedule `0 6 * * 1`.

- [ ] **Step 4: `docs/cli.md`**
  - `raven packages update`: downloads only `names.db`.
  - `build-shipped-db`: drop "(and its companion base-exports file)"; note base-7 is excluded from `names.db`.
  - Add a short `raven packages build-embedded-base` entry (maintainer-only; regenerates the embedded base-7 table from a reference R). Add it to the `packages <subcommand>` list if present.
  - Line ~114 and any other "`names.db` and `base-exports.json`" → "`names.db`"; clarify base-7 is embedded.

- [ ] **Step 5: Commit**

```bash
git add docs/package-database.md README.md docs/development.md docs/cli.md
git commit -m "docs: embedded base-7 + one names.db sidecar; drop base-exports.json"
```

---

### Task 8: Verify, format, drift check, cleanup

- [ ] **Step 1: Build** — `cargo build -p raven` → no errors.
- [ ] **Step 2: Test** — `cargo test -p raven` → all green. Grep for stragglers: `grep -rn "base-exports\|base_exports_path\|RAVEN_BASE_EXPORTS\|write_base_exports_file\|locate_base_exports\|base_exports_output" crates/ editors/ .github/ docs/ README.md` should return only the in-memory `base_exports` set usages (the `Arc<HashSet>` in `package_library.rs`/`handlers.rs`/`scope.rs`/etc.) — never the file/sidecar plumbing.
- [ ] **Step 3: Format** — `cargo fmt` (or the repo's `code format` flow). If a Bun/TS settings-reference drift test exists and any `package.json` settings changed (they did not here), regenerate; otherwise skip.
- [ ] **Step 4: Cleanup** — remove any temp files created during verification.
- [ ] **Step 5: Commit** any formatting-only changes: `git commit -am "style: cargo fmt"`.

---

### Maintainer-run follow-ups (NOT executable by an automated agent)

These need R + the maintainer's rich library (and `curl`/`git lfs` locally). The implementation above provides the commands, script, and wiring; the maintainer runs and commits the two artifacts. Partition is exact: **base-7 → embedded `.rs`; all other installed packages → `names.db` seed**, split at `get_fallback_base_packages()`.

1. `raven packages build-embedded-base --reference-lib <DIR>` → overwrite `crates/raven/src/package_db/embedded_base_generated.rs`; `cargo test -p raven embedded_base`; commit.
2. `git lfs install` (once); `scripts/build-names-db.sh --raven ./target/release/raven --output crates/raven/data/names-db-seed.db --reference-lib <full-lib>` (M1: installed ∪ CRAN/Bioc, base-7 dropped by the post-merge filter); commit the LFS pointer.

**Open/minor items (from the handoff):** weekly cron `0 6 * * 1` not formally ratified; multi-`.libPaths()` capture for the comprehensive local seed uses a single `--reference-lib` (additive Release pushes cover the rest per the spec's enrichment model); the ~20k-call weekly r-universe fetch is a pre-existing flakiness concern now recurring on schedule.
