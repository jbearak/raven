# Data viewer: View() support for vectors, scalars, and flat lists

**Date:** 2026-06-27
**Status:** Approved (design)

## Problem

Raven's `View()` override renders `data.frame` (incl. `tibble` /
`data.table`) and `matrix`. Every other class raises:

```r
> View(1)
Error: Can't `View()` an object of class `numeric`
```

The objects users most often want to glance at — a scalar, a (named)
vector, a single labelled column pulled from an import
(`View(mydata$education)`), a factor (`View(iris$Species)`), or a flat
list of columns — all error today.

The fix is almost entirely R-side: the webview, Arrow reader,
sort/filter/format, copy, and HTTP wire format already render any
data.frame. We only need to convert an accepted vector / scalar / flat
list into a data.frame on the R side, in front of the existing pipeline.
**No webview, wire-format, or Arrow-reader changes.**

## Scope

In scope — newly `View()`-able:

- **Atomic vectors**: `numeric` / `integer` / `double`, `character`,
  `logical`, `complex`, `raw`. (`complex` / `raw` aren't Arrow-native;
  the existing per-column fallback stringifies them, same as today for
  unrecognized data.frame columns.)
- **Scalars** — handled as the length-1 case of the vector path, not
  special-cased.
- **Standalone `factor` vectors** (e.g. `iris$Species`).
- **Standalone `haven_labelled` vectors** (e.g. one column extracted from
  a `haven::read_dta` import).
- **Flat (non-recursive) lists** — a list whose every element is a
  scalar/vector (atomic, factor, `haven_labelled`, or `NULL`), with no
  element that is itself a list, data.frame, or multi-dimensional object.

Out of scope — keep erroring with the existing message:

- Nested / recursive lists (any element is a list or data.frame).
- List elements that are matrices/arrays (have a `dim`), S4 objects,
  environments, functions, etc.
- Bare S4 objects, environments, functions, `NULL` itself, and anything
  else not in the accepted set.

## Design

All changes live in `.raven_view` in
`editors/vscode/src/plot/r-bootstrap-profile.ts`. The current shape —

```r
if (!is.data.frame(x) && !is.matrix(x)) stop("Can't `View()` ...")
df <- if (is.matrix(x)) { ...matrix... } else { x }
```

becomes a single if/else-if chain that either produces `df` or stops:

```r
df <- if (is.matrix(x)) {
    ...existing matrix handling...
} else if (is.data.frame(x)) {
    x
} else if (<vector accepted>) {
    <build name/value frame>          # see "Vectors / scalars"
} else if (<list accepted>) {
    <build element-as-column frame>   # see "Flat lists"
} else {
    stop("Can't `View()` an object of class `",
         paste(class(x), collapse = "/"), "`", call. = FALSE)
}
```

Branch order matters: `matrix` and `data.frame` are tested first (a
data.frame is also a list), then the vector branch, then the list
branch. Everything that produces `df` then falls into the existing
per-column `.raven_encode_col` loop and the existing Arrow-write + POST
path, untouched.

### Vectors / scalars

**Accept** when `is.null(dim(x))` and
(`is.atomic(x) || is.factor(x) || inherits(x, "haven_labelled")`). The
`dim` guard keeps matrices/1-D arrays out of this branch. Plain atomic
vectors carry no labels, so `factor` / `haven_labelled` are named
explicitly only to admit those standalone classes.

**Shape — a leading `name` column (when named) + a value column:**

| `names(x)` | Columns |
| --- | --- |
| non-NULL | `name` (character) + the value column |
| NULL | the value column only |

- `name` column header is **always** `name` (singular), mirroring the
  matrix `rowname` leading-column treatment — a named vector's names play
  the same role as matrix rownames, so they render as a leading column,
  not a tooltip.
- Value column header: `value` when `length(x) == 1`, else `values`.
- Row count = `length(x)`.

**Construction** uses a **bare list given the `data.frame` class** (not
`data.frame(value = x)`), so the value vector's class/attributes —
factor levels, `haven_labelled` `labels` — survive into the existing
`.raven_encode_col` pass and the webview Labels toggle, with zero new
code. Set `names()`, `class(df) <- "data.frame"`, and
`attr(df, "row.names") <- .set_row_names(length(x))`.

**Rejected alternatives** (decided during brainstorming):

- *Expression-derived headers* (`names(x)` / `x` from
  `deparse(substitute(x))`): clean for a bare symbol but ugly for
  literals/calls (`View(c(1, 2, 3))` → a column headed `c(1, 2, 3)`),
  duplicates the panel title, and the canvas header cell is sized for a
  short name. Dropped in favor of the fixed generic `name` / `value(s)`.
- *Names on cell hover instead of a column*: the grid is Glide Data Grid
  (canvas — no DOM per-cell tooltip), so this would need a separate
  side-channel to ship the full names vector to the webview (fighting the
  stream-the-visible-window design) plus a custom tooltip overlay, and
  names would not be copyable/sortable/filterable and would be hidden
  until hovered. The column gives copy + sort + filter + visibility for
  free and matches the matrix precedent.

### Flat lists

**Accept** `x` when it is a list (data.frames are caught earlier),
`length(x) > 0`, and **every** element `el` satisfies:

```r
is.null(el) ||
((is.atomic(el) || is.factor(el) || inherits(el, "haven_labelled")) &&
 is.null(dim(el)))
```

If any element is itself a list, a data.frame, or has a `dim`
(matrix/array), or is otherwise unsupported, the list falls through to
the existing `Can't `View()` ...` error — this is the "non-recursive"
exclusion (`is.list(el)` catches both nested lists and data.frames).

**Shape — element-as-column table, NA-padded to the longest element:**

```r
View(list(a = 1:3, b = c("x", "y"), c = TRUE))
```

| a | b | c    |
| - | - | ---- |
| 1 | x | TRUE |
| 2 | y |      |
| 3 |   |      |

- One column per list element; row count `n = max(lengths(x))`
  (`0` if every element is empty).
- Each element keeps **its own type** — `a` integer, `b` character,
  `c` logical — so per-column sort/filter/format and the Labels toggle
  (for factor / `haven_labelled` elements) all work, exactly as for a
  data.frame. No stringifying.

**Per-column construction:**

- Pad each element to `n` via **positional indexing**: `el[seq_len(n)]`.
  Indexing past the end yields `NA` and preserves class — `factor[...]`
  keeps levels, `[.haven_labelled` keeps its `labels`. This is why we
  index rather than `length<-` (which can strip S3 attributes).
- `NULL` or length-0 elements → an all-`NA` column (`rep(NA, n)`,
  logical), since `NULL[seq_len(n)]` is `NULL`, not an NA vector.
- Build the columns into a bare list given the `data.frame` class +
  `.set_row_names(n)`, then fall into the existing `.raven_encode_col`
  loop.

**Column names:** from `names(x)`; any missing/`""` name is replaced by a
position-based `V<i>` and the full set passed through `make.unique`,
mirroring `as.data.frame(<unnamed list>)`.

### Vector-vs-list shape divergence (intentional)

A named vector and a list of scalars render differently, by design:

- `c(a = 1, b = 2)` → **2-row** `name`/`values` table (one variable with
  labelled entries).
- `list(a = 1, b = 2)` → **1-row, 2-column** table `a | b` (a collection
  of variables; matches `as.data.frame(list(a = 1, b = 2))`).

### Edge cases

- **Length-0 vector** (`integer(0)`): allowed; empty `values` column,
  `rows: 0`.
- **Partially-named vector** (`c(a = 1, 2)`): `names()` has `""` for
  unnamed slots → blank `name` cells.
- **Factor / `haven_labelled` standalone**: `names()` is typically NULL →
  single value column; class preserved → Labels toggle swaps codes for
  labels. Plain atomic vectors show no Labels button (existing toolbar
  logic hides it when no column is affected).
- **Empty list** `list()`: `length(x) == 0` → falls through to the error.
- **Panel name**: unchanged. `View(1)` → panel `1`; explicit second arg
  still wins.

## Testing

- `tests/bun/data-viewer-bootstrap-content.test.ts`: assert the bootstrap
  source contains the new vector and list branches, the bare-list /
  `.set_row_names` construction, the `name` + `value`/`values` header
  selection, the `el[seq_len(n)]` padding, and `make.unique` column
  naming (string-level checks, matching how this file already pins the
  View() override).
- `tests/bun/data-viewer-bootstrap-r-integration.test.ts` (runs the
  profile against a real R, gated on `HAS_R` / `HAS_ARROW`, capturing the
  `/view-data` POST): add cases that `View()` —
  - a named vector → columns `name`, `values`, `nrow == length`;
  - an unnamed vector → single `values` column;
  - a scalar → single `value` column, `nrow == 1`;
  - a factor and a `haven_labelled` vector → single value column, labels
    intact in the Arrow schema metadata (gate the `haven_labelled` case
    on `haven` via the existing `r_with(...)` helper);
  - a ragged flat list → element-as-column, `nrow == max(lengths)`, with
    NA padding and per-column types preserved;
  - a nested list → still errors.
  Assert the resulting Arrow file's column names, types, and row count.
- No webview/TS-grid test changes: the grid already renders arbitrary
  frames; nothing in its contract changes.

## Docs

- `docs/data-viewer.md` "What it shows": add atomic vectors, scalars,
  standalone factors, `haven_labelled` vectors, and flat lists.
  Document: the leading `name` column + `value`/`values` data column for
  vectors (and that the `name` column is dropped when `names()` is NULL);
  that the `name` column mirrors the matrix `rowname` leading column;
  the element-as-column, NA-padded table for lists; that nested/recursive
  lists are unsupported; and the intentional named-vector-vs-list shape
  divergence.

## Non-goals

- No nested/recursive list support. No names-on-hover. No
  expression-derived headers. No new settings. No webview, wire-format,
  Arrow-reader, or sort/filter/format/copy changes — this is purely a new
  R-side conversion in front of the existing pipeline.
