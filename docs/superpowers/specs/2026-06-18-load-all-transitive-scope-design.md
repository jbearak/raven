# Transitive `load_all()` scope: across `source()` and from `.Rprofile`

**Date:** 2026-06-18
**Status:** Design — approved, pending spec review

## Problem

`devtools::load_all()` / `pkgload::load_all()` attaches a package's namespace to
the search path for the rest of the R session. After it runs, *all* subsequently
executed code — including files pulled in via `source()` and scripts started from
`.Rprofile` — sees the package's internal symbols. raven does not model this:

- **Across `source()`.** Given

  ```r
  # parent.R
  pkgload::load_all()
  source("child.R")
  ```
  ```r
  # child.R
  my_func()        # my_func() defined in R/
  ```

  `parent.R` sees `my_func` (completion, no undefined-variable diagnostic), but
  `child.R` emits an undefined-variable diagnostic. The package contribution is
  injected only into the root query file.

- **From `.Rprofile`.** A `load_all()` call in the workspace-root `.Rprofile`
  does not add the package's internal symbols to other scripts' scopes.

By contrast, `library(pkg)` **does** propagate transitively across `source()`
chains (position-aware: only `library()` calls *before* a `source()` call flow
to that child), and `.Rprofile` `library()` attachments propagate via
`inherited_packages`. The asymmetry is the bug.

## Root cause

The package contribution (`PackageScopeContribution`: `r_internal_symbols`,
`sysdata_symbols`, `onload_symbols`, `imported_symbols`, …) is injected by
`append_package_contribution` / `append_rprofile_prelude` in
`crates/raven/src/cross_file/scope.rs`, but **only at `current_depth == 0`** (the
root query file). Every recursive walk into a sourced child passes
`package_contribution = None`, so `load_all()` internals never cross a `source()`
edge. `library()` avoids this because it propagates *package names*
(`packages_for_child`) through the recursion, position-aware via the per-file
`ScopeEvent::PackageLoad` timeline; `load_all()` injects a *fixed symbol set* and
was never threaded.

## Approved decisions

1. **Position-aware across `source()`** — only a `load_all()` call that precedes
   the `source()` call (and is in the same-or-ancestor function scope) propagates
   to that child. Mirrors `library()` and R runtime semantics.
2. **Child location is irrelevant** — when an in-root parent calls `load_all()`
   and sources a child, the child sees the internals regardless of its own
   location (even outside the package tree). The parent established package
   identity. The `under_package_root` gate stays for **direct** `load_all()`
   callers only.
3. **`.Rprofile` `load_all()` follows prelude gating** — surfaced through the
   same prelude path, withheld from `R/` and `tests/` in package mode (same as
   `rprofile_prelude_applies`); `R/` and `tests/` already get internals via
   dev-context, so nothing is lost there.
4. **Precise revalidation closure** — when `R/` changes and package visibility
   changes, the force-republish set is widened to the exact `load_all()` reach
   (see below), not a blunt "all docs under root".

## Which code path (corrected after adversarial review)

The reported bug is observed when `child.R` is **opened directly** and its
diagnostics flag `my_func()`. Verified against the code: a directly-opened
sourced file gets its inherited scope through the **backward parent-prefix walk**
(`scope.rs` ~5234 / parent-edges loop ~5494 / parent `PackageLoad` propagation
~5653-5705), which collects each parent's pre-`source()` `library()` attachments
into `prefix.inherited_packages`. The **forward** child-resolution block
(`~6246-6320`, where `extra_packages` is computed from the `PackageLoad` timeline)
only runs for `source()` calls *within the queried file* — it never fires for a
directly-opened child. The backward parent-prefix recursive call passes
`package_contribution = None` (`~5599-5600`).

**Therefore the fix must live in the backward parent-prefix path**, mirroring how
`library()` already reaches a directly-opened child. The forward child-resolution
path is intentionally **left unchanged**: a child's hoisted *definitions* (what
the forward path computes and merges back into the parent's scope) do not depend
on `load_all` internals being in scope, so forward propagation is not needed for
the reported bug — and avoiding it sidesteps the `ForwardChildMemo` cache-key
problem entirely (see §7).

## Approach (chosen over alternatives)

**A — backward "load_all in effect" propagation + `.Rprofile` prelude.** Record
`load_all()` calls in the per-file timeline (`ScopeEvent::DevLoadAll`). In the
backward parent-prefix walk, alongside the existing parent `PackageLoad`
propagation, scan each parent's timeline for a pre-`source()`-call-site
`DevLoadAll` event (same position + function-scope gates). When found (or when a
parent is itself transitively under load_all), mark the prefix
`load_all_in_effect` and inject the package contribution's internal symbols into
the prefix. The `.Rprofile` case sets the same flag "from (0,0)".

Rejected:

- **B — model `load_all()` as a synthetic package in `inherited_packages`.** The
  internals are not a real namespace; every consumer of `inherited_packages`
  would need to special-case the pseudo-package, and symbol injection (synthetic
  URI, kinds) does not match how packages resolve. Leaky, invasive.
- **C — thread `package_contribution` into all forward descendants, gate at
  injection only.** Not position-aware (fails decision 1) and forces a
  `ForwardChildMemo` cache-key change for no benefit to the reported bug.
- **D — forward child-resolution propagation (the original draft).** Targets the
  wrong path: it never fires for a directly-opened child, which is the reported
  bug. Rejected after verifying the backward/forward split in the code.

## Design

### 1. Detection & artifacts

`call_is_dev_load_all()` already identifies the calls. Emit a new
`ScopeEvent::DevLoadAll { line, column, function_scope }` into `timeline` at the
same point `collect_definitions` sets `calls_dev_load_all`. Keep the
`calls_dev_load_all` bool — still used by the root-file injection path and by the
revalidation closure.

### 2. Backward parent-prefix propagation (decisions 1 + 2)

In the parent-edges loop of the backward parent-prefix walk — exactly where the
parent's `PackageLoad` events are already propagated into
`prefix.inherited_packages` (`~5653-5705`) — add a parallel scan of each parent's
timeline for `DevLoadAll` events, using the identical gates already applied to
`PackageLoad`:

- position: the `load_all()` call is at-or-before the effective `source()`
  call-site position in the parent (`(load_line, load_col) <= (call_line, call_col)`,
  matching the existing `PackageLoad` comparison);
- function scope: `is_same_or_descendant_function_scope(...)`.

A qualifying `DevLoadAll` is honored **only when the parent is a valid direct
caller** — i.e. the parent file is `under_package_root` (decision 2 puts the gate
on the parent that establishes package identity, never on the child). When the
condition holds, set a new `load_all_in_effect: bool` on the `ParentPrefix`.

Transitivity reuses the existing "propagate packages the parent inherited from
*its* parents" step (`~5707-5729`): the parent's own `load_all_in_effect`
(computed by its recursive scope resolution) ORs into the child's, so
`a.R → b.R → c.R` with `load_all()` in `a.R` reaches `c.R`.

### 3. Injecting internals into the prefix

`package_contribution` is available at the depth-0 entry (`~5288`) where the
prefix is built. When the assembled `ParentPrefix` has `load_all_in_effect`,
inject the contribution's internal symbols (`r_internal_symbols`,
`sysdata_symbols`, `onload_symbols`, `imported_symbols`) into `prefix.symbols`
with `PACKAGE_INTERNAL_URI` and `or_insert_with` — the same symbol set and
injection style `append_package_contribution` uses, but **bypassing the
`under_package_root` gate on the child** (decision 2; the gate was already
enforced on the parent in §2). The existing `current_depth == 0` direct-caller
injection (gated by `calls_dev_load_all && under_package_root`) is unchanged and
runs independently for files that call `load_all()` themselves.

### 3a. Multi-parent over-approximation (decision: accept, consistent with library())

A child sourced by two parents already receives the **union** of both parents'
`library()` attachments, path-agnostic (`~5716-5729`). `load_all` follows the
same semantics: if *any* parent had a pre-`source()` `load_all()` in effect, the
child sees internals — even on an execution path through a parent that did not.
This is a safe false-negative direction (a suppressed diagnostic, never a
fabricated one) and matches existing `library()` behavior, so it is accepted and
documented rather than special-cased.

### 3b. Forward child-resolution path (intentionally unchanged)

The forward child-resolution block (`~6246-6320`) is **not** modified. It computes
a child's definitions to hoist back into the *parent's* scope after a `source()`
call; those definitions do not depend on `load_all` internals being in scope.
Leaving it unchanged means `ForwardChildKey` / `ForwardChildMemo` need no new
key field (see §7).

### 4. `.Rprofile` `load_all()` (decision 3)

- Add `rprofile_calls_load_all: bool` to `PackageScopeContribution`, set when the
  workspace-root `.Rprofile` contains a `load_all()` call (detected with the same
  `call_is_dev_load_all` logic during prelude derivation). This requires plumbing
  the flag through the `.Rprofile` scan **and** `derive_package_state` /
  `build_scope_contribution` that populate the contribution — adding the struct
  field alone is insufficient (it must actually be set for
  `PackageScopeContribution` equality, and thus `pkg_visibility_changed`, to
  react).
- `append_rprofile_prelude`'s early-return guard currently bails when
  `rprofile_symbols.is_empty() && rprofile_attached_packages.is_empty()`
  (`~7210`). A `.Rprofile` that *only* calls `load_all()` has neither, so the
  guard must be extended to also stay live when `rprofile_calls_load_all` is set;
  otherwise the prelude no-ops.
- When the flag is set and `rprofile_prelude_applies` passes, inject the package
  internals (same symbol set as `append_package_contribution`). Note the
  withholding via `rprofile_withheld_in_package_mode` covers `R/`, `tests/`,
  **and built-doc dirs** (`package_state/mod.rs` ~307-308) — all three are
  excluded in package mode, and all three already get internals via dev-context.
- Model it as "load_all in effect from position (0,0)" for any file the prelude
  reaches: set `prefix.load_all_in_effect` (or the depth-0 equivalent) so it both
  injects into that file and, through the §2 transitivity, reaches files that
  `source()` it (parallel to how `rprofile_attached_packages` already flow via
  `inherited_packages`).

### 5. Precedence (unchanged)

All injected internals use `or_insert_with`, so local definitions and all
higher-precedence tiers win. Internals carry `PACKAGE_INTERNAL_URI`.

### 6. Revalidation closure (decision 4)

`extend_with_open_package_docs` (in `backend.rs`) currently marks only open docs
matching `is_r_source_path` (`R/`, `tests/`) for force-republish when
`pkg_visibility_changed`. This misses every `load_all()` consumer outside `R/` and
`tests/` — a **pre-existing gap** (a root-level `analysis.R` calling `load_all()`
already goes stale today) that this feature widens (out-of-root sourced children,
`.Rprofile`-reached scripts).

Widen the package-state affected-set to the existing `is_r_source_path` docs
**plus the exact `load_all()` reach**:

- every open doc whose artifacts have `calls_dev_load_all` and is under the root
  (direct callers — closes the pre-existing gap);
- their position-aware `source()`-graph descendants (reuse the existing
  dependency-graph descendant walk; catches out-of-root children);
- if `rprofile_calls_load_all`, every open doc for which `rprofile_prelude_applies`,
  plus *their* source-graph descendants.

Computing this set from the same gating predicates and graph primitives the
injection uses keeps the "what sees the symbols" set and the "what gets
revalidated" set from drifting.

**Lock discipline (must hold).** `extend_with_open_package_docs` runs while the
`WorldState` write lock is held (`backend.rs` ~4923 / ~5077-5114). The widened
closure must use **only** the lock-safe primitives already used in that block:
dependency-graph reachability (the same `compute_affected_dependents_after_edit`
descendant walk) and `calls_dev_load_all` / `rprofile_calls_load_all` boolean
checks read from already-snapshotted artifacts/contribution. It must **not**
perform cross-file scope resolution under the lock — that would violate the
documented locking invariant. (Path-based reachability + bool checks are cheap and
match what the existing source-graph revalidation already does here.)

### 7. Caching and interface-hash inputs

- **`ForwardChildMemo` is not affected.** Because the forward child-resolution
  path is left unchanged (§3b), `ForwardChildKey` (`{child_uri, path_fp, pkg_fp,
  provider_fp}`, `~1236`; `pkg_fp` hashes package *names* only) needs no new field.
  Had we propagated `load_all` forward, the key would have silently conflated a
  child resolved with vs. without `load_all` in effect — the original draft's
  latent bug, avoided by construction.
- **Parent-prefix caching.** Verify that whatever caches/reuses the
  `ParentPrefix` (`pre_computed_prefix`, standalone scope cache) keys on the
  inputs that now determine `load_all_in_effect`. Since the prefix is recomputed
  from parent artifacts and `load_all_in_effect` is derived from parent
  `DevLoadAll` timeline events (covered by the interface hash below), prefix
  reuse must invalidate when those events change. Confirm during implementation
  that no prefix cache key omits this.
- **`compute_interface_hash`** must include the new `DevLoadAll` timeline events
  (line + column + function scope) so adding/removing/moving a `load_all()`
  relative to a `source()` call revalidates dependents — mirroring how
  `PackageLoad` events already feed the hash.
- **`rprofile_calls_load_all`** must be populated in the contribution (see §4) so
  `PackageScopeContribution` equality (used for `pkg_visibility_changed`) reacts;
  the struct field alone, unpopulated, would never trip revalidation.

## Testing

Mirror the existing `library()`-across-`source()` and load_all tests
(`state_tests.rs`, `cross_file/scope.rs`). The primary scenario is a
**directly-opened child** (the reported bug), exercising the backward path:

- **Reported bug:** `child.R` opened directly; `parent.R` does `load_all(); source("child.R")`
  → `child.R` sees internals, no undefined-var diagnostic.
- Position-aware: `parent.R` does `source("child.R"); load_all()` → `child.R` does
  **not** see internals.
- Transitive: `a.R` (`load_all(); source("b.R")`) → `b.R` (`source("c.R")`); open
  `c.R` directly → sees internals (§2 transitivity).
- Decision 2: in-root parent → **out-of-root** child → child sees internals; gate
  enforced on the parent (an out-of-root parent calling bare `load_all()` does not
  propagate).
- Function-scoped `load_all()` in the parent: child sourced within that scope sees
  internals; sourced outside it does not.
- Multi-parent (§3a): `child.R` sourced by `pA.R` (pre-source `load_all()`) and
  `pB.R` (none) → child sees internals (documented union over-approximation).
- `.Rprofile` `load_all()` → directly-opened script sees internals; **withheld**
  from `R/`, `tests/`, and built-doc dirs in package mode (decision 3);
  a `.Rprofile` that *only* calls `load_all()` still triggers injection (guard fix, §4);
  propagates to that script's sourced children.
- Revalidation: with `child.R` (out-of-root, sourced after `load_all()` in
  `parent.R`) open, adding a symbol to `R/` force-republishes `child.R`'s
  diagnostics (decision 4). Same for a root-level direct `load_all()` caller and a
  `.Rprofile`-reached script.

## Docs to update

- `docs/cross-file.md` — `load_all()` propagation across `source()`, parallel to
  the existing `library()` section.
- `docs/r-package-dev.md` — transitive `load_all()` behavior.
- `docs/rprofile.md` — `.Rprofile` `load_all()` behavior and package-mode
  withholding.

## Invariants touched

- Backward `load_all` propagation reuses the parent `PackageLoad` propagation in
  the parent-prefix walk — keep the `DevLoadAll` scan structurally identical to
  the `PackageLoad` scan (same position/function-scope gates) so they cannot
  drift.
- The injection reach and the revalidation closure must be computed from the same
  predicates (`calls_dev_load_all`, `under_package_root` on the **parent/direct
  caller**, `rprofile_prelude_applies`, source-graph descendants).
- The revalidation closure runs under the `WorldState` write lock and must use
  only graph reachability + artifact/contribution bool checks — never cross-file
  scope resolution under the lock (§6).
- The forward child-resolution path and `ForwardChildMemo` key are intentionally
  unchanged; if a future change does propagate `load_all` forward, the cache key
  must gain a `load_all_in_effect` discriminator (§7).
