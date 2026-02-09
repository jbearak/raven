# Implementation Plan: Syntax Error Diagnostic Placement

## Overview

This plan implements the "content-line detection" strategy to fix syntax error diagnostic placement. The core changes are adding `find_innermost_error` (which skips leaf ERROR nodes), `find_first_content_line` (which locates the first line with actual content after structural tokens), and modifying `minimize_error_range` to use them.

## Tasks

- [x] 1. Implement the `find_innermost_error` function
  - Add new function in `crates/raven/src/handlers.rs` after `find_first_missing_descendant`
  - Implement depth-first search to find the deepest non-leaf ERROR node
  - Skip leaf ERROR nodes (zero children) — these are typically misplaced tokens like `}`
  - Return `Option<Node>` — Some(innermost non-leaf) or None if no non-leaf ERROR found
  - _Requirements: 1.2, 3.1_

- [x] 1.1 Write property test for structural parent exclusion
  - **Property 1: Structural Parent Exclusion**
  - **Validates: Requirements 1.1, 1.5**

- [x] 2. Implement `find_first_content_line` and modify `minimize_error_range`
  - [x] 2.1 Add `find_first_content_line` function and Phase 2 logic
    - Add `find_first_content_line` to scan ERROR node children for the first content line
    - Skip structural keywords (`if`, `while`, `for`, `function`, `repeat`), punctuation, boolean/null literals, and ERROR children
    - Only consider children AFTER the opening brace `{` line
    - Fall back to brace_line + 1 or start_row if no content found
    - In `minimize_error_range`: call `find_innermost_error`, then `find_first_content_line` for multi-line results
    - _Requirements: 1.1, 1.2, 1.5, 3.2, 3.3, 3.4_

  - [x] 2.2 Keep existing Phase 1 (MISSING) and Phase 3 (fallback) logic
    - Ensure MISSING nodes still take priority
    - Ensure single-line ERROR preservation still works
    - _Requirements: 1.3, 1.4_

- [x] 2.3 Write property test for content line placement
  - **Property 2: Content Line Placement**
  - **Validates: Requirements 1.1, 1.2, 3.2**

- [x] 2.4 Write property test for MISSING node priority
  - **Property 3: MISSING Node Priority**
  - **Validates: Requirements 1.3**

- [x] 3. Update existing unit tests
  - [x] 3.1 Update `incomplete_assignment_range_is_on_first_line` test
    - Changed assertion: diagnostic is now on line 1 (where `x <-` is), not line 0
    - _Requirements: 1.1, 1.5_

  - [x] 3.2 Verify other existing tests still pass
    - Run `incomplete_assignment_in_block_minimized`
    - Run `incomplete_comparison_in_block_minimized`
    - Run `incomplete_binary_op_in_block_minimized`
    - Run `unclosed_call_in_block_minimized`
    - Run `single_line_error_unchanged`
    - Run `top_level_incomplete_assignment`
    - Run `no_duplicate_diagnostics`
    - Run `genuinely_broken_code_still_reports_error`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 3.3 Write property test for single-line range preservation
  - **Property 4: Single-Line Range Preservation**
  - **Validates: Requirements 1.4**

- [x] 3.4 Write property test for diagnostic deduplication
  - **Property 5: Diagnostic Deduplication**
  - **Validates: Requirements 2.1**

- [x] 4. Add new unit tests for edge cases
  - [x] 4.1 Add test for multiple errors at same depth
    - Test that content-line detection picks the first content line
    - _Requirements: 3.2_

  - [x] 4.2 Add test for deeply nested ERROR nodes
    - Test that `find_innermost_error` skips leaf ERROR nodes at depth
    - _Requirements: 1.2, 3.1_

- [x] 4.3 Write property test for leaf ERROR exclusion
  - **Property 6: Leaf ERROR Exclusion**
  - **Validates: Requirements 3.1**

- [x] 4.4 Write property test for MISSING node width
  - **Property 7: MISSING Node Width**
  - **Validates: Requirements 4.2**

- [x] 4.5 Write property test for error detection completeness
  - **Property 8: Error Detection Completeness**
  - **Validates: Requirements 4.4**

- [x] 5. Checkpoint — Ensure all tests pass
  - Run `cargo test -p raven syntax_error_range_tests`
  - Ensure no regressions in other handler tests
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional property-based tests and can be skipped for faster MVP
- The core fix is in tasks 1 and 2 (adding `find_innermost_error`, `find_first_content_line`, and modifying `minimize_error_range`)
- Task 3.1 is already done — the test was updated during task 2 implementation
- Property tests should use `proptest` with minimum 100 iterations
- Each property test must include a comment tag referencing the design property
- The property test from task 1.1 was updated during task 2 to match the content-line strategy
