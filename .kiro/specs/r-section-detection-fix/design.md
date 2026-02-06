# Design Document: R Section Detection Fix

## Overview

This design addresses the issue where decorative comment separators (like `# ==================`) are incorrectly detected as R code sections, cluttering the document outline. The fix adds a post-match validation step to reject matches where the captured section name consists entirely of delimiter characters.

The solution is minimal and surgical: a single validation check added after the existing regex match, preserving all current behavior for legitimate sections while filtering out decorative separators.

## Architecture

The fix integrates into the existing `SymbolExtractor::extract_sections()` method in `handlers.rs`. No new modules or significant architectural changes are required.

```
┌─────────────────────────────────────────────────────────────┐
│                    Section Detection Flow                    │
├─────────────────────────────────────────────────────────────┤
│  1. Iterate over document lines                             │
│  2. Apply Section_Pattern regex                             │
│  3. Extract capture group 3 (Section_Name)                  │
│  4. [NEW] Validate Section_Name has non-delimiter content   │
│  5. If valid, create RawSymbol with Module kind             │
└─────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### Modified Component: `extract_sections()` in `handlers.rs`

**Current Location**: `crates/raven/src/handlers.rs` (line ~860)

**Current Behavior**:
```rust
pub fn extract_sections(&self) -> Vec<RawSymbol> {
    // ... regex matching ...
    if let Some(name_match) = caps.get(3) {
        let name = name_match.as_str().trim().to_string();
        // Creates section symbol unconditionally
        sections.push(RawSymbol { ... });
    }
}
```

**Modified Behavior**:
```rust
pub fn extract_sections(&self) -> Vec<RawSymbol> {
    // ... regex matching ...
    if let Some(name_match) = caps.get(3) {
        let name = name_match.as_str().trim().to_string();
        
        // NEW: Skip if name consists only of delimiter characters
        if is_delimiter_only(&name) {
            continue;
        }
        
        sections.push(RawSymbol { ... });
    }
}
```

### New Helper Function: `is_delimiter_only()`

**Purpose**: Determines if a string consists entirely of delimiter characters and/or whitespace.

**Signature**:
```rust
/// Returns true if the string contains only delimiter characters (#, -, =, *, +)
/// and/or whitespace. Returns true for empty strings.
fn is_delimiter_only(s: &str) -> bool
```

**Implementation**:
```rust
fn is_delimiter_only(s: &str) -> bool {
    const DELIMITER_CHARS: &[char] = &['#', '-', '=', '*', '+'];
    s.chars().all(|c| c.is_whitespace() || DELIMITER_CHARS.contains(&c))
}
```

**Rationale for inline helper vs. separate module**:
- Single-use function with simple logic
- No external dependencies
- Keeps related code together in `handlers.rs`
- Can be placed near `section_pattern()` for discoverability

## Data Models

No new data models are required. The existing `RawSymbol` struct remains unchanged.

**Delimiter Characters Set**:
| Character | Usage in Section_Pattern |
|-----------|-------------------------|
| `#`       | `#{4,}` delimiter       |
| `-`       | `-{4,}` delimiter       |
| `=`       | `={4,}` delimiter       |
| `*`       | `\*{4,}` delimiter      |
| `+`       | `\+{4,}` delimiter      |

This set is derived directly from the Section_Pattern regex's capture group 4.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Delimiter validation correctness

*For any* string `s`, `is_delimiter_only(s)` SHALL return `true` if and only if every character in `s` is either a delimiter character (`#`, `-`, `=`, `*`, `+`) or whitespace.

This is a bidirectional property:
- If all characters are delimiters/whitespace → returns `true`
- If at least one character is NOT a delimiter/whitespace → returns `false`

**Validates: Requirements 1.1, 1.2, 1.3**

### Property 2: Section detection consistency

*For any* R comment line that matches the Section_Pattern regex, `extract_sections()` SHALL include it in the result if and only if the captured Section_Name (group 3, trimmed) contains at least one non-delimiter, non-whitespace character.

**Validates: Requirements 2.1-2.6, 3.1-3.11, 4.1-4.6**

## Error Handling

This feature does not introduce new error conditions. The validation is a simple boolean check that either accepts or rejects a match—no exceptions or error states are possible.

**Edge Cases Handled**:
- Empty string after trim: `is_delimiter_only("")` returns `true` (rejected)
- Whitespace-only string: `is_delimiter_only("   ")` returns `true` (rejected)
- Mixed delimiters: `is_delimiter_only("=-==-=")` returns `true` (rejected)
- Single non-delimiter char: `is_delimiter_only("a")` returns `false` (accepted)

## Testing Strategy

### Unit Tests

Unit tests verify specific examples and edge cases. These are valuable for documenting expected behavior and catching regressions on known inputs.

**Delimiter-only rejection tests** (Requirement 3):
- `# ==================` → not detected
- `################################################################################` → not detected
- `# ----` → not detected
- `# ****` → not detected
- `# ====` → not detected
- `# ++++` → not detected
- `# ==== ==== ====` → not detected
- `# --------` → not detected
- `# = ----` → not detected
- `# ---- ====` → not detected
- `# =-==-= ----` → not detected

**Standard section acceptance tests** (Requirement 2):
- `# Section Name ----` → detected as "Section Name"
- `## Subsection ####` → detected with level 2
- `# %% Cell Name ----` → detected (RStudio style)
- `### Deep Section ========` → detected with level 3
- `# Section 1.2 ----` → detected (numbers with letters)
- `# WORKFLOW OVERVIEW: ----` → detected (colon in name)

**Edge case tests** (Requirement 4):
- `# 123 ----` → detected (numbers only)
- `# @TODO: Fix this ----` → detected (special chars)
- `# my_section ----` → detected (underscores)
- `# Section.1 ----` → detected (dots)
- `# ... ----` → detected (dots only)
- `# 日本語 ----` → detected (Unicode)

### Property-Based Tests

Property tests verify universal properties across many generated inputs, providing stronger correctness guarantees than example-based tests alone.

**Test Configuration**:
- Library: `proptest` (already used in codebase)
- Minimum iterations: 100 per property
- Tag format: `Feature: r-section-detection-fix, Property N: <description>`

**Property Test 1: Delimiter validation correctness**
- **Feature: r-section-detection-fix, Property 1: Delimiter validation correctness**
- Generate random strings from delimiter charset (`#`, `-`, `=`, `*`, `+`) plus whitespace → assert `is_delimiter_only()` returns `true`
- Generate random strings guaranteed to contain at least one non-delimiter character → assert `is_delimiter_only()` returns `false`
- **Validates: Requirements 1.1, 1.2, 1.3**

**Property Test 2: Section detection consistency**
- **Feature: r-section-detection-fix, Property 2: Section detection consistency**
- Generate valid R section comment lines with random names containing non-delimiter content → assert section is detected
- Generate R comment lines where captured name is delimiter-only → assert section is NOT detected
- **Validates: Requirements 2.1-2.6, 3.1-3.11, 4.1-4.6**

## Implementation Notes

### Code Location

All changes are in `crates/raven/src/handlers.rs`:

1. Add `is_delimiter_only()` helper function near `section_pattern()` (~line 65)
2. Modify `extract_sections()` to call the helper (~line 875)

### Minimal Diff

The implementation requires approximately:
- 8 lines for `is_delimiter_only()` function
- 4 lines added to `extract_sections()` (validation + continue)
- ~50 lines of new tests

### Backward Compatibility

- All existing tests for standard section detection continue to pass
- No changes to public API
- No changes to LSP protocol behavior
- Only filtering behavior is added, no existing sections are affected
