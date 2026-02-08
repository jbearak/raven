# Implementation Plan: Function Parameter Completions

## Overview

This implementation adds function parameter completions to Raven's LSP. When the cursor is inside a function call, parameter names are added to the standard completion list with `"0-"` sort prefix (highest priority). The work builds incrementally: context detection → parameter extraction → R subprocess integration → completion handler integration → documentation resolve.

## Tasks

- [ ] 1. Create completion context detection module
  - [ ] 1.1 Create `crates/raven/src/completion_context.rs` with `FunctionCallContext` struct and `detect_function_call_context()` function
    - Define `FunctionCallContext` with `function_name`, `namespace`, `existing_params` fields
    - Implement AST walk: find node at cursor, walk up ancestors looking for `call` nodes
    - Handle innermost function call for nested calls
    - Extract namespace from `namespace_operator` nodes (e.g., `dplyr::filter`)
    - Extract already-specified named parameters from argument list (`name = value` patterns)
    - Return `None` if cursor is inside a string literal or outside all function calls
    - Add `pub mod completion_context;` to `lib.rs`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]* 1.2 Write property test for function call context detection
    - **Property 1: Function Call Context Detection**
    - **Validates: Requirements 1.1, 1.2, 1.4**

  - [ ]* 1.3 Write property test for nested function call resolution
    - **Property 2: Nested Function Call Resolution**
    - **Validates: Requirements 1.3**

- [ ] 2. Checkpoint - Ensure context detection tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Implement parameter resolver module
  - [ ] 3.1 Create `crates/raven/src/parameter_resolver.rs` with data structures and AST extraction
    - Define `FunctionSignature`, `ParameterInfo`, `SignatureSource` structs
    - Define `SignatureCache` with `RwLock<LruCache>` for package and user signatures (use `peek()` for reads, `push()` for writes)
    - Implement `extract_from_ast()`: extract params from `formal_parameters` tree-sitter node, including default values and `...` detection
    - Implement `resolve()` (synchronous, may block for package functions) with resolution priority: cache → local AST → cross-file scope → package (R subprocess with 5s timeout on cache miss)
    - Add `pub mod parameter_resolver;` to `lib.rs`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 9.1, 9.4_

  - [ ]* 3.2 Write property test for parameter extraction round-trip
    - **Property 3: Parameter Extraction Round-Trip**
    - **Validates: Requirements 4.1**

  - [ ]* 3.3 Write property test for dots parameter exclusion
    - **Property 5: Dots Parameter Exclusion**
    - **Validates: Requirements 4.4**

- [ ] 4. Extend R subprocess for function formals queries
  - [ ] 4.1 Add `get_function_formals()` method to `RSubprocess` in `r_subprocess.rs`
    - Query R using `formals(func)` or `formals(pkg::func)` with tab-separated output
    - Parse output into `Vec<ParameterInfo>` (name, default_value, is_dots)
    - Validate function and package names against `[a-zA-Z0-9._]` to prevent injection
    - Handle `__RLSP_ERROR__` marker in output
    - Wrap with timeout (reuse existing `execute_r_code_with_timeout`; use 5s timeout for completion-path queries, log timeouts at warn level)
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [ ]* 4.2 Write property test for R subprocess input validation
    - **Property 10: R Subprocess Input Validation**
    - **Validates: Requirements 9.2**

- [ ] 5. Checkpoint - Ensure parameter resolver and R subprocess tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Integrate parameter completions into completion handler
  - [ ] 6.1 Add `SignatureCache` to `WorldState` and initialize in `WorldState::new()`
    - Add `signature_cache: Arc<SignatureCache>` field to `WorldState`
    - Initialize with default capacities (500 package, 200 user)
    - _Requirements: 9.1_

  - [ ] 6.2 Modify `completion()` function in `handlers.rs` and `backend.rs` to support mixed completions
    - Add `SORT_PREFIX_PARAM: &str = "0-"` constant
    - After building standard completions, call `detect_function_call_context()`
    - If inside function call, call `get_parameter_completions()` and prepend results
    - Implement `get_parameter_completions()`: call `resolver.resolve()` (synchronous, may block for package functions), filter dots and already-specified params, format items with `CompletionItemKind::FIELD`, `insert_text = "name = "`, `sort_text = "0-name"`, and `data` field for resolve
    - Update backend.rs `completion()` async wrapper to use `spawn_blocking` for the parameter resolution path: collect standard completions + detect context under read lock (fast), release lock, then run parameter resolution in `spawn_blocking` with cloned Arc references
    - Standard completions remain unchanged (keywords, document symbols, package exports, cross-file symbols)
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 6.3 Write property test for parameter completion formatting
    - **Property 6: Parameter Completion Formatting**
    - **Validates: Requirements 5.1, 5.3, 5.6**

  - [ ]* 6.4 Write property test for already-specified parameter exclusion
    - **Property 7: Already-Specified Parameter Exclusion**
    - **Validates: Requirements 5.5**

  - [ ]* 6.5 Write property test for mixed completions
    - **Property 8: Mixed Completions in Function Call Context**
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 6.6 Write property test for default value preservation
    - **Property 4: Default Value Preservation**
    - **Validates: Requirements 2.3, 4.3, 5.2**

  - [ ]* 6.7 Write property test for cache consistency
    - **Property 9: Cache Consistency**
    - **Validates: Requirements 2.5, 3.4**

- [ ] 7. Checkpoint - Ensure completion integration tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Create roxygen extraction module
  - [ ] 8.1 Create `crates/raven/src/roxygen.rs` with shared roxygen extraction logic
    - Implement `extract_roxygen_block()`: scan backward from function definition line collecting `#'` lines
    - Parse title (first non-tag line), description (lines after title before first tag), and `@param` entries
    - Define `RoxygenBlock` struct with `title`, `description`, `params: HashMap<String, String>`
    - Implement `get_param_doc()` and `get_function_doc()` helper functions
    - Add `pub mod roxygen;` to `lib.rs`
    - _Requirements: 7.3, 8.1, 8.2, 8.3, 8.5_

  - [ ]* 8.2 Write property test for roxygen function documentation extraction
    - **Property 13: Roxygen Function Documentation Extraction**
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [ ] 9. Implement documentation on resolve (parameters and functions)
  - [ ] 9.1 Add `data` field to user-defined function completion items
    - Extend `collect_document_completions` to include `uri` and definition line in `data` for function items
    - Extend cross-file function completion items similarly
    - This must be done first since 9.2 and 9.3 depend on this data being present
    - _Requirements: 8.1_

  - [ ] 9.2 Extend `completion_item_resolve()` in `handlers.rs` for parameter documentation
    - Check for `param_name` in completion item's `data` field
    - For package functions: use `help_cache.get_or_fetch()` to get R help text, then extract `@param` description
    - For user-defined functions: use `uri` and `func_line` from data, call `extract_roxygen_block()`, then `get_param_doc()`
    - Implement `extract_param_description()` for R help text parsing
    - Return item unchanged if no documentation found
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 9.3 Extend `completion_item_resolve()` for user-defined function name documentation
    - Check for `func_line` without `param_name` in data (indicates function name completion)
    - Use `uri` and `func_line`, call `extract_roxygen_block()`, then `get_function_doc()`
    - Return item unchanged if no roxygen block found
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 9.4 Write property test for parameter documentation extraction
    - **Property 11: Parameter Documentation Extraction**
    - **Validates: Requirements 7.2, 7.3**

- [ ] 10. Implement cache invalidation
  - [ ] 10.1 Invalidate user-defined function signatures on file change
    - Hook into `did_change` handler to call `signature_cache.invalidate_file(uri)`
    - Clear all user signatures keyed to the changed file URI (O(n) scan over LRU, acceptable at 200 capacity)
    - _Requirements: 9.2_

  - [ ]* 10.2 Write property test for cache invalidation
    - **Property 12: Cache Invalidation on File Change**
    - **Validates: Requirements 9.2**

- [ ] 11. Implement graceful degradation
  - [ ] 11.1 Handle R subprocess unavailability and unknown functions
    - When R subprocess fails or times out, fall back to AST-based extraction for user-defined functions
    - When function signature cannot be determined at all, return standard completions without parameter suggestions
    - Log R subprocess timeouts at warn level; log other errors at trace level
    - _Requirements: 11.1, 11.2, 11.3_

- [ ] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- Dollar-sign completions are deferred to a follow-up spec
