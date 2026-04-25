# Libpath watching and missing-package diagnostics

**Status:** Draft — awaiting user review
**Date:** 2026-04-16
**Owner:** Raven LSP

## Problem

Raven queries the R library paths (`.libPaths()`) once during backend initialization and caches package exports indefinitely. If a user installs a package after the LSP starts (`install.packages("foo")`, `renv::restore()`, `pak::pkg_install()`), Raven never notices: undefined-variable diagnostics for exported symbols persist, and the user has to restart the editor to clear them.

Separately, when `library(foo)` references a package that is not installed, Raven should make that the *primary* signal to the user rather than emitting a cascade of downstream undefined-variable diagnostics.

## Current behavior (as of 2026-04-16)

- `.libPaths()` is read once in `RSubprocess::get_lib_paths()` and stored on `PackageLibrary`.
- Package exports are loaded lazily and cached forever in `PackageLibrary.packages` / `combined_exports`.
- The missing-package diagnostic **already exists** (`collect_missing_package_diagnostics` in `handlers.rs:4516`) and emits `"Package 'foo' is not installed"` with configurable severity (default WARNING). It is gated on four conditions, all of which must be true:
  1. `cross_file_config.packages_enabled == true` (default: true)
  2. `state.package_library_ready == true` (set once initialization completes)
  3. `state.package_library.r_subprocess().is_some()` (R was found at startup)
  4. `cross_file_config.packages_missing_package_severity.is_some()` (default: WARNING)
- `PackageLibrary::invalidate(name)` and `clear_cache()` exist but are not called from any filesystem-triggered path today.
- No file-watching infrastructure exists in the crate; `notify` is not a dependency.

## Goals

1. When the contents of any directory on `.libPaths()` change (a package is installed, updated, or removed), Raven detects the change within ~1 s and:
   - invalidates the affected entries in `PackageLibrary`,
   - re-runs diagnostics on open documents whose `loaded_packages` intersect the change set.
2. A missing-package diagnostic reliably fires on `library(foo)` / `require(foo)` / `loadNamespace("foo")` when `foo` is not installed. If this does not fire today under documented conditions, we identify and fix the reason.
3. Provide an explicit fallback path the user can invoke when the watcher fails (unsupported filesystem, platform quirk, watch-limit exhaustion).

## Non-goals

- Reacting to mid-session `.libPaths()` reconfiguration driven by `.Rprofile`, `R_LIBS_USER`, or explicit `.libPaths(new=...)` calls in the user's R session. A manual refresh covers this.
- Code actions / quick fixes that run `install.packages()` on the user's behalf.
- Detecting package *updates* that change the export set but leave directory mtimes stable (rare; will usually trip a watch event anyway when `NAMESPACE` is rewritten).
- Reacting to `renv` lockfile changes as a primary signal — we watch the libpath directories themselves, which `renv::restore()` also modifies.

## Design

### Component 1: `LibpathWatcher`

New module: `crates/raven/src/libpath_watcher.rs`.

Owns a `notify::RecommendedWatcher` and a background tokio task. On construction:

1. Take a list of libpath directories and a `mpsc::Sender<LibpathEvent>`.
2. Register each directory with `RecursiveMode::Recursive`. The pre-implementation draft used `NonRecursive`, but in-place upgrades (`install.packages("pkg")` on an already-installed `pkg`) rewrite files inside `<libpath>/pkg/` without changing the libpath's listing, so non-recursive watches miss the events entirely. Recursive watches attach one watch per descendant directory (≈10–20 per package on inotify), which is acceptable given libpath sizes; users on hosts with the legacy `fs.inotify.max_user_watches = 8192` may need to raise it for very large CRAN snapshots.
3. Events from `notify` are forwarded into an internal channel, debounced for 500 ms (configurable), then aggregated into a single `LibpathEvent { added: HashSet<String>, removed: HashSet<String>, touched: HashSet<String> }`. `added`/`removed` come from diffing the post-debounce directory listing against a cached listing; `touched` is derived from the drained `notify` paths during the debounce window so in-place upgrades produce a `Changed` event even when the package set is unchanged.

```rust
pub enum LibpathEvent {
    /// One or more libpath directories changed. Contains the delta vs. the last snapshot.
    Changed {
        added: HashSet<String>,    // new package names
        removed: HashSet<String>,  // package directories that disappeared
        touched: HashSet<String>,  // existing package directories with modified contents
    },
    /// Watcher attach failed or dropped events (e.g. inotify limit); caller should fall back to a full refresh.
    Dropped,
}
```

The watcher does **not** invalidate the cache directly — it only reports deltas. Cache and diagnostic logic stays in `PackageLibrary` / `Backend` so the watcher can be unit-tested against a channel.

**Failure modes:** if `notify` fails to attach to any libpath directory (permissions, missing dir, watch-descriptor limit on Linux), the watcher logs a warning, emits `LibpathEvent::Dropped` once, and exits cleanly. The backend continues functioning; the user can use the manual refresh command.

### Component 2: `PackageLibrary` cache invalidation

Add to `PackageLibrary`:

```rust
pub async fn invalidate_many(&self, names: &HashSet<String>);  // batch version of invalidate
pub async fn cached_package_names(&self) -> HashSet<String>;   // snapshot of what's currently cached
```

When the backend receives a `LibpathEvent::Changed`:

1. Combine `added ∪ removed ∪ touched` into one set.
2. Call `invalidate_many` on the per-package cache.
3. Also invalidate entries in `combined_exports` whose key is in the set — and invalidate any `combined_exports` entry whose `attached_packages` contain any affected name (meta-packages like `tidyverse`).
4. If `added` is non-empty, schedule a best-effort `prefetch_packages` for the new names so the next diagnostic pass is warm.

On `LibpathEvent::Dropped`, call `clear_cache()` and re-initialize libpaths (re-query `.libPaths()` via the R subprocess).

### Component 3: Backend lifecycle wiring

In `backend.rs`:

1. After successful `PackageLibrary` init (around `backend.rs:1075`), spawn a `LibpathWatcher` over the list of paths the library was just initialized with.
2. Spawn a consumer task that owns the `mpsc::Receiver<LibpathEvent>`. On each event it:
   - mutates `PackageLibrary` per Component 2,
   - builds the set of open document URIs whose `Document.loaded_packages` intersect the affected names,
   - schedules diagnostics revalidation for each of those URIs through the existing `CrossFileRevalidationState::schedule()` mechanism so we use the project's standard debounce and cancellation paths.
3. On settings change (`backend.rs:2403`), if libpaths changed, tear down the old watcher and spawn a new one.
4. On shutdown, the watcher's task is aborted cleanly; the `Drop` impl on `RecommendedWatcher` unregisters inotify/FSEvents handles.

### Component 4: Manual refresh command

Register a new LSP command `raven.refreshPackages`:

- Clears the package cache.
- Re-queries `.libPaths()`.
- Re-runs `prefetch_packages` for all packages referenced by open documents.
- Triggers revalidation for all open documents.

Expose from the VS Code extension as a command-palette entry: **"Raven: Refresh package cache"**. This is the escape hatch when automatic watching fails or when the user made changes the watcher can't see (e.g. flipped `R_LIBS_USER` in their shell).

### Component 5: Verifying and, if needed, fixing the missing-package diagnostic

The diagnostic at `handlers.rs:4516` already covers part (b) of the original request. Before shipping, we will:

1. Write an integration test that opens a document containing `library(foo)` where `foo` is not installed in the test R environment, and asserts the diagnostic fires with the configured severity.
2. Verify the four gating conditions are all satisfied in the default user configuration and document them in `docs/packages.md`.
3. If the user's current installation is not emitting the diagnostic, identify which gate is blocking (likely: `package_library_ready` is stuck false, or `r_subprocess()` is None because R wasn't found on PATH), and either fix the gate or surface a diagnostic that explains the blocker to the user.

### Configuration

Two new settings, both forwarded through all three extension layers (`package.json`, `extension.ts`, `settings.test.ts`) per the CLAUDE.md invariant:

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages.watchLibraryPaths` | boolean | `true` | Watch R library paths for package install/remove events. |
| `packages.watchDebounceMs` | integer | `500` | Debounce interval for aggregating libpath events. Clamped to `[100, 5000]`. |

## Data flow

```text
install.packages("foo")
  → filesystem change under libpath/
  → notify → LibpathWatcher debounce (500ms)
  → diff directory listing vs. snapshot
  → mpsc send LibpathEvent::Changed { added: {"foo"}, ... }
  → Backend consumer task:
      - PackageLibrary::invalidate_many(&{"foo"})
      - invalidate combined_exports entries touching "foo"
      - prefetch_packages(&["foo"])
      - for each open doc with "foo" in loaded_packages:
          CrossFileRevalidationState::schedule(uri)
  → diagnostic pass re-runs, missing-package diagnostic on library(foo) clears
```

## Error handling

- **Watcher attach failure**: log warn, emit `Dropped`, leave cache as-is, rely on manual refresh. No panic.
- **Debounce channel disconnect**: treat as shutdown, exit task cleanly.
- **R subprocess unavailable**: the whole feature path no-ops gracefully because the existing gates at `collect_missing_package_diagnostics` already require `r_subprocess().is_some()`. The watcher still runs and invalidates caches, but static exports from NAMESPACE parsing continue to work.
- **Libpath directory disappears mid-session** (e.g. renv switches projects and old libpath is gone): watcher emits `Dropped`; manual refresh picks up the new paths on next settings change or `raven.refreshPackages`.
- **Massive install (1000+ packages)**: debounce + directory-diff collapses this into a single `Changed` event, so we do one batch invalidation rather than 1000 individual ones.

## Testing

Unit tests:
- `LibpathWatcher` with a tempdir: create/remove package subdirectories, assert the expected `LibpathEvent` arrives within debounce+slack.
- `PackageLibrary::invalidate_many` + meta-package invalidation (`tidyverse` entry cleared when `dplyr` is invalidated).
- Debounce bounds: events within the window collapse to one; events across the boundary produce two.

Integration tests (`crates/raven/tests/`):
- Open a document referencing `library(foo); foo_fn()` where `foo` is not installed → assert missing-package diagnostic fires.
- Same setup, then `touch $libpath/foo/DESCRIPTION` (simulating install) → assert diagnostic clears within 2 s.
- Watcher teardown on settings change: change `packages.watchLibraryPaths` from true → false → true and verify the new watcher sees subsequent events.

Non-goals for testing:
- We do not run real `install.packages()` in CI. Tests simulate installs by creating the directory layout that `install.packages` would produce (`foo/DESCRIPTION`, `foo/NAMESPACE`).

## Open questions

- Should `packages.watchLibraryPaths = false` also disable the manual `raven.refreshPackages` command? Proposal: no — the command remains available as an escape hatch regardless.
- Should we diff on directory listings only (cheap), or also stat `DESCRIPTION`/`NAMESPACE` mtimes to detect in-place updates? Proposal: directory listing only for v1 — package updates typically recreate the directory or at least rewrite `DESCRIPTION`, which triggers a notify event anyway.

## Build order

1. `libpath_watcher.rs` module + unit tests against tempdir.
2. `PackageLibrary::invalidate_many` + meta-package invalidation tests.
3. Backend wiring: spawn watcher post-init, consumer task, shutdown path.
4. Manual refresh command + VS Code command registration.
5. Config plumbing through all three extension layers.
6. Integration tests for end-to-end invalidation.
7. Diagnostic verification pass: new test for `library(foo)` missing-package, doc update in `docs/packages.md`.
