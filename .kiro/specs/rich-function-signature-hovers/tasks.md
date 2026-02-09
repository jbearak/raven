# Implementation Plan: Rich Function Signature Help

## Overview

This plan implements rich signature help for Raven's LSP, enhancing the tooltip that appears when typing function arguments. The implementation modifies the signature_help() function in handlers.rs and adds helper functions to build LSP SignatureInformation structures with parameter details and documentation.

## Tasks

- [x] 1. Add helper functions for signature formatting
  - Add format_signature_label() to format parameter lists
  - Add build_parameter_information() to create LSP ParameterInformation
  - Add detect_active_parameter() to find which parameter is being typed
  - _Requirements: 5.1, 5.2, 5.3, 6.1, 6.3_

- [x] 1.1 Write unit tests for signature formatting helpers
  - Test zero parameters: "func()"
  - Test single parameter: "func(x)"
  - Test parameters with defaults: "func(x = 1, y = TRUE)"
  - Test dots parameter: "func(x, ...)"
  - _Requirements: 5.1, 5.2, 5.3, 9.1_

- [x] 1.2 Write property test for signature formatting
  - **Property 3: User Function Signature Formatting**
  - **Validates: Requirements 5.1, 5.2, 5.3, 2.1**

- [x] 1.3 Write unit tests for active parameter detection
  - Test first parameter (no commas): index 0
  - Test second parameter (one comma): index 1
  - Test nested calls: correct index for outer call
  - _Requirements: 6.3_

- [x] 1.4 Write property test for active parameter detection
  - **Property 6: Active Parameter Detection**
  - **Validates: Requirements 6.3**

- [x] 2. Implement package function signature building
  - Add try_build_package_signature() async function
  - Use HelpCache::get_or_fetch() to get help text
  - Use extract_signature_from_help() to get signature
  - Use extract_description_from_help() to get description
  - Use HelpCache::get_arguments() to get parameter docs
  - Build SignatureInformation with parameters and documentation
  - Handle fallback: function name with package attribution
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 6.1, 6.2, 6.4, 9.5_

- [x] 2.1 Write unit tests for package signature building
  - Test with standard R help (base::mean)
  - Test with multi-line signatures
  - Test with S3 method signatures (prefer generic)
  - Test with missing Usage section (fallback)
  - Test with missing Description section
  - Test with parameter documentation
  - _Requirements: 1.1, 3.1, 3.2, 3.3, 3.4, 4.1, 4.5, 6.2_

- [x] 2.2 Write property test for package signature formatting
  - **Property 1: Package Function Signature Formatting**
  - **Validates: Requirements 1.1, 1.2, 1.3, 3.1, 3.2, 3.5**

- [x] 2.3 Write property test for help text description extraction
  - **Property 2: Help Text Description Extraction**
  - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [x] 3. Checkpoint - Ensure package signature tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement user function signature building
  - Add try_build_user_signature() function
  - Use Parameter_Resolver::resolve() to get function signature
  - Extract parameters from FunctionSignature
  - Use extract_roxygen_block() to get documentation
  - Use get_function_doc() to get title and description
  - Use get_param_doc() for each parameter's documentation
  - Build SignatureInformation with parameters and documentation
  - Handle fallback: function name with file location
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.5, 9.3, 9.4_

- [x] 4.1 Write unit tests for user signature building
  - Test function with roxygen title + description
  - Test function with @param tags
  - Test function with plain comments (fallback)
  - Test function with no comments
  - Test function with no parameters
  - Test AST extraction failure (fallback)
  - _Requirements: 2.1, 2.2, 2.3, 5.1, 5.4, 9.3, 9.4_

- [x] 4.2 Write property test for user signature formatting
  - **Property 3: User Function Signature Formatting** (if not already covered)
  - **Validates: Requirements 5.1, 5.2, 5.3, 2.1**

- [x] 4.3 Write property test for roxygen documentation display
  - **Property 4: Roxygen Documentation Display**
  - **Validates: Requirements 2.2, 2.3**

- [x] 4.4 Write property test for parameter information structure
  - **Property 5: Parameter Information Structure**
  - **Validates: Requirements 6.1, 6.2**

- [x] 5. Checkpoint - Ensure user signature tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Rewrite signature_help() function
  - Make function async (for HelpCache access)
  - Keep existing call detection logic
  - Extract function name from call node
  - Determine if package or user function using cross-file scope
  - For package functions: call try_build_package_signature()
  - For user functions: call try_build_user_signature()
  - Call detect_active_parameter() to find active parameter
  - Build SignatureHelp with signature and active parameter
  - Handle fallback: function name with source attribution
  - _Requirements: 1.1, 2.1, 6.3, 7.1, 7.2, 7.3, 7.4, 7.5, 9.2_

- [x] 6.1 Write unit tests for signature_help() function
  - Test package function call
  - Test user function call
  - Test undefined function call
  - Test with active parameter detection
  - Test fallback cases
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 6.2 Write property test for signature help fallback
  - **Property 7: Signature Help Fallback**
  - **Validates: Requirements 7.1, 7.3, 9.2, 9.4, 9.5**

- [x] 6.3 Write property test for S3 method preference
  - **Property 8: S3 Method Signature Preference**
  - **Validates: Requirements 3.3**

- [x] 7. Update backend handler to use async signature_help
  - Modify the LSP backend handler to call signature_help with spawn_blocking
  - Ensure proper error handling
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 8. Integration testing
  - Test typing package function call (e.g., "mean(")
  - Test typing user function call with roxygen
  - Test typing user function call without roxygen
  - Test typing undefined function call
  - Test nested function calls
  - Test active parameter highlighting
  - _Requirements: All requirements_

- [x] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The implementation reuses existing infrastructure (HelpCache, Roxygen_Parser, Parameter_Resolver)
- No new R subprocess calls are introduced - all data comes from existing caches
