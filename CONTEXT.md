# Raven package model

Glossary for how Raven resolves package export names without a running R (the tiered package database). This file defines vocabulary only; the mechanics live in `docs/package-database.md` and `crates/raven/src/package_db/`.

## Language

**Base-7**:
The seven base packages R attaches by default, which Raven treats as always in scope with no `library()` call: base, methods, utils, grDevices, graphics, stats, datasets.
_Avoid_: "base packages" (ambiguous), "base/recommended" (that phrase also covers recommended packages, which are not always attached).

**Recommended packages**:
Packages installed alongside R but not attached by default (MASS, Matrix, survival, …). They require `library()` and resolve like any other ecosystem package, never through the always-in-scope base set.

**Dataset export**:
A data object a package ships (e.g. `mtcars`, `flights`) that appears in neither `export()` nor the namespace export set. Tracked separately from ordinary exports at every tier, because that separation is knowable for the whole ecosystem.
_Avoid_: folding datasets into "exports".

**Export kind**:
Whether an ordinary (non-dataset) export is a function or a plain value. Deliberately *not* tracked for package exports, because the ecosystem source (r-universe) supplies export names without kind. Distinct from dataset-vs-non-dataset, which is tracked.
