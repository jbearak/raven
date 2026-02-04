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
    RWM[reserved_words.rs] --> |is_reserved_word| DE[Definition Extraction<br/>scope.rs (all extract_* entry points)]
    RWM --> |is_reserved_word| UVC[Undefined Variable Checker<br/>handlers.rs]
    RWM --> |is_reserved_word| CP[Completion Provider<br/>handlers.rs<br/>scope + workspace + package sources]
    RWM --> |is_reserved_word| DSP[Document Symbol Provider<br/>handlers.rs<br/>AST + scope fallback]
    
    DE --> |ScopeArtifacts + Interface| SR[Scope Resolution]
    UVC --> |Diagnostics| D[diagnostics()]
    CP --> |CompletionItems (post-dedup)| C[completion()]
    DSP --> |SymbolInformation (final filter)| DS[document_symbol()]
```

The `reserved_words` module remains stateless and callable from any component. It will use a zero-allocation lookup so hot paths pay minimal overhead.

## Components and Interfaces

### Reserved Word Module (`reserved_words.rs`)

A new module at `crates/raven/src/reserved_words.rs`:

```rust
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

Apply the reserved-word guard to **all definition entry points**, not only `try_extract_assignment`:

- `try_extract_assignment` (left/right assignments, including `=` forms where applicable)
- `extract_function_definition` and helpers that record function names
- `extract_replacement_function` or other specialized definition extractors
- Any path that appends to `ScopeArtifacts` timeline or exported interface
- Workspace-index ingestion that rehydrates definitions into scope artifacts

Implementation detail: parse identifier text as `&str` and run `is_reserved_word` **before** cloning/allocating; if `true`, short-circuit and emit no definition event/export.

#### Undefined Variable Checker (`handlers.rs`)

The `collect_undefined_variables_position_aware` function is modified to skip reserved words early:

```rust
for (name, usage_node) in used {
    // Skip reserved words BEFORE any other checks
    if crate::reserved_words::is_reserved_word(&name) {
        continue;
    }
    
    // ... existing checks for builtins, scope, packages ...
}
```

#### Completion Provider (`handlers.rs`)

Filter reserved words at the **final aggregation point** for identifier completions so all sources are covered:

- Document-derived symbols (current file)
- Scope-resolved symbols (other open files)
- Workspace index symbols (closed files)
- Package/built-in symbols included in identifier lists

Just before emitting `CompletionItem`s, skip any `name` where `is_reserved_word(name)` is `true`; this prevents leakage even if an upstream collector misses a path. Keyword-specific completions remain unaffected.

#### Document Symbol Provider (`handlers.rs`)

Apply the reserved-word filter in both symbol collection paths:

- AST traversal that extracts assignment-like symbols
- Any fallback that derives symbols from `ScopeArtifacts` or workspace index

Filter at the emission point so no symbol with a reserved name is added, regardless of source.

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

This list is based on R's official reserved words. Note that `library`, `require`, `return`, `print` are NOT reserved words - they are regular functions that can be redefined.

### Lookup Performance

The `matches!` expression is zero-allocation and inlineable, avoiding `HashSet` initialization while retaining O(1) lookup with lower constant cost.



## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Reserved Word Identification

*For any* string that is in the set of R reserved words (`if`, `else`, `repeat`, `while`, `function`, `for`, `in`, `next`, `break`, `TRUE`, `FALSE`, `NULL`, `Inf`, `NaN`, `NA`, `NA_integer_`, `NA_real_`, `NA_complex_`, `NA_character_`), `is_reserved_word()` SHALL return `true`. *For any* string that is a valid R identifier but NOT in this set, `is_reserved_word()` SHALL return `false`.

**Validates: Requirements 1.1, 1.2**

### Property 2: Definition Extraction Exclusion

*For any* R code containing a definition in any supported form (left/right assignment, function definition, replacement function, or other extractor path) where the declared identifier is a reserved word, the definition extractor SHALL NOT include that reserved word in either the exported interface or the scope timeline.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

### Property 3: Undefined Variable Check Exclusion

*For any* R code containing a reserved word used as an identifier (in any syntactic position), the undefined variable checker SHALL NOT emit an "Undefined variable" diagnostic for that reserved word.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 4: Completion Exclusion

*For any* completion request that aggregates identifiers from document, scope, workspace index, or package sources, the completion provider SHALL NOT include reserved words in the identifier completion list (keyword completions may still surface them as keywords).

**Validates: Requirements 5.1, 5.2**

### Property 5: Document Symbol Exclusion

*For any* document symbol collection (AST or scope-derived) where a candidate symbol name is a reserved word, the provider SHALL NOT include it in the emitted symbol list.

**Validates: Requirements 6.1, 6.2**

## Error Handling

### Invalid Input Handling

The `is_reserved_word()` function handles all string inputs gracefully:
- Empty strings return `false` (not a reserved word)
- Strings with special characters return `false` (not a reserved word)
- Case-sensitive matching: `TRUE` is reserved, but `true` is not

### Parse Error Preservation

When reserved words appear in invalid positions (e.g., `else` without preceding `if`), tree-sitter will report parse errors. This feature does NOT suppress or modify those errors. The only change is that we no longer report "Undefined variable: else" for such cases—the parse error is the correct diagnostic.

### Edge Cases

| Input | Expected Behavior |
|-------|-------------------|
| `else <- 1` | No definition created, no undefined variable warning, parse error from tree-sitter |
| `if <- function() {}` | No definition created, no undefined variable warning, parse error from tree-sitter |
| `TRUE <- FALSE` | No definition created, no undefined variable warning |
| `myelse <- 1` | Normal definition created (not a reserved word) |
| `ELSE <- 1` | Normal definition created (case-sensitive, `ELSE` is not reserved) |

## Testing Strategy

### Unit Tests

1. **Reserved word module tests**: same coverage; implicitly zero allocation via `matches!`.
2. **Definition extraction tests**: cover all extractor entry points (plain assignment, function definition, replacement function, right assignment). Non-reserved identifiers remain positive controls.
3. **Undefined variable tests**: unchanged.
4. **Completion tests**: verify filtering after final aggregation by injecting identifiers from document, workspace index, and package sources; keyword completions remain available separately.
5. **Document symbol tests**: cover AST-based and scope-derived symbol sources.

### Property-Based Tests

Property-based tests verify universal properties across many generated inputs. Each test runs minimum 100 iterations.

**Test Configuration**:
- Framework: `proptest` (Rust property-based testing library)
- Iterations: 100+ per property
- Each test tagged with: **Feature: reserved-keyword-handling, Property N: [property text]**

**Property Test Implementations**:

1. **Property 1 Test**: Generate random strings from the reserved word set and verify `is_reserved_word()` returns `true`. Generate random valid R identifiers not in the set and verify it returns `false`.

2. **Property 2 Test**: Generate R code with assignments to randomly selected reserved words. Parse and extract definitions. Verify the reserved word does not appear in exported interface or timeline.

3. **Property 3 Test**: Generate R code with reserved words used as identifiers. Run undefined variable checking. Verify no "Undefined variable" diagnostic is emitted for reserved words.

4. **Property 4 Test**: Generate R code with assignments to reserved words. Generate completions. Verify reserved words don't appear in identifier completion items.

5. **Property 5 Test**: Generate R code with assignments to reserved words. Collect document symbols. Verify reserved words don't appear in symbol list.
