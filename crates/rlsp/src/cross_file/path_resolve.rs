//
// cross_file/path_resolve.rs
//
// Path resolution for cross-file awareness
//

use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::Url;

/// Context for path resolution
#[derive(Debug, Clone)]
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
    /// Create a new context for a file
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
}

/// Resolve a path string to an absolute path
pub fn resolve_path(path: &str, context: &PathContext) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }

    let resolved = if path.starts_with('/') {
        // Workspace-root-relative path
        let workspace_root = context.workspace_root.as_ref()?;
        workspace_root.join(&path[1..])
    } else {
        // File-relative or working-directory-relative path
        let base = context.effective_working_directory();
        base.join(path)
    };

    // Normalize the path (resolve .. and .)
    normalize_path(&resolved)
}

/// Resolve a working directory path
pub fn resolve_working_directory(path: &str, context: &PathContext) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }

    let resolved = if path.starts_with('/') {
        // Workspace-root-relative
        let workspace_root = context.workspace_root.as_ref()?;
        workspace_root.join(&path[1..])
    } else {
        // File-relative
        let file_dir = context.file_path.parent()?;
        file_dir.join(path)
    };

    normalize_path(&resolved)
}

/// Normalize a path by resolving . and .. components
fn normalize_path(path: &Path) -> Option<PathBuf> {
    let mut components = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                if !components.is_empty() {
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

/// Convert a resolved path to a file URI
pub fn path_to_uri(path: &Path) -> Option<Url> {
    Url::from_file_path(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(ctx.effective_working_directory(), PathBuf::from("/project/src"));
    }

    #[test]
    fn test_effective_working_directory_explicit() {
        let mut ctx = make_context("/project/src/main.R", Some("/project"));
        ctx.working_directory = Some(PathBuf::from("/project/data"));
        assert_eq!(ctx.effective_working_directory(), PathBuf::from("/project/data"));
    }

    #[test]
    fn test_effective_working_directory_inherited() {
        let mut ctx = make_context("/project/src/main.R", Some("/project"));
        ctx.inherited_working_directory = Some(PathBuf::from("/project/scripts"));
        assert_eq!(ctx.effective_working_directory(), PathBuf::from("/project/scripts"));
    }

    #[test]
    fn test_child_context_with_chdir() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let child = ctx.child_context_with_chdir(Path::new("/project/data/utils.R"));
        assert_eq!(child.effective_working_directory(), PathBuf::from("/project/data"));
    }

    #[test]
    fn test_child_context_without_chdir() {
        let ctx = make_context("/project/src/main.R", Some("/project"));
        let child = ctx.child_context(Path::new("/project/data/utils.R"));
        // Inherits parent's effective working directory
        assert_eq!(child.effective_working_directory(), PathBuf::from("/project/src"));
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
}