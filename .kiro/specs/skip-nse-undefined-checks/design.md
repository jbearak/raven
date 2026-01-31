# Design Document: Skip NSE Undefined Variable Checks

## Overview

This design modifies Rlsp's undefined variable detection to skip checks in contexts where R uses non-standard evaluation (NSE) or data frame column access. The implementation follows Ark's approach using context flags that are set during AST traversal.

The key insight from Ark's implementation is that instead of checking each identifier's context at the point of use, we track context state during tree traversal and skip undefined variable checks when inside certain node types.

## Architecture

### Current Architecture

The current `collect_usages()` function in `handlers.rs` performs a simple recursive traversal of the AST, collecting all identifier usages. It only skips:
1. LHS of assignment operators (`<-`, `=`, `<<-`)
2. Named argument names (the `name` field of `argument` nodes)

### Proposed Architecture

We will modify the traversal to track context state using flags, similar to Ark's `DiagnosticContext`:

```
┌─────────────────────────────────────────────────────────────────┐
│                    collect_usages_with_context()                │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   UsageContext                           │   │
│  │  - in_formula: bool                                      │   │
│  │  - in_call_like_arguments: bool                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Recursive AST Traversal                     │   │
│  │                                                          │   │
│  │  1. Check node type                                      │   │
│  │  2. Update context flags if entering special node        │   │
│  │  3. For identifiers: check context + parent node type    │   │
│  │  4. Recurse into children with updated context           │   │
│  │  5. Restore context flags after leaving special node     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### UsageContext Struct

```rust
/// Context for tracking NSE-related state during AST traversal
struct UsageContext {
    /// True when inside a formula expression (~ operator)
    in_formula: bool,
    /// True when inside the arguments of a call-like node (call, subset, subset2)
    in_call_like_arguments: bool,
}

impl Default for UsageContext {
    fn default() -> Self {
        Self {
            in_formula: false,
            in_call_like_arguments: false,
        }
    }
}
```

### Modified collect_usages Function

The existing `collect_usages()` function will be replaced with `collect_usages_with_context()`:

```rust
fn collect_usages_with_context<'a>(
    node: Node<'a>,
    text: &str,
    context: &UsageContext,
    used: &mut Vec<(String, Node<'a>)>,
)
```

### Skip Logic for Identifiers

When an identifier is encountered, the following checks determine if it should be skipped:

1. **Context flags**: Skip if `context.in_formula` or `context.in_call_like_arguments` is true
2. **Extract operator RHS**: Skip if parent is `extract_operator` and this is the `rhs` field
3. **Assignment LHS**: Skip if parent is `binary_operator` with assignment operator and this is LHS
4. **Named argument name**: Skip if parent is `argument` and this is the `name` field

### Node Type Detection

Tree-sitter-r node types used:

| R Syntax | Node Type | Field Names |
|----------|-----------|-------------|
| `df$col` | `extract_operator` | `lhs`, `rhs` |
| `obj@slot` | `extract_operator` | `lhs`, `rhs` |
| `func(...)` | `call` | `function`, `arguments` |
| `x[...]` | `subset` | `function`, `arguments` |
| `x[[...]]` | `subset2` | `function`, `arguments` |
| `~ x` | `unary_operator` | `rhs` (operator is `~`) |
| `y ~ x` | `binary_operator` | `lhs`, `rhs` (operator is `~`) |

## Data Models

### Tree-Sitter Node Relationships

```
extract_operator
├── lhs: identifier (check for undefined)
├── $ or @
└── rhs: identifier (SKIP - column/slot name)

call
├── function: identifier (check for undefined)
└── arguments
    └── argument* (SKIP all identifiers inside)

subset / subset2
├── function: identifier (check for undefined)
└── arguments
    └── argument* (SKIP all identifiers inside)

unary_operator (when operator is ~)
└── rhs: expression (SKIP all identifiers inside)

binary_operator (when operator is ~)
├── lhs: expression (SKIP all identifiers inside)
└── rhs: expression (SKIP all identifiers inside)
```



## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Extract Operator RHS Skipped

*For any* R code containing an extract operator (`$` or `@`), the identifier on the right-hand side of the operator SHALL NOT produce an undefined variable diagnostic, regardless of whether that identifier is defined in scope.

**Validates: Requirements 1.1, 1.2**

### Property 2: Extract Operator LHS Checked

*For any* R code containing an extract operator (`$` or `@`) where the left-hand side is an undefined identifier, the system SHALL produce an undefined variable diagnostic for that identifier.

**Validates: Requirements 1.3**

### Property 3: Call-Like Arguments Skipped

*For any* R code containing a call-like node (`call`, `subset`, or `subset2`), identifiers appearing inside the `arguments` field SHALL NOT produce undefined variable diagnostics, regardless of whether those identifiers are defined in scope.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 4: Function Names Checked

*For any* R code containing a function call where the function name is an undefined identifier, the system SHALL produce an undefined variable diagnostic for that function name.

**Validates: Requirements 2.4**

### Property 5: Formula Expressions Skipped

*For any* R code containing a formula expression (unary `~ x` or binary `y ~ x`), identifiers appearing inside the formula SHALL NOT produce undefined variable diagnostics, regardless of whether those identifiers are defined in scope.

**Validates: Requirements 3.1, 3.2**

### Property 6: Nested Skip Contexts

*For any* R code where a formula appears inside call arguments (e.g., `lm(y ~ x)`), identifiers in the formula SHALL NOT produce undefined variable diagnostics, demonstrating that both skip contexts apply correctly.

**Validates: Requirements 3.4**

### Property 7: Existing Skip Rules Preserved

*For any* R code containing assignments or named arguments, the existing skip rules SHALL continue to work:
- Assignment LHS identifiers (`x <- 1`, `x = 1`, `x <<- 1`) SHALL NOT produce diagnostics
- Named argument names (`func(n = 1)`) SHALL NOT produce diagnostics

**Validates: Requirements 5.1, 5.2**

### Property 8: Non-Skipped Contexts Checked

*For any* R code containing an undefined identifier that is NOT in a skip context (not in formula, not in call-like arguments, not RHS of extract operator, not assignment LHS, not named argument name), the system SHALL produce an undefined variable diagnostic.

**Validates: Requirements 1.3, 2.4, 2.5, 3.3**

## Error Handling

### Invalid AST Nodes

If the tree-sitter parser produces an error node or missing node, the undefined variable checking should skip that subtree entirely. This is existing behavior that should be preserved.

### Edge Cases

1. **Deeply nested formulas**: `~ (~ (~ x))` - all identifiers should be skipped
2. **Nested call arguments**: `f(g(h(x)))` - all identifiers in all argument levels should be skipped
3. **Mixed contexts**: `df$col[x > 5]` - `col` skipped (extract RHS), `x` skipped (subset arguments), `df` checked
4. **Chained extracts**: `df$a$b$c` - only `df` should be checked, all others are RHS of extract operators

## Testing Strategy

### Dual Testing Approach

Both unit tests and property-based tests are required for comprehensive coverage:

- **Unit tests**: Verify specific examples and edge cases
- **Property tests**: Verify universal properties across generated inputs

### Property-Based Testing Configuration

- **Library**: `proptest` (already used in the codebase)
- **Minimum iterations**: 100 per property test
- **Tag format**: `Feature: skip-nse-undefined-checks, Property N: {property_text}`

### Test Categories

#### Unit Tests

1. **Extract operator tests**:
   - `df$column` - no diagnostic for `column`
   - `obj@slot` - no diagnostic for `slot`
   - `undefined$column` - diagnostic for `undefined`

2. **Call-like argument tests**:
   - `subset(df, x > 5)` - no diagnostic for `x`
   - `df[x > 5, ]` - no diagnostic for `x`
   - `df[[x]]` - no diagnostic for `x`
   - `undefined_func(x)` - diagnostic for `undefined_func`

3. **Formula tests**:
   - `~ x` - no diagnostic for `x`
   - `y ~ x + z` - no diagnostic for `y`, `x`, `z`
   - `lm(y ~ x, data = df)` - no diagnostic for `y`, `x`

4. **Edge case tests**:
   - Deeply nested structures
   - Mixed contexts
   - Chained operations

#### Property Tests

Each correctness property (1-8) should have a corresponding property-based test that:
1. Generates random R code matching the property's pattern
2. Parses the code and collects diagnostics
3. Verifies the property holds

### Test File Location

Tests should be added to `crates/rlsp/src/handlers.rs` in the existing `#[cfg(test)]` module, or in a new test file `crates/rlsp/src/handlers_tests.rs` if the test module becomes too large.
