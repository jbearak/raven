# Issue #135: Route `diagnostics()` Through Snapshot Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy `pub fn diagnostics()` body in `crates/raven/src/handlers.rs` with a thin delegating call to the snapshot-based pipeline (`DiagnosticsSnapshot::build` → `diagnostics_from_snapshot`), then delete the six now-dead legacy collectors and migrate their direct-call tests.

**Architecture:** Five phases on a single feature branch. Phase 1 adds parity-gap tests against the legacy path. Phase 2 captures a benchmark baseline. Phase 3 delegates `diagnostics()` (with `#[allow(dead_code)]` on the soon-to-be-deleted legacy collectors). Phase 4 reruns benchmarks and gates on a confidence-interval-aware threshold. Phase 5 deletes the six legacy collectors and migrates ~57 in-file tests. Each phase ends with a `codex:rescue` review.

**Tech Stack:** Rust, tree-sitter-r, tower-lsp, Criterion (for benchmarks), tempfile (for filesystem-backed tests).

**Spec:** `/Users/jmb/repos/raven/docs/superpowers/specs/2026-04-30-issue-135-route-diagnostics-through-snapshot-design.md`

**Branch:** `refactor/issue-135-route-diagnostics-through-snapshot` (already created off `main`; spec and this plan are on this branch)

**Key file locations:**
- `crates/raven/src/handlers.rs:264` — `diagnostics_from_snapshot` (snapshot entry, unchanged)
- `crates/raven/src/handlers.rs:3558–3569` — `diagnostics_via_snapshot` (currently `#[cfg(feature = "test-support")]`, lifted in Phase 3)
- `crates/raven/src/handlers.rs:3603` — `pub fn diagnostics()` (rewritten in Phase 3)
- `crates/raven/src/handlers.rs:4113` — `collect_missing_file_diagnostics` (deleted in Phase 5)
- `crates/raven/src/handlers.rs:4471` — `collect_max_depth_diagnostics` (deleted in Phase 5)
- `crates/raven/src/handlers.rs:4573` — `collect_missing_package_diagnostics` (deleted in Phase 5)
- `crates/raven/src/handlers.rs:4651` — `collect_redundant_directive_diagnostics` (deleted in Phase 5)
- `crates/raven/src/handlers.rs:5609` — `collect_out_of_scope_diagnostics` (deleted in Phase 5)
- `crates/raven/src/handlers.rs:8196` — `collect_undefined_variables_position_aware` (deleted in Phase 5)
- `crates/raven/src/backend.rs:4135` — only direct production caller of `diagnostics()`
- `crates/raven/benches/lsp_operations.rs:243` — `bench_diagnostics`
- `crates/raven/src/handlers.rs:34800` — `create_test_state()` test helper
- `crates/raven/src/cross_file/types.rs:117` — `ForwardSource::inherits_symbols`

**Two diagnostic message formats** (path-dependent — Phase 1 tests must avoid asserting on message wording):
- Legacy path emits: `"Symbol '{name}' used before source() call at line {n}"` (handlers.rs:5796)
- Snapshot path emits: `"'{name}' is used before it's available (sourced on line {n})"` (handlers.rs:5229)

Phase 1 tests use **message-agnostic predicates** (e.g., search for the symbol name in `d.message` plus a `severity == WARNING` check at a known line range) so the same test passes on both paths.

---

## Phase 1: Add gap-coverage tests against the legacy path

Phase 1 adds 7 tests in `crates/raven/src/handlers.rs` (in the `mod tests` block at the bottom of the file, near existing `test_out_of_scope_*` tests around line 33491). Each test creates a `TempDir` with the necessary files, sets up `WorldState`, calls `diagnostics(&state, &uri, &DiagCancelToken::never())`, and asserts on the resulting `Vec<Diagnostic>`. Five tests are Category A (pass on legacy now; locked in as regression coverage). Two are Category B (fail on legacy; un-ignored in Phase 3).

All Phase 1 tests use TempDir-backed paths because the path-resolution logic for `@lsp-cd` and workspace-root fallback inspects the filesystem.

### Task 1.1: Add Category A test — `@lsp-cd` resolves AST `source()` targets

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add a new `#[test]` near line 33490 inside the existing `mod tests`)

- [ ] **Step 1: Write the failing test (it should pass once added; this is a regression lock)**

Add the following test inside the existing `mod tests` block, right after `test_out_of_scope_diagnostic_not_emitted_when_severity_off` (around line 33547):

```rust
/// Regression lock for issue #135 (Phase 1, Category A).
///
/// `@lsp-cd subdir/` makes the file's working directory `<workspace>/subdir/`.
/// AST-detected `source("helper.R")` should resolve to
/// `<workspace>/subdir/helper.R`, not `<workspace>/helper.R`. If the path
/// resolution regresses to plain parent-dir join, the source target won't be
/// found, and a symbol the helper exports will be flagged as undefined or
/// "used before sourced" depending on whether the unresolved source survives
/// the source-call list at all.
#[test]
fn test_out_of_scope_respects_lsp_cd_for_ast_source() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let subdir_path = workspace_path.join("subdir");
    std::fs::create_dir(&subdir_path).unwrap();

    let main_path = workspace_path.join("main.R");
    let helper_path = subdir_path.join("helper.R");

    // main.R declares @lsp-cd subdir/ then sources "helper.R"
    let main_code = "# @lsp-cd subdir/\nresult <- helper(1)\nsource(\"helper.R\")\n";
    let helper_code = "helper <- function(x) x + 1\n";
    std::fs::write(&main_path, main_code).unwrap();
    std::fs::write(&helper_path, helper_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let main_url = Url::from_file_path(&main_path).unwrap();
    let helper_url = Url::from_file_path(&helper_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    state
        .documents
        .insert(helper_url.clone(), Document::new(helper_code, None));
    state
        .documents
        .insert(main_url.clone(), Document::new(main_code, None));
    state.cross_file_graph.update_file(
        &helper_url,
        &crate::cross_file::extract_metadata(helper_code),
        Some(&workspace_url),
        |_| None,
    );
    state.cross_file_graph.update_file(
        &main_url,
        &crate::cross_file::extract_metadata(main_code),
        Some(&workspace_url),
        |_| None,
    );

    let diags = diagnostics(&state, &main_url, &DiagCancelToken::never());

    // Expect a "used before sourced" diagnostic for `helper` on line 1
    // (0-indexed) — line of `result <- helper(1)`. Both paths emit ONE
    // diagnostic for this symbol; assert path-agnostically by message
    // substring "helper" and line.
    let helper_diags: Vec<_> = diags
        .iter()
        .filter(|d| d.message.contains("'helper'") || d.message.contains("Symbol 'helper'"))
        .filter(|d| d.range.start.line == 1)
        .collect();
    assert_eq!(
        helper_diags.len(),
        1,
        "Expected one diagnostic for `helper` on line 1; got {:?}",
        diags
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );

    // Confirm `helper` is NOT flagged as undefined (the source resolved, so
    // the symbol IS available cross-file). If `@lsp-cd` resolution broke,
    // the source would not resolve and we'd see "Undefined variable: helper".
    let undefined_helper: Vec<_> = diags
        .iter()
        .filter(|d| d.message.contains("Undefined variable: helper"))
        .collect();
    assert!(
        undefined_helper.is_empty(),
        "`helper` should not be flagged as undefined when @lsp-cd resolves \
         the source target. Got: {:?}",
        undefined_helper
    );
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p raven test_out_of_scope_respects_lsp_cd_for_ast_source -- --nocapture`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): @lsp-cd path resolution regression lock for #135"
```

### Task 1.2: Add Category A test — workspace-root fallback for unannotated `source()`

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add another `#[test]` after Task 1.1's test)

- [ ] **Step 1: Write the test**

Add right after `test_out_of_scope_respects_lsp_cd_for_ast_source`:

```rust
/// Regression lock for issue #135 (Phase 1, Category A).
///
/// In an unannotated workspace (no @lsp-cd), `source("scripts/helper.R")`
/// resolves via workspace-root fallback when the literal relative path
/// doesn't exist next to the parent file. This is the AST-detected
/// source-call-only fallback (`resolve_path_with_workspace_fallback` at
/// handlers.rs:5731). If the fallback regresses, the source target won't
/// resolve from a file outside the workspace root.
#[test]
fn test_out_of_scope_uses_workspace_root_fallback_for_ast_source() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let scripts_path = workspace_path.join("scripts");
    std::fs::create_dir(&scripts_path).unwrap();

    let main_path = scripts_path.join("main.R");
    let helper_path = scripts_path.join("helper.R");

    // main.R lives in scripts/; sources "scripts/helper.R" relative to
    // workspace root, NOT relative to main.R's parent dir. The literal
    // `<scripts_dir>/scripts/helper.R` does not exist; workspace-root
    // fallback should resolve to `<workspace>/scripts/helper.R`.
    let main_code = "result <- helper(1)\nsource(\"scripts/helper.R\")\n";
    let helper_code = "helper <- function(x) x + 1\n";
    std::fs::write(&main_path, main_code).unwrap();
    std::fs::write(&helper_path, helper_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let main_url = Url::from_file_path(&main_path).unwrap();
    let helper_url = Url::from_file_path(&helper_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    state
        .documents
        .insert(helper_url.clone(), Document::new(helper_code, None));
    state
        .documents
        .insert(main_url.clone(), Document::new(main_code, None));
    state.cross_file_graph.update_file(
        &helper_url,
        &crate::cross_file::extract_metadata(helper_code),
        Some(&workspace_url),
        |_| None,
    );
    state.cross_file_graph.update_file(
        &main_url,
        &crate::cross_file::extract_metadata(main_code),
        Some(&workspace_url),
        |_| None,
    );

    let diags = diagnostics(&state, &main_url, &DiagCancelToken::never());

    // `helper` should resolve through workspace-root fallback; expect a
    // single "used before sourced" diagnostic on line 0.
    let helper_diags: Vec<_> = diags
        .iter()
        .filter(|d| d.message.contains("'helper'") || d.message.contains("Symbol 'helper'"))
        .filter(|d| d.range.start.line == 0)
        .collect();
    assert_eq!(
        helper_diags.len(),
        1,
        "Expected one diagnostic for `helper` on line 0; got {:?}",
        diags
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );

    // Not undefined: workspace-root fallback found the helper.
    let undefined_helper: Vec<_> = diags
        .iter()
        .filter(|d| d.message.contains("Undefined variable: helper"))
        .collect();
    assert!(
        undefined_helper.is_empty(),
        "`helper` should not be flagged as undefined when workspace-root \
         fallback resolves the source target. Got: {:?}",
        undefined_helper
    );
}
```

- [ ] **Step 2: Run test**

Run: `cargo test -p raven test_out_of_scope_uses_workspace_root_fallback_for_ast_source -- --nocapture`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): workspace-root fallback regression lock for #135"
```

### Task 1.3: Add Category A test — `source(..., local=TRUE)` does not flag

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add another `#[test]`)

- [ ] **Step 1: Write the test**

Add right after Task 1.2's test:

```rust
/// Regression lock for issue #135 (Phase 1, Category A).
///
/// `source("helper.R", local=TRUE)` does NOT inherit symbols into the
/// caller's scope (R semantics: local=TRUE evaluates the sourced file in
/// a fresh local environment). The "used before sourced" diagnostic must
/// not fire for symbols defined in a local-sourced file — they are
/// genuinely undefined from the caller's perspective. The legacy
/// collector got this right after PR #134 (handlers.rs:5721 filters via
/// `inherits_symbols()`); this test locks it in.
#[test]
fn test_out_of_scope_skips_local_true_source() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let main_path = workspace_path.join("main.R");
    let helper_path = workspace_path.join("helper.R");

    // helper.R defines `helper`. main.R sources it with local=TRUE BEFORE
    // calling helper(). Because local=TRUE doesn't inherit symbols,
    // helper() at the call site is genuinely undefined — but the
    // out-of-scope collector should NOT flag it as "used before sourced"
    // (the source comes earlier than the use). It should only show up,
    // if at all, as an undefined-variable diagnostic.
    let main_code = "source(\"helper.R\", local=TRUE)\nresult <- helper(1)\n";
    let helper_code = "helper <- function(x) x + 1\n";
    std::fs::write(&main_path, main_code).unwrap();
    std::fs::write(&helper_path, helper_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let main_url = Url::from_file_path(&main_path).unwrap();
    let helper_url = Url::from_file_path(&helper_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    state
        .documents
        .insert(helper_url.clone(), Document::new(helper_code, None));
    state
        .documents
        .insert(main_url.clone(), Document::new(main_code, None));
    state.cross_file_graph.update_file(
        &helper_url,
        &crate::cross_file::extract_metadata(helper_code),
        Some(&workspace_url),
        |_| None,
    );
    state.cross_file_graph.update_file(
        &main_url,
        &crate::cross_file::extract_metadata(main_code),
        Some(&workspace_url),
        |_| None,
    );

    let diags = diagnostics(&state, &main_url, &DiagCancelToken::never());

    // No "used before sourced" diagnostic for `helper` (the `inherits_symbols()`
    // filter must skip the local=TRUE source).
    let used_before_helper: Vec<_> = diags
        .iter()
        .filter(|d| {
            (d.message.contains("'helper'") || d.message.contains("Symbol 'helper'"))
                && (d.message.contains("used before"))
        })
        .collect();
    assert!(
        used_before_helper.is_empty(),
        "Expected NO 'used before sourced' diagnostic for helper(): \
         local=TRUE doesn't inherit. Got: {:?}",
        used_before_helper
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );

    // Undefined-variable diagnostic for `helper` IS expected (R semantics:
    // helper is not visible from the caller's environment).
    let undefined_helper: Vec<_> = diags
        .iter()
        .filter(|d| d.message.contains("Undefined variable: helper"))
        .collect();
    assert!(
        !undefined_helper.is_empty(),
        "Expected 'Undefined variable: helper' diagnostic — local=TRUE \
         doesn't inherit. Got: {:?}",
        diags
            .iter()
            .map(|d| d.message.clone())
            .collect::<Vec<_>>()
    );
}
```

- [ ] **Step 2: Run test**

Run: `cargo test -p raven test_out_of_scope_skips_local_true_source -- --nocapture`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): local=TRUE source filter regression lock for #135"
```

### Task 1.4: Add Category A test — `sys.source(envir=new.env())` does not flag

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add another `#[test]`)

- [ ] **Step 1: Write the test**

Add right after Task 1.3's test:

```rust
/// Regression lock for issue #135 (Phase 1, Category A).
///
/// `sys.source("helper.R", envir=new.env())` evaluates in a fresh env;
/// symbols are NOT inherited into the caller's scope. The "used before
/// sourced" collector must skip such sources via `inherits_symbols()`.
#[test]
fn test_out_of_scope_skips_sys_source_non_global_env() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let main_path = workspace_path.join("main.R");
    let helper_path = workspace_path.join("helper.R");

    let main_code =
        "sys.source(\"helper.R\", envir=new.env())\nresult <- helper(1)\n";
    let helper_code = "helper <- function(x) x + 1\n";
    std::fs::write(&main_path, main_code).unwrap();
    std::fs::write(&helper_path, helper_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let main_url = Url::from_file_path(&main_path).unwrap();
    let helper_url = Url::from_file_path(&helper_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    state
        .documents
        .insert(helper_url.clone(), Document::new(helper_code, None));
    state
        .documents
        .insert(main_url.clone(), Document::new(main_code, None));
    state.cross_file_graph.update_file(
        &helper_url,
        &crate::cross_file::extract_metadata(helper_code),
        Some(&workspace_url),
        |_| None,
    );
    state.cross_file_graph.update_file(
        &main_url,
        &crate::cross_file::extract_metadata(main_code),
        Some(&workspace_url),
        |_| None,
    );

    let diags = diagnostics(&state, &main_url, &DiagCancelToken::never());

    let used_before_helper: Vec<_> = diags
        .iter()
        .filter(|d| {
            (d.message.contains("'helper'") || d.message.contains("Symbol 'helper'"))
                && d.message.contains("used before")
        })
        .collect();
    assert!(
        used_before_helper.is_empty(),
        "Expected NO 'used before sourced' for helper(): sys.source with \
         non-global env doesn't inherit. Got: {:?}",
        used_before_helper
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );
}
```

- [ ] **Step 2: Run test**

Run: `cargo test -p raven test_out_of_scope_skips_sys_source_non_global_env -- --nocapture`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): sys.source non-global env regression lock for #135"
```

### Task 1.5: Add Category A test — `sys.source(envir=globalenv())` DOES flag

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add another `#[test]`)

- [ ] **Step 1: Write the test**

Add right after Task 1.4's test:

```rust
/// Regression lock for issue #135 (Phase 1, Category A).
///
/// `sys.source("helper.R", envir=globalenv())` DOES inherit symbols into
/// the global environment. Confirms the `inherits_symbols()` filter
/// correctly distinguishes global from non-global env.
#[test]
fn test_out_of_scope_includes_sys_source_global_env() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let main_path = workspace_path.join("main.R");
    let helper_path = workspace_path.join("helper.R");

    // Use `globalenv()` so the source IS inheriting. Use BEFORE the source
    // call to trigger "used before sourced".
    let main_code =
        "result <- helper(1)\nsys.source(\"helper.R\", envir=globalenv())\n";
    let helper_code = "helper <- function(x) x + 1\n";
    std::fs::write(&main_path, main_code).unwrap();
    std::fs::write(&helper_path, helper_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let main_url = Url::from_file_path(&main_path).unwrap();
    let helper_url = Url::from_file_path(&helper_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    state
        .documents
        .insert(helper_url.clone(), Document::new(helper_code, None));
    state
        .documents
        .insert(main_url.clone(), Document::new(main_code, None));
    state.cross_file_graph.update_file(
        &helper_url,
        &crate::cross_file::extract_metadata(helper_code),
        Some(&workspace_url),
        |_| None,
    );
    state.cross_file_graph.update_file(
        &main_url,
        &crate::cross_file::extract_metadata(main_code),
        Some(&workspace_url),
        |_| None,
    );

    let diags = diagnostics(&state, &main_url, &DiagCancelToken::never());

    // Expect exactly one "used before sourced" diagnostic on line 0.
    let used_before_helper: Vec<_> = diags
        .iter()
        .filter(|d| {
            (d.message.contains("'helper'") || d.message.contains("Symbol 'helper'"))
                && d.message.contains("used before")
                && d.range.start.line == 0
        })
        .collect();
    assert_eq!(
        used_before_helper.len(),
        1,
        "Expected 1 'used before sourced' for helper() on line 0: \
         sys.source with globalenv() DOES inherit. Got: {:?}",
        diags
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );
}
```

- [ ] **Step 2: Run test**

Run: `cargo test -p raven test_out_of_scope_includes_sys_source_global_env -- --nocapture`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): sys.source globalenv() regression lock for #135"
```

### Task 1.6: Add Category B test — broader "already in scope" suppression (failing on legacy)

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add another `#[test]` with `#[ignore]`)

This is deviation #4 from issue #135. The legacy collector only skips usages whose scope-resolved `source_uri` matches the queried URI; the snapshot collector additionally checks `scope.symbols.contains_key(name)` and skips if the symbol is in scope through any in-scope mechanism.

- [ ] **Step 1: Write the test (expect FAIL on legacy; will be `#[ignore]`d)**

Add right after Task 1.5's test:

```rust
/// Phase 1 Category B for issue #135 — failing on legacy until Phase 3.
///
/// Deviation #4: snapshot suppresses "used before sourced" when the symbol
/// is already in scope via a non-source mechanism (e.g., backward edge).
/// Legacy only checks usages resolving to the queried URI and so flags
/// the symbol even though it's available another way.
///
/// Setup: `main.R` declares `helper` and sources `child.R`. `child.R` is
/// queried for diagnostics. `child.R` calls `helper()` and ALSO sources
/// `redef.R` AFTER the call. `redef.R` defines `helper` again (a redefinition).
/// The use of `helper()` is in-scope from `main.R` (via backward edge), so
/// the snapshot path suppresses the "used before sourced" diagnostic;
/// the legacy path emits it.
#[ignore = "legacy parity gap; un-ignored in Phase 3 (issue #135)"]
#[test]
fn test_out_of_scope_suppresses_when_in_scope_via_backward_edge() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let main_path = workspace_path.join("main.R");
    let child_path = workspace_path.join("child.R");
    let redef_path = workspace_path.join("redef.R");

    let main_code = "helper <- function(x) x + 1\nsource(\"child.R\")\n";
    let child_code = "result <- helper(1)\nsource(\"redef.R\")\n";
    let redef_code = "helper <- function(x) x * 2\n";
    std::fs::write(&main_path, main_code).unwrap();
    std::fs::write(&child_path, child_code).unwrap();
    std::fs::write(&redef_path, redef_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let main_url = Url::from_file_path(&main_path).unwrap();
    let child_url = Url::from_file_path(&child_path).unwrap();
    let redef_url = Url::from_file_path(&redef_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    for (uri, code) in [
        (&main_url, main_code),
        (&child_url, child_code),
        (&redef_url, redef_code),
    ] {
        state
            .documents
            .insert(uri.clone(), Document::new(code, None));
        state.cross_file_graph.update_file(
            uri,
            &crate::cross_file::extract_metadata(code),
            Some(&workspace_url),
            |_| None,
        );
    }

    let diags = diagnostics(&state, &child_url, &DiagCancelToken::never());

    // `helper` at child.R line 0 is in-scope via backward edge from main.R.
    // The snapshot path suppresses; assert no "used before sourced" diagnostic.
    let used_before_helper: Vec<_> = diags
        .iter()
        .filter(|d| {
            (d.message.contains("'helper'") || d.message.contains("Symbol 'helper'"))
                && d.message.contains("used before")
        })
        .collect();
    assert!(
        used_before_helper.is_empty(),
        "Expected NO 'used before sourced' for helper(): symbol is in \
         scope via backward edge from main.R. Got: {:?}",
        used_before_helper
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );
}
```

- [ ] **Step 2: Run test to verify it's correctly ignored**

Run: `cargo test -p raven test_out_of_scope_suppresses_when_in_scope_via_backward_edge -- --nocapture`
Expected: 1 ignored, 0 failed (the `#[ignore]` skips it)

- [ ] **Step 3: Verify the test would FAIL on the legacy path (sanity check; do not commit this)**

Temporarily comment out the `#[ignore]` line and run:

```bash
cargo test -p raven test_out_of_scope_suppresses_when_in_scope_via_backward_edge -- --nocapture
```

Expected: FAIL with assertion that `helper` HAS a "used before sourced" diagnostic. If it passes (no failure) without `#[ignore]`, the test is not exercising the deviation — re-design the fixture before proceeding. **Restore the `#[ignore]` before committing.**

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): in-scope-via-backward-edge gap test for #135"
```

### Task 1.7: Add Category B test — source-call-site defense-in-depth (failing on legacy)

**Files:**
- Modify: `crates/raven/src/handlers.rs` (add another `#[test]` with `#[ignore]`)

This is deviation #5 from issue #135 — the `xyz <- xyz` self-leak shape that motivated commit 91c3617. The snapshot collector verifies the symbol's `source_uri` differs from the queried URI before emitting; legacy does not.

- [ ] **Step 1: Write the test (expect FAIL on legacy; will be `#[ignore]`d)**

Add right after Task 1.6's test:

```rust
/// Phase 1 Category B for issue #135 — failing on legacy until Phase 3.
///
/// Deviation #5: snapshot has source-call-site defense-in-depth that
/// verifies the symbol at the source position actually comes from another
/// URI before emitting "used before sourced". Legacy doesn't, so the
/// `xyz <- xyz` self-leak shape produces a false positive: the queried
/// URI defines `xyz` at top-level AND a sourced file ALSO defines `xyz`,
/// and legacy emits the diagnostic without checking that `xyz` resolves
/// to a DIFFERENT URI than the queried one.
#[ignore = "legacy parity gap; un-ignored in Phase 3 (issue #135)"]
#[test]
fn test_out_of_scope_self_leak_does_not_emit_used_before_sourced() {
    use tempfile::TempDir;

    let temp_dir = TempDir::new().unwrap();
    let workspace_path = temp_dir.path();
    let data_path = workspace_path.join("data.R");
    let indices_path = workspace_path.join("indices.R");

    // data.R has a self-referential `xyz <- xyz` (the RHS is a USE of `xyz`,
    // not a def — `visible_from` semantics ensure the LHS binding isn't
    // installed until the end of the assignment) and ALSO sources indices.R,
    // which ALSO defines `xyz`. The naive legacy path sees that `xyz` is
    // defined in indices.R (sourced after the use) and emits "used before
    // sourced." The snapshot path's source-call-site defense-in-depth verifies
    // the symbol at the source position actually comes from a DIFFERENT URI
    // before emitting; `xyz` resolves to data.R itself (the self-leak), so
    // the diagnostic is suppressed.
    //
    // Expected snapshot behavior: NO "used before sourced" for xyz; the RHS
    // remains a genuine "Undefined variable: xyz" because no outer `xyz`
    // exists at that point in the timeline.
    let data_code = "xyz <- xyz\nsource(\"indices.R\")\n";
    let indices_code = "xyz <- 99\n";
    std::fs::write(&data_path, data_code).unwrap();
    std::fs::write(&indices_path, indices_code).unwrap();

    let workspace_url = Url::from_file_path(workspace_path).unwrap();
    let data_url = Url::from_file_path(&data_path).unwrap();
    let indices_url = Url::from_file_path(&indices_path).unwrap();

    let mut state = WorldState::new(Vec::new());
    state.workspace_scan_complete = true;
    state.workspace_folders.push(workspace_url.clone());
    state.cross_file_config.out_of_scope_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);
    state.cross_file_config.undefined_variables_enabled = true;

    for (uri, code) in [(&data_url, data_code), (&indices_url, indices_code)] {
        state
            .documents
            .insert(uri.clone(), Document::new(code, None));
        state.cross_file_graph.update_file(
            uri,
            &crate::cross_file::extract_metadata(code),
            Some(&workspace_url),
            |_| None,
        );
    }

    let diags = diagnostics(&state, &data_url, &DiagCancelToken::never());

    // No "used before sourced" for xyz: the symbol resolves to data.R
    // itself (self-leak), not to indices.R. The snapshot path's source-site
    // defense-in-depth catches this; legacy does not.
    let used_before_xyz: Vec<_> = diags
        .iter()
        .filter(|d| {
            (d.message.contains("'xyz'") || d.message.contains("Symbol 'xyz'"))
                && d.message.contains("used before")
        })
        .collect();
    assert!(
        used_before_xyz.is_empty(),
        "Expected NO 'used before sourced' for xyz: self-referential \
         assignment, source-site defense-in-depth must verify source_uri \
         differs from queried URI. Got: {:?}",
        used_before_xyz
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );

    // The RHS `xyz` is genuinely undefined (no outer binding exists when
    // the RHS is evaluated, before the LHS is installed). Expect exactly
    // one undefined-variable diagnostic on line 0.
    let undefined_xyz: Vec<_> = diags
        .iter()
        .filter(|d| d.message.contains("Undefined variable: xyz"))
        .filter(|d| d.range.start.line == 0)
        .collect();
    assert_eq!(
        undefined_xyz.len(),
        1,
        "Expected exactly one 'Undefined variable: xyz' on line 0; got {:?}",
        diags
            .iter()
            .map(|d| (d.message.clone(), d.range))
            .collect::<Vec<_>>()
    );
}
```

- [ ] **Step 2: Run test to verify it's correctly ignored**

Run: `cargo test -p raven test_out_of_scope_self_leak_does_not_emit_used_before_sourced -- --nocapture`
Expected: 1 ignored, 0 failed.

- [ ] **Step 3: Verify the test would FAIL on the legacy path (sanity check; do not commit)**

Temporarily comment out the `#[ignore]` line and run the test. Expected: FAIL. If it passes, re-design the fixture. Restore `#[ignore]` before committing.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test(handlers): self-leak source-site defense gap test for #135"
```

### Task 1.8: Run full test suite at Phase 1 boundary

- [ ] **Step 1: Run full lib tests**

Run: `cargo test -p raven 2>&1 | tail -50`
Expected: all tests pass; the two `#[ignore]`d Category B tests show as `ignored`.

- [ ] **Step 2: Verify zero compiler warnings**

Run: `cargo build -p raven 2>&1 | grep -E "warning|error" | head -20`
Expected: zero new warnings (existing warnings, if any, are pre-existing).

### Task 1.9: codex:rescue gate for Phase 1

- [ ] **Step 1: Hand the Phase 1 commits to codex:rescue for review**

Dispatch a `codex:rescue` agent with this brief:

> Review the Phase 1 commits on branch `refactor/issue-135-route-diagnostics-through-snapshot` (commits since `main`).
>
> Phase 1 added 7 tests in `crates/raven/src/handlers.rs` to cover parity gaps between the legacy and snapshot diagnostic paths (issue #135). 5 are Category A (regression locks; passing on legacy as of `main`). 2 are Category B (failing-on-legacy gaps marked `#[ignore]`; un-ignored in Phase 3).
>
> Spec: `docs/superpowers/specs/2026-04-30-issue-135-route-diagnostics-through-snapshot-design.md`
>
> Audit:
> 1. Does each test actually exercise the deviation it claims to? In particular, does the Category B in-scope-via-backward-edge test actually trigger the snapshot's `scope.symbols.contains_key(name)` check, and does it actually fail on legacy when `#[ignore]` is removed?
> 2. Are the message-substring assertions (`"'helper'"` || `"Symbol 'helper'"`) robust against future tweaks to either path's message format?
> 3. Are there sub-cases worth covering that I missed (e.g., chdir=TRUE on `source()`, multiple `@lsp-cd` in nested chains)?
> 4. Is the workspace-root fallback test fixture correct? The relative path `"scripts/helper.R"` from a file inside `<workspace>/scripts/main.R` is unusual; would a more natural fixture (e.g., `source("helper.R")` resolving to `<workspace>/helper.R` from a parent at `<workspace>/scripts/main.R`) be a better match for the actual fallback semantics?
>
> Write a focused report under 600 words. Lead with verdict (LGTM / minor issues / major issues). Do not modify files.

- [ ] **Step 2: Address any issues codex raises**

If codex finds problems, fix them by editing tests or adding new ones, commit, and re-run codex:rescue. Do NOT proceed to Phase 2 until codex's review is LGTM or minor-issues-resolved.

---

## Phase 2: Capture pre-delegation benchmark baseline

### Task 2.1: Run baseline bench on Phase 1's tip

**Files:**
- Create: `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md`

- [ ] **Step 1: Run bench**

Run: `cargo bench --bench lsp_operations -- lsp_diagnostics 2>&1 | tee /tmp/bench-baseline.txt`
Expected: Criterion runs both `small_10` and `medium_50` fixtures; outputs mean/median/std-dev.

- [ ] **Step 2: Capture results to baseline doc**

Create `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` with the following content (replace the placeholder rows with actual numbers from `/tmp/bench-baseline.txt`):

```markdown
# Benchmark Baseline for Issue #135

**Captured on:** 2026-04-30
**Commit:** <run `git rev-parse HEAD` and paste here>
**Branch:** refactor/issue-135-route-diagnostics-through-snapshot
**Phase:** 1 (legacy path, before delegation)

## Command

```bash
cargo bench --bench lsp_operations -- lsp_diagnostics
```

## Results

| Fixture | Mean | Std Dev | 95% CI lower | 95% CI upper |
|---|---|---|---|---|
| `lsp_diagnostics/diagnostics/small_10` | <fill in> | <fill in> | <fill in> | <fill in> |
| `lsp_diagnostics/diagnostics/medium_50` | <fill in> | <fill in> | <fill in> | <fill in> |

## Raw output

(Pasted relevant Criterion output for both fixtures; trim to the per-fixture summary lines.)

## Phase 4 comparison

Filled in during Phase 4. Acceptance gates:

1. CI lower bound on percent change ≤ 15% on `medium_50` (or `large` if added).
2. Per-iteration mean increase ≤ 5 ms on every fixture, regardless of percentage.
3. Same gates apply to any fanout-shaped fixture added in Phase 2.
```

- [ ] **Step 3: Commit baseline**

```bash
git add docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md
git commit -m "bench: capture pre-delegation diagnostics baseline (#135)"
```

### Task 2.2: codex:rescue gate for Phase 2 — fanout-fixture decision

- [ ] **Step 1: Hand baseline numbers to codex:rescue**

Dispatch a `codex:rescue` agent:

> Review the bench baseline in `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` and the existing `bench_diagnostics` setup in `crates/raven/benches/lsp_operations.rs:243`.
>
> Context: Phase 3 of issue #135 will route `pub fn diagnostics()` through the snapshot path. The production sync caller is `Backend::publish_diagnostics` at backend.rs:4135; watched-file fanout reaches it indirectly via `publish_diagnostics_via_arc`/`publish_diagnostics`. The fanout cost (one publish per affected URI per edit) is the regression candidate.
>
> Decide:
> 1. Are the existing `small_10` (10 files) and `medium_50` (50 files) fixtures large enough to surface snapshot-build cost (cycle detection, neighborhood collection, subgraph clone)?
> 2. If not, recommend a `large` fixture size or a new bench shape that exercises the fanout cascade (e.g., a single file with many backward parents, or a fanout test that times publishing across N URIs).
> 3. Sanity-check the recorded baseline numbers — anything that looks anomalous (e.g., huge std-dev, non-monotonic across fixture sizes)?
>
> Write a focused report under 400 words. Lead with: ADD `large` FIXTURE / NO NEW FIXTURE NEEDED / ADD NEW BENCH. Do not modify files.

- [ ] **Step 2: If codex says ADD `large` FIXTURE — implement it**

Modify `crates/raven/benches/lsp_operations.rs:243-274` to add a third entry in `configs`:

```rust
let configs: &[(&str, FixtureConfig)] = &[
    ("small_10", FixtureConfig::small()),
    ("medium_50", FixtureConfig::medium()),
    ("large_<N>", FixtureConfig::custom(<N>, <chain_depth>, <fanout>)),
];
```

(Replace `<N>`, `<chain_depth>`, `<fanout>` with codex's recommendation. If `FixtureConfig::custom` does not exist, look at how `small()` and `medium()` are implemented in `crates/raven/benches/fixtures.rs` or similar, and add a `large()` constructor there.)

Re-run the bench, append the `large` numbers to the baseline doc, commit:

```bash
git add crates/raven/benches/lsp_operations.rs crates/raven/benches/fixtures.rs docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md
git commit -m "bench: add large fixture for diagnostics regression coverage (#135)"
```

If codex says NO NEW FIXTURE NEEDED, skip this step.

- [ ] **Step 3: If codex says ADD NEW BENCH — implement it**

Add a new `fn bench_diagnostics_fanout(c: &mut Criterion)` in `lsp_operations.rs` that builds a workspace where one file has many backward parents (or whatever shape codex recommended) and times publishing across all affected URIs. Add it to `criterion_group!` macro at the bottom. Re-run the bench, capture results, commit.

---

## Phase 3: Delegate `diagnostics()` to the snapshot path

### Task 3.1: Lift `diagnostics_via_snapshot` out of `#[cfg(feature = "test-support")]`

**Files:**
- Modify: `crates/raven/src/handlers.rs:3558–3569`

- [ ] **Step 1: Replace the cfg gate**

In `crates/raven/src/handlers.rs`, find lines 3558–3569 (the doc-comment + `diagnostics_via_snapshot` definition):

```rust
/// Build a `DiagnosticsSnapshot` and run the snapshot-based diagnostic
/// pipeline — exposed under the `test-support` feature so benchmarks can
/// measure the same path used by `run_debounced_diagnostics` in production.
#[cfg(feature = "test-support")]
#[allow(dead_code)]
pub fn diagnostics_via_snapshot(
    state: &WorldState,
    uri: &Url,
    cancel: &DiagCancelToken,
) -> Vec<Diagnostic> {
    match DiagnosticsSnapshot::build(state, uri) {
        Some(snapshot) => diagnostics_from_snapshot(&snapshot, uri, cancel).unwrap_or_default(),
        None => Vec::new(),
    }
}
```

Replace with:

```rust
/// Build a `DiagnosticsSnapshot` and run the snapshot-based diagnostic
/// pipeline. This is the production entry point for sync diagnostic
/// computation (called by `pub fn diagnostics`), and is also the bench
/// harness target for `crates/raven/benches/lsp_operations.rs`.
pub fn diagnostics_via_snapshot(
    state: &WorldState,
    uri: &Url,
    cancel: &DiagCancelToken,
) -> Vec<Diagnostic> {
    match DiagnosticsSnapshot::build(state, uri) {
        Some(snapshot) => diagnostics_from_snapshot(&snapshot, uri, cancel).unwrap_or_default(),
        None => Vec::new(),
    }
}
```

(Drops `#[cfg(feature = "test-support")]` and `#[allow(dead_code)]`. Updates the doc comment.)

- [ ] **Step 2: Verify it still compiles**

Run: `cargo build -p raven 2>&1 | tail -20`
Expected: success, no warnings.

### Task 3.2: Replace `pub fn diagnostics()` body with delegation

**Files:**
- Modify: `crates/raven/src/handlers.rs:3603` (the `pub fn diagnostics` function and its body, ~3603–3781)

- [ ] **Step 1: Replace the body**

Find `pub fn diagnostics(state: &WorldState, uri: &Url, cancel: &DiagCancelToken) -> Vec<Diagnostic> {` at line 3603. The function spans from 3603 to ~3781 (ending with `diagnostics`).

Replace the entire function body (everything between the opening `{` on line 3603 and the closing `}` of the function) with:

```rust
pub fn diagnostics(state: &WorldState, uri: &Url, cancel: &DiagCancelToken) -> Vec<Diagnostic> {
    // Master switch check - return empty if diagnostics disabled
    if !state.cross_file_config.diagnostics_enabled {
        return Vec::new();
    }

    // Suppress diagnostics for non-R files (JAGS, Stan)
    if document_file_type(state, uri) != FileType::R {
        return Vec::new();
    }

    let Some(doc) = state.get_document(uri) else {
        return Vec::new();
    };

    if doc.tree.is_none() {
        return Vec::new();
    }

    // Delegate to the snapshot-based pipeline (the same path used by the
    // debounced production pipeline in `run_debounced_diagnostics`). Issue
    // #135 retired the legacy collector path that previously lived here.
    diagnostics_via_snapshot(state, uri, cancel)
}
```

The early-return guards (master switch, non-R, no document, no tree) are preserved because they short-circuit before `DiagnosticsSnapshot::build` does any work — keeping the cheap-skip behavior identical to the legacy version.

**Note on cancellation behavior:** The legacy body returned partial accumulated diagnostics on cancellation (handlers.rs:3729–3730 and :3759–3760). The snapshot path (`diagnostics_from_snapshot`) returns `None` on cancellation, which `diagnostics_via_snapshot` converts to `Vec::new()` via `unwrap_or_default()`. The single production caller (`backend.rs:4135`) uses `DiagCancelToken::never()`, so production behavior is unchanged. Tests and benches that use a never-cancelling token are also unaffected. If any future caller passes a cancellable token AND depends on partial-result semantics, that caller needs to revisit the contract.

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p raven 2>&1 | tail -30`
Expected: success. Likely warnings about the now-unused legacy collectors and helpers — that's expected and addressed in Task 3.3.

### Task 3.3: Add `#[allow(dead_code)]` to the six legacy collectors

**Files:**
- Modify: `crates/raven/src/handlers.rs:4113`, `:4471`, `:4573`, `:4651`, `:5609`, `:8196`

- [ ] **Step 1: Annotate each legacy collector**

For each of the six `fn` definitions listed below, insert `#[allow(dead_code)]` on the line immediately above the `fn` keyword (after any existing doc comments and `#[cfg(...)]` attributes), with the comment `// removed in Phase 5 (issue #135)` on the line ABOVE that:

1. `fn collect_missing_file_diagnostics(` at handlers.rs:4113
2. `fn collect_max_depth_diagnostics(` at handlers.rs:4471
3. `fn collect_missing_package_diagnostics(` at handlers.rs:4573
4. `fn collect_redundant_directive_diagnostics(` at handlers.rs:4651
5. `fn collect_out_of_scope_diagnostics(` at handlers.rs:5609
6. `pub(crate) fn collect_undefined_variables_position_aware(` at handlers.rs:8196

Example pattern (use Edit tool for each; line numbers may have shifted slightly from earlier edits — find by function signature):

```rust
// (existing doc comments above)

// removed in Phase 5 (issue #135)
#[allow(dead_code)]
fn collect_out_of_scope_diagnostics(
    // ... existing parameters
)
```

The legacy tests in the same file still call these functions, so they remain reachable as long as `cfg(test)` is active. The `#[allow(dead_code)]` quiets the warning in non-test builds where they have no callers.

- [ ] **Step 2: Verify zero warnings**

Run: `cargo build -p raven 2>&1 | grep -E "^(warning|error):" | head -20`
Expected: zero warnings, zero errors.

Run: `cargo build -p raven --tests 2>&1 | grep -E "^(warning|error):" | head -20`
Expected: zero warnings, zero errors.

### Task 3.4: Un-ignore the Category B tests from Phase 1

**Files:**
- Modify: `crates/raven/src/handlers.rs` — remove `#[ignore = "..."]` from the two Category B tests added in Tasks 1.6 and 1.7

- [ ] **Step 1: Remove `#[ignore]` from `test_out_of_scope_suppresses_when_in_scope_via_backward_edge`**

Find the test added in Task 1.6 and delete the line:

```rust
#[ignore = "legacy parity gap; un-ignored in Phase 3 (issue #135)"]
```

- [ ] **Step 2: Remove `#[ignore]` from `test_out_of_scope_self_leak_does_not_emit_used_before_sourced`**

Find the test added in Task 1.7 and delete the same `#[ignore = "..."]` line.

- [ ] **Step 3: Run both tests to verify they now pass on the snapshot path**

Run:

```bash
cargo test -p raven test_out_of_scope_suppresses_when_in_scope_via_backward_edge -- --nocapture
cargo test -p raven test_out_of_scope_self_leak_does_not_emit_used_before_sourced -- --nocapture
```

Expected: both PASS.

### Task 3.5: Run full test suite + build, verify zero warnings

- [ ] **Step 1: Full test suite**

Run: `cargo test -p raven 2>&1 | tail -30`
Expected: all pass, zero ignored from Phase 1 (Category A always passed; Category B now passing).

- [ ] **Step 2: Full build**

Run: `cargo build -p raven 2>&1 | grep -E "warning|error" | head -20`
Expected: zero warnings.

- [ ] **Step 3: Test build**

Run: `cargo build -p raven --tests 2>&1 | grep -E "warning|error" | head -20`
Expected: zero warnings.

### Task 3.6: Commit Phase 3

- [ ] **Step 1: Stage and commit all Phase 3 changes**

```bash
git add crates/raven/src/handlers.rs
git commit -m "$(cat <<'EOF'
refactor: route diagnostics() through snapshot path (#135)

Phase 3 of issue #135. Replaces the body of pub fn diagnostics() with a
delegating call to diagnostics_via_snapshot (which is now lifted out of
#[cfg(feature = "test-support")] and exposed for production use).

Adds #[allow(dead_code)] to the six legacy collectors that Phase 5 will
delete; comments mark each as "removed in Phase 5 (issue #135)".

Un-ignores the two Category B tests from Phase 1 — they pass on the
snapshot path and now serve as parity locks for the deviations they
documented.

Refs: #135
EOF
)"
```

### Task 3.7: codex:rescue gate for Phase 3

- [ ] **Step 1: Hand Phase 3 commits to codex:rescue**

Dispatch a `codex:rescue` agent:

> Review the Phase 3 commit on branch `refactor/issue-135-route-diagnostics-through-snapshot`. The HEAD commit replaces `pub fn diagnostics()` body with a delegating call to `diagnostics_via_snapshot`. Spec: `docs/superpowers/specs/2026-04-30-issue-135-route-diagnostics-through-snapshot-design.md`.
>
> Audit (parity-focused, NOT compilation):
>
> 1. The single direct production caller is `crates/raven/src/backend.rs:4135` inside `Backend::publish_diagnostics`. Confirm: (a) the caller's expectations on the returned `Vec<Diagnostic>` are unchanged (e.g., it does not depend on collector ordering, on a specific message wording, or on cache state); (b) the `state.read().await` lock held around the call is not violated by `DiagnosticsSnapshot::build` acquiring fresh locks (verify at `crates/raven/src/handlers.rs:60-216` that `build()` only borrows from `&WorldState` without re-acquiring async locks); (c) `diagnostics_async_standalone` (handlers.rs:3843), the live consumer of the returned diagnostics, is unaffected because it does not introspect them.
> 2. The bench harness at `crates/raven/benches/lsp_operations.rs:263` calls `raven::handlers::diagnostics(...)` which now flows through the snapshot path. Confirm it still compiles and runs.
> 3. Watched-file fanout reaches `publish_diagnostics` indirectly through `publish_diagnostics_via_arc` (backend.rs ~3183, ~3196) and `publish_diagnostics` (~4099). Confirm: nothing in this fanout path inspects the legacy collectors directly.
> 4. Behavioral parity: `pub fn diagnostics()` previously primed a per-(line, column) `scope_cache` and shared it between out-of-scope and undefined-variables collectors. The snapshot path uses `ScopeStream` instead. The cache-priming order differs but the emitted diagnostic sets must match. Search the test suite for any test that relied on legacy cache state (e.g., asserts on internal fields) — there should be none, but flag any you find.
> 5. The two Category B tests (`test_out_of_scope_suppresses_when_in_scope_via_backward_edge`, `test_out_of_scope_self_leak_does_not_emit_used_before_sourced`) were `#[ignore]`d in Phase 1 because they fail on legacy. Confirm they now pass on the snapshot path.
>
> Write a focused report under 800 words. Lead with verdict (LGTM / minor issues / major issues / revert Phase 3). Do not modify files.

- [ ] **Step 2: Address any issues codex raises**

If codex finds parity issues, fix them. If serious enough that the snapshot path is wrong, escalate — DO NOT modify the snapshot path in this PR (that's a separate fix). If a Phase 1 test was insufficient, add another test. If the snapshot path is actually correct and the Phase 1 test was wrong, fix the test.

Do NOT proceed to Phase 4 until codex's review is LGTM or minor-issues-resolved.

---

## Phase 4: Re-run benchmarks; confirm no regression

### Task 4.1: Re-run bench, append to baseline doc

**Files:**
- Modify: `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md`

- [ ] **Step 1: Run bench**

Run: `cargo bench --bench lsp_operations -- lsp_diagnostics 2>&1 | tee /tmp/bench-phase4.txt`
Expected: same fixtures as Phase 2; Criterion's `target/criterion/` already contains the previous run, so the new run reports `change` (percent and absolute) against it directly.

- [ ] **Step 2: Extract numbers from Criterion's JSON output**

Stdout text format varies between Criterion versions; the JSON estimates files are stable. For each fixture, read:

```bash
# Replace `<bench_name>` with the actual fixture path under target/criterion/.
# Each fixture has a directory: target/criterion/lsp_diagnostics/diagnostics/<fixture_name>/
ls target/criterion/lsp_diagnostics/diagnostics/
```

For each fixture name, the relevant files are:
- `new/estimates.json` — current run's mean, median, std dev, with confidence intervals.
- `change/estimates.json` — percent and absolute change from prior run, with confidence intervals on the change.

Inspect them with `jq`:

```bash
for fixture in $(ls target/criterion/lsp_diagnostics/diagnostics/); do
    echo "=== $fixture ==="
    echo "Current:"
    jq '.mean.point_estimate, .mean.confidence_interval' \
       "target/criterion/lsp_diagnostics/diagnostics/$fixture/new/estimates.json"
    echo "Change:"
    jq '.mean.point_estimate, .mean.confidence_interval' \
       "target/criterion/lsp_diagnostics/diagnostics/$fixture/change/estimates.json"
done
```

Mean point estimates are in **nanoseconds**. Confidence intervals on change are **fractions** (0.05 = 5%).

- [ ] **Step 3: Append results to baseline doc**

Open `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` and add a new section:

```markdown
## Phase 4 Results (post-delegation)

**Captured on:** <date>
**Commit:** <run `git rev-parse HEAD` and paste here>
**Phase:** 4 (snapshot path, post-delegation)

| Fixture | Mean | Std Dev | 95% CI lower | 95% CI upper | % change | Mean Δ |
|---|---|---|---|---|---|---|
| `lsp_diagnostics/diagnostics/small_10` | <fill in> | <fill in> | <fill in> | <fill in> | <fill in>% | <fill in> |
| `lsp_diagnostics/diagnostics/medium_50` | <fill in> | <fill in> | <fill in> | <fill in> | <fill in>% | <fill in> |
| `<large fixture if added>` | … | … | … | … | … | … |

## Acceptance gates

- [ ] **Gate 1: CI lower bound on percent change ≤ 15% on `medium_50`** (and `large` if added). _Result: <fill in>._
- [ ] **Gate 2: Per-iteration mean increase ≤ 5 ms on every fixture.** _Result: <fill in>._
- [ ] **Gate 3: Same gates apply to fanout-shaped fixture (if added in Phase 2).** _Result: <fill in>._

## Verdict

<PASS / FAIL — if FAIL, describe the failing gate and the proposed mitigation.>
```

Fill in the actual numbers from the `jq` output above (mean, CI bounds, percent change). Mark gates checked if they pass.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md
git commit -m "bench: capture post-delegation diagnostics numbers (#135)"
```

### Task 4.2: Evaluate gates; codex:rescue gate for Phase 4

- [ ] **Step 1: If any gate fails**

Profile the snapshot build to find the culprit:

```bash
cargo build --release -p raven --features test-support
```

Then write a small profiling harness or use `crates/raven/examples/profile_diagnostics.rs` (referenced in CLAUDE.md learnings) to print per-phase timing. The candidates are:
- `DiagnosticsSnapshot::build` cycle detection (`detect_cycle`)
- `cached_neighborhood_subgraph` (neighborhood collection)
- `diagnostics_from_snapshot`'s `ScopeStream` allocation overhead

Investigate before proceeding. If unfixable in this PR, revert Phase 3 and re-scope the issue.

- [ ] **Step 2: If all gates pass — hand to codex:rescue**

Dispatch a `codex:rescue` agent:

> Review the bench results in `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md` (Phase 2 baseline + Phase 4 post-delegation).
>
> The Phase 4 section asserts Gate 1 (CI lower bound ≤ 15% on `medium_50`), Gate 2 (per-iteration mean ≤ 5 ms increase), Gate 3 (same gates on fanout fixture if added). Verify each gate's pass/fail evaluation against the actual numbers.
>
> Sanity-check: are the absolute numbers plausible? E.g., snapshot `medium_50` should be in the same order of magnitude as legacy. A 50× regression would indicate something pathological (e.g., neighborhood collection looping or cache-miss storms).
>
> Write a focused report under 300 words. Lead with: PROCEED TO PHASE 5 / INVESTIGATE FURTHER / REVERT PHASE 3.

Do NOT proceed to Phase 5 until codex says PROCEED.

---

## Phase 5: Delete legacy collectors and migrate tests

### Task 5.1: Delete the six legacy collectors

**Files:**
- Modify: `crates/raven/src/handlers.rs` (delete 6 functions and their helpers)

- [ ] **Step 0: Locate current line numbers (line numbers below are pre-PR)**

Phase 3's edits will have shifted line numbers. Get the current locations:

```bash
rg -n "^(fn|pub\(crate\) fn) collect_(missing_file_diagnostics|max_depth_diagnostics|missing_package_diagnostics|redundant_directive_diagnostics|out_of_scope_diagnostics|undefined_variables_position_aware)\b" crates/raven/src/handlers.rs
```

The exclusion of `_from_snapshot` and `_async` is intentional — only the legacy non-snapshot variants are deleted. Save the output (six `<file>:<line>` pairs) to use in the steps below.

- [ ] **Step 1: Delete `collect_missing_file_diagnostics` (handlers.rs:4113)**

Find the function definition (likely starting with `// removed in Phase 5 (issue #135)\n#[allow(dead_code)]\nfn collect_missing_file_diagnostics(`). Delete the comment, the `#[allow(dead_code)]`, and the entire function body up to and including the closing `}`. Also delete any preceding doc comments that refer to it.

- [ ] **Step 2: Delete `collect_max_depth_diagnostics` (handlers.rs:4471)**

Same procedure.

- [ ] **Step 3: Delete `collect_missing_package_diagnostics` (handlers.rs:4573)**

Same procedure.

- [ ] **Step 4: Delete `collect_redundant_directive_diagnostics` (handlers.rs:4651)**

Same procedure.

- [ ] **Step 5: Delete `collect_out_of_scope_diagnostics` (handlers.rs:5609)**

Same procedure.

- [ ] **Step 6: Delete `collect_undefined_variables_position_aware` (handlers.rs:8196)**

Same procedure. Note: this is `pub(crate) fn`, but it has no callers outside this file (verified earlier via grep), so it's safe to delete.

- [ ] **Step 7: Build and identify cascading dead code**

Run: `cargo build -p raven --tests 2>&1 | grep -E "^warning|^error" | head -40`

Expected: error/warning lines pointing to:
- Test functions in `mod tests` that called the deleted collectors directly (these are migrated in Task 5.2).
- Helper functions used only by the deleted collectors. Examples might include `get_cross_file_scope` (legacy variants), `prime_scope_cache_for_legacy`, etc.

Make a list of all helpers reported as dead. For each, check whether it's a helper used ONLY by the deleted collectors:

```bash
grep -n "fn <helper_name>" crates/raven/src/handlers.rs
grep -n "<helper_name>(" crates/raven/src/handlers.rs | head -20
```

If a helper has no callers OR is called only from the deleted code, delete it. If it's still used by the snapshot path or shared collectors, keep it.

- [ ] **Step 8: After dead-code cascade is removed, build cleanly**

Run: `cargo build -p raven 2>&1 | grep -E "^warning|^error"`
Expected: empty (zero warnings, zero errors).

The test build will still fail because Task 5.2's migrations haven't happened — that's expected.

### Task 5.2: Migrate or delete legacy-collector tests

**Files:**
- Modify: `crates/raven/src/handlers.rs` (~57 in-file tests inside `mod tests`)

**First — clean up imports.** The test module's `use` block (around handlers.rs:34785–34810, find via `grep -n "fn create_test_state" crates/raven/src/handlers.rs`) brings the now-deleted legacy collector names into scope. After Task 5.1's deletion, these `use` items must be removed too. Search:

```bash
grep -n "use super::collect_\(missing_file_diagnostics\|max_depth_diagnostics\|missing_package_diagnostics\|redundant_directive_diagnostics\|out_of_scope_diagnostics\|undefined_variables_position_aware\)" crates/raven/src/handlers.rs
```

Remove each matching `use` line. Some imports may also be inline within tests (e.g., `super::collect_X(...)`); those must be migrated as part of the per-test work below.

The migration target for each test is one of:

1. **Replace direct call with `diagnostics_via_snapshot(&state, &uri, &DiagCancelToken::never())`** — the test asserts on resulting `Diagnostic` shape from the full pipeline.
2. **Replace direct call with the matching `*_from_snapshot` variant by building a `DiagnosticsSnapshot` first** — the test isolates one collector. Pattern:

   ```rust
   let snapshot = DiagnosticsSnapshot::build(&state, &uri).expect("snapshot build");
   let mut diagnostics = Vec::new();
   collect_X_from_snapshot(&snapshot, &uri, /* ... */, &mut diagnostics, /* ... */);
   ```

3. **Delete** — the test asserts a behavior covered by an existing snapshot-path test, and the duplication is not worth keeping.

**Choice rule** (mechanical):
- Multi-collector or full-pipeline assertions → option 1
- Single-collector with isolated arguments → option 2
- Duplicate of an existing snapshot-path test → option 3

Use grep to find the call sites:

```bash
grep -n "collect_out_of_scope_diagnostics\|collect_undefined_variables_position_aware\|collect_max_depth_diagnostics\|collect_missing_file_diagnostics\|collect_missing_package_diagnostics\|collect_redundant_directive_diagnostics" crates/raven/src/handlers.rs
```

(The collectors themselves are gone; remaining references are exclusively in test bodies.)

The list as of the start of Phase 5 is approximately:
- `collect_out_of_scope_diagnostics`: 3 test sites (around lines 33530, 33598, 33671 — pre-deletion line numbers; will shift)
- `collect_undefined_variables_position_aware`: ~30+ test sites (in `mod tests`, around lines 24000–35270)
- `collect_max_depth_diagnostics`, `collect_missing_file_diagnostics`, `collect_missing_package_diagnostics`, `collect_redundant_directive_diagnostics`: ~10 test sites each (around lines 32898–33480, 33170–33296)

Process them in **batches of 5–10 tests per commit**, running `cargo test -p raven` after each batch.

#### Sub-task 5.2.A: Migrate `collect_out_of_scope_diagnostics` test sites

- [ ] **Step 1: Find each test that calls `collect_out_of_scope_diagnostics(...)` directly**

```bash
grep -n "collect_out_of_scope_diagnostics(" crates/raven/src/handlers.rs
```

For each test:

- If it asserts on the diagnostic Vec from a single collector pass with no cross-talk — use option 2 (build `DiagnosticsSnapshot`, call `collect_out_of_scope_diagnostics_from_snapshot`).
- If it tests a cross-collector concern — use option 1 (`diagnostics_via_snapshot`).

Example migration pattern (option 1):

Before:
```rust
let mut diagnostics = Vec::new();
collect_out_of_scope_diagnostics(
    &state,
    &main_url,
    tree.root_node(),
    main_code,
    &meta,
    &mut diagnostics,
    &mut std::collections::HashMap::new(),
    &DiagCancelToken::never(),
);
```

After:
```rust
let diagnostics = diagnostics_via_snapshot(&state, &main_url, &DiagCancelToken::never());
```

Example migration pattern (option 2):

Before: same as above.

After:
```rust
let snapshot = DiagnosticsSnapshot::build(&state, &main_url)
    .expect("snapshot built for main.R");
let mut diagnostics = Vec::new();
let mut scope_cache = std::collections::HashMap::new();
collect_out_of_scope_diagnostics_from_snapshot(
    &snapshot,
    &main_url,
    snapshot.tree.root_node(),
    &snapshot.text,
    &mut diagnostics,
    &mut scope_cache,
    &DiagCancelToken::never(),
);
```

(Verify the exact signature of `collect_out_of_scope_diagnostics_from_snapshot` at handlers.rs:4985 and adjust the call.)

The test no longer needs the local `tree`, `main_code`, or `meta` variables — they live inside the snapshot. If the test still uses them for assertions (e.g., position calculations), keep them; otherwise remove.

- [ ] **Step 2: Migrate each test in this group, build after each**

```bash
cargo build -p raven --tests 2>&1 | grep "^error" | head -10
```

- [ ] **Step 3: Run the migrated tests**

```bash
cargo test -p raven test_out_of_scope -- --nocapture
```

Expected: all pass.

- [ ] **Step 4: Commit this batch**

```bash
git add crates/raven/src/handlers.rs
git commit -m "test: migrate out_of_scope tests to snapshot path (#135)"
```

#### Sub-task 5.2.B: Migrate `collect_missing_file_diagnostics` test sites

Repeat the procedure from 5.2.A:
- Find call sites.
- Migrate each (option 1 or 2; the corresponding `_from_snapshot` collector is at handlers.rs:4830).
- Build, test, commit.

```bash
git add crates/raven/src/handlers.rs
git commit -m "test: migrate missing_file tests to snapshot path (#135)"
```

#### Sub-task 5.2.C: Migrate `collect_max_depth_diagnostics` test sites

Same procedure. Snapshot collector at handlers.rs:4775. Commit:

```bash
git add crates/raven/src/handlers.rs
git commit -m "test: migrate max_depth tests to snapshot path (#135)"
```

#### Sub-task 5.2.D: Migrate `collect_missing_package_diagnostics` test sites

Same procedure. Snapshot collector at handlers.rs:4901. Commit:

```bash
git add crates/raven/src/handlers.rs
git commit -m "test: migrate missing_package tests to snapshot path (#135)"
```

#### Sub-task 5.2.E: Migrate `collect_redundant_directive_diagnostics` test sites

Same procedure. Snapshot collector at handlers.rs:4942. Commit:

```bash
git add crates/raven/src/handlers.rs
git commit -m "test: migrate redundant_directive tests to snapshot path (#135)"
```

#### Sub-task 5.2.F: Migrate `collect_undefined_variables_position_aware` test sites

This is the largest batch (~30+ sites). Migrate in groups of 5–10 tests, committing after each. Snapshot collector at handlers.rs:5240.

The snapshot collector signature differs from the legacy version — verify by reading handlers.rs:5240 first. The key difference: snapshot reads `state.workspace_imports`, `state.package_library`, `directive_meta` from the `DiagnosticsSnapshot`, so the test no longer threads them as separate arguments.

For each batch:

```bash
cargo test -p raven test_undefined -- --nocapture
git add crates/raven/src/handlers.rs
git commit -m "test: migrate undefined_variables batch <N> to snapshot path (#135)"
```

### Task 5.3: Update CLAUDE.md

**Files:**
- Modify: `/Users/jmb/repos/raven/CLAUDE.md` (two distinct bullets)

The CLAUDE.md Learnings section has two bullets that reference the dual-path
parallelism. **Both must be updated, not deleted** — they encode invariants
(`live_top_level_exports`, workspace_imports gate) that still apply to the
snapshot-only pipeline.

- [ ] **Step 1: Locate the two affected bullets**

Run:

```bash
grep -n "collect_undefined_variables_position_aware\|BOTH must be fixed\|live_top_level_exports" CLAUDE.md | head -10
```

The two affected bullets, as of this PR's start (line numbers may shift):
- Line ~180 — workspace_imports / package-exists gate. Mentions
  `collect_undefined_variables_from_snapshot` AND
  `collect_undefined_variables_position_aware`.
- Line ~211 — the `live_top_level_exports` invariant + the long "BOTH must be
  fixed" narrative listing five rm-sensitive call sites across both paths.

- [ ] **Step 2: Update the workspace-imports bullet (~line 180)**

Use the Edit tool. Find the substring:

```
Apply the same gate in both `collect_undefined_variables_from_snapshot` and `collect_undefined_variables_position_aware`.
```

Replace with:

```
Apply the gate in `collect_undefined_variables_from_snapshot` (the legacy `collect_undefined_variables_position_aware` was retired in issue #135).
```

- [ ] **Step 3: Update the `live_top_level_exports` bullet (~line 211)**

Find the long bullet starting with "The undefined-variable diagnostic has a fallback path…" and ending with "…`test_live_top_level_exports_*` for the helper itself (long-form `remove()`, repeated rm/redef, function-local rm exclusion)."

Replace the whole bullet with a snapshot-only version. Specific edits within the bullet:

1. Change "Five rm-sensitive call sites total:" to "Three rm-sensitive call sites in the snapshot pipeline (the legacy mirrors were retired in issue #135):"
2. Delete items `(3) legacy direct-source fallback in collect_undefined_variables_position_aware` and `(4) legacy local_opt hoist-globals fast path (same function)` from the numbered list. Renumber the remaining items as `(1)`, `(2)`, `(3)`.
3. After "snapshot use-before-source attribution `source_target_live_exports` in `collect_out_of_scope_diagnostics_from_snapshot`," delete the trailing clause "; plus its legacy counterpart `source_symbols` in `collect_out_of_scope_diagnostics`."
4. Delete the sentence "The diagnostic pipeline has BOTH a legacy path (...) and a snapshot path (...). BOTH must be fixed; a fix that only touches one leaves the other broken in production."
5. In the regression coverage list, change "test_rm_in_directly_sourced_child_propagates_to_parent_diagnostics (legacy + snapshot diagnostic paths in one test)" to "test_rm_in_directly_sourced_child_propagates_to_parent_diagnostics (snapshot diagnostic path)".

- [ ] **Step 4: Verify no other bullets reference the deleted collectors**

```bash
grep -n "collect_undefined_variables_position_aware\|collect_out_of_scope_diagnostics[^_]\|collect_max_depth_diagnostics[^_]\|collect_missing_file_diagnostics[^_]\|collect_missing_package_diagnostics[^_]\|collect_redundant_directive_diagnostics[^_]" CLAUDE.md
```

Expected: no matches. (The `[^_]` tail excludes `*_from_snapshot` variants which contain underscores.)

If any matches remain, update or remove the surrounding text with similar precision.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: consolidate dual-path learnings to snapshot-only (#135)"
```

### Task 5.4: Final test + build verification

- [ ] **Step 1: Full test suite**

Run: `cargo test -p raven 2>&1 | tail -30`
Expected: all pass, zero ignored from this PR's additions.

- [ ] **Step 2: Full release build**

Run: `cargo build -p raven 2>&1 | grep -E "^warning|^error"`
Expected: empty.

- [ ] **Step 3: Test build**

Run: `cargo build -p raven --tests 2>&1 | grep -E "^warning|^error"`
Expected: empty.

- [ ] **Step 4: Bench compiles**

Run: `cargo bench --bench lsp_operations --no-run 2>&1 | tail -10`
Expected: compiles cleanly.

### Task 5.5: codex:rescue gate for Phase 5

- [ ] **Step 1: Hand Phase 5 commits to codex:rescue**

Dispatch a `codex:rescue` agent:

> Review Phase 5 of issue #135 on branch `refactor/issue-135-route-diagnostics-through-snapshot`. Phase 5 deletes six legacy diagnostic collectors and migrates ~57 in-file tests. Spec: `docs/superpowers/specs/2026-04-30-issue-135-route-diagnostics-through-snapshot-design.md`.
>
> Audit:
>
> 1. Dead-code scan: run `cargo build -p raven 2>&1` and `cargo build -p raven --tests 2>&1`. Both must produce zero warnings about unused functions, unused variables, or unused imports introduced by this PR.
> 2. CLAUDE.md edit: confirm the "BOTH must be fixed" Learning has been replaced with a single-line note. Confirm no other Learning still references the dual path. Verify the surrounding text still reads naturally.
> 3. Test migration spot-check: pick 3 random migrated tests and verify the migration target was appropriate (option 1 for cross-collector, option 2 for single-collector, option 3 for true duplicates). Flag any test that was deleted but whose assertion is NOT covered by an existing snapshot-path test.
> 4. Confirm no `*_from_snapshot` caller still has a legacy fallback (e.g., `if let Some(fb) = legacy_collect(...)`).
> 5. Confirm the `diagnostics_async_standalone` function (handlers.rs:3843) and the async missing-file helpers around handlers.rs:3867 are intact (the spec explicitly preserved these; verify they were not deleted by mistake).
>
> Write a focused report under 600 words. Lead with verdict (LGTM / minor issues / major issues). Do not modify files.

- [ ] **Step 2: Address any issues codex raises**

If codex finds undeleted helpers, undocumented removals, or test-migration gaps, fix them and commit.

### Task 5.6: Open the PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin refactor/issue-135-route-diagnostics-through-snapshot
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "refactor: route diagnostics() through snapshot path; delete legacy collectors (#135)" --body "$(cat <<'EOF'
## Summary

- Eliminates the legacy diagnostic path in `crates/raven/src/handlers.rs`. `pub fn diagnostics()` now delegates to the snapshot pipeline (`DiagnosticsSnapshot::build` → `diagnostics_from_snapshot`), which is the same path the debounced production pipeline (`run_debounced_diagnostics`) already uses.
- Deletes six legacy collectors (`collect_out_of_scope_diagnostics`, `collect_undefined_variables_position_aware`, `collect_max_depth_diagnostics`, `collect_missing_file_diagnostics`, `collect_missing_package_diagnostics`, `collect_redundant_directive_diagnostics`) and migrates ~57 in-file tests to use the snapshot path or matching `*_from_snapshot` collectors.
- Adds 7 parity-gap tests (5 regression locks, 2 deviations from issue #135) covering `@lsp-cd`, workspace-root fallback, `local=TRUE`, non-global `sys.source`, `sys.source` with global env, in-scope-via-backward-edge suppression, and the `xyz <- xyz` self-leak shape.
- Updates CLAUDE.md to drop the "BOTH must be fixed" Learning.

Closes #135.

## Test plan

- [ ] `cargo test -p raven` — all pass, zero ignored from this PR.
- [ ] `cargo build -p raven` — zero warnings.
- [ ] `cargo build -p raven --tests` — zero warnings.
- [ ] `cargo bench --bench lsp_operations -- lsp_diagnostics` — compares against pre-delegation baseline; results recorded in `docs/superpowers/specs/2026-04-30-issue-135-bench-baseline.md`.
- [ ] Smoke test in VS Code: open a workspace with `@lsp-cd` directives and confirm diagnostics surface correctly for cross-file source chains.
EOF
)"
```

- [ ] **Step 3: Return PR URL**

The `gh pr create` command prints the PR URL. Note it for the user.

---

## Self-review checklist

- [x] **Spec coverage:** Every section of the spec has at least one task. Phases 1–5 map directly. Acceptance criteria from the spec are addressed:
  - "thin wrapper" → Task 3.2
  - "legacy collectors deleted" → Task 5.1
  - "test suite passes" → Tasks 1.8, 3.5, 5.4
  - "CLAUDE.md updated" → Task 5.3
  - "regression test or bench" → Tasks 2.1, 4.1
  - "test coverage for @lsp-cd, workspace-root fallback, local=TRUE, sys.source" → Tasks 1.1–1.5
- [x] **Placeholder scan:** No "TBD" or "implement later" in tasks. The bench result tables have `<fill in>` slots — these are explicit "fill in actual numbers" instructions, not abstract placeholders. Phase 2's `large` fixture decision is delegated to codex with concrete instructions.
- [x] **Type consistency:** Function signatures and module paths verified against handlers.rs line references at plan-write time. Snapshot-collector call patterns mirror the existing `test_self_referential_assignment_does_not_emit_used_before_sourced` test (handlers.rs:35660). The Phase 1 tests use `tower_lsp::lsp_types::DiagnosticSeverity::WARNING` (matching existing tests at handlers.rs:35663).
- [x] **Diagnostic message split:** Phase 1 tests use message-substring assertions that work on BOTH paths (path-agnostic via `'helper'` || `Symbol 'helper'` patterns).
