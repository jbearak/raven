# Transitive `load_all()` scope: model as a virtual attached package

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
  `child.R` emits an undefined-variable diagnostic.

- **From `.Rprofile`.** A `load_all()` call in the workspace-root `.Rprofile`
  does not add the package's internal symbols to other scripts' scopes.

By contrast, `library(pkg)` **does** propagate transitively across `source()`
chains (position-aware), and `.Rprofile` `library()` attachments propagate via
`inherited_packages`. The asymmetry is the bug.

## Root cause

`load_all()` internals are injected directly into `scope.symbols` by
`append_package_contribution` (`cross_file/scope.rs` ~6889), using the synthetic
`PACKAGE_INTERNAL_URI`, and **only at the root query file** (`current_depth == 0`).
Recursive walks into sourced children pass `package_contribution = None`, so the
symbols never cross a `source()` edge in either direction. `library()` avoids this
because it attaches a *package name* into `inherited_packages` via the
`ScopeEvent::PackageLoad` timeline, and that name propagates through all the
existing cross-file machinery.

## Core design decision (revised after adversarial review)

**Model `load_all()` as attaching a synthetic "virtual package" rather than
injecting symbols directly.** A `load_all()` call emits a
`ScopeEvent::PackageLoad` event with a reserved sentinel package name; the
package-name → symbols resolution chokepoints special-case that sentinel to
resolve against the workspace-local `PackageScopeContribution` internal symbol
set (rather than the installed-package database).

This was option B in the first draft and was wrongly rejected as "leaky." It is
in fact the cleanest approach: the propagation machinery for attached packages is
a clean abstraction with a small number of resolution chokepoints. By reusing it,
the following all come for **free** (no new code), each previously a bespoke
mechanism or an open bug:

- **Backward propagation to a directly-opened child** (the reported bug) — a
  directly-opened sourced file collects its parents' pre-`source()` `PackageLoad`
  attachments via the backward parent-prefix walk (`scope.rs` ~5653-5705). The
  forward child-resolution block never fires for a directly-opened child; the
  first draft targeted it and would not have fixed the bug.
- **Forward child→parent attachment hoist** — a parent that `source()`s the
  load_all caller sees the package *after* the call, because child attachments
  already hoist back into the parent's later scope (`scope.loaded_packages` from
  sourced files). The bespoke approach would not have handled this.
- **Position-awareness** (`(line,col)` comparison + function-scope gate).
- **Multi-parent union** (a child sourced by two parents gets the union; safe
  over-approximation, identical to `library()`).
- **Transitivity** across `a.R → b.R → c.R`.
- **Interface hashing** — `compute_interface_hash` already folds in `PackageLoad`
  name + line + column + function scope (`scope.rs` ~4823-4830), so adding /
  moving / removing a `load_all()` call revalidates dependents.
- **`ForwardChildMemo` cache key** — `pkg_fp` hashes attached-package *names*
  (`scope.rs` ~1265-1280), so a child resolved with vs. without the sentinel gets
  distinct keys. (This was Codex's Item 8 blocker against the bespoke forward
  approach; it disappears here.)
- **`.Rprofile`** — add the sentinel to `rprofile_attached_packages`; the existing
  prelude gating (`rprofile_prelude_applies`, including built-doc / `R/` / `tests/`
  withholding) and injection then apply unchanged.

## Approved sub-decisions

1. **Position-aware** — only a `load_all()` call preceding a `source()` call (and
   in the same-or-ancestor function scope) propagates. Free with `PackageLoad`.
2. **Child location irrelevant; gate on the caller** — the sentinel
   `PackageLoad` is emitted **only when the `load_all()` caller is
   `under_package_root`** (the file that establishes package identity). Once
   attached, it flows to children regardless of *their* location.
3. **`.Rprofile` `load_all()` follows prelude gating** — surfaced by adding the
   sentinel to `rprofile_attached_packages`, subject to the existing
   `rprofile_prelude_applies` withholding (`R/`, `tests/`, built-doc dirs in
   package mode; those already get internals via dev-context).
4. **R/-change revalidation reuses the libpath-consumer probe** — treat the
   sentinel as a changed package and reuse the existing "which open docs have
   package P attached" intersection.
5. **Resolution backing: thread the contribution into the chokepoints** (option
   (b)), keeping workspace-local internals out of the installed-package database.

## Design

### 1. Sentinel name & detection

- Define a reserved sentinel package name (a constant that cannot collide with a
  real R package, e.g. containing a character illegal in package names). One
  workspace = one package, so a single sentinel suffices.
- `call_is_dev_load_all()` already detects the calls. In `collect_definitions`,
  when it matches **and the file is `under_package_root`** (sub-decision 2), emit
  `ScopeEvent::PackageLoad { line, column, package: SENTINEL, function_scope }`
  into the timeline — exactly as a `library()` call would, at the call's
  position. Drop the now-redundant `calls_dev_load_all` bool from the scope path
  (retain only if still needed by the revalidation trigger; see §4).

### 2. Resolution at the chokepoints (sub-decision 5)

The sentinel must resolve to the contribution's internal symbol set
(`r_internal_symbols ∪ sysdata_symbols ∪ onload_symbols ∪ imported_symbols`).
Thread the active `PackageScopeContribution` into the three resolution methods in
`package_library.rs` and special-case the sentinel:

- `is_symbol_from_loaded_packages` (~668) — undefined-variable suppression.
- `find_package_owner_for_symbol` (~1287) — hover attribution.
- `get_owned_exports_for_completions` (~607) — completion enumeration.

Each, when it encounters the sentinel in the attached-package list, consults the
threaded contribution's internal set instead of the installed cache. Their call
sites in `handlers.rs` (completion ~17890, hover ~19470, undefined-var ~15317 /
owner ~14691) pass the contribution (already available in the snapshot).

Suppress the `PACKAGE_NOT_INSTALLED` diagnostic for the sentinel
(`handlers.rs` ~5103 / ~5119): `package_exists` returns false for it, so add an
explicit skip.

### 3. Remove the bespoke load_all injection; keep dev-context

In `append_package_contribution` (`scope.rs` ~6889), remove the `dev_load_all`
branch (the `(dev_load_all && under_package_root)` arm). The direct `load_all()`
caller now gets internals via its own timeline's sentinel `PackageLoad` →
`inherited_packages`/`loaded_packages` → resolution, identical to how a sourced
child gets them. The independent **dev-context** path
(`is_dev_context_path` — editing `R/`/`tests/` etc. with no `load_all()` call) is
**unchanged**; the two conditions were already decoupled booleans.

`.Rprofile`: when the workspace-root `.Rprofile` calls `load_all()` (detected with
`call_is_dev_load_all` during the `.Rprofile` scan), add the sentinel to
`rprofile_attached_packages` in `PackageScopeContribution`. The existing
`append_rprofile_prelude` path (gating + injection into `inherited_packages`) then
handles it with no further change — and because `rprofile_attached_packages` is no
longer empty, the existing early-return guard passes naturally.

### 4. R/-change revalidation (sub-decision 4)

When `R/` changes and the recomputed `PackageScopeContribution` differs
(`pkg_visibility_changed`), every doc that has the sentinel in its resolved
attached set must be re-diagnosed — that is exactly the load_all caller, the files
it `source()`s (callees), and the files that `source()` it (callers).

Reuse the libpath-consumer affected-docs probe (`backend.rs` ~8294-8310:
`scope_hit = inherited_packages ∩ trigger_set`) with `trigger_set = {SENTINEL}`.
That path **snapshots inputs under the lock, drops the guard, then resolves scope
per open doc** — satisfying the locking invariant (unlike a synchronous closure
inside the write-lock handler). It covers caller, callees, and callers uniformly
because all three carry the sentinel in their resolved attached set.

Replace the original draft's bespoke `extend_with_open_package_docs` widening with
this reuse. (The pre-existing gap — a root-level `analysis.R` calling `load_all()`
not refreshed on `R/` change — is closed by the same mechanism, since it now
carries the sentinel.)

### 5. Precedence (unchanged in spirit)

Internals resolve at the attached-package-export tier — below local definitions,
own directives, and the built-in policy tables — which is the correct, and
arguably more-correct, tier for them (they are "from a package", not local). The
direct-caller behavior is preserved: a local definition of the same name still
wins because local `scope.symbols` resolution precedes package-export resolution
in the consuming handlers.

### 6. LSP-feature parity (verified)

- **Completion** — unchanged path; sentinel exports surface via
  `get_owned_exports_for_completions`.
- **Hover** — *improves*. Today load_all internals sit in `scope.symbols` with
  `PACKAGE_INTERNAL_URI` and lose help text; via the package path they resolve
  through `find_package_owner_for_symbol` and render real help.
- **Go-to-definition** — no regression. Today goto no-ops on `PACKAGE_INTERNAL_URI`
  scope symbols (`handlers.rs` ~20448); package exports are likewise
  non-navigable. (Optional future improvement: map the sentinel's symbols to their
  real `R/` source URIs to make goto jump to source — out of scope here.)
- **Find-references** — unaffected (textual, not scope-symbol based).

## Testing

### A. Scope / diagnostics propagation (mirror existing `library()` tests)

- **Reported bug:** `child.R` opened directly; `parent.R` does
  `load_all(); source("child.R")` → `child.R` sees internals, no undefined-var
  diagnostic.
- Position-aware: `source("child.R"); load_all()` → `child.R` does **not** see
  internals.
- Transitive: `a.R` (`load_all(); source("b.R")`) → `b.R` (`source("c.R")`); open
  `c.R` → sees internals.
- Forward child→parent hoist: `main.R` does `source("loader.R"); my_func()` where
  `loader.R` calls `load_all()` → `main.R` sees `my_func` after the `source()`.
- Sub-decision 2: in-root parent → **out-of-root** child → child sees internals;
  an out-of-root file calling bare `load_all()` does **not** attach the sentinel.
- Function-scoped `load_all()`: child sourced within that scope sees internals;
  sourced outside it does not.
- Multi-parent: `child.R` sourced by `pA.R` (pre-source `load_all()`) and `pB.R`
  (none) → child sees internals (documented union over-approximation).
- `.Rprofile` `load_all()`: directly-opened script sees internals; **withheld**
  from `R/`, `tests/`, built-doc dirs in package mode; a `.Rprofile` that *only*
  calls `load_all()` still attaches; propagates to that script's sourced children.

### B. R/ lifecycle → diagnostics (REQUIRED — explicit user requirement)

For each mutation, assert diagnostics update correctly in **all three roles**:
the file calling `load_all()` (`L`), files that `source()` `L` (callers, incl.
the post-`source()` continuation), and files `L` `source()`s (callees). Use the
`did_change_watched_files` / package-state path so revalidation (§4) is exercised
end-to-end, not just a single recompute.

- **ADD** a file to `R/` defining `new_func`:
  - before: `new_func()` in `L`, in a caller (after sourcing `L`), and in a callee
    each emit an undefined-variable diagnostic;
  - after add: all three diagnostics are **suppressed** (cleared) without editing
    those files — i.e. force-republish fires for all three.
- **DELETE** a file from `R/` that defined `my_func`:
  - before: `my_func()` is suppressed in `L`, caller, callee;
  - after delete: the undefined-variable diagnostic **reappears** in all three.
- **EDIT** a file in `R/` renaming `old_func` → `new_func`:
  - after edit: `old_func()` becomes **unsuppressed** (diagnostic appears) and
    `new_func()` becomes **suppressed** (diagnostic clears) in `L`, caller, callee.
- **Negative / scoping controls:**
  - a `load_all()` placed *after* a `source(callee)` call does **not** suppress the
    callee's diagnostics (position-aware revalidation);
  - an out-of-root file with a bare `load_all()` is **not** affected by `R/`
    changes (sentinel never attached);
  - in package mode, `R/` and `tests/` files are governed by dev-context, not the
    `.Rprofile` sentinel (withholding holds).
- **Monotonicity:** republished diagnostics respect document-version
  monotonicity / the force-republish gate (no older-version publish).

## Docs to update

- `docs/cross-file.md` — `load_all()` modeled as a virtual attached package;
  propagation parallel to `library()`.
- `docs/r-package-dev.md` — transitive `load_all()` behavior and R/-change
  diagnostics refresh.
- `docs/rprofile.md` — `.Rprofile` `load_all()` behavior and package-mode
  withholding.

## Invariants touched

- The sentinel `PackageLoad` must be emitted **only** when the `load_all()` caller
  is `under_package_root` (sub-decision 2 gate sits on the caller, never the
  child).
- Sentinel resolution lives behind the three `package_library` chokepoints only;
  no other consumer of `inherited_packages` may assume entries are installed
  packages (the `PACKAGE_NOT_INSTALLED` diagnostic is the one exception, explicitly
  skipped).
- R/-change revalidation reuses the libpath-consumer probe and therefore inherits
  its locking discipline: snapshot inputs under the lock, drop the guard, then
  resolve scope per doc — never resolve cross-file scope while holding the lock.
- The dev-context internals path stays independent of the `load_all()` sentinel
  path; removing the `dev_load_all` branch from `append_package_contribution` must
  not alter dev-context behavior.
