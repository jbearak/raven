# Design: Self-Contained Fixture for Cross-File Scope Regression Test

**Date:** 2026-04-29  
**Branch:** `t3code/optimize-diagnostic-updates`  
**Replaces:** `debug_real_worldwide_data_r` (`#[ignore]`) in `crates/raven/src/handlers.rs`

---

## Problem

`debug_real_worldwide_data_r` is an `#[ignore]` integration test that depends on `~/repos/worldwide`, a live 413-file R workspace. It breaks whenever those files change on disk (e.g., shifting line numbers). The two invariants it guards are important:

1. The "same-file leak filter": at the RHS of `xyz <- xyz`, `xyz` must NOT be in scope — the `visible_from` semantics ensure the binding isn't installed until the end of the assignment node.
2. The resulting "Undefined variable: xyz" diagnostic must fire.

## Goal

Replace the `#[ignore]` test with a self-contained `#[test]` that exercises the same invariants plus library propagation and deep-chain memoization, without depending on any external workspace.

---

## Fixture Layout

`create_self_ref_chain_fixture()` (new function in `fixture_workspace.rs`) creates a `TempDir` with 10 files forming a linear `source()` chain.

| File | Content |
|---|---|
| `file_0.R` | `library(dplyr)` + `source("file_1.R")` |
| `file_1.R`–`file_4.R` | `func_N <- function(x) x + 1` + `source("file_N+1.R")` |
| `file_5.R` | `func_5 <- function(x) x + 1` + `source("file_6.R")` + `xyz <- xyz` |
| `file_6.R`–`file_8.R` | `func_N <- function(x) x + 1` + `source("file_N+1.R")` |
| `file_9.R` | `func_9 <- function(x) x + 1` + `leaf_var <- 42` |

`file_5.R` line layout (0-indexed):

```text
line 0: func_5 <- function(x) x + 1
line 1: source("file_6.R")
line 2: xyz <- xyz
```

At `xyz <- xyz` on line 2, the RHS `xyz` starts at **column 7** (after `xyz <- `). This is the single query point used for all scope assertions.

### Return type

```rust
pub struct SelfRefChainFixture {
    pub _dir: TempDir,       // keeps temp files alive for the test's duration
    pub all_uris: Vec<Url>,  // 10 file URIs in chain order (file_0 first)
    pub mid_file_uri: Url,   // URI of file_5.R
    pub mid_xyz_line: u32,   // 2  (0-indexed line of `xyz <- xyz`)
    pub mid_xyz_rhs_col: u32,// 7  (column of RHS `xyz`)
}
```

No magic numbers appear in the test — all positions come from the struct.

---

## Test Structure

### Name

```rust
#[test]
fn self_ref_variable_not_in_scope_across_deep_source_chain()
```

Located in the same test module in `handlers.rs` as the deleted `debug_real_worldwide_data_r`.

### Setup

1. Call `create_self_ref_chain_fixture()`.
2. Build a `WorldState` with:
   - `workspace_scan_complete = true`
   - `undefined_variables_enabled = true`
   - `out_of_scope_severity = Some(DiagnosticSeverity::WARNING)`
3. For each URI in `fixture.all_uris`: read content, insert into `state.documents` and `state.cross_file_graph` (same pattern as the old test).
4. Build `DiagnosticsSnapshot::build(&state, &fixture.mid_file_uri)`.
5. Call `diagnostics_from_snapshot(&snapshot, &fixture.mid_file_uri, &DiagCancelToken::never())`.
6. Call `snapshot.get_scope(&fixture.mid_file_uri, fixture.mid_xyz_line, fixture.mid_xyz_rhs_col, &DiagCancelToken::never(), None)` — one call, result used for assertions 1–3.

### Four assertions

| # | What | Why |
|---|---|---|
| 1 | `xyz` NOT in `rhs_scope.symbols` | `visible_from` semantics: binding not installed until end of assignment |
| 2 | `leaf_var` IS in `rhs_scope.symbols` | Confirms DFS traversed the full `file_6 → … → file_9` suffix |
| 3 | `dplyr` in `rhs_scope.inherited_packages` or `rhs_scope.loaded_packages` | `library()` from root propagates across all 5 `source()` edges |
| 4 | `diags` contains `"Undefined variable: xyz"` | Full diagnostic pipeline agrees with scope query |

---

## File Changes

### `crates/raven/src/test_utils/fixture_workspace.rs`

- Add `SelfRefChainFixture` struct (pub).
- Add `pub fn create_self_ref_chain_fixture() -> SelfRefChainFixture`.
- Add `use url::Url;` import (not currently present in this module).
- No changes to existing `FixtureConfig`, `create_fixture_workspace`, or `write_fixture_workspace`.

### `crates/raven/src/handlers.rs`

- **Delete** `debug_real_worldwide_data_r` entirely.
- **Add** `self_ref_variable_not_in_scope_across_deep_source_chain` as a plain `#[test]` inside the existing `#[cfg(test)]` module. The test must live here (not in a separate integration test file) because `DiagnosticsSnapshot::get_scope` is private.

## Implementation notes (from Codex review)

- `diagnostics_from_snapshot` returns `Option<Vec<Diagnostic>>`; call `.expect("diagnostics")` before asserting on contents.
- `package_library_ready` defaults to `false` in `WorldState::new`. Package export lookups are suppressed, but `library()` timeline events still populate `loaded_packages` / `inherited_packages` — assertion 3 (`dplyr` in scope) is valid without an R subprocess.
- `undefined_variables_enabled` and `diagnostics_enabled` default to `true` in `CrossFileConfig`; only `workspace_scan_complete = true` needs to be set explicitly.

---

## Properties exercised

| Property | How |
|---|---|
| `visible_from` / same-file leak filter | `xyz` absent from RHS scope (assertion 1) |
| Deep cross-file DFS + memoization | 10-file chain, `leaf_var` visible across 4 hops (assertion 2) |
| `library()` propagation across `source()` edges | `dplyr` in inherited/loaded packages (assertion 3) |
| Full diagnostic pipeline | "Undefined variable: xyz" fires (assertion 4) |
| CI-safe, no external deps | Plain `#[test]`, TempDir, no `~/repos/worldwide` |
