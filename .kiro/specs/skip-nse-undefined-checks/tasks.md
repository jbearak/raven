# Implementation Plan: Skip NSE Undefined Variable Checks

## Overview

This implementation modifies the undefined variable detection in `handlers.rs` to skip checks in NSE contexts (formulas, call-like arguments) and extract operator RHS. The approach uses context flags during AST traversal, matching Ark's implementation.

## Tasks

- [x] 1. Add UsageContext struct and modify collect_usages function
  - [x] 1.1 Create UsageContext struct with in_formula and in_call_like_arguments flags
    - Add struct definition with Default impl
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2_
  
  - [x] 1.2 Create collect_usages_with_context function
    - Replace collect_usages with context-aware version
    - Pass context through recursive calls
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2_
  
  - [x] 1.3 Add formula detection logic
    - Check for unary_operator with ~ operator
    - Check for binary_operator with ~ operator
    - Set in_formula flag when entering formula nodes
    - _Requirements: 3.1, 3.2_
  
  - [x] 1.4 Add call-like arguments detection logic
    - Detect call, subset, subset2 nodes
    - Set in_call_like_arguments when entering arguments field
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 2. Add extract operator RHS skip logic
  - [x] 2.1 Add parent node check for extract_operator
    - Check if parent is extract_operator node
    - Check if current node is the rhs field
    - Skip identifier if both conditions are true
    - _Requirements: 1.1, 1.2_

- [x] 3. Integrate skip logic into identifier collection
  - [x] 3.1 Add context flag checks to identifier handling
    - Skip if in_formula is true
    - Skip if in_call_like_arguments is true
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2_
  
  - [x] 3.2 Preserve existing skip rules
    - Keep assignment LHS skip logic
    - Keep named argument name skip logic
    - _Requirements: 5.1, 5.2_

- [x] 4. Update callers of collect_usages
  - [x] 4.1 Update collect_undefined_variables_position_aware
    - Replace collect_usages call with collect_usages_with_context
    - Pass default UsageContext
    - _Requirements: 4.1, 4.2_
  
  - [x] 4.2 Update collect_undefined_variables (if still used)
    - Replace collect_usages call with collect_usages_with_context
    - Pass default UsageContext
    - _Requirements: 4.1, 4.2_

- [x] 5. Checkpoint - Verify basic functionality
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Add unit tests for new skip logic
  - [x] 6.1 Add extract operator tests
    - Test df$column - no diagnostic for column
    - Test obj@slot - no diagnostic for slot
    - Test undefined$column - diagnostic for undefined
    - _Requirements: 1.1, 1.2, 1.3_
  
  - [x] 6.2 Add call-like argument tests
    - Test subset(df, x > 5) - no diagnostic for x
    - Test df[x > 5, ] - no diagnostic for x
    - Test df[[x]] - no diagnostic for x
    - Test undefined_func(x) - diagnostic for undefined_func
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  
  - [x] 6.3 Add formula tests
    - Test ~ x - no diagnostic for x
    - Test y ~ x + z - no diagnostic for y, x, z
    - Test lm(y ~ x, data = df) - no diagnostic for y, x
    - _Requirements: 3.1, 3.2, 3.4_
  
  - [x] 6.4 Add edge case tests
    - Test deeply nested formulas
    - Test nested call arguments
    - Test mixed contexts (df$col[x > 5])
    - Test chained extracts (df$a$b$c)
    - _Requirements: 1.1, 1.2, 2.1, 3.1_

- [x] 7. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- The implementation follows Ark's approach of using context flags during traversal
- Extract operator RHS check is done at the identifier level (parent node check) rather than context flag
- All changes are in `crates/rlsp/src/handlers.rs`
- No configuration changes needed - behavior is hardcoded
- Property-based tests are optional for this feature since the logic is straightforward pattern matching
