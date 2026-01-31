# Design Document: Interval Tree Scope Lookup

## Overview

This design introduces an interval tree data structure to optimize function scope lookups in the rlsp cross-file awareness module. The current implementation uses linear scans (O(n)) over a vector of function scopes to determine which scope contains a given position. By replacing this with an interval tree, point queries become O(log n + k) where k is the number of containing intervals.

The optimization targets six specific locations in `scope.rs` where `function_scopes.iter()` is called with filter/max_by_key patterns to find containing scopes. These patterns are replaced with efficient interval tree queries.

## Architecture

```mermaid
graph TD
    subgraph "Current Architecture"
        A1[ScopeArtifacts] --> B1[function_scopes: Vec]
        B1 --> C1[Linear Scan O(n)]
        C1 --> D1[Filter + max_by_key]
    end
    
    subgraph "New Architecture"
        A2[ScopeArtifacts] --> B2[function_scope_tree: FunctionScopeTree]
        B2 --> C2[Interval Tree Query O(log n)]
        C2 --> D2[Innermost Selection O(k)]
    end
```

### Design Decisions

1. **Custom Implementation vs External Crate**: We implement a minimal custom interval tree rather than using an external crate because:
   - The use case is narrow (2D position intervals with specific containment semantics)
   - External crates like `interavl` use half-open intervals, but we need inclusive boundaries
   - Minimizes dependency footprint
   - Allows tight integration with existing position comparison semantics

2. **Augmented BST Approach**: The interval tree is implemented as an augmented binary search tree where each node stores the maximum end position in its subtree. This enables efficient pruning during queries.

3. **Static Construction**: Since function scopes are computed once per file and don't change until re-parsing, we use a static construction approach (build once from sorted intervals) rather than supporting dynamic insertions.

## Components and Interfaces

### FunctionScopeTree

The core interval tree data structure for storing and querying function scopes.

```rust
/// A 2D position in a document (line, column)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

/// A function scope interval with start and end positions
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FunctionScopeInterval {
    pub start: Position,
    pub end: Position,
}

/// Node in the interval tree
struct IntervalNode {
    interval: FunctionScopeInterval,
    max_end: Position,
    left: Option<Box<IntervalNode>>,
    right: Option<Box<IntervalNode>>,
}

/// Interval tree for efficient function scope queries
pub struct FunctionScopeTree {
    root: Option<Box<IntervalNode>>,
    count: usize,
}

impl FunctionScopeTree {
    /// Build a tree from a slice of function scope tuples
    /// Time complexity: O(n log n)
    pub fn from_scopes(scopes: &[(u32, u32, u32, u32)]) -> Self;
    
    /// Query all intervals containing the given position
    /// Time complexity: O(log n + k) where k is result count
    pub fn query_point(&self, pos: Position) -> Vec<FunctionScopeInterval>;
    
    /// Query for the innermost (latest start) interval containing the position
    /// Time complexity: O(log n + k) where k is containing interval count
    pub fn query_innermost(&self, pos: Position) -> Option<FunctionScopeInterval>;
    
    /// Check if the tree is empty
    pub fn is_empty(&self) -> bool;
    
    /// Get the number of intervals in the tree
    pub fn len(&self) -> usize;
}
```

### Integration Points

The `FunctionScopeTree` integrates with existing code at these points:

1. **ScopeArtifacts**: Replace `function_scopes: Vec<(u32, u32, u32, u32)>` with `function_scope_tree: FunctionScopeTree`

2. **compute_artifacts()**: Build the interval tree after collecting FunctionScope events

3. **scope_at_position()**: Replace linear scans with `query_point()` or `query_innermost()`

4. **scope_at_position_recursive()**: Same replacement pattern

5. **find_containing_function_scope()**: Delegate to `query_innermost()`

## Data Models

### Position

Represents a 2D position in a document using LSP conventions (0-based line, UTF-16 column).

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

impl Position {
    pub fn new(line: u32, column: u32) -> Self {
        Self { line, column }
    }
    
    /// Create a position representing end-of-file
    pub fn eof() -> Self {
        Self { line: u32::MAX, column: u32::MAX }
    }
    
    /// Check if this is an EOF sentinel position
    pub fn is_eof(&self) -> bool {
        self.line == u32::MAX || self.column == u32::MAX
    }
}
```

### FunctionScopeInterval

Represents a function scope as a closed interval [start, end].

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FunctionScopeInterval {
    pub start: Position,
    pub end: Position,
}

impl FunctionScopeInterval {
    pub fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }
    
    /// Check if this interval contains the given position (inclusive)
    pub fn contains(&self, pos: Position) -> bool {
        self.start <= pos && pos <= self.end
    }
    
    /// Convert from tuple representation
    pub fn from_tuple(tuple: (u32, u32, u32, u32)) -> Self {
        Self {
            start: Position::new(tuple.0, tuple.1),
            end: Position::new(tuple.2, tuple.3),
        }
    }
    
    /// Convert to tuple representation for backward compatibility
    pub fn to_tuple(&self) -> (u32, u32, u32, u32) {
        (self.start.line, self.start.column, self.end.line, self.end.column)
    }
}
```

### IntervalNode (Internal)

Internal node structure for the augmented BST.

```rust
struct IntervalNode {
    /// The interval stored at this node
    interval: FunctionScopeInterval,
    /// Maximum end position in this subtree (for pruning)
    max_end: Position,
    /// Left subtree (intervals with smaller start positions)
    left: Option<Box<IntervalNode>>,
    /// Right subtree (intervals with larger start positions)
    right: Option<Box<IntervalNode>>,
}
```

### Updated ScopeArtifacts

```rust
pub struct ScopeArtifacts {
    pub exported_interface: HashMap<String, ScopedSymbol>,
    pub timeline: Vec<ScopeEvent>,
    pub interface_hash: u64,
    /// Interval tree for O(log n) function scope queries
    pub function_scope_tree: FunctionScopeTree,
}
```



## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Point Query Correctness

*For any* set of function scope intervals and *for any* query position, the point query SHALL return exactly those intervals that contain the position—no false positives (intervals that don't contain the point) and no false negatives (missing intervals that do contain the point).

**Validates: Requirements 1.3, 1.4**

### Property 2: Innermost Selection Correctness

*For any* set of function scope intervals and *for any* query position, the innermost query SHALL return the interval with the lexicographically largest start position among all intervals containing the query point, or None if no intervals contain the point.

**Validates: Requirements 2.1, 2.2**

### Property 3: Backward Compatibility (Model-Based)

*For any* valid R source code and *for any* position within that code, the scope resolution using the interval tree SHALL produce identical results to the original linear scan implementation.

**Validates: Requirements 3.4**

### Property 4: Position Lexicographic Ordering

*For any* two positions (line1, col1) and (line2, col2), the Position comparison SHALL follow lexicographic ordering: (line1, col1) < (line2, col2) if and only if line1 < line2, or (line1 == line2 and col1 < col2).

**Validates: Requirements 4.1**

## Error Handling

### Empty Tree Queries

When querying an empty interval tree:
- `query_point()` returns an empty `Vec`
- `query_innermost()` returns `None`
- No panics or errors occur

### Invalid Intervals

Intervals where `start > end` are considered invalid:
- The `from_scopes()` constructor filters out invalid intervals with a warning log
- This maintains robustness against malformed AST data

### EOF Sentinel Positions

When the query position is an EOF sentinel (`u32::MAX, u32::MAX`):
- The query proceeds normally but typically returns no results
- This matches existing behavior where EOF positions don't match function scopes

### Large Column Values

UTF-16 column values near `u32::MAX`:
- Position comparison uses standard Rust `Ord` which handles large values correctly
- No special overflow handling needed since we use `u32` throughout

## Testing Strategy

### Dual Testing Approach

This feature uses both unit tests and property-based tests:

- **Unit tests**: Verify specific examples, edge cases, and error conditions
- **Property tests**: Verify universal properties across randomly generated inputs

### Property-Based Testing Configuration

- **Library**: `proptest` (already a dev-dependency)
- **Minimum iterations**: 100 per property test
- **Tag format**: `Feature: interval-tree-scope-lookup, Property N: description`

### Test Categories

#### Unit Tests

1. **Empty tree**: Query empty tree returns empty/None
2. **Single interval**: Basic containment check
3. **Boundary positions**: Positions exactly at start/end are included
4. **Non-overlapping intervals**: Multiple disjoint intervals
5. **Nested intervals**: Innermost selection with nested scopes
6. **EOF sentinel**: EOF positions don't match scopes

#### Property Tests

1. **Property 1**: Point query correctness
   - Generate random intervals and query points
   - Verify all returned intervals contain the point
   - Verify no containing intervals are missed (compare with brute force)

2. **Property 2**: Innermost selection correctness
   - Generate random intervals and query points
   - Verify result has maximum start among containing intervals

3. **Property 3**: Backward compatibility
   - Generate random R code with functions
   - Compare old (linear scan) vs new (interval tree) results

4. **Property 4**: Position ordering
   - Generate random position pairs
   - Verify lexicographic ordering holds

### Test File Location

Tests will be added to:
- `crates/rlsp/src/cross_file/scope.rs` (unit tests in `#[cfg(test)]` module)
- `crates/rlsp/src/cross_file/property_tests.rs` (property tests)
