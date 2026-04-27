# Fix TOCTOU race in `CrossFileDiagnosticsGate`

**Date:** 2026-04-27
**Status:** Design approved; ready for implementation plan
**Files:** `crates/raven/src/cross_file/revalidation.rs`, `crates/raven/src/backend.rs`

## Problem

`CrossFileDiagnosticsGate::can_publish` and `CrossFileDiagnosticsGate::record_publish` each take their own short-lived locks. With the force-republish counter at 1, two concurrent publishes for the same URI can both observe `force_active = true` inside `can_publish` and both proceed; each then calls `record_publish` whose saturating decrement leaves the counter at 0. One marker has permitted two same-version publishes.

The practical impact is benign — an extra redundant `client.publish_diagnostics` call. The bug is worth fixing because the per-marker guarantee is what justifies the counter's existence over the prior `HashSet` representation; weakening it under contention leaves the gate's contract relying on luck.

## Solution

Add a single atomic method that combines the gate predicate with the commit step under one critical section. Migrate the three production commit-path call sites to it. Leave `can_publish` and `record_publish` in place for advisory pre-flight checks and test fixtures, with a doc-comment warning that pairing them in production is racy.

## Architecture

### New API

```rust
impl CrossFileDiagnosticsGate {
    /// Atomically check the publish gate and, if it would allow the publish,
    /// commit it: update `last_published_version` to `version` and consume
    /// one outstanding force-republish marker (saturating).
    ///
    /// Returns `true` iff the caller should proceed to publish. Production
    /// commit paths MUST use this method, not the
    /// `can_publish` / `record_publish` pair, to avoid a TOCTOU race where
    /// two concurrent same-version publishes each observe
    /// `force_active = true` and both proceed off a single marker.
    ///
    /// Predicate matches `can_publish`:
    ///   - if `version < last_published`: false (never publish older)
    ///   - if force counter > 0: `version >= last_published` (same OK)
    ///   - else: `version > last_published` (strictly newer)
    pub fn try_consume_publish(&self, uri: &Url, version: i32) -> bool;
}
```

Implementation:

```rust
pub fn try_consume_publish(&self, uri: &Url, version: i32) -> bool {
    let mut last_published = self.last_published_version.write().unwrap();
    let mut force = self.force_republish.write().unwrap();

    let allowed = match last_published.get(uri) {
        Some(&last) => {
            if version < last {
                false
            } else if force.get(uri).copied().unwrap_or(0) > 0 {
                version >= last
            } else {
                version > last
            }
        }
        None => true,
    };

    if !allowed {
        return false;
    }

    last_published.insert(uri.clone(), version);
    if let Some(count) = force.get_mut(uri) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            force.remove(uri);
        }
    }
    true
}
```

Both write locks are taken in the same order as the existing `record_publish` and `clear` methods (`last_published_version` before `force_republish`) to maintain consistency and avoid deadlocks.

### Existing API changes

- `can_publish` and `record_publish` retain their signatures and semantics.
- Both gain a one-line doc note: *"For production commit paths, use `try_consume_publish` — calling these as a pair is racy under contention."*
- No deprecation attribute, to avoid noise in property-test usage.

## Migration

Three production commit-path call sites in `backend.rs` migrate. Five advisory `can_publish`-only sites and all test fixtures stay unchanged.

### Migrated to `try_consume_publish`

| Site | Function | Notes |
|---|---|---|
| `backend.rs:765` + `backend.rs:778` | `publish_diagnostics_for_affected` post-async commit | Replace inner `can_publish` (line 765) with `try_consume_publish`; delete standalone `record_publish` (line 778). The version + revision freshness check guarding the call stays unchanged. |
| `backend.rs:2975` + `backend.rs:2987` | WD-affected children commit loop | Same shape as above. |
| `backend.rs:3969` + `backend.rs:3984` | `Backend::publish_diagnostics` | Same shape. The post-async re-check becomes the atomic commit. |

**Order subtlety:** `try_consume_publish` commits state (updates `last_published_version`, consumes the marker) **before** the `client.publish_diagnostics` call returns. If the publish fails or the task is cancelled mid-publish, the marker has already been consumed. This matches the existing risk window between `can_publish → publish → record_publish` — no regression.

### Unchanged (advisory pre-flight, no commit)

- `backend.rs:702` — early skip before snapshot build
- `backend.rs:2914-2916` — early skip in WD children loop before computing diagnostics
- `backend.rs:3905` — early skip before sync-diagnostics computation

These advisory checks take cheap concurrent read locks. They exist to bail out before expensive scope resolution when the gate is already going to refuse. A racy `can_publish` here is benign: at worst we compute diagnostics that `try_consume_publish` then refuses (no extra publish, just wasted work).

### Unchanged (test/property-test fixtures)

- `cross_file/property_tests.rs` — `record_publish` / `can_publish` used as setup primitives that exercise the gate's predicate semantics directly.
- `backend.rs:5629-5659` — test fixtures.
- `revalidation.rs` `mod tests` — existing gate tests (including `test_gate_clear_resets_state` and the rest of the pre-existing `test_gate_*` suite). Test A and Test B below are added alongside them.

## Test plan

All existing tests pass unchanged.

### New tests in `revalidation.rs` `mod tests`

**Test A — Contract test under contention.** `N` threads each `mark_force_republish` then `try_consume_publish` at the same version. Asserts successes equal `N`. Documents the per-marker contract under concurrency. Passes on the buggy code (marks serialize through the write lock so successes ≤ N anyway), so this is regression-prevention rather than race-reproduction.

**Test B — Race reproducer.** Pre-mark once (force = 1), then `N` threads race only on `try_consume_publish` — no concurrent marks. Asserts successes = 1. With the original `can_publish → record_publish` pair, multiple threads observe `force_active = true` simultaneously and all proceed → assertion fails (typically successes ≥ 2). With `try_consume_publish` taking write locks atomically, exactly one wins.

Both tests use `std::sync::{Arc, Barrier}` and `std::sync::atomic::AtomicUsize` to align thread starts for maximum contention.

### Verification

`cargo test -p raven` — runs all unit and property tests in the crate.

## Invariants preserved (CLAUDE.md)

- **Monotonic diagnostics publishing.** `try_consume_publish` uses the same predicate as `can_publish`; strictly older versions are still rejected.
- **Force-republish per-marker guarantee.** Atomic check + decrement under a single write-lock pair closes the race; each marker permits exactly one same-version publish.
- **tower-lsp `concurrency_level(1)`.** Orthogonal — request ordering is unchanged.
- **LRU `peek`/`push` discipline.** Not applicable to this gate (no LRU).

## Out of scope

- Renaming `record_publish` to `seed_published_for_test` or similar.
- Replacing `can_publish` with a separate `would_publish` advisory method.
- Eliminating the post-`try_consume_publish` failure window (would require integrating the actual `client.publish_diagnostics` call inside the gate, which changes the architecture significantly).
