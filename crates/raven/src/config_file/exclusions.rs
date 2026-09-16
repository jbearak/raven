//! Compiled project-level workspace exclusions.
//!
//! These exclusions are intentionally separate from lint overrides: they remove
//! files from workspace discovery/indexing and default CLI discovery, not just
//! lint diagnostics.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use globset::{Glob, GlobBuilder, GlobMatcher};
use serde_json::Value;
use tower_lsp::lsp_types::Url;

#[derive(Debug, Clone)]
struct ExclusionRule {
    negated: bool,
    matcher: GlobMatcher,
    prune_matchers: Vec<GlobMatcher>,
}

/// Compiled `[workspace].exclude` matcher.
///
/// Patterns are evaluated in order against paths relative to the containing
/// workspace root; the last matching pattern wins. A leading `!` negates a
/// pattern and re-includes matching paths. Directory pruning is disabled
/// whenever any negated pattern is present, so a re-included descendant is never
/// skipped by an ancestor-directory prune.
#[derive(Debug, Clone, Default)]
pub struct CompiledWorkspaceExclusions {
    roots: Vec<PathBuf>,
    patterns: Vec<String>,
    rules: Vec<ExclusionRule>,
    has_negation: bool,
    respect_gitignore: bool,
    gitignore: Arc<crate::discovery::GitignoreSnapshot>,
}

impl PartialEq for CompiledWorkspaceExclusions {
    fn eq(&self, other: &Self) -> bool {
        self.same_discovery_inputs(other) && self.discovery_revision() == other.discovery_revision()
    }
}
impl Eq for CompiledWorkspaceExclusions {}

impl CompiledWorkspaceExclusions {
    pub fn respect_gitignore(&self) -> bool {
        self.respect_gitignore
    }

    /// Discovery-only rule evaluation. Never use this for explicit source
    /// edges or to mark graph edges non-lending.
    pub fn is_gitignored(&self, path: &Path, directory: bool) -> bool {
        self.respect_gitignore && self.gitignore.is_ignored(path, directory)
    }

    pub fn is_gitignored_uri(&self, uri: &Url) -> bool {
        uri.to_file_path()
            .ok()
            .is_some_and(|path| self.is_gitignored(&path, false))
    }

    pub(crate) fn is_automatic_discovery_uri(&self, uri: &Url) -> bool {
        let Ok(path) = uri.to_file_path() else {
            return false;
        };
        let relative = self.gitignore.relative_workspace_path(&path).or_else(|| {
            self.roots
                .iter()
                .filter_map(|root| path.strip_prefix(root).ok())
                .min_by_key(|relative| relative.components().count())
        });
        let Some(relative) = relative else {
            return false;
        };
        !relative.parent().is_some_and(|parent| {
            parent.components().any(|component| {
                component
                    .as_os_str()
                    .to_str()
                    .is_some_and(crate::state::should_skip_directory)
            })
        }) && !self.is_gitignored(&path, false)
            && !self.is_excluded_path(&path)
    }

    /// An explicitly requested directory outside the workspace has its own
    /// bounded Git context. Project exclusions stay rooted in the workspace.
    pub(crate) fn for_discovery_directory<'a>(&'a self, directory: &Path) -> Cow<'a, Self> {
        if !self.respect_gitignore || self.gitignore.relative_workspace_path(directory).is_some() {
            return Cow::Borrowed(self);
        }
        let mut policy = self.clone();
        policy.gitignore = Arc::new(crate::discovery::GitignoreSnapshot::build_with_pruning(
            &[directory.to_path_buf()],
            |_| false,
        ));
        Cow::Owned(policy)
    }

    pub(crate) fn discovery_revision(&self) -> u64 {
        self.gitignore.revision()
    }

    pub(crate) fn ancestor_ignore_files(&self) -> &[PathBuf] {
        &self.gitignore.ancestor_files
    }

    pub(crate) fn gitignore_event_affects_discovery(&self, path: &Path) -> bool {
        self.respect_gitignore
            && path.file_name().is_some_and(|name| name == ".gitignore")
            && self.gitignore.watches(path)
            && !path
                .parent()
                .is_some_and(|parent| self.can_prune_directory(parent))
    }

    /// Read ignore files once for a new immutable discovery generation. Call
    /// off state locks, then install through the state's policy-swap seam.
    pub fn refresh_gitignore(&mut self) {
        self.gitignore = Arc::new(if self.respect_gitignore {
            crate::discovery::GitignoreSnapshot::build_with_pruning(&self.roots, |path| {
                self.can_prune_directory(path)
            })
        } else {
            crate::discovery::GitignoreSnapshot::default()
        });
    }

    pub(crate) fn inherit_gitignore(&mut self, previous: &Self) {
        if self.roots == previous.roots {
            self.gitignore = previous.gitignore.clone();
        }
    }

    pub(crate) fn install_gitignore(&mut self, refreshed: &Self) {
        self.gitignore = refreshed.gitignore.clone();
    }

    pub(crate) fn same_discovery_inputs(&self, other: &Self) -> bool {
        self.roots == other.roots
            && self.respect_gitignore == other.respect_gitignore
            && self.patterns == other.patterns
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }

    pub fn has_negation(&self) -> bool {
        self.has_negation
    }

    /// Returns true when `path` is excluded by the last matching rule.
    pub fn is_excluded_path(&self, path: &Path) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let Some(rel) = self.relative_path(path) else {
            return false;
        };
        if rel.as_ref().as_os_str().is_empty() {
            return false;
        }

        let mut excluded = false;
        for rule in &self.rules {
            if rule.matcher.is_match(rel.as_ref()) {
                excluded = !rule.negated;
            }
        }
        excluded
    }

    pub fn is_excluded_uri(&self, uri: &Url) -> bool {
        if self.is_empty() {
            return false;
        }
        uri.to_file_path()
            .ok()
            .is_some_and(|path| self.is_excluded_path(&path))
    }

    /// Returns true when a directory can be pruned before walking descendants.
    ///
    /// This is deliberately stricter than [`Self::is_excluded_path`]: a file
    /// pattern that matches the directory path itself does not prove every child
    /// is excluded. Only directory-glob patterns normalized to `dir/**` (or a
    /// wildcard equivalent such as `**/generated/**`) produce prune matchers.
    /// Any negated rule disables pruning globally.
    pub fn can_prune_directory(&self, dir: &Path) -> bool {
        if self.rules.is_empty() || self.has_negation {
            return false;
        }
        let Some(rel) = self.relative_path(dir) else {
            return false;
        };
        if rel.as_ref().as_os_str().is_empty() {
            return false;
        }
        self.rules.iter().any(|rule| {
            !rule.negated
                && rule
                    .prune_matchers
                    .iter()
                    .any(|matcher| matcher.is_match(rel.as_ref()))
        })
    }

    /// Return `path` relative to the nearest configured workspace root.
    ///
    /// The serial workspace walk hands this matcher paths produced by joining
    /// entries onto the stored workspace root, so root and input already share
    /// spelling and the raw `strip_prefix` result is authoritative. The
    /// canonicalized fallback exists only for watched/incremental paths
    /// (`event.rs` `translate_watched`, backend on-demand indexing) whose URIs
    /// may arrive under a symlinked or differently-spelled root. It affects
    /// matcher input normalization only; index and graph keys remain
    /// uncanonicalized.
    fn relative_path<'a>(&'a self, path: &'a Path) -> Option<Cow<'a, Path>> {
        if let Some(rel) = self
            .roots
            .iter()
            .filter_map(|root| path.strip_prefix(root).ok())
            .min_by_key(|rel| rel.components().count())
        {
            return Some(Cow::Borrowed(rel));
        }

        let canonical_path = canonicalize_existing_or_parent(path)?;
        self.roots
            .iter()
            .filter_map(|root| {
                let canonical_root = root.canonicalize().ok()?;
                canonical_path
                    .strip_prefix(&canonical_root)
                    .ok()
                    .map(Path::to_path_buf)
            })
            .min_by_key(|rel| rel.components().count())
            .map(Cow::Owned)
    }
}

fn canonicalize_existing_or_parent(path: &Path) -> Option<PathBuf> {
    path.canonicalize()
        .ok()
        .or_else(|| match (path.parent(), path.file_name()) {
            (Some(parent), Some(name)) => {
                parent.canonicalize().ok().map(|parent| parent.join(name))
            }
            _ => None,
        })
}

/// Build compiled workspace exclusions from `[workspace].exclude`.
///
/// `roots` are the workspace roots against which project-relative patterns are
/// matched. Invalid globs are skipped with a warning.
pub fn compile_workspace_exclusions(
    merged: &Value,
    roots: impl IntoIterator<Item = PathBuf>,
) -> CompiledWorkspaceExclusions {
    let roots: Vec<PathBuf> = roots.into_iter().collect();
    if roots.is_empty() {
        return CompiledWorkspaceExclusions::default();
    }

    let arr = merged
        .get("workspace")
        .and_then(|v| v.get("exclude"))
        .and_then(|v| v.as_array());

    let mut patterns = Vec::new();
    let mut rules = Vec::new();
    let mut has_negation = false;

    for raw in arr.into_iter().flatten() {
        let Some(raw) = raw.as_str() else {
            log::warn!("raven.toml: workspace.exclude entries must be strings; skipping {raw:?}");
            continue;
        };
        let Some((negated, pattern)) = normalize_pattern(raw) else {
            continue;
        };
        let glob = match workspace_glob(&pattern) {
            Ok(glob) => glob,
            Err(err) => {
                log::warn!("raven.toml: invalid workspace.exclude glob {raw:?}: {err}");
                continue;
            }
        };
        let prune_matchers = if negated {
            Vec::new()
        } else {
            compile_prune_matchers(&pattern)
        };
        has_negation |= negated;
        patterns.push(if negated {
            format!("!{pattern}")
        } else {
            pattern.clone()
        });
        rules.push(ExclusionRule {
            negated,
            matcher: glob.compile_matcher(),
            prune_matchers,
        });
    }

    CompiledWorkspaceExclusions {
        roots,
        patterns,
        rules,
        has_negation,
        respect_gitignore: merged
            .get("workspace")
            .and_then(|value| value.get("respectGitignore"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        gitignore: Arc::default(),
    }
}

fn normalize_pattern(raw: &str) -> Option<(bool, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (negated, body) = match trimmed.strip_prefix('!') {
        Some(rest) => (true, rest.trim()),
        None => (false, trimmed),
    };
    if body.is_empty() {
        return None;
    }
    let body = body.strip_prefix("./").unwrap_or(body);
    let pattern = if body.ends_with('/') {
        format!("{body}**")
    } else {
        body.to_string()
    };
    Some((negated, pattern))
}

fn workspace_glob(pattern: &str) -> Result<Glob, globset::Error> {
    GlobBuilder::new(pattern).literal_separator(true).build()
}

fn compile_prune_matchers(pattern: &str) -> Vec<GlobMatcher> {
    let Some(prefix) = pattern.strip_suffix("/**") else {
        return Vec::new();
    };
    if prefix.is_empty() {
        return Vec::new();
    }

    let mut matchers = Vec::new();
    if let Ok(glob) = workspace_glob(prefix) {
        matchers.push(glob.compile_matcher());
    }
    if let Some(stripped) = prefix.strip_prefix("**/")
        && !stripped.is_empty()
        && let Ok(glob) = workspace_glob(stripped)
    {
        matchers.push(glob.compile_matcher());
    }
    matchers
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_exclusions_do_not_exclude_file_uri() {
        let cfg = CompiledWorkspaceExclusions::default();
        let uri = Url::from_file_path(std::env::temp_dir().join("anything.R")).unwrap();

        assert!(cfg.is_empty());
        assert!(!cfg.is_excluded_uri(&uri));
    }

    #[test]
    fn last_match_wins_with_negation() {
        let root = PathBuf::from("/workspace");
        let cfg = compile_workspace_exclusions(
            &json!({ "workspace": { "exclude": ["generated/**", "!generated/keep.R"] } }),
            vec![root.clone()],
        );

        assert!(cfg.is_excluded_path(&root.join("generated/drop.R")));
        assert!(!cfg.is_excluded_path(&root.join("generated/keep.R")));
        assert!(cfg.has_negation());
        assert!(
            !cfg.can_prune_directory(&root.join("generated")),
            "negated re-includes disable directory pruning"
        );
    }

    #[test]
    fn directory_glob_prunes_without_negation() {
        let root = PathBuf::from("/workspace");
        let cfg = compile_workspace_exclusions(
            &json!({ "workspace": { "exclude": ["generated/**"] } }),
            vec![root.clone()],
        );

        assert!(cfg.can_prune_directory(&root.join("generated")));
        assert!(cfg.is_excluded_path(&root.join("generated/drop.R")));
        assert!(!cfg.is_excluded_path(&root.join("other/generated/drop.R")));
    }

    #[test]
    fn single_star_does_not_cross_directory_separator() {
        let root = PathBuf::from("/workspace");
        let cfg = compile_workspace_exclusions(
            &json!({ "workspace": { "exclude": ["generated/*"] } }),
            vec![root.clone()],
        );

        assert!(cfg.is_excluded_path(&root.join("generated/file.R")));
        assert!(
            !cfg.is_excluded_path(&root.join("generated/nested/file.R")),
            "single-star globs must not match through '/'"
        );
    }

    #[test]
    fn double_star_crosses_directory_separator() {
        let root = PathBuf::from("/workspace");
        let cfg = compile_workspace_exclusions(
            &json!({ "workspace": { "exclude": ["generated/**"] } }),
            vec![root.clone()],
        );

        assert!(cfg.is_excluded_path(&root.join("generated/file.R")));
        assert!(cfg.is_excluded_path(&root.join("generated/nested/file.R")));
    }

    #[test]
    fn recursive_directory_glob_prunes_any_matching_directory() {
        let root = PathBuf::from("/workspace");
        let cfg = compile_workspace_exclusions(
            &json!({ "workspace": { "exclude": ["**/generated/**"] } }),
            vec![root.clone()],
        );

        assert!(cfg.can_prune_directory(&root.join("generated")));
        assert!(cfg.can_prune_directory(&root.join("pkg/generated")));
        assert!(cfg.is_excluded_path(&root.join("pkg/generated/file.R")));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_spelled_watched_path_uses_canonical_fallback() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::TempDir::new().unwrap();
        let real_root = tmp.path().join("real");
        let link_root = tmp.path().join("link");
        std::fs::create_dir_all(real_root.join("generated")).unwrap();
        symlink(&real_root, &link_root).unwrap();

        let excluded = real_root.join("generated/drop.R");
        std::fs::write(&excluded, "drop <- 1\n").unwrap();
        let missing = real_root.join("generated/missing.R");
        let cfg = compile_workspace_exclusions(
            &json!({ "workspace": { "exclude": ["generated/**"] } }),
            vec![link_root],
        );

        assert!(cfg.is_excluded_path(&excluded));
        assert!(cfg.is_excluded_path(&missing));
    }
}
