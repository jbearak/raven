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

## Approach (chosen over alternatives)

**A — synthetic timeline event + inherited "load_all in effect" flag.** Record
`load_all()` calls in the per-file timeline and reuse the *exact* position-aware
+ function-scope filter already used for `library()`. Thread the
`package_contribution` reference plus a `load_all_in_effect` flag into recursive
child calls; inject at the child via the existing `append_package_contribution`.

Rejected:

- **B — model `load_all()` as a synthetic package in `inherited_packages`.** The
  internals are not a real namespace; every consumer of `inherited_packages`
  would need to special-case the pseudo-package, and symbol injection (synthetic
  URI, kinds) does not match how packages resolve. Leaky, invasive.
- **C — thread `package_contribution` into all descendants, gate at injection
  only.** Not position-aware; fails decision 1.

## Design

### 1. Detection & artifacts

`call_is_dev_load_all()` already identifies the calls. Emit a new
`ScopeEvent::DevLoadAll { line, column, function_scope }` into `timeline` at the
same point `collect_definitions` sets `calls_dev_load_all`. Keep the
`calls_dev_load_all` bool — still used by the root-file injection path and by the
revalidation closure.

### 2. Propagation across `source()` (decisions 1 + 2)

In the child-resolution block of `scope_at_position_with_graph_recursive` where
`extra_packages` is computed from `PackageLoad` timeline events, add a parallel
scan for `DevLoadAll` events using the identical gates:

- position: `(load_line, load_col) < (src_line, src_col)`
- function scope: `is_same_or_descendant_function_scope(source_function_scope, load_function_scope)`

If a qualifying `DevLoadAll` event exists, **or** the current frame already has
`load_all_in_effect` inherited, set `load_all_in_effect = true` for the child.

Recursive-function changes:

- Stop forcing `package_contribution = None` for children; thread the parent's
  `Option<&PackageScopeContribution>` reference through.
- Add parameter `load_all_in_effect: bool`.

### 3. Injection at the child

Today injection runs only at `current_depth == 0`. Change so that when
`load_all_in_effect` is inherited, `append_package_contribution` also runs at the
child's depth, with a new parameter that **bypasses the `under_package_root`
gate** (decision 2) while still respecting `is_r_source_path` / dev-context logic
for *which* symbol categories apply. The `current_depth == 0` direct-caller path
(gated by `calls_dev_load_all && under_package_root`) is unchanged.

### 4. `.Rprofile` `load_all()` (decision 3)

- Add `rprofile_calls_load_all: bool` to `PackageScopeContribution`, set when the
  workspace-root `.Rprofile` contains a `load_all()` call (detected with the same
  `call_is_dev_load_all` logic during prelude derivation).
- In `append_rprofile_prelude`, when the flag is set and `rprofile_prelude_applies`
  passes, inject the package internals (same symbol set as
  `append_package_contribution`).
- Model it as "load_all in effect from position (0,0)" for the root file, so at
  `current_depth == 0` it sets `load_all_in_effect = true` and therefore also
  propagates to that file's sourced children (parallel to how
  `rprofile_attached_packages` already flow via `inherited_packages`).

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

### 7. Interface hash / revalidation inputs

- `compute_interface_hash` must include the new `DevLoadAll` timeline events (line
  + column + function scope) so that adding/removing/moving a `load_all()`
  relative to a `source()` call revalidates dependents.
- `rprofile_calls_load_all` feeds the existing `.Rprofile`-change revalidation
  path; `PackageScopeContribution` equality (used for `pkg_visibility_changed`)
  already covers the new field once added to the struct.

## Testing

Mirror the existing `library()`-across-`source()` and load_all tests
(`state_tests.rs`, `cross_file/scope.rs`):

- `load_all(); source(child)` → child sees internals; no undefined-var diagnostic.
- `source(child); load_all()` → child does **not** see internals (position-aware).
- in-root parent → **out-of-root** child → child sees internals (decision 2).
- function-scoped `load_all()` inside a function: child sourced within that scope
  sees internals; sourced outside it does not.
- `.Rprofile` `load_all()` → directly-opened script sees internals; **withheld**
  from `R/` and `tests/` in package mode (decision 3); propagates to that
  script's sourced children.
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

- Position-aware propagation reuses the `library()` timeline filter — keep the two
  filters structurally identical so they cannot drift.
- The injection reach and the revalidation closure must be computed from the same
  predicates (`calls_dev_load_all`, `under_package_root` for direct callers,
  `rprofile_prelude_applies`, source-graph descendants).
