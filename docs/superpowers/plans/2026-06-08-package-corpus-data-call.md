# Plan: `data()` dataset-binding recognizer (corpus FP Tier 5)

## Goal
Resolve the false positives where a script/test does `data(foo)` and then uses
`foo`, e.g. MASS `inst/scripts/ch0*.R` (`library(MASS); data(hills); …hills…`)
and survival `tests/*.R` (`data(mgus2); …mgus2…`). These are a large share of
the remaining "test/script scope" known-FP bucket.

## Key reframe (why this is small)
The original Tier 5 framing assumed we needed new package-state infrastructure
to expose each package's `data/` directory into scope resolution. Investigating
the seams shows a much smaller, precedent-following approach:

**`data(foo)` is a runtime-binding call, exactly like `load("foo.rda")` —
which Raven already models.** `cross_file/scope.rs` has a family of
runtime-binding recognizers wired into `compute_artifacts`:
`try_extract_assign_call` (`assign("x", …)`), `try_extract_literal_load_call_definition`
(`load("x.rda")`), `try_extract_set_generic_definition`, and
`try_extract_text_connection_definition`. Each pushes a `ScopeEvent::Def` and an
`exported_interface` entry.

Add one more: `try_extract_data_call_definition`. `data(a, b)` binds `a` and `b`
in the calling environment from the `data()` call onward. This:
- needs **no** `data/` directory knowledge — it models `data()`'s binding
  behavior the same way `load()` models its file stem (neither verifies the
  object actually exists; both deliberately err toward no-false-positive);
- works in **any** file (plain `tests/*.R`, `inst/`, `demo/`, `R/`), sidestepping
  the fact that `append_package_contribution` only injects package scope for
  `R/` and `tests/testthat|testit/`;
- handles **same-package and cross-package** `data()` uniformly (a MASS script's
  `data(hills)` and survival's own `data(lung)` are identical shapes);
- composes with existing cross-file resolution: the `Def` lands in the file's
  timeline, so a `data()` in a sourced parent is already visible to children.

## Implementation

### 1. Recognizer (`crates/raven/src/cross_file/scope.rs`)
Add `try_extract_data_call_definitions(node, line_index, uri) -> Vec<ScopedSymbol>`
(plural — one `data()` call can bind several names) and wire it into
`compute_artifacts` next to the other call recognizers, pushing a `Def` per
returned symbol with `visible_from` at the call's end position.

Recognize `data(...)` where the callee is `data` (or `utils::data`). For each
**positional** argument:
- bare identifier → bind that name (`data(lung)` → `lung`);
- string literal → bind its content (`data("lung")` → `lung`).

Skip **named** arguments — `package=`, `lib.loc=`, `envir=`, `verbose=`,
`overwrite=`. Defer the rarer `list = c("a","b")` form for v1 (document it as a
known gap; it can be added later by reading a character-vector `list=` arg).

`data()` with no positional args lists datasets and binds nothing → return empty.

Reuse `string_literal_content` and the UTF-16 position helpers already in the
file. Mirror `try_extract_text_connection_definition` for structure.

### 2. Tests (red→green, in `scope.rs` tests)
- `data(lung)` → `exported_interface` contains `lung`.
- `data("lung")` → contains `lung`.
- `data(lung, package = "survival")` → contains `lung`, not `package`/`survival`.
- `data(a, b, c)` → contains all three.
- `data()` → binds nothing.
- visibility: a use *before* the `data()` call is still unbound (the `Def`'s
  `visible_from` is the call end), matching the other recognizers.

### 3. Corpus re-run + fixture regeneration
- `RAVEN_CORPUS_GROUPS=base,recommended RAVEN_CORPUS_ALLOW_UNCLASSIFIED=1` to
  capture the new observed set.
- Regenerate `known_false_positives.toml` keeping only still-observed entries
  (the data()-driven ones drop out). Confirm **zero** accepted-reals went stale.
- Run strict mode (`RAVEN_CORPUS_GROUPS=base,recommended`) to confirm green.

### 4. Docs
- `docs/diagnostics.md`: add `data(name)` to the "runtime binding recognizers"
  list next to `assign`/`load`/`textConnection`.
- `docs/superpowers/plans/2026-06-08-package-corpus-fp-reexamination.md`: record the resolved count and
  reclassify the Tier 5 entry from "deferred" to "done (recognizer approach)".

## Expected impact
The MASS `inst/scripts/*.R` chapters and survival/cluster/nlme `tests/*.R`
data-driven FPs. Precise count comes from the re-run. Will **not** touch:
- Matrix `tests/*.R` test-helper symbols (`assert.EQ.mat`, `showProc.time`)
  loaded via `source(system.file("test-tools-Matrix.R"))` — separate, harder
  (dynamic `system.file()` path; out of reach without install).
- `attach()`, `eval(parse())` — fundamentally dynamic.

## Risks / decisions
- **Generosity vs. precision.** Like `load()`, this binds the name without
  proving the dataset exists, so `data(typo)` won't be flagged. This is the
  established trade-off for the recognizer family (no false positives over
  catching every typo). If a stricter mode is ever wanted, a `data/`-directory
  cross-check could gate the binding — but that reintroduces the heavier
  infrastructure and is explicitly out of scope here.
- **`list=` form** deferred; document as a known minor gap.
- Keep the recognizer to the `data` callee only; do not generalize to arbitrary
  loaders.

## Out of scope
Package `data/` directory indexing, `LazyData: true` always-available datasets,
cross-package dataset metadata, and the Matrix `system.file()` test-helper case.
