# Implementation Plan: Else Newline Syntax Error Detection

## Overview

This plan implements detection of the R syntax error where `else` appears on a new line after the closing brace of an `if` block. The implementation adds a new diagnostic collector function to `handlers.rs` that traverses the AST and emits diagnostics for this pattern.

## Tasks

- [x] 1. Implement the else-newline detection function
  - [x] 1.1 Create `collect_else_newline_errors` function in `handlers.rs`
    - Add function signature with `node: Node`, `text: &str`, `diagnostics: &mut Vec<Diagnostic>` parameters
    - Implement AST traversal to find `else` keywords
    - For each `else`, find the preceding closing brace and compare line numbers
    - Emit diagnostic if `else` is on a different line than the closing brace
    - Include check to avoid duplicate diagnostics when tree-sitter already marks the node as error
    - _Requirements: 1.1, 1.2, 1.3, 4.2_

  - [x] 1.2 Integrate into diagnostics pipeline
    - Call `collect_else_newline_errors` from the `diagnostics()` function
    - Place after `collect_syntax_errors()` call
    - _Requirements: 4.1_

  - [x] 1.3 Write unit tests for basic patterns
    - Test invalid pattern: `if (x) {y}\nelse {z}` emits diagnostic
    - Test valid pattern: `if (x) {y} else {z}` no diagnostic
    - Test multi-line valid: `if (x) {\n  y\n} else {\n  z\n}` no diagnostic
    - Test multi-line invalid: `if (x) {\n  y\n}\nelse {\n  z\n}` emits diagnostic
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 2. Handle edge cases and nested structures
  - [x] 2.1 Implement nested if-else detection
    - Ensure recursive traversal detects orphaned else at any nesting level
    - _Requirements: 2.5_

  - [x] 2.2 Handle `else if` pattern
    - Detect `}\nelse if` as orphaned else
    - _Requirements: 5.2_

  - [x] 2.3 Handle blank lines between `}` and `else`
    - Ensure multiple blank lines still trigger diagnostic
    - _Requirements: 5.4_

  - [x] 2.4 Write unit tests for edge cases
    - Test nested valid: `if (a) { if (b) {c} else {d} } else {e}` no diagnostic
    - Test nested invalid: `if (a) { if (b) {c}\nelse {d} }` diagnostic for inner else
    - Test `else if` on new line: `if (x) {y}\nelse if (z) {w}` diagnostic emitted
    - Test blank lines: `if (x) {y}\n\nelse {z}` diagnostic emitted
    - Test standalone else (tree-sitter error): no duplicate diagnostic
    - _Requirements: 2.5, 5.1, 5.2, 5.3, 5.4_

- [x] 3. Verify diagnostic properties
  - [x] 3.1 Ensure correct diagnostic severity and message
    - Set severity to `DiagnosticSeverity::ERROR`
    - Set message to "In R, 'else' must appear on the same line as the closing '}' of the if block"
    - _Requirements: 3.1, 3.3, 1.4_

  - [x] 3.2 Ensure correct diagnostic range
    - Range should cover the `else` keyword exactly
    - _Requirements: 3.2_

  - [x] 3.3 Write unit tests for diagnostic properties
    - Test diagnostic severity is ERROR
    - Test diagnostic message contains expected text
    - Test diagnostic range matches else keyword position
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Property-based tests
  - [x] 5.1 Write property test for orphaned else detection
    - **Property 1: Orphaned Else Detection**
    - Generate if-else code with else on new line, verify diagnostic emitted
    - **Validates: Requirements 1.1, 2.1, 2.2**

  - [x] 5.2 Write property test for valid else no diagnostic
    - **Property 2: Valid Else No Diagnostic**
    - Generate valid if-else code, verify no diagnostic emitted
    - **Validates: Requirements 1.2, 1.3, 2.3, 2.4**

  - [x] 5.3 Write property test for diagnostic range accuracy
    - **Property 4: Diagnostic Range Accuracy**
    - For detected diagnostics, verify range matches else position
    - **Validates: Requirements 3.2**

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- All tasks are required for comprehensive test coverage
- The implementation uses Rust and tree-sitter-r for AST parsing
- Tests should be added to the existing `#[cfg(test)]` module in `handlers.rs`
- Property tests use the `proptest` crate following existing patterns in the codebase
