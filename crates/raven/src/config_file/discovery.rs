//! Walk upward from a starting directory looking for raven.toml or .lintr.

use std::path::{Path, PathBuf};

/// Result of a config-file discovery walk.
#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveredConfig {
    RavenToml(PathBuf),
    Lintr(PathBuf),
    None,
}

/// Walk upward from `start` (inclusive) toward the filesystem root, returning
/// the first `raven.toml` found. If none is found, return the first `.lintr`
/// found on the same walk. Walks at most `MAX_DEPTH` levels.
///
/// The walk is **lexical**: it consults `Path::parent` without canonicalizing
/// symlinks, so opening a symlinked workspace searches the link's parent
/// chain rather than the real parent chain. Infinite loops are impossible
/// because of the `MAX_DEPTH` bound, but if a user reports surprising
/// discovery behavior across symlinks, the canonicalize-once fix lives here.
const MAX_DEPTH: usize = 32;

pub fn find_config(start: &Path) -> DiscoveredConfig {
    let mut current: Option<&Path> = Some(start);
    let mut lintr_fallback: Option<PathBuf> = None;
    let mut depth = 0;

    while let Some(dir) = current {
        if depth >= MAX_DEPTH {
            break;
        }
        let candidate = dir.join("raven.toml");
        if candidate.is_file() {
            return DiscoveredConfig::RavenToml(candidate);
        }
        if lintr_fallback.is_none() {
            let lintr = dir.join(".lintr");
            if lintr.is_file() {
                lintr_fallback = Some(lintr);
            }
        }
        current = dir.parent();
        depth += 1;
    }

    match lintr_fallback {
        Some(p) => DiscoveredConfig::Lintr(p),
        None => DiscoveredConfig::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn finds_raven_toml_in_start_dir() {
        let tmp = TempDir::new().unwrap();
        let toml = tmp.path().join("raven.toml");
        fs::write(&toml, "").unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::RavenToml(toml));
    }

    #[test]
    fn finds_raven_toml_in_parent_dir() {
        let tmp = TempDir::new().unwrap();
        let toml = tmp.path().join("raven.toml");
        fs::write(&toml, "").unwrap();
        let sub = tmp.path().join("src");
        fs::create_dir(&sub).unwrap();
        assert_eq!(find_config(&sub), DiscoveredConfig::RavenToml(toml));
    }

    #[test]
    fn falls_back_to_lintr_when_no_raven_toml() {
        let tmp = TempDir::new().unwrap();
        let lintr = tmp.path().join(".lintr");
        fs::write(&lintr, "linters: linters_with_defaults()\n").unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::Lintr(lintr));
    }

    #[test]
    fn raven_toml_wins_over_lintr_at_same_level() {
        let tmp = TempDir::new().unwrap();
        let toml = tmp.path().join("raven.toml");
        let lintr = tmp.path().join(".lintr");
        fs::write(&toml, "").unwrap();
        fs::write(&lintr, "linters: linters_with_defaults()\n").unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::RavenToml(toml));
    }

    #[test]
    fn returns_none_when_neither_present() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(find_config(tmp.path()), DiscoveredConfig::None);
    }
}
