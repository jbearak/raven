//! R package workspace detection and namespace model.
//!
//! When the workspace root contains a `DESCRIPTION` file, Raven activates
//! "package mode": all `R/*.R` files are treated as mutually visible (flat
//! namespace), and imports declared via roxygen annotations or the NAMESPACE
//! file suppress undefined-variable diagnostics for external package symbols.
//!
//! Detection heuristic for roxygen-managed packages: if any `R/*.R` file
//! contains `#' @export`, the package is considered roxygen-managed and
//! namespace tags are parsed from source rather than the NAMESPACE file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

static ROXYGEN_EXPORT_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?m)#'\s*@export\b").expect("valid regex")
});

/// Metadata about the detected R package workspace.
#[derive(Debug, Clone)]
pub struct PackageWorkspace {
    /// Package name from DESCRIPTION `Package:` field.
    pub name: String,
    /// Absolute path to the workspace root (where DESCRIPTION lives).
    pub root: PathBuf,
    /// Whether the package uses roxygen2 (any R/*.R file has `#' @export`).
    pub roxygen_managed: bool,
}

/// Unified namespace model for an R package.
///
/// Built from either roxygen annotations (when `roxygen_managed`) or the
/// NAMESPACE file. Used to determine which symbols the package exports and
/// which external package symbols are available without qualification.
#[derive(Debug, Clone, Default)]
pub struct PackageNamespaceModel {
    /// Symbols this package exports (for informational purposes; mutual
    /// visibility means ALL top-level symbols are visible internally regardless).
    pub exports: HashSet<String>,
    /// `importFrom(pkg, sym)` pairs — only these specific symbols are available.
    pub imports: Vec<(String, String)>,
    /// Packages imported wholesale via `import(pkg)` — all their exports are available.
    pub full_imports: Vec<String>,
}

/// Detect whether the workspace root is an R package.
///
/// Returns `Some(PackageWorkspace)` if a valid DESCRIPTION file with a
/// `Package:` field exists at `workspace_root`. The `roxygen_managed` flag
/// is set by scanning `R/*.R` files for `#' @export`.
pub fn detect_package_workspace(workspace_root: &Path) -> Option<PackageWorkspace> {
    let description_path = workspace_root.join("DESCRIPTION");
    let content = std::fs::read_to_string(&description_path).ok()?;
    let name = parse_dcf_field(&content, "Package")?;

    let roxygen_managed = detect_roxygen_usage(workspace_root);

    Some(PackageWorkspace {
        name,
        root: workspace_root.to_path_buf(),
        roxygen_managed,
    })
}

/// Like [`detect_package_workspace`] but determines `roxygen_managed` from
/// pre-loaded file contents rather than re-reading from disk. Use this when
/// file content is already available (e.g. after a parallel workspace scan).
#[allow(dead_code)]
pub fn detect_package_workspace_with_content<'a>(
    workspace_root: &Path,
    r_file_contents: impl Iterator<Item = &'a str>,
) -> Option<PackageWorkspace> {
    let description_path = workspace_root.join("DESCRIPTION");
    let content = std::fs::read_to_string(&description_path).ok()?;
    let name = parse_dcf_field(&content, "Package")?;

    let roxygen_managed = r_file_contents.into_iter().any(|c| ROXYGEN_EXPORT_RE.is_match(c));

    Some(PackageWorkspace {
        name,
        root: workspace_root.to_path_buf(),
        roxygen_managed,
    })
}

/// Check if any `R/*.R` file contains `#' @export`.
fn detect_roxygen_usage(workspace_root: &Path) -> bool {
    let r_dir = workspace_root.join("R");
    let Ok(entries) = std::fs::read_dir(&r_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(ext) = path.extension() {
            if !ext.eq_ignore_ascii_case("r") {
                continue;
            }
        } else {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if ROXYGEN_EXPORT_RE.is_match(&content) {
                return true;
            }
        }
    }
    false
}

/// Build a `PackageNamespaceModel` from the NAMESPACE file.
///
/// Parses `import(pkg)`, `importFrom(pkg, sym, ...)`, and `export(sym, ...)`
/// directives. Used when the package is not roxygen-managed or as a fallback.
pub fn namespace_model_from_file(namespace_path: &Path) -> PackageNamespaceModel {
    let content = match std::fs::read_to_string(namespace_path) {
        Ok(c) => c,
        Err(_) => return PackageNamespaceModel::default(),
    };
    namespace_model_from_content(&content)
}

/// Parse NAMESPACE content into a `PackageNamespaceModel`.
pub fn namespace_model_from_content(content: &str) -> PackageNamespaceModel {
    let mut model = PackageNamespaceModel::default();
    // Normalize multiline directives (join lines ending with incomplete parens)
    let normalized = normalize_multiline(content);

    for line in normalized.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(args) = strip_directive(line, "export") {
            for name in split_args(args) {
                if !name.is_empty() {
                    model.exports.insert(name.to_string());
                }
            }
        } else if let Some(args) = strip_directive(line, "exportPattern") {
            // Store pattern exports as-is (informational)
            for pat in split_args(args) {
                if !pat.is_empty() {
                    model.exports.insert(format!("__PATTERN__:{}", pat));
                }
            }
        } else if let Some(args) = strip_directive(line, "S3method") {
            let parts: Vec<&str> = split_args(args).collect();
            if parts.len() >= 2 {
                model
                    .exports
                    .insert(format!("{}.{}", parts[0], parts[1]));
            }
        } else if let Some(args) = strip_directive(line, "importFrom") {
            let parts: Vec<&str> = split_args(args).collect();
            if parts.len() >= 2 {
                let pkg = unquote(parts[0]);
                for sym in &parts[1..] {
                    let sym = unquote(sym);
                    if !sym.is_empty() {
                        model.imports.push((pkg.clone(), sym));
                    }
                }
            }
        } else if let Some(args) = strip_directive(line, "import") {
            for pkg in split_args(args) {
                let pkg = unquote(pkg);
                if !pkg.is_empty() {
                    model.full_imports.push(pkg);
                }
            }
        }
    }
    model
}

/// Build a `PackageNamespaceModel` from aggregated roxygen namespace tags.
pub fn namespace_model_from_roxygen(
    files: &[(String, crate::roxygen::RoxygenNamespace)],
) -> PackageNamespaceModel {
    let mut model = PackageNamespaceModel::default();
    let mut seen_imports: HashSet<(String, String)> = HashSet::new();
    let mut seen_full: HashSet<String> = HashSet::new();

    for (_path, ns) in files {
        for sym in &ns.exports {
            model.exports.insert(sym.clone());
        }
        for (pkg, sym) in &ns.import_from {
            if seen_imports.insert((pkg.clone(), sym.clone())) {
                model.imports.push((pkg.clone(), sym.clone()));
            }
        }
        for pkg in &ns.imports {
            if seen_full.insert(pkg.clone()) {
                model.full_imports.push(pkg.clone());
            }
        }
    }
    model
}

// --- helpers ---

/// Parse a DCF field value from DESCRIPTION content. Public for use by scan_workspace.
pub fn parse_dcf_field_pub(content: &str, field: &str) -> Option<String> {
    parse_dcf_field(content, field)
}

fn parse_dcf_field(content: &str, field: &str) -> Option<String> {
    let prefix = format!("{}:", field);
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let val = rest.trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn count_unquoted_parens(s: &str) -> (usize, usize) {
    let mut open = 0usize;
    let mut close = 0usize;
    let mut in_quote: Option<char> = None;
    for c in s.chars() {
        match in_quote {
            Some(q) if c == q => { in_quote = None; }
            Some(_) => {}
            None => match c {
                '"' | '\'' => { in_quote = Some(c); }
                '(' => { open += 1; }
                ')' => { close += 1; }
                _ => {}
            }
        }
    }
    (open, close)
}

fn normalize_multiline(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        // Strip trailing comments (# not inside quotes)
        let effective = strip_trailing_comment(trimmed);
        let effective = effective.trim();
        if effective.is_empty() || effective.starts_with('#') {
            // Pure comment line — but if we're inside an unbalanced directive, skip it
            if out.ends_with('\n') {
                let last_line_start = out[..out.len() - 1].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let last_line = &out[last_line_start..out.len() - 1];
                let (open, close) = count_unquoted_parens(last_line);
                if open > close {
                    // Inside unbalanced parens — skip comment line entirely
                    continue;
                }
            }
            out.push_str(trimmed);
            out.push('\n');
            continue;
        }
        // If previous line has unbalanced parens, join
        if out.ends_with('\n') {
            let last_line_start = out[..out.len() - 1].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let last_line = &out[last_line_start..out.len() - 1];
            let (open, close) = count_unquoted_parens(last_line);
            if open > close {
                // Remove trailing newline and append this line
                out.pop(); // remove '\n'
                out.push_str(effective);
                out.push('\n');
                continue;
            }
        }
        out.push_str(effective);
        out.push('\n');
    }
    out
}

/// Strip trailing `# comment` from a NAMESPACE line, respecting quoted strings.
fn strip_trailing_comment(line: &str) -> &str {
    let mut in_quote: Option<char> = None;
    for (i, c) in line.char_indices() {
        match in_quote {
            Some(q) if c == q => { in_quote = None; }
            Some(_) => {}
            None => match c {
                '"' | '\'' => { in_quote = Some(c); }
                '#' => return line[..i].trim_end(),
                _ => {}
            },
        }
    }
    line
}

fn strip_directive<'a>(line: &'a str, directive: &str) -> Option<&'a str> {
    let prefix = format!("{}(", directive);
    if line.starts_with(&prefix) && line.ends_with(')') {
        Some(&line[prefix.len()..line.len() - 1])
    } else {
        None
    }
}

fn split_args(args: &str) -> impl Iterator<Item = &str> {
    args.split(',').map(|s| s.trim())
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').trim_matches('\'').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn detect_package_workspace_with_description() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("DESCRIPTION"),
            "Package: mypkg\nVersion: 1.0.0\n",
        )
        .unwrap();
        let ws = detect_package_workspace(dir.path());
        assert!(ws.is_some());
        let ws = ws.unwrap();
        assert_eq!(ws.name, "mypkg");
        assert!(!ws.roxygen_managed);
    }

    #[test]
    fn detect_package_workspace_none_without_description() {
        let dir = TempDir::new().unwrap();
        let ws = detect_package_workspace(dir.path());
        assert!(ws.is_none());
    }

    #[test]
    fn detect_roxygen_managed() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("DESCRIPTION"),
            "Package: mypkg\nVersion: 1.0.0\n",
        )
        .unwrap();
        let r_dir = dir.path().join("R");
        fs::create_dir(&r_dir).unwrap();
        fs::write(r_dir.join("foo.R"), "#' @export\nfoo <- function() {}\n").unwrap();
        let ws = detect_package_workspace(dir.path()).unwrap();
        assert!(ws.roxygen_managed);
    }

    #[test]
    fn namespace_model_from_content_basic() {
        let content = r#"
export(foo)
export(bar, baz)
importFrom(dplyr, mutate, filter)
import(ggplot2)
S3method(print, myclass)
"#;
        let model = namespace_model_from_content(content);
        assert!(model.exports.contains("foo"));
        assert!(model.exports.contains("bar"));
        assert!(model.exports.contains("baz"));
        assert!(model.exports.contains("print.myclass"));
        assert_eq!(model.imports.len(), 2);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
        assert_eq!(model.full_imports, vec!["ggplot2"]);
    }

    #[test]
    fn namespace_model_from_content_multiline() {
        let content = "importFrom(dplyr,\n  mutate,\n  filter)\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
        assert!(model.exports.contains("foo"));
    }

    #[test]
    fn namespace_model_from_roxygen_aggregates() {
        use crate::roxygen::RoxygenNamespace;
        let files = vec![
            (
                "R/a.R".to_string(),
                RoxygenNamespace {
                    exports: vec!["foo".into()],
                    imports: vec!["ggplot2".into()],
                    import_from: vec![("dplyr".into(), "mutate".into())],
                },
            ),
            (
                "R/b.R".to_string(),
                RoxygenNamespace {
                    exports: vec!["bar".into()],
                    imports: vec![],
                    import_from: vec![("dplyr".into(), "filter".into())],
                },
            ),
        ];
        let model = namespace_model_from_roxygen(&files);
        assert!(model.exports.contains("foo"));
        assert!(model.exports.contains("bar"));
        assert_eq!(model.full_imports, vec!["ggplot2"]);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
    }

    #[test]
    fn namespace_trailing_comment() {
        let content = "importFrom(dplyr, mutate) # pipe-friendly\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.exports.contains("foo"));
    }

    #[test]
    fn namespace_multiline_with_comment() {
        let content = "importFrom(dplyr,\n  # the main verb\n  mutate,\n  filter)\n";
        let model = namespace_model_from_content(content);
        assert!(model.imports.contains(&("dplyr".into(), "mutate".into())));
        assert!(model.imports.contains(&("dplyr".into(), "filter".into())));
    }

    #[test]
    fn normalize_multiline_quoted_parens() {
        let content = "exportPattern(\"^[^(]\")\nexport(foo)\n";
        let normalized = normalize_multiline(content);
        assert_eq!(normalized, "exportPattern(\"^[^(]\")\nexport(foo)\n");
    }

    #[test]
    fn strip_trailing_comment_respects_quoted_hash() {
        // # inside a quoted string should NOT be treated as a comment
        assert_eq!(strip_trailing_comment(r#"exportPattern("^[^#].*")"#), r#"exportPattern("^[^#].*")"#);
        assert_eq!(strip_trailing_comment(r#"export(foo) # comment"#), "export(foo)");
        assert_eq!(strip_trailing_comment(r#"export("a#b")"#), r#"export("a#b")"#);
        // Single-quoted
        assert_eq!(strip_trailing_comment("export('a#b')"), "export('a#b')");
    }

    #[test]
    fn namespace_export_pattern_with_hash_in_regex() {
        // exportPattern with # in the regex should parse correctly
        let content = "exportPattern(\"^[^#].*\")\nexport(foo)\n";
        let model = namespace_model_from_content(content);
        assert!(model.exports.contains("__PATTERN__:\"^[^#].*\""));
        assert!(model.exports.contains("foo"));
    }
}
