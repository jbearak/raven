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

    let raw_rx = Arc::new(StdMutex::new(raw_rx));
    let snapshot = Arc::new(tokio::sync::Mutex::new(LibpathSnapshot::capture(&attached)));

    let task = tokio::spawn(async move {
        debounce_loop(raw_rx, snapshot, attached, debounce, tx).await;
    });

    Some(LibpathWatcherHandle {
        _watcher: watcher,
        task,
    })
}

async fn debounce_loop(
    raw_rx: Arc<StdMutex<std::sync::mpsc::Receiver<notify::Result<notify::Event>>>>,
    snapshot: Arc<tokio::sync::Mutex<LibpathSnapshot>>,
    paths: Vec<PathBuf>,
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
            Ok(Ok(_evt)) => {
                // Got an event; now drain any further events within debounce window.
                tokio::time::sleep(debounce).await;
                let rx_arc = Arc::clone(&raw_rx);
                let _drained = tokio::task::spawn_blocking(move || {
                    let guard = rx_arc.lock().unwrap();
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

    #[tokio::test]
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
