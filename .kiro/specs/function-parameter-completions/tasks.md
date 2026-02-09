# Implementation Plan: Function Parameter Completions

## Overview

This implementation adds function parameter completions to Raven's LSP. When the cursor is inside a function call, parameter names are added to the standard completion list with `"0-"` sort prefix (highest priority). The work builds incrementally: context detection → parameter extraction → R subprocess integration → completion handler integration → roxygen extraction → documentation resolve → cache invalidation → graceful degradation.

## Tasks

- [ ] 1. Create completion context detection module
  - [ ] 1.1 Create `crates/raven/src/completion_context.rs` with `FunctionCallContext` struct and `detect_function_call_context()` function
    - Define `FunctionCallContext` with `function_name: String`, `namespace: Option<String>`, `is_internal: bool` fields
    - Implement `detect_function_call_context(tree, text, position) -> Option<FunctionCallContext>` using tree-sitter AST walk
    - Implement `find_enclosing_function_call()`: find node at cursor position, walk up ancestors looking for `call` nodes, return innermost match
    - Handle namespace-qualified calls: extract namespace and function name from `namespace_operator` nodes. Check operator text: `::` -> `is_internal = false`, `:::` -> `is_internal = true`
    - Gate on embedded-R scope (R Markdown): return `None` when cursor is outside an R code block
    - Return `None` if cursor is inside a `string` node or outside all function call parentheses
    - Add a bracket-heuristic fallback with FSM for incomplete syntax when AST walk fails. The scanner must:
      - Track **all three bracket types** `()`, `[]`, `{}` for correct nesting depth (only unmatched `(` triggers completions)
      - Be **string-aware**: maintain FSM state for single-quoted, double-quoted, backtick-quoted, and R 4.0+ raw strings (`r"(...)"`, `R"(...)"`, variants with dash delimiters). Ignore brackets inside strings.
      - Be **comment-aware**: when `#` is encountered outside string literals, skip backward to the start of that line (comment extends to end-of-line). Ignore brackets inside comments.
      - Handle **backslash escapes** inside strings (e.g., `\"` does not end a double-quoted string)
      - After finding the unmatched `(`, extract the function name token before it (skipping whitespace, collecting identifier chars including `.` and `::` / `:::` namespace qualifiers)
    - Add `mod completion_context;` to `main.rs`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [ ]* 1.2 Write property test for function call context detection
    - **Property 1: Function Call Context Detection**
    - Generate R code with function calls and random cursor positions; verify context is detected iff cursor is inside argument list
    - **Validates: Requirements 1.1, 1.2, 1.4**

  - [ ]* 1.3 Write property test for nested function call resolution
    - **Property 2: Nested Function Call Resolution**
    - Generate nested function calls; verify innermost function name is returned when cursor is inside inner call's parentheses
    - **Validates: Requirements 1.3**

  - [ ]* 1.4 Write unit test for embedded-R scope gating (R Markdown)
    - Verify parameter completions only appear inside R code blocks, not in markdown text
    - **Validates: Requirements 1.7**

  - [ ]* 1.5 Write unit tests for incomplete-syntax and bracket fallback FSM
    - Verify bracket-heuristic detects call context when parentheses are unbalanced during typing
    - Verify bracket-heuristic handles brackets inside string literals: `f("(", |)` detects `f`, `g(')', |)` detects `g`, `` h(`(`, |) `` detects `h`
    - Verify bracket-heuristic handles escaped quotes inside strings: `f("a\"(b", |)` detects `f`
    - Verify bracket-heuristic handles brackets inside R comments: `f(x, # adjust ( balance\n  |)` detects `f`
    - Verify bracket-heuristic tracks multi-bracket nesting: `df[func(x, |)]` detects `func`, not confused by `[`
    - Verify bracket-heuristic handles R 4.0+ raw strings: `f(r"(hello(world))", |)` detects `f`
    - Verify bracket-heuristic handles cursor at column 0 (edge case: no crash, no false detection)
    - **Validates: Requirements 1.6**

- [ ] 2. Checkpoint - Ensure context detection tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Implement parameter resolver module
  - [ ] 3.1 Create `crates/raven/src/parameter_resolver.rs` with data structures, cache, and AST extraction
    - Define `FunctionSignature` (name, parameters, source), `ParameterInfo` (name, default_value, is_dots), `SignatureSource` enum (RSubprocess, CurrentFile, CrossFile)
    - Define `SignatureCache` with two `RwLock<LruCache>` fields: `package_signatures` (capacity 500) and `user_signatures` (capacity 200)
    - Implement `SignatureCache::new()`, `get_package()`, `get_user()` (use `peek()` for reads), `insert_package()`, `insert_user()` (use `push()` for writes)
    - Implement `SignatureCache::invalidate_file(uri)`: iterate user LRU cache, collect keys matching URI prefix, remove them
    - Implement `ParameterResolver::extract_from_ast()`: extract params from `formal_parameters` tree-sitter node, detect `...` via `dots` node kind (set `is_dots = true`), extract default values from `default_parameter` nodes (do NOT filter out `...`; include it for R-LS parity). The `is_dots` flag is used later to suppress ` = ` in insert text
    - Implement `ParameterResolver::resolve(..., is_internal: bool)` with resolution priority: cache → local AST (nearest in-scope definition before cursor; works for untitled docs) → cross-file scope → package (R subprocess with 5s timeout on cache miss)
    - For package resolution: use scope resolver's position-aware `loaded_packages` + `inherited_packages` to determine which package exports the function at cursor position. If `is_internal` is true, pass `exported_only = false` to R query.
    - Add `mod parameter_resolver;` to `main.rs`
    - _Requirements: 2.1, 2.5, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 9.1, 9.4_

  - [ ]* 3.2 Write property test for parameter extraction round-trip
    - **Property 3: Parameter Extraction Round-Trip**
    - Generate R function definitions with varying parameter counts and defaults; verify extracted parameter names match original formal parameter names in declaration order
    - **Validates: Requirements 4.1**

  - [ ]* 3.3 Write property test for dots parameter inclusion
    - **Property 5: Dots Parameter Inclusion**
    - Generate R functions with `...` parameter; verify dots is included in parameter completions
    - **Validates: Requirements 5.5**

- [ ] 4. Extend R subprocess for function formals queries
  - [ ] 4.1 Add `get_function_formals()` method to `RSubprocess` in `crates/raven/src/r_subprocess.rs`
    - Implement `get_function_formals(function_name, package: Option<&str>, exported_only: bool) -> Result<Vec<ParameterInfo>>`
    - Generate R code that resolves the function object and handles primitives: `fn <- get(...)`; `f <- if (is.primitive(fn)) formals(args(fn)) else formals(fn)`
    - Parse tab-separated output: each line is `name\tdefault\n`; empty string after tab means `default_value = None`
    - Validate function and package names against `[a-zA-Z0-9._]` regex to prevent R code injection (reject names with other characters)
    - Handle `__RLSP_ERROR__` marker in output
    - Use existing `execute_r_code_with_timeout()` with 5s timeout for completion-path queries
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ]* 4.2 Write property test for R subprocess input validation
    - **Property 11: R Subprocess Input Validation**
    - Generate function names with characters outside `[a-zA-Z0-9._]`; verify they are rejected without executing R code
    - **Validates: Requirements 10.2**

- [ ] 5. Checkpoint - Ensure parameter resolver and R subprocess tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Integrate parameter completions into completion handler
  - [ ] 6.1 Add `SignatureCache` to `WorldState` in `crates/raven/src/state.rs`
    - Add `pub signature_cache: Arc<SignatureCache>` field to `WorldState`
    - Initialize with default capacities (500 package, 200 user) in `WorldState::new()`
    - _Requirements: 9.1_

  - [ ] 6.2 Modify `completion()` in `crates/raven/src/handlers.rs` and `backend.rs` to add mixed parameter completions
    - Add `const SORT_PREFIX_PARAM: &str = "0-";` constant alongside existing sort prefix constants
    - After building standard completions, call `detect_function_call_context(tree, &text, position)`
    - If inside function call, call `get_parameter_completions()` and prepend parameter items to the completion list
    - Suppress parameter completions when the current token is namespace-qualified (`::`/`:::`), matching R-LS
    - Respect embedded-R scope gating (R Markdown): no parameter completions outside R code blocks
    - Implement `get_parameter_completions()`:
      - Call `resolver.resolve()`
      - Handle `base::options()` special case: if function is `options` and package is `base` (or inferred as base), add `names(.Options)` to parameter list
      - Filter params using case-insensitive substring matching against the current token (R-LS behavior). Matching must be literal (not regex) — use simple `str::contains` on lowercased strings, NOT regex, to ensure `.` in identifiers like `na.rm` matches literally
      - Include `...` parameters (no exclusion)
      - Format each as `CompletionItem` with `kind = VARIABLE`, `insert_text_format = InsertTextFormat::PLAIN_TEXT`, `insert_text = "name = "` for regular params or `insert_text = "..."` for dots (no ` = ` for `...`), `sort_text = "0-{index}-name"` (preserving definition order), `detail = "parameter"` (optionally `parameter = default`), and `data` JSON with `type = "parameter"`, `param_name`, `function_name`, `package`/`uri`+`func_line`
    - Gate parameter completions when inside special-case function calls: if the function is `library` or `require` (and an installed-packages completion handler exists), skip parameter completions to match R-LS behavior
    - Ensure token detection (checking for `::` or `:::` accessor) happens BEFORE call detection — if accessor is present, skip call detection entirely (R-LS ordering)
    - Update `backend.rs` `completion()` async wrapper: collect standard completions + detect context under WorldState read lock (fast), release lock, then run parameter resolution in `tokio::task::spawn_blocking` with cloned `Arc<SignatureCache>` and `Arc<PackageLibrary>` references
    - Standard completions remain unchanged when not in function call context
    - _Requirements: 2.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 6.3 Write property test for parameter completion formatting
    - **Property 6: Parameter Completion Formatting**
    - For any parameter completion item, verify `kind = VARIABLE`, `insert_text_format = PLAIN_TEXT`, `sort_text` starts with `0-` followed by digits; for non-dots params `insert_text` ends with ` = `; for `...` param `insert_text` equals `"..."` (no ` = `)
    - **Validates: Requirements 5.1, 5.3, 5.6, 5.7**

  - [ ]* 6.4 Write property test for case-insensitive substring matching
    - **Property 7: Case-Insensitive Substring Matching**
    - Generate tokens with different casing; verify matching is case-insensitive and substring-based
    - **Validates: Requirements 5.4**

  - [ ]* 6.5 Write property test for namespace-qualified token suppression
    - **Property 8: Namespace-Qualified Token Suppression**
    - Verify parameter completions are suppressed when the current token includes `::` or `:::`
    - **Validates: Requirements 6.5**

  - [ ]* 6.6 Write property test for mixed completions
    - **Property 9: Mixed Completions in Function Call Context**
    - Verify completion list contains both parameter items (with `"0-"` prefix) and standard items (keywords, variables, package exports)
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 6.7 Write property test for default value preservation
    - **Property 4: Default Value Preservation**
    - Generate functions with default values; if defaults are included, verify completion item detail field contains the default value string
    - **Validates: Requirements 2.3, 4.3, 5.2**

  - [ ]* 6.8 Write property test for cache consistency
    - **Property 10: Cache Consistency**
    - Insert a signature into cache, then look it up; verify the cached signature is returned without invoking R subprocess
    - **Validates: Requirements 2.5, 3.4**

- [ ] 7. Checkpoint - Ensure completion integration tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Create roxygen extraction module
  - [ ] 8.1 Create `crates/raven/src/roxygen.rs` with shared roxygen extraction logic
    - Define `RoxygenBlock` struct with `title: Option<String>`, `description: Option<String>`, `params: HashMap<String, String>`
    - Add `fallback: Option<String>` for plain-comment documentation when no roxygen tags are present
    - Implement `extract_roxygen_block(text, func_line) -> Option<RoxygenBlock>`: scan backward from function definition line collecting consecutive comment lines (`#'` preferred; plain `#` fallback)
    - Parse title (first non-tag line), description (lines after title before first tag or blank line), and `@param name description` entries (including multi-line continuation per roxygen2 semantics)
    - If no roxygen tags are present, populate `fallback` with plain comment text converted to markdown
    - Implement `get_param_doc(block, param_name) -> Option<String>` and `get_function_doc(block) -> Option<String>` helpers
    - Add `mod roxygen;` to `main.rs`
    - _Requirements: 7.3, 8.1, 8.2, 8.3, 8.5_

  - [ ]* 8.2 Write property test for roxygen function documentation extraction
    - **Property 14: Roxygen Function Documentation Extraction**
    - Generate roxygen blocks with title, description, and @param tags; verify extraction returns correct title and description
    - **Validates: Requirements 8.1, 8.2, 8.3**

- [ ] 9. Implement documentation on resolve (parameters and functions)
  - [ ] 9.1 Extend help subsystem to expose structured argument docs from Rd
    - Add helper (e.g., `help::get_arguments(topic, package)`) that parses Rd `\\arguments` into `HashMap<String, String>`
    - Cache argument maps alongside existing help cache to avoid repeated R subprocess calls
    - _Requirements: 7.2_

  - [ ] 9.2 Add `data` field to user-defined function completion items in `crates/raven/src/handlers.rs`
    - Extend `collect_document_completions` to include `type = "user_function"`, `uri`, and definition line in `data` JSON for items with `CompletionItemKind::FUNCTION`
    - Extend cross-file function completion items similarly (items from sourced files)
    - This data enables `completionItem/resolve` to locate the roxygen block for documentation
    - _Requirements: 8.1_

  - [ ] 9.3 Extend `completion_item_resolve()` in `crates/raven/src/handlers.rs` for parameter documentation
    - Add dispatch logic: check for `type == "parameter"` in completion item's `data` field
    - For package functions (has `package` in data): use structured Rd arguments from the help subsystem to resolve parameter docs (not raw help text)
    - For user-defined functions (has `uri` + `func_line` in data): read file content, call `extract_roxygen_block()`, then `get_param_doc()`
    - Return item unchanged if no documentation found
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 9.4 Extend `completion_item_resolve()` for user-defined function name documentation
    - Add dispatch: check for `type == "user_function"` in data
    - Use `uri` and `func_line`, call `extract_roxygen_block()`, then `get_function_doc()` to get title/description (or fallback text)
    - Return item unchanged if no roxygen block found
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 9.5 Write property test for parameter documentation extraction
    - **Property 12: Parameter Documentation Extraction**
    - Generate Rd arguments and roxygen blocks with `@param` entries; verify correct description is extracted for specified parameter name
    - **Validates: Requirements 7.2, 7.3**

- [ ] 10. Checkpoint - Ensure documentation resolve tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement cache invalidation and graceful degradation
  - [ ] 11.1 Hook cache invalidation into `did_change` handler
    - In `did_change` handler in `backend.rs` or `handlers.rs`, call `signature_cache.invalidate_file(uri)` when a file changes
    - This clears all user-defined function signatures keyed to the changed file URI
    - _Requirements: 9.2_

  - [ ]* 11.2 Write property test for cache invalidation
    - **Property 13: Cache Invalidation on File Change**
    - Insert user-defined signatures for a file, invalidate that file, verify subsequent lookups return None
    - **Validates: Requirements 9.2**

  - [ ] 11.3 Implement graceful degradation for R subprocess failures
    - When R subprocess fails or times out for a package function, fall back to AST-based extraction if the function is user-defined; otherwise return standard completions without parameter suggestions
    - When function signature cannot be determined at all, return standard completions only (no parameter items)
    - Log R subprocess timeouts at warn level; log other errors (parse failures, missing functions) at trace level
    - _Requirements: 11.1, 11.2, 11.3_

- [ ] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `proptest` crate (minimum 100 iterations each)
- Module declarations go in `main.rs` (not `lib.rs`) per the existing project structure
- Dollar-sign completions and pipe operator argument exclusion are out of scope (see requirements.md)
