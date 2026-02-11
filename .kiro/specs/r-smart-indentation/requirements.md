# Requirements Document: R Smart Indentation

## Introduction

This feature implements intelligent indentation for R code in VS Code, addressing three key patterns that are currently not handled well: pipe continuation, open-paren alignment, and smart de-indentation. The implementation follows a two-tier approach: declarative rules in language-configuration.json for basic indentation (always-on), and AST-aware LSP onTypeFormatting for precise context-aware indentation (opt-in via formatOnType setting).

## Glossary

- **Pipe_Operator**: The native R pipe `|>` or magrittr pipe `%>%` used for chaining operations
- **Continuation_Operator**: Binary operators that indicate expression continuation (`|>`, `%>%`, `+`, `~`, `%infix%`)
- **Chain_Start**: The first line in a sequence of operator-terminated lines; the line that is NOT preceded by a continuation operator
- **Indentation_Handler**: The LSP component that computes indentation based on AST context
- **Language_Configuration**: VS Code's declarative JSON file defining basic indentation rules
- **FormattingOptions**: LSP request parameters containing user's tab_size and insert_spaces preferences
- **TextEdit**: LSP response object that replaces a range of text with new content
- **RStudio_Style**: Indentation mode where same-line arguments align to opening paren, next-line arguments indent +tabSize from function line
- **RStudio_Minus_Style**: Indentation mode where all arguments indent +tabSize from previous line regardless of paren position

## Requirements

### Requirement 1: Declarative Pipe Continuation Indentation

**User Story:** As an R developer, I want lines following pipe operators to be automatically indented, so that my pipe chains are visually structured without requiring additional configuration.

#### Acceptance Criteria

1. WHEN a line ends with `|>` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level (as determined by the file's editor indentation settings)
2. WHEN a line ends with `%>%` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level
3. WHEN a line ends with `+` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level
4. WHEN a line ends with `~` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level
5. WHEN a line ends with a custom infix operator `%word%` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level

### Requirement 2: Declarative Bracket Indentation

**User Story:** As an R developer, I want lines following opening brackets to be automatically indented, so that nested code blocks are visually structured.

#### Acceptance Criteria

1. WHEN a line ends with `{` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level (as determined by the file's editor indentation settings)
2. WHEN a line ends with `(` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level
3. WHEN a line ends with `[` followed by optional whitespace and optional comment, THE Language_Configuration SHALL indent the next line by one indentation level
4. WHEN a line starts with `}`, `)`, or `]`, THE Language_Configuration SHALL outdent that line by one indentation level

### Requirement 3: AST-Aware Pipe Chain Indentation

**User Story:** As an R developer, I want all continuation lines in a pipe chain to be indented consistently relative to the chain start, so that my code follows RStudio conventions and is easy to read.

#### Acceptance Criteria

1. WHEN the cursor is positioned after a Continuation_Operator at end of line, THE Indentation_Handler SHALL identify the Chain_Start by walking backward through consecutive operator-terminated lines
2. WHEN indenting a continuation line in a pipe chain, THE Indentation_Handler SHALL indent by FormattingOptions.tab_size from the Chain_Start column
3. WHEN multiple continuation lines exist in a chain, THE Indentation_Handler SHALL apply the same indentation to all continuation lines
4. WHEN a pipe chain is nested inside a function call, THE Indentation_Handler SHALL compute indentation relative to the pipe chain context, not the enclosing parenthesis

### Requirement 4: AST-Aware Argument Alignment

**User Story:** As an R developer, I want function arguments to be aligned intelligently based on whether the opening paren is followed by content or a newline, so that my code follows RStudio conventions.

#### Acceptance Criteria

1. WHEN the cursor is inside unclosed parentheses and the opening paren is followed by content on the same line and RStudio_Style is configured, THE Indentation_Handler SHALL align the continuation line to the column after the opening paren
2. WHEN the cursor is inside unclosed parentheses and the opening paren is followed by a newline, THE Indentation_Handler SHALL indent by FormattingOptions.tab_size from the line containing the opening paren
3. WHEN the cursor is inside unclosed parentheses and RStudio_Minus_Style is configured, THE Indentation_Handler SHALL indent by FormattingOptions.tab_size from the previous line regardless of paren position
4. WHEN the cursor is inside unclosed braces `{}`, THE Indentation_Handler SHALL indent by FormattingOptions.tab_size from the line containing the opening brace

### Requirement 5: AST-Aware De-indentation

**User Story:** As an R developer, I want closing delimiters and statements after complete expressions to be de-indented appropriately, so that my code structure is clear.

#### Acceptance Criteria

1. WHEN a closing delimiter `)`, `]`, or `}` appears on its own line, THE Indentation_Handler SHALL align it to the column of the line containing the matching opening delimiter
2. WHEN the cursor is positioned after a complete expression with no trailing Continuation_Operator and no unclosed delimiters, THE Indentation_Handler SHALL return to the indentation of the enclosing block

### Requirement 6: User Configuration Respect

**User Story:** As an R developer, I want the indentation system to respect my editor configuration for tab size and space/tab preference, so that indentation matches my project conventions.

#### Acceptance Criteria

1. WHEN computing indentation, THE Indentation_Handler SHALL read FormattingOptions.tab_size from the LSP request parameters
2. WHEN computing indentation, THE Indentation_Handler SHALL read FormattingOptions.insert_spaces from the LSP request parameters
3. WHEN FormattingOptions.insert_spaces is true, THE Indentation_Handler SHALL use spaces for indentation
4. WHEN FormattingOptions.insert_spaces is false, THE Indentation_Handler SHALL use tabs for indentation
5. WHEN applying indentation, THE TextEdit SHALL replace the full indentation range from column 0 to the end of existing whitespace

### Requirement 7: Indentation Style Configuration

**User Story:** As an R developer, I want to choose between RStudio and RStudio-minus indentation styles, so that I can match my team's coding conventions.

#### Acceptance Criteria

1. THE system SHALL provide a configuration setting `raven.indentation.style` with enum values `rstudio`, `rstudio-minus`, and `off`
2. WHEN `raven.indentation.style` is set to `rstudio`, THE Indentation_Handler SHALL align same-line arguments to the opening paren and indent next-line arguments by tab_size from the function line
3. WHEN `raven.indentation.style` is set to `rstudio-minus`, THE Indentation_Handler SHALL indent all arguments by tab_size from the previous line regardless of paren position
4. WHEN `raven.indentation.style` is not configured, THE system SHALL default to `rstudio`
5. WHEN `raven.indentation.style` is set to `off`, THE Indentation_Handler SHALL return no edits (None), disabling Tier 2 AST-aware indentation while leaving Tier 1 declarative rules active

### Requirement 8: LSP On-Type Formatting Registration

**User Story:** As an R developer, I want the LSP server to provide on-type formatting when I enable formatOnType, so that I get precise AST-aware indentation.

#### Acceptance Criteria

1. WHEN the LSP server initializes, THE system SHALL register `textDocument/onTypeFormatting` capability with trigger character `"\n"`
2. WHEN `editor.formatOnType` is enabled and the user presses Enter, THE VS Code client SHALL send a `textDocument/onTypeFormatting` request to the server
3. WHEN the Indentation_Handler receives an onTypeFormatting request, THE system SHALL compute indentation using the tree-sitter AST
4. WHEN the Indentation_Handler computes indentation, THE system SHALL return a TextEdit array that overrides VS Code's declarative indentation rules

### Requirement 9: Tree-Sitter AST Context Detection

**User Story:** As a system implementer, I want to use tree-sitter nodes to accurately detect syntactic context, so that indentation decisions are based on precise code structure.

#### Acceptance Criteria

1. WHEN detecting pipe operators, THE system SHALL identify `pipe_operator` nodes for `|>`
2. WHEN detecting special operators, THE system SHALL identify `special_operator` nodes for `%>%`, `%in%`, and custom infix operators
3. WHEN detecting binary operators, THE system SHALL identify `binary_operator` nodes with `+` or `~` operators
4. WHEN detecting function call context, THE system SHALL identify `call` and `arguments` nodes
5. WHEN detecting block context, THE system SHALL identify `brace_list` nodes for `{}`-delimited blocks

### Requirement 10: Nested Context Handling

**User Story:** As an R developer, I want indentation to work correctly when pipe chains are nested inside function calls or other complex structures, so that all my code is properly formatted.

#### Acceptance Criteria

1. WHEN a pipe chain appears inside a function call's arguments, THE Indentation_Handler SHALL compute pipe continuation indentation relative to the pipe chain context
2. WHEN a function call appears inside a pipe chain, THE Indentation_Handler SHALL compute argument indentation relative to the function call context
3. WHEN multiple levels of nesting exist, THE Indentation_Handler SHALL correctly identify the innermost relevant context for indentation decisions


### Requirement 11: User-Facing Documentation

**User Story:** As an R developer, I want clear documentation about the indentation feature, so that I understand how to configure and use it effectively.

#### Acceptance Criteria

1. THE system SHALL provide user-facing documentation explaining the two-tier indentation approach
2. THE documentation SHALL explain the difference between Tier 1 (always-on) and Tier 2 (opt-in via formatOnType)
3. THE documentation SHALL explain the `raven.indentation.style` configuration setting and the difference between `rstudio` and `rstudio-minus` styles
4. THE documentation SHALL provide examples of pipe chain indentation, function argument alignment, and nested structures
5. THE documentation SHALL explain how to enable Tier 2 by setting `editor.formatOnType` to true
6. THE documentation SHALL be added to an existing documentation file or a new file in the `docs/` directory
