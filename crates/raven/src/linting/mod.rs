//! Native style/lint diagnostics.
//!
//! Implements a small set of `lintr`-equivalent rules natively against the
//! tree-sitter AST and raw text. No R subprocess; rules run in microseconds on
//! the already-parsed tree.
//!
//! Scope:
//! * `line_length` — flag lines wider than the configured maximum.
//! * `trailing_whitespace` — trailing spaces/tabs at end of line.
//! * `no_tab` — one diagnostic per line that contains a tab, anchored at
//!   the first tab on that line.
//! * `trailing_blank_lines` — blank lines at the very end of the file.
//! * `assignment_operator` — enforce `<-` (or `=`) for top-level assignment.
//! * `object_name` — enforce a naming scheme (snake_case, camelCase, etc.)
//!   on assignment targets and function arguments.
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

pub use self::config::{AssignmentOperatorStyle, LintConfig, ObjectNameStyle};

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
    if let Some(sev) = config.object_name_severity {
        rules::object_name::collect(
            text,
            tree_root,
            rules::object_name::ObjectNameStyles {
                function: config.object_name_style_function,
                variable: config.object_name_style_variable,
                argument: config.object_name_style_argument,
            },
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
    fn assignment_operator_flags_inside_function_body_passed_as_arg() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            ..enabled_config()
        };
        // `y = x` inside the function body is a real assignment, not a named
        // argument — even though it lives transitively under an arguments
        // list. Regression: an earlier draft propagated a sticky
        // `inside_call_args` flag through descendants and suppressed this.
        let diags = lint("lapply(xs, function(x) { y = x; y })\n", &config);
        assert_eq!(
            diags.len(),
            1,
            "expected exactly one assignment-operator lint for `y = x`, got {:?}",
            diags
        );
    }

    #[test]
    fn assignment_operator_flags_inside_braced_block_passed_as_arg() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            ..enabled_config()
        };
        // `{ y = 1 }` is a braced expression evaluated as the argument; the
        // inner `y = 1` is a real assignment, not a named argument.
        let diags = lint("f({ y = 1 })\n", &config);
        assert_eq!(diags.len(), 1);
    }

    #[test]
    fn assignment_operator_flags_inside_if_body_passed_as_arg() {
        let config = LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            ..enabled_config()
        };
        // `y = 1` is the body of an `if` used as an argument — a real
        // assignment evaluated when the call runs.
        let diags = lint("f(if (cond) y = 1)\n", &config);
        assert_eq!(diags.len(), 1);
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

    fn object_name_only_config() -> LintConfig {
        LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            ..enabled_config()
        }
    }

    #[test]
    fn object_name_flags_camelcase_variable_under_snake_case() {
        let config = object_name_only_config();
        let diags = lint("myVar <- 1\n", &config);
        assert_eq!(diags.len(), 1, "expected one diagnostic, got {:?}", diags);
        assert!(diags[0].message.contains("Variable name `myVar`"));
        assert!(diags[0].message.contains("snake_case"));
    }

    #[test]
    fn object_name_accepts_snake_case() {
        let config = object_name_only_config();
        let diags = lint("my_var <- 1\nmy_func <- function(x_arg, y_arg) x_arg + y_arg\n", &config);
        assert!(diags.is_empty(), "snake_case names should pass: {:?}", diags);
    }

    #[test]
    fn object_name_flags_function_name() {
        let config = object_name_only_config();
        let diags = lint("MyFunc <- function() 1\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("Function name `MyFunc`"));
    }

    #[test]
    fn object_name_flags_argument_names() {
        let config = object_name_only_config();
        let diags = lint("f <- function(badArg, goodArg, other) 1\n", &config);
        // Two camelCase args should be flagged; `other` is fine.
        let arg_diags: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("Argument name"))
            .collect();
        assert_eq!(arg_diags.len(), 2, "got {:?}", diags);
    }

    #[test]
    fn object_name_exempts_s3_method_dispatch() {
        let config = object_name_only_config();
        // `print.MyClass <- function(x, ...) ...` is S3 dispatch; the function
        // name must not be flagged even though it isn't snake_case.
        let diags = lint("print.MyClass <- function(x, ...) NULL\n", &config);
        let fn_diags: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("Function name"))
            .collect();
        assert!(fn_diags.is_empty(), "S3 method should be exempt: {:?}", diags);
    }

    #[test]
    fn object_name_still_flags_non_dispatch_dotted_function() {
        let config = object_name_only_config();
        // All-lowercase dotted name is *not* method dispatch; under snake_case
        // it's still a violation (the dot is not a snake_case separator).
        let diags = lint("my.func <- function() 1\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("Function name `my.func`"));
    }

    #[test]
    fn object_name_skips_named_arguments() {
        let config = object_name_only_config();
        // `myArg` is a parameter name (flag), and `someArg = 1` inside the
        // function call is a named argument (no flag). Net: one diagnostic.
        let diags = lint("f <- function(myArg) g(someArg = 1)\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
        assert!(diags[0].message.contains("Argument name `myArg`"));
    }

    #[test]
    fn object_name_skips_compound_lhs() {
        let config = object_name_only_config();
        // `obj$badName <- 1` doesn't introduce a new symbol — just updates a
        // field. Should not flag.
        let diags = lint("obj$badName <- 1\n", &config);
        assert!(diags.is_empty(), "compound LHS should be skipped: {:?}", diags);
    }

    #[test]
    fn object_name_skips_backtick_quoted_names() {
        let config = object_name_only_config();
        let diags = lint("`with spaces` <- 1\n", &config);
        assert!(diags.is_empty(), "backtick names should be skipped: {:?}", diags);
    }

    #[test]
    fn object_name_camel_case_style_flags_snake_case() {
        let mut config = object_name_only_config();
        config.object_name_style_variable = ObjectNameStyle::CamelCase;
        let diags = lint("my_var <- 1\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("camelCase"));
    }

    #[test]
    fn object_name_any_disables_specific_kind() {
        let mut config = object_name_only_config();
        config.object_name_style_function = ObjectNameStyle::Any;
        // Variable is still checked, function is not.
        let diags = lint("BadName <- function() badVar <- 1\n", &config);
        // BadName (function): exempt; badVar (variable inside function): flagged.
        let fn_diags = diags
            .iter()
            .filter(|d| d.message.contains("Function name"))
            .count();
        let var_diags = diags
            .iter()
            .filter(|d| d.message.contains("Variable name"))
            .count();
        assert_eq!(fn_diags, 0);
        assert_eq!(var_diags, 1);
    }

    #[test]
    fn object_name_respects_arrow_right_assignment() {
        let config = object_name_only_config();
        let diags = lint("1 -> BadName\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("Variable name `BadName`"));
    }

    #[test]
    fn object_name_respects_nolint_marker() {
        let config = object_name_only_config();
        let diags = lint("BadName <- 1 # nolint\n", &config);
        assert!(diags.is_empty(), "nolint should suppress: {:?}", diags);
    }

    #[test]
    fn object_name_severity_off_disables_rule() {
        let mut config = object_name_only_config();
        config.object_name_severity = None;
        let diags = lint("BadName <- 1\n", &config);
        assert!(diags.is_empty());
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

