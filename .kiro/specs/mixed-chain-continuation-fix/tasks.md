# Implementation Plan: Mixed Chain Continuation Indentation Fix

## Overview

This plan fixes incorrect indentation in mixed operator chains by replacing the `is_mixed_chain` fallback with AST-based sub-chain resolution, fixing the column calculation, and adding a test for the reported scenario.

## Tasks

- [x] 1. Add `find_subchain_start` helper and remove `is_mixed_chain`
  - Added `find_subchain_start(outermost, target_class, source) -> Option<u32>` in `crates/raven/src/indentation/context.rs`
  - Drills into LHS spine of `outermost`; when it hits a different-class `binary_operator`, returns `Some(lhs.child(2).start_position().column)` (the RHS column of the cross-class boundary)
  - Returns `None` for single-class chains (no boundary found)
  - Removed the `is_mixed_chain` function — replaced by this helper
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 2. Modify `find_chain_start_from_ast` to use `find_subchain_start`
  - Removed the `is_mixed_chain` check and early `return None`
  - Removed the assignment-parent special case (redundant)
  - For mixed chains: returns `(outermost.start_position().row, sub_chain_col)` — uses outermost's start line (low indent) with sub-chain's column
  - For single-class chains: returns `outermost.start_position()` as before
  - _Requirements: 1.1, 1.2, 1.3, 2.1_

- [x] 3. Fix column calculation for AST node lookup
  - Replaced `let trimmed_end_col = trimmed.len().saturating_sub(1)` with explicit leading-whitespace-aware calculation
  - _Requirements: 3.1, 3.2_

- [x] 4. Add test for mixed chain indentation
  - Added `test_mixed_chain_pipe_then_arithmetic` for the bug report scenario
  - Updated `test_edge_case_mixed_operators_in_chain` expectations to match new sub-chain resolution
  - _Requirements: 1.2_

- [x] 5. Run existing tests and verify no regressions
  - All 310 indentation unit tests pass
  - All 103 integration tests pass (including ggplot mixed-chain tests)
  - Full test suite passes
  - _Requirements: 4.1, 4.2, 4.3_
