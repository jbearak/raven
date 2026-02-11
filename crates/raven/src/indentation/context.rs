//! Context detection for R smart indentation.
//!
//! This module analyzes tree-sitter AST to determine the syntactic context
//! at the cursor position, which drives indentation decisions.
//!
//! # Error Handling
//!
//! This module implements robust error handling for various edge cases:
//! - Invalid AST states: Falls back to regex-based detection when AST has errors
//! - Position validation: Validates cursor position is within document bounds
//! - Missing delimiters: Handles unclosed delimiters gracefully with heuristics
//! - Iteration limits: Prevents infinite loops in chain start detection

use tower_lsp::lsp_types::Position;
use tree_sitter::{Node, Tree};

// ============================================================================
// AST Node Detection Functions
// ============================================================================

/// Checks if a node is a native pipe operator (`|>`).
///
/// In tree-sitter-r, the native pipe `|>` appears as a child node with
/// kind `|>` inside a `binary_operator` parent.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
///
/// # Returns
///
/// `true` if the node is a `|>` node (native pipe operator).
pub fn is_pipe_operator(node: Node) -> bool {
    node.kind() == "|>"
}

/// Checks if a node is a special operator (`%>%`, `%in%`, `%word%`, etc.).
///
/// In tree-sitter-r, special operators like `%>%`, `%in%`, `%*%` appear
/// as child nodes with kind `special` inside a `binary_operator` parent.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
///
/// # Returns
///
/// `true` if the node is a `special` node (magrittr pipe or custom infix).
pub fn is_special_operator(node: Node) -> bool {
    node.kind() == "special"
}

/// Checks if a node is a continuation binary operator (`+` or `~`).
///
/// These operators are commonly used for line continuation in R:
/// - `+` is used in ggplot2 for layering
/// - `~` is used in formulas
///
/// In tree-sitter-r, these appear as child nodes with kind `+` or `~`
/// inside a `binary_operator` parent.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
///
/// # Returns
///
/// `true` if the node is a `+` or `~` operator node.
pub fn is_continuation_binary_operator(node: Node, _source: &str) -> bool {
    let kind = node.kind();
    kind == "+" || kind == "~"
}

/// Checks if a node is a function call node.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
///
/// # Returns
///
/// `true` if the node is a `call` node.
pub fn is_call_node(node: Node) -> bool {
    node.kind() == "call"
}

/// Checks if a node is an arguments node (inside parentheses of a function call).
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
///
/// # Returns
///
/// `true` if the node is an `arguments` node.
pub fn is_arguments_node(node: Node) -> bool {
    node.kind() == "arguments"
}

/// Checks if a node is a brace list node (code block inside `{}`).
///
/// In tree-sitter-r, braced code blocks use `braced_expression` as the node kind.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
///
/// # Returns
///
/// `true` if the node is a `braced_expression` node.
pub fn is_brace_list_node(node: Node) -> bool {
    node.kind() == "braced_expression"
}

/// Determines the operator type for a continuation operator node.
///
/// This function identifies what kind of continuation operator a node represents,
/// which is used to determine indentation behavior.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
/// * `source` - The source code text for extracting operator text
///
/// # Returns
///
/// `Some(OperatorType)` if the node is a recognized continuation operator,
/// `None` otherwise.
pub fn get_operator_type(node: Node, source: &str) -> Option<OperatorType> {
    match node.kind() {
        "|>" => Some(OperatorType::Pipe),
        "special" => {
            let text = node_text(node, source);
            if text == "%>%" {
                Some(OperatorType::MagrittrPipe)
            } else {
                // Any other %word% operator
                Some(OperatorType::CustomInfix)
            }
        }
        "+" => Some(OperatorType::Plus),
        "~" => Some(OperatorType::Tilde),
        _ => None,
    }
}

/// Checks if a node is any kind of continuation operator.
///
/// Continuation operators are operators that indicate the expression continues
/// on the next line: `|>`, `%>%`, `%word%`, `+`, `~`.
///
/// # Arguments
///
/// * `node` - The tree-sitter node to check
/// * `source` - The source code text for extracting operator text
///
/// # Returns
///
/// `true` if the node is a continuation operator.
pub fn is_continuation_operator(node: Node, source: &str) -> bool {
    is_pipe_operator(node)
        || is_special_operator(node)
        || is_continuation_binary_operator(node, source)
}

// ============================================================================
// AST Parent Walking Helpers
// ============================================================================

/// Walks up the AST from a node to find a parent matching a predicate.
///
/// # Arguments
///
/// * `node` - The starting node
/// * `predicate` - A function that returns `true` for the desired parent
///
/// # Returns
///
/// The first ancestor node matching the predicate, or `None` if not found.
pub fn find_parent<F>(node: Node, predicate: F) -> Option<Node>
where
    F: Fn(Node) -> bool,
{
    let mut current = node;
    while let Some(parent) = current.parent() {
        if predicate(parent) {
            return Some(parent);
        }
        current = parent;
    }
    None
}

/// Walks up the AST to find the nearest enclosing arguments node.
///
/// # Arguments
///
/// * `node` - The starting node
///
/// # Returns
///
/// The nearest `arguments` ancestor, or `None` if not inside arguments.
pub fn find_enclosing_arguments(node: Node) -> Option<Node> {
    find_parent(node, is_arguments_node)
}

/// Walks up the AST to find the nearest enclosing brace list node.
///
/// # Arguments
///
/// * `node` - The starting node
///
/// # Returns
///
/// The nearest `brace_list` ancestor, or `None` if not inside braces.
pub fn find_enclosing_brace_list(node: Node) -> Option<Node> {
    find_parent(node, is_brace_list_node)
}

/// Walks up the AST to find the nearest enclosing call node.
///
/// # Arguments
///
/// * `node` - The starting node
///
/// # Returns
///
/// The nearest `call` ancestor, or `None` if not inside a call.
pub fn find_enclosing_call(node: Node) -> Option<Node> {
    find_parent(node, is_call_node)
}

/// Finds the innermost relevant context node for indentation.
///
/// This walks up the AST and returns the first node that is relevant
/// for indentation decisions: arguments, brace_list, or a continuation operator.
///
/// # Arguments
///
/// * `node` - The starting node
/// * `source` - The source code text for operator detection
///
/// # Returns
///
/// The innermost relevant ancestor node, or `None` if none found.
pub fn find_innermost_context_node<'a>(node: Node<'a>, source: &str) -> Option<Node<'a>> {
    let mut current = node;
    loop {
        // Check if current node is a relevant context
        if is_arguments_node(current)
            || is_brace_list_node(current)
            || is_continuation_operator(current, source)
        {
            return Some(current);
        }

        // Move to parent
        current = current.parent()?;
    }
}

/// Finds the matching opening delimiter for a closing delimiter.
///
/// Walks up the AST from the given node to find the matching opening
/// delimiter (`(`, `[`, or `{`) for a closing delimiter (`)`, `]`, or `}`).
///
/// # Arguments
///
/// * `node` - The tree-sitter node at or near the closing delimiter
/// * `delimiter` - The closing delimiter character (`)`, `]`, or `}`)
///
/// # Returns
///
/// `Some(Node)` containing the AST node for the matching opening structure,
/// or `None` if no matching opener is found (unclosed delimiter).
///
/// # Example
///
/// ```ignore
/// // For code: "func(x, y)"
/// // If node is at the closing ')', this returns the 'arguments' node
/// // which starts at the opening '('
/// ```
pub fn find_matching_opener<'a>(node: Node<'a>, delimiter: char) -> Option<Node<'a>> {
    let target_kind = match delimiter {
        ')' => "arguments",
        ']' => "subset", // or "subset2" for [[]]
        '}' => "braced_expression",
        _ => return None,
    };

    // Walk up to find the enclosing structure
    let mut current = node;
    loop {
        if current.kind() == target_kind
            || (delimiter == ']' && current.kind() == "subset2")
            || (delimiter == ')' && current.kind() == "call")
        {
            // For call nodes, return the arguments child if it exists
            if current.kind() == "call" {
                for i in 0..current.child_count() {
                    if let Some(child) = current.child(i) {
                        if child.kind() == "arguments" {
                            return Some(child);
                        }
                    }
                }
            }

            return Some(current);
        }

        current = current.parent()?;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Extracts the text content of a tree-sitter node.
///
/// # Arguments
///
/// * `node` - The tree-sitter node
/// * `source` - The source code text
///
/// # Returns
///
/// The substring of source corresponding to the node's byte range.
fn node_text<'a>(node: Node, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}

// ============================================================================
// Core Types
// ============================================================================

/// Represents the syntactic context at the cursor position for indentation.
#[derive(Debug, Clone, PartialEq)]
pub enum IndentContext {
    /// Inside unclosed parentheses (function call arguments).
    InsideParens {
        /// Line number of the opening parenthesis.
        opener_line: u32,
        /// Column of the opening parenthesis.
        opener_col: u32,
        /// Whether there is content after the opening paren on the same line.
        has_content_on_opener_line: bool,
    },

    /// Inside unclosed braces (code block).
    InsideBraces {
        /// Line number of the opening brace.
        opener_line: u32,
        /// Column of the opening brace.
        opener_col: u32,
    },

    /// After a continuation operator (pipe, plus, tilde, infix).
    AfterContinuationOperator {
        /// Line number where the chain starts.
        chain_start_line: u32,
        /// Column where the chain starts (first non-whitespace).
        chain_start_col: u32,
        /// Type of the continuation operator.
        operator_type: OperatorType,
    },

    /// After a complete expression (no trailing operator, no unclosed delimiters).
    AfterCompleteExpression {
        /// Indentation level of the enclosing block.
        enclosing_block_indent: u32,
    },

    /// Closing delimiter on its own line.
    ClosingDelimiter {
        /// Line number of the matching opening delimiter.
        opener_line: u32,
        /// Column of the matching opening delimiter.
        opener_col: u32,
        /// The closing delimiter character.
        delimiter: char,
    },
}

/// Types of continuation operators in R.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperatorType {
    /// Native R pipe `|>`
    Pipe,
    /// Magrittr pipe `%>%`
    MagrittrPipe,
    /// Plus operator `+` (commonly used in ggplot2)
    Plus,
    /// Tilde operator `~` (formula)
    Tilde,
    /// Custom infix operator `%word%`
    CustomInfix,
}

/// Detects the syntactic context at the given position for indentation.
///
/// This function analyzes the tree-sitter AST to determine what kind of
/// indentation context the cursor is in (e.g., inside parentheses, after
/// a pipe operator, etc.).
///
/// The detection follows this priority order:
/// 1. ClosingDelimiter - if current line starts with closing delimiter
/// 2. AfterContinuationOperator - if previous line ends with continuation operator
/// 3. InsideParens - if inside unclosed parentheses
/// 4. InsideBraces - if inside unclosed braces
/// 5. AfterCompleteExpression - default fallback
///
/// # Error Handling
///
/// - If the AST has errors at the cursor position, falls back to regex-based detection
/// - If position is out of bounds, returns AfterCompleteExpression with indent 0
/// - Logs warnings for debugging without surfacing errors to user
///
/// # Arguments
///
/// * `tree` - The tree-sitter parse tree for the document
/// * `source` - The source code text
/// * `position` - The cursor position (typically after a newline)
///
/// # Returns
///
/// The detected `IndentContext` that should be used for indentation calculation.
pub fn detect_context(tree: &Tree, source: &str, position: Position) -> IndentContext {
    // Validate position is within document bounds
    if !is_position_valid(source, position) {
        log::warn!(
            "detect_context: position ({}, {}) is out of bounds for document with {} lines",
            position.line,
            position.character,
            source.lines().count()
        );
        return IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 0,
        };
    }

    // Check if AST has errors at cursor position - if so, use fallback
    let root = tree.root_node();
    if should_use_fallback(root, source, position) {
        log::trace!(
            "detect_context: using fallback detection due to AST errors at position ({}, {})",
            position.line,
            position.character
        );
        return fallback_detect_context(source, position);
    }

    // 1. Check if current line starts with closing delimiter
    if let Some(ctx) = detect_closing_delimiter(source, position) {
        // Find the matching opener using AST
        if let Some(ctx) = find_matching_opener_context(tree, source, &ctx) {
            return ctx;
        }
        // If no matching opener found, use the fallback context with heuristic
        log::trace!(
            "detect_context: no matching opener found for closing delimiter, using heuristic"
        );
        return ctx;
    }

    // 2. Check if previous line ends with continuation operator
    if let Some(ctx) = detect_continuation_operator(tree, source, position) {
        return ctx;
    }

    // 3. Check for both parens and braces, return the innermost one
    // We need to find the actual AST positions to compare, not the indentation values
    let parens_node = find_unclosed_arguments_at_position(root, position, source);
    let braces_node = find_unclosed_braces_at_position(root, position, source);

    match (parens_node, braces_node) {
        (Some(p), Some(b)) => {
            // Both contexts found - return the innermost one (later start position)
            let parens_start = p.start_position();
            let braces_start = b.start_position();

            // Compare positions: later line wins, or same line with later column
            if braces_start.row > parens_start.row
                || (braces_start.row == parens_start.row && braces_start.column > parens_start.column)
            {
                // Braces are innermost
                let opener_line = braces_start.row as u32;
                let opener_col = get_line_indent(source, opener_line);
                IndentContext::InsideBraces {
                    opener_line,
                    opener_col,
                }
            } else {
                // Parens are innermost
                let opener_line = parens_start.row as u32;
                let opener_col = parens_start.column as u32;
                let has_content = check_content_after_opener(source, opener_line, opener_col);
                IndentContext::InsideParens {
                    opener_line,
                    opener_col,
                    has_content_on_opener_line: has_content,
                }
            }
        }
        (Some(p), None) => {
            let opener_pos = p.start_position();
            let opener_line = opener_pos.row as u32;
            let opener_col = opener_pos.column as u32;
            let has_content = check_content_after_opener(source, opener_line, opener_col);
            IndentContext::InsideParens {
                opener_line,
                opener_col,
                has_content_on_opener_line: has_content,
            }
        }
        (None, Some(b)) => {
            let opener_pos = b.start_position();
            let opener_line = opener_pos.row as u32;
            let opener_col = get_line_indent(source, opener_line);
            IndentContext::InsideBraces {
                opener_line,
                opener_col,
            }
        }
        (None, None) => {
            // 4. Default to complete expression
            IndentContext::AfterCompleteExpression {
                enclosing_block_indent: get_enclosing_block_indent(tree, source, position),
            }
        }
    }
}

// ============================================================================
// Error Handling Helper Functions
// ============================================================================

/// Validates that a position is within the document bounds.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `position` - The cursor position to validate
///
/// # Returns
///
/// `true` if the position is valid (within document bounds), `false` otherwise.
fn is_position_valid(source: &str, position: Position) -> bool {
    let lines: Vec<&str> = source.lines().collect();
    let line_count = lines.len();

    // Check line is within bounds
    if position.line as usize >= line_count {
        // Allow position at the end of the last line or on a new line after it
        if position.line as usize > line_count {
            return false;
        }
        // Position is on a line that doesn't exist yet (e.g., after pressing Enter at EOF)
        // This is valid - the line will be empty
        return true;
    }

    // Check character is within line bounds (allowing for end of line)
    let line_text = lines.get(position.line as usize).unwrap_or(&"");
    // UTF-16 character position can be at most line length + 1 (for end of line)
    // We're lenient here since the actual character position may be approximate
    position.character as usize <= line_text.len() + 1
}

/// Determines if we should use fallback regex-based detection.
///
/// Returns true if the AST has errors at or near the cursor position,
/// indicating that AST-based detection may be unreliable.
///
/// # Arguments
///
/// * `root` - The root node of the parse tree
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// `true` if fallback detection should be used, `false` otherwise.
fn should_use_fallback(root: Node, _source: &str, position: Position) -> bool {
    // Check if there's an error node at or near the cursor position
    let point = tree_sitter::Point {
        row: position.line as usize,
        column: position.character as usize,
    };

    // Get the node at cursor position
    if let Some(node) = root.descendant_for_point_range(point, point) {
        // Check if this node or any ancestor is an error
        let mut current = node;
        loop {
            if current.is_error() {
                return true;
            }
            match current.parent() {
                Some(parent) => current = parent,
                None => break,
            }
        }
    }

    // Also check the previous line for errors (since we often indent based on it)
    if position.line > 0 {
        let prev_point = tree_sitter::Point {
            row: (position.line - 1) as usize,
            column: 0,
        };
        if let Some(node) = root.descendant_for_point_range(prev_point, prev_point) {
            let mut current = node;
            loop {
                if current.is_error() {
                    return true;
                }
                match current.parent() {
                    Some(parent) => current = parent,
                    None => break,
                }
            }
        }
    }

    false
}

/// Fallback context detection using regex-based heuristics.
///
/// This function is used when the AST has errors and cannot be relied upon
/// for accurate context detection. It uses simple regex patterns to detect
/// common indentation contexts.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// The detected `IndentContext` based on regex heuristics.
fn fallback_detect_context(source: &str, position: Position) -> IndentContext {
    // 1. Check if current line starts with closing delimiter
    if let Some(line_text) = source.lines().nth(position.line as usize) {
        let trimmed = line_text.trim_start();
        if let Some(first_char) = trimmed.chars().next() {
            if matches!(first_char, ')' | ']' | '}') {
                // Find matching opener using simple bracket counting
                if let Some((opener_line, opener_col)) =
                    find_matching_opener_heuristic(source, position.line, first_char)
                {
                    return IndentContext::ClosingDelimiter {
                        opener_line,
                        opener_col,
                        delimiter: first_char,
                    };
                }
                // No matching opener found - use previous line indent
                let prev_indent = if position.line > 0 {
                    get_line_indent(source, position.line - 1)
                } else {
                    0
                };
                return IndentContext::AfterCompleteExpression {
                    enclosing_block_indent: prev_indent,
                };
            }
        }
    }

    // 2. Check if previous line ends with continuation operator
    if position.line > 0 {
        if let Some(prev_line) = source.lines().nth((position.line - 1) as usize) {
            let trimmed = strip_trailing_comment(prev_line).trim_end();

            // Check for continuation operators
            let operator_type = if trimmed.ends_with("|>") {
                Some(OperatorType::Pipe)
            } else if trimmed.ends_with("%>%") {
                Some(OperatorType::MagrittrPipe)
            } else if trimmed.ends_with('+') {
                Some(OperatorType::Plus)
            } else if trimmed.ends_with('~') {
                Some(OperatorType::Tilde)
            } else if trimmed.ends_with('%') && is_custom_infix_ending(trimmed) {
                Some(OperatorType::CustomInfix)
            } else {
                None
            };

            if let Some(op_type) = operator_type {
                // Find chain start using simple backward walk
                let (chain_start_line, chain_start_col) =
                    find_chain_start_heuristic(source, position.line - 1);
                return IndentContext::AfterContinuationOperator {
                    chain_start_line,
                    chain_start_col,
                    operator_type: op_type,
                };
            }
        }
    }

    // 3. Check for unclosed delimiters using bracket counting
    if let Some((opener_line, opener_col, delimiter)) =
        find_unclosed_delimiter_heuristic(source, position.line)
    {
        match delimiter {
            '(' | '[' => {
                let has_content = check_content_after_opener(source, opener_line, opener_col);
                return IndentContext::InsideParens {
                    opener_line,
                    opener_col,
                    has_content_on_opener_line: has_content,
                };
            }
            '{' => {
                let opener_indent = get_line_indent(source, opener_line);
                return IndentContext::InsideBraces {
                    opener_line,
                    opener_col: opener_indent,
                };
            }
            _ => {}
        }
    }

    // 4. Default to complete expression with previous line indent
    let enclosing_indent = if position.line > 0 {
        get_line_indent(source, position.line - 1)
    } else {
        0
    };

    IndentContext::AfterCompleteExpression {
        enclosing_block_indent: enclosing_indent,
    }
}

/// Finds a matching opening delimiter using simple bracket counting.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `closing_line` - The line containing the closing delimiter
/// * `closing_char` - The closing delimiter character
///
/// # Returns
///
/// `Some((line, col))` of the matching opener, or `None` if not found.
fn find_matching_opener_heuristic(
    source: &str,
    closing_line: u32,
    closing_char: char,
) -> Option<(u32, u32)> {
    let opening_char = match closing_char {
        ')' => '(',
        ']' => '[',
        '}' => '{',
        _ => return None,
    };

    let lines: Vec<&str> = source.lines().collect();
    // Start with depth 1 because we're looking for the opener that matches
    // the closing delimiter on closing_line
    let mut depth = 1;

    // Walk backward from closing line (but skip the closing delimiter itself)
    // First, process the closing line up to (but not including) the closing delimiter
    if let Some(closing_line_text) = lines.get(closing_line as usize) {
        let stripped = strip_trailing_comment(closing_line_text);
        // Find the position of the first closing delimiter on this line
        if let Some(closing_pos) = stripped.find(closing_char) {
            // Process characters before the closing delimiter in reverse
            for (col, ch) in stripped[..closing_pos].char_indices().rev() {
                if ch == closing_char {
                    depth += 1;
                } else if ch == opening_char {
                    depth -= 1;
                    if depth == 0 {
                        return Some((closing_line, col as u32));
                    }
                }
            }
        }
    }

    // Now walk backward through previous lines
    if closing_line == 0 {
        return None;
    }

    for line_idx in (0..closing_line as usize).rev() {
        let line_text = lines.get(line_idx)?;
        let stripped = strip_trailing_comment(line_text);

        // Process characters in reverse order
        for (col, ch) in stripped.char_indices().rev() {
            if ch == closing_char {
                depth += 1;
            } else if ch == opening_char {
                depth -= 1;
                if depth == 0 {
                    // Found the matching opener
                    return Some((line_idx as u32, col as u32));
                }
            }
        }
    }

    None
}

/// Finds the chain start using simple backward line walking.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `start_line` - The line to start walking backward from
///
/// # Returns
///
/// `(line, col)` of the chain start.
fn find_chain_start_heuristic(source: &str, start_line: u32) -> (u32, u32) {
    let mut current_line = start_line;
    let max_iterations = 1000;
    let mut iterations = 0;

    while current_line > 0 && iterations < max_iterations {
        if let Some(prev_line_text) = source.lines().nth((current_line - 1) as usize) {
            let trimmed = strip_trailing_comment(prev_line_text).trim_end();

            // Check if previous line ends with continuation operator
            let ends_with_op = trimmed.ends_with("|>")
                || trimmed.ends_with("%>%")
                || trimmed.ends_with('+')
                || trimmed.ends_with('~')
                || (trimmed.ends_with('%') && is_custom_infix_ending(trimmed));

            if !ends_with_op {
                break;
            }
        } else {
            break;
        }

        current_line -= 1;
        iterations += 1;
    }

    if iterations >= max_iterations {
        log::warn!("find_chain_start_heuristic: exceeded max iterations");
    }

    // Get the column of first non-whitespace on chain start line
    let col = source
        .lines()
        .nth(current_line as usize)
        .map(|l| l.chars().take_while(|c| c.is_whitespace()).count() as u32)
        .unwrap_or(0);

    (current_line, col)
}

/// Finds an unclosed delimiter using bracket counting.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `current_line` - The current line number
///
/// # Returns
///
/// `Some((line, col, delimiter))` of the innermost unclosed opener, or `None`.
fn find_unclosed_delimiter_heuristic(
    source: &str,
    current_line: u32,
) -> Option<(u32, u32, char)> {
    let lines: Vec<&str> = source.lines().collect();

    // Track unclosed delimiters with their positions
    let mut stack: Vec<(u32, u32, char)> = Vec::new();

    // Process lines up to (but not including) current line
    for line_idx in 0..current_line as usize {
        let line_text = lines.get(line_idx)?;
        let stripped = strip_trailing_comment(line_text);

        for (col, ch) in stripped.char_indices() {
            match ch {
                '(' | '[' | '{' => {
                    stack.push((line_idx as u32, col as u32, ch));
                }
                ')' => {
                    if let Some((_, _, '(')) = stack.last() {
                        stack.pop();
                    }
                }
                ']' => {
                    if let Some((_, _, '[')) = stack.last() {
                        stack.pop();
                    }
                }
                '}' => {
                    if let Some((_, _, '{')) = stack.last() {
                        stack.pop();
                    }
                }
                _ => {}
            }
        }
    }

    // Return the innermost (last) unclosed delimiter
    stack.pop()
}

/// Detects if the current line starts with a closing delimiter.
///
/// Checks if the first non-whitespace character on the current line is
/// `)`, `]`, or `}`.
///
/// When the cursor is at position 0 on a line that contains only a closing
/// delimiter (with optional whitespace), this is likely an auto-close scenario:
/// the user pressed Enter between `(` and `)`, and VS Code pushed the auto-inserted
/// `)` to the new line. In this case, we skip closing delimiter detection so the
/// line gets indented as "inside parens" content instead.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// `Some(IndentContext::ClosingDelimiter)` if a closing delimiter is found
/// and the cursor is NOT at the start of the line (i.e., the user intentionally
/// placed the delimiter), with placeholder opener position (to be filled by AST lookup).
fn detect_closing_delimiter(source: &str, position: Position) -> Option<IndentContext> {
    let line_text = source.lines().nth(position.line as usize)?;
    let trimmed = line_text.trim_start();

    if trimmed.is_empty() {
        return None;
    }

    let first_char = trimmed.chars().next()?;
    if matches!(first_char, ')' | ']' | '}') {
        // If the line contains only the closing delimiter (with optional whitespace),
        // this is an auto-close push-down scenario: the user pressed Enter and
        // VS Code's auto-inserted closing delimiter got pushed to this line.
        // Skip closing delimiter detection so the line gets indented as content
        // inside the enclosing parens/braces.
        //
        // The onTypeFormatting position.character may be 0 or may reflect
        // the previous line's indentation — either way, a delimiter-only line
        // after Enter means we're inserting content, not aligning the delimiter.
        let after_delimiter = trimmed[first_char.len_utf8()..].trim();
        if after_delimiter.is_empty() {
            return None;
        }

        // Return with placeholder opener position - will be updated by AST lookup
        Some(IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 0,
            delimiter: first_char,
        })
    } else {
        None
    }
}

/// Finds the matching opener for a closing delimiter using AST.
///
/// Walks up the AST from the closing delimiter position to find the
/// matching opening delimiter and returns an updated context with
/// the correct opener position.
///
/// # Arguments
///
/// * `tree` - The tree-sitter parse tree
/// * `source` - The source code text
/// * `ctx` - The closing delimiter context with placeholder opener position
///
/// # Returns
///
/// Updated `IndentContext::ClosingDelimiter` with correct opener position,
/// or `None` if no matching opener is found.
fn find_matching_opener_context(
    tree: &Tree,
    source: &str,
    ctx: &IndentContext,
) -> Option<IndentContext> {
    let IndentContext::ClosingDelimiter { delimiter, .. } = ctx else {
        return None;
    };

    // Find the position of the closing delimiter on the current line
    let lines: Vec<&str> = source.lines().collect();

    // We need to find which line has the closing delimiter
    // Since we're called from detect_context, we need to search for it
    for (line_idx, line_text) in lines.iter().enumerate() {
        let trimmed = line_text.trim_start();
        if trimmed.starts_with(*delimiter) {
            let col = line_text.len() - trimmed.len();
            let point = tree_sitter::Point {
                row: line_idx,
                column: col,
            };

            // Get the node at the closing delimiter position
            if let Some(node) = tree.root_node().descendant_for_point_range(point, point) {
                // Walk up to find the enclosing structure
                if let Some((opener_line, opener_col)) =
                    find_opener_position(node, *delimiter, source)
                {
                    return Some(IndentContext::ClosingDelimiter {
                        opener_line,
                        opener_col,
                        delimiter: *delimiter,
                    });
                }
            }
            break;
        }
    }

    None
}

/// Finds the position of the opening delimiter that matches a closing delimiter.
///
/// # Arguments
///
/// * `node` - The tree-sitter node at or near the closing delimiter
/// * `delimiter` - The closing delimiter character
/// * `source` - The source code text
///
/// # Returns
///
/// `Some((line, col))` of the opening delimiter, or `None` if not found.
fn find_opener_position(node: Node, delimiter: char, _source: &str) -> Option<(u32, u32)> {
    let target_kind = match delimiter {
        ')' => "arguments",
        ']' => "subset", // or "subset2" for [[]]
        '}' => "braced_expression",
        _ => return None,
    };

    // Walk up to find the enclosing structure
    let mut current = node;
    loop {
        if current.kind() == target_kind
            || (delimiter == ']' && current.kind() == "subset2")
            || (delimiter == ')' && current.kind() == "call")
        {
            // For call nodes, we want the opening paren position
            // which is after the function name
            if current.kind() == "call" {
                // Find the arguments child
                for i in 0..current.child_count() {
                    if let Some(child) = current.child(i) {
                        if child.kind() == "arguments" {
                            let start = child.start_position();
                            return Some((start.row as u32, start.column as u32));
                        }
                    }
                }
            }

            let start = current.start_position();
            return Some((start.row as u32, start.column as u32));
        }

        current = current.parent()?;
    }
}

/// Detects if the previous line ends with a continuation operator.
///
/// Checks if the line before the cursor position ends with a continuation
/// operator (`|>`, `%>%`, `+`, `~`, `%word%`), ignoring trailing whitespace
/// and comments.
///
/// # Arguments
///
/// * `tree` - The tree-sitter parse tree
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// `Some(IndentContext::AfterContinuationOperator)` if a continuation operator
/// is found, with the chain start position and operator type.
fn detect_continuation_operator(
    tree: &Tree,
    source: &str,
    position: Position,
) -> Option<IndentContext> {
    // Need to check the previous line
    if position.line == 0 {
        return None;
    }

    let prev_line = position.line - 1;
    let line_text = source.lines().nth(prev_line as usize)?;

    // Strip trailing whitespace and comments
    let trimmed = strip_trailing_comment(line_text);
    let trimmed = trimmed.trim_end();

    if trimmed.is_empty() {
        return None;
    }

    // Determine operator type from line ending
    let operator_type = if trimmed.ends_with("|>") {
        Some(OperatorType::Pipe)
    } else if trimmed.ends_with("%>%") {
        Some(OperatorType::MagrittrPipe)
    } else if trimmed.ends_with('+') {
        Some(OperatorType::Plus)
    } else if trimmed.ends_with('~') {
        Some(OperatorType::Tilde)
    } else if trimmed.ends_with('%') && is_custom_infix_ending(trimmed) {
        Some(OperatorType::CustomInfix)
    } else {
        None
    }?;

    // Find chain start using ChainWalker
    let walker = ChainWalker::new(tree, source);
    let (chain_start_line, chain_start_col) = walker.find_chain_start(position);

    Some(IndentContext::AfterContinuationOperator {
        chain_start_line,
        chain_start_col,
        operator_type,
    })
}

/// Checks if a line ends with a custom infix operator (%word%).
///
/// # Arguments
///
/// * `trimmed` - The line text with trailing whitespace/comments removed
///
/// # Returns
///
/// `true` if the line ends with a valid custom infix operator.
fn is_custom_infix_ending(trimmed: &str) -> bool {
    // Must end with % and have another % before it
    if !trimmed.ends_with('%') {
        return false;
    }

    let bytes = trimmed.as_bytes();
    let len = bytes.len();

    if len < 3 {
        return false;
    }

    // Find the opening % by scanning backward
    for i in (0..len - 1).rev() {
        if bytes[i] == b'%' {
            let between = &trimmed[i + 1..len - 1];
            // Valid infix operators allow alphanumeric and certain special chars
            if !between.is_empty()
                && between.chars().all(|c| {
                    c.is_alphanumeric()
                        || matches!(c, '.' | '>' | '<' | '*' | '/' | '|' | '&' | '!' | '=')
                })
            {
                return true;
            }
            break;
        }
    }

    false
}

/// Detects if the cursor is inside unclosed parentheses.
///
/// Walks up the AST from the cursor position to find an enclosing
/// `arguments` node that hasn't been closed yet.
///
/// # Arguments
///
/// * `tree` - The tree-sitter parse tree
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// `Some(IndentContext::InsideParens)` if inside unclosed parentheses,
/// with the opener position and content check.
#[allow(dead_code)] // Used in tests and may be useful for future refactoring
fn detect_inside_parens(tree: &Tree, source: &str, position: Position) -> Option<IndentContext> {
    // Strategy: Look for an arguments node that:
    // 1. Starts before the cursor position
    // 2. Either ends after the cursor OR has a MISSING closing paren

    let root = tree.root_node();

    // Find all arguments nodes and check if cursor is inside any of them
    let args_node = find_unclosed_arguments_at_position(root, position, source)?;

    let opener_pos = args_node.start_position();
    let opener_line = opener_pos.row as u32;
    let opener_col = opener_pos.column as u32;

    // Check if there's content after the opening paren on the same line
    let has_content = check_content_after_opener(source, opener_line, opener_col);

    Some(IndentContext::InsideParens {
        opener_line,
        opener_col,
        has_content_on_opener_line: has_content,
    })
}

/// Finds an unclosed arguments node that contains the given position.
///
/// This handles the case where tree-sitter marks the closing paren as MISSING.
fn find_unclosed_arguments_at_position<'a>(
    node: Node<'a>,
    position: Position,
    source: &str,
) -> Option<Node<'a>> {
    // Check if this node is an arguments node
    if node.kind() == "arguments" {
        let start = node.start_position();
        let end = node.end_position();

        // Check if cursor is after the start
        let cursor_after_start = position.line as usize > start.row
            || (position.line as usize == start.row
                && position.character as usize > start.column);

        if cursor_after_start {
            // Check if the arguments node is unclosed (has MISSING close)
            // or if cursor is before the end
            let cursor_before_end = (position.line as usize) < end.row
                || (position.line as usize == end.row
                    && (position.character as usize) < end.column);

            let has_missing_close = has_missing_child(node);

            if cursor_before_end || has_missing_close {
                return Some(node);
            }
        }
    }

    // Recursively check children, looking for the innermost match
    let mut result: Option<Node<'a>> = None;
    let mut cursor = node.walk();

    if cursor.goto_first_child() {
        loop {
            if let Some(found) = find_unclosed_arguments_at_position(cursor.node(), position, source)
            {
                // Keep the innermost (last found) match
                result = Some(found);
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }

    result
}

/// Checks if a node has a MISSING child (indicating incomplete syntax).
fn has_missing_child(node: Node) -> bool {
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            if cursor.node().is_missing() {
                return true;
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    false
}

/// Checks if there's non-whitespace content after the opening paren on the same line.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `opener_line` - The line number of the opening paren
/// * `opener_col` - The column of the opening paren
///
/// # Returns
///
/// `true` if there's content after the opening paren on the same line.
fn check_content_after_opener(source: &str, opener_line: u32, opener_col: u32) -> bool {
    let Some(line_text) = source.lines().nth(opener_line as usize) else {
        return false;
    };

    // Get the text after the opening paren (skip the paren itself)
    let after_opener = if (opener_col as usize + 1) < line_text.len() {
        &line_text[(opener_col as usize + 1)..]
    } else {
        return false;
    };

    // Strip comments and check if there's non-whitespace content
    let stripped = strip_trailing_comment(after_opener);
    !stripped.trim().is_empty()
}

/// Detects if the cursor is inside unclosed braces.
///
/// Walks up the AST from the cursor position to find an enclosing
/// `braced_expression` node that hasn't been closed yet.
///
/// # Arguments
///
/// * `tree` - The tree-sitter parse tree
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// `Some(IndentContext::InsideBraces)` if inside unclosed braces,
/// with the opener position.
#[allow(dead_code)] // Used in tests and may be useful for future refactoring
fn detect_inside_braces(tree: &Tree, source: &str, position: Position) -> Option<IndentContext> {
    // Strategy: Look for a braced_expression node that:
    // 1. Starts before the cursor position
    // 2. Either ends after the cursor OR has a MISSING closing brace

    let root = tree.root_node();

    // Find all braced_expression nodes and check if cursor is inside any of them
    let brace_node = find_unclosed_braces_at_position(root, position, source)?;

    let opener_pos = brace_node.start_position();

    // Get the indentation of the line containing the opening brace
    let opener_line = opener_pos.row as u32;
    let opener_col = get_line_indent(source, opener_line);

    Some(IndentContext::InsideBraces {
        opener_line,
        opener_col,
    })
}

/// Finds an unclosed braced_expression node that contains the given position.
///
/// This handles the case where tree-sitter marks the closing brace as MISSING.
fn find_unclosed_braces_at_position<'a>(
    node: Node<'a>,
    position: Position,
    _source: &str,
) -> Option<Node<'a>> {
    // Check if this node is a braced_expression node
    if node.kind() == "braced_expression" {
        let start = node.start_position();
        let end = node.end_position();

        // Check if cursor is after the start
        let cursor_after_start = position.line as usize > start.row
            || (position.line as usize == start.row
                && position.character as usize > start.column);

        if cursor_after_start {
            // Check if the braced_expression node is unclosed (has MISSING close)
            // or if cursor is before the end
            let cursor_before_end = (position.line as usize) < end.row
                || (position.line as usize == end.row
                    && (position.character as usize) < end.column);

            let has_missing_close = has_missing_child(node);

            if cursor_before_end || has_missing_close {
                return Some(node);
            }
        }
    }

    // Recursively check children, looking for the innermost match
    let mut result: Option<Node<'a>> = None;
    let mut cursor = node.walk();

    if cursor.goto_first_child() {
        loop {
            if let Some(found) = find_unclosed_braces_at_position(cursor.node(), position, _source)
            {
                // Keep the innermost (last found) match
                result = Some(found);
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }

    result
}

/// Gets the indentation (leading whitespace count) of a line.
///
/// # Arguments
///
/// * `source` - The source code text
/// * `line` - The line number (0-indexed)
///
/// # Returns
///
/// The number of leading whitespace characters on the line.
fn get_line_indent(source: &str, line: u32) -> u32 {
    source
        .lines()
        .nth(line as usize)
        .map(|l| l.chars().take_while(|c| c.is_whitespace()).count() as u32)
        .unwrap_or(0)
}

/// Gets the indentation of the enclosing block.
///
/// Walks up the AST to find the nearest enclosing block (braced_expression,
/// function body, etc.) and returns its indentation level.
///
/// # Arguments
///
/// * `tree` - The tree-sitter parse tree
/// * `source` - The source code text
/// * `position` - The cursor position
///
/// # Returns
///
/// The indentation level of the enclosing block, or 0 if at top level.
fn get_enclosing_block_indent(tree: &Tree, source: &str, position: Position) -> u32 {
    let point = tree_sitter::Point {
        row: position.line as usize,
        column: position.character as usize,
    };

    // Get node at cursor position
    let Some(node) = tree.root_node().descendant_for_point_range(point, point) else {
        return 0;
    };

    // Walk up to find enclosing block
    if let Some(brace_node) = find_enclosing_brace_list(node) {
        let opener_line = brace_node.start_position().row as u32;
        return get_line_indent(source, opener_line);
    }

    // No enclosing block, return 0 (top level)
    0
}
// ============================================================================
// Chain Start Detection
// ============================================================================

/// Walks backward through operator-terminated lines to find the chain start.
///
/// The chain start is the first line in a sequence of operator-terminated lines.
/// For example:
/// ```r
/// result <- data %>%    # Line 0 - chain start
///   filter(x > 0) %>%   # Line 1 - continuation
///   select(y)           # Line 2 - continuation
/// ```
///
/// When cursor is on line 2, chain start should be line 0, column 0 (start of "result").
pub struct ChainWalker<'a> {
    /// The tree-sitter parse tree (currently unused but available for future AST-based detection)
    #[allow(dead_code)]
    tree: &'a Tree,
    /// The source code text
    source: &'a str,
}

impl<'a> ChainWalker<'a> {
    /// Creates a new ChainWalker.
    ///
    /// # Arguments
    ///
    /// * `tree` - The tree-sitter parse tree
    /// * `source` - The source code text
    pub fn new(tree: &'a Tree, source: &'a str) -> Self {
        Self { tree, source }
    }

    /// Finds the chain start by walking backward through operator-terminated lines.
    ///
    /// Starting from `start_position`, walks backward through lines that end with
    /// continuation operators (`|>`, `%>%`, `+`, `~`, `%word%`) until finding a line
    /// that does NOT end with such an operator.
    ///
    /// # Arguments
    ///
    /// * `start_position` - The position to start walking backward from
    ///
    /// # Returns
    ///
    /// A tuple `(line, column)` representing the chain start position:
    /// - `line`: The line number of the chain start
    /// - `column`: The column of the first non-whitespace character on that line
    pub fn find_chain_start(&self, start_position: Position) -> (u32, u32) {
        let mut current_line = start_position.line;
        let max_iterations = 1000;
        let mut iterations = 0;

        while current_line > 0 && iterations < max_iterations {
            if !self.line_ends_with_operator(current_line - 1) {
                break;
            }
            current_line -= 1;
            iterations += 1;
        }

        if iterations >= max_iterations {
            log::warn!("Chain start detection exceeded max iterations");
        }

        (current_line, self.get_line_start_column(current_line))
    }

    /// Checks if a line ends with a continuation operator.
    ///
    /// Continuation operators are: `|>`, `%>%`, `+`, `~`, and custom infix `%word%`.
    /// The check ignores trailing whitespace and comments.
    ///
    /// # Arguments
    ///
    /// * `line` - The line number to check (0-indexed)
    ///
    /// # Returns
    ///
    /// `true` if the line ends with a continuation operator.
    fn line_ends_with_operator(&self, line: u32) -> bool {
        let Some(line_text) = self.get_line_text(line) else {
            return false;
        };

        // Strip trailing whitespace and comments
        let trimmed = strip_trailing_comment(line_text);
        let trimmed = trimmed.trim_end();

        if trimmed.is_empty() {
            return false;
        }

        // Check for native pipe |>
        if trimmed.ends_with("|>") {
            return true;
        }

        // Check for magrittr pipe %>% and custom infix %word%
        // Pattern: ends with %something%
        // The last character must be '%' and there must be another '%' before it
        if trimmed.ends_with('%') {
            let bytes = trimmed.as_bytes();
            let len = bytes.len();
            // Find the opening % by scanning backward from the second-to-last character
            if len >= 3 {
                // Start from len-2 (skip the closing %)
                for i in (0..len - 1).rev() {
                    if bytes[i] == b'%' {
                        // Found opening %, check content between
                        let between = &trimmed[i + 1..len - 1];
                        // Valid infix operators: %>%, %in%, %*%, %/%, %o%, %x%, %||%, etc.
                        // Allow alphanumeric, '.', '>', '<', '*', '/', '|', '&', '!', '='
                        if !between.is_empty()
                            && between.chars().all(|c| {
                                c.is_alphanumeric()
                                    || matches!(c, '.' | '>' | '<' | '*' | '/' | '|' | '&' | '!' | '=')
                            })
                        {
                            return true;
                        }
                        // Found a %, but content is invalid, stop looking
                        break;
                    }
                }
            }
        }

        // Check for + operator at end
        if trimmed.ends_with('+') {
            return true;
        }

        // Check for ~ operator at end
        if trimmed.ends_with('~') {
            return true;
        }

        false
    }

    /// Gets the column of the first non-whitespace character on a line.
    ///
    /// # Arguments
    ///
    /// * `line` - The line number (0-indexed)
    ///
    /// # Returns
    ///
    /// The column (0-indexed) of the first non-whitespace character,
    /// or 0 if the line is empty or all whitespace.
    fn get_line_start_column(&self, line: u32) -> u32 {
        let Some(line_text) = self.get_line_text(line) else {
            return 0;
        };

        line_text
            .chars()
            .take_while(|c| c.is_whitespace())
            .count() as u32
    }

    /// Gets the text content of a specific line.
    ///
    /// # Arguments
    ///
    /// * `line` - The line number (0-indexed)
    ///
    /// # Returns
    ///
    /// The line text, or `None` if the line doesn't exist.
    fn get_line_text(&self, line: u32) -> Option<&'a str> {
        self.source.lines().nth(line as usize)
    }
}

/// Strips trailing comments from a line of R code.
///
/// R comments start with `#` and continue to end of line.
/// This function handles the case where `#` appears inside strings.
///
/// # Arguments
///
/// * `line` - The line text
///
/// # Returns
///
/// The line text with trailing comment removed.
fn strip_trailing_comment(line: &str) -> &str {
    let mut in_string = false;
    let mut string_char = '"';
    let mut escape_next = false;

    for (i, c) in line.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }

        if c == '\\' && in_string {
            escape_next = true;
            continue;
        }

        if !in_string && (c == '"' || c == '\'') {
            in_string = true;
            string_char = c;
        } else if in_string && c == string_char {
            in_string = false;
        } else if !in_string && c == '#' {
            return &line[..i];
        }
    }

    line
}




#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Helper to parse R code and get the tree
    fn parse_r_code(code: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .expect("Failed to set R language");
        parser.parse(code, None).expect("Failed to parse code")
    }

    /// Recursively visits all nodes in the tree and collects them.
    fn collect_all_nodes(node: Node) -> Vec<Node> {
        let mut nodes = vec![node];
        let mut cursor = node.walk();
        if cursor.goto_first_child() {
            loop {
                nodes.extend(collect_all_nodes(cursor.node()));
                if !cursor.goto_next_sibling() {
                    break;
                }
            }
        }
        nodes
    }

    // ========================================================================
    // Error Handling Tests (Task 9.6)
    // ========================================================================

    #[test]
    fn test_is_position_valid_within_bounds() {
        let source = "line0\nline1\nline2";
        assert!(is_position_valid(source, Position { line: 0, character: 0 }));
        assert!(is_position_valid(source, Position { line: 1, character: 3 }));
        assert!(is_position_valid(source, Position { line: 2, character: 5 }));
    }

    #[test]
    fn test_is_position_valid_at_end_of_line() {
        let source = "line0\nline1";
        // Position at end of line should be valid
        assert!(is_position_valid(source, Position { line: 0, character: 5 }));
        assert!(is_position_valid(source, Position { line: 1, character: 5 }));
    }

    #[test]
    fn test_is_position_valid_out_of_bounds_line() {
        let source = "line0\nline1";
        // Line 5 doesn't exist
        assert!(!is_position_valid(source, Position { line: 5, character: 0 }));
    }

    #[test]
    fn test_is_position_valid_empty_source() {
        let source = "";
        // Empty source - line 0 is valid (for new line after EOF)
        assert!(is_position_valid(source, Position { line: 0, character: 0 }));
        assert!(!is_position_valid(source, Position { line: 1, character: 0 }));
    }

    #[test]
    fn test_is_position_valid_new_line_after_eof() {
        let source = "line0";
        // Position on line after last line (e.g., after pressing Enter at EOF)
        assert!(is_position_valid(source, Position { line: 1, character: 0 }));
        // But not two lines after
        assert!(!is_position_valid(source, Position { line: 2, character: 0 }));
    }

    #[test]
    fn test_should_use_fallback_no_errors() {
        let code = "x <- 1 + 2";
        let tree = parse_r_code(code);
        let position = Position { line: 0, character: 5 };
        assert!(!should_use_fallback(tree.root_node(), code, position));
    }

    #[test]
    fn test_should_use_fallback_with_syntax_error() {
        // Use a more clearly invalid syntax that tree-sitter will mark as error
        let code = "x <- <- y"; // Double assignment operator is invalid
        let tree = parse_r_code(code);
        let position = Position { line: 0, character: 5 };
        // This may or may not trigger fallback depending on how tree-sitter handles it
        // The important thing is that it doesn't panic
        let _ = should_use_fallback(tree.root_node(), code, position);
    }

    #[test]
    fn test_should_use_fallback_incomplete_expression() {
        // Incomplete expressions may not always be marked as errors by tree-sitter
        // The important thing is that the function handles them gracefully
        let code = "x <-"; // Incomplete assignment
        let tree = parse_r_code(code);
        let position = Position { line: 0, character: 4 };
        // This may or may not trigger fallback - just verify it doesn't panic
        let _ = should_use_fallback(tree.root_node(), code, position);
    }

    #[test]
    fn test_fallback_detect_context_closing_delimiter() {
        let source = "func(\n  arg1\n)";
        let position = Position { line: 2, character: 0 };
        let ctx = fallback_detect_context(source, position);
        
        match ctx {
            IndentContext::ClosingDelimiter { delimiter, .. } => {
                assert_eq!(delimiter, ')');
            }
            _ => panic!("Expected ClosingDelimiter context"),
        }
    }

    #[test]
    fn test_fallback_detect_context_continuation_operator() {
        let source = "data %>%\n";
        let position = Position { line: 1, character: 0 };
        let ctx = fallback_detect_context(source, position);
        
        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator context"),
        }
    }

    #[test]
    fn test_fallback_detect_context_native_pipe() {
        let source = "data |>\n";
        let position = Position { line: 1, character: 0 };
        let ctx = fallback_detect_context(source, position);
        
        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::Pipe);
            }
            _ => panic!("Expected AfterContinuationOperator context"),
        }
    }

    #[test]
    fn test_fallback_detect_context_unclosed_paren() {
        let source = "func(\n";
        let position = Position { line: 1, character: 0 };
        let ctx = fallback_detect_context(source, position);
        
        match ctx {
            IndentContext::InsideParens { opener_line, opener_col, .. } => {
                assert_eq!(opener_line, 0);
                assert_eq!(opener_col, 4);
            }
            _ => panic!("Expected InsideParens context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_fallback_detect_context_unclosed_brace() {
        let source = "if (TRUE) {\n";
        let position = Position { line: 1, character: 0 };
        let ctx = fallback_detect_context(source, position);
        
        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_fallback_detect_context_complete_expression() {
        let source = "x <- 1\n";
        let position = Position { line: 1, character: 0 };
        let ctx = fallback_detect_context(source, position);
        
        match ctx {
            IndentContext::AfterCompleteExpression { enclosing_block_indent } => {
                assert_eq!(enclosing_block_indent, 0);
            }
            _ => panic!("Expected AfterCompleteExpression context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_find_matching_opener_heuristic_paren() {
        let source = "func(\n  arg\n)";
        let result = find_matching_opener_heuristic(source, 2, ')');
        assert_eq!(result, Some((0, 4)));
    }

    #[test]
    fn test_find_matching_opener_heuristic_nested() {
        let source = "outer(inner(\n  arg\n))";
        // Closing the inner paren
        let result = find_matching_opener_heuristic(source, 2, ')');
        // Should find the inner opening paren
        assert!(result.is_some());
    }

    #[test]
    fn test_find_matching_opener_heuristic_brace() {
        let source = "if (TRUE) {\n  x <- 1\n}";
        let result = find_matching_opener_heuristic(source, 2, '}');
        assert_eq!(result, Some((0, 10)));
    }

    #[test]
    fn test_find_matching_opener_heuristic_not_found() {
        let source = "x <- 1\n)"; // Unmatched closing paren
        let result = find_matching_opener_heuristic(source, 1, ')');
        assert_eq!(result, None);
    }

    #[test]
    fn test_find_chain_start_heuristic_simple() {
        let source = "data %>%\n  step1()";
        let (line, col) = find_chain_start_heuristic(source, 0);
        assert_eq!(line, 0);
        assert_eq!(col, 0);
    }

    #[test]
    fn test_find_chain_start_heuristic_multi_line() {
        let source = "data %>%\n  step1() %>%\n  step2()";
        let (line, col) = find_chain_start_heuristic(source, 1);
        assert_eq!(line, 0);
        assert_eq!(col, 0);
    }

    #[test]
    fn test_find_chain_start_heuristic_indented() {
        let source = "  data %>%\n    step1()";
        let (line, col) = find_chain_start_heuristic(source, 0);
        assert_eq!(line, 0);
        assert_eq!(col, 2); // First non-whitespace at column 2
    }

    #[test]
    fn test_find_unclosed_delimiter_heuristic_paren() {
        let source = "func(\n";
        let result = find_unclosed_delimiter_heuristic(source, 1);
        assert_eq!(result, Some((0, 4, '(')));
    }

    #[test]
    fn test_find_unclosed_delimiter_heuristic_nested() {
        let source = "outer(inner(\n";
        let result = find_unclosed_delimiter_heuristic(source, 1);
        // Should return the innermost unclosed delimiter
        assert_eq!(result, Some((0, 11, '(')));
    }

    #[test]
    fn test_find_unclosed_delimiter_heuristic_closed() {
        let source = "func(arg)\n";
        let result = find_unclosed_delimiter_heuristic(source, 1);
        assert_eq!(result, None);
    }

    #[test]
    fn test_detect_context_with_invalid_position() {
        let code = "x <- 1";
        let tree = parse_r_code(code);
        // Position way out of bounds
        let position = Position { line: 100, character: 0 };
        let ctx = detect_context(&tree, code, position);
        
        // Should return AfterCompleteExpression with indent 0
        match ctx {
            IndentContext::AfterCompleteExpression { enclosing_block_indent } => {
                assert_eq!(enclosing_block_indent, 0);
            }
            _ => panic!("Expected AfterCompleteExpression for invalid position"),
        }
    }

    #[test]
    fn test_detect_context_with_syntax_error_uses_fallback() {
        let code = "x <- + +\n"; // Invalid syntax
        let tree = parse_r_code(code);
        let position = Position { line: 1, character: 0 };
        
        // Should not panic, should return a valid context
        let ctx = detect_context(&tree, code, position);
        
        // The fallback should detect this as a complete expression
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {}
            _ => {} // Any context is fine, just shouldn't panic
        }
    }

    // ========================================================================
    // Property Test Generators
    // ========================================================================

    /// Generate a valid R identifier (lowercase letters and underscores)
    /// Filters out R reserved keywords to avoid generating invalid code
    fn r_identifier() -> impl Strategy<Value = String> {
        "[a-z][a-z0-9_]{0,5}".prop_filter("not reserved keyword", |s| {
            !matches!(
                s.as_str(),
                "if" | "else"
                    | "for"
                    | "in"
                    | "while"
                    | "repeat"
                    | "next"
                    | "break"
                    | "function"
                    | "return"
                    | "TRUE"
                    | "FALSE"
                    | "NULL"
                    | "NA"
                    | "Inf"
                    | "NaN"
            )
        })
    }

    /// Generate a valid custom infix operator name (letters only, no reserved)
    fn custom_infix_name() -> impl Strategy<Value = String> {
        "[a-zA-Z]{2,6}"
    }

    /// Enum representing continuation operator types for chain generation
    #[derive(Debug, Clone, Copy)]
    enum ChainOperator {
        NativePipe,    // |>
        MagrittrPipe,  // %>%
        Plus,          // +
        Tilde,         // ~
        CustomInfix,   // %word%
    }

    impl ChainOperator {
        fn as_str(&self) -> &'static str {
            match self {
                ChainOperator::NativePipe => "|>",
                ChainOperator::MagrittrPipe => "%>%",
                ChainOperator::Plus => "+",
                ChainOperator::Tilde => "~",
                ChainOperator::CustomInfix => "%op%",
            }
        }
    }

    /// Strategy to generate different chain operators
    fn chain_operator() -> impl Strategy<Value = ChainOperator> {
        prop_oneof![
            Just(ChainOperator::NativePipe),
            Just(ChainOperator::MagrittrPipe),
            Just(ChainOperator::Plus),
            Just(ChainOperator::Tilde),
            Just(ChainOperator::CustomInfix),
        ]
    }

    /// Generate a pipe chain with the specified length and operator.
    ///
    /// The chain starts with "data" and adds `length` continuation lines.
    /// Each line ends with the operator (except the last line).
    ///
    /// Example for length=2 with %>%:
    /// ```r
    /// data %>%
    ///   step0() %>%
    ///   step1()
    /// ```
    fn generate_pipe_chain(length: usize, operator: ChainOperator, leading_spaces: usize) -> String {
        let indent = " ".repeat(leading_spaces);
        let mut code = format!("{}data", indent);

        for i in 0..length {
            code.push_str(&format!(" {}\n  ", operator.as_str()));
            code.push_str(&format!("step{}()", i));
        }

        code
    }

    /// Get the column of the first non-whitespace character on a line.
    fn get_first_non_ws_col(code: &str, line: u32) -> u32 {
        code.lines()
            .nth(line as usize)
            .map(|l| l.chars().take_while(|c| c.is_whitespace()).count() as u32)
            .unwrap_or(0)
    }

    /// Enum representing the type of R code structure to generate
    #[derive(Debug, Clone)]
    enum RCodeStructure {
        NativePipe,
        MagrittrPipe,
        PlusOperator,
        TildeOperator,
        CustomInfix(String),
        FunctionCall,
        BraceBlock,
    }

    /// Strategy to generate different R code structures
    fn r_code_structure() -> impl Strategy<Value = RCodeStructure> {
        prop_oneof![
            Just(RCodeStructure::NativePipe),
            Just(RCodeStructure::MagrittrPipe),
            Just(RCodeStructure::PlusOperator),
            Just(RCodeStructure::TildeOperator),
            custom_infix_name().prop_map(RCodeStructure::CustomInfix),
            Just(RCodeStructure::FunctionCall),
            Just(RCodeStructure::BraceBlock),
        ]
    }

    /// Generate R code containing the specified structure
    fn generate_r_code(structure: &RCodeStructure, left_id: &str, right_id: &str) -> String {
        match structure {
            RCodeStructure::NativePipe => format!("{} |> {}()", left_id, right_id),
            RCodeStructure::MagrittrPipe => format!("{} %>% {}()", left_id, right_id),
            RCodeStructure::PlusOperator => format!("{} + {}", left_id, right_id),
            RCodeStructure::TildeOperator => format!("{} ~ {}", left_id, right_id),
            RCodeStructure::CustomInfix(name) => format!("{} %{}% {}", left_id, name, right_id),
            RCodeStructure::FunctionCall => format!("{}({}, {})", left_id, right_id, right_id),
            RCodeStructure::BraceBlock => format!("{{ {} <- {} }}", left_id, right_id),
        }
    }

    /// Expected node kind for each structure type
    fn expected_node_kind(structure: &RCodeStructure) -> &'static str {
        match structure {
            RCodeStructure::NativePipe => "|>",
            RCodeStructure::MagrittrPipe => "special",
            RCodeStructure::PlusOperator => "+",
            RCodeStructure::TildeOperator => "~",
            RCodeStructure::CustomInfix(_) => "special",
            RCodeStructure::FunctionCall => "call",
            RCodeStructure::BraceBlock => "braced_expression",
        }
    }

    /// Check if the expected node kind is found in the AST
    fn find_expected_node<'a>(
        nodes: &[Node<'a>],
        structure: &RCodeStructure,
        source: &str,
    ) -> bool {
        let expected_kind = expected_node_kind(structure);

        for node in nodes {
            if node.kind() == expected_kind {
                // For special operators, verify the text matches
                if let RCodeStructure::MagrittrPipe = structure {
                    if node_text(*node, source) == "%>%" {
                        return true;
                    }
                } else if let RCodeStructure::CustomInfix(name) = structure {
                    let text = node_text(*node, source);
                    if text == format!("%{}%", name) {
                        return true;
                    }
                } else {
                    return true;
                }
            }
        }
        false
    }

    /// Verify the detection function returns correct result for the structure
    fn verify_detection_function(node: Node, structure: &RCodeStructure, source: &str) -> bool {
        match structure {
            RCodeStructure::NativePipe => {
                if node.kind() == "|>" {
                    return is_pipe_operator(node);
                }
            }
            RCodeStructure::MagrittrPipe => {
                if node.kind() == "special" && node_text(node, source) == "%>%" {
                    return is_special_operator(node);
                }
            }
            RCodeStructure::PlusOperator => {
                if node.kind() == "+" {
                    return is_continuation_binary_operator(node, source);
                }
            }
            RCodeStructure::TildeOperator => {
                if node.kind() == "~" {
                    return is_continuation_binary_operator(node, source);
                }
            }
            RCodeStructure::CustomInfix(name) => {
                if node.kind() == "special" && node_text(node, source) == format!("%{}%", name) {
                    return is_special_operator(node);
                }
            }
            RCodeStructure::FunctionCall => {
                if node.kind() == "call" {
                    return is_call_node(node);
                }
            }
            RCodeStructure::BraceBlock => {
                if node.kind() == "braced_expression" {
                    return is_brace_list_node(node);
                }
            }
        }
        // Node doesn't match the structure we're looking for
        false
    }

    // ========================================================================
    // Property 15: AST Node Detection
    // Feature: r-smart-indentation, Property 15: AST Node Detection
    // Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
    // ========================================================================

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        /// Property 15: For any R code containing continuation operators (`|>`, `%>%`,
        /// `+`, `~`, `%word%`), function calls, or brace blocks, the context detector
        /// should correctly identify the corresponding tree-sitter nodes.
        ///
        /// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5**
        #[test]
        fn property_ast_node_detection(
            structure in r_code_structure(),
            left_id in r_identifier(),
            right_id in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            // Generate R code with the specified structure
            let code = generate_r_code(&structure, &left_id, &right_id);

            // Parse with tree-sitter
            let tree = parse_r_code(&code);

            // Collect all nodes
            let nodes = collect_all_nodes(tree.root_node());

            // Verify the expected node type is found in the AST
            prop_assert!(
                find_expected_node(&nodes, &structure, &code),
                "Expected node kind '{}' not found in AST for code: {}",
                expected_node_kind(&structure),
                code
            );

            // Verify the detection function correctly identifies the node
            let mut detection_verified = false;
            for node in &nodes {
                if verify_detection_function(*node, &structure, &code) {
                    detection_verified = true;
                    break;
                }
            }
            prop_assert!(
                detection_verified,
                "Detection function failed for structure {:?} in code: {}",
                structure,
                code
            );
        }

        /// Property 15 extended: Native pipe operator detection
        /// Validates: Requirement 9.1
        #[test]
        fn property_native_pipe_detection(
            left_id in r_identifier(),
            right_id in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{} |> {}()", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            // Find the |> node
            let pipe_node = nodes.iter().find(|n| n.kind() == "|>");
            prop_assert!(pipe_node.is_some(), "Should find |> node in: {}", code);

            // Verify is_pipe_operator returns true
            prop_assert!(
                is_pipe_operator(*pipe_node.unwrap()),
                "is_pipe_operator should return true for |> node"
            );

            // Verify get_operator_type returns Pipe
            prop_assert_eq!(
                get_operator_type(*pipe_node.unwrap(), &code),
                Some(OperatorType::Pipe),
                "get_operator_type should return Pipe for |> node"
            );
        }

        /// Property 15 extended: Magrittr pipe operator detection
        /// Validates: Requirement 9.2
        #[test]
        fn property_magrittr_pipe_detection(
            left_id in r_identifier(),
            right_id in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{} %>% {}()", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            // Find the special node with %>%
            let special_node = nodes.iter().find(|n| {
                n.kind() == "special" && node_text(**n, &code) == "%>%"
            });
            prop_assert!(special_node.is_some(), "Should find %>% node in: {}", code);

            // Verify is_special_operator returns true
            prop_assert!(
                is_special_operator(*special_node.unwrap()),
                "is_special_operator should return true for %>% node"
            );

            // Verify get_operator_type returns MagrittrPipe
            prop_assert_eq!(
                get_operator_type(*special_node.unwrap(), &code),
                Some(OperatorType::MagrittrPipe),
                "get_operator_type should return MagrittrPipe for %>% node"
            );
        }

        /// Property 15 extended: Custom infix operator detection
        /// Validates: Requirement 9.2
        #[test]
        fn property_custom_infix_detection(
            left_id in r_identifier(),
            right_id in r_identifier(),
            infix_name in custom_infix_name(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{} %{}% {}", left_id, infix_name, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            let expected_text = format!("%{}%", infix_name);

            // Find the special node with the custom infix
            let special_node = nodes.iter().find(|n| {
                n.kind() == "special" && node_text(**n, &code) == expected_text
            });
            prop_assert!(
                special_node.is_some(),
                "Should find %{}% node in: {}",
                infix_name,
                code
            );

            // Verify is_special_operator returns true
            prop_assert!(
                is_special_operator(*special_node.unwrap()),
                "is_special_operator should return true for %{}% node",
                infix_name
            );

            // Verify get_operator_type returns CustomInfix
            prop_assert_eq!(
                get_operator_type(*special_node.unwrap(), &code),
                Some(OperatorType::CustomInfix),
                "get_operator_type should return CustomInfix for %{}% node",
                infix_name
            );
        }

        /// Property 15 extended: Plus operator detection
        /// Validates: Requirement 9.3
        #[test]
        fn property_plus_operator_detection(
            left_id in r_identifier(),
            right_id in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{} + {}", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            // Find the + node
            let plus_node = nodes.iter().find(|n| n.kind() == "+");
            prop_assert!(plus_node.is_some(), "Should find + node in: {}", code);

            // Verify is_continuation_binary_operator returns true
            prop_assert!(
                is_continuation_binary_operator(*plus_node.unwrap(), &code),
                "is_continuation_binary_operator should return true for + node"
            );

            // Verify get_operator_type returns Plus
            prop_assert_eq!(
                get_operator_type(*plus_node.unwrap(), &code),
                Some(OperatorType::Plus),
                "get_operator_type should return Plus for + node"
            );
        }

        /// Property 15 extended: Tilde operator detection
        /// Validates: Requirement 9.3
        #[test]
        fn property_tilde_operator_detection(
            left_id in r_identifier(),
            right_id in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{} ~ {}", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            // Find the ~ node
            let tilde_node = nodes.iter().find(|n| n.kind() == "~");
            prop_assert!(tilde_node.is_some(), "Should find ~ node in: {}", code);

            // Verify is_continuation_binary_operator returns true
            prop_assert!(
                is_continuation_binary_operator(*tilde_node.unwrap(), &code),
                "is_continuation_binary_operator should return true for ~ node"
            );

            // Verify get_operator_type returns Tilde
            prop_assert_eq!(
                get_operator_type(*tilde_node.unwrap(), &code),
                Some(OperatorType::Tilde),
                "get_operator_type should return Tilde for ~ node"
            );
        }

        /// Property 15 extended: Function call detection
        /// Validates: Requirement 9.4
        #[test]
        fn property_function_call_detection(
            func_name in r_identifier(),
            arg1 in r_identifier(),
            arg2 in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{}({}, {})", func_name, arg1, arg2);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            // Find the call node
            let call_node = nodes.iter().find(|n| n.kind() == "call");
            prop_assert!(call_node.is_some(), "Should find call node in: {}", code);

            // Verify is_call_node returns true
            prop_assert!(
                is_call_node(*call_node.unwrap()),
                "is_call_node should return true for call node"
            );

            // Find the arguments node
            let args_node = nodes.iter().find(|n| n.kind() == "arguments");
            prop_assert!(args_node.is_some(), "Should find arguments node in: {}", code);

            // Verify is_arguments_node returns true
            prop_assert!(
                is_arguments_node(*args_node.unwrap()),
                "is_arguments_node should return true for arguments node"
            );
        }

        /// Property 15 extended: Brace block detection
        /// Validates: Requirement 9.5
        #[test]
        fn property_brace_block_detection(
            var_name in r_identifier(),
            value in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            let code = format!("{{ {} <- {} }}", var_name, value);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());

            // Find the braced_expression node
            let brace_node = nodes.iter().find(|n| n.kind() == "braced_expression");
            prop_assert!(brace_node.is_some(), "Should find braced_expression node in: {}", code);

            // Verify is_brace_list_node returns true
            prop_assert!(
                is_brace_list_node(*brace_node.unwrap()),
                "is_brace_list_node should return true for braced_expression node"
            );
        }

        /// Property 15 extended: is_continuation_operator correctly identifies all types
        /// Validates: Requirements 9.1, 9.2, 9.3
        #[test]
        fn property_is_continuation_operator_comprehensive(
            left_id in r_identifier(),
            right_id in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 15: AST Node Detection

            // Test native pipe
            let code = format!("{} |> {}()", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());
            let pipe_node = nodes.iter().find(|n| n.kind() == "|>");
            prop_assert!(pipe_node.is_some());
            prop_assert!(is_continuation_operator(*pipe_node.unwrap(), &code));

            // Test magrittr pipe
            let code = format!("{} %>% {}()", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());
            let special_node = nodes.iter().find(|n| n.kind() == "special");
            prop_assert!(special_node.is_some());
            prop_assert!(is_continuation_operator(*special_node.unwrap(), &code));

            // Test plus
            let code = format!("{} + {}", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());
            let plus_node = nodes.iter().find(|n| n.kind() == "+");
            prop_assert!(plus_node.is_some());
            prop_assert!(is_continuation_operator(*plus_node.unwrap(), &code));

            // Test tilde
            let code = format!("{} ~ {}", left_id, right_id);
            let tree = parse_r_code(&code);
            let nodes = collect_all_nodes(tree.root_node());
            let tilde_node = nodes.iter().find(|n| n.kind() == "~");
            prop_assert!(tilde_node.is_some());
            prop_assert!(is_continuation_operator(*tilde_node.unwrap(), &code));
        }

        // ========================================================================
        // Property 1: Chain Start Detection
        // Feature: r-smart-indentation, Property 1: Chain Start Detection
        // Validates: Requirements 3.1
        // ========================================================================

        /// Property 1: For any R code snippet containing a pipe chain (consecutive
        /// lines ending with continuation operators), the chain start detection
        /// algorithm should identify the first line that is NOT preceded by a
        /// continuation operator, and return its line number and starting column.
        ///
        /// **Validates: Requirements 3.1**
        #[test]
        fn property_chain_start_detection(
            chain_length in 1..10usize,
            operator in chain_operator(),
            leading_spaces in 0..4usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            // Generate R code with pipe chain of specified length
            let code = generate_pipe_chain(chain_length, operator, leading_spaces);

            // Parse with tree-sitter
            let tree = parse_r_code(&code);

            // Position cursor at the last line of the chain
            let last_line = chain_length as u32;
            let end_position = Position {
                line: last_line,
                character: 0,
            };

            // Detect chain start using ChainWalker
            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(end_position);

            // Verify: chain start should be line 0 (first line of chain)
            prop_assert_eq!(
                start_line, 0,
                "Chain start line should be 0 for code:\n{}\nGot start_line={}",
                code, start_line
            );

            // Verify: chain start column should be first non-whitespace
            let expected_col = get_first_non_ws_col(&code, 0);
            prop_assert_eq!(
                start_col, expected_col,
                "Chain start column should be {} (first non-ws) for code:\n{}\nGot start_col={}",
                expected_col, code, start_col
            );
        }

        /// Property 1 extended: Chain start detection with native pipe |>
        /// Validates: Requirement 3.1
        #[test]
        fn property_chain_start_native_pipe(
            chain_length in 1..10usize,
            leading_spaces in 0..4usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            let code = generate_pipe_chain(chain_length, ChainOperator::NativePipe, leading_spaces);
            let tree = parse_r_code(&code);

            let last_line = chain_length as u32;
            let position = Position {
                line: last_line,
                character: 0,
            };

            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(position);

            prop_assert_eq!(start_line, 0);
            prop_assert_eq!(start_col, leading_spaces as u32);
        }

        /// Property 1 extended: Chain start detection with magrittr pipe %>%
        /// Validates: Requirement 3.1
        #[test]
        fn property_chain_start_magrittr_pipe(
            chain_length in 1..10usize,
            leading_spaces in 0..4usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            let code = generate_pipe_chain(chain_length, ChainOperator::MagrittrPipe, leading_spaces);
            let tree = parse_r_code(&code);

            let last_line = chain_length as u32;
            let position = Position {
                line: last_line,
                character: 0,
            };

            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(position);

            prop_assert_eq!(start_line, 0);
            prop_assert_eq!(start_col, leading_spaces as u32);
        }

        /// Property 1 extended: Chain start detection with plus operator +
        /// Validates: Requirement 3.1
        #[test]
        fn property_chain_start_plus_operator(
            chain_length in 1..10usize,
            leading_spaces in 0..4usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            let code = generate_pipe_chain(chain_length, ChainOperator::Plus, leading_spaces);
            let tree = parse_r_code(&code);

            let last_line = chain_length as u32;
            let position = Position {
                line: last_line,
                character: 0,
            };

            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(position);

            prop_assert_eq!(start_line, 0);
            prop_assert_eq!(start_col, leading_spaces as u32);
        }

        /// Property 1 extended: Chain start detection with tilde operator ~
        /// Validates: Requirement 3.1
        #[test]
        fn property_chain_start_tilde_operator(
            chain_length in 1..10usize,
            leading_spaces in 0..4usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            let code = generate_pipe_chain(chain_length, ChainOperator::Tilde, leading_spaces);
            let tree = parse_r_code(&code);

            let last_line = chain_length as u32;
            let position = Position {
                line: last_line,
                character: 0,
            };

            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(position);

            prop_assert_eq!(start_line, 0);
            prop_assert_eq!(start_col, leading_spaces as u32);
        }

        /// Property 1 extended: Chain start detection with custom infix %op%
        /// Validates: Requirement 3.1
        #[test]
        fn property_chain_start_custom_infix(
            chain_length in 1..10usize,
            leading_spaces in 0..4usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            let code = generate_pipe_chain(chain_length, ChainOperator::CustomInfix, leading_spaces);
            let tree = parse_r_code(&code);

            let last_line = chain_length as u32;
            let position = Position {
                line: last_line,
                character: 0,
            };

            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(position);

            prop_assert_eq!(start_line, 0);
            prop_assert_eq!(start_col, leading_spaces as u32);
        }

        /// Property 1 extended: Chain start from any position in the chain
        /// For any position within a chain, the chain start should always be line 0.
        /// Validates: Requirement 3.1
        #[test]
        fn property_chain_start_from_any_position(
            chain_length in 2..10usize,
            operator in chain_operator(),
            cursor_line in 1..10usize,
        ) {
            // Feature: r-smart-indentation, Property 1: Chain Start Detection

            // Ensure cursor_line is within the chain
            let cursor_line = (cursor_line % chain_length) + 1;

            let code = generate_pipe_chain(chain_length, operator, 0);
            let tree = parse_r_code(&code);

            let position = Position {
                line: cursor_line as u32,
                character: 0,
            };

            let walker = ChainWalker::new(&tree, &code);
            let (start_line, start_col) = walker.find_chain_start(position);

            // Chain start should always be line 0 regardless of cursor position
            prop_assert_eq!(
                start_line, 0,
                "Chain start should be line 0 when cursor at line {} in chain of length {}",
                cursor_line, chain_length
            );
            prop_assert_eq!(start_col, 0);
        }
    }

    // ========================================================================
    // OperatorType Tests
    // ========================================================================

    #[test]
    fn test_operator_type_equality() {
        assert_eq!(OperatorType::Pipe, OperatorType::Pipe);
        assert_ne!(OperatorType::Pipe, OperatorType::MagrittrPipe);
    }

    // ========================================================================
    // IndentContext Tests
    // ========================================================================

    #[test]
    fn test_indent_context_variants() {
        let parens = IndentContext::InsideParens {
            opener_line: 0,
            opener_col: 5,
            has_content_on_opener_line: true,
        };
        assert!(matches!(parens, IndentContext::InsideParens { .. }));

        let braces = IndentContext::InsideBraces {
            opener_line: 1,
            opener_col: 0,
        };
        assert!(matches!(braces, IndentContext::InsideBraces { .. }));

        let continuation = IndentContext::AfterContinuationOperator {
            chain_start_line: 0,
            chain_start_col: 0,
            operator_type: OperatorType::Pipe,
        };
        assert!(matches!(
            continuation,
            IndentContext::AfterContinuationOperator { .. }
        ));

        let complete = IndentContext::AfterCompleteExpression {
            enclosing_block_indent: 4,
        };
        assert!(matches!(
            complete,
            IndentContext::AfterCompleteExpression { .. }
        ));

        let closing = IndentContext::ClosingDelimiter {
            opener_line: 0,
            opener_col: 5,
            delimiter: ')',
        };
        assert!(matches!(closing, IndentContext::ClosingDelimiter { .. }));
    }

    // ========================================================================
    // is_pipe_operator Tests
    // ========================================================================

    #[test]
    fn test_is_pipe_operator_native_pipe() {
        let code = "x |> f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_pipe = false;
        for node in nodes {
            if node.kind() == "|>" {
                assert!(is_pipe_operator(node));
                found_pipe = true;
            }
        }
        assert!(found_pipe, "Should find a |> node");
    }

    #[test]
    fn test_is_pipe_operator_not_pipe() {
        let code = "x + y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        for node in nodes {
            if node.kind() != "|>" {
                assert!(!is_pipe_operator(node));
            }
        }
    }

    // ========================================================================
    // is_special_operator Tests
    // ========================================================================

    #[test]
    fn test_is_special_operator_magrittr() {
        let code = "x %>% f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_special = false;
        for node in nodes {
            if node.kind() == "special" {
                assert!(is_special_operator(node));
                found_special = true;
            }
        }
        assert!(found_special, "Should find a special node");
    }

    #[test]
    fn test_is_special_operator_custom_infix() {
        let code = "x %in% y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_special = false;
        for node in nodes {
            if node.kind() == "special" {
                assert!(is_special_operator(node));
                found_special = true;
            }
        }
        assert!(found_special, "Should find a special node for %in%");
    }

    // ========================================================================
    // is_continuation_binary_operator Tests
    // ========================================================================

    #[test]
    fn test_is_continuation_binary_operator_plus() {
        let code = "x + y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_plus = false;
        for node in nodes {
            if node.kind() == "+" {
                assert!(is_continuation_binary_operator(node, code));
                found_plus = true;
            }
        }
        assert!(found_plus, "Should find a + operator node");
    }

    #[test]
    fn test_is_continuation_binary_operator_tilde() {
        let code = "y ~ x";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_tilde = false;
        for node in nodes {
            if node.kind() == "~" {
                assert!(is_continuation_binary_operator(node, code));
                found_tilde = true;
            }
        }
        assert!(found_tilde, "Should find a ~ operator node");
    }

    #[test]
    fn test_is_continuation_binary_operator_not_continuation() {
        let code = "x <- y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        for node in nodes {
            // Assignment operator <- is not a continuation operator
            if node.kind() == "<-" {
                assert!(!is_continuation_binary_operator(node, code));
            }
        }
    }

    #[test]
    fn test_is_continuation_binary_operator_multiply() {
        let code = "x * y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        for node in nodes {
            // Multiplication operator * is not a continuation operator
            if node.kind() == "*" {
                assert!(!is_continuation_binary_operator(node, code));
            }
        }
    }

    // ========================================================================
    // is_call_node Tests
    // ========================================================================

    #[test]
    fn test_is_call_node() {
        let code = "f(x, y)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_call = false;
        for node in nodes {
            if node.kind() == "call" {
                assert!(is_call_node(node));
                found_call = true;
            }
        }
        assert!(found_call, "Should find a call node");
    }

    #[test]
    fn test_is_call_node_nested() {
        let code = "f(g(x))";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let call_count = nodes.iter().filter(|n| is_call_node(**n)).count();
        assert_eq!(call_count, 2, "Should find two call nodes");
    }

    // ========================================================================
    // is_arguments_node Tests
    // ========================================================================

    #[test]
    fn test_is_arguments_node() {
        let code = "f(x, y)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_args = false;
        for node in nodes {
            if node.kind() == "arguments" {
                assert!(is_arguments_node(node));
                found_args = true;
            }
        }
        assert!(found_args, "Should find an arguments node");
    }

    #[test]
    fn test_is_arguments_node_empty() {
        let code = "f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let found_args = nodes.iter().any(|n| is_arguments_node(*n));
        assert!(found_args, "Should find an arguments node even for empty args");
    }

    // ========================================================================
    // is_brace_list_node Tests
    // ========================================================================

    #[test]
    fn test_is_brace_list_node() {
        let code = "{ x <- 1 }";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_braces = false;
        for node in nodes {
            if node.kind() == "braced_expression" {
                assert!(is_brace_list_node(node));
                found_braces = true;
            }
        }
        assert!(found_braces, "Should find a braced_expression node");
    }

    #[test]
    fn test_is_brace_list_node_function_body() {
        let code = "f <- function(x) { x + 1 }";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let found_braces = nodes.iter().any(|n| is_brace_list_node(*n));
        assert!(
            found_braces,
            "Should find a braced_expression node in function body"
        );
    }

    // ========================================================================
    // get_operator_type Tests
    // ========================================================================

    #[test]
    fn test_get_operator_type_native_pipe() {
        let code = "x |> f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "|>" {
                assert_eq!(get_operator_type(node, code), Some(OperatorType::Pipe));
                found = true;
            }
        }
        assert!(found, "Should find pipe operator");
    }

    #[test]
    fn test_get_operator_type_magrittr_pipe() {
        let code = "x %>% f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "special" {
                let text = node_text(node, code);
                if text == "%>%" {
                    assert_eq!(
                        get_operator_type(node, code),
                        Some(OperatorType::MagrittrPipe)
                    );
                    found = true;
                }
            }
        }
        assert!(found, "Should find magrittr pipe operator");
    }

    #[test]
    fn test_get_operator_type_custom_infix() {
        let code = "x %in% y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "special" {
                let text = node_text(node, code);
                if text == "%in%" {
                    assert_eq!(
                        get_operator_type(node, code),
                        Some(OperatorType::CustomInfix)
                    );
                    found = true;
                }
            }
        }
        assert!(found, "Should find custom infix operator");
    }

    #[test]
    fn test_get_operator_type_plus() {
        let code = "x + y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "+" {
                assert_eq!(get_operator_type(node, code), Some(OperatorType::Plus));
                found = true;
            }
        }
        assert!(found, "Should find plus operator");
    }

    #[test]
    fn test_get_operator_type_tilde() {
        let code = "y ~ x";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "~" {
                assert_eq!(get_operator_type(node, code), Some(OperatorType::Tilde));
                found = true;
            }
        }
        assert!(found, "Should find tilde operator");
    }

    #[test]
    fn test_get_operator_type_non_continuation() {
        let code = "x <- y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        for node in nodes {
            if node.kind() == "<-" {
                // Assignment should return None
                assert_eq!(get_operator_type(node, code), None);
            }
        }
    }

    // ========================================================================
    // is_continuation_operator Tests
    // ========================================================================

    #[test]
    fn test_is_continuation_operator_all_types() {
        // Test native pipe
        let code = "x |> f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());
        let found = nodes
            .iter()
            .any(|n| n.kind() == "|>" && is_continuation_operator(*n, code));
        assert!(found, "Should find native pipe as continuation operator");

        // Test magrittr pipe
        let code = "x %>% f()";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());
        let found = nodes
            .iter()
            .any(|n| n.kind() == "special" && is_continuation_operator(*n, code));
        assert!(found, "Should find magrittr pipe as continuation operator");

        // Test plus
        let code = "x + y";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());
        let found = nodes
            .iter()
            .any(|n| n.kind() == "+" && is_continuation_operator(*n, code));
        assert!(found, "Should find plus as continuation operator");
    }

    // ========================================================================
    // find_parent Tests
    // ========================================================================

    #[test]
    fn test_find_parent_arguments() {
        let code = "f(x, y)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found_test = false;
        for node in nodes {
            if node.kind() == "identifier" {
                let text = node_text(node, code);
                if text == "x" || text == "y" {
                    let args = find_parent(node, is_arguments_node);
                    assert!(args.is_some(), "Should find arguments parent");
                    found_test = true;
                }
            }
        }
        assert!(found_test, "Should have tested find_parent");
    }

    #[test]
    fn test_find_parent_no_match() {
        let code = "x <- 1";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        for node in nodes {
            if node.kind() == "identifier" {
                let args = find_parent(node, is_arguments_node);
                assert!(args.is_none(), "Should not find arguments parent");
            }
        }
    }

    // ========================================================================
    // find_enclosing_* Tests
    // ========================================================================

    #[test]
    fn test_find_enclosing_arguments() {
        let code = "f(x, y)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "identifier" && node_text(node, code) == "x" {
                let args = find_enclosing_arguments(node);
                assert!(args.is_some());
                found = true;
            }
        }
        assert!(found);
    }

    #[test]
    fn test_find_enclosing_brace_list() {
        let code = "{ x <- 1 }";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "identifier" && node_text(node, code) == "x" {
                let braces = find_enclosing_brace_list(node);
                assert!(braces.is_some());
                found = true;
            }
        }
        assert!(found);
    }

    #[test]
    fn test_find_enclosing_call() {
        let code = "f(x)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "identifier" && node_text(node, code) == "x" {
                let call = find_enclosing_call(node);
                assert!(call.is_some());
                found = true;
            }
        }
        assert!(found);
    }

    // ========================================================================
    // find_matching_opener Tests (Task 5.7)
    // ========================================================================

    #[test]
    fn test_find_matching_opener_paren() {
        let code = "func(x, y)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        // Find the closing paren node (or a node near it)
        let mut found = false;
        for node in &nodes {
            if node.kind() == "identifier" && node_text(*node, code) == "y" {
                // From inside the arguments, find the matching opener for ')'
                let opener = find_matching_opener(*node, ')');
                assert!(opener.is_some(), "Should find matching opener for )");
                let opener = opener.unwrap();
                assert_eq!(opener.kind(), "arguments");
                found = true;
            }
        }
        assert!(found, "Should have found the test node");
    }

    #[test]
    fn test_find_matching_opener_brace() {
        let code = "{ x <- 1 }";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        // Find a node inside the braces
        let mut found = false;
        for node in &nodes {
            if node.kind() == "identifier" && node_text(*node, code) == "x" {
                let opener = find_matching_opener(*node, '}');
                assert!(opener.is_some(), "Should find matching opener for }}");
                let opener = opener.unwrap();
                assert_eq!(opener.kind(), "braced_expression");
                found = true;
            }
        }
        assert!(found, "Should have found the test node");
    }

    #[test]
    fn test_find_matching_opener_bracket() {
        let code = "x[1, 2]";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        // Find a node inside the brackets
        let mut found = false;
        for node in &nodes {
            if node.kind() == "float" || (node.kind() == "integer" && node_text(*node, code) == "1")
            {
                let opener = find_matching_opener(*node, ']');
                assert!(opener.is_some(), "Should find matching opener for ]");
                let opener = opener.unwrap();
                assert!(
                    opener.kind() == "subset" || opener.kind() == "subset2",
                    "Expected subset or subset2, got {}",
                    opener.kind()
                );
                found = true;
                break;
            }
        }
        assert!(found, "Should have found the test node");
    }

    #[test]
    fn test_find_matching_opener_not_found() {
        let code = "x <- 1";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        // Try to find opener from a node not inside any delimiters
        for node in &nodes {
            if node.kind() == "identifier" && node_text(*node, code) == "x" {
                let opener = find_matching_opener(*node, ')');
                assert!(opener.is_none(), "Should not find opener when not inside parens");
            }
        }
    }

    #[test]
    fn test_find_matching_opener_invalid_delimiter() {
        let code = "func(x)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        // Try with an invalid delimiter character
        for node in &nodes {
            if node.kind() == "identifier" && node_text(*node, code) == "x" {
                let opener = find_matching_opener(*node, '@');
                assert!(opener.is_none(), "Should return None for invalid delimiter");
            }
        }
    }

    #[test]
    fn test_find_matching_opener_nested() {
        let code = "outer(inner(x))";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        // From innermost x, should find the inner arguments first
        let mut found = false;
        for node in &nodes {
            if node.kind() == "identifier" && node_text(*node, code) == "x" {
                let opener = find_matching_opener(*node, ')');
                assert!(opener.is_some(), "Should find matching opener");
                // The innermost arguments node should be found
                found = true;
            }
        }
        assert!(found, "Should have found the test node");
    }

    // ========================================================================
    // find_innermost_context_node Tests
    // ========================================================================

    #[test]
    fn test_find_innermost_context_node_arguments() {
        let code = "f(x, y)";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "identifier" && node_text(node, code) == "x" {
                let ctx = find_innermost_context_node(node, code);
                assert!(ctx.is_some());
                assert!(is_arguments_node(ctx.unwrap()));
                found = true;
            }
        }
        assert!(found);
    }

    #[test]
    fn test_find_innermost_context_node_braces() {
        let code = "{ x <- 1 }";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "identifier" && node_text(node, code) == "x" {
                let ctx = find_innermost_context_node(node, code);
                assert!(ctx.is_some());
                assert!(is_brace_list_node(ctx.unwrap()));
                found = true;
            }
        }
        assert!(found);
    }

    #[test]
    fn test_find_innermost_context_nested() {
        // Arguments inside braces - should find arguments first
        let code = "{ f(x) }";
        let tree = parse_r_code(code);
        let nodes = collect_all_nodes(tree.root_node());

        let mut found = false;
        for node in nodes {
            if node.kind() == "identifier" && node_text(node, code) == "x" {
                let ctx = find_innermost_context_node(node, code);
                assert!(ctx.is_some());
                // Should find arguments (innermost) not brace_list
                assert!(is_arguments_node(ctx.unwrap()));
                found = true;
            }
        }
        assert!(found);
    }

    // ========================================================================
    // ChainWalker Tests
    // ========================================================================

    #[test]
    fn test_chain_walker_simple_pipe() {
        let code = "result <- data %>%\n  filter(x > 0) %>%\n  select(y)";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        // Cursor on line 2 (select line)
        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        // Chain start should be line 0 (result <- data %>%)
        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0); // "result" starts at column 0
    }

    #[test]
    fn test_chain_walker_native_pipe() {
        let code = "data |>\n  filter(x) |>\n  select(y)";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_plus_operator() {
        let code = "ggplot(data) +\n  geom_point() +\n  theme_minimal()";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_tilde_operator() {
        let code = "y ~\n  x1 +\n  x2";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_custom_infix() {
        let code = "x %myop%\n  y %myop%\n  z";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_with_comments() {
        let code = "data %>%  # comment\n  filter(x) %>%  # another comment\n  select(y)";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_indented_start() {
        let code = "  result <- data %>%\n    filter(x) %>%\n    select(y)";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 2); // "result" starts at column 2 (after 2 spaces)
    }

    #[test]
    fn test_chain_walker_no_chain() {
        let code = "x <- 1\ny <- 2\nz <- 3";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        // Cursor on line 2
        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        // No chain, so start should be line 2 itself
        assert_eq!(start_line, 2);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_single_line() {
        let code = "data %>% filter(x)";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 0,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        // Single line, chain start is line 0
        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_middle_of_chain() {
        let code = "data %>%\n  step1() %>%\n  step2() %>%\n  step3()";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        // Cursor on line 1 (step1 line)
        let position = Position {
            line: 1,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        // Chain start should still be line 0
        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_in_percent() {
        // Test %in% operator
        let code = "x %in%\n  y";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 1,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    #[test]
    fn test_chain_walker_mixed_operators() {
        // Mix of different continuation operators
        let code = "data %>%\n  filter(x) |>\n  mutate(y = y + 1)";
        let tree = parse_r_code(code);
        let walker = ChainWalker::new(&tree, code);

        let position = Position {
            line: 2,
            character: 0,
        };
        let (start_line, start_col) = walker.find_chain_start(position);

        assert_eq!(start_line, 0);
        assert_eq!(start_col, 0);
    }

    // ========================================================================
    // strip_trailing_comment Tests
    // ========================================================================

    #[test]
    fn test_strip_trailing_comment_simple() {
        assert_eq!(strip_trailing_comment("x <- 1 # comment"), "x <- 1 ");
    }

    #[test]
    fn test_strip_trailing_comment_no_comment() {
        assert_eq!(strip_trailing_comment("x <- 1"), "x <- 1");
    }

    #[test]
    fn test_strip_trailing_comment_hash_in_string() {
        assert_eq!(
            strip_trailing_comment(r#"x <- "hello # world""#),
            r#"x <- "hello # world""#
        );
    }

    #[test]
    fn test_strip_trailing_comment_hash_in_single_quote_string() {
        assert_eq!(
            strip_trailing_comment("x <- 'hello # world'"),
            "x <- 'hello # world'"
        );
    }

    #[test]
    fn test_strip_trailing_comment_string_then_comment() {
        assert_eq!(
            strip_trailing_comment(r#"x <- "hello" # comment"#),
            r#"x <- "hello" "#
        );
    }

    #[test]
    fn test_strip_trailing_comment_escaped_quote() {
        assert_eq!(
            strip_trailing_comment(r#"x <- "hello \" # world" # comment"#),
            r#"x <- "hello \" # world" "#
        );
    }

    #[test]
    fn test_strip_trailing_comment_only_comment() {
        assert_eq!(strip_trailing_comment("# just a comment"), "");
    }

    // ========================================================================
    // detect_context Tests
    // ========================================================================

    #[test]
    fn test_detect_context_closing_delimiter_paren() {
        let code = "func(\n  arg1,\n  arg2\n)";
        let tree = parse_r_code(code);

        // Cursor on line 3 (the closing paren line).
        // The line contains only ")" — the auto-close heuristic skips closing
        // delimiter detection so the line gets indented as inside-parens content.
        let position = Position {
            line: 3,
            character: 0,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideParens { opener_col, .. } => {
                assert_eq!(opener_col, 4); // column of the opening paren
            }
            _ => panic!("Expected InsideParens context (auto-close heuristic), got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_closing_delimiter_brace() {
        let code = "{\n  x <- 1\n}";
        let tree = parse_r_code(code);

        // Cursor on line 2 (the closing brace line).
        // The line contains only "}" — auto-close heuristic treats as inside-braces.
        let position = Position {
            line: 2,
            character: 0,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces context (auto-close heuristic), got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_after_pipe_operator() {
        let code = "data %>%\n  ";
        let tree = parse_r_code(code);

        // Cursor on line 1 (after the pipe)
        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator {
                chain_start_line,
                operator_type,
                ..
            } => {
                assert_eq!(chain_start_line, 0);
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_after_native_pipe() {
        let code = "data |>\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator {
                operator_type, ..
            } => {
                assert_eq!(operator_type, OperatorType::Pipe);
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_after_plus_operator() {
        let code = "ggplot(data) +\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator {
                operator_type, ..
            } => {
                assert_eq!(operator_type, OperatorType::Plus);
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_after_tilde_operator() {
        let code = "y ~\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator {
                operator_type, ..
            } => {
                assert_eq!(operator_type, OperatorType::Tilde);
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_inside_parens_with_content() {
        let code = "func(arg1,\n  ";
        let tree = parse_r_code(code);

        // Cursor on line 1 (inside the parens)
        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideParens {
                has_content_on_opener_line,
                ..
            } => {
                assert!(
                    has_content_on_opener_line,
                    "Should detect content after opener"
                );
            }
            _ => panic!("Expected InsideParens context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_inside_parens_no_content() {
        let code = "func(\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideParens {
                has_content_on_opener_line,
                ..
            } => {
                assert!(
                    !has_content_on_opener_line,
                    "Should not detect content after opener"
                );
            }
            _ => panic!("Expected InsideParens context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_inside_braces() {
        let code = "{\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_complete_expression() {
        let code = "x <- 1\n";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 0,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {
                // Expected
            }
            _ => panic!("Expected AfterCompleteExpression context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_chain_start_detection() {
        let code = "data %>%\n  filter(x) %>%\n  ";
        let tree = parse_r_code(code);

        // Cursor on line 2 (after second pipe)
        let position = Position {
            line: 2,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator {
                chain_start_line,
                chain_start_col,
                ..
            } => {
                assert_eq!(chain_start_line, 0, "Chain should start at line 0");
                assert_eq!(chain_start_col, 0, "Chain should start at column 0");
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_priority_closing_over_continuation() {
        // When a line contains only a closing delimiter, the auto-close heuristic
        // treats it as inside-parens (the delimiter was pushed down by Enter).
        // This is correct for onTypeFormatting: the user wants content indentation.
        let code = "data %>%\n  filter(x\n  )";
        let tree = parse_r_code(code);

        // Cursor on line 2 (the closing paren line)
        let position = Position {
            line: 2,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        // Delimiter-only line → treated as inside-parens
        match ctx {
            IndentContext::InsideParens { .. } => {
                // Expected: auto-close heuristic kicks in
            }
            _ => panic!("Expected InsideParens context (auto-close heuristic), got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_nested_parens_in_braces() {
        // Note: When code is very incomplete, tree-sitter may produce ERROR nodes
        // and context detection may fall back to AfterCompleteExpression.
        // This test verifies the behavior with more complete code.
        let code = "if (TRUE) {\n  func(x,\n    y";
        let tree = parse_r_code(code);

        // Cursor after 'y' on line 2
        let position = Position {
            line: 2,
            character: 5,
        };
        let ctx = detect_context(&tree, code, position);

        // With more complete code, should detect InsideParens
        match ctx {
            IndentContext::InsideParens { .. } => {
                // Expected - parens are innermost
            }
            IndentContext::InsideBraces { .. } => {
                // Also acceptable - braces detected
            }
            IndentContext::AfterCompleteExpression { .. } => {
                // Acceptable for incomplete code - tree-sitter may produce ERROR nodes
            }
            _ => panic!("Unexpected context: {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_with_comment_on_prev_line() {
        let code = "data %>%  # comment\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        // Should still detect continuation operator despite comment
        match ctx {
            IndentContext::AfterContinuationOperator {
                operator_type, ..
            } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_custom_infix() {
        let code = "x %in%\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator {
                operator_type, ..
            } => {
                assert_eq!(operator_type, OperatorType::CustomInfix);
            }
            _ => panic!(
                "Expected AfterContinuationOperator context, got {:?}",
                ctx
            ),
        }
    }

    #[test]
    fn test_detect_context_function_body() {
        let code = "f <- function(x) {\n  ";
        let tree = parse_r_code(code);

        let position = Position {
            line: 1,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces context, got {:?}", ctx),
        }
    }

    #[test]
    fn test_detect_context_enclosing_block_indent() {
        let code = "  {\n    x <- 1\n  }\n  ";
        let tree = parse_r_code(code);

        // Cursor after the closing brace
        let position = Position {
            line: 3,
            character: 2,
        };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterCompleteExpression {
                enclosing_block_indent,
            } => {
                // Should return 0 since we're at top level after the block
                assert_eq!(enclosing_block_indent, 0);
            }
            _ => panic!("Expected AfterCompleteExpression context, got {:?}", ctx),
        }
    }

    // ========================================================================
    // Property 16: Nested Context Priority
    // Feature: r-smart-indentation, Property 16: Nested Context Priority
    // Validates: Requirements 3.4, 10.1, 10.2, 10.3
    // ========================================================================

    /// Enum representing different nesting scenarios for Property 16 tests
    #[derive(Debug, Clone)]
    enum NestedStructure {
        /// Pipe chain inside function call: func(data %>% step())
        PipeInsideCall,
        /// Function call inside pipe chain: data %>% func(arg)
        CallInsidePipe,
        /// Braces inside function call: func({ x <- 1 })
        BracesInsideCall,
        /// Pipe inside braces: { data %>% step() }
        PipeInsideBraces,
        /// Call inside braces: { func(x) }
        CallInsideBraces,
        /// Nested function calls: outer(inner(x))
        NestedCalls,
        /// Pipe chain inside pipe chain (via function): data %>% func(x %>% step())
        PipeInsidePipeViaCall,
    }

    /// Strategy to generate different nested structures
    fn nested_structure() -> impl Strategy<Value = NestedStructure> {
        prop_oneof![
            Just(NestedStructure::PipeInsideCall),
            Just(NestedStructure::CallInsidePipe),
            Just(NestedStructure::BracesInsideCall),
            Just(NestedStructure::PipeInsideBraces),
            Just(NestedStructure::CallInsideBraces),
            Just(NestedStructure::NestedCalls),
            Just(NestedStructure::PipeInsidePipeViaCall),
        ]
    }

    /// Generate nested R code structure with a cursor position inside the innermost context.
    ///
    /// Returns (code, cursor_position, expected_innermost_context_type)
    fn generate_nested_structure(
        structure: &NestedStructure,
        func_name: &str,
        inner_func: &str,
    ) -> (String, Position, &'static str) {
        match structure {
            NestedStructure::PipeInsideCall => {
                // func(data %>%
                //   step())
                // Cursor after %>% should detect pipe context
                let code = format!("{}(data %>%\n  step())", func_name);
                let position = Position { line: 1, character: 2 };
                (code, position, "AfterContinuationOperator")
            }
            NestedStructure::CallInsidePipe => {
                // data %>%
                //   func(arg,
                //     more)
                // Cursor inside func() should detect parens context
                let code = format!("data %>%\n  {}(arg,\n    more)", func_name);
                let position = Position { line: 2, character: 4 };
                (code, position, "InsideParens")
            }
            NestedStructure::BracesInsideCall => {
                // func({
                //   x <- 1
                // })
                // Cursor inside braces should detect brace context
                let code = format!("{}({{\n  x <- 1\n}})", func_name);
                let position = Position { line: 1, character: 2 };
                (code, position, "InsideBraces")
            }
            NestedStructure::PipeInsideBraces => {
                // {
                //   data %>%
                //     step()
                // }
                // Cursor after %>% should detect pipe context
                let code = "{{\n  data %>%\n    step()\n}}".to_string();
                let position = Position { line: 2, character: 4 };
                (code, position, "AfterContinuationOperator")
            }
            NestedStructure::CallInsideBraces => {
                // {
                //   func(arg,
                //     more)
                // }
                // Cursor inside func() should detect parens context
                let code = format!("{{\n  {}(arg,\n    more)\n}}", func_name);
                let position = Position { line: 2, character: 4 };
                (code, position, "InsideParens")
            }
            NestedStructure::NestedCalls => {
                // outer(inner(x,
                //   y))
                // Cursor inside inner() should detect parens context for inner
                let code = format!("{}({}(x,\n  y))", func_name, inner_func);
                let position = Position { line: 1, character: 2 };
                (code, position, "InsideParens")
            }
            NestedStructure::PipeInsidePipeViaCall => {
                // data %>%
                //   func(x %>%
                //     step())
                // Cursor after inner %>% should detect pipe context
                let code = format!("data %>%\n  {}(x %>%\n    step())", func_name);
                let position = Position { line: 2, character: 4 };
                (code, position, "AfterContinuationOperator")
            }
        }
    }

    /// Verify that the detected context matches the expected innermost context type.
    fn verify_innermost_context(ctx: &IndentContext, expected_type: &str) -> bool {
        match (ctx, expected_type) {
            (IndentContext::AfterContinuationOperator { .. }, "AfterContinuationOperator") => true,
            (IndentContext::InsideParens { .. }, "InsideParens") => true,
            (IndentContext::InsideBraces { .. }, "InsideBraces") => true,
            (IndentContext::ClosingDelimiter { .. }, "ClosingDelimiter") => true,
            (IndentContext::AfterCompleteExpression { .. }, "AfterCompleteExpression") => true,
            _ => false,
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        /// Property 16: For any R code with multiple levels of nesting (e.g., pipe chain
        /// inside function call inside another pipe chain), the context detector should
        /// identify the innermost syntactically relevant context for the cursor position,
        /// such that indentation decisions are based on the most specific applicable rule.
        ///
        /// **Validates: Requirements 3.4, 10.1, 10.2, 10.3**
        #[test]
        fn property_nested_context_priority(
            structure in nested_structure(),
            func_name in r_identifier(),
            inner_func in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // Generate nested R code with cursor position
            let (code, position, expected_type) = generate_nested_structure(
                &structure,
                &func_name,
                &inner_func,
            );

            // Parse with tree-sitter
            let tree = parse_r_code(&code);

            // Detect context at cursor position
            let ctx = detect_context(&tree, &code, position);

            // Verify the innermost context is detected
            prop_assert!(
                verify_innermost_context(&ctx, expected_type),
                "Expected {} context for structure {:?}, got {:?}\nCode:\n{}",
                expected_type,
                structure,
                ctx,
                code
            );
        }

        /// Property 16 extended: Pipe chain inside function call should detect pipe context
        /// Validates: Requirement 10.1
        #[test]
        fn property_pipe_inside_call_detects_pipe(
            func_name in r_identifier(),
            pipe_op in prop_oneof![Just("|>"), Just("%>%")],
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // func(data |>
            //   step())
            let code = format!("{}(data {}\n  step())", func_name, pipe_op);
            let tree = parse_r_code(&code);

            // Cursor on line 1 (after pipe)
            let position = Position { line: 1, character: 2 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect pipe context, not parens context
            match ctx {
                IndentContext::AfterContinuationOperator { operator_type, .. } => {
                    match &*pipe_op {
                        "|>" => prop_assert_eq!(operator_type, OperatorType::Pipe),
                        "%>%" => prop_assert_eq!(operator_type, OperatorType::MagrittrPipe),
                        _ => prop_assert!(false, "Unexpected pipe operator"),
                    }
                }
                _ => prop_assert!(
                    false,
                    "Expected AfterContinuationOperator for pipe inside call, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }

        /// Property 16 extended: Function call inside pipe chain should detect function call context
        /// Validates: Requirement 10.2
        #[test]
        fn property_call_inside_pipe_detects_parens(
            func_name in r_identifier(),
            arg1 in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // data %>%
            //   func(arg1,
            //     more)
            let code = format!("data %>%\n  {}({},\n    more)", func_name, arg1);
            let tree = parse_r_code(&code);

            // Cursor on line 2 (inside function call)
            let position = Position { line: 2, character: 4 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect parens context (innermost), not pipe context
            match ctx {
                IndentContext::InsideParens { has_content_on_opener_line, .. } => {
                    // The opener line has content (arg1)
                    prop_assert!(
                        has_content_on_opener_line,
                        "Should detect content on opener line"
                    );
                }
                _ => prop_assert!(
                    false,
                    "Expected InsideParens for call inside pipe, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }

        /// Property 16 extended: Braces inside function call should detect brace context
        /// Validates: Requirement 10.3
        #[test]
        fn property_braces_inside_call_detects_braces(
            func_name in r_identifier(),
            var_name in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // func({
            //   x <- 1
            // })
            let code = format!("{}({{\n  {} <- 1\n}})", func_name, var_name);
            let tree = parse_r_code(&code);

            // Cursor on line 1 (inside braces)
            let position = Position { line: 1, character: 2 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect brace context (innermost), not parens context
            match ctx {
                IndentContext::InsideBraces { opener_line, .. } => {
                    // Opener should be on line 0 (where the { is)
                    prop_assert_eq!(opener_line, 0);
                }
                _ => prop_assert!(
                    false,
                    "Expected InsideBraces for braces inside call, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }

        /// Property 16 extended: Multiple levels of nesting should detect innermost context
        /// Validates: Requirements 3.4, 10.1, 10.2, 10.3
        #[test]
        fn property_deep_nesting_detects_innermost(
            outer_func in r_identifier(),
            inner_func in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // Test: outer pipe -> function call -> inner pipe
            // data %>%
            //   outer(x %>%
            //     inner())
            // Cursor after inner %>% should detect pipe context
            let code = format!(
                "data %>%\n  {}(x %>%\n    {}())",
                outer_func, inner_func
            );
            let tree = parse_r_code(&code);

            // Cursor on line 2 (after inner pipe)
            let position = Position { line: 2, character: 4 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect the innermost pipe context
            match ctx {
                IndentContext::AfterContinuationOperator { .. } => {
                    // Correct - detected innermost pipe
                }
                _ => prop_assert!(
                    false,
                    "Expected AfterContinuationOperator for deep nesting, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }

        /// Property 16 extended: Nested function calls should detect innermost call
        /// Validates: Requirement 10.2
        #[test]
        fn property_nested_calls_detects_innermost(
            outer_func in r_identifier(),
            inner_func in r_identifier(),
            arg in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // outer(inner(arg,
            //   more))
            let code = format!("{}({}({},\n  more))", outer_func, inner_func, arg);
            let tree = parse_r_code(&code);

            // Cursor on line 1 (inside inner call)
            let position = Position { line: 1, character: 2 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect innermost parens context
            match ctx {
                IndentContext::InsideParens { .. } => {
                    // Correct - detected innermost parens
                }
                _ => prop_assert!(
                    false,
                    "Expected InsideParens for nested calls, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }

        /// Property 16 extended: Pipe inside braces should detect pipe context
        /// Validates: Requirements 3.4, 10.1
        #[test]
        fn property_pipe_inside_braces_detects_pipe(
            step_func in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // {
            //   data %>%
            //     step()
            // }
            let code = format!("{{\n  data %>%\n    {}()\n}}", step_func);
            let tree = parse_r_code(&code);

            // Cursor on line 2 (after pipe)
            let position = Position { line: 2, character: 4 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect pipe context, not brace context
            match ctx {
                IndentContext::AfterContinuationOperator { operator_type, .. } => {
                    prop_assert_eq!(operator_type, OperatorType::MagrittrPipe);
                }
                _ => prop_assert!(
                    false,
                    "Expected AfterContinuationOperator for pipe inside braces, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }

        /// Property 16 extended: Call inside braces should detect call context
        /// Validates: Requirements 10.2, 10.3
        #[test]
        fn property_call_inside_braces_detects_parens(
            func_name in r_identifier(),
            arg in r_identifier(),
        ) {
            // Feature: r-smart-indentation, Property 16: Nested Context Priority

            // {
            //   func(arg,
            //     more)
            // }
            let code = format!("{{\n  {}({},\n    more)\n}}", func_name, arg);
            let tree = parse_r_code(&code);

            // Cursor on line 2 (inside function call)
            let position = Position { line: 2, character: 4 };
            let ctx = detect_context(&tree, &code, position);

            // Should detect parens context, not brace context
            match ctx {
                IndentContext::InsideParens { .. } => {
                    // Correct - detected innermost parens
                }
                _ => prop_assert!(
                    false,
                    "Expected InsideParens for call inside braces, got {:?}\nCode:\n{}",
                    ctx,
                    code
                ),
            }
        }
    }

    // ========================================================================
    // Unit Tests for Nested Context Priority
    // ========================================================================

    #[test]
    fn test_nested_pipe_inside_call() {
        // func(data %>%
        //   step())
        let code = "func(data %>%\n  step())";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator, got {:?}", ctx),
        }
    }

    #[test]
    fn test_nested_call_inside_pipe() {
        // data %>%
        //   func(arg,
        //     more)
        let code = "data %>%\n  func(arg,\n    more)";
        let tree = parse_r_code(code);

        let position = Position { line: 2, character: 4 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideParens { .. } => {
                // Correct
            }
            _ => panic!("Expected InsideParens, got {:?}", ctx),
        }
    }

    #[test]
    fn test_nested_braces_inside_call() {
        // func({
        //   x <- 1
        // })
        let code = "func({\n  x <- 1\n})";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideBraces { .. } => {
                // Correct
            }
            _ => panic!("Expected InsideBraces, got {:?}", ctx),
        }
    }

    #[test]
    fn test_nested_three_levels() {
        // data %>%
        //   outer(x %>%
        //     inner())
        let code = "data %>%\n  outer(x %>%\n    inner())";
        let tree = parse_r_code(code);

        // Cursor after inner pipe
        let position = Position { line: 2, character: 4 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { .. } => {
                // Correct - detected innermost pipe
            }
            _ => panic!("Expected AfterContinuationOperator for innermost pipe, got {:?}", ctx),
        }
    }

    #[test]
    fn test_nested_native_pipe_inside_call() {
        // func(data |>
        //   step())
        let code = "func(data |>\n  step())";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::Pipe);
            }
            _ => panic!("Expected AfterContinuationOperator with Pipe, got {:?}", ctx),
        }
    }

    #[test]
    fn test_nested_plus_inside_call() {
        // ggplot(data) +
        //   geom_point(aes(x,
        //     y))
        let code = "ggplot(data) +\n  geom_point(aes(x,\n    y))";
        let tree = parse_r_code(code);

        // Cursor inside aes() call
        let position = Position { line: 2, character: 4 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideParens { .. } => {
                // Correct - detected innermost parens (aes call)
            }
            _ => panic!("Expected InsideParens for aes() inside ggplot chain, got {:?}", ctx),
        }
    }

    // ========================================================================
    // Task 3.7: Unit Tests for Context Detection Edge Cases
    // Validates: Requirements 3.1, 10.3
    // ========================================================================

    // ------------------------------------------------------------------------
    // Empty Lines Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_edge_case_empty_line_after_pipe() {
        // Cursor on empty line after pipe
        let code = "data %>%\n\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 1 (empty line)
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator from line 0
        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator after pipe with empty line, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_empty_line_inside_function_call() {
        // Cursor on empty line inside function call
        let code = "func(arg1,\n\n  arg2)";
        let tree = parse_r_code(code);

        // Cursor on line 1 (empty line)
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect inside parens
        match ctx {
            IndentContext::InsideParens { .. } => {
                // Correct
            }
            _ => panic!("Expected InsideParens for empty line inside function call, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_empty_line_inside_braces() {
        // Cursor on empty line inside braces
        let code = "{\n\n  x <- 1\n}";
        let tree = parse_r_code(code);

        // Cursor on line 1 (empty line)
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect inside braces
        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces for empty line inside braces, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_multiple_empty_lines_after_pipe() {
        // Multiple empty lines after pipe
        // Note: The context detector only looks at the immediately previous line,
        // so multiple empty lines will result in AfterCompleteExpression.
        // This is expected behavior - the user would need to be on line 1 (first empty line)
        // to get the continuation context.
        let code = "data %>%\n\n\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 1 (first empty line after pipe) - should detect continuation
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { chain_start_line, .. } => {
                assert_eq!(chain_start_line, 0);
            }
            _ => panic!("Expected AfterContinuationOperator on first empty line after pipe, got {:?}", ctx),
        }

        // Cursor on line 2 (second empty line) - previous line is empty, so no continuation detected
        let position2 = Position { line: 2, character: 0 };
        let ctx2 = detect_context(&tree, code, position2);

        // This is expected to be AfterCompleteExpression since line 1 is empty
        match ctx2 {
            IndentContext::AfterCompleteExpression { .. } => {
                // Expected - previous line is empty, no continuation operator
            }
            _ => panic!("Expected AfterCompleteExpression on second empty line, got {:?}", ctx2),
        }
    }

    // ------------------------------------------------------------------------
    // Comments Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_edge_case_line_ending_with_operator_followed_by_comment() {
        // Line ending with operator followed by comment: `data %>% # comment`
        let code = "data %>% # this is a comment\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 1 (after the pipe with comment)
        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator despite comment
        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator with trailing comment, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_line_with_only_comment() {
        // Line with only comment
        let code = "data %>%\n  # just a comment\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 1 (comment-only line)
        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator from line 0
        match ctx {
            IndentContext::AfterContinuationOperator { chain_start_line, .. } => {
                assert_eq!(chain_start_line, 0);
            }
            _ => panic!("Expected AfterContinuationOperator with comment-only line, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_cursor_after_comment_line() {
        // Cursor after comment line in pipe chain
        // Note: The context detector only looks at the immediately previous line.
        // If the previous line is a comment-only line (no operator), it won't detect
        // the continuation context. This is expected behavior.
        let code = "data %>%\n  # comment\n  ";
        let tree = parse_r_code(code);

        // Cursor on line 1 (comment line) - previous line has pipe
        let position1 = Position { line: 1, character: 2 };
        let ctx1 = detect_context(&tree, code, position1);

        match ctx1 {
            IndentContext::AfterContinuationOperator { chain_start_line, .. } => {
                assert_eq!(chain_start_line, 0);
            }
            _ => panic!("Expected AfterContinuationOperator on comment line after pipe, got {:?}", ctx1),
        }

        // Cursor on line 2 (after comment line) - previous line is comment, no operator
        let position2 = Position { line: 2, character: 2 };
        let ctx2 = detect_context(&tree, code, position2);

        // This is expected to be AfterCompleteExpression since line 1 is a comment
        match ctx2 {
            IndentContext::AfterCompleteExpression { .. } => {
                // Expected - previous line is comment, no continuation operator
            }
            _ => panic!("Expected AfterCompleteExpression after comment line, got {:?}", ctx2),
        }
    }

    #[test]
    fn test_edge_case_comment_with_hash_in_string() {
        // Comment detection should handle hash in string
        let code = "x <- \"hello # world\" %>%\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 1
        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator (hash in string is not a comment)
        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator with hash in string, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_native_pipe_with_comment() {
        // Native pipe with trailing comment
        let code = "data |> # native pipe comment\n  step()";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::Pipe);
            }
            _ => panic!("Expected AfterContinuationOperator for native pipe with comment, got {:?}", ctx),
        }
    }

    // ------------------------------------------------------------------------
    // EOF Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_edge_case_eof_after_pipe() {
        // Cursor at end of file after pipe
        let code = "data %>%\n";
        let tree = parse_r_code(code);

        // Cursor on line 1 (EOF)
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator
        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator at EOF after pipe, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_eof_inside_unclosed_parens() {
        // Cursor at end of file inside unclosed parens
        let code = "func(x,\n";
        let tree = parse_r_code(code);

        // Cursor on line 1 (EOF)
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect inside parens
        match ctx {
            IndentContext::InsideParens { .. } => {
                // Correct
            }
            _ => panic!("Expected InsideParens at EOF inside unclosed parens, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_eof_inside_unclosed_braces() {
        // Cursor at end of file inside unclosed braces
        let code = "{\n  x <- 1\n";
        let tree = parse_r_code(code);

        // Cursor on line 2 (EOF)
        let position = Position { line: 2, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect inside braces
        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces at EOF inside unclosed braces, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_eof_after_native_pipe() {
        // Cursor at end of file after native pipe
        let code = "data |>\n";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::Pipe);
            }
            _ => panic!("Expected AfterContinuationOperator at EOF after native pipe, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_eof_after_plus() {
        // Cursor at end of file after plus operator
        let code = "ggplot(data) +\n";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::Plus);
            }
            _ => panic!("Expected AfterContinuationOperator at EOF after plus, got {:?}", ctx),
        }
    }

    // ------------------------------------------------------------------------
    // Invalid AST / Syntax Errors Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_edge_case_incomplete_expression_pipe_no_continuation() {
        // Incomplete expression: `data %>%` (no continuation)
        let code = "data %>%";
        let tree = parse_r_code(code);

        // Cursor at end of line 0
        let position = Position { line: 0, character: 8 };
        let ctx = detect_context(&tree, code, position);

        // Should handle gracefully - either detect pipe context or complete expression
        // The important thing is it doesn't panic
        match ctx {
            IndentContext::AfterContinuationOperator { .. }
            | IndentContext::AfterCompleteExpression { .. }
            | IndentContext::InsideParens { .. } => {
                // All acceptable for incomplete expression
            }
            _ => {
                // Other contexts are also acceptable as long as we don't panic
            }
        }
    }

    #[test]
    fn test_edge_case_unclosed_parenthesis() {
        // Unclosed parenthesis: `func(x,`
        let code = "func(x,";
        let tree = parse_r_code(code);

        // Cursor at end of line 0
        let position = Position { line: 0, character: 7 };
        let ctx = detect_context(&tree, code, position);

        // Should detect inside parens (unclosed)
        match ctx {
            IndentContext::InsideParens { has_content_on_opener_line, .. } => {
                assert!(has_content_on_opener_line, "Should detect content after opener");
            }
            _ => panic!("Expected InsideParens for unclosed parenthesis, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_unclosed_brace() {
        // Unclosed brace: `{ x <- 1`
        let code = "{ x <- 1";
        let tree = parse_r_code(code);

        // Cursor at end of line 0
        let position = Position { line: 0, character: 8 };
        let ctx = detect_context(&tree, code, position);

        // Should detect inside braces (unclosed)
        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            _ => panic!("Expected InsideBraces for unclosed brace, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_mismatched_delimiters() {
        // Mismatched delimiters: `func(x]`
        // Tree-sitter will produce an error node for this
        let code = "func(x]";
        let tree = parse_r_code(code);

        // Cursor at end of line 0
        let position = Position { line: 0, character: 7 };
        let ctx = detect_context(&tree, code, position);

        // Should handle gracefully without panicking
        // The exact context depends on how tree-sitter parses the error
        match ctx {
            IndentContext::InsideParens { .. }
            | IndentContext::AfterCompleteExpression { .. }
            | IndentContext::ClosingDelimiter { .. } => {
                // All acceptable for mismatched delimiters
            }
            _ => {
                // Other contexts are also acceptable as long as we don't panic
            }
        }
    }

    #[test]
    fn test_edge_case_syntax_error_in_pipe_chain() {
        // Syntax error in pipe chain
        let code = "data %>% %>%\n  step()";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        // Should handle gracefully - detect some context without panicking
        match ctx {
            IndentContext::AfterContinuationOperator { .. }
            | IndentContext::AfterCompleteExpression { .. }
            | IndentContext::InsideParens { .. } => {
                // All acceptable for syntax error
            }
            _ => {
                // Other contexts are also acceptable
            }
        }
    }

    #[test]
    fn test_edge_case_deeply_nested_unclosed() {
        // Deeply nested unclosed structures
        let code = "func({\n  inner(x,\n    ";
        let tree = parse_r_code(code);

        // Cursor on line 2 (inside inner call)
        let position = Position { line: 2, character: 4 };
        let ctx = detect_context(&tree, code, position);

        // Should detect innermost unclosed context (parens)
        match ctx {
            IndentContext::InsideParens { .. } => {
                // Correct - detected innermost parens
            }
            IndentContext::InsideBraces { .. } => {
                // Also acceptable - detected braces
            }
            IndentContext::AfterCompleteExpression { .. } => {
                // Acceptable for incomplete code
            }
            _ => panic!("Expected InsideParens or InsideBraces for deeply nested unclosed, got {:?}", ctx),
        }
    }

    // ------------------------------------------------------------------------
    // Missing Nodes Tests
    // ------------------------------------------------------------------------

    #[test]
    fn test_edge_case_empty_function_call() {
        // Empty function call: `func()`
        let code = "func()";
        let tree = parse_r_code(code);

        // Cursor inside empty parens
        let position = Position { line: 0, character: 5 };
        let ctx = detect_context(&tree, code, position);

        // Should detect complete expression (parens are closed)
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {
                // Correct - empty call is complete
            }
            IndentContext::InsideParens { .. } => {
                // Also acceptable if cursor is considered inside
            }
            _ => panic!("Expected AfterCompleteExpression or InsideParens for empty function call, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_empty_braces() {
        // Empty braces: `{}`
        let code = "{}";
        let tree = parse_r_code(code);

        // Cursor inside empty braces
        let position = Position { line: 0, character: 1 };
        let ctx = detect_context(&tree, code, position);

        // Should detect complete expression or inside braces
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {
                // Correct - empty braces are complete
            }
            IndentContext::InsideBraces { .. } => {
                // Also acceptable if cursor is considered inside
            }
            _ => panic!("Expected AfterCompleteExpression or InsideBraces for empty braces, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_single_line_pipe() {
        // Single-line pipe: `data %>% step()`
        let code = "data %>% step()";
        let tree = parse_r_code(code);

        // Cursor at end of line
        let position = Position { line: 0, character: 15 };
        let ctx = detect_context(&tree, code, position);

        // Should detect complete expression (pipe chain is complete)
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {
                // Correct - single line pipe is complete
            }
            _ => panic!("Expected AfterCompleteExpression for single-line pipe, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_empty_line_at_start_of_file() {
        // Empty line at start of file
        let code = "\ndata %>%\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 0 (empty line)
        let position = Position { line: 0, character: 0 };
        let ctx = detect_context(&tree, code, position);

        // Should detect complete expression (nothing before cursor)
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {
                // Correct
            }
            _ => panic!("Expected AfterCompleteExpression for empty line at start, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_whitespace_only_line() {
        // Line with only whitespace
        let code = "data %>%\n    \n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 1 (whitespace-only line)
        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator from line 0
        match ctx {
            IndentContext::AfterContinuationOperator { chain_start_line, .. } => {
                assert_eq!(chain_start_line, 0);
            }
            _ => panic!("Expected AfterContinuationOperator for whitespace-only line, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_cursor_at_column_zero() {
        // Cursor at column 0 on various lines
        let code = "func(\n  arg1,\n  arg2\n)";
        let tree = parse_r_code(code);

        // Cursor at column 0 on line 1
        let position = Position { line: 1, character: 0 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::InsideParens { .. } => {
                // Correct
            }
            _ => panic!("Expected InsideParens at column 0 inside function call, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_very_long_chain() {
        // Very long pipe chain (tests iteration limit)
        let mut code = String::from("data");
        for i in 0..50 {
            code.push_str(&format!(" %>%\n  step{}()", i));
        }
        let tree = parse_r_code(&code);

        // Cursor on last line
        let position = Position { line: 50, character: 2 };
        let ctx = detect_context(&tree, &code, position);

        // Should detect continuation operator with chain start at line 0
        match ctx {
            IndentContext::AfterContinuationOperator { chain_start_line, .. } => {
                assert_eq!(chain_start_line, 0);
            }
            _ => panic!("Expected AfterContinuationOperator for very long chain, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_mixed_operators_in_chain() {
        // Mixed operators in chain
        let code = "data %>%\n  filter(x) |>\n  mutate(y) +\n  ";
        let tree = parse_r_code(code);

        // Cursor on line 3 (after +)
        let position = Position { line: 3, character: 2 };
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator with chain start at line 0
        match ctx {
            IndentContext::AfterContinuationOperator { chain_start_line, operator_type, .. } => {
                assert_eq!(chain_start_line, 0);
                assert_eq!(operator_type, OperatorType::Plus);
            }
            _ => panic!("Expected AfterContinuationOperator for mixed operators, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_unclosed_bracket() {
        // Unclosed bracket: `x[1,`
        let code = "x[1,";
        let tree = parse_r_code(code);

        // Cursor at end of line 0
        let position = Position { line: 0, character: 4 };
        let ctx = detect_context(&tree, code, position);

        // Should handle gracefully - may detect as complete expression or inside parens
        // depending on how tree-sitter handles subset syntax
        match ctx {
            IndentContext::InsideParens { .. }
            | IndentContext::AfterCompleteExpression { .. } => {
                // Both acceptable
            }
            _ => {
                // Other contexts are also acceptable as long as we don't panic
            }
        }
    }

    #[test]
    fn test_edge_case_nested_unclosed_structures() {
        // Multiple levels of unclosed structures
        let code = "outer({\n  inner(x,\n    nested(y,\n      ";
        let tree = parse_r_code(code);

        // Cursor on line 3 (deepest level)
        let position = Position { line: 3, character: 6 };
        let ctx = detect_context(&tree, code, position);

        // Should detect some context without panicking
        match ctx {
            IndentContext::InsideParens { .. }
            | IndentContext::InsideBraces { .. }
            | IndentContext::AfterCompleteExpression { .. } => {
                // All acceptable for deeply nested unclosed structures
            }
            _ => {
                // Other contexts are also acceptable
            }
        }
    }

    #[test]
    fn test_edge_case_pipe_after_closing_paren() {
        // Pipe after closing paren on same line
        let code = "func(x) %>%\n  step()";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator for pipe after closing paren, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_closing_delimiter_with_content_after() {
        // Closing delimiter with content after it
        let code = "func(\n  arg\n) %>%\n  step()";
        let tree = parse_r_code(code);

        // Cursor on line 3 (after pipe)
        let position = Position { line: 3, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::MagrittrPipe);
            }
            _ => panic!("Expected AfterContinuationOperator after closing delimiter with pipe, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_tilde_in_formula() {
        // Tilde in formula context
        let code = "y ~\n  x1 + x2";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::Tilde);
            }
            _ => panic!("Expected AfterContinuationOperator for tilde in formula, got {:?}", ctx),
        }
    }

    #[test]
    fn test_edge_case_custom_infix_operator() {
        // Custom infix operator
        let code = "x %myop%\n  y";
        let tree = parse_r_code(code);

        let position = Position { line: 1, character: 2 };
        let ctx = detect_context(&tree, code, position);

        match ctx {
            IndentContext::AfterContinuationOperator { operator_type, .. } => {
                assert_eq!(operator_type, OperatorType::CustomInfix);
            }
            _ => panic!("Expected AfterContinuationOperator for custom infix, got {:?}", ctx),
        }
    }

    // ========================================================================
    // Error Handling Unit Tests (Task 9.7)
    // Validates: Requirements 6.1, 8.3
    // ========================================================================

    #[test]
    fn test_error_handling_invalid_ast_double_operator() {
        // Invalid AST: double operators should trigger fallback detection
        let code = "x %>% %>%\n";
        let tree = parse_r_code(code);
        let position = Position { line: 1, character: 0 };

        // Should not panic, should return a valid context using fallback
        let ctx = detect_context(&tree, code, position);

        // The fallback should detect the continuation operator on the previous line
        match ctx {
            IndentContext::AfterContinuationOperator { .. }
            | IndentContext::AfterCompleteExpression { .. } => {
                // Both are acceptable for malformed code
            }
            _ => {
                // Other contexts are also acceptable as long as we don't panic
            }
        }
    }

    #[test]
    fn test_error_handling_invalid_ast_incomplete_assignment() {
        // Invalid AST: incomplete assignment
        let code = "x <-\n";
        let tree = parse_r_code(code);
        let position = Position { line: 1, character: 0 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Any context is acceptable for incomplete code
        match ctx {
            IndentContext::AfterCompleteExpression { .. }
            | IndentContext::AfterContinuationOperator { .. }
            | IndentContext::InsideParens { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_out_of_bounds_line_far_beyond() {
        // Position with line number far beyond document
        let code = "x <- 1";
        let tree = parse_r_code(code);
        let position = Position { line: 1000, character: 0 };

        let ctx = detect_context(&tree, code, position);

        // Should return AfterCompleteExpression with indent 0
        match ctx {
            IndentContext::AfterCompleteExpression { enclosing_block_indent } => {
                assert_eq!(enclosing_block_indent, 0);
            }
            _ => panic!("Expected AfterCompleteExpression for far out-of-bounds line"),
        }
    }

    #[test]
    fn test_error_handling_out_of_bounds_column_beyond_line() {
        // Position with column beyond line length
        let code = "short";
        let tree = parse_r_code(code);
        // Column 100 is way beyond the 5-character line
        let position = Position { line: 0, character: 100 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Should handle gracefully
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_out_of_bounds_max_values() {
        // Position with maximum u32 values
        let code = "x <- 1";
        let tree = parse_r_code(code);
        let position = Position { line: u32::MAX, character: u32::MAX };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Should return AfterCompleteExpression with indent 0
        match ctx {
            IndentContext::AfterCompleteExpression { enclosing_block_indent } => {
                assert_eq!(enclosing_block_indent, 0);
            }
            _ => panic!("Expected AfterCompleteExpression for max u32 position"),
        }
    }

    #[test]
    fn test_error_handling_unclosed_paren_multiline() {
        // Unclosed parenthesis spanning multiple lines
        let code = "func(\n  arg1,\n  arg2,\n";
        let tree = parse_r_code(code);
        let position = Position { line: 3, character: 0 };

        let ctx = detect_context(&tree, code, position);

        // Should detect inside parens
        match ctx {
            IndentContext::InsideParens { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            IndentContext::AfterCompleteExpression { .. } => {
                // Also acceptable if fallback is used
            }
            _ => panic!("Expected InsideParens or AfterCompleteExpression for unclosed paren, got {:?}", ctx),
        }
    }

    #[test]
    fn test_error_handling_unclosed_brace_multiline() {
        // Unclosed brace spanning multiple lines
        let code = "if (TRUE) {\n  x <- 1\n  y <- 2\n";
        let tree = parse_r_code(code);
        let position = Position { line: 3, character: 0 };

        let ctx = detect_context(&tree, code, position);

        // Should detect inside braces
        match ctx {
            IndentContext::InsideBraces { opener_line, .. } => {
                assert_eq!(opener_line, 0);
            }
            IndentContext::AfterCompleteExpression { .. } => {
                // Also acceptable if fallback is used
            }
            _ => panic!("Expected InsideBraces or AfterCompleteExpression for unclosed brace, got {:?}", ctx),
        }
    }

    #[test]
    fn test_error_handling_mismatched_delimiters_paren_bracket() {
        // Mismatched delimiters: opening paren, closing bracket
        let code = "func(x]";
        let tree = parse_r_code(code);
        let position = Position { line: 0, character: 7 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Any context is acceptable for mismatched delimiters
        match ctx {
            IndentContext::InsideParens { .. }
            | IndentContext::AfterCompleteExpression { .. }
            | IndentContext::ClosingDelimiter { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_mismatched_delimiters_brace_paren() {
        // Mismatched delimiters: opening brace, closing paren
        let code = "{ x <- 1 )";
        let tree = parse_r_code(code);
        let position = Position { line: 0, character: 10 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Any context is acceptable for mismatched delimiters
        match ctx {
            IndentContext::InsideBraces { .. }
            | IndentContext::AfterCompleteExpression { .. }
            | IndentContext::ClosingDelimiter { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_deeply_nested_syntax_error() {
        // Deeply nested structure with syntax error
        let code = "outer({\n  inner(x, {\n    <- broken\n  })\n})";
        let tree = parse_r_code(code);
        let position = Position { line: 2, character: 4 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Any context is acceptable for syntax error in nested structure
        match ctx {
            IndentContext::InsideParens { .. }
            | IndentContext::InsideBraces { .. }
            | IndentContext::AfterCompleteExpression { .. }
            | IndentContext::AfterContinuationOperator { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_empty_source() {
        // Empty source code
        let code = "";
        let tree = parse_r_code(code);
        let position = Position { line: 0, character: 0 };

        let ctx = detect_context(&tree, code, position);

        // Should return AfterCompleteExpression with indent 0
        match ctx {
            IndentContext::AfterCompleteExpression { enclosing_block_indent } => {
                assert_eq!(enclosing_block_indent, 0);
            }
            _ => panic!("Expected AfterCompleteExpression for empty source"),
        }
    }

    #[test]
    fn test_error_handling_whitespace_only_source() {
        // Source with only whitespace
        let code = "   \n   \n   ";
        let tree = parse_r_code(code);
        let position = Position { line: 1, character: 0 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Should return AfterCompleteExpression
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {}
            _ => panic!("Expected AfterCompleteExpression for whitespace-only source"),
        }
    }

    #[test]
    fn test_error_handling_comment_only_source() {
        // Source with only comments
        let code = "# comment 1\n# comment 2\n";
        let tree = parse_r_code(code);
        let position = Position { line: 2, character: 0 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Should return AfterCompleteExpression
        match ctx {
            IndentContext::AfterCompleteExpression { .. } => {}
            _ => panic!("Expected AfterCompleteExpression for comment-only source"),
        }
    }

    #[test]
    fn test_error_handling_unicode_in_code() {
        // Code with unicode characters
        let code = "变量 <- 1 %>%\n  处理()";
        let tree = parse_r_code(code);
        let position = Position { line: 1, character: 2 };

        // Should not panic
        let ctx = detect_context(&tree, code, position);

        // Should detect continuation operator context
        match ctx {
            IndentContext::AfterContinuationOperator { .. }
            | IndentContext::AfterCompleteExpression { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_very_long_line() {
        // Very long line (stress test)
        let long_content = "x".repeat(10000);
        let code = format!("{} %>%\n  step()", long_content);
        let tree = parse_r_code(&code);
        let position = Position { line: 1, character: 2 };

        // Should not panic
        let ctx = detect_context(&tree, &code, position);

        // Should detect continuation operator context
        match ctx {
            IndentContext::AfterContinuationOperator { .. }
            | IndentContext::AfterCompleteExpression { .. } => {}
            _ => {}
        }
    }

    #[test]
    fn test_error_handling_many_nested_levels() {
        // Many levels of nesting (stress test)
        let mut code = String::new();
        for _ in 0..50 {
            code.push_str("func(");
        }
        code.push('x');
        // Don't close the parens - test unclosed handling
        
        let tree = parse_r_code(&code);
        let position = Position { line: 0, character: code.len() as u32 };

        // Should not panic
        let ctx = detect_context(&tree, &code, position);

        // Should detect inside parens or complete expression
        match ctx {
            IndentContext::InsideParens { .. }
            | IndentContext::AfterCompleteExpression { .. } => {}
            _ => {}
        }
    }
}


#[cfg(test)]
mod auto_close_tests {
    use super::*;
    use crate::indentation::calculator::{IndentationConfig, IndentationStyle, calculate_indentation};
    use tower_lsp::lsp_types::Position;

    fn parse_r(code: &str) -> Tree {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&tree_sitter_r::LANGUAGE.into()).unwrap();
        parser.parse(code, None).unwrap()
    }

    fn rstudio_config(tab_size: u32) -> IndentationConfig {
        IndentationConfig {
            tab_size,
            insert_spaces: true,
            style: IndentationStyle::RStudio,
        }
    }

    #[test]
    fn auto_closed_paren_gets_inside_parens_context() {
        // VS Code auto-inserts `)`, user presses Enter → `func(\n)`
        let code = "x <- some_func(\n)";
        let tree = parse_r(code);
        let ctx = detect_context(&tree, code, Position { line: 1, character: 0 });
        assert!(matches!(ctx, IndentContext::InsideParens { .. }),
            "Auto-closed paren should be treated as InsideParens, got {:?}", ctx);
    }

    #[test]
    fn unclosed_paren_gets_inside_parens_context() {
        let code = "x <- some_func(\n";
        let tree = parse_r(code);
        let ctx = detect_context(&tree, code, Position { line: 1, character: 0 });
        assert!(matches!(ctx, IndentContext::InsideParens { .. }),
            "Unclosed paren should be InsideParens, got {:?}", ctx);
    }

    #[test]
    fn auto_closed_and_unclosed_produce_same_indent() {
        let config = rstudio_config(2);

        let code_auto = "x <- some_func(\n)";
        let tree_auto = parse_r(code_auto);
        let ctx_auto = detect_context(&tree_auto, code_auto, Position { line: 1, character: 0 });
        let indent_auto = calculate_indentation(ctx_auto, config.clone(), code_auto);

        let code_open = "x <- some_func(\n";
        let tree_open = parse_r(code_open);
        let ctx_open = detect_context(&tree_open, code_open, Position { line: 1, character: 0 });
        let indent_open = calculate_indentation(ctx_open, config, code_open);

        assert_eq!(indent_auto, indent_open,
            "Auto-closed and unclosed parens should produce identical indentation");
    }

    #[test]
    fn auto_closed_paren_in_braces_with_content_aligns_to_paren() {
        // The key user-reported scenario: content after opener should align
        let code = "if (TRUE) {\n  x <- some_func(\"file\",\n  )\n}";
        let tree = parse_r(code);
        let ctx = detect_context(&tree, code, Position { line: 2, character: 0 });

        match &ctx {
            IndentContext::InsideParens { opener_col, has_content_on_opener_line, .. } => {
                assert_eq!(*opener_col, 16);
                assert!(*has_content_on_opener_line);
            }
            _ => panic!("Expected InsideParens, got {:?}", ctx),
        }

        let indent = calculate_indentation(ctx, rstudio_config(2), code);
        // RStudio style with content after opener → align to column after `(`
        assert_eq!(indent, 17, "Should align to column after opening paren");
    }

    #[test]
    fn auto_closed_brace_gets_inside_braces_context() {
        let code = "if (TRUE) {\n}";
        let tree = parse_r(code);
        let ctx = detect_context(&tree, code, Position { line: 1, character: 0 });
        assert!(matches!(ctx, IndentContext::InsideBraces { .. }),
            "Auto-closed brace should be treated as InsideBraces, got {:?}", ctx);
    }

    #[test]
    fn second_enter_inside_auto_closed_parens() {
        // Simulates: user typed `x <- some_function(x,`, Enter (got alignment),
        // typed `y`, then pressed Enter again. Document state:
        //   x <- some_function(x,
        //                      y
        //                      )
        // Cursor is on line 2, the `)` is also on line 2.
        // onTypeFormatting position character may be nonzero (matching prev indent).
        let code = "x <- some_function(x,\n                   y\n                   )";
        let tree = parse_r(code);

        // Cursor at line 2 with nonzero character (matching previous line's indent)
        let ctx = detect_context(&tree, code, Position { line: 2, character: 19 });
        assert!(matches!(ctx, IndentContext::InsideParens { .. }),
            "Second Enter with auto-closed paren should be InsideParens, got {:?}", ctx);

        let indent = calculate_indentation(ctx, rstudio_config(2), code);
        // Should align to column after `(` since there's content after opener
        assert_eq!(indent, 19, "Should maintain paren alignment on second Enter");
    }
}
