//! Shared "discover the nearest project config, then load it" seam.
//!
//! The LSP startup path, the watched-files reload, `raven check`, and
//! `raven lint` all need the same sequence: run [`find_config`] from the
//! caller's active project root, then load whichever file it discovered
//! (`raven.toml` beats `.lintr`). Hand-reproducing that match in each site let
//! them drift — notably on which loader reads `.lintr`. [`discover_and_load`]
//! is the single implementation they share.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    ConfigFileKind, DiscoveredConfig, DiscoveryOptions, find_config_with_options, load_lintr,
    load_toml,
};

/// Outcome of discovering and loading a project config from a directory.
///
/// Warnings are *returned*, not emitted, because each caller has its own sink
/// (`log::warn!` in the server, `eprintln!` in the CLI). A discovered-but-
/// unloadable file is [`LoadFailed`](DiscoveredLoad::LoadFailed), distinct from
/// [`None`](DiscoveredLoad::None), so a caller that treats a broken config as an
/// operator error (the CLI) can, while the server collapses both to "no project
/// layer".
#[derive(Debug)]
pub enum DiscoveredLoad {
    /// Neither `raven.toml` nor `.lintr` was found at or above the directory.
    None,
    /// A config file was discovered and parsed.
    Loaded {
        path: PathBuf,
        settings: Value,
        warnings: Vec<String>,
    },
    /// A config file was discovered but could not be read or parsed.
    LoadFailed { path: PathBuf },
}

pub struct LoadedConfig {
    pub settings: Value,
    pub warnings: Vec<String>,
}

pub fn resolve_explicit_config_path(base: &Path, explicit: &Path) -> PathBuf {
    let path = if explicit.is_absolute() {
        explicit.to_path_buf()
    } else {
        base.join(explicit)
    };
    crate::cross_file::normalize_path_public(&path).unwrap_or(path)
}

pub fn load_explicit_config(path: &Path) -> Option<LoadedConfig> {
    load_config_at_path(path)
}

pub fn load_explicit_config_from_base(
    base: &Path,
    explicit: &Path,
) -> Option<(PathBuf, LoadedConfig)> {
    let path = resolve_explicit_config_path(base, explicit);
    load_explicit_config(&path).map(|loaded| (path, loaded))
}

fn load_config_at_path(path: &Path) -> Option<LoadedConfig> {
    let kind = ConfigFileKind::from_path(path).unwrap_or(ConfigFileKind::RavenToml);
    match kind {
        ConfigFileKind::Lintr => load_lintr(path).map(|loaded| LoadedConfig {
            settings: loaded.settings,
            warnings: loaded.warnings,
        }),
        ConfigFileKind::RavenToml => load_toml(path).map(|loaded| LoadedConfig {
            settings: loaded.settings,
            warnings: loaded.warnings,
        }),
    }
}

/// Discover the nearest project config (`raven.toml` beats `.lintr`) at or above
/// `search_start` and load it. The single discovery+load seam shared by the LSP
/// startup path, the watched-files reload, `raven check`, and `raven lint`, so
/// they can't drift on discovery precedence or which loader reads each file.
pub fn discover_and_load(search_start: &Path) -> DiscoveredLoad {
    discover_and_load_with_options(search_start, &DiscoveryOptions::default())
}

pub fn discover_and_load_with_options(
    search_start: &Path,
    options: &DiscoveryOptions,
) -> DiscoveredLoad {
    match find_config_with_options(search_start, options) {
        DiscoveredConfig::RavenToml(path) | DiscoveredConfig::Lintr(path) => {
            match load_config_at_path(&path) {
                Some(loaded) => DiscoveredLoad::Loaded {
                    path,
                    settings: loaded.settings,
                    warnings: loaded.warnings,
                },
                None => DiscoveredLoad::LoadFailed { path },
            }
        }
        DiscoveredConfig::None => DiscoveredLoad::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn none_when_no_config() {
        let tmp = TempDir::new().unwrap();
        assert!(matches!(
            discover_and_load(tmp.path()),
            DiscoveredLoad::None
        ));
    }

    #[test]
    fn loaded_for_raven_toml() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("raven.toml"), "[linting]\nenabled = true\n").unwrap();
        match discover_and_load(tmp.path()) {
            DiscoveredLoad::Loaded { path, settings, .. } => {
                assert_eq!(path, tmp.path().join("raven.toml"));
                assert!(settings.get("linting").is_some());
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[test]
    fn loaded_for_lintr() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join(".lintr"),
            "linters: linters_with_defaults()\n",
        )
        .unwrap();
        assert!(matches!(
            discover_and_load(tmp.path()),
            DiscoveredLoad::Loaded { .. }
        ));
    }

    #[test]
    fn load_failed_for_malformed_raven_toml() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("raven.toml"), "not valid = = toml [[[\n").unwrap();
        match discover_and_load(tmp.path()) {
            DiscoveredLoad::LoadFailed { path } => {
                assert_eq!(path, tmp.path().join("raven.toml"))
            }
            other => panic!("expected LoadFailed, got {other:?}"),
        }
    }
}
