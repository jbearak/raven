//! Filesystem watcher for R library paths.
//!
//! Watches one or more `.libPaths()` directories with the `notify` crate,
//! debounces raw filesystem events, diffs the post-debounce directory listing
//! against the previous snapshot, and emits a single `LibpathEvent::Changed`
//! with the delta (added / removed / touched package names).
//!
//! # Recursive vs non-recursive watching
//!
//! Each libpath is attached with `RecursiveMode::Recursive`. Non-recursive
//! watching misses the common in-place upgrade case: `install.packages("pkg")`
//! for an already-installed package overwrites files inside
//! `<libpath>/<pkg>/` without changing the libpath's directory listing, so the
//! `added`/`removed` diff is empty and no directory-level events fire under
//! `NonRecursive`. Recursive watching surfaces those file-level events so
//! `touched_from_events` can mark the package's cached exports as stale.
//!
//! On Linux, `notify`'s recursive inotify implementation attaches one watch
//! per descendant **directory** (not per file). A typical R package has ~10–20
//! subdirectories (`R/`, `man/`, `help/`, `data/`, …), so 500 installed
//! packages is ~5–10k inotify watches. This is comfortably under Debian/Ubuntu's
//! modern default of `fs.inotify.max_user_watches = 524288`, but users on
//! older distros capped at 8192 who install CRAN snapshots may want to raise
//! the limit via `sysctl -w fs.inotify.max_user_watches=524288`.

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
    ///
    /// Used by the integration test suite (`crates/raven/tests/libpath_watching.rs`)
    /// to assert post-event package deltas without re-implementing the union locally;
    /// the production consumer destructures the event directly so it does not call
    /// this from within the lib crate.
    #[allow(dead_code)]
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A snapshot of which package subdirectories exist under each libpath.
///
/// `entries` preserves the original libpath order (earlier = higher priority,
/// matching R's `.libPaths()`). Order matters because a package installed into
/// multiple libpaths is resolved from the first one that contains it; if the
/// "winning root" changes between snapshots, consumers must invalidate that
/// package's cached exports even though the name is still present.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LibpathSnapshot {
    entries: Vec<(PathBuf, HashSet<String>)>,
}

impl LibpathSnapshot {
    pub fn capture(paths: &[PathBuf]) -> Self {
        let entries = paths
            .iter()
            .map(|root| (root.clone(), read_package_dir(root)))
            .collect();
        Self { entries }
    }

    /// For each package name present in any watched root, return the first root
    /// (in libpath priority order) that contains it.
    fn winning_roots(&self) -> HashMap<String, PathBuf> {
        let mut winner: HashMap<String, PathBuf> = HashMap::new();
        for (root, names) in &self.entries {
            for name in names {
                winner.entry(name.clone()).or_insert_with(|| root.clone());
            }
        }
        winner
    }

    /// Diff two snapshots by their effective `package -> winning-root` mapping.
    ///
    /// Returns three sets:
    /// - `added`: names that were not present in `self` but are in `other`.
    /// - `removed`: names that were in `self` but are not in `other`.
    /// - `moved`: names present in both but whose winning root changed, so the
    ///   effective on-disk package differs even though the name persists.
    ///
    /// Consumers should treat all three as invalidation triggers.
    pub(crate) fn diff(
        &self,
        other: &Self,
    ) -> (HashSet<String>, HashSet<String>, HashSet<String>) {
        let prev = self.winning_roots();
        let next = other.winning_roots();
        let mut added = HashSet::new();
        let mut removed = HashSet::new();
        let mut moved = HashSet::new();
        for name in prev.keys().chain(next.keys()) {
            match (prev.get(name), next.get(name)) {
                (None, Some(_)) => {
                    added.insert(name.clone());
                }
                (Some(_), None) => {
                    removed.insert(name.clone());
                }
                (Some(p), Some(n)) if p != n => {
                    moved.insert(name.clone());
                }
                _ => {}
            }
        }
        (added, removed, moved)
    }

    /// True if any watched root currently contains a package with this name.
    fn contains(&self, name: &str) -> bool {
        self.entries.iter().any(|(_, names)| names.contains(name))
    }
}

/// Given raw `notify::Event` paths observed during a debounce window, derive
/// the set of package names that were "touched" — present in both snapshots
/// (so neither added nor removed) but whose contents were rewritten. This
/// covers the common in-place upgrade/reinstall case that produces no
/// directory-listing delta.
fn touched_from_events(
    event_paths: &[PathBuf],
    watched_roots: &[PathBuf],
    prev: &LibpathSnapshot,
    next: &LibpathSnapshot,
) -> HashSet<String> {
    let mut touched = HashSet::new();
    for path in event_paths {
        for root in watched_roots {
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            // First component after the root is the package directory name.
            let Some(std::path::Component::Normal(os)) = rel.components().next() else {
                break;
            };
            let Some(name) = os.to_str() else { break };
            if name.starts_with("00LOCK-") {
                break;
            }
            if prev.contains(name) && next.contains(name) {
                touched.insert(name.to_string());
            }
            break;
        }
    }
    touched
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
        let names: HashSet<String> = snap
            .entries
            .iter()
            .flat_map(|(_, n)| n.iter().cloned())
            .collect();
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
        assert!(snap.entries.iter().all(|(_, n)| n.is_empty()));
    }

    #[test]
    fn diff_reports_added_and_removed() {
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");
        let prev = LibpathSnapshot::capture(&[t.path().to_path_buf()]);

        make_pkg(t.path(), "bar");
        std::fs::remove_dir_all(t.path().join("foo")).unwrap();
        let next = LibpathSnapshot::capture(&[t.path().to_path_buf()]);

        let (added, removed, moved) = prev.diff(&next);
        assert_eq!(added, ["bar".to_string()].into_iter().collect());
        assert_eq!(removed, ["foo".to_string()].into_iter().collect());
        assert!(moved.is_empty());
    }

    #[test]
    fn diff_reports_moved_when_winning_root_changes() {
        // Two libpaths in priority order: high, low. Package `foo` initially
        // lives only in `low`; it is then installed into `high`, shadowing the
        // previous resolution even though the name persists in the union.
        let t_high = tempdir().unwrap();
        let t_low = tempdir().unwrap();
        make_pkg(t_low.path(), "foo");
        let prev = LibpathSnapshot::capture(&[
            t_high.path().to_path_buf(),
            t_low.path().to_path_buf(),
        ]);
        make_pkg(t_high.path(), "foo");
        let next = LibpathSnapshot::capture(&[
            t_high.path().to_path_buf(),
            t_low.path().to_path_buf(),
        ]);

        let (added, removed, moved) = prev.diff(&next);
        assert!(added.is_empty(), "name is in union both times");
        assert!(removed.is_empty());
        assert_eq!(moved, ["foo".to_string()].into_iter().collect());
    }

    #[test]
    fn capture_handles_missing_directory() {
        let snap = LibpathSnapshot::capture(&[PathBuf::from("/does/not/exist/raven")]);
        assert!(snap.entries.iter().all(|(_, n)| n.is_empty()));
    }

    #[test]
    fn touched_from_events_flags_in_place_upgrade() {
        // An in-place `install.packages("foo")` rewrites files *inside*
        // `<libpath>/foo/` without touching the libpath's listing. The diff
        // alone reports added={}, removed={}, moved={} — the only signal is
        // file-level events under `<libpath>/foo/`, which recursive watching
        // surfaces. `touched_from_events` must turn those into `{"foo"}`.
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");
        let prev = LibpathSnapshot::capture(&[t.path().to_path_buf()]);
        let next = prev.clone();

        let event_paths = vec![
            t.path().join("foo").join("DESCRIPTION"),
            t.path().join("foo").join("NAMESPACE"),
            // A deep-nested path still resolves to the package name.
            t.path().join("foo").join("help").join("aliases.rds"),
        ];

        let touched = touched_from_events(
            &event_paths,
            &[t.path().to_path_buf()],
            &prev,
            &next,
        );
        assert_eq!(touched, ["foo".to_string()].into_iter().collect());
    }

    #[test]
    fn touched_from_events_skips_00lock_staging() {
        // Recursive watching fires events under `<libpath>/00LOCK-foo/` during
        // install staging. Those must not be mis-attributed to the eventual
        // real `foo` package.
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");
        let snap = LibpathSnapshot::capture(&[t.path().to_path_buf()]);

        let event_paths = vec![
            t.path().join("00LOCK-foo").join("DESCRIPTION"),
            t.path().join("00LOCK-foo").join("foo").join("R").join("foo.R"),
        ];

        let touched = touched_from_events(
            &event_paths,
            &[t.path().to_path_buf()],
            &snap,
            &snap,
        );
        assert!(touched.is_empty(), "expected no touched, got {:?}", touched);
    }
}

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::mpsc;

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
    use notify::{RecursiveMode, Watcher};

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
        // Recursive: needed so in-place package upgrades (which rewrite files
        // inside an existing `<libpath>/<pkg>/` without touching the libpath's
        // listing) fire events we can turn into `touched`. See the module-level
        // docstring for the Linux inotify cost tradeoff.
        match watcher.watch(p, RecursiveMode::Recursive) {
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

    // Capture the initial snapshot before returning so that any filesystem
    // events queued between watcher.watch() and task startup are correctly
    // detected as deltas. block_in_place signals tokio that this thread is
    // about to block, allowing it to move other tasks off this worker.
    let initial_snap =
        tokio::task::block_in_place(|| LibpathSnapshot::capture(&attached));

    let raw_rx = Arc::new(StdMutex::new(raw_rx));
    let task = tokio::spawn(async move {
        let snapshot = Arc::new(tokio::sync::Mutex::new(initial_snap));
        debounce_loop(raw_rx, snapshot, Arc::new(attached), debounce, tx).await;
    });

    Some(LibpathWatcherHandle {
        _watcher: watcher,
        task,
    })
}

async fn debounce_loop(
    raw_rx: Arc<StdMutex<std::sync::mpsc::Receiver<notify::Result<notify::Event>>>>,
    snapshot: Arc<tokio::sync::Mutex<LibpathSnapshot>>,
    paths: Arc<Vec<PathBuf>>,
    debounce: Duration,
    tx: mpsc::Sender<LibpathEvent>,
) {
    loop {
        // Block on the next raw event. We move raw_rx across an await using
        // spawn_blocking because std::sync::mpsc::Receiver::recv blocks.
        let rx_arc = Arc::clone(&raw_rx);
        let first = tokio::task::spawn_blocking(move || {
            // Unwrap: StdMutex never poisons in normal operation.
            let guard = rx_arc.lock().unwrap();
            guard.recv()
        })
        .await;

        match first {
            Ok(Ok(notify_result)) => {
                // Capture paths from the initial event and everything drained
                // during the debounce window. We need these to reconstruct the
                // `touched` set (in-place upgrades that produce no listing delta).
                // An `Err` notify result at the head of the stream means notify
                // surfaced an error for this callback — log and proceed with an
                // empty starting path list so we still run the diff.
                let mut event_paths: Vec<PathBuf> = match notify_result {
                    Ok(evt) => evt.paths,
                    Err(e) => {
                        log::warn!("LibpathWatcher: notify error event: {e}");
                        Vec::new()
                    }
                };
                tokio::time::sleep(debounce).await;
                let rx_arc = Arc::clone(&raw_rx);
                let drained_paths: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
                    let mut paths = Vec::new();
                    let guard = rx_arc.lock().unwrap();
                    while let Ok(res) = guard.try_recv() {
                        match res {
                            Ok(evt) => paths.extend(evt.paths),
                            Err(e) => {
                                log::warn!("LibpathWatcher: notify error during drain: {e}")
                            }
                        }
                    }
                    paths
                })
                .await
                .unwrap_or_default();
                event_paths.extend(drained_paths);

                // Diff and derive touched under a single snapshot-lock acquisition.
                let paths_for_capture = paths.clone();
                let next_snap = match tokio::task::spawn_blocking(move || {
                    LibpathSnapshot::capture(&paths_for_capture)
                })
                .await
                {
                    Ok(snap) => snap,
                    Err(e) => {
                        log::warn!("LibpathWatcher: capture task failed: {e}");
                        let _ = tx.send(LibpathEvent::Dropped).await;
                        return;
                    }
                };
                let (added, removed, touched) = {
                    let mut snap_guard = snapshot.lock().await;
                    let (added, removed, moved) = snap_guard.diff(&next_snap);
                    let mut touched =
                        touched_from_events(&event_paths, &paths, &snap_guard, &next_snap);
                    // Packages whose winning libpath changed are also "touched"
                    // from the consumer's perspective — the effective on-disk
                    // version differs even though the name persists.
                    touched.extend(moved);
                    *snap_guard = next_snap;
                    (added, removed, touched)
                };

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
                // Notify consumer so the fallback (full cache clear) path runs;
                // otherwise package invalidation silently stops for this session.
                let _ = tx.send(LibpathEvent::Dropped).await;
                return;
            }
            Err(join_err) => {
                log::warn!("LibpathWatcher: blocking task failed: {join_err}");
                let _ = tx.send(LibpathEvent::Dropped).await;
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

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires reliable macOS FSEvents delivery; run with `cargo test -- --ignored`"]
    async fn watcher_emits_added_on_new_package() {
        let t = tempdir().unwrap();
        let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);

        let _handle = spawn_watcher(
            vec![t.path().to_path_buf()],
            Duration::from_millis(300),
            tx,
        )
        .expect("watcher attached");

        // Give the watcher a moment to register.
        tokio::time::sleep(Duration::from_millis(200)).await;

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

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires reliable FS notifications; run with `cargo test -- --ignored`"]
    async fn watcher_emits_touched_on_in_place_upgrade() {
        // Regression for the NonRecursive → Recursive switch: rewriting files
        // inside an existing package directory must report it as `touched`.
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");

        let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
        let _handle = spawn_watcher(
            vec![t.path().to_path_buf()],
            Duration::from_millis(300),
            tx,
        )
        .expect("watcher attached");

        tokio::time::sleep(Duration::from_millis(200)).await;

        // Rewrite files inside the existing package directory — no listing
        // delta, so only recursive watching surfaces this as a signal.
        std::fs::write(
            t.path().join("foo").join("DESCRIPTION"),
            "Package: foo\nVersion: 2.0\n",
        )
        .unwrap();
        std::fs::write(
            t.path().join("foo").join("NAMESPACE"),
            "export(new_fn)\n",
        )
        .unwrap();

        let evt = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("event arrived in time")
            .expect("channel not closed");

        match evt {
            LibpathEvent::Changed {
                added,
                removed,
                touched,
            } => {
                assert!(added.is_empty(), "no dir was added: {:?}", added);
                assert!(removed.is_empty(), "no dir was removed: {:?}", removed);
                assert!(
                    touched.contains("foo"),
                    "expected 'foo' in touched, got {:?}",
                    touched
                );
            }
            LibpathEvent::Dropped => panic!("expected Changed, got Dropped"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires reliable macOS FSEvents delivery; run with `cargo test -- --ignored`"]
    async fn watcher_emits_removed_on_package_deletion() {
        let t = tempdir().unwrap();
        make_pkg(t.path(), "foo");

        let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
        let _handle = spawn_watcher(
            vec![t.path().to_path_buf()],
            Duration::from_millis(300),
            tx,
        )
        .expect("watcher attached");

        tokio::time::sleep(Duration::from_millis(200)).await;

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

    #[tokio::test(flavor = "multi_thread")]
    async fn watcher_returns_none_when_no_paths_attach() {
        let (tx, mut rx) = mpsc::channel::<LibpathEvent>(16);
        // Non-existent path should fail to attach on all platforms.
        let handle = spawn_watcher(
            vec![PathBuf::from("/raven/nonexistent/xyz-abc")],
            Duration::from_millis(50),
            tx,
        );
        assert!(handle.is_none());
        // Contract: when no paths attach, spawn_watcher must emit Dropped on the
        // provided sender so the backend's consumer can run its recovery path
        // (clear cache, force-republish diagnostics) instead of silently going
        // dark.
        let evt = tokio::time::timeout(Duration::from_millis(200), rx.recv())
            .await
            .expect("Dropped delivered before timeout")
            .expect("channel still open");
        assert!(matches!(evt, LibpathEvent::Dropped));
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
