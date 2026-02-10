# Design Document: Syntax Error Diagnostic Placement

## Overview

This design addresses the incorrect placement of syntax error diagnostics when tree-sitter wraps incomplete expressions inside multi-line ERROR nodes. The previous implementation collapsed multi-line ERROR ranges to the first line, which often points to structurally valid parent constructs (like `if` statements) rather than the actual syntax error.

The solution introduces a "content-line detection" strategy that scans the ERROR node's children to find the first line containing actual content (identifiers, operators) after structural tokens, ensuring diagnostics appear on the line with the problematic code.

### Problem Example

```r
if (1==1) {
  x <-
}
```

**Previous behavior:**
- Tree-sitter creates an ERROR node spanning lines 0-2 (the entire `if` block)
- `minimize_error_range` collapses to line 0 → diagnostic on `if (1==1) {`
- Result: Red squiggle on valid code

**New behavior:**
- Scan ERROR node children, skip structural tokens, find content on line 1
- Place diagnostic on line 1 only
- Result: Red squiggle on the incomplete assignment

### Actual Tree-Sitter Output

A key discovery during implementation: tree-sitter does NOT always produce nested ERROR nodes or MISSING nodes for incomplete expressions inside blocks. For `if (TRUE) { x <- }`, the actual tree is:

```
program [0:0 - 2:1]
└── ERROR [0:0 - 2:1]
    ├── if [0:0 - 0:2]           (unnamed, structural keyword)
    ├── ( [0:3 - 0:4]            (unnamed, punctuation)
    ├── true [0:4 - 0:8]         (named, condition literal)
    ├── ) [0:8 - 0:9]            (unnamed, punctuation)
    ├── { [0:10 - 0:11]          (unnamed, opening brace)
    ├── identifier [1:2 - 1:3]   (named, content — "x")
    ├── <- [1:4 - 1:6]           (unnamed, operator)
    └── ERROR [2:0 - 2:1]        (leaf ERROR — "}")
```

Key observations:
- The incomplete assignment tokens (`x`, `<-`) are **flat children** of the outer ERROR, not wrapped in a nested ERROR
- There is **no MISSING node** for the right-hand side of the assignment
- The `}` gets its own **leaf ERROR node** (zero children) because tree-sitter cannot fit it into the grammar
- The only nested ERROR is the leaf `}`, which is NOT the actual error location

This means a naive "find innermost ERROR" strategy would point to the `}` on line 2, not the incomplete expression on line 1. The content-line strategy solves this by scanning for actual content tokens.

### Diagnostic Messages

The system produces two types of diagnostic messages:

1. **"Syntax error"** — Emitted for ERROR nodes
   - Example: `if (TRUE) { x <- }` → "Syntax error" placed on the content line

2. **"Missing [node_kind]"** — Emitted for MISSING nodes
   - Example: `x <-` → "Missing identifier" (at the location after `<-`)
   - Example: `f(` → "Missing )" (at the location after `(`)

When both ERROR and MISSING nodes exist in the same structure, the MISSING node takes priority for placement.

## Architecture

The fix modifies the `minimize_error_range` function in `crates/raven/src/handlers.rs` to implement a three-phase strategy:

1. **Phase 1: MISSING node detection** (unchanged)
   - If a MISSING node exists anywhere in the tree, use its location
   - This handles cases like `x <-` where the right-hand side is missing

2. **Phase 2: Innermost ERROR + content-line detection** (new)
   - Find the innermost non-leaf ERROR node (skip leaf ERROR nodes with zero children)
   - If the innermost ERROR is single-line, use its full range
   - If the innermost ERROR is multi-line, use `find_first_content_line` to locate the first line with actual content after structural tokens

3. **Phase 3: First-line fallback** (existing, now last resort)
   - Only reached if no MISSING node and no non-leaf ERROR node found
   - Collapses to first line of the outermost ERROR node

## Components and Interfaces

### New Functions

#### `find_innermost_error(node: Node) -> Option<Node>`

**Purpose:** Find the deepest ERROR node that has children (skip leaf ERROR nodes).

**Algorithm:**
```text
function find_innermost_error(node):
    if node.is_error():
        for child in node.children():
            if child.is_error():
                if innermost = find_innermost_error(child):
                    return innermost
        # No ERROR children with children found
        if node.child_count() > 0:
            return node       # this ERROR has children, it's a candidate
        return None            # leaf ERROR, skip it

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
- `Some(Node)` — The deepest non-leaf ERROR node
- `None` — No non-leaf ERROR nodes found

#### `find_first_content_line(node: Node) -> Option<usize>`

**Purpose:** For a multi-line ERROR node, find the first line containing actual content (not structural tokens).

**Algorithm:**
```text
function find_first_content_line(node):
    if node is single-line:
        return node.start_row

    brace_line = find opening '{' child line, or None

    for child in node.children():
        skip if child.is_error()
        skip if child is unnamed (punctuation)
        skip if child.kind() in [if, while, for, function, repeat]
        skip if child.kind() in [true, false, null]
        skip if brace_line exists and child.row <= brace_line

        return child.start_row    # first content token after brace

    # fallback: line after brace, or start line
    return brace_line + 1, or node.start_row
```

**Signature:**
```rust
fn find_first_content_line(node: Node) -> Option<usize>
```

**Returns:**
- `Some(row)` — The 0-indexed row of the first content line
- `None` — Should not happen in practice (always returns Some)

### Modified Functions

#### `minimize_error_range(node: Node, text: &str) -> Range`

**Purpose:** Convert an ERROR node into a focused diagnostic range.

**Modified Algorithm:**
```text
function minimize_error_range(node, text):
    # Phase 1: MISSING node takes priority (unchanged)
    if missing = find_first_missing_descendant(node):
        return range_at(missing.position, width=1)

    # Phase 2: Find innermost non-leaf ERROR, then content line (NEW)
    if innermost = find_innermost_error(node):
        if innermost is single-line:
            return innermost.full_range
        if content_row = find_first_content_line(innermost):
            return full_line_range(content_row, text)

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
- May be a leaf node (zero children) for misplaced tokens like `}`

**MISSING Node:**
- `node.is_missing() == true`
- Represents an expected but absent token
- Always zero-width (start == end)
- Takes priority over ERROR nodes for diagnostic placement
- NOT always present — tree-sitter may omit MISSING nodes for some incomplete expressions

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

### Example Tree Structures

#### Case 1: Incomplete assignment in block (no MISSING node)

Input: `if (TRUE) { x <- }`

```text
program [0:0 - 2:1]
└── ERROR [0:0 - 2:1]
    ├── if [0:0 - 0:2]
    ├── ( [0:3 - 0:4]
    ├── true [0:4 - 0:8]
    ├── ) [0:8 - 0:9]
    ├── { [0:10 - 0:11]
    ├── identifier: x [1:2 - 1:3]    ← content line (line 1)
    ├── <- [1:4 - 1:6]
    └── ERROR [2:0 - 2:1]            ← leaf ERROR (skipped)
```

- Phase 1: No MISSING node → skip
- Phase 2: `find_innermost_error` returns outer ERROR (leaf `}` skipped)
- Phase 2: `find_first_content_line` finds `identifier` on line 1 (after `{` on line 0)
- Result: Diagnostic on line 1

#### Case 2: Top-level incomplete assignment (has MISSING node)

Input: `x <-`

```text
program [0:0 - 0:4]
└── binary_operator [0:0 - 0:4]
    ├── identifier: x [0:0 - 0:1]
    ├── <- [0:2 - 0:4]
    └── (MISSING identifier) [0:4 - 0:4]
```

- Phase 1: MISSING node found at [0:4] → diagnostic at (0, 4) with width 1
- Result: "Missing identifier" diagnostic at end of line

#### Case 3: Single-line error

Input: `x <- )`

```text
program [0:0 - 0:6]
├── binary_operator [0:0 - 0:4]
│   ├── identifier: x [0:0 - 0:1]
│   ├── <- [0:2 - 0:4]
│   └── (MISSING identifier) [0:4 - 0:4]
└── ERROR [0:5 - 0:6]    ← single-line ERROR
```

- The `)` ERROR is single-line → full range preserved
- Result: Diagnostic on the `)` character

## Correctness Properties

### Property 1: Structural Parent Exclusion

*For any* multi-line ERROR node produced by R code containing an incomplete expression within a structurally valid parent construct (such as `if`, `while`, `for`), the diagnostic range SHALL NOT start on the line of the parent construct.

**Validates: Requirements 1.1, 1.5**

### Property 2: Content Line Placement

*For any* multi-line ERROR node where `find_first_content_line` returns a row, the diagnostic range SHALL start on that row, not on the structural parent's line or the leaf ERROR's line.

**Validates: Requirements 1.1, 1.2, 3.2**

### Property 3: MISSING Node Priority

*For any* ERROR node containing a MISSING node descendant, the diagnostic range SHALL be placed at the MISSING node's location, regardless of other ERROR nodes present.

**Validates: Requirements 1.3**

### Property 4: Single-Line Range Preservation

*For any* single-line ERROR node (where start row equals end row), the diagnostic range SHALL preserve the full range of the ERROR node without modification.

**Validates: Requirements 1.4**

### Property 5: Diagnostic Deduplication

*For any* multi-line ERROR node containing nested ERROR node children, the system SHALL emit exactly one diagnostic for the entire error structure.

**Validates: Requirements 2.1**

### Property 6: Leaf ERROR Exclusion

*For any* multi-line ERROR node containing only leaf ERROR children (zero-child ERROR nodes), `find_innermost_error` SHALL return the parent ERROR node, not the leaf.

**Validates: Requirements 3.1**

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
- `text.lines().nth(row)` returns `None` → use `unwrap_or(0)` or `unwrap_or(start_col as u32)`
- Ensures diagnostic has at least 1-column width
- Prevents panic from missing line data

### Deeply Nested ERROR Trees

**Scenario:** Pathological code creates very deep ERROR node nesting.

**Handling:**
- Recursive `find_innermost_error` may hit stack limits
- Rust's default stack size (2MB on Linux) handles ~10,000 levels
- Real-world R code rarely exceeds 100 levels of nesting
- No explicit depth limit needed

### Zero-Width Ranges

**Scenario:** MISSING nodes have zero width (start == end).

**Handling:**
- Always add 1 to end column: `end: Position::new(m_row, m_col.saturating_add(1))`
- Ensures red squiggle is visible in editor

### No Content Line Found

**Scenario:** A multi-line ERROR node has no identifiable content line (all children are structural or ERROR).

**Handling:**
- `find_first_content_line` falls back to `brace_line + 1` if a brace was found
- Otherwise falls back to `node.start_position().row`
- Ensures a diagnostic is always emitted

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

**Test:** Generate R code with incomplete expressions inside blocks. Parse and collect diagnostics. Verify that for multi-line ERROR nodes, the diagnostic does not start on the structural parent's line.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 1: Structural parent exclusion

#### Property 2: Content Line Placement

**Test:** Generate R code with incomplete expressions inside blocks. Parse, find the outermost multi-line ERROR, call `find_first_content_line`. Verify the diagnostic starts on the content line.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 2: Content line placement

#### Property 3: MISSING Node Priority

**Test:** Generate R code with MISSING nodes (incomplete expressions). Parse and identify both ERROR and MISSING nodes. Verify that when a MISSING node exists, the diagnostic is placed at the MISSING node's location.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 3: MISSING node priority

#### Property 4: Single-Line Range Preservation

**Test:** Generate single-line R code with syntax errors. Parse and identify single-line ERROR nodes. Verify the diagnostic range exactly matches the ERROR node's range.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 4: Single-line range preservation

#### Property 5: Diagnostic Deduplication

**Test:** Generate R code with nested ERROR nodes. Count top-level ERROR nodes. Verify diagnostic count does not exceed top-level ERROR count.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 5: Diagnostic deduplication

#### Property 6: Leaf ERROR Exclusion

**Test:** Generate R code that produces leaf ERROR nodes. Verify `find_innermost_error` returns the parent ERROR, not the leaf.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 6: Leaf ERROR exclusion

#### Property 7: MISSING Node Width

**Test:** Generate R code with MISSING nodes. Verify each MISSING-based diagnostic has width of exactly 1 column.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 7: MISSING node width

#### Property 8: Error Detection Completeness

**Test:** Generate syntactically invalid R code. Verify at least one diagnostic is emitted.

**Tag:** Feature: syntax-error-diagnostic-placement, Property 8: Error detection completeness

### Testing Framework

- **Unit tests:** Rust's built-in `#[test]` framework
- **Property-based tests:** `proptest` crate
- **Tree-sitter:** `tree_sitter_r::LANGUAGE` for parsing
- **Minimum iterations:** 100 per property test

### Test Data Generation

For property-based tests, generate R code with:
- Incomplete assignments: `x <-`, `y =`
- Incomplete binary operations: `x +`, `a *`, `b <`
- Incomplete function calls: `f(`, `g(x,`
- Nested blocks: `if (TRUE) { ... }`, `while (x) { ... }`, `for (i in 1:10) { ... }`
- Various nesting depths: 1-5 levels
- Multiple errors per file: 1-3 errors
