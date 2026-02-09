//
// completion_context.rs
//
// Detects function call context at cursor position for parameter completions.
// Uses tree-sitter AST walk with a bracket-heuristic FSM fallback for
// incomplete syntax (matching the official R language server's approach).
//

use tower_lsp::lsp_types::Position;
use tree_sitter::{Node, Point, Tree};

/// Information about a detected function call at cursor position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionCallContext {
    /// Name of the function being called
    pub function_name: String,
    /// Optional namespace qualifier (e.g., "dplyr" in dplyr::filter)
    pub namespace: Option<String>,
    /// Whether the call uses internal access (:::)
    pub is_internal: bool,
}

/// Detect if cursor is inside a function call's argument list.
///
/// Returns `None` if:
/// - cursor is outside all function call parentheses
/// - cursor is inside a string literal within function arguments
/// - document is R Markdown and cursor is outside an R code block
///
/// Uses tree-sitter AST walk as primary strategy, with a bracket-heuristic
/// FSM fallback for incomplete/malformed syntax.
pub fn detect_function_call_context(
    tree: &Tree,
    text: &str,
    position: Position,
) -> Option<FunctionCallContext> {
    // Gate on embedded-R scope: if this looks like R Markdown, check
    // that the cursor is inside an R code block.
    if is_rmarkdown(text) && !is_inside_r_code_block(text, position) {
        return None;
    }

    // Try AST-based detection first
    if let Some(ctx) = detect_via_ast(tree, text, position) {
        return Some(ctx);
    }

    // Fall back to bracket-heuristic FSM for incomplete syntax
    detect_via_bracket_heuristic(text, position)
}

/// Check if the document text looks like R Markdown (contains code fences).
fn is_rmarkdown(text: &str) -> bool {
    // R Markdown files contain ```{r ...} code fences.
    // A simple heuristic: look for the pattern at the start of a line.
    text.lines()
        .any(|line| line.trim_start().starts_with("```{r"))
}

/// Check if the cursor position is inside an R code block in R Markdown.
fn is_inside_r_code_block(text: &str, position: Position) -> bool {
    let cursor_line = position.line as usize;
    let mut in_r_block = false;

    for (line_idx, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```{r") {
            in_r_block = true;
        } else if in_r_block && trimmed.starts_with("```") {
            // Closing fence — cursor must be before this line to be inside
            if line_idx > cursor_line {
                return true;
            }
            in_r_block = false;
        }

        if line_idx == cursor_line {
            return in_r_block;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// AST-based detection
// ---------------------------------------------------------------------------

/// Try to detect function call context using tree-sitter AST walk.
fn detect_via_ast(tree: &Tree, text: &str, position: Position) -> Option<FunctionCallContext> {
    let point = Point::new(position.line as usize, position.character as usize);
    let node = tree.root_node().descendant_for_point_range(point, point)?;

    // If cursor is inside a string node, no parameter completions
    if is_inside_string(&node) {
        return None;
    }

    find_enclosing_function_call(node, text, position)
}

/// Check if a node (or any ancestor) is a string literal.
fn is_inside_string(node: &Node) -> bool {
    let mut current = *node;
    loop {
        let kind = current.kind();
        if kind == "string" || kind == "string_content" || kind == "raw_string_literal" {
            return true;
        }
        // Stop walking up if we hit a call or program node
        if kind == "call" || kind == "program" {
            return false;
        }
        match current.parent() {
            Some(p) => current = p,
            None => return false,
        }
    }
}

/// Walk up the AST from cursor to find the innermost enclosing function call.
///
/// For nested calls like `outer(inner(x))`, returns the innermost `call`
/// whose argument list contains the cursor position.
fn find_enclosing_function_call(
    node: Node,
    text: &str,
    position: Position,
) -> Option<FunctionCallContext> {
    let cursor_point = Point::new(position.line as usize, position.character as usize);
    let mut current = node;

    loop {
        if current.kind() == "call" {
            // Check if cursor is inside the arguments (between `(` and `)`)
            if let Some(args_node) = current.child_by_field_name("arguments") {
                let args_start = args_node.start_position();
                let args_end = args_node.end_position();

                // cursor must be after the opening `(` and before or at the closing `)`
                if cursor_point > args_start && cursor_point <= args_end {
                    if let Some(func_node) = current.child_by_field_name("function") {
                        return extract_call_info(func_node, text);
                    }
                }
            }
        }
        current = current.parent()?;
    }
}

/// Extract function name and namespace info from the function node of a call.
fn extract_call_info(func_node: Node, text: &str) -> Option<FunctionCallContext> {
    if func_node.kind() == "namespace_operator" {
        let mut cursor = func_node.walk();
        let children: Vec<_> = func_node.children(&mut cursor).collect();

        // Children: [namespace_identifier, "::" or ":::", function_identifier]
        if children.len() >= 3 {
            let ns_name = node_text(children[0], text);
            let operator = node_text(children[1], text);
            let func_name = node_text(children[2], text);

            return Some(FunctionCallContext {
                function_name: func_name.to_string(),
                namespace: Some(ns_name.to_string()),
                is_internal: operator == ":::",
            });
        }
        None
    } else if func_node.kind() == "identifier" {
        Some(FunctionCallContext {
            function_name: node_text(func_node, text).to_string(),
            namespace: None,
            is_internal: false,
        })
    } else {
        // Anonymous function or other non-identifier callee — not supported
        None
    }
}

/// Extract text for a tree-sitter node.
fn node_text<'a>(node: Node, text: &'a str) -> &'a str {
    &text[node.byte_range()]
}

// ---------------------------------------------------------------------------
// Bracket-heuristic FSM fallback
// ---------------------------------------------------------------------------

/// FSM states for tracking string context within a single line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FsmState {
    Normal,
    SingleQuoted,
    DoubleQuoted,
    BacktickQuoted,
    /// Inside a raw string like r"(...)" — tracks the delimiter char and depth.
    RawString {
        /// The closing quote character (' or ")
        close_quote: char,
        /// The delimiter character between the quote and the opening paren
        /// None means no delimiter (just `r"(...")`).
        delimiter: Option<char>,
        /// Nesting depth of parentheses inside the raw string
        paren_depth: usize,
    },
}

/// Detect function call context using a bracket-heuristic FSM.
///
/// This is the fallback when the AST walk fails (e.g., incomplete syntax).
/// It scans lines backward from the cursor, and within each line scans
/// forward from position 0, matching the R-LS C implementation (`search.c`).
///
/// The algorithm:
/// 1. Process lines from cursor line backward
/// 2. Within each line, scan forward from position 0 (up to cursor col on cursor line)
/// 3. Re-initialize FSM state at each new line
/// 4. Track brackets using a stack; closing brackets pop any opening bracket
/// 5. Only an unmatched `(` triggers parameter completions
/// 6. Multi-line string bailout: if a previous line ends in quote state, stop
fn detect_via_bracket_heuristic(text: &str, position: Position) -> Option<FunctionCallContext> {
    let lines: Vec<&str> = text.lines().collect();
    let cursor_line = position.line as usize;
    let cursor_col = position.character as usize;

    if cursor_line >= lines.len() {
        return None;
    }

    // Bracket stack accumulated across lines (from later lines to earlier).
    // Contains opening bracket characters that haven't been matched yet.
    let mut bracket_stack: Vec<char> = Vec::new();

    for line_idx in (0..=cursor_line).rev() {
        let line = lines[line_idx];
        let scan_end = if line_idx == cursor_line {
            cursor_col.min(line.len())
        } else {
            line.len()
        };

        let line_bytes = line.as_bytes();
        let mut state = FsmState::Normal; // Re-initialize FSM each line

        // Unmatched brackets found on this line (after intra-line matching).
        // Opens: (char, byte_position); Closes: just the char.
        let mut line_opens: Vec<(char, usize)> = Vec::new();

        let mut i = 0;
        while i < scan_end {
            let ch = line_bytes[i] as char;

            match state {
                FsmState::SingleQuoted => {
                    if ch == '\\' {
                        i += 1; // skip escaped char
                    } else if ch == '\'' {
                        state = FsmState::Normal;
                    }
                }
                FsmState::DoubleQuoted => {
                    if ch == '\\' {
                        i += 1; // skip escaped char
                    } else if ch == '"' {
                        state = FsmState::Normal;
                    }
                }
                FsmState::BacktickQuoted => {
                    if ch == '`' {
                        state = FsmState::Normal;
                    }
                }
                FsmState::RawString {
                    close_quote,
                    delimiter,
                    paren_depth,
                } => {
                    if ch == '(' {
                        state = FsmState::RawString {
                            close_quote,
                            delimiter,
                            paren_depth: paren_depth + 1,
                        };
                    } else if ch == ')' {
                        if paren_depth <= 1 {
                            // Try to close the raw string: `)` + optional delimiter + quote
                            let closed = try_close_raw_string(
                                line_bytes, i, scan_end, close_quote, delimiter,
                            );
                            if let Some(advance_to) = closed {
                                state = FsmState::Normal;
                                i = advance_to;
                            } else {
                                state = FsmState::RawString {
                                    close_quote,
                                    delimiter,
                                    paren_depth: paren_depth.saturating_sub(1),
                                };
                            }
                        } else {
                            state = FsmState::RawString {
                                close_quote,
                                delimiter,
                                paren_depth: paren_depth - 1,
                            };
                        }
                    }
                    // All other chars inside raw string are ignored
                }
                FsmState::Normal => {
                    match ch {
                        '#' => {
                            // Comment: stop scanning remainder of this line
                            break;
                        }
                        '\'' => state = FsmState::SingleQuoted,
                        '"' => state = FsmState::DoubleQuoted,
                        '`' => state = FsmState::BacktickQuoted,
                        'r' | 'R' => {
                            // Check for R 4.0+ raw string
                            if let Some((raw_state, new_i)) =
                                try_start_raw_string(line_bytes, i, scan_end)
                            {
                                state = raw_state;
                                i = new_i;
                            }
                        }
                        '(' | '[' | '{' => {
                            line_opens.push((ch, i));
                        }
                        ')' | ']' | '}' => {
                            // R-LS behavior: any closing bracket pops any opening bracket
                            if line_opens.pop().is_some() {
                                // Matched with an opening bracket on this line
                            } else {
                                // Unmatched close: deduct from accumulated stack
                                bracket_stack.pop();
                            }
                        }
                        _ => {}
                    }
                }
            }

            i += 1;
        }

        // Multi-line string bailout: if a previous line (not cursor line) ends
        // with an unmatched quote state, stop searching backward.
        if line_idx < cursor_line
            && matches!(state, FsmState::SingleQuoted | FsmState::DoubleQuoted)
        {
            return None;
        }

        // Cursor-in-string check: if this is the cursor line and the FSM ends
        // inside a string, the cursor is inside a string literal — no completions.
        if line_idx == cursor_line
            && matches!(
                state,
                FsmState::SingleQuoted
                    | FsmState::DoubleQuoted
                    | FsmState::BacktickQuoted
                    | FsmState::RawString { .. }
            )
        {
            return None;
        }

        // Check unmatched opening brackets from this line.
        // Scan them from first to last (left to right in the line).
        // Each one is pushed onto the bracket_stack.
        // If any is a `(`, it's a candidate for the enclosing call.
        // We want the *nearest* unmatched `(` to the cursor, which is the
        // last `(` in line_opens (rightmost on this line, closest to cursor).
        //
        // But we also need to account for brackets from later lines that
        // might close these opens. The bracket_stack already has unmatched
        // opens from later lines. New opens from this line are added.
        // However, we should check: does the last open on this line survive
        // as unmatched after considering all later-line closes?
        //
        // The closes from later lines have already been applied to bracket_stack.
        // So we just push these opens and check.

        for &(ch, _pos) in &line_opens {
            bracket_stack.push(ch);
        }

        // Check if the top of the stack is an unmatched `(` from this line.
        // We want the rightmost unmatched `(` from this line.
        // Find the last `(` in line_opens.
        if let Some(&top) = bracket_stack.last() {
            if top == '(' {
                // Find the rightmost `(` in line_opens
                if let Some(&(_ch, paren_pos)) = line_opens.iter().rev().find(|(c, _)| *c == '(') {
                    return extract_function_name_before_paren(lines[line_idx], paren_pos);
                }
            }
        }
    }

    None
}

/// Try to close a raw string at position `i` (which is a `)`).
/// Returns the position to advance to if the raw string closes, or None.
fn try_close_raw_string(
    line_bytes: &[u8],
    i: usize,
    scan_end: usize,
    close_quote: char,
    delimiter: Option<char>,
) -> Option<usize> {
    let mut j = i + 1;
    if let Some(delim) = delimiter {
        if j < scan_end && line_bytes[j] as char == delim {
            j += 1;
        } else {
            return None;
        }
    }
    if j < scan_end && line_bytes[j] as char == close_quote {
        Some(j)
    } else {
        None
    }
}

/// Try to start a raw string from position `i` in the line.
/// Returns `(FsmState, new_i)` where `new_i` is the position of the opening
/// paren of the raw string, or `None` if this isn't a raw string start.
fn try_start_raw_string(
    line_bytes: &[u8],
    i: usize,
    scan_end: usize,
) -> Option<(FsmState, usize)> {
    // Pattern: r"(...)" or R'(...)' or r"-(..)-" etc.
    // At position i we have 'r' or 'R'.
    let mut j = i + 1;
    if j >= scan_end {
        return None;
    }

    let quote_char = line_bytes[j] as char;
    if quote_char != '"' && quote_char != '\'' {
        return None;
    }
    j += 1;

    // Optional delimiter character between quote and `(`
    let delimiter = if j < scan_end && line_bytes[j] as char != '(' {
        let d = line_bytes[j] as char;
        j += 1;
        Some(d)
    } else {
        None
    };

    // Must have `(` next
    if j >= scan_end || line_bytes[j] as char != '(' {
        return None;
    }

    // j points at the `(` — the outer loop's i += 1 will advance past it
    Some((
        FsmState::RawString {
            close_quote: quote_char,
            delimiter,
            paren_depth: 1,
        },
        j,
    ))
}

/// Extract the function name (and optional namespace) immediately before a `(`.
///
/// Scans backward from `paren_pos` in the line, skipping whitespace, then
/// collecting identifier characters (alphanumeric, `.`, `_`) and namespace
/// qualifiers (`::` or `:::`).
fn extract_function_name_before_paren(
    line: &str,
    paren_pos: usize,
) -> Option<FunctionCallContext> {
    let bytes = line.as_bytes();
    if paren_pos == 0 {
        return None;
    }

    let mut end = paren_pos;

    // Skip whitespace before `(`
    while end > 0 && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }

    if end == 0 {
        return None;
    }

    // Collect the token: identifier chars and `::` / `:::` namespace qualifiers.
    // R identifiers can contain: letters, digits, `.`, `_`
    let mut start = end;
    while start > 0 {
        let b = bytes[start - 1];
        if b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b':' {
            start -= 1;
        } else {
            break;
        }
    }

    if start == end {
        return None;
    }

    let token = &line[start..end];
    parse_function_token(token)
}

/// Parse a function name token that may contain namespace qualifiers.
fn parse_function_token(token: &str) -> Option<FunctionCallContext> {
    // Check for ::: first (must check before :: since :: is a prefix of :::)
    if let Some(triple_pos) = token.find(":::") {
        let ns = &token[..triple_pos];
        let func = &token[triple_pos + 3..];
        if !ns.is_empty() && !func.is_empty() {
            return Some(FunctionCallContext {
                function_name: func.to_string(),
                namespace: Some(ns.to_string()),
                is_internal: true,
            });
        }
    } else if let Some(double_pos) = token.find("::") {
        let ns = &token[..double_pos];
        let func = &token[double_pos + 2..];
        if !ns.is_empty() && !func.is_empty() {
            return Some(FunctionCallContext {
                function_name: func.to_string(),
                namespace: Some(ns.to_string()),
                is_internal: false,
            });
        }
    }

    // Simple function name (no namespace)
    if token.is_empty() || token.starts_with(':') {
        return None;
    }

    Some(FunctionCallContext {
        function_name: token.to_string(),
        namespace: None,
        is_internal: false,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser_pool::with_parser;

    fn parse_r(code: &str) -> Tree {
        with_parser(|parser| parser.parse(code, None).unwrap())
    }

    // --- AST-based detection tests ---

    #[test]
    fn test_simple_function_call() {
        let code = "func(x, )";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 8));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_cursor_after_open_paren() {
        let code = "func()";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 5));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_cursor_outside_parens() {
        let code = "func(x)\ny <- 1";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(1, 5));
        assert_eq!(ctx, None);
    }

    #[test]
    fn test_nested_calls_inner() {
        let code = "outer(inner(x, ))";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 15));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "inner".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_nested_calls_outer() {
        let code = "outer(inner(x), )";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 16));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "outer".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_namespace_double_colon() {
        let code = "dplyr::filter(df, )";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 18));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "filter".to_string(),
                namespace: Some("dplyr".to_string()),
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_namespace_triple_colon() {
        let code = "pkg:::internal_func(x, )";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 23));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "internal_func".to_string(),
                namespace: Some("pkg".to_string()),
                is_internal: true,
            })
        );
    }

    #[test]
    fn test_cursor_inside_string() {
        let code = r#"func("hello")"#;
        let tree = parse_r(code);
        // Cursor inside the string at col 7 (the 'e' in "hello")
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 7));
        assert_eq!(ctx, None);
    }

    // --- R Markdown gating tests ---

    #[test]
    fn test_rmarkdown_outside_r_block() {
        let code = "---\ntitle: test\n---\n\nSome text func(\n\n```{r}\nx <- 1\n```\n";
        let tree = parse_r(code);
        // Cursor on line 4 (markdown text), col 15
        let ctx = detect_function_call_context(&tree, code, Position::new(4, 15));
        assert_eq!(ctx, None);
    }

    #[test]
    fn test_non_rmarkdown_not_gated() {
        let code = "func(x, )";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 8));
        assert!(ctx.is_some());
    }

    #[test]
    fn test_rmarkdown_inside_r_block_detects_call() {
        // Cursor inside an R code block in R Markdown should detect function call context
        let code = "---\ntitle: test\n---\n\n```{r}\nfunc(x, )\n```\n";
        // Line 5 is "func(x, )" — cursor at col 8 (after comma, inside parens)
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(5, 8));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_rmarkdown_between_r_blocks_no_context() {
        // Cursor in markdown text between two R code blocks should NOT detect context
        let code = "\
---
title: test
---

```{r}
x <- func(1)
```

Some markdown text with func( here

```{r}
y <- other(2)
```
";
        let tree = parse_r(code);
        // Line 8 is "Some markdown text with func( here" — cursor at col 29 (after the open paren)
        let ctx = detect_function_call_context(&tree, code, Position::new(8, 29));
        assert_eq!(ctx, None);
    }

    #[test]
    fn test_rmarkdown_second_r_block_detects_call() {
        // Multiple R code blocks: cursor in second block should work
        let code = "\
---
title: test
---

```{r}
x <- first(1)
```

Some text

```{r}
y <- second(a, )
```
";
        let tree = parse_r(code);
        // Line 11 is "y <- second(a, )" — cursor at col 15 (after comma, inside parens)
        let ctx = detect_function_call_context(&tree, code, Position::new(11, 15));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "second".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    // --- Bracket-heuristic FSM tests ---

    #[test]
    fn test_fallback_unbalanced_parens() {
        // Incomplete syntax: missing closing paren
        let code = "func(x, ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 8));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_fallback_string_with_paren() {
        // Bracket inside string should be ignored
        let code = "f(\"(\", ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 7));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("f")
        );
    }

    #[test]
    fn test_fallback_single_quoted_string_with_paren() {
        let code = "g(')', ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 7));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("g")
        );
    }

    #[test]
    fn test_fallback_backtick_string_with_paren() {
        let code = "h(`(`, ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 7));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("h")
        );
    }

    #[test]
    fn test_fallback_escaped_quote() {
        let code = "f(\"a\\\"(b\", ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 11));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("f")
        );
    }

    #[test]
    fn test_fallback_comment_with_bracket() {
        let code = "f(x, # adjust ( balance\n  ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(1, 2));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("f")
        );
    }

    #[test]
    fn test_fallback_multi_bracket_nesting() {
        // df[func(x, )] — cursor inside func's args
        let code = "df[func(x, ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 11));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("func")
        );
    }

    #[test]
    fn test_fallback_raw_string() {
        let code = "f(r\"(hello(world))\", ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 21));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("f")
        );
    }

    #[test]
    fn test_fallback_raw_string_with_delimiter() {
        let code = "f(r\"-(hello(world))-\", ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 23));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("f")
        );
    }

    #[test]
    fn test_fallback_cursor_at_col_0() {
        // Cursor at beginning of a continuation line
        let code = "func(\n  ";
        let tree = parse_r(code);
        // Cursor at beginning of line 1
        let ctx = detect_function_call_context(&tree, code, Position::new(1, 0));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("func")
        );
    }

    #[test]
    fn test_fallback_cursor_at_col_0_no_crash() {
        // Edge case: cursor at col 0 on first line with just `(`
        let code = "(";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 0));
        // No function name before `(`, so should return None
        assert_eq!(ctx, None);
    }

    #[test]
    fn test_fallback_multiline_string_bailout() {
        // When the cursor is on a line that requires looking at a previous line
        // that ends with an unmatched quote, the heuristic should bail out.
        // Here, the `(` is on line 0 (inside the multi-line string context),
        // and the cursor is on line 1 with no `(` on that line.
        let code = "f(\"hello\nworld";
        let heuristic_ctx = detect_via_bracket_heuristic(code, Position::new(1, 5));
        // Line 1 has no `(`, so we look at line 0. Line 0 ends in DoubleQuoted
        // state (the `"` at position 2 opens a string that isn't closed on line 0).
        // The heuristic should bail out.
        assert_eq!(heuristic_ctx, None);
    }

    #[test]
    fn test_fallback_namespace_qualified() {
        let code = "dplyr::filter(df, ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 18));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "filter".to_string(),
                namespace: Some("dplyr".to_string()),
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_fallback_namespace_triple_colon() {
        let code = "pkg:::internal(x, ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(0, 18));
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "internal".to_string(),
                namespace: Some("pkg".to_string()),
                is_internal: true,
            })
        );
    }

    #[test]
    fn test_fallback_multiline_call() {
        let code = "func(\n  x,\n  y,\n  ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(3, 2));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("func")
        );
    }

    #[test]
    fn test_fallback_closing_bracket_on_later_line() {
        // func(x, inner(y), — the `)` after y closes inner's `(`
        let code = "func(x, inner(y),\n  ";
        let tree = parse_r(code);
        let ctx = detect_function_call_context(&tree, code, Position::new(1, 2));
        assert_eq!(
            ctx.as_ref().map(|c| c.function_name.as_str()),
            Some("func")
        );
    }

    // --- Helper function tests ---

    #[test]
    fn test_extract_function_name_simple() {
        let ctx = extract_function_name_before_paren("func(", 4);
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_extract_function_name_with_whitespace() {
        let ctx = extract_function_name_before_paren("func  (", 6);
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_extract_function_name_with_dots() {
        let ctx = extract_function_name_before_paren("read.csv(", 8);
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "read.csv".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_extract_function_name_namespace() {
        let ctx = extract_function_name_before_paren("dplyr::filter(", 13);
        assert_eq!(
            ctx,
            Some(FunctionCallContext {
                function_name: "filter".to_string(),
                namespace: Some("dplyr".to_string()),
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_extract_function_name_at_pos_0() {
        let ctx = extract_function_name_before_paren("(", 0);
        assert_eq!(ctx, None);
    }

    #[test]
    fn test_is_rmarkdown_true() {
        assert!(is_rmarkdown("---\ntitle: test\n---\n\n```{r}\nx <- 1\n```\n"));
    }

    #[test]
    fn test_is_rmarkdown_false() {
        assert!(!is_rmarkdown("x <- 1\nfunc(x)"));
    }

    #[test]
    fn test_is_inside_r_code_block() {
        let code = "---\ntitle: test\n---\n\n```{r}\nx <- 1\n```\n";
        // Line 5 is "x <- 1" — inside the R block
        assert!(is_inside_r_code_block(code, Position::new(5, 0)));
        // Line 3 is empty — outside the R block
        assert!(!is_inside_r_code_block(code, Position::new(3, 0)));
    }

    #[test]
    fn test_parse_function_token_simple() {
        assert_eq!(
            parse_function_token("func"),
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: None,
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_parse_function_token_namespace() {
        assert_eq!(
            parse_function_token("pkg::func"),
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: Some("pkg".to_string()),
                is_internal: false,
            })
        );
    }

    #[test]
    fn test_parse_function_token_internal() {
        assert_eq!(
            parse_function_token("pkg:::func"),
            Some(FunctionCallContext {
                function_name: "func".to_string(),
                namespace: Some("pkg".to_string()),
                is_internal: true,
            })
        );
    }

    #[test]
    fn test_parse_function_token_empty() {
        assert_eq!(parse_function_token(""), None);
    }

    #[test]
    fn test_parse_function_token_colons_only() {
        assert_eq!(parse_function_token("::"), None);
    }
}

// ============================================================================
// Property Tests for Function Call Context Detection
// Feature: function-parameter-completions, Property 1: Function Call Context Detection
// ============================================================================

#[cfg(test)]
mod property_tests {
    use super::*;
    use crate::parser_pool::with_parser;
    use proptest::prelude::*;

    /// Strategy to generate valid R identifiers for function names.
    /// R identifiers start with a letter or `.` (if followed by non-digit),
    /// and can contain letters, digits, `.`, and `_`.
    /// We keep it simple: start with a lowercase letter, then alphanumeric/dot/underscore.
    fn r_identifier() -> impl Strategy<Value = String> {
        // Start with a letter, then 0-7 chars of [a-z0-9._]
        ("[a-z][a-z0-9._]{0,7}").prop_filter("must not be empty", |s| !s.is_empty())
    }

    /// Strategy to generate simple R argument expressions (values that can appear
    /// as arguments in a function call). These must not contain unbalanced
    /// parentheses, quotes, or other characters that would confuse the parser.
    fn r_argument_expr() -> impl Strategy<Value = String> {
        prop_oneof![
            // Simple identifiers
            r_identifier(),
            // Numeric literals
            (1..1000i32).prop_map(|n| n.to_string()),
            // TRUE/FALSE
            prop_oneof![Just("TRUE".to_string()), Just("FALSE".to_string())],
        ]
    }

    /// Strategy to generate a list of argument expressions (0 to 4 args).
    fn r_arguments(min: usize, max: usize) -> impl Strategy<Value = Vec<String>> {
        prop::collection::vec(r_argument_expr(), min..=max)
    }

    /// Parse R code using the thread-local parser.
    fn parse_r(code: &str) -> tree_sitter::Tree {
        with_parser(|parser| parser.parse(code, None).unwrap())
    }


    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        // ============================================================================
        // Feature: function-parameter-completions, Property 1: Function Call Context Detection
        //
        // For any R code containing function calls and for any cursor position,
        // the context detector SHALL return a FunctionCallContext with the correct
        // function name when the cursor is inside the argument list (after `(`,
        // before `)`, or after a comma), and SHALL return None when the cursor is
        // outside all function call parentheses.
        //
        // **Validates: Requirements 1.1, 1.2, 1.4**
        // ============================================================================

        /// Test that cursor positions INSIDE a function call's argument list
        /// are correctly detected with the right function name.
        #[test]
        fn prop_context_detected_inside_argument_list(
            func_name in r_identifier(),
            args in r_arguments(0, 4),
        ) {
            // Build code like: func_name(arg1, arg2, arg3)
            let args_str = args.join(", ");
            let code = format!("{}({})", func_name, args_str);

            let tree = parse_r(&code);

            // The opening paren is at column = func_name.len()
            let open_paren_col = func_name.len();
            // The closing paren is at column = func_name.len() + 1 + args_str.len()
            let close_paren_col = open_paren_col + 1 + args_str.len();

            // Test cursor right after the opening paren (Requirement 1.1)
            let pos_after_open = Position::new(0, (open_paren_col + 1) as u32);
            let ctx = detect_function_call_context(&tree, &code, pos_after_open);
            prop_assert!(
                ctx.is_some(),
                "Expected context detected after '(' at col {} in code: {}",
                open_paren_col + 1,
                code
            );
            let ctx = ctx.unwrap();
            prop_assert_eq!(
                &ctx.function_name,
                &func_name,
                "Function name mismatch after '(' in code: {}",
                code
            );
            prop_assert_eq!(
                ctx.namespace,
                None,
                "Expected no namespace for simple call in code: {}",
                code
            );
            prop_assert_eq!(
                ctx.is_internal,
                false,
                "Expected is_internal=false for simple call in code: {}",
                code
            );

            // Test cursor at the closing paren position (still inside args)
            let pos_at_close = Position::new(0, close_paren_col as u32);
            let ctx_close = detect_function_call_context(&tree, &code, pos_at_close);
            prop_assert!(
                ctx_close.is_some(),
                "Expected context detected at ')' col {} in code: {}",
                close_paren_col,
                code
            );
            prop_assert_eq!(
                &ctx_close.unwrap().function_name,
                &func_name,
                "Function name mismatch at ')' in code: {}",
                code
            );

            // Test cursor positions after each comma (Requirement 1.2)
            if args.len() >= 2 {
                // Find comma positions in the args_str
                let mut search_start = 0;
                for _ in 0..(args.len() - 1) {
                    if let Some(comma_offset) = args_str[search_start..].find(',') {
                        let comma_col_in_code = open_paren_col + 1 + search_start + comma_offset;
                        // Cursor right after the comma (skip the space too)
                        let pos_after_comma = Position::new(0, (comma_col_in_code + 2) as u32);
                        let ctx_comma = detect_function_call_context(&tree, &code, pos_after_comma);
                        prop_assert!(
                            ctx_comma.is_some(),
                            "Expected context detected after comma at col {} in code: {}",
                            comma_col_in_code + 2,
                            code
                        );
                        prop_assert_eq!(
                            &ctx_comma.unwrap().function_name,
                            &func_name,
                            "Function name mismatch after comma in code: {}",
                            code
                        );
                        search_start += comma_offset + 1;
                    }
                }
            }
        }

        /// Test that cursor positions OUTSIDE function call parentheses
        /// do NOT detect a function call context (Requirement 1.4).
        #[test]
        fn prop_no_context_outside_function_call(
            func_name in r_identifier(),
            args in r_arguments(0, 3),
            prefix_var in r_identifier(),
        ) {
            // Build code with a variable assignment before the function call
            // and a variable assignment after it:
            // prefix_var <- 1
            // func_name(arg1, arg2)
            // suffix_var <- 2
            let args_str = args.join(", ");
            let code = format!(
                "{} <- 1\n{}({})\n{} <- 2",
                prefix_var, func_name, args_str, prefix_var
            );

            let tree = parse_r(&code);

            // Test cursor on line 0 (before the function call) — should be None
            // Position at the end of the assignment: "prefix_var <- 1"
            let pos_before = Position::new(0, (prefix_var.len() + 5) as u32);
            let ctx_before = detect_function_call_context(&tree, &code, pos_before);
            prop_assert!(
                ctx_before.is_none(),
                "Expected no context on line 0 (before call) at col {} in code:\n{}",
                prefix_var.len() + 5,
                code
            );

            // Test cursor on line 2 (after the function call) — should be None
            // Position at the end of the assignment: "prefix_var <- 2"
            let pos_after = Position::new(2, (prefix_var.len() + 5) as u32);
            let ctx_after = detect_function_call_context(&tree, &code, pos_after);
            prop_assert!(
                ctx_after.is_none(),
                "Expected no context on line 2 (after call) at col {} in code:\n{}",
                prefix_var.len() + 5,
                code
            );
        }

        /// Test that cursor at random valid positions within the argument list
        /// always detects the correct function name.
        #[test]
        fn prop_random_position_inside_args(
            func_name in r_identifier(),
            args in r_arguments(1, 4),
            // Pick a random offset within the argument list
            offset_frac in 0.0f64..1.0f64,
        ) {
            let args_str = args.join(", ");
            let code = format!("{}({})", func_name, args_str);

            let tree = parse_r(&code);

            let open_paren_col = func_name.len();
            // Valid cursor range: (open_paren_col + 1) to (open_paren_col + args_str.len())
            // i.e., after '(' up to and including the last arg char (before ')')
            let min_col = open_paren_col + 1;
            let max_col = open_paren_col + 1 + args_str.len();

            // Compute a random column within the argument list
            let range = max_col - min_col;
            prop_assume!(range > 0);
            let cursor_col = min_col + ((offset_frac * range as f64) as usize).min(range - 1);

            let pos = Position::new(0, cursor_col as u32);
            let ctx = detect_function_call_context(&tree, &code, pos);
            prop_assert!(
                ctx.is_some(),
                "Expected context at col {} (offset_frac={}) in code: {}",
                cursor_col,
                offset_frac,
                code
            );
            prop_assert_eq!(
                &ctx.unwrap().function_name,
                &func_name,
                "Function name mismatch at col {} in code: {}",
                cursor_col,
                code
            );
        }

        /// Test that cursor before the function name does not detect context.
        #[test]
        fn prop_no_context_before_function_name(
            func_name in r_identifier(),
            args in r_arguments(0, 3),
        ) {
            // Add leading whitespace so we can place cursor before the function name
            let args_str = args.join(", ");
            let code = format!("  {}({})", func_name, args_str);

            let tree = parse_r(&code);

            // Cursor at column 0 (before the function name)
            let pos = Position::new(0, 0);
            let ctx = detect_function_call_context(&tree, &code, pos);
            prop_assert!(
                ctx.is_none(),
                "Expected no context at col 0 (before func name) in code: {}",
                code
            );

            // Cursor at column 1 (still before the function name)
            let pos1 = Position::new(0, 1);
            let ctx1 = detect_function_call_context(&tree, &code, pos1);
            prop_assert!(
                ctx1.is_none(),
                "Expected no context at col 1 (before func name) in code: {}",
                code
            );
        }

        /// Test that cursor right after the closing paren does not detect context.
        #[test]
        fn prop_no_context_after_closing_paren(
            func_name in r_identifier(),
            args in r_arguments(0, 3),
        ) {
            let args_str = args.join(", ");
            // Add a trailing space and assignment so cursor has somewhere to go
            let code = format!("{}({}) ", func_name, args_str);

            let tree = parse_r(&code);

            // The closing paren is at column = func_name.len() + 1 + args_str.len()
            let close_paren_col = func_name.len() + 1 + args_str.len();
            // Cursor right after the closing paren
            let pos = Position::new(0, (close_paren_col + 1) as u32);
            let ctx = detect_function_call_context(&tree, &code, pos);
            prop_assert!(
                ctx.is_none(),
                "Expected no context after ')' at col {} in code: {}",
                close_paren_col + 1,
                code
            );
        }

        // ============================================================================
        // Feature: function-parameter-completions, Property 2: Nested Function Call Resolution
        //
        // For any R code containing nested function calls (e.g., `outer(inner(x))`),
        // when the cursor is inside the inner function's parentheses, the context
        // detector SHALL return the innermost function name.
        //
        // **Validates: Requirements 1.3**
        // ============================================================================

        /// Test that cursor inside the inner function's parentheses returns the
        /// innermost function name, not the outer function name.
        #[test]
        fn prop_nested_call_inner_detected(
            outer_name in r_identifier(),
            inner_name in r_identifier(),
            inner_args in r_arguments(0, 3),
        ) {
            // Ensure outer and inner names differ so we can distinguish them
            prop_assume!(outer_name != inner_name);

            // Build code like: outer(inner(arg1, arg2))
            let inner_args_str = inner_args.join(", ");
            let inner_call = format!("{}({})", inner_name, inner_args_str);
            let code = format!("{}({})", outer_name, inner_call);

            let tree = parse_r(&code);

            // Layout: outer_name ( inner_name ( inner_args ) )
            // Positions:
            //   outer open paren: outer_name.len()
            //   inner_name starts: outer_name.len() + 1
            //   inner open paren: outer_name.len() + 1 + inner_name.len()
            //   inner args start: outer_name.len() + 1 + inner_name.len() + 1
            //   inner close paren: outer_name.len() + 1 + inner_name.len() + 1 + inner_args_str.len()
            let inner_open_paren_col = outer_name.len() + 1 + inner_name.len();
            let inner_close_paren_col = inner_open_paren_col + 1 + inner_args_str.len();

            // Cursor right after the inner opening paren — should detect inner function
            let pos_after_inner_open = Position::new(0, (inner_open_paren_col + 1) as u32);
            let ctx = detect_function_call_context(&tree, &code, pos_after_inner_open);
            prop_assert!(
                ctx.is_some(),
                "Expected context inside inner call at col {} in code: {}",
                inner_open_paren_col + 1,
                code
            );
            let ctx = ctx.unwrap();
            prop_assert_eq!(
                &ctx.function_name,
                &inner_name,
                "Expected inner function '{}' but got '{}' at col {} in code: {}",
                inner_name,
                ctx.function_name,
                inner_open_paren_col + 1,
                code
            );

            // Cursor at the inner closing paren — should still detect inner function
            let pos_at_inner_close = Position::new(0, inner_close_paren_col as u32);
            let ctx_close = detect_function_call_context(&tree, &code, pos_at_inner_close);
            prop_assert!(
                ctx_close.is_some(),
                "Expected context at inner ')' col {} in code: {}",
                inner_close_paren_col,
                code
            );
            prop_assert_eq!(
                &ctx_close.unwrap().function_name,
                &inner_name,
                "Expected inner function at inner ')' in code: {}",
                code
            );
        }

        /// Test that cursor in the outer function's argument list but outside the
        /// inner call's parentheses returns the outer function name.
        #[test]
        fn prop_nested_call_outer_detected_outside_inner(
            outer_name in r_identifier(),
            inner_name in r_identifier(),
            inner_args in r_arguments(0, 3),
        ) {
            // Ensure outer and inner names differ so we can distinguish them
            prop_assume!(outer_name != inner_name);

            // Build code like: outer(inner(arg1, arg2), )
            // The trailing ", " gives us a position inside outer's args but outside inner's parens
            let inner_args_str = inner_args.join(", ");
            let inner_call = format!("{}({})", inner_name, inner_args_str);
            let code = format!("{}({}, )", outer_name, inner_call);

            let tree = parse_r(&code);

            // Layout: outer_name ( inner_call , _ )
            //   outer open paren: outer_name.len()
            //   inner_call ends at: outer_name.len() + 1 + inner_call.len()
            //   comma at: outer_name.len() + 1 + inner_call.len()
            //   space at: outer_name.len() + 1 + inner_call.len() + 1
            //   outer close paren: outer_name.len() + 1 + inner_call.len() + 2
            let after_comma_col = outer_name.len() + 1 + inner_call.len() + 2;

            // Cursor after the comma (in outer's args, outside inner's parens)
            let pos_after_comma = Position::new(0, after_comma_col as u32);
            let ctx = detect_function_call_context(&tree, &code, pos_after_comma);
            prop_assert!(
                ctx.is_some(),
                "Expected outer context after comma at col {} in code: {}",
                after_comma_col,
                code
            );
            prop_assert_eq!(
                &ctx.unwrap().function_name,
                &outer_name,
                "Expected outer function '{}' after comma in code: {}",
                outer_name,
                code
            );
        }

        /// Test deeply nested calls (3 levels): cursor inside the innermost call
        /// returns the innermost function name.
        #[test]
        fn prop_deeply_nested_innermost_detected(
            outer_name in r_identifier(),
            middle_name in r_identifier(),
            inner_name in r_identifier(),
            inner_arg in r_argument_expr(),
        ) {
            // Ensure all three names are distinct
            prop_assume!(outer_name != middle_name);
            prop_assume!(outer_name != inner_name);
            prop_assume!(middle_name != inner_name);

            // Build code like: outer(middle(inner(arg)))
            let code = format!("{}({}({}({})))", outer_name, middle_name, inner_name, inner_arg);

            let tree = parse_r(&code);

            // Compute the position of the inner function's open paren
            // outer_name ( middle_name ( inner_name ( inner_arg ) ) )
            let inner_open_paren_col = outer_name.len() + 1 + middle_name.len() + 1 + inner_name.len();

            // Cursor right after the inner opening paren — should detect innermost function
            let pos = Position::new(0, (inner_open_paren_col + 1) as u32);
            let ctx = detect_function_call_context(&tree, &code, pos);
            prop_assert!(
                ctx.is_some(),
                "Expected innermost context at col {} in code: {}",
                inner_open_paren_col + 1,
                code
            );
            prop_assert_eq!(
                &ctx.unwrap().function_name,
                &inner_name,
                "Expected innermost function '{}' in code: {}",
                inner_name,
                code
            );
        }

        /// Test that cursor inside the inner call at a random valid position
        /// always returns the inner function name.
        #[test]
        fn prop_nested_call_random_position_inside_inner(
            outer_name in r_identifier(),
            inner_name in r_identifier(),
            inner_args in r_arguments(1, 4),
            offset_frac in 0.0f64..1.0f64,
        ) {
            prop_assume!(outer_name != inner_name);

            let inner_args_str = inner_args.join(", ");
            let inner_call = format!("{}({})", inner_name, inner_args_str);
            let code = format!("{}({})", outer_name, inner_call);

            let tree = parse_r(&code);

            // Inner call argument range:
            //   inner open paren col: outer_name.len() + 1 + inner_name.len()
            //   inner args start: inner_open_paren_col + 1
            //   inner args end (before close paren): inner_open_paren_col + 1 + inner_args_str.len()
            let inner_open_paren_col = outer_name.len() + 1 + inner_name.len();
            let min_col = inner_open_paren_col + 1;
            let max_col = inner_open_paren_col + 1 + inner_args_str.len();

            let range = max_col - min_col;
            prop_assume!(range > 0);
            let cursor_col = min_col + ((offset_frac * range as f64) as usize).min(range - 1);

            let pos = Position::new(0, cursor_col as u32);
            let ctx = detect_function_call_context(&tree, &code, pos);
            prop_assert!(
                ctx.is_some(),
                "Expected inner context at col {} in code: {}",
                cursor_col,
                code
            );
            prop_assert_eq!(
                &ctx.unwrap().function_name,
                &inner_name,
                "Expected inner function '{}' at col {} in code: {}",
                inner_name,
                cursor_col,
                code
            );
        }
    }
}
