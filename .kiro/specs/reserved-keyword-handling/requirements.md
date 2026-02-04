# Requirements Document

## Introduction

This feature addresses incorrect handling of R reserved keywords in the Raven LSP. Currently, the LSP has two related bugs:

**Bug 1 - False definition**: When a user writes `else <- 1`, the LSP incorrectly treats `else` as a valid variable definition. However, `else` is a reserved keyword in R and cannot be assigned to - this code is a syntax error, not a valid assignment.

**Bug 2 - False undefined variable**: When `else` appears in an unexpected position (e.g., on a separate line from `if`), the LSP reports "Undefined variable: else". This is wrong because:
- `else` is a reserved keyword, not a variable
- The actual problem is a syntax error (in R, `else` must be on the same line as the closing brace of the `if` block)
- If the user prepends `else <- 1`, the "undefined variable" diagnostic disappears because the LSP thinks `else` is now defined. This is incorrect - a syntax error diagnostic should appear instead.

The fix requires the LSP to:
1. Never treat reserved keywords as variable definitions
2. Never report reserved keywords as "undefined variables"
3. Let tree-sitter's syntax error detection handle misplaced keywords

## Glossary

- **Reserved_Keyword**: An R language keyword that cannot be used as a variable name. Includes: `if`, `else`, `repeat`, `while`, `function`, `for`, `in`, `next`, `break`, `TRUE`, `FALSE`, `NULL`, `Inf`, `NaN`, `NA`, `NA_integer_`, `NA_real_`, `NA_complex_`, `NA_character_`
- **Definition_Extractor**: The component that identifies variable and function definitions from R code AST
- **Undefined_Variable_Checker**: The component that reports diagnostics for variables used but not defined
- **Syntax_Error_Collector**: The component that reports syntax errors from tree-sitter parsing
- **Scope_Resolver**: The component that determines which symbols are in scope at a given position

## Requirements

### Requirement 1: Reserved Keyword List

**User Story:** As a developer, I want the LSP to have a comprehensive list of R reserved keywords, so that it can correctly identify them throughout the codebase.

#### Acceptance Criteria

1. THE Reserved_Keyword_Module SHALL define a constant list containing all R reserved keywords: `if`, `else`, `repeat`, `while`, `function`, `for`, `in`, `next`, `break`, `TRUE`, `FALSE`, `NULL`, `Inf`, `NaN`, `NA`, `NA_integer_`, `NA_real_`, `NA_complex_`, `NA_character_`
2. THE Reserved_Keyword_Module SHALL provide a function `is_reserved_keyword(name: &str) -> bool` that returns true if the name is a reserved keyword
3. THE Reserved_Keyword_Module SHALL be accessible from handlers.rs and scope.rs modules

### Requirement 2: Exclude Reserved Keywords from Definitions

**User Story:** As a developer, I want the LSP to never treat reserved keywords as variable definitions, so that `else <- 1` does not create a definition for `else`.

#### Acceptance Criteria

1. WHEN the Definition_Extractor encounters an assignment where the left-hand side identifier text matches a reserved keyword, THE Definition_Extractor SHALL NOT add it to the exported interface
2. WHEN the Definition_Extractor encounters an assignment where the left-hand side identifier text matches a reserved keyword, THE Definition_Extractor SHALL NOT add it to the scope timeline
3. WHEN the Definition_Extractor encounters `else <- 1`, THE Definition_Extractor SHALL NOT create a definition for `else`
4. WHEN the Definition_Extractor encounters `if <- function() {}`, THE Definition_Extractor SHALL NOT create a definition for `if`
5. WHEN the user has `else <- 1` followed by code using `else`, THE Undefined_Variable_Checker SHALL still skip `else` (because it's a reserved keyword, not because it's "defined")

### Requirement 3: Skip Reserved Keywords in Undefined Variable Checks

**User Story:** As a developer, I want the LSP to never report reserved keywords as undefined variables, so that misplaced `else` shows a syntax error instead of "undefined variable".

#### Acceptance Criteria

1. WHEN the Undefined_Variable_Checker encounters a reserved keyword as an identifier usage, THE Undefined_Variable_Checker SHALL skip it without reporting an undefined variable diagnostic
2. WHEN the Undefined_Variable_Checker encounters `else` in any position, THE Undefined_Variable_Checker SHALL NOT report "Undefined variable: else"
3. WHEN the Undefined_Variable_Checker encounters `if` in any position, THE Undefined_Variable_Checker SHALL NOT report "Undefined variable: if"
4. WHEN the user writes `else { print(1) }` without a preceding `if`, THE Undefined_Variable_Checker SHALL NOT report "Undefined variable: else" (tree-sitter will report the syntax error instead)
5. THE Undefined_Variable_Checker SHALL check if an identifier is a reserved keyword BEFORE checking if it's defined in scope

### Requirement 4: Syntax Error Reporting for Misplaced Keywords

**User Story:** As a developer, I want the LSP to report syntax errors when reserved keywords appear in invalid positions, so that I get accurate error messages.

#### Acceptance Criteria

1. WHEN tree-sitter reports a syntax error for code containing a misplaced reserved keyword, THE Syntax_Error_Collector SHALL report the syntax error
2. WHEN the user writes `else` on a line that does not have a preceding `}` from an `if` or `else if` block on the same line, THE Syntax_Error_Collector SHALL report a syntax error (via tree-sitter)
3. THE Syntax_Error_Collector SHALL NOT be modified; it already correctly reports tree-sitter syntax errors

### Requirement 5: Completions Exclude Reserved Keywords

**User Story:** As a developer, I want the LSP to not suggest reserved keywords as variable name completions, so that I don't accidentally try to use them as identifiers.

#### Acceptance Criteria

1. WHEN generating completions for variable names, THE Completion_Provider SHALL NOT include reserved keywords in the completion list
2. WHEN a user has defined `el <- 1` and types `el`, THE Completion_Provider SHALL suggest `el` but SHALL NOT suggest `else`

### Requirement 6: Document Symbols Exclude Reserved Keywords

**User Story:** As a developer, I want the document symbols list to not include reserved keywords that appear on the left side of assignments.

#### Acceptance Criteria

1. WHEN collecting document symbols, THE Document_Symbol_Provider SHALL NOT include symbols where the name is a reserved keyword
2. WHEN the document contains `else <- 1`, THE Document_Symbol_Provider SHALL NOT list `else` as a symbol
