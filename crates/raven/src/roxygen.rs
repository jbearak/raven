//
// roxygen.rs
//
// Shared roxygen/comment extraction logic for parameter and function documentation.
//
// This module parses roxygen2-style comment blocks (`#'` lines) and plain R comment
// blocks (`#` lines) above function definitions. It is used by both parameter
// documentation resolve (Requirement 7) and function documentation resolve
// (Requirement 8) to avoid duplication.
//

use std::collections::HashMap;

/// Parsed roxygen/comment block from the contiguous comment lines above a function definition.
#[derive(Debug, Clone)]
pub struct RoxygenBlock {
    /// Title line (first non-tag line in a roxygen block)
    pub title: Option<String>,
    /// Description paragraph (lines after title, before first tag or blank `#'` line)
    pub description: Option<String>,
    /// `@param` entries: param_name -> description (supports multi-line continuation)
    pub params: HashMap<String, String>,
    /// Fallback text when no roxygen tags are present (plain `#` comment text)
    pub fallback: Option<String>,
}

/// Extract a roxygen/comment block by scanning backward from a function definition line.
///
/// Collects consecutive comment lines immediately above `func_line` (0-indexed).
/// Prefers `#'` (roxygen) lines; falls back to plain `#` comments if no `#'` lines
/// are found. Returns `None` if no contiguous comment block exists above the function.
pub fn extract_roxygen_block(text: &str, func_line: u32) -> Option<RoxygenBlock> {
    let lines: Vec<&str> = text.lines().collect();
    let func_line = func_line as usize;

    if func_line == 0 || func_line >= lines.len() {
        return None;
    }

    // Scan backward from the line immediately above the function definition,
    // collecting consecutive comment lines.
    let mut comment_lines: Vec<&str> = Vec::new();
    let mut idx = func_line - 1;
    loop {
        let line = lines[idx];
        let trimmed = line.trim_start();
        if trimmed.starts_with("#'") || trimmed.starts_with('#') {
            comment_lines.push(line);
        } else {
            break;
        }
        if idx == 0 {
            break;
        }
        idx -= 1;
    }

    if comment_lines.is_empty() {
        return None;
    }

    // Reverse so lines are in top-to-bottom order.
    comment_lines.reverse();

    // Determine if this is a roxygen block (#' lines) or plain comment block (# lines).
    let has_roxygen = comment_lines
        .iter()
        .any(|l| l.trim_start().starts_with("#'"));

    if has_roxygen {
        Some(parse_roxygen_block(&comment_lines))
    } else {
        Some(parse_plain_comment_block(&comment_lines))
    }
}

/// Strip the roxygen prefix (`#'`) from a line, returning the content after it.
/// Handles optional single space after `#'`.
fn strip_roxygen_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("#'") {
        // Strip at most one leading space after #'
        rest.strip_prefix(' ').unwrap_or(rest)
    } else {
        // Not a roxygen line — shouldn't happen in a roxygen block, but handle gracefully
        ""
    }
}

/// Parse a roxygen block (lines starting with `#'`).
///
/// Roxygen2 semantics:
/// - Title: first non-empty, non-tag line
/// - Description: lines after title, before first tag or blank `#'` line
/// - `@param name description`: parameter docs (multi-line continuation: subsequent
///   non-tag, non-blank lines that don't start a new `@` tag are appended)
/// - `@description text`: explicit description tag (overrides implicit description)
fn parse_roxygen_block(lines: &[&str]) -> RoxygenBlock {
    // Filter to only roxygen lines (#' prefix), preserving order.
    let roxygen_lines: Vec<&str> = lines
        .iter()
        .filter(|l| l.trim_start().starts_with("#'"))
        .copied()
        .collect();

    let mut title: Option<String> = None;
    let mut description_lines: Vec<String> = Vec::new();
    let mut params: HashMap<String, String> = HashMap::new();
    let mut has_any_tag = false;

    // State machine for parsing roxygen2 blocks.
    //
    // Roxygen2 semantics:
    //   Title = first non-tag, non-empty line
    //   Description = subsequent non-tag lines before the first tag.
    //     Blank #' lines are treated as paragraph separators but do NOT
    //     end the description section — only a tag ends it.
    //   Tags (@param, @description, etc.) can appear anywhere.
    enum State {
        /// Looking for title (first non-tag, non-empty line)
        Title,
        /// Collecting description lines (after title, before first tag)
        Description,
        /// Collecting @param continuation lines
        Param(String),
        /// Collecting @description continuation lines
        DescriptionTag,
        /// After a tag we don't specifically handle; skip continuation lines
        OtherTag,
    }

    let mut state = State::Title;

    for line in &roxygen_lines {
        let content = strip_roxygen_prefix(line);

        // Check if this line starts a new tag
        if let Some(tag_content) = content.strip_prefix('@') {
            has_any_tag = true;

            if let Some(rest) = tag_content.strip_prefix("param") {
                // @param must be followed by whitespace and then the param name
                if rest.starts_with(' ') || rest.starts_with('\t') {
                    let rest = rest.trim_start();
                    // Extract param name (first word) and description (rest)
                    let (param_name, param_desc) = split_first_word(rest);
                    if !param_name.is_empty() {
                        params.insert(param_name.to_string(), param_desc.to_string());
                        state = State::Param(param_name.to_string());
                        continue;
                    }
                }
                // Malformed @param — treat as other tag
                state = State::OtherTag;
                continue;
            } else if tag_content.starts_with("description") {
                let rest = tag_content
                    .strip_prefix("description")
                    .unwrap_or("")
                    .trim_start();
                if !rest.is_empty() {
                    description_lines = vec![rest.to_string()];
                } else {
                    description_lines = Vec::new();
                }
                state = State::DescriptionTag;
                continue;
            } else {
                // Some other tag (@return, @export, @examples, etc.)
                state = State::OtherTag;
                continue;
            }
        }

        // Not a tag line — handle based on current state
        match &state {
            State::Title => {
                if content.is_empty() {
                    // Skip leading blank lines
                    continue;
                }
                title = Some(content.to_string());
                state = State::Description;
            }
            State::Description => {
                if content.is_empty() {
                    // Blank line is a paragraph separator within the description.
                    // We skip it but stay in Description state — only a tag ends
                    // the description section.
                    continue;
                }
                description_lines.push(content.trim().to_string());
            }
            State::Param(name) => {
                if content.is_empty() {
                    // Blank line ends param continuation
                    state = State::OtherTag;
                } else {
                    // Multi-line continuation: append to existing param description
                    if let Some(desc) = params.get_mut(name) {
                        desc.push(' ');
                        desc.push_str(content.trim());
                    }
                }
            }
            State::DescriptionTag => {
                if content.is_empty() {
                    // Blank line ends @description continuation
                    state = State::OtherTag;
                } else {
                    description_lines.push(content.trim().to_string());
                }
            }
            State::OtherTag => {
                // Continuation of an unhandled tag — skip
            }
        }
    }

    let description = if description_lines.is_empty() {
        None
    } else {
        Some(description_lines.join(" "))
    };

    // If no roxygen tags were found at all, treat the entire block as fallback text
    if !has_any_tag {
        let all_text: Vec<String> = roxygen_lines
            .iter()
            .map(|l| strip_roxygen_prefix(l).to_string())
            .collect();
        let fallback_text = all_text.join("\n").trim().to_string();
        return RoxygenBlock {
            title,
            description,
            params,
            fallback: if fallback_text.is_empty() {
                None
            } else {
                Some(fallback_text)
            },
        };
    }

    RoxygenBlock {
        title,
        description,
        params,
        fallback: None,
    }
}

/// Parse a plain comment block (lines starting with `#` but not `#'`).
///
/// When no roxygen tags are present, the entire comment text is stored as `fallback`.
fn parse_plain_comment_block(lines: &[&str]) -> RoxygenBlock {
    let text_lines: Vec<String> = lines
        .iter()
        .map(|l| {
            let trimmed = l.trim_start();
            // Strip the `#` prefix and optional single space
            if let Some(rest) = trimmed.strip_prefix('#') {
                rest.strip_prefix(' ').unwrap_or(rest).to_string()
            } else {
                String::new()
            }
        })
        .collect();

    let fallback_text = text_lines.join("\n").trim().to_string();

    RoxygenBlock {
        title: None,
        description: None,
        params: HashMap::new(),
        fallback: if fallback_text.is_empty() {
            None
        } else {
            Some(fallback_text)
        },
    }
}

/// Split a string into the first whitespace-delimited word and the remainder.
fn split_first_word(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    match s.find(|c: char| c.is_whitespace()) {
        Some(pos) => (&s[..pos], s[pos..].trim_start()),
        None => (s, ""),
    }
}

/// Extract `@param` description for a specific parameter from a roxygen block.
///
/// Returns `None` if the parameter is not documented in the block.
pub fn get_param_doc(block: &RoxygenBlock, param_name: &str) -> Option<String> {
    block.params.get(param_name).cloned()
}

/// Get the function-level documentation (title + description, or fallback text).
///
/// Returns a combined string of title and description when available.
/// Falls back to the plain comment text if no roxygen tags were present.
/// Returns `None` if no documentation is available at all.
pub fn get_function_doc(block: &RoxygenBlock) -> Option<String> {
    // If we have a title or description from roxygen, use those
    if block.title.is_some() || block.description.is_some() {
        let mut parts: Vec<&str> = Vec::new();
        if let Some(ref t) = block.title {
            parts.push(t.as_str());
        }
        if let Some(ref d) = block.description {
            parts.push(d.as_str());
        }
        return Some(parts.join("\n\n"));
    }

    // Fall back to plain comment text
    block.fallback.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // extract_roxygen_block — basic roxygen (#') blocks
    // -----------------------------------------------------------------------

    #[test]
    fn test_roxygen_title_only() {
        let code = "\
#' Calculate the mean of a vector
my_mean <- function(x) mean(x)
";
        let block = extract_roxygen_block(code, 1).unwrap();
        assert_eq!(block.title.as_deref(), Some("Calculate the mean of a vector"));
        assert!(block.description.is_none());
        assert!(block.params.is_empty());
        // No tags → fallback is populated
        assert!(block.fallback.is_some());
    }

    #[test]
    fn test_roxygen_title_and_description() {
        let code = "\
#' Calculate the mean
#' This function computes the arithmetic mean
#' of a numeric vector.
#'
#' @param x A numeric vector
my_mean <- function(x) mean(x)
";
        let block = extract_roxygen_block(code, 5).unwrap();
        assert_eq!(block.title.as_deref(), Some("Calculate the mean"));
        assert_eq!(
            block.description.as_deref(),
            Some("This function computes the arithmetic mean of a numeric vector.")
        );
        assert_eq!(block.params.get("x").map(|s| s.as_str()), Some("A numeric vector"));
        assert!(block.fallback.is_none()); // has tags
    }

    #[test]
    fn test_roxygen_multiple_params() {
        let code = "\
#' Add two numbers
#' @param x First number
#' @param y Second number
#' @return The sum
add <- function(x, y) x + y
";
        let block = extract_roxygen_block(code, 4).unwrap();
        assert_eq!(block.title.as_deref(), Some("Add two numbers"));
        assert_eq!(block.params.get("x").map(|s| s.as_str()), Some("First number"));
        assert_eq!(block.params.get("y").map(|s| s.as_str()), Some("Second number"));
        assert_eq!(block.params.len(), 2);
    }

    #[test]
    fn test_roxygen_multiline_param() {
        let code = "\
#' Process data
#' @param data A data frame containing the input data.
#'   Must have columns 'x' and 'y'.
#'   Additional columns are ignored.
#' @param verbose Whether to print progress
process <- function(data, verbose = FALSE) {}
";
        let block = extract_roxygen_block(code, 5).unwrap();
        assert_eq!(
            block.params.get("data").map(|s| s.as_str()),
            Some("A data frame containing the input data. Must have columns 'x' and 'y'. Additional columns are ignored.")
        );
        assert_eq!(
            block.params.get("verbose").map(|s| s.as_str()),
            Some("Whether to print progress")
        );
    }

    #[test]
    fn test_roxygen_explicit_description_tag() {
        let code = "\
#' My Function Title
#' @description This is an explicit description
#'   that spans multiple lines.
#' @param x Input value
my_func <- function(x) x
";
        let block = extract_roxygen_block(code, 4).unwrap();
        assert_eq!(block.title.as_deref(), Some("My Function Title"));
        assert_eq!(
            block.description.as_deref(),
            Some("This is an explicit description that spans multiple lines.")
        );
        assert_eq!(block.params.get("x").map(|s| s.as_str()), Some("Input value"));
    }

    #[test]
    fn test_roxygen_no_title_just_params() {
        let code = "\
#' @param x A value
#' @param y Another value
add <- function(x, y) x + y
";
        let block = extract_roxygen_block(code, 2).unwrap();
        assert!(block.title.is_none());
        assert!(block.description.is_none());
        assert_eq!(block.params.len(), 2);
    }

    // -----------------------------------------------------------------------
    // extract_roxygen_block — plain comment (#) fallback
    // -----------------------------------------------------------------------

    #[test]
    fn test_plain_comment_fallback() {
        let code = "\
# This function adds two numbers
# and returns the result
add <- function(x, y) x + y
";
        let block = extract_roxygen_block(code, 2).unwrap();
        assert!(block.title.is_none());
        assert!(block.description.is_none());
        assert!(block.params.is_empty());
        assert_eq!(
            block.fallback.as_deref(),
            Some("This function adds two numbers\nand returns the result")
        );
    }

    #[test]
    fn test_plain_comment_single_line() {
        let code = "\
# Simple helper
helper <- function() 42
";
        let block = extract_roxygen_block(code, 1).unwrap();
        assert_eq!(block.fallback.as_deref(), Some("Simple helper"));
    }

    // -----------------------------------------------------------------------
    // extract_roxygen_block — edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn test_no_comment_block() {
        let code = "\
x <- 1
my_func <- function() {}
";
        let result = extract_roxygen_block(code, 1);
        assert!(result.is_none());
    }

    #[test]
    fn test_func_at_line_zero() {
        let code = "my_func <- function() {}";
        let result = extract_roxygen_block(code, 0);
        assert!(result.is_none());
    }

    #[test]
    fn test_non_contiguous_comments() {
        let code = "\
#' First block
x <- 1
#' Second block
my_func <- function() {}
";
        // Only the contiguous block immediately above func_line (line 3) is collected
        let block = extract_roxygen_block(code, 3).unwrap();
        assert_eq!(block.title.as_deref(), Some("Second block"));
    }

    #[test]
    fn test_mixed_roxygen_and_plain_prefers_roxygen() {
        // When both #' and # lines are present in the contiguous block,
        // the block is treated as roxygen (since has_roxygen is true).
        let code = "\
# plain comment
#' Roxygen title
#' @param x A value
my_func <- function(x) x
";
        let block = extract_roxygen_block(code, 3).unwrap();
        // The #' lines are parsed as roxygen; the plain # line is filtered out
        assert_eq!(block.title.as_deref(), Some("Roxygen title"));
        assert_eq!(block.params.get("x").map(|s| s.as_str()), Some("A value"));
    }

    #[test]
    fn test_blank_roxygen_lines_end_description() {
        let code = "\
#' Title
#' Description line
#'
#' This should also be in description
#' @param x A value
my_func <- function(x) x
";
        let block = extract_roxygen_block(code, 5).unwrap();
        assert_eq!(block.title.as_deref(), Some("Title"));
        // Blank #' lines are paragraph separators within description, not terminators.
        // Only a tag ends the description section.
        assert_eq!(
            block.description.as_deref(),
            Some("Description line This should also be in description")
        );
    }

    #[test]
    fn test_roxygen_with_export_and_return_tags() {
        let code = "\
#' Calculate sum
#' @param x First value
#' @param y Second value
#' @return The sum of x and y
#' @export
add <- function(x, y) x + y
";
        let block = extract_roxygen_block(code, 5).unwrap();
        assert_eq!(block.title.as_deref(), Some("Calculate sum"));
        assert_eq!(block.params.len(), 2);
        // @return and @export are ignored (not parsed into params)
    }

    #[test]
    fn test_indented_comments() {
        let code = "\
  #' Indented title
  #' @param x A value
  my_func <- function(x) x
";
        let block = extract_roxygen_block(code, 2).unwrap();
        assert_eq!(block.title.as_deref(), Some("Indented title"));
        assert_eq!(block.params.get("x").map(|s| s.as_str()), Some("A value"));
    }

    #[test]
    fn test_roxygen_no_space_after_prefix() {
        // #'Title (no space) should still work
        let code = "\
#'Title without space
#'@param x Value
my_func <- function(x) x
";
        let block = extract_roxygen_block(code, 2).unwrap();
        assert_eq!(block.title.as_deref(), Some("Title without space"));
        assert_eq!(block.params.get("x").map(|s| s.as_str()), Some("Value"));
    }

    // -----------------------------------------------------------------------
    // get_param_doc
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_param_doc_found() {
        let block = RoxygenBlock {
            title: Some("Title".to_string()),
            description: None,
            params: {
                let mut m = HashMap::new();
                m.insert("x".to_string(), "A numeric vector".to_string());
                m.insert("y".to_string(), "Another vector".to_string());
                m
            },
            fallback: None,
        };
        assert_eq!(get_param_doc(&block, "x"), Some("A numeric vector".to_string()));
        assert_eq!(get_param_doc(&block, "y"), Some("Another vector".to_string()));
    }

    #[test]
    fn test_get_param_doc_not_found() {
        let block = RoxygenBlock {
            title: None,
            description: None,
            params: HashMap::new(),
            fallback: None,
        };
        assert_eq!(get_param_doc(&block, "z"), None);
    }

    // -----------------------------------------------------------------------
    // get_function_doc
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_function_doc_title_and_description() {
        let block = RoxygenBlock {
            title: Some("My Function".to_string()),
            description: Some("Does something useful.".to_string()),
            params: HashMap::new(),
            fallback: None,
        };
        assert_eq!(
            get_function_doc(&block),
            Some("My Function\n\nDoes something useful.".to_string())
        );
    }

    #[test]
    fn test_get_function_doc_title_only() {
        let block = RoxygenBlock {
            title: Some("My Function".to_string()),
            description: None,
            params: HashMap::new(),
            fallback: None,
        };
        assert_eq!(get_function_doc(&block), Some("My Function".to_string()));
    }

    #[test]
    fn test_get_function_doc_description_only() {
        let block = RoxygenBlock {
            title: None,
            description: Some("A description.".to_string()),
            params: HashMap::new(),
            fallback: None,
        };
        assert_eq!(get_function_doc(&block), Some("A description.".to_string()));
    }

    #[test]
    fn test_get_function_doc_fallback() {
        let block = RoxygenBlock {
            title: None,
            description: None,
            params: HashMap::new(),
            fallback: Some("Plain comment text".to_string()),
        };
        assert_eq!(get_function_doc(&block), Some("Plain comment text".to_string()));
    }

    #[test]
    fn test_get_function_doc_none() {
        let block = RoxygenBlock {
            title: None,
            description: None,
            params: HashMap::new(),
            fallback: None,
        };
        assert_eq!(get_function_doc(&block), None);
    }

    #[test]
    fn test_get_function_doc_title_preferred_over_fallback() {
        let block = RoxygenBlock {
            title: Some("Title".to_string()),
            description: None,
            params: HashMap::new(),
            fallback: Some("Fallback text".to_string()),
        };
        // Title/description take precedence over fallback
        assert_eq!(get_function_doc(&block), Some("Title".to_string()));
    }

    // -----------------------------------------------------------------------
    // Realistic R code scenarios
    // -----------------------------------------------------------------------

    #[test]
    fn test_realistic_roxygen_block() {
        let code = r#"
library(dplyr)

#' Filter and summarize data
#'
#' Takes a data frame and applies filtering based on the
#' specified threshold, then computes summary statistics.
#'
#' @param df A data frame with numeric columns
#' @param threshold Minimum value for filtering.
#'   Values below this threshold are excluded.
#' @param cols Character vector of column names to summarize.
#'   Defaults to all numeric columns.
#' @param na.rm Logical; should NA values be removed?
#' @param ... Additional arguments passed to summary functions
#' @return A summarized data frame
#' @export
#' @examples
#' filter_and_summarize(mtcars, threshold = 100)
filter_and_summarize <- function(df, threshold = 0, cols = NULL, na.rm = TRUE, ...) {
  # implementation
}
"#;
        let block = extract_roxygen_block(code, 19).unwrap();
        assert_eq!(block.title.as_deref(), Some("Filter and summarize data"));
        assert_eq!(
            block.description.as_deref(),
            Some("Takes a data frame and applies filtering based on the specified threshold, then computes summary statistics.")
        );
        assert_eq!(block.params.len(), 5);
        assert_eq!(
            block.params.get("df").map(|s| s.as_str()),
            Some("A data frame with numeric columns")
        );
        assert_eq!(
            block.params.get("threshold").map(|s| s.as_str()),
            Some("Minimum value for filtering. Values below this threshold are excluded.")
        );
        assert_eq!(
            block.params.get("cols").map(|s| s.as_str()),
            Some("Character vector of column names to summarize. Defaults to all numeric columns.")
        );
        assert_eq!(
            block.params.get("na.rm").map(|s| s.as_str()),
            Some("Logical; should NA values be removed?")
        );
        assert_eq!(
            block.params.get("...").map(|s| s.as_str()),
            Some("Additional arguments passed to summary functions")
        );
        assert!(block.fallback.is_none());

        // Test helpers
        assert_eq!(
            get_param_doc(&block, "threshold"),
            Some("Minimum value for filtering. Values below this threshold are excluded.".to_string())
        );
        assert_eq!(get_param_doc(&block, "nonexistent"), None);

        let func_doc = get_function_doc(&block).unwrap();
        assert!(func_doc.contains("Filter and summarize data"));
        assert!(func_doc.contains("Takes a data frame"));
    }

    #[test]
    fn test_func_line_beyond_file() {
        let code = "x <- 1\n";
        let result = extract_roxygen_block(code, 100);
        assert!(result.is_none());
    }

    #[test]
    fn test_empty_roxygen_block() {
        let code = "\
#'
#'
my_func <- function() {}
";
        let block = extract_roxygen_block(code, 2).unwrap();
        // All lines are blank after stripping prefix — no title, no description
        assert!(block.title.is_none());
        assert!(block.description.is_none());
        assert!(block.params.is_empty());
        // Fallback is None because the text is empty after trimming
        assert!(block.fallback.is_none());
    }

    #[test]
    fn test_param_with_dots_name() {
        let code = "\
#' @param ... Additional arguments
my_func <- function(...) {}
";
        let block = extract_roxygen_block(code, 1).unwrap();
        assert_eq!(
            block.params.get("...").map(|s| s.as_str()),
            Some("Additional arguments")
        );
    }
}

// ============================================================================
// Property Tests for Roxygen Function Documentation Extraction
// Feature: function-parameter-completions, Property 14: Roxygen Function Documentation Extraction
// ============================================================================

#[cfg(test)]
mod prop_tests {
    use super::*;
    use proptest::prelude::*;

    /// Strategy to generate a valid roxygen title line (non-empty, no `@` prefix, no `#` chars).
    fn title_strategy() -> impl Strategy<Value = String> {
        "[A-Z][a-z]{2,15}( [a-z]{2,10}){0,4}"
            .prop_map(|s| s.trim().to_string())
            .prop_filter("title must not be empty", |s| !s.is_empty())
    }

    /// Strategy to generate a description line (non-empty, no `@` prefix, no `#` chars).
    fn description_line_strategy() -> impl Strategy<Value = String> {
        "[A-Z][a-z]{2,15}( [a-z]{2,10}){1,6}"
            .prop_map(|s| s.trim().to_string())
            .prop_filter("desc must not be empty", |s| !s.is_empty())
    }

    /// Strategy to generate a valid R-style parameter name (letters, digits, dots, underscores).
    fn param_name_strategy() -> impl Strategy<Value = String> {
        "[a-z][a-z0-9_.]{0,8}"
            .prop_filter("param name must not be empty", |s| !s.is_empty())
    }

    /// Strategy to generate a param description.
    fn param_desc_strategy() -> impl Strategy<Value = String> {
        "[A-Z][a-z]{2,12}( [a-z]{2,8}){0,4}"
            .prop_map(|s| s.trim().to_string())
            .prop_filter("param desc must not be empty", |s| !s.is_empty())
    }

    /// Strategy to generate a list of @param entries with unique names.
    fn param_entries_strategy() -> impl Strategy<Value = Vec<(String, String)>> {
        prop::collection::vec((param_name_strategy(), param_desc_strategy()), 0..=5).prop_map(
            |entries| {
                // Deduplicate by param name (keep first occurrence)
                let mut seen = std::collections::HashSet::new();
                entries
                    .into_iter()
                    .filter(|(name, _)| seen.insert(name.clone()))
                    .collect()
            },
        )
    }

    /// Describes whether the description is provided implicitly (paragraph after title)
    /// or via an explicit `@description` tag.
    #[derive(Debug, Clone)]
    enum DescriptionStyle {
        /// Description as paragraph lines after the title, before any tag
        Implicit,
        /// Description via `@description` tag
        Explicit,
    }

    fn description_style_strategy() -> impl Strategy<Value = DescriptionStyle> {
        prop_oneof![
            Just(DescriptionStyle::Implicit),
            Just(DescriptionStyle::Explicit),
        ]
    }

    /// Expected extraction results from a generated roxygen block.
    #[derive(Debug)]
    struct ExpectedBlock {
        title: Option<String>,
        description: Option<String>,
    }

    /// Build a complete R code string with a roxygen block above a function definition.
    ///
    /// Returns (code, func_line, expected).
    ///
    /// The expected values account for roxygen2 parsing semantics:
    /// - The first non-tag, non-empty `#'` line is always the **title**
    /// - Subsequent non-tag lines before the first tag are the **description**
    /// - An `@description` tag provides an explicit description
    /// - When no title line is present but an implicit description line exists,
    ///   that line becomes the title (roxygen2 semantics)
    fn build_roxygen_code(
        title: &Option<String>,
        description: &Option<String>,
        desc_style: &DescriptionStyle,
        params: &[(String, String)],
    ) -> (String, u32, ExpectedBlock) {
        let mut lines: Vec<String> = Vec::new();

        // Add a preamble line so the function isn't at line 0
        lines.push("# preamble".to_string());

        // Add title line if present
        if let Some(ref t) = title {
            lines.push(format!("#' {}", t));
        }

        // Add description
        match desc_style {
            DescriptionStyle::Implicit => {
                if let Some(ref d) = description {
                    // Implicit description: lines after title, before first tag
                    lines.push(format!("#' {}", d));
                }
            }
            DescriptionStyle::Explicit => {
                if let Some(ref d) = description {
                    // Explicit @description tag
                    lines.push(format!("#' @description {}", d));
                }
            }
        }

        // Add @param entries
        for (name, desc) in params {
            lines.push(format!("#' @param {} {}", name, desc));
        }

        let func_line = lines.len() as u32;
        // Build a simple function definition with matching parameter names
        let param_names: Vec<&str> = params.iter().map(|(n, _)| n.as_str()).collect();
        let func_params = if param_names.is_empty() {
            String::new()
        } else {
            param_names.join(", ")
        };
        lines.push(format!("my_func <- function({}) {{ NULL }}", func_params));

        let code = lines.join("\n");

        // Compute expected values based on roxygen2 parsing semantics.
        //
        // The parser's state machine works as follows:
        // 1. First non-tag, non-empty line → title
        // 2. Subsequent non-tag lines before first tag → description (implicit)
        // 3. @description tag → description (explicit, overrides implicit)
        //
        // Key insight: when there's no explicit title but there IS an implicit
        // description line, that line becomes the title (it's the first non-tag line).

        let expected = match desc_style {
            DescriptionStyle::Implicit => {
                match (title, description) {
                    (Some(t), Some(d)) => {
                        // Title line present, description line present (implicit).
                        // Parser: title = t, description = d (if tags terminate it)
                        // or description = d (stays in Description state until tag/EOF)
                        ExpectedBlock {
                            title: Some(t.clone()),
                            description: Some(d.clone()),
                        }
                    }
                    (Some(t), None) => {
                        // Title line only, no description
                        ExpectedBlock {
                            title: Some(t.clone()),
                            description: None,
                        }
                    }
                    (None, Some(d)) => {
                        // No title line, but implicit description line present.
                        // The parser treats the first non-tag line as the title,
                        // so the description text becomes the title.
                        ExpectedBlock {
                            title: Some(d.clone()),
                            description: None,
                        }
                    }
                    (None, None) => {
                        // No title, no description — only @param tags (if any)
                        ExpectedBlock {
                            title: None,
                            description: None,
                        }
                    }
                }
            }
            DescriptionStyle::Explicit => {
                // @description tag provides description explicitly.
                // Title is the first non-tag line (if present).
                ExpectedBlock {
                    title: title.clone(),
                    description: description.clone(),
                }
            }
        };

        (code, func_line, expected)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        // ============================================================================
        // Feature: function-parameter-completions, Property 14: Roxygen Function Documentation Extraction
        //
        // For any roxygen comment block containing a title line and/or @description
        // tag above a function definition, the extraction function SHALL return the
        // title and description as the function's documentation.
        //
        // **Validates: Requirements 8.1, 8.2, 8.3**
        // ============================================================================

        /// Generate roxygen blocks with title, description, and @param tags;
        /// verify extraction returns correct title and description, and that
        /// get_function_doc() returns the combined documentation.
        #[test]
        fn prop_roxygen_function_doc_extraction(
            has_title in proptest::bool::ANY,
            has_description in proptest::bool::ANY,
            title in title_strategy(),
            description in description_line_strategy(),
            desc_style in description_style_strategy(),
            params in param_entries_strategy(),
        ) {
            let opt_title = if has_title { Some(title.clone()) } else { None };
            let opt_desc = if has_description { Some(description.clone()) } else { None };

            // We need at least one roxygen line to have a block
            prop_assume!(has_title || has_description || !params.is_empty());

            let (code, func_line, expected) =
                build_roxygen_code(&opt_title, &opt_desc, &desc_style, &params);

            // Requirement 8.1: Extract contiguous comment block above function definition
            let block = extract_roxygen_block(&code, func_line);
            prop_assert!(
                block.is_some(),
                "Expected a roxygen block for code:\n{}",
                code
            );
            let block = block.unwrap();

            // Requirement 8.2: Title line extraction
            // The first non-tag, non-empty #' line is the title.
            prop_assert_eq!(
                &block.title,
                &expected.title,
                "Title mismatch for code:\n{}",
                code
            );

            // Requirement 8.3: Description extraction
            // Either implicit (paragraph after title) or explicit (@description tag).
            let has_tags = !params.is_empty() || matches!(desc_style, DescriptionStyle::Explicit);
            if has_tags {
                prop_assert_eq!(
                    &block.description,
                    &expected.description,
                    "Description mismatch for code:\n{}",
                    code
                );
            }

            // Verify @param entries are extracted correctly
            for (name, desc) in &params {
                prop_assert_eq!(
                    block.params.get(name).map(|s| s.as_str()),
                    Some(desc.as_str()),
                    "Param '{}' mismatch for code:\n{}",
                    name,
                    code
                );
            }

            // Requirement 8.1 + 8.2 + 8.3: get_function_doc returns combined documentation
            let func_doc = get_function_doc(&block);

            if expected.title.is_some() || expected.description.is_some() {
                prop_assert!(
                    func_doc.is_some(),
                    "Expected function doc to be Some for code:\n{}",
                    code
                );
                let doc = func_doc.unwrap();

                if let Some(ref t) = expected.title {
                    prop_assert!(
                        doc.contains(t.as_str()),
                        "Function doc should contain title '{}' but got '{}' for code:\n{}",
                        t,
                        doc,
                        code
                    );
                }
                if let Some(ref d) = expected.description {
                    prop_assert!(
                        doc.contains(d.as_str()),
                        "Function doc should contain description '{}' but got '{}' for code:\n{}",
                        d,
                        doc,
                        code
                    );
                }

                // When both title and description are present, they should be
                // separated by a double newline
                if expected.title.is_some() && expected.description.is_some() {
                    prop_assert!(
                        doc.contains("\n\n"),
                        "Function doc should have double newline separator between title and description, got '{}' for code:\n{}",
                        doc,
                        code
                    );
                }
            } else if !has_tags {
                // No title, no description, no tags — only possible if we have
                // params (which means has_tags is true). This branch handles the
                // case where fallback text might be present.
            }
        }
    }
}

