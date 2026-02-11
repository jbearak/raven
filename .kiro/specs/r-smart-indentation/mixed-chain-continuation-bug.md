# R Smart Indentation: Mixed Chain Continuation Bug

## Problem

When pressing Enter after a continuation operator in a mixed chain (pipe followed by arithmetic operators), the indentation is incorrect.

### Example

```r
x <- f(a,
       b,
       c(a,
         b = f(a,
               b))) |>
     x + y +
     [CURSOR HERE]
```

**Expected:** Cursor at column 5 (aligned with `x` after `|>`)  
**Actual:** Cursor at column 19

## Root Cause

The AST-based chain start detection (`find_chain_start_from_ast`) encounters a mixed chain where:
1. A pipe operator (`|>`) is followed by arithmetic operators (`+`)
2. The tree-sitter AST represents this as nested binary operators
3. When looking for the `+` at the end of line 5, the parent binary operator spans the ENTIRE expression from `f(...)` through `x + y +`
4. The function was falling back to text-based heuristics (`ChainWalker`) for mixed chains
5. `ChainWalker` was starting from the wrong position and returning line 4 (where `|>` is) instead of line 5 (where the `+` chain starts)

## Technical Details

### AST Structure

```text
(program 
  (binary_operator                    ; x <- ...
    lhs: (identifier)                 ; x
    rhs: (binary_operator             ; f(...) |> x + y +
      lhs: (binary_operator           ; f(...) |> x
        lhs: (binary_operator         ; f(...) |> (missing)
          lhs: (call ...)             ; f(...)
          rhs: (identifier))          ; x (after |>)
        rhs: (identifier))            ; y
      rhs: (MISSING identifier))))    ; missing after final +
```

The final `+` operator's parent is a binary_operator that spans from `f(...)` to the end, because tree-sitter extends parent nodes when there's a MISSING child.

### Current Behavior

1. `detect_continuation_operator` is called with `prev_line = 5`
2. `find_chain_start_from_ast` looks for the operator at the end of line 5
3. Finds the `+` operator and gets its parent binary_operator (the entire expression)
4. Detects this is a mixed chain and returns `None`
5. Falls back to `ChainWalker.find_chain_start(position)` where `position.line = 6`
6. `ChainWalker` walks backward from line 6:
   - Line 5 ends with `+` → continue
   - Line 4 ends with `|>` → continue (doesn't distinguish operator classes)
   - Line 3 ends with `,` → stop
7. Returns `(4, 15)` - line 4, column 15 (first non-whitespace on line 4)
8. Calculator adds `tab_size` to ensure minimum indent: `max(15, 15 + 4) = 19`

## Solution

### Option 1: Fix AST-based detection for mixed chains

Instead of falling back to text-based heuristics, handle mixed chains in `find_chain_start_from_ast`:

1. Remove the `is_mixed_chain` check and fallback
2. When `outermost` spans multiple lines, find the leftmost binary_operator of the same operator class
3. Return the start position of that leftmost node

```rust
// If outermost spans multiple lines, find the leftmost node of our class
let outermost_start = outermost.start_position();
let outermost_end = outermost.end_position();
if outermost_start.row != outermost_end.row {
    if let Some(leftmost) = find_leftmost_of_class(outermost, our_class, source) {
        let start = leftmost.start_position();
        return Some((start.row as u32, start.column as u32));
    }
}
```

### Option 2: Fix ChainWalker to understand operator classes

Modify `ChainWalker` to only walk backward through operators of the same class:

1. Add operator class detection to `ChainWalker`
2. In `find_chain_start`, determine the operator class from `prev_line`
3. Only continue backward if the previous line ends with the same class of operator

### Option 3: Fix ChainWalker starting position

When falling back to `ChainWalker`, start from `prev_line` instead of `position`:

```rust
let fallback_pos = Position {
    line: prev_line,
    character: 0,
};
let result = walker.find_chain_start(fallback_pos);
```

This would make it find the start of the current sub-chain (the `+` chain) rather than the entire mixed chain.

## Recommendation

**Option 1** is the most robust solution because:
- It handles mixed chains correctly at the AST level
- It doesn't require text-based heuristics
- It's consistent with the existing AST-based approach
- It handles edge cases like MISSING nodes correctly

## Implementation Notes

### Column Calculation Bug

There's also a bug in how the column is calculated when finding the AST node:

```rust
// WRONG: doesn't account for leading whitespace
let trimmed_end_col = trimmed.len().saturating_sub(1);

// CORRECT: account for leading whitespace
let leading_ws = line_text.len() - line_text.trim_start().len();
let trimmed_end_col = leading_ws + trimmed.trim_start().len().saturating_sub(1);
```

### Test Case

```rust
#[test]
fn test_continuation_after_pipe_with_nested_calls() {
    let code = "x <- f(a,\n       b,\n       c(a,\n         b = f(a,\n               b))) |>\n     x + y +\n";
    let col = get_indentation_column(code, 6, rstudio_config(4));
    assert_eq!(col, 5, "Should align with chain start after pipe");
}
```

## Related Code

- `crates/raven/src/indentation/context.rs`:
  - `find_chain_start_from_ast` (lines 1197-1275)
  - `detect_continuation_operator` (lines 1293-1341)
  - `ChainWalker` (lines 1689-1850)
- `crates/raven/src/indentation/calculator.rs`:
  - `calculate_indentation` (lines 58-115)

## ESS Comparison

ESS (Emacs Speaks Statistics) handles this correctly by:
1. Distinguishing between operator classes (pipe vs arithmetic)
2. Finding the start of the current operator class chain, not the entire mixed chain
3. Not adding extra indentation when the chain start is already indented

## Status

- **Discovered:** 2026-02-11
- **Severity:** Medium (affects mixed chain indentation)
- **Workaround:** None
- **Fix Status:** Implemented and verified (commits 29e5549, 041b3fa)
