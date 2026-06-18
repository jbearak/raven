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
the following all come **largely for free** — each previously a bespoke mechanism
or an open bug. (Two pieces still need real work — sentinel emission with
function-scope annotation, §1/§2 Item 4; and guards for non-chokepoint name
consumers, §2a Item 1 — so this is "reuse the machinery", not "zero code".)

- **Backward propagation to a directly-opened child** (the reported bug) — a
  directly-opened sourced file collects its parents' pre-`source()` `PackageLoad`
  attachments via the backward parent-prefix walk (`scope.rs` ~5653-5705). The
  forward child-resolution block never fires for a directly-opened child; the
  first draft targeted it and would not have fixed the bug.
- **Forward child→parent attachment hoist** — a parent that `source()`s the
  load_all caller sees the package *after* the call, because child attachments
  already hoist back into the parent's later scope (`scope.loaded_packages` from
  sourced files). The bespoke approach would not have handled this.
- **Position-awareness** (`(line,col)` comparison + function-scope gate) — free
  *once* the sentinel `PackageLoad` carries a `function_scope` annotation; that
  emission is the work called out in §1.
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
4. **R/-change revalidation: lock-safe graph closure** — in the watched-file
   handler, mark a conservative superset (source-graph neighborhood of open
   `load_all()` carriers + `.Rprofile`-reach) via graph reachability + artifact
   bools, never scope resolution. (Revised away from "reuse the libpath probe",
   which is not callable from that handler — see §4.)
5. **Resolution backing: a local-dev overlay on `package_library`** (refinement
   of option (b)). Keep workspace-local internals out of the installed-package
   database, but expose them as a dedicated overlay field on `package_library`
   that the chokepoints consult via `&self` — *not* as a threaded parameter
   (which would ripple through `NseAnalysis::build` and every test). See §2.

## Design

### 1. Sentinel name & detection

- Define a reserved sentinel package name (a constant that cannot collide with a
  real R package, e.g. containing a character illegal in package names). One
  workspace = one package, so a single sentinel suffices.
- `call_is_dev_load_all()` already detects the calls. Emit the sentinel
  `PackageLoad` through the **same emission path that gives `library()`
  `PackageLoad` events their `function_scope`** (`scope.rs` ~1846-1849), not via a
  standalone bool. `collect_definitions` today records only a `calls_dev_load_all`
  bool (~2700-2708), and `annotate_event_function_scopes` (~1610) does **not**
  handle `PackageLoad` — so a naively-emitted event would lack the function-scope
  annotation that makes position/scope behavior work. Routing through the
  `library()` emission site guarantees identical position + function-scope
  treatment (closing Codex Item 4).
- Gate on the caller: emit **only when the `load_all()` caller is
  `under_package_root`** (sub-decision 2).
- **Keep** the `calls_dev_load_all` bool — the revalidation closure (§4) needs it
  to identify load_all carriers cheaply under the lock.

### 2. Resolution via a local-dev overlay (sub-decision 5)

The sentinel must resolve to the contribution's internal symbol set
(`r_internal_symbols ∪ sysdata_symbols ∪ onload_symbols ∪ imported_symbols`).

Codex Item 2: threading `PackageScopeContribution` as a parameter into the three
resolution methods is the wrong shape — they are also reached via
`NseAnalysis::build` (which takes only `package_library`/`base_exports`,
`handlers.rs` ~13231-13238) and via `package_library` unit tests that pass no
contribution, so a parameter would ripple through every NSE call site and break
test signatures.

Instead, add a **local-dev overlay** to `package_library`: an
`Option<Arc<LocalDevPackage>>` field holding the sentinel → internal-symbol-set
mapping, refreshed whenever `apply_package_event` recomputes the contribution
(single writer). The three resolution methods consult it via `&self` before the
installed cache:

- `is_symbol_from_loaded_packages` (~668) — undefined-variable suppression.
- `find_package_owner_for_symbol` (~1287) — hover attribution.
- `get_owned_exports_for_completions` (~607) — completion enumeration.

This honors option (b)'s intent (local internals never enter the installed-package
cache; they live in a clearly-separated field) **without** any call-site
threading. `NseAnalysis::build` already takes `package_library`, so it inherits
the overlay for free; tests default the overlay to `None`.

`PACKAGE_NOT_INSTALLED` needs no change: it iterates only
`directive_meta.library_calls` (`handlers.rs` ~5099), which a timeline-emitted
sentinel never enters — so it cannot fire a false "not installed" diagnostic.

### 2a. Sentinel guards for other attached-name consumers (Codex Item 1)

Some consumers iterate attached package **names** (from `inherited_packages` /
`loaded_packages`), not the `package_library` overlay, and would mis-handle the
sentinel by looking it up or shelling out to R. Add a central
`is_load_all_sentinel(name)` predicate and skip the sentinel in each:

- `data()` alias expansion (`scope.rs` ~6620) — sentinel has no datasets; skip.
- pending-cache `package_exists` loop (`handlers.rs` ~6451) — skip (it is not an
  installed package to fetch).
- R-subprocess prefetch filters (`backend.rs` ~3905, ~7912) — skip so the sentinel
  is never sent to `library()`/help in the R subprocess.
- NSE owner / standard-eval resolution (`handlers.rs` ~13154/~13191/~14691/~15317)
  resolves owners through the overlay-aware chokepoints, so it needs no extra
  guard — but confirm during implementation it does not separately enumerate the
  sentinel against installed metadata.

### 3. Remove the bespoke load_all injection; keep dev-context

In `append_package_contribution` (`scope.rs` ~6889), remove the `dev_load_all`
branch (the `(dev_load_all && under_package_root)` arm; ~6942). Verified the
branch injects `r_internal_symbols ∪ sysdata_symbols ∪ onload_symbols ∪
imported_symbols` — exactly the sentinel's set — and **not** `dataset_symbols`
(datasets are injected separately for any workspace R file, ~6907-6910, and that
path is untouched). So the sentinel `PackageLoad` path gives the direct caller
identical symbol coverage, with no dataset regression (confirms Codex Item 3).
The independent **dev-context** path (`is_dev_context_path` — editing
`R/`/`tests/` etc. with no `load_all()` call) is **unchanged**; the two conditions
were already decoupled booleans.

`.Rprofile`: when the workspace-root `.Rprofile` calls `load_all()` (detected with
`call_is_dev_load_all` during the `.Rprofile` scan), add the sentinel to
`rprofile_attached_packages` in `PackageScopeContribution`. The existing
`append_rprofile_prelude` path (gating + injection into `inherited_packages`) then
handles it with no further change — and because `rprofile_attached_packages` is no
longer empty, the existing early-return guard passes naturally.

### 4. R/-change revalidation (sub-decision 4)

When `R/` changes and the recomputed `PackageScopeContribution` differs
(`pkg_visibility_changed`, caught by full-contribution equality — Codex Item 5/6
confirmed `r_internal_symbols` changes trip it), every doc whose scope includes
the sentinel must be re-diagnosed — the load_all caller, the files it `source()`s
(callees), and the files that `source()` it (callers, via the child→parent
attachment hoist).

**The libpath-consumer probe is *not* reusable here** (Codex Item 5, confirmed):
it lives inside `run_libpath_consumer`'s task (`backend.rs` ~8122-8230), is not
callable from `did_change_watched_files`, and that handler's existing fanout
(~5611-5616) only adds open `R/`/`tests/`/`.Rprofile` paths — not arbitrary
`load_all()` carriers. Extracting and rewiring the probe (which re-resolves scope
per doc) into the write-lock handler would also violate the locking invariant.

Instead, widen the affected-set with a **lock-safe graph closure**, computed from
the same cheap primitives the existing source-graph revalidation already uses in
that handler (`compute_affected_dependents_after_edit` + artifact bools), with
**no scope resolution under the lock**:

1. seed with every open doc whose artifacts have `calls_dev_load_all` and is
   `under_package_root` (the carriers — closes the pre-existing root-level
   `analysis.R` gap);
2. add their source-graph **descendants** (callees) **and ancestors** (callers,
   for the child→parent hoist) via the dependency graph;
3. if `.Rprofile` attaches the sentinel, add every open doc for which
   `rprofile_prelude_applies`, plus their graph neighborhood.

This is a deliberate **conservative superset**: position-aware correctness of
suppress/unsuppress is enforced later, at diagnosis-time scope resolution (which
is position-aware); the revalidation set only needs to guarantee every possibly
affected doc is re-diagnosed, and over-inclusion costs only a redundant,
idempotent re-diagnose. Mark the set via the existing force-republish gate.

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
- **Go-to-definition** — *improves*, and is now in scope (see §7). Today goto
  no-ops on `PACKAGE_INTERNAL_URI` scope symbols (`handlers.rs` ~20448); under the
  pivot those symbols leave `scope.symbols`, so the reject gate no longer fires and
  goto can resolve them to their real `R/` source via the workspace index.
- **Find-references** — unaffected (textual, not scope-symbol based).

### 7. Go-to-definition for `load_all()` internals → `R/` source

Goto on an internal function exposed by `load_all()` (e.g. `my_func()` in a
caller, callee, or the `load_all()` file itself) should navigate to its real
definition in the package's `R/` source. This works **without adding any location
data to `PackageScopeContribution`** — the package's `R/` files are already in the
workspace index (`workspace_index_new`) with real `ScopedSymbol` locations (file
URI + line + column, `scope.rs` ~587-608), and the goto handler already has a
workspace-index fallback (`handlers.rs` ~20516).

Design:

- The contribution names the internal symbols (`r_internal_symbols`,
  `onload_symbols`); the **workspace index supplies the location**. Keep that
  separation — no `(file,line)` map on the contribution.
- In the goto handler, when the cursor identifier `name` is in scope via the
  load_all sentinel (resolved through the overlay) and `name ∈ r_internal_symbols
  ∪ onload_symbols`, resolve its definition by querying the workspace index
  **restricted to the package's source tree** (`<workspace_root>/R`, and the test
  tree for test helpers) and return that `Location`. Restricting to the package
  tree avoids navigating to an unrelated workspace file that happens to define the
  same name.
- If multiple `R/` files define the name (rare), return all locations (LSP allows
  an array).
- `sysdata_symbols` and `imported_symbols` have **no navigable workspace source**
  (sysdata are data objects; imports come from *other* installed packages), so
  goto on them no-ops — the same outcome as external-package symbols (§ future
  work).
- The existing `starts_with("package:")` reject gate (`handlers.rs` ~20448/~20505/
  ~20530) is unaffected: under the pivot these internals are no longer
  `scope.symbols` entries carrying a `package:` URI, so the gate simply does not
  apply to them.

Where practical, extend the existing workspace-index fallback rather than adding a
parallel path; the only load_all-specific logic is the "is this a sentinel
internal?" test and the package-tree restriction.

### Future work: go-to-definition into external/installed packages

Out of scope for this spec (per design decision). Navigating from a `library()`
symbol (e.g. `dplyr::mutate`) into the package's `.R` source is **infeasible with
current data**: installed packages in `.libPaths()` ship a compiled lazy-load
database, not readable source; `PackageInfo` stores only export *names* and
rendered help text — no source paths or line locations. Supporting it would
require a separate subsystem: fetch/extract upstream sources (CRAN/Bioc/GitHub),
parse and index them to symbol→location, invalidate on package upgrade, and budget
disk for cached sources. Documented here as a future feature; the goto handler's
behavior for installed-package symbols is unchanged (no-op) in the meantime.

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

### C. Resolution overlay & sentinel guards (Codex Items 1 & 2)

- **Hover** on a load_all internal renders real package help (the improvement),
  not the bare-symbol fallback.
- **Completion** in a load_all caller offers the internal symbols.
- **Overlay isolation:** with no `load_all()` anywhere, the local-dev overlay is
  empty and resolution is byte-identical to today (regression guard); the sentinel
  never appears in installed-package enumeration / metadata.
- **Sentinel guards:** the sentinel name is never sent to the R subprocess
  (prefetch filter skips it), never triggers a `PACKAGE_NOT_INSTALLED` diagnostic,
  and `data()` alias expansion ignores it.
- **NSE call sites** resolve owners through the overlay without a contribution
  parameter (`NseAnalysis::build` signature unchanged).

### D. Go-to-definition (§7)

- Goto on `my_func()` in the **load_all caller**, in a **callee**, and in a
  **caller** (all with the sentinel in scope) navigates to its `R/` definition
  with the correct file URI + line.
- Goto picks the `R/` definition, not an unrelated workspace file that defines the
  same name (package-tree restriction).
- Goto on a `sysdata`/imported symbol no-ops (no navigable workspace source).
- Regression: goto on a normal `library()` symbol still no-ops (external-package
  goto unchanged).
- Goto still works for R/-defined symbols referenced within `R/` itself
  (dev-context path unaffected).

## Docs to update

- `docs/cross-file.md` — `load_all()` modeled as a virtual attached package;
  propagation parallel to `library()`.
- `docs/r-package-dev.md` — transitive `load_all()` behavior, R/-change
  diagnostics refresh, and go-to-definition into `R/` source for load_all
  internals.
- `docs/go-to-definition.md` — goto for `load_all()`-exposed internals; note the
  external/installed-package case is not yet supported.
- `docs/rprofile.md` — `.Rprofile` `load_all()` behavior and package-mode
  withholding.

## Invariants touched

- The sentinel `PackageLoad` must be emitted **only** when the `load_all()` caller
  is `under_package_root` (sub-decision 2 gate sits on the caller, never the
  child).
- Sentinel symbol resolution lives behind the three `package_library` chokepoints
  (via the local-dev overlay) only. Every *other* consumer that iterates attached
  package **names** and feeds them to installed-package machinery or the R
  subprocess must skip the sentinel via `is_load_all_sentinel` (§2a). Adding a new
  such consumer requires adding the guard.
- R/-change revalidation runs inside the `did_change_watched_files` write-lock
  handler and therefore must use **only** graph reachability + artifact bools —
  never cross-file scope resolution under the lock (§4). The libpath-consumer
  probe is explicitly *not* reused here.
- The dev-context internals path stays independent of the `load_all()` sentinel
  path; removing the `dev_load_all` branch from `append_package_contribution` must
  not alter dev-context behavior.
- Go-to-definition for load_all internals derives locations from the **workspace
  index**, not from `PackageScopeContribution` (which stays location-free). Goto
  must restrict resolution to the package's source tree so a same-named symbol in
  an unrelated workspace file is not chosen.
