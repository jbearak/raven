# Design Document: Reserved Keyword Handling

## Overview

This design addresses the incorrect handling of R reserved words in the Raven LSP. Currently, the LSP has two bugs:

1. **False definitions**: Code like `else <- 1` incorrectly creates a definition for `else`
2. **False undefined variable diagnostics**: Misplaced `else` reports "Undefined variable: else" instead of relying on tree-sitter parse errors

The solution introduces a centralized `Reserved_Word_Module` that provides a constant list of R reserved words and an `is_reserved_word()` function. This module is then used by:
- Definition extraction (to skip reserved words)
- Undefined variable checking (to skip reserved words)
- Completion generation (to exclude reserved words from identifier completions)
- Document symbol collection (to exclude reserved words)

## Architecture

```mermaid
graph TD
    RWM[reserved_words.rs] --> |is_reserved_word| DE[Definition Extraction<br/>scope.rs]
    RWM --> |is_reserved_word| UVC[Undefined Variable Checker<br/>handlers.rs]
    RWM --> |is_reserved_word| CP[Completion Provider<br/>handlers.rs]
    RWM --> |is_reserved_word| DSP[Document Symbol Provider<br/>handlers.rs]
    
    DE --> |ScopeArtifacts + Interface| SR[Scope Resolution]
    UVC --> |Diagnostics| D[diagnostics()]
    CP --> |CompletionItems| C[completion()]
    DSP --> |SymbolInformation| DS[document_symbol()]
```

The `reserved_words` module is stateless and callable from any component. It uses a zero-allocation lookup via `matches!` macro for minimal overhead in hot paths.

## Components and Interfaces

### Reserved Word Module (`reserved_words.rs`)

A new module at `crates/raven/src/reserved_words.rs`:

```rust
/// Complete list of R reserved words for this feature.
/// These words cannot be used as user-defined identifiers.
pub const RESERVED_WORDS: &[&str] = &[
    "if", "else", "repeat", "while", "function", "for", "in", "next", "break",
    "TRUE", "FALSE", "NULL", "Inf", "NaN",
    "NA", "NA_integer_", "NA_real_", "NA_complex_", "NA_character_",
];

/// Check if a name is an R reserved word.
/// 
/// Returns `true` if `name` matches any of the R reserved words,
/// `false` otherwise. The check is case-sensitive.
pub fn is_reserved_word(name: &str) -> bool {
    matches!(
        name,
        "if"
            | "else"
            | "repeat"
            | "while"
            | "function"
            | "for"
            | "in"
            | "next"
            | "break"
            | "TRUE"
            | "FALSE"
            | "NULL"
            | "Inf"
            | "NaN"
            | "NA"
            | "NA_integer_"
            | "NA_real_"
            | "NA_complex_"
            | "NA_character_"
    )
}
```

This avoids heap allocation and hashing while keeping the check inlineable.

### Modified Components

#### Definition Extraction (`scope.rs`)

The `try_extract_assignment` function is modified to skip reserved words:

```rust
fn try_extract_assignment(node: Node, content: &str, uri: &Url) -> Option<ScopedSymbol> {
    // ... existing parsing logic to get name ...
    
    // Skip reserved words - they cannot be defined
    if crate::reserved_words::is_reserved_word(&name) {
        return None;
    }
    
    // ... rest of function ...
}
```

This ensures reserved words are excluded from:
- The exported interface (Requirement 2.1)
- The scope timeline (Requirement 2.2)

Both left-assignment (`<-`, `=`, `<<-`) and right-assignment (`->`) forms are covered since they share the same extraction function.

#### Undefined Variable Checker (`handlers.rs`)

The `collect_undefined_variables_position_aware` function is modified to skip reserved words early:

```rust
for (name, usage_node) in used {
    // Skip reserved words BEFORE any other checks (Requirement 3.4)
    if crate::reserved_words::is_reserved_word(&name) {
        continue;
    }
    
    // ... existing checks for builtins, scope, packages ...
}
```

This ensures reserved words never produce "Undefined variable" diagnostics regardless of their position in the code.

#### Completion Provider (`handlers.rs`)

The `completion` function already adds keywords as completions. The modification filters reserved words from identifier-derived completions:

```rust
// Add symbols from current document (local definitions take precedence)
collect_document_completions(tree.root_node(), &text, &mut items, &mut seen_names);

// Filter out reserved words from identifier completions
// (Keywords are added separately with CompletionItemKind::KEYWORD)
items.retain(|item| {
    item.kind == Some(CompletionItemKind::KEYWORD) 
        || !crate::reserved_words::is_reserved_word(&item.label)
});
```

This ensures:
- Reserved words are NOT suggested as identifier completions (Requirement 5.1)
- Reserved words ARE still available as keyword completions (Requirement 5.3)

#### Document Symbol Provider (`handlers.rs`)

The `collect_symbols` function is modified to skip reserved words:

```rust
fn collect_symbols(node: Node, text: &str, symbols: &mut Vec<SymbolInformation>) {
    if node.kind() == "binary_operator" {
        // ... existing parsing logic ...
        
        if matches!(op_text, "<-" | "=" | "<<-") && lhs.kind() == "identifier" {
            let name = node_text(lhs, text).to_string();
            
            // Skip reserved words - they should not appear as document symbols
            if crate::reserved_words::is_reserved_word(&name) {
                // Continue to recurse but don't add this symbol
            } else {
                // ... add symbol to list ...
            }
        }
    }
    // ... recurse ...
}
```

## Data Models

### Reserved Word List

The complete list of reserved words for this feature:

| Category | Words |
|----------|-------|
| Control Flow | `if`, `else`, `repeat`, `while`, `function`, `for`, `in`, `next`, `break` |
| Logical Constants | `TRUE`, `FALSE` |
| Null | `NULL` |
| Special Numeric | `Inf`, `NaN` |
| NA Variants | `NA`, `NA_integer_`, `NA_real_`, `NA_complex_`, `NA_character_` |

This list is based on R's official reserved words. Note that `library`, `require`, `return`, `print` are NOT reserved words—they are regular functions that can be redefined.

### Lookup Performance

The `matches!` expression compiles to a jump table or series of comparisons, providing O(1) lookup with zero allocation. This is more efficient than `HashSet` for small, fixed sets.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Reserved Word Identification

*For any* string that is in the set of R reserved words (`if`, `else`, `repeat`, `while`, `function`, `for`, `in`, `next`, `break`, `TRUE`, `FALSE`, `NULL`, `Inf`, `NaN`, `NA`, `NA_integer_`, `NA_real_`, `NA_complex_`, `NA_character_`), `is_reserved_word()` SHALL return `true`. *For any* string that is NOT in this set, `is_reserved_word()` SHALL return `false`.

**Validates: Requirements 1.1, 1.2**

### Property 2: Definition Extraction Exclusion

*For any* R code containing an assignment (left-assignment `<-`, `=`, `<<-` or right-assignment `->`) where the target identifier is a reserved word, the definition extractor SHALL NOT include that reserved word in either the exported interface or the scope timeline.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

### Property 3: Undefined Variable Check Exclusion

*For any* R code containing a reserved word used as an identifier (in any syntactic position), the undefined variable checker SHALL NOT emit an "Undefined variable" diagnostic for that reserved word.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 4: Completion Exclusion

*For any* completion request that aggregates identifiers from document, scope, workspace index, or package sources, the completion provider SHALL NOT include reserved words in the identifier completion list. Keyword completions (with `CompletionItemKind::KEYWORD`) may still include reserved words.

**Validates: Requirements 5.1, 5.2, 5.3**

### Property 5: Document Symbol Exclusion

*For any* document symbol collection where a candidate symbol name is a reserved word, the provider SHALL NOT include it in the emitted symbol list.

**Validates: Requirements 6.1, 6.2**

## Error Handling

### Invalid Input Handling

The `is_reserved_word()` function handles all string inputs gracefully:
- Empty strings return `false` (not a reserved word)
- Strings with special characters return `false` (not a reserved word)
- Case-sensitive matching: `TRUE` is reserved, but `true` is not

### Parse Error Preservation

When reserved words appear in invalid positions (e.g., `else` without preceding `if`), tree-sitter will report parse errors. This feature does NOT suppress or modify those errors (Requirement 4.2). The only change is that we no longer report "Undefined variable: else" for such cases—the parse error is the correct diagnostic (Requirement 4.1).

### Edge Cases

| Input | Expected Behavior |
|-------|-------------------|
| `else <- 1` | No definition created, no undefined variable warning, parse error from tree-sitter |
| `if <- function() {}` | No definition created, no undefined variable warning, parse error from tree-sitter |
| `TRUE <- FALSE` | No definition created, no undefined variable warning |
| `myelse <- 1` | Normal definition created (not a reserved word) |
| `ELSE <- 1` | Normal definition created (case-sensitive, `ELSE` is not reserved) |
| `el` completion | Suggests `el` if defined, does NOT suggest `else` as identifier |

## Testing Strategy

### Dual Testing Approach

This feature uses both unit tests and property-based tests:
- **Unit tests**: Verify specific examples, edge cases, and error conditions
- **Property tests**: Verify universal properties across all inputs

### Unit Tests

1. **Reserved word module tests**:
   - Test each reserved word returns `true`
   - Test non-reserved words return `false`
   - Test edge cases: empty string, special characters, case sensitivity

2. **Definition extraction tests**:
   - Test `else <- 1` creates no definition
   - Test `if <- function() {}` creates no definition
   - Test `TRUE <- FALSE` creates no definition
   - Test `myelse <- 1` creates normal definition (positive control)

3. **Undefined variable tests**:
   - Test `else` alone produces no "Undefined variable" diagnostic
   - Test `if` alone produces no "Undefined variable" diagnostic
   - Test `undefined_var` produces diagnostic (positive control)

4. **Completion tests**:
   - Test reserved words not in identifier completions
   - Test reserved words still appear as keyword completions
   - Test `el` prefix suggests `el` but not `else`

5. **Document symbol tests**:
   - Test `else <- 1` not in symbol list
   - Test `myvar <- 1` in symbol list (positive control)

### Property-Based Tests

Property-based tests verify universal properties across many generated inputs. Each test runs minimum 100 iterations.

**Test Configuration**:
- Framework: `proptest` (Rust property-based testing library)
- Iterations: 100+ per property
- Each test tagged with: **Feature: reserved-keyword-handling, Property N: [property text]**

**Property Test Implementations**:

1. **Property 1 Test**: Generate random strings from the reserved word set and verify `is_reserved_word()` returns `true`. Generate random valid R identifiers not in the set and verify it returns `false`.

2. **Property 2 Test**: Generate R code with assignments to randomly selected reserved words (both left and right assignment forms). Parse and extract definitions. Verify the reserved word does not appear in exported interface or timeline.

3. **Property 3 Test**: Generate R code with reserved words used as identifiers in various positions. Run undefined variable checking. Verify no "Undefined variable" diagnostic is emitted for reserved words.

4. **Property 4 Test**: Generate R code with assignments to reserved words. Generate completions. Verify reserved words don't appear in identifier completion items (but may appear as keywords).

5. **Property 5 Test**: Generate R code with assignments to reserved words. Collect document symbols. Verify reserved words don't appear in symbol list.
