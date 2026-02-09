# Implementation Plan: Syntax Error Diagnostic Placement

## Overview

This plan implements the "innermost error detection" strategy to fix syntax error diagnostic placement. The core change is adding a `find_innermost_error` function and modifying `minimize_error_range` to use it before falling back to the first-line strategy.

## Tasks

- [x] 1. Implement the `find_innermost_error` function
  - Add new function in `crates/raven/src/handlers.rs` after `find_first_missing_descendant`
  - Implement depth-first search to find the deepest ERROR node
  - Return `Option<Node>` - Some(innermost) or None if no ERROR found
  - _Requirements: 1.2, 3.2_

- [x] 1.1 Write property test for innermost ERROR selection
  - **Property 2: Innermost ERROR Selection**
  - **Validates: Requirements 1.2**

- [-] 2. Modify `minimize_error_range` to use innermost error detection
  - [x] 2.1 Add Phase 2 logic after MISSING node check
    - Call `find_innermost_error(node)` if no MISSING node found
    - If innermost is single-line, return its full range
    - If innermost is multi-line, return its first line
    - _Requirements: 1.1, 1.2, 1.5_
  
  - [-] 2.2 Keep existing Phase 1 (MISSING) and Phase 3 (fallback) logic
    - Ensure MISSING nodes still take priority
    - Ensure single-line ERROR preservation still works
    - _Requirements: 1.3, 1.4_

- [ ]* 2.3 Write property test for structural parent exclusion
  - **Property 1: Structural Parent Exclusion**
  - **Validates: Requirements 1.1, 1.5**

- [ ]* 2.4 Write property test for MISSING node priority
  - **Property 3: MISSING Node Priority**
  - **Validates: Requirements 1.3**

- [ ] 3. Update existing unit tests
  - [ ] 3.1 Update `incomplete_assignment_range_is_on_first_line` test
    - Change assertion: diagnostic should be on line 1 (not line 0)
    - This test currently expects line 0, but the fix changes it to line 1
    - _Requirements: 1.1, 1.5_
  
  - [ ] 3.2 Verify other existing tests still pass
    - Run `incomplete_assignment_in_block_minimized`
    - Run `incomplete_comparison_in_block_minimized`
    - Run `incomplete_binary_op_in_block_minimized`
    - Run `unclosed_call_in_block_minimized`
    - Run `single_line_error_unchanged`
    - Run `top_level_incomplete_assignment`
    - Run `no_duplicate_diagnostics`
    - Run `genuinely_broken_code_still_reports_error`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ]* 3.3 Write property test for single-line range preservation
  - **Property 4: Single-Line Range Preservation**
  - **Validates: Requirements 1.4**

- [ ]* 3.4 Write property test for diagnostic deduplication
  - **Property 5: Diagnostic Deduplication**
  - **Validates: Requirements 2.1**

- [ ] 4. Add new unit tests for edge cases
  - [ ] 4.1 Add test for multiple errors at same depth
    - Test source-order tie-breaking behavior
    - _Requirements: 3.2_
  
  - [ ] 4.2 Add test for deeply nested ERROR nodes
    - Test that innermost detection works with 3+ levels
    - _Requirements: 1.2_

- [ ]* 4.3 Write property test for source-order tie-breaking
  - **Property 6: Source-Order Tie-Breaking**
  - **Validates: Requirements 3.2**

- [ ]* 4.4 Write property test for MISSING node width
  - **Property 7: MISSING Node Width**
  - **Validates: Requirements 4.2**

- [ ]* 4.5 Write property test for error detection completeness
  - **Property 8: Error Detection Completeness**
  - **Validates: Requirements 4.4**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Run `cargo test -p raven syntax_error_range_tests`
  - Ensure no regressions in other handler tests
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional property-based tests and can be skipped for faster MVP
- The core fix is in tasks 1 and 2 (adding `find_innermost_error` and modifying `minimize_error_range`)
- Task 3.1 is critical - it updates the test that currently expects the wrong behavior
- Property tests should use `proptest` or `quickcheck` with minimum 100 iterations
- Each property test must include a comment tag referencing the design property
