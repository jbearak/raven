//! Native style/lint diagnostics.
//!
//! Implements a small set of `lintr`-equivalent rules natively against the
//! tree-sitter AST and raw text. No R subprocess; rules run in microseconds on
//! the already-parsed tree.
//!
//! Scope:
//! * `line_length` — flag lines wider than the configured maximum.
//! * `trailing_whitespace` — trailing spaces/tabs at end of line.
//! * `no_tab` — leading or interior tab characters.
//! * `trailing_blank_lines` — blank lines at the very end of the file.
//! * `assignment_operator` — enforce `<-` (or `=`) for top-level assignment.
//!
//! Suppression supports both lintr and Raven conventions:
//! * `# nolint` (with optional `: rule_a, rule_b` filter) suppresses the line.
//! * `# nolint start` / `# nolint end` brackets a region.
//! * `# @lsp-ignore` suppresses the line it appears on.
//! * `# @lsp-ignore-next` suppresses the *following* source line.

pub mod config;
mod nolint;
mod rules;

use tower_lsp::lsp_types::Diagnostic;
use tree_sitter::Node;

pub use self::config::{AssignmentOperatorStyle, LintConfig};

/// Source identifier set on every diagnostic produced by this module.
///
/// Lets clients (and tests) distinguish lint diagnostics from cross-file or
/// syntax diagnostics, and gives the user a recognizable badge in the editor.
pub const LINT_SOURCE: &str = "raven (lint)";

/// Run all enabled lint rules against the given document.
///
/// `text` is the document text and `tree_root` is the tree-sitter root node.
/// Returns an empty `Vec` when `config.enabled` is false; individual rules are
/// gated by their per-rule severity inside [`LintConfig`].
pub fn run_lints(text: &str, tree_root: Node<'_>, config: &LintConfig) -> Vec<Diagnostic> {
    if !config.enabled {
        return Vec::new();
    }

    let suppressions = nolint::Suppressions::from_text(text);
    let mut out = Vec::new();

    if let Some(sev) = config.line_length_severity {
        rules::line_length::collect(text, config.line_length, sev, &suppressions, &mut out);
    }
    if let Some(sev) = config.trailing_whitespace_severity {
        rules::trailing_whitespace::collect(text, sev, &suppressions, &mut out);
    }
    if let Some(sev) = config.no_tab_severity {
        rules::no_tab::collect(text, sev, &suppressions, &mut out);
    }
    if let Some(sev) = config.trailing_blank_lines_severity {
        rules::trailing_blank_lines::collect(text, sev, &suppressions, &mut out);
    }
    if let Some(sev) = config.assignment_operator_severity {
        rules::assignment_operator::collect(
            text,
            tree_root,
            config.assignment_operator_style,
            sev,
            &suppressions,
            &mut out,
        );
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser_pool::with_parser;
    use tower_lsp::lsp_types::DiagnosticSeverity;

    fn enabled_config() -> LintConfig {
        LintConfig {
            enabled: true,
            ..LintConfig::default()
        }
    }

    fn lint(text: &str, config: &LintConfig) -> Vec<Diagnostic> {
        let tree = with_parser(|p| p.parse(text, None)).expect("parse must succeed");
        run_lints(text, tree.root_node(), config)
    }

    #[test]
    fn master_switch_off_returns_empty() {
        let mut config = enabled_config();
        config.enabled = false;
        let diags = lint("x  \n", &config);
        assert!(diags.is_empty());
    }

    #[test]
    fn line_length_flags_only_overlong_lines() {
        let config = LintConfig {
            line_length: 10,
            ..enabled_config()
        };
        let diags = lint("short\nthis line is much too long\nshort\n", &config);
        let line_lints: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("characters long"))
            .collect();
        assert_eq!(line_lints.len(), 1);
        assert_eq!(line_lints[0].range.start.line, 1);
    }

    #[test]
    fn trailing_whitespace_is_flagged() {
        let config = LintConfig {
            line_length_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        };
        let diags = lint("x <- 1   \n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("Trailing whitespace"));
        assert_eq!(diags[0].range.start.character, 6);
    }

    #[test]
    fn no_tab_flags_first_run_per_line() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        };
        let diags = lint("\t\tx <- 1\n", &config);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].range.start.character, 0);
        assert_eq!(diags[0].range.end.character, 2);
    }

    #[test]
    fn trailing_blank_lines_flag_multiple() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        };
        let diags = lint("x <- 1\n\n\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("trailing blank"));
    }

    #[test]
    fn missing_final_newline_is_flagged() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        };
        let diags = lint("x <- 1", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("end with a newline"));
    }

    #[test]
    fn assignment_operator_flags_top_level_equals_when_left_arrow_preferred() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            ..enabled_config()
        };
        let diags = lint("x = 1\n", &config);
        let assign_lints: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("assignment"))
            .collect();
        assert_eq!(assign_lints.len(), 1);
    }

    #[test]
    fn assignment_operator_ignores_named_arguments() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            ..enabled_config()
        };
        // `n = 5` inside a call is a named argument, not assignment.
        let diags = lint("rnorm(n = 5)\n", &config);
        assert!(diags.is_empty(), "named-argument `=` must not be flagged");
    }

    #[test]
    fn assignment_operator_equals_style_flags_left_arrow() {
        let config = LintConfig {
            assignment_operator_style: AssignmentOperatorStyle::Equals,
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            ..enabled_config()
        };
        let diags = lint("x <- 1\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("Use `=`"));
    }

    #[test]
    fn nolint_line_suppresses_diagnostics_on_that_line() {
        let config = LintConfig {
            line_length: 10,
            line_length_severity: Some(DiagnosticSeverity::HINT),
            trailing_whitespace_severity: Some(DiagnosticSeverity::HINT),
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        };
        // Overlong + trailing whitespace, but suppressed.
        let diags = lint("this line is very long   # nolint\n", &config);
        assert!(diags.is_empty(), "nolint comment must suppress lints");
    }

    #[test]
    fn nolint_block_suppresses_a_range() {
        let config = LintConfig {
            line_length: 5,
            line_length_severity: Some(DiagnosticSeverity::HINT),
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        };
        let src = "longline_outside\n# nolint start\nlongline_inside_a\nlongline_inside_b\n# nolint end\nlongline_after\n";
        let diags = lint(src, &config);
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(lines.contains(&0));
        assert!(!lines.contains(&2));
        assert!(!lines.contains(&3));
        assert!(lines.contains(&5));
    }

    #[test]
    fn diagnostics_carry_lint_source() {
        let config = LintConfig {
            line_length: 5,
            ..enabled_config()
        };
        let diags = lint("longline\n", &config);
        assert!(!diags.is_empty());
        for d in &diags {
            assert_eq!(d.source.as_deref(), Some(LINT_SOURCE));
        }
    }
}

