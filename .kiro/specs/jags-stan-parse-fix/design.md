# JAGS/Stan Parse Fix — Bugfix Design

## Overview

The `parse_document` function in `crates/raven/src/state.rs` explicitly returns `None` for JAGS and Stan file types, preventing tree-sitter AST generation. This causes all tree-dependent LSP handlers (find-references, go-to-definition, hover, document symbols) to bail out early when `doc.tree` is `None`. The fix is a one-line change: route JAGS/Stan files through `parse_r(contents)` instead of returning `None`. The R tree-sitter parser produces partial/best-effort ASTs for non-R syntax, which is sufficient for these LSP features. This was the original design intent documented in the jags-stan-support spec.

## Glossary

- **Bug_Condition (C)**: A JAGS or Stan file is opened/edited, causing `parse_document` to return `None` instead of a best-effort AST
- **Property (P)**: JAGS/Stan files should receive a tree-sitter AST from `parse_r`, enabling tree-dependent LSP features to operate on a best-effort basis
- **Preservation**: Diagnostics suppression, completion filtering, workspace indexing, and R file parsing must remain unchanged
- **`parse_document`**: The function in `crates/raven/src/state.rs` (line 252) that dispatches parsing based on `FileType`
- **`parse_r`**: The function in `crates/raven/src/state.rs` (line 245) that creates a tree-sitter parser with the R grammar and parses content
- **`FileType`**: Enum in `crates/raven/src/file_type.rs` with variants `R`, `Jags`, `Stan`
- **`doc.tree`**: The `Option<Tree>` field on `Document` that stores the parsed AST; when `None`, all tree-dependent handlers return early

## Bug Details

### Bug Condition

The bug manifests when any JAGS (`.jags`, `.bugs`) or Stan (`.stan`) file is opened or edited. The `parse_document` function matches `FileType::Jags | FileType::Stan` and returns `None`, so `Document.tree` is always `None` for these file types. Every tree-dependent LSP handler checks `doc.tree.as_ref()?` and bails out immediately.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type (Rope, FileType)
  OUTPUT: boolean

  RETURN input.fileType IN [FileType::Jags, FileType::Stan]
END FUNCTION
```

### Examples

- Opening `model.jags` containing `x <- dnorm(0, 1)` → find-references on `x` returns empty because `doc.tree` is `None`; expected: returns locations of `x` based on best-effort R parse
- Opening `model.stan` containing `real alpha; alpha = 1.0;` → go-to-definition on `alpha` returns nothing; expected: navigates to the assignment on a best-effort basis
- Opening `model.bugs` → document symbols returns empty list; expected: returns symbols extracted from the best-effort AST
- Hovering over an identifier in a `.stan` file → no hover info; expected: hover info from cross-file scope resolution using the partial AST

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- R files (`.r`, `.R`, `.rmd`, `.Rmd`, `.qmd`) must continue to be parsed with `parse_r` and produce full ASTs exactly as before
- Diagnostics for JAGS/Stan files must continue to return empty (suppression is in `handlers::diagnostics_from_snapshot` via `file_type_from_uri(uri) != FileType::R`, independent of `parse_document`)
- Completion for JAGS files must continue to return JAGS-specific completions (checked via `doc.file_type` match in `handlers::completion`, independent of `parse_document`)
- Completion for Stan files must continue to return Stan-specific completions (same mechanism)
- Workspace indexing of JAGS/Stan files must continue to work (indexing already calls `parse_r` directly in `scan_directory`, independent of `parse_document`)

**Scope:**
All inputs where `FileType` is `R` are completely unaffected. The only change is in the `FileType::Jags | FileType::Stan` arm of `parse_document`. Diagnostics suppression, completion filtering, and workspace indexing all check `FileType` independently and do not depend on `parse_document`'s return value.

## Hypothesized Root Cause

Based on the code analysis, the root cause is definitively identified (not hypothesized):

1. **Explicit `None` return in `parse_document`**: At `state.rs` line 257, the match arm `FileType::Jags | FileType::Stan => None` prevents AST generation. The comment says "Non-R documents use text-based completion/diagnostic routing instead of being forced through tree-sitter-r" — this was overly conservative. The original jags-stan-support design explicitly states these files should continue using the R tree-sitter parser for best-effort LSP features.

2. **Cascading effect on all tree-dependent handlers**: Because `Document.tree` is `None`:
   - `references()` bails at `doc.tree.as_ref()?` (handlers.rs line 10370)
   - `goto_definition()` bails at `doc.tree.as_ref()?` (handlers.rs line 10104)
   - `hover()` bails at `doc.tree.as_ref()?` (handlers.rs line 9184)
   - `document_symbol()` bails at `doc.tree.as_ref()?` (handlers.rs line 2421)

3. **No other code path is affected**: Diagnostics suppression checks `file_type_from_uri(uri) != FileType::R` in `diagnostics_from_snapshot`. Completion checks `doc.file_type` in the completion handler. Workspace indexing calls `parse_r` directly. None of these depend on `parse_document`.

## Correctness Properties

Property 1: Bug Condition — JAGS/Stan files receive a tree-sitter AST

_For any_ input where the file type is `Jags` or `Stan` (isBugCondition returns true), the fixed `parse_document` function SHALL return `Some(Tree)` by calling `parse_r(contents)`, producing a best-effort partial AST that enables tree-dependent LSP handlers to operate.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**

Property 2: Preservation — R file parsing unchanged

_For any_ input where the file type is `R` (isBugCondition returns false), the fixed `parse_document` function SHALL produce the same `Option<Tree>` result as the original function, preserving all existing R parsing behavior.

**Validates: Requirements 3.1**

Property 3: Preservation — Diagnostics suppression unchanged

_For any_ JAGS or Stan file, the diagnostics handler SHALL continue to return an empty diagnostics list, regardless of whether `parse_document` now returns a tree.

**Validates: Requirements 3.2**

Property 4: Preservation — Completion filtering unchanged

_For any_ JAGS file, the completion handler SHALL continue to return JAGS-specific completions. _For any_ Stan file, the completion handler SHALL continue to return Stan-specific completions. Neither shall be affected by the parse fix.

**Validates: Requirements 3.3, 3.4**

Property 5: Preservation — Workspace indexing unchanged

_For any_ JAGS or Stan file in the workspace, the indexing system SHALL continue to index them and include their symbols in cross-file references, unaffected by the parse fix.

**Validates: Requirements 3.5**

## Fix Implementation

### Changes Required

**File**: `crates/raven/src/state.rs`

**Function**: `parse_document` (line 252)

**Specific Changes**:
1. **Remove the `None` return for JAGS/Stan**: Change the match arm `FileType::Jags | FileType::Stan => None` to call `parse_r(contents)` instead.

**Before:**
```rust
fn parse_document(contents: &Rope, file_type: FileType) -> Option<Tree> {
    match file_type {
        FileType::R => parse_r(contents),
        // Raven only ships an R parser today. Non-R documents use text-based
        // completion/diagnostic routing instead of being forced through tree-sitter-r.
        FileType::Jags | FileType::Stan => None,
    }
}
```

**After:**
```rust
fn parse_document(contents: &Rope, file_type: FileType) -> Option<Tree> {
    match file_type {
        FileType::R | FileType::Jags | FileType::Stan => parse_r(contents),
    }
}
```

This is a one-line change. The match becomes exhaustive over all variants routing to `parse_r`, which can be simplified to remove the match entirely, but keeping the match preserves exhaustiveness checking if new `FileType` variants are added later.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm the root cause analysis.

**Test Plan**: Write tests that create `Document` instances with JAGS/Stan file types and assert that `doc.tree` is populated. Run these tests on the UNFIXED code to observe failures.

**Test Cases**:
1. **JAGS Document Tree Test**: Create a `Document` with `FileType::Jags` content, assert `doc.tree.is_some()` (will fail on unfixed code — tree is `None`)
2. **Stan Document Tree Test**: Create a `Document` with `FileType::Stan` content, assert `doc.tree.is_some()` (will fail on unfixed code — tree is `None`)
3. **BUGS Extension Tree Test**: Create a `Document` via `new_with_uri` with a `.bugs` URI, assert `doc.tree.is_some()` (will fail on unfixed code)
4. **Handler Invocation Test**: Call `document_symbol` on a JAGS document, assert it returns `Some(...)` (will fail on unfixed code — returns `None`)

**Expected Counterexamples**:
- `Document::new_with_file_type("x <- 1", None, FileType::Jags).tree` is `None`
- `document_symbol(state, &jags_uri)` returns `None`
- Root cause confirmed: `parse_document` returns `None` for non-R file types

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := parse_document_fixed(input.contents, input.fileType)
  ASSERT result IS Some(Tree)
  ASSERT result.unwrap().root_node().child_count() >= 0
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT parse_document_original(input) = parse_document_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many random R code strings to verify parsing behavior is unchanged
- It catches edge cases in tree-sitter parsing that manual tests might miss
- It provides strong guarantees that R file behavior is completely unaffected

**Test Plan**: Observe behavior on UNFIXED code first for R files, then write property-based tests capturing that behavior.

**Test Cases**:
1. **R File Parsing Preservation**: Generate random R code strings, verify `parse_document` with `FileType::R` produces the same tree structure before and after the fix
2. **Diagnostics Suppression Preservation**: Create JAGS/Stan documents with the fix applied, verify `diagnostics()` still returns empty
3. **Completion Filtering Preservation**: Create JAGS/Stan documents with the fix applied, verify completion returns language-specific items (not R items)

### Unit Tests

- Test that `parse_document` returns `Some(Tree)` for `FileType::Jags`
- Test that `parse_document` returns `Some(Tree)` for `FileType::Stan`
- Test that `parse_document` returns `Some(Tree)` for `FileType::R` (unchanged)
- Test that `Document::new_with_uri` with a `.jags` URI produces a non-`None` tree
- Test that `Document::new_with_uri` with a `.stan` URI produces a non-`None` tree
- Test that `document_symbol` returns symbols for a JAGS file with R-like assignments
- Test that `references` finds identifier occurrences in a Stan file
- Test that diagnostics remain empty for JAGS/Stan files after the fix

### Property-Based Tests

- Generate random text content with JAGS/Stan file types, verify `parse_document` always returns `Some(Tree)` (fix checking)
- Generate random R code strings with `FileType::R`, verify `parse_document` returns the same result as before (preservation)
- Generate random JAGS/Stan content, verify diagnostics remain empty after the fix (preservation)

### Integration Tests

- Open a JAGS file, request document symbols, verify non-empty response for files with R-like syntax
- Open a Stan file, request find-references on an identifier, verify locations are returned
- Open a JAGS file, request hover on an identifier, verify hover info is returned
- Verify that switching between R and JAGS files produces correct behavior for each
