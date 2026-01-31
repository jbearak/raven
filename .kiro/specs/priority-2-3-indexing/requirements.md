# Requirements: Priority 2 and 3 On-Demand Indexing

## Overview

Extend the on-demand indexing system to handle Priority 2 (backward directive targets) and Priority 3 (transitive dependencies) files asynchronously in the background, without blocking diagnostics.

## Background

Task 20.2 implemented synchronous Priority 1 indexing (directly sourced files) to fix the race condition where diagnostics ran before sourced files were indexed. However, Priority 2 and 3 indexing were skipped due to architectural constraints (Backend doesn't implement Clone, making it difficult to spawn async tasks that need Backend methods).

## User Stories

### 1. As a developer, I want files referenced by backward directives to be indexed automatically
**Acceptance Criteria:**
- 1.1: When a file with `@lsp-run-by: ../parent.r` is opened, the parent file is indexed if not already in the workspace index
- 1.2: Indexing happens asynchronously without blocking diagnostics for the opened file
- 1.3: Parent file symbols become available for cross-file resolution after indexing completes
- 1.4: If parent file is already indexed, no duplicate indexing occurs

### 2. As a developer, I want transitive dependencies to be indexed automatically
**Acceptance Criteria:**
- 2.1: When a file A sources file B, and B sources file C, opening A triggers indexing of both B and C
- 2.2: Priority 1 files (B) are indexed synchronously before diagnostics
- 2.3: Priority 3 files (C) are indexed asynchronously in the background
- 2.4: Transitive indexing is bounded by a configurable depth limit (default: 2 levels)
- 2.5: Circular dependencies are detected and don't cause infinite indexing loops

### 3. As a developer, I want efficient background indexing that doesn't impact performance
**Acceptance Criteria:**
- 3.1: Background indexing uses a task queue with priority ordering
- 3.2: Only one background indexing task runs at a time to avoid resource contention
- 3.3: Background indexing can be cancelled if the file is closed or workspace changes
- 3.4: Background indexing respects a maximum queue size to prevent memory issues

## Technical Requirements

### 4. Architecture: Refactor Backend to support async indexing
**Acceptance Criteria:**
- 4.1: Extract indexing logic into a separate struct that can be cloned/shared
- 4.2: Use Arc<RwLock<WorldState>> directly in indexing tasks instead of Backend reference
- 4.3: Create a BackgroundIndexer struct that manages the indexing queue
- 4.4: BackgroundIndexer is owned by Backend and accessible via Arc

### 5. Priority 2 Indexing: Backward directive targets
**Acceptance Criteria:**
- 5.1: In `did_open()`, collect files referenced by backward directives
- 5.2: Check if each file needs indexing (not open, not in workspace index)
- 5.3: Submit Priority 2 files to background indexer queue
- 5.4: Background indexer processes Priority 2 files after Priority 1 completes

### 6. Priority 3 Indexing: Transitive dependencies
**Acceptance Criteria:**
- 6.1: After indexing a Priority 1 file, extract its source() calls
- 6.2: For each sourced file not yet indexed, add to queue as Priority 3
- 6.3: Limit transitive depth to prevent excessive indexing (configurable, default: 2)
- 6.4: Track visited files to prevent circular dependency loops

### 7. Configuration
**Acceptance Criteria:**
- 7.1: Add `crossFile.onDemandIndexing.enabled` setting (default: true)
- 7.2: Add `crossFile.onDemandIndexing.maxTransitiveDepth` setting (default: 2)
- 7.3: Add `crossFile.onDemandIndexing.maxQueueSize` setting (default: 50)
- 7.4: Add `crossFile.onDemandIndexing.priority2Enabled` setting (default: true)
- 7.5: Add `crossFile.onDemandIndexing.priority3Enabled` setting (default: true)

### 8. Logging and Observability
**Acceptance Criteria:**
- 8.1: Log when files are added to background indexing queue with priority
- 8.2: Log when background indexing starts and completes for each file
- 8.3: Log queue size and processing time for performance monitoring
- 8.4: Log when files are skipped due to queue size limits

### 9. Error Handling
**Acceptance Criteria:**
- 9.1: File read errors don't crash the background indexer
- 9.2: Parse errors are logged but don't prevent other files from being indexed
- 9.3: Background indexer continues processing queue even if individual files fail
- 9.4: Failed files can be retried on next access

## Non-Goals

- Real-time re-indexing of changed files (handled by existing file watcher)
- Indexing files outside the workspace
- Parallel indexing of multiple files (sequential is simpler and sufficient)

## Success Metrics

- Priority 2 and 3 files are indexed within 1 second of opening a file
- No performance degradation when opening files with many transitive dependencies
- Background indexing queue never exceeds configured maximum size
- Zero crashes or hangs due to background indexing

## Dependencies

- Requires completed task 20.2 (Priority 1 synchronous indexing)
- Requires existing workspace indexing infrastructure
- Requires existing dependency graph and metadata extraction

## Open Questions

1. Should we index Priority 2 files synchronously or asynchronously?
   - **Recommendation**: Asynchronously - they're less critical than Priority 1
   
2. Should transitive depth be per-file or global?
   - **Recommendation**: Per-file - allows deeper chains from important entry points

3. Should we prioritize recently accessed files in the queue?
   - **Recommendation**: Yes - use activity tracking similar to revalidation

4. Should background indexing be cancellable?
   - **Recommendation**: Yes - cancel when file is closed or workspace changes
