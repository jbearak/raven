//! Indentation calculation for R smart indentation.
//!
//! This module computes the correct indentation amount based on the
//! detected context and user configuration (tab size, style preference).

use super::context::IndentContext;

/// Configuration for indentation calculation.
#[derive(Debug, Clone, PartialEq)]
pub struct IndentationConfig {
    /// Number of spaces per indentation level.
    pub tab_size: u32,
    /// Whether to use spaces (true) or tabs (false) for indentation.
    pub insert_spaces: bool,
    /// The indentation style to use.
    pub style: IndentationStyle,
}

impl Default for IndentationConfig {
    fn default() -> Self {
        Self {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        }
    }
}

/// Indentation style variants.
///
/// These correspond to common R coding conventions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IndentationStyle {
    /// RStudio style: same-line arguments align to opening paren,
    /// next-line arguments indent +tab_size from function line.
    #[default]
    RStudio,
    /// RStudio-minus style: all arguments indent +tab_size from
    /// previous line regardless of paren position.
    RStudioMinus,
}

/// Calculates the target indentation column based on context and configuration.
///
/// # Arguments
///
/// * `context` - The detected syntactic context
/// * `config` - User configuration for tab size and style
/// * `source` - The source code text (used for line indent lookups)
///
/// # Returns
///
/// The target column number for indentation (0-indexed).
pub fn calculate_indentation(
    context: IndentContext,
    config: IndentationConfig,
    source: &str,
) -> u32 {
    match context {
        IndentContext::AfterContinuationOperator {
            chain_start_col, ..
        } => {
            // Pipe chain continuation: indent from chain start
            // All continuation lines in a chain get the same indentation (straight mode)
            chain_start_col + config.tab_size
        }
        IndentContext::InsideParens {
            opener_line,
            opener_col,
            has_content_on_opener_line,
        } => {
            match config.style {
                IndentationStyle::RStudio => {
                    if has_content_on_opener_line {
                        // Align to column after opening paren
                        opener_col + 1
                    } else {
                        // Indent from function line
                        get_line_indent(source, opener_line) + config.tab_size
                    }
                }
                IndentationStyle::RStudioMinus => {
                    // Always indent from opener line + tab_size
                    get_line_indent(source, opener_line) + config.tab_size
                }
            }
        }
        IndentContext::InsideBraces { opener_line, .. } => {
            // Brace block: indent from brace line
            get_line_indent(source, opener_line) + config.tab_size
        }
        IndentContext::ClosingDelimiter { opener_line, .. } => {
            // Closing delimiter: align to opener line indentation
            get_line_indent(source, opener_line)
        }
        IndentContext::AfterCompleteExpression {
            enclosing_block_indent,
        } => {
            // Complete expression: return to enclosing block indentation
            enclosing_block_indent
        }
    }
}

/// Gets the indentation (leading whitespace column) of a specific line.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `line` - The line number (0-indexed)
///
/// # Returns
///
/// The column of the first non-whitespace character on the line.
pub fn get_line_indent(source: &str, line: u32) -> u32 {
    source
        .lines()
        .nth(line as usize)
        .map(|l| {
            l.chars()
                .take_while(|c| c.is_whitespace())
                .map(|c| if c == '\t' { 1 } else { 1 }) // Simplified: count chars
                .sum()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_indentation_config_default() {
        let config = IndentationConfig::default();
        assert_eq!(config.tab_size, 2);
        assert!(config.insert_spaces);
        assert_eq!(config.style, IndentationStyle::RStudio);
    }

    #[test]
    fn test_indentation_style_default() {
        let style = IndentationStyle::default();
        assert_eq!(style, IndentationStyle::RStudio);
    }

    #[test]
    fn test_get_line_indent() {
        let source = "no indent\n  two spaces\n    four spaces";
        assert_eq!(get_line_indent(source, 0), 0);
        assert_eq!(get_line_indent(source, 1), 2);
        assert_eq!(get_line_indent(source, 2), 4);
    }

    #[test]
    fn test_get_line_indent_empty_line() {
        let source = "first\n\nthird";
        assert_eq!(get_line_indent(source, 1), 0);
    }

    #[test]
    fn test_get_line_indent_out_of_bounds() {
        let source = "only one line";
        assert_eq!(get_line_indent(source, 10), 0);
    }

    #[test]
    fn test_get_line_indent_whitespace_only_line() {
        // Lines with only whitespace should return the whitespace count
        let source = "first\n    \nthird";
        assert_eq!(get_line_indent(source, 1), 4);
    }

    #[test]
    fn test_get_line_indent_with_tabs() {
        // Tab characters should be counted as 1 character each (simplified behavior)
        let source = "\tfirst\n\t\tsecond\n\t  mixed";
        assert_eq!(get_line_indent(source, 0), 1); // 1 tab
        assert_eq!(get_line_indent(source, 1), 2); // 2 tabs
        assert_eq!(get_line_indent(source, 2), 3); // 1 tab + 2 spaces
    }

    #[test]
    fn test_get_line_indent_mixed_whitespace() {
        // Mixed tabs and spaces
        let source = "  \t  code";
        assert_eq!(get_line_indent(source, 0), 5); // 2 spaces + 1 tab + 2 spaces
    }

    #[test]
    fn test_get_line_indent_empty_source() {
        // Empty source string
        let source = "";
        assert_eq!(get_line_indent(source, 0), 0);
    }

    #[test]
    fn test_get_line_indent_single_newline() {
        // Source with just a newline
        let source = "\n";
        assert_eq!(get_line_indent(source, 0), 0);
        assert_eq!(get_line_indent(source, 1), 0);
    }

    // ========================================================================
    // Pipe Chain Continuation Tests (Task 5.1)
    // ========================================================================

    #[test]
    fn test_pipe_chain_continuation_basic() {
        use super::super::context::OperatorType;

        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // Chain starts at column 0, so continuation should be at column 2
        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 2);
    }

    #[test]
    fn test_pipe_chain_continuation_with_offset() {
        use super::super::context::OperatorType;

        let config = IndentationConfig {
            tab_size: 4,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // Chain starts at column 4, so continuation should be at column 8
        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 4,
            operator_type: OperatorType::MagrittrPipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 8);
    }

    #[test]
    fn test_pipe_chain_continuation_all_operators_same_indent() {
        use super::super::context::OperatorType;

        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let chain_start_col = 0;
        let expected_indent = chain_start_col + config.tab_size;

        // All operator types should produce the same indentation (straight mode)
        let operators = [
            OperatorType::Pipe,
            OperatorType::MagrittrPipe,
            OperatorType::Plus,
            OperatorType::Tilde,
            OperatorType::CustomInfix,
        ];

        for op in operators {
            let context = IndentContext::AfterContinuationOperator {
                chain_start_line: 0,
                chain_start_col,
                operator_type: op,
            };

            let indent = calculate_indentation(context.clone(), config.clone(), "");
            assert_eq!(
                indent, expected_indent,
                "Operator {:?} should produce indent {}",
                op, expected_indent
            );
        }
    }

    #[test]
    fn test_pipe_chain_continuation_uniform_across_lines() {
        use super::super::context::OperatorType;

        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // Simulate multiple continuation lines in a chain
        // All should get the same indentation regardless of which line they're on
        let chain_start_col = 0;
        let expected_indent = chain_start_col + config.tab_size;

        for line in 1..5 {
            let context = IndentContext::AfterContinuationOperator {
                chain_start_line: 0,
                chain_start_col,
                operator_type: OperatorType::Pipe,
            };

            let indent = calculate_indentation(context, config.clone(), "");
            assert_eq!(
                indent, expected_indent,
                "Line {} should have same indent as other continuation lines",
                line
            );
        }
    }

    #[test]
    fn test_pipe_chain_continuation_various_tab_sizes() {
        use super::super::context::OperatorType;

        let chain_start_col = 0;

        for tab_size in [1, 2, 4, 8] {
            let config = IndentationConfig {
                tab_size,
                insert_spaces: true,
                style: IndentationStyle::RStudio,
            };

            let context = IndentContext::AfterContinuationOperator {
                chain_start_line: 0,
                chain_start_col,
                operator_type: OperatorType::Pipe,
            };

            let indent = calculate_indentation(context, config, "");
            assert_eq!(
                indent,
                chain_start_col + tab_size,
                "Tab size {} should produce indent {}",
                tab_size,
                chain_start_col + tab_size
            );
        }
    }

    #[test]
    fn test_pipe_chain_continuation_style_independent() {
        use super::super::context::OperatorType;

        // Pipe chain indentation should be the same regardless of style setting
        // (style only affects function argument alignment)
        let chain_start_col = 4;
        let tab_size = 2;
        let expected_indent = chain_start_col + tab_size;

        for style in [IndentationStyle::RStudio, IndentationStyle::RStudioMinus] {
            let config = IndentationConfig {
                tab_size,
                insert_spaces: true,
                style,
            };

            let context = IndentContext::AfterContinuationOperator {
                chain_start_line: 0,
                chain_start_col,
                operator_type: OperatorType::Pipe,
            };

            let indent = calculate_indentation(context, config, "");
            assert_eq!(
                indent, expected_indent,
                "Style {:?} should not affect pipe chain indentation",
                style
            );
        }
    }

    // ========================================================================
    // Function Argument Alignment Tests (Task 5.3)
    // ========================================================================

    #[test]
    fn test_inside_parens_rstudio_same_line_content() {
        // RStudio style: when there's content after the opening paren,
        // align to the column after the opening paren (opener_col + 1)
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // func(arg1,  <- opener at column 4, has content
        //      ^-- should align to column 5
        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: true,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 5); // opener_col + 1
    }

    #[test]
    fn test_inside_parens_rstudio_next_line() {
        // RStudio style: when opening paren is followed by newline,
        // indent from function line + tab_size
        let source = "func(\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // func(  <- opener at column 4, no content after
        //   ^-- should indent from line indent (0) + tab_size (2) = 2
        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // get_line_indent(0) + tab_size = 0 + 2
    }

    #[test]
    fn test_inside_parens_rstudio_next_line_with_indent() {
        // RStudio style with indented function line
        let source = "  func(\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // "  func(" <- line has 2 spaces indent, opener at column 6
        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 6,
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 4); // get_line_indent(0) + tab_size = 2 + 2
    }

    #[test]
    fn test_inside_parens_rstudio_minus_always_indent() {
        // RStudio-minus style: always indent from opener line + tab_size,
        // regardless of whether there's content after the paren
        let source = "func(arg1,\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudioMinus,
        };

        // Even with content on opener line, RStudio-minus ignores it
        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: true,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // get_line_indent(0) + tab_size = 0 + 2
    }

    #[test]
    fn test_inside_parens_rstudio_minus_no_content() {
        // RStudio-minus style with no content after paren
        let source = "func(\n";
        let config = IndentationConfig {
            tab_size: 4,
            insert_spaces: true,
            style: IndentationStyle::RStudioMinus,
        };

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 4); // get_line_indent(0) + tab_size = 0 + 4
    }

    #[test]
    fn test_inside_parens_various_tab_sizes() {
        let source = "func(\n";

        for tab_size in [1, 2, 4, 8] {
            let config = IndentationConfig {
                tab_size,
                insert_spaces: true,
                style: IndentationStyle::RStudio,
            };

            let context = IndentContext::InsideParens {
                opener_line: 0,
                opener_col: 4,
                has_content_on_opener_line: false,
            };

            let indent = calculate_indentation(context, config, source);
            assert_eq!(
                indent, tab_size,
                "Tab size {} should produce indent {}",
                tab_size, tab_size
            );
        }
    }

    // ========================================================================
    // Brace Block Indentation Tests (Task 5.3)
    // ========================================================================

    #[test]
    fn test_inside_braces_basic() {
        // Brace block: indent from brace line + tab_size
        let source = "if (TRUE) {\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideBraces {
            opener_line: 0,
            opener_col: 10, // This is the brace column, but we use line indent
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // get_line_indent(0) + tab_size = 0 + 2
    }

    #[test]
    fn test_inside_braces_with_indent() {
        // Brace block with indented opener line
        let source = "  if (TRUE) {\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideBraces {
            opener_line: 0,
            opener_col: 12,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 4); // get_line_indent(0) + tab_size = 2 + 2
    }

    #[test]
    fn test_inside_braces_various_tab_sizes() {
        let source = "{\n";

        for tab_size in [1, 2, 4, 8] {
            let config = IndentationConfig {
                tab_size,
                insert_spaces: true,
                style: IndentationStyle::RStudio,
            };

            let context = IndentContext::InsideBraces {
                opener_line: 0,
                opener_col: 0,
            };

            let indent = calculate_indentation(context, config, source);
            assert_eq!(
                indent, tab_size,
                "Tab size {} should produce indent {}",
                tab_size, tab_size
            );
        }
    }

    #[test]
    fn test_inside_braces_style_independent() {
        // Brace indentation should be the same regardless of style setting
        let source = "{\n";
        let tab_size = 2;

        for style in [IndentationStyle::RStudio, IndentationStyle::RStudioMinus] {
            let config = IndentationConfig {
                tab_size,
                insert_spaces: true,
                style,
            };

            let context = IndentContext::InsideBraces {
                opener_line: 0,
                opener_col: 0,
            };

            let indent = calculate_indentation(context, config, source);
            assert_eq!(
                indent, tab_size,
                "Style {:?} should not affect brace indentation",
                style
            );
        }
    }

    // ========================================================================
    // De-indentation Tests (Task 5.5)
    // ========================================================================

    #[test]
    fn test_closing_delimiter_basic() {
        // Closing delimiter should align to opener line indentation
        let source = "func(\n  arg1\n)";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 4,
            delimiter: ')',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 0); // opener line has no indentation
    }

    #[test]
    fn test_closing_delimiter_with_indented_opener() {
        // Closing delimiter should align to opener line indentation
        let source = "  func(\n    arg1\n  )";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 6,
            delimiter: ')',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // opener line has 2 spaces indentation
    }

    #[test]
    fn test_closing_delimiter_brace() {
        // Closing brace should align to opener line indentation
        let source = "    if (TRUE) {\n      x <- 1\n    }";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 14,
            delimiter: '}',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 4); // opener line has 4 spaces indentation
    }

    #[test]
    fn test_closing_delimiter_bracket() {
        // Closing bracket should align to opener line indentation
        let source = "  x[\n    1\n  ]";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 3,
            delimiter: ']',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // opener line has 2 spaces indentation
    }

    #[test]
    fn test_closing_delimiter_style_independent() {
        // Closing delimiter alignment should be style-independent
        let source = "  func(\n    arg1\n  )";

        for style in [IndentationStyle::RStudio, IndentationStyle::RStudioMinus] {
            let config = IndentationConfig {
                tab_size: 2,
                insert_spaces: true,
                style,
            };

            let context = IndentContext::ClosingDelimiter {
                opener_line: 0,
                opener_col: 6,
                delimiter: ')',
            };

            let indent = calculate_indentation(context, config, source);
            assert_eq!(
                indent, 2,
                "Style {:?} should not affect closing delimiter alignment",
                style
            );
        }
    }

    #[test]
    fn test_after_complete_expression_basic() {
        // After complete expression, return to enclosing block indentation
        let config = IndentationConfig::default();

        let context = IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 0,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 0);
    }

    #[test]
    fn test_after_complete_expression_with_indent() {
        // After complete expression in indented block
        let config = IndentationConfig::default();

        let context = IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 4,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 4);
    }

    #[test]
    fn test_after_complete_expression_various_indents() {
        let config = IndentationConfig::default();

        for enclosing_indent in [0, 2, 4, 6, 8, 10] {
            let context = IndentContext::AfterCompleteExpression {
                enclosing_block_indent: enclosing_indent,
            };

            let indent = calculate_indentation(context, config.clone(), "");
            assert_eq!(
                indent, enclosing_indent,
                "Enclosing indent {} should be returned as-is",
                enclosing_indent
            );
        }
    }

    #[test]
    fn test_after_complete_expression_style_independent() {
        // Complete expression de-indentation should be style-independent
        for style in [IndentationStyle::RStudio, IndentationStyle::RStudioMinus] {
            let config = IndentationConfig {
                tab_size: 2,
                insert_spaces: true,
                style,
            };

            let context = IndentContext::AfterCompleteExpression {
                enclosing_block_indent: 4,
            };

            let indent = calculate_indentation(context, config, "");
            assert_eq!(
                indent, 4,
                "Style {:?} should not affect complete expression de-indentation",
                style
            );
        }
    }

    // ========================================================================
    // Property-Based Tests (Task 5.2)
    // ========================================================================

    // ========================================================================
    // Edge Case Tests (Task 5.8)
    // ========================================================================

    // --- Column 0 Edge Cases ---

    #[test]
    fn test_edge_case_chain_start_at_column_0() {
        use super::super::context::OperatorType;

        // Chain start at column 0 should produce indentation of just tab_size
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 2); // 0 + 2 = 2
    }

    #[test]
    fn test_edge_case_opener_at_column_0() {
        // Opener at column 0 with content should align to column 1
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 0,
            has_content_on_opener_line: true,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 1); // 0 + 1 = 1
    }

    #[test]
    fn test_edge_case_opener_at_column_0_no_content() {
        // Opener at column 0 with no content should use line indent + tab_size
        let source = "(\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 0,
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // line indent 0 + tab_size 2 = 2
    }

    #[test]
    fn test_edge_case_brace_at_column_0() {
        // Brace at column 0 should indent by tab_size
        let source = "{\n";
        let config = IndentationConfig {
            tab_size: 4,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideBraces {
            opener_line: 0,
            opener_col: 0,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 4); // line indent 0 + tab_size 4 = 4
    }

    #[test]
    fn test_edge_case_enclosing_block_indent_0() {
        // Enclosing block indent of 0 should return 0
        let config = IndentationConfig::default();

        let context = IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 0,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 0);
    }

    #[test]
    fn test_edge_case_closing_delimiter_opener_at_column_0() {
        // Closing delimiter with opener at column 0 should return 0
        let source = "(\n  arg\n)";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 0,
            delimiter: ')',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 0); // opener line has no indentation
    }

    // --- Very Large Indentation Edge Cases ---

    #[test]
    fn test_edge_case_chain_start_at_column_100() {
        use super::super::context::OperatorType;

        // Chain start at column 100+ should work correctly
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 100,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 102); // 100 + 2 = 102
    }

    #[test]
    fn test_edge_case_opener_at_column_100() {
        // Opener at column 100+ with content should align to column 101
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 100,
            has_content_on_opener_line: true,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 101); // 100 + 1 = 101
    }

    #[test]
    fn test_edge_case_large_tab_size() {
        use super::super::context::OperatorType;

        // Large tab_size (8) should work correctly
        let config = IndentationConfig {
            tab_size: 8,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 8); // 0 + 8 = 8
    }

    #[test]
    fn test_edge_case_large_enclosing_block_indent() {
        // Large enclosing block indent should be returned as-is
        let config = IndentationConfig::default();

        let context = IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 200,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 200);
    }

    #[test]
    fn test_edge_case_very_large_line_indent() {
        // Very large line indentation should work correctly
        let source = format!("{}func(\n", " ".repeat(150));
        let config = IndentationConfig {
            tab_size: 4,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 154, // 150 spaces + "func"
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, &source);
        assert_eq!(indent, 154); // line indent 150 + tab_size 4 = 154
    }

    #[test]
    fn test_edge_case_closing_delimiter_large_indent() {
        // Closing delimiter with large opener line indent
        let source = format!("{}func(\n", " ".repeat(100));
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 104,
            delimiter: ')',
        };

        let indent = calculate_indentation(context, config, &source);
        assert_eq!(indent, 100); // opener line has 100 spaces indentation
    }

    // --- Invalid Positions / Missing Openers Edge Cases ---

    #[test]
    fn test_edge_case_out_of_bounds_line_number() {
        // get_line_indent should handle out-of-bounds line numbers gracefully
        let source = "only one line";
        assert_eq!(get_line_indent(source, 0), 0);
        assert_eq!(get_line_indent(source, 1), 0); // out of bounds
        assert_eq!(get_line_indent(source, 100), 0); // way out of bounds
        assert_eq!(get_line_indent(source, u32::MAX), 0); // maximum value
    }

    #[test]
    fn test_edge_case_empty_source_string() {
        // Empty source string should be handled gracefully
        let source = "";
        assert_eq!(get_line_indent(source, 0), 0);

        // Calculation with empty source should still work
        let config = IndentationConfig::default();

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: false,
        };

        // get_line_indent returns 0 for empty source, so indent = 0 + tab_size
        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // 0 + 2 = 2
    }

    #[test]
    fn test_edge_case_opener_line_out_of_bounds() {
        // When opener_line is out of bounds, get_line_indent returns 0
        let source = "single line";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        // Opener line 10 doesn't exist in single-line source
        let context = IndentContext::InsideParens {
            opener_line: 10,
            opener_col: 4,
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // get_line_indent returns 0, so 0 + 2 = 2
    }

    #[test]
    fn test_edge_case_closing_delimiter_opener_line_out_of_bounds() {
        // Closing delimiter with out-of-bounds opener line
        let source = "single line";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 100, // doesn't exist
            opener_col: 4,
            delimiter: ')',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 0); // get_line_indent returns 0 for out-of-bounds
    }

    #[test]
    fn test_edge_case_brace_opener_line_out_of_bounds() {
        // Brace with out-of-bounds opener line
        let source = "single line";
        let config = IndentationConfig {
            tab_size: 4,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::InsideBraces {
            opener_line: 50, // doesn't exist
            opener_col: 10,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 4); // get_line_indent returns 0, so 0 + 4 = 4
    }

    // --- Configuration Defaults Edge Cases ---

    #[test]
    fn test_edge_case_default_config_pipe_chain() {
        use super::super::context::OperatorType;

        // Default config should work correctly with pipe chains
        let config = IndentationConfig::default();
        assert_eq!(config.tab_size, 2);
        assert!(config.insert_spaces);
        assert_eq!(config.style, IndentationStyle::RStudio);

        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 2); // default tab_size is 2
    }

    #[test]
    fn test_edge_case_default_config_inside_parens() {
        // Default config with InsideParens context
        let source = "func(\n";
        let config = IndentationConfig::default();

        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: false,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // default tab_size is 2, line indent is 0
    }

    #[test]
    fn test_edge_case_default_config_inside_braces() {
        // Default config with InsideBraces context
        let source = "{\n";
        let config = IndentationConfig::default();

        let context = IndentContext::InsideBraces {
            opener_line: 0,
            opener_col: 0,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // default tab_size is 2
    }

    #[test]
    fn test_edge_case_default_config_closing_delimiter() {
        // Default config with ClosingDelimiter context
        let source = "  func(\n    arg\n  )";
        let config = IndentationConfig::default();

        let context = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 6,
            delimiter: ')',
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // opener line has 2 spaces indentation
    }

    #[test]
    fn test_edge_case_default_config_complete_expression() {
        // Default config with AfterCompleteExpression context
        let config = IndentationConfig::default();

        let context = IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 4,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 4); // enclosing block indent is returned as-is
    }

    #[test]
    fn test_edge_case_tab_size_1() {
        use super::super::context::OperatorType;

        // Minimum tab_size of 1 should work correctly
        let config = IndentationConfig {
            tab_size: 1,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 1); // 0 + 1 = 1
    }

    #[test]
    fn test_edge_case_insert_spaces_false() {
        use super::super::context::OperatorType;

        // insert_spaces=false should not affect calculation (only formatting)
        let config = IndentationConfig {
            tab_size: 4,
            insert_spaces: false,
            style: IndentationStyle::RStudio,
        };

        let context = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };

        let indent = calculate_indentation(context, config, "");
        assert_eq!(indent, 4); // calculation is the same regardless of insert_spaces
    }

    #[test]
    fn test_edge_case_rstudio_minus_default_behavior() {
        // RStudio-minus style should always use line indent + tab_size
        let source = "func(arg1,\n";
        let config = IndentationConfig {
            tab_size: 2,
            insert_spaces: true,
            style: IndentationStyle::RStudioMinus,
        };

        // Even with content on opener line, RStudio-minus ignores it
        let context = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 4,
            has_content_on_opener_line: true,
        };

        let indent = calculate_indentation(context, config, source);
        assert_eq!(indent, 2); // line indent 0 + tab_size 2 = 2, ignores opener_col
    }

    // ========================================================================
    // Property-Based Tests (Task 5.2)
    // ========================================================================

    mod property_tests {
        use super::*;
        use proptest::prelude::*;

        // Feature: r-smart-indentation, Property 2: Pipe Chain Indentation Calculation
        // *For any* pipe chain with a detected chain start at column C and any tab_size
        // value T, the computed indentation for continuation lines should equal C + T.
        // **Validates: Requirements 3.2**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_pipe_chain_indentation_calculation(
                chain_start_col in 0u32..100,
                tab_size in 1u32..9,
                operator_type_idx in 0usize..5,
                style_idx in 0usize..2,
            ) {
                use super::super::super::context::OperatorType;

                // Map index to operator type
                let operator_type = match operator_type_idx {
                    0 => OperatorType::Pipe,
                    1 => OperatorType::MagrittrPipe,
                    2 => OperatorType::Plus,
                    3 => OperatorType::Tilde,
                    _ => OperatorType::CustomInfix,
                };

                // Map index to style
                let style = match style_idx {
                    0 => IndentationStyle::RStudio,
                    _ => IndentationStyle::RStudioMinus,
                };

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style,
                };

                let context = IndentContext::AfterContinuationOperator {
                    chain_start_line: 0,
                    chain_start_col,
                    operator_type,
                };

                let indent = calculate_indentation(context, config, "");

                // Property: indentation should equal chain_start_col + tab_size
                prop_assert_eq!(
                    indent,
                    chain_start_col + tab_size,
                    "For chain_start_col={}, tab_size={}, expected indent={}, got={}",
                    chain_start_col,
                    tab_size,
                    chain_start_col + tab_size,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 3: Uniform Continuation Indentation
        // *For any* pipe chain with multiple continuation lines, all continuation lines
        // should receive identical indentation values (straight mode).
        // **Validates: Requirements 3.3**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_uniform_continuation_indentation(
                chain_start_col in 0u32..100,
                chain_start_line in 0u32..1000,
                tab_size in 1u32..9,
                num_continuation_lines in 2usize..20,
                operator_types in prop::collection::vec(0usize..5, 2..20),
            ) {
                use super::super::super::context::OperatorType;

                // Helper to map index to operator type
                let map_operator = |idx: usize| match idx % 5 {
                    0 => OperatorType::Pipe,
                    1 => OperatorType::MagrittrPipe,
                    2 => OperatorType::Plus,
                    3 => OperatorType::Tilde,
                    _ => OperatorType::CustomInfix,
                };

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudio,
                };

                // Calculate indentation for each continuation line in the chain
                // All should get the same indentation regardless of:
                // - Which line number they're on
                // - Which operator type precedes them
                let mut indentations = Vec::new();

                for (i, &op_idx) in operator_types.iter().take(num_continuation_lines).enumerate() {
                    let context = IndentContext::AfterContinuationOperator {
                        chain_start_line,
                        chain_start_col,
                        operator_type: map_operator(op_idx),
                    };

                    let indent = calculate_indentation(context, config.clone(), "");
                    indentations.push((i, indent));
                }

                // Property: all continuation lines should have identical indentation
                let expected_indent = chain_start_col + tab_size;
                for (line_idx, indent) in &indentations {
                    prop_assert_eq!(
                        *indent,
                        expected_indent,
                        "Continuation line {} should have indent {}, got {}",
                        line_idx,
                        expected_indent,
                        indent
                    );
                }

                // Also verify all indentations are equal to each other
                if let Some((_, first_indent)) = indentations.first() {
                    for (line_idx, indent) in &indentations {
                        prop_assert_eq!(
                            indent,
                            first_indent,
                            "All continuation lines should have same indent. Line {} has {}, but line 0 has {}",
                            line_idx,
                            indent,
                            first_indent
                        );
                    }
                }
            }
        }

        // Feature: r-smart-indentation, Property 4: Same-Line Argument Alignment (RStudio Style)
        // *For any* function call with RStudio style configured, where the opening parenthesis
        // is followed by content on the same line, the computed indentation for continuation
        // arguments should equal the column immediately after the opening parenthesis (opener_col + 1).
        // **Validates: Requirements 4.1**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_same_line_argument_alignment_rstudio(
                opener_col in 0u32..100,
                tab_size in 1u32..9,
            ) {
                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudio,
                };

                // RStudio style with content on opener line: align to opener_col + 1
                let context = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: true,
                };

                let indent = calculate_indentation(context, config, "");

                // Property: indentation should equal opener_col + 1
                prop_assert_eq!(
                    indent,
                    opener_col + 1,
                    "For opener_col={}, expected indent={}, got={}",
                    opener_col,
                    opener_col + 1,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 5: Next-Line Argument Indentation
        // *For any* function call where the opening parenthesis is followed by a newline,
        // the computed indentation for the first argument should equal the indentation of
        // the line containing the opening parenthesis plus tab_size.
        // **Validates: Requirements 4.2**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_next_line_argument_indentation(
                line_indent in 0u32..50,
                opener_col in 0u32..100,
                tab_size in 1u32..9,
            ) {
                // Generate source with the specified line indentation
                let source = format!("{}func(\n", " ".repeat(line_indent as usize));

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudio,
                };

                // RStudio style with no content on opener line: indent from line + tab_size
                let context = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: false,
                };

                let indent = calculate_indentation(context, config, &source);

                // Property: indentation should equal line_indent + tab_size
                prop_assert_eq!(
                    indent,
                    line_indent + tab_size,
                    "For line_indent={}, tab_size={}, expected indent={}, got={}",
                    line_indent,
                    tab_size,
                    line_indent + tab_size,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 6: RStudio-Minus Style Indentation
        // *For any* function call with RStudio-minus style configured, the computed indentation
        // for continuation arguments should equal the indentation of the previous line plus tab_size,
        // regardless of whether the opening parenthesis is followed by content or a newline.
        // **Validates: Requirements 4.3**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_rstudio_minus_style_indentation(
                line_indent in 0u32..50,
                opener_col in 0u32..100,
                tab_size in 1u32..9,
                has_content in proptest::bool::ANY,
            ) {
                // Generate source with the specified line indentation
                let source = format!("{}func(\n", " ".repeat(line_indent as usize));

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudioMinus,
                };

                // RStudio-minus style: always indent from opener line + tab_size
                // regardless of has_content_on_opener_line
                let context = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: has_content,
                };

                let indent = calculate_indentation(context, config, &source);

                // Property: indentation should equal line_indent + tab_size
                // regardless of whether there's content on the opener line
                prop_assert_eq!(
                    indent,
                    line_indent + tab_size,
                    "For line_indent={}, tab_size={}, has_content={}, expected indent={}, got={}",
                    line_indent,
                    tab_size,
                    has_content,
                    line_indent + tab_size,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 7: Brace Block Indentation
        // *For any* code block with an opening brace `{`, the computed indentation for lines
        // inside the block should equal the indentation of the line containing the opening
        // brace plus tab_size.
        // **Validates: Requirements 4.4**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_brace_block_indentation(
                line_indent in 0u32..50,
                opener_col in 0u32..100,
                tab_size in 1u32..9,
                style_idx in 0usize..2,
            ) {
                // Generate source with the specified line indentation
                let source = format!("{}if (TRUE) {{\n", " ".repeat(line_indent as usize));

                // Map index to style - brace indentation should be style-independent
                let style = match style_idx {
                    0 => IndentationStyle::RStudio,
                    _ => IndentationStyle::RStudioMinus,
                };

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style,
                };

                // Inside braces: indent from brace line + tab_size
                let context = IndentContext::InsideBraces {
                    opener_line: 0,
                    opener_col,
                };

                let indent = calculate_indentation(context, config, &source);

                // Property: indentation should equal line_indent + tab_size
                // regardless of style setting
                prop_assert_eq!(
                    indent,
                    line_indent + tab_size,
                    "For line_indent={}, tab_size={}, style={:?}, expected indent={}, got={}",
                    line_indent,
                    tab_size,
                    style,
                    line_indent + tab_size,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 8: Closing Delimiter Alignment
        // *For any* closing delimiter (`)`, `]`, or `}`) that appears on its own line,
        // the computed indentation should equal the indentation of the line containing
        // the matching opening delimiter.
        // **Validates: Requirements 5.1**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_closing_delimiter_alignment(
                line_indent in 0u32..50,
                opener_col in 0u32..100,
                tab_size in 1u32..9,
                delimiter_idx in 0usize..3,
                style_idx in 0usize..2,
            ) {
                // Generate source with the specified line indentation
                let source = format!("{}func(\n", " ".repeat(line_indent as usize));

                // Map index to delimiter type
                let delimiter = match delimiter_idx {
                    0 => ')',
                    1 => ']',
                    _ => '}',
                };

                // Map index to style - closing delimiter alignment should be style-independent
                let style = match style_idx {
                    0 => IndentationStyle::RStudio,
                    _ => IndentationStyle::RStudioMinus,
                };

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style,
                };

                // Closing delimiter: align to opener line indentation
                let context = IndentContext::ClosingDelimiter {
                    opener_line: 0,
                    opener_col,
                    delimiter,
                };

                let indent = calculate_indentation(context, config, &source);

                // Property: indentation should equal the opener line's indentation
                // regardless of delimiter type, opener_col, tab_size, or style
                prop_assert_eq!(
                    indent,
                    line_indent,
                    "For line_indent={}, delimiter='{}', style={:?}, expected indent={}, got={}",
                    line_indent,
                    delimiter,
                    style,
                    line_indent,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 9: Complete Expression De-indentation
        // *For any* complete expression (no trailing continuation operator, no unclosed
        // delimiters), the computed indentation for the following line should equal the
        // indentation of the enclosing block.
        // **Validates: Requirements 5.2**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_complete_expression_deindentation(
                enclosing_block_indent in 0u32..100,
                tab_size in 1u32..9,
                style_idx in 0usize..2,
            ) {
                // Map index to style - complete expression de-indentation should be style-independent
                let style = match style_idx {
                    0 => IndentationStyle::RStudio,
                    _ => IndentationStyle::RStudioMinus,
                };

                let config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style,
                };

                // After complete expression: return to enclosing block indentation
                let context = IndentContext::AfterCompleteExpression {
                    enclosing_block_indent,
                };

                let indent = calculate_indentation(context, config, "");

                // Property: indentation should equal the enclosing block indentation
                // regardless of tab_size or style setting
                prop_assert_eq!(
                    indent,
                    enclosing_block_indent,
                    "For enclosing_block_indent={}, style={:?}, expected indent={}, got={}",
                    enclosing_block_indent,
                    style,
                    enclosing_block_indent,
                    indent
                );
            }
        }

        // Feature: r-smart-indentation, Property 13: Style Configuration Behavior
        // *For any* function call, when raven.indentation.style is set to "rstudio",
        // same-line arguments should align to the opening paren (opener_col + 1) and
        // next-line arguments should indent from the function line; when set to
        // "rstudio-minus", all arguments should indent from the previous line.
        // **Validates: Requirements 7.2, 7.3**
        proptest! {
            #![proptest_config(ProptestConfig::with_cases(100))]

            #[test]
            fn property_style_configuration_behavior(
                line_indent in 0u32..50,
                opener_col in 0u32..100,
                tab_size in 1u32..9,
                has_content in proptest::bool::ANY,
            ) {
                // Generate source with the specified line indentation
                let source = format!("{}func(\n", " ".repeat(line_indent as usize));

                // Test RStudio style behavior
                let rstudio_config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudio,
                };

                let context_rstudio = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: has_content,
                };

                let rstudio_indent = calculate_indentation(context_rstudio, rstudio_config, &source);

                // RStudio style:
                // - Same-line content: align to opener_col + 1
                // - Next-line (no content): indent from function line (line_indent + tab_size)
                let expected_rstudio = if has_content {
                    opener_col + 1
                } else {
                    line_indent + tab_size
                };

                prop_assert_eq!(
                    rstudio_indent,
                    expected_rstudio,
                    "RStudio style: line_indent={}, opener_col={}, has_content={}, tab_size={}, expected={}, got={}",
                    line_indent,
                    opener_col,
                    has_content,
                    tab_size,
                    expected_rstudio,
                    rstudio_indent
                );

                // Test RStudio-minus style behavior
                let rstudio_minus_config = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudioMinus,
                };

                let context_rstudio_minus = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: has_content,
                };

                let rstudio_minus_indent = calculate_indentation(context_rstudio_minus, rstudio_minus_config, &source);

                // RStudio-minus style:
                // - Always indent from opener line + tab_size, regardless of same-line content
                let expected_rstudio_minus = line_indent + tab_size;

                prop_assert_eq!(
                    rstudio_minus_indent,
                    expected_rstudio_minus,
                    "RStudio-minus style: line_indent={}, opener_col={}, has_content={}, tab_size={}, expected={}, got={}",
                    line_indent,
                    opener_col,
                    has_content,
                    tab_size,
                    expected_rstudio_minus,
                    rstudio_minus_indent
                );

                // Additional property: RStudio-minus should be independent of has_content
                // (already verified above, but let's make it explicit)
                // The indentation should be the same whether has_content is true or false
                let context_with_content = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: true,
                };
                let context_without_content = IndentContext::InsideParens {
                    opener_line: 0,
                    opener_col,
                    has_content_on_opener_line: false,
                };

                let rstudio_minus_config_clone = IndentationConfig {
                    tab_size,
                    insert_spaces: true,
                    style: IndentationStyle::RStudioMinus,
                };

                let indent_with = calculate_indentation(context_with_content, rstudio_minus_config_clone.clone(), &source);
                let indent_without = calculate_indentation(context_without_content, rstudio_minus_config_clone, &source);

                prop_assert_eq!(
                    indent_with,
                    indent_without,
                    "RStudio-minus should produce same indent regardless of has_content: with={}, without={}",
                    indent_with,
                    indent_without
                );
            }
        }
    }
}
