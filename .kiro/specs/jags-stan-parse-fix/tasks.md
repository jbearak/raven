# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** — JAGS/Stan files have None tree
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate `parse_document` returns `None` for JAGS/Stan file types
  - **Scoped PBT Approach**: Use `proptest` with `jags_stan_extension_strategy` (already in `state_tests.rs`) to generate JAGS/Stan file types; for each, create a `Document` and assert `doc.tree.is_some()`
  - Write a property-based test in `crates/raven/src/state_tests.rs` that:
    - Generates arbitrary text content and a JAGS or Stan `FileType`
    - Calls `parse_document(contents, file_type)` (or creates a `Document` with that file type)
    - Asserts the result is `Some(Tree)` (i.e., `tree.is_some()`)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS — `parse_document` returns `None` for `FileType::Jags` and `FileType::Stan`, confirming the bug
  - Document counterexamples: e.g., `parse_document(Rope::from("x <- 1"), FileType::Jags)` returns `None`
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** — R parsing, diagnostics suppression, and completion filtering unchanged
  - **IMPORTANT**: Follow observation-first methodology — observe behavior on UNFIXED code, then write tests capturing it
  - Write property-based tests in `crates/raven/src/state_tests.rs` that:
    - **R parsing preservation**: Generate random R code strings with `FileType::R`, verify `parse_document` returns `Some(Tree)` with consistent root node structure (same as current behavior)
    - **Diagnostics suppression**: Create JAGS/Stan `Document` instances, verify diagnostics collection returns empty (suppression is independent of `parse_document` — checked via `file_type != FileType::R` in `diagnostics_from_snapshot`)
    - **Completion filtering**: Create JAGS/Stan `Document` instances, verify completion returns language-specific items (JAGS builtins for `.jags`, Stan builtins for `.stan`) — filtering is via `doc.file_type` match, independent of `parse_document`
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS — these behaviors are already correct and independent of the bug
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix: Route JAGS/Stan files through `parse_r` in `parse_document`

  - [x] 3.1 Implement the fix
    - Change the match arm in `parse_document` (`crates/raven/src/state.rs`) from `FileType::Jags | FileType::Stan => None` to `FileType::R | FileType::Jags | FileType::Stan => parse_r(contents)`
    - Remove the now-stale comment about text-based routing
    - This is a one-line change in the match expression
    - _Bug_Condition: isBugCondition(input) where input.fileType IN [FileType::Jags, FileType::Stan]_
    - _Expected_Behavior: parse_document returns Some(Tree) for all FileType variants by calling parse_r(contents)_
    - _Preservation: R file parsing, diagnostics suppression, completion filtering, workspace indexing all unchanged (they check FileType independently)_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** — JAGS/Stan files now receive a tree-sitter AST
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 asserts `parse_document` returns `Some(Tree)` for JAGS/Stan file types
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** — R parsing, diagnostics suppression, and completion filtering unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm R file parsing, diagnostics suppression, and completion filtering are all unaffected by the fix

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `cargo test -p raven` to verify all existing and new tests pass
  - Ensure no regressions in the broader test suite
  - Ask the user if questions arise
