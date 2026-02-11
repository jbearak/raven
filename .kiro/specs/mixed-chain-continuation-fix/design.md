# Design Document: Mixed Chain Continuation Indentation Fix

## Overview

This fix addresses incorrect indentation in mixed operator chains — where a pipe (`|>`) is followed by arithmetic (`+`) or other continuation operators. The current `find_chain_start_from_ast` detects mixed chains via `is_mixed_chain` and returns `None`, falling back to `ChainWalker`. `ChainWalker` doesn't distinguish operator classes, so it walks past the class boundary and returns the wrong chain start.

The fix keeps resolution in the AST path by finding the sub-chain start at the operator class boundary instead of falling back to text heuristics.

## Problem

### Reproducing Example

```r
x <- f(a,
       b,
       c(a,
         b = f(a,
               b))) |>
     x + y +
     [CURSOR]
```

Expected: cursor at column 5 (aligned with `x` after `|>`).
Actual: cursor at column 19.

### Root Cause

1. `detect_continuation_operator` is called with `prev_line = 5` (the `x + y +` line).
2. `find_chain_start_from_ast` finds the `+` node, determines `our_class = 1`.
3. `is_mixed_chain` detects the LHS contains `|>` (class 0) → returns `true`.
4. `find_chain_start_from_ast` returns `None`.
5. Fallback: `ChainWalker.find_chain_start(position)` with `position.line = 6`.
6. `ChainWalker` walks backward: line 5 (`+`) → line 4 (`|>`) → line 3 (`,`) → stop.
7. Returns `(4, 15)` — the `|>` line's first non-whitespace column.
8. Calculator: `max(15, 15 + 4) = 19`.

The correct answer is `(5, 5)` — the start of the `+` sub-chain.

### AST Structure

```text
binary_operator                          ; x <- ...
  └── rhs: binary_operator (+)          ; (f(...) |> x) + y + MISSING
        ├── lhs: binary_operator (+)    ; (f(...) |> x) + y
        │     ├── lhs: binary_operator (|>)  ; f(...) |> x    ← class boundary
        │     │     ├── lhs: call            ; f(a, b, c(...))
        │     │     └── rhs: identifier      ; x  (line 5, col 5)
        │     └── rhs: identifier            ; y
        └── rhs: MISSING identifier
```

The walk-up loop in `find_chain_start_from_ast` correctly stops at the outermost `+` binary_operator (the one containing `+ y + MISSING`). But `outermost.start_position()` returns the start of the entire LHS expression (`f(...)` on line 0), not the sub-chain start (`x` on line 5).

## Solution

### Change 1: Replace `is_mixed_chain` fallback with `find_subchain_start`

Remove the `is_mixed_chain` check and `None` return. Instead, after computing `outermost`, drill into its LHS spine to find the operator class boundary and return the RHS of the cross-class node — that's the first operand of the current sub-chain.

New helper function:

```rust
/// For a same-class outermost binary_operator, find the start position of the
/// sub-chain's first operand. Drills into the LHS spine until hitting a
/// different operator class or a non-binary-operator, then returns the RHS
/// of that boundary node.
fn find_subchain_start(
    outermost: tree_sitter::Node,
    target_class: u8,
    source: &str,
) -> (u32, u32) {
    let mut current = outermost;
    loop {
        let Some(lhs) = current.child(0) else { break };
        if lhs.kind() != "binary_operator" {
            break;
        }
        match continuation_class_of_binop(&lhs, source) {
            Some(class) if class == target_class => current = lhs,
            _ => {
                // Cross-class boundary: the sub-chain's first operand is
                // the RHS of this different-class node (child index 2).
                if let Some(rhs) = lhs.child(2) {
                    let pos = rhs.start_position();
                    return (pos.row as u32, pos.column as u32);
                }
                break;
            }
        }
    }
    let pos = current.start_position();
    (pos.row as u32, pos.column as u32)
}
```

For the example: `outermost` is the `+` node for `(f(...) |> x) + y + MISSING`. Drill into LHS: `(f(...) |> x) + y` is class 1 (same) → continue. Its LHS is `f(...) |> x` which is class 0 (different) → get `lhs.child(2)` = `x` at (5, 5). ✓

Modification to `find_chain_start_from_ast`:

```rust
// REMOVE:
//   if is_mixed_chain(chain_binop, our_class, source) {
//       return None;
//   }

// REPLACE the final return logic with:
let (start_row, start_col) = find_subchain_start(outermost, our_class, source);

// Check if outermost's parent is an assignment
if let Some(parent) = outermost.parent() {
    let pk = parent.kind();
    if pk == "left_assignment" || pk == "equals_assignment" || pk == "right_assignment" {
        return Some((start_row, start_col));
    }
}

Some((start_row, start_col))
```

### Change 2: Fix column calculation for AST node lookup

The current code computes the column for the end of code on `prev_line` as:

```rust
let trimmed_end_col = trimmed.len().saturating_sub(1);
```

This works when `trimmed` preserves leading whitespace (since `strip_trailing_comment` + `trim_end` only trims the right side). However, the intent is fragile. Make it explicit:

```rust
let leading_ws = line_text.len() - line_text.trim_start().len();
let content_len = trimmed.trim_start().len();
let trimmed_end_col = leading_ws + content_len.saturating_sub(1);
```

### Change 3: Remove `is_mixed_chain` function

After Change 1, `is_mixed_chain` is no longer called. Remove it to avoid dead code.

## Affected Files

- `crates/raven/src/indentation/context.rs`:
  - Remove `is_mixed_chain` (lines 1169-1186)
  - Add `find_subchain_start`
  - Modify `find_chain_start_from_ast` (lines 1197-1275): remove mixed-chain fallback, use `find_subchain_start` for return value
  - Fix column calculation (around line 1210)

## Edge Cases

1. **Single-class chain** (no mixing): `find_subchain_start` drills to a non-binary-operator LHS and returns `current.start_position()` — same as the current `outermost.start_position()`. No behavior change.
2. **Triple-class chain** (e.g., `|>` then `+` then `~`): each class boundary is resolved independently since `find_chain_start_from_ast` is called for the operator on `prev_line`, and the walk-up loop stops at the first different-class parent.
3. **MISSING nodes**: tree-sitter extends parent spans for MISSING children, but the walk-up loop uses `continuation_class_of_binop` which checks the operator child, not the span. MISSING nodes don't affect class detection.
4. **Nested function calls in mixed chains**: the pipe's RHS (child index 2) is the identifier/call after the pipe, which is the correct sub-chain start regardless of how complex the LHS call is.
