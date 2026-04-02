# Implementation Plan: JAGS/Stan Outline Hierarchy

## Overview

Add text-based block detection for JAGS and Stan files so that language-specific block structures appear as top-level sections in the document outline. Implementation is a `BlockDetector` struct in `handlers.rs` with brace-matching logic, integrated into the existing `document_symbol` handler and `HierarchyBuilder` pipeline.

## Tasks

- [ ] 1. Implement BlockDetector with regex patterns and brace matching
  - [~] 1.1 Add `BlockDetector` struct and static regex patterns to `handlers.rs`
    - Define `BlockDetector` struct with `detect_jags(text: &str) -> Vec<RawSymbol>` and `detect_stan(text: &str) -> Vec<RawSymbol>` public methods
    - Add a shared `detect_blocks(text: &str, pattern: &Regex) -> Vec<RawSymbol>` internal method
    - Compile JAGS regex `^\s*(data|model)\s*\{?` and Stan regex `^\s*(functions|data|transformed\s+data|parameters|transformed\s+parameters|model|generated\s+quantities)\s*\{?` via `OnceLock`
    - Each detected block produces a `RawSymbol` with `kind: DocumentSymbolKind::Module`, `section_level: Some(1)`, and `detail: None`
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [~] 1.2 Implement `find_matching_brace` with comment/string-aware state machine
    - Implement brace nesting depth tracker: increment on `{`, decrement on `}`; return `(line, col)` when depth reaches 0
    - Implement state machine with states: `Normal`, `InLineComment`, `InBlockComment`, `InString`
    - Handle transitions: `//` and `#` → `InLineComment` (to EOL), `/*` → `InBlockComment` (to `*/`), `"` → `InString` (handle `\"` escapes)
    - When no matching brace is found (unbalanced), return `None` so caller extends range to EOF
    - Set block `range` from keyword line to closing brace line; set `selection_range` to keyword text only
    - _Requirements: 1.4, 1.5, 2.9, 2.10, 5.1, 5.2, 5.3_

  - [~] 1.3 Write unit tests for BlockDetector JAGS detection
    - Test `data { ... }` block detection: verify name="data", kind=Module, correct range
    - Test `model { ... }` block detection: verify name="model", kind=Module, correct range
    - Test leading whitespace on keyword line
    - Test brace on next line after keyword
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [~] 1.4 Write unit tests for BlockDetector Stan detection
    - Test all 7 Stan block keywords in a complete Stan file
    - Test multi-word keywords (`transformed data`, `transformed parameters`, `generated quantities`) with flexible whitespace
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [~] 1.5 Write unit tests for brace matching edge cases
    - Test nested braces (e.g., `for` loops with inner `{ }`) produce correct outer range
    - Test unbalanced braces extend range to EOF
    - Test braces inside line comments (`// }`, `# }`) are ignored
    - Test braces inside block comments (`/* } */`) are ignored
    - Test braces inside string literals (`"}"`) are ignored
    - _Requirements: 5.1, 5.2, 5.3_

- [ ] 2. Integrate BlockDetector into document_symbol handler
  - [~] 2.1 Modify `document_symbol` to dispatch based on `FileType`
    - After `extractor.extract_all()`, add a `match doc.file_type` block
    - `FileType::Jags` → call `BlockDetector::detect_jags(&text)` and extend `raw_symbols`
    - `FileType::Stan` → call `BlockDetector::detect_stan(&text)` and extend `raw_symbols`
    - `FileType::R` → no block detection (empty vec)
    - Block symbols merge into `raw_symbols` before `HierarchyBuilder::build()` — existing section-nesting logic handles hierarchy automatically via `section_level: Some(1)`
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4_

  - [ ] 2.2 Write unit tests for file type dispatch and hierarchical nesting
    - Test R file content with `model <- function() {}` produces no block symbols
    - Test JAGS file with symbols inside a block: verify symbols nest as children of the block in `DocumentSymbol` output
    - Test symbols outside any block appear at root level
    - _Requirements: 3.1, 3.2, 4.1, 4.2, 4.3_

- [ ] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Property-based tests for correctness properties
  - [ ] 4.1 Write property test for block keyword detection
    - **Property 1: Block keyword detection produces correctly named Module symbols**
    - Generate random JAGS/Stan files with valid block keywords and varying leading whitespace; verify each detected symbol has `name` equal to the keyword and `kind == DocumentSymbolKind::Module`
    - Use `proptest` with custom `arb_jags_keyword()` and `arb_stan_keyword()` strategies
    - **Validates: Requirements 1.1, 1.2, 1.3, 2.1–2.8**

  - [ ] 4.2 Write property test for block range correctness
    - **Property 2: Block range spans from keyword line to matching closing brace line**
    - Generate blocks with random nesting depths (0–4 levels of inner braces); verify `range.start.line` is the keyword line and `range.end.line` is the matching brace line; for unbalanced braces verify range extends to EOF
    - **Validates: Requirements 1.4, 2.9, 5.1, 5.2**

  - [ ] 4.3 Write property test for selection range correctness
    - **Property 3: Selection range spans the block keyword only**
    - For any detected block, verify `selection_range` is contained within `range`, spans a single line equal to `range.start.line`, and character span equals the keyword length
    - **Validates: Requirements 1.5, 2.10**

  - [ ] 4.4 Write property test for symbol nesting
    - **Property 4: Symbols nest within their containing block**
    - Generate JAGS/Stan files with blocks and symbols at known positions; verify symbols inside blocks are children and symbols outside are at root level
    - **Validates: Requirements 3.1, 3.2**

  - [ ] 4.5 Write property test for file type dispatch
    - **Property 5: File type dispatch correctness**
    - Generate text containing block-like patterns and test with each `FileType`; verify only the correct detector runs (JAGS keywords for Jags, Stan keywords for Stan, none for R)
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ] 4.6 Write property test for brace matching in comments/strings
    - **Property 6: Brace matching ignores braces in comments and strings**
    - Generate blocks containing braces inside `//` comments, `#` comments, `/* */` block comments, and `"..."` strings; verify block range is unaffected by those braces
    - **Validates: Requirements 5.3**

- [ ] 5. Update documentation
  - [ ] 5.1 Update `docs/document-outline.md` with JAGS/Stan block detection
    - Add a section describing JAGS block detection (`data`, `model`) and Stan block detection (7 block keywords)
    - Document that blocks appear as top-level Module sections and symbols nest within them
    - _Requirements: 1.1, 1.2, 2.1–2.7, 3.1, 3.2_

- [ ] 6. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests use the `proptest` crate with custom strategies per the design document
- The `HierarchyBuilder` already handles section nesting via `section_level` — no changes needed there
