# Requirements Document

## Introduction

This feature adds function parameter completions to Raven (an R language server). When the cursor is inside a function call, the LSP will suggest parameter names for that function alongside standard completions (variables, functions, keywords). This enables developers to quickly discover and use function parameters without consulting documentation.

## Glossary

- **Completion_Handler**: The LSP component that processes completion requests and returns completion items
- **Parameter_Resolver**: The component that extracts and caches function parameter information
- **Function_Signature**: The parameter list of a function including parameter names and default values
- **R_Subprocess**: The interface for querying R about package information and function signatures
- **Package_Library**: The cache of installed R packages and their exports
- **Cross_File_Scope**: The scope resolution system that tracks symbols across sourced files
- **Tree_Sitter**: The incremental parsing library used to analyze R code structure
- **Completion_Resolve**: The LSP `completionItem/resolve` handler that lazily loads documentation for a selected completion item

## Requirements

### Requirement 1: Function Call Context Detection

**User Story:** As a developer, I want the LSP to detect when my cursor is inside a function call, so that I can receive relevant parameter suggestions alongside standard completions.

#### Acceptance Criteria

1. WHEN the cursor is positioned after `(` and before `)` in a function call, THE Completion_Handler SHALL detect the function call context
2. WHEN the cursor is positioned after a comma within function arguments, THE Completion_Handler SHALL detect the function call context
3. WHEN the cursor is positioned inside nested function calls, THE Completion_Handler SHALL detect the innermost function call context
4. WHEN the cursor is positioned outside any function call parentheses, THE Completion_Handler SHALL NOT provide parameter completions
5. WHEN the cursor is positioned inside a string literal within function arguments, THE Completion_Handler SHALL NOT provide parameter completions

### Requirement 2: Base R Function Parameter Completions

**User Story:** As a developer, I want to see parameter suggestions for base R functions, so that I can quickly write correct function calls without consulting documentation.

#### Acceptance Criteria

1. WHEN the cursor is inside a base R function call, THE Parameter_Resolver SHALL query R subprocess using `formals()` to get parameter names
2. WHEN R subprocess returns parameter information, THE Completion_Handler SHALL display parameter names as completion items
3. WHEN a parameter has a default value, THE Completion_Handler SHALL include the default value in the completion detail
4. IF R subprocess is unavailable, THEN THE Parameter_Resolver SHALL return an empty parameter list gracefully
5. THE Parameter_Resolver SHALL cache function signatures to avoid repeated R subprocess queries

### Requirement 3: Package Function Parameter Completions

**User Story:** As a developer, I want to see parameter suggestions for functions from loaded packages, so that I can use package functions efficiently.

#### Acceptance Criteria

1. WHEN the cursor is inside a call to a function from a loaded package, THE Parameter_Resolver SHALL resolve the function's package and query its parameters
2. WHEN using namespace-qualified calls (e.g., `dplyr::filter(`), THE Parameter_Resolver SHALL query parameters for the specified package's function directly
3. WHEN multiple packages export the same function name, THE Parameter_Resolver SHALL use the scope resolver to determine which package's function is in scope at the cursor position (based on which `library()` calls precede the cursor in the current file and its sourced dependencies)
4. THE Parameter_Resolver SHALL cache package function signatures per package to minimize R subprocess queries

### Requirement 4: User-Defined Function Parameter Completions

**User Story:** As a developer, I want to see parameter suggestions for functions I've defined in my project, so that I can use my own functions consistently.

#### Acceptance Criteria

1. WHEN the cursor is inside a call to a user-defined function in the current file, THE Parameter_Resolver SHALL extract parameters from the function definition AST
2. WHEN the cursor is inside a call to a function defined in a sourced file, THE Parameter_Resolver SHALL use cross-file scope to locate and extract parameters
3. WHEN a user-defined function has parameters with default values, THE Completion_Handler SHALL include the default value in the completion detail
4. WHEN a user-defined function uses `...` (dots), THE Completion_Handler SHALL NOT include `...` as a completion item since dots is a pass-through mechanism, not a named parameter to be specified

### Requirement 5: Parameter Completion Formatting

**User Story:** As a developer, I want parameter completions to be clearly formatted and sorted above other completions, so that I can distinguish them and access them quickly.

#### Acceptance Criteria

1. THE Completion_Handler SHALL display parameter completions with `CompletionItemKind::FIELD`
2. WHEN a parameter has a default value, THE Completion_Handler SHALL show the default in the detail field (e.g., `= TRUE`)
3. WHEN inserting a parameter completion, THE Completion_Handler SHALL append an equals sign followed by a space (`= `) after the parameter name
4. THE Completion_Handler SHALL filter parameter completions based on the user's typed prefix
5. THE Completion_Handler SHALL exclude parameters that have already been specified in the current function call
6. THE Completion_Handler SHALL assign parameter completions a sort prefix of `"0-"` so they appear before all other completion types in the list

### Requirement 6: Mixed Completions in Function Call Context

**User Story:** As a developer, I want parameter completions to appear alongside standard completions when inside a function call, so that I can access both parameter names and variable names needed as argument values.

#### Acceptance Criteria

1. WHEN in function call context, THE Completion_Handler SHALL add parameter completions to the standard completion list rather than replacing it
2. WHEN in function call context, THE Completion_Handler SHALL include standard completions (local variables, package exports, cross-file symbols, keywords) alongside parameter completions
3. THE Completion_Handler SHALL maintain existing completion behavior when not in function call context
4. THE Completion_Handler SHALL sort parameter completions (`"0-"`) before all other completion types, and maintain the existing sort precedence for non-parameter items: local definitions (`"1-"`) before package exports (`"4-"`) before keywords (`"5-"`)

### Requirement 7: Parameter Documentation on Resolve

**User Story:** As a developer, I want to see documentation for a parameter when I select it in the completion list, so that I understand what each parameter does.

#### Acceptance Criteria

1. WHEN a parameter completion item is selected, THE Completion_Resolve handler SHALL return documentation for that parameter
2. WHEN the function is from a package, THE Completion_Resolve handler SHALL extract the `@param` description from the function's R help documentation
3. WHEN the function is user-defined with roxygen comments above the definition, THE Completion_Resolve handler SHALL extract the `@param` description from the roxygen block by scanning comment lines (`#'`) immediately preceding the function definition
4. IF parameter documentation is unavailable, THEN THE Completion_Resolve handler SHALL return the completion item without documentation

### Requirement 8: Roxygen Documentation for User-Defined Function Completions

**User Story:** As a developer, I want to see the roxygen description when I select a user-defined function in the completion list, so that I understand what the function does without navigating to its definition.

#### Acceptance Criteria

1. WHEN a user-defined function completion item is resolved via `completionItem/resolve`, THE Completion_Resolve handler SHALL scan for roxygen comment lines (`#'`) immediately above the function definition
2. WHEN roxygen comments contain a title line (the first non-tag `#'` line), THE Completion_Resolve handler SHALL include it as the function's documentation
3. WHEN roxygen comments contain a `@description` tag or description paragraph, THE Completion_Resolve handler SHALL include it in the documentation
4. IF no roxygen comments are found above the function definition, THEN THE Completion_Resolve handler SHALL return the completion item without documentation
5. THE roxygen extraction logic SHALL be shared between parameter documentation (Requirement 7) and function documentation (this requirement) to avoid duplication

### Requirement 9: Signature Cache Management

**User Story:** As a developer, I want function signatures to be cached efficiently, so that completions are fast and responsive.

#### Acceptance Criteria

1. THE Parameter_Resolver SHALL store cached signatures in a thread-safe data structure
2. THE Parameter_Resolver SHALL invalidate user-defined function signatures when the defining file changes
3. THE Parameter_Resolver SHALL persist package function signatures across LSP sessions where possible
4. WHEN cache memory exceeds a configurable threshold, THE Parameter_Resolver SHALL evict least-recently-used entries

### Requirement 10: R Subprocess Query Interface

**User Story:** As a developer, I want the LSP to query R for function information, so that completions are accurate for the installed R version.

#### Acceptance Criteria

1. THE R_Subprocess SHALL provide a method to query function parameters using `formals(func)`
2. THE R_Subprocess SHALL validate function names to prevent code injection
3. IF a query times out or fails, THEN THE R_Subprocess SHALL return an error without crashing the LSP
4. THE R_Subprocess SHALL support querying parameters for functions in specific packages using `formals(pkg::func)`

### Requirement 11: Error Handling and Graceful Degradation

**User Story:** As a developer, I want the LSP to handle errors gracefully, so that completions work even when some information is unavailable.

#### Acceptance Criteria

1. IF R subprocess is unavailable, THEN THE Completion_Handler SHALL fall back to AST-based parameter extraction where possible
2. IF function signature cannot be determined, THEN THE Completion_Handler SHALL return standard completions without parameter suggestions
3. THE Completion_Handler SHALL log errors at trace level without displaying error messages to the user