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
