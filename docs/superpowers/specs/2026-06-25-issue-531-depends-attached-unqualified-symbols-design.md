# Issue #531 — Resolve unqualified symbols from `Depends:` packages in package mode

Date: 2026-06-25
Status: Approved for implementation (codex round 2: "no blockers"; spec-text
precision corrections applied)

## Problem

In package mode (workspace root has `DESCRIPTION` with a non-empty `Package:`
field), raven resolves unqualified symbols from a package listed in
`NAMESPACE: import(pkg)` but **not** from a package listed in `Depends:` in
`DESCRIPTION`. Because R *attaches* `Depends:` packages when the package is
loaded (`library()` / `pkgload::load_all()`), their exports are available
unqualified to the package's own code at runtime, and `R CMD check` does not
flag them. raven's static analysis diverges from R here, producing false
`undefined-variable` warnings.

Reproduction (raven 0.11.1): a package with `Depends: ggplot2` and
`R/p.r` = `myplot <- function(d) ggplot(d, aes(x, y)) + theme_bw()` flags
`ggplot` and `theme_bw` as undefined. Adding `NAMESPACE` with `import(ggplot2)`
(and nothing else) fixes both — so the export data is available; only the
`Depends:`-based resolution path is missing.

## Goal / non-goals

**Goal.** Treat each package in `DESCRIPTION` `Depends:` as a source of
unqualified exported symbols for the package's own code — exactly equivalent to
a `NAMESPACE` `import(pkg)` of each. This suppresses `undefined-variable` for
those packages' exports and feeds completion / NSE-in-play the same way
`import(pkg)` does today.

**Non-goals.**
- `Imports:` keeps its current stricter semantics (loaded, not attached →
  requires `pkg::sym` or `importFrom`). We do **not** add `Imports:` packages to
  the unqualified set. This matches R.
- `Suggests:` is unaffected.
- We do not change how a package's exports are *looked up* (the package
  library / names-db three-tier path is untouched).
- We do not add `useDynLib` or any other resolution that doesn't exist today.

## Background: how `import(pkg)` resolves today

(All paths under `crates/raven/src/`.)

1. **NAMESPACE → model.** `package_namespace.rs` parses `import(pkg)` into
   `PackageNamespaceModel.full_imports: Vec<String>` and `importFrom(pkg, sym)`
   into `imports: Vec<(String, String)>`.
2. **Model + roxygen → contribution.** `package_state/derive.rs`
   `build_scope_contribution` (lines ~148-176) folds the namespace model into a
   `PackageScopeContribution`: `full_imports: Arc<BTreeSet<String>>` (whole-
   package imports) and `imported_symbols: Arc<BTreeMap<sym, {pkg}>>` (specific
   symbols). `merge_namespace_model` first unions roxygen `@import`/`@importFrom`
   from `R/*.R` Source files into the model.
3. **Consumption.** `full_imports` is **not** injected as concrete symbols into
   scope (`scope.rs` `append_package_contribution` deliberately skips it — the
   comment explains the package library enumerates them). Instead three
   consumers read `scope_contribution.full_imports`:
   - completion (`handlers.rs` ~18079): offer those packages' exports;
   - NSE "in-play packages" (`handlers.rs` `collect_in_play_packages` ~5975):
     determine which packages' NSE policies apply;
   - undefined-variable diagnostics (`handlers.rs` ~5803, ~6700): an undefined
     identifier that is an export of a `full_imports` package is suppressed.

`Depends:` is already *parsed* — `namespace_parser::parse_description_field_pub`
(strips `(>= x)` version constraints, drops the special `R` entry) — but is used
only by `compute_test_attached_packages` (the `tests/testthat/` implicit-attach
gate for testthat). It never reaches `full_imports`.

## Design

**Single change site: `build_scope_contribution` in
`package_state/derive.rs`.** After computing `full_imports` from the namespace
model, union in the `Depends:` package names from `DESCRIPTION`.

Current (lines ~148-158):

```rust
let (imported_symbols, full_imports) = match namespace_model {
    Some(m) => {
        let mut imp: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (pkg, sym) in &m.imports {
            imp.entry(sym.clone()).or_default().insert(pkg.clone());
        }
        let full: BTreeSet<String> = m.full_imports.iter().cloned().collect();
        (imp, full)
    }
    None => (BTreeMap::new(), BTreeSet::new()),
};
```

Proposed:

```rust
let (imported_symbols, mut full_imports) = match namespace_model {
    Some(m) => { /* unchanged */ }
    None => (BTreeMap::new(), BTreeSet::new()),
};
// `Depends:` packages are attached when the package is loaded (R puts their
// exports on the search path), so their exports resolve unqualified inside the
// package's own code — exactly like a NAMESPACE `import(pkg)`. Union them into
// `full_imports`. `Imports:` is deliberately excluded: it is loaded but not
// attached, so it stays `::`/`importFrom`-only (matches R). Version
// constraints and the special `R` entry are stripped by the parser. The
// package's own name is filtered out (`pkg != ws.name`): a valid DESCRIPTION
// never self-depends, but a malformed one mid-edit could, and self-name in
// `full_imports` would query a possibly-stale installed package of the same
// name.
if let Some(desc) = description {
    for pkg in crate::namespace_parser::parse_description_field_pub(&desc.text, "Depends") {
        if pkg != ws.name {
            full_imports.insert(pkg);
        }
    }
}
```

`ws` (the `PackageWorkspace`) is already in scope at this point (it is used a
few lines down for `package_name: Some(ws.name.clone())`), so `ws.name` is
available for the self-name guard.

### Why merge into `full_imports` rather than add a new field

The issue asks for behavior "equivalent to a `NAMESPACE` `import()` of each."
`full_imports` *is* the "whole package available unqualified" set, and all three
consumers (completion, NSE-in-play, undefined-variable) already read it. Merging
gets correct behavior in all three with one change and no new plumbing, no new
interface-hash field, no new scope-injection branch. A separate field would
duplicate three consumer sites for no semantic gain.

### Visibility / consumer scope (review finding 1)

`full_imports` is read from `scope_contribution` — a single package-wide value —
by three consumers, *none* gated on the queried file's path (gating differs per
consumer, so do not assume a single uniform gate):

- undefined-variable suppression (`handlers.rs:5803`, `:6700`/`:6726`) — gated on
  `cross_file_config.packages_enabled && package_library_ready`;
- NSE in-play set (`handlers.rs:5975`, via `collect_in_play_packages`) — adds
  `full_imports` with no direct packages-ready gate of its own;
- completion (`handlers.rs:18086`) — gated on `packages_enabled`.

So in package mode `full_imports` already applies workspace-wide, regardless of
whether the queried file is under `R/`. This is the **existing** behavior of
NAMESPACE `import(pkg)`; the spec does not change it. It is also *correct* for
`Depends:`: R attaches `Depends:` packages onto the global search path whenever
the package is loaded (including when its test suite runs), so their exports are
visible to any code evaluated with the package loaded — broader than a namespace
`import()`, never narrower. Matching `import()`'s scope is therefore faithful,
not a regression, and is exactly what the issue requests ("equivalent to a
NAMESPACE `import()` of each"). No new file-kind scoping mechanism is introduced.

### Meta-package NSE expansion: intentional asymmetry (review finding 3)

`collect_in_play_packages` adds `full_imports` to the in-play `packages` set but
**not** to `attached_packages_for_meta` (`handlers.rs:5975` vs `:5984`). Only
`library()`/`require()` attaches and `test_attached_packages` feed
`attached_packages_for_meta`, which expands meta-packages (e.g. `tidyverse`) to
their members so a bare verb like `filter` resolves to dplyr's NSE policy.

Routing `Depends:` through `full_imports` therefore does **not** trigger
meta-package member expansion. We accept this deliberately:

- It is **identical to the existing `import(pkg)` behavior** — `import(tidyverse)`
  in NAMESPACE doesn't meta-expand today either — so `Depends:` stays consistent
  with the mechanism the issue asked it to mirror.
- The only affected case is a *meta-package* in `Depends:` (e.g.
  `Depends: tidyverse`), which is rare and a discouraged anti-pattern. A concrete
  package in `Depends:` (`ggplot2`, `data.table`, `dplyr`, `R6`, …) is itself a
  member, so its own NSE policy resolves directly via the in-play `packages` set
  — no meta-expansion needed. The motivating issue and all realistic cases are
  concrete packages.
- The worst-case symptom for a meta-package in `Depends:` is a *false positive*
  (a mask argument flagged), never a false negative, and it is fixable by the
  user with an explicit `library(member_pkg)` — the same escape hatch that exists
  for `import(tidyverse)` today.

Adding `Depends:`-specific meta-expansion would require tracking the `Depends:`
subset separately from `full_imports` (since `import()` entries must *not* be
meta-expanded, to preserve current behavior) and a new consumer in
`collect_in_play_packages`. That cost is not justified by the rare anti-pattern
case. If a real report surfaces, the follow-up is a separate
`depends_attached_packages` field consumed there — explicitly out of scope here.

### Both-paths coverage (NAMESPACE present and absent)

The union runs **after** the `match`, so it applies whether or not a NAMESPACE
exists. The repro has no NAMESPACE (`namespace_model` is `None` → `full_imports`
starts empty), and `Depends:` still populates it. A package with both a
`NAMESPACE import(x)` and `Depends: y` ends with `{x, y}` (de-duped by the
`BTreeSet`; a package both imported and depended-on collapses to one entry).

### Revalidation / caching (review finding 2)

Revalidation here is **not** driven by per-file `interface_hash`
(`compute_interface_hash` carries no `PackageScopeContribution`). It is driven by
the package-state change path in `backend.rs`:

- `DESCRIPTION` is in the package-input gate — `path == root.join("DESCRIPTION")`
  (`backend.rs:4796`) — so editing it re-runs `derive_package_state`.
- The backend compares the old vs new contribution and sets
  `package_visibility_changed = ... || scope_contribution() != &old_contribution`
  (`backend.rs:4818`). Populating `full_imports` from `Depends:` changes the
  contribution, so a `Depends:` edit flips this flag.
- When set, the fanout (`backend.rs:4895`) adds every open `is_r_source_path`
  file to the affected set and re-publishes their diagnostics. `is_r_source_path`
  covers `R/` **and** package test files (`tests/`, installed test dirs), but
  **excludes** dev-context paths (`vignettes/`, `demo/`, `data-raw/`, `man/`).

That fanout covers `R/` + test files — which includes the issue's target — and
is the same path a NAMESPACE `import()` edit already takes, so `Depends:` edits
revalidate identically to NAMESPACE edits. `PackageScopeContribution` derives
`PartialEq, Eq` (`mod.rs:834`), so the equality comparison above includes
`full_imports` automatically; no interface-hash field changes. (Dev-context
files — vignettes etc. — are outside this fanout's eager refresh, identical to
the existing NAMESPACE-change behavior; they still pick up the new contribution
on their next edit. Out of scope for this issue.)

## Tests

Add to `package_state/derive.rs` tests (which already construct `PackageInputs`
with a `DESCRIPTION`):

1. **`depends_packages_added_to_full_imports`** — `Depends: ggplot2` with no
   NAMESPACE → `scope_contribution.full_imports` contains `"ggplot2"`.
2. **`imports_not_added_to_full_imports`** — `Imports: dplyr` (no `Depends:`, no
   NAMESPACE) → `full_imports` does **not** contain `"dplyr"`.
3. **`depends_unions_with_namespace_full_imports`** — `Depends: ggplot2` +
   NAMESPACE `import(rlang)` → `full_imports == {ggplot2, rlang}`.
4. **`depends_strips_version_and_drops_R`** —
   `Depends: R (>= 3.5), ggplot2 (>= 3.0)` → `full_imports == {ggplot2}` (no
   `R`, no version text).
5. **`depends_dedupes_with_namespace`** — `Depends: rlang` + NAMESPACE
   `import(rlang)` → `full_imports == {rlang}` (single entry).
5b. **`depends_filters_own_package_name`** — package `tp` with
   `Depends: tp, ggplot2` (malformed self-dep) → `full_imports == {ggplot2}`
   (own name dropped by the `pkg != ws.name` guard).
6. **End-to-end diagnostic** (in `handlers.rs`, mirroring
   `test_completion_includes_full_imports_packages` /
   `test_diagnostic_suppresses_importFrom_in_package_file`): a package file using
   `ggplot`/`theme_bw` with `Depends: ggplot2` (and ggplot2 exports seeded into
   the package library the way existing tests do) produces no
   `undefined-variable` for those symbols. This is the issue's actual repro and
   the regression guard.

## Docs

Update `docs/r-package-dev.md`:
- In the import-resolution section, state that `DESCRIPTION` `Depends:` packages
  are treated as attached (their exports resolve unqualified), equivalent to a
  NAMESPACE `import()`, while `Imports:` remains `::`/`importFrom`-only.

(No README change needed; this is a package-mode detail.)

## Risk / edge cases considered

- **Over-suppression.** Only `Depends:` is added, never `Imports:`/`Suggests:`,
  so we do not silence diagnostics for packages R itself wouldn't attach. The
  worst case for a mis-declared `Depends:` is a suppressed diagnostic for a real
  typo that happens to match a depended-package export — identical to the
  existing `import(pkg)` exposure, and the user explicitly declared the
  dependency.
- **Self-reference.** A valid DESCRIPTION cannot `Depends:` on itself, but a
  malformed one mid-edit could. The `pkg != ws.name` guard drops it so we never
  query a stale installed package of the package's own name. `R` is filtered and
  empty/blank fields yield no entries (`parse_depends_value`).
- **Base packages in `Depends:`** (e.g. `methods`, `utils`, `stats`). These are
  attached at runtime, so treating them as unqualified-export sources is correct
  and harmless — their exports (e.g. `setClass`, `head`) are genuinely available.
  This is the same as listing them in `import()`.
- **Exports unavailable.** If the depended package's exports can't be resolved
  (not installed, not in repo-db / names-db), the diagnostic behavior is
  unchanged from `import(pkg)` of an unresolvable package — raven can only
  suppress symbols it can enumerate. Out of scope.
