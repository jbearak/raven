# Requirements Document: Mixed Chain Continuation Indentation Fix

## Introduction

This bug fix addresses incorrect indentation when pressing Enter after a continuation operator in a mixed chain — a pipe operator (`|>` or `%>%`) followed by arithmetic/other operators (`+`, `~`, etc.). The AST-based chain start detection falls back to text-based heuristics for mixed chains, but the text-based `ChainWalker` does not distinguish operator classes and walks too far back, producing an incorrect indentation column.

## Glossary

- **Mixed_Chain**: A sequence of continuation operators where different operator classes appear (e.g., `|>` followed by `+`)
- **Operator_Class**: A grouping of continuation operators: class 0 = pipes (`|>`, `%>%`), class 1 = `+`, class 2 = `~`, class 3 = custom infix (`%word%`)
- **Chain_Start**: The first line in a sub-chain of the same operator class; the indentation anchor for continuation lines
- **ChainWalker**: The text-based fallback that walks backward through operator-terminated lines to find the chain start
- **find_chain_start_from_ast**: The AST-based function that uses tree-sitter nodes to find the chain start for a given operator
- **is_mixed_chain**: Helper that detects when a binary_operator's LHS contains a different operator class
- **Sub_Chain**: A contiguous run of same-class operators within a larger mixed chain

## Requirements

### Requirement 1: Correct Mixed Chain Indentation

**User Story:** As an R developer, when I press Enter after a continuation operator that follows a pipe chain (e.g., `x + y +` after `|>`), I want the new line indented relative to the start of the current operator sub-chain, not the entire mixed chain.

#### Acceptance Criteria

1. WHEN a line ends with a continuation operator whose parent binary_operator is part of a Mixed_Chain, THE Indentation_Handler SHALL compute indentation relative to the Sub_Chain start of the same Operator_Class
2. WHEN a `+` chain follows a `|>` chain (e.g., `f(...) |>\n     x + y +\n`), THE Indentation_Handler SHALL indent the next line to `chain_start_col + tab_size` where `chain_start_col` is the column of the first `+` operand (e.g., column 5 for `     x + y +`)
3. WHEN a `|>` chain follows a `+` chain, THE Indentation_Handler SHALL indent relative to the `|>` Sub_Chain start, not the `+` chain start

### Requirement 2: AST-Based Mixed Chain Resolution

**User Story:** As a developer, I want mixed chains to be resolved using the AST rather than falling back to text-based heuristics, so that operator class boundaries are respected.

#### Acceptance Criteria

1. WHEN `find_chain_start_from_ast` encounters a Mixed_Chain, THE function SHALL NOT return `None` and fall back to `ChainWalker`
2. WHEN the outermost same-class binary_operator spans multiple lines, THE function SHALL find the leftmost binary_operator node of the same Operator_Class and return its start position
3. WHEN the outermost same-class binary_operator is on a single line, THE function SHALL return its start position as the chain start

### Requirement 3: Column Calculation Accuracy

**User Story:** As a developer, I want the AST node lookup to find the correct operator node on the previous line, so that chain detection starts from the right position.

#### Acceptance Criteria

1. WHEN computing the column of the last code character on a line (for AST node lookup), THE function SHALL account for leading whitespace by computing `leading_whitespace_length + trimmed_content_length - 1`
2. WHEN the previous line has leading whitespace, THE column calculation SHALL NOT use only the trimmed content length (which ignores the whitespace offset)

### Requirement 4: Backward Compatibility

**User Story:** As a developer, I want all existing indentation tests to continue passing after this fix.

#### Acceptance Criteria

1. WHEN a single-class chain (no mixing) is encountered, THE Indentation_Handler SHALL produce the same result as before the fix
2. WHEN a non-continuation expression is encountered, THE Indentation_Handler SHALL produce the same result as before the fix
3. WHEN `ChainWalker` is used for non-mixed fallback scenarios, THE behavior SHALL remain unchanged
