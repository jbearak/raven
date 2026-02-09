# Requirements Document

## Introduction

This feature improves the placement of syntax error diagnostics in Raven LSP to ensure they appear on the line containing the actual syntax error, rather than on structurally valid parent constructs. Currently, when tree-sitter wraps incomplete expressions inside blocks in a multi-line ERROR node, the diagnostic minimization logic collapses the range to the first line of the ERROR node, which often points to valid code (like an `if` statement) rather than the actual incomplete expression.

## Glossary

- **ERROR_Node**: A tree-sitter node with `is_error() == true`, indicating a syntax error in the parsed code
- **Leaf_ERROR_Node**: An ERROR_Node with zero children — typically a single misplaced token (e.g., `}`) that tree-sitter cannot fit into the grammar
- **MISSING_Node**: A tree-sitter node with `is_missing() == true`, indicating an expected but absent token
- **Diagnostic_Range**: The LSP Range (start/end Position) where a diagnostic squiggle appears in the editor
- **Minimization_Logic**: The algorithm that converts a multi-line ERROR node into a focused diagnostic range
- **Incomplete_Expression**: A syntactically incomplete statement (e.g., `x <-` without a right-hand side)
- **Structural_Parent**: A syntactically valid construct (e.g., `if`, `while`, `for`, `function`, `repeat`) that contains an ERROR node
- **Content_Line**: The first line inside a multi-line ERROR node that contains non-structural named tokens (identifiers, operators) after the opening brace
- **First_Line_Strategy**: The previous approach of collapsing multi-line ERROR ranges to the first line
- **Content_Line_Strategy**: The new approach of scanning ERROR node children to find the first line with actual content after structural tokens

## Requirements

### Requirement 1: Accurate Diagnostic Placement

**User Story:** As a developer, I want syntax error diagnostics to appear on the line containing the actual syntax error, so that I can quickly identify and fix the problematic code without being distracted by red squiggles on valid code.

#### Acceptance Criteria

1. WHEN an Incomplete_Expression exists within a multi-line ERROR_Node, THE Minimization_Logic SHALL place the Diagnostic_Range on the Content_Line containing the Incomplete_Expression
2. WHEN a multi-line ERROR_Node contains a non-leaf nested ERROR_Node, THE Minimization_Logic SHALL prefer the nested ERROR_Node's content for placement over the outer ERROR_Node's first line
3. WHEN a MISSING_Node exists within a multi-line ERROR_Node, THE Minimization_Logic SHALL prioritize the MISSING_Node location for the Diagnostic_Range
4. WHEN a single-line ERROR_Node is encountered, THE Minimization_Logic SHALL preserve the full range without modification
5. WHEN a Structural_Parent (such as `if`, `while`, `for`, `function`, `repeat`) contains an ERROR_Node, THE Minimization_Logic SHALL NOT place diagnostics on the Structural_Parent line unless the error originates there

### Requirement 2: Diagnostic Deduplication

**User Story:** As a developer, I want to see exactly one syntax error diagnostic per actual syntax error, so that I am not overwhelmed by duplicate or redundant error messages.

#### Acceptance Criteria

1. WHEN a multi-line ERROR_Node contains nested ERROR_Node children, THE System SHALL emit exactly one diagnostic for the entire error structure
2. WHEN recursing through ERROR_Node children, THE System SHALL stop recursion after identifying the diagnostic location to prevent duplicate diagnostics
3. WHEN a MISSING_Node is found within an ERROR_Node, THE System SHALL emit a diagnostic for the MISSING_Node and suppress any parent ERROR_Node diagnostic

### Requirement 3: Content Line Detection

**User Story:** As a developer, I want the system to identify the most specific location of a syntax error within nested structures, so that the diagnostic points to the exact problematic code.

#### Acceptance Criteria

1. WHEN traversing a multi-line ERROR_Node, THE System SHALL skip Leaf_ERROR_Nodes (ERROR nodes with zero children) during innermost-error search
2. WHEN a multi-line ERROR_Node contains an opening brace `{`, THE System SHALL only consider children AFTER the brace line when searching for the Content_Line
3. WHEN scanning for the Content_Line, THE System SHALL skip structural keywords (`if`, `while`, `for`, `function`, `repeat`), punctuation, boolean/null literals, and ERROR children
4. WHEN no Content_Line is found after the brace, THE System SHALL fall back to the line immediately after the brace

### Requirement 4: Backward Compatibility

**User Story:** As a developer, I want existing test cases to continue passing with the new diagnostic placement logic, so that I can be confident the changes do not introduce regressions.

#### Acceptance Criteria

1. WHEN processing single-line ERROR_Node instances, THE System SHALL maintain the existing behavior of preserving the full range
2. WHEN processing MISSING_Node instances, THE System SHALL maintain the existing behavior of creating a 1-column-wide diagnostic at the missing token location
3. WHEN processing top-level incomplete assignments (e.g., `x <-`), THE System SHALL continue to emit a diagnostic for the MISSING identifier
4. WHEN processing genuinely broken code, THE System SHALL continue to emit at least one diagnostic

### Requirement 5: Test Coverage

**User Story:** As a maintainer, I want comprehensive test coverage for the new diagnostic placement logic, so that I can verify correctness and prevent future regressions.

#### Acceptance Criteria

1. THE System SHALL include tests for incomplete assignments within blocks (e.g., `if (TRUE) { x <- }`)
2. THE System SHALL include tests for incomplete binary operations within blocks (e.g., `if (TRUE) { x + }`)
3. THE System SHALL include tests for incomplete comparisons within blocks (e.g., `if (TRUE) { x < }`)
4. THE System SHALL include tests for unclosed function calls within blocks (e.g., `if (TRUE) { f( }`)
5. THE System SHALL include tests verifying that diagnostics appear on the Content_Line, not on the Structural_Parent line
6. THE System SHALL include tests verifying exactly one diagnostic is emitted per error structure (no duplicates)
