# Design Document: Syntax Error Diagnostic Placement

## Overview

This design addresses the incorrect placement of syntax error diagnostics when tree-sitter wraps incomplete expressions inside multi-line ERROR nodes. The current implementation collapses multi-line ERROR ranges to the first line, which often points to structurally valid parent constructs (like `if` statements) rather than the actual syntax error.

The solution introduces an "innermost error detection" strategy that traverses the ERROR node tree to find the deepest ERROR or MISSING node, ensuring diagnostics appear on the line containing the actual problematic code.

### Problem Example

```r
if (1==1) {
  x <-
}
```

**Current behavior:**
- Tree-sitter creates an ERROR node spanning lines 0-2 (the entire `if` block)
- `minimize_error_range` collapses to line 0 → diagnostic on `if (1==1) {`
- Result: Red squiggle on valid code

**Desired behavior:**
- Detect that the innermost error is on line 1 (`x <-`)
- Place diagnostic on line 1 only
- Result: Red squiggle on the incomplete assignment

### Diagnostic Messages

The system produces two types of diagnostic messages:

1. **"Syntax error"** - Emitted for ERROR nodes
   - Example: `if (TRUE) { x <- }` → "Syntax error" (but placed at the MISSING node location)
   
2. **"Missing [node_kind]"** - Emitted for MISSING nodes
   - Example: `x <-` → "Missing identifier" (at the location after `<-`)
   - Example: `f(` → "Missing )" (at the location after `(`)

When both ERROR and MISSING nodes exist in the same structure, the MISSING node takes priority for placement, but only one diagnostic is emitted (the ERROR node's "Syntax error" message, placed at the MISSING location).

## Architecture

The fix modifies the `minimize_error_range` function in `crates/raven/src/handlers.rs` to implement a two-phase strategy:

1. **Phase 1: MISSING node detection** (unchanged)
   - If a MISSING node exists anywhere in the tree, use its location
   - This handles cases like `x <-` where the right-hand side is missing

2. **Phase 2: Innermost ERROR detection** (new)
   - If no MISSING node exists, find the innermost (deepest) ERROR node
   - Use the innermost ERROR node's range for the diagnostic
   - If the innermost ERROR is still multi-line, use its first line (fallback)

3. **Phase 3: First-line fallback** (existing, now last resort)
   - Only used when no MISSING and no single-line innermost ERROR found
   - Collapses to first line of the outermost ERROR node

## Components and Interfaces

### Modified Functions

#### `find_innermost_error(node: Node) -> Option<Node>`

**Purpose:** Recursively find the deepest ERROR node within a tree.

**Algorithm:**
```
function find_innermost_error(node):
    if node.is_error():
        # Check if any children are also ERROR nodes
        for child in node.children():
            if child.is_error():
                # Recurse to find deeper errors
                if innermost = find_innermost_error(child):
                    return innermost
        # No ERROR children, this is the innermost
        return node
    
    # Not an ERROR node, check children
    for child in node.children():
        if innermost = find_innermost_error(child):
            return innermost
    
    return None
```

**Signature:**
```rust
fn find_innermost_error(node: Node) -> Option<Node>
```

**Returns:**
- `Some(Node)` - The deepest ERROR node in the tree
- `None` - No ERROR nodes found

#### `minimize_error_range(node: Node, text: &str) -> Range`

**Purpose:** Convert an ERROR node into a focused diagnostic range.

**Modified Algorithm:**
```
function minimize_error_range(node, text):
    # Phase 1: MISSING node takes priority (unchanged)
    if missing = find_first_missing_descendant(node):
        return range_at(missing.position, width=1)
    
    # Phase 2: Find innermost ERROR (NEW)
    if innermost = find_innermost_error(node):
        if innermost is single-line:
            return innermost.full_range
        # Innermost is still multi-line, use its first line
        return first_line_of(innermost, text)
    
    # Phase 3: Fallback to first line of outermost ERROR
    if node is single-line:
        return node.full_range
    return first_line_of(node, text)
```

**Signature:** (unchanged)
```rust
fn minimize_error_range(node: Node, text: &str) -> Range
```

#### `collect_syntax_errors(node: Node, text: &str, diagnostics: &mut Vec<Diagnostic>)`

**Purpose:** Traverse the AST and collect syntax error diagnostics.

**Behavior:** (unchanged)
- When an ERROR node is encountered, call `minimize_error_range` and emit one diagnostic
- Do NOT recurse into ERROR children (prevents duplicates)
- Continue recursing into non-ERROR children

## Data Models

### Tree-Sitter Node Types

**ERROR Node:**
- `node.is_error() == true`
- Represents a syntax error in the parsed code
- Can span multiple lines
- Can contain nested ERROR nodes

**MISSING Node:**
- `node.is_missing() == true`
- Represents an expected but absent token
- Always zero-width (start == end)
- Takes priority over ERROR nodes for diagnostic placement

**Node Position:**
```rust
struct Position {
    row: usize,    // 0-indexed line number
    column: usize, // 0-indexed byte offset
}
```

**LSP Range:**
```rust
struct Range {
    start: Position,  // Inclusive
    end: Position,    // Exclusive
}
```

### Example Tree Structure

For `if (TRUE) { x <- }`:

```
program
└── if_statement (ERROR) [0:0 - 2:1]
    ├── if [0:0 - 0:2]
    ├── ( [0:3 - 0:4]
    ├── TRUE [0:4 - 0:8]
    ├── ) [0:8 - 0:9]
    ├── { [0:10 - 0:11]
    ├── binary_operator (ERROR) [1:2 - 1:5]
    │   ├── identifier: x [1:2 - 1:3]
    │   ├── <- [1:4 - 1:6]
    │   └── (MISSING identifier) [1:6 - 1:6]
    └── } [2:0 - 2:1]
```

**Current behavior:**
- Outer ERROR at [0:0 - 2:1] → collapses to line 0

**New behavior:**
- Find innermost ERROR: `binary_operator` at [1:2 - 1:5]
- Find MISSING node at [1:6 - 1:6]
- Use MISSING location → diagnostic at line 1, column 6


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Structural Parent Exclusion

*For any* R code containing an incomplete expression within a structurally valid parent construct (such as `if`, `while`, `for`, `{}`), the diagnostic range SHALL NOT start on the line of the parent construct unless the syntax error originates on that line.

**Validates: Requirements 1.1, 1.5**

### Property 2: Innermost ERROR Selection

*For any* multi-line ERROR node containing nested ERROR node children, the diagnostic range SHALL be placed at the location of the deepest (innermost) ERROR node in the tree.

**Validates: Requirements 1.2**

### Property 3: MISSING Node Priority

*For any* ERROR node containing a MISSING node descendant, the diagnostic range SHALL be placed at the MISSING node's location, regardless of other ERROR nodes present.

**Validates: Requirements 1.3**

### Property 4: Single-Line Range Preservation

*For any* single-line ERROR node (where start row equals end row), the diagnostic range SHALL preserve the full range of the ERROR node without modification.

**Validates: Requirements 1.4**

### Property 5: Diagnostic Deduplication

*For any* multi-line ERROR node containing nested ERROR node children, the system SHALL emit exactly one diagnostic for the entire error structure.

**Validates: Requirements 2.1**

### Property 6: Source-Order Tie-Breaking

*For any* ERROR node containing multiple ERROR node children at the same depth level, the diagnostic SHALL be placed at the first ERROR node encountered in source order (left-to-right, top-to-bottom).

**Validates: Requirements 3.2**

### Property 7: MISSING Node Width

*For any* MISSING node, the diagnostic range SHALL have a width of exactly 1 column to ensure visibility in the editor.

**Validates: Requirements 4.2**

### Property 8: Error Detection Completeness

*For any* R code containing syntax errors, the system SHALL emit at least one diagnostic.

**Validates: Requirements 4.4**

## Error Handling

### Invalid Node Positions

**Scenario:** Tree-sitter returns a node with invalid position data (e.g., end before start).

**Handling:**
- Use `saturating_add` for column calculations to prevent overflow
- Clamp ranges to ensure start <= end
- Emit diagnostic with minimal 1-column width if position is invalid

### Empty or Missing Source Text

**Scenario:** The `text` parameter is empty or the requested line doesn't exist.

**Handling:**
- `text.lines().nth(row)` returns `None` → use `unwrap_or(start_col as u32)`
- Ensures diagnostic has at least 1-column width
- Prevents panic from missing line data

### Deeply Nested ERROR Trees

**Scenario:** Pathological code creates very deep ERROR node nesting.

**Handling:**
- Recursive `find_innermost_error` may hit stack limits
- Rust's default stack size (2MB on Linux) handles ~10,000 levels
- Real-world R code rarely exceeds 100 levels of nesting
- No explicit depth limit needed (would complicate code for negligible benefit)

### Zero-Width Ranges

**Scenario:** MISSING nodes have zero width (start == end).

**Handling:**
- Always add 1 to end column: `end: Position::new(m_row, m_col.saturating_add(1))`
- Ensures red squiggle is visible in editor
- LSP spec allows zero-width ranges, but editors may not render them

## Testing Strategy

### Unit Tests

Unit tests verify specific examples and edge cases:

1. **Incomplete assignment in block** (`if (TRUE) { x <- }`)
   - Verify diagnostic is on line 1 (the `x <-` line), not line 0 (the `if` line)
   - Verify exactly one diagnostic is emitted

2. **Incomplete binary operation** (`if (TRUE) { x + }`)
   - Verify diagnostic is on the line with `x +`
   - Verify single-line diagnostic range

3. **Incomplete comparison** (`if (TRUE) { x < }`)
   - Verify diagnostic is on the line with `x <`
   - Verify single-line diagnostic range

4. **Unclosed function call** (`if (TRUE) { f( }`)
   - Verify diagnostic is on the line with `f(`
   - Verify MISSING node detection for the closing `)`

5. **Single-line error** (`x <- )`)
   - Verify full range is preserved
   - Verify no minimization occurs

6. **Top-level incomplete assignment** (`x <-`)
   - Verify MISSING identifier diagnostic is emitted
   - Verify backward compatibility with existing behavior

7. **No duplicate diagnostics** (`if (TRUE) { x <- }`)
   - Verify exactly one diagnostic (not one per nested ERROR)
   - Verify recursion stops after first ERROR

8. **Genuinely broken code** (`x <- function( { }`)
   - Verify at least one diagnostic is emitted
   - Verify system doesn't crash or hang

### Property-Based Tests

Property-based tests verify universal properties across randomized inputs. Each test should run a minimum of 100 iterations.

#### Property 1: Structural Parent Exclusion

**Test:** Generate R code with incomplete expressions inside blocks. Parse and collect diagnostics. Verify that for each diagnostic, if the code has a structurally valid parent construct (detected by checking if the ERROR node starts with keywords like `if`, `while`, `for`, `function`), the diagnostic does not start on the parent's line.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 1: Structural parent exclusion

#### Property 2: Innermost ERROR Selection

**Test:** Generate R code that produces nested ERROR nodes. Parse and identify the outermost ERROR node. Manually traverse to find the innermost ERROR node. Collect diagnostics and verify the diagnostic range corresponds to the innermost ERROR node's location.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 2: Innermost ERROR selection

#### Property 3: MISSING Node Priority

**Test:** Generate R code with MISSING nodes (incomplete expressions). Parse and identify both ERROR and MISSING nodes. Collect diagnostics and verify that when a MISSING node exists, the diagnostic is placed at the MISSING node's location, not at any ERROR node's location.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 3: MISSING node priority

#### Property 4: Single-Line Range Preservation

**Test:** Generate single-line R code with syntax errors. Parse and identify single-line ERROR nodes (start row == end row). Collect diagnostics and verify the diagnostic range exactly matches the ERROR node's range.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 4: Single-line range preservation

#### Property 5: Diagnostic Deduplication

**Test:** Generate R code with nested ERROR nodes. Parse and count the number of ERROR nodes in the tree. Collect diagnostics and verify that the number of diagnostics is less than or equal to the number of top-level ERROR nodes (no diagnostic per nested ERROR).

**Tag:** Feature: syntax-error-diagnostic-placement, Property 5: Diagnostic deduplication

#### Property 6: Source-Order Tie-Breaking

**Test:** Generate R code with multiple syntax errors at the same nesting depth. Parse and identify ERROR nodes at the same depth. Collect diagnostics and verify that the diagnostic corresponds to the first ERROR node in source order (lowest line number, then lowest column).

**Tag:** Feature: syntax-error-diagnostic-placement, Property 6: Source-order tie-breaking

#### Property 7: MISSING Node Width

**Test:** Generate R code with MISSING nodes. Parse and collect diagnostics for MISSING nodes. Verify that each diagnostic range has a width of exactly 1 column (end.column - start.column == 1).

**Tag:** Feature: syntax-error-diagnostic-placement, Property 7: MISSING node width

#### Property 8: Error Detection Completeness

**Test:** Generate syntactically invalid R code (various types of errors). Parse and collect diagnostics. Verify that at least one diagnostic is emitted for each piece of broken code.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 8: Error detection completeness

### Testing Framework

- **Unit tests:** Use Rust's built-in `#[test]` framework
- **Property-based tests:** Use `proptest` or `quickcheck` crate
- **Tree-sitter:** Use `tree_sitter_r::LANGUAGE` for parsing
- **Minimum iterations:** 100 per property test (configurable via `proptest` config)

### Test Data Generation

For property-based tests, generate R code with:
- Incomplete assignments: `x <-`, `y =`
- Incomplete binary operations: `x +`, `a *`, `b <`
- Incomplete function calls: `f(`, `g(x,`
- Nested blocks: `if (TRUE) { ... }`, `while (x) { ... }`
- Various nesting depths: 1-5 levels
- Multiple errors per file: 1-3 errors

Use `proptest` strategies to generate:
- Valid R identifiers
- Valid R operators
- Valid R keywords
- Random nesting structures
