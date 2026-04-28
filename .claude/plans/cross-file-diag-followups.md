# Cross-file diagnostic latency: deferred follow-ups

GitHub issue: https://github.com/jbearak/raven/issues/123
Branch: `cross-file-diag-followups` (off `main`)
Predecessor PR (already merged): #124 — bumped `DocumentStoreConfig::default()` to `max_documents: 4096`, `max_memory_bytes: 512 MB` and added the `edit_to_publish` bench plus the `profile_diagnostics` example.

## Context

While investigating user-reported lag in cross-file diagnostic updates (R scripts that source/are-sourced-by other scripts in a large workspace), the dominant cause turned out to be `DocumentStoreConfig::default()` evicting open documents (`max_documents: 50`) and forcing the snapshot path to recompute scope artifacts and metadata from scratch on every `DiagnosticsSnapshot::build`. That fix landed on the `speed` branch (`crates/raven/src/document_store.rs`: defaults bumped to `max_documents: 4096`, `max_memory_bytes: 512 MB`).

Measured impact (see benches below):

| Scenario | Before | After |
|---|---:|---:|
| Single hub edit (mixed_20×5, 121 files) | 11.86 ms | 2.42 ms |
| Cumulative cascade (hub + 30 leaves) | 209 ms | 11.9 ms |
| Stress (mixed_50×10, 551 files) hub | — | 4.21 ms |

This issue tracks the lower-priority follow-ups that were identified during that investigation. Each item is independent — they can be picked up in parallel and are well-suited to subagent dispatch.

## How to measure

- End-to-end bench: `cargo bench --features test-support --bench edit_to_publish`
- Phase-by-phase trace: `RUST_LOG=raven=trace cargo run --release --example profile_diagnostics --features test-support`

Use `--save-baseline before` / `--baseline before` to compare runs.

## Deferred items

- [x] **Structural: pin documents that are reachable from any open document.** Treat the cache's "do not evict" set as the *transitive dependency neighborhood* of open documents — not just open documents themselves. A closed file that is sourced by an open file (or sources one) is still consulted on every diagnostic snapshot for the open file; evicting it forces `compute_artifacts_with_metadata` recomputation on the fallback path. The pinned set must be reactive: recompute it when (a) `did_open`/`did_close` changes the open set, or (b) the dependency graph's edges change for any pinned doc (added/removed `source()` / backward directive). Closed documents *outside* every open document's neighborhood remain LRU-evictable. This eliminates the `legacy_documents` recomputation fallback at the root and removes the `max_documents` cap as a tuning knob for cross-file workloads.

- [x] **S0: Wrap `CrossFileMetadata` in `Arc`.** `content_provider::get_metadata` deep-clones a struct of `Vec`/`HashSet`/`String` fields per neighbor, per snapshot, per dependent. Mirrors the existing `Arc<ScopeArtifacts>` pattern. Touch points: `DocumentState.metadata`, `Document.metadata` (if added), `DiagnosticsSnapshot::metadata_map`, the `G: Fn(&Url) -> Option<CrossFileMetadata>` closure type in `scope_at_position_with_graph`.

- [x] **S1: Share neighborhood / artifact pre-collection across dependent revalidations.** Today, when one edit fans out to N dependents, each dependent's `run_debounced_diagnostics` builds its own `DiagnosticsSnapshot` with overlapping neighborhoods. A workspace-level cache keyed by graph revision would let dependents share most of the pre-collected data.

- [x] **S2: Move `detect_cycle` / `extract_subgraph` / `workspace_imports.clone()` out from under the read lock.** `DiagnosticsSnapshot::build` runs all of these while holding `WorldState`'s read lock. Lock-hold is now ≤0.12 ms after the eviction fix, so this is more about hygiene than perf. Could be done lazily (compute on first use, not in `build`).

- [x] **S3: Batch `mark_force_republish` over transitive dependents.** `did_change` (`backend.rs:2168`) loops over dependents and calls `mark_force_republish` per URI; each call takes write locks on `last_published_version` and `force_republish` maps. A bulk `mark_force_republish_many(&[Url])` would do one lock-acquire pair total. Microseconds today, but cleaner.

- [x] **S4: Cache `detect_cycle` result by graph edge revision.** Recomputed on every snapshot build today; result only changes when graph edges change. Bump a counter in `DependencyGraph::update_file` when edges change, and key the cache on `(uri, edge_revision)`.

- [x] **S5: Wrap `workspace_imports` / `base_exports` in `Arc`.** Same Arc-cheapness pattern as `ScopeArtifacts` — these are immutable on the diagnostic hot path so cloning them per snapshot is needless allocation.

## Notes

- All items are quantitatively in the noise floor relative to the eviction fix. They are listed in rough impact order (structural first, then estimated savings descending).
- Each item should land with TDD coverage and a `--baseline` comparison run on `edit_to_publish.rs` showing the change is at least neutral (preferably negative) in microseconds.
- Background context lives in the "Learnings" entry in `AGENTS.md` (`DocumentStoreConfig::default()` paragraph) plus the existing entries on `DiagnosticsSnapshot` lock hygiene.
