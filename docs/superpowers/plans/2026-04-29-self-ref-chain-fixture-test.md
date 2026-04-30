# Self-Contained Fixture for Cross-File Scope Regression Test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `#[ignore]` `debug_real_worldwide_data_r` test (which depends on `~/repos/worldwide`) with a self-contained `#[test]` that exercises the same invariants via a 10-file fixture workspace.

**Architecture:** Add `SelfRefChainFixture` struct + `create_self_ref_chain_fixture()` builder to `fixture_workspace.rs`, then write the replacement test in `handlers.rs` using those helpers. Delete the old test. Two files touched, no other changes.

**Tech Stack:** Rust, `tempfile::TempDir`, `url::Url`, existing `WorldState` / `DiagnosticsSnapshot` / `diagnostics_from_snapshot` APIs in `crates/raven/src/handlers.rs`.

---

## Implementation Tasks

### Task 1: Add `SelfRefChainFixture` struct and builder to `fixture_workspace.rs`

**Files:**
- Modify: `crates/raven/src/test_utils/fixture_workspace.rs`

- [ ] **Step 1: Add the `Url` import and the `SelfRefChainFixture` struct**

  Open `crates/raven/src/test_utils/fixture_workspace.rs`. The current imports (lines 9–11) are:

  ```rust
  use std::fmt::Write;
  use std::path::Path;
  use tempfile::TempDir;
  ```

  Add `use url::Url;` so the block becomes:

  ```rust
  use std::fmt::Write;
  use std::path::Path;
  use tempfile::TempDir;
  use url::Url;
  ```

  Then, immediately after the existing `FixtureConfig` struct and its `impl` block (search for `impl FixtureConfig` to find the end of it), add the new struct:

  ```rust
  /// Fixture for testing cross-file scope invariants: a 10-file linear
  /// source() chain with a self-referential assignment in the middle file.
  pub struct SelfRefChainFixture {
      /// Keeps the TempDir alive for the test's duration. Prefixed with `_`
      /// to signal intentional non-use while still dropping at end of scope.
      pub _dir: TempDir,
      /// All 10 file URIs in chain order: file_0.R (root) through file_9.R (leaf).
      pub all_uris: Vec<Url>,
      /// URI of file_5.R — the "mid-chain" file containing `xyz <- xyz`.
      pub mid_file_uri: Url,
      /// 0-indexed line of `xyz <- xyz` in file_5.R (line 2).
      pub mid_xyz_line: u32,
      /// 0-indexed column of the RHS `xyz` in `xyz <- xyz`.
      /// Layout (zero-based columns): `x`@0, `y`@1, `z`@2, ` `@3, `<`@4, `-`@5, ` `@6, `x`@7.
      /// So the RHS `xyz` starts at column 7.
      pub mid_xyz_rhs_col: u32,
  }
  ```

- [ ] **Step 2: Add the `create_self_ref_chain_fixture()` builder function**

  Immediately after the `SelfRefChainFixture` struct, add:

  ```rust
  /// Creates a self-contained 10-file fixture workspace for testing cross-file
  /// scope invariants.
  ///
  /// Chain layout: file_0.R → file_1.R → … → file_9.R
  ///
  /// - file_0.R: `library(dplyr)` + `source("file_1.R")`
  /// - file_1.R–file_4.R: pass-through (define func_N, source next)
  /// - file_5.R: `func_5`, `source("file_6.R")`, `xyz <- xyz`  ← key file
  /// - file_6.R–file_8.R: pass-through
  /// - file_9.R: `func_9`, `leaf_var <- 42`  ← leaf definition
  pub fn create_self_ref_chain_fixture() -> SelfRefChainFixture {
      let dir = TempDir::new().expect("create temp dir for self-ref chain fixture");

      for i in 0..10usize {
          let content = match i {
              0 => "library(dplyr)\nsource(\"file_1.R\")\n".to_owned(),
              5 => "func_5 <- function(x) x + 1\nsource(\"file_6.R\")\nxyz <- xyz\n".to_owned(),
              9 => "func_9 <- function(x) x + 1\nleaf_var <- 42\n".to_owned(),
              n => format!(
                  "func_{n} <- function(x) x + 1\nsource(\"file_{next}.R\")\n",
                  n = n,
                  next = n + 1
              ),
          };
          let path = dir.path().join(format!("file_{}.R", i));
          std::fs::write(&path, content).expect("write fixture file");
      }

      let all_uris: Vec<Url> = (0..10)
          .map(|i| {
              Url::from_file_path(dir.path().join(format!("file_{}.R", i)))
                  .expect("URI from fixture path")
          })
          .collect();

      let mid_file_uri = all_uris[5].clone();

      SelfRefChainFixture {
          _dir: dir,
          all_uris,
          mid_file_uri,
          mid_xyz_line: 2,
          mid_xyz_rhs_col: 7,
      }
  }
  ```

- [ ] **Step 3: Verify it compiles**

  ```bash
  cargo build -p raven 2>&1 | head -30
  ```

  Expected: no errors. (Warnings are fine.)

- [ ] **Step 4: Commit**

  ```bash
  git add crates/raven/src/test_utils/fixture_workspace.rs
  git commit -m "test: add SelfRefChainFixture and create_self_ref_chain_fixture builder"
  ```

---

### Task 2: Write the replacement test in `handlers.rs`

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Write the new test**

  The test module in `handlers.rs` is opened by `mod tests {` at line 12646. The old `debug_real_worldwide_data_r` test lives at line 35601. Add the new test **immediately before** `debug_real_worldwide_data_r` (so it's easy to see the two side by side before deleting the old one). Insert at line 35599 (just before the doc comment for `debug_real_worldwide_data_r`):

  ```rust
      /// Regression test for the cross-file scope "same-file leak filter" and
      /// `visible_from` semantics. Uses a self-contained 10-file fixture so CI
      /// does not depend on ~/repos/worldwide.
      ///
      /// Invariants verified:
      /// 1. At the RHS of `xyz <- xyz` in file_5.R, `xyz` is NOT in scope
      ///    (visible_from = end of assignment node, not LHS position).
      /// 2. `leaf_var` (defined in file_9.R) IS in scope at the same point,
      ///    confirming the DFS actually traversed the file_6→…→file_9 suffix.
      /// 3. `dplyr` (library() in file_0.R) appears in inherited/loaded packages,
      ///    confirming library() propagates across all 5 source() edges.
      /// 4. The "Undefined variable: xyz" diagnostic fires in the full pipeline.
      #[test]
      fn self_ref_variable_not_in_scope_across_deep_source_chain() {
          use crate::test_utils::fixture_workspace::create_self_ref_chain_fixture;
          use tower_lsp::lsp_types::DiagnosticSeverity;

          let fixture = create_self_ref_chain_fixture();

          let mut state = crate::state::WorldState::new(vec![]);
          state.workspace_scan_complete = true;
          // undefined_variables_enabled and diagnostics_enabled default to true;
          // out_of_scope_severity just needs to be non-None to enable that collector.
          state.cross_file_config.out_of_scope_severity =
              Some(DiagnosticSeverity::WARNING);

          let workspace_url =
              url::Url::from_file_path(fixture._dir.path()).expect("workspace url");

          for uri in &fixture.all_uris {
              let path = uri.to_file_path().expect("uri to path");
              let content = std::fs::read_to_string(&path).expect("read fixture file");
              state
                  .documents
                  .insert(uri.clone(), crate::Document::new(&content, None));
              state.cross_file_graph.update_file(
                  uri,
                  &crate::cross_file::extract_metadata(&content),
                  Some(&workspace_url),
                  |_| None,
              );
          }

          let snapshot =
              DiagnosticsSnapshot::build(&state, &fixture.mid_file_uri).expect("snapshot");
          let diags =
              diagnostics_from_snapshot(&snapshot, &fixture.mid_file_uri, &DiagCancelToken::never())
                  .expect("diagnostics");

          // Single scope query at the RHS position — used for assertions 1–3.
          let rhs_scope = snapshot.get_scope(
              &fixture.mid_file_uri,
              fixture.mid_xyz_line,
              fixture.mid_xyz_rhs_col,
              &DiagCancelToken::never(),
              None,
          );

          // 1. Negative: xyz must NOT leak back as visible at its own RHS.
          assert!(
              !rhs_scope.symbols.contains_key("xyz"),
              "xyz must NOT be visible at the RHS of its own assignment; \
               visible symbols: {:?}",
              rhs_scope.symbols.keys().collect::<Vec<_>>()
          );

          // 2. Positive: leaf_var from file_9.R must be reachable via the chain.
          assert!(
              rhs_scope.symbols.contains_key("leaf_var"),
              "leaf_var (defined in file_9.R) must be in scope at the query point \
               (confirms DFS traversed the full suffix); \
               visible symbols: {:?}",
              rhs_scope.symbols.keys().collect::<Vec<_>>()
          );

          // 3. Package propagation: dplyr loaded in file_0.R must propagate.
          let has_dplyr = rhs_scope.inherited_packages.iter().any(|p| p == "dplyr")
              || rhs_scope.loaded_packages.iter().any(|p| p == "dplyr");
          assert!(
              has_dplyr,
              "dplyr (library() in file_0.R) must propagate to mid-chain scope; \
               inherited={:?}, loaded={:?}",
              rhs_scope.inherited_packages, rhs_scope.loaded_packages
          );

          // 4. Diagnostic: the pipeline must also report "Undefined variable: xyz".
          assert!(
              diags.iter().any(|d| d.message.contains("Undefined variable: xyz")),
              "Expected 'Undefined variable: xyz' diagnostic; got: {:?}",
              diags.iter().map(|d| &d.message).collect::<Vec<_>>()
          );
      }
  ```

- [ ] **Step 2: Run the new test to verify it passes**

  ```bash
  cargo test -p raven self_ref_variable_not_in_scope_across_deep_source_chain 2>&1 | tail -20
  ```

  Expected output includes:

  ```text
  test tests::self_ref_variable_not_in_scope_across_deep_source_chain ... ok
  ```

  If it fails, diagnose from the assertion message before proceeding.

- [ ] **Step 3: Commit the passing test (before deleting the old one)**

  ```bash
  git add crates/raven/src/handlers.rs
  git commit -m "test: add self_ref_variable_not_in_scope_across_deep_source_chain"
  ```

---

### Task 3: Delete the old `#[ignore]` test

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Delete `debug_real_worldwide_data_r`**

  The function spans from the doc comment at line 35595 (approximately — it follows the new test now) to its closing `}`. Delete the entire block: the 4-line doc comment, the `#[test]`, the `#[ignore]` annotation, and the entire function body including its closing brace.

  The block to delete begins with:
  ```rust
      /// Reproduce against the user's real worldwide files. Inserts every
  ```
  and ends with:
  ```rust
      }
  ```
  (the closing brace of `debug_real_worldwide_data_r`, followed by a blank line before the next item in `mod tests`).

  The easiest way: search for `fn debug_real_worldwide_data_r` to find the exact current line, then delete from the `///` comment above `#[test]` down through the closing `}` of the function.

- [ ] **Step 2: Verify the test suite still compiles and the new test still passes**

  ```bash
  cargo test -p raven self_ref_variable_not_in_scope_across_deep_source_chain 2>&1 | tail -10
  ```

  Expected:

  ```text
  test tests::self_ref_variable_not_in_scope_across_deep_source_chain ... ok
  ```

- [ ] **Step 3: Run the full test suite to check for regressions**

  ```bash
  cargo test -p raven 2>&1 | tail -20
  ```

  Expected: all tests pass; `debug_real_worldwide_data_r` no longer appears in the output.

- [ ] **Step 4: Commit**

  ```bash
  git add crates/raven/src/handlers.rs
  git commit -m "test: remove #[ignore] debug_real_worldwide_data_r (replaced by fixture test)"
  ```

---

## Self-Review

**Spec coverage:**
- ✅ 10-file chain (Task 1, Step 2 — `file_0.R`–`file_9.R`)
- ✅ `library()` propagation (assertion 3 in Task 2, Step 1)
- ✅ Self-referential assignment in mid-chain file (`xyz <- xyz` in `file_5.R`)
- ✅ Positive assertion (`leaf_var` reachable — assertion 2)
- ✅ `create_self_ref_chain_fixture()` in `fixture_workspace.rs` (Task 1)
- ✅ Plain `#[test]`, no `#[ignore]` (Task 2)
- ✅ Old test deleted (Task 3)
- ✅ Codex-noted items: `Url` import (Task 1 Step 1), `.expect()` on `Option` return (Task 2 Step 1), `package_library_ready` note (doc comment in Task 2 Step 1 — `undefined_variables_enabled` and `diagnostics_enabled` default true)

**Placeholder scan:** No TBDs, no "implement later", no vague steps. All code blocks are complete.

**Type consistency:**
- `SelfRefChainFixture` fields (`_dir`, `all_uris`, `mid_file_uri`, `mid_xyz_line`, `mid_xyz_rhs_col`) used consistently across Task 1 and Task 2.
- `create_self_ref_chain_fixture()` returns `SelfRefChainFixture` in Task 1; Task 2 calls it as `let fixture = create_self_ref_chain_fixture()` — consistent.
- `DiagnosticsSnapshot::build` → `.expect("snapshot")`, `diagnostics_from_snapshot` → `.expect("diagnostics")` — both `Option` returns handled correctly.
