# Implementation Plan: R Smart Indentation

## Overview

This implementation plan breaks down the R smart indentation feature into discrete coding tasks. The feature uses a two-tier architecture: Tier 1 provides declarative regex-based rules in VS Code's language configuration (always-on), and Tier 2 provides AST-aware indentation through LSP onTypeFormatting (opt-in). Tasks are organized to build incrementally, with testing integrated throughout.

## Tasks

- [x] 1. Implement Tier 1 declarative indentation rules
  - Update `editors/vscode/language-configuration.json` with enhanced indentationRules and new onEnterRules
  - Add patterns for pipe operators (`|>`, `%>%`), binary operators (`+`, `~`), custom infix operators (`%word%`)
  - Add patterns for bracket indentation (`{`, `(`, `[`) and de-indentation (`}`, `)`)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4_

- [x] 2. Set up indentation module structure
  - Create `crates/raven/src/indentation/mod.rs` module
  - Create `crates/raven/src/indentation/context.rs` for context detection
  - Create `crates/raven/src/indentation/calculator.rs` for indentation calculation
  - Create `crates/raven/src/indentation/formatter.rs` for TextEdit generation
  - Define core types: `IndentContext`, `IndentationConfig`, `IndentationStyle`, `OperatorType`
  - _Requirements: 3.1, 4.1, 6.1, 7.1_

- [x] 3. Implement context detection
  - [x] 3.1 Implement AST node detection for operators and structures
    - Write functions to identify `pipe_operator`, `special_operator`, `binary_operator` nodes
    - Write functions to identify `call`, `arguments`, and `brace_list` nodes
    - Handle tree-sitter node traversal and parent walking
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 3.2 Write property test for AST node detection
    - **Property 15: AST Node Detection**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5**

  - [x] 3.3 Implement chain start detection algorithm
    - Write `ChainWalker` struct with `find_chain_start` method
    - Walk backward through operator-terminated lines to find chain start
    - Implement iteration limit to prevent infinite loops
    - _Requirements: 3.1_

  - [x] 3.4 Write property test for chain start detection
    - **Property 1: Chain Start Detection**
    - **Validates: Requirements 3.1**

  - [x] 3.5 Implement context detection for all scenarios
    - Detect `InsideParens` context with opener position and content check
    - Detect `InsideBraces` context with opener position
    - Detect `AfterContinuationOperator` context with chain start
    - Detect `AfterCompleteExpression` context with enclosing block indent
    - Detect `ClosingDelimiter` context with matching opener
    - _Requirements: 3.1, 4.1, 5.1, 5.2_

  - [x] 3.6 Write property test for nested context priority
    - **Property 16: Nested Context Priority**
    - **Validates: Requirements 3.4, 10.1, 10.2, 10.3**

  - [x] 3.7 Write unit tests for context detection edge cases
    - Test empty lines, comments, EOF
    - Test invalid AST and missing nodes
    - Test unclosed and mismatched delimiters
    - _Requirements: 3.1, 10.3_

- [x] 4. Checkpoint - Ensure context detection tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement indentation calculation
  - [x] 5.1 Implement calculation for pipe chain continuation
    - Calculate indentation as chain_start_col + tab_size
    - Ensure all continuation lines get same indentation (straight mode)
    - _Requirements: 3.2, 3.3_

  - [x] 5.2 Write property tests for pipe chain indentation
    - **Property 2: Pipe Chain Indentation Calculation**
    - **Property 3: Uniform Continuation Indentation**
    - **Validates: Requirements 3.2, 3.3**

  - [x] 5.3 Implement calculation for function argument alignment
    - RStudio style: same-line args align to opener_col + 1, next-line args indent from function line
    - RStudio-minus style: all args indent from previous line + tab_size
    - Handle brace blocks: indent from brace line + tab_size
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 5.4 Write property tests for argument alignment
    - **Property 4: Same-Line Argument Alignment (RStudio Style)**
    - **Property 5: Next-Line Argument Indentation**
    - **Property 6: RStudio-Minus Style Indentation**
    - **Property 7: Brace Block Indentation**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [x] 5.5 Implement calculation for de-indentation
    - Closing delimiter: align to opener line indentation
    - Complete expression: return to enclosing block indentation
    - _Requirements: 5.1, 5.2_

  - [x] 5.6 Write property tests for de-indentation
    - **Property 8: Closing Delimiter Alignment**
    - **Property 9: Complete Expression De-indentation**
    - **Validates: Requirements 5.1, 5.2**

  - [x] 5.7 Implement helper functions
    - `get_line_indent`: count leading whitespace on specified line
    - `find_matching_opener`: find matching opening delimiter
    - Handle error cases: invalid positions, missing openers
    - _Requirements: 5.1, 5.2_

  - [x] 5.8 Write unit tests for calculation edge cases
    - Test column 0, very large indentation
    - Test missing openers, invalid positions
    - Test configuration defaults
    - _Requirements: 4.1, 5.1, 6.1_

- [x] 6. Checkpoint - Ensure indentation calculation tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement style formatter
  - [x] 7.1 Implement whitespace generation
    - Generate spaces when insert_spaces is true
    - Generate tabs (with trailing spaces for alignment) when insert_spaces is false
    - Respect tab_size for tab/space calculation
    - _Requirements: 6.3, 6.4_

  - [x] 7.2 Write property test for whitespace character generation
    - **Property 11: Whitespace Character Generation**
    - **Validates: Requirements 6.3, 6.4**

  - [x] 7.3 Implement TextEdit generation
    - Calculate existing whitespace length on target line
    - Create TextEdit with range from (line, 0) to (line, existing_ws_length)
    - Set new_text to generated whitespace
    - _Requirements: 6.5_

  - [x] 7.4 Write property test for TextEdit range replacement
    - **Property 12: TextEdit Range Replacement**
    - **Validates: Requirements 6.5**

  - [x] 7.5 Write unit tests for formatter
    - Test space generation with various tab_size values
    - Test tab generation with mixed tabs+spaces
    - Test TextEdit range calculation with existing whitespace
    - _Requirements: 6.3, 6.4, 6.5_

- [x] 8. Implement configuration management
  - [x] 8.1 Extend Config struct with indentation_style field
    - Add `indentation_style: IndentationStyle` to `Config` struct in `crates/raven/src/config.rs`
    - Implement parsing from LSP config JSON
    - Default to RStudio style if not configured or invalid
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 8.2 Write unit test for configuration defaults
    - Test that missing config defaults to RStudio style
    - _Requirements: 7.4_

  - [x] 8.3 Add VS Code settings schema
    - Update `editors/vscode/package.json` with `raven.indentation.style` configuration
    - Define enum values: "rstudio", "rstudio-minus"
    - Set default to "rstudio"
    - Add description explaining the difference
    - _Requirements: 7.1_

  - [x] 8.4 Write property test for style configuration behavior
    - **Property 13: Style Configuration Behavior**
    - **Validates: Requirements 7.2, 7.3**

- [x] 9. Implement LSP onTypeFormatting handler
  - [x] 9.1 Create handler module and register capability
    - Create `crates/raven/src/handlers/on_type_formatting.rs`
    - Implement `on_type_formatting_capability()` returning OnTypeFormattingOptions with trigger "\n"
    - Register capability in server initialization
    - _Requirements: 8.1_

  - [x] 9.2 Write unit test for capability registration
    - Test that server capabilities include onTypeFormatting with trigger "\n"
    - _Requirements: 8.1_

  - [x] 9.3 Implement onTypeFormatting request handler
    - Extract FormattingOptions (tab_size, insert_spaces) from request params
    - Get document text and tree-sitter AST from state
    - Call context detector with AST and cursor position
    - Call indentation calculator with context and config
    - Call style formatter to generate TextEdit
    - Return Vec<TextEdit> in LSP response
    - _Requirements: 6.1, 6.2, 8.3, 8.4_

  - [x] 9.4 Write property test for FormattingOptions respect
    - **Property 10: FormattingOptions Respect**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 9.5 Write property test for TextEdit response structure
    - **Property 14: TextEdit Response Structure**
    - **Validates: Requirements 8.4**

  - [x] 9.6 Implement error handling
    - Handle invalid AST states with fallback to regex-based detection
    - Handle UTF-16 to byte offset conversion errors
    - Handle malformed FormattingOptions with safe defaults (clamp tab_size to 1-8, default insert_spaces to true)
    - Handle chain start detection infinite loop with iteration limit
    - Handle missing or unmatched delimiters gracefully
    - Log warnings for debugging without surfacing errors to user
    - _Requirements: 3.1, 6.1, 8.3_

  - [x] 9.7 Write unit tests for error handling
    - Test invalid AST with syntax errors
    - Test out-of-bounds positions
    - Test invalid tab_size values (0, negative, very large)
    - Test missing insert_spaces
    - Test unclosed delimiters
    - _Requirements: 6.1, 8.3_

- [x] 10. Checkpoint - Ensure LSP handler tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Write integration tests
  - [x] 11.1 Create integration test suite
    - Create `tests/indentation/integration_tests.rs`
    - Test full onTypeFormatting request/response cycle
    - Test with real R code examples from tidyverse style guide
    - Test configuration loading and application
    - Test both RStudio and RStudio-minus styles
    - _Requirements: 3.2, 4.1, 6.1, 7.2, 7.3_

  - [x] 11.2 Write integration tests for real-world R code
    - Test pipe chains from tidyverse examples
    - Test nested structures (pipe in function, function in pipe)
    - Test mixed operators and complex nesting
    - _Requirements: 3.3, 3.4, 10.1, 10.2, 10.3_

- [x] 12. Create user-facing documentation
  - Create `docs/indentation.md` with comprehensive documentation
  - Explain two-tier approach: Tier 1 (always-on) vs Tier 2 (opt-in)
  - Document `raven.indentation.style` configuration setting
  - Provide examples of pipe chain indentation, function argument alignment, nested structures
  - Explain how to enable Tier 2 by setting `editor.formatOnType` to true
  - Include troubleshooting section for common issues
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

- [x] 13. Final checkpoint - Ensure all tests pass and documentation is complete
  - Run all unit tests and property tests
  - Run integration tests with real R code
  - Verify documentation is clear and complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property tests that can be skipped for faster MVP; however, core unit tests (3.7, 5.8, 7.5, 9.7) are recommended for MVP as they validate edge cases and error handling critical to an AST-based indentation system
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties with minimum 100 iterations
- Unit tests validate specific examples, edge cases, and error conditions
- Integration tests verify end-to-end functionality with real R code
- Documentation task ensures users understand how to configure and use the feature
