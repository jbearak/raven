//
// cross_file/path_resolve.rs
//
// Path resolution for cross-file awareness
//
// CRITICAL DESIGN NOTE: Forward vs Backward Directive Path Resolution
// ====================================================================
// Directives are written with the canonical `# raven:` prefix; the `@lsp-`
// forms named below are permanent aliases that parse identically.
// This module provides two PathContext constructors with DIFFERENT behaviors:
//
// 1. PathContext::new() - For BACKWARD directives (`# raven: sourced-by`, `# raven: run-by`, `# raven: included-by`)
//    - IGNORES `# raven: cd` working directory
//    - Always resolves paths relative to the file's own directory
//    - Rationale: Backward directives describe static file relationships from the child's
//      perspective. They declare "this file is sourced by that parent file" - a relationship
//      that should NOT change based on runtime working directory.
//
// 2. PathContext::from_metadata() - For FORWARD directives (`# raven: source`, `# raven: run`, `# raven: include`)
//                                   and source() calls
//    - USES `# raven: cd` working directory when present
//    - Resolves paths relative to the working directory (or file's directory if no `# raven: cd`)
//    - Rationale: Forward directives and source() calls describe runtime execution behavior.
//      They are semantically equivalent to R's source() function, which is affected by
//      the current working directory at runtime.
//
// DO NOT change this behavior without understanding the full implications for cross-file
// awareness. User-facing explanation lives in `docs/cross-file.md`.
//

use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::Url;

use super::types::CrossFileMetadata;

/// Context for path resolution
#[derive(Debug, Clone, Hash)]
pub struct PathContext {
    /// Path of the current file
    pub file_path: PathBuf,
    /// Explicit working directory from directive
    pub working_directory: Option<PathBuf>,
    /// Working directory inherited from parent
    pub inherited_working_directory: Option<PathBuf>,
    /// Workspace root
    pub workspace_root: Option<PathBuf>,
}

impl PathContext {
    /// Create a new context for a file WITHOUT working directory support.
    ///
    /// **USE FOR: Backward directives only** (`# raven: sourced-by`, `# raven: run-by`, `# raven: included-by`)
    ///
    /// This constructor creates a PathContext that resolves paths relative to the file's
    /// own directory, ignoring any `# raven: cd` directive. This is intentional because backward
    /// directives describe static file relationships that should not change based on runtime
    /// working directory.
    ///
    /// **DO NOT USE FOR:** Forward directives (`# raven: source`) or `source()` calls.
    /// Use `PathContext::from_metadata()` instead, which respects `# raven: cd`.
    pub fn new(file_uri: &Url, workspace_root: Option<&Url>) -> Option<Self> {
        let file_path = file_uri.to_file_path().ok()?;
        let workspace_root = workspace_root.and_then(|u| u.to_file_path().ok());
        Some(Self {
            file_path,
            working_directory: None,
            inherited_working_directory: None,
            workspace_root,
        })
    }

    /// Create a context from a file URI and its metadata WITH working directory support.
    ///
    /// **USE FOR: Forward directives** (`# raven: source`, `# raven: run`, `# raven: include`) **and source() calls**
    ///
    /// This constructor creates a PathContext that respects `# raven: cd` working directory
    /// directives. Paths are resolved relative to the working directory (if set) or the
    /// file's directory (if no working directory). This matches R's runtime behavior where
    /// `source()` calls are affected by the current working directory.
    ///
    /// **DO NOT USE FOR:** Backward directives (`# raven: sourced-by`, `# raven: run-by`, `# raven: included-by`).
    /// Use `PathContext::new()` instead, which ignores `# raven: cd`.
    ///
    /// Priority for path resolution: explicit working_directory > inherited > file's directory
    pub fn from_metadata(
        file_uri: &Url,
        metadata: &CrossFileMetadata,
        workspace_root: Option<&Url>,
    ) -> Option<Self> {
        let mut ctx = Self::new(file_uri, workspace_root)?;

        // Apply explicit working directory from metadata if present
        if let Some(ref wd_path) = metadata.working_directory {
            ctx.working_directory = resolve_working_directory(wd_path, &ctx);
        }

        // Apply inherited working directory if no explicit one. Standalone
        // modules are caller-independent: they still honor their own explicit
        // `# raven: cd`, but never inherit a caller working directory.
        // Inherited working directories are stored as absolute paths, so use directly
        // when absolute. Only resolve if relative (legacy/edge case).
        if ctx.working_directory.is_none()
            && !metadata.standalone
            && let Some(ref inherited_wd) = metadata.inherited_working_directory
        {
            let inherited_path = PathBuf::from(inherited_wd);
            if inherited_path.is_absolute() {
                ctx.inherited_working_directory = Some(inherited_path);
            } else {
                // Relative inherited paths should not occur in normal operation
                log::trace!(
                    "Inherited WD is relative '{}' for {}, resolving relative to file directory",
                    inherited_wd,
                    file_uri
                );
                ctx.inherited_working_directory = resolve_working_directory(inherited_wd, &ctx);
            }
        }

        Some(ctx)
    }

    /// Get the effective working directory for path resolution
    pub fn effective_working_directory(&self) -> PathBuf {
        // Priority: explicit > inherited > file's directory
        self.working_directory
            .clone()
            .or_else(|| self.inherited_working_directory.clone())
            .unwrap_or_else(|| {
                self.file_path
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| self.file_path.clone())
            })
    }

    /// Create a child context for a sourced file with chdir=TRUE
    pub fn child_context_with_chdir(&self, child_path: &Path) -> Self {
        let child_dir = child_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| child_path.to_path_buf());
        Self {
            file_path: child_path.to_path_buf(),
            working_directory: None,
            inherited_working_directory: Some(child_dir),
            workspace_root: self.workspace_root.clone(),
        }
    }

    /// Create a child context for a sourced file without chdir
    pub fn child_context(&self, child_path: &Path) -> Self {
        Self {
            file_path: child_path.to_path_buf(),
            working_directory: None,
            inherited_working_directory: Some(self.effective_working_directory()),
            workspace_root: self.workspace_root.clone(),
        }
    }

    /// Create a child context for a sourced file, respecting chdir flag
    pub fn child_context_for_source(&self, child_path: &Path, chdir: bool) -> Self {
        if chdir {
            self.child_context_with_chdir(child_path)
        } else {
            self.child_context(child_path)
        }
    }
}

/// Resolve a path string to an absolute path.
/// Handles file-relative, workspace-relative, and absolute paths with working directory context.
pub fn resolve_path(path: &str, context: &PathContext) -> Option<PathBuf> {
    resolve_path_impl(path, context, false)
}

/// Resolve a path with workspace-root fallback for source() statements and forward directives.
///
/// This function first tries normal resolution (relative to file's directory or `# raven: cd`).
/// If that fails AND the file has no explicit working directory directive, it falls back
/// to trying the path relative to workspace root.
///
/// This is useful for codebases that haven't been annotated with directives but where
/// source() calls use paths relative to the project root (a common pattern in R projects).
///
/// Use this for AST-detected `source()` calls AND for forward directives (`# raven: source`,
/// `# raven: run`, `# raven: include`). Forward directives are semantically equivalent to
/// `source()` calls (see `.kiro/specs/lsp-source-directive/`) and must resolve identically.
/// Do NOT use for backward directives (`# raven: sourced-by`, `# raven: run-by`,
/// `# raven: included-by`) which always resolve relative to the file's directory.
pub fn resolve_path_with_workspace_fallback(path: &str, context: &PathContext) -> Option<PathBuf> {
    resolve_path_impl(path, context, true)
}

/// Internal implementation of path resolution with optional workspace fallback
fn resolve_path_impl(
    path: &str,
    context: &PathContext,
    try_workspace_fallback: bool,
) -> Option<PathBuf> {
    if path.is_empty() {
        log::trace!("Path resolution: empty path provided");
        return None;
    }

    let base_dir = context.effective_working_directory();
    let working_dir = context.working_directory.as_ref();

    log::trace!(
        "Resolving path '{}' with base_dir='{}', working_dir={:?}, file_path='{}'",
        path,
        base_dir.display(),
        working_dir.as_ref().map(|p| p.display().to_string()),
        context.file_path.display()
    );

    // If path starts with /, it's explicitly workspace-root-relative
    if let Some(stripped) = path.strip_prefix('/') {
        let Some(workspace_root) = context.workspace_root.as_ref() else {
            log::warn!(
                "Failed to resolve workspace-root-relative path '{}': no workspace root available, base_dir='{}'",
                path,
                base_dir.display()
            );
            return None;
        };
        let resolved = workspace_root.join(stripped);
        return match normalize_path(&resolved) {
            // Case-correct below the workspace-root prefix when the file exists, so
            // the edge target URI matches the index key on case-insensitive
            // filesystems (issue #476). This also covers a workspace-package
            // `system.file()` target, whose `/inst/...` path resolves here.
            Some(canonical) if canonical.exists() => {
                Some(canonicalize_case_below(workspace_root, &canonical))
            }
            // Missing file: return the lexical path for missing-file diagnostics.
            Some(canonical) => Some(canonical),
            None => {
                log::warn!(
                    "Failed to resolve path '{}': normalization failed, attempted_path='{}', base_dir='{}'",
                    path,
                    resolved.display(),
                    base_dir.display()
                );
                None
            }
        };
    }

    // Try file-relative or working-directory-relative path first.
    // Reuse `base_dir` (already the effective working directory) as the trusted
    // prefix for case-correction below.
    let base = base_dir;
    let resolved = base.join(path);

    if let Some(canonical) = normalize_path(&resolved) {
        // Check if the file exists
        if canonical.exists() {
            // Correct component case to match the on-disk entry (issue #476) so
            // the resulting URI equals the workspace index key on
            // case-insensitive filesystems. `base` is the trusted prefix.
            let canonical = canonicalize_case_below(&base, &canonical);
            log::trace!(
                "Resolved path '{}' to canonical path: '{}'",
                path,
                canonical.display()
            );
            return Some(canonical);
        }

        // File doesn't exist at the resolved path
        // Try workspace-root fallback if:
        // 1. Fallback is enabled (for source() statements)
        // 2. No explicit `# raven: cd` directive (working_directory is None)
        // 3. No inherited working directory
        // 4. Workspace root is available
        let has_explicit_wd = context.working_directory.is_some();
        let has_inherited_wd = context.inherited_working_directory.is_some();

        if try_workspace_fallback
            && !has_explicit_wd
            && !has_inherited_wd
            && let Some(ref workspace_root) = context.workspace_root
        {
            let workspace_resolved = workspace_root.join(path);
            if let Some(workspace_canonical) = normalize_path(&workspace_resolved)
                && workspace_canonical.exists()
            {
                // Case-correct below the workspace-root prefix (issue #476).
                let workspace_canonical =
                    canonicalize_case_below(workspace_root, &workspace_canonical);
                log::trace!(
                    "Resolved path '{}' via workspace-root fallback: '{}' (file-relative '{}' did not exist)",
                    path,
                    workspace_canonical.display(),
                    canonical.display()
                );
                return Some(workspace_canonical);
            }
        }

        // Return the original resolved path even if file doesn't exist
        // (caller may want to report diagnostics about missing file)
        log::trace!(
            "Resolved path '{}' to canonical path: '{}' (file may not exist)",
            path,
            canonical.display()
        );
        return Some(canonical);
    }

    log::warn!(
        "Failed to resolve path '{}': normalization failed, attempted_path='{}', base_dir='{}'",
        path,
        resolved.display(),
        base.display()
    );
    None
}

/// Resolve a working directory path.
/// Used for `# raven: cd` directive resolution with workspace-relative and absolute path support.
pub fn resolve_working_directory(path: &str, context: &PathContext) -> Option<PathBuf> {
    if path.is_empty() {
        log::trace!("Working directory resolution: empty path provided");
        return None;
    }

    let file_dir = context.file_path.parent();

    log::trace!(
        "Resolving working directory '{}' with file_path='{}', file_dir={:?}",
        path,
        context.file_path.display(),
        file_dir.as_ref().map(|p| p.display().to_string())
    );

    let resolved = if let Some(stripped) = path.strip_prefix('/') {
        // Workspace-root-relative
        let workspace_root = context.workspace_root.as_ref();
        if workspace_root.is_none() {
            log::warn!(
                "Failed to resolve workspace-root-relative working directory '{}': no workspace root available",
                path
            );
            return None;
        }
        workspace_root.unwrap().join(stripped)
    } else {
        // File-relative
        let file_dir = context.file_path.parent();
        if file_dir.is_none() {
            log::warn!(
                "Failed to resolve working directory '{}': file has no parent directory, file_path='{}'",
                path,
                context.file_path.display()
            );
            return None;
        }
        file_dir.unwrap().join(path)
    };

    match normalize_path(&resolved) {
        Some(canonical) => {
            log::trace!(
                "Resolved working directory '{}' to canonical path: '{}'",
                path,
                canonical.display()
            );
            Some(canonical)
        }
        None => {
            log::warn!(
                "Failed to resolve working directory '{}': normalization failed, attempted_path='{}'",
                path,
                resolved.display()
            );
            None
        }
    }
}

/// Rewrite the casing of `full`'s path components *below* `base` to match the
/// real on-disk directory entries, **without resolving symlinks**. Components of
/// `base` are kept verbatim; only the suffix `full` adds beyond `base` is
/// corrected, component by component, via `read_dir`.
///
/// This fixes the case-insensitive-filesystem mismatch behind issue #476: a
/// `source("scripts/templates.r")` resolves (lexically) to `…/templates.r`,
/// which `Path::exists()` accepts on macOS/Windows even though the directory
/// entry is `templates.R`. The workspace index keys files under their
/// directory-walk spelling (`…/templates.R`), so the verbatim-cased resolver
/// path produced an edge target that never matched the index key, dropping every
/// symbol the sourced file defined. Correcting case here — at the single
/// resolution chokepoint — makes the edge target equal the index key uniformly
/// across graph resolution, scope resolution, missing-file diagnostics,
/// go-to-definition, and path completion.
///
/// Only components below `base` are touched because the index preserves the
/// workspace-folder/file prefix spelling exactly as registered (it never
/// symlink-canonicalizes it); `base` is derived from those same URIs, so it
/// already carries the matching prefix. Rewriting the prefix to its on-disk
/// casing could diverge from a differently-cased registered folder URI. This
/// also bounds `read_dir` to the appended source-path depth (usually 1-3).
///
/// `std::fs::canonicalize` is deliberately avoided: it resolves symlinks, so on
/// macOS a fixture under `$TMPDIR` (`/var/…` → `/private/var/…`) would resolve to
/// a prefix the un-canonicalized index keys never use.
///
/// On a case-sensitive filesystem the exact-match branch always wins, so this is
/// a no-op (and a genuinely absent `templates.r` next to an on-disk `templates.R`
/// is left unresolved, as it should be).
///
/// If `full` does not start with `base` (unexpected), `full` is returned
/// unchanged.
fn canonicalize_case_below(base: &Path, full: &Path) -> PathBuf {
    let Ok(suffix) = full.strip_prefix(base) else {
        return full.to_path_buf();
    };
    let mut result = base.to_path_buf();
    for component in suffix.components() {
        match component {
            std::path::Component::Normal(name) => match real_entry_name(&result, name) {
                Some(real) => result.push(real),
                None => result.push(name),
            },
            // Suffix is relative and normalized; non-Normal components are not
            // expected, but pass them through defensively.
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// Return the real directory-entry name in `dir` matching `name`: an exact-case
/// match if present (correct on case-sensitive filesystems where two casings can
/// coexist), otherwise the first case-insensitive match. `None` if `dir` is
/// unreadable or nothing matches.
fn real_entry_name(dir: &Path, name: &std::ffi::OsStr) -> Option<std::ffi::OsString> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut ci_match: Option<std::ffi::OsString> = None;
    for entry in entries.flatten() {
        let entry_name = entry.file_name();
        if entry_name == name {
            return Some(entry_name);
        }
        if ci_match.is_none()
            && entry_name
                .to_str()
                .zip(name.to_str())
                .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            ci_match = Some(entry_name);
        }
    }
    ci_match
}

/// Normalize a path by resolving . and .. components
fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                // Only pop if the last component is a Normal segment
                // Preserve RootDir and Prefix components
                if let Some(last) = components.last()
                    && matches!(last, std::path::Component::Normal(_))
                {
                    components.pop();
                }
            }
            std::path::Component::CurDir => {}
            c => components.push(c),
        }
    }

    if components.is_empty() {
        return None;
    }

    let mut result = PathBuf::new();
    for c in components {
        result.push(c);
    }
    Some(result)
}

/// Public version of normalize_path for use outside this module.
/// Normalizes path by resolving . and .. components and canonicalizing when possible.
pub fn normalize_path_public(path: &Path) -> Option<PathBuf> {
    normalize_path(path)
}

/// Resolve a `system.file(parts..., package = P)` call to a filesystem path.
///
/// Resolution algorithm (the two layouts differ by an `inst/` prefix):
/// 1. If `P == workspace_package_name` → `<workspace_root>/inst/<rel>`
///    (source layout, WITH `inst/`).
/// 2. Else if `P` is installed → search each `lib_paths` entry for
///    `<lib_path>/P/<rel>` (installed layout, NO `inst/` prefix; first hit wins).
/// 3. Otherwise → `None` (unresolved).
///
/// `rel` is formed by joining `parts` with `/`.
/// Build the relative path from `system.file()` literal components, rejecting
/// any that would escape the intended base (`<workspace>/inst` or
/// `<lib>/<pkg>`). A component that is an absolute path, a drive prefix, or
/// contains a `..` parent segment is refused — otherwise a literal such as
/// `system.file("..", "..", "secret.R", package = "pkg")` would turn
/// `system.file()` analysis into an arbitrary local-file read for an untrusted
/// workspace. Returns `None` for empty input or any escaping component.
fn system_file_relative_path(parts: &[String]) -> Option<PathBuf> {
    use std::path::Component;
    let mut rel = PathBuf::new();
    for part in parts {
        let candidate = Path::new(part);
        if candidate.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return None;
        }
        rel.push(candidate);
    }
    (!rel.as_os_str().is_empty()).then_some(rel)
}

pub fn resolve_system_file(
    parts: &[String],
    package: &str,
    workspace_package_name: Option<&str>,
    workspace_root: Option<&Path>,
    lib_paths: &[PathBuf],
) -> Option<PathBuf> {
    let rel = system_file_relative_path(parts)?;

    // Branch 1: same as workspace package → source layout with inst/ prefix
    if let (Some(ws_pkg), Some(ws_root)) = (workspace_package_name, workspace_root)
        && package == ws_pkg
    {
        let inst_dir = ws_root.join("inst");
        let candidate = inst_dir.join(&rel);
        if candidate.exists() {
            // Case-correct below the `inst/` prefix (issue #476) so the edge
            // target matches the index key on case-insensitive filesystems.
            return Some(canonicalize_case_below(&inst_dir, &candidate));
        }
        // Even if file doesn't exist yet, return the path so diagnostics
        // can report a missing file (consistent with resolve_path behavior).
        return Some(candidate);
    }

    // Branch 2: installed package → search lib_paths without inst/ prefix
    for lib_path in lib_paths {
        let candidate = lib_path.join(package).join(&rel);
        if candidate.exists() {
            return Some(canonicalize_case_below(lib_path, &candidate));
        }
    }

    // Branch 3: unresolved
    None
}

/// Resolve any `system_file`-bearing `ForwardSource` entries in `meta` into
/// concrete paths. Call after `extract_metadata` when workspace and library
/// context is available. Each resolved entry gets `source.path` (and, for
/// cross-package hits, `source.resolved_uri`) populated so the existing
/// dependency/scope machinery handles them transparently.
///
/// `source.system_file` is NEVER cleared and unresolved entries are NEVER
/// dropped: resolution state is recomputed from scratch on every call so that
/// package lifecycle events (install/removal in a watched libpath, a workspace
/// `Package:` rename) can re-resolve without re-extracting metadata from
/// source text. `WorldState::resolve_system_file_in_workspace` revisits every
/// entry where `system_file.is_some()`. The function is idempotent: calling it
/// again with the same inputs yields the same metadata.
///
/// Resolution states after a call:
/// - branch 1 (workspace self-package): `path = "/inst/<rel>"`, `resolved_uri = None`
/// - branch 2 hit (installed package): `path` absolute, `resolved_uri = Some`
/// - branch 2 miss with non-empty `lib_paths` (not installed): `path` empty,
///   `resolved_uri = None` — any prior resolution is cleared so a removed
///   package's stale edge disappears
/// - `lib_paths` empty and not self-package: left untouched (deferred until
///   the package library is ready)
pub fn resolve_system_file_sources(
    meta: &mut super::types::CrossFileMetadata,
    workspace_package_name: Option<&str>,
    workspace_root: Option<&Path>,
    lib_paths: &[PathBuf],
) {
    resolve_system_file_source_entries(
        &mut meta.sources,
        workspace_package_name,
        workspace_root,
        lib_paths,
    );
}

/// Slice-based core of [`resolve_system_file_sources`]: resolves directly on
/// a `ForwardSource` slice so callers that need change detection can resolve
/// into a cloned `Vec` and compare, without deep-cloning the whole
/// `CrossFileMetadata` (`Arc::make_mut`) when nothing changed.
pub fn resolve_system_file_source_entries(
    sources: &mut [super::types::ForwardSource],
    workspace_package_name: Option<&str>,
    workspace_root: Option<&Path>,
    lib_paths: &[PathBuf],
) {
    for source in sources.iter_mut() {
        if let Some(ref sf) = source.system_file {
            // Branch 1: same as workspace package → source layout with inst/ prefix
            if let Some(ws_pkg) = workspace_package_name
                && sf.package == ws_pkg
                && workspace_root.is_some()
            {
                let Some(rel) = system_file_relative_path(&sf.parts) else {
                    continue;
                };
                source.path = format!("/inst/{}", rel.display());
                // Workspace-relative resolution: drop any stale cross-package
                // URI from a previous pass (e.g. before a Package: rename).
                source.resolved_uri = None;
            } else if !lib_paths.is_empty() {
                // Branch 2: cross-package → search lib_paths (only when
                // lib_paths are actually available; otherwise leave intact
                // for a later retry after R initialization).
                let resolved = resolve_system_file(
                    &sf.parts,
                    &sf.package,
                    workspace_package_name,
                    workspace_root,
                    lib_paths,
                );
                if let Some(abs_path) = resolved {
                    source.resolved_uri = Url::from_file_path(&abs_path).ok();
                    source.path = abs_path.display().to_string();
                } else {
                    // Not installed: clear any stale resolution (the package
                    // may have just been removed, or the workspace package
                    // renamed away from a former branch-1 match) but retain
                    // the entry so a later install event can re-resolve it.
                    source.resolved_uri = None;
                    source.path = String::new();
                }
            }
            // When lib_paths is empty AND not same-package, the entry is left
            // intact — including any prior resolution — for a later retry.
        }
    }
}

/// Convert a resolved path to a file URI.
/// Creates a file:// URI from an absolute filesystem path.
pub fn path_to_uri(path: &Path) -> Option<Url> {
    Url::from_file_path(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Issue #476: case-correction of resolved source paths so the edge target URI
    // matches the workspace-index key on case-insensitive filesystems.
    #[test]
    fn canonicalize_case_below_prefers_exact_match() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Templates.R"), "").unwrap();
        // An exact-case query must be returned verbatim, never folded to another
        // entry — critical on case-sensitive filesystems where two casings coexist.
        let full = dir.path().join("Templates.R");
        let got = canonicalize_case_below(dir.path(), &full);
        assert_eq!(got, full);
    }

    #[test]
    fn canonicalize_case_below_folds_to_on_disk_case() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("templates.R"), "").unwrap();
        // Query with the wrong case for the final component; the real entry name
        // (`templates.R`) must be substituted so the URI matches the index key.
        // (On a case-insensitive FS `templates.r` opens the same inode; on a
        // case-sensitive FS there is no `templates.r`, so the case-insensitive
        // fallback still resolves to the real entry — the function's job.)
        let queried = dir.path().join("templates.r");
        let got = canonicalize_case_below(dir.path(), &queried);
        assert_eq!(got, dir.path().join("templates.R"));
    }

    #[test]
    fn canonicalize_case_below_corrects_only_below_base() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("Child.R"), "").unwrap();
        // base is the workspace/file prefix and is trusted verbatim; only the
        // appended components are case-corrected.
        let queried = dir.path().join("sub").join("child.r");
        let got = canonicalize_case_below(dir.path(), &queried);
        assert_eq!(got, dir.path().join("sub").join("Child.R"));
    }

    #[test]
    fn canonicalize_case_below_keeps_missing_component_as_typed() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing on disk matches; the path is returned unchanged (it will be
        // reported as a missing file downstream).
        let queried = dir.path().join("nope.R");
        let got = canonicalize_case_below(dir.path(), &queried);
        assert_eq!(got, queried);
    }

    #[test]
    fn canonicalize_case_below_passthrough_when_not_under_base() {
        let base = PathBuf::from("/some/base");
        let unrelated = PathBuf::from("/other/place/file.R");
        assert_eq!(canonicalize_case_below(&base, &unrelated), unrelated);
    }

    fn make_context(file: &str, workspace: Option<&str>) -> PathContext {
        PathContext {
            file_path: PathBuf::from(file),
            working_directory: None,
            inherited_working_directory: None,
            workspace_root: workspace.map(PathBuf::from),
        }
    }

    #[test]
    fn test_resolve_relative_path() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let resolved = resolve_path("utils.R", &ctx).unwrap();
        assert_eq!(resolved, PathBuf::from("/project/src/utils.R"));
    }

    #[test]
    fn system_file_rejects_escaping_components() {
        // Parent-dir, absolute, and empty parts must not resolve — otherwise a
        // crafted `system.file("..", ...)` could read files outside the package.
        let lib = vec![PathBuf::from("/lib")];
        assert_eq!(
            resolve_system_file(
                &["..".into(), "..".into(), "secret.R".into()],
                "pkg",
                None,
                None,
                &lib,
            ),
            None
        );
        assert_eq!(
            resolve_system_file(&["/etc/passwd".into()], "pkg", None, None, &lib),
            None
        );
        assert_eq!(resolve_system_file(&[], "pkg", None, None, &lib), None);
        // A normal relative component still resolves via the workspace branch
        // (which returns the candidate path even when the file doesn't exist).
        assert_eq!(
            resolve_system_file(
                &["extdata".into(), "x.R".into()],
                "pkg",
                Some("pkg"),
                Some(Path::new("/ws")),
                &lib,
            ),
            Some(PathBuf::from("/ws/inst/extdata/x.R"))
        );
    }

    #[test]
    fn test_resolve_parent_directory() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let resolved = resolve_path("../data/input.R", &ctx).unwrap();
        assert_eq!(resolved, PathBuf::from("/project/data/input.R"));
    }

    #[test]
    fn test_resolve_workspace_root_relative() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let resolved = resolve_path("/data/input.R", &ctx).unwrap();
        assert_eq!(resolved, PathBuf::from("/project/data/input.R"));
    }

    #[test]
    fn test_resolve_workspace_root_relative_no_workspace() {
        let ctx = make_context("/project/src/main.R", None);
        let resolved = resolve_path("/data/input.R", &ctx);
        assert!(resolved.is_none());
    }

    #[test]
    fn test_effective_working_directory_default() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/src")
        );
    }

    #[test]
    fn test_effective_working_directory_explicit() {
        let mut ctx = make_context("/project/src/main.R", Some("/project"));
        ctx.working_directory = Some(PathBuf::from("/project/data"));
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    #[test]
    fn test_effective_working_directory_inherited() {
        let mut ctx = make_context("/project/src/main.R", Some("/project"));
        ctx.inherited_working_directory = Some(PathBuf::from("/project/scripts"));
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/scripts")
        );
    }

    #[test]
    fn test_child_context_with_chdir() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let child = ctx.child_context_with_chdir(Path::new("/project/data/utils.R"));
        assert_eq!(
            child.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    #[test]
    fn test_child_context_without_chdir() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let child = ctx.child_context(Path::new("/project/data/utils.R"));
        // Inherits parent's effective working directory
        assert_eq!(
            child.effective_working_directory(),
            PathBuf::from("/project/src")
        );
    }

    #[test]
    fn test_resolve_working_directory_relative() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let resolved = resolve_working_directory("../data", &ctx).unwrap();
        assert_eq!(resolved, PathBuf::from("/project/data"));
    }

    #[test]
    fn test_resolve_working_directory_workspace_relative() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let resolved = resolve_working_directory("/data/scripts", &ctx).unwrap();
        assert_eq!(resolved, PathBuf::from("/project/data/scripts"));
    }

    #[test]
    fn test_from_metadata_with_working_directory() {
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/main.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: Some("/data".to_string()),
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    #[test]
    fn test_from_metadata_relative_working_directory() {
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/main.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: Some("../data".to_string()),
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    // Tests for inherited_working_directory in from_metadata
    // Validates: Requirements 6.2, 6.3, 3.1

    #[test]
    fn test_from_metadata_with_inherited_working_directory() {
        // Validates: Requirements 6.2, 6.3
        // When metadata has inherited_working_directory and no explicit working_directory,
        // the PathContext should use the inherited working directory.
        // Inherited working directories are stored as absolute paths.
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/child.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: None,
            inherited_working_directory: Some("/project/data".to_string()),
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();

        // Absolute inherited paths are used directly
        assert!(ctx.working_directory.is_none());
        assert_eq!(
            ctx.inherited_working_directory,
            Some(PathBuf::from("/project/data"))
        );
        // Effective working directory should use inherited
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    #[test]
    fn test_from_metadata_inherited_working_directory_relative_path() {
        // Validates: Requirements 6.2, 6.3
        // Inherited working directory with relative path should resolve relative to file's directory
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/child.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: None,
            inherited_working_directory: Some("../data".to_string()),
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();

        assert!(ctx.working_directory.is_none());
        assert_eq!(
            ctx.inherited_working_directory,
            Some(PathBuf::from("/project/data"))
        );
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    #[test]
    fn test_from_metadata_explicit_working_directory_takes_precedence() {
        // Validates: Requirements 3.1
        // When both explicit and inherited working directories are present,
        // explicit should take precedence
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/child.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: Some("/explicit".to_string()),
            inherited_working_directory: Some("/inherited".to_string()),
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();

        // Explicit working directory should be set
        assert_eq!(
            ctx.working_directory,
            Some(PathBuf::from("/project/explicit"))
        );
        // Inherited should NOT be set when explicit is present
        assert!(ctx.inherited_working_directory.is_none());
        // Effective should use explicit
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/explicit")
        );
    }

    #[test]
    fn test_from_metadata_no_working_directories() {
        // When neither explicit nor inherited working directory is set,
        // effective working directory should be file's directory
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/child.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: None,
            inherited_working_directory: None,
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();

        assert!(ctx.working_directory.is_none());
        assert!(ctx.inherited_working_directory.is_none());
        // Effective should fall back to file's directory
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/project/src")
        );
    }

    #[test]
    fn test_from_metadata_inherited_working_directory_absolute_path() {
        // Validates: Requirements 6.2, 6.3
        // Inherited working directories are stored as absolute paths, so absolute
        // paths should be used directly without re-resolution
        use super::super::types::CrossFileMetadata;

        let file_uri = Url::parse("file:///project/src/child.R").unwrap();
        let workspace_uri = Url::parse("file:///project").unwrap();

        let meta = CrossFileMetadata {
            working_directory: None,
            inherited_working_directory: Some("/absolute/path".to_string()),
            ..Default::default()
        };

        let ctx = PathContext::from_metadata(&file_uri, &meta, Some(&workspace_uri)).unwrap();

        // Absolute inherited paths are used directly (not re-resolved as workspace-relative)
        assert_eq!(
            ctx.inherited_working_directory,
            Some(PathBuf::from("/absolute/path"))
        );
        assert_eq!(
            ctx.effective_working_directory(),
            PathBuf::from("/absolute/path")
        );
    }

    #[test]
    fn test_child_context_for_source_with_chdir() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let child = ctx.child_context_for_source(Path::new("/project/data/utils.R"), true);
        assert_eq!(
            child.effective_working_directory(),
            PathBuf::from("/project/data")
        );
    }

    #[test]
    fn test_child_context_for_source_without_chdir() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let child = ctx.child_context_for_source(Path::new("/project/data/utils.R"), false);
        assert_eq!(
            child.effective_working_directory(),
            PathBuf::from("/project/src")
        );
    }

    // Tests for normalize_path ParentDir handling (Requirements 4.1-4.4)
    #[test]
    fn test_normalize_path_preserves_root_with_parent_dir() {
        // "/../a" should produce "/a", not "a"
        let path = Path::new("/../a");
        let result = normalize_path(path).unwrap();
        assert_eq!(result, PathBuf::from("/a"));
    }

    #[test]
    fn test_normalize_path_normal_parent_dir() {
        // "/a/../b" should produce "/b"
        let path = Path::new("/a/../b");
        let result = normalize_path(path).unwrap();
        assert_eq!(result, PathBuf::from("/b"));
    }

    #[test]
    fn test_normalize_path_relative_parent_dir() {
        // "a/../b" should produce "b"
        let path = Path::new("a/../b");
        let result = normalize_path(path).unwrap();
        assert_eq!(result, PathBuf::from("b"));
    }

    #[test]
    fn test_normalize_path_multiple_parent_dirs() {
        // "/a/b/../../c" should produce "/c"
        let path = Path::new("/a/b/../../c");
        let result = normalize_path(path).unwrap();
        assert_eq!(result, PathBuf::from("/c"));
    }

    #[test]
    fn test_normalize_path_leading_parent_dirs() {
        // "/../../../a" should produce "/a" (can't go above root)
        let path = Path::new("/../../../a");
        let result = normalize_path(path).unwrap();
        assert_eq!(result, PathBuf::from("/a"));
    }

    // ==================== system.file resolution tests ====================

    #[test]
    fn test_resolve_system_file_same_package_inst_prefix() {
        // Same-package: workspace "Matrix" with inst/test-tools.R → resolved via inst/
        let tmp = tempfile::tempdir().unwrap();
        let ws_root = tmp.path();
        std::fs::create_dir_all(ws_root.join("inst")).unwrap();
        std::fs::write(ws_root.join("inst/test-tools.R"), "f <- 1").unwrap();

        let result = resolve_system_file(
            &["test-tools.R".to_string()],
            "Matrix",
            Some("Matrix"),
            Some(ws_root),
            &[],
        );
        assert_eq!(result, Some(ws_root.join("inst/test-tools.R")));
    }

    #[test]
    fn test_resolve_system_file_installed_cross_package_no_inst() {
        // Installed cross-package: lib_path contains P/helper.R (no inst/ prefix)
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path();
        std::fs::create_dir_all(lib.join("P")).unwrap();
        std::fs::write(lib.join("P/helper.R"), "g <- 2").unwrap();

        let result = resolve_system_file(
            &["helper.R".to_string()],
            "P",
            Some("MyPkg"),
            Some(Path::new("/fake/ws")),
            &[lib.to_path_buf()],
        );
        assert_eq!(result, Some(lib.join("P/helper.R")));
    }

    #[test]
    fn test_resolve_system_file_multi_part_join() {
        // Multi-part: system.file("a", "b.R", package = "P") → P/a/b.R
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path();
        std::fs::create_dir_all(lib.join("P/a")).unwrap();
        std::fs::write(lib.join("P/a/b.R"), "h <- 3").unwrap();

        let result = resolve_system_file(
            &["a".to_string(), "b.R".to_string()],
            "P",
            None,
            None,
            &[lib.to_path_buf()],
        );
        assert_eq!(result, Some(lib.join("P/a/b.R")));
    }

    #[test]
    fn test_resolve_system_file_unresolved_fallback() {
        // Package neither self nor installed → None, no panic
        let result = resolve_system_file(
            &["helper.R".to_string()],
            "NonExistent",
            Some("MyPkg"),
            Some(Path::new("/fake/ws")),
            &[PathBuf::from("/no/such/lib")],
        );
        assert_eq!(result, None);
    }

    #[test]
    fn test_resolve_system_file_sources_integration() {
        // resolve_system_file_sources sets the workspace-root-relative path and
        // retains system_file so later events can re-resolve.
        use super::super::source_detect::SystemFileCall;
        use super::super::types::{CrossFileMetadata, ForwardSource};

        let tmp = tempfile::tempdir().unwrap();
        let ws_root = tmp.path();
        std::fs::create_dir_all(ws_root.join("inst")).unwrap();
        std::fs::write(ws_root.join("inst/helper.R"), "x <- 1").unwrap();

        let mut meta = CrossFileMetadata {
            sources: vec![ForwardSource {
                system_file: Some(SystemFileCall {
                    parts: vec!["helper.R".to_string()],
                    package: "mypkg".to_string(),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        resolve_system_file_sources(&mut meta, Some("mypkg"), Some(ws_root), &[]);

        assert_eq!(meta.sources[0].path, "/inst/helper.R");
        assert!(
            meta.sources[0].system_file.is_some(),
            "system_file must be retained so a Package: rename can re-resolve"
        );
    }

    #[test]
    fn test_resolve_system_file_sources_unresolved_retained() {
        // Unresolved (cross-package, not installed) entries are RETAINED even
        // when lib_paths is non-empty (resolution attempted and failed), so a
        // later package-install event can re-resolve them. They stay inert:
        // empty path, no resolved_uri.
        use super::super::source_detect::SystemFileCall;
        use super::super::types::{CrossFileMetadata, ForwardSource};

        let tmp = tempfile::tempdir().unwrap();
        let ws_root = tmp.path();
        // A lib_path that exists but doesn't contain the package
        let lib_dir = tempfile::tempdir().unwrap();

        let mut meta = CrossFileMetadata {
            sources: vec![ForwardSource {
                system_file: Some(SystemFileCall {
                    parts: vec!["setup.R".to_string()],
                    package: "otherpkg".to_string(),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        resolve_system_file_sources(
            &mut meta,
            Some("mypkg"),
            Some(ws_root),
            &[lib_dir.path().to_path_buf()],
        );

        assert_eq!(
            meta.sources.len(),
            1,
            "Unresolved entries must be retained for later re-resolution"
        );
        assert!(meta.sources[0].system_file.is_some());
        assert!(meta.sources[0].path.is_empty());
        assert!(meta.sources[0].resolved_uri.is_none());
    }

    // ---- P7: system.file edge re-resolution after a library swap ----
    //
    // Simulates the scenario in `resolve_system_file_in_workspace`: a
    // `ForwardSource` that was previously left with `system_file.is_some()`
    // (lib_paths was empty at index time) is re-resolved once a new
    // `package_library` with non-empty lib_paths is available.
    //
    // The test directly exercises `resolve_system_file_sources` — the same
    // function called by `resolve_system_file_in_workspace` — with the "before
    // swap" (empty lib_paths, entry stays) and "after swap" (lib_paths now
    // point at the installed package, entry resolves) states.

    /// After a library swap that populates lib_paths, an unresolved
    /// `system_file` source is resolved to the installed path, `resolved_uri`
    /// is set, and `system_file` is retained for future re-resolution.
    #[test]
    fn system_file_re_resolved_after_library_swap() {
        use super::super::source_detect::SystemFileCall;
        use super::super::types::{CrossFileMetadata, ForwardSource};

        let libdir = tempfile::tempdir().unwrap();
        // "otherpkg" installed at libdir/otherpkg/helper.R (installed layout:
        // no inst/ prefix).
        let pkg_dir = libdir.path().join("otherpkg");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("helper.R"), "helper_fn <- function() 42\n").unwrap();

        // --- Step 1: initial call with empty lib_paths (before swap) ---
        // Entry must survive (deferred): system_file stays Some, source not
        // dropped.
        let mut meta_before = CrossFileMetadata {
            sources: vec![ForwardSource {
                system_file: Some(SystemFileCall {
                    parts: vec!["helper.R".to_string()],
                    package: "otherpkg".to_string(),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };
        resolve_system_file_sources(&mut meta_before, Some("mypkg"), None, &[]);
        assert_eq!(
            meta_before.sources.len(),
            1,
            "With empty lib_paths the entry must be kept (deferred) for a later retry"
        );
        assert!(
            meta_before.sources[0].system_file.is_some(),
            "system_file must remain Some when lib_paths is empty (deferred)"
        );
        assert!(
            meta_before.sources[0].resolved_uri.is_none(),
            "resolved_uri must remain None before lib_paths are available"
        );

        // --- Step 2: retry after the library swap (lib_paths now populated) ---
        // Entry must resolve: resolved_uri points into the new lib path while
        // system_file stays Some for future lifecycle events.
        let mut meta_after = meta_before.clone();
        resolve_system_file_sources(
            &mut meta_after,
            Some("mypkg"),
            None,
            &[libdir.path().to_path_buf()],
        );
        assert_eq!(
            meta_after.sources.len(),
            1,
            "Entry must survive resolution (it resolved successfully)"
        );
        assert!(
            meta_after.sources[0].system_file.is_some(),
            "system_file must be retained after successful resolution so a \
             package-removal event can re-resolve"
        );
        let resolved_uri = meta_after.sources[0]
            .resolved_uri
            .as_ref()
            .expect("resolved_uri must be set after cross-package system.file() resolution");
        let resolved_path = resolved_uri.to_file_path().unwrap();
        assert!(
            resolved_path.starts_with(libdir.path()),
            "resolved path must be inside the new lib_path. Got: {resolved_path:?}"
        );
        assert!(
            resolved_path.ends_with("otherpkg/helper.R"),
            "resolved path must point at otherpkg/helper.R. Got: {resolved_path:?}"
        );
    }

    /// Positive control for the library-swap test: a same-package `system.file()`
    /// resolves to `inst/` immediately, regardless of lib_paths.
    #[test]
    fn system_file_same_package_resolves_immediately_without_lib_paths() {
        use super::super::source_detect::SystemFileCall;
        use super::super::types::{CrossFileMetadata, ForwardSource};

        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("inst")).unwrap();
        std::fs::write(tmp.path().join("inst").join("helper.R"), "x <- 1\n").unwrap();

        let mut meta = CrossFileMetadata {
            sources: vec![ForwardSource {
                system_file: Some(SystemFileCall {
                    parts: vec!["helper.R".to_string()],
                    package: "selfpkg".to_string(),
                }),
                ..Default::default()
            }],
            ..Default::default()
        };

        resolve_system_file_sources(&mut meta, Some("selfpkg"), Some(tmp.path()), &[]);

        assert_eq!(meta.sources.len(), 1);
        assert!(
            meta.sources[0].path.contains("/inst/helper.R"),
            "same-package system.file() must resolve immediately (no lib_paths \
             needed); path must be set to the inst/ location, got: {:?}",
            meta.sources[0].path
        );
        assert!(
            meta.sources[0].system_file.is_some(),
            "system_file must be retained so a Package: rename can re-resolve"
        );
    }
}

#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy for generating path segments
    fn segment_strategy() -> impl Strategy<Value = String> {
        prop::string::string_regex("[a-z][a-z0-9_]{0,10}")
            .unwrap()
            .prop_filter("non-empty", |s| !s.is_empty())
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        /// Property 3: Path normalization preserves root
        /// For any absolute path with leading ParentDir, the root should be preserved.
        #[test]
        fn prop_normalize_preserves_root(
            num_parent_dirs in 1_usize..5,
            segments in prop::collection::vec(segment_strategy(), 1..5)
        ) {
            // Build path like "/../../../a/b/c"
            let mut path_str = String::from("/");
            for _ in 0..num_parent_dirs {
                path_str.push_str("../");
            }
            path_str.push_str(&segments.join("/"));

            let path = Path::new(&path_str);
            let result = normalize_path(path);

            // Result should exist and start with root
            prop_assert!(result.is_some());
            let normalized = result.unwrap();
            prop_assert!(normalized.is_absolute(), "Normalized path should be absolute");
        }

        /// Property 3: Normal parent dir resolution works correctly
        #[test]
        fn prop_normal_parent_dir_resolution(
            prefix_segments in prop::collection::vec(segment_strategy(), 1..3),
            suffix_segments in prop::collection::vec(segment_strategy(), 1..3)
        ) {
            // Build path like "/a/b/../c/d" where .. should cancel one segment
            let mut path_str = String::from("/");
            path_str.push_str(&prefix_segments.join("/"));
            path_str.push_str("/../");
            path_str.push_str(&suffix_segments.join("/"));

            let path = Path::new(&path_str);
            let result = normalize_path(path);

            prop_assert!(result.is_some());
            let normalized = result.unwrap();

            // The result should have one fewer segment than prefix + suffix
            let expected_segments = prefix_segments.len() - 1 + suffix_segments.len();
            let actual_segments = normalized.components()
                .filter(|c| matches!(c, std::path::Component::Normal(_)))
                .count();
            prop_assert_eq!(actual_segments, expected_segments);
        }
    }
}
