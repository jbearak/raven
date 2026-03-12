# Arc<ScopeArtifacts> Refactor — Eliminate Cloning in Scope Resolution

## Problem

Every call to `get_artifacts(uri)` in scope resolution closures clones the full `ScopeArtifacts` struct, which contains:
- `HashMap<Arc<str>, ScopedSymbol>` (can have hundreds of entries)
- `Vec<ScopeEvent>` (large timeline)
- `FunctionScopeTree` (heap-allocated interval tree)

In dense dependency graphs, scope resolution calls `get_artifacts` many times across many files. Each clone is O(n) in the number of symbols/events. For files referencing many other files, this dominates diagnostic computation time.

**Key insight**: `scope_at_position_with_graph_recursive` only *borrows* the returned `ScopeArtifacts` — it never moves or stores it. Wrapping in `Arc` makes every clone O(1) (atomic refcount increment).

## Plan

### Step 1: Store `Arc<ScopeArtifacts>` in index entries

Change the three storage sites from `ScopeArtifacts` to `Arc<ScopeArtifacts>`:

- `document_store.rs:94` — `DocumentState.artifacts: Arc<ScopeArtifacts>`
- `workspace_index.rs:98` — `IndexEntry.artifacts: Arc<ScopeArtifacts>`
- `cross_file/workspace_index.rs:27` — `IndexEntry.artifacts: Arc<ScopeArtifacts>`

All sites that *write* to these fields wrap in `Arc::new(...)`. All sites that *read* get an `Arc` clone (O(1)) instead of a deep clone.

**Files**: `document_store.rs`, `workspace_index.rs`, `cross_file/workspace_index.rs`

### Step 2: Update `get_artifacts()` return types

Change all `get_artifacts` methods and trait definitions to return `Option<Arc<ScopeArtifacts>>`:

- `content_provider.rs:49` — `ContentProvider` trait: `fn get_artifacts(&self, uri: &Url) -> Option<Arc<ScopeArtifacts>>`
- `content_provider.rs:274` — `DefaultContentProvider` implementation (5-layer fallback)
- `cross_file/content_provider.rs:29` — second `ContentProvider` trait
- `cross_file/content_provider.rs:103` — `CrossFileContentProvider` implementation
- `workspace_index.rs:244` — direct `get_artifacts` method
- `cross_file/workspace_index.rs:104` — direct `get_artifacts` method
- Test `MockContentProvider` (`content_provider.rs:470`)

For the `DefaultContentProvider` fallback that recomputes via `scope::compute_artifacts(...)`, wrap the result: `Arc::new(scope::compute_artifacts(...))`.

**Files**: `content_provider.rs`, `cross_file/content_provider.rs`, `workspace_index.rs`, `cross_file/workspace_index.rs`

### Step 3: Update scope resolution generic bounds

Change the `F` type parameter:

```rust
// Before
F: Fn(&Url) -> Option<ScopeArtifacts>
// After
F: Fn(&Url) -> Option<Arc<ScopeArtifacts>>
```

In both:
- `scope_at_position_with_graph` (scope.rs:2292)
- `scope_at_position_with_graph_recursive` (scope.rs:2353)

The function body needs no changes — `Arc<T>` auto-derefs to `&T`. The local `let artifacts = match get_artifacts(uri) { Some(a) => a, ... }` will bind an `Arc<ScopeArtifacts>`, and all subsequent `artifacts.field` borrows work via `Deref`.

Also update the standalone `scope_at_position` (scope.rs ~line 1620) if it has the same pattern.

**Files**: `cross_file/scope.rs`

### Step 4: Update all closure call sites

Update closures at each caller to return `Option<Arc<ScopeArtifacts>>`:

| Caller | File:Line | Change |
|---|---|---|
| `DiagnosticsSnapshot::get_scope` | `handlers.rs:191` | `.get().cloned()` on `HashMap<Url, Arc<ScopeArtifacts>>` → returns `Arc` |
| `get_cross_file_scope` | `handlers.rs:2218` | `content_provider.get_artifacts()` already returns `Arc` after Step 2 |
| `collect_max_depth_diagnostics` | `handlers.rs:3701` | Wrap recompute: `Arc::new(scope::compute_artifacts(...))` |
| `collect_max_depth_diagnostics_from_snapshot` | `handlers.rs:3996` | Same as get_scope — map stores `Arc` |
| `did_open` prefetch | `backend.rs:1657` | `content_provider.get_artifacts()` already returns `Arc` |
| `parameter_resolver` | `parameter_resolver.rs:756` | `content_provider.get_artifacts()` already returns `Arc` |
| Integration test | `content_provider.rs:2244` | `provider.get_artifacts()` already returns `Arc` |

**Files**: `handlers.rs`, `backend.rs`, `parameter_resolver.rs`

### Step 5: Update `DiagnosticsSnapshot.artifacts_map`

Change from `HashMap<Url, ScopeArtifacts>` to `HashMap<Url, Arc<ScopeArtifacts>>`.

The `build()` method's pre-collect loop calls `content_provider.get_artifacts()` which now returns `Arc`, so inserts are already O(1). The `get_scope()` closure's `.get().cloned()` clones the `Arc` (O(1)) instead of the full struct.

**Files**: `handlers.rs`

### Step 6: Update test call sites

Many tests in `scope.rs`, `property_tests.rs`, `integration_tests.rs`, and `performance_budgets.rs` construct closures returning `Option<ScopeArtifacts>`. These need to wrap returns in `Arc::new(...)` or change their `HashMap` storage.

Strategy: use a background agent to update all test call sites after the production code compiles.

**Files**: `cross_file/scope.rs` (tests), `cross_file/property_tests.rs`, `cross_file/integration_tests.rs`, `tests/performance_budgets.rs`

## Implementation Order

1. Steps 1-2 together (storage + return types) — get the data flow producing `Arc`s
2. Steps 3-5 together (consumers) — update scope resolution and snapshot to accept `Arc`s
3. Step 6 (tests) — mechanical update, can use background agent

## Verification

- `cargo build -p raven` — no warnings
- `cargo test -p raven` — all tests pass
- `cargo test --release --test performance_budgets --features test-support` — performance budgets pass
- Manual: open a workspace with many cross-file references, verify diagnostics are faster

## Risk

Low. The refactor is mechanical — `Arc<T>` implements `Deref<Target=T>`, so all borrow-based usage works unchanged. The only behavioral difference is clone cost: O(1) instead of O(n).

One subtlety: mutation sites that do `entry.artifacts = compute_artifacts(...)` need `entry.artifacts = Arc::new(compute_artifacts(...))`. These are limited to document open/change handlers and indexing paths.
