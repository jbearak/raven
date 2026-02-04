# Design Document: Else Newline Syntax Error Detection

## Overview

This design describes the implementation of a diagnostic detector for the common R syntax error where `else` appears on a new line after the closing brace of an `if` block. In R, this is invalid because the parser considers the `if` statement complete when it encounters the newline, treating the subsequent `else` as an unexpected token.

The detector will be implemented as a new function in `handlers.rs` that traverses the AST looking for this specific pattern and emits appropriate diagnostics.

## Architecture

The solution integrates into the existing diagnostics pipeline in `handlers.rs`:

```text
┌─────────────────────────────────────────────────────────────────┐
│                    diagnostics() function                        │
├─────────────────────────────────────────────────────────────────┤
│  1. collect_syntax_errors()          (existing)                  │
│  2. collect_else_newline_errors()    (NEW)                       │
│  3. collect_circular_dependency()    (existing)                  │
│  4. collect_missing_file_diagnostics (existing)                  │
│  5. collect_undefined_variables()    (existing)                  │
│  ...                                                             │
└─────────────────────────────────────────────────────────────────┘
```

The new `collect_else_newline_errors()` function will:
1. Traverse the AST looking for `else` keywords
2. For each `else`, check if it's on a different line than the preceding `}`
3. Emit a diagnostic if the pattern is detected

## Components and Interfaces

### New Function: `collect_else_newline_errors`

```rust
/// Detect and report diagnostics for `else` keywords that appear on a new line
/// after the closing brace of an `if` block.
///
/// In R, `else` must appear on the same line as the closing `}` of the `if` block.
/// When `else` is on a new line, R treats the `if` as complete and `else` becomes
/// an unexpected token.
///
/// # Arguments
/// * `node` - The root AST node to traverse
/// * `text` - The source text for extracting node content
/// * `diagnostics` - Vector to append diagnostics to
///
/// # Examples
///
/// Invalid (emits diagnostic):
/// ```r
/// if (cond) { body }
/// else { body2 }
/// ```
///
/// Valid (no diagnostic):
/// ```r
/// if (cond) { body } else { body2 }
/// ```
fn collect_else_newline_errors(
    node: Node,
    text: &str,
    diagnostics: &mut Vec<Diagnostic>,
);
```

### Detection Algorithm

The algorithm works by finding `else` keywords and checking their relationship to the preceding closing brace:

```text
Algorithm: Detect Orphaned Else

1. Traverse AST recursively
2. For each node:
   a. If node is "else" keyword:
      - Find the preceding sibling that ends with "}"
      - Get the line number of the closing "}"
      - Get the line number of the "else" keyword
      - If else_line > brace_line: emit diagnostic
   b. Recurse into children
```

### AST Structure Analysis

Tree-sitter-r parses if-else statements with the following structure:

Valid if-else (same line):
```text
(if_statement
  condition: (...)
  consequence: (brace_list ...)
  alternative: (else_clause
    body: (brace_list ...)))
```

Invalid else on newline - tree-sitter may parse this as:
```text
(program
  (if_statement
    condition: (...)
    consequence: (brace_list ...))
  (ERROR
    (identifier)))  ; "else" parsed as error or identifier
```

OR tree-sitter might still parse it as an if_statement but with the else on a different line. We need to handle both cases:

1. **Case 1**: Tree-sitter marks `else` as ERROR node - already handled by `collect_syntax_errors()`
2. **Case 2**: Tree-sitter parses it as valid if_statement - we need to check line positions

### Integration Point

The function will be called from `diagnostics()` in `handlers.rs`:

```rust
pub fn diagnostics(state: &WorldState, uri: &Url) -> Vec<Diagnostic> {
    // ... existing code ...
    
    // Collect syntax errors (existing)
    collect_syntax_errors(tree.root_node(), &mut diagnostics);
    
    // NEW: Collect else-on-newline errors
    collect_else_newline_errors(tree.root_node(), &text, &mut diagnostics);
    
    // ... rest of existing code ...
}
```

## Data Models

### Diagnostic Output

The diagnostic will have the following properties:

| Property | Value |
|----------|-------|
| severity | `DiagnosticSeverity::ERROR` |
| range | Start and end position of the `else` keyword |
| message | "In R, 'else' must appear on the same line as the closing '}' of the if block" |
| source | "raven" (optional) |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Orphaned Else Detection

*For any* R code where an `else` keyword starts on a different line than the closing `}` of the preceding `if` block, the detector SHALL emit exactly one diagnostic for that `else`.

**Validates: Requirements 1.1, 2.1, 2.2**

### Property 2: Valid Else No Diagnostic

*For any* R code where an `else` keyword appears on the same line as the closing `}` of the preceding `if` block, the detector SHALL NOT emit a diagnostic for that `else`.

**Validates: Requirements 1.2, 1.3, 2.3, 2.4**

### Property 3: Nested Detection

*For any* nested if-else structure with an orphaned `else` at any nesting level, the detector SHALL correctly identify and emit a diagnostic for each orphaned `else`.

**Validates: Requirements 2.5**

### Property 4: Diagnostic Range Accuracy

*For any* detected orphaned `else`, the diagnostic range SHALL start at the beginning of the `else` keyword and end at the end of the `else` keyword.

**Validates: Requirements 3.2**

### Property 5: No Duplicate Diagnostics

*For any* `else` token that is already marked as an ERROR node by tree-sitter, the detector SHALL NOT emit an additional diagnostic for that token.

**Validates: Requirements 4.2**

## Error Handling

### Edge Cases

1. **Standalone `else`**: When `else` appears without any preceding `if` statement, tree-sitter will mark it as an error. The detector should not emit a duplicate diagnostic.

2. **Comments between `}` and `else`**: If comments appear between `}` and `else` but both are on the same line, no diagnostic should be emitted.

3. **`else if` on new line**: The pattern `}\nelse if` should trigger a diagnostic for the orphaned `else`.

4. **Empty files or parse failures**: If the document has no tree or parsing failed, return early without diagnostics.

### Error Recovery

The detector should be defensive:
- Check for null/missing nodes before accessing properties
- Handle malformed AST gracefully by skipping problematic nodes
- Never panic; log warnings for unexpected AST structures

## Testing Strategy

### Unit Tests

Unit tests will cover specific examples:

1. **Basic invalid pattern**: `if (x) {y}\nelse {z}` → diagnostic emitted
2. **Basic valid pattern**: `if (x) {y} else {z}` → no diagnostic
3. **Multi-line valid**: `if (x) {\n  y\n} else {\n  z\n}` → no diagnostic
4. **Multi-line invalid**: `if (x) {\n  y\n}\nelse {\n  z\n}` → diagnostic emitted
5. **Nested valid**: `if (a) { if (b) {c} else {d} } else {e}` → no diagnostic
6. **Nested invalid**: `if (a) { if (b) {c}\nelse {d} }` → diagnostic for inner else
7. **`else if` on new line**: `if (x) {y}\nelse if (z) {w}` → diagnostic emitted
8. **Blank lines**: `if (x) {y}\n\nelse {z}` → diagnostic emitted
9. **Comments same line**: `if (x) {y} # comment\nelse {z}` → diagnostic emitted (else on new line)
10. **Diagnostic message content**: Verify message contains expected text
11. **Diagnostic severity**: Verify severity is ERROR
12. **Diagnostic range**: Verify range covers `else` keyword

### Property-Based Tests

Property tests will use generated R code to verify properties hold across many inputs:

1. **Property 1 test**: Generate if-else code with else on new line, verify diagnostic count
2. **Property 2 test**: Generate valid if-else code, verify no diagnostics
3. **Property 3 test**: Generate nested if-else with orphaned else, verify all detected
4. **Property 4 test**: For detected diagnostics, verify range matches else position
5. **Property 5 test**: For code where tree-sitter marks else as error, verify no duplicate

### Test Configuration

- Property tests: minimum 100 iterations
- Each property test tagged with: `Feature: else-newline-syntax-error, Property N: {property_text}`

### Test File Location

Tests will be added to `crates/raven/src/handlers.rs` in the existing `#[cfg(test)]` module, following the project's testing patterns.

