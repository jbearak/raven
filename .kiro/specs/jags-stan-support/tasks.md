# Implementation Plan: JAGS and Stan Language Support

## Overview

Add JAGS (`.jags`, `.bugs`) and Stan (`.stan`) language support to the Raven LSP server and VS Code extension. Implementation proceeds bottom-up: core Rust types first, then diagnostics/completion logic, then built-in modules, then VS Code extension changes (language registration, grammars, configuration files), and finally workspace indexing.

## Tasks

- [ ] 1. Add FileType enum and detection helper
  - [ ] 1.1 Define `FileType` enum and `file_type_from_uri()` in `crates/raven/src/handlers.rs`
    - Add `FileType` enum with variants `R`, `Jags`, `Stan` (derive Debug, Clone, Copy, PartialEq, Eq)
    - Add `file_type_from_uri(uri: &Url) -> FileType` that checks URI path extension: `.jags`/`.bugs` → Jags, `.stan` → Stan, everything else → R
    - _Requirements: 1.1, 2.1, 10.1_

  - [ ]* 1.2 Write property test for file type detection (Property 1)
    - **Property 1: File type detection is consistent with extension**
    - Generate random URI strings with known extensions, verify `file_type_from_uri` returns the correct variant
    - Use `proptest` to generate random path prefixes combined with known extensions
    - **Validates: Requirements 1.1, 2.1, 10.1**

- [ ] 2. Implement diagnostics suppression for JAGS/Stan files
  - [ ] 2.1 Add early return in `diagnostics()` and `diagnostics_from_snapshot()` in `crates/raven/src/handlers.rs`
    - After the `diagnostics_enabled` master switch check, add: if `file_type_from_uri(uri) != FileType::R` return empty `Vec<Diagnostic>`
    - Apply the same guard to `diagnostics_from_snapshot()` if it exists as a separate entry point
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_

  - [ ]* 2.2 Write property test for JAGS diagnostics suppression (Property 2)
    - **Property 2: JAGS files produce empty diagnostics**
    - Generate random text content, create a WorldState with a `.jags` URI document, call `diagnostics()`, assert empty
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 2.3 Write property test for Stan diagnostics suppression (Property 3)
    - **Property 3: Stan files produce empty diagnostics**
    - Generate random text content, create a WorldState with a `.stan` URI document, call `diagnostics()`, assert empty
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 2.4 Write property test for R diagnostics non-regression (Property 4)
    - **Property 4: R files with syntax errors still produce diagnostics**
    - Generate R code with injected syntax errors (e.g., `x <-` with no RHS), verify non-empty diagnostics for `.r`/`.R` URIs
    - **Validates: Requirements 10.1, 10.2**

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Create JAGS and Stan built-in modules
  - [ ] 4.1 Create `crates/raven/src/jags_builtins.rs`
    - Define static `&[&str]` arrays: `JAGS_DISTRIBUTIONS`, `JAGS_FUNCTIONS`, `JAGS_KEYWORDS`
    - Populate with the lists from the design document
    - _Requirements: 12.2, 12.3, 12.4_

  - [ ] 4.2 Create `crates/raven/src/stan_builtins.rs`
    - Define static `&[&str]` arrays: `STAN_TYPES`, `STAN_BLOCK_KEYWORDS`, `STAN_CONTROL_FLOW`, `STAN_FUNCTIONS`
    - Populate with the lists from the design document
    - _Requirements: 13.2, 13.3, 13.4, 13.5_

  - [ ] 4.3 Register new modules in `crates/raven/src/lib.rs`
    - Add `pub mod jags_builtins;` and `pub mod stan_builtins;` declarations
    - _Requirements: 12.2, 13.2_

- [ ] 5. Implement completion filtering for JAGS/Stan files
  - [ ] 5.1 Add JAGS/Stan completion branches in `crates/raven/src/handlers.rs`
    - At the top of `completion()`, match on `file_type_from_uri(uri)`
    - For `FileType::Jags`: return JAGS keywords + distributions + functions + file-local symbols (via `collect_document_completions`), exclude R keywords/builtins/package exports
    - For `FileType::Stan`: return Stan types + block keywords + control flow + functions + file-local symbols, exclude R keywords/builtins/package exports
    - For `FileType::R`: fall through to existing logic unchanged
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [ ]* 5.2 Write property test for JAGS completions excluding R items (Property 5)
    - **Property 5: JAGS completions exclude R-specific items**
    - Generate JAGS file content, request completions, verify no R reserved words or R-only builtins appear
    - **Validates: Requirements 12.1**

  - [ ]* 5.3 Write property test for JAGS completions including all built-ins (Property 6)
    - **Property 6: JAGS completions include all JAGS built-ins**
    - Generate JAGS file content, request completions at a valid position, verify all JAGS distributions/functions/keywords are present
    - **Validates: Requirements 12.2, 12.3, 12.4**

  - [ ]* 5.4 Write property test for JAGS file-local symbol completions (Property 7)
    - **Property 7: JAGS completions include file-local symbols**
    - Generate JAGS content with random assignments (`x <- ...`), verify assigned names appear in completions
    - **Validates: Requirements 12.5**

  - [ ]* 5.5 Write property test for Stan completions excluding R items (Property 8)
    - **Property 8: Stan completions exclude R-specific items**
    - Generate Stan file content, request completions, verify no R reserved words or R-only builtins appear
    - **Validates: Requirements 13.1**

  - [ ]* 5.6 Write property test for Stan completions including all built-ins (Property 9)
    - **Property 9: Stan completions include all Stan built-ins**
    - Generate Stan file content, request completions at a valid position, verify all Stan types/blocks/control flow/functions are present
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.5**

  - [ ]* 5.7 Write property test for Stan file-local symbol completions (Property 10)
    - **Property 10: Stan completions include file-local symbols**
    - Generate Stan content with random assignments (`x <- ...`), verify assigned names appear in completions
    - **Validates: Requirements 13.6**

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Extend workspace indexing to include JAGS/Stan files
  - [ ] 7.1 Update `scan_directory()` in `crates/raven/src/state.rs`
    - Extend the file extension check to include `.jags`, `.bugs`, `.stan` (case-insensitive)
    - These files will be parsed by the R tree-sitter parser on a best-effort basis for symbol extraction
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ]* 7.2 Write property test for workspace indexing (Property 11)
    - **Property 11: Workspace indexing includes JAGS/Stan files**
    - Generate random file names with `.jags`, `.bugs`, `.stan` extensions, create temp files, run `scan_directory`, verify indexed
    - **Validates: Requirements 11.1**

- [ ] 8. Register JAGS and Stan languages in VS Code extension
  - [ ] 8.1 Update `editors/vscode/package.json` with language and grammar contributions
    - Add JAGS language entry (`id: "jags"`, extensions: `.jags`, `.bugs`, configuration path)
    - Add Stan language entry (`id: "stan"`, extensions: `.stan`, configuration path)
    - Add `contributes.grammars` array with entries for `source.jags` and `source.stan` pointing to `./syntaxes/` paths
    - Add `"onLanguage:jags"` and `"onLanguage:stan"` to `activationEvents`
    - _Requirements: 5.1, 5.2, 6.1, 6.2, 7.1, 8.1_

  - [ ] 8.2 Create `editors/vscode/jags-language-configuration.json`
    - Define `comments.lineComment` as `#`
    - Define brackets: `{}`, `[]`, `()`
    - Define auto-closing pairs for braces, brackets, parens, double quotes
    - Define surrounding pairs
    - _Requirements: 5.2_

  - [ ] 8.3 Create `editors/vscode/stan-language-configuration.json`
    - Define `comments.lineComment` as `//` and `comments.blockComment` as `["/*", "*/"]`
    - Define brackets: `{}`, `[]`, `()`
    - Define auto-closing pairs for braces, brackets, parens, double quotes
    - Define surrounding pairs
    - _Requirements: 6.2_

- [ ] 9. Create TextMate grammar files
  - [ ] 9.1 Create `editors/vscode/syntaxes/jags.tmLanguage.json`
    - Scope name: `source.jags`
    - Patterns for: block keywords (`model`, `data`), control flow (`for`, `in`, `if`, `else`), distribution names, math functions, comments (`#`), numeric literals, string literals, operators (`<-`, `~`, arithmetic, comparison, logical)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ] 9.2 Create `editors/vscode/syntaxes/stan.tmLanguage.json`
    - Scope name: `source.stan`
    - Patterns for: program block keywords, type keywords, constraint keywords (`lower`, `upper`, `offset`, `multiplier`), control flow, line comments (`//`), block comments (`/* */`), operators, numeric literals (int, real, scientific), string literals, distribution suffixes (`_lpdf`, `_lpmf`, `_lcdf`, `_lccdf`, `_rng`)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_

- [ ] 10. Update VS Code extension client configuration
  - [ ] 10.1 Update document selector and file watcher in `editors/vscode/src/extension.ts`
    - Add `{ scheme: 'file', language: 'jags' }`, `{ scheme: 'untitled', language: 'jags' }`, `{ scheme: 'file', language: 'stan' }`, `{ scheme: 'untitled', language: 'stan' }` to `documentSelector`
    - Update file watcher glob to `'**/*.{r,R,rmd,Rmd,qmd,jags,bugs,stan}'`
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ] 10.2 Update `isRFile` helper in `sendActivityNotification` in `editors/vscode/src/extension.ts`
    - Add `.jags`, `.bugs`, `.stan` to the extension list in the `isRFile` check
    - _Requirements: 9.3_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using the `proptest` crate
- LSP features (find references, go to definition, hover, document outline) require no code changes — they already work on a best-effort basis via the R tree-sitter parser (Requirements 3.x, 4.x)
