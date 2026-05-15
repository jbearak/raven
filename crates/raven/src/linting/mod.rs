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
//! * `infix_spaces` — flag missing spaces around binary infix operators and
//!   stray spaces around tight-binding operators (`::`, `$`, `:`, unary `-/+/!`).
//! * `commented_code` — flag standalone comment blocks whose body parses as R
//!   and contains a call, assignment, operator, or function definition. This
//!   rule additionally re-parses each candidate comment body via the
//!   thread-local parser pool; every other rule walks only the
//!   already-parsed tree.
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
    if let Some(sev) = config.infix_spaces_severity {
        rules::infix_spaces::collect(text, tree_root, sev, &suppressions, &mut out);
    }
    if let Some(sev) = config.commented_code_severity {
        rules::commented_code::collect(text, tree_root, sev, &suppressions, &mut out);
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
            infix_spaces_severity: None,
            commented_code_severity: None,
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
    fn object_name_flags_dotted_function_with_unknown_generic_prefix() {
        let config = object_name_only_config();
        // `foo` is not a known base R S3 generic, so `foo.Bar` is *not*
        // auto-exempted — the user gets a snake_case violation instead of a
        // silent pass. Regression for the original over-broad heuristic that
        // exempted any function name with an uppercase post-dot suffix.
        let diags = lint("foo.Bar <- function() 1\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
        assert!(diags[0].message.contains("Function name `foo.Bar`"));
    }

    #[test]
    fn object_name_accepts_leading_dot_hidden_names() {
        let config = object_name_only_config();
        // R uses a leading `.` to mark "hidden" identifiers; lintr accepts
        // it as decorative on every scheme. Don't flag `.foo`, `.my_var`, or
        // `.helper <- function(...)`.
        let diags = lint(
            ".hidden_var <- 1\n.another_var <- 2\n.helper <- function(x_arg) x_arg\n",
            &config,
        );
        assert!(diags.is_empty(), "leading-dot names should be allowed: {:?}", diags);
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
    fn object_name_respects_lsp_ignore_marker() {
        let config = object_name_only_config();
        // Same-line `# @lsp-ignore` and next-line `# @lsp-ignore-next`
        // markers must suppress object-name diagnostics, same as `# nolint`.
        // Sanity check that the new rule is wired through the shared
        // `Suppressions` infrastructure.
        let diags = lint(
            "BadOne <- 1 # @lsp-ignore\n# @lsp-ignore-next\nBadTwo <- 2\nBadThree <- 3\n",
            &config,
        );
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(!lines.contains(&0), "@lsp-ignore should suppress line 0: {:?}", diags);
        assert!(!lines.contains(&2), "@lsp-ignore-next should suppress line 2: {:?}", diags);
        assert!(lines.contains(&3), "unsuppressed line 3 should still flag: {:?}", diags);
    }

    #[test]
    fn object_name_exempts_methods_of_dotted_generics() {
        let config = object_name_only_config();
        // Regression test for the unreachable-GENERICS bug: methods of
        // generics that themselves contain dots (`as.Date`, `is.numeric`,
        // `all.equal`, `fitted.values`) must be exempt. Previously the
        // prefix-before-first-dot lookup yielded `"as"` / `"is"` / `"all"`
        // (none in the allowlist), false-flagging legitimate S3 methods.
        let src = "\
as.Date.character <- function(x, ...) NULL
as.numeric.MyClass <- function(x) NULL
is.character.foo <- function(x) NULL
all.equal.MyModel <- function(target, current, ...) NULL
print.data.frame <- function(x, ...) NULL
";
        let diags = lint(src, &config);
        assert!(
            diags.is_empty(),
            "methods of dotted/multi-part generics must be exempt: {:?}",
            diags
        );
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

    fn infix_spaces_only_config() -> LintConfig {
        LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            object_name_severity: None,
            commented_code_severity: None,
            ..enabled_config()
        }
    }

    #[test]
    fn infix_spaces_flags_missing_spaces_around_plus() {
        let config = infix_spaces_only_config();
        let diags = lint("x <- 1+2\n", &config);
        assert_eq!(diags.len(), 2, "expected 2 diagnostics (before+after), got {:?}", diags);
        for d in &diags {
            assert!(d.message.contains("space"), "msg: {}", d.message);
            assert!(d.message.contains("`+`"), "msg: {}", d.message);
        }
    }

    #[test]
    fn infix_spaces_flags_only_missing_side() {
        let config = infix_spaces_only_config();
        let diags = lint("x <- 1 +2\n", &config);
        assert_eq!(diags.len(), 1);
        assert!(diags[0].message.contains("after"));
    }

    #[test]
    fn infix_spaces_does_not_flag_correct_spacing() {
        let config = infix_spaces_only_config();
        let diags = lint("x <- a + b * c / d ^ e\n", &config);
        assert!(diags.is_empty(), "expected no diagnostics, got {:?}", diags);
    }

    #[test]
    fn infix_spaces_does_not_flag_alignment_whitespace() {
        // Multiple spaces around an operator are allowed — alignment is a
        // common pattern and collapsing it would be more annoying than helpful.
        let config = infix_spaces_only_config();
        let diags = lint("x   <-   1\n", &config);
        assert!(diags.is_empty(), "alignment spaces must not be flagged: {:?}", diags);
    }

    #[test]
    fn infix_spaces_flags_namespace_op_with_spaces() {
        let config = infix_spaces_only_config();
        // `pkg :: fun` shouldn't have spaces around `::`. But tree-sitter-r
        // only parses `pkg::fun` as `namespace_operator` when the operator is
        // tight — verify it's a no-op when written that way.
        let diags = lint("x <- pkg::fun()\n", &config);
        assert!(diags.is_empty(), "tight `::` must not be flagged: {:?}", diags);
    }

    #[test]
    fn infix_spaces_flags_extract_op_with_spaces() {
        let config = infix_spaces_only_config();
        // `obj $ field` has stray whitespace around `$`. tree-sitter-r still
        // recognises this as `extract_operator`.
        let diags = lint("x <- obj $ field\n", &config);
        assert!(!diags.is_empty(), "stray space around `$` must be flagged");
        assert!(diags.iter().all(|d| d.message.contains("`$`")));
    }

    #[test]
    fn infix_spaces_flags_at_op_with_spaces() {
        let config = infix_spaces_only_config();
        // `obj @ slot` (S4 slot access) is also `extract_operator`.
        let diags = lint("x <- obj @ slot\n", &config);
        assert!(!diags.is_empty(), "stray space around `@` must be flagged");
        assert!(diags.iter().all(|d| d.message.contains("`@`")));
    }

    #[test]
    fn infix_spaces_flags_unary_not_with_space() {
        let config = infix_spaces_only_config();
        // Unary `!` should be tight against its operand.
        let diags = lint("y <- ! x\n", &config);
        let unary_diags: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("unary") && d.message.contains("`!`"))
            .collect();
        assert_eq!(unary_diags.len(), 1, "got {:?}", diags);
    }

    #[test]
    fn infix_spaces_flags_sequence_op_with_spaces() {
        let config = infix_spaces_only_config();
        // `1 : 10` — spaces around `:` are wrong for the sequence operator.
        let diags = lint("xs <- 1 : 10\n", &config);
        assert_eq!(diags.len(), 2, "got {:?}", diags);
        assert!(diags.iter().all(|d| d.message.contains("`:`")));
    }

    #[test]
    fn infix_spaces_tight_sequence_is_ok() {
        let config = infix_spaces_only_config();
        let diags = lint("xs <- 1:10\n", &config);
        assert!(diags.is_empty(), "tight `:` must not be flagged: {:?}", diags);
    }

    #[test]
    fn infix_spaces_flags_unary_minus_with_space() {
        let config = infix_spaces_only_config();
        // `- x` has a space after the unary minus — should be flagged.
        let diags = lint("y <- - x\n", &config);
        let unary_diags: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("unary"))
            .collect();
        assert_eq!(unary_diags.len(), 1, "got {:?}", diags);
    }

    #[test]
    fn infix_spaces_tight_unary_minus_is_ok() {
        let config = infix_spaces_only_config();
        let diags = lint("y <- -x\n", &config);
        assert!(diags.is_empty(), "tight unary `-` must not be flagged: {:?}", diags);
    }

    #[test]
    fn infix_spaces_does_not_flag_binary_minus() {
        let config = infix_spaces_only_config();
        // `a - b` with binary minus and spaces — fine.
        let diags = lint("y <- a - b\n", &config);
        assert!(diags.is_empty(), "binary `-` with spaces must pass: {:?}", diags);
    }

    #[test]
    fn infix_spaces_does_not_flag_named_argument() {
        let config = infix_spaces_only_config();
        // tree-sitter-r parses `name=value` inside a call as an `argument`
        // node, never a `binary_operator`. The infix-spaces rule must never
        // touch named arguments — they are an unrelated syntactic form.
        let diags = lint("f(name=value)\n", &config);
        assert!(diags.is_empty(), "named arguments must not be flagged: {:?}", diags);
    }

    #[test]
    fn infix_spaces_does_not_flag_function_default_argument() {
        let config = infix_spaces_only_config();
        // tree-sitter-r parses formal-parameter defaults like `x=1` as a
        // `parameter` node (operator `=` is a direct child), not as a
        // `binary_operator`. The rule must therefore leave both spaced and
        // unspaced defaults alone.
        let no_space = lint("f <- function(x=1) x\n", &config);
        let with_space = lint("f <- function(x = 1) x\n", &config);
        assert!(
            no_space.is_empty(),
            "function(x=1) defaults must not be flagged: {:?}",
            no_space
        );
        assert!(
            with_space.is_empty(),
            "function(x = 1) defaults must not be flagged: {:?}",
            with_space
        );
    }

    #[test]
    fn infix_spaces_does_not_flag_line_continuation() {
        let config = infix_spaces_only_config();
        // Operator at end of line, RHS on the next line — the newline supplies
        // the separation, so neither side should be flagged.
        let diags = lint("x <- a +\n  b\n", &config);
        assert!(diags.is_empty(), "line-continuation `+` must not be flagged: {:?}", diags);
    }

    #[test]
    fn infix_spaces_handles_comment_before_operand() {
        // Regression: ensures `child_by_field_name("rhs")` (rather than
        // positional walking) picks the real operand even when a comment
        // node intervenes between the operator and its operand.
        let config = infix_spaces_only_config();
        // A comment between `<-` and `1` is uncommon but legal R. The rule
        // should still be able to evaluate the gap consistently — and since
        // the comment forces a newline before `1`, `gap_text` returns `None`
        // (line-continuation case), so no diagnostic should be produced.
        let diags = lint("x <- # comment\n  1\n", &config);
        assert!(
            diags.is_empty(),
            "comment-then-newline gap must not produce diagnostics: {:?}",
            diags
        );
    }

    #[test]
    fn infix_spaces_flags_custom_percent_op_with_missing_spaces() {
        let config = infix_spaces_only_config();
        let diags = lint("x <- a%>%b\n", &config);
        assert_eq!(diags.len(), 2, "got {:?}", diags);
        assert!(diags.iter().all(|d| d.message.contains("`%>%`")));
    }

    #[test]
    fn infix_spaces_flags_assignment_without_spaces() {
        let config = infix_spaces_only_config();
        let diags = lint("x<-1\n", &config);
        assert_eq!(diags.len(), 2, "got {:?}", diags);
        assert!(diags.iter().all(|d| d.message.contains("`<-`")));
    }

    #[test]
    fn infix_spaces_flags_comparison_without_spaces() {
        let config = infix_spaces_only_config();
        let diags = lint("if (a<=b) NULL\n", &config);
        assert_eq!(diags.len(), 2);
        assert!(diags.iter().all(|d| d.message.contains("`<=`")));
    }

    #[test]
    fn infix_spaces_flags_logical_without_spaces() {
        let config = infix_spaces_only_config();
        let diags = lint("if (a&&b) NULL\n", &config);
        assert_eq!(diags.len(), 2);
        assert!(diags.iter().all(|d| d.message.contains("`&&`")));
    }

    #[test]
    fn infix_spaces_flags_formula_without_spaces() {
        let config = infix_spaces_only_config();
        let diags = lint("m <- lm(y~x)\n", &config);
        let tilde_diags: Vec<_> = diags
            .iter()
            .filter(|d| d.message.contains("`~`"))
            .collect();
        assert_eq!(tilde_diags.len(), 2, "got {:?}", diags);
    }

    #[test]
    fn infix_spaces_does_not_flag_unary_formula() {
        let config = infix_spaces_only_config();
        // `~ x` and `~x` are both acceptable formula-head forms. The rule
        // should not touch unary `~` either way.
        let no_space = lint("f(~x)\n", &config);
        let with_space = lint("f(~ x)\n", &config);
        assert!(no_space.is_empty(), "unary `~x` must pass: {:?}", no_space);
        assert!(
            with_space.is_empty(),
            "unary `~ x` must pass: {:?}",
            with_space
        );
    }

    #[test]
    fn infix_spaces_does_not_flag_pipe_with_spaces() {
        let config = infix_spaces_only_config();
        let diags = lint("xs |> length()\n", &config);
        assert!(diags.is_empty(), "pipe with spaces must pass: {:?}", diags);
    }

    #[test]
    fn infix_spaces_respects_nolint() {
        let config = infix_spaces_only_config();
        let diags = lint("x <- 1+2 # nolint\n", &config);
        assert!(diags.is_empty(), "nolint must suppress: {:?}", diags);
    }

    #[test]
    fn infix_spaces_respects_lsp_ignore_next() {
        let config = infix_spaces_only_config();
        let diags = lint("# @lsp-ignore-next\nx <- 1+2\ny <- 3+4\n", &config);
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(!lines.contains(&1), "@lsp-ignore-next must suppress line 1: {:?}", diags);
        assert!(lines.contains(&2), "unsuppressed line 2 must still flag: {:?}", diags);
    }

    #[test]
    fn infix_spaces_severity_off_disables_rule() {
        let mut config = infix_spaces_only_config();
        config.infix_spaces_severity = None;
        let diags = lint("x<-1\n", &config);
        assert!(diags.is_empty(), "rule must be silent when severity is None: {:?}", diags);
    }

    fn commented_code_only_config() -> LintConfig {
        LintConfig {
            line_length_severity: None,
            trailing_whitespace_severity: None,
            no_tab_severity: None,
            trailing_blank_lines_severity: None,
            assignment_operator_severity: None,
            object_name_severity: None,
            infix_spaces_severity: None,
            ..enabled_config()
        }
    }

    #[test]
    fn commented_code_flags_obvious_call() {
        let config = commented_code_only_config();
        let diags = lint("# foo(bar, baz)\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
        assert!(diags[0].message.contains("Commented code"));
        assert_eq!(diags[0].range.start.line, 0);
    }

    #[test]
    fn commented_code_flags_assignment() {
        let config = commented_code_only_config();
        let diags = lint("# x <- 1 + 2\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
    }

    #[test]
    fn commented_code_skips_prose_without_operators() {
        let config = commented_code_only_config();
        // Bare identifier — could be a noun in prose. Don't flag.
        let diags = lint("# foo\n# another comment\n", &config);
        assert!(diags.is_empty(), "prose must not be flagged: {:?}", diags);
    }

    #[test]
    fn commented_code_skips_roxygen() {
        let config = commented_code_only_config();
        // Roxygen blocks routinely contain code-shaped examples like
        // `@param x default 1` — those must not be flagged.
        let diags = lint("#' @param x default value\n#' foo(bar = 1)\n", &config);
        assert!(diags.is_empty(), "roxygen must not be flagged: {:?}", diags);
    }

    #[test]
    fn commented_code_skips_shebang_on_first_line() {
        let config = commented_code_only_config();
        let diags = lint("#!/usr/bin/env Rscript\n", &config);
        assert!(diags.is_empty(), "shebang must not be flagged: {:?}", diags);
    }

    #[test]
    fn commented_code_skips_todo_and_fixme_lines() {
        let config = commented_code_only_config();
        let diags = lint(
            "# TODO: rewrite foo(x, y)\n# FIXME(jmb): fix logger(level)\n# NOTE: see help() below\n",
            &config,
        );
        assert!(
            diags.is_empty(),
            "annotation comments must not be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_skips_directive_markers() {
        let config = commented_code_only_config();
        // `# nolint`, `# @lsp-source`, etc. must never be flagged — these are
        // suppression / cross-file directives, not commented-out code.
        let diags = lint(
            "# nolint\n# nolint: line_length\n# @lsp-source ../helpers.R\n# @lsp-ignore\n",
            &config,
        );
        assert!(
            diags.is_empty(),
            "directive markers must not be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_skips_end_of_line_comments() {
        let config = commented_code_only_config();
        // The `# x <- 2` is an end-of-line annotation, not standalone dead
        // code. Don't flag.
        let diags = lint("x <- 1 # x <- 2\n", &config);
        assert!(
            diags.is_empty(),
            "end-of-line comment must not be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_groups_contiguous_block() {
        let config = commented_code_only_config();
        // Two commented-out code lines that are syntactically valid R when
        // joined. Should produce *one* diagnostic for the whole block.
        let diags = lint("# x <- 1\n# y <- x + 2\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
        let d = &diags[0];
        assert_eq!(d.range.start.line, 0);
        assert_eq!(d.range.end.line, 1);
    }

    #[test]
    fn commented_code_respects_nolint_block() {
        let config = commented_code_only_config();
        // For commented-out code, an inline `# nolint` suffix can't suppress
        // the diagnostic — the `#` of the marker is itself inside the comment
        // and so the Suppressions parser never sees a fresh `# nolint`. The
        // supported patterns are bracketed blocks and `# @lsp-ignore-next`.
        let diags = lint("# nolint start\n# x <- 1 + 2\n# nolint end\n", &config);
        assert!(diags.is_empty(), "nolint block must suppress: {:?}", diags);
    }

    #[test]
    fn commented_code_respects_lsp_ignore_next() {
        let config = commented_code_only_config();
        let diags = lint("# @lsp-ignore-next\n# x <- 1 + 2\n# y <- 3 + 4\n", &config);
        // `@lsp-ignore-next` suppresses line 1. Line 2 is also commented
        // code, and it must STILL be flagged — the contiguous block is split
        // at the directive line and at the suppressed line, leaving line 2
        // as its own sub-group that the rule evaluates independently.
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(
            !lines.contains(&1),
            "@lsp-ignore-next must suppress line 1: {:?}",
            diags
        );
        assert!(
            lines.contains(&2),
            "unsuppressed line 2 must still be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_splits_block_at_directive_line() {
        let config = commented_code_only_config();
        // A `# @lsp-source` directive sandwiched between two real commented
        // code lines must NOT swallow them. The block should split into two
        // single-line sub-groups; each parses as code and is reported.
        let diags = lint(
            "# x <- 1\n# @lsp-source ../helpers.R\n# y <- 2\n",
            &config,
        );
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(
            lines.contains(&0),
            "line 0 commented code must still flag: {:?}",
            diags
        );
        assert!(
            lines.contains(&2),
            "line 2 commented code must still flag: {:?}",
            diags
        );
        assert!(
            !lines.contains(&1),
            "directive line itself must not be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_splits_block_at_shebang_line() {
        let config = commented_code_only_config();
        // Shebang on line 0 plus commented code on line 1 must not silently
        // skip the commented code as part of the same block.
        let diags = lint("#!/usr/bin/env Rscript\n# x <- 1\n", &config);
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(
            lines.contains(&1),
            "commented code adjacent to shebang must flag: {:?}",
            diags
        );
        assert!(
            !lines.contains(&0),
            "shebang itself must not be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_splits_block_at_todo_line() {
        let config = commented_code_only_config();
        // Same idea with an annotation comment in the middle.
        let diags = lint(
            "# x <- 1\n# TODO: revisit\n# y <- 2\n",
            &config,
        );
        let lines: Vec<u32> = diags.iter().map(|d| d.range.start.line).collect();
        assert!(lines.contains(&0));
        assert!(lines.contains(&2));
        assert!(!lines.contains(&1));
    }

    #[test]
    fn commented_code_flags_multi_line_block_when_individual_lines_dont_parse() {
        let config = commented_code_only_config();
        // Each individual line is not a complete R expression — only the
        // joined block parses. The grouping pass should still flag the
        // block. This is the headline value-add of the contiguous-grouping
        // logic vs. line-at-a-time evaluation.
        let diags = lint("# function(x) {\n#   x + 1\n# }\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
        assert_eq!(diags[0].range.start.line, 0);
        assert_eq!(diags[0].range.end.line, 2);
    }

    #[test]
    fn commented_code_still_groups_when_no_skip_lines() {
        let config = commented_code_only_config();
        // Without any skip lines in between, a contiguous block should still
        // join as one diagnostic — Codex's regression case must not break
        // the original grouping behaviour.
        let diags = lint("# x <- 1\n# y <- x + 2\n# z <- y * 3\n", &config);
        assert_eq!(diags.len(), 1, "got {:?}", diags);
        assert_eq!(diags[0].range.start.line, 0);
        assert_eq!(diags[0].range.end.line, 2);
    }

    #[test]
    fn commented_code_skips_mode_line() {
        let config = commented_code_only_config();
        let diags = lint("# -*- coding: utf-8 -*-\n", &config);
        assert!(
            diags.is_empty(),
            "Emacs mode line must not be flagged: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_severity_off_disables_rule() {
        let mut config = commented_code_only_config();
        config.commented_code_severity = None;
        let diags = lint("# x <- 1\n", &config);
        assert!(
            diags.is_empty(),
            "rule must be silent when severity is None: {:?}",
            diags
        );
    }

    #[test]
    fn commented_code_diagnostic_carries_lint_source() {
        let config = commented_code_only_config();
        let diags = lint("# foo(bar)\n", &config);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].source.as_deref(), Some(LINT_SOURCE));
    }
}

