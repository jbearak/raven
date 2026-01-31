//
// cross_file/directive.rs
//
// Directive parsing for cross-file awareness
//

use regex::Regex;
use std::sync::OnceLock;

use super::types::{BackwardDirective, CallSiteSpec, CrossFileMetadata, ForwardSource};

/// Compiled regex patterns for directive parsing
struct DirectivePatterns {
    backward: Regex,
    forward: Regex,
    working_dir: Regex,
    ignore: Regex,
    ignore_next: Regex,
}

fn patterns() -> &'static DirectivePatterns {
    static PATTERNS: OnceLock<DirectivePatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        DirectivePatterns {
            backward: Regex::new(
                r#"#\s*@lsp-(?:sourced-by|run-by|included-by)\s*:?\s*["']?([^"'\s]+)["']?(?:\s+line\s*=\s*(\d+))?(?:\s+match\s*=\s*["']([^"']+)["'])?"#
            ).unwrap(),
            forward: Regex::new(
                r#"#\s*@lsp-source\s*:?\s*["']?([^"'\s]+)["']?"#
            ).unwrap(),
            working_dir: Regex::new(
                r#"#\s*@lsp-(?:working-directory|working-dir|current-directory|current-dir|cd|wd)\s*:?\s*["']?([^"'\s]+)["']?"#
            ).unwrap(),
            ignore: Regex::new(
                r"#\s*@lsp-ignore\s*:?\s*$"
            ).unwrap(),
            ignore_next: Regex::new(
                r"#\s*@lsp-ignore-next\s*:?\s*$"
            ).unwrap(),
        }
    })
}

/// Parse directives from file content
pub fn parse_directives(content: &str) -> CrossFileMetadata {
    log::trace!("Starting directive parsing");
    let patterns = patterns();
    let mut meta = CrossFileMetadata::default();

    for (line_num, line) in content.lines().enumerate() {
        let line_num = line_num as u32;

        // Check backward directives
        if let Some(caps) = patterns.backward.captures(line) {
            let path = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let call_site = if let Some(line_match) = caps.get(2) {
                // Convert 1-based user input to 0-based internal
                let user_line: u32 = line_match.as_str().parse().unwrap_or(1);
                CallSiteSpec::Line(user_line.saturating_sub(1))
            } else if let Some(match_pattern) = caps.get(3) {
                CallSiteSpec::Match(match_pattern.as_str().to_string())
            } else {
                CallSiteSpec::Default
            };
            log::trace!(
                "  Parsed backward directive at line {}: path='{}' call_site={:?}",
                line_num,
                path,
                call_site
            );
            meta.sourced_by.push(BackwardDirective {
                path,
                call_site,
                directive_line: line_num,
            });
            continue;
        }

        // Check forward directive
        if let Some(caps) = patterns.forward.captures(line) {
            let path = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            log::trace!(
                "  Parsed forward directive at line {}: path='{}'",
                line_num,
                path
            );
            meta.sources.push(ForwardSource {
                path,
                line: line_num,
                column: 0,
                is_directive: true,
                local: false,
                chdir: false,
                is_sys_source: false,
                sys_source_global_env: true,
            });
            continue;
        }

        // Check working directory directive
        if let Some(caps) = patterns.working_dir.captures(line) {
            let path = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            log::trace!(
                "  Parsed working directory directive at line {}: path='{}'",
                line_num,
                path
            );
            meta.working_directory = Some(path);
            continue;
        }

        // Check ignore directives
        if patterns.ignore.is_match(line) {
            log::trace!("  Parsed @lsp-ignore directive at line {}", line_num);
            meta.ignored_lines.insert(line_num);
            continue;
        }

        if patterns.ignore_next.is_match(line) {
            log::trace!("  Parsed @lsp-ignore-next directive at line {}", line_num);
            meta.ignored_next_lines.insert(line_num + 1);
        }
    }

    log::trace!(
        "Completed directive parsing: {} backward directives, {} forward directives, working_dir={:?}, {} ignored lines",
        meta.sourced_by.len(),
        meta.sources.len(),
        meta.working_directory,
        meta.ignored_lines.len() + meta.ignored_next_lines.len()
    );

    meta
}

/// Check if a line should have diagnostics suppressed
pub fn is_line_ignored(metadata: &CrossFileMetadata, line: u32) -> bool {
    metadata.ignored_lines.contains(&line) || metadata.ignored_next_lines.contains(&line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backward_directive_basic() {
        let content = "# @lsp-sourced-by ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Default);
    }

    #[test]
    fn test_backward_directive_with_colon() {
        let content = "# @lsp-sourced-by: ../main.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_backward_directive_quoted() {
        let content = r#"# @lsp-sourced-by "../main.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_backward_directive_single_quoted() {
        let content = "# @lsp-sourced-by '../main.R'";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
    }

    #[test]
    fn test_backward_directive_with_line() {
        let content = "# @lsp-sourced-by ../main.R line=15";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Line(14)); // 0-based
    }

    #[test]
    fn test_backward_directive_with_match() {
        let content = r#"# @lsp-sourced-by ../main.R match="source(""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sourced_by[0].call_site, CallSiteSpec::Match("source(".to_string()));
    }

    #[test]
    fn test_backward_directive_synonyms() {
        let content = "# @lsp-run-by ../main.R\n# @lsp-included-by ../other.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 2);
        assert_eq!(meta.sourced_by[0].path, "../main.R");
        assert_eq!(meta.sourced_by[1].path, "../other.R");
    }

    #[test]
    fn test_forward_directive() {
        let content = "# @lsp-source utils.R";
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils.R");
        assert!(meta.sources[0].is_directive);
    }

    #[test]
    fn test_forward_directive_with_colon_and_quotes() {
        let content = r#"# @lsp-source: "utils/helpers.R""#;
        let meta = parse_directives(content);
        assert_eq!(meta.sources.len(), 1);
        assert_eq!(meta.sources[0].path, "utils/helpers.R");
    }

    #[test]
    fn test_working_directory_directive() {
        let content = "# @lsp-working-directory /data/scripts";
        let meta = parse_directives(content);
        assert_eq!(meta.working_directory, Some("/data/scripts".to_string()));
    }

    #[test]
    fn test_working_directory_synonyms() {
        for directive in ["@lsp-wd", "@lsp-cd", "@lsp-current-directory", "@lsp-current-dir", "@lsp-working-dir"] {
            let content = format!("# {} /data", directive);
            let meta = parse_directives(&content);
            assert_eq!(meta.working_directory, Some("/data".to_string()), "Failed for {}", directive);
        }
    }

    #[test]
    fn test_ignore_directive() {
        let content = "x <- 1\n# @lsp-ignore\ny <- undefined";
        let meta = parse_directives(content);
        assert!(meta.ignored_lines.contains(&1));
    }

    #[test]
    fn test_ignore_next_directive() {
        let content = "# @lsp-ignore-next\ny <- undefined";
        let meta = parse_directives(content);
        assert!(meta.ignored_next_lines.contains(&1));
    }

    #[test]
    fn test_is_line_ignored() {
        let content = "# @lsp-ignore\nx <- 1\n# @lsp-ignore-next\ny <- 2";
        let meta = parse_directives(content);
        assert!(is_line_ignored(&meta, 0)); // @lsp-ignore line
        assert!(!is_line_ignored(&meta, 1)); // x <- 1
        assert!(!is_line_ignored(&meta, 2)); // @lsp-ignore-next line
        assert!(is_line_ignored(&meta, 3)); // y <- 2 (next line after ignore-next)
    }

    #[test]
    fn test_multiple_directives() {
        let content = r#"# @lsp-sourced-by ../main.R line=10
# @lsp-working-directory /data
source("utils.R")
# @lsp-source helpers.R
# @lsp-ignore
x <- undefined"#;
        let meta = parse_directives(content);
        assert_eq!(meta.sourced_by.len(), 1);
        assert_eq!(meta.sources.len(), 1); // Only directive, not source() call
        assert_eq!(meta.working_directory, Some("/data".to_string()));
        assert!(meta.ignored_lines.contains(&4));
    }
}