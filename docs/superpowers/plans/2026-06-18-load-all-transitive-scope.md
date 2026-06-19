# Transitive `load_all()` scope (virtual attached package) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model `devtools::load_all()` / `pkgload::load_all()` as a synthetic "virtual attached package" so its package internals propagate transitively across `source()` chains and from `.Rprofile`, with R/-change diagnostics refresh and go-to-definition into `R/` source.

**Architecture:** A `load_all()` call emits a `ScopeEvent::PackageLoad` event carrying a reserved sentinel package name. The existing attached-package propagation machinery (backward parent-prefix walk, forward child→parent hoist, interface hashing, `ForwardChildMemo`) then carries it for free. The sentinel resolves to the workspace-local internal symbol set through a **local-dev overlay** on `PackageLibrary`, consulted via `&self` at three resolution chokepoints. Name-consumers that feed the R subprocess or installed-package machinery skip the sentinel via a central `is_load_all_sentinel` predicate. R/-change revalidation is a lock-safe graph closure in `did_change_watched_files`. Go-to-definition redirects the synthetic `PACKAGE_INTERNAL_URI` to the workspace index's `top_level_interface`, restricted to the package source tree.

**Tech Stack:** Rust (raven LSP crate), tower-lsp, tree-sitter-r. Tests are `#[test]` units in-crate. CI gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets --features test-support -- -D warnings` (toolchain pinned `1.96.0`).

**Spec:** `docs/superpowers/specs/2026-06-18-load-all-transitive-scope-design.md` (authoritative; this plan implements it). Do not re-litigate settled design decisions.

---

## Verified code anchors (re-confirmed against current tree; spec estimates drifted slightly)

All paths under `crates/raven/src/`.

| What | Location | Notes |
|---|---|---|
| `ScopeEvent::PackageLoad` enum variant | `cross_file/scope.rs:700-707` | fields: `line, column, package: String, function_scope: Option<FunctionScopeInterval>` |
| `PackageLoad` emission loop (compute_artifacts) | `cross_file/scope.rs:1848-1861` | iterates `library_calls`, sets `function_scope` via `find_containing_function_scope` **at emission time** |
| `PackageLoad` emission loop (compute_artifacts_with_metadata) | `cross_file/scope.rs:2110-2123` | second copy of the same loop |
| `call_is_dev_load_all` | `cross_file/scope.rs:1917-1938` | detects bare `load_all`, `devtools::load_all`, `pkgload::load_all` |
| `calls_dev_load_all` recorded | `cross_file/scope.rs:2700-2709` | in `collect_definitions`; field decl `scope.rs:765` |
| `annotate_event_function_scopes` | `cross_file/scope.rs:1610-1666` | **does NOT** handle `PackageLoad` (falls to `_ => {}`); function_scope comes from emission loop instead — spec's claim was inverted, conclusion unchanged |
| `append_package_contribution` + `dev_load_all` branch | `cross_file/scope.rs:6889`, branch guard at `6942` | injects `r_internal_symbols ∪ sysdata ∪ onload ∪ imported`; datasets at `6907-6926`; `under_package_root = path.strip_prefix(root).is_ok()` at `6936` |
| backward parent-prefix walk | `cross_file/scope.rs:5653-5705` | reads parent `PackageLoad` before call site, `record_package_origin` |
| `compute_interface_hash` PackageLoad fold | `cross_file/scope.rs:4823-4830` | hashes package+line+column+function_scope |
| `ForwardChildKey.pkg_fp` / `package_set_fingerprint` | `cross_file/scope.rs:1236-1280` | order-independent name hash |
| `top_level_interface` | `cross_file/scope.rs:4634-4642` | rm-aware, top-level-only; filters via `live_top_level_exports` (`4591-4618`) |
| `exported_interface` (footgun) | `cross_file/scope.rs:751` | includes function-local + rm-removed — **do not use for goto** |
| `PACKAGE_INTERNAL_URI` const + `is_package_internal_uri` | `cross_file/scope.rs:6854`, `6858-6860` | value `"package:///internal"` |
| `is_symbol_from_loaded_packages` | `package_library.rs:668-701` | undefined-var suppression chokepoint |
| `find_package_owner_for_symbol` | `package_library.rs:1287-1317` | hover attribution chokepoint |
| `get_owned_exports_for_completions` | `package_library.rs:607-647` | completion chokepoint (delegates to `cached_completion_entries`) |
| `PackageLibrary` struct | `package_library.rs:321-354`; ctors `356-397` | fields incl. `combined_entries: ArcSwap`, `packages: ArcSwap`, `base_exports: Arc<HashSet<String>>` |
| `PackageScopeContribution` struct | `package_state/mod.rs:835+` | fields incl. `workspace_root`, `r_internal_symbols`, `sysdata_symbols`, `onload_symbols`, `imported_symbols`, `rprofile_attached_packages`, `rprofile_root` |
| `apply_package_event` (single writer) | `state.rs:607-614` → `package_state/derive.rs:24` `derive_package_state` → `derive.rs:49` `build_scope_contribution` (`62` minimal, `160` full) | single place the contribution is recomputed |
| `NseAnalysis::build` signature | `handlers.rs:13231-13244` | takes `package_library`/`base_exports`, **no** contribution param — keep it that way |
| `data()` alias attached-set | `cross_file/scope.rs:6620-6635` (calls `expand_data_load`, iter at `4991`) | name consumer |
| pending-cache `package_exists` loop | `handlers.rs:6451-6456` | name consumer (`position_aware_packages_buf`) |
| R-subprocess prefetch filter (did_open) | `backend.rs:3894-3909` | filter at `3905-3908` |
| R-subprocess prefetch filter (libpath consumer) | `backend.rs:7912-7915` | filter chain |
| `PACKAGE_NOT_INSTALLED` loop | `handlers.rs:5099-5131` | iterates `directive_meta.library_calls` only — sentinel never enters; no guard |
| NSE owner / std-eval resolution | `handlers.rs:14691`, `15317` | resolve via package_library chokepoints — no extra guard, but confirm |
| `did_change_watched_files` handler | `backend.rs:4770`; existing fanout `5611-5625`; mark `5639-5646` | `cap_watched_file_revalidations` + `mark_force_republish_many` |
| `compute_affected_dependents_after_edit` | `cross_file/revalidation.rs:509-553` | uses `DependencyGraph::revalidation_consistent_set` |
| dependency graph primitives | `cross_file/dependency.rs:1209` (`get_transitive_dependents`), `1285` (`get_transitive_dependencies`), `1304` (`_multi_root`), `1365` (`revalidation_consistent_set`) | |
| `rprofile_prelude_applies` | `cross_file/scope.rs:7184-7200` | gating predicate |
| `DiagnosticsGate.mark_force_republish[_many]` | `cross_file/revalidation.rs:194`, `202` | |
| `run_libpath_consumer` | `backend.rs:8122-8230` (spawned `8045`) | **not** callable from `did_change_watched_files` — do not reuse |
| goto: scope compute | `handlers.rs:20431-20438` | `ScopeAtPosition` carries `inherited_packages`/`loaded_packages` |
| goto: cursor lookup | `handlers.rs:20440-20443` | `scope.symbols.get` |
| goto: `package:` reject gates (3) | `handlers.rs:20448`, `20505`, `20530` | currently `return None`/`continue` |
| goto: open-doc + workspace-index fallback | `handlers.rs:20490-20537` | uses `content_provider.get_artifacts` + `exported_interface` + `scoped_symbol_range` |
| `is_r_source_path` | `package_state/mod.rs:190-225` | returns `Option<RFileKind>`; `R/`, `tests/{testthat,testit}`, `tests/*.R`, `inst/{tinytest,unitTests}` |
| `is_dev_context_path` | `package_state/mod.rs:261-276` | `demo/`, `data-raw/`, `vignettes/`, `man/` |
| `content_provider` | `state.rs:771-794` | unified open-docs-first artifact access |

### Test-harness reference (mirror these — read them before writing tests)

- **Cross-file scope unit tests:** `cross_file/scope.rs` test module — use `compute_artifacts(uri,tree,content)` / `compute_artifacts_with_metadata`, `DependencyGraph::update_file`, and `scope_at_position_with_graph(...)` (query scope at a position; takes `Some(&workspace_root)` and `Some(contribution)`). Mirror existing `library()` propagation tests.
- **Package-mode end-to-end:** `state_tests.rs` (e.g. `test_file_sees_r_dir_symbol_end_to_end`, ~`596-1362`) — build `WorldState`, set `package_inputs.{workspace_root,package_mode,description,r_files}`, call `apply_package_event(&PackageInputDelta::Initial)`, read `state.package_state.scope_contribution()`.
- **Watched-file / WorldState graph:** `state_tests.rs:1-200` — `scan_workspace`, `WorldState::apply_workspace_index`. For the `did_change_watched_files` end-to-end (Task 4), **first locate the Backend + mock-client harness** (search `tests/` and `backend.rs` test modules for how `did_change_watched_files` is invoked and how published diagnostics are captured). Do not assume an API.
- **Goto tests:** invoke the goto handler and assert `Option<GotoDefinitionResponse::Scalar(Location)>`. Find an existing goto test to mirror the exact handler entry point and async/setup conventions.
- **Run:** `cargo test --package raven <filter>`. CI gates after every task: `cargo fmt --all` then `cargo clippy --workspace --all-targets --features test-support -- -D warnings`.

---

## File structure (what each touched file owns)

- `crates/raven/src/package_library.rs` — **home of the sentinel**: `LOAD_ALL_SENTINEL` const + `is_load_all_sentinel(&str) -> bool` (lowest layer that needs it, no dependency cycle), the `LocalDevPackage` overlay type, the overlay field on `PackageLibrary`, and the three chokepoints consulting it.
- `crates/raven/src/cross_file/scope.rs` — sentinel `PackageLoad` emission (two loops); the `under_package_root` gate at resolution; remove the `dev_load_all` injection branch; `data()` alias sentinel guard.
- `crates/raven/src/package_state/derive.rs` + `mod.rs` — `.Rprofile` `load_all()` → `rprofile_attached_packages` sentinel; build the `LocalDevPackage` value from the contribution.
- `crates/raven/src/state.rs` — refresh the overlay on `PackageLibrary` whenever `apply_package_event` recomputes the contribution (single writer).
- `crates/raven/src/handlers.rs` — `package_exists` loop guard; goto `PACKAGE_INTERNAL_URI` redirect.
- `crates/raven/src/backend.rs` — two prefetch-filter guards; the lock-safe revalidation closure in `did_change_watched_files`.
- `docs/` — `cross-file.md`, `r-package-dev.md`, `go-to-definition.md`, `rprofile.md`, and `development.md` if internal notes change.

---

## Task 0: Sentinel constant, predicate, and empty overlay scaffolding

**Files:**
- Modify: `crates/raven/src/package_library.rs` (struct `321-354`, ctors `356-397`)
- Test: `crates/raven/src/package_library.rs` (test module at bottom)

The sentinel value must contain a character illegal in R package names (which match `[a-zA-Z][a-zA-Z0-9.]*`). Underscore is illegal in R package names, guaranteeing no collision. Use `"__raven_load_all__"`.

- [ ] **Step 1: Write the failing test**

In the `package_library.rs` test module:

```rust
#[test]
fn load_all_sentinel_is_recognized_and_non_colliding() {
    assert!(is_load_all_sentinel(LOAD_ALL_SENTINEL));
    assert!(!is_load_all_sentinel("dplyr"));
    assert!(!is_load_all_sentinel("load_all"));
    // Underscore is illegal in real R package names, so the sentinel can never collide.
    assert!(LOAD_ALL_SENTINEL.contains('_'));
}

#[test]
fn empty_overlay_resolution_is_unchanged() {
    let lib = PackageLibrary::new_empty();
    // No load_all anywhere => sentinel resolves to nothing.
    assert!(!lib.is_symbol_from_loaded_packages("anything", &[LOAD_ALL_SENTINEL.to_string()]));
    assert_eq!(lib.find_package_owner_for_symbol("anything", &[LOAD_ALL_SENTINEL.to_string()]), None);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --package raven load_all_sentinel_is_recognized_and_non_colliding empty_overlay_resolution_is_unchanged`
Expected: FAIL — `LOAD_ALL_SENTINEL` / `is_load_all_sentinel` / `LocalDevPackage` not found.

- [ ] **Step 3: Implement the constant, predicate, overlay type, and field**

In `package_library.rs`, near the top (module level):

```rust
/// Reserved package name used to model `devtools::load_all()` / `pkgload::load_all()`
/// as a synthetic attached package. Contains `_`, which is illegal in real R package
/// names, so it can never collide with an installed/attached package.
pub const LOAD_ALL_SENTINEL: &str = "__raven_load_all__";

/// True iff `name` is the reserved `load_all()` sentinel package name.
///
/// Every consumer that iterates attached package *names* and feeds them to
/// installed-package machinery or the R subprocess MUST skip the sentinel via this
/// predicate (the sentinel resolves only through the local-dev overlay chokepoints).
#[inline]
pub fn is_load_all_sentinel(name: &str) -> bool {
    name == LOAD_ALL_SENTINEL
}

/// Workspace-local internal symbol set exposed by a `load_all()` virtual attached
/// package. Built from the active `PackageScopeContribution`; refreshed by the single
/// contribution writer (`apply_package_event`). Holds names only — go-to-definition
/// derives locations from the workspace index, never from here.
#[derive(Debug, Clone, Default)]
pub struct LocalDevPackage {
    /// Union of r_internal ∪ sysdata ∪ onload ∪ imported symbol names.
    pub symbols: std::collections::HashSet<String>,
}
```

Add the overlay field to `PackageLibrary` (alongside the `ArcSwap` caches; an `ArcSwap` so the single writer can swap it without `&mut self`):

```rust
    /// Local-dev overlay: sentinel -> workspace-local internal symbols.
    /// `None`-equivalent is an empty set. Consulted by the three resolution
    /// chokepoints before the installed caches. Refreshed by `apply_package_event`.
    local_dev_overlay: arc_swap::ArcSwap<Option<std::sync::Arc<LocalDevPackage>>>,
```

Initialize it to `ArcSwap::from_pointee(None)` in both `new_empty()` (`356`) and `with_subprocess()` (`385`). Add a setter `pub fn set_local_dev_overlay(&self, overlay: Option<Arc<LocalDevPackage>>)` that calls `self.local_dev_overlay.store(Arc::new(overlay))`, and a private `fn overlay_has_symbol(&self, name: &str, loaded_packages: &[String]) -> bool` helper that returns false unless `loaded_packages` contains the sentinel and the overlay set contains `name`. (Chokepoints wire to it in Task 2 — for now `overlay_has_symbol` is unused; add `#[allow(dead_code)]` only if clippy complains before Task 2, and remove it there.)

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --package raven load_all_sentinel_is_recognized_and_non_colliding empty_overlay_resolution_is_unchanged`
Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_library.rs
git commit -m "feat(load_all): add LOAD_ALL_SENTINEL, is_load_all_sentinel, LocalDevPackage overlay scaffold"
```

---

## Task 1: Emit the sentinel `PackageLoad`, gate on caller `under_package_root`

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` (emission `1848-1861`, `2110-2123`; `collect_definitions` `2700-2709`; resolution gate — see Step 3)
- Test: `crates/raven/src/cross_file/scope.rs` test module (mirror existing `library()` propagation tests)

**Design note — the gate (DECISION: cheap query-file gate, deviates from spec sub-decision 2 by user choice 2026-06-18).** `compute_artifacts` / `compute_artifacts_with_metadata` do **not** receive the workspace root, and threading it in would ripple through every test caller (the same anti-pattern the spec rejects for the overlay). The spec's sub-decision 2 (gate on the *caller* via origin tracking) is the most complex, riskiest code in the feature; the user opted for the cheaper, nearly-free **query-file** gate instead, accepting one edge-case divergence. Therefore:
1. **Emit the sentinel `PackageLoad` unconditionally** when a `load_all()` call is detected, through the same emission loop that gives `library()` its `function_scope` — this buys position-awareness, function-scope gating, multi-parent union, transitivity, interface hashing, and `pkg_fp` keying for free.
2. **Gate on the QUERY file being `under_package_root`** at resolution, where the root is known. `append_package_contribution` already computes `under_package_root = path.strip_prefix(root).is_ok()` for the query file and has `scope` + `contrib.workspace_root` in hand. Add: **if the query file is not under the package root, strip `LOAD_ALL_SENTINEL` from `scope.loaded_packages` and `scope.inherited_packages`** (before the chokepoints consult it). No `package_origins` / origin tracking needed.

**Accepted divergence from spec sub-decision 2:** an out-of-root *child* sourced by an in-root parent will **not** see internals (the spec would show them). This is a rarer double-edge-case than the scratch-file footgun the gate protects against, and the cheap gate still: fixes the reported bug (in-root → in-root child), preserves today's out-of-root scratch-file protection, and keeps internals out of a directly-opened out-of-root `load_all()` file. Record this deviation in the PR description and the spec's invariants so the final Codex pass does not flag it as a regression.

- [ ] **Step 1: Write the failing tests** (mirror the file's existing `library()` cross-file tests for setup/helpers)

Reported-bug (backward-to-child) test:

```rust
#[test]
fn load_all_propagates_to_directly_opened_child() {
    // parent.R: pkgload::load_all(); source("child.R")
    // child.R:  my_func()      // my_func is an R/ internal
    // Open child.R directly; it must see the sentinel package (no undefined-var).
    // Build a package contribution whose r_internal_symbols contains "my_func",
    // register the LocalDevPackage overlay, resolve scope at child EOF, assert
    // the sentinel is in scope.loaded_packages/inherited_packages AND "my_func"
    // resolves (via overlay) — i.e. not reported undefined.
    // ... mirror test_file_sees_r_dir_symbol_end_to_end + a library() propagation test.
}
```

Enumerate the remaining Section-A tests (each a concrete `#[test]`, same harness):
- `load_all_is_position_aware`: `source("child.R"); load_all()` → child does **not** see the sentinel.
- `load_all_propagates_transitively`: `a.R`(`load_all(); source("b.R")`) → `b.R`(`source("c.R")`) → open `c.R` sees sentinel.
- `load_all_forward_child_to_parent_hoist`: `main.R`(`source("loader.R"); my_func()`), `loader.R`(`load_all()`) → `main.R` sees sentinel after the `source()`.
- `load_all_function_scoped`: child sourced inside the function scope sees it; child sourced outside does not.
- `load_all_multi_parent_union`: child sourced by `pA.R`(pre-source `load_all()`) and `pB.R`(none) → child sees sentinel (documented union).
- `load_all_out_of_root_child_does_not_see_internals` (cheap-gate semantics): in-root parent → out-of-root child → child does **not** see the sentinel internals (the query-file gate strips the sentinel for out-of-root query files). This is the accepted divergence from spec sub-decision 2.
- `load_all_out_of_root_caller_does_not_see_internals`: an out-of-root file that itself calls bare `load_all()` does **not** see the sentinel internals (its own diagnostics are unaffected). Note: the sentinel may still be *emitted* into its timeline and propagate to in-root children — only the out-of-root query file itself is gated out.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --package raven load_all_`
Expected: FAIL — sentinel never emitted / never in scope.

- [ ] **Step 3: Implement emission + gate**

(a) Detect the `load_all()` call as part of the same pass that produces `library_calls`. In both emission loops (`scope.rs:1848-1861` and `2110-2123`), after the `library_calls` loop, emit:

```rust
// Model devtools/pkgload::load_all() as attaching a synthetic virtual package.
// Emitted through the same path as library() so it inherits position +
// function-scope treatment (and thus all attached-package propagation).
// The under_package_root gate is applied at resolution (root is unknown here).
if let Some(site) = artifacts.dev_load_all_site {
    artifacts.timeline.push(ScopeEvent::PackageLoad {
        line: site.line,
        column: site.column,
        package: crate::package_library::LOAD_ALL_SENTINEL.to_string(),
        function_scope: site.function_scope.clone(),
    });
}
```

In `collect_definitions` (`scope.rs:2700-2709`), when `call_is_dev_load_all` matches, in addition to setting `calls_dev_load_all = true`, record the **first** call site: add field `pub dev_load_all_site: Option<DevLoadAllSite>` to `ScopeArtifacts` where `DevLoadAllSite { line: u32, column: u32, function_scope: Option<FunctionScopeInterval> }`, populating `function_scope` with `find_containing_function_scope(&artifacts.function_scope_tree, line, column)` (same call the library loop uses). Keep `calls_dev_load_all` — Task 4 needs it under the lock.

(b) Apply the **cheap query-file gate** in `append_package_contribution`: it already computes `under_package_root = path.strip_prefix(root).is_ok()` for the query file. Add, near the top (after `root`/`path` are bound, before the dev-context branches):

```rust
// Cheap query-file gate for the load_all() sentinel: a file outside the
// package root must not pull in this package's internals via load_all()
// (it would mute real diagnostics there). Strip the sentinel from the
// query file's attached-package set when the query file is out-of-root.
// (Deliberately simpler than spec sub-decision 2's caller-origin gate.)
if !under_package_root {
    scope.loaded_packages.remove(crate::package_library::LOAD_ALL_SENTINEL);
    scope.inherited_packages.remove(crate::package_library::LOAD_ALL_SENTINEL);
}
```

Ensure `under_package_root` is computed before this strip (move its binding up if needed). When `contrib.workspace_root` is `None` the function early-returns and no strip happens — harmless, because the overlay is empty in that case. Confirm via the two out-of-root negative tests.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --package raven load_all_`
Expected: PASS (all Section-A tests).

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/cross_file/scope.rs
git commit -m "feat(load_all): emit sentinel PackageLoad event with caller under_package_root gate"
```

---

## Task 2: Resolve the sentinel via the local-dev overlay (three chokepoints) + refresh

**Files:**
- Modify: `crates/raven/src/package_library.rs` (`is_symbol_from_loaded_packages:668`, `find_package_owner_for_symbol:1287`, `get_owned_exports_for_completions:607`)
- Modify: `crates/raven/src/package_state/derive.rs` (build the `LocalDevPackage` from the full contribution path, `~160`) and/or `mod.rs`
- Modify: `crates/raven/src/state.rs` (`apply_package_event:607-614` — refresh overlay after recompute)
- Test: `package_library.rs` test module + `state_tests.rs`

- [ ] **Step 1: Write the failing tests**

```rust
// package_library.rs
#[test]
fn overlay_resolves_sentinel_symbols_only_when_sentinel_attached() {
    let lib = PackageLibrary::new_empty();
    let mut syms = std::collections::HashSet::new();
    syms.insert("my_func".to_string());
    lib.set_local_dev_overlay(Some(std::sync::Arc::new(LocalDevPackage { symbols: syms })));

    // Sentinel attached => resolves.
    assert!(lib.is_symbol_from_loaded_packages("my_func", &[LOAD_ALL_SENTINEL.to_string()]));
    assert_eq!(
        lib.find_package_owner_for_symbol("my_func", &[LOAD_ALL_SENTINEL.to_string()]),
        Some(LOAD_ALL_SENTINEL.to_string())
    );
    let exports = lib.get_owned_exports_for_completions(&[LOAD_ALL_SENTINEL.to_string()]);
    assert!(exports.contains_key("my_func"));

    // Sentinel NOT attached => overlay contributes nothing.
    assert!(!lib.is_symbol_from_loaded_packages("my_func", &["dplyr".to_string()]));
}
```

End-to-end (`state_tests.rs`): build a package with `R/utils.R` defining `helper`, a `load_all()` caller script, `apply_package_event(&PackageInputDelta::Initial)`, then assert `state.package_library` overlay contains `helper` and resolution at the caller sees it. Also: **hover** on a load_all internal renders real package help (not bare-symbol fallback); **completion** in a caller offers the internal symbols; **overlay isolation** — with no `load_all()` anywhere the overlay is empty and resolution is byte-identical (regression guard); **NSE** `NseAnalysis::build` signature unchanged (compile-time: the test calls it with the existing arg list).

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --package raven overlay_resolves_sentinel`
Expected: FAIL — chokepoints don't consult the overlay; overlay never refreshed.

- [ ] **Step 3: Implement**

In each of the three chokepoints, consult the overlay **before** the installed caches:
- `is_symbol_from_loaded_packages` (`668`): after the `base_exports` early-return, `if self.overlay_has_symbol(symbol, loaded_packages) { return true; }`.
- `find_package_owner_for_symbol` (`1287`): if `loaded_packages` contains the sentinel and the overlay set contains `symbol`, `return Some(LOAD_ALL_SENTINEL.to_string())` before consulting `combined_entries`.
- `get_owned_exports_for_completions` (`607`): if the sentinel is in `loaded_packages`, fold every overlay symbol into the returned map under owner `LOAD_ALL_SENTINEL` (dedup via the existing `push_unique`).

Build `LocalDevPackage` in the **full** contribution path (`derive.rs:~160`): `symbols = r_internal_symbols ∪ sysdata_symbols ∪ onload_symbols ∪ imported_symbols.keys()`. Surface it on the derived state (e.g. a field on `PackageState` or returned alongside the contribution). In `apply_package_event` (`state.rs:607-614`), after `self.package_state.set_from(new_package_state)`, call `self.package_library.set_local_dev_overlay(overlay)` (or `None` when no workspace/package). Confirm `apply_package_event` is the **only** writer that swaps the contribution (verified) so the overlay never goes stale.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test --package raven overlay_resolves_sentinel` and the new `state_tests` tests.
Expected: PASS.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/package_library.rs crates/raven/src/package_state/ crates/raven/src/state.rs
git commit -m "feat(load_all): resolve sentinel via local-dev overlay at three chokepoints; refresh on apply_package_event"
```

---

## Task 2a: Sentinel guards for attached-name consumers

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` (`data()` alias `6620-6635` / `expand_data_load` iter `4991`)
- Modify: `crates/raven/src/handlers.rs` (`package_exists` loop `6451-6456`)
- Modify: `crates/raven/src/backend.rs` (prefetch filters `3905-3908`, `7912-7915`)
- Test: nearest test module to each site (or `state_tests.rs` for end-to-end)

- [ ] **Step 1: Write the failing tests**

- `sentinel_skipped_in_data_alias_expansion`: a scope with the sentinel attached + a `data()` call → `expand_data_load` is not asked to resolve the sentinel (no panic / no spurious symbol). Assert the sentinel contributes no dataset aliases.
- `sentinel_never_prefetched_to_r_subprocess`: with the sentinel in `inherited_packages`/`loaded_packages`, the computed prefetch package vec excludes `LOAD_ALL_SENTINEL` (test the filter closure directly if `run_libpath_consumer` isn't unit-reachable).
- `sentinel_does_not_trigger_package_not_installed`: confirm the `PACKAGE_NOT_INSTALLED` loop iterates `directive_meta.library_calls` only (assertion that a sentinel in scope produces no such diagnostic) — likely a no-op guard but assert it.

- [ ] **Step 2: Run to verify they fail / pass-by-construction**

Run: `cargo test --package raven sentinel_`
Expected: FAIL where a guard is missing.

- [ ] **Step 3: Implement guards**

- `data()` alias (`scope.rs:6620`): when building the `attached` set, `.filter(|p| !crate::package_library::is_load_all_sentinel(p))`.
- `package_exists` loop (`handlers.rs:6451`): in the `.any(|pkg| ...)` closure, short-circuit `if crate::package_library::is_load_all_sentinel(pkg) { return false; }`.
- Prefetch filters (`backend.rs:3905-3908`, `7912-7915`): change `.filter(|p| is_valid_package_name(p))` to `.filter(|p| is_valid_package_name(p) && !crate::package_library::is_load_all_sentinel(p))`.
- `PACKAGE_NOT_INSTALLED` (`handlers.rs:5099`): no code change (iterates `library_calls`); keep the assertion test as a regression guard. NSE owner/std-eval sites (`14691`, `15317`) resolve via the overlay-aware chokepoints — confirm by reading; no guard. **Grep for any new name-consumer** (`inherited_packages` / `loaded_packages` feeding installed lookups or the R subprocess) and guard it too.

- [ ] **Step 4: Run to verify they pass** → `cargo test --package raven sentinel_`

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add -A && git commit -m "feat(load_all): guard attached-name consumers against the sentinel (data(), package_exists, prefetch)"
```

---

## Task 3: Remove the bespoke `dev_load_all` injection; wire `.Rprofile` `load_all()`

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` (`append_package_contribution` branch `6942`)
- Modify: `crates/raven/src/package_state/derive.rs` (`.Rprofile` scan → `rprofile_attached_packages`)
- Test: `cross_file/scope.rs` + `state_tests.rs`

- [ ] **Step 1: Write the failing tests**

- `direct_caller_sees_internals_via_sentinel_not_injection`: a `load_all()` caller in `R/`-adjacent dev file still sees internals — now via the sentinel/overlay path, not the removed injection branch. (This guards against a regression when the branch is deleted.)
- `rprofile_load_all_propagates_to_script`: workspace-root `.Rprofile` calls `load_all()`; a directly-opened script sees internals.
- `rprofile_load_all_withheld_in_package_dirs`: in package mode, `R/`, `tests/`, and built-doc dirs do **not** get the `.Rprofile` sentinel (withholding via `rprofile_prelude_applies`).
- `rprofile_only_load_all_still_attaches`: a `.Rprofile` whose only content is `load_all()` still attaches the sentinel (the `rprofile_attached_packages` non-empty early-return guard passes naturally).

- [ ] **Step 2: Run to verify they fail** → `cargo test --package raven rprofile_load_all direct_caller_sees_internals`

- [ ] **Step 3: Implement**

In `append_package_contribution` (`scope.rs:6942`), remove the `(dev_load_all && under_package_root)` arm from the guard so it reads `if !is_dev_context { return; }` (dev-context path untouched). Delete the now-unused `dev_load_all` parameter only if no caller needs it — otherwise leave the param and stop using it; check callers. The direct caller now gets internals via the sentinel `PackageLoad` (Task 1) resolving through the overlay (Task 2). **Do not** touch the dataset injection (`6907-6926`) or `is_dev_context_path`.

In the `.Rprofile` scan (`derive.rs`), when `call_is_dev_load_all` matches a call in the workspace-root `.Rprofile`, insert `LOAD_ALL_SENTINEL` into `rprofile_attached_packages`. The existing `append_rprofile_prelude` + `rprofile_prelude_applies` gating then handles withholding unchanged.

- [ ] **Step 4: Run to verify they pass** + run the full Section-A suite from Task 1 to confirm no regression.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add -A && git commit -m "refactor(load_all): remove bespoke dev_load_all injection; wire .Rprofile load_all to rprofile_attached_packages sentinel"
```

---

## Task 4: Lock-safe R/-change revalidation closure (Section B — required)

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_change_watched_files` handler `4770`; fanout `5611-5646`)
- Test: the Backend + mock-client end-to-end harness (**locate first** — see test-harness reference)

**Invariant:** runs inside the `did_change_watched_files` write-lock handler → use **only** graph reachability + artifact bools (`calls_dev_load_all`, `under_package_root`, `rprofile_prelude_applies`). **No** cross-file scope resolution under the lock. Do **not** reuse `run_libpath_consumer`'s probe.

- [ ] **Step 1: Write the failing end-to-end tests** (drive through `did_change_watched_files`, all three roles: caller `L`, callers-of-`L`, callees-of-`L`)

- `r_add_suppresses_in_all_three_roles`: before — `new_func()` in `L`, a caller (after sourcing `L`), and a callee each emit undefined-var; ADD `R/new.R` defining `new_func` → all three suppressed without editing those files (force-republish fires for all three).
- `r_delete_unsuppresses_in_all_three_roles`: DELETE the `R/` file defining `my_func` → diagnostic reappears in `L`, caller, callee.
- `r_edit_rename_flips_suppression`: rename `old_func`→`new_func` in `R/` → `old_func()` unsuppressed, `new_func()` suppressed, in all three roles.
- Negative controls: `load_all()` placed after `source(callee)` does not suppress the callee; out-of-root bare `load_all()` file is unaffected by R/ changes; in package mode `R/`+`tests/` governed by dev-context not the `.Rprofile` sentinel.
- `revalidation_respects_version_monotonicity`: republished diagnostics never publish an older document version (force-republish gate).

- [ ] **Step 2: Run to verify they fail** → `cargo test --package raven r_add_suppresses r_delete_unsuppresses r_edit_rename`

- [ ] **Step 3: Implement the closure**

In `did_change_watched_files`, when the recomputed `PackageScopeContribution` differs (existing `pkg_visibility_changed` / full-contribution equality), widen the affected set (snapshot graph + artifact bools under the lock; no scope resolution):
1. Seed: every open doc whose artifacts have `calls_dev_load_all` **and** is `under_package_root` (the carriers — closes the root-level `analysis.R` gap).
2. Add their source-graph **descendants** (callees) and **ancestors** (callers) via `DependencyGraph` (`get_transitive_dependencies` / `get_transitive_dependents`, or `revalidation_consistent_set` per carrier, using matching `max_depth`/`max_visited` budgets).
3. If `.Rprofile` attaches the sentinel, add every open doc for which `rprofile_prelude_applies`, plus their graph neighborhood.
Mark the union via `mark_force_republish_many` (respecting `cap_watched_file_revalidations`). This is a deliberate conservative superset; position-aware correctness is enforced later at diagnosis-time scope resolution.

- [ ] **Step 4: Run to verify they pass** → the Section-B suite.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add -A && git commit -m "feat(load_all): lock-safe R/-change revalidation closure over load_all carriers + neighborhood"
```

---

## Task 5: Go-to-definition for load_all internals → R/ source (Section D, §7)

**Files:**
- Modify: `crates/raven/src/handlers.rs` (goto gates `20448`, `20505`, `20530`; fallback `20490-20537`)
- Test: goto test module (mirror an existing goto test)

- [ ] **Step 1: Write the failing tests**

- `goto_sentinel_path_navigates_to_r_source`: goto on `my_func()` in the load_all **caller**, a **callee**, and a **caller-of-loader** (sentinel in scope, none in `R/`) → `Location` with the `R/` file URI + correct line.
- `goto_dev_context_path_r_to_r`: goto on an internal referenced from within an `R/` file (and a test file) → navigates to its `R/` definition (the `PACKAGE_INTERNAL_URI` redirect; closes the pre-existing R/→R/ gap).
- `goto_picks_package_tree_not_unrelated_file`: an unrelated workspace file defining the same name is **not** chosen (`is_r_source_path` restriction).
- `goto_uses_top_level_interface_not_exported`: a function-local / `rm()`-removed name of the same spelling is **not** a goto target.
- `goto_duplicate_defs_deterministic`: two `R/` files defining the same name → a single deterministic `Location` (no panic, stable order).
- `goto_sysdata_or_imported_noops`: goto on a sysdata/imported symbol → `None`.
- `goto_library_symbol_still_noops`: goto on a normal `library()` symbol still no-ops (external-package goto unchanged — regression).
- `goto_internal_open_and_closed`: works when the `R/` defining file is open (DocumentStore) and closed (workspace index) — both via `content_provider`.

- [ ] **Step 2: Run to verify they fail** → `cargo test --package raven goto_sentinel goto_dev_context goto_picks_package_tree goto_uses_top_level goto_duplicate goto_sysdata goto_library_symbol goto_internal_open`

- [ ] **Step 3: Implement the redirect**

Change the three `package:` reject gates (`20448`, `20505`, `20530`): when `symbol.source_uri` is **exactly** `PACKAGE_INTERNAL_URI` (use `is_package_internal_uri`), **do not** dead-end — resolve `name` through the workspace index instead. Other `package:` URIs keep no-op'ing. Resolution helper:
- Iterate open docs then workspace index via `content_provider.get_artifacts`.
- Look up the name in `top_level_interface(&artifacts)` (rm-aware, top-level-only) — **not** `exported_interface`.
- Restrict candidate files to the package source tree: `is_r_source_path(path, workspace_root).is_some()`, where `workspace_root` comes from `PackageScopeContribution.workspace_root` (the in-scope package set is already on the `scope` the handler computed at `20431`).
- Return the **first** match in a stable iteration order (`GotoDefinitionResponse::Scalar(Location)` via `scoped_symbol_range`). sysdata/imported names have no navigable source → fall through to `None`.

- [ ] **Step 4: Run to verify they pass** → the Section-D suite.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --features test-support -- -D warnings
git add crates/raven/src/handlers.rs && git commit -m "feat(load_all): goto redirects PACKAGE_INTERNAL_URI to R/ source via top_level_interface (is_r_source_path restricted)"
```

---

## Task 6: Documentation

**Files:** `docs/cross-file.md`, `docs/r-package-dev.md`, `docs/go-to-definition.md`, `docs/rprofile.md`; `docs/development.md` if internal caching/architecture notes changed (the overlay + revalidation closure).

- [ ] **Step 1:** `docs/cross-file.md` — `load_all()` modeled as a virtual attached package; propagation parallel to `library()` (backward/forward/transitive/multi-parent).
- [ ] **Step 2:** `docs/r-package-dev.md` — transitive `load_all()` behavior, R/-change diagnostics refresh, goto into `R/` source for internals.
- [ ] **Step 3:** `docs/go-to-definition.md` — goto for `load_all()`-exposed internals; external/installed-package goto not yet supported (future work).
- [ ] **Step 4:** `docs/rprofile.md` — `.Rprofile` `load_all()` behavior and package-mode withholding.
- [ ] **Step 5:** `docs/development.md` — the local-dev overlay on `PackageLibrary` and the lock-safe revalidation closure (if not already covered by module doc comments).
- [ ] **Step 6: Commit**

```bash
git add docs/ && git commit -m "docs(load_all): document transitive load_all scope, .Rprofile behavior, and goto into R/ source"
```

---

## Final verification (before review/PR — per the goal)

- [ ] `cargo fmt --all --check` clean.
- [ ] `cargo clippy --workspace --all-targets --features test-support -- -D warnings` zero warnings.
- [ ] `cargo test --package raven` green (full suite, not just new tests).
- [ ] Re-read the spec's "Invariants touched" and confirm each holds in code.
- [ ] Then: Codex adversarial whole-branch pass (read-only, named files, time-boxed) → fix → two consecutive `/code-review` clean → open PR.

---

## Self-review against the spec

**Spec coverage:**
- §1 sentinel emission → Task 1. §2 overlay resolution → Task 2. §2a guards → Task 2a. §3 remove injection + `.Rprofile` → Task 3. §4 revalidation → Task 4. §5 precedence → preserved by overlay tier (no task; verified by Task 2's "local def wins" being unchanged — add an assertion in Task 2 if not covered). §6 LSP parity → hover/completion in Task 2, goto in Task 5. §7 goto → Task 5. Testing A→Task 1, B→Task 4, C→Task 2/2a, D→Task 5. Docs → Task 6.
- **Gap noted:** §5 precedence (local definition of same name still wins over the sentinel export). Add one assertion to Task 2 Step 1 (`local_def_shadows_sentinel_export`) so it is explicitly covered.

**Placeholder scan:** the two genuine design-judgment points (Task 1 gate location; Task 4 backend test harness) are called out as design notes with the negative/end-to-end tests as the executable spec, not hand-waved "figure it out" — the red-green loop forces correctness.

**Type consistency:** `LOAD_ALL_SENTINEL` / `is_load_all_sentinel` / `LocalDevPackage` / `set_local_dev_overlay` / `dev_load_all_site` / `DevLoadAllSite` used consistently across Tasks 0–5.
