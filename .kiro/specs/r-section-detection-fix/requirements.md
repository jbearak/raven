# Requirements Document

## Introduction

This document specifies requirements for improving R code section detection in the Raven LSP. The current implementation incorrectly matches decorative comment separators (like `# ==================`) as sections, cluttering the document outline. The fix ensures only intentional section markers with actual text content are detected.

**Scope**: This fix applies to the document outline (`textDocument/documentSymbol`) only. Sections do not appear in workspace symbol search (`workspace/symbol`), so that provider is unaffected.

## Root Cause

The Section_Pattern regex uses a lazy quantifier `(\S.+?)` for capture group 3 (the Section_Name). When a comment line consists entirely of Delimiter characters (e.g., `# ==================`), the lazy quantifier captures the minimum substring of delimiter characters as the "name," and the remaining characters satisfy the trailing delimiter group (group 4). For example:

- `# ==================` — group 3 captures `==` as the name, group 4 captures `================`
- `################################################################################` — `#(#*)` consumes leading hashes, group 3 captures `##`, group 4 captures `####`
- `# --------` — group 3 captures `--`, group 4 captures `------`
- `# ---- ====` — group 3 captures `----`, group 4 captures `====`

The fix is a post-match validation step: after the regex matches, check whether the captured Section_Name consists entirely of Delimiter_Characters. If so, reject the match.

## Glossary

- **Section_Detector**: The component responsible for identifying R code sections in source files (`SymbolExtractor::extract_sections()` in `handlers.rs`)
- **Section_Pattern**: The regex pattern used to match R code section comments: `^\s*#(#*)\s*(%%)?\s*(\S.+?)\s*(#{4,}|-{4,}|={4,}|\*{4,}|\+{4,})\s*$`
- **Section_Name**: The text captured by group 3 of Section_Pattern, after trimming whitespace (e.g., "VALIDATION SYSTEM" in `# VALIDATION SYSTEM ----`)
- **Delimiter**: Trailing characters that mark the end of a section comment (`----`, `####`, `====`, `****`, `++++`)
- **Delimiter_Characters**: The set of characters used in delimiters: `#`, `-`, `=`, `*`, `+`
- **Decorative_Separator**: A comment line consisting only of Delimiter_Characters used for visual separation, not as a section marker

## Requirements

### Requirement 1: Section Name Content Validation

**User Story:** As a developer, I want the document outline to only show meaningful section names, so that I can navigate my code effectively without clutter from decorative separators.

#### Acceptance Criteria

1. WHEN the Section_Detector matches a potential section comment, THE Section_Detector SHALL verify that the Section_Name contains at least one character that is NOT a Delimiter_Character (`#`, `-`, `=`, `*`, `+`) and NOT whitespace
2. IF the Section_Name contains only Delimiter_Characters and/or whitespace, THEN THE Section_Detector SHALL reject the match and not create a section entry
3. IF the Section_Name contains only whitespace or is empty, THEN THE Section_Detector SHALL reject the match and not create a section entry

### Requirement 2: Standard Section Pattern Support (Existing Behavior)

**User Story:** As an R developer, I want the LSP to continue recognizing all standard R section comment patterns, so that my existing code sections are properly detected.

#### Acceptance Criteria

1. WHEN a comment matches the pattern `# Section Name ----`, THE Section_Detector SHALL detect it as a valid section
2. WHEN a comment matches the pattern `## Subsection ####`, THE Section_Detector SHALL detect it as a valid section with heading level 2
3. WHEN a comment matches the pattern `# %% Cell Name ----`, THE Section_Detector SHALL detect it as a valid section (RStudio/Jupyter cell style)
4. WHEN a comment matches the pattern `### Deep Section ========`, THE Section_Detector SHALL detect it as a valid section with heading level 3
5. WHEN a comment contains mixed content like `# Section 1.2 ----`, THE Section_Detector SHALL detect it as a valid section (numbers with letters)
6. WHEN a comment matches the pattern `# WORKFLOW OVERVIEW: ----`, THE Section_Detector SHALL detect it as a valid section (colon in name)

### Requirement 3: Decorative Separator Rejection

**User Story:** As a developer, I want decorative separator lines to be ignored, so that my document outline remains clean and navigable.

#### Acceptance Criteria

1. WHEN a comment line is `# ==================`, THE Section_Detector SHALL NOT detect it as a section
2. WHEN a comment line is `################################################################################`, THE Section_Detector SHALL NOT detect it as a section
3. WHEN a comment line is `# ----`, THE Section_Detector SHALL NOT detect it as a section
4. WHEN a comment line is `# ****`, THE Section_Detector SHALL NOT detect it as a section
5. WHEN a comment line is `# ====`, THE Section_Detector SHALL NOT detect it as a section
6. WHEN a comment line is `# ++++`, THE Section_Detector SHALL NOT detect it as a section
7. WHEN a comment line is `# ==== ==== ====`, THE Section_Detector SHALL NOT detect it as a section (multiple delimiter groups with spaces)
8. WHEN a comment line is `# --------`, THE Section_Detector SHALL NOT detect it as a section (long single-type delimiter — regex captures `--` as name)
9. WHEN a comment line is `# = ----`, THE Section_Detector SHALL NOT detect it as a section (single delimiter character as name)
10. WHEN a comment line is `# ---- ====`, THE Section_Detector SHALL NOT detect it as a section (two delimiter groups separated by space)
11. WHEN a comment line is `# =-==-= ----`, THE Section_Detector SHALL NOT detect it as a section (mixed delimiter characters as name)

### Requirement 4: Edge Cases

**User Story:** As a developer, I want edge cases to be handled correctly, so that the section detection is robust.

#### Acceptance Criteria

1. WHEN a comment contains only numbers like `# 123 ----`, THE Section_Detector SHALL detect it as a valid section (numbers are not Delimiter_Characters — matches RStudio behavior)
2. WHEN a comment contains special characters with letters like `# @TODO: Fix this ----`, THE Section_Detector SHALL detect it as a valid section
3. WHEN a comment contains underscores with letters like `# my_section ----`, THE Section_Detector SHALL detect it as a valid section
4. WHEN a comment contains dots with letters like `# Section.1 ----`, THE Section_Detector SHALL detect it as a valid section
5. WHEN a comment contains only dots like `# ... ----`, THE Section_Detector SHALL detect it as a valid section (dots are not Delimiter_Characters)
6. WHEN a comment contains Unicode characters like `# 日本語 ----`, THE Section_Detector SHALL detect it as a valid section (non-ASCII characters are not Delimiter_Characters)

## Implementation Notes

- The fix SHALL be implemented as a post-match validation in `extract_sections()` (`handlers.rs` ~line 872), not as a modification to the Section_Pattern regex
- After the regex captures group 3 and trims whitespace, if every remaining character is a Delimiter_Character, the match SHALL be skipped
- The Delimiter_Characters set (`#`, `-`, `=`, `*`, `+`) matches the characters used in the Section_Pattern's trailing delimiter group (group 4)
- Existing tests for standard section detection (Requirement 2) SHALL continue to pass without modification
