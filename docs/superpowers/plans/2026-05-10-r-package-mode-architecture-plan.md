# R Package Mode Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the R package mode subsystem in raven so that derived state is produced by a single pure function from explicit inputs, eliminating the (event × cache × transition) bug class that drove 17 fix commits on the `r-packages` branch.

**Architecture:** Introduce `PackageState` (derived) + `PackageInputs` (raw) + `PackageInputDelta` (advisory hint). LSP event handlers translate events to deltas, update inputs, and call `derive_package_state(prev, inputs, delta) -> new_state`. Scope injection through the existing `cross_file/scope.rs` engine replaces the parallel diagnostic-suppression set. `tests/testthat/` files get one-way visibility into `R/`.

**Tech Stack:** Rust, tower-lsp 0.20, tokio, proptest. Spec at `docs/superpowers/specs/2026-05-10-r-package-mode-architecture-design.md`.

---

## File structure

**Create:**
- `crates/raven/src/package_state.rs` — `PackageState`, `PackageInputs`, `PackageInputDelta`, `derive_package_state`, helpers
- `crates/raven/src/package_state/digest.rs` — `ContentDigest` and `digest()` helper
- `crates/raven/src/package_state/derive.rs` — the derive function
- `crates/raven/src/package_state/event.rs` — LSP event → `PackageInputDelta` translation
- `crates/raven/src/package_state/proptest.rs` — proptest state machine for the safety property (gated `#[cfg(test)]`)

**Modify:**
- `crates/raven/src/state.rs` — move package fields into `PackageState`; passthrough accessors
- `crates/raven/src/backend.rs` — replace `rebuild_*` calls with input update + derive
- `crates/raven/src/handlers.rs` — drop suppression set; thread package contribution through scope
- `crates/raven/src/cross_file/scope.rs` — accept `Option<&PackageScopeContribution>`
- `crates/raven/src/lib.rs`, `crates/raven/src/main.rs` — module declarations
- `crates/raven/src/qualified_resolve.rs`, `parameter_resolver.rs`, `content_provider.rs` — scope call sites
- `docs/r-package-dev.md` — Phase 5 behavior change note
- `tests/performance_budgets.rs` — add `derive_package_state` budget

**Branch & worktree:** Work directly on the existing `r-packages` branch. No worktree needed; git status was clean at session start.

**Per-phase commit discipline:** Each task ends with a commit. Each phase ends with a "phase done" commit if any tidy-up is needed. The full test suite (`cargo test -p raven`) must pass before every commit; benchmark regressions are an acceptable reason to investigate but not commit.

---

## Phase 1 — Encapsulate package fields into `PackageState`

**Phase goal:** Physically move the five package-related fields out of `WorldState` into a new `PackageState` struct, behind passthrough accessors so all ~100 existing callers compile unchanged. **No behavior change.** Existing test suite must pass at every commit.

### Task 1.1: Create `package_state` module skeleton

**Files:**
- Create: `crates/raven/src/package_state.rs`
- Modify: `crates/raven/src/lib.rs` (declare module)
- Modify: `crates/raven/src/main.rs` (declare module)

- [ ] **Step 1: Create the module file with empty struct**

```rust
// crates/raven/src/package_state.rs
//! R package mode subsystem.
//!
//! See `docs/superpowers/specs/2026-05-10-r-package-mode-architecture-design.md`
//! for the architectural rationale.
//!
//! This module owns all derived state for R package mode. Outside of this
//! module, `PackageState` is read-only — it can only be replaced as a
//! whole, never partially mutated.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use crate::package_namespace::{PackageNamespaceModel, PackageWorkspace};
use crate::roxygen::RoxygenNamespace;

/// Derived state for R package mode. Owned by `WorldState`.
///
/// Phase 1: holds the five fields previously on `WorldState` directly.
/// Phase 2: gains `derive_package_state` derivation.
/// Phase 5: drops legacy `workspace_imports` field.
#[derive(Default, Debug, Clone)]
pub struct PackageState {
    pub workspace: Option<PackageWorkspace>,
    pub namespace_model: Option<PackageNamespaceModel>,
    pub roxygen_tags_cache: HashMap<PathBuf, RoxygenNamespace>,
    pub internal_symbols_cache: Arc<HashSet<String>>,
    pub workspace_imports: Arc<Vec<(String, String)>>,
}

impl PackageState {
    pub fn new() -> Self {
        Self {
            workspace: None,
            namespace_model: None,
            roxygen_tags_cache: HashMap::new(),
            internal_symbols_cache: Arc::new(HashSet::new()),
            workspace_imports: Arc::new(Vec::new()),
        }
    }
}
```

- [ ] **Step 2: Declare the module in lib.rs and main.rs**

Add `pub mod package_state;` to both `crates/raven/src/lib.rs` and `crates/raven/src/main.rs` (alphabetical order with other `pub mod` lines).

Per CLAUDE.md: "when adding a top-level module to the `raven` crate, declare it in BOTH `crates/raven/src/lib.rs` AND `crates/raven/src/main.rs`".

- [ ] **Step 3: Verify it compiles**

Run: `cargo check -p raven`
Expected: clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/package_state.rs crates/raven/src/lib.rs crates/raven/src/main.rs
git commit -m "refactor(package-state): introduce PackageState skeleton (Phase 1.1)"
```

### Task 1.2: Migrate `package_workspace` into `PackageState`

**Files:**
- Modify: `crates/raven/src/state.rs` (around line 600 + initialization at line 709)

- [ ] **Step 1: Add `package_state` field to `WorldState`**

In `crates/raven/src/state.rs` `pub struct WorldState`, replace the line:
```rust
    pub package_workspace: Option<crate::package_namespace::PackageWorkspace>,
```
with:
```rust
    /// Container for all derived R package mode state. See package_state.rs.
    pub package_state: crate::package_state::PackageState,
```

- [ ] **Step 2: Update the `WorldState::new` initializer**

In `WorldState::new`, replace the line `package_workspace: None,` (around line 709) with `package_state: crate::package_state::PackageState::new(),` (we'll add the other migrations to this same field in subsequent tasks).

- [ ] **Step 3: Add a passthrough accessor**

Below the `WorldState` impl block, add:

```rust
impl WorldState {
    /// Passthrough for legacy `state.package_workspace` reads.
    pub fn package_workspace(&self) -> Option<&crate::package_namespace::PackageWorkspace> {
        self.package_state.workspace.as_ref()
    }
}
```

- [ ] **Step 4: Replace direct field reads across the codebase**

Run:
```bash
rg -l 'state\.package_workspace|self\.package_workspace' crates/raven/src/
```

For each file in the result, replace:
- `state.package_workspace.as_ref()` → `state.package_workspace()`
- `state.package_workspace.is_some()` → `state.package_workspace().is_some()`
- `state.package_workspace.is_none()` → `state.package_workspace().is_none()`
- `state.package_workspace = ...` (writes) → `state.package_state.workspace = ...`
- `self.package_workspace.as_ref()` → `self.package_state.workspace.as_ref()` (when `self` is `WorldState`)

- [ ] **Step 5: Verify clean compile and tests pass**

Run: `cargo check -p raven`
Expected: clean compile.

Run: `cargo test -p raven --lib`
Expected: all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/
git commit -m "refactor(package-state): migrate package_workspace into PackageState (Phase 1.2)"
```

### Task 1.3: Migrate `package_namespace_model` into `PackageState`

**Files:**
- Modify: `crates/raven/src/state.rs`
- Modify: any file that reads or writes `state.package_namespace_model`

- [ ] **Step 1: Remove the field from `WorldState`**

Delete the line:
```rust
    pub package_namespace_model: Option<crate::package_namespace::PackageNamespaceModel>,
```

Delete its initializer in `WorldState::new`: `package_namespace_model: None,`.

- [ ] **Step 2: Add passthrough accessor**

```rust
impl WorldState {
    pub fn package_namespace_model(&self) -> Option<&crate::package_namespace::PackageNamespaceModel> {
        self.package_state.namespace_model.as_ref()
    }
}
```

- [ ] **Step 3: Replace direct reads/writes**

Run `rg -l 'package_namespace_model' crates/raven/src/` and update every site:
- Reads: `state.package_namespace_model` → `state.package_namespace_model()`
- Writes: `state.package_namespace_model = X;` → `state.package_state.namespace_model = X;`

- [ ] **Step 4: Verify and commit**

Run: `cargo test -p raven --lib`
Expected: all tests pass.

```bash
git add crates/raven/src/
git commit -m "refactor(package-state): migrate package_namespace_model into PackageState (Phase 1.3)"
```

### Task 1.4: Migrate `roxygen_tags_cache` into `PackageState`

**Files:**
- Modify: `crates/raven/src/state.rs`
- Modify: any file referencing `roxygen_tags_cache`

- [ ] **Step 1: Remove field from `WorldState`**

Delete:
```rust
    pub roxygen_tags_cache: HashMap<PathBuf, crate::roxygen::RoxygenNamespace>,
```

Delete its initializer: `roxygen_tags_cache: HashMap::new(),`.

- [ ] **Step 2: Add passthrough accessors**

```rust
impl WorldState {
    pub fn roxygen_tags_cache(&self) -> &std::collections::HashMap<std::path::PathBuf, crate::roxygen::RoxygenNamespace> {
        &self.package_state.roxygen_tags_cache
    }

    pub fn roxygen_tags_cache_mut(&mut self) -> &mut std::collections::HashMap<std::path::PathBuf, crate::roxygen::RoxygenNamespace> {
        &mut self.package_state.roxygen_tags_cache
    }
}
```

- [ ] **Step 3: Replace direct reads/writes**

Run `rg -l 'roxygen_tags_cache' crates/raven/src/` and update each site, preferring the new accessors.

- [ ] **Step 4: Verify and commit**

Run: `cargo test -p raven --lib`

```bash
git add crates/raven/src/
git commit -m "refactor(package-state): migrate roxygen_tags_cache into PackageState (Phase 1.4)"
```

### Task 1.5: Migrate `package_internal_symbols_cache` into `PackageState`

**Files:**
- Modify: `crates/raven/src/state.rs`
- Modify: handlers.rs:339-359 (`collect_package_internal_symbols`)

- [ ] **Step 1: Remove field; add passthrough**

Delete the field and initializer from `WorldState`. Add accessor:
```rust
impl WorldState {
    pub fn package_internal_symbols_cache(&self) -> &std::sync::Arc<std::collections::HashSet<String>> {
        &self.package_state.internal_symbols_cache
    }
}
```

- [ ] **Step 2: Update `rebuild_package_internal_symbols_cache` to live on `PackageState`**

In `state.rs`, find the existing `pub fn rebuild_package_internal_symbols_cache(&mut self)` (line ~784) and **replace** with a passthrough that calls a new method on `PackageState`. Move the body's logic to `PackageState::rebuild_internal_symbols_cache(&mut self, workspace_index: &CrossFileWorkspaceIndex, document_store: &DocumentStore)` (signature adapted to take inputs explicitly).

Skeleton:
```rust
impl PackageState {
    pub fn rebuild_internal_symbols_cache(
        &mut self,
        workspace_index: &crate::cross_file::workspace_index::CrossFileWorkspaceIndex,
        documents: &crate::document_store::DocumentStore,
    ) {
        // Move the existing body here, replacing self.* references with
        // workspace_index.* / documents.* as appropriate.
        // self.workspace -> self.workspace, no change
        // self.internal_symbols_cache = Arc::new(...)
    }
}

impl WorldState {
    pub fn rebuild_package_internal_symbols_cache(&mut self) {
        // Borrow-split: take a snapshot reference to non-package state.
        let workspace_index = &self.cross_file_workspace_index;
        let documents = &self.document_store;
        self.package_state.rebuild_internal_symbols_cache(workspace_index, documents);
    }
}
```

(Adjust the actual borrows based on what the existing body of `rebuild_package_internal_symbols_cache` reads.)

- [ ] **Step 3: Update reads of the cache**

For sites that previously did `state.package_internal_symbols_cache.clone()`, replace with `state.package_internal_symbols_cache().clone()`.

- [ ] **Step 4: Verify and commit**

Run: `cargo test -p raven --lib`

```bash
git add crates/raven/src/
git commit -m "refactor(package-state): migrate package_internal_symbols_cache into PackageState (Phase 1.5)"
```

### Task 1.6: Migrate `workspace_imports` into `PackageState`

**Files:**
- Modify: `crates/raven/src/state.rs`
- Modify: every file referencing `workspace_imports` (see initial grep — ~10+ sites)

- [ ] **Step 1: Remove field from `WorldState`; add passthrough**

Delete `pub workspace_imports: Arc<Vec<(String, String)>>,` from `WorldState`. Delete `workspace_imports: Arc::new(Vec::new()),` from initializer. Add:
```rust
impl WorldState {
    pub fn workspace_imports(&self) -> &std::sync::Arc<Vec<(String, String)>> {
        &self.package_state.workspace_imports
    }
}
```

- [ ] **Step 2: Replace reads and writes**

Run `rg -n 'workspace_imports' crates/raven/src/` and:
- For reads: `state.workspace_imports` → `state.workspace_imports()`. For destructuring (`state.workspace_imports.iter()`), → `state.workspace_imports().iter()`.
- For writes: `state.workspace_imports = X;` → `state.package_state.workspace_imports = X;`.

The line in `DiagnosticsSnapshot::build` (around handlers.rs:251–260) that reads `state.workspace_imports.clone()` becomes `state.workspace_imports().clone()`.

- [ ] **Step 3: Move `rebuild_namespace_model_from_cache` body to `PackageState`**

Find `pub fn rebuild_namespace_model_from_cache(&mut self) -> bool` in `state.rs` (line ~731) and split similarly to Task 1.5: a new `impl PackageState` method holds the logic, and `WorldState::rebuild_namespace_model_from_cache(&mut self) -> bool` is a passthrough that pre-snapshots any non-package borrows and forwards.

- [ ] **Step 4: Verify and commit**

Run: `cargo test -p raven`

```bash
git add crates/raven/src/
git commit -m "refactor(package-state): migrate workspace_imports into PackageState (Phase 1.6)"
```

### Task 1.7: Phase 1 verification

**Files:** none

- [ ] **Step 1: Full test suite**

Run: `cargo test -p raven`
Expected: every test passing — Phase 1 must be a pure refactor.

- [ ] **Step 2: Run integration tests too**

Run: `cargo test -p raven --tests`
Expected: green.

- [ ] **Step 3: Verify benchmarks compile**

Run: `cargo bench -p raven --no-run`
Expected: clean compile (we don't run them yet).

- [ ] **Step 4: Smoke-test in VS Code**

Open a known package workspace in VS Code with the dev build of raven. Confirm:
- Package mode activates (status visible in logs).
- Cross-file references between R/*.R files don't show false-positive diagnostics.
- Edit, save, close — no crashes, no errors in logs.

- [ ] **Step 5: Phase 1 milestone commit**

If any small docs/comments updates were needed:
```bash
git add docs/ crates/
git commit -m "refactor(package-state): Phase 1 complete — fields encapsulated, no behavior change"
```

Otherwise skip — earlier commits already capture the work.

---

## Phase 2 — Define inputs, delta, derive function, parity tests

**Phase goal:** Add the `PackageInputs`/`PackageInputDelta`/`derive_package_state` machinery as new code that *coexists* with the existing legacy `rebuild_*` methods. Add parity tests that capture handler-by-handler input/output today and assert `derive` matches. Add unit tests, property tests, and a benchmark.

### Task 2.1: Add `ContentDigest` type

**Files:**
- Create: `crates/raven/src/package_state/digest.rs`
- Modify: `crates/raven/src/package_state.rs` (add `pub mod digest;` and re-exports)
- Modify: `crates/raven/Cargo.toml` (add `blake3` if not already present)

- [ ] **Step 1: Check whether blake3 is already a dep**

Run: `cargo tree -p raven 2>/dev/null | rg blake3`
Expected: either present (transitive or direct) or absent.

- [ ] **Step 2: If absent, add to Cargo.toml**

In `crates/raven/Cargo.toml` `[dependencies]`:
```toml
blake3 = "1"
```

Run: `cargo check -p raven` to fetch.

- [ ] **Step 3: Convert `package_state.rs` to a directory module**

If `package_state.rs` exists as a single file, keep it as the root. Add at the top:
```rust
pub mod digest;
pub use digest::ContentDigest;
```

- [ ] **Step 4: Write the digest module with a failing test**

```rust
// crates/raven/src/package_state/digest.rs
//! Content-addressed identity for an Arc<str>.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub struct ContentDigest {
    pub byte_len: u32,
    pub blake3_prefix: u64,
}

impl ContentDigest {
    pub fn of(text: &str) -> Self {
        let hash = blake3::hash(text.as_bytes());
        let bytes = hash.as_bytes();
        let blake3_prefix = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        Self {
            byte_len: u32::try_from(text.len()).unwrap_or(u32::MAX),
            blake3_prefix,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_text_yields_equal_digest() {
        let a = ContentDigest::of("foo <- 1\n");
        let b = ContentDigest::of("foo <- 1\n");
        assert_eq!(a, b);
    }

    #[test]
    fn different_text_yields_different_digest() {
        let a = ContentDigest::of("foo <- 1\n");
        let b = ContentDigest::of("foo <- 2\n");
        assert_ne!(a, b);
    }

    #[test]
    fn empty_text_has_zero_length() {
        let d = ContentDigest::of("");
        assert_eq!(d.byte_len, 0);
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p raven --lib package_state::digest`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/package_state.rs crates/raven/src/package_state/digest.rs crates/raven/Cargo.toml
git commit -m "feat(package-state): add ContentDigest with blake3 prefix (Phase 2.1)"
```

### Task 2.2: Add `PackageInputs`, `RFileInput`, `RFileKind`, `ContentOrigin`

**Files:**
- Modify: `crates/raven/src/package_state.rs`

- [ ] **Step 1: Define the input types**

Append to `crates/raven/src/package_state.rs`:

```rust
// ============== INPUTS ==============

use crate::cross_file::config::PackageMode;

#[derive(Clone, Debug, Default)]
pub struct PackageInputs {
    pub workspace_root: Option<PathBuf>,
    pub package_mode: PackageMode,
    pub description: Option<DescriptionInput>,
    pub namespace: Option<NamespaceInput>,
    pub r_files: BTreeMap<PathBuf, RFileInput>,
}

#[derive(Clone, Debug)]
pub struct DescriptionInput {
    pub path: PathBuf,
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct NamespaceInput {
    pub path: PathBuf,
    pub text: Arc<str>,
}

#[derive(Clone, Debug)]
pub struct RFileInput {
    pub kind: RFileKind,
    pub origin: ContentOrigin,
    pub text: Arc<str>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum RFileKind {
    Source,
    Test,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContentOrigin {
    Open { version: i32 },
    Disk,
}
```

- [ ] **Step 2: Add a smoke test**

```rust
#[cfg(test)]
mod input_tests {
    use super::*;

    #[test]
    fn default_inputs_are_empty() {
        let inputs = PackageInputs::default();
        assert!(inputs.workspace_root.is_none());
        assert!(inputs.r_files.is_empty());
    }
}
```

- [ ] **Step 3: Verify and commit**

Run: `cargo test -p raven --lib package_state`
Expected: digest tests + 1 new test, all pass.

```bash
git add crates/raven/src/package_state.rs
git commit -m "feat(package-state): add PackageInputs, RFileInput, RFileKind (Phase 2.2)"
```

### Task 2.3: Add `PackageInputDelta`

**Files:**
- Modify: `crates/raven/src/package_state.rs`

- [ ] **Step 1: Define the delta enum**

Append:
```rust
// ============== DELTA ==============

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PackageInputDelta {
    Initial,
    RFileChanged { path: PathBuf, kind: RFileKind },
    RFileDeleted { path: PathBuf, kind: RFileKind },
    NamespaceChanged,
    DescriptionChanged,
    SettingChanged,
    Batch(Vec<PackageInputDelta>),
}
```

- [ ] **Step 2: Verify compiles**

Run: `cargo check -p raven`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/package_state.rs
git commit -m "feat(package-state): add PackageInputDelta enum (Phase 2.3)"
```

### Task 2.4: Add `is_r_source_path` and `is_inside_package` helpers

**Files:**
- Modify: `crates/raven/src/package_state.rs`

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod path_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn r_source_path_recognizes_R_dir() {
        let root = Path::new("/work/pkg");
        let kind = is_r_source_path(Path::new("/work/pkg/R/utils.R"), root);
        assert_eq!(kind, Some(RFileKind::Source));
    }

    #[test]
    fn r_source_path_recognizes_testthat() {
        let root = Path::new("/work/pkg");
        let kind = is_r_source_path(Path::new("/work/pkg/tests/testthat/test-utils.R"), root);
        assert_eq!(kind, Some(RFileKind::Test));
    }

    #[test]
    fn r_source_path_rejects_non_R_files() {
        let root = Path::new("/work/pkg");
        assert_eq!(is_r_source_path(Path::new("/work/pkg/R/utils.txt"), root), None);
        assert_eq!(is_r_source_path(Path::new("/work/pkg/inst/data.R"), root), None);
        assert_eq!(is_r_source_path(Path::new("/elsewhere/utils.R"), root), None);
    }

    #[test]
    fn r_source_path_handles_uppercase_extension() {
        let root = Path::new("/work/pkg");
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/utils.r"), root),
            Some(RFileKind::Source),
            ".r lowercase should also match"
        );
    }

    #[test]
    fn r_source_path_recognizes_subdirs_in_R() {
        let root = Path::new("/work/pkg");
        assert_eq!(
            is_r_source_path(Path::new("/work/pkg/R/unix/utils.R"), root),
            Some(RFileKind::Source),
            "OS-specific R subdirs (e.g. R/unix/) are valid"
        );
    }
}
```

Run: `cargo test -p raven --lib package_state::path_tests`
Expected: 5 failures (function not defined).

- [ ] **Step 2: Implement the helpers**

Append to `package_state.rs`:
```rust
use std::path::Path;

/// Returns `Some(kind)` if `path` is a package source/test file we track,
/// based on the workspace root. Returns `None` otherwise.
///
/// Rules:
/// - `<root>/R/**/*.R` (or `*.r`) → `Source`
/// - `<root>/tests/testthat/**/*.R` (or `*.r`) → `Test`
/// - everything else → `None`
pub fn is_r_source_path(path: &Path, workspace_root: &Path) -> Option<RFileKind> {
    let rel = path.strip_prefix(workspace_root).ok()?;
    let mut comps = rel.components();
    let first = comps.next()?.as_os_str().to_str()?;

    let is_r_extension = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("R" | "r"),
    );
    if !is_r_extension {
        return None;
    }

    match first {
        "R" => Some(RFileKind::Source),
        "tests" => {
            let second = comps.next()?.as_os_str().to_str()?;
            if second == "testthat" {
                Some(RFileKind::Test)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Returns true if `path` is anywhere inside the package workspace.
pub fn is_inside_package(path: &Path, workspace_root: &Path) -> bool {
    path.starts_with(workspace_root)
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p raven --lib package_state::path_tests`
Expected: 5 passes.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/package_state.rs
git commit -m "feat(package-state): add is_r_source_path and is_inside_package helpers (Phase 2.4)"
```

### Task 2.5: Add `RFileFacts` and `PackageScopeContribution` types

**Files:**
- Modify: `crates/raven/src/package_state.rs`

- [ ] **Step 1: Define output types**

Append:
```rust
// ============== OUTPUTS (continued) ==============

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RFileFacts {
    pub roxygen_namespace: RoxygenNamespace,
    pub top_level_defs: Arc<BTreeSet<String>>,
    pub content_digest: ContentDigest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackageScopeContribution {
    pub r_internal_symbols: Arc<BTreeSet<String>>,
    pub imported_symbols: Arc<BTreeMap<String, BTreeSet<String>>>,
    pub full_imports: Arc<BTreeSet<String>>,
}
```

(Note: ensure `RoxygenNamespace` derives `PartialEq, Eq` — if not, add the derives in `roxygen.rs`.)

- [ ] **Step 2: Extend `PackageState` to embed the new types**

Replace the existing `PackageState` definition with:
```rust
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct PackageState {
    // Phase 1 fields (still present for compatibility)
    pub workspace: Option<PackageWorkspace>,
    pub namespace_model: Option<PackageNamespaceModel>,
    pub roxygen_tags_cache: HashMap<PathBuf, RoxygenNamespace>,
    pub internal_symbols_cache: Arc<HashSet<String>>,
    pub workspace_imports: Arc<Vec<(String, String)>>,

    // Phase 2 additions (populated by derive_package_state)
    pub r_file_facts: BTreeMap<PathBuf, RFileFacts>,
    pub scope_contribution: PackageScopeContribution,
}
```

(Ensure `PackageWorkspace`, `PackageNamespaceModel` derive `PartialEq, Eq` in `package_namespace.rs`. Also ensure `HashMap` doesn't break Eq — replace with `BTreeMap` for the `roxygen_tags_cache` if needed for derived equality. Note: `HashSet` has Eq derived in std.)

If `PackageWorkspace`/`PackageNamespaceModel` don't have `Eq` and adding it is invasive, change `PackageState`'s derives to `Debug, Clone` only and write a manual `PartialEq` that ignores the legacy fields and only compares Phase 2 fields. The proptest property only needs equality on the *new* derived fields anyway.

- [ ] **Step 3: Verify**

Run: `cargo check -p raven`
Expected: clean. If `Eq` derives fail on `PackageNamespaceModel`/`PackageWorkspace`, add them in `package_namespace.rs` (they're plain data; should be straightforward).

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/package_state.rs crates/raven/src/package_namespace.rs crates/raven/src/roxygen.rs
git commit -m "feat(package-state): add RFileFacts, PackageScopeContribution types (Phase 2.5)"
```

### Task 2.6: Implement `derive_package_state` step 1 (effective workspace)

**Files:**
- Create: `crates/raven/src/package_state/derive.rs`
- Modify: `crates/raven/src/package_state.rs` (re-export)

- [ ] **Step 1: Write failing tests**

Create `crates/raven/src/package_state/derive.rs`:

```rust
//! The pure derivation function from `PackageInputs` to `PackageState`.
//!
//! See spec §6 (`derive` function).

use super::*;
use crate::package_namespace::parse_dcf_field_pub;

pub fn derive_package_state(
    prev: &PackageState,
    inputs: &PackageInputs,
    delta: &PackageInputDelta,
) -> PackageState {
    let _ = (prev, delta); // placeholder until later steps

    let workspace = effective_workspace(inputs);
    let mut state = PackageState::default();
    state.workspace = workspace;
    state
}

fn effective_workspace(inputs: &PackageInputs) -> Option<PackageWorkspace> {
    let root = inputs.workspace_root.as_ref()?;
    let parsed_name = inputs
        .description
        .as_ref()
        .and_then(|d| parse_dcf_field_pub(&d.text, "Package"))
        .filter(|s| !s.is_empty());

    match (inputs.package_mode, parsed_name.as_deref()) {
        (PackageMode::Disabled, _) => None,
        (PackageMode::Auto, Some(name)) => Some(PackageWorkspace {
            name: name.to_string(),
            root: root.clone(),
            roxygen_managed: false, // legacy field; deprecated, kept for compat
        }),
        (PackageMode::Auto, None) => None,
        (PackageMode::Enabled, Some(name)) => Some(PackageWorkspace {
            name: name.to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
        (PackageMode::Enabled, None) => Some(PackageWorkspace {
            name: "unknown".to_string(),
            root: root.clone(),
            roxygen_managed: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_inputs(mode: PackageMode) -> PackageInputs {
        PackageInputs {
            workspace_root: Some("/work/pkg".into()),
            package_mode: mode,
            description: None,
            namespace: None,
            r_files: BTreeMap::new(),
        }
    }

    fn with_description(mode: PackageMode, text: &str) -> PackageInputs {
        let mut i = empty_inputs(mode);
        i.description = Some(DescriptionInput {
            path: "/work/pkg/DESCRIPTION".into(),
            text: text.into(),
        });
        i
    }

    #[test]
    fn disabled_mode_yields_no_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Disabled, "Package: foo\n"),
            &PackageInputDelta::Initial,
        );
        assert!(s.workspace.is_none());
    }

    #[test]
    fn auto_with_no_description_yields_no_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &empty_inputs(PackageMode::Auto),
            &PackageInputDelta::Initial,
        );
        assert!(s.workspace.is_none());
    }

    #[test]
    fn auto_with_description_yields_workspace() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Auto, "Package: foo\n"),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "foo");
    }

    #[test]
    fn enabled_with_no_description_synthesizes_unknown() {
        let s = derive_package_state(
            &PackageState::default(),
            &empty_inputs(PackageMode::Enabled),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "unknown");
    }

    #[test]
    fn enabled_with_invalid_description_synthesizes_unknown() {
        let s = derive_package_state(
            &PackageState::default(),
            &with_description(PackageMode::Enabled, "no Package field here\n"),
            &PackageInputDelta::Initial,
        );
        assert_eq!(s.workspace.as_ref().unwrap().name, "unknown");
    }
}
```

In `crates/raven/src/package_state.rs`, add the module declaration at the top:
```rust
pub mod derive;
pub use derive::derive_package_state;
```

- [ ] **Step 2: Run tests (expect failure if `parse_dcf_field_pub` not exported)**

Run: `cargo test -p raven --lib package_state::derive`
If errors about `parse_dcf_field_pub`, ensure it's `pub` in `package_namespace.rs` (it should be per the existing grep — line 212).

- [ ] **Step 3: Run again**

Run: `cargo test -p raven --lib package_state::derive`
Expected: 5 passes.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/package_state.rs crates/raven/src/package_state/derive.rs
git commit -m "feat(package-state): derive step 1 — effective workspace detection (Phase 2.6)"
```

### Task 2.7: Implement `derive_package_state` step 2 (per-file facts memoization)

**Files:**
- Modify: `crates/raven/src/package_state/derive.rs`
- Modify: `crates/raven/src/roxygen.rs` (extract `top_level_defs`)

- [ ] **Step 1: Add a helper in `roxygen.rs` for top-level definition extraction**

Find or add `pub fn extract_top_level_defs(text: &str) -> std::collections::BTreeSet<String>` in `crates/raven/src/roxygen.rs`. If a similar function already exists (likely in workspace_index or scope), reuse it; otherwise, write a tree-sitter-based or regex-based extractor.

For the simplest first cut, copy the existing top-level extraction logic from `cross_file::workspace_index::extract_definitions` into a small helper. Aim for fidelity rather than performance.

```rust
// In crates/raven/src/roxygen.rs (or a new module if it grows):
pub fn extract_top_level_defs(text: &str) -> std::collections::BTreeSet<String> {
    // For Phase 2.7, delegate to existing logic. The existing
    // `WorkspaceIndex` build path already extracts top-level defs.
    // Replace this stub with a call to that logic.
    todo!("delegate to existing top-level def extractor")
}
```

(Resolve the `todo!` by tracing where `top_level_defs` are computed today — likely in `crates/raven/src/cross_file/workspace_index.rs` or `cross_file/scope.rs::compute_artifacts`. Extract that logic into a free function callable from here. If it's too tangled, write a fresh extractor using tree-sitter for the common cases: `name <- function(...)`, `name = function(...)`, `setGeneric("name", ...)`. The proptest in 2.13 will catch correctness gaps.)

- [ ] **Step 2: Add memoization step in `derive`**

In `crates/raven/src/package_state/derive.rs`, replace the body of `derive_package_state`:
```rust
pub fn derive_package_state(
    prev: &PackageState,
    inputs: &PackageInputs,
    delta: &PackageInputDelta,
) -> PackageState {
    let _ = delta;
    let workspace = effective_workspace(inputs);
    let r_file_facts = derive_r_file_facts(&prev.r_file_facts, &inputs.r_files);
    let mut state = PackageState::default();
    state.workspace = workspace;
    state.r_file_facts = r_file_facts;
    state
}

fn derive_r_file_facts(
    prev: &BTreeMap<PathBuf, RFileFacts>,
    inputs: &BTreeMap<PathBuf, RFileInput>,
) -> BTreeMap<PathBuf, RFileFacts> {
    let mut out = BTreeMap::new();
    for (path, file) in inputs {
        let reuse = prev
            .get(path)
            .filter(|cached| cached.content_digest == file.content_digest);
        let facts = match reuse {
            Some(cached) => cached.clone(),
            None => RFileFacts {
                roxygen_namespace: crate::roxygen::extract_roxygen_namespace_tags(&file.text),
                top_level_defs: std::sync::Arc::new(crate::roxygen::extract_top_level_defs(&file.text)),
                content_digest: file.content_digest,
            },
        };
        out.insert(path.clone(), facts);
    }
    out
}
```

- [ ] **Step 3: Add memoization tests**

```rust
#[test]
fn memoization_reuses_cached_facts_on_unchanged_content() {
    let path: PathBuf = "/work/pkg/R/foo.R".into();
    let text: Arc<str> = "foo <- function() 1\n".into();
    let digest = ContentDigest::of(&text);

    let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
    inputs.r_files.insert(path.clone(), RFileInput {
        kind: RFileKind::Source,
        origin: ContentOrigin::Disk,
        text: text.clone(),
        content_digest: digest,
    });

    let s1 = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
    let s2 = derive_package_state(&s1, &inputs, &PackageInputDelta::Initial);

    let f1 = s1.r_file_facts.get(&path).unwrap();
    let f2 = s2.r_file_facts.get(&path).unwrap();
    // The Arc<BTreeSet<String>> should be pointer-equal across the two calls
    assert!(std::sync::Arc::ptr_eq(&f1.top_level_defs, &f2.top_level_defs));
}

#[test]
fn memoization_recomputes_on_content_change() {
    let path: PathBuf = "/work/pkg/R/foo.R".into();
    let text1: Arc<str> = "foo <- function() 1\n".into();
    let text2: Arc<str> = "foo <- function() 2\n".into();

    let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
    inputs.r_files.insert(path.clone(), RFileInput {
        kind: RFileKind::Source,
        origin: ContentOrigin::Disk,
        text: text1.clone(),
        content_digest: ContentDigest::of(&text1),
    });

    let s1 = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);

    inputs.r_files.get_mut(&path).unwrap().text = text2.clone();
    inputs.r_files.get_mut(&path).unwrap().content_digest = ContentDigest::of(&text2);

    let s2 = derive_package_state(&s1, &inputs, &PackageInputDelta::Initial);
    let f1 = s1.r_file_facts.get(&path).unwrap();
    let f2 = s2.r_file_facts.get(&path).unwrap();
    assert!(!std::sync::Arc::ptr_eq(&f1.top_level_defs, &f2.top_level_defs));
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p raven --lib package_state`
Expected: detection + memoization tests all green.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_state/ crates/raven/src/roxygen.rs
git commit -m "feat(package-state): derive step 2 — per-file facts with memoization (Phase 2.7)"
```

### Task 2.8: Implement `derive_package_state` step 3 (merge namespace model)

**Files:**
- Modify: `crates/raven/src/package_state/derive.rs`

- [ ] **Step 1: Add merge logic**

In `derive_package_state` body, after building `r_file_facts`:

```rust
let namespace_model = if workspace.is_some() {
    Some(merge_namespace_model(
        inputs.namespace.as_ref(),
        &r_file_facts,
    ))
} else {
    None
};

state.namespace_model = namespace_model;
```

Add helper:
```rust
fn merge_namespace_model(
    namespace: Option<&NamespaceInput>,
    r_file_facts: &BTreeMap<PathBuf, RFileFacts>,
) -> PackageNamespaceModel {
    let mut model = match namespace {
        Some(ns) => crate::package_namespace::namespace_model_from_content(&ns.text),
        None => PackageNamespaceModel::default(),
    };

    for (_, facts) in r_file_facts {
        // Union roxygen-derived imports/exports with NAMESPACE-derived.
        for sym in &facts.roxygen_namespace.exports {
            model.exports.insert(sym.clone());
        }
        for (pkg, sym) in &facts.roxygen_namespace.imports {
            if !model.imports.iter().any(|(p, s)| p == pkg && s == sym) {
                model.imports.push((pkg.clone(), sym.clone()));
            }
        }
        for pkg in &facts.roxygen_namespace.full_imports {
            if !model.full_imports.contains(pkg) {
                model.full_imports.push(pkg.clone());
            }
        }
    }

    model
}
```

(Adjust field names to match the actual `PackageNamespaceModel` and `RoxygenNamespace` shapes — read them in `package_namespace.rs` and `roxygen.rs` first.)

- [ ] **Step 2: Add merge tests**

```rust
#[test]
fn merge_unions_namespace_and_roxygen() {
    use crate::roxygen::RoxygenNamespace;
    let path: PathBuf = "/work/pkg/R/foo.R".into();
    let text: Arc<str> = "#' @importFrom dplyr filter\nfoo <- function() 1\n".into();
    let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
    inputs.namespace = Some(NamespaceInput {
        path: "/work/pkg/NAMESPACE".into(),
        text: "importFrom(dplyr, mutate)\nimport(magrittr)\n".into(),
    });
    inputs.r_files.insert(path.clone(), RFileInput {
        kind: RFileKind::Source,
        origin: ContentOrigin::Disk,
        text: text.clone(),
        content_digest: ContentDigest::of(&text),
    });
    let s = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
    let m = s.namespace_model.unwrap();
    // Both `dplyr::filter` (roxygen) and `dplyr::mutate` (NAMESPACE) present
    assert!(m.imports.iter().any(|(p,n)| p=="dplyr" && n=="filter"));
    assert!(m.imports.iter().any(|(p,n)| p=="dplyr" && n=="mutate"));
    // import(magrittr) preserved
    assert!(m.full_imports.contains(&"magrittr".to_string()));
}
```

- [ ] **Step 3: Run, fix, commit**

Run: `cargo test -p raven --lib package_state`
Expected: green.

```bash
git add crates/raven/src/package_state/derive.rs
git commit -m "feat(package-state): derive step 3 — merge namespace model (Phase 2.8)"
```

### Task 2.9: Implement `derive_package_state` step 4 (scope contribution)

**Files:**
- Modify: `crates/raven/src/package_state/derive.rs`

- [ ] **Step 1: Add scope contribution build**

```rust
fn build_scope_contribution(
    workspace: &Option<PackageWorkspace>,
    namespace_model: &Option<PackageNamespaceModel>,
    r_file_facts: &BTreeMap<PathBuf, RFileFacts>,
) -> PackageScopeContribution {
    let Some(ws) = workspace else {
        return PackageScopeContribution::default();
    };

    let r_dir = ws.root.join("R");
    let mut r_internal_symbols: BTreeSet<String> = BTreeSet::new();
    for (path, facts) in r_file_facts {
        if !path.starts_with(&r_dir) { continue; } // Source kind == under R/
        for def in facts.top_level_defs.iter() {
            r_internal_symbols.insert(def.clone());
        }
    }

    let (imported, full) = match namespace_model {
        Some(model) => {
            let mut imported: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for (pkg, sym) in &model.imports {
                imported.entry(sym.clone()).or_default().insert(pkg.clone());
            }
            let full: BTreeSet<String> = model.full_imports.iter().cloned().collect();
            (imported, full)
        }
        None => (BTreeMap::new(), BTreeSet::new()),
    };

    PackageScopeContribution {
        r_internal_symbols: Arc::new(r_internal_symbols),
        imported_symbols: Arc::new(imported),
        full_imports: Arc::new(full),
    }
}
```

In `derive_package_state`, append:
```rust
state.scope_contribution = build_scope_contribution(
    &state.workspace,
    &state.namespace_model,
    &state.r_file_facts,
);
```

- [ ] **Step 2: Add scope contribution tests**

```rust
#[test]
fn scope_contribution_includes_internal_symbols_from_R_dir() {
    let path: PathBuf = "/work/pkg/R/utils.R".into();
    let text: Arc<str> = "helper <- function() 1\n".into();
    let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
    inputs.r_files.insert(path.clone(), RFileInput {
        kind: RFileKind::Source,
        origin: ContentOrigin::Disk,
        text: text.clone(),
        content_digest: ContentDigest::of(&text),
    });
    let s = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
    assert!(s.scope_contribution.r_internal_symbols.contains("helper"));
}

#[test]
fn scope_contribution_excludes_test_file_symbols() {
    let test_path: PathBuf = "/work/pkg/tests/testthat/test-utils.R".into();
    let text: Arc<str> = "test_helper <- function() 1\n".into();
    let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
    inputs.r_files.insert(test_path, RFileInput {
        kind: RFileKind::Test,
        origin: ContentOrigin::Disk,
        text: text.clone(),
        content_digest: ContentDigest::of(&text),
    });
    let s = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
    assert!(!s.scope_contribution.r_internal_symbols.contains("test_helper"));
}

#[test]
fn scope_contribution_carries_imports_from_namespace() {
    let mut inputs = with_description(PackageMode::Auto, "Package: foo\n");
    inputs.namespace = Some(NamespaceInput {
        path: "/work/pkg/NAMESPACE".into(),
        text: "importFrom(dplyr, filter)\nimportFrom(stats, filter)\n".into(),
    });
    let s = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
    let pkgs = s.scope_contribution.imported_symbols.get("filter").unwrap();
    assert!(pkgs.contains("dplyr"));
    assert!(pkgs.contains("stats"));
}
```

- [ ] **Step 3: Run, commit**

Run: `cargo test -p raven --lib package_state`

```bash
git add crates/raven/src/package_state/derive.rs
git commit -m "feat(package-state): derive step 4 — scope contribution (Phase 2.9)"
```

### Task 2.10: Add proptest state machine for the safety property

**Files:**
- Create: `crates/raven/src/package_state/proptest_machine.rs`
- Modify: `crates/raven/Cargo.toml` (add `proptest`, `proptest-state-machine` if absent)

- [ ] **Step 1: Add dev-dependencies**

In `crates/raven/Cargo.toml` `[dev-dependencies]`:
```toml
proptest = "1"
```

(Skip `proptest-state-machine` if not in use; we'll write a hand-rolled state machine.)

- [ ] **Step 2: Write the proptest module**

Create `crates/raven/src/package_state/proptest_machine.rs`:

```rust
//! Proptest verifying the safety property of `derive_package_state`:
//! diff-driven derivation must equal from-scratch derivation.

#![cfg(test)]

use super::*;
use proptest::prelude::*;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone, Debug)]
enum Mutation {
    SetRFile { path: PathBuf, kind: RFileKind, text: String },
    DeleteRFile { path: PathBuf },
    SetNamespace { text: String },
    SetDescription { text: String },
    SetMode { mode: PackageMode },
}

fn arb_path() -> impl Strategy<Value = (PathBuf, RFileKind)> {
    prop_oneof![
        ("[a-z]{1,4}").prop_map(|n| (PathBuf::from(format!("/work/pkg/R/{}.R", n)), RFileKind::Source)),
        ("[a-z]{1,4}").prop_map(|n| (PathBuf::from(format!("/work/pkg/tests/testthat/test-{}.R", n)), RFileKind::Test)),
    ]
}

fn arb_r_text() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("foo <- function() 1\n".to_string()),
        Just("#' @export\nbar <- function(x) x + 1\n".to_string()),
        Just("#' @importFrom dplyr filter\nbaz <- function() 0\n".to_string()),
        Just("# empty\n".to_string()),
    ]
}

fn arb_mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        (arb_path(), arb_r_text()).prop_map(|((path, kind), text)| {
            Mutation::SetRFile { path, kind, text }
        }),
        arb_path().prop_map(|(path, _)| Mutation::DeleteRFile { path }),
        prop_oneof![
            Just("import(magrittr)\n".to_string()),
            Just("importFrom(dplyr, filter)\n".to_string()),
            Just("".to_string()),
        ].prop_map(|text| Mutation::SetNamespace { text }),
        prop_oneof![
            Just("Package: foo\n".to_string()),
            Just("Package: bar\n".to_string()),
            Just("# no package\n".to_string()),
        ].prop_map(|text| Mutation::SetDescription { text }),
        prop_oneof![
            Just(PackageMode::Auto),
            Just(PackageMode::Enabled),
            Just(PackageMode::Disabled),
        ].prop_map(|mode| Mutation::SetMode { mode }),
    ]
}

fn apply(inputs: &mut PackageInputs, mutation: &Mutation) -> PackageInputDelta {
    match mutation {
        Mutation::SetRFile { path, kind, text } => {
            let arc: Arc<str> = text.as_str().into();
            inputs.r_files.insert(path.clone(), RFileInput {
                kind: *kind,
                origin: ContentOrigin::Disk,
                text: arc.clone(),
                content_digest: ContentDigest::of(&arc),
            });
            PackageInputDelta::RFileChanged { path: path.clone(), kind: *kind }
        }
        Mutation::DeleteRFile { path } => {
            if let Some(prev) = inputs.r_files.remove(path) {
                PackageInputDelta::RFileDeleted { path: path.clone(), kind: prev.kind }
            } else {
                // No-op delete; emit an Initial as a harmless advisory
                PackageInputDelta::Initial
            }
        }
        Mutation::SetNamespace { text } => {
            inputs.namespace = if text.is_empty() {
                None
            } else {
                Some(NamespaceInput {
                    path: "/work/pkg/NAMESPACE".into(),
                    text: text.as_str().into(),
                })
            };
            PackageInputDelta::NamespaceChanged
        }
        Mutation::SetDescription { text } => {
            inputs.description = Some(DescriptionInput {
                path: "/work/pkg/DESCRIPTION".into(),
                text: text.as_str().into(),
            });
            PackageInputDelta::DescriptionChanged
        }
        Mutation::SetMode { mode } => {
            inputs.package_mode = *mode;
            PackageInputDelta::SettingChanged
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, .. ProptestConfig::default() })]

    #[test]
    fn diff_driven_equals_recompute(mutations in proptest::collection::vec(arb_mutation(), 1..16)) {
        let mut inputs = PackageInputs {
            workspace_root: Some("/work/pkg".into()),
            package_mode: PackageMode::Auto,
            description: Some(DescriptionInput {
                path: "/work/pkg/DESCRIPTION".into(),
                text: "Package: foo\n".into(),
            }),
            namespace: None,
            r_files: BTreeMap::new(),
        };

        let mut state = PackageState::default();
        for m in &mutations {
            let delta = apply(&mut inputs, m);
            state = derive_package_state(&state, &inputs, &delta);
        }

        let from_scratch = derive_package_state(
            &PackageState::default(),
            &inputs,
            &PackageInputDelta::Initial,
        );

        // Compare only the derived fields (workspace, namespace_model,
        // r_file_facts, scope_contribution). Phase-1 legacy fields are not
        // populated by derive yet.
        prop_assert_eq!(state.workspace, from_scratch.workspace);
        prop_assert_eq!(state.namespace_model, from_scratch.namespace_model);
        prop_assert_eq!(state.r_file_facts, from_scratch.r_file_facts);
        prop_assert_eq!(state.scope_contribution, from_scratch.scope_contribution);
    }

    #[test]
    fn advisory_delta_does_not_affect_correctness(mutations in proptest::collection::vec(arb_mutation(), 1..8)) {
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some("/work/pkg".into());
        inputs.package_mode = PackageMode::Auto;
        inputs.description = Some(DescriptionInput {
            path: "/work/pkg/DESCRIPTION".into(),
            text: "Package: foo\n".into(),
        });

        let mut s_correct_delta = PackageState::default();
        let mut s_wrong_delta = PackageState::default();
        for m in &mutations {
            let delta = apply(&mut inputs.clone(), m);
            let _ = apply(&mut inputs, m);
            s_correct_delta = derive_package_state(&s_correct_delta, &inputs, &delta);
            s_wrong_delta = derive_package_state(&s_wrong_delta, &inputs, &PackageInputDelta::Initial);
        }
        prop_assert_eq!(s_correct_delta.r_file_facts, s_wrong_delta.r_file_facts);
        prop_assert_eq!(s_correct_delta.scope_contribution, s_wrong_delta.scope_contribution);
    }
}
```

In `crates/raven/src/package_state.rs`, add:
```rust
#[cfg(test)]
mod proptest_machine;
```

- [ ] **Step 3: Run proptest**

Run: `cargo test -p raven --lib package_state::proptest_machine -- --nocapture`
Expected: all properties hold.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/package_state/ crates/raven/Cargo.toml
git commit -m "test(package-state): add proptest state machine for safety property (Phase 2.10)"
```

### Task 2.11: Add `derive_package_state` benchmark

**Files:**
- Modify: `crates/raven/tests/performance_budgets.rs`

- [ ] **Step 1: Add a benchmark scenario**

Add a test that constructs a synthetic 500-file workspace, calls `derive_package_state` with a single-file delta, and asserts the elapsed time is below the budget.

```rust
#[test]
fn derive_package_state_500_file_keystroke_budget() {
    use raven::package_state::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Instant;

    let root: PathBuf = "/work/pkg".into();
    let mut inputs = PackageInputs {
        workspace_root: Some(root.clone()),
        package_mode: raven::cross_file::config::PackageMode::Auto,
        description: Some(DescriptionInput {
            path: root.join("DESCRIPTION"),
            text: "Package: foo\n".into(),
        }),
        namespace: None,
        r_files: BTreeMap::new(),
    };
    for i in 0..500 {
        let p = root.join("R").join(format!("file_{}.R", i));
        let text: Arc<str> = format!("fn_{} <- function() {}\n", i, i).into();
        inputs.r_files.insert(p, RFileInput {
            kind: RFileKind::Source,
            origin: ContentOrigin::Disk,
            text: text.clone(),
            content_digest: ContentDigest::of(&text),
        });
    }
    let s0 = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);

    // Single-file delta: change file_42
    let p = root.join("R").join("file_42.R");
    let new_text: Arc<str> = "fn_42 <- function() 99\n".into();
    inputs.r_files.insert(p.clone(), RFileInput {
        kind: RFileKind::Source,
        origin: ContentOrigin::Disk,
        text: new_text.clone(),
        content_digest: ContentDigest::of(&new_text),
    });

    let mut times = Vec::with_capacity(20);
    for _ in 0..20 {
        let start = Instant::now();
        let _s = derive_package_state(&s0, &inputs, &PackageInputDelta::RFileChanged {
            path: p.clone(),
            kind: RFileKind::Source,
        });
        times.push(start.elapsed());
    }
    times.sort();
    let median = times[times.len() / 2];
    let p99 = times[(times.len() * 99 / 100).min(times.len() - 1)];
    eprintln!("derive_package_state 500-file: median={:?} p99={:?}", median, p99);
    assert!(median.as_millis() < 5, "median {} >= 5ms budget", median.as_millis());
    assert!(p99.as_millis() < 20, "p99 {} >= 20ms budget", p99.as_millis());
}
```

- [ ] **Step 2: Run benchmark**

Run: `cargo test -p raven --test performance_budgets derive_package_state_500_file_keystroke_budget -- --nocapture`
Expected: passes; eprintln shows real timings.

If it fails the budget, drop to the pre-approved mitigation (a) in spec §6.3 (memoize merge by input-set fingerprint). Implement that, re-run, commit both together.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/tests/performance_budgets.rs
git commit -m "perf(package-state): add 500-file derive_package_state benchmark with budget (Phase 2.11)"
```

### Task 2.12: Add parity test scaffolding

**Files:**
- Create: `crates/raven/src/package_state/parity_tests.rs` (gated `#[cfg(test)]`)

- [ ] **Step 1: Write parity tests covering each existing handler scenario**

For each scenario currently exercised by handler-driven `rebuild_*` calls — e.g. "did_change adds @export to one file", "did_close removes file", "DESCRIPTION created" — write a test that:
1. Builds inputs and calls `derive_package_state` with the appropriate delta.
2. Builds the equivalent `WorldState` and runs the legacy `rebuild_*` path.
3. Asserts the resulting `PackageNamespaceModel`, `internal_symbols_cache`, and `workspace_imports` are equal.

Sample:
```rust
#[cfg(test)]
mod parity_tests {
    use super::*;
    // ... helper builders ...

    #[test]
    fn parity_did_change_adds_export() {
        // Legacy path
        let mut state = make_world_state_with_one_open_file("foo.R", "");
        state.rebuild_namespace_model_from_cache();
        let legacy_imports = state.workspace_imports().clone();

        // New path
        let inputs = inputs_from_world_state(&state);
        let new_state = derive_package_state(&PackageState::default(), &inputs, &PackageInputDelta::Initial);
        // Build equivalent imports list from new_state.scope_contribution.imported_symbols
        let new_imports = flatten_imported_symbols(&new_state.scope_contribution);

        assert_eq!(*legacy_imports, new_imports);
    }
}
```

(The exact list of scenarios is bounded by the 17 fix commits — each commit names a handler scenario. Cover at least: did_change with @export added, with @import added, with @importFrom added; did_close after edit; did_change_watched_files for DESCRIPTION/NAMESPACE; settings change auto→enabled→disabled→auto.)

This is exploratory work — expect to discover places where the legacy and new paths *don't* agree. When that happens, document it as a parity-test failure in the commit message. Investigate: is the legacy result wrong, or is `derive` wrong? Most likely the legacy result is "uncomputed in a corner case the bug commits hadn't reached" — that's a feature, not a bug, of the new design.

- [ ] **Step 2: Run parity tests**

Run: `cargo test -p raven --lib package_state::parity_tests`
Expected: green. If any fail, investigate per the note above.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/package_state/parity_tests.rs
git commit -m "test(package-state): parity tests vs legacy rebuild_ paths (Phase 2.12)"
```

### Task 2.13: Phase 2 verification

- [ ] **Step 1: Full test suite**

Run: `cargo test -p raven`
Expected: all green.

- [ ] **Step 2: Property tests N=256**

Run: `PROPTEST_CASES=256 cargo test -p raven --lib package_state::proptest_machine`
Expected: green at higher case count (verify the property is robust).

- [ ] **Step 3: Phase 2 milestone commit**

```bash
git commit --allow-empty -m "test(package-state): Phase 2 complete — derive function with parity + properties"
```

---

## Phase 3 — Switch handlers to deltas (matrix collapse)

**Phase goal:** Each LSP handler computes a `PackageInputDelta` from its event, updates `WorldState.package_inputs`, and calls `derive_package_state`. Legacy `rebuild_*` methods are deleted. The (event × cache) matrix is gone.

### Task 3.1: Add `package_inputs` field to `WorldState`

**Files:**
- Modify: `crates/raven/src/state.rs`

- [ ] **Step 1: Add the field**

```rust
pub struct WorldState {
    // ...
    pub package_state: crate::package_state::PackageState,
    pub package_inputs: crate::package_state::PackageInputs,  // NEW
    // ...
}
```

Initializer: `package_inputs: crate::package_state::PackageInputs::default(),`.

- [ ] **Step 2: Add a thin "apply event" method**

```rust
impl WorldState {
    /// Apply a `PackageInputDelta` produced by an event handler:
    /// 1) Inputs were already mutated by the caller.
    /// 2) Recompute `package_state` from `package_inputs`.
    pub fn apply_package_event(&mut self, delta: &crate::package_state::PackageInputDelta) {
        let new_state = crate::package_state::derive_package_state(
            &self.package_state,
            &self.package_inputs,
            delta,
        );
        self.package_state = new_state;
    }
}
```

- [ ] **Step 3: Verify and commit**

Run: `cargo check -p raven`

```bash
git add crates/raven/src/state.rs
git commit -m "feat(state): add package_inputs field and apply_package_event method (Phase 3.1)"
```

### Task 3.2: Add the event-translation helper module

**Files:**
- Create: `crates/raven/src/package_state/event.rs`
- Modify: `crates/raven/src/package_state.rs` (re-export)

- [ ] **Step 1: Write the event translation helper**

```rust
//! Translation from LSP events to `PackageInputDelta` + input mutations.

use super::*;
use std::path::Path;

pub enum HandlerEvent {
    DidOpen { uri: lsp_types::Url, version: i32, text: Arc<str> },
    DidChange { uri: lsp_types::Url, version: i32, text: Arc<str> },
    DidClose { uri: lsp_types::Url, on_disk_text: Option<Arc<str>> },
    WatchedFileChanged { uri: lsp_types::Url, on_disk_text: Option<Arc<str>>, deleted: bool },
    SettingChanged { new_mode: crate::cross_file::config::PackageMode },
    WorkspaceScanCompleted { /* TBD: contents from scan_workspace */ },
    Initial,
}

pub fn translate(
    inputs: &mut PackageInputs,
    event: HandlerEvent,
) -> Option<PackageInputDelta> {
    let Some(root) = inputs.workspace_root.clone() else { return None };
    match event {
        HandlerEvent::DidOpen { uri, version, text } | HandlerEvent::DidChange { uri, version, text } => {
            let path = uri.to_file_path().ok()?;
            let kind = is_r_source_path(&path, &root)?;
            let digest = ContentDigest::of(&text);
            inputs.r_files.insert(path.clone(), RFileInput {
                kind,
                origin: ContentOrigin::Open { version },
                text,
                content_digest: digest,
            });
            Some(PackageInputDelta::RFileChanged { path, kind })
        }
        HandlerEvent::DidClose { uri, on_disk_text } => {
            let path = uri.to_file_path().ok()?;
            let kind = is_r_source_path(&path, &root)?;
            match on_disk_text {
                Some(text) => {
                    let digest = ContentDigest::of(&text);
                    inputs.r_files.insert(path.clone(), RFileInput {
                        kind,
                        origin: ContentOrigin::Disk,
                        text,
                        content_digest: digest,
                    });
                    Some(PackageInputDelta::RFileChanged { path, kind })
                }
                None => {
                    inputs.r_files.remove(&path);
                    Some(PackageInputDelta::RFileDeleted { path, kind })
                }
            }
        }
        HandlerEvent::WatchedFileChanged { uri, on_disk_text, deleted } => {
            let path = uri.to_file_path().ok()?;
            // DESCRIPTION
            if path == root.join("DESCRIPTION") {
                inputs.description = on_disk_text.map(|t| DescriptionInput { path: path.clone(), text: t });
                return Some(PackageInputDelta::DescriptionChanged);
            }
            // NAMESPACE
            if path == root.join("NAMESPACE") {
                inputs.namespace = on_disk_text.map(|t| NamespaceInput { path: path.clone(), text: t });
                return Some(PackageInputDelta::NamespaceChanged);
            }
            // R/tests file
            if let Some(kind) = is_r_source_path(&path, &root) {
                if deleted {
                    inputs.r_files.remove(&path);
                    return Some(PackageInputDelta::RFileDeleted { path, kind });
                }
                if let Some(text) = on_disk_text {
                    let digest = ContentDigest::of(&text);
                    inputs.r_files.insert(path.clone(), RFileInput {
                        kind,
                        origin: ContentOrigin::Disk,
                        text,
                        content_digest: digest,
                    });
                    return Some(PackageInputDelta::RFileChanged { path, kind });
                }
            }
            None
        }
        HandlerEvent::SettingChanged { new_mode } => {
            inputs.package_mode = new_mode;
            Some(PackageInputDelta::SettingChanged)
        }
        HandlerEvent::WorkspaceScanCompleted { .. } => {
            // Caller mutates inputs in batch; just emit Initial.
            Some(PackageInputDelta::Initial)
        }
        HandlerEvent::Initial => Some(PackageInputDelta::Initial),
    }
}
```

- [ ] **Step 2: Add unit tests for translation**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn did_change_for_r_file_emits_rfile_changed() {
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some("/work/pkg".into());
        let uri = lsp_types::Url::from_file_path("/work/pkg/R/foo.R").unwrap();
        let delta = translate(&mut inputs, HandlerEvent::DidChange {
            uri, version: 1, text: "x <- 1\n".into(),
        });
        assert!(matches!(delta, Some(PackageInputDelta::RFileChanged { kind: RFileKind::Source, .. })));
        assert_eq!(inputs.r_files.len(), 1);
    }

    #[test]
    fn did_change_for_non_r_file_emits_no_delta() {
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some("/work/pkg".into());
        let uri = lsp_types::Url::from_file_path("/work/pkg/inst/data.R").unwrap();
        let delta = translate(&mut inputs, HandlerEvent::DidChange {
            uri, version: 1, text: "x <- 1\n".into(),
        });
        assert!(delta.is_none());
    }

    #[test]
    fn description_change_updates_inputs_and_emits_delta() {
        let mut inputs = PackageInputs::default();
        inputs.workspace_root = Some("/work/pkg".into());
        let uri = lsp_types::Url::from_file_path("/work/pkg/DESCRIPTION").unwrap();
        let delta = translate(&mut inputs, HandlerEvent::WatchedFileChanged {
            uri, on_disk_text: Some("Package: foo\n".into()), deleted: false,
        });
        assert!(matches!(delta, Some(PackageInputDelta::DescriptionChanged)));
        assert!(inputs.description.is_some());
    }
}
```

- [ ] **Step 3: Run, commit**

Run: `cargo test -p raven --lib package_state::event`

```bash
git add crates/raven/src/package_state/event.rs crates/raven/src/package_state.rs
git commit -m "feat(package-state): event translation helper (Phase 3.2)"
```

### Task 3.3: Switch `did_change` to event-driven

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_change` handler)

- [ ] **Step 1: Find and replace the package-mode rebuild block in did_change**

In `crates/raven/src/backend.rs` `did_change` (find via `rg -n 'fn did_change' crates/raven/src/backend.rs`), locate the block that calls `rebuild_namespace_model_from_cache` / `rebuild_package_internal_symbols_cache` / updates `roxygen_tags_cache` directly. Replace it with:

```rust
// Compute package input delta and re-derive
let event = crate::package_state::event::HandlerEvent::DidChange {
    uri: uri.clone(),
    version: params.text_document.version,
    text: text.clone(),  // Arc<str> already in scope
};
if let Some(delta) = crate::package_state::event::translate(&mut state.package_inputs, event) {
    state.apply_package_event(&delta);
}
```

(`state` here is the mutable `WorldState` lock guard. `text` is the post-change text, already an `Arc<str>` from `DocumentStore`.)

- [ ] **Step 2: Run package-mode tests**

Run: `cargo test -p raven --lib state_tests`
Expected: green.

Run: `cargo test -p raven`
Expected: green.

If any tests fail, the legacy and new paths disagree on a scenario. Investigate per the parity-test playbook in Task 2.12.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "refactor(backend): did_change uses event-driven package state (Phase 3.3)"
```

### Task 3.4: Switch `did_open` to event-driven

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_open` handler)

- [ ] **Step 1: Replace the package-mode block in did_open**

Same pattern as Task 3.3 but with `HandlerEvent::DidOpen { uri, version: params.text_document.version, text }`.

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/backend.rs
git commit -m "refactor(backend): did_open uses event-driven package state (Phase 3.4)"
```

### Task 3.5: Switch `did_close` to event-driven

**Files:**
- Modify: `crates/raven/src/backend.rs`

- [ ] **Step 1: Replace the did_close block**

In `did_close`, before/after the existing per-event work, read on-disk text:
```rust
let path = uri.to_file_path().ok();
let on_disk_text: Option<Arc<str>> = match &path {
    Some(p) => tokio::task::spawn_blocking({
        let p = p.clone();
        move || std::fs::read_to_string(&p).ok().map(Arc::<str>::from)
    }).await.ok().flatten(),
    None => None,
};
let event = crate::package_state::event::HandlerEvent::DidClose { uri: uri.clone(), on_disk_text };
{
    let mut state = self.state.write().await;
    if let Some(delta) = crate::package_state::event::translate(&mut state.package_inputs, event) {
        state.apply_package_event(&delta);
    }
}
```

(Adapt to actual lock acquisition pattern.)

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/backend.rs
git commit -m "refactor(backend): did_close uses event-driven package state (Phase 3.5)"
```

### Task 3.6: Switch `did_change_watched_files` to event-driven

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_change_watched_files`, around line 3573, 3897)

- [ ] **Step 1: Replace the file-by-file rebuild loop**

For each watched-file event, classify the path and emit a `HandlerEvent::WatchedFileChanged`:
```rust
for change in params.changes {
    let uri = change.uri;
    let path = uri.to_file_path().ok();

    // Directory event handling: if path is a directory, recurse and emit Batch
    if let Some(p) = &path {
        if p.is_dir() {
            // TODO: walk subtree, emit RFileChanged/RFileDeleted for each R/test file
            continue; // skip for now; Task 3.7 covers
        }
    }

    let on_disk_text = if change.typ != FileChangeType::DELETED {
        if let Some(p) = &path {
            tokio::task::spawn_blocking({
                let p = p.clone();
                move || std::fs::read_to_string(&p).ok().map(Arc::<str>::from)
            }).await.ok().flatten()
        } else { None }
    } else { None };

    let deleted = change.typ == FileChangeType::DELETED;
    let event = crate::package_state::event::HandlerEvent::WatchedFileChanged {
        uri, on_disk_text, deleted,
    };
    {
        let mut state = self.state.write().await;
        if let Some(delta) = crate::package_state::event::translate(&mut state.package_inputs, event) {
            state.apply_package_event(&delta);
        }
    }
}
```

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/backend.rs
git commit -m "refactor(backend): did_change_watched_files uses event-driven package state (Phase 3.6)"
```

### Task 3.7: Add directory-event subtree walk

**Files:**
- Modify: `crates/raven/src/backend.rs`
- Modify: `crates/raven/src/package_state/event.rs`

- [ ] **Step 1: Add `HandlerEvent::DirectoryChanged` and translation**

Extend `HandlerEvent`:
```rust
DirectoryChanged { dir: PathBuf, file_iter: Vec<(PathBuf, Option<Arc<str>>)> },
```

Add translation to `Batch(...)` of per-file deltas using existing `is_r_source_path` filter.

- [ ] **Step 2: In `did_change_watched_files`, when path is a directory, walk it**

```rust
if let Some(p) = &path {
    if p.is_dir() {
        let mut file_iter = Vec::new();
        let walker = walkdir::WalkDir::new(p);
        for entry in walker.into_iter().flatten() {
            if entry.file_type().is_file() {
                let pb = entry.path().to_path_buf();
                let text = tokio::task::spawn_blocking({
                    let pb = pb.clone();
                    move || std::fs::read_to_string(&pb).ok().map(Arc::<str>::from)
                }).await.ok().flatten();
                file_iter.push((pb, text));
            }
        }
        let event = HandlerEvent::DirectoryChanged { dir: p.clone(), file_iter };
        // dispatch event same as for individual files
        // ...
        continue;
    }
}
```

(Add `walkdir` to dev/dep if not present.)

- [ ] **Step 3: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/backend.rs crates/raven/src/package_state/event.rs crates/raven/Cargo.toml
git commit -m "refactor(backend): handle directory events with subtree walk (Phase 3.7)"
```

### Task 3.8: Switch `did_change_configuration` packageMode change

**Files:**
- Modify: `crates/raven/src/backend.rs` (`did_change_configuration`)

- [ ] **Step 1: After parsing the new config, emit SettingChanged**

```rust
if old_mode != new_mode {
    let event = crate::package_state::event::HandlerEvent::SettingChanged { new_mode };
    if let Some(delta) = crate::package_state::event::translate(&mut state.package_inputs, event) {
        state.apply_package_event(&delta);
    }
}
```

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/backend.rs
git commit -m "refactor(backend): did_change_configuration uses event-driven package state (Phase 3.8)"
```

### Task 3.9: Wire `WorkspaceScanCompleted` event

**Files:**
- Modify: `crates/raven/src/backend.rs` (around line 1265–1365)

- [ ] **Step 1: After scan completes, populate inputs in batch and emit Initial**

In the workspace-scan completion block (where today the code calls `apply_workspace_index`, `rebuild_namespace_model_from_cache`, `rebuild_package_internal_symbols_cache`), replace with:

```rust
{
    let mut state = state_clone.write().await;

    // Populate package_inputs from scan results
    if let Some(root) = state.workspace_folders.first().and_then(|u| u.to_file_path().ok()) {
        state.package_inputs.workspace_root = Some(root.clone());
        state.package_inputs.package_mode = state.cross_file_config.package_mode;
        // DESCRIPTION
        let desc_path = root.join("DESCRIPTION");
        state.package_inputs.description = std::fs::read_to_string(&desc_path).ok().map(|t| {
            DescriptionInput { path: desc_path, text: t.into() }
        });
        // NAMESPACE
        let ns_path = root.join("NAMESPACE");
        state.package_inputs.namespace = std::fs::read_to_string(&ns_path).ok().map(|t| {
            NamespaceInput { path: ns_path, text: t.into() }
        });
        // R/ and tests/testthat/ files from `roxygen_cache` (which has on-disk content)
        for (path, _ns) in roxygen_cache.iter() {
            // Need text. If scan results don't include text, read it here under spawn_blocking.
            // (Adjust based on what scan_workspace returns.)
            // For each scanned R or test file:
            // state.package_inputs.r_files.insert(path.clone(), RFileInput { ... });
        }
        // For each open document under R/ or tests/testthat/, override the disk entry with Open
        // ... iterate state.documents ...
    }

    state.apply_package_event(&PackageInputDelta::Initial);

    // Continue with existing force-republish flow
    let open_keys: Vec<Url> = state.documents.keys().cloned().collect();
    state.diagnostics_gate.mark_force_republish_many(open_keys.iter());
    // ...
}
```

(The exact integration depends on the scan_workspace return signature. Adjust to thread the actual scanned content into `package_inputs.r_files`.)

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/backend.rs
git commit -m "refactor(backend): WorkspaceScanCompleted populates package_inputs and re-derives (Phase 3.9)"
```

### Task 3.10: Delete legacy `rebuild_*` methods

**Files:**
- Modify: `crates/raven/src/state.rs`
- Modify: `crates/raven/src/package_state.rs` (remove the methods we added in Phase 1.5/1.6)

- [ ] **Step 1: Find remaining callers**

Run: `rg -n 'rebuild_namespace_model_from_cache|rebuild_package_internal_symbols_cache' crates/raven/src/`
Expected: only the definitions remain (or only test code).

If any production callers remain, audit them — they should be using the event path now.

- [ ] **Step 2: Delete the methods**

Remove `rebuild_namespace_model_from_cache` and `rebuild_package_internal_symbols_cache` from both `WorldState` and `PackageState`. Remove related helpers if dead.

- [ ] **Step 3: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/state.rs crates/raven/src/package_state.rs
git commit -m "refactor(package-state): delete legacy rebuild methods (matrix collapse) (Phase 3.10)"
```

### Task 3.11: Delete parity tests

**Files:**
- Delete: `crates/raven/src/package_state/parity_tests.rs`
- Modify: `crates/raven/src/package_state.rs` (remove module decl)

- [ ] **Step 1: Delete and update**

Once the legacy paths are gone, parity tests have nothing to compare against. Delete the file and the `#[cfg(test)] mod parity_tests;` line.

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/package_state/ crates/raven/src/package_state.rs
git commit -m "test(package-state): remove parity tests after legacy paths deleted (Phase 3.11)"
```

### Task 3.12: Phase 3 verification

- [ ] **Step 1: Full test suite**

Run: `cargo test -p raven`
Expected: green.

- [ ] **Step 2: Property tests at high N**

Run: `PROPTEST_CASES=512 cargo test -p raven --lib package_state::proptest_machine`
Expected: green.

- [ ] **Step 3: VS Code smoke**

Open a package workspace; edit, save, close, run package operations. No regressions in user-visible behavior.

- [ ] **Step 4: Phase 3 milestone**

```bash
git commit --allow-empty -m "refactor(package-state): Phase 3 complete — handlers event-driven, matrix collapsed"
```

---

## Phase 4 — Wire scope injection

**Phase goal:** Extend the `cross_file/scope.rs` engine to consume `Option<&PackageScopeContribution>` and thread the contribution from `WorldState.package_state.scope_contribution` through every scope call site. Hover, signature help, and completion start working uniformly for package-internal symbols. Suppression set still in place (parallel paths).

### Task 4.1: Extend `scope_at_position_with_graph` signature

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs`

- [ ] **Step 1: Add the parameter**

Find `pub fn scope_at_position_with_graph<F, G>(...)` at line ~2877. Add `package_contribution: Option<&PackageScopeContribution>` to its parameter list.

Inside the function, when symbol resolution falls through standard scope resolution and the file is under `R/` or `tests/testthat/`, consult the contribution to recognize package-internal and imported symbols.

```rust
pub fn scope_at_position_with_graph<F, G>(
    // ... existing params ...
    package_contribution: Option<&crate::package_state::PackageScopeContribution>,
) -> ScopeAtPosition
where /* ... */
{
    // ... existing body ...
    // After standard resolution, augment the symbol set with package contribution
    // (when the URI is under R/ or tests/testthat/).
    if let Some(contrib) = package_contribution {
        // The augmentation point: where we accumulate `is_visible` results,
        // also check `contrib.r_internal_symbols`, `contrib.imported_symbols`,
        // `contrib.full_imports` (consulting the package library for exports).
        // ...
    }
    // return result
}
```

- [ ] **Step 2: Update all callers (compile errors will guide you)**

Run: `cargo check -p raven`
Expected: compile errors at every call site.

For each call site (per the migration checklist in spec §8.2), pass `None` for `package_contribution` initially. Iterate until clean.

- [ ] **Step 3: Verify and commit**

Run: `cargo test -p raven`
Expected: green (passing `None` is a no-op behaviorally).

```bash
git add crates/raven/src/
git commit -m "refactor(scope): add package_contribution parameter to scope_at_position_with_graph (Phase 4.1)"
```

### Task 4.2: Same for `scope_at_position_with_graph_cached` and `_recursive`

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs`

- [ ] **Step 1: Add parameter to both functions**

Same change as 4.1, applied to:
- `scope_at_position_with_graph_cached` (line ~2974)
- `scope_at_position_with_graph_recursive` (line ~3457)
- `ScopeStream` if it caches the package contribution

- [ ] **Step 2: Update callers (pass None)**

Run: `cargo check -p raven`
Iterate to clean.

- [ ] **Step 3: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/
git commit -m "refactor(scope): thread package_contribution through cached/recursive variants (Phase 4.2)"
```

### Task 4.3: Implement scope-resolution lookup against `PackageScopeContribution`

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs`

- [ ] **Step 1: Write failing integration test**

In `crates/raven/tests/`, add a test that:
1. Sets up a synthetic package workspace with `R/utils.R` defining `helper()` and `R/main.R` calling `helper()`.
2. Triggers diagnostics on `R/main.R`.
3. Asserts no "undefined variable: helper" diagnostic.
4. Calls hover on `helper()` in `R/main.R` and asserts hover content includes the definition from `R/utils.R`.

This test exists today via the suppression path — likely passes for diagnostic, fails for hover (since hover doesn't consult the suppression set). Confirm baseline.

- [ ] **Step 2: Implement contribution-driven resolution in `scope_at_position_with_graph_recursive`**

When iterating the symbol-resolution stack, if a symbol `name` is not found:
- If `package_contribution.r_internal_symbols.contains(name)`, mark as defined (provenance: package-internal). Pick the file in `r_file_facts` whose `top_level_defs` contains `name` and use its URI as the definition site.
- Else if `package_contribution.imported_symbols.contains_key(name)`, mark as defined (provenance: first source pkg from BTreeSet).
- Else iterate `package_contribution.full_imports` and consult `WorldState.package_library` (passed via closure as today's `with_packages` API does).

- [ ] **Step 3: Verify hover test passes**

Run: `cargo test -p raven --test <integration_test>`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/cross_file/scope.rs crates/raven/tests/
git commit -m "feat(scope): resolve package-internal and imported symbols via contribution (Phase 4.3)"
```

### Task 4.4: Wire contribution at each call site

**Files:**
- Modify: per the spec §8.2 migration checklist:
  - `crates/raven/src/handlers.rs` lines 313, 3012, 3058, 4578
  - `crates/raven/src/backend.rs` lines 2348, 2932, 5328, 5682, 7628
  - `crates/raven/src/parameter_resolver.rs:774`
  - `crates/raven/src/content_provider.rs:2255`
  - `crates/raven/src/qualified_resolve.rs:470, 822, 1533, 1627`

- [ ] **Step 1: Replace `None` with actual contribution at every site**

At each call, change:
```rust
scope::scope_at_position_with_graph(/* ... */, None)
```
to:
```rust
let contrib = state.package_state.scope_contribution.clone();
scope::scope_at_position_with_graph(/* ... */, Some(&contrib))
```

(For sites that don't have `state` in scope, plumb it through. Some require restructuring.)

- [ ] **Step 2: Verify**

Run: `cargo test -p raven`
Expected: green; package-internal hover/signature now work.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/
git commit -m "refactor: pass package_state.scope_contribution to all scope call sites (Phase 4.4)"
```

### Task 4.5: Add hover/signature integration tests

**Files:**
- Modify: `crates/raven/tests/cross_file_scope.rs` (or appropriate integration test file)

- [ ] **Step 1: Add tests for hover on package-internal symbol**

```rust
#[test]
fn hover_on_package_internal_symbol() {
    // Set up workspace with R/utils.R: helper <- function(x) x + 1
    // and R/main.R: result <- helper(2)
    // Send LSP hover request on `helper` in R/main.R
    // Assert: response includes the definition from R/utils.R
}

#[test]
fn signature_help_on_package_internal_symbol() {
    // Same setup; signature help on helper(|)
    // Assert: signature shows `function(x)`
}
```

- [ ] **Step 2: Run, fix, commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/tests/
git commit -m "test: add hover/signature integration tests for package-internal symbols (Phase 4.5)"
```

### Task 4.6: Phase 4 verification

- [ ] **Step 1: Full test suite + integration tests**

Run: `cargo test -p raven --tests`
Expected: green.

- [ ] **Step 2: Smoke test in VS Code**

Open package workspace. Verify:
- Hover on internal function works.
- Signature help on internal function shows arg list.
- Completion suggests internal function names.
- No regression on cross-file references that were working before.

- [ ] **Step 3: Phase 4 milestone**

```bash
git commit --allow-empty -m "feat(scope): Phase 4 complete — package contribution wired through scope engine"
```

---

## Phase 5 — Drop suppression-set path

**Phase goal:** Delete the parallel diagnostic-suppression code path now that scope injection covers the same cases. Includes a documented behavior change for non-package workspaces with stray NAMESPACE files (per spec §11.1).

### Task 5.1: Remove `package_internal_symbols` and `package_full_imports` from `DiagnosticsSnapshot`

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Delete fields**

In `DiagnosticsSnapshot` (around line 101), remove:
- `pub(crate) package_internal_symbols: Arc<HashSet<String>>,`
- `pub(crate) package_full_imports: Vec<String>,`

- [ ] **Step 2: Remove their initialization in `DiagnosticsSnapshot::build`**

Around line 272–273. Remove the lines that build `package_internal_symbols` and `package_full_imports`.

- [ ] **Step 3: Remove consumers in the diagnostic loop**

Find every read of `snapshot.package_internal_symbols` and `snapshot.package_full_imports` (around lines 5245, 5322, 5345). Each was a fallback to allow the symbol; the scope engine now handles this. Delete the conditional branches.

- [ ] **Step 4: Verify and commit**

Run: `cargo test -p raven`
Expected: green (scope path covers all cases).

```bash
git add crates/raven/src/handlers.rs
git commit -m "refactor(handlers): remove suppression-set fields from DiagnosticsSnapshot (Phase 5.1)"
```

### Task 5.2: Remove `workspace_imports` field on `DiagnosticsSnapshot`

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Delete `pub workspace_imports` from snapshot, its initialization, and its consumers**

Around lines 101, 251–260, 5085, 5213. The `workspace_imports_map` precompute disappears; the lookup becomes scope-engine resolution.

- [ ] **Step 2: Verify and commit**

Run: `cargo test -p raven`
```bash
git add crates/raven/src/handlers.rs
git commit -m "refactor(handlers): remove workspace_imports from DiagnosticsSnapshot (Phase 5.2)"
```

### Task 5.3: Add behavior-change test for non-package NAMESPACE

**Files:**
- Modify: `crates/raven/tests/` (new test or existing integration test file)

- [ ] **Step 1: Write the test**

```rust
#[test]
fn non_package_workspace_with_namespace_does_not_suppress_diagnostics() {
    // Set up workspace with NAMESPACE but no DESCRIPTION
    // Source: x <- importFrom_thing()
    // Expect: undefined variable diagnostic (NOT suppressed)
    // This is the documented Phase 5 behavior change (spec §11.1).
}
```

- [ ] **Step 2: Run, commit**

Run: `cargo test -p raven --tests`
Expected: green (behavior change is now codified).

```bash
git add crates/raven/tests/
git commit -m "test: codify Phase 5 non-package NAMESPACE behavior change (Phase 5.3)"
```

### Task 5.4: Delete `WorldState::workspace_imports` accessor and `PackageState::workspace_imports` field

**Files:**
- Modify: `crates/raven/src/state.rs`
- Modify: `crates/raven/src/package_state.rs`

- [ ] **Step 1: Delete the field and accessor**

In `PackageState`, remove `pub workspace_imports: Arc<Vec<(String, String)>>,`.
In `WorldState`, remove the `workspace_imports()` accessor.

- [ ] **Step 2: Verify**

Run: `cargo check -p raven`
Expected: any leftover reads will fail compile — fix them by reading from `package_state.scope_contribution.imported_symbols` instead. By Task 5.2 these should already be gone.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/
git commit -m "refactor(state): delete workspace_imports field (Phase 5.4)"
```

### Task 5.5: Delete the package-mode completion block in handlers.rs:9366

**Files:**
- Modify: `crates/raven/src/handlers.rs`

- [ ] **Step 1: Find and delete**

Around line 9366, the package-mode completion block iterates `package_internal_symbols_cache` to add internal symbols to completion. Since scope injection now provides these via the standard completion path, delete the block.

- [ ] **Step 2: Verify**

Run: `cargo test -p raven`
Manually test in VS Code: completion in `R/main.R` should still suggest `helper` from `R/utils.R`.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/handlers.rs
git commit -m "refactor(handlers): remove redundant package-mode completion block (Phase 5.5)"
```

### Task 5.6: Update `docs/r-package-dev.md` with Phase 5 behavior change

**Files:**
- Modify: `docs/r-package-dev.md`

- [ ] **Step 1: Add a "Behavior change" note**

Append to `## Known Limitations` or a new "Recent changes" section:

```markdown
### Behavior change: non-package NAMESPACE files no longer suppress diagnostics

Prior to this version, a workspace containing a `NAMESPACE` file but no `DESCRIPTION` would still have its `import()` and `importFrom()` directives parsed and used to suppress undefined-variable diagnostics. This was incidental — `import()` directives in a NAMESPACE without a corresponding `Package:` field have no meaning to R itself.

Now: package mode activates only when both `DESCRIPTION` (with a `Package:` field) and `NAMESPACE` are present. Non-package workspaces run as script mode regardless of `NAMESPACE` presence.

If you need this behavior, set `raven.packages.packageMode: "enabled"` to force package mode.
```

- [ ] **Step 2: Commit**

```bash
git add docs/r-package-dev.md
git commit -m "docs: note Phase 5 behavior change for non-package NAMESPACE (Phase 5.6)"
```

### Task 5.7: Phase 5 verification

- [ ] **Step 1: Full test suite**

Run: `cargo test -p raven`
Expected: green, including the new behavior-change test.

- [ ] **Step 2: Smoke**

In VS Code: open a non-package workspace with a stray NAMESPACE; confirm script-mode behavior. Open a real package; confirm package mode still works end-to-end.

- [ ] **Step 3: Phase 5 milestone**

```bash
git commit --allow-empty -m "refactor: Phase 5 complete — suppression path deleted, scope injection canonical"
```

---

## Phase 6 — Tests/testthat one-way visibility

**Phase goal:** Verify that test files (`tests/testthat/*.R`) get the package contribution applied via the scope engine. Add integration tests confirming one-way visibility.

### Task 6.1: Verify test-file scope contribution application

**Files:**
- Modify: `crates/raven/src/cross_file/scope.rs` (the augmentation point in 4.3)

- [ ] **Step 1: Confirm the predicate gates correctly**

In the scope engine's contribution-application code added in Task 4.3, ensure the gate is:
```rust
let path = uri.to_file_path().ok();
let workspace_root = state.package_state.workspace.as_ref().map(|w| w.root.clone());
let kind = path.zip(workspace_root.as_ref())
    .and_then(|(p, root)| crate::package_state::is_r_source_path(&p, root));
if matches!(kind, Some(RFileKind::Source) | Some(RFileKind::Test)) {
    // apply contribution
}
```

This was likely already done in 4.3 but explicitly confirm it covers Test kind. If it only checked R/ paths, expand here.

- [ ] **Step 2: Commit**

```bash
git add crates/raven/src/cross_file/scope.rs
git commit -m "feat(scope): tests/testthat files receive package contribution (Phase 6.1)"
```

### Task 6.2: Add integration test for tests/testthat → R/ visibility

**Files:**
- Modify: `crates/raven/tests/`

- [ ] **Step 1: Write the tests**

```rust
#[test]
fn testthat_file_sees_package_internal_symbols() {
    // Set up:
    //   /work/pkg/DESCRIPTION: Package: foo
    //   /work/pkg/R/utils.R: helper <- function() 1
    //   /work/pkg/tests/testthat/test-utils.R: result <- helper()
    // Assert: no "undefined variable: helper" diagnostic on the test file.
}

#[test]
fn package_R_file_does_not_see_test_symbols() {
    // Set up:
    //   /work/pkg/DESCRIPTION: Package: foo
    //   /work/pkg/R/main.R: result <- test_helper()
    //   /work/pkg/tests/testthat/test-utils.R: test_helper <- function() 1
    // Assert: "undefined variable: test_helper" diagnostic on R/main.R
    //         (test symbols don't leak into R/)
}

#[test]
fn testthat_file_sees_imported_symbols() {
    // Set up:
    //   /work/pkg/DESCRIPTION: Package: foo
    //   /work/pkg/NAMESPACE: importFrom(dplyr, filter)
    //   /work/pkg/tests/testthat/test-x.R: result <- filter(...)
    // Assert: no diagnostic for `filter` on the test file.
}
```

- [ ] **Step 2: Run**

Run: `cargo test -p raven --tests`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/tests/
git commit -m "test(package): tests/testthat one-way visibility into R/ (Phase 6.2)"
```

### Task 6.3: Update user-facing docs

**Files:**
- Modify: `docs/r-package-dev.md`

- [ ] **Step 1: Document the new behavior**

In `## What's Supported`, add:
```markdown
### Tests directory awareness

Files under `tests/testthat/` get one-way read access to package-internal symbols (R/*.R) and to symbols imported via NAMESPACE/roxygen. Tests can call internal package functions without "undefined variable" diagnostics. Symbols defined in test files are not visible from R/*.R.
```

- [ ] **Step 2: Commit**

```bash
git add docs/r-package-dev.md
git commit -m "docs(package): document tests/testthat one-way visibility (Phase 6.3)"
```

### Task 6.4: Phase 6 verification (final)

- [ ] **Step 1: Full test suite + integration**

Run: `cargo test -p raven`
Expected: green.

- [ ] **Step 2: Property tests at high N**

Run: `PROPTEST_CASES=1024 cargo test -p raven --lib package_state::proptest_machine`
Expected: green at high N.

- [ ] **Step 3: Final smoke in VS Code**

Walk through:
- Package workspace open and scan complete.
- Edit `R/utils.R`, save, see diagnostics in dependent files update.
- Hover an internal symbol — works.
- Hover an imported symbol — works.
- Open a `tests/testthat/test-foo.R` file — internal helpers are recognized.
- Edit DESCRIPTION's Package field — re-detects.
- Set `packageMode: "disabled"` — script-mode behavior.
- Re-enable — package mode reactivates.

- [ ] **Step 4: Final commit**

```bash
git commit --allow-empty -m "feat(package-state): refactor complete — all 6 phases landed"
```

---

## Self-review notes

**Spec coverage:**
- Aim 1 (always-merge): Phase 2.8 (merge namespace model) — **covered**
- Aim 2 (scope injection): Phase 4 — **covered**
- Aim 3a (R/-only predicate dedup): Phase 2.4 (`is_r_source_path`) — **covered**
- Aim 3b (tests/testthat one-way): Phase 6 — **covered**
- Aim 4 (input-delta architecture): Phase 2 + Phase 3 — **covered**
- Decision table for effective workspace (spec §6.1 step 1): Task 2.6 — **covered**
- Memoization with content digest (spec §5.2): Task 2.1 + Task 2.7 — **covered**
- `WorkspaceScanCompleted` internal event (spec §7.1): Task 3.9 — **covered**
- Directory event handling (spec §7): Task 3.7 — **covered**
- Migration checklist for scope call sites (spec §8.2): Task 4.4 — **covered**
- Phase 5 non-package behavior change (spec §11.1): Task 5.3 + 5.6 — **covered**
- Performance budget (spec §6.3): Task 2.11 — **covered**
- Property test state machine (spec §10.1.2): Task 2.10 — **covered**

**Type/method consistency check:**
- `derive_package_state(prev, inputs, delta)` — used consistently in 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 3.1, 3.9.
- `is_r_source_path(path, workspace_root) -> Option<RFileKind>` — used consistently in 2.4, 3.2, 6.1.
- `PackageScopeContribution { r_internal_symbols, imported_symbols, full_imports }` — fields match across 2.5, 2.9, 4.3, 4.4.
- `ContentDigest::of(text: &str) -> Self` — used consistently throughout.

**Placeholder scan:** Task 2.7 step 1 contains a `todo!()` for `extract_top_level_defs` because the existing extraction logic varies depending on what's already in the workspace_index. The agent must trace and resolve this — it's flagged inline rather than left as a silent gap. Task 3.9 has a "TODO" comment about reading scan results' text — this is also flagged inline.

**Out-of-order task readability:** Each task carries enough context (file paths, function names, expected commands, expected output) that an engineer reading any task in isolation can act. Where a task references an artifact from an earlier task (e.g., 4.4 references 4.3's predicate), the reference is by name plus a one-line restatement.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-r-package-mode-architecture-plan.md`.

The plan totals 6 phases × ~6 tasks = ~40 tasks, each ending in a small commit. Total estimated diff: ~1300 LoC net (Phase 3 is a large net deletion). The proptest property and the parity tests are the safety net — if either flips red, halt and investigate.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks. Best for a refactor of this size: each subagent comes in with the full plan, executes one task to a clean commit, and returns. Two-stage review catches drift.

**2. Inline Execution** — Run tasks in this session via executing-plans. Faster for small chunks; harder to recover from late-phase issues.
