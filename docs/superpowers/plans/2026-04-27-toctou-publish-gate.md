# TOCTOU Publish-Gate Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close a TOCTOU race in `CrossFileDiagnosticsGate` by introducing a single atomic `try_consume_publish` method and migrating all production commit-path call sites to use it.

**Architecture:** Add `try_consume_publish` next to the existing `can_publish` / `record_publish` pair in `crates/raven/src/cross_file/revalidation.rs`. The new method takes both write locks together, evaluates the same predicate as `can_publish`, and on success updates `last_published_version` and consumes one force-republish marker (saturating). Three commit-path call sites in `crates/raven/src/backend.rs` migrate to the new method. The existing `can_publish` and `record_publish` remain for advisory pre-flight checks (cheap concurrent read-locked early-skip in five sites) and test fixtures, but their docs gain a one-liner warning that pairing them in production is racy.

**Tech Stack:** Rust, `std::sync::RwLock`, `tokio` (async runtime), `tower-lsp`. Tests use `std::sync::{Arc, Barrier}` and `std::sync::atomic::AtomicUsize` for thread-coordination primitives.

**Spec:** `docs/superpowers/specs/2026-04-27-toctou-publish-gate-design.md`

**Key files:**
- Modify: `crates/raven/src/cross_file/revalidation.rs` (add method, add doc warnings, add 2 unit tests)
- Modify: `crates/raven/src/backend.rs` (3 commit-path call-site migrations)

**CLAUDE.md invariants this plan must preserve:**
- Diagnostics publishing must be monotonic by document version.
- Force-republish counter: each marker permits exactly one same-version publish.
- tower-lsp `concurrency_level(1)` (orthogonal but never weakened).

---

## Task 1: Add race-reproducing test (Test B)

This is the test that **fails on the current code** (compile error: method doesn't exist) and that will fail with the wrong assertion if a future regression reverts to the racy `can_publish + record_publish` pair.

**Files:**
- Modify: `crates/raven/src/cross_file/revalidation.rs` (append to `mod tests`)

- [ ] **Step 1: Write the failing test**

Append the following inside `mod tests`, after the existing `test_gate_force_republish_counter_capped` test (around line 553) — group it with the other gate tests, before the `// CrossFileActivityState tests` comment.

```rust
    #[test]
    fn test_gate_try_consume_publish_no_excess_with_pre_marked_state() {
        // Race reproducer: with one outstanding force marker and N concurrent
        // try_consume_publish callers (no further marks), exactly ONE publish
        // must succeed. With the legacy can_publish + record_publish pair, two
        // racing callers both observe force_active = true and both proceed off
        // a single marker — this assertion would fail on that buggy code path.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};
        use std::thread;

        let gate = Arc::new(CrossFileDiagnosticsGate::new());
        let uri = test_uri("test.R");

        gate.record_publish(&uri, 1);
        gate.mark_force_republish(&uri);

        const N_THREADS: usize = 32;
        let barrier = Arc::new(Barrier::new(N_THREADS));
        let successes = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::with_capacity(N_THREADS);

        for _ in 0..N_THREADS {
            let gate = gate.clone();
            let uri = uri.clone();
            let barrier = barrier.clone();
            let successes = successes.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                if gate.try_consume_publish(&uri, 1) {
                    successes.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            successes.load(Ordering::Relaxed),
            1,
            "One marker must permit exactly one publish, even under N racing consumers"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run from the repo root:

```bash
cargo test -p raven --lib cross_file::revalidation::tests::test_gate_try_consume_publish_no_excess_with_pre_marked_state
```

Expected: compilation error like `error[E0599]: no method named 'try_consume_publish' found for ...`. This is the failing-test signal — the method doesn't exist yet.

- [ ] **Step 3: Do NOT commit yet**

The test is intentionally failing. We commit only after it passes (Task 2 below).

---

## Task 2: Implement `try_consume_publish`

**Files:**
- Modify: `crates/raven/src/cross_file/revalidation.rs` (add method to `impl CrossFileDiagnosticsGate`)

- [ ] **Step 1: Add the new method**

Insert the following method into the `impl CrossFileDiagnosticsGate` block in `crates/raven/src/cross_file/revalidation.rs`, immediately after the existing `record_publish` method (which ends around line 134):

```rust
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

Note: lock order matches the existing `record_publish` and `clear` methods (`last_published_version` before `force_republish`).

- [ ] **Step 2: Run the new test to verify it passes**

```bash
cargo test -p raven --lib cross_file::revalidation::tests::test_gate_try_consume_publish_no_excess_with_pre_marked_state
```

Expected: PASS (`test result: ok. 1 passed; 0 failed`).

- [ ] **Step 3: Run all gate tests to confirm no regression**

```bash
cargo test -p raven --lib cross_file::revalidation::tests
```

Expected: all existing gate / revalidation tests pass alongside the new one (around 30 tests total in this module).

- [ ] **Step 4: Commit**

```bash
git add crates/raven/src/cross_file/revalidation.rs
git commit -m "$(cat <<'EOF'
fix: add atomic try_consume_publish to close diagnostics-gate TOCTOU

Replaces the racy can_publish + record_publish pattern with a single
method that takes both write locks together and atomically commits the
publish decision. Includes a regression test that races N consumers on
a single pre-set force marker.
EOF
)"
```

---

## Task 3: Add contract test (Test A)

This documents the per-marker invariant under contention. It passes on the buggy code too (because marks serialize through the write lock so successes ≤ N anyway) — its purpose is regression-prevention, not race-reproduction.

**Files:**
- Modify: `crates/raven/src/cross_file/revalidation.rs` (append to `mod tests`)

- [ ] **Step 1: Add the contract test**

Insert the following immediately after `test_gate_try_consume_publish_no_excess_with_pre_marked_state`:

```rust
    #[test]
    fn test_gate_try_consume_publish_atomic_under_concurrency() {
        // Contract test: each thread marks once, then races on
        // try_consume_publish at the same version. Asserts successes == N
        // (one publish per mark). Documents the per-marker contract under
        // contention.
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};
        use std::thread;

        let gate = Arc::new(CrossFileDiagnosticsGate::new());
        let uri = test_uri("test.R");

        gate.record_publish(&uri, 1);

        const N_THREADS: usize = 32;
        let barrier = Arc::new(Barrier::new(N_THREADS));
        let successes = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::with_capacity(N_THREADS);

        for _ in 0..N_THREADS {
            let gate = gate.clone();
            let uri = uri.clone();
            let barrier = barrier.clone();
            let successes = successes.clone();
            handles.push(thread::spawn(move || {
                gate.mark_force_republish(&uri);
                barrier.wait();
                if gate.try_consume_publish(&uri, 1) {
                    successes.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        assert_eq!(
            successes.load(Ordering::Relaxed),
            N_THREADS,
            "Each of N marks should permit exactly one publish"
        );
    }
```

- [ ] **Step 2: Run the new test**

```bash
cargo test -p raven --lib cross_file::revalidation::tests::test_gate_try_consume_publish_atomic_under_concurrency
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/raven/src/cross_file/revalidation.rs
git commit -m "test: add per-marker contract test for try_consume_publish"
```

---

## Task 4: Doc warnings on the legacy methods

**Files:**
- Modify: `crates/raven/src/cross_file/revalidation.rs` (update doc comments on `can_publish` and `record_publish`)

- [ ] **Step 1: Update `can_publish` doc**

Find the existing doc comment on `can_publish` (currently at lines 97–102):

```rust
    /// Check if diagnostics can be published for this version.
    ///
    /// Force republish allows same-version republish but NEVER older versions:
    /// - Normal: publish if `version > last_published_version`
    /// - Forced (count > 0): publish if `version >= last_published_version` (same version allowed)
    /// - Never: publish if `version < last_published_version`
    pub fn can_publish(&self, uri: &Url, version: i32) -> bool {
```

Replace with:

```rust
    /// Check if diagnostics can be published for this version.
    ///
    /// Force republish allows same-version republish but NEVER older versions:
    /// - Normal: publish if `version > last_published_version`
    /// - Forced (count > 0): publish if `version >= last_published_version` (same version allowed)
    /// - Never: publish if `version < last_published_version`
    ///
    /// Production commit paths MUST use [`Self::try_consume_publish`] instead.
    /// Pairing `can_publish` with `record_publish` is racy: two concurrent
    /// same-version callers can both observe `force_active = true` and proceed
    /// off a single marker. This method is retained for cheap advisory
    /// pre-flight checks (e.g. early-skip before computing diagnostics) and
    /// for test fixtures.
    pub fn can_publish(&self, uri: &Url, version: i32) -> bool {
```

- [ ] **Step 2: Update `record_publish` doc**

Find the existing doc comment on `record_publish` (currently at lines 122–123):

```rust
    /// Record that diagnostics were published for this version. Consumes one
    /// outstanding force-republish marker (if any) for this URI.
    pub fn record_publish(&self, uri: &Url, version: i32) {
```

Replace with:

```rust
    /// Record that diagnostics were published for this version. Consumes one
    /// outstanding force-republish marker (if any) for this URI.
    ///
    /// Production commit paths MUST use [`Self::try_consume_publish`] instead.
    /// Pairing `can_publish` with `record_publish` is racy under contention.
    /// This method is retained for test fixtures.
    pub fn record_publish(&self, uri: &Url, version: i32) {
```

- [ ] **Step 3: Verify docs build**

```bash
cargo doc -p raven --no-deps --document-private-items
```

Expected: no warnings about broken intra-doc links (the `[`Self::try_consume_publish`]` references should resolve).

- [ ] **Step 4: Re-run all revalidation tests as a smoke check**

```bash
cargo test -p raven --lib cross_file::revalidation::tests
```

Expected: all tests still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/cross_file/revalidation.rs
git commit -m "docs: warn that can_publish + record_publish pairing is racy"
```

---

## Task 5: Migrate site #1 — `publish_diagnostics_for_affected`

This is the post-async commit path in the standalone helper that publishes diagnostics for cross-file-affected documents.

**Files:**
- Modify: `crates/raven/src/backend.rs` (around lines 756–781)

- [ ] **Step 1: Locate the existing block**

The block to replace is the second-freshness-check section in `publish_diagnostics_for_affected`. Search for the literal anchor:

```bash
grep -n "Second freshness check before publishing" crates/raven/src/backend.rs
```

Expected: one hit, currently around line 756.

- [ ] **Step 2: Replace the block**

Replace the existing block (from `// Second freshness check before publishing` through the closing `}` of the outer `if can_publish` arm) with the migrated version.

**Before:**

```rust
    // Second freshness check before publishing
    let can_publish = {
        let state = state_arc.read().await;
        let current_version = state.documents.get(&affected_uri).and_then(|d| d.version);
        let current_revision = state.documents.get(&affected_uri).map(|d| d.revision);

        if current_version != trigger_version || current_revision != trigger_revision {
            false
        } else if let Some(ver) = current_version {
            state.diagnostics_gate.can_publish(&affected_uri, ver)
        } else {
            true
        }
    };

    if can_publish {
        client
            .publish_diagnostics(affected_uri.clone(), diagnostics, None)
            .await;

        let state = state_arc.read().await;
        if let Some(ver) = state.documents.get(&affected_uri).and_then(|d| d.version) {
            state.diagnostics_gate.record_publish(&affected_uri, ver);
        }
        state.cross_file_revalidation.complete(&affected_uri);
    }
```

**After:**

```rust
    // Second freshness check + atomic gate commit before publishing.
    // try_consume_publish takes write locks on the gate's maps, evaluates the
    // same predicate as can_publish, and on success updates last_published
    // and consumes one force-republish marker — closing the race where
    // two same-version publishes could share one marker.
    let can_publish = {
        let state = state_arc.read().await;
        let current_version = state.documents.get(&affected_uri).and_then(|d| d.version);
        let current_revision = state.documents.get(&affected_uri).map(|d| d.revision);

        if current_version != trigger_version || current_revision != trigger_revision {
            false
        } else if let Some(ver) = current_version {
            state
                .diagnostics_gate
                .try_consume_publish(&affected_uri, ver)
        } else {
            true
        }
    };

    if can_publish {
        client
            .publish_diagnostics(affected_uri.clone(), diagnostics, None)
            .await;

        let state = state_arc.read().await;
        state.cross_file_revalidation.complete(&affected_uri);
    }
```

Note: the standalone `record_publish` block has been removed. The `cross_file_revalidation.complete(&affected_uri)` call is preserved (it's separate from gate state).

- [ ] **Step 3: Build**

```bash
cargo build -p raven
```

Expected: compiles clean.

- [ ] **Step 4: Run targeted tests**

```bash
cargo test -p raven --lib cross_file::revalidation::tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "fix: use try_consume_publish in publish_diagnostics_for_affected"
```

---

## Task 6: Migrate site #2 — WD-affected children commit loop

This is the inner publish loop for documents whose working-directory inheritance changed.

**Files:**
- Modify: `crates/raven/src/backend.rs` (around lines 2967–2989)

- [ ] **Step 1: Locate the block**

```bash
grep -n "if current_version != version || current_revision != revision" crates/raven/src/backend.rs
```

Expected: one hit, currently around line 2972.

- [ ] **Step 2: Replace the block**

Find this block (the second `can_publish` block in the WD-children handler — currently around lines 2967–2989):

**Before:**

```rust
                    let can_publish = {
                        let state = state_arc.read().await;
                        let current_version =
                            state.documents.get(&child_uri).and_then(|d| d.version);
                        let current_revision = state.documents.get(&child_uri).map(|d| d.revision);
                        if current_version != version || current_revision != revision {
                            false
                        } else if let Some(ver) = current_version {
                            state.diagnostics_gate.can_publish(&child_uri, ver)
                        } else {
                            true
                        }
                    };
                    if can_publish {
                        client
                            .publish_diagnostics(child_uri.clone(), diagnostics, None)
                            .await;

                        let state = state_arc.read().await;
                        if let Some(ver) = state.documents.get(&child_uri).and_then(|d| d.version) {
                            state.diagnostics_gate.record_publish(&child_uri, ver);
                        }
                    }
```

**After:**

```rust
                    let can_publish = {
                        let state = state_arc.read().await;
                        let current_version =
                            state.documents.get(&child_uri).and_then(|d| d.version);
                        let current_revision = state.documents.get(&child_uri).map(|d| d.revision);
                        if current_version != version || current_revision != revision {
                            false
                        } else if let Some(ver) = current_version {
                            state
                                .diagnostics_gate
                                .try_consume_publish(&child_uri, ver)
                        } else {
                            true
                        }
                    };
                    if can_publish {
                        client
                            .publish_diagnostics(child_uri.clone(), diagnostics, None)
                            .await;
                    }
```

- [ ] **Step 3: Build**

```bash
cargo build -p raven
```

Expected: compiles clean.

- [ ] **Step 4: Run cross-file tests**

```bash
cargo test -p raven --lib cross_file
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "fix: use try_consume_publish in WD-affected children publish"
```

---

## Task 7: Migrate site #3 — `Backend::publish_diagnostics`

This is the canonical `Backend::publish_diagnostics` async method.

**Files:**
- Modify: `crates/raven/src/backend.rs` (around lines 3955–3990)

- [ ] **Step 1: Locate the block**

```bash
grep -n "Re-check freshness after async work" crates/raven/src/backend.rs
```

Expected: one hit, currently around line 3955.

- [ ] **Step 2: Replace the post-async re-check + record block**

Find this block (currently around lines 3955–3990):

**Before:**

```rust
        // Re-check freshness after async work to avoid publishing stale diagnostics
        {
            let state = self.state.read().await;
            if let Some(ver) = version {
                let current_version = state.documents.get(uri).and_then(|d| d.version);
                if current_version != Some(ver) {
                    log::trace!(
                        "Skipping diagnostics for {}: version changed (was {:?}, now {:?})",
                        uri,
                        version,
                        current_version
                    );
                    return;
                }
                if !state.diagnostics_gate.can_publish(uri, ver) {
                    log::trace!(
                        "Skipping diagnostics for {}: monotonic gate after async (version={})",
                        uri,
                        ver
                    );
                    return;
                }
            }
        }

        // Record the publish (uses interior mutability, no write lock needed)
        {
            let state = self.state.read().await;
            if let Some(ver) = version {
                state.diagnostics_gate.record_publish(uri, ver);
            }
        }

        self.client
            .publish_diagnostics(uri.clone(), diagnostics, None)
            .await;
```

**After:**

```rust
        // Re-check freshness after async work, atomically commit gate state, before publishing.
        // try_consume_publish replaces the racy can_publish + record_publish pair.
        {
            let state = self.state.read().await;
            if let Some(ver) = version {
                let current_version = state.documents.get(uri).and_then(|d| d.version);
                if current_version != Some(ver) {
                    log::trace!(
                        "Skipping diagnostics for {}: version changed (was {:?}, now {:?})",
                        uri,
                        version,
                        current_version
                    );
                    return;
                }
                if !state.diagnostics_gate.try_consume_publish(uri, ver) {
                    log::trace!(
                        "Skipping diagnostics for {}: monotonic gate after async (version={})",
                        uri,
                        ver
                    );
                    return;
                }
            }
        }

        self.client
            .publish_diagnostics(uri.clone(), diagnostics, None)
            .await;
```

Note: the entire `// Record the publish` block is removed; gate-state commit is now folded into the atomic `try_consume_publish`.

- [ ] **Step 3: Build**

```bash
cargo build -p raven
```

Expected: compiles clean.

- [ ] **Step 4: Run all backend / cross-file tests**

```bash
cargo test -p raven --lib backend
cargo test -p raven --lib cross_file
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/raven/src/backend.rs
git commit -m "fix: use try_consume_publish in Backend::publish_diagnostics"
```

---

## Task 8: Verify no remaining production callers of the legacy pair

Now confirm that every `record_publish` site outside test code is gone, and that the remaining `can_publish` sites are advisory-only (no commit). This is a defensive grep, not a code change.

**Files:** none modified.

- [ ] **Step 1: Grep for `record_publish` outside `revalidation.rs` and tests**

```bash
grep -rn "record_publish" --include="*.rs" crates/raven/src
```

Expected hits (and only these):
- `crates/raven/src/cross_file/revalidation.rs` — definition site and `mod tests` setup calls
- `crates/raven/src/cross_file/property_tests.rs` — property-test setup primitives
- `crates/raven/src/backend.rs` — only in the test fixtures around lines 5629–5630 (the `world.diagnostics_gate.record_publish(&uri_a, 1)` style setup calls). No production hits.

If any production hit remains in `backend.rs` outside test fixtures, it's a missed migration — fix it now using the same shape as Tasks 5–7.

- [ ] **Step 2: Grep for `can_publish` and verify each remaining site is advisory**

```bash
grep -n "can_publish" crates/raven/src/backend.rs
```

Expected hits in production code (advisory pre-flight only — these stay as `can_publish`):
- early-skip before snapshot build (around line 702)
- early-skip in WD children loop before computing diagnostics (around line 2914)
- early-skip in `Backend::publish_diagnostics` before sync diagnostics (around line 3905)

Plus the `let can_publish = { … }` local variable bindings in Tasks 5 and 6 (the variable name was kept; what changed was the gate method called inside).

Test-fixture hits (around lines 5632, 5633, 5655, 5659) also stay.

If any remaining production `can_publish` site is followed (in the same control flow) by `client.publish_diagnostics` and `record_publish`, that's a missed commit-path migration.

- [ ] **Step 3: No commit — this task is purely verification**

---

## Task 9: Full crate test run

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

```bash
cargo test -p raven
```

Expected: all unit tests, integration tests, and property tests pass. The two new tests (`test_gate_try_consume_publish_no_excess_with_pre_marked_state`, `test_gate_try_consume_publish_atomic_under_concurrency`) appear in the output.

- [ ] **Step 2: Build release to confirm no release-only warnings**

```bash
cargo build --release -p raven
```

Expected: clean build.

- [ ] **Step 3: No commit — final sign-off**

If anything fails, fix the issue and add an additional task. Do not weaken the new tests to make them pass.

---

## Self-review notes

- **Spec coverage:** new method (Task 2), test A (Task 3), test B (Task 1), three call-site migrations (Tasks 5–7), doc updates (Task 4), invariant verification (Tasks 8–9). All "Architecture", "Migration", and "Test plan" sections of the spec map to a task.
- **No placeholders:** every code block is concrete; every command has expected output; every commit message is specified.
- **Type consistency:** the method signature `fn try_consume_publish(&self, uri: &Url, version: i32) -> bool` is identical across the spec, the implementation in Task 2, and the call sites in Tasks 5–7. Both `can_publish` and `record_publish` retain their pre-existing signatures — no rename.
- **Lock-order consistency:** Task 2's implementation acquires `last_published_version` then `force_republish`, matching the existing `record_publish` and `clear` methods.
- **Order subtlety from the spec:** Sites #1 and #2 previously committed gate state *after* `client.publish_diagnostics`; under migration they commit *before*. Acceptable per the spec's "Order subtlety" section — the per-marker contract is now precisely what we want it to be, and the new "wasted marker on cancellation" failure mode is benign (a future revalidation will re-mark).
