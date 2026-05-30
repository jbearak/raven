# Extract a shared `build_package_library` helper (kill editor/CI drift)

**Date:** 2026-05-29
**Status:** Design proposed (incorporates a Codex review); pending user review before implementation plan
**Files:** `crates/raven/src/package_library.rs`, `crates/raven/src/backend.rs`, `crates/raven/src/cli/check.rs`, `docs/cli.md`

## Problem

The "build a `PackageLibrary` from current configuration" sequence is hand-reproduced in **four** places. They were written separately and have already drifted:

| # | Site | Lock model | Readiness vs `add_library_paths` | R discovery | Surfacing |
|---|---|---|---|---|---|
| 1 | `backend.rs::rebuild_package_library` (~6715) | `&Arc<RwLock<WorldState>>`, snapshot-then-drop | **after** | `spawn_blocking` | `log::warn!` |
| 2 | `cli/check.rs::maybe_init_r` (~362) | `&mut WorldState` (owned) | **after** | `spawn_blocking` | 3 `eprintln!` notes |
| 3 | `backend.rs::ensure_package_library_initialized` (~1159) | snapshot + write-lock race re-check | **before** ⚠️ | direct on async executor ⚠️ | `log::warn!` |
| 4 | `backend.rs` Task B post-scan init (~2324) | snapshot, write-lock apply | **before** ⚠️ | `spawn_blocking` | `log::info!` counts + perf |

The two startup paths (#3, #4) compute `package_library_ready` from `lib_paths()` **before** `add_library_paths` runs, while the canonical builder (#1) and the CLI (#2) compute it **after**. In the case "R yields no paths, but `additionalLibraryPaths` is valid," #1/#2 mark the library *ready* while #3/#4 mark it *not-ready*. This divergence is not test-pinned. It is the same class of bug `raven check` was created to prevent (CI diagnostics must match the editor's), which itself already drifted once when `maybe_init_r` shipped without the `packages.enabled` gate (fixed in the prior session; see the working-tree diff to `check.rs`).

This is a **refactor, not a bug fix**: present per-site behavior is what it is, and the convergence is designed to be observably behavior-neutral on supported platforms (see "Phase 2" and "Two findings" below). The goal is to remove the structural cause of this drift class.

### Two findings that shape the design

1. **`PackageLibrary::initialize()` never returns `Err`.** It has a single `Ok(())` return (`package_library.rs:1074`) and swallows every R failure with `log::trace!` + a fallback. So the `InitFailed` branch is dead in all four sites today. We keep the variant for the CLI's three-note contract and because `initialize()`'s signature is fallible, but we do not write tests or caller logic implying it is reachable via the real pipeline.

2. **`get_fallback_lib_paths()` is unconditionally non-empty on macOS/Linux/Windows** (hardcoded framework/system/Homebrew pushes, `r_subprocess.rs:1189-1248`). `initialize()` falls back to it whenever R reports nothing (`package_library.rs:943-945`, `1095-1098`). Consequence: post-`initialize()`, `lib_paths()` is **always non-empty** on supported platforms. Therefore `RNotFound` / `NoLibraryPaths`, the CLI's R-degradation `eprintln!` notes, **and the phase-2 before/after readiness difference are all unreachable end-to-end** on dev/CI machines (they require an exotic target where the cfg fallback is empty). This is why the readiness predicate is pinned by a pure, platform-independent classifier rather than by end-to-end tests, and why phase 2 is a no-op on supported platforms.

## Decisions

Three open decisions from the handoff, resolved.

### 1. Scope — full structure, two-phase

Route all four sites through one helper, split into:

- **Phase 1 (pure refactor):** converge sites #1 and #2 (already matching). Zero behavior change.
- **Phase 2 (explicit, separately reviewable change):** migrate sites #3 and #4. Standardizes readiness on the canonical "after `add_library_paths`" timing and moves #3's R discovery into `spawn_blocking`. On supported platforms this is observably a no-op (finding #2); the convergence is what closes the drift.

### 2. Outcome type — struct `{ library, status }` with a status enum

```rust
/// Outcome of [`build_package_library`]: the constructed library plus a single
/// status that is the sole source of truth for readiness and the degradation
/// reason. Encoding state as one enum (not a `(lib, bool)` pair + a separate
/// reason) makes the illegal "ready, but with a degradation reason" state
/// unrepresentable — the drift this helper exists to prevent.
pub struct PackageLibraryOutcome {
    /// Always present. `new_empty()` for `Disabled`. NOTE: a non-`Ready`
    /// library may still carry useful offline data (base symbols, configured
    /// additional paths), so "install it anyway" vs "discard it" is a *caller
    /// policy*, not implied by the status — see the caller table below.
    pub library: Arc<PackageLibrary>,
    pub status: PackageLibraryStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PackageLibraryStatus {
    Disabled,            // packages.enabled == false; no R discovery attempted
    Ready,               // initialized with >= 1 library path — the only ready state
    RNotFound,           // no R subprocess located (incl. spawn_blocking join failure)
    InitFailed(String),  // initialize() errored — currently unreachable (finding #1)
    NoLibraryPaths,      // R found, init ok, but zero lib paths discovered/configured
}
```

Rationale (researched): the `(lib, bool)` + separate-reason option is the desyncable "boolean flags are bugs in disguise" anti-pattern; a single enum makes illegal states unrepresentable (Minsky's principle). A struct wrapping a *common* `library` field + a status enum is preferred over a fat enum that repeats `Arc<PackageLibrary>` in every variant, because the library is genuinely common to every outcome and the LSP callers consume it uniformly — repeating it per-variant would only add destructuring boilerplate. The *state* is still one enum, satisfying the principle. Sources: [rafaelfernandez.dev](https://blog.rafaelfernandez.dev/posts/making-invalid-states-unrepresentable-1-boolean-flags/), [corrode — enums](https://corrode.dev/blog/enums/), [corrode — illegal state](https://corrode.dev/blog/illegal-state/).

### 3. Helper home — `package_library.rs`

Idiomatic Rust co-locates construction logic with the type it builds ([Rustonomicon — constructors](https://doc.rust-lang.org/nomicon/constructors.html)). The helper takes owned/cloned inputs and no `WorldState`, so it stays lock-free and adds no `WorldState`/`Client`/logging/perf dependency to the module — keeping the model type from becoming a backend module, and stopping the CLI reaching deeper into `backend`.

### 4. Adjacent disabled-gates — remove the redundant one, keep the load-bearing one

Two *callers* of `rebuild_package_library` hold `packages_enabled` semantics in a second place. They look alike but need opposite treatment:

- **`backend.rs:5719` (settings reload) — remove the redundant branch.** It is `if packages_enabled { rebuild } else { (new_empty, false) }`, and it *always* swaps the result into `state`. Since `rebuild_package_library` already self-gates (`backend.rs:6734`) and returns exactly `(new_empty, false)` when disabled, the `else` branch is pure duplication of the disabled→empty decision — the very drift surface this refactor targets. DRY / single-source-of-truth says collapse it to an unconditional `let (lib, ready) = rebuild_package_library(&self.state).await;`. Behavior-neutral (when disabled, the helper returns `new_empty`/`false` either way; the only difference is one extra brief read-lock acquisition and no R discovery, exactly as before). `packages_enabled` stays captured for the later prefetch guard at `backend.rs:5754`.

- **`backend.rs:2476` (`raven.refreshPackages`) — keep it; it is load-bearing.** When disabled, the swap is *inside* the `if`, so the existing library is left in place. Removing the gate would route through the helper and swap in `new_empty`, **clobbering** the user's current library on a refresh issued while packages are disabled. Leave it unchanged and add a one-line comment explaining the gate guards against that clobber, so it isn't "tidied" away later.

Best-practice basis: DRY for the redundant gate ([replace-nested-conditional-with-guard-clauses](https://refactoring.guru/replace-nested-conditional-with-guard-clauses)); isolate the cleanup in its own commit to keep the extraction reviewable ([focused / "campsite" PRs](https://blog.thepete.net/blog/2019/05/10/6-practices-for-effective-pull-requests/)).

## Architecture

### The helper (`package_library.rs`)

```rust
pub async fn build_package_library(
    r_path: Option<PathBuf>,
    additional_paths: &[PathBuf],
    workspace_root: Option<PathBuf>,
    packages_enabled: bool,
) -> PackageLibraryOutcome {
    if !packages_enabled {
        return PackageLibraryOutcome {
            library: Arc::new(PackageLibrary::new_empty()),
            status: PackageLibraryStatus::Disabled,
        };
    }

    // R discovery does synchronous IO (which/where, R --version); keep it off
    // the async runtime. A spawn_blocking join failure collapses to `None`,
    // i.e. "R not found" — matching the existing builders' `.unwrap_or(None)`
    // (backend.rs:6749, 2335). It is NOT mapped to InitFailed.
    let subprocess = tokio::task::spawn_blocking(move || {
        match (RSubprocess::new(r_path), workspace_root) {
            (Some(sub), Some(root)) => Some(sub.with_working_dir(root)),
            (sub, _) => sub,
        }
    })
    .await
    .unwrap_or(None);

    let r_found = subprocess.is_some();
    let mut lib = PackageLibrary::with_subprocess(subprocess);
    let init_error = lib.initialize().await.err().map(|e| e.to_string());
    // Augment, never clobber: additional paths apply AFTER discovery so the
    // readiness check below counts them too.
    lib.add_library_paths(additional_paths);
    let has_lib_paths = !lib.lib_paths().is_empty();

    let status = PackageLibraryStatus::classify(init_error, r_found, has_lib_paths);
    PackageLibraryOutcome { library: Arc::new(lib), status }
}
```

The helper **never logs or prints**; each caller surfaces the status its own way.

### The pure classifier (single source of truth for the predicate)

The readiness predicate + degradation precedence are extracted into a pure function so they can be table-tested deterministically and platform-independently (finding #2 makes end-to-end testing of the interesting branches impossible). The error payload lives *outside* the boolean truth table by passing `Option<String>` (resolving the "InitFailed payload vs exhaustive table fight"):

```rust
impl PackageLibraryStatus {
    /// Only `Ready` is ready.
    pub fn is_ready(&self) -> bool { matches!(self, Self::Ready) }

    /// Classify an *enabled* build. `init_error == None` means initialize()
    /// succeeded. Precedence mirrors the CLI's current order exactly
    /// (Ready -> RNotFound -> InitFailed -> NoLibraryPaths), so phase 1 is
    /// behavior-identical. `Disabled` is set by the gate before this is called.
    fn classify(
        init_error: Option<String>,
        r_found: bool,
        has_lib_paths: bool,
    ) -> Self {
        if init_error.is_none() && has_lib_paths {
            Self::Ready
        } else if !r_found {
            Self::RNotFound
        } else if let Some(err) = init_error {
            Self::InitFailed(err)
        } else {
            Self::NoLibraryPaths
        }
    }
}
```

Full truth table (8 rows), which the test pins exactly:

| `init_error` | `r_found` | `has_lib_paths` | → status |
|---|---|---|---|
| None | T | T | Ready |
| None | T | F | NoLibraryPaths |
| None | F | T | Ready *(R absent but fallback/additional paths present — matches CLI)* |
| None | F | F | RNotFound |
| Some | T | T | InitFailed *(dead today; logic only)* |
| Some | T | F | InitFailed *(dead today; logic only)* |
| Some | F | T | RNotFound *(R-absent precedes init error — matches CLI)* |
| Some | F | F | RNotFound |

### Caller policy table

The `library` field is common to all outcomes, but callers differ on whether to install a non-`Ready` library. This divergence is intentional and must be preserved exactly:

| Caller | On `Disabled` | On other non-`Ready` | On `Ready` | Surfacing |
|---|---|---|---|---|
| #1 `rebuild_package_library` | returns `(library, false)` | returns `(library, false)` — **installs the built library** | `(library, true)` | `log::warn!` iff `InitFailed` |
| #2 `maybe_init_r` (CLI) | keep pre-existing default; silent | **keep default**; `ready` stays false; print the matching R-degradation note | swap `library` in; `ready = true` | 3 `eprintln!` notes (R-degradation only) |
| #3 `ensure_package_library_initialized` | (unreached: gated by early `!enabled` return) | install `library` under race-rechecked write lock; `ready = is_ready()` | same | `log::trace!` "on demand"; `log::warn!` iff `InitFailed` |
| #4 Task B startup | install `new_empty`; `ready=false`; `log::info!` "disabled" | install `library` (race-rechecked); `ready = is_ready()` | same | `log::info!` counts; perf; `log::warn!` iff `InitFailed` |

## Migration

### Phase 1 — pure refactor (no behavior change)

**#1 `rebuild_package_library`** keeps its snapshot-under-read-lock-then-drop block (locking discipline), then:

```rust
let outcome = crate::package_library::build_package_library(
    packages_r_path, &additional_paths, workspace_root, packages_enabled,
).await;
if let PackageLibraryStatus::InitFailed(e) = &outcome.status {
    log::warn!("rebuild_package_library: initialize failed: {e}");
}
(outcome.library, outcome.status.is_ready())
```

**#2 `maybe_init_r`** snapshots its inputs from `&mut state` into locals *before* the call (avoids the borrow conflict with the later `state` mutation), then matches:

```rust
let r_path = state.cross_file_config.packages_r_path.clone();
let additional = state.cross_file_config.packages_additional_library_paths.clone();
let enabled = state.cross_file_config.packages_enabled;
let outcome = crate::package_library::build_package_library(
    r_path, &additional, Some(root.to_path_buf()), enabled,
).await;
use crate::package_library::PackageLibraryStatus::*;
match outcome.status {
    Ready => { state.package_library = outcome.library; state.package_library_ready = true; }
    Disabled => {}                       // keep default, silent — matches current early return
    RNotFound => eprintln!("raven check: R not found on PATH; package and base-symbol diagnostics will be limited"),
    InitFailed(e) => eprintln!("raven check: R found but its package library failed to initialize ({e}); package and base-symbol diagnostics will be limited"),
    NoLibraryPaths => eprintln!("raven check: R found but no library paths were discovered; package and base-symbol diagnostics will be limited"),
}
```

This preserves: the disabled-gate-before-R-discovery, the three notes verbatim, "keep default on non-Ready," and the readiness predicate.

### Phase 2 — explicit, separately reviewable change

**#3 `ensure_package_library_initialized`**: keep the `!enabled` early-return and the `already_ready` short-circuit (the helper doesn't know about either), keep the `log::trace!`, then call `build_package_library(..., packages_enabled = true)`. **Keep the write-lock race re-check** (`backend.rs:1205-1212`) that avoids overwriting a library a competing path already installed — the helper must not absorb this stateful policy. Re-emit `log::warn!` on `InitFailed`.

**#4 Task B post-scan init**: replace the inline `if packages_enabled { build } else { new_empty }` block (`backend.rs:2320-2369`) with the helper. **Keep perf metrics** (`record_package_init`, `backend.rs:2321/2351/2353`), the count `log::info!`, and the "disabled" `log::info!` (matched off `Disabled`) **outside** the helper. Keep the "apply only if not already ready" race re-check (`backend.rs:2376-2386`).

Two intended changes fall out, both behavior-neutral on supported platforms (finding #2):

1. Readiness now computed **after** `add_library_paths` in both (was before). Observable only where the platform fallback is empty *and* `additionalLibraryPaths` is set: there, the library flips `not-ready → ready`, matching the canonical builder, and the libpath watcher (`restart_libpath_watcher`, gated on `package_library_ready`) may then watch those configured paths.
2. #3's R discovery moves into `spawn_blocking` (was a direct synchronous `RSubprocess::new` on the async executor in the `did_open` path, `backend.rs:1191`) — a latent fix aligning it with #1/#4.

## Test plan

The interesting predicate branches are unreachable end-to-end on supported platforms (finding #2), so the predicate is pinned by the pure classifier, and the anti-drift guarantee is "all four sites route through one helper" (verified by code, not by four parallel end-to-end tests).

### Stay green (regression net)
- `cli/check.rs::maybe_init_r_honors_additional_library_paths`
- `cli/check.rs::maybe_init_r_skips_when_packages_disabled`
- `backend.rs` `rebuild_package_library` disabled-path test (`backend.rs:9283`)

### New — `package_library.rs` `mod tests`
- **`classify` truth table:** all 8 rows above, asserted exactly. This is the deterministic, platform-independent pin for the readiness predicate and precedence. The `Some(_)` rows test classification *logic* only (finding #1 — not reachable via `initialize()`).
- **`build_package_library` disabled:** `packages_enabled = false` → `status == Disabled`, `library.lib_paths()` empty, `!is_ready()`. R-independent.
- **`build_package_library` honors additional paths:** with `packages_enabled = true` and a **real temp dir** in `additional_paths`, that path appears in `outcome.library.lib_paths()`. Uses a temp dir (not a bogus path) because `add_library_paths` appends without existence checks (`package_library.rs:721`), so the test reflects the "valid additional path" intent.

### Adjacent disabled-gate cleanup (its own commit — see Decision 4)
- **`backend.rs:5719` removal:** add a regression test that a settings reload with `packages_enabled == false` yields `package_library` empty and `package_library_ready == false` (locking in that the now-unconditional `rebuild_package_library` call preserves the disabled outcome). Confirm the existing settings-reload tests stay green.
- **`backend.rs:2476` (kept):** verify (assert if not already covered) that `refreshPackages` while disabled does **not** clear an already-populated library — the behavior the load-bearing gate protects.

### Verification commands (run from the worktree, NOT the main checkout)
```
cargo test -p raven --lib package_library::   # helper + classify tests
cargo test -p raven --lib cli::               # CLI module
cargo test -p raven --lib maybe_init_r        # gate/additional-paths tests
cargo test -p raven --lib rebuild_package     # backend builder tests
```

## Commit / PR strategy

Separate commits, **one PR**. Ordered so each commit builds and tests green on its own:

1. **Precondition.** Commit the prior session's existing working-tree changes (the `packages.enabled` gate in `maybe_init_r`, the `should_skip_directory` test relocation, the `docs/cli.md` wording) — the refactor edits the same code, so preserve them first (per the handoff).
2. **Phase 1 — extract + converge the two matching sites.** Add `build_package_library`, `PackageLibraryOutcome`, `PackageLibraryStatus`, `is_ready`, `classify`, and the helper/`classify` tests in `package_library.rs`; route `rebuild_package_library` (#1) and `maybe_init_r` (#2) through it; update the CLI doc comment + `docs/cli.md` wording. Pure refactor.
3. **Phase 2 — converge the two startup sites.** Route `ensure_package_library_initialized` (#3) and Task B (#4) through the helper, preserving each site's surrounding context; add the phase-2 notes. Explicit (no-op on supported platforms) behavior change.
4. **Cleanup — adjacent gate (Decision 4).** Remove the redundant `packages_enabled` branch at `backend.rs:5719` + regression test; add the load-bearing comment at `backend.rs:2476`.

TDD applies within each commit (helper `classify` tests are RED before the helper exists, etc.).

## Documentation updates
- `cli/check.rs:342-361` doc comment: point at the shared `build_package_library` / status rules, not at `backend::rebuild_package_library`, so maintainers don't reintroduce backend↔CLI coupling by hand. Tighten the "degradation paths" wording: there are **three R-related** `eprintln!` notes; `Disabled` is a degradation path that prints **nothing**.
- A doc comment on `build_package_library` / `PackageLibraryStatus` stating it is the single source of the readiness predicate and that all four sites route through it.
- `docs/cli.md` "R and packages": no functional change, but verify wording still matches after the doc-comment tightening.

## Invariants preserved (CLAUDE.md)
- **Locking discipline.** The helper is lock-free (owned/cloned inputs, no `WorldState`). Phase-1 wrappers snapshot all config and drop the read guard before the `spawn_blocking` + `initialize().await`; phase-2 sites keep their existing snapshot-then-build structure. No lock is held across R discovery / `await` / cross-file work.
- **Readiness predicate.** `Ready` still requires non-empty `lib_paths()`, so a half-initialized library never reads as ready and never emits false-positive missing-package diagnostics. Centralized in `classify`.
- **`add_library_paths` ordering.** Runs *after* R discovery in the helper, so configured paths augment (never suppress) R-reported paths — now uniform across all four sites.

## Out of scope
- Removing the now-provably-dead `InitFailed` path (and collapsing the CLI from three R-notes to two).
- Reworking the `did_open` race re-check in `ensure_package_library_initialized`.
- Any change to `initialize()`'s fallback behavior or to `get_fallback_lib_paths()` (incl. the quirk that R-absent still yields fallback paths on supported platforms).
- Changing `backend.rs:2476`'s behavior (its `packages_enabled` gate is load-bearing — see Decision 4 — so it stays; only a clarifying comment is added). The `backend.rs:5719` redundant branch **is** removed, but as its own isolated commit, not folded into the extraction.
