# Requirements Document

## Introduction

This feature enhances Raven's document outline to recognize JAGS and Stan language block structures as top-level hierarchical sections. Currently, JAGS and Stan files are parsed using the R tree-sitter parser on a best-effort basis, and their block structures (`data { }`, `model { }`, etc.) are not recognized as outline sections. This feature adds text-based detection of these language-specific blocks so that symbols extracted within each block appear as children of the block in the outline view.

## Glossary

- **Document_Symbol_Provider**: The LSP handler that responds to `textDocument/documentSymbol` requests, returning symbols for a single file
- **Block_Detector**: The component responsible for detecting JAGS and Stan top-level block structures from source text using regex-based pattern matching
- **JAGS_Block**: A top-level block in a JAGS file; one of `data` or `model`, followed by a brace-delimited body
- **Stan_Block**: A top-level block in a Stan file; one of `functions`, `data`, `transformed data`, `parameters`, `transformed parameters`, `model`, or `generated quantities`, followed by a brace-delimited body
- **Block_Section**: A `RawSymbol` with `DocumentSymbolKind::Module` representing a detected JAGS or Stan block, used as a hierarchical parent in the outline

## Requirements

### Requirement 1: JAGS Block Detection

**User Story:** As a JAGS developer, I want `data { }` and `model { }` blocks to appear as top-level sections in the document outline, so that I can navigate my JAGS model files hierarchically.

#### Acceptance Criteria

1. WHEN a JAGS file contains a `data { ... }` block, THE Block_Detector SHALL create a Block_Section named "data" with SymbolKind MODULE
2. WHEN a JAGS file contains a `model { ... }` block, THE Block_Detector SHALL create a Block_Section named "model" with SymbolKind MODULE
3. THE Block_Detector SHALL detect JAGS blocks using a text-based regex pattern that matches the block keyword at the start of a line (with optional leading whitespace) followed by an opening brace (on the same line or a subsequent line)
4. THE Block_Section range SHALL span from the block keyword line to the line containing the matching closing brace
5. THE Block_Section selection_range SHALL span the block keyword only

### Requirement 2: Stan Block Detection

**User Story:** As a Stan developer, I want `functions`, `data`, `transformed data`, `parameters`, `transformed parameters`, `model`, and `generated quantities` blocks to appear as top-level sections in the document outline, so that I can navigate my Stan model files hierarchically.

#### Acceptance Criteria

1. WHEN a Stan file contains a `functions { ... }` block, THE Block_Detector SHALL create a Block_Section named "functions" with SymbolKind MODULE
2. WHEN a Stan file contains a `data { ... }` block, THE Block_Detector SHALL create a Block_Section named "data" with SymbolKind MODULE
3. WHEN a Stan file contains a `transformed data { ... }` block, THE Block_Detector SHALL create a Block_Section named "transformed data" with SymbolKind MODULE
4. WHEN a Stan file contains a `parameters { ... }` block, THE Block_Detector SHALL create a Block_Section named "parameters" with SymbolKind MODULE
5. WHEN a Stan file contains a `transformed parameters { ... }` block, THE Block_Detector SHALL create a Block_Section named "transformed parameters" with SymbolKind MODULE
6. WHEN a Stan file contains a `model { ... }` block, THE Block_Detector SHALL create a Block_Section named "model" with SymbolKind MODULE
7. WHEN a Stan file contains a `generated quantities { ... }` block, THE Block_Detector SHALL create a Block_Section named "generated quantities" with SymbolKind MODULE
8. THE Block_Detector SHALL detect Stan blocks using a text-based regex pattern that matches the block keyword at the start of a line (with optional leading whitespace) followed by an opening brace (on the same line or a subsequent line)
9. THE Block_Section range SHALL span from the block keyword line to the line containing the matching closing brace
10. THE Block_Section selection_range SHALL span the block keyword only

### Requirement 3: Hierarchical Nesting of Symbols Within Blocks

**User Story:** As a JAGS or Stan developer, I want symbols extracted within a block to appear as children of that block in the outline, so that the outline reflects the logical structure of my model file.

#### Acceptance Criteria

1. WHEN a symbol is extracted within the range of a JAGS or Stan Block_Section, THE Document_Symbol_Provider SHALL nest the symbol as a child of that Block_Section
2. WHEN a symbol is extracted outside any Block_Section range, THE Document_Symbol_Provider SHALL include the symbol at the root level of the outline
3. THE Document_Symbol_Provider SHALL use the existing HierarchyBuilder section-nesting logic to nest symbols within Block_Sections (Block_Sections are treated as sections with `section_level` of 1)

### Requirement 4: File Type Awareness in Symbol Extraction

**User Story:** As a developer, I want the document symbol provider to apply JAGS block detection only to JAGS files and Stan block detection only to Stan files, so that R files are unaffected by this feature.

#### Acceptance Criteria

1. WHEN the file type is JAGS, THE Document_Symbol_Provider SHALL run JAGS block detection and include detected blocks as Block_Sections
2. WHEN the file type is Stan, THE Document_Symbol_Provider SHALL run Stan block detection and include detected blocks as Block_Sections
3. WHEN the file type is R, THE Document_Symbol_Provider SHALL NOT run JAGS or Stan block detection
4. THE Document_Symbol_Provider SHALL determine file type from the document's stored `file_type` field (derived from URI extension or language ID)

### Requirement 5: Brace Matching for Block Range Computation

**User Story:** As a developer, I want block ranges to be computed by matching braces, so that nested braces within a block body do not cause incorrect range boundaries.

#### Acceptance Criteria

1. WHEN computing the range of a Block_Section, THE Block_Detector SHALL find the matching closing brace by tracking brace nesting depth (incrementing on `{`, decrementing on `}`)
2. IF a block's opening brace has no matching closing brace (unbalanced braces), THEN THE Block_Detector SHALL extend the block range to the end of the file
3. THE Block_Detector SHALL ignore braces inside comments and string literals when computing brace nesting depth
