# Libpath Watching + Missing-Package Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when R packages are installed, updated, or removed on disk and refresh diagnostics automatically, and ensure `library(foo)` emits a diagnostic when `foo` is not installed.

**Architecture:** A `notify`-crate-based file watcher sits on every `.libPaths()` directory. Raw events feed a debounced diff task that produces `LibpathEvent::Changed { added, removed, touched }`. A backend consumer task invalidates the relevant `PackageLibrary` cache entries and schedules diagnostic revalidation for open documents whose loaded packages intersect the change set. An LSP command `raven.refreshPackages` serves as the manual escape hatch. The existing `collect_missing_package_diagnostics` in `handlers.rs:4516` already implements missing-package warnings; we verify it with a new integration test and document the gating conditions.

**Tech Stack:** Rust, tokio, `notify` crate (new dep), tower-lsp, tree-sitter-r, TypeScript (VS Code extension).

**Spec:** `docs/superpowers/specs/2026-04-16-libpath-watch-design.md`

---

## File structure

### Created

- `crates/raven/src/libpath_watcher.rs` — `LibpathWatcher` struct, `LibpathEvent` enum, debounce/diff logic.
- `crates/raven/tests/libpath_watching.rs` — integration test for install-triggered diagnostic refresh.

### Modified

- `crates/raven/Cargo.toml` — add `notify` dep.
- `crates/raven/src/lib.rs` — `pub mod libpath_watcher;`.
- `crates/raven/src/package_library.rs` — `invalidate_many`, `invalidate_touching_meta`, `cached_package_names`.
- `crates/raven/src/state.rs` — `WorldState::libpath_watcher_handle: Option<Arc<LibpathWatcherHandle>>`.
- `crates/raven/src/backend.rs` — spawn watcher post-init (around line 1075); consumer task; settings-change teardown (around line 2400); `execute_command` handler for `raven.refreshPackages`; config parsing for two new fields.
- `crates/raven/src/cross_file/config.rs` — `packages_watch_library_paths: bool`, `packages_watch_debounce_ms: u64`.
- `editors/vscode/package.json` — two new settings; one new command.
- `editors/vscode/src/initializationOptions.ts` — forward new settings.
- `editors/vscode/src/extension.ts` — register `raven.refreshPackages` command.
- `editors/vscode/src/test/settings.test.ts` — test coverage for new settings.
- `docs/packages.md` — document `watchLibraryPaths`, `watchDebounceMs`, and the missing-package diagnostic gating.
- `CLAUDE.md` (`## Learnings`) — add any non-obvious pitfalls encountered.

---

## Task 1: Add `notify` dependency and declare module

**Files:**
- Modify: `crates/raven/Cargo.toml`
- Modify: `crates/raven/src/lib.rs`

- [ ] **Step 1: Add `notify` to dependencies**

Append to `[dependencies]` in `crates/raven/Cargo.toml`:

```toml
notify = { version = "6.1", default-features = false, features = ["macos_fsevent"] }
```

Rationale: `default-features = false` disables `crossbeam-channel` integration that pulls in unused runtime glue. On Linux and Windows, `notify` falls back to inotify/ReadDirectoryChangesW automatically; we only need to opt in explicitly for FSEvents on macOS.

- [ ] **Step 2: Declare the module**

Open `crates/raven/src/lib.rs` and add (preserving existing module order — alphabetic within the existing block):

```rust
pub mod libpath_watcher;
```

- [ ] **Step 3: Verify the crate still builds with the new dep**

Run:
```bash
cargo build -p raven
```
Expected: success (warning about unused `libpath_watcher` module is fine at this point — Task 2 fills it in).

- [ ] **Step 4: Commit**

```bash
git add crates/raven/Cargo.toml Cargo.lock crates/raven/src/lib.rs
git commit -m "feat(libpath): add notify dep and declare libpath_watcher module"
```

---

## Task 2: `LibpathEvent` enum and empty `LibpathWatcher` skeleton

**Files:**
- Create: `crates/raven/src/libpath_watcher.rs`

- [ ] **Step 1: Write the failing test for the event shape**

Create `crates/raven/src/libpath_watcher.rs` with only this content to start:

```rust
//! Filesystem watcher for R library paths.
//!
//! Watches one or more `.libPaths()` directories with the `notify` crate,
//! debounces raw filesystem events, diffs the post-debounce directory listing
//! against the previous snapshot, and emits a single `LibpathEvent::Changed`
//! with the delta (added / removed / touched package names).

use std::collections::HashSet;

/// Aggregated notification about changes under one or more libpath directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibpathEvent {
    /// Directory listings changed vs. last snapshot.
    Changed {
        /// Package names whose directories are newly present.
        added: HashSet<String>,
        /// Package names whose directories disappeared.
        removed: HashSet<String>,
        /// Existing package directories whose contents were touched
        /// (e.g. DESCRIPTION/NAMESPACE rewritten in place).
        touched: HashSet<String>,
    },
    /// Watcher attach failed or events were dropped; consumer should fall back
    /// to a full cache clear + re-init.
    Dropped,
}

impl LibpathEvent {
    /// Union of `added ∪ removed ∪ touched` for a `Changed` event; empty otherwise.
    pub fn affected_packages(&self) -> HashSet<String> {
        match self {
            LibpathEvent::Changed {
                added,
                removed,
                touched,
            } => {
                let mut out = added.clone();
                out.extend(removed.iter().cloned());
                out.extend(touched.iter().cloned());
                out
            }
            LibpathEvent::Dropped => HashSet::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affected_packages_unions_all_three_sets() {
        let ev = LibpathEvent::Changed {
            added: ["a".to_string()].into_iter().collect(),
            removed: ["b".to_string()].into_iter().collect(),
            touched: ["c".to_string(), "a".to_string()].into_iter().collect(),
        };
        let aff = ev.affected_packages();
        assert!(aff.contains("a"));
        assert!(aff.contains("b"));
        assert!(aff.contains("c"));
        assert_eq!(aff.len(), 3);
    }

    #[test]
    fn affected_packages_empty_for_dropped() {
        assert!(LibpathEvent::Dropped.affected_packages().is_empty());
    }
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cargo test -p raven --lib libpath_watcher::tests
```
Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/libpath_watcher.rs
git commit -m "feat(libpath): introduce LibpathEvent enum"
```

---

## Task 3: `LibpathWatcher` core — snapshot and diff logic (no notify yet)

**Files:**
- Modify: `crates/raven/src/libpath_watcher.rs`

Design note: we pull the snapshot/diff logic out into a pure function first so it is trivially unit-testable without spinning up a real watcher.

- [ ] **Step 1: Write the failing tests**

Append to `crates/raven/src/libpath_watcher.rs`:

```rust
use std::path::{Path, PathBuf};

/// A snapshot of which package subdirectories exist under each libpath.
/// Keyed by libpath root, each value is the set of immediate subdirectory
/// names that look like an R package (DESCRIPTION or NAMESPACE present).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct LibpathSnapshot {
    entries: std::collections::BTreeMap<PathBuf, HashSet<String>>,
}

impl LibpathSnapshot {
    pub(crate) fn capture(paths: &[PathBuf]) -> Self {
        let mut entries = std::collections::BTreeMap::new();
        for root in paths {
            let names = read_package_dir(root);
            entries.insert(root.clone(), names);
        }
        Self { entries }
    }

    pub(crate) fn diff(&self, other: &Self) -> (HashSet<String>, HashSet<String>) {
        let mut prev: HashSet<String> = HashSet::new();
        let mut next: HashSet<String> = HashSet::new();
        for names in self.entries.values() {
            prev.extend(names.iter().cloned());
        }
        for names in other.entries.values() {
            next.extend(names.iter().cloned());
        }
        let added: HashSet<String> = next.difference(&prev).cloned().collect();
        let removed: HashSet<String> = prev.difference(&next).cloned().collect();
        (added, removed)
    }
}

fn read_package_dir(root: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in read_dir.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // Skip in-progress install staging directories (leading "00LOCK-").
        if name.starts_with("00LOCK-") {
            continue;
        }
        let path = entry.path();
        if path.join("DESCRIPTION").exists() || path.join("NAMESPACE").exists() {
            out.insert(name);
        }
    }
    out
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use tempfile::tempdir;

    fn make_pkg(root: &Path, name: &str) {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("DESCRIPTION"), "Package: x\n").unwrap();
    }

    #[test]
    fn capture_lists_packages_with_description() {
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");
        make_pkg(t.path(), "bar");
        // Non-package directory (no DESCRIPTION/NAMESPACE) is ignored.
        std::fs::create_dir_all(t.path().join("not-a-pkg")).unwrap();

        let snap = LibpathSnapshot::capture(&[t.path().to_path_buf()]);
        let names: HashSet<String> = snap.entries.values().flatten().cloned().collect();
        assert_eq!(
            names,
            ["foo".to_string(), "bar".to_string()].into_iter().collect()
        );
    }

    #[test]
    fn capture_skips_00lock_staging_dirs() {
        let t = tempdir().unwrap();
        let lock = t.path().join("00LOCK-foo");
        std::fs::create_dir_all(&lock).unwrap();
        std::fs::write(lock.join("DESCRIPTION"), "").unwrap();

        let snap = LibpathSnapshot::capture(&[t.path().to_path_buf()]);
        assert!(snap.entries.values().flatten().next().is_none());
    }

    #[test]
    fn diff_reports_added_and_removed() {
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");
        let prev = LibpathSnapshot::capture(&[t.path().to_path_buf()]);

        make_pkg(t.path(), "bar");
        std::fs::remove_dir_all(t.path().join("foo")).unwrap();
        let next = LibpathSnapshot::capture(&[t.path().to_path_buf()]);

        let (added, removed) = prev.diff(&next);
        assert_eq!(added, ["bar".to_string()].into_iter().collect());
        assert_eq!(removed, ["foo".to_string()].into_iter().collect());
    }

    #[test]
    fn capture_handles_missing_directory() {
        let snap = LibpathSnapshot::capture(&[PathBuf::from("/does/not/exist/raven")]);
        assert!(snap.entries.values().flatten().next().is_none());
    }
}
```

Also add `tempfile` to `[dev-dependencies]` — it is already there per `Cargo.toml:47`, so no edit needed. If it were absent, we would add `tempfile = "3"`.

- [ ] **Step 2: Run the new tests**

```bash
cargo test -p raven --lib libpath_watcher::snapshot_tests
```
Expected: all four tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/libpath_watcher.rs
git commit -m "feat(libpath): snapshot and diff logic for libpath directories"
```

---

## Task 4: Wire `notify` into `LibpathWatcher` with debouncing

**Files:**
- Modify: `crates/raven/src/libpath_watcher.rs`

- [ ] **Step 1: Write the failing integration test for the watcher**

Append to `crates/raven/src/libpath_watcher.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

/// Handle to a running libpath watcher. Drop the handle to stop watching.
pub struct LibpathWatcherHandle {
    /// Kept alive so the watcher thread keeps running; the task aborts when this drops.
    _watcher: notify::RecommendedWatcher,
    /// Abort handle for the debounce/diff task.
    task: tokio::task::JoinHandle<()>,
}

impl Drop for LibpathWatcherHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start watching `paths`. Events are debounced by `debounce` and delivered on `tx`.
///
/// On fatal setup failure (all paths unwatchable), emits a single
/// `LibpathEvent::Dropped` and returns `None`. On partial failure (some paths
/// attached), proceeds with the paths that succeeded.
pub fn spawn_watcher(
    paths: Vec<PathBuf>,
    debounce: Duration,
    tx: mpsc::Sender<LibpathEvent>,
) -> Option<LibpathWatcherHandle> {
    use notify::{EventKind, RecursiveMode, Watcher};

    if paths.is_empty() {
        log::info!("LibpathWatcher: no paths to watch, skipping");
        return None;
    }

    // Internal channel: notify -> debounce task. Use a std::sync::mpsc because
    // notify v6 only accepts a synchronous EventHandler closure.
    let (raw_tx, raw_rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let raw_tx_cloned = raw_tx.clone();

    let mut watcher = match notify::recommended_watcher(move |res| {
        // Best-effort send; receiver may have gone away on shutdown.
        let _ = raw_tx_cloned.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("LibpathWatcher: failed to construct watcher: {e}");
            let _ = tx.try_send(LibpathEvent::Dropped);
            return None;
        }
    };

    let mut attached: Vec<PathBuf> = Vec::new();
    for p in &paths {
        match watcher.watch(p, RecursiveMode::NonRecursive) {
            Ok(()) => attached.push(p.clone()),
            Err(e) => {
                // A libpath directory may not exist yet (e.g. empty renv); log and continue.
                log::warn!("LibpathWatcher: cannot watch {}: {e}", p.display());
            }
        }
    }

    if attached.is_empty() {
        log::warn!("LibpathWatcher: no libpath directories could be attached");
        let _ = tx.try_send(LibpathEvent::Dropped);
        return None;
    }

    let raw_rx = Arc::new(Mutex::new(raw_rx));
    let snapshot = Arc::new(Mutex::new(LibpathSnapshot::capture(&attached)));

    let task = tokio::spawn(async move {
        debounce_loop(raw_rx, snapshot, attached, debounce, tx).await;
    });

    Some(LibpathWatcherHandle {
        _watcher: watcher,
        task,
    })
}

async fn debounce_loop(
    raw_rx: Arc<Mutex<std::sync::mpsc::Receiver<notify::Result<notify::Event>>>>,
    snapshot: Arc<Mutex<LibpathSnapshot>>,
    paths: Vec<PathBuf>,
    debounce: Duration,
    tx: mpsc::Sender<LibpathEvent>,
) {
    loop {
        // Block on the next raw event. We move raw_rx across an await using
        // spawn_blocking because std::sync::mpsc::Receiver::recv blocks.
        let rx_arc = Arc::clone(&raw_rx);
        let first = tokio::task::spawn_blocking(move || {
            let guard = rx_arc.blocking_lock();
            guard.recv()
        })
        .await;

        match first {
            Ok(Ok(_evt)) => {
                // Got an event; now drain any further events within debounce window.
                tokio::time::sleep(debounce).await;
                let rx_arc = Arc::clone(&raw_rx);
                let _drained = tokio::task::spawn_blocking(move || {
                    let guard = rx_arc.blocking_lock();
                    while guard.try_recv().is_ok() {}
                })
                .await;

                // Diff.
                let next_snap = LibpathSnapshot::capture(&paths);
                let (added, removed) = {
                    let prev = snapshot.lock().await;
                    prev.diff(&next_snap)
                };
                // Touched = packages that still exist but the snapshot saw
                // events for. We don't track per-package event counts, so we
                // conservatively mark everything that exists in both prev and next
                // as NOT touched unless the notify event kind was a non-directory
                // change. For v1, leave `touched` empty — diff-on-listings is
                // cheap and sufficient for the common `install.packages` case.
                let touched: HashSet<String> = HashSet::new();

                *snapshot.lock().await = next_snap;

                if !added.is_empty() || !removed.is_empty() || !touched.is_empty() {
                    let _ = tx
                        .send(LibpathEvent::Changed {
                            added,
                            removed,
                            touched,
                        })
                        .await;
                }
            }
            Ok(Err(_disconnect)) => {
                log::warn!("LibpathWatcher: raw channel disconnected, exiting");
                return;
            }
            Err(join_err) => {
                log::warn!("LibpathWatcher: blocking task failed: {join_err}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod watcher_tests {
    use super::*;
    use tempfile::tempdir;

    fn make_pkg(root: &Path, name: &str) {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("DESCRIPTION"), "Package: x\n").unwrap();
    }

    #[tokio::test]
    async fn watcher_emits_added_on_new_package() {
        let t = tempdir().unwrap();
        let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);

        let _handle = spawn_watcher(
            vec![t.path().to_path_buf()],
            Duration::from_millis(150),
            tx,
        )
        .expect("watcher attached");

        // Give the watcher a moment to register.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Simulate install.
        make_pkg(t.path(), "foo");

        let evt = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("event arrived in time")
            .expect("channel not closed");

        match evt {
            LibpathEvent::Changed { added, removed, .. } => {
                assert_eq!(added, ["foo".to_string()].into_iter().collect());
                assert!(removed.is_empty());
            }
            LibpathEvent::Dropped => panic!("expected Changed, got Dropped"),
        }
    }

    #[tokio::test]
    async fn watcher_emits_removed_on_package_deletion() {
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");

        let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
        let _handle = spawn_watcher(
            vec![t.path().to_path_buf()],
            Duration::from_millis(150),
            tx,
        )
        .expect("watcher attached");

        tokio::time::sleep(Duration::from_millis(50)).await;

        std::fs::remove_dir_all(t.path().join("foo")).unwrap();

        let evt = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("event arrived in time")
            .expect("channel not closed");

        match evt {
            LibpathEvent::Changed { added, removed, .. } => {
                assert_eq!(removed, ["foo".to_string()].into_iter().collect());
                assert!(added.is_empty());
            }
            LibpathEvent::Dropped => panic!("expected Changed, got Dropped"),
        }
    }

    #[tokio::test]
    async fn watcher_returns_none_when_no_paths_attach() {
        let (tx, _rx) = mpsc::channel::<LibpathEvent>(16);
        // Non-existent path should fail to attach on all platforms.
        let handle = spawn_watcher(
            vec![PathBuf::from("/raven/nonexistent/xyz-abc")],
            Duration::from_millis(50),
            tx,
        );
        assert!(handle.is_none());
    }
}
```

- [ ] **Step 2: Run the watcher tests**

```bash
cargo test -p raven --lib libpath_watcher::watcher_tests
```
Expected: all three tests pass. If a test times out on macOS due to FSEvents coalescing latency, raise the debounce in the test to 300ms and the timeout to 5s; do not change the production default yet.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/libpath_watcher.rs
git commit -m "feat(libpath): wire notify into LibpathWatcher with debounced diff"
```

---

## Task 5: `PackageLibrary::invalidate_many` + meta-package invalidation

**Files:**
- Modify: `crates/raven/src/package_library.rs`

- [ ] **Step 1: Write the failing test**

Add a new test module block at the end of `crates/raven/src/package_library.rs` (or within the existing test module — follow the file's current convention; the existing tests live in `mod tests` beginning around the file's bottom):

```rust
#[tokio::test]
async fn invalidate_many_removes_all_listed_packages() {
    use std::collections::HashSet;

    let lib = PackageLibrary::new_empty();
    lib.insert_package(PackageInfo::new("dplyr".into(), HashSet::new()))
        .await;
    lib.insert_package(PackageInfo::new("ggplot2".into(), HashSet::new()))
        .await;
    lib.insert_package(PackageInfo::new("readr".into(), HashSet::new()))
        .await;
    assert_eq!(lib.cached_count().await, 3);

    let to_invalidate: HashSet<String> =
        ["dplyr".into(), "readr".into()].into_iter().collect();
    lib.invalidate_many(&to_invalidate).await;

    assert_eq!(lib.cached_count().await, 1);
    assert!(lib.is_cached("ggplot2").await);
    assert!(!lib.is_cached("dplyr").await);
    assert!(!lib.is_cached("readr").await);
}

#[tokio::test]
async fn invalidate_many_clears_combined_exports_for_meta_packages() {
    use std::collections::HashSet;

    let lib = PackageLibrary::new_empty();
    // Seed combined_exports as though tidyverse had been loaded.
    {
        let mut combined = lib.combined_exports.write().await;
        combined.insert(
            "tidyverse".into(),
            std::sync::Arc::new(
                ["mutate".to_string(), "ggplot".to_string()]
                    .into_iter()
                    .collect(),
            ),
        );
        combined.insert(
            "dplyr".into(),
            std::sync::Arc::new(["mutate".to_string()].into_iter().collect()),
        );
    }

    // Invalidate a child (dplyr) — the meta-package combined entry must be dropped too.
    let set: HashSet<String> = ["dplyr".to_string()].into_iter().collect();
    lib.invalidate_many(&set).await;

    let combined = lib.combined_exports.read().await;
    assert!(!combined.contains_key("tidyverse"));
    assert!(!combined.contains_key("dplyr"));
}

#[tokio::test]
async fn cached_package_names_returns_current_keys() {
    use std::collections::HashSet;
    let lib = PackageLibrary::new_empty();
    lib.insert_package(PackageInfo::new("a".into(), HashSet::new()))
        .await;
    lib.insert_package(PackageInfo::new("b".into(), HashSet::new()))
        .await;

    let names = lib.cached_package_names().await;
    assert_eq!(
        names,
        ["a".to_string(), "b".to_string()].into_iter().collect()
    );
}
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cargo test -p raven --lib package_library::tests::invalidate_many_
```
Expected: compile error — `invalidate_many` and `cached_package_names` don't exist yet.

- [ ] **Step 3: Implement the new methods**

In `crates/raven/src/package_library.rs`, directly after the existing `invalidate` method (line 416) and before `clear_cache` (line 422), insert:

```rust
/// Invalidate a batch of packages, also dropping any `combined_exports`
/// entries whose key is in `names` or whose `attached_packages` intersect `names`.
///
/// This matters for meta-packages like `tidyverse` whose combined export set
/// is derived from multiple children; invalidating `dplyr` must also drop the
/// cached `tidyverse` aggregate so the next lookup rebuilds it from fresh data.
pub async fn invalidate_many(&self, names: &HashSet<String>) {
    if names.is_empty() {
        return;
    }
    {
        let mut cache = self.packages.write().await;
        for n in names {
            cache.remove(n);
        }
    }
    {
        let mut combined = self.combined_exports.write().await;
        // Drop direct hits first.
        combined.retain(|k, _| !names.contains(k));
        // Drop meta-package aggregates whose attached set intersects `names`.
        let meta_hits: Vec<String> = combined
            .keys()
            .filter(|k| {
                let attached = meta_attached_packages(k.as_str());
                attached.iter().any(|p| names.contains(p))
            })
            .cloned()
            .collect();
        for m in meta_hits {
            combined.remove(&m);
        }
    }
}

/// Snapshot of the keys currently in the per-package cache.
pub async fn cached_package_names(&self) -> HashSet<String> {
    let cache = self.packages.read().await;
    cache.keys().cloned().collect()
}
```

Also add this free function near the top of the file (just after the `TIDYMODELS_PACKAGES` constant around line 60):

```rust
/// Return the set of child packages attached by a meta-package name.
/// Empty for non-meta packages.
fn meta_attached_packages(name: &str) -> &'static [&'static str] {
    match name {
        "tidyverse" => TIDYVERSE_PACKAGES,
        "tidymodels" => TIDYMODELS_PACKAGES,
        _ => &[],
    }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cargo test -p raven --lib package_library::tests::invalidate_many_
cargo test -p raven --lib package_library::tests::cached_package_names
```
Expected: all three new tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/package_library.rs
git commit -m "feat(packages): invalidate_many + meta-package cache invalidation"
```

---

## Task 6: Config plumbing — two new `CrossFileConfig` fields

**Files:**
- Modify: `crates/raven/src/cross_file/config.rs`
- Modify: `crates/raven/src/backend.rs`

- [ ] **Step 1: Add the fields to `CrossFileConfig`**

In `crates/raven/src/cross_file/config.rs`, after the `packages_missing_package_severity` field (line 82), insert:

```rust
    /// Watch R library paths (`.libPaths()`) for package install/remove events.
    /// When true, Raven attaches a filesystem watcher and refreshes package
    /// diagnostics automatically.
    pub packages_watch_library_paths: bool,
    /// Debounce window for libpath watcher events, in milliseconds.
    /// Clamped to `[100, 5000]` by the parser.
    pub packages_watch_debounce_ms: u64,
```

In the `Default` impl for `CrossFileConfig` (starts around `config.rs:108`), set the defaults. Find the existing `packages_missing_package_severity: Some(DiagnosticSeverity::WARNING)` line and insert directly after:

```rust
            packages_watch_library_paths: true,
            packages_watch_debounce_ms: 500,
```

- [ ] **Step 2: Parse the new settings**

In `crates/raven/src/backend.rs`, inside `parse_cross_file_config`, locate the `packages` parsing block (starts around line 302). Add at the end of that block (after the `missingPackageSeverity` parse at line 328), *before* the closing brace of `if let Some(packages) = packages {`:

```rust
        if let Some(v) = packages
            .get("watchLibraryPaths")
            .and_then(|v| v.as_bool())
        {
            config.packages_watch_library_paths = v;
        }
        if let Some(v) = packages
            .get("watchDebounceMs")
            .and_then(|v| v.as_u64())
        {
            config.packages_watch_debounce_ms = v.clamp(100, 5000);
        }
```

- [ ] **Step 3: Detect these settings in the change-handler `package_settings_changed` comparison**

Grep `backend.rs` for `package_settings_changed` (the build uses it around line 2244 to decide whether to reinitialize). Extend the comparison to also consider the new fields changing. Concretely, locate the `let package_settings_changed = new_config` line (around 2244) and its `||` chain. Add two clauses matching the existing style:

```rust
                || new_config.packages_watch_library_paths
                    != current_state.cross_file_config.packages_watch_library_paths
                || new_config.packages_watch_debounce_ms
                    != current_state.cross_file_config.packages_watch_debounce_ms
```

- [ ] **Step 4: Add a parse test**

Add near the existing `parse_cross_file_config` doctest or in an `#[cfg(test)]` block in `backend.rs`, a focused unit test:

```rust
#[test]
fn parse_cross_file_config_reads_watch_fields() {
    let settings = serde_json::json!({
        "packages": {
            "watchLibraryPaths": false,
            "watchDebounceMs": 250
        }
    });
    let cfg = super::parse_cross_file_config(&settings).unwrap().unwrap();
    assert!(!cfg.packages_watch_library_paths);
    assert_eq!(cfg.packages_watch_debounce_ms, 250);
}

#[test]
fn parse_cross_file_config_clamps_watch_debounce_ms() {
    let settings = serde_json::json!({
        "packages": { "watchDebounceMs": 50 }  // below floor
    });
    let cfg = super::parse_cross_file_config(&settings).unwrap().unwrap();
    assert_eq!(cfg.packages_watch_debounce_ms, 100);

    let settings = serde_json::json!({
        "packages": { "watchDebounceMs": 99999 } // above ceiling
    });
    let cfg = super::parse_cross_file_config(&settings).unwrap().unwrap();
    assert_eq!(cfg.packages_watch_debounce_ms, 5000);
}
```

Drop these into the existing `#[cfg(test)] mod tests { ... }` block in `backend.rs` (search for `mod tests` inside `backend.rs` — if it lives in a dedicated test module, colocate there; otherwise place in a new `#[cfg(test)] mod config_parse_tests { use super::*; ... }` at the bottom of `backend.rs`).

- [ ] **Step 5: Run the tests**

```bash
cargo test -p raven --lib parse_cross_file_config_reads_watch_fields
cargo test -p raven --lib parse_cross_file_config_clamps_watch_debounce_ms
```
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add crates/raven/src/cross_file/config.rs crates/raven/src/backend.rs
git commit -m "feat(config): add packages.watchLibraryPaths and watchDebounceMs"
```

---

## Task 7: Extend `WorldState` to hold the watcher handle

**Files:**
- Modify: `crates/raven/src/state.rs`

- [ ] **Step 1: Add the field**

In `crates/raven/src/state.rs`, inside the `WorldState` struct (before `package_library_ready` at line 580), add:

```rust
    /// Handle to the running libpath watcher, if any. Dropping it stops watching.
    pub libpath_watcher_handle: Option<std::sync::Arc<crate::libpath_watcher::LibpathWatcherHandle>>,
```

In the `WorldState::new` constructor around line 609, in the struct literal around line 644, add:

```rust
            libpath_watcher_handle: None,
```

Adjacent to `package_library_ready: false,` at line 679.

- [ ] **Step 2: Verify the crate compiles**

```bash
cargo build -p raven
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/state.rs
git commit -m "feat(state): add WorldState.libpath_watcher_handle"
```

---

## Task 8: Backend — spawn watcher after package init and wire consumer task

**Files:**
- Modify: `crates/raven/src/backend.rs`

Design note: the consumer task holds a clone of `Arc<RwLock<WorldState>>` and the LSP `Client`, listens on an `mpsc::Receiver<LibpathEvent>`, and on each event updates the package library and triggers diagnostics refresh via the existing `self.publish_diagnostics` path. Since the consumer is free-standing, we use a free function `run_libpath_consumer` rather than a method.

- [ ] **Step 1: Write the consumer function and spawner helper**

At the bottom of `backend.rs` (outside any `impl` block), add:

```rust
/// Consumer for libpath change events. Invalidates the package cache for
/// affected packages and schedules diagnostic revalidation for open documents
/// whose loaded packages intersect the change set.
async fn run_libpath_consumer(
    state_arc: std::sync::Arc<tokio::sync::RwLock<state::WorldState>>,
    client: tower_lsp::Client,
    mut rx: tokio::sync::mpsc::Receiver<crate::libpath_watcher::LibpathEvent>,
) {
    use crate::libpath_watcher::LibpathEvent;

    while let Some(evt) = rx.recv().await {
        match evt {
            LibpathEvent::Changed {
                added,
                removed,
                touched,
            } => {
                let affected: std::collections::HashSet<String> = added
                    .iter()
                    .chain(removed.iter())
                    .chain(touched.iter())
                    .cloned()
                    .collect();
                if affected.is_empty() {
                    continue;
                }
                log::info!(
                    "LibpathWatcher: +{} -{} ~{} packages",
                    added.len(),
                    removed.len(),
                    touched.len()
                );

                // Invalidate the package cache.
                let pkg_lib = { state_arc.read().await.package_library.clone() };
                pkg_lib.invalidate_many(&affected).await;

                // Prefetch newly added packages in the background so the next diagnostic pass is warm.
                if !added.is_empty() {
                    let pkg_lib = pkg_lib.clone();
                    let added_vec: Vec<String> = added.iter().cloned().collect();
                    tokio::spawn(async move {
                        pkg_lib.prefetch_packages(&added_vec).await;
                    });
                }

                // Collect URIs whose loaded_packages intersect `affected`.
                let affected_uris: Vec<tower_lsp::lsp_types::Url> = {
                    let state = state_arc.read().await;
                    state
                        .documents
                        .iter()
                        .filter_map(|(uri, doc)| {
                            let hit = doc
                                .loaded_packages
                                .iter()
                                .any(|p| affected.contains(p));
                            if hit {
                                Some(uri.clone())
                            } else {
                                None
                            }
                        })
                        .collect()
                };

                // Force republish is safe: the text hasn't changed but the
                // underlying package set has, so we want to overwrite the last
                // publish at the same version.
                {
                    let state = state_arc.read().await;
                    for uri in &affected_uris {
                        state.diagnostics_gate.mark_force_republish(uri);
                    }
                }

                // Schedule diagnostics for each affected open URI.
                for uri in affected_uris {
                    let _ = client
                        .send_notification::<tower_lsp::lsp_types::notification::PublishDiagnostics>(
                            // We don't actually publish here; we request the backend
                            // debounced diagnostic pipeline by re-running publish_diagnostics.
                            // Fall through to the call below instead.
                            tower_lsp::lsp_types::PublishDiagnosticsParams {
                                uri: uri.clone(),
                                diagnostics: vec![],
                                version: None,
                            },
                        )
                        .await;
                    // The real work: schedule a real diagnostic pass through the existing debounce.
                    // (We route through the same helper publish_diagnostics uses.)
                    // Backend owns the pipeline; re-enter it by cloning state+client.
                    let state_arc2 = std::sync::Arc::clone(&state_arc);
                    let client2 = client.clone();
                    tokio::spawn(async move {
                        Backend::publish_diagnostics_via_arc(state_arc2, client2, &uri).await;
                    });
                }
            }
            LibpathEvent::Dropped => {
                log::warn!("LibpathWatcher: dropped, clearing package cache");
                let pkg_lib = { state_arc.read().await.package_library.clone() };
                pkg_lib.clear_cache().await;
                // Nothing else to do — next diagnostic pass will re-query on demand.
            }
        }
    }
    log::info!("LibpathWatcher consumer channel closed; exiting");
}
```

Notice: the consumer calls `Backend::publish_diagnostics_via_arc`. Add a thin associated helper on `Backend` that mirrors `publish_diagnostics` but takes explicit `state_arc` + `client` so we can call it from contexts without `&self`. Near the existing `publish_diagnostics` method (line 3644), add:

```rust
/// Free-standing variant of `publish_diagnostics` usable from background tasks.
/// Delegates to the same debounced pipeline.
pub(crate) async fn publish_diagnostics_via_arc(
    state_arc: std::sync::Arc<tokio::sync::RwLock<state::WorldState>>,
    client: tower_lsp::Client,
    uri: &tower_lsp::lsp_types::Url,
) {
    // Use the same debounce as the regular path by delegating into the shared helper.
    // (Backend::publish_diagnostics internally spawns run_debounced_diagnostics.)
    let (debounce_ms, trigger_version, trigger_revision) = {
        let state = state_arc.read().await;
        let doc = state.documents.get(uri);
        let v = doc.and_then(|d| d.version);
        let r = doc.map(|d| d.revision);
        (
            state.cross_file_config.revalidation_debounce_ms,
            v,
            r,
        )
    };
    tokio::spawn(run_debounced_diagnostics(
        state_arc,
        client,
        uri.clone(),
        debounce_ms,
        trigger_version,
        trigger_revision,
    ));
}
```

Also: remove the dead `send_notification::<PublishDiagnostics>` shim from `run_libpath_consumer` above — it was only there as a placeholder. Keep just the `tokio::spawn(async move { Backend::publish_diagnostics_via_arc(...).await; })` call.

So the cleaned-up URI loop becomes:

```rust
for uri in affected_uris {
    let state_arc2 = std::sync::Arc::clone(&state_arc);
    let client2 = client.clone();
    tokio::spawn(async move {
        Backend::publish_diagnostics_via_arc(state_arc2, client2, &uri).await;
    });
}
```

- [ ] **Step 2: Spawn the watcher after package init**

In the `initialized` handler, locate the block that constructs `new_package_library` and sets `package_library_ready` (around `backend.rs:1017-1083`). After the write-lock block that sets `state.package_library = new_package_library`, add:

```rust
// Start the libpath watcher if enabled and we have a real package library.
{
    let state = self.state.read().await;
    if state.cross_file_config.packages_enabled
        && state.cross_file_config.packages_watch_library_paths
        && state.package_library_ready
    {
        let lib_paths = state.package_library.lib_paths().to_vec();
        let debounce =
            std::time::Duration::from_millis(state.cross_file_config.packages_watch_debounce_ms);
        drop(state); // release read lock before write

        let (tx, rx) = tokio::sync::mpsc::channel::<crate::libpath_watcher::LibpathEvent>(64);
        let handle_opt = crate::libpath_watcher::spawn_watcher(lib_paths, debounce, tx);

        if let Some(handle) = handle_opt {
            let state_arc = std::sync::Arc::clone(&self.state);
            let client = self.client.clone();
            tokio::spawn(run_libpath_consumer(state_arc, client, rx));

            let mut state = self.state.write().await;
            state.libpath_watcher_handle = Some(std::sync::Arc::new(handle));
        }
    }
}
```

- [ ] **Step 3: Restart watcher on settings change**

In the settings-change handler, locate the `if package_settings_changed {` block (around `backend.rs:2400`). At the end of that block (after the write-lock that reinitializes `state.package_library`), tear down the existing watcher and optionally spawn a new one:

```rust
// Tear down the old libpath watcher; a new one is spawned below if still enabled.
{
    let mut state = self.state.write().await;
    state.libpath_watcher_handle = None;
}

let (restart, lib_paths, debounce) = {
    let state = self.state.read().await;
    let restart = state.cross_file_config.packages_enabled
        && state.cross_file_config.packages_watch_library_paths
        && state.package_library_ready;
    (
        restart,
        state.package_library.lib_paths().to_vec(),
        std::time::Duration::from_millis(state.cross_file_config.packages_watch_debounce_ms),
    )
};

if restart {
    let (tx, rx) = tokio::sync::mpsc::channel::<crate::libpath_watcher::LibpathEvent>(64);
    if let Some(handle) = crate::libpath_watcher::spawn_watcher(lib_paths, debounce, tx) {
        let state_arc = std::sync::Arc::clone(&self.state);
        let client = self.client.clone();
        tokio::spawn(run_libpath_consumer(state_arc, client, rx));
        let mut state = self.state.write().await;
        state.libpath_watcher_handle = Some(std::sync::Arc::new(handle));
    }
}
```

- [ ] **Step 4: Build**

```bash
cargo build -p raven
```
Expected: compiles clean. Fix any visibility issues (the `Backend::publish_diagnostics_via_arc` must be `pub(crate)` and `run_debounced_diagnostics` must be reachable from it — it already lives at module scope per `backend.rs:651`).

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "feat(libpath): spawn watcher + consumer task during backend init"
```

---

## Task 9: `raven.refreshPackages` LSP command

**Files:**
- Modify: `crates/raven/src/backend.rs`

- [ ] **Step 1: Write a failing test for the command handler**

If the test module at the bottom of `backend.rs` does not yet exist, add one; otherwise append. Test scope is the logic of `refresh_packages_command_body`, a helper we will introduce and unit-test in isolation:

```rust
#[cfg(test)]
mod refresh_packages_tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[tokio::test]
    async fn refresh_clears_package_cache_and_returns_count() {
        use crate::package_library::{PackageInfo, PackageLibrary};
        let lib = Arc::new(PackageLibrary::new_empty());
        lib.insert_package(PackageInfo::new("foo".into(), HashSet::new()))
            .await;
        lib.insert_package(PackageInfo::new("bar".into(), HashSet::new()))
            .await;
        assert_eq!(lib.cached_count().await, 2);

        let cleared = refresh_packages_command_body(&lib, &[]).await;
        assert_eq!(cleared, 2);
        assert_eq!(lib.cached_count().await, 0);
    }
}
```

- [ ] **Step 2: Verify it fails**

```bash
cargo test -p raven --lib refresh_packages_tests
```
Expected: compile error — `refresh_packages_command_body` does not exist.

- [ ] **Step 3: Implement the helper and command handler**

At module scope in `backend.rs` (alongside `run_libpath_consumer`), add:

```rust
/// Core logic of the `raven.refreshPackages` command. Returns the number of cached
/// package entries that were cleared. Takes an explicit loaded-package list so the
/// caller can trigger prefetch of packages known to be in use.
pub(crate) async fn refresh_packages_command_body(
    pkg_lib: &std::sync::Arc<crate::package_library::PackageLibrary>,
    loaded_packages_to_prefetch: &[String],
) -> usize {
    let before = pkg_lib.cached_count().await;
    pkg_lib.clear_cache().await;
    if !loaded_packages_to_prefetch.is_empty() {
        pkg_lib.prefetch_packages(loaded_packages_to_prefetch).await;
    }
    before
}
```

Then register the command on `Backend`. tower-lsp's `LanguageServer` trait includes an `execute_command` method. In the `impl LanguageServer for Backend` block, find whether `execute_command` is already defined. If not, add it (alongside `did_change_configuration` or similar). Example placement: directly after `shutdown` at `backend.rs:1095`.

```rust
async fn execute_command(
    &self,
    params: tower_lsp::lsp_types::ExecuteCommandParams,
) -> tower_lsp::jsonrpc::Result<Option<serde_json::Value>> {
    match params.command.as_str() {
        "raven.refreshPackages" => {
            // Collect distinct packages referenced by open docs for warm prefetch.
            let (pkg_lib, loaded_packages, open_uris) = {
                let state = self.state.read().await;
                let mut loaded: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                for doc in state.documents.values() {
                    for p in &doc.loaded_packages {
                        loaded.insert(p.clone());
                    }
                }
                let uris: Vec<tower_lsp::lsp_types::Url> =
                    state.documents.keys().cloned().collect();
                (
                    state.package_library.clone(),
                    loaded.into_iter().collect::<Vec<_>>(),
                    uris,
                )
            };

            let cleared = refresh_packages_command_body(&pkg_lib, &loaded_packages).await;
            log::info!("raven.refreshPackages: cleared {cleared} cache entries");

            // Force-republish diagnostics for all open documents.
            {
                let state = self.state.read().await;
                for uri in &open_uris {
                    state.diagnostics_gate.mark_force_republish(uri);
                }
            }
            for uri in open_uris {
                self.publish_diagnostics(&uri).await;
            }
            Ok(Some(serde_json::json!({ "cleared": cleared })))
        }
        other => {
            log::warn!("execute_command: unknown command '{other}'");
            Ok(None)
        }
    }
}
```

Also, in the `initialize` handler (search for `fn initialize`), ensure the server advertises the command in `server_info.capabilities.execute_command_provider`:

```rust
execute_command_provider: Some(tower_lsp::lsp_types::ExecuteCommandOptions {
    commands: vec!["raven.refreshPackages".to_string()],
    ..Default::default()
}),
```

If `execute_command_provider` is already set, extend its `commands` vec rather than overwriting.

- [ ] **Step 4: Run the test**

```bash
cargo test -p raven --lib refresh_packages_tests
```
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "feat(libpath): raven.refreshPackages LSP command"
```

---

## Task 10: VS Code — new settings + refresh command

**Files:**
- Modify: `editors/vscode/package.json`
- Modify: `editors/vscode/src/initializationOptions.ts`
- Modify: `editors/vscode/src/extension.ts`

- [ ] **Step 1: Add the two new settings and the new command to `package.json`**

In `editors/vscode/package.json`, inside the `contributes.commands` array (starts line 25) add:

```json
{
    "command": "raven.refreshPackages",
    "title": "Raven: Refresh package cache"
}
```

In the `configuration.properties` block, after `raven.packages.missingPackageSeverity` (ends around line 388), insert:

```json
"raven.packages.watchLibraryPaths": {
    "type": "boolean",
    "default": true,
    "description": "Watch R library paths for package install/remove events and refresh diagnostics automatically. Disable if you see excessive filesystem activity or inotify watch-limit errors on Linux."
},
"raven.packages.watchDebounceMs": {
    "type": "integer",
    "default": 500,
    "minimum": 100,
    "maximum": 5000,
    "description": "Debounce window for batching library path filesystem events, in milliseconds. Larger values reduce redundant work during bulk installs (e.g. renv::restore); smaller values respond faster."
}
```

- [ ] **Step 2: Forward the settings in `initializationOptions.ts`**

In `editors/vscode/src/initializationOptions.ts`:

1. Extend the `packages` block in `RavenInitializationOptions` (around line 67) to:

```ts
packages?: {
    enabled?: boolean;
    additionalLibraryPaths?: string[];
    rPath?: string;
    missingPackageSeverity?: SeverityLevel;
    watchLibraryPaths?: boolean;
    watchDebounceMs?: number;
};
```

2. In `getInitializationOptions` (around line 261 where packages are read), add after `missingPackageSeverity`:

```ts
const watchLibraryPaths = getExplicitSetting<boolean>(config, 'packages.watchLibraryPaths');
const watchDebounceMs = getExplicitSetting<number>(config, 'packages.watchDebounceMs');
```

3. Extend the `if (packagesEnabled !== undefined || ...)` guard to include the two new variables, then inside the block add:

```ts
if (watchLibraryPaths !== undefined) {
    options.packages.watchLibraryPaths = watchLibraryPaths;
}
if (watchDebounceMs !== undefined) {
    options.packages.watchDebounceMs = watchDebounceMs;
}
```

- [ ] **Step 3: Register the VS Code command**

In `editors/vscode/src/extension.ts`, directly after the `raven.restart` command registration (around line 134), add:

```ts
context.subscriptions.push(
    vscode.commands.registerCommand('raven.refreshPackages', async () => {
        try {
            await client.sendRequest('workspace/executeCommand', {
                command: 'raven.refreshPackages',
                arguments: []
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Raven refreshPackages failed: ${err}`);
        }
    })
);
```

- [ ] **Step 4: Add test coverage**

In `editors/vscode/src/test/settings.test.ts`, add cases covering both new settings. Use the existing test style — find a representative existing test (e.g. a `raven.packages.missingPackageSeverity` case) and mirror it. A minimal addition:

```ts
test('forwards packages.watchLibraryPaths when explicitly configured', () => {
    const config = makeConfigWithExplicit({ 'packages.watchLibraryPaths': false });
    const opts = getInitializationOptions(config);
    assert.strictEqual(opts.packages?.watchLibraryPaths, false);
});

test('forwards packages.watchDebounceMs when explicitly configured', () => {
    const config = makeConfigWithExplicit({ 'packages.watchDebounceMs': 300 });
    const opts = getInitializationOptions(config);
    assert.strictEqual(opts.packages?.watchDebounceMs, 300);
});

test('omits packages.watch* fields when not explicitly configured', () => {
    const config = makeConfigWithExplicit({});
    const opts = getInitializationOptions(config);
    assert.strictEqual(opts.packages?.watchLibraryPaths, undefined);
    assert.strictEqual(opts.packages?.watchDebounceMs, undefined);
});
```

If `makeConfigWithExplicit` is not the real helper name, locate the existing helper in `settings.test.ts` used by the current tests for `missingPackageSeverity` and reuse it verbatim — do not invent a new helper.

- [ ] **Step 5: Run the extension test build**

```bash
cd editors/vscode && bun run compile && cd -
```
Expected: no TypeScript errors.

If the repo's convention is to run full VS Code tests:
```bash
cd editors/vscode && bun test && cd -
```

- [ ] **Step 6: Commit**

```bash
git add editors/vscode/package.json editors/vscode/src/initializationOptions.ts editors/vscode/src/extension.ts editors/vscode/src/test/settings.test.ts
git commit -m "feat(vscode): expose libpath watcher settings and refreshPackages command"
```

---

## Task 11: Integration test for end-to-end install → diagnostic clear

**Files:**
- Create: `crates/raven/tests/libpath_watching.rs`

This test does not use a real R subprocess; it constructs a `PackageLibrary` whose lib_paths point at a tempdir, spawns the watcher, and verifies that creating a package directory invalidates the cache.

- [ ] **Step 1: Write the failing test**

Create `crates/raven/tests/libpath_watching.rs`:

```rust
//! End-to-end integration: filesystem change under a watched libpath
//! propagates into a PackageLibrary cache invalidation.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use raven::libpath_watcher::{spawn_watcher, LibpathEvent};
use raven::package_library::{PackageInfo, PackageLibrary};
use tempfile::tempdir;
use tokio::sync::mpsc;

fn make_pkg(root: &Path, name: &str) {
    let d = root.join(name);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("DESCRIPTION"), "Package: x\n").unwrap();
}

#[tokio::test]
async fn install_triggers_cache_invalidation() {
    let t = tempdir().unwrap();

    // Pre-populate a cache entry for "foo" simulating a previous stale miss.
    let lib = Arc::new(PackageLibrary::new_empty());
    lib.insert_package(PackageInfo::new("foo".into(), HashSet::new()))
        .await;
    assert!(lib.is_cached("foo").await);

    let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
    let _handle = spawn_watcher(
        vec![t.path().to_path_buf()],
        Duration::from_millis(150),
        tx,
    )
    .expect("watcher attached");

    tokio::time::sleep(Duration::from_millis(50)).await;
    make_pkg(t.path(), "foo");

    let evt = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("event in time")
        .expect("channel open");

    let affected = evt.affected_packages();
    assert!(affected.contains("foo"), "expected 'foo' in {:?}", affected);

    lib.invalidate_many(&affected).await;
    assert!(!lib.is_cached("foo").await);
}
```

- [ ] **Step 2: Run it and verify it passes**

```bash
cargo test -p raven --test libpath_watching
```
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/tests/libpath_watching.rs
git commit -m "test(libpath): integration test for install-triggered invalidation"
```

---

## Task 12: Verify and document the existing `library(foo)` missing-package diagnostic

**Files:**
- Modify: `crates/raven/src/handlers.rs` (test only — implementation is unchanged)
- Modify: `docs/packages.md`

- [ ] **Step 1: Locate and extend the existing tests**

Open `crates/raven/src/handlers.rs` and find the test `test_missing_package_diagnostic_emitted` (begins around line 32440 per the exploration). This test already covers the warning emission but does so under a handcrafted `WorldState`. Add one more test that specifically asserts the default severity is WARNING and the exact diagnostic message format:

```rust
#[tokio::test]
async fn missing_package_diagnostic_default_is_warning_with_expected_message() {
    use crate::cross_file::CrossFileMetadata;
    use crate::state::WorldState;
    let mut state = WorldState::new(Vec::new());
    state.package_library_ready = true;
    state.cross_file_config.packages_enabled = true;
    // default is WARNING; make it explicit for the test's benefit
    state.cross_file_config.packages_missing_package_severity =
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING);

    // Ensure a subprocess is available (function bails otherwise).
    // Use the test helper if the file provides one; otherwise construct the
    // PackageLibrary with a dummy subprocess via `PackageLibrary::with_subprocess(None)`
    // and adjust the gate explicitly in the test.
    // NOTE: collect_missing_package_diagnostics early-returns when `r_subprocess()`
    // is None. If the test helper doesn't spawn a real R subprocess, use the
    // `#[cfg(test)]` gate relaxation pattern used in the neighboring tests
    // (they set `package_library_ready = true` and a cached package list directly).

    let meta = CrossFileMetadata {
        library_calls: vec![crate::cross_file::types::LibraryCall {
            package: "foo_does_not_exist".into(),
            line: 3,
            column: 22,
        }],
        ..Default::default()
    };

    let mut diags: Vec<tower_lsp::lsp_types::Diagnostic> = Vec::new();
    collect_missing_package_diagnostics(&state, &meta, &mut diags);

    assert_eq!(diags.len(), 1, "expected one diagnostic");
    assert_eq!(
        diags[0].severity,
        Some(tower_lsp::lsp_types::DiagnosticSeverity::WARNING)
    );
    assert!(
        diags[0]
            .message
            .contains("Package 'foo_does_not_exist' is not installed"),
        "message was: {}",
        diags[0].message
    );
}
```

If the existing neighboring tests use a test-only constructor for `PackageLibrary` that bypasses the `r_subprocess()` check, mirror their construction exactly rather than inventing a new one. If they don't — i.e., the current tests only verify the diagnostic appears when subprocess is present — leave the new test gated with `#[ignore = "requires R subprocess"]` and add a second variant that uses the same gate-relaxation trick as `test_missing_package_diagnostic_suppressed_while_package_library_not_ready` (around `handlers.rs:32585`). Match existing patterns; do not introduce new testing infrastructure here.

- [ ] **Step 2: Run the new test**

```bash
cargo test -p raven --lib missing_package_diagnostic_default_is_warning_with_expected_message
```
Expected: passes (or, if gated with `#[ignore]`, run with `-- --ignored` and confirm locally).

- [ ] **Step 3: Document the feature**

In `docs/packages.md`, add a new section near the end. If `docs/packages.md` does not exist, create it following the same style as `docs/cross-file.md`.

Content to add:

````markdown
## Live package updates

Raven watches each directory on `.libPaths()` for changes. When you run
`install.packages("foo")`, `remotes::install_github()`, `pak::pkg_install()`,
or `renv::restore()`, Raven invalidates its in-memory cache entries for the
affected packages within a few hundred milliseconds, then re-runs diagnostics
on open documents that referenced those packages. No editor restart is
required.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `raven.packages.watchLibraryPaths` | `true` | Enable filesystem-watcher-driven cache invalidation. |
| `raven.packages.watchDebounceMs` | `500` | Event-debounce window in ms. Clamped to `[100, 5000]`. |

### Fallback — manual refresh

If the watcher fails to attach (for example, Linux inotify watch-descriptor
limit exhausted, or a libpath on a filesystem that does not emit notify
events), run the VS Code command **"Raven: Refresh package cache"**
(`raven.refreshPackages`). This clears the in-memory cache and re-runs
diagnostics unconditionally.

## `library(foo)` diagnostics

When `foo` is not installed, Raven emits a `warning` on the `library(foo)`
(or `require(foo)`, `loadNamespace("foo")`) line with message:

> Package 'foo' is not installed

This diagnostic is produced only when **all four** of the following hold:

1. `raven.packages.enabled` is `true` (default).
2. `raven.packages.missingPackageSeverity` is not `"off"` (default: `"warning"`).
3. Raven completed its package-library initialization phase (happens shortly after startup).
4. Raven found an R executable at startup (either on `PATH` or via `raven.packages.rPath`).

If condition 4 fails, Raven cannot distinguish "not installed" from "installation
checked by a custom R configuration", and suppresses the diagnostic rather
than emit false positives. Check your Raven output channel for a line like
`PackageLibrary initialized: N lib_paths` to confirm initialization succeeded.
````

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/handlers.rs docs/packages.md
git commit -m "docs(packages): document libpath watching and missing-package diagnostic"
```

---

## Task 13: Update CLAUDE.md `## Learnings` with non-obvious findings

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append pitfalls encountered during implementation**

Add the following bullets to the end of the `## Learnings` section in `CLAUDE.md`:

```markdown
- `notify` v6's `EventHandler` is synchronous, so bridging to tokio requires a `std::sync::mpsc` plus `spawn_blocking` — don't try to use `tokio::sync::mpsc` directly inside `recommended_watcher`.
- `RecursiveMode::NonRecursive` is sufficient (and much cheaper on Linux) for libpath watching because we only need to observe *which package subdirectories* exist. We do not need per-file events under each package dir to detect installs/removes.
- Skip `00LOCK-<pkg>` staging directories when snapshotting a libpath; they appear mid-install and would otherwise look like new packages that immediately disappear.
- When a filesystem-triggered revalidation runs, the document version has not changed — call `CrossFileDiagnosticsGate::mark_force_republish(uri)` before `publish_diagnostics` or the monotonic gate will suppress the republish.
- `PackageLibrary::invalidate_many` must also drop `combined_exports` entries for meta-packages (`tidyverse`, `tidymodels`) whose `attached_packages` intersect the invalidated names — otherwise stale aggregate exports survive per-child invalidation.
```

- [ ] **Step 2: Run the full test suite one more time**

```bash
cargo test -p raven
```
Expected: all tests pass. Investigate any regression before committing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): learnings from libpath watching implementation"
```

---

## Self-review results

1. **Spec coverage:**
   - Component 1 (`LibpathWatcher`) → Tasks 2, 3, 4.
   - Component 2 (`PackageLibrary::invalidate_many`) → Task 5.
   - Component 3 (backend wiring) → Tasks 7, 8.
   - Component 4 (manual refresh command) → Tasks 9, 10 (VS Code side).
   - Component 5 (missing-package diagnostic verification + doc) → Task 12.
   - Configuration (two new settings, all three extension layers) → Tasks 6, 10.
   - Testing section of the spec → Tasks 2–5 (unit), Task 11 (integration), Task 12 (diagnostic).
   - CLAUDE.md invariant about three-layer extension config — covered (Tasks 6 + 10 together update Rust config, `package.json`, `initializationOptions.ts`, and `settings.test.ts`).

2. **Placeholder scan:** No `TBD`/`TODO`. Two places defer to "match the existing pattern" (Task 6 Step 3's list of `||` clauses; Task 10 Step 4's `makeConfigWithExplicit` helper name; Task 12 Step 1's fallback gate pattern); each of these points at a concrete existing symbol in the codebase that the implementer will read and imitate, which is safer than guessing at the exact name from outside the repo.

3. **Type consistency:**
   - `LibpathEvent` → referenced as `crate::libpath_watcher::LibpathEvent` in `run_libpath_consumer` (Task 8) and via re-export in integration test (Task 11). Matches Task 2 definition.
   - `LibpathWatcherHandle` → produced by `spawn_watcher` (Task 4), stored in `WorldState.libpath_watcher_handle: Option<Arc<LibpathWatcherHandle>>` (Task 7). Consistent.
   - `invalidate_many(&HashSet<String>)` → called with `&affected` (Task 8) and `&set` (Task 5 test). Consistent.
   - `refresh_packages_command_body(&Arc<PackageLibrary>, &[String]) -> usize` → signature matches the tokio test in Task 9 and the call site in `execute_command`.
   - Config field names `packages_watch_library_paths`, `packages_watch_debounce_ms` → defined in Task 6, read in Task 8 and the restart path. Consistent snake_case ↔ camelCase mapping.

---

**Plan complete and saved to `.claude/plans/libpath-watching.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
