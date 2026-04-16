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
