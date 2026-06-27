# Data viewer: View() support for vectors and scalars

**Date:** 2026-06-27
**Status:** Approved (design)

## Problem

Raven's `View()` override renders `data.frame` (incl. `tibble` /
`data.table`) and `matrix`. Every other class raises:

```r
> View(1)
Error: Can't `View()` an object of class `numeric`
```

Vectors and scalars are the most common objects users actually want to
glance at — a single labelled column pulled from an import
(`View(mydata$education)`), a factor (`View(iris$Species)`), or a plain
result vector. They all error today.

The fix is small and almost entirely R-side: the webview, Arrow reader,
sort/filter/format, copy, and HTTP wire format already render any
1-or-2-column frame. We only need to convert an accepted vector/scalar
into such a frame on the R side, *before* the existing acceptance gate.

## Scope

In scope — newly `View()`-able:

- Atomic vectors: `numeric` / `integer` / `double`, `character`,
  `logical`, `complex`, `raw`.
- Scalars (length-1 atomic vectors) — handled as the length-1 case of
  the vector path, not special-cased.
- Standalone `factor` vectors (e.g. `iris$Species`).
- Standalone `haven_labelled` vectors (e.g. a single column extracted
  from a `haven::read_dta` import).

Out of scope — keep erroring with the existing message:

- Lists (atomic-list / `list()`), S4 objects, environments, functions,
  and anything else not in the accepted set.
- Multi-dimensional objects (matrix/array) — already handled by the
  matrix branch, or excluded by the `dim()` guard below.

## Design

### Single new branch in `.raven_view`

All changes live in `.raven_view` in
`editors/vscode/src/plot/r-bootstrap-profile.ts`, inserted **between**
the matrix branch and the existing
`if (!is.data.frame(x) && !is.matrix(x)) stop(...)` gate.

### Acceptance gate

Accept `x` as a vector/scalar when **all** hold:

- `is.null(dim(x))` — excludes matrices and 1-D+ arrays, which must not
  fall through to this branch.
- `is.atomic(x) || is.factor(x) || inherits(x, "haven_labelled")`.

`is.factor` is called out explicitly because a factor is technically
atomic in storage but we want it accepted regardless of how `is.atomic`
treats it across R versions; `haven_labelled` likewise. Plain atomic
vectors carry no labels, so for them this is identical to "atomic".

Anything that is not a `data.frame`, not a `matrix`, and not accepted
here continues to hit the existing `stop("Can't `View()` ...")` path
unchanged.

### Frame construction (preserve class/attributes)

Build the frame as a **bare list given the `data.frame` class**, not via
`data.frame(values = x)`. `data.frame()` can coerce or strip a factor's
levels and a `haven_labelled`'s `labels` attribute; constructing the
list directly keeps the values vector's class and attributes intact so
the existing `.raven_encode_col` pass (which already understands factor
and `haven_labelled`) and the webview's Labels toggle work with zero new
code.

Construction:

- `n <- length(x)`.
- Determine headers (see below).
- If `names(x)` is non-NULL: column 1 = the names header, holding
  `as.character(names(x))`; column 2 = the values header, holding `x`
  unchanged.
- If `names(x)` is NULL: a single values-header column holding `x`
  unchanged.
- Assign `names()`, `class(df) <- "data.frame"`, and
  `attr(df, "row.names") <- .set_row_names(n)`.

Then fall into the existing per-column `.raven_encode_col` loop and the
existing Arrow-write + POST path. No changes below this point.

### Header naming

Driven by length (`n`), per the approved rule:

| Case | Names present | Names absent |
| --- | --- | --- |
| `n == 1` | `name`, `value` | `value` |
| `n != 1` | `names`, `values` | `values` |

### Edge cases

- **Length-0 vectors** (`integer(0)`, `character(0)`): allowed, not an
  error. Renders an empty values column; the toolbar shows `rows: 0`.
  Header uses the `n != 1` (plural) form.
- **Partially-named vectors** (`c(a = 1, 2)`): `names()` is non-NULL with
  `""` for the unnamed slots; the names column shows empty strings for
  those rows. No special handling.
- **Factor / `haven_labelled` standalone**: `names()` is typically NULL,
  so these render as a single values column. The values column keeps its
  class through construction, so the Labels toggle swaps codes for level
  / value-label strings exactly as it does inside a data.frame. Plain
  atomic vectors show no Labels button (nothing to label) — existing
  toolbar logic already hides it when no column is affected.
- **Panel name**: unchanged. `View(1)` deparses to panel name `1`;
  `View(x)` to `x`; an explicit second arg still wins. No new logic.

## Testing

- `tests/bun/data-viewer-bootstrap-content.test.ts`: assert the bootstrap
  source contains the new acceptance branch and the bare-list /
  `.set_row_names` construction, and that the singular/plural header
  selection is present (string-level checks, matching how this file
  already pins the View() override).
- `tests/bun/data-viewer-bootstrap-r-integration.test.ts` (runs the
  profile against a real R, gated on `HAS_R` / `HAS_ARROW`, and captures
  the `/view-data` POST): add cases that `View()` a named vector, an
  unnamed vector, a scalar, a factor, and a `haven_labelled` vector, and
  assert the resulting Arrow file's column names and row count match the
  table above. Gate the `haven_labelled` case on `haven` availability
  using the existing `r_with(...)` helper, consistent with how the suite
  guards optional packages.
- No webview/TS-grid test changes: the grid already renders arbitrary
  1-or-2-column frames; nothing in its contract changes.

## Docs

- `docs/data-viewer.md` "What it shows": add atomic vectors, scalars,
  standalone factors, and `haven_labelled` vectors, documenting the
  names/values (and singular `name`/`value` for length-1) layout, the
  drop of the names column when `names()` is NULL, and that the Labels
  toggle applies to a standalone factor / labelled vector.

## Non-goals

- No list support. No new settings. No webview, wire-format, Arrow-reader,
  sort/filter/format/copy changes — this is purely a new R-side
  conversion in front of the existing pipeline.
