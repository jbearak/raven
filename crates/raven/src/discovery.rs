//! Immutable, discovery-only `.gitignore` policy. Building a snapshot performs
//! filesystem I/O; querying it never does. Explicit files and source edges must
//! not consult this policy. Each workspace inherits rules only up to its nearest
//! `.git` marker (or starts at itself), and the deepest workspace owns a path.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

/// Reachability is ownership, not scope lending: forward directives/calls own
/// their targets and backward directives own their parents. Even a non-lending
/// edge from an excluded open buffer must keep its explicitly consumed target.
pub(crate) fn owned_files(
    graph: &crate::cross_file::dependency::DependencyGraph,
    roots: impl IntoIterator<Item = tower_lsp::lsp_types::Url>,
) -> HashSet<tower_lsp::lsp_types::Url> {
    let mut owned = HashSet::new();
    let mut pending: Vec<_> = roots.into_iter().collect();
    while let Some(uri) = pending.pop() {
        if !owned.insert(uri.clone()) {
            continue;
        }
        pending.extend(
            graph
                .get_dependencies(&uri)
                .into_iter()
                .filter(|edge| !edge.is_backward_directive)
                .map(|edge| edge.to.clone()),
        );
        pending.extend(
            graph
                .get_dependents(&uri)
                .into_iter()
                .filter(|edge| edge.is_backward_directive)
                .map(|edge| edge.from.clone()),
        );
    }
    owned
}

#[derive(Debug)]
struct Rules {
    matcher: Arc<Gitignore>,
    directory: PathBuf,
    parent: Option<Arc<Rules>>,
}

impl Rules {
    fn ignores(&self, path: &Path, directory: bool) -> bool {
        match self.matcher.matched(
            path.strip_prefix(&self.directory).unwrap_or(path),
            directory,
        ) {
            ignore::Match::Ignore(_) => true,
            ignore::Match::Whitelist(_) => false,
            ignore::Match::None => self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.ignores(path, directory)),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Context {
    rules: Option<Arc<Rules>>,
    ignored: bool,
}

/// Build-local cache, including missing, empty, unreadable, and invalid files.
/// Canonical directory keys make overlapping roots share both matchers and
/// failures, so each physical ignore file is read and warned about at most once
/// per generation. Matchers have no lexical base; each context supplies its own.
type IgnoreFileCache = HashMap<PathBuf, Option<Arc<Gitignore>>>;

fn load_ignore_matcher(directory: &Path) -> Option<Arc<Gitignore>> {
    let path = directory.join(".gitignore");
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_file() => {}
        Ok(_) => return None, // Git does not follow symlinked ignore files.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            log::warn!("Cannot read {}: {err}", path.display());
            return None;
        }
    }
    let mut builder = GitignoreBuilder::new("");
    // `add` preserves successfully parsed lines on a partial error. Report any
    // read/parse and compilation failures together so one file warns only once.
    let parse_error = builder.add(&path);
    match builder.build() {
        Ok(matcher) => {
            if let Some(err) = parse_error {
                log::warn!("Cannot fully read {}: {err}", path.display());
            }
            (!matcher.is_empty()).then(|| Arc::new(matcher))
        }
        Err(err) => {
            if let Some(parse_error) = parse_error {
                log::warn!("Cannot compile {}: {parse_error}; {err}", path.display());
            } else {
                log::warn!("Cannot compile {}: {err}", path.display());
            }
            None
        }
    }
}

impl Context {
    fn ignores(&self, path: &Path, directory: bool) -> bool {
        self.ignored
            || self
                .rules
                .as_ref()
                .is_some_and(|rules| rules.ignores(path, directory))
    }

    fn child(&self, path: &Path) -> Self {
        Self {
            rules: self.rules.clone(),
            ignored: self.ignores(path, true),
        }
    }

    fn load(&mut self, directory: &Path, physical: &Path, cache: &mut IgnoreFileCache) {
        if self.ignored {
            return;
        }
        if let Some(matcher) = cache
            .entry(physical.to_path_buf())
            .or_insert_with(|| load_ignore_matcher(directory))
        {
            self.rules = Some(Arc::new(Rules {
                matcher: matcher.clone(),
                directory: directory.to_path_buf(),
                parent: self.rules.clone(),
            }));
        }
    }
}

#[derive(Debug)]
struct Root {
    path: PathBuf,
    canonical: PathBuf,
    contexts: HashMap<PathBuf, Context>,
    matchers: HashMap<PathBuf, Arc<Gitignore>>,
    aliases: HashMap<PathBuf, PathBuf>,
}

impl Root {
    fn context(&self, directory: &Path) -> Context {
        if let Some(context) = self.contexts.get(directory) {
            return context.clone();
        }
        // Newly created or pruned directories inherit existing rules until the
        // next filesystem refresh. No disk reads occur on request/lock paths.
        let mut context = directory
            .parent()
            .filter(|parent| parent.starts_with(&self.path))
            .map(|parent| self.context(parent).child(directory))
            .unwrap_or_default();
        if !context.ignored {
            let mut physical = directory.to_path_buf();
            let mut seen = HashSet::new();
            while seen.insert(physical.clone()) {
                let next = physical.ancestors().find_map(|ancestor| {
                    self.aliases
                        .get(ancestor)
                        .map(|target| target.join(physical.strip_prefix(ancestor).unwrap()))
                });
                match next {
                    Some(next) if next != physical => physical = next,
                    _ => break,
                }
            }
            if let Some(matcher) = self.matchers.get(&physical) {
                context.rules = Some(Arc::new(Rules {
                    matcher: matcher.clone(),
                    directory: directory.to_path_buf(),
                    parent: context.rules,
                }));
            }
        }
        context
    }
}

#[derive(Debug, Default)]
pub(crate) struct GitignoreSnapshot {
    roots: Vec<Root>,
    revision: u64,
    /// Exact ancestor locations, including missing files; roots are watched
    /// recursively by the client separately.
    pub(crate) ancestor_files: Vec<PathBuf>,
    ancestor_aliases: HashSet<PathBuf>,
}

impl GitignoreSnapshot {
    #[cfg(test)]
    pub(crate) fn build(roots: &[PathBuf]) -> Self {
        Self::build_with_pruning(roots, |_| false)
    }

    pub(crate) fn build_with_pruning(roots: &[PathBuf], prune: impl Fn(&Path) -> bool) -> Self {
        let mut snapshot = Self {
            revision: NEXT_REVISION.fetch_add(1, Ordering::Relaxed),
            ..Self::default()
        };
        let mut ignore_files = IgnoreFileCache::new();
        for path in roots {
            let canonical_root = path.canonicalize().unwrap_or_else(|_| path.clone());
            let boundary = path
                .ancestors()
                .find(|ancestor| ancestor.join(".git").exists())
                .unwrap_or(path);
            let mut lineage: Vec<_> = path
                .ancestors()
                .take_while(|ancestor| ancestor.starts_with(boundary))
                .collect();
            lineage.reverse();
            let mut context = Context::default();
            for (index, directory) in lineage.iter().enumerate() {
                if index != 0 {
                    context = context.child(directory);
                }
                let canonical = if *directory == path {
                    Some(canonical_root.clone())
                } else {
                    directory.canonicalize().ok()
                };
                if *directory != path {
                    snapshot.ancestor_files.push(directory.join(".gitignore"));
                    if let Some(canonical) = &canonical {
                        snapshot
                            .ancestor_aliases
                            .insert(canonical.join(".gitignore"));
                    }
                }
                context.load(
                    directory,
                    canonical.as_deref().unwrap_or(directory),
                    &mut ignore_files,
                );
            }
            let mut root = Root {
                path: path.clone(),
                canonical: canonical_root,
                contexts: HashMap::new(),
                matchers: HashMap::new(),
                aliases: HashMap::new(),
            };
            root.aliases.insert(path.clone(), root.canonical.clone());
            let mut visited = HashSet::from([root.canonical.clone()]);
            let mut pending = vec![(path.clone(), context)];
            while let Some((directory, context)) = pending.pop() {
                if !context.ignored
                    && let Ok(entries) = fs::read_dir(&directory)
                {
                    for entry in entries.flatten() {
                        let child = entry.path();
                        if !child.is_dir()
                            || prune(&child)
                            || (!package_scan_directory(path, &child)
                                && child
                                    .file_name()
                                    .and_then(|s| s.to_str())
                                    .is_some_and(crate::state::should_skip_directory))
                        {
                            continue;
                        }
                        let mut child_context = context.child(&child);
                        if child_context.ignored {
                            continue;
                        }
                        let Ok(canonical) = child.canonicalize() else {
                            continue;
                        };
                        root.aliases.insert(child.clone(), canonical.clone());
                        // Record physical-parent spelling too: an alternate
                        // outer alias may reach this symlink in a second hop.
                        if let (Some(parent), Some(name)) =
                            (root.aliases.get(&directory).cloned(), child.file_name())
                        {
                            root.aliases.insert(parent.join(name), canonical.clone());
                        }
                        if (!package_scan_directory(path, &child)
                            && canonical
                                .file_name()
                                .and_then(|s| s.to_str())
                                .is_some_and(crate::state::is_vendored_directory))
                            || !visited.insert(canonical.clone())
                        {
                            continue;
                        }
                        child_context.load(&child, &canonical, &mut ignore_files);
                        if let Some(rules) = &child_context.rules
                            && rules.directory == child
                        {
                            root.matchers.insert(canonical, rules.matcher.clone());
                        }
                        pending.push((child, child_context));
                    }
                }
                root.contexts.insert(directory, context);
            }
            snapshot.roots.push(root);
        }
        snapshot
            .roots
            .sort_by_key(|root| std::cmp::Reverse(root.path.components().count()));
        snapshot.ancestor_files.sort();
        snapshot.ancestor_files.dedup();
        snapshot
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn relative_workspace_path<'a>(&self, path: &'a Path) -> Option<&'a Path> {
        self.roots.iter().find_map(|root| {
            path.strip_prefix(&root.path)
                .or_else(|_| path.strip_prefix(&root.canonical))
                .ok()
        })
    }

    pub(crate) fn watches(&self, path: &Path) -> bool {
        if self.ancestor_files.iter().any(|ancestor| ancestor == path)
            || self.ancestor_aliases.contains(path)
        {
            return true;
        }
        let Some(parent) = path.parent() else {
            return false;
        };
        for root in &self.roots {
            let Ok(relative) = parent
                .strip_prefix(&root.path)
                .or_else(|_| parent.strip_prefix(&root.canonical))
            else {
                continue;
            };
            if relative.as_os_str().is_empty() {
                return true;
            }
            let mut directory = root.path.clone();
            for component in relative.components() {
                directory.push(component);
                if !package_scan_directory(&root.path, &directory)
                    && component
                        .as_os_str()
                        .to_str()
                        .is_some_and(crate::state::should_skip_directory)
                {
                    return false;
                }
            }
            return !self.is_ignored(&root.path.join(relative), true);
        }
        false
    }

    pub(crate) fn is_ignored(&self, path: &Path, directory: bool) -> bool {
        for root in &self.roots {
            let relative = path
                .strip_prefix(&root.path)
                .or_else(|_| path.strip_prefix(&root.canonical));
            let Ok(relative) = relative else { continue };
            let path = root.path.join(relative);
            if path == root.path {
                return root.context(&path).ignored;
            }
            return path
                .parent()
                .is_some_and(|parent| root.context(parent).ignores(&path, directory));
        }
        false
    }
}

// These package scanners intentionally visit hidden subdirectories. Other
// hidden/vendor trees retain the workspace walk's existing pruning behavior.
fn package_scan_directory(root: &Path, directory: &Path) -> bool {
    [
        root.join("R"),
        root.join("tests/testthat"),
        root.join("data-raw"),
    ]
    .iter()
    .any(|base| directory.starts_with(base))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn write(root: &Path, name: &str, text: &str) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn nesting_negation_parent_pruning_and_frozen_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root, ".gitignore", "*.R\n!keep.R\nblocked/\n");
        write(root, "nested/.gitignore", "!local.R\n");
        write(root, "blocked/.gitignore", "!escape.R\n");
        let snapshot = GitignoreSnapshot::build(&[root.into()]);
        assert!(snapshot.is_ignored(&root.join("file.R"), false));
        assert!(!snapshot.is_ignored(&root.join("keep.R"), false));
        assert!(!snapshot.is_ignored(&root.join("nested/local.R"), false));
        assert!(!snapshot.is_ignored(&root.join("nested/FILE.r"), false));
        assert!(snapshot.is_ignored(&root.join("blocked/escape.R"), false));
        write(root, ".gitignore", "");
        assert!(snapshot.is_ignored(&root.join("file.R"), false));
        assert!(!GitignoreSnapshot::build(&[root.into()]).is_ignored(&root.join("file.R"), false));
    }

    #[test]
    fn overlapping_roots_share_ancestor_and_nested_matchers() {
        let temp = tempfile::tempdir().unwrap();
        let outer = temp.path();
        let inner = outer.join("nested");
        write(outer, ".git", "gitdir: somewhere\n");
        write(outer, ".gitignore", "*.R\n");
        write(outer, "nested/.gitignore", "!keep.R\n");
        let snapshot = GitignoreSnapshot::build(&[outer.into(), inner.clone()]);
        let outer_root = snapshot
            .roots
            .iter()
            .find(|root| root.path == outer)
            .unwrap();
        let inner_root = snapshot
            .roots
            .iter()
            .find(|root| root.path == inner)
            .unwrap();
        let outer_rules = outer_root.contexts[&inner].rules.as_ref().unwrap();
        let inner_rules = inner_root.contexts[&inner].rules.as_ref().unwrap();
        assert!(Arc::ptr_eq(&outer_rules.matcher, &inner_rules.matcher));
        assert!(Arc::ptr_eq(
            &outer_rules.parent.as_ref().unwrap().matcher,
            &inner_rules.parent.as_ref().unwrap().matcher,
        ));
        assert!(snapshot.is_ignored(&inner.join("hidden.R"), false));
        assert!(!snapshot.is_ignored(&inner.join("keep.R"), false));
    }

    #[test]
    fn ignore_file_cache_keeps_negative_results_until_next_generation() {
        let initial_contents: &[Option<&[u8]>] =
            &[None, Some(b""), Some(b"[z-a]\n"), Some(b"\xff")];
        for contents in initial_contents {
            let temp = tempfile::tempdir().unwrap();
            let directory = temp.path();
            let physical = directory.canonicalize().unwrap();
            if let Some(contents) = contents {
                fs::write(directory.join(".gitignore"), contents).unwrap();
            }
            let mut cache = IgnoreFileCache::new();
            let mut context = Context::default();
            context.load(directory, &physical, &mut cache);
            assert!(cache[&physical].is_none(), "{contents:?}");

            // An overlapping root reuses the failed/empty read, even when the
            // file changes mid-build. A later generation reads the new contents.
            write(directory, ".gitignore", "*.R\n");
            let mut overlapping = Context::default();
            overlapping.load(directory, &physical, &mut cache);
            assert!(!overlapping.ignores(&directory.join("file.R"), false));
            let mut refreshed = Context::default();
            refreshed.load(directory, &physical, &mut IgnoreFileCache::new());
            assert!(refreshed.ignores(&directory.join("file.R"), false));
        }
    }

    #[test]
    fn ancestors_stop_at_nearest_git_marker_and_no_marker_means_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root, ".gitignore", "*.R\n");
        fs::create_dir_all(root.join("repo/sub/work")).unwrap();
        write(root, "repo/.git", "gitdir: somewhere\n");
        write(root, "repo/.gitignore", "*.csv\n");
        write(root, "repo/sub/.gitignore", "!keep.csv\n");
        let workspace = root.join("repo/sub/work");
        let snapshot = GitignoreSnapshot::build(std::slice::from_ref(&workspace));
        assert!(!snapshot.is_ignored(&workspace.join("file.R"), false));
        assert!(snapshot.is_ignored(&workspace.join("file.csv"), false));
        assert!(!snapshot.is_ignored(&workspace.join("keep.csv"), false));
        assert_eq!(
            snapshot.ancestor_files,
            vec![
                root.join("repo/.gitignore"),
                root.join("repo/sub/.gitignore")
            ]
        );
        fs::remove_file(root.join("repo/.git")).unwrap();
        let snapshot = GitignoreSnapshot::build(std::slice::from_ref(&workspace));
        assert!(!snapshot.is_ignored(&workspace.join("file.csv"), false));
        assert!(snapshot.ancestor_files.is_empty());
    }

    #[test]
    fn deepest_workspace_owns_matching() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), ".gitignore", "*.R\n");
        let inner = temp.path().join("inner");
        fs::create_dir(&inner).unwrap();
        let snapshot = GitignoreSnapshot::build(&[temp.path().into(), inner.clone()]);
        assert!(snapshot.is_ignored(&temp.path().join("a.R"), false));
        assert!(!snapshot.is_ignored(&inner.join("a.R"), false));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_ignore_files_are_not_read_and_directory_cycles_terminate() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "rules", "*.R\n");
        std::os::unix::fs::symlink(temp.path().join("rules"), temp.path().join(".gitignore"))
            .unwrap();
        std::os::unix::fs::symlink(temp.path(), temp.path().join("loop")).unwrap();
        let snapshot = GitignoreSnapshot::build(&[temp.path().into()]);
        assert!(!snapshot.is_ignored(&temp.path().join("file.R"), false));
        assert_eq!(snapshot.roots[0].contexts.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn nested_ignore_rules_apply_to_both_symlink_spellings() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "real/nested/.gitignore", "hidden.R\n");
        std::os::unix::fs::symlink(temp.path().join("real"), temp.path().join("alias")).unwrap();
        let snapshot = GitignoreSnapshot::build(&[temp.path().into()]);
        for spelling in ["real", "alias"] {
            assert!(
                snapshot.is_ignored(&temp.path().join(spelling).join("nested/hidden.R"), false)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn chained_directory_aliases_reuse_physical_ignore_rules() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = workspace.path();
        write(outside.path(), ".gitignore", "hidden.R\n");
        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("real/jump")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        let snapshot = GitignoreSnapshot::build(&[root.into()]);
        for spelling in ["real", "alias"] {
            assert!(snapshot.is_ignored(&root.join(spelling).join("jump/hidden.R"), false));
        }
    }

    #[cfg(unix)]
    #[test]
    fn watch_events_accept_canonical_workspace_spelling_and_skip_pruned_trees() {
        let temp = tempfile::tempdir().unwrap();
        write(temp.path(), "real/.gitignore", "generated/\n");
        std::os::unix::fs::symlink(temp.path().join("real"), temp.path().join("alias")).unwrap();
        let snapshot = GitignoreSnapshot::build(&[temp.path().join("alias")]);
        let canonical = temp.path().join("real").canonicalize().unwrap();
        assert!(snapshot.watches(&canonical.join(".gitignore")));
        assert!(snapshot.watches(&canonical.join("new/.gitignore")));
        assert!(!snapshot.watches(&canonical.join("generated/.gitignore")));
        assert!(!snapshot.watches(&canonical.join("node_modules/pkg/.gitignore")));
    }

    fn git(root: &Path) -> Command {
        let mut command = Command::new("git");
        command
            .current_dir(root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .args([
                "-c",
                "core.excludesFile=/dev/null",
                "-c",
                "core.ignorecase=false",
            ]);
        command
    }

    #[test]
    fn decisions_match_git_check_ignore_no_index() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(git(root).args(["init", "-q"]).status().unwrap().success());
        write(
            root,
            ".gitignore",
            "\u{feff}*.R\n!keep.R\n/root.csv\nblocked/\n!blocked/escape.R\nlogs/**\n!logs/\n!logs/keep.txt\nfoo/**/secret*\n\\#literal\n\\!literal\nspace\\ \n*.tmp\n[ab]?.csv\n",
        );
        write(
            root,
            "nested/.gitignore",
            "!local.R\n*.txt\n!keep.txt\n/root.csv\n",
        );
        write(root, "nested/deep/.gitignore", "!deep.txt\n");
        write(root, "blocked/.gitignore", "!escape.R\n");
        write(root, "tracked.R", "x <- 1");
        assert!(
            git(root)
                .args(["add", "-f", "tracked.R"])
                .status()
                .unwrap()
                .success()
        );
        let prefixes = [
            "",
            "nested/",
            "nested/deep/",
            "blocked/",
            "logs/",
            "foo/",
            "foo/a/",
            "foo/a/b/",
            "absent/",
        ];
        let leaves = [
            "file.R",
            "file.r",
            "keep.R",
            "local.R",
            "escape.R",
            "root.csv",
            "keep.txt",
            "deep.txt",
            "secret.txt",
            "secret.R",
            "#literal",
            "!literal",
            "space ",
            "a1.csv",
            "c1.csv",
            "scratch.tmp",
            "tracked.R",
        ];
        let mut paths = Vec::new();
        for prefix in prefixes {
            for leaf in leaves {
                paths.push((format!("{prefix}{leaf}"), false));
            }
        }
        for directory in ["blocked", "logs", "nested", "file.R", "foo/a/secret"] {
            fs::create_dir_all(root.join(directory)).unwrap();
            paths.push((directory.to_string(), true));
        }
        let input: Vec<_> = paths
            .iter()
            .flat_map(|(path, _)| path.bytes().chain(std::iter::once(0)))
            .collect();
        let mut child = git(root)
            .args(["check-ignore", "--no-index", "--stdin", "--verbose", "-z"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let fields: Vec<_> = output.stdout.split(|byte| *byte == 0).collect();
        let ignored: HashSet<_> = fields
            .chunks_exact(4)
            .filter(|entry| !entry[2].starts_with(b"!"))
            .map(|entry| String::from_utf8(entry[3].to_vec()).unwrap())
            .collect();
        let snapshot = GitignoreSnapshot::build(&[root.into()]);
        for (path, directory) in paths {
            assert_eq!(
                snapshot.is_ignored(&root.join(&path), directory),
                ignored.contains(&path),
                "{path}"
            );
        }
    }
}
