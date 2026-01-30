# AGENTS.md - LLM Guidance for Rlsp

## Project Overview

Rlsp is a static R Language Server extracted from Ark. It provides LSP features without embedding R runtime. Uses tree-sitter for parsing, subprocess calls for help.

## Repository Structure

- `crates/rlsp/`: Main LSP implementation
- `crates/rlsp/src/cross_file/`: Cross-file awareness module
- `editors/vscode/`: VS Code extension
- `Cargo.toml`: Workspace root
- `setup.sh`: Build and install script

## Build Commands

- `cargo build -p rlsp` - Debug build
- `cargo build --release -p rlsp` - Release build
- `cargo test -p rlsp` - Run tests
- `./setup.sh` - Build and install everything

## LSP Architecture

- Static analysis using tree-sitter-r
- Workspace symbol indexing (functions, variables)
- Package awareness (library() calls, NAMESPACE)
- Help via R subprocess (tools::Rd2txt)
- Thread-safe caching (RwLock)
- Cross-file awareness via source() detection and directives

## Cross-File Architecture

### Module Structure (`crates/rlsp/src/cross_file/`)

- `types.rs` - Core types (CrossFileMetadata, BackwardDirective, ForwardSource, CallSiteSpec)
- `directive.rs` - Directive parsing (@lsp-sourced-by, @lsp-source, etc.) with optional colon/quotes
- `source_detect.rs` - Tree-sitter based source() call detection with UTF-16 columns
- `path_resolve.rs` - Path resolution with working directory support
- `dependency.rs` - Dependency graph with directive-vs-AST conflict resolution
- `scope.rs` - Scope resolution and symbol extraction
- `config.rs` - Configuration options including severity settings
- `cache.rs` - Caching with interior mutability
- `parent_resolve.rs` - Parent resolution with match= and call-site inference
- `revalidation.rs` - Real-time update system with debouncing
- `workspace_index.rs` - Workspace indexing for closed files
- `file_cache.rs` - Disk file cache with snapshots
- `content_provider.rs` - Unified content provider

### Directive Syntax

All directives support optional colon and quotes:
- `# @lsp-sourced-by ../main.R`
- `# @lsp-sourced-by: ../main.R`
- `# @lsp-sourced-by "../main.R"`
- `# @lsp-sourced-by: "../main.R"`

Backward directive synonyms: `@lsp-sourced-by`, `@lsp-run-by`, `@lsp-included-by`
Working directory synonyms: `@lsp-working-directory`, `@lsp-working-dir`, `@lsp-current-directory`, `@lsp-current-dir`, `@lsp-wd`, `@lsp-cd`

### Call-Site Resolution

1. `line=N` - Explicit line number (highest precedence)
2. `match="pattern"` - Pattern search in parent file
3. Text inference - Scan parent for source() calls to child
4. Config default - `assumeCallSite` setting ("end" or "start")

### Directive-vs-AST Conflict Resolution

- Directive with known call site: only overrides AST edge at same call site
- Directive without call site: suppresses all AST edges to that target (emits warning)
- AST edges to different targets are always preserved

### Dependency Graph

- Forward edges only (parent sources child)
- Backward directives create/confirm forward edges
- Edges store call site position (line, column in UTF-16)
- Stores local, chdir, is_sys_source flags
- Deduplication by canonical key

### Scope Resolution

- Position-aware: scope depends on (line, character) position
- Two-phase: compute per-file artifacts (non-recursive), then traverse
- Artifacts include: exported interface, timeline of scope events, interface hash
- Timeline contains: symbol definitions, source() calls, working directory changes
- Traversal bounded by max_chain_depth and visited set

### Caching Strategy

- Three caches with interior mutability: MetadataCache, ArtifactsCache, ParentSelectionCache
- Fingerprinted entries: self_hash, edges_hash, upstream_interfaces_hash, workspace_index_version
- Invalidation triggers: interface hash change OR edge set change

### Real-Time Updates

- Metadata extraction on document change
- Dependency graph update
- Selective invalidation based on interface/edge changes
- Debounced diagnostics fanout to affected open files
- Cancellation of outdated pending revalidations
- Freshness guards prevent stale diagnostic publishes
- Monotonic publishing: never publish older version than last published

### Thread-Safety

- WorldState protected by Arc<tokio::sync::RwLock>
- Concurrent reads from request handlers
- Serialized writes for state mutations
- Interior-mutable caches allow population during read operations
- Background tasks reacquire locks, never hold borrowed &mut WorldState

## VS Code Extension

- TypeScript client in `editors/vscode/src/`
- Bundles platform-specific rlsp binary
- Configuration: `rlsp.server.path`
- Sends activity notifications for revalidation prioritization

## Coding Style

- No `bail!`, use explicit `return Err(anyhow!(...))`
- Omit `return` in match expressions
- Direct formatting: `anyhow!("Message: {err}")`
- Use `log::trace!` instead of `log::debug!`
- Fully qualified result types

## Testing

Property-based tests with proptest, integration tests

## Built-in Functions

`build_builtins.R` generates `src/builtins.rs` with 2,355 R functions

## Release Process

Manual tagging (`git tag vX.Y.Z && git push origin vX.Y.Z`) triggers GitHub Actions

## Extension Guide

### Adding New Directives

1. **Define the directive type** in `types.rs`:
   - Add variant to existing enum or create new struct
   - Include all necessary fields (path, line, parameters)

2. **Parse the directive** in `directive.rs`:
   - Add regex pattern to `DIRECTIVE_PATTERNS` or create new pattern
   - Handle optional colon and quotes: `@name:? "?path"?`
   - Parse any parameters (e.g., `line=N`, `match="pattern"`)
   - Add to `parse_directives()` function

3. **Process in dependency graph** (`dependency.rs`):
   - Handle in `update_file()` method
   - Create appropriate `DependencyEdge` entries
   - Consider directive-vs-AST conflict resolution

4. **Update scope resolution** (`scope.rs`) if directive affects symbol availability

5. **Add tests**:
   - Unit tests in the module's `#[cfg(test)]` section
   - Property tests in `property_tests.rs` for invariants

### Extending Scope Resolution

1. **Modify `ScopeArtifacts`** in `scope.rs`:
   - Add new fields to track additional scope information
   - Update `compute_artifacts()` to populate new fields

2. **Update timeline events** (`ScopeEvent` enum):
   - Add new event types for scope-affecting constructs
   - Handle in `scope_at_position_*` functions

3. **Modify traversal** in `scope_at_position_with_graph_recursive()`:
   - Process new event types
   - Maintain correct symbol precedence (local > inherited)

4. **Update interface hash** if changes affect cross-file invalidation

### Adding Cross-File Diagnostics

1. **Define diagnostic type** in `handlers.rs`:
   - Create `collect_*_diagnostics()` function
   - Use `state.cross_file_config.*_severity` for configurable severity

2. **Add configuration** in `config.rs`:
   - Add severity field to `CrossFileConfig`
   - Add to `from_initialization_options()`

3. **Wire into diagnostics collection** in `handlers.rs`:
   - Call from `collect_diagnostics()` or `publish_diagnostics()`
   - Ensure proper position (line, column) in UTF-16

4. **Add tests** for diagnostic generation and severity configuration

### Testing Strategies

**Unit Tests:**
- Test individual functions in isolation
- Use `#[cfg(test)]` module at end of each file
- Mock dependencies with closures

**Property Tests** (`property_tests.rs`):
- Test invariants that must hold for all inputs
- Use `proptest!` macro with custom strategies
- Focus on: edge deduplication, scope precedence, path resolution

**Integration Tests:**
- Test full LSP request/response cycles
- Use `handlers::integration_tests` module
- Test with realistic R code patterns

**Test Patterns:**
```rust
// Unit test pattern
#[test]
fn test_specific_behavior() {
    let input = /* setup */;
    let result = function_under_test(input);
    assert_eq!(result, expected);
}

// Property test pattern
proptest! {
    #[test]
    fn prop_invariant_holds(input in strategy()) {
        let result = function_under_test(input);
        prop_assert!(invariant(result));
    }
}
```