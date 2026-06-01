# Raven package model

Glossary for how Raven resolves package export names without a running R (the tiered package database). This file defines vocabulary only; the mechanics live in `docs/package-database.md` and `crates/raven/src/package_db/`.

## Language

**Base-7**:
The seven base packages R attaches by default, which Raven treats as always in scope with no `library()` call: base, methods, utils, grDevices, graphics, stats, datasets. These are 7 of R's **14 base-priority packages** (`installed.packages(priority="base")`); the other 7 — compiler, grid, parallel, splines, stats4, tcltk, tools — ship with every R install but require an explicit `library()` to attach.
_Avoid_: "base packages" for the 7 (R reserves that term for all 14 priority=base packages); "base/recommended" (that phrase also covers recommended packages, which are not always attached).

**Base-priority (14)**:
All packages R ships with priority `"base"`: the default-attached Base-7 plus compiler, grid, parallel, splines, stats4, tcltk, tools. Raven embeds the export/dataset floor for **all 14** so `library(grid)` etc. resolve offline (no R, no `names.db`); only the Base-7 are always in scope, while the other 7 resolve only after an explicit `library()` call.

**Recommended packages**:
Packages installed alongside R but not attached by default (MASS, Matrix, survival, …). They require `library()` and resolve like any other ecosystem package, never through the always-in-scope base set.

**Dataset export**:
A data object a package ships (e.g. `mtcars`, `flights`) that appears in neither `export()` nor the namespace export set. Tracked separately from ordinary exports at every tier, because that separation is knowable for the whole ecosystem.
_Avoid_: folding datasets into "exports".

**Export kind**:
Whether an ordinary (non-dataset) export is a function or a plain value. Deliberately *not* tracked for package exports, because the ecosystem source (r-universe) supplies export names without kind. Distinct from dataset-vs-non-dataset, which is tracked.
