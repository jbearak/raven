# Requirements Document

## Introduction

This feature addresses a missing diagnostic in the Raven R language server for a common R syntax error: placing `else` on a new line after the closing brace of an `if` block.

In R, the `else` keyword must appear on the same line as the closing brace of the preceding `if` block. When `else` appears on a new line, R considers the `if` statement complete and treats `else` as an unexpected token, resulting in a syntax error.

**Problem**: Currently, Raven does NOT emit an error for this invalid syntax pattern. The tree-sitter-r parser may not mark this as an error node, so Raven needs to detect this pattern explicitly and emit a diagnostic.

**Examples**:

INVALID (should emit diagnostic):
```r
if (1 == 1) {print(2)}
else {print(3)}
```

VALID (no diagnostic):
```r
if (1 == 1) {print(2)} else {print(3)}

# Also valid - else on same line as closing brace
if (1 == 1) {
  print(2)
} else {
  print(3)
}
```

## Glossary

- **Else_Newline_Detector**: The component that detects when `else` appears on a new line after a closing brace from an `if` block.
- **Syntax_Error_Collector**: The existing component that reports syntax/parse errors from tree-sitter.
- **If_Statement**: A tree-sitter node representing an R `if` statement, which may or may not include an `else` clause.
- **Orphaned_Else**: An `else` keyword that appears on a new line after a closing brace, making it syntactically disconnected from the preceding `if` statement.

## Requirements

### Requirement 1: Detect Orphaned Else on New Line

**User Story:** As a developer, I want the LSP to detect when `else` appears on a new line after a closing brace, so that I receive immediate feedback about this common R syntax error.

#### Acceptance Criteria

1. If the Else_Newline_Detector encounters an `else` keyword that starts on a different line than the closing brace of the preceding `if` block, THE Else_Newline_Detector SHALL emit a diagnostic.
2. In cases where the Else_Newline_Detector encounters `else` on the same line as the closing brace of the preceding `if` block, THE Else_Newline_Detector SHALL NOT emit a diagnostic.
3. For code containing a valid `if-else` statement where `else` immediately follows `}` on the same line, THE Else_Newline_Detector SHALL NOT emit a diagnostic.
4. THE diagnostic message SHALL clearly indicate that `else` must appear on the same line as the closing brace.

### Requirement 2: Handle Various Code Patterns

**User Story:** As a developer, I want the detection to work correctly across different code formatting styles, so that I get accurate diagnostics regardless of how my code is formatted.

#### Acceptance Criteria

1. WHEN the code contains `if (cond) {body}\nelse {body2}` (else on new line), THE Else_Newline_Detector SHALL emit a diagnostic.
2. WHEN the code contains `if (cond) {\n  body\n}\nelse {\n  body2\n}` (multi-line if with else on new line after brace), THE Else_Newline_Detector SHALL emit a diagnostic.
3. WHEN the code contains `if (cond) {body} else {body2}` (single line), THE Else_Newline_Detector SHALL NOT emit a diagnostic.
4. WHEN the code contains `if (cond) {\n  body\n} else {\n  body2\n}` (multi-line with else on same line as brace), THE Else_Newline_Detector SHALL NOT emit a diagnostic.
5. WHEN the code contains nested if-else statements, THE Else_Newline_Detector SHALL correctly detect orphaned else at any nesting level.

### Requirement 3: Diagnostic Properties

**User Story:** As a developer, I want the diagnostic to have appropriate severity and positioning, so that it integrates well with my editor's error display.

#### Acceptance Criteria

1. THE diagnostic severity SHALL be ERROR (DiagnosticSeverity::ERROR).
2. THE diagnostic range SHALL highlight the `else` keyword.
3. THE diagnostic message SHALL be descriptive, such as "In R, 'else' must appear on the same line as the closing '}' of the if block".
4. THE diagnostic SHALL include a code or source identifier indicating it comes from Raven's syntax checker.

### Requirement 4: Integration with Existing Diagnostics

**User Story:** As a developer, I want this new diagnostic to work alongside existing diagnostics without conflicts or duplicates.

#### Acceptance Criteria

1. THE Else_Newline_Detector SHALL be called as part of the existing diagnostics collection in `handlers.rs`.
2. IF tree-sitter already reports an error for the same `else` token, THE Else_Newline_Detector SHALL NOT emit a duplicate diagnostic.
3. THE Else_Newline_Detector SHALL NOT interfere with other diagnostic collectors (undefined variables, missing files, etc.).

### Requirement 5: Edge Cases

**User Story:** As a developer, I want the detection to handle edge cases correctly, so that I don't receive false positives or miss real errors.

#### Acceptance Criteria

1. WHEN `else` appears without any preceding `if` statement, THE Else_Newline_Detector SHALL NOT emit the newline-specific diagnostic (tree-sitter handles this as a general syntax error).
2. WHEN `else if` appears on a new line after a closing brace, THE Else_Newline_Detector SHALL emit a diagnostic for the orphaned `else`.
3. WHEN there are comments between `}` and `else` on the same line, THE Else_Newline_Detector SHALL NOT emit a diagnostic if `else` is still on the same line as `}`.
4. WHEN there are blank lines between `}` and `else`, THE Else_Newline_Detector SHALL emit a diagnostic.
