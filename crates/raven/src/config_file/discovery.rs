//! Walk upward from a starting directory looking for raven.toml or .lintr.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFileKind {
    RavenToml,
    Lintr,
}

impl ConfigFileKind {
    pub const ALL: [Self; 2] = [Self::RavenToml, Self::Lintr];

    pub fn from_path(path: &Path) -> Option<Self> {
        match path.file_name() {
            Some(name) if name == OsStr::new(Self::RavenToml.file_name()) => Some(Self::RavenToml),
            Some(name) if name == OsStr::new(Self::Lintr.file_name()) => Some(Self::Lintr),
            _ => None,
        }
    }

    /// True when `path`'s file name is `.lintr`.
    pub fn is_lintr_path(path: &Path) -> bool {
        Self::from_path(path) == Some(Self::Lintr)
    }

    pub fn file_name(self) -> &'static str {
        match self {
            Self::RavenToml => "raven.toml",
            Self::Lintr => ".lintr",
        }
    }

    pub fn source_name(self) -> &'static str {
        self.file_name()
    }
}

/// Result of a config-file discovery walk.
#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveredConfig {
    RavenToml(PathBuf),
    Lintr(PathBuf),
    None,
}

/// Walk upward from `start` (inclusive) toward the filesystem root, returning
/// the first `raven.toml` found. If none is found, return the first `.lintr`
/// allowed by [`DiscoveryOptions`] on the same walk. The default options skip
/// the literal home-directory `.lintr`; workspace and non-home ancestor `.lintr`
/// files are still eligible. Walks at most `MAX_DEPTH` levels.
///
/// The walk is **lexical**: it consults `Path::parent` without canonicalizing
/// symlinks, so opening a symlinked workspace searches the link's parent
/// chain rather than the real parent chain. Infinite loops are impossible
/// because of the `MAX_DEPTH` bound, but if a user reports surprising
/// discovery behavior across symlinks, the canonicalize-once fix lives here.
pub(crate) const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryOptions {
    read_home_lintr: bool,
    home_dir: Option<PathBuf>,
}

impl DiscoveryOptions {
    pub fn for_home_lintr(read_home_lintr: bool) -> Self {
        Self {
            read_home_lintr,
            home_dir: default_home_dir().map(|home| normalize_config_identity_path(&home)),
        }
    }

    pub fn from_client_settings(raw_client: &serde_json::Value) -> Self {
        let read_home_lintr = raw_client
            .get("linting")
            .and_then(|l| l.get("readHomeLintr"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Self::for_home_lintr(read_home_lintr)
    }

    pub fn with_home_dir(mut self, home_dir: &Path) -> Self {
        self.home_dir = Some(normalize_config_identity_path(home_dir));
        self
    }

    pub fn read_home_lintr(&self) -> bool {
        self.read_home_lintr
    }

    pub fn allows_config_path(&self, path: &Path) -> bool {
        match ConfigFileKind::from_path(path) {
            Some(ConfigFileKind::RavenToml) => true,
            Some(ConfigFileKind::Lintr) => self.allows_lintr_path(path),
            None => false,
        }
    }

    pub fn is_home_lintr_path(&self, path: &Path) -> bool {
        if !ConfigFileKind::is_lintr_path(path) {
            return false;
        }
        let candidate = normalize_config_identity_path(path);
        self.home_dir.as_deref().is_some_and(|home| {
            candidate
                == normalize_config_identity_path(&home.join(ConfigFileKind::Lintr.file_name()))
        })
    }

    fn allows_lintr_path(&self, path: &Path) -> bool {
        if self.read_home_lintr {
            return true;
        }
        !self.is_home_lintr_path(path)
    }
}

impl Default for DiscoveryOptions {
    fn default() -> Self {
        Self::for_home_lintr(false)
    }
}

fn default_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn normalize_config_identity_path(path: &Path) -> PathBuf {
    crate::cross_file::normalize_path_public(path).unwrap_or_else(|| path.to_path_buf())
}

pub fn find_config(start: &Path) -> DiscoveredConfig {
    find_config_with_options(start, &DiscoveryOptions::default())
}

pub(crate) fn ancestor_dirs(start: &Path) -> impl Iterator<Item = &Path> {
    std::iter::successors(Some(start), |dir| dir.parent()).take(MAX_DEPTH)
}

pub fn find_config_with_options(start: &Path, options: &DiscoveryOptions) -> DiscoveredConfig {
    let mut lintr_fallback: Option<PathBuf> = None;

    for dir in ancestor_dirs(start) {
        let candidate = dir.join(ConfigFileKind::RavenToml.file_name());
        if candidate.is_file() {
            return DiscoveredConfig::RavenToml(candidate);
        }
        if lintr_fallback.is_none() {
            let lintr = dir.join(ConfigFileKind::Lintr.file_name());
            if lintr.is_file() && options.allows_lintr_path(&lintr) {
                lintr_fallback = Some(lintr);
            }
        }
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

    #[test]
    fn config_file_kind_rejects_non_config_file_names() {
        assert_eq!(
            ConfigFileKind::from_path(Path::new("raven.toml")),
            Some(ConfigFileKind::RavenToml)
        );
        assert_eq!(
            ConfigFileKind::from_path(Path::new(".lintr")),
            Some(ConfigFileKind::Lintr)
        );
        for path in [
            "foo.R",
            ".lintr.bak",
            "raven.toml.bak",
            "nested/raven.toml.tmp",
            "nested/not.lintr",
        ] {
            assert_eq!(ConfigFileKind::from_path(Path::new(path)), None, "{path}");
        }
    }

    #[test]
    fn skips_literal_home_lintr_when_home_lintr_disabled() {
        let home = TempDir::new().unwrap();
        let workspace = home.path().join("project");
        fs::create_dir(&workspace).unwrap();
        fs::write(
            home.path().join(".lintr"),
            "linters: linters_with_defaults(line_length_linter(120))\n",
        )
        .unwrap();

        let options = DiscoveryOptions::for_home_lintr(false).with_home_dir(home.path());

        assert_eq!(
            find_config_with_options(&workspace, &options),
            DiscoveredConfig::None
        );
    }

    #[test]
    fn home_lintr_identity_normalizes_dotdot_spellings() {
        let home = TempDir::new().unwrap();
        let nested = home.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let home_spelling = nested.join("..");
        let lintr_spelling = nested.join("..").join(".lintr");

        let options = DiscoveryOptions::for_home_lintr(false).with_home_dir(&home_spelling);

        assert!(options.is_home_lintr_path(&home.path().join(".lintr")));
        assert!(options.is_home_lintr_path(&lintr_spelling));
        assert!(
            !options.allows_config_path(&lintr_spelling),
            "disabled literal home .lintr must be rejected even when the path spelling differs"
        );
    }

    #[test]
    fn reads_literal_home_lintr_when_home_lintr_enabled() {
        let home = TempDir::new().unwrap();
        let workspace = home.path().join("project");
        fs::create_dir(&workspace).unwrap();
        let lintr = home.path().join(".lintr");
        fs::write(
            &lintr,
            "linters: linters_with_defaults(line_length_linter(120))\n",
        )
        .unwrap();

        let options = DiscoveryOptions::for_home_lintr(true).with_home_dir(home.path());

        assert_eq!(
            find_config_with_options(&workspace, &options),
            DiscoveredConfig::Lintr(lintr)
        );
    }

    #[test]
    fn still_reads_non_home_parent_lintr_when_home_lintr_disabled() {
        let configured_home = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        let workspace = repo.path().join("project");
        fs::create_dir(&workspace).unwrap();
        let lintr = repo.path().join(".lintr");
        fs::write(
            &lintr,
            "linters: linters_with_defaults(line_length_linter(120))\n",
        )
        .unwrap();

        let options = DiscoveryOptions::for_home_lintr(false).with_home_dir(configured_home.path());

        assert_eq!(
            find_config_with_options(&workspace, &options),
            DiscoveredConfig::Lintr(lintr)
        );
    }

    #[test]
    fn client_setting_defaults_home_lintr_off() {
        assert!(!DiscoveryOptions::from_client_settings(&serde_json::json!({})).read_home_lintr());
        assert!(
            !DiscoveryOptions::from_client_settings(
                &serde_json::json!({ "linting": { "readHomeLintr": false } })
            )
            .read_home_lintr()
        );
        assert!(
            DiscoveryOptions::from_client_settings(
                &serde_json::json!({ "linting": { "readHomeLintr": true } })
            )
            .read_home_lintr()
        );
    }

    #[test]
    fn default_home_lintr_policy_uses_process_home_dir() {
        let expected_home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .map(|home| normalize_config_identity_path(&home));
        let options = DiscoveryOptions::default();

        assert_eq!(options.home_dir, expected_home);
        assert!(!options.read_home_lintr());
        if let Some(home) = options.home_dir.as_deref() {
            assert!(
                !options.allows_config_path(&home.join(ConfigFileKind::Lintr.file_name())),
                "default discovery must reject literal home .lintr"
            );
        }
    }
}
