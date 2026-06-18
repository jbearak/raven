# .Rprofile prelude & script-scope visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model a workspace-root `.Rprofile` as a static, suppressive-only "script-scope prelude" so files where R would actually source `.Rprofile` (scripts, data-raw, non-package `R/`, etc.) resolve the helpers it defines/sources/attaches — and document the existing package-visibility boundary.

**Architecture:** Mirror the existing `data/` dataset-symbol pipeline exactly. A synchronous disk scan (`scan_workspace_rprofile`) statically parses `<root>/.Rprofile` (and the files it `source()`s, transitively, bounded) into two sets — top-level symbol names and attached packages — stored on `PackageInputs`. The pure `derive_package_state` copies them onto `PackageScopeContribution` (plus an `rprofile_root`). A new depth-0 injection (`append_rprofile_prelude`) merges them into a queried file's scope, gated by an applicability rule that withholds the prelude (in package mode only) from namespace `R/`, tests, and built doc dirs. A `.Rprofile` edit re-runs the scan via the watched-file path and force-republishes affected open files.

**Tech Stack:** Rust (the `raven` crate; tree-sitter-r), TypeScript (the VS Code extension), bun tests.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-06-17-rprofile-prelude-and-script-scope-design.md`). Every task's requirements implicitly include these.

- **Static-parse only** — never execute `.Rprofile`. Parse the AST; extract only top-level `library`/`require`, top-level assignments (via Raven's normal top-level scope construction), and top-level `source()` of literal paths. Never `eval`.
- **Additive / suppressive only** — the prelude may *suppress* "undefined variable" false positives and *enrich* completion/hover. It must **never** introduce a new diagnostic.
- **Applicability rule** — apply where R actually sources `.Rprofile` (`scripts/`, `data-raw/`, plain `inst/` scripts, `tools/`, `debug/`, arbitrary dirs, all script-mode files **including a non-package `R/`**). Withhold (in **package mode only**) from namespace `R/`, tests (`tests/testthat/`, `tests/testit/`, plain `tests/*.R`, `inst/tinytest/`, `inst/unitTests/`), and built doc dirs (`vignettes/`, `man/`, `demo/`). The exclusion is gated on the **active package-mode flag**, not on the path. `data-raw/` is **applied to**, not withheld (so withholding must be **narrower** than `is_dev_context_path`).
- **Harvest via Raven's normal top-level scope construction** (`extract_top_level_defs`) — this *includes* conditional / `if (interactive())` top-level assignments. Only `source()` / `library()` **arguments** must be literal.
- **Skip / whitelist `renv/activate.R`** — recognize the `renv/activate.R` path and do not follow it for symbol extraction; do not error if it is missing.
- **Follow `source()` only for literal paths**, reusing the existing path resolution + workspace-root fallback, followed transitively, bounded by a recursion budget.
- **Project `.Rprofile` only** — model the workspace-root `.Rprofile`, never `~/.Rprofile`.
- **Setting `raven.packages.rprofilePrelude`** — boolean, default `true`.
- **Single-signal package activation already landed** (commit `ecb8c19a`). Do NOT re-add a NAMESPACE-based `Auto` activation branch.

### CI gates (run before every commit)

```bash
cargo fmt --all
cargo fmt --all --check
cargo clippy --workspace --all-targets --features test-support -- -D warnings
```

Zero clippy warnings. Run the relevant `cargo test -p raven <module>` for changed areas (each task names them).

---

## File Structure

**New files:**
- `crates/raven/src/package_state/rprofile.rs` — the static `.Rprofile` scanner (`scan_workspace_rprofile`, `RprofileScan`, recursion budgets). One responsibility: turn a workspace root into prelude symbol + attached-package sets, never executing anything.

**Modified (Rust):**
- `crates/raven/src/package_state/mod.rs` — declare `pub mod rprofile;`; add `model_rprofile`, `rprofile_symbols`, `rprofile_attached_packages` to `PackageInputs`; add `rprofile_symbols`, `rprofile_attached_packages`, `rprofile_root` to `PackageScopeContribution`; add `RProfileChanged` to `PackageInputDelta`; add the `is_built_doc_dir_path` + `rprofile_withheld_in_package_mode` path helpers.
- `crates/raven/src/package_state/derive.rs` — thread the new inputs into `build_scope_contribution` (carry the prelude even when there is no package workspace).
- `crates/raven/src/package_state/event.rs` — handle a `.Rprofile` change in `translate` / `translate_watched`.
- `crates/raven/src/cross_file/config.rs` — add `model_rprofile: bool` to `CrossFileConfig` (default `true`).
- `crates/raven/src/cross_file/scope.rs` — add `append_rprofile_prelude`; call it at the Phase 5a site; mirror prelude names in `compute_contribution_symbol_names`.
- `crates/raven/src/backend.rs` — parse `packages.rprofilePrelude`; seed `model_rprofile` + run the scan in `initialize_package_inputs_from_state`; route `.Rprofile` watched changes; broaden the manifest republish set for `RProfileChanged`; re-scan on a live `rprofilePrelude` toggle.
- `crates/raven/src/cli/check.rs` — the 11 acceptance tests (uses the existing `collect_diagnostics_blocking` harness).

**Modified (docs / VS Code):**
- `docs/r-package-dev.md` — Part A "Files outside the package directories" section + the `.Rprofile` prelude subsection + Configuration row.
- `editors/vscode/package.json`, `editors/vscode/src/initializationOptions.ts`, `editors/vscode/src/test/settings.test.ts` — the setting (three places).
- `editors/vscode/src/extension.ts` — the `**/.Rprofile` watcher.
- `docs/settings-reference.md` — regenerated.

---

## Task 1: Part A + prelude user documentation

Documents the existing boundary and the new feature. No code; the deliverable is the doc. (Part A is independent of the feature and can land first.)

**Files:**
- Modify: `docs/r-package-dev.md`

- [ ] **Step 1: Read the current doc to find the insertion point**

Run: `rg -n "load_all|dev-context|Build commands|False positives persist" docs/r-package-dev.md`

Identify (a) the end of the dev-context/`load_all()` discussion and the "Build commands" heading (insert the new section *before* "Build commands"), and (b) the troubleshooting entry "False positives persist…".

- [ ] **Step 2: Add the "Files outside the package directories" section**

Insert this section immediately before the "Build commands" heading:

```markdown
## Files outside the package directories

Files that live outside a package's standard directories (most commonly a
`scripts/` or `analysis/` folder) do **not** automatically see your package's
functions. A diagnostic such as `Undefined variable: my_helper` on a function
used from `scripts/` is, by default, **correct**: `scripts/` is not a package
directory, `R CMD check` never runs it, and a clean `Rscript scripts/foo.R`
session genuinely cannot find `my_helper`.

Readers usually arrive with one of two mental models — name yours:

- **"This is a real R package."** The diagnostic is correct and expected.
  `scripts/` is not a package directory, `library()` exposes only *exported*
  symbols, and `R CMD check` never sources `scripts/`. Fix it the way R would:
  call `library(yourpkg)` (for exports), `devtools::load_all()` (for everything
  in `R/`), `source()` the file, or add a `# raven: source` directive.
- **"This is an analysis project that borrows package scaffolding"** (research
  compendia — `rrtools`, `rcompendium`, ropensci's `rrrpkg`). Here the function
  genuinely *is* defined at runtime — typically because a workspace-root
  `.Rprofile` sources your helpers at startup — so the diagnostic reads as a
  false positive. Raven models a workspace-root `.Rprofile` automatically (see
  "`.Rprofile` prelude" below); for other loading conventions, use a directive.

### What each loading mechanism makes visible

| How a file outside the package dirs obtains your functions | What becomes visible |
|---|---|
| `library(yourpkg)` | **Only exported** symbols (`@export` / `NAMESPACE`). Requires the package installed. Internals need `yourpkg:::name`. |
| `devtools::load_all()` / `pkgload::load_all()` | **Exported and internal** `R/` symbols — `load_all()`'s `export_all = TRUE` default copies *all* objects into scope. This is why code can pass under `load_all()` but fail under `library()` / `R CMD check`. |
| `source("R/...")` | **All top-level definitions** become globals — there is no export concept; `source()` has nothing to do with packages. |
| A `# raven: source R/...` directive | Path-resolution equivalent of `source()` — Raven follows it (and its transitive `source()` chain) to bring those top-level defs into scope. |

### The `load_all` / `library` trap

The most common R packaging surprise: `devtools::load_all()` makes *internal*
functions usable by bare name (default `export_all = TRUE`), so code that
"works in development" can fail under `library()` or `R CMD check`. Adding
`@export` alone does **not** make a function visible to a `scripts/` file — that
file still needs `library()` (which exposes only exports), or
`load_all()` / `source()` / a directive.

### Worked recipe (the `.Rprofile` / bootstrap pattern)

Bring helpers into a `scripts/` file with a directive at the top of the file:

```r
# raven: source R/functions.r      # at the top of a scripts/ file
```

> If your project loads its helpers via a workspace-root `.Rprofile` (e.g.
> `source("R/functions.r")`), Raven models that automatically — see
> "`.Rprofile` prelude" below. The directive remains available for projects
> that load functions some other way, or when `.Rprofile` modeling is disabled.

### `.Rprofile` prelude

When a workspace-root `.Rprofile` exists, Raven statically reads its top-level
statements and treats the symbols they introduce as in scope for the files
where R would actually have sourced `.Rprofile` (an interactive session, or
`Rscript` launched from the project root). This mirrors R's startup — per
`?Startup`, R sources `./.Rprofile` before running any script — without
executing anything. The prelude contributes:

- names assigned at top level (`x <- ...`, `x = ...`, `x <<- ...`, and
  `assign("x", ...)` with a literal name), including names bound inside
  top-level `if`/`else` (e.g. `if (interactive()) helper <- function() {}`);
- packages attached by top-level `library(pkg)` / `require(pkg)` — their
  exports become available by bare name;
- top-level definitions reachable through `source("path")` calls whose path is
  a static literal, resolved with the workspace-root fallback and followed
  transitively through those files' own `source()` calls.

The model is **suppressive only**: it can silence a false "undefined variable"
and enrich completion/hover, but it never *introduces* a diagnostic. It is
**withheld** (in package mode) from files whose canonical run context is a
clean, profile-suppressed `R CMD check` / `build` session — namespace `R/`,
tests, and built doc dirs (`vignettes/`, `man/`, `demo/`) — because a symbol
that exists only because of `.Rprofile` is a genuine bug there. In a project
that is **not** an R package, an `R/` directory is just scripts, so the prelude
applies to it like any other directory. Raven never models `~/.Rprofile`, and
it recognizes `renv`'s `source("renv/activate.R")` line and does not follow it.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `raven.packages.rprofilePrelude` | `true` | Model a workspace-root `.Rprofile`'s top-level `source()`/`library()`/assignments as a script-scope prelude. |
```

- [ ] **Step 3: Cross-link the troubleshooting entry**

In the "False positives persist…" troubleshooting entry, add a sentence:
`If the function is loaded at runtime by a workspace-root `.Rprofile` or a bootstrap `source()`, see "Files outside the package directories" — Raven models `.Rprofile` automatically, and a `# raven: source` directive covers other conventions.`

- [ ] **Step 4: Commit**

```bash
git add docs/r-package-dev.md
git commit -m "docs(r-package-dev): document the package-visibility boundary and .Rprofile prelude"
```

---

## Task 2: Add the `rprofilePrelude` config field (Rust)

**Files:**
- Modify: `crates/raven/src/cross_file/config.rs:152` (struct field) and `:225` (Default)
- Modify: `crates/raven/src/backend.rs:428` (parser) and `crates/raven/src/backend.rs:~9205` (test module)

**Interfaces:**
- Produces: `CrossFileConfig.model_rprofile: bool` (default `true`); parsed from `packages.rprofilePrelude`.

- [ ] **Step 1: Write the failing parse test**

In `crates/raven/src/backend.rs`, in the config-parse test module (near `parse_cross_file_config_reads_watch_fields`, ~line 9205), add:

```rust
#[test]
fn parse_cross_file_config_reads_model_rprofile() {
    let settings = serde_json::json!({
        "packages": { "rprofilePrelude": false }
    });
    let config = parse_cross_file_config(&settings);
    assert!(!config.model_rprofile, "rprofilePrelude=false must parse");
}

#[test]
fn parse_cross_file_config_model_rprofile_defaults_true() {
    let settings = serde_json::json!({ "packages": {} });
    let config = parse_cross_file_config(&settings);
    assert!(config.model_rprofile, "rprofilePrelude must default to true");
}
```

(If `parse_cross_file_config` takes a different argument shape, mirror the exact call form used by the sibling `parse_cross_file_config_reads_watch_fields` test.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p raven --features test-support parse_cross_file_config_reads_model_rprofile`
Expected: FAIL — `no field model_rprofile on type CrossFileConfig`.

- [ ] **Step 3: Add the struct field**

In `crates/raven/src/cross_file/config.rs`, after `pub package_mode: PackageMode,` (line 152):

```rust
    /// Model a workspace-root `.Rprofile` as a script-scope prelude
    /// (suppressive-only). See `docs/r-package-dev.md` and
    /// `crates/raven/src/package_state/rprofile.rs`.
    pub model_rprofile: bool,
```

- [ ] **Step 4: Add the Default value**

In the `impl Default for CrossFileConfig` block, after `package_mode: PackageMode::Auto,` (line 225):

```rust
            model_rprofile: true,
```

- [ ] **Step 5: Parse the setting**

In `crates/raven/src/backend.rs`, inside the `if let Some(packages) = packages` block, after the `packageMode` arm (after line 434):

```rust
        if let Some(v) = packages.get("rprofilePrelude").and_then(|v| v.as_bool()) {
            config.model_rprofile = v;
        }
```

- [ ] **Step 6: Mark `model_rprofile` as a scope-impacting setting**

`scope_settings_changed` (`crates/raven/src/cross_file/config.rs`, ~line 230) drives `scope_changed` (`backend.rs:6141`), which the config-reload path uses to decide scope-cache handling. The prelude changes resolved scope, so add the field. After `|| self.package_mode != other.package_mode`:

```rust
            || self.model_rprofile != other.model_rprofile
```

Extend the existing scope-change test (search `scope_settings_changed` in `config.rs` tests, ~line 293) with a `model_rprofile`-flip case asserting it returns `true`.

- [ ] **Step 7: Run the tests + gates**

Run: `cargo test -p raven --features test-support parse_cross_file_config_ scope_settings`
Expected: PASS. Then `cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings`.

- [ ] **Step 8: Commit**

```bash
git add crates/raven/src/cross_file/config.rs crates/raven/src/backend.rs
git commit -m "feat(config): add raven.packages.rprofilePrelude setting (default on)"
```

---

## Task 3: Wire the setting into VS Code (three places) + regenerate the settings reference

**Files:**
- Modify: `editors/vscode/package.json:~1306` (after the `packageMode` block)
- Modify: `editors/vscode/src/initializationOptions.ts:89` (interface), `:331` (read), `:333-363` (guard + assign)
- Modify: `editors/vscode/src/test/settings.test.ts:116` (SETTINGS_MAPPING)
- Regenerate: `docs/settings-reference.md`

- [ ] **Step 1: Add the package.json schema entry**

In `editors/vscode/package.json`, immediately after the `raven.packages.packageMode` block (ends ~line 1306), add:

```json
        "raven.packages.rprofilePrelude": {
          "type": "boolean",
          "default": true,
          "description": "Model a workspace-root .Rprofile's top-level source()/library()/assignments as a script-scope prelude, so files where R would source .Rprofile (scripts, data-raw, non-package R/) resolve the helpers it provides. Suppressive only: never introduces a diagnostic."
        },
```

- [ ] **Step 2: Add the TS interface field**

In `editors/vscode/src/initializationOptions.ts`, in the `packages?: { ... }` interface (after `packageMode?: 'auto' | 'enabled' | 'disabled';`, line 89):

```typescript
        rprofilePrelude?: boolean;
```

- [ ] **Step 3: Read and assign the setting**

After `const packageMode = getExplicitSetting<...>(config, 'packages.packageMode');` (line 331):

```typescript
    const rprofilePrelude = getExplicitSetting<boolean>(config, 'packages.rprofilePrelude');
```

Add `rprofilePrelude !== undefined ||` to the `if ( ... )` guard (lines 333-340), and inside the block (after the `packageMode` assignment, ~line 363):

```typescript
        if (rprofilePrelude !== undefined) {
            options.packages.rprofilePrelude = rprofilePrelude;
        }
```

- [ ] **Step 4: Add the SETTINGS_MAPPING entry**

In `editors/vscode/src/test/settings.test.ts`, after the `packages.packageMode` row (line 116):

```typescript
    { vsCodeKey: 'packages.rprofilePrelude', jsonPath: ['packages', 'rprofilePrelude'], type: 'boolean' },
```

- [ ] **Step 5: Regenerate the settings reference**

Run: `bun editors/vscode/scripts/generate-settings-reference.mjs`
This rewrites `docs/settings-reference.md` to include the `raven.packages.rprofilePrelude` row.

- [ ] **Step 6: Run the gating tests**

Run: `bun test tests/bun/settings-reference.test.ts`
Run: `cd editors/vscode && bun test src/test/settings.test.ts` (or the project's documented invocation for the Mocha settings suite — see CLAUDE.md "VS Code settings sync").
Expected: PASS (drift test green, mapping test green).

- [ ] **Step 7: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/initializationOptions.ts editors/vscode/src/test/settings.test.ts docs/settings-reference.md
git commit -m "feat(vscode): expose raven.packages.rprofilePrelude setting"
```

---

## Task 4: The static `.Rprofile` scanner — assignments, libraries, missing file

**Files:**
- Create: `crates/raven/src/package_state/rprofile.rs`
- Modify: `crates/raven/src/package_state/mod.rs:15` (module declaration)

**Interfaces:**
- Produces:
  - `pub struct RprofileScan { pub symbols: BTreeSet<String>, pub attached_packages: BTreeSet<String> }` (derives `Debug, Default, Clone, PartialEq, Eq`).
  - `pub fn scan_workspace_rprofile(workspace_root: &std::path::Path) -> RprofileScan`.
- Consumes: `crate::roxygen::extract_top_level_defs(&str) -> BTreeSet<String>`; `crate::cross_file::source_detect::extract_attached_packages(&str) -> BTreeSet<String>`.

- [ ] **Step 1: Declare the module**

In `crates/raven/src/package_state/mod.rs`, after `pub mod sysdata;` (line 15):

```rust
pub mod rprofile;
```

- [ ] **Step 2: Write the failing tests**

Create `crates/raven/src/package_state/rprofile.rs` with the test module first:

```rust
//! Static (never-executed) scan of a workspace-root `.Rprofile` into a
//! script-scope prelude: the top-level symbol names it binds and the packages
//! it attaches, plus the same harvested transitively from any literal
//! `source()` targets. See `docs/r-package-dev.md` ("`.Rprofile` prelude") and
//! the design spec. Mirrors `scan_own_package_data_dir`: synchronous, disk-only,
//! best-effort, and safe to call when the file is absent.
//!
//! INVARIANT (suppressive-only): this scan only ever *adds* names/packages to a
//! file's scope. Over-harvesting can mask a false positive but can never
//! fabricate a diagnostic, so it deliberately uses Raven's normal top-level
//! scope construction (which includes conditional top-level assignments) and
//! never executes anything.

use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RprofileScan {
    pub symbols: BTreeSet<String>,
    pub attached_packages: BTreeSet<String>,
    /// Canonicalized paths of files followed out of `.Rprofile` via literal
    /// `source()` (the `.Rprofile` file itself is NOT included). Used by the
    /// optional transitive-freshness wiring (Task 12) to rescan when one of
    /// these helper files is edited. Empty in the single-file harvest.
    pub sourced_files: std::collections::BTreeSet<std::path::PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn missing_rprofile_yields_empty() {
        let tmp = TempDir::new().unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert_eq!(scan, RprofileScan::default());
    }

    #[test]
    fn harvests_top_level_assignments() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "my_helper <- function() 1\nCONST = 42\nglob <<- 7\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("my_helper"), "got {:?}", scan.symbols);
        assert!(scan.symbols.contains("CONST"), "got {:?}", scan.symbols);
        assert!(scan.symbols.contains("glob"), "got {:?}", scan.symbols);
    }

    #[test]
    fn harvests_attached_packages() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "library(stringr)\nrequire(dplyr)\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.attached_packages.contains("stringr"), "got {:?}", scan.attached_packages);
        assert!(scan.attached_packages.contains("dplyr"), "got {:?}", scan.attached_packages);
    }

    #[test]
    fn function_body_assignments_are_not_harvested() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".Rprofile"),
            "outer <- function() { local_only <- 1 }\n",
        )
        .unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("outer"));
        assert!(!scan.symbols.contains("local_only"), "function-local must not leak: {:?}", scan.symbols);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p raven --features test-support package_state::rprofile`
Expected: FAIL — `cannot find function scan_workspace_rprofile`.

- [ ] **Step 4: Implement the scanner (single-file harvest)**

Add to `crates/raven/src/package_state/rprofile.rs` (above the test module). Source-following is added in Task 5; here the recursion helper exists but only handles the `.Rprofile` file itself:

```rust
/// Maximum depth of `source()` chains followed out of `.Rprofile`. Mirrors the
/// cross-file `max_chain_depth` default (64) so a profile that sources a large
/// helper tree cannot blow up the scan.
const RPROFILE_MAX_SOURCE_DEPTH: usize = 64;
/// Maximum number of distinct files visited while following `source()` chains
/// (cycle + fan-out guard). Far above any real `.Rprofile` helper tree.
const RPROFILE_MAX_SOURCE_FILES: usize = 1000;

/// Synchronously scan `<workspace_root>/.Rprofile` (never executing it) into a
/// script-scope prelude. Returns empty when the file is absent or unreadable.
pub fn scan_workspace_rprofile(workspace_root: &Path) -> RprofileScan {
    let mut scan = RprofileScan::default();
    let rprofile_path = workspace_root.join(".Rprofile");
    let Ok(text) = std::fs::read_to_string(&rprofile_path) else {
        return scan;
    };
    harvest_file(&text, &mut scan);
    scan
}

/// Harvest top-level defs + attached packages from one file's text into `scan`.
fn harvest_file(text: &str, scan: &mut RprofileScan) {
    for def in crate::roxygen::extract_top_level_defs(text) {
        scan.symbols.insert(def);
    }
    for pkg in crate::cross_file::source_detect::extract_attached_packages(text) {
        scan.attached_packages.insert(pkg);
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p raven --features test-support package_state::rprofile`
Expected: PASS (all four tests).

Note: `function_body_assignments_are_not_harvested` and the conditional-assignment behavior both rely on `extract_top_level_defs` keeping only `function_scope == None` defs (it delegates to `compute_artifacts` + `live_top_level_exports`). If the function-body test unexpectedly fails, STOP and use systematic-debugging — do not work around it; the harvest must match Raven's normal scoping.

- [ ] **Step 6: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_state/rprofile.rs crates/raven/src/package_state/mod.rs
git commit -m "feat(rprofile): static .Rprofile scanner (assignments + attached packages)"
```

---

## Task 5: Scanner — follow literal `source()` (transitive, bounded, renv-aware)

**Files:**
- Modify: `crates/raven/src/package_state/rprofile.rs`

**Interfaces:**
- Consumes: `crate::cross_file::source_detect::detect_source_calls(&tree, content) -> Vec<ForwardSource>` (fields: `path`, `local`, `is_directive`, `is_sys_source`, …); `crate::cross_file::path_resolve::{PathContext, resolve_path_with_workspace_fallback}`; `crate::cross_file::types::CrossFileMetadata`.

- [ ] **Step 1: Write the failing tests**

In the `tests` module of `crates/raven/src/package_state/rprofile.rs`, add:

```rust
    #[test]
    fn follows_literal_source_with_workspace_fallback() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(tmp.path().join("R").join("functions.r"), "r_bind <- function() 1\n").unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"R/functions.r\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("r_bind"), "got {:?}", scan.symbols);
    }

    #[test]
    fn follows_source_transitively() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("R")).unwrap();
        fs::write(tmp.path().join("R").join("r.bind.r"), "r_bind <- function() 1\n").unwrap();
        // functions.r sources r.bind.r; in R this resolves via cwd (root), which
        // Raven models with the workspace-root fallback.
        fs::write(tmp.path().join("R").join("functions.r"), "source(\"R/r.bind.r\")\n").unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"R/functions.r\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("r_bind"), "transitive source must resolve: {:?}", scan.symbols);
    }

    #[test]
    fn attached_packages_followed_through_source() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("setup.R"), "library(tidyr)\nhelper <- function() 1\n").unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"setup.R\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.attached_packages.contains("tidyr"), "got {:?}", scan.attached_packages);
        assert!(scan.symbols.contains("helper"));
    }

    #[test]
    fn skips_renv_activate() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("renv")).unwrap();
        // activate.R defines machinery we must NOT harvest as user globals.
        fs::write(tmp.path().join("renv").join("activate.R"), "should_not_leak <- function() 1\n").unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(\"renv/activate.R\")\nlocal_def <- 1\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(!scan.symbols.contains("should_not_leak"), "renv/activate.R must be skipped: {:?}", scan.symbols);
        assert!(scan.symbols.contains("local_def"), "statements after the renv line still harvest");
    }

    #[test]
    fn local_true_source_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("priv.R"), "private_def <- 1\n").unwrap();
        // source(..., local = TRUE) puts defs in a local env, not globals.
        fs::write(tmp.path().join(".Rprofile"), "source(\"priv.R\", local = TRUE)\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(!scan.symbols.contains("private_def"), "local=TRUE source must not contribute globals: {:?}", scan.symbols);
    }

    #[test]
    fn dynamic_source_path_is_ignored() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".Rprofile"), "source(paste0(\"R/\", \"x.R\"))\nstill_here <- 1\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        // No crash; non-literal source() ignored; sibling assignment still harvested.
        assert!(scan.symbols.contains("still_here"));
    }

    #[test]
    fn conditional_top_level_assignment_is_harvested() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".Rprofile"), "if (interactive()) helper <- function() {}\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(scan.symbols.contains("helper"), "conditional top-level assignment must be harvested: {:?}", scan.symbols);
    }

    #[test]
    fn function_body_source_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("dev.R"), "dev_only <- 1\n").unwrap();
        // source() inside a function body only runs when the fn is called.
        fs::write(tmp.path().join(".Rprofile"), "f <- function() source(\"dev.R\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(!scan.symbols.contains("dev_only"), "function-body source() must not be followed: {:?}", scan.symbols);
        assert!(scan.symbols.contains("f"));
    }

    #[test]
    fn sys_source_without_global_env_is_not_followed() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("priv.R"), "priv_only <- 1\n").unwrap();
        // sys.source() defaults to a non-global env → symbols are not inherited.
        fs::write(tmp.path().join(".Rprofile"), "sys.source(\"priv.R\")\n").unwrap();
        let scan = scan_workspace_rprofile(tmp.path());
        assert!(!scan.symbols.contains("priv_only"), "sys.source() (non-global env) must not contribute globals: {:?}", scan.symbols);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p raven --features test-support package_state::rprofile`
Expected: FAIL — `follows_literal_source_with_workspace_fallback` (and others) fail because source() is not followed yet. (`conditional_top_level_assignment_is_harvested` may already pass — that is fine; it pins the spec-required behavior.)

- [ ] **Step 3: Implement transitive source-following**

Replace `scan_workspace_rprofile` and `harvest_file` in `crates/raven/src/package_state/rprofile.rs` with a worklist-based recursion. Resolve each literal `source()` target with the workspace-root fallback, skip `renv/activate.R`, honor the visited-set + depth/file budgets:

```rust
use tower_lsp::lsp_types::Url;

pub fn scan_workspace_rprofile(workspace_root: &Path) -> RprofileScan {
    let mut scan = RprofileScan::default();
    let rprofile_path = workspace_root.join(".Rprofile");
    let Ok(text) = std::fs::read_to_string(&rprofile_path) else {
        return scan;
    };
    let workspace_url = Url::from_file_path(workspace_root).ok();
    let renv_activate = workspace_root.join("renv").join("activate.R");

    // Worklist of (file_path, file_text, depth). Visited is keyed by the
    // canonicalized path so cycles and re-sources collapse to one visit.
    let mut visited: BTreeSet<std::path::PathBuf> = BTreeSet::new();
    let mut worklist: Vec<(std::path::PathBuf, String, usize)> =
        vec![(rprofile_path.clone(), text, 0)];
    visited.insert(rprofile_path.canonicalize().unwrap_or(rprofile_path));

    while let Some((path, text, depth)) = worklist.pop() {
        harvest_file(&text, &mut scan);
        if depth >= RPROFILE_MAX_SOURCE_DEPTH || visited.len() >= RPROFILE_MAX_SOURCE_FILES {
            continue;
        }
        for target in literal_source_targets(&text) {
            let Some(file_uri) = Url::from_file_path(&path).ok() else { continue };
            let ctx = match crate::cross_file::path_resolve::PathContext::from_metadata(
                &file_uri,
                &crate::cross_file::types::CrossFileMetadata::default(),
                workspace_url.as_ref(),
            ) {
                Some(c) => c,
                None => continue,
            };
            let Some(resolved) =
                crate::cross_file::path_resolve::resolve_path_with_workspace_fallback(&target, &ctx)
            else {
                continue;
            };
            // Skip renv's activate.R (defines internal machinery, no user globals).
            let canonical_resolved = resolved.canonicalize().unwrap_or_else(|_| resolved.clone());
            let canonical_renv = renv_activate.canonicalize().unwrap_or_else(|_| renv_activate.clone());
            if canonical_resolved == canonical_renv || resolved == renv_activate {
                continue;
            }
            if !visited.insert(canonical_resolved.clone()) {
                continue;
            }
            if visited.len() > RPROFILE_MAX_SOURCE_FILES {
                break;
            }
            if let Ok(sourced_text) = std::fs::read_to_string(&resolved) {
                // Record the canonical path so a later edit to this helper can
                // trigger a prelude rescan (Task 12 transitive freshness).
                scan.sourced_files.insert(canonical_resolved.clone());
                worklist.push((resolved, sourced_text, depth + 1));
            }
        }
    }
    scan
}

fn harvest_file(text: &str, scan: &mut RprofileScan) {
    for def in crate::roxygen::extract_top_level_defs(text) {
        scan.symbols.insert(def);
    }
    for pkg in crate::cross_file::source_detect::extract_attached_packages(text) {
        scan.attached_packages.insert(pkg);
    }
}

/// Literal `source()` target paths in `text` that contribute to the GLOBAL /
/// script scope. Excludes:
/// - `# raven:` directives (`is_directive`);
/// - calls that do not inherit symbols — `source(..., local = TRUE)` and
///   `sys.source(...)` without `envir = globalenv()` (`!inherits_symbols()`);
/// - calls lexically inside a function body (`is_function_scoped`) — they only
///   run when that function is invoked, so they are not load-time globals;
/// - non-literal paths (`detect_source_calls` yields an empty `path` for those).
///
/// `detect_source_calls` walks the WHOLE tree (not just top level), so these
/// filters are load-bearing — without them a `.Rprofile` like
/// `f <- function() source("dev.R")` would wrongly pull `dev.R` into the
/// suppressive prelude.
fn literal_source_targets(text: &str) -> Vec<String> {
    use tree_sitter::Parser;
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_r::LANGUAGE.into()).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(text, None) else {
        return Vec::new();
    };
    crate::cross_file::source_detect::detect_source_calls(&tree, text)
        .into_iter()
        .filter(|s| {
            !s.is_directive && s.inherits_symbols() && !s.is_function_scoped && !s.path.is_empty()
        })
        .map(|s| s.path)
        .collect()
}
```

Notes confirmed against the source: `ForwardSource::inherits_symbols()` returns `false` for `local == true` or `is_sys_source && !sys_source_global_env` (`types.rs:371`); `is_function_scoped` is a `ForwardSource` field (`types.rs:333`). `Url::from_file_path(root)` is the in-crate idiom (the directory variant is unused in the repo) — `PathContext::from_metadata` converts the URL back to a path internally, so a trailing slash is irrelevant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p raven --features test-support package_state::rprofile`
Expected: PASS (all tests, including transitive + renv + local + dynamic + conditional).

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_state/rprofile.rs
git commit -m "feat(rprofile): follow literal source() transitively with workspace fallback, skip renv"
```

---

## Task 6: Carry the prelude through `PackageInputs` → `PackageScopeContribution`

**Files:**
- Modify: `crates/raven/src/package_state/mod.rs` (`PackageInputs` ~81; `PackageScopeContribution` ~731)
- Modify: `crates/raven/src/package_state/derive.rs` (`derive_package_state` ~24; `build_scope_contribution` ~55)

**Interfaces:**
- Produces:
  - `PackageInputs.model_rprofile: bool`, `PackageInputs.rprofile_symbols: BTreeSet<String>`, `PackageInputs.rprofile_attached_packages: BTreeSet<String>`.
  - `PackageScopeContribution.rprofile_symbols: Arc<BTreeSet<String>>`, `.rprofile_attached_packages: Arc<BTreeSet<String>>`, `.rprofile_root: Option<PathBuf>`.

- [ ] **Step 1: Write the failing derive tests**

In `crates/raven/src/package_state/derive.rs` test module, add:

```rust
    #[test]
    fn contribution_carries_rprofile_symbols_in_package_mode() {
        let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
        inputs.rprofile_symbols.insert("r_bind".to_string());
        inputs.rprofile_attached_packages.insert("stringr".to_string());
        let s = derive_package_state(&PackageState::new(), &inputs, &PackageInputDelta::Initial);
        let c = s.scope_contribution();
        assert!(c.rprofile_symbols.contains("r_bind"));
        assert!(c.rprofile_attached_packages.contains("stringr"));
        assert_eq!(c.rprofile_root, inputs.workspace_root);
        // package mode active → workspace_root is Some
        assert!(c.workspace_root.is_some());
    }

    #[test]
    fn contribution_carries_rprofile_symbols_in_script_mode() {
        // No DESCRIPTION + Auto → no package workspace, but the prelude must
        // still be carried (script-mode R/ inclusion depends on this).
        let mut inputs = empty_inputs(PackageMode::Auto);
        inputs.workspace_root = Some(std::path::PathBuf::from("/work"));
        inputs.rprofile_symbols.insert("zz".to_string());
        let s = derive_package_state(&PackageState::new(), &inputs, &PackageInputDelta::Initial);
        let c = s.scope_contribution();
        assert!(c.rprofile_symbols.contains("zz"), "prelude must survive in script mode");
        assert_eq!(c.rprofile_root.as_deref(), Some(std::path::Path::new("/work")));
        // script mode → no package workspace
        assert!(c.workspace_root.is_none());
    }
```

Confirm `empty_inputs` / `with_description` produce a `workspace_root`; if `empty_inputs` leaves it `None`, set it explicitly as shown.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p raven --features test-support package_state::derive::tests::contribution_carries_rprofile`
Expected: FAIL — `no field rprofile_symbols on type PackageInputs`.

- [ ] **Step 3: Add the `PackageInputs` fields**

In `crates/raven/src/package_state/mod.rs`, in `PackageInputs` (after `sysdata_names`, ~line 96):

```rust
    /// Whether `.Rprofile` prelude modeling is enabled (mirrors
    /// `CrossFileConfig.model_rprofile`). Carried here so the watched-file
    /// `translate` path can gate the scan without reaching for config.
    /// Set by `initialize_package_inputs_from_state`; `Default` is `false`
    /// (seeders set the real value from config, which defaults `true`).
    pub model_rprofile: bool,
    /// Top-level symbol names introduced by the workspace-root `.Rprofile`
    /// (and its transitive literal `source()` targets). Populated by
    /// `rprofile::scan_workspace_rprofile`. Empty when modeling is off or the
    /// file is absent.
    pub rprofile_symbols: BTreeSet<String>,
    /// Packages attached (top-level `library()`/`require()`) by the
    /// workspace-root `.Rprofile` and its transitive `source()` targets.
    pub rprofile_attached_packages: BTreeSet<String>,
    /// Canonical paths of helper files the prelude followed via `source()`
    /// (from `RprofileScan::sourced_files`). Used by the optional
    /// transitive-freshness wiring (Task 12) to rescan when a sourced helper is
    /// edited. Not carried onto the contribution (watch-routing only).
    pub rprofile_sourced_files: BTreeSet<PathBuf>,
```

- [ ] **Step 4: Add the `PackageScopeContribution` fields**

In `PackageScopeContribution` (after `onload_symbols`, ~line 826):

```rust
    /// Symbol names contributed by a workspace-root `.Rprofile` prelude
    /// (assignments + transitive `source()` defs). Injected by
    /// `append_rprofile_prelude` into files where R would source `.Rprofile`
    /// (gated by `rprofile_withheld_in_package_mode` in package mode).
    /// Suppressive-only.
    pub rprofile_symbols: Arc<BTreeSet<String>>,
    /// Packages attached by the `.Rprofile` prelude. Added to a file's
    /// `inherited_packages` under the same applicability rule.
    pub rprofile_attached_packages: Arc<BTreeSet<String>>,
    /// Workspace root used for the `.Rprofile` prelude's path-containment and
    /// applicability checks. Set whenever a workspace root is known (BOTH
    /// package and script mode) — deliberately distinct from `workspace_root`,
    /// which is `Some` only in package mode. `None` when no root is known.
    pub rprofile_root: Option<PathBuf>,
```

- [ ] **Step 5: Thread inputs into the derivation**

In `crates/raven/src/package_state/derive.rs`, update the `build_scope_contribution` call in `derive_package_state` (line 39) to pass the new inputs:

```rust
    let scope_contribution = build_scope_contribution(
        &workspace,
        &namespace_model,
        &r_file_facts,
        inputs.description.as_ref(),
        &inputs.dataset_names,
        &inputs.sysdata_names,
        &inputs.rprofile_symbols,
        &inputs.rprofile_attached_packages,
        inputs.workspace_root.clone(),
    );
```

Change `build_scope_contribution`'s signature (line 55) to add:

```rust
    rprofile_symbols: &BTreeSet<String>,
    rprofile_attached_packages: &BTreeSet<String>,
    rprofile_root: Option<PathBuf>,
```

Restructure its body so the prelude is carried **even when there is no package workspace**. Replace the `let Some(ws) = workspace else { return PackageScopeContribution::default(); };` early-return with a build-then-augment shape:

```rust
fn build_scope_contribution(
    workspace: &Option<PackageWorkspace>,
    namespace_model: &Option<PackageNamespaceModel>,
    r_file_facts: &BTreeMap<PathBuf, RFileFacts>,
    description: Option<&DescriptionInput>,
    dataset_names: &BTreeSet<String>,
    sysdata_names: &BTreeSet<String>,
    rprofile_symbols: &BTreeSet<String>,
    rprofile_attached_packages: &BTreeSet<String>,
    rprofile_root: Option<PathBuf>,
) -> PackageScopeContribution {
    let mut contrib = match workspace {
        Some(ws) => {
            // ... EXISTING package-mode contribution build, unchanged ...
            // (the existing loop over r_file_facts, namespace imports, etc.,
            //  ending in the `PackageScopeContribution { ... }` literal — keep
            //  every existing field assignment, and add the three new fields
            //  with placeholder values that Step 6 overwrites, OR set them here
            //  directly from the params)
            PackageScopeContribution {
                workspace_root: Some(ws.root.clone()),
                // ... all existing fields ...
                rprofile_symbols: Arc::new(rprofile_symbols.clone()),
                rprofile_attached_packages: Arc::new(rprofile_attached_packages.clone()),
                rprofile_root: rprofile_root.clone(),
            }
        }
        None => PackageScopeContribution {
            rprofile_symbols: Arc::new(rprofile_symbols.clone()),
            rprofile_attached_packages: Arc::new(rprofile_attached_packages.clone()),
            rprofile_root,
            ..PackageScopeContribution::default()
        },
    };
    let _ = &mut contrib; // (no further mutation needed)
    contrib
}
```

(Practically: keep the existing `Some(ws)` body intact and just add the three new fields to its returned struct literal; in the `None` arm return a default with only the three prelude fields set. The `let _ = &mut contrib;` line is unnecessary — drop it; shown only to indicate `contrib` is the return value.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p raven --features test-support package_state::derive`
Expected: PASS. The compiler will also flag two families of exhaustive struct literals that now miss the new fields — fix each (compiler-guided):

- **`PackageInputs { ... }`** (e.g. `derive.rs` `empty_inputs`/`with_description`, `proptest_machine::initial_inputs`, `handlers.rs` ~28972, `event.rs` test helpers): add `model_rprofile: false, rprofile_symbols: BTreeSet::new(), rprofile_attached_packages: BTreeSet::new(), rprofile_sourced_files: BTreeSet::new(),` (or `..Default::default()` if already used).
- **`PackageScopeContribution { ... }`** — there are MANY (the real builder in `derive.rs:157` you just edited, plus test fixtures at `handlers.rs:25574,25658,25729,26110,28547,28633` and similar in `scope.rs`). For the test fixtures, append `..PackageScopeContribution::default()` (cleanest) or add the three new fields explicitly. The real builder in `derive.rs` was already updated in Step 5.

Re-run `cargo build -p raven --features test-support` (or the test command) until it compiles green.

- [ ] **Step 7: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_state/mod.rs crates/raven/src/package_state/derive.rs
git commit -m "feat(rprofile): carry prelude symbols through inputs and scope contribution"
```

---

## Task 7: Seed the scan at startup (LSP + `raven check`)

**Files:**
- Modify: `crates/raven/src/backend.rs` (`initialize_package_inputs_from_state` ~1763)

**Interfaces:**
- Consumes: `crate::package_state::rprofile::scan_workspace_rprofile`; `state.cross_file_config.model_rprofile`.

- [ ] **Step 1: Write the failing test**

In `crates/raven/src/backend.rs` test module (near the existing test at ~8688 that calls `initialize_package_inputs_from_state`), add:

```rust
#[tokio::test]
async fn initialize_package_inputs_scans_rprofile() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir_all(root.join("R")).unwrap();
    std::fs::write(root.join("R").join("functions.r"), "r_bind <- function() 1\n").unwrap();
    std::fs::write(root.join(".Rprofile"), "source(\"R/functions.r\")\nmy_helper <- function() 1\n").unwrap();

    let mut state = WorldState::new();
    // model_rprofile defaults true in CrossFileConfig.
    let disk_seed = collect_package_r_file_inputs_from_disk(root);
    initialize_package_inputs_from_state(
        &mut state,
        root.to_path_buf(),
        Some("Package: pkg\n".into()),
        None,
        disk_seed,
    );

    assert!(state.package_inputs.model_rprofile);
    assert!(state.package_inputs.rprofile_symbols.contains("my_helper"), "got {:?}", state.package_inputs.rprofile_symbols);
    assert!(state.package_inputs.rprofile_symbols.contains("r_bind"), "got {:?}", state.package_inputs.rprofile_symbols);
}

#[tokio::test]
async fn initialize_package_inputs_skips_rprofile_when_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::write(root.join(".Rprofile"), "my_helper <- function() 1\n").unwrap();
    let mut state = WorldState::new();
    state.cross_file_config.model_rprofile = false;
    initialize_package_inputs_from_state(&mut state, root.to_path_buf(), None, None, Default::default());
    assert!(state.package_inputs.rprofile_symbols.is_empty(), "disabled → no scan");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p raven --features test-support initialize_package_inputs_scans_rprofile`
Expected: FAIL — `rprofile_symbols` empty (no scan wired yet).

- [ ] **Step 3: Wire the scan into seeding**

In `initialize_package_inputs_from_state` (`crates/raven/src/backend.rs`), after `state.package_inputs.package_mode = state.cross_file_config.package_mode;` (line 1771) add:

```rust
    state.package_inputs.model_rprofile = state.cross_file_config.model_rprofile;
```

And after `state.package_inputs.sysdata_names = ...` (line 1782) add:

```rust
    let rprofile_scan = if state.package_inputs.model_rprofile {
        crate::package_state::rprofile::scan_workspace_rprofile(&root)
    } else {
        crate::package_state::rprofile::RprofileScan::default()
    };
    state.package_inputs.rprofile_symbols = rprofile_scan.symbols;
    state.package_inputs.rprofile_attached_packages = rprofile_scan.attached_packages;
    state.package_inputs.rprofile_sourced_files = rprofile_scan.sourced_files;
```

(`root` is in scope — it is the function's `root` parameter, used just above for the data scans. This runs before `state.apply_package_event(&Initial)` at line 1783, so the derived contribution sees the prelude.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p raven --features test-support initialize_package_inputs`
Expected: PASS. (`raven check` reaches this via `build_indexed_state`, so the CLI is covered too.)

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/backend.rs
git commit -m "feat(rprofile): scan workspace .Rprofile when seeding package inputs"
```

---

## Task 8: Inject the prelude into a file's scope (Phase 5a)

**Files:**
- Modify: `crates/raven/src/package_state/mod.rs` (add `is_built_doc_dir_path`, `rprofile_withheld_in_package_mode`)
- Modify: `crates/raven/src/cross_file/scope.rs` (`append_rprofile_prelude`; call site ~6668; `compute_contribution_symbol_names` ~6747)

**Interfaces:**
- Produces:
  - `pub fn is_built_doc_dir_path(path: &Path, workspace_root: &Path) -> bool` (true for `vignettes/`/`man/`/`demo/` R files; narrower than `is_dev_context_path` — excludes `data-raw/`).
  - `pub fn rprofile_withheld_in_package_mode(path: &Path, workspace_root: &Path) -> bool`.
  - `pub(crate) fn append_rprofile_prelude(scope: &mut ScopeAtPosition, uri: &Url, contrib: &PackageScopeContribution)`.

- [ ] **Step 1: Write the failing path-helper tests**

In `crates/raven/src/package_state/mod.rs` (`path_tests` module), add:

```rust
    #[test]
    fn built_doc_dir_path_matches_vignettes_man_demo_only() {
        let root = Path::new("/work/pkg");
        assert!(is_built_doc_dir_path(Path::new("/work/pkg/vignettes/v.R"), root));
        assert!(is_built_doc_dir_path(Path::new("/work/pkg/man/ex.R"), root));
        assert!(is_built_doc_dir_path(Path::new("/work/pkg/demo/d.R"), root));
        // data-raw is APPLIED to (not a built doc dir) — narrower than is_dev_context_path.
        assert!(!is_built_doc_dir_path(Path::new("/work/pkg/data-raw/prep.R"), root));
        assert!(!is_built_doc_dir_path(Path::new("/work/pkg/scripts/a.R"), root));
    }

    #[test]
    fn rprofile_withheld_covers_namespace_tests_built_dirs() {
        let root = Path::new("/work/pkg");
        assert!(rprofile_withheld_in_package_mode(Path::new("/work/pkg/R/f.R"), root));
        assert!(rprofile_withheld_in_package_mode(Path::new("/work/pkg/tests/testthat/test-x.R"), root));
        assert!(rprofile_withheld_in_package_mode(Path::new("/work/pkg/tests/foo.R"), root));
        assert!(rprofile_withheld_in_package_mode(Path::new("/work/pkg/vignettes/v.R"), root));
        // applied-to dirs are NOT withheld
        assert!(!rprofile_withheld_in_package_mode(Path::new("/work/pkg/scripts/a.R"), root));
        assert!(!rprofile_withheld_in_package_mode(Path::new("/work/pkg/data-raw/prep.R"), root));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p raven --features test-support package_state::path_tests::rprofile_withheld`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement the path helpers**

In `crates/raven/src/package_state/mod.rs`, after `is_dev_context_path` (line 255):

```rust
/// True when `path` is an R file under the package's built/checked doc dirs
/// (`vignettes/`, `man/`, `demo/`) — rebuilt by `R CMD build` / run by
/// `R CMD check` with the user profile suppressed. Used (in package mode only)
/// to withhold the `.Rprofile` prelude. DELIBERATELY NARROWER than
/// [`is_dev_context_path`]: `data-raw/` is dev-only, `.Rbuildignore`d, and run
/// interactively from the root, so the prelude APPLIES there.
pub fn is_built_doc_dir_path(path: &Path, workspace_root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(workspace_root) else {
        return false;
    };
    let is_r_extension = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("R" | "r" | "Rmd" | "rmd" | "qmd")
    );
    if !is_r_extension {
        return false;
    }
    let Some(first) = rel.components().next().and_then(|c| c.as_os_str().to_str()) else {
        return false;
    };
    matches!(first, "vignettes" | "man" | "demo")
}

/// In package mode, the `.Rprofile` prelude is withheld from files whose
/// canonical run context is a profile-suppressed `R CMD check` / `build`
/// session: namespace `R/` (Source) and all test files (via
/// [`is_r_source_path`]), plus built doc dirs (via [`is_built_doc_dir_path`]).
/// Callers apply this ONLY when a package workspace is active — in script mode
/// the prelude applies everywhere, including `R/`.
pub fn rprofile_withheld_in_package_mode(path: &Path, workspace_root: &Path) -> bool {
    is_r_source_path(path, workspace_root).is_some() || is_built_doc_dir_path(path, workspace_root)
}
```

- [ ] **Step 4: Run path-helper tests**

Run: `cargo test -p raven --features test-support package_state::path_tests`
Expected: PASS.

- [ ] **Step 5: Write the failing injection test**

In `crates/raven/src/cross_file/scope.rs` (find the test module that exercises `append_package_contribution`; search `append_package_contribution` in tests), add tests that build a `PackageScopeContribution` with prelude fields and assert `append_rprofile_prelude` injects under the applicability rule. Mirror the construction style of existing contribution tests. Skeleton:

```rust
    fn prelude_contrib(root: &std::path::Path, package_mode: bool) -> crate::package_state::PackageScopeContribution {
        let mut c = crate::package_state::PackageScopeContribution::default();
        if package_mode {
            c.workspace_root = Some(root.to_path_buf());
            c.package_name = Some("pkg".into());
        }
        c.rprofile_root = Some(root.to_path_buf());
        c.rprofile_symbols = std::sync::Arc::new(["r_bind".to_string()].into_iter().collect());
        c.rprofile_attached_packages = std::sync::Arc::new(["stringr".to_string()].into_iter().collect());
        c
    }

    #[test]
    fn rprofile_prelude_injects_into_scripts_in_package_mode() {
        let root = std::path::Path::new("/work/pkg");
        let uri = Url::from_file_path("/work/pkg/scripts/a.R").unwrap();
        let mut scope = ScopeAtPosition::default(); // use the crate's actual constructor
        append_rprofile_prelude(&mut scope, &uri, &prelude_contrib(root, true));
        assert!(scope.symbols.contains_key("r_bind"));
        assert!(scope.inherited_packages.contains("stringr"));
    }

    #[test]
    fn rprofile_prelude_withheld_from_package_R_dir() {
        let root = std::path::Path::new("/work/pkg");
        let uri = Url::from_file_path("/work/pkg/R/uses_zz.R").unwrap();
        let mut scope = ScopeAtPosition::default();
        append_rprofile_prelude(&mut scope, &uri, &prelude_contrib(root, true));
        assert!(!scope.symbols.contains_key("r_bind"), "namespace R/ must not get the prelude in package mode");
    }

    #[test]
    fn rprofile_prelude_applies_to_R_dir_in_script_mode() {
        let root = std::path::Path::new("/work/proj");
        let uri = Url::from_file_path("/work/proj/R/uses_zz.R").unwrap();
        let mut scope = ScopeAtPosition::default();
        append_rprofile_prelude(&mut scope, &uri, &prelude_contrib(root, false));
        assert!(scope.symbols.contains_key("r_bind"), "script-mode R/ is ordinary scripts → prelude applies");
    }

    #[test]
    fn rprofile_prelude_does_not_overwrite_local_definition() {
        let root = std::path::Path::new("/work/pkg");
        let uri = Url::from_file_path("/work/pkg/scripts/a.R").unwrap();
        let mut scope = ScopeAtPosition::default();
        // Pre-insert a local r_bind; the prelude must not overwrite it.
        // (construct a ScopedSymbol the same way other scope tests do)
        // ... insert local symbol named "r_bind" ...
        append_rprofile_prelude(&mut scope, &uri, &prelude_contrib(root, true));
        // assert the local definition's source_uri is unchanged (not PACKAGE_INTERNAL_URI)
    }
```

Adjust `ScopeAtPosition::default()` / `ScopedSymbol` construction to the crate's real APIs (copy from a neighboring test in the same module).

- [ ] **Step 6: Run to verify failure**

Run: `cargo test -p raven --features test-support rprofile_prelude_injects`
Expected: FAIL — `append_rprofile_prelude` not found.

- [ ] **Step 7: Implement `append_rprofile_prelude` and the call site**

In `crates/raven/src/cross_file/scope.rs`, add after `append_package_contribution` (after ~line 7160):

```rust
/// Inject the `.Rprofile` prelude (issue: script-scope prelude) into a queried
/// file's scope at Phase 5a. Independent of the package-mode contribution:
/// applies in BOTH package and script mode, gated by
/// [`rprofile_withheld_in_package_mode`] in package mode only. Additive /
/// suppressive only — never overwrites an existing binding (so local and
/// cross-file defs win), and the attached packages flow to `inherited_packages`
/// exactly like a helper-file `library()` attach.
pub(crate) fn append_rprofile_prelude(
    scope: &mut ScopeAtPosition,
    uri: &Url,
    contrib: &crate::package_state::PackageScopeContribution,
) {
    let Some(root) = contrib.rprofile_root.as_ref() else {
        return;
    };
    if contrib.rprofile_symbols.is_empty() && contrib.rprofile_attached_packages.is_empty() {
        return;
    }
    let Ok(path) = uri.to_file_path() else {
        return;
    };
    if path.strip_prefix(root).is_err() {
        return; // only files under the workspace root
    }
    // `workspace_root.is_some()` ⇔ a package workspace is active (package mode).
    let package_mode_active = contrib.workspace_root.is_some();
    if package_mode_active && crate::package_state::rprofile_withheld_in_package_mode(&path, root) {
        return;
    }
    let pkg_uri = Url::parse(PACKAGE_INTERNAL_URI)
        .unwrap_or_else(|_| Url::parse("package:internal").unwrap());
    for sym in contrib.rprofile_symbols.iter() {
        let name: Arc<str> = Arc::from(sym.as_str());
        scope
            .symbols
            .entry(name.clone())
            .or_insert_with(|| ScopedSymbol {
                name,
                kind: SymbolKind::Variable,
                source_uri: pkg_uri.clone(),
                defined_line: 0,
                defined_column: 0,
                defined_end_column: crate::utf16::utf16_len(sym.as_str()),
                signature: None,
                is_declared: false,
            });
    }
    for pkg in contrib.rprofile_attached_packages.iter() {
        scope.inherited_packages.insert(pkg.clone());
    }
}
```

Call it from **BOTH** package-contribution injection sites — the prelude must be applied wherever `append_package_contribution` is.

Site 1 — the recursive resolver's Phase 5a (`scope.rs:6662-6669`), right after `append_package_contribution`:

```rust
    if current_depth == 0
        && let Some(contrib) = package_contribution
    {
        let dev_load_all = get_artifacts(uri)
            .map(|a| a.calls_dev_load_all)
            .unwrap_or(false);
        append_package_contribution(&mut scope, uri, contrib, dev_load_all);
        append_rprofile_prelude(&mut scope, uri, contrib);
    }
```

Site 2 — **`ScopeStream::snapshot()` (`scope.rs:8086-8093`)**. This is the path the diagnostics pipeline actually uses (`handlers.rs` builds scope via `ScopeStream`), so omitting it would make every acceptance test fail. After the existing `append_package_contribution` call:

```rust
        if let Some(contrib) = self.package_contribution {
            append_package_contribution(
                &mut scope,
                self.queried_uri,
                contrib,
                self.artifacts.calls_dev_load_all,
            );
            append_rprofile_prelude(&mut scope, self.queried_uri, contrib);
        }
```

- [ ] **Step 8: Mirror prelude names in `compute_contribution_symbol_names`**

So `is_visible` / `symbol_for` agree with `snapshot()` (avoids "used before available" misattribution on prelude symbols). In `compute_contribution_symbol_names` (line 6747), after `let Some(contrib) = contribution else { return out; };` and BEFORE the `let Some(root) = contrib.workspace_root.as_ref() else { return out; };` early-return, add a prelude block keyed off `rprofile_root` (so it runs in script mode too):

```rust
    // `.Rprofile` prelude names — independent of the package workspace, so this
    // runs before the `workspace_root` early-return below (script mode has no
    // workspace_root but still gets the prelude). Mirrors `append_rprofile_prelude`'s
    // applicability gate. Attached packages contribute no symbol NAMES here
    // (their exports resolve via the package library), so only `rprofile_symbols`.
    if let Some(rprofile_root) = contrib.rprofile_root.as_ref()
        && let Ok(qpath) = queried_uri.to_file_path()
        && qpath.strip_prefix(rprofile_root).is_ok()
    {
        let package_mode_active = contrib.workspace_root.is_some();
        if !(package_mode_active
            && crate::package_state::rprofile_withheld_in_package_mode(&qpath, rprofile_root))
        {
            for sym in contrib.rprofile_symbols.iter() {
                out.insert(Arc::from(sym.as_str()));
            }
        }
    }
```

- [ ] **Step 9: Run the injection tests + gates**

Run: `cargo test -p raven --features test-support rprofile_prelude`
Expected: PASS. Then fmt + clippy.

- [ ] **Step 10: Commit**

```bash
git add crates/raven/src/package_state/mod.rs crates/raven/src/cross_file/scope.rs
git commit -m "feat(rprofile): inject .Rprofile prelude into script-scope at Phase 5a"
```

---

## Task 9: End-to-end acceptance tests (static cases 1–8, 10, 11)

Exercises the full pipeline through the `raven check` harness (`collect_diagnostics_blocking`), which also satisfies acceptance case 10 (`raven check` parity). Case 9 (live update) is in Task 10.

**Files:**
- Modify: `crates/raven/src/cli/check.rs` (tests module, near `base_args` ~1120 and `collect_diagnostics_blocking` ~1786)

- [ ] **Step 1: Write a small assertion helper + the fixtures**

In the `check.rs` tests module, add a helper and the cases. Helper:

```rust
    /// True if any diagnostic on any target is an "Undefined variable" for `name`.
    fn has_undefined(diags: &[(PathBuf, Diagnostic)], name: &str) -> bool {
        diags.iter().any(|(_, d)| {
            d.message.starts_with("Undefined variable")
                && d.message.contains(name)
        })
    }

    fn args_for(root: &Path, target: &Path) -> CheckArgs {
        let mut a = base_args(root);
        a.paths = vec![target.to_path_buf()];
        a
    }
```

- [ ] **Step 2: Case 1 — resolution via `.Rprofile` source()**

```rust
    #[test]
    fn acceptance_1_resolution_via_rprofile_source() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::create_dir(root.join("R")).unwrap();
        fs::write(root.join("R").join("functions.r"), "r_bind <- function(...) 1\n").unwrap();
        fs::write(root.join(".Rprofile"), "source(\"R/functions.r\")\n").unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        let foo = root.join("scripts").join("foo.R");
        fs::write(&foo, "r_bind(1, 2)\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &foo));
        assert!(!has_undefined(&diags, "r_bind"), "prelude must resolve r_bind: {:?}", diags);
    }
```

- [ ] **Step 3: Cases 2, 3, 11 — assignment, library, conditional**

```rust
    #[test]
    fn acceptance_2_resolution_via_rprofile_assignment() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::write(root.join(".Rprofile"), "my_helper <- function() {}\n").unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        let foo = root.join("scripts").join("foo.R");
        fs::write(&foo, "my_helper()\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &foo));
        assert!(!has_undefined(&diags, "my_helper"), "{:?}", diags);
    }

    #[test]
    fn acceptance_11_conditional_top_level_assignment() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::write(root.join(".Rprofile"), "if (interactive()) helper <- function() {}\n").unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        let foo = root.join("scripts").join("foo.R");
        fs::write(&foo, "helper()\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &foo));
        assert!(!has_undefined(&diags, "helper"), "{:?}", diags);
    }
```

(Case 3, `library(stringr)` → `str_to_sentence()`, requires the package library to know `stringr`'s exports. If the test environment has no R/installed `stringr`, assert the weaker invariant that the prelude adds `stringr` to inherited packages via a unit test on the contribution instead, and note it. Prefer a self-package version: `.Rprofile` does `library(pkg)` where `pkg` is the workspace package — but exports need the library too. Keep case 3 as a contribution-level assertion if package-library resolution is unavailable in the harness; document the limitation in the test comment.)

- [ ] **Step 4: Cases 4, 5 — package-mode exclusions (still fire)**

```rust
    #[test]
    fn acceptance_4_package_mode_excludes_R_dir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::write(root.join(".Rprofile"), "zz <- 1\n").unwrap();
        fs::create_dir(root.join("R")).unwrap();
        let uses = root.join("R").join("uses_zz.R");
        fs::write(&uses, "f <- function() zz\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &uses));
        assert!(has_undefined(&diags, "zz"), "namespace R/ must NOT get the prelude: {:?}", diags);
    }

    #[test]
    fn acceptance_5_package_mode_excludes_tests() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::write(root.join(".Rprofile"), "zz <- 1\n").unwrap();
        fs::create_dir_all(root.join("tests").join("testthat")).unwrap();
        let testf = root.join("tests").join("testthat").join("test-x.R");
        fs::write(&testf, "test_that('x', { zz })\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &testf));
        assert!(has_undefined(&diags, "zz"), "tests must NOT get the prelude: {:?}", diags);
    }
```

(If `test_that(...)` introduces other diagnostics that interfere, simplify the test body to a bare `zz` reference at top level of the test file.)

- [ ] **Step 4b: Applicability e2e — `data-raw/` applies, `vignettes/` withholds (package mode)**

The path-helper unit tests (Task 8) are necessary but not sufficient; assert end-to-end that the spec's apply/withhold split holds for `data-raw/` vs a built doc dir:

```rust
    #[test]
    fn acceptance_applicability_data_raw_gets_prelude() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::write(root.join(".Rprofile"), "zz <- 1\n").unwrap();
        fs::create_dir(root.join("data-raw")).unwrap();
        let prep = root.join("data-raw").join("prep.R");
        fs::write(&prep, "f <- function() zz\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &prep));
        assert!(!has_undefined(&diags, "zz"), "data-raw/ must get the prelude (dev-only, run from root): {:?}", diags);
    }

    #[test]
    fn acceptance_applicability_vignettes_withholds_prelude() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::write(root.join(".Rprofile"), "zz <- 1\n").unwrap();
        fs::create_dir(root.join("vignettes")).unwrap();
        let vig = root.join("vignettes").join("intro.R");
        fs::write(&vig, "f <- function() zz\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &vig));
        assert!(has_undefined(&diags, "zz"), "vignettes/ must NOT get the prelude (rebuilt under R CMD check): {:?}", diags);
    }
```

(If `vignettes/*.R` is not classified as a workspace R file by the harness, use `vignettes/intro.Rmd` with an R chunk that references `zz`, or assert via `compute_contribution_symbol_names`/the path helper that `vignettes/` is withheld. Keep the `data-raw/` case as the primary apply assertion.)

- [ ] **Step 5: Case 6 — script-mode `R/` inclusion**

```rust
    #[test]
    fn acceptance_6_script_mode_includes_R_dir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // NO DESCRIPTION → script mode. R/ is ordinary scripts here.
        fs::write(root.join(".Rprofile"), "zz <- 1\n").unwrap();
        fs::create_dir(root.join("R")).unwrap();
        let uses = root.join("R").join("uses_zz.R");
        fs::write(&uses, "f <- function() zz\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &uses));
        assert!(!has_undefined(&diags, "zz"), "script-mode R/ must get the prelude: {:?}", diags);
    }
```

- [ ] **Step 6: Cases 7, 8 — renv no-op + no fabricated diagnostics**

```rust
    #[test]
    fn acceptance_7_renv_noop() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("renv")).unwrap();
        fs::write(root.join("renv").join("activate.R"), "x <- 1\n").unwrap();
        fs::write(root.join(".Rprofile"), "source(\"renv/activate.R\")\n").unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        let foo = root.join("scripts").join("foo.R");
        fs::write(&foo, "genuinely_undefined\n").unwrap();
        let diags = collect_diagnostics_blocking(&args_for(root, &foo));
        assert!(has_undefined(&diags, "genuinely_undefined"), "renv must be a no-op; real bugs still flag: {:?}", diags);
    }

    #[test]
    fn acceptance_8_no_fabricated_diagnostics() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(root.join("DESCRIPTION"), "Package: pkg\n").unwrap();
        fs::create_dir(root.join("scripts")).unwrap();
        let foo = root.join("scripts").join("foo.R");
        fs::write(&foo, "ok <- 1\nok\n").unwrap();
        // Baseline: no .Rprofile.
        let baseline = collect_diagnostics_blocking(&args_for(root, &foo));
        // Add a .Rprofile; the diagnostic set must not GAIN anything.
        fs::write(root.join(".Rprofile"), "helper <- function() 1\n").unwrap();
        let with_profile = collect_diagnostics_blocking(&args_for(root, &foo));
        assert!(
            with_profile.len() <= baseline.len(),
            "prelude is suppressive-only; must not add diagnostics. baseline={:?} with={:?}",
            baseline, with_profile
        );
    }
```

- [ ] **Step 7: Run all acceptance tests + gates**

Run: `cargo test -p raven --features test-support acceptance_`
Expected: PASS (case 3 per its documented form). Then fmt + clippy.

- [ ] **Step 8: Commit**

```bash
git add crates/raven/src/cli/check.rs
git commit -m "test(rprofile): end-to-end acceptance cases 1-8, 10, 11 via raven check"
```

---

## Task 10: Watch `.Rprofile` + live update (case 9) + setting toggle

**Files:**
- Modify: `crates/raven/src/package_state/mod.rs` (`PackageInputDelta` ~137)
- Modify: `crates/raven/src/package_state/event.rs` (`translate_watched` ~117; tests)
- Modify: `crates/raven/src/backend.rs` (manifest routing ~4982; republish set ~5053; `model_rprofile` re-init ~6195)
- Modify: `editors/vscode/src/extension.ts` (~272, `fileEvents`)

**Interfaces:**
- Produces: `PackageInputDelta::RProfileChanged`.

- [ ] **Step 1: Add the delta variant**

In `crates/raven/src/package_state/mod.rs`, in `PackageInputDelta` (after `DataDirChanged,`):

```rust
    RProfileChanged,
```

- [ ] **Step 2: Write the failing event test**

In `crates/raven/src/package_state/event.rs` tests, add (mirror `watched_data_raw_directory_event_refreshes_sysdata_names` ~794):

```rust
    #[test]
    fn watched_rprofile_change_rescans_and_emits_delta() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.model_rprofile = true;
        std::fs::write(root.join(".Rprofile"), "my_helper <- function() 1\n").unwrap();
        let uri = tower_lsp::lsp_types::Url::from_file_path(root.join(".Rprofile")).unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged { uri, on_disk_text: None, deleted: false },
        );
        assert_eq!(delta, Some(PackageInputDelta::RProfileChanged));
        assert!(inputs.rprofile_symbols.contains("my_helper"), "got {:?}", inputs.rprofile_symbols);
    }

    #[test]
    fn watched_rprofile_delete_clears_symbols() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.model_rprofile = true;
        inputs.rprofile_symbols.insert("old".to_string());
        let uri = tower_lsp::lsp_types::Url::from_file_path(root.join(".Rprofile")).unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged { uri, on_disk_text: None, deleted: true },
        );
        assert_eq!(delta, Some(PackageInputDelta::RProfileChanged));
        assert!(inputs.rprofile_symbols.is_empty());
    }

    #[test]
    fn watched_rprofile_change_is_noop_when_disabled() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.model_rprofile = false;
        std::fs::write(root.join(".Rprofile"), "my_helper <- function() 1\n").unwrap();
        let uri = tower_lsp::lsp_types::Url::from_file_path(root.join(".Rprofile")).unwrap();
        let delta = translate(
            &mut inputs,
            HandlerEvent::WatchedFileChanged { uri, on_disk_text: None, deleted: false },
        );
        // Disabled: no rescan, no symbols. (Delta may be None.)
        assert!(inputs.rprofile_symbols.is_empty());
        let _ = delta;
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p raven --features test-support watched_rprofile`
Expected: FAIL.

- [ ] **Step 4: Handle `.Rprofile` in `translate_watched`**

In `crates/raven/src/package_state/event.rs`, in `translate_watched`, add an arm BEFORE the `is_r_source_path` arm (so a root `.Rprofile` is never mistaken for an R-source/data path). Insert after the NAMESPACE block (after line 157):

```rust
    let canonical_rprofile = canonical_root.join(".Rprofile");
    if canonical_path == canonical_rprofile || path == root.join(".Rprofile") {
        if !inputs.model_rprofile {
            // Modeling disabled: ensure no stale prelude lingers, no rescan.
            let had = !inputs.rprofile_symbols.is_empty()
                || !inputs.rprofile_attached_packages.is_empty();
            inputs.rprofile_symbols.clear();
            inputs.rprofile_attached_packages.clear();
            inputs.rprofile_sourced_files.clear();
            return had.then_some(PackageInputDelta::RProfileChanged);
        }
        if deleted {
            inputs.rprofile_symbols.clear();
            inputs.rprofile_attached_packages.clear();
            inputs.rprofile_sourced_files.clear();
            return Some(PackageInputDelta::RProfileChanged);
        }
        let scan = super::rprofile::scan_workspace_rprofile(root);
        inputs.rprofile_symbols = scan.symbols;
        inputs.rprofile_attached_packages = scan.attached_packages;
        inputs.rprofile_sourced_files = scan.sourced_files;
        return Some(PackageInputDelta::RProfileChanged);
    }
```

(The scan re-reads `.Rprofile` from disk and follows its `source()` chain, so `on_disk_text` is not needed here — matching the `data/` rescan pattern.)

- [ ] **Step 5: Run the event tests**

Run: `cargo test -p raven --features test-support watched_rprofile`
Expected: PASS.

- [ ] **Step 6: Route `.Rprofile` watched changes in the backend**

In `crates/raven/src/backend.rs`, in the `pkg_manifest_changes` filter (line 4982), extend the match:

```rust
                                if p == root.join("DESCRIPTION")
                                    || p == root.join("NAMESPACE")
                                    || p == root.join(".Rprofile")
                                {
                                    Some((c.uri.clone(), c.typ == FileChangeType::DELETED))
                                } else {
                                    None
                                }
```

- [ ] **Step 7: Broaden the republish set when `.Rprofile` changed**

In the manifest-event block (after `deltas` is built, around line 5037, before `extend_affected_for_manifest_change`), compute whether a prelude change occurred and use a broader open-doc predicate for it. The prelude affects `scripts/` files, which `is_package_relevant_open_uri` excludes. Replace the `open_keys_filtered` computation (lines 5053-5065) with:

```rust
                let rprofile_changed = deltas
                    .iter()
                    .any(|d| matches!(d, crate::package_state::PackageInputDelta::RProfileChanged));
                let open_keys_filtered: Vec<Url> = state
                    .package_inputs
                    .workspace_root
                    .as_ref()
                    .map(|root| {
                        state
                            .documents
                            .keys()
                            .filter(|uri| {
                                // DESCRIPTION/NAMESPACE: package-relevant files.
                                // .Rprofile prelude: any workspace R-language
                                // file (the prelude reaches scripts/, which are
                                // not "package-relevant").
                                is_package_relevant_open_uri(uri, root)
                                    || (rprofile_changed
                                        && uri
                                            .to_file_path()
                                            .ok()
                                            .is_some_and(|p| {
                                                crate::package_state::is_package_workspace_r_file(
                                                    &p, root,
                                                )
                                            }))
                            })
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
```

- [ ] **Step 8: Re-scan on a live `rprofilePrelude` toggle**

In `reconcile_after_config_recompute` (`crates/raven/src/backend.rs`, the decisions block ~6195), after the `pkg_mode_io_needed` computation, fold in a model-rprofile change so the re-init path (which calls `initialize_package_inputs_from_state` → re-scans `.Rprofile`) also fires on a pure setting toggle:

```rust
            let model_rprofile_changed =
                state.cross_file_config.model_rprofile != prev.prev_cross_file.model_rprofile;
            let pkg_mode_io_needed = pkg_mode_io_needed.or_else(|| {
                if model_rprofile_changed {
                    state
                        .workspace_folders
                        .first()
                        .and_then(|u| u.to_file_path().ok())
                } else {
                    None
                }
            });
```

(The whole-struct `only_watch_changed` comparison already force-republishes open docs when `model_rprofile` flips; this adds the missing re-scan so the toggle actually changes the contribution. `prev.prev_cross_file` is the `CrossFileConfig` snapshot — confirm the field name.)

- [ ] **Step 9: Add the VS Code watcher**

In `editors/vscode/src/extension.ts`, in the `synchronize.fileEvents` array (~line 281), add:

```typescript
        vscode.workspace.createFileSystemWatcher('**/.Rprofile'),
```

(The backend routing in Step 6 already filters to the workspace-root `.Rprofile`, so a nested `.Rprofile` produces a watched event that `translate_watched` ignores.)

- [ ] **Step 10: Write the live-update acceptance test (case 9)**

In `crates/raven/src/package_state/event.rs` tests (or a backend test), assert that applying an `RProfileChanged` event re-derives a contribution whose `rprofile_symbols` reflect the new `.Rprofile`. A focused state-level test (no full LSP server) is sufficient:

```rust
    #[test]
    fn acceptance_9_live_update_redrives_contribution() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.model_rprofile = true;

        // Initial: helper_a defined.
        std::fs::write(root.join(".Rprofile"), "helper_a <- function() 1\n").unwrap();
        let uri = tower_lsp::lsp_types::Url::from_file_path(root.join(".Rprofile")).unwrap();
        let _ = translate(&mut inputs, HandlerEvent::WatchedFileChanged {
            uri: uri.clone(), on_disk_text: None, deleted: false });
        let s1 = crate::package_state::derive_package_state(
            &crate::package_state::PackageState::new(), &inputs, &PackageInputDelta::RProfileChanged);
        assert!(s1.scope_contribution().rprofile_symbols.contains("helper_a"));

        // Edit: helper_b instead.
        std::fs::write(root.join(".Rprofile"), "helper_b <- function() 1\n").unwrap();
        let _ = translate(&mut inputs, HandlerEvent::WatchedFileChanged {
            uri, on_disk_text: None, deleted: false });
        let s2 = crate::package_state::derive_package_state(
            &s1, &inputs, &PackageInputDelta::RProfileChanged);
        assert!(s2.scope_contribution().rprofile_symbols.contains("helper_b"));
        assert!(!s2.scope_contribution().rprofile_symbols.contains("helper_a"),
            "live edit must drop the old symbol");
    }
```

- [ ] **Step 11: Run everything + gates**

Run: `cargo test -p raven --features test-support package_state:: && cargo test -p raven --features test-support acceptance_`
Run the VS Code compile check per CLAUDE.md (e.g. `cd editors/vscode && bun run compile` or the documented `tsc` invocation).
Then fmt + clippy.

- [ ] **Step 12: Commit**

```bash
git add crates/raven/src/package_state/mod.rs crates/raven/src/package_state/event.rs crates/raven/src/backend.rs editors/vscode/src/extension.ts
git commit -m "feat(rprofile): watch .Rprofile, re-scan + revalidate scripts on edit and toggle"
```

---

## Task 11: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full crate test suite**

Run: `cargo test -p raven --features test-support`
Expected: PASS (no regressions in package_state, cross_file, cli, handlers).

- [ ] **Step 2: Run the bun suites touched**

Run: `bun test tests/bun/settings-reference.test.ts`
Run the VS Code Mocha settings suite per CLAUDE.md.

- [ ] **Step 3: Final gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --features test-support -- -D warnings
```

- [ ] **Step 4: Manual smoke (optional, if R is available)**

Build `raven` and run `raven check` on a scratch workspace matching acceptance case 1; confirm `r_bind` is not flagged with `.Rprofile` present and is flagged when `.Rprofile` is removed.

- [ ] **Step 5: Commit any fixups**

```bash
git add -A && git commit -m "test(rprofile): full-suite verification fixups" || true
```

(After Task 12, per the session goal: have codex review the work, then run `/code-review` until two consecutive clean passes, then open the PR.)

---

## Task 12 (enhancement): rescan the prelude when a sourced helper file is edited

**Status: enhancement, not required by the spec's 11 acceptance tests** (case 9 covers editing `.Rprofile` itself, which Task 10 handles). This closes the transitive gap: if `.Rprofile` does `source("R/functions.r")` and the user edits `R/functions.r`, the prelude should refresh. The `rprofile_sourced_files` set (threaded in Tasks 5–7) makes this cheap and precise. Implement only after Tasks 1–11 are green; if skipped, document the limitation (below).

**Files:**
- Modify: `crates/raven/src/package_state/event.rs` (`translate_watched` R-source arm; `.Rprofile` arm to also refresh `rprofile_sourced_files`)
- Possibly: `crates/raven/src/backend.rs` (ensure R-file watched changes route through `translate` and that an `RProfileChanged` inside a `Batch` broadens the republish)

- [ ] **Step 1: Write the failing test**

In `crates/raven/src/package_state/event.rs` tests:

```rust
    #[test]
    fn editing_a_sourced_helper_rescans_the_prelude() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join("R")).unwrap();
        std::fs::write(root.join("R").join("functions.r"), "old_helper <- function() 1\n").unwrap();
        std::fs::write(root.join(".Rprofile"), "source(\"R/functions.r\")\n").unwrap();

        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some(root.to_path_buf());
        inputs.model_rprofile = true;
        // Seed the prelude (mirrors initialize_package_inputs_from_state).
        let scan = super::super::rprofile::scan_workspace_rprofile(root);
        inputs.rprofile_symbols = scan.symbols;
        inputs.rprofile_sourced_files = scan.sourced_files;
        assert!(inputs.rprofile_symbols.contains("old_helper"));

        // Edit the sourced helper.
        std::fs::write(root.join("R").join("functions.r"), "new_helper <- function() 1\n").unwrap();
        let uri = tower_lsp::lsp_types::Url::from_file_path(root.join("R").join("functions.r")).unwrap();
        let delta = translate(&mut inputs, HandlerEvent::WatchedFileChanged { uri, on_disk_text: None, deleted: false });

        // The change must (a) update the package R-file input AND (b) rescan the prelude.
        match delta {
            Some(PackageInputDelta::Batch(ref ds)) => {
                assert!(ds.iter().any(|d| matches!(d, PackageInputDelta::RProfileChanged)), "expected RProfileChanged in batch: {:?}", ds);
            }
            other => panic!("expected a Batch with RProfileChanged, got {:?}", other),
        }
        assert!(inputs.rprofile_symbols.contains("new_helper"), "prelude must refresh: {:?}", inputs.rprofile_symbols);
        assert!(!inputs.rprofile_symbols.contains("old_helper"));
    }
```

(Note: in package mode `R/functions.r` is also a package source file, so the base delta is `RFileChanged`; the helper need not be under `R/` — a `scripts/helpers.R` sourced by `.Rprofile` works the same, with base delta dependent on `is_r_source_path`.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p raven --features test-support editing_a_sourced_helper`
Expected: FAIL (returns a bare `RFileChanged`, prelude not refreshed).

- [ ] **Step 3: Implement the rescan in `translate_watched`**

In the `is_r_source_path` arm of `translate_watched`, compute the base delta first, then — if the changed file is a prelude-sourced helper — rescan and return a `Batch`. Replace the arm body:

```rust
    if let Some(kind) = is_r_source_path(&path, root) {
        let base = if deleted {
            inputs.r_files.remove(&path);
            PackageInputDelta::RFileDeleted { path: path.clone(), kind }
        } else {
            let text = on_disk_text.or_else(|| crate::state::read_source(&path).ok().map(Arc::from))?;
            let digest = ContentDigest::of(&text);
            inputs.r_files.insert(path.clone(), RFileInput { kind, text, content_digest: digest });
            PackageInputDelta::RFileChanged { path: path.clone(), kind }
        };
        if inputs.model_rprofile && inputs.rprofile_sourced_files.contains(&canonical_path) {
            let scan = super::rprofile::scan_workspace_rprofile(root);
            inputs.rprofile_symbols = scan.symbols;
            inputs.rprofile_attached_packages = scan.attached_packages;
            inputs.rprofile_sourced_files = scan.sourced_files;
            return Some(PackageInputDelta::Batch(vec![base, PackageInputDelta::RProfileChanged]));
        }
        return Some(base);
    }
```

Also, in the `.Rprofile` arm (Task 10 Step 4), set `inputs.rprofile_sourced_files = scan.sourced_files;` alongside the symbol/package assignments, so the sourced set stays current after a `.Rprofile` edit.

- [ ] **Step 4: Ensure the republish + routing reach the helper's dependents**

Verify (read `backend.rs` around the watched-file R-source update path, ~5294) that an R-file watched change routes through `translate`/`apply_package_event` so the `Batch([RFileChanged, RProfileChanged])` is applied, and that the resulting `package_visibility_changed` / republish covers open `scripts/` files (the `is_package_workspace_r_file` broadening from Task 10 Step 7, or the existing `package_visibility_changed` path). If R-file watched changes do NOT currently flow through `translate` (they may go through a separate graph-update path), extend that path to apply the returned delta and broaden the republish when the batch contains `RProfileChanged`. Add a focused test or a manual `raven check` smoke confirming a `scripts/` file re-resolves a helper renamed in a `.Rprofile`-sourced file.

- [ ] **Step 5: Run + gates + commit**

```bash
cargo test -p raven --features test-support editing_a_sourced_helper
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_state/event.rs crates/raven/src/backend.rs
git commit -m "feat(rprofile): refresh prelude when a sourced helper file is edited"
```

**If this task is skipped**, add a one-line known limitation to `docs/r-package-dev.md` under "`.Rprofile` prelude": *"Editing a helper file that `.Rprofile` `source()`s refreshes the prelude on the next full rebuild (restart, config change, or `.Rprofile` edit); editing `.Rprofile` itself updates live."*

---

## Self-review notes (spec coverage)

- Part A docs → Task 1. `.Rprofile` prelude user doc + Configuration row → Task 1.
- Setting `raven.packages.rprofilePrelude` (three places + reference + Rust) → Tasks 2, 3.
- Static-parse-only scanner; assignments, library, source() (literal, transitive, workspace fallback, renv skip, local=TRUE excluded, dynamic ignored, conditional harvested) → Tasks 4, 5.
- Carry through `PackageInputs`/`PackageScopeContribution`/derive, script-mode survival → Task 6.
- Startup + `raven check` seeding → Task 7.
- Injection + applicability rule (withhold R/, tests, vignettes/man/demo in package mode only; apply to data-raw/, scripts/, script-mode R/) + `is_visible` parity → Task 8. **Injected at BOTH `append_package_contribution` sites: the recursive Phase 5a (`scope.rs:6668`) AND `ScopeStream::snapshot()` (`scope.rs:8093`, the diagnostics path).**
- Acceptance cases 1–8, 10, 11 → Task 9 (incl. `data-raw/` applies / `vignettes/` withholds e2e); case 9 (live update) + watch + toggle → Task 10; transitive sourced-helper edits → Task 12 (enhancement; documented limitation if skipped).
- Revalidation: mirror the proven `dataset_symbols` mechanism (contribution `PartialEq` change detection + force-republish), broadened so the `.Rprofile` change republishes `scripts/` files. The standalone scope cache (#483) caches only depth-≥1 scopes AND only when `package_contribution.is_none()` (`scope.rs:5833`); the prelude injects only at depth 0 via the contribution, so it is never cached — no cache-invalidation work, and no `compute_interface_hash` change is required (the spec's "interface hash" suggestion is satisfied by the equivalent, established data-symbol path).
- `source()` filter correctness: `detect_source_calls` walks the whole tree, so follow only `inherits_symbols() && !is_function_scoped` non-directive literal paths (excludes function-body `source()`, `local=TRUE`, and non-global `sys.source()`) → Task 5.
- `model_rprofile` change detection: added to `scope_settings_changed` (Task 2) and the config-reload re-init trigger (Task 10 Step 8); the whole-struct `only_watch_changed` comparison auto-force-republishes on toggle.
- Struct-literal fixups: both `PackageInputs` and `PackageScopeContribution` exhaustive literals (many test fixtures) → Task 6 Step 6 (compiler-guided).
