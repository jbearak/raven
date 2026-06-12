# Lazy-Data Enumeration Implementation Plan (issue #429)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enumerate lazy-loaded package datasets (`Rdata.rdb`) and multi-object `data()` aliases via the R subprocess so `library(survival); lung` and `data(api, package="survey"); apiclus1` stop flagging, while `library(cli); emojis` keeps flagging.

**Architecture:** Batched R subprocess query (`data(package=)$results[,"Item"]`) populates two things in the existing `ArcSwap<PackageCache>`: `PackageInfo.lazy_data` (enumerated names, LazyData packages only — `Rdata.rdb` presence is the marker) and a new `PackageInfo.data_aliases` map (file stem → object names, all packages with `data/`). Bucket 1 flows through existing `collect_exports_recursive` folding with zero consumption changes. Bucket 3 adds a `ScopeEvent::DataLoad` timeline variant expanded at query time via a provider callback, mirroring how `PackageLoad` events inject exports. Spec: `docs/superpowers/specs/2026-06-11-lazy-data-enumeration-design.md`.

**Tech Stack:** Rust (toolchain `1.96.0` per `rust-toolchain.toml`), tokio, tree-sitter-r, R subprocess.

**Gates for every task:** `cargo fmt --all` before commit; `cargo clippy --workspace --all-targets --features test-support -- -D warnings` zero warnings; relevant `cargo test -p raven` subset green.

**Required reading before any task:** the module doc at the top of `crates/raven/src/r_subprocess.rs` (safety invariants), the `lazy_data` field doc at `crates/raven/src/package_library.rs:119-132`, and CLAUDE.md "Key invariants".

---

### Task 1: `DataObject` type + dataset-item parser (pure functions)

**Files:**
- Modify: `crates/raven/src/r_subprocess.rs` (new types + parser next to `parse_multi_exports_output`, around line 612)
- Tests: same file, `#[cfg(test)] mod tests` at the bottom

`data(package = "pkg")$results[, "Item"]` lines come in two shapes: `lung` (plain) and `apiclus1 (api)` (object documented under a shared topic/file stem). The CLI already strips aliases (`capture_base_datasets`, `crates/raven/src/cli/packages.rs:1391` — read its doc comment); here we must keep both halves.

- [ ] **Step 1: Write failing unit tests**

Add to the existing test module in `r_subprocess.rs`:

```rust
#[test]
fn test_parse_data_item_plain() {
    assert_eq!(
        parse_data_item("lung"),
        Some(DataObject { name: "lung".to_string(), file_stem: "lung".to_string() })
    );
}

#[test]
fn test_parse_data_item_aliased() {
    assert_eq!(
        parse_data_item("apiclus1 (api)"),
        Some(DataObject { name: "apiclus1".to_string(), file_stem: "api".to_string() })
    );
}

#[test]
fn test_parse_data_item_empty_and_whitespace() {
    assert_eq!(parse_data_item(""), None);
    assert_eq!(parse_data_item("   "), None);
}

#[test]
fn test_parse_multi_datasets_output_two_packages() {
    let output = "\
__RAVEN_MULTI_DATASETS__
__PKG:survival__
lung
ovarian
__PKG:survey__
apiclus1 (api)
apistrat (api)
__RAVEN_END__
";
    let result = parse_multi_datasets_output(output).unwrap();
    assert_eq!(result["survival"].len(), 2);
    assert_eq!(result["survival"][0].name, "lung");
    assert_eq!(result["survey"][0], DataObject { name: "apiclus1".into(), file_stem: "api".into() });
    assert_eq!(result["survey"][1].file_stem, "api");
}

#[test]
fn test_parse_multi_datasets_output_empty_package() {
    let output = "__RAVEN_MULTI_DATASETS__\n__PKG:cli__\n__RAVEN_END__\n";
    let result = parse_multi_datasets_output(output).unwrap();
    assert!(result["cli"].is_empty());
}

#[test]
fn test_parse_multi_datasets_output_missing_marker() {
    assert!(parse_multi_datasets_output("no marker here").is_err());
}
```

- [ ] **Step 2: Run tests, verify they fail to compile (types don't exist)**

Run: `cargo test -p raven parse_data_item parse_multi_datasets 2>&1 | tail -20`
Expected: compile error — `DataObject` / `parse_data_item` / `parse_multi_datasets_output` not found.

- [ ] **Step 3: Implement**

```rust
/// One dataset object enumerated by `data(package = ...)`.
///
/// R's `Item` column is `name` for a dataset whose object name matches its
/// data-file stem, or `name (stem)` when a multi-object data file binds
/// differently-named objects (e.g. survey's `data/api.rda` → `apiclus1 (api)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataObject {
    /// The R object name bound by `data()` / lazy-loading (e.g. `apiclus1`).
    pub name: String,
    /// The data-file stem the object loads from (e.g. `api`); equals `name`
    /// when the Item carried no parenthesized topic.
    pub file_stem: String,
}

/// Parse one `Item` line from `data(package=)$results` into a [`DataObject`].
fn parse_data_item(line: &str) -> Option<DataObject> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if let Some((name, rest)) = line.split_once(" (")
        && let Some(stem) = rest.strip_suffix(')')
    {
        let (name, stem) = (name.trim(), stem.trim());
        if !name.is_empty() && !stem.is_empty() {
            return Some(DataObject { name: name.to_string(), file_stem: stem.to_string() });
        }
    }
    Some(DataObject { name: line.to_string(), file_stem: line.to_string() })
}

/// Parse the marker-structured output of `get_multiple_package_datasets()`.
/// Same framing as [`parse_multi_exports_output`]: a `__RAVEN_MULTI_DATASETS__`
/// header, one `__PKG:name__` line per package, `__RAVEN_END__` terminator.
fn parse_multi_datasets_output(
    output: &str,
) -> Result<std::collections::HashMap<String, Vec<DataObject>>> {
    let mut result = std::collections::HashMap::new();
    let start = output
        .find("__RAVEN_MULTI_DATASETS__")
        .ok_or_else(|| anyhow!("Missing __RAVEN_MULTI_DATASETS__ marker in R output"))?;
    let section = &output[start + "__RAVEN_MULTI_DATASETS__".len()..];
    let mut current_package: Option<String> = None;
    let mut current_items: Vec<DataObject> = Vec::new();
    for line in section.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("__PKG:") && line.ends_with("__") {
            if let Some(pkg) = current_package.take() {
                result.insert(pkg, std::mem::take(&mut current_items));
            }
            current_package = Some(line[6..line.len() - 2].to_string());
        } else if line == "__RAVEN_END__" {
            if let Some(pkg) = current_package.take() {
                result.insert(pkg, std::mem::take(&mut current_items));
            }
            break;
        } else if current_package.is_some()
            && let Some(obj) = parse_data_item(line)
        {
            current_items.push(obj);
        }
    }
    if let Some(pkg) = current_package {
        result.insert(pkg, std::mem::take(&mut current_items));
    }
    Ok(result)
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test -p raven parse_data_item parse_multi_datasets`
Expected: all 6 PASS.

- [ ] **Step 5: fmt, clippy, commit**

```bash
cargo fmt --all && cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/r_subprocess.rs
git commit -m "feat: parse data(package=) Item lines into DataObject (issue #429)"
```

---

### Task 2: `get_multiple_package_datasets` subprocess query

**Files:**
- Modify: `crates/raven/src/r_subprocess.rs` (new method on `impl RSubprocess`, place after `get_multiple_package_exports` ending at line 501)
- Tests: same file (R-gated integration test — find how existing subprocess tests gate on R availability, e.g. tests calling `RSubprocess::new`, and copy that gating pattern exactly)

- [ ] **Step 1: Write failing R-gated integration test**

```rust
#[tokio::test]
async fn test_get_multiple_package_datasets_base_datasets() {
    // `datasets` ships with every R install; `state.abb (state)` exercises aliases.
    let Some(sub) = RSubprocess::new(None) else {
        eprintln!("R not available, skipping");
        return;
    };
    let result = sub
        .get_multiple_package_datasets(&["datasets".to_string()])
        .await
        .expect("query should succeed");
    let items = &result["datasets"];
    assert!(items.iter().any(|d| d.name == "mtcars" && d.file_stem == "mtcars"));
    assert!(items.iter().any(|d| d.name == "state.abb" && d.file_stem == "state"));
}

#[tokio::test]
async fn test_get_multiple_package_datasets_rejects_invalid_name() {
    let Some(sub) = RSubprocess::new(None) else {
        eprintln!("R not available, skipping");
        return;
    };
    assert!(sub
        .get_multiple_package_datasets(&["bad; system('x')".to_string()])
        .await
        .is_err());
}
```

(Adjust the `RSubprocess::new(None)` construction/skip idiom to match the file's existing integration tests — mirror whichever gating the neighboring tests use.)

- [ ] **Step 2: Verify compile failure**

Run: `cargo test -p raven get_multiple_package_datasets 2>&1 | tail -5`
Expected: method not found.

- [ ] **Step 3: Implement the method**

Model on `get_multiple_package_exports` (r_subprocess.rs:456-501). Every safety invariant from the module doc applies: validate all names via `is_valid_package_name` before codegen; the call goes through `execute_r_code` which carries the standard timeout.

```rust
/// Enumerate dataset objects for multiple packages in one R call via
/// `data(package = "pkg")$results[, "Item"]` (issue #429).
///
/// Items are `name` or `name (stem)`; both halves are preserved in
/// [`DataObject`] so callers can map file stems to bound object names.
/// Packages that error (not installed, no data) yield empty lists.
pub async fn get_multiple_package_datasets(
    &self,
    packages: &[String],
) -> Result<std::collections::HashMap<String, Vec<DataObject>>> {
    if packages.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    for pkg in packages {
        if !is_valid_package_name(pkg) {
            return Err(anyhow!(
                "Invalid package name '{}': must contain only letters, numbers, dots, and underscores",
                pkg
            ));
        }
    }
    let packages_vector = packages
        .iter()
        .map(|p| format!("\"{}\"", p))
        .collect::<Vec<_>>()
        .join(", ");
    let r_code = format!(
        r#"
pkgs <- c({})
cat("__RAVEN_MULTI_DATASETS__\n")
for (pkg in pkgs) {{
    cat(paste0("__PKG:", pkg, "__\n"))
    tryCatch({{
        items <- suppressWarnings(data(package = pkg)$results)
        if (length(items)) writeLines(items[, "Item"])
    }}, error = function(e) {{}})
}}
cat("__RAVEN_END__\n")
"#,
        packages_vector
    );
    let output = self.execute_r_code(&r_code).await?;
    parse_multi_datasets_output(&output)
}
```

- [ ] **Step 4: Run tests, verify pass** (requires local R — it is installed on this machine)

Run: `cargo test -p raven get_multiple_package_datasets`
Expected: 2 PASS.

- [ ] **Step 5: fmt, clippy, commit**

```bash
cargo fmt --all && cargo clippy -p raven --all-targets --features test-support -- -D warnings
git add crates/raven/src/r_subprocess.rs
git commit -m "feat: batched data(package=) enumeration query (issue #429)"
```

---

### Task 3: `PackageInfo.data_aliases` field + enumeration-aware population

**Files:**
- Modify: `crates/raven/src/package_library.rs` — `PackageInfo` (line 108), `package_info_from_dir` (line 178), `get_package` (line 1532), and `prefetch_packages` (find it; the `lazy_data` doc at line 126-129 says it inserts straight into the cache bypassing `get_package`)
- Tests: existing `#[cfg(test)]` module in `package_library.rs`

Semantics (from the spec — do not deviate):
- `data_aliases: HashMap<String, Vec<String>>` (file stem → bound object names) is populated from enumeration for **any** package with a `data/` dir; empty without R.
- `lazy_data` is **replaced** by enumerated names only when `data/Rdata.rdb` exists (the LazyData marker — R builds that DB only when DESCRIPTION sets LazyData). For non-LazyData packages `lazy_data` keeps today's static `parse_data_symbols` stems (permissive path stays; tightening is out of scope).
- Enumeration failure must never fail `get_package` — log and fall back to static.
- Base packages keep their separate route (`lazy_data` empty by design, line 129-131); do not touch `initialize`'s base handling.

- [ ] **Step 1: Write failing tests**

The test module already builds fake package dirs (see `test_get_package_populates_lazy_data_from_disk`, line 4153 — reuse its fixture helpers). Add:

```rust
#[test]
fn test_package_info_data_aliases_default_empty() {
    let info = PackageInfo::new("pkg".to_string(), HashSet::new());
    assert!(info.data_aliases.is_empty());
}

#[tokio::test]
async fn test_apply_enumerated_data_lazydata_package() {
    // Rdata.rdb present → lazy_data replaced by enumerated names; aliases mapped.
    let enumerated = vec![
        crate::r_subprocess::DataObject { name: "apiclus1".into(), file_stem: "api".into() },
        crate::r_subprocess::DataObject { name: "apistrat".into(), file_stem: "api".into() },
        crate::r_subprocess::DataObject { name: "lung".into(), file_stem: "lung".into() },
    ];
    let mut info = PackageInfo::new("survey".to_string(), HashSet::new());
    info.lazy_data = vec!["api".to_string()]; // static stem discovery result
    apply_enumerated_data(&mut info, &enumerated, /* has_lazy_data_db */ true);
    assert_eq!(info.lazy_data, vec!["apiclus1", "apistrat", "lung"]);
    assert_eq!(info.data_aliases["api"], vec!["apiclus1", "apistrat"]);
    assert_eq!(info.data_aliases["lung"], vec!["lung"]);
}

#[tokio::test]
async fn test_apply_enumerated_data_non_lazydata_package() {
    // No Rdata.rdb → lazy_data untouched (permissive static stems stay); aliases still mapped.
    let enumerated = vec![
        crate::r_subprocess::DataObject { name: "apiclus1".into(), file_stem: "api".into() },
    ];
    let mut info = PackageInfo::new("survey".to_string(), HashSet::new());
    info.lazy_data = vec!["api".to_string()];
    apply_enumerated_data(&mut info, &enumerated, false);
    assert_eq!(info.lazy_data, vec!["api"]);
    assert_eq!(info.data_aliases["api"], vec!["apiclus1"]);
}
```

- [ ] **Step 2: Verify compile failure**

Run: `cargo test -p raven apply_enumerated_data data_aliases_default 2>&1 | tail -5`
Expected: field/function not found.

- [ ] **Step 3: Implement field + helper**

Add to `PackageInfo` (after `lazy_data`, line 132):

```rust
    /// Map from data-file stem to the object names that file binds, from R's
    /// `data(package=)` enumeration (issue #429). Covers multi-object files
    /// (survey: `api` → `apiclus1`, `apistrat`, ...). Populated for any
    /// package with a `data/` dir when the R subprocess is available; empty
    /// otherwise. Consumed only by `data()` call alias expansion in
    /// cross-file scope — never injected after bare `library()` for
    /// non-LazyData packages.
    pub data_aliases: HashMap<String, Vec<String>>,
```

Initialize `data_aliases: HashMap::new()` in both `PackageInfo::new` and `PackageInfo::with_details` (keep `with_details`'s signature unchanged — population mutates the field afterward via the helper). Fix any struct-literal construction sites the compiler flags (e.g. tests at lines ~2217, ~2297).

Add the helper (free function near `package_info_from_dir`):

```rust
/// Fold R's `data(package=)` enumeration into a freshly-built `PackageInfo`.
///
/// `has_lazy_data_db` is the `data/Rdata.rdb` check: that DB exists iff
/// DESCRIPTION sets LazyData, and only then does `library(pkg)` attach the
/// datasets — so enumerated names replace `lazy_data` only in that case.
/// Non-LazyData packages keep their static file-stem `lazy_data` (deliberately
/// permissive; see issue #429 scope decisions). `data_aliases` is filled for
/// both, feeding `data()` call alias expansion.
fn apply_enumerated_data(
    info: &mut PackageInfo,
    enumerated: &[crate::r_subprocess::DataObject],
    has_lazy_data_db: bool,
) {
    if enumerated.is_empty() {
        return;
    }
    if has_lazy_data_db {
        info.lazy_data = enumerated.iter().map(|d| d.name.clone()).collect();
    }
    for d in enumerated {
        info.data_aliases
            .entry(d.file_stem.clone())
            .or_default()
            .push(d.name.clone());
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test -p raven apply_enumerated_data data_aliases_default`
Expected: 3 PASS.

- [ ] **Step 5: Wire into `get_package` and `prefetch_packages`**

In `get_package` (after `package_info_from_dir` at line 1631, before `insert_package`):

```rust
        // Issue #429: enumerate lazy-data objects via R when the package ships data/.
        let mut info = info;
        let data_dir = pkg_dir.join("data");
        if data_dir.is_dir()
            && let Some(ref r_subprocess) = self.r_subprocess
        {
            match r_subprocess
                .get_multiple_package_datasets(std::slice::from_ref(&name.to_string()))
                .await
            {
                Ok(mut map) => {
                    if let Some(enumerated) = map.remove(name) {
                        let has_db = data_dir.join("Rdata.rdb").is_file();
                        apply_enumerated_data(&mut info, &enumerated, has_db);
                    }
                }
                Err(e) => {
                    log::trace!("data() enumeration failed for '{}': {} (static fallback)", name, e);
                }
            }
        }
```

In `prefetch_packages` (which bypasses `get_package` — read its body first): collect the subset of prefetched packages whose `data/` dir exists, make **one** `get_multiple_package_datasets` call for all of them (that's why the batched API exists — each R spawn is 75-350ms), and apply `apply_enumerated_data` per package before cache insertion, with the same `Rdata.rdb` check per package dir. Same error tolerance: on `Err`, log at trace and proceed without enumeration.

- [ ] **Step 6: Add an R-gated end-to-end test**

```rust
#[tokio::test]
async fn test_get_package_enumerates_datasets_with_r() {
    // `datasets` won't do (base route); use any installed LazyData package.
    // survival ships with most R installs and is in the corpus environment.
    let Some(sub) = crate::r_subprocess::RSubprocess::new(None) else {
        eprintln!("R not available, skipping");
        return;
    };
    let mut lib = PackageLibrary::with_subprocess(Some(sub));
    lib.initialize().await;
    let Some(info) = lib.get_package("survival").await else {
        eprintln!("survival not installed, skipping");
        return;
    };
    assert!(
        info.lazy_data.contains(&"lung".to_string()),
        "lazy_data should contain `lung`, got {:?}",
        info.lazy_data
    );
}
```

(Match `PackageLibrary::with_subprocess` / `initialize` invocation details to neighboring R-gated tests in this file — copy their construction idiom.)

- [ ] **Step 7: Run full package_library tests; fmt, clippy, commit**

```bash
cargo test -p raven package_library
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_library.rs
git commit -m "feat: populate lazy_data and data_aliases from R data() enumeration (issue #429)"
```

This task alone closes bucket 1 (44 entries): `collect_exports_recursive` (package_library.rs:1870,1878) already folds `lazy_data` into scope and owner attribution — verify by reading those lines, change nothing there.

---

### Task 4: `ScopeEvent::DataLoad` — record `data()` calls with package + stems

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` — `ScopeEvent` enum (line 599), `try_extract_data_call_definitions` (line 3301) and its call site (line 2198), `event_effect_position` (line ~973)
- Tests: scope.rs test module

This task only **records**; expansion is Task 5. The existing literal-name binding behavior must remain byte-for-byte identical (it is the no-R fallback).

- [ ] **Step 1: Write failing tests**

Find how existing scope tests build artifacts from R source (search `fn build_artifacts` or how tests near line 13492 construct `ScopeArtifacts` from code strings; reuse that helper). Add:

```rust
#[test]
fn test_data_call_records_dataload_event_with_package() {
    let code = r#"data(api, package = "survey")"#;
    let artifacts = /* build artifacts via the module's test helper */;
    let ev = artifacts.timeline.iter().find_map(|e| match e {
        ScopeEvent::DataLoad { stems, package, .. } => Some((stems.clone(), package.clone())),
        _ => None,
    });
    let (stems, package) = ev.expect("DataLoad event recorded");
    assert_eq!(stems, vec!["api".to_string()]);
    assert_eq!(package.as_deref(), Some("survey"));
}

#[test]
fn test_data_call_records_dataload_event_bare() {
    let code = "data(mtcars)";
    let artifacts = /* build via helper */;
    let ev = artifacts.timeline.iter().find_map(|e| match e {
        ScopeEvent::DataLoad { stems, package, .. } => Some((stems.clone(), package.clone())),
        _ => None,
    });
    let (stems, package) = ev.expect("DataLoad event recorded");
    assert_eq!(stems, vec!["mtcars".to_string()]);
    assert_eq!(package, None);
}

#[test]
fn test_data_call_literal_binding_unchanged() {
    // The literal names still bind as Variable symbols (no-R fallback).
    let code = "data(mtcars)\nmtcars";
    // assert mtcars resolves in scope at line 1 exactly as before this change
    // (copy the assertion style of the existing data() tests in this module —
    // search for tests exercising try_extract_data_call_definitions).
}
```

- [ ] **Step 2: Verify compile failure** (`DataLoad` variant doesn't exist)

Run: `cargo test -p raven dataload 2>&1 | tail -5`

- [ ] **Step 3: Implement**

Add the variant (after `PackageLoad`, line 668):

```rust
    /// A `data(...)` / `utils::data(...)` call. Carries the literal dataset
    /// stems and the `package =` argument (when a string literal) so
    /// query-time resolution can expand multi-object data-file aliases via
    /// `PackageInfo.data_aliases` (issue #429). The literal stems are ALSO
    /// bound as ordinary `Def` events at artifact time — that is the no-R
    /// fallback and must not be removed.
    DataLoad {
        line: u32,
        column: u32,
        /// Positional dataset names exactly as written (`data(api)` → `["api"]`).
        stems: Vec<String>,
        /// `package = "..."` string-literal argument, if present.
        package: Option<String>,
        /// Function scope if inside a function (None = global)
        function_scope: Option<FunctionScopeInterval>,
    },
```

Update `event_effect_position` (line ~973) with a `ScopeEvent::DataLoad { line, column, .. } => (*line, *column)` arm, and let the compiler's exhaustive-match errors lead you to **every** other `match` over `ScopeEvent` — for this task, give `DataLoad` a no-op/skip arm everywhere except `event_effect_position` (Task 5 fills in the consumers). Do not use a catch-all `_ =>` anywhere a match is currently exhaustive; keep exhaustiveness so future variants stay loud.

Change `try_extract_data_call_definitions` to also return the call info. Keep the existing name and behavior for symbols; extend the signature:

```rust
fn try_extract_data_call_definitions(
    node: Node,
    line_index: &LineIndex,
    uri: &Url,
) -> (Vec<ScopedSymbol>, Option<(Vec<String>, Option<String>)>) {
```

Inside, in the existing argument loop (line 3330): named arguments are currently skipped wholesale (line 3335) — now, before skipping, check whether the name node's text is `package` and the value is a string literal (`string_literal_content`, line 3367); capture it. Collect positional names into both the `ScopedSymbol` vec (unchanged) and a `stems: Vec<String>`. Return `(symbols, if stems.is_empty() { None } else { Some((stems, package)) })`.

At the call site (line 2198), destructure, keep pushing the symbols exactly as today, and additionally push a `ScopeEvent::DataLoad` onto the timeline with the call node's start position and the same `function_scope` treatment used for `PackageLoad` events (see how line 1193-1210 annotates package loads; `data()` events are pushed where the symbols are, so follow the function-scope handling of the surrounding `Def` events at that site).

**Interface-hash check:** read `compute_interface_hash` (call at line ~1240) and its doc. The literal stems already flow into the hash via their `Def` symbols; the `DataLoad` event adds no *cross-file-visible* names beyond what Task 5's expansion produces at query time within the same file. Confirm whether expanded names can cross files via `live_top_level_exports` — if `data()`-bound literals already propagate to sourcing parents, the expansion must too, and the conservative fix is to include `(stems, package)` pairs in the hash input. Decide by reading; document the decision in a comment at the hash site.

- [ ] **Step 4: Run scope tests**

Run: `cargo test -p raven --lib cross_file::scope`
Expected: new tests PASS, zero existing failures.

- [ ] **Step 5: fmt, clippy (workspace — the enum change ripples), commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/cross_file/scope.rs
git commit -m "feat: record DataLoad scope events for data() calls (issue #429)"
```

---### Task 5: Query-time alias expansion + production wiring

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` (timeline consumers), `crates/raven/src/package_library.rs` (sync alias accessor), `crates/raven/src/handlers.rs` and/or the cross-file diagnostic path (provider plumbing)
- Tests: scope.rs test module + handlers tests

This is the most open-ended task. The contract:

1. **Provider.** Expansion needs a *synchronous* lookup `(&str pkg, &str stem) -> Vec<String>` available wherever `PackageLoad` events currently inject exports (the `get_package_exports: &Fn(&str) -> HashSet<String>` callback in `scope_at_position_with_packages`, line 1731, and the equivalent injection points in the recursive cross-file resolution — find them by following where `DataLoad`'s no-op arms from Task 4 sit). Trace how production callers construct the `get_package_exports` callback (who calls these scope functions outside tests — search `handlers.rs` and `cross_file/` for the non-test constructors) and plumb the alias provider the **same way**: if exports come from a pre-collected snapshot map, build a parallel `HashMap<String, HashMap<String, Vec<String>>>` snapshot from the same `PackageInfo`s; if they call into `PackageLibrary` synchronously, add a sync `peek`-style accessor on `PackageLibrary` that reads the `ArcSwap` cache without promotion (CLAUDE.md LRU invariant: read paths use `peek()`, never `push()`).

2. **Expansion semantics** (from the spec, exactly):
   - `DataLoad { stems, package: Some(pkg), .. }` → for each stem, bind every name in `data_aliases[stem]` of `pkg`, as `SymbolKind::Variable` at the event position, same visibility rules as the literal binding.
   - `DataLoad { stems, package: None, .. }` → search every package attached at-or-before the event position (the same loaded-package set the surrounding resolution already tracks for `PackageLoad`, plus default-attached base packages) and bind all matches from each.
   - The literal stems are already bound by the Task-4-preserved `Def` events — expansion is purely additive; never remove or suppress the literal binding.
   - Unknown package / empty aliases / no provider → expansion contributes nothing (fallback intact).

3. **Locking invariant (CLAUDE.md):** diagnostic computation MUST NOT hold the `WorldState` read lock across cross-file scope resolution. The alias snapshot must be captured under the same snapshot discipline as the existing artifact/metadata/config snapshots — find that snapshot block in the diagnostics path and add the alias data there, not inside resolution.

- [ ] **Step 1: Write failing scope-level test with a fake provider**

```rust
#[test]
fn test_dataload_expansion_with_explicit_package() {
    // data(api, package = "survey") then apiclus1 → resolves via provider.
    let code = "data(api, package = \"survey\")\napiclus1";
    let aliases = |pkg: &str, stem: &str| -> Vec<String> {
        if pkg == "survey" && stem == "api" {
            vec!["apiclus1".to_string(), "apistrat".to_string()]
        } else {
            Vec::new()
        }
    };
    // build artifacts, resolve scope at line 1 with the provider wired in;
    // assert `apiclus1` is in scope and `apistrat` too; assert `api` (literal) also still binds.
}

#[test]
fn test_dataload_expansion_bare_searches_attached() {
    let code = "library(survey)\ndata(api)\napiclus1";
    // same provider; assert apiclus1 in scope at line 2.
}

#[test]
fn test_dataload_expansion_absent_provider_falls_back_to_literal() {
    let code = "data(api, package = \"survey\")\napiclus1";
    // provider returning empty: apiclus1 NOT in scope, api IS.
}
```

(Concrete invocation must match whatever plumbing shape step 2 lands on — write these tests first against the signature you intend, then implement to them.)

- [ ] **Step 2: Implement expansion at every timeline consumer that handles `PackageLoad`**, replacing Task 4's no-op arms. The compiler already enumerated the sites for you in Task 4 — each no-op arm is a TODO list entry. For `scope_at_position_with_packages`-style consumers, expansion code shape:

```rust
ScopeEvent::DataLoad { line: ev_line, column: ev_column, stems, package, function_scope } => {
    // visibility / function-scope gating: copy the PackageLoad arm's checks verbatim
    let target_packages: Vec<&str> = match package {
        Some(pkg) => vec![pkg.as_str()],
        None => loaded_packages_so_far.iter().map(|s| s.as_str())
            .chain(default_attached_base_packages())
            .collect(),
    };
    for pkg in target_packages {
        for stem in stems {
            for object_name in get_data_aliases(pkg, stem) {
                let name: Arc<str> = Arc::from(object_name.as_str());
                scope.symbols.entry(name.clone()).or_insert_with(|| ScopedSymbol {
                    name,
                    kind: SymbolKind::Variable,
                    source_uri: uri_for_package(pkg),
                    defined_line: *ev_line,
                    defined_column: *ev_column,
                    signature: None,
                    is_declared: false,
                });
            }
        }
    }
}
```

(`loaded_packages_so_far`, `default_attached_base_packages`, `uri_for_package`, and insert-precedence are placeholders for the *local idioms at each consumer* — at each site, copy exactly how the `PackageLoad` arm three lines up obtains the loaded set, builds the `package:` URI, and decides `entry().or_insert_with` vs overwrite. Do not invent new idioms.)

- [ ] **Step 3: Wire the production diagnostics + completion paths** per the contract above; run the three acceptance snippets manually via `raven check`:

```bash
cargo build -p raven
printf 'library(survival)\nlung\n' > /tmp/t1.R && target/debug/raven check /tmp/t1.R
printf 'data(api, package = "survey")\napiclus1\n' > /tmp/t2.R && target/debug/raven check /tmp/t2.R
printf 'library(cli)\nemojis\n' > /tmp/t3.R && target/debug/raven check /tmp/t3.R
```

Expected: t1 and t2 report no undefined-variable diagnostics (R + survival + survey installed locally); t3 STILL reports `emojis` undefined.

- [ ] **Step 4: Add those three acceptance cases as R-gated integration tests** — find the existing `raven check`-level or handlers-level diagnostic test harness (search tests for `undefined variable` assertions against full R snippets) and add all three, skipping when R/survival/survey are absent, with the negative `emojis` case asserted unconditionally on the "must flag" side whenever cli is installed.

- [ ] **Step 5: Full test suite, fmt, clippy, commit**

```bash
cargo test -p raven
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add -A && git commit -m "feat: expand data() aliases at scope query time (issue #429)"
```

---

### Task 6: sysdata ledger re-probe + corpus run + ledger pruning

**Files:**
- Modify: `crates/raven/tests/fixtures/package_corpus/known_false_positives.toml`
- Reference: `docs/package-corpus-checkpoint.md` (read first — it documents the strict-run and stale-FP workflow), `crates/raven/tests/package_corpus.rs` (how `RAVEN_CORPUS_GROUPS` and strict mode work)

- [ ] **Step 1: Run the full 4-group strict corpus** with the implementation in place (exact env-var invocation per `docs/package-corpus-checkpoint.md` / the test file header — copy it verbatim from there).

- [ ] **Step 2: Prune bucket 1 + 3 entries.** The run's `stale-fp:` report lists ledger entries whose diagnostics no longer fire — these are the lazy-data and alias entries the feature fixed. Remove exactly those from `known_false_positives.toml`. Do not remove entries not named by the report.

- [ ] **Step 3: Re-probe the 26 sysdata entries.** For every entry whose `reason` mentions `sysdata`: determine whether the referencing file is package-internal code (covered by `package_state/sysdata.rs` machinery — these should appear in the stale-FP report and get pruned) or a *user-level script* referencing sysdata objects after `library()` (e.g. `library(cli); emojis` patterns). The latter are genuine R errors: re-classify `kind = "FalsePositive"` → `kind = "AcceptedReal"` with a reason noting "sysdata is namespace-internal; real R errors here".

- [ ] **Step 4: Verify strict run green:** 0 unclassified / 0 stale acceptances / 0 stale FPs across all 4 groups.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/tests/fixtures/package_corpus/known_false_positives.toml
git commit -m "test: prune lazy-data ledger entries; reclassify user-level sysdata refs (issue #429)"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/cross-file.md` (data()/library() scope semantics), `docs/package-database.md` (enumeration, no-R fallback, capture-reference upgrade), `docs/development.md` (if the snapshot plumbing added architecture worth debugging notes)

- [ ] **Step 1:** Document, in user-facing terms: lazy-loaded datasets of installed LazyData packages now resolve after `library()`; `data()` calls expand multi-object files when `package=` is given or the package is attached; without R, behavior falls back to file-stem discovery (reduced fidelity, no regression); sysdata never leaks into user scripts.
- [ ] **Step 2:** Verify every new/changed function carries the doc comments written in Tasks 1-5 (the invariants live on the functions per CLAUDE.md, not in CLAUDE.md).
- [ ] **Step 3: Commit**

```bash
git add docs/ && git commit -m "docs: lazy-data enumeration and data() alias expansion (issue #429)"
```

---

### Task 8: Pre-PR review gate (required by the issue — two consecutive clean passes)

- [ ] **Step 1: Prerequisites:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --features test-support -- -D warnings`, `cargo test -p raven` all green; strict corpus run green per Task 6.
- [ ] **Step 2: Review pass:** dispatch parallel reviewer subagents over `git diff main...HEAD`, one per dimension — Correctness; Invariants (CLAUDE.md Key invariants + module/function doc-comment invariants of every touched file); Tests (red→green discipline, per-surface coverage, negative cases); Docs; Simplification/reuse. Each reports findings with `file:line`, severity, confidence.
- [ ] **Step 3: Adversarial verification:** every finding goes to an independent subagent instructed to refute it against the actual code; discard refuted findings.
- [ ] **Step 4:** If any finding survives: fix, re-run gates, **reset the counter**, return to Step 2.
- [ ] **Step 5:** PR opens only after two clean passes in a row.
