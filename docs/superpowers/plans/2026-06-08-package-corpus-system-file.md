# Plan: resolve `source(system.file(...))` (corpus FP follow-up)

## Goal
Resolve false positives where a script/test sources a helper file via
`source(system.file("helper.R", package = "P"))` and then uses the helper's
definitions. Dominant case: Matrix `tests/*.R` (`source(system.file("test-tools.R",
package = "Matrix"))` defining `assert.EQ.mat`, `showProc.time`, `isValid`,
`identical3`, …), and the analogous cluster/other recommended-package helpers.

## Key correction
An earlier assessment called cross-package `system.file()` "out of reach." That
is wrong for **installed** packages. `system.file("X", package = "P")` is just a
search of `.libPaths()` for `<libdir>/P/X`, and Raven already retains the library
directories: `PackageLibrary { lib_paths: Vec<PathBuf> }`, exposed via
`lib_paths()` (`crates/raven/src/package_library.rs`). Base and recommended
packages are present in any R installation, so the path resolves. The only truly
unreachable case is a non-workspace package that is **not installed** and has no
metadata — the same condition under which Tier 1 export metadata is also absent.

## Resolution algorithm
`system.file(part1, part2, …, package = P [, mustWork=…])` → join the positional
**string-literal** parts with `/` to form `<rel>`. Resolve `<rel>` to a real file:

1. **`P == workspace package`** (DESCRIPTION `Package:`, via
   `parse_dcf_field_pub`): `<root>/inst/<rel>`. Source-tree layout keeps the
   `inst/` prefix; version-matched; works with no R installed.
2. **`P` installed**: for each `lib_path`, test `<lib_path>/P/<rel>`; first hit
   wins. Installed layout has `inst/` **flattened** to the package root, so there
   is **no** `inst/` prefix here. (This branch also covers `P == self` when the
   workspace isn't rooted at the package, e.g. a single open file.)
3. **neither** → unresolved; leave the `source()` unresolved exactly as today
   (degrade gracefully, no behavior change).

Note the prefix difference between branches 1 and 2 (`inst/` vs none) — it is the
crux and must be covered by tests.

## Implementation

### 1. Path-resolver extension (`crates/raven/src/cross_file/`)
`source()` path resolution currently handles string-literal paths
(`source_detect.rs` + `path_resolve.rs`). Extend the argument evaluator so a
`system.file(...)` **call** in the `source()` path position is statically
evaluated to a filesystem path using the algorithm above, then handed to the
existing source-resolution / cross-file machinery (which already reads the target
file, computes its `ScopeArtifacts`, and contributes its top-level defs to the
sourcing file). Most of the work is the static evaluator + the two-layout
mapping; the cross-file contribution is reused, not rebuilt.

Inputs the evaluator needs:
- the workspace package name (DESCRIPTION `Package:`);
- the library paths (`PackageLibrary::lib_paths()`).
Thread these into the resolver (or read them from the snapshot already available
to diagnostics).

Handle only **string-literal** positional parts and a literal `package=`; bail
(unresolved) on computed/variable arguments. Ignore `mustWork`, `lib.loc`,
`fsep` for v1 (document `lib.loc` as a minor gap).

### 2. Tests (red→green)
- Same-package: workspace `Matrix` with `inst/test-tools.R` defining `f`; a file
  `source(system.file("test-tools.R", package = "Matrix"))` then `f()` → `f`
  resolves; `inst/` prefix used.
- Installed cross-package: point a fake `lib_path` at a temp dir containing
  `P/helper.R` (no `inst/`); `source(system.file("helper.R", package = "P"))`
  resolves against the libdir.
- Multi-part: `system.file("a", "b.R", package = "P")` → `.../a/b.R`.
- Unresolved: package neither self nor installed → `source()` stays unresolved,
  no panic, behavior unchanged.
- Non-literal arg (`system.file(x, package = "P")`) → unresolved.

### 3. Corpus re-run + fixture regeneration
Same as the `data()` plan: `RAVEN_CORPUS_GROUPS=base,recommended
RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1`, regenerate `known_false_positives.toml`
keeping only still-observed entries, confirm zero accepted-reals went stale, then
strict mode green. This should clear the bulk of the Matrix `tests/*.R`
helper-symbol FPs (the corpus runs with base+recommended installed locally).

### 4. Docs
- `docs/diagnostics.md`: note that `source(system.file("f", package = "P"))` is
  resolved (same-package via `inst/`, installed packages via library paths).
- `docs/superpowers/plans/2026-06-08-package-corpus-fp-reexamination.md`: record resolved count; correct the
  earlier "out of reach" characterization of `system.file()`.

## Interactions / caveats
- **Version skew (same-package).** If `P == self`, prefer the workspace
  `inst/<rel>` over an installed copy so the analyzed source and the helper match
  versions. Only fall back to `lib_paths` when not the workspace package (or the
  workspace isn't the package root).
- **Headless CI with no R.** No `lib_paths` → only the same-package `inst/`
  branch works. Consistent with Raven's existing conditional metadata behavior;
  not a regression.
- **Editor with a single open file** (workspace not the package root): branch 1
  may not apply; branch 2 resolves if installed. Degrade gracefully otherwise.
- Keep this scoped to the `system.file()` callee; do not generalize to arbitrary
  path-producing functions.

## Out of scope
Uninstalled non-workspace packages, `lib.loc=`/`fsep=` arguments, computed
(non-literal) `system.file()` arguments, and non-`source()` uses of
`system.file()` (e.g. `readRDS(system.file(...))` — not a scope concern).
