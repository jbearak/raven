# R Package Mode Architecture — Design

**Date:** 2026-05-10
**Branch:** `r-packages`
**Status:** Draft for review
**Supersedes:** `docs/superpowers/plans/2026-05-09-r-package-support-review.md` (review-time notes; this document is the architectural redesign that follows from those reviews)

---

## 1. Problem statement

The `r-packages` branch (commit `be7b0d7..HEAD`) adds R package workspace support to Raven: when a workspace has a `DESCRIPTION` file, the LSP enables mutual visibility between `R/*.R` files, parses NAMESPACE/roxygen2 import directives, and suppresses undefined-variable diagnostics for imported symbols.

After the initial implementation (1 feature commit), 17 successive "fix correctness/perf" commits have landed. Reading them in order, they don't read as normal post-feature polish — each one names a *new* failure mode in the same handful of areas: stale caches across event-handler paths, transitions of the `roxygen_managed` flag, parser edge cases, and locking-discipline regressions.

The recurrence pattern indicates an architectural problem, not a bug-density problem: the package-mode subsystem maintains roughly **(5 LSP events × 4 derived caches × 2 boolean state transitions) ≈ 40 (event × cache) cells**, each of which must be filled in correctly by hand inside the relevant event handler. We have been filling these cells in one bug at a time. This document specifies a redesign that collapses the matrix to a single derivation function so the bug class becomes structurally hard to write.

## 2. Background research

Two established R LSPs were surveyed for design choices:

- **REditorSupport/languageserver** (R-based, the de facto R LSP): NAMESPACE-only export/import inference (no roxygen parsing); scope injection (not suppression); `R/`-only mutual visibility; mtime-polled NAMESPACE rebuild; one `Workspace` R6 object owns all state; full rebuild of NAMESPACE-derived state, per-doc incremental for `parse_data`.
- **posit-dev/ark** (Rust-based): NAMESPACE + INDEX (no roxygen); scope injection via `ScopeLayer` chain; `R/`-only with an ad-hoc testthat kludge; rebuild-on-load granularity; distributed across small crates with `state.root: Option<SourceRoot>` as the gate; no incremental computation framework.

Headline takeaways:

1. Both treat NAMESPACE as the source of truth and ignore roxygen for export inference. Raven's choice to parse roxygen directly is a deliberate differentiator (responsive without `devtools::document()`), which is *worth keeping* — but the bug pattern shows the binary "roxygen-managed" flag we use to choose between sources is the actual cost.
2. Both inject imported and internal symbols into the scope/symbol table rather than maintaining a parallel diagnostic-suppression set.
3. Both restrict mutual visibility to `R/`. Neither respects `Collate:` ordering.
4. Neither uses an incremental computation framework. They rebuild from source.

## 3. Aims (settled)

The following aims are locked for this design:

1. **Always parse both NAMESPACE and roxygen tags from `R/*.R`; merge into one namespace model.** Drop the `roxygen_managed` boolean flag and all transition logic that depends on it. Roxygen entries and NAMESPACE entries are unioned; neither overrides the other.
2. **Switch from diagnostic suppression to scope injection.** Package-internal symbols and imported symbols flow through the existing `cross_file/scope.rs` engine. Hover, signature help, and completion work uniformly with explicit definitions, source() chains, and library() calls. The separate suppression-set code path is deleted.
3. **`R/`-only intent for mutual visibility, with a centralized predicate.** `tests/`, `vignettes/`, `inst/`, etc. do not contribute symbols. The "is this file part of the package?" check is one helper used at every call site.
4. **One-way visibility from `tests/testthat/` into `R/`.** Test files see all `R/` top-level symbols (read-only); `R/` files do not see test symbols. No ad-hoc kludges.
5. **Explicit input-delta architecture.** Package state is derived from a defined input set by a single pure function. Handlers update inputs and emit deltas; they do not mutate derived state.

The trinary `raven.packages.packageMode` setting (`auto`/`enabled`/`disabled`) is preserved as-is. `Collate:` ordering is not respected (matches both established R LSPs; would not change correctness).

## 4. Architecture

### 4.1 Data flow

Five LSP events feed the package subsystem: `did_change`, `did_open`, `did_close`, `did_change_watched_files`, `did_change_configuration`. Each handler, after any prior cross-file work, computes a `PackageInputDelta` describing what changed, applies the corresponding update to `WorldState.package_inputs`, calls `derive_package_state`, and replaces `WorldState.package_state`.

```text
LSP event
    │
    │  1. handler reads any disk content needed
    │     (outside the write lock — invariant)
    │
    ▼
handler builds PackageInputDelta + new field values for PackageInputs
    │
    ▼
write lock on WorldState ──────────────────────────────────────┐
    │                                                          │
    │  2. apply input changes to WorldState.package_inputs     │
    │  3. let new_state = derive(prev_state, &inputs, &delta)  │
    │  4. WorldState.package_state = new_state                 │
    │                                                          │
    ▼                                                          │
release write lock ◄──────────────────────────────────────────┘
    │
    ▼
downstream consumers (diagnostics, completion, scope) read
under the existing read-lock path
```

### 4.2 Three contracts

These contracts are what eliminate the recurring bug class. Each is enforceable mechanically (via privacy + tests), not merely by convention.

1. **`PackageState` is replaced as a whole.** The struct's fields are `pub(super)` to the package-mode module; outside that module, only `&PackageState` (reads) and `WorldState::set_package_state(new)` (replacement) are accessible. There are no methods that mutate part of `PackageState`.
2. **`derive_package_state` is pure.** No I/O, no time, no globals. All inputs are arguments. This makes it (a) safe to call under any lock, (b) trivial to property-test, (c) easy to reason about across the migration.
3. **All disk I/O happens before the write lock.** Handlers read files via `tokio::task::spawn_blocking` (or from `DocumentStore` for open documents), then acquire the write lock with text in hand. This codifies the existing CLAUDE.md invariant.

### 4.3 The (event × cache × transition) matrix collapses

Today: each of {`did_change`, `did_open`, `did_close`, `did_change_watched_files`, `did_change_configuration`} updates some subset of {`roxygen_tags_cache`, `package_internal_symbols_cache`, `package_namespace_model`, `workspace_imports`} with subtly different rules, and additionally checks for `PackageMode` and `roxygen_managed` transitions inline.

After the refactor: each handler produces a `PackageInputDelta` and calls `derive`. There is one function that produces `PackageState`. Inconsistencies between handlers become structurally impossible.

## 5. Core types

All types live in a new module `crates/raven/src/package_state.rs`. The existing `package_namespace.rs` module is reduced to: parser helpers (`parse_dcf_field`, NAMESPACE parsing) and the data type `PackageNamespaceModel`. The existing `roxygen.rs` module is unchanged in scope (extraction helpers).

### 5.1 Inputs

```rust
pub struct PackageInputs {
    pub workspace_root: Option<PathBuf>,
    pub package_mode: PackageMode,                    // auto | enabled | disabled
    pub description: Option<DescriptionInput>,
    pub namespace: Option<NamespaceInput>,
    /// All R source files keyed by absolute path. Populated for both
    /// open documents (text from DocumentStore) and on-disk-only files.
    /// Files outside R/ and tests/testthat/ are not included.
    pub r_files: BTreeMap<PathBuf, RFileInput>,
}

pub struct DescriptionInput { pub path: PathBuf, pub text: Arc<str> }
pub struct NamespaceInput   { pub path: PathBuf, pub text: Arc<str> }

pub struct RFileInput {
    pub kind: RFileKind,                 // Source (R/) | Test (tests/testthat/)
    pub origin: ContentOrigin,           // Open(version) | Disk
    pub text: Arc<str>,
    pub content_digest: ContentDigest,   // memoization key for derive (see §5.4)
}

pub enum RFileKind { Source, Test }
pub enum ContentOrigin { Open { version: i32 }, Disk }
```

Ownership choice: `PackageInputs` holds `Arc<str>` for content rather than borrowed references. The same `Arc<str>` may be cloned from `DocumentStore` for open files; it costs a single Arc bump. This decision keeps `derive` decoupled from `DocumentStore`'s lifetime and lets us property-test it with synthetic inputs.

### 5.2 Content digest (memoization key)

```rust
/// Content-addressed identity for an `Arc<str>`. Used as the memoization
/// key for `RFileFacts`. The composite (length, hash) makes accidental
/// collisions vanishingly unlikely while keeping equality cheap.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ContentDigest {
    pub byte_len: u32,
    pub blake3_prefix: u64,   // first 8 bytes of blake3(text)
}
```

Two distinct file contents could in principle map to the same `u64` hash; the composite `(byte_len, blake3_prefix)` reduces collision probability to ≪ 2⁻⁶² while remaining a 12-byte struct. The reuse decision in `derive` (Section 6.1 step 2) compares `ContentDigest` for equality. The proptest property in §10.1.2 is conditional on **digest equality implying content equality**; if a generator ever produces two distinct contents with the same digest, the property test surfaces a logic bug rather than passing trivially.

(`blake3` is already a transitive dependency via tower-lsp tooling; if not we will introduce `blake3 = "1"` at the workspace level. Phase 1 may use a simpler `(byte_len, ahash)` if blake3 introduction is gated, with a follow-up to swap before Phase 3 lands.)

### 5.3 Delta

```rust
pub enum PackageInputDelta {
    /// First derivation after workspace open / config change. Treat all
    /// inputs as new.
    Initial,
    /// did_change / did_open for an R/*.R or tests/testthat/*.R file.
    /// did_close also emits this when the file remains on disk
    /// (input switches Open→Disk; content may revert).
    RFileChanged { path: PathBuf, kind: RFileKind },
    /// did_close for a file no longer on disk; or
    /// did_change_watched_files deletion of an R/*.R or
    /// tests/testthat/*.R file.
    RFileDeleted { path: PathBuf, kind: RFileKind },
    /// did_change_watched_files for <root>/NAMESPACE (any change).
    NamespaceChanged,
    /// did_change_watched_files for <root>/DESCRIPTION (any change).
    DescriptionChanged,
    /// did_change_configuration flipping packageMode.
    SettingChanged,
    /// Multiple of the above batched (e.g. workspace scan finds many files).
    Batch(Vec<PackageInputDelta>),
}
```

### 5.4 Outputs

```rust
pub struct PackageState {
    /// None when packageMode is Disabled, or auto+no DESCRIPTION,
    /// or detection failed. Otherwise Some.
    pub workspace: Option<PackageWorkspace>,
    /// `Option<PackageNamespaceModel>` — `None` exactly when
    /// `workspace` is `None` (packageMode Disabled, auto with no
    /// valid DESCRIPTION, or detection failed); cleared in lock-step
    /// with `workspace` whenever a mode/input transition clears
    /// package state. When `Some`, it is merged from `NAMESPACE` +
    /// the union of all R/ roxygen tags (empty but still `Some`
    /// when neither source contributes entries).
    pub namespace_model: Option<PackageNamespaceModel>,
    /// Per-R-file derived facts. Keyed identically to PackageInputs.r_files.
    pub r_file_facts: BTreeMap<PathBuf, RFileFacts>,
    /// What scope/diagnostics/completion consume.
    pub scope_contribution: PackageScopeContribution,
}

pub struct RFileFacts {
    pub roxygen_namespace: RoxygenNamespace,         // existing type from roxygen.rs
    pub top_level_defs: Arc<BTreeSet<String>>,
    pub content_digest: ContentDigest,               // memoization key, see §5.4
}

pub struct PackageScopeContribution {
    /// Internal symbols (top-level defs across all R/ files).
    /// Visible to all R/ files AND all tests/testthat/ files (one-way).
    pub r_internal_symbols: Arc<BTreeSet<String>>,
    /// importFrom and roxygen @importFrom: each imported symbol may be
    /// supplied by multiple packages (`importFrom(A, foo)` and
    /// `importFrom(B, foo)` both contribute). Resolution must consult the
    /// full set; ordering must be deterministic and must not depend on
    /// NAMESPACE/roxygen traversal order. BTreeMap+BTreeSet provides this.
    pub imported_symbols: Arc<BTreeMap<String, BTreeSet<String>>>,
    /// import(pkg) and roxygen @import: deterministic-ordered set of
    /// fully-imported packages whose exports are all available.
    pub full_imports: Arc<BTreeSet<String>>,
}
```

`PackageWorkspace` and `PackageNamespaceModel` retain their current shape (defined in `package_namespace.rs`). The change is purely *who owns them* (`PackageState` instead of `WorldState` directly).

## 6. The `derive` function

Signature:

```rust
pub fn derive_package_state(
    prev: &PackageState,
    inputs: &PackageInputs,
    delta: &PackageInputDelta,
) -> PackageState;
```

### 6.1 Behavior

1. **Determine effective workspace.** Resolution requires *parsing* `Package:` from `description.text`, not merely observing that DESCRIPTION exists. Decision table:
   - `package_mode == Disabled` → `PackageState::empty()`.
   - `package_mode == Auto`: parse `Package:` from `description.text` if present. Effective workspace is `Some(PackageWorkspace { name, root, … })` only when `workspace_root` is set **and** the `Package:` field parses to a non-empty identifier. Otherwise `PackageState::empty()`.
   - `package_mode == Enabled`: parse `Package:` from `description.text` if present; if parsing succeeds, use that name. If `description` is `None` or `Package:` parsing fails, synthesize `PackageWorkspace { name: "unknown", root: workspace_root, ... }` (requires `workspace_root.is_some()`; when also absent, fall back to `PackageState::empty()`).

   This matches existing logic at `state.rs:1524` (`scan_workspace`) and `state.rs:1071–1116` (`apply_workspace_index`), but states the parsing requirement explicitly so `derive` is fully a function of `description.text`.
2. **Per-file facts (memoized).** For each entry in `inputs.r_files`, look up `prev.r_file_facts.get(&path)`. If `cached.content_digest == file.content_digest`, reuse the cached `RFileFacts` (`Arc` clone — cheap). Otherwise re-extract `RoxygenNamespace` and `top_level_defs` from `file.text`. The memoization is what preserves O(changed-file) keystroke cost.
3. **Merge namespace model.** Union the parsed-NAMESPACE imports/exports with the unioned roxygen tags from all `kind == Source` files. **No precedence** between roxygen and NAMESPACE — both contribute. Aim 1 (always-merge) is implemented here.
4. **Compute `scope_contribution`.** `r_internal_symbols` is the union of `top_level_defs` across files with `kind == Source` (test files do not contribute). `imported_symbols` and `full_imports` come straight from the merged `namespace_model`.
5. **Return new state.** No I/O, no logging side effects beyond per-file parse warnings.

### 6.2 The safety property

`delta` is an *advisory hint*, not a contract. The result is identical regardless of which delta variant is passed (or even if `delta == Initial`). Handlers using a wrong delta lose perf — not correctness.

This invariant is the property test target:

```rust
proptest! {
    #[test]
    fn diff_driven_equals_recompute(
        scenario in arbitrary_input_scenario()
    ) {
        let mut state = PackageState::empty();
        for (inputs, delta) in &scenario.steps {
            state = derive_package_state(&state, inputs, delta);
        }
        let from_scratch = derive_package_state(
            &PackageState::empty(),
            &scenario.final_inputs,
            &PackageInputDelta::Initial,
        );
        prop_assert_eq!(state, from_scratch);
    }
}
```

### 6.3 Complexity

Per package-affecting `derive` call, **runs entirely under the `WorldState` write lock**:

- **Step 2 (per-file facts):** `O(Σ size of changed files)` for roxygen extraction + top-level def extraction. Memoized — unchanged files contribute one `BTreeMap` lookup and one `Arc` clone each (effectively `O(R_files × log R_files)` for the BTreeMap traversal).
- **Step 3 (namespace merge):** `O(R_files × avg_tags_per_file)` to union all per-file `RoxygenNamespace`s with the parsed NAMESPACE. For a typical package this is `O(R_files)` since most files contribute no tags.
- **Step 4 (scope contribution):** `O(R_files × avg_top_level_defs)` to build `r_internal_symbols`; `O(unique imports)` to build `imported_symbols` and `full_imports`.
- **Total per call:** `O(Σ size of changed files + R_files × avg(tags + top_level_defs))`.

The **constant-factor cost on every keystroke** is therefore `O(R_files)` for the merge plus the scope rebuild, even when only one file changed. For a 500-file package this is bounded but non-trivial — and it runs under the write lock.

Mitigations specified for the implementation plan:
- Phase 2 establishes a benchmark in `tests/performance_budgets.rs` measuring `derive` time on synthetic 100-file, 500-file, and 1000-file packages with single-file deltas. Budget: ≤ 2 ms median, ≤ 10 ms p99 on the 500-file scenario.
- If the budget cannot be met, two follow-up optimizations are pre-approved:
  - **(a) Memoize merge output by input-set fingerprint:** hash the (sorted) tuple of `(path, content_digest)` for tagged files; if unchanged across calls, reuse `namespace_model` and `scope_contribution` from `prev`.
  - **(b) Hoist roxygen extraction out of the write lock:** in the handler, perform extraction under a read lock first, then acquire the write lock and re-check the cache; this trades a fast-path read-then-write for a slow-path collision.

Memory: total bound is one `RFileFacts` per tracked R/test file. For a 5000-file package, on the order of low-MB (sets of strings + `RoxygenNamespace` per file).

## 7. Event → delta translation

Handlers translate LSP events into deltas through one helper module. The mapping is exhaustive and centralized.

The package subsystem reacts to **two kinds of events**: external LSP events (rows 1–7 below) and one internal event (`WorkspaceScanCompleted`) emitted by Raven's own background workspace-scan task.

| Event | Predicate | Delta(s) emitted |
|---|---|---|
| `did_open` | path matches `is_r_source_path` | `RFileChanged{path, kind}` |
| `did_open` | otherwise | none |
| `did_change` | path matches `is_r_source_path` | `RFileChanged{path, kind}` |
| `did_change` | otherwise | none |
| `did_close` | file still readable on disk | `RFileChanged{path, kind}` (origin Open→Disk; reread) |
| `did_close` | file no longer on disk | `RFileDeleted{path, kind}` |
| `did_save` | any file | **none** — `did_save` only triggers diagnostic republish in this codebase (`backend.rs:4174`); it does not mutate the document. Package state was already updated by the corresponding `did_change`. |
| `did_change_watched_files` | `<root>/DESCRIPTION` created/modified/deleted | `DescriptionChanged` |
| `did_change_watched_files` | `<root>/NAMESPACE` created/modified/deleted | `NamespaceChanged` |
| `did_change_watched_files` | non-open R/tests file (file path) created/modified | `RFileChanged{path, kind}` |
| `did_change_watched_files` | non-open R/tests file (file path) deleted | `RFileDeleted{path, kind}` |
| `did_change_watched_files` | a path that is a *directory* (e.g. `<root>/R/`) | scan the subtree under that directory, emit `Batch(vec![RFileChanged\|RFileDeleted, ...])` for every R/tests file the scan finds or that disappeared. Single non-package directories outside R/tests/ are ignored. (Today, `read_to_string` on a directory silently fails — see `backend.rs:3573, 3897` — that error path is replaced by this rule.) |
| `did_change_configuration` | `packageMode` value changed | `SettingChanged` |
| Initial workspace open / scan kickoff | first derivation | `Initial` (after populating all inputs in batch) |
| `WorkspaceScanCompleted` (**internal**) | the cross-file workspace scan finishes, returning `(pkg_workspace, pkg_ns_model, roxygen_cache, ...)` from `state.rs::scan_workspace` | `Batch(vec![DescriptionChanged, NamespaceChanged, RFileChanged{...} for each scanned file])` then a force-republish of all open documents (mirrors today's `mark_force_republish_many` at `backend.rs:1289–1305`) |

### 7.1 The `WorkspaceScanCompleted` internal event

The cross-file workspace scan runs as a Tokio task (`backend.rs:1265–1365`) that begins after `Initial` and completes asynchronously. When it completes:

1. Inputs that were not yet populated at `Initial` time (because reading the entire `R/` tree is slow) become available.
2. The package subsystem must update its inputs to include the scanned content and re-derive.
3. Open documents must be force-republished to surface diagnostics that depend on the now-complete state — this is exactly today's behavior at `backend.rs:1289–1305` (`mark_force_republish_many`) but now driven by an explicit event rather than ad-hoc rebuild calls.

Specification:
- The scan task, on completion, calls `apply_scan_results(scan_output)` on `WorldState`. That method updates `package_inputs` with all scanned content, calls `derive_package_state(prev, &new_inputs, &Initial)`, replaces `package_state`, and finally calls `mark_force_republish_many(open_uris)`.
- Treating this as a separate event in the spec ensures the post-scan republish is part of the architecture, not an ad-hoc patch.

### 7.2 Centralized predicates

Two helper functions in `package_state.rs` are the *only* places that classify paths:

```rust
/// Returns Some(kind) if `path` is a package source file we track,
/// based on the workspace root. Returns None for paths outside
/// R/**/*.R and tests/testthat/**/*.R.
pub fn is_r_source_path(path: &Path, workspace_root: &Path) -> Option<RFileKind>;

/// Returns true if `path` is anywhere inside the package workspace
/// (used for filtering watched-file events to relevant packages).
pub fn is_inside_package(path: &Path, workspace_root: &Path) -> bool;
```

Every handler that needs to ask "is this an R/ file?" or "is this part of my package?" calls these. The boundary-leak bug class (basename vs. full path; case sensitivity; missed extensions) is eliminated by deduplication.

## 8. Scope integration

### 8.1 `cross_file/scope.rs` accepts `PackageScopeContribution`

The scope engine has multiple entry points; production cross-file resolution does **not** go through `scope_at_position_with_packages` (`scope.rs:1615`, which handles single-file `library()` exports via a closure). Production diagnostics, hover, completion, and goto-definition route through `scope_at_position_with_graph` (`scope.rs:2877`) and `scope_at_position_with_graph_cached` (`scope.rs:2974`), and recursively through `scope_at_position_with_graph_recursive` (`scope.rs:3457`). None of these currently accept package contributions.

Specification:
- Add `package_contribution: Option<&PackageScopeContribution>` as a parameter on `scope_at_position_with_graph`, `scope_at_position_with_graph_cached`, and `scope_at_position_with_graph_recursive`.
- Plumb the contribution through `ScopeStream` (the iterator that feeds the recursive walk) so backward edges and dependency-graph traversal honor it consistently.
- `scope_at_position_with_packages` and `scope_at_position_with_deps` either gain the parameter (uniform API) or are documented as legacy single-file paths that don't need it; the choice will be made during Phase 4 once we audit each call site.

When resolving a symbol in a file under `R/` *or* `tests/testthat/`:
1. Standard scope resolution (definitions in this file, `source()` chains, `library()` calls, dependency-graph back-edges) runs first — these have priority.
2. If still unresolved, the resolver consults `r_internal_symbols`, then `imported_symbols`, then iterates `full_imports` consulting the package library. Any hit is a defined symbol.
3. The resolved symbol carries provenance (which package, which file) so hover/signature can locate documentation.

For files outside `R/` and `tests/testthat/`, no contribution is applied (script-mode behavior is preserved).

### 8.2 Migration checklist for scope call sites

Every site that resolves cross-file scope must be updated to thread `Option<&PackageScopeContribution>` through. Phase 4 must touch each of these and Phase 5 cannot land until they are all migrated.

| Call site | Current entry point |
|---|---|
| `crates/raven/src/handlers.rs:313` (request-cached scope used by completion/hover/etc.) | `scope::scope_at_position_with_graph_cached` |
| `crates/raven/src/handlers.rs:3012` (`get_cross_file_scope`) | `scope::scope_at_position_with_graph` |
| `crates/raven/src/handlers.rs:3058` (`get_cross_file_scope_with_cache`) | `scope::scope_at_position_with_graph_cached` |
| `crates/raven/src/handlers.rs:4578` (diagnostics path) | `scope::scope_at_position_with_graph` |
| `crates/raven/src/backend.rs:2348, 2932, 5328, 5682, 7628` (various LSP request handlers) | `scope::scope_at_position_with_graph` |
| `crates/raven/src/parameter_resolver.rs:774` | `scope::scope_at_position_with_graph` |
| `crates/raven/src/content_provider.rs:2255` | `scope::scope_at_position_with_graph` |
| `crates/raven/src/qualified_resolve.rs:470, 822, 1533, 1627` | `handlers::get_cross_file_scope_with_cache` |
| `DiagnosticsSnapshot::get_scope` (handlers.rs) | wraps `get_cross_file_scope_with_cache` |

Each of these gets the package contribution from `WorldState.package_state.scope_contribution` (read under the existing read lock, cloned via `Arc`). The audit and update of these sites is the bulk of Phase 4's diff.

### 8.3 Diagnostic suppression set is deleted

`DiagnosticsSnapshot::package_internal_symbols` and `DiagnosticsSnapshot::package_full_imports` are removed. The diagnostic loop in `handlers.rs` that consults them (around lines 5085–5345) is replaced with a call into the scope engine — the same call used for hover and completion. There is one resolution path; the diagnostic loop just asks "is this symbol defined?"

`workspace_imports: Arc<Vec<(String, String)>>` on `WorldState` and `DiagnosticsSnapshot` is also removed; its information is now in `PackageScopeContribution.imported_symbols` (`Arc<BTreeMap<String, BTreeSet<String>>>`, which preserves multi-package contributions deterministically — see §5.4).

### 8.4 Hover and completion follow automatically

Hover for an internal R-package function: scope resolves the name to the URI of its defining `R/*.R` file. The existing hover handler dispatches on URI as it does for any other resolved symbol.

Completion's package-mode block in `handlers.rs` (around line 9366) is deleted. Completion reads the scope; the scope already includes package symbols. No special-case code remains.

Signature help: same path as hover.

## 9. Locking and error handling

### 9.1 Locking

| Phase | Lock | Notes |
|---|---|---|
| Read disk content (DESCRIPTION, NAMESPACE, R/*.R) | none | `tokio::task::spawn_blocking`; pre-acquire bytes |
| Read open-document content | none | `DocumentStore::get_text` returns `Arc<str>` |
| Update `WorldState.package_inputs` + call `derive` + write `package_state` | `WorldState::write` | `derive` is pure, runs entirely under the write lock |
| Read `WorldState.package_state` for diagnostics/completion/scope | `WorldState::read` | clone the `Arc<...>` fields out of `PackageScopeContribution` |

`derive` itself acquires no locks. The write-lock-hold time is bounded by `derive`'s runtime, dominated by re-extracting roxygen for changed files.

### 9.2 Error handling

| Failure | Behavior |
|---|---|
| `auto` mode + DESCRIPTION absent | `package_state.workspace = None`; runs as script mode |
| DESCRIPTION present but `Package:` field missing/invalid | log warning once; `package_state.workspace = None` |
| NAMESPACE parse error | log warning; merged namespace uses roxygen-only |
| Roxygen parse error in one file | log warning; that file contributes empty `RoxygenNamespace`; other files unaffected |
| `Enabled` + no DESCRIPTION | synthesize `PackageWorkspace { name: "unknown", root, ... }`; merge proceeds normally |
| File on disk but unreadable | log warning; treat as not-present |
| `derive` panics | unrecoverable bug; tests must establish `derive` cannot panic on any input the handler can produce |

All errors are recoverable. Package mode never crashes the LSP.

## 10. Testing strategy

### 10.1 Three layers

1. **Unit tests on `derive`.** Pure-function tests with hand-constructed `PackageInputs` and `PackageInputDelta`. Cover: detection across `(package_mode, description-present, workspace-root-present)`; merge semantics for NAMESPACE-only, roxygen-only, both, overlapping entries; per-file memoization (content hash unchanged ⇒ facts reused, verified with object-identity check on the inner `Arc`); test-file partition (`kind == Test` symbols never enter `r_internal_symbols`); empty-state idempotence.
2. **Property tests on the safety property** (`proptest` state machine). The naive form ("apply random deltas to random inputs") is trivially satisfiable. The test must instead generate *consistent* (input-mutation, delta) pairs to be meaningful.

   **Generator design** — a `proptest_state_machine::ReferenceStateMachine` over a synthetic `(PackageInputs, PackageState)` pair:

   - **Reference transitions** (each generates an `(InputMutation, PackageInputDelta)` pair):
     - `MutateRFile { path, kind, new_text }` → emits `RFileChanged{path, kind}`
     - `DeleteRFile { path }` → emits `RFileDeleted{path, kind}`
     - `MutateNamespace { new_text }` → emits `NamespaceChanged`
     - `MutateDescription { new_text }` → emits `DescriptionChanged`
     - `MutatePackageMode { new_mode }` → emits `SettingChanged`
     - `MutateMultiple { mutations: Vec<...> }` → emits `Batch(...)` with the corresponding deltas
   - **Adversarial transition (deliberately weakens the delta to test the "advisory" claim):**
     - `MutateRFile { ... }` paired with delta `Initial`, or with `RFileChanged` for a *different* path. The post-state must still equal a from-scratch recompute.

   **Properties asserted at every step:**
   - **Diff-equals-recompute:** `derive(prev_state, current_inputs, advertised_delta) == derive(empty, current_inputs, Initial)`.
   - **Determinism:** Calling `derive` twice with the same inputs produces equal `PackageState` (no internal randomness; no order-dependence in the BTree-backed sets).
   - **Memoization correctness:** When two consecutive `MutateRFile` calls with identical text are run, the inner `Arc<RFileFacts>` for that path must be pointer-equal across the two states (`Arc::ptr_eq`).
   - **Test-file partition:** No `RFileFacts` for a `kind == Test` file ever contributes to `r_internal_symbols`.

   These properties together formalize the safety claim and make the architectural intent machine-checkable.
3. **Parity tests during migration** (Phases 2–3). Capture inputs and outputs from existing event handlers in known scenarios; assert the new derive produces identical results. Temporary scaffolding deleted after Phase 3.
4. **Integration tests** (existing). The 100+ existing LSP integration tests already exercise event sequences. They run unchanged through Phase 3. Phase 4 adds tests for hover/signature on package-internal symbols.

### 10.2 Test discipline

Every commit in the migration must:
- Keep all existing tests green.
- Keep parity tests green (in phases that have them).
- Not regress benchmarks in `tests/performance_budgets.rs` by more than 5% on the package-mode scenarios.

A failing parity test halts migration and is treated as a structural bug.

## 11. Migration plan

Six phases. Each phase is independently mergeable with green tests. Aborting after Phase 3 still delivers most of the architectural value (matrix collapse).

| Phase | Goal | What changes | What stays the same | Tests added |
|---|---|---|---|---|
| **1** | Encapsulate | New `package_state` module. Move `package_workspace`, `package_namespace_model`, `roxygen_tags_cache`, `package_internal_symbols_cache`, `workspace_imports` fields *physically* into `PackageState`, but expose **passthrough accessor methods** on `WorldState` (`pub fn workspace_imports(&self) -> &Arc<Vec<...>>` etc.) and **passthrough mutator methods** that preserve the exact existing mutation API (`pub fn rebuild_namespace_model_from_cache(&mut self) -> bool` etc.). All ~100 existing callers compile unchanged. Fields on `PackageState` may stay `pub(crate)` until Phase 3 makes the encapsulation enforceable. **No behavior change; passes the existing test suite verbatim.** | All event handlers; suppression-set diagnostic path; scope engine | Smoke tests + existing suite green; structure refactor only |
| **2** | Define inputs and `derive` | Introduce `PackageInputs`, `PackageInputDelta`, `derive_package_state`. The legacy `rebuild_*` methods now wrap `derive` internally. Add **parity tests** capturing handler-by-handler input/output today and asserting `derive` matches. | Handlers still call legacy `rebuild_*`; no caller-visible change | Parity tests; unit tests on `derive`; first cut of property tests |
| **3** | Switch handlers to deltas | Each handler computes `PackageInputDelta` and calls `derive` directly. Delete legacy `rebuild_*` methods. **Matrix collapse complete.** | Suppression-set diagnostic path; scope engine | Parity tests deleted; full property-test suite enabled |
| **4** | Wire scope injection | Extend `cross_file/scope.rs` to consume `&PackageScopeContribution`. Hover/signature/completion start working uniformly for package-internal and imported symbols. | Suppression set still in place (parallel paths during transition) | New integration tests for hover/signature on internal symbols |
| **5** | Drop suppression-set path | Delete `DiagnosticsSnapshot::package_internal_symbols` and `package_full_imports`; delete `WorldState::workspace_imports`; delete the package-mode completion block in `handlers.rs`. Diagnostic loop now consults the scope engine. **Non-trivial behavior change for non-package workspaces — see §11.1 below.** | Phase 4 scope-injection path | Existing tests must remain green; new tests for non-package NAMESPACE-derived suppression behavior |
| **6** | Tests/testthat one-way visibility | Verify `kind == Test` files receive contribution; add integration tests for tests/testthat/*.R using internal R/ symbols. | — | Targeted integration tests |

Estimated diff size: Phase 1 ~600 LoC moved (pure refactor); Phase 2 ~400 LoC added (`derive` + parity); Phase 3 ~−800 LoC (handlers shrink); Phase 4 ~250 LoC (scope integration); Phase 5 ~−500 LoC (deletion); Phase 6 ~150 LoC.

### 11.1 Phase 5 non-package consumer behavior

`WorldState::workspace_imports` today is **not strictly package-mode state**. It is populated by `scan_workspace` (see `state.rs:1391`) regardless of whether the workspace is a package: any `NAMESPACE` file at the workspace root has its `import()` and `importFrom()` directives parsed and used to suppress diagnostics. This means a non-package workspace that happens to contain a `NAMESPACE` (e.g. someone editing a script alongside a generated NAMESPACE) currently gets diagnostic suppression for its imports.

Phase 5 deletes `WorldState::workspace_imports`. The replacement, `PackageState::scope_contribution.imported_symbols`, is only populated when `package_state.workspace.is_some()`. So the naive deletion would silently remove suppression for non-package workspaces with a stray NAMESPACE — a behavior regression.

Two acceptable resolutions; we pick (a):

(a) **Preserve current behavior under package mode only.** A non-package workspace's NAMESPACE no longer suppresses diagnostics. Justification: `import()`/`importFrom()` in a NAMESPACE without a `Package:` field is meaningless to R itself; removing this is a *correctness improvement*. We document the change in `docs/r-package-dev.md` and in the release notes. We add a Phase 5 test asserting that a workspace with NAMESPACE-but-no-DESCRIPTION gets script-mode behavior (no suppression).

(b) Build a separate non-package `NamespaceImports` module and parser path. Rejected: re-creates the dual-source-of-truth problem the architecture is trying to remove.

If at any point during Phase 5 we discover real-world users relying on (b)'s behavior, the rollback is to keep `workspace_imports` populated by a tiny non-package-mode parser used only as a suppression set when `package_state.workspace.is_none()`. The architecture supports this addition without re-introducing the matrix.

## 12. Out of scope

- **Parser robustness.** Hand-rolled NAMESPACE/roxygen tokenizers are responsible for ~8 of the 17 fix commits (quote/escape/multiline edge cases). The architectural refactor isolates them to one module so they can be replaced or hardened independently. Replacing them with a real parser is a separate workstream tracked elsewhere.
- **Locking budget audit.** The "no sync I/O under write lock" invariant is established (CLAUDE.md). New code in this refactor honors it; existing code paths outside package mode are not audited here.
- **Package library subprocess.** The `package_library`/`r_subprocess` machinery is separate from package mode and has its own architecture. Not touched.
- **Collate ordering.** Not respected (matches established R LSPs; no user demand observed).
- **S4/R5 method dispatch.** Out of scope (existing limitation; tracked elsewhere).
- **`useDynLib`.** Out of scope (existing limitation).

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Phase 1's pure refactor introduces a regression | Keep the field shapes identical; only ownership moves. Run full test suite per commit. |
| Property tests reveal that today's handler-driven state was *wrong* (not just uncomputed) in some scenario | This is a feature, not a bug. Document the discrepancy; fix as a parity-test failure. |
| `derive` is too slow under the write lock for very large packages (1000+ R files) | Memoization + per-file content digest should keep keystroke cost ~unchanged. We will benchmark in `tests/performance_budgets.rs` and add a budget. If exceeded, hoist roxygen extraction out of the write lock (extract under read lock first; insert if hash unchanged). |
| Scope engine integration (Phase 4) breaks unrelated cross-file scenarios | Integration tests exist for both. Run the full integration suite per Phase 4 commit. |
| Tests/testthat one-way visibility surfaces test files that shouldn't be parsed | The `is_r_source_path` predicate is the single gate. Audit it carefully in Phase 6. |

## 14. Open questions

Resolved by codex:rescue review (2026-05-10):
- ✅ `imported_symbols` shape (must preserve multi-package contributions) → `Arc<BTreeMap<String, BTreeSet<String>>>` (§5.4)
- ✅ Memoization key collision risk → `ContentDigest = (byte_len, blake3_prefix)` (§5.2)
- ✅ Package detection precision → spec parses `Package:` field explicitly (§6.1)
- ✅ Event coverage gaps → added `did_save`, `WorkspaceScanCompleted`, directory-watched-event handling (§7)
- ✅ Scope engine target functions → corrected to `scope_at_position_with_graph[_cached][_recursive]` (§8.1) plus migration checklist (§8.2)
- ✅ Phase 1 "no behavior change" achievability → passthrough accessors and mutators (§11)
- ✅ Phase 5 non-package consumer behavior → explicit policy in §11.1
- ✅ Complexity claim accuracy → revised in §6.3
- ✅ Proptest property testability → state machine generator design in §10.1.2

Currently no unresolved questions. Next reviewer: writing-plans skill.

## 15. References

- `docs/superpowers/plans/2026-05-09-r-package-support-review.md` — original PR review notes
- `docs/r-package-dev.md` — user-facing documentation (will need an update in Phase 4 when hover starts working)
- `docs/cross-file.md` — scope/dependency engine documentation
- `crates/raven/src/cross_file/scope.rs` — scope resolution engine (Phase 4 integration target)
- REditorSupport/languageserver — comparator (NAMESPACE-only, scope injection)
- posit-dev/ark — comparator (NAMESPACE+INDEX, scope injection)
