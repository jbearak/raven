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

The fix is R-side only, in one place: the type-dispatch in `.raven_view`.
Today a hard gate (`r-bootstrap-profile.ts:303`) rejects everything that
is not a data.frame/matrix before any conversion can run; we replace
that gate with a conversion chain that turns an accepted vector / scalar
/ flat list into a data.frame. Everything downstream —
`.raven_encode_col`, `.raven_write_arrow`, the `/view-data` POST, and the
entire webview / wire-format / Arrow-reader path — is **untouched**,
because it already renders any data.frame.

## Scope

In scope — newly `View()`-able:

- **Atomic vectors**: `numeric` / `integer` / `double`, `character`,
  `logical`, `complex`, plus classed atomic vectors the existing encoder
  already handles — `Date`, `POSIXct`. (`complex` isn't Arrow-native; the
  existing per-column fallback stringifies it, same as today for
  unrecognized data.frame columns.)
- **`raw` is excluded.** A raw vector has no `NA`, so out-of-bounds
  indexing during ragged-list padding yields `00` bytes rather than a
  missing cell — a silent-wrong result. To keep one rule across the
  vector and list branches, `raw` is rejected in both; `View(raw_vec)`
  keeps erroring.
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

**Accept** when `!is.null(x)` and `is.null(dim(x))` and `!is.raw(x)` and
(`is.atomic(x) || is.factor(x) || inherits(x, "haven_labelled")`). The
`!is.null(x)` guard is required because `is.atomic(NULL)` is `TRUE` on
R < 4.4 (it became `FALSE` in 4.4.0), so without it `View(NULL)` would
wrongly enter this branch; instead it must fall through to the error. The
`dim` guard keeps matrices/1-D arrays out of this branch; `!is.raw(x)`
enforces the raw exclusion above. Plain atomic vectors carry no labels,
so `factor` / `haven_labelled` are named explicitly only to admit those
standalone classes. `Date` / `POSIXct` are atomic with no `dim`, so they
are admitted here and rendered by the existing encoder.

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
 is.null(dim(el)) && !is.raw(el))
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

- Pad each **non-NULL** element to `n` via **positional indexing**:
  `el[seq_len(n)]`. Indexing past the end yields `NA` and **preserves
  class** — `factor[...]` keeps levels, `[.haven_labelled` keeps its
  `labels`. Crucially this also covers length-0 *typed* elements: a
  `factor(character(), levels = "a")` or `integer(0)` element indexed to
  `n` becomes a class-preserving NA column (or a zero-row class-preserving
  column when `n == 0`), so its levels/labels survive into
  `.raven_encode_col`. We index rather than `length<-` (which can strip
  S3 attributes) or `rep(NA, n)` (which would erase type).
- **Only a literal `NULL` element** → `rep(NA, n)` (logical). `NULL` has
  no type to preserve, and `NULL[seq_len(n)]` is `NULL`, not an NA vector.
- Build the columns into a bare list given the `data.frame` class +
  `.set_row_names(n)`, then fall into the existing `.raven_encode_col`
  loop.

**Column names:** start from `names(x)`, or — when `names(x)` is `NULL`
(a fully unnamed list, not a character vector with empty slots) — a
length-`length(x)` vector of `""`. Replace every `""` / `NA` slot with a
position-based `V<i>`, then pass the whole vector through `make.unique`.
This mirrors `as.data.frame(<unnamed list>)`. (Column count is
`length(x)`, independent of the row count `n`.)

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
  - a flat list with a **length-0 typed element** (e.g.
    `list(a = 1:3, f = factor(character(), levels = "a"))`) → the `f`
    column is still a factor (levels intact), all-NA, not a logical
    column — guards finding #2;
  - an **all-empty** typed list (e.g.
    `list(f = factor(character(), levels = "a"))`) → a zero-row factor
    column, levels intact — guards finding #3;
  - a list with a **`NULL` element** → an all-NA column, no crash;
  - a fully **unnamed** list → synthesized `V1..Vk` column names;
  - a `raw` vector and a flat list containing a `raw` element → both
    **error** (raw is excluded);
  - `View(NULL)` → **errors** (must not enter the vector branch on
    R < 4.4 where `is.atomic(NULL)` is `TRUE`);
  - a factor with a literal **`NA` level** (`factor(x, exclude = NULL)`)
    vs. a factor with `NA` *values* → the level/value distinction
    round-trips correctly through the schema metadata.
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
  lists and `raw` vectors are unsupported; and the intentional
  named-vector-vs-list shape divergence.

## Non-goals

- No nested/recursive list support. No `raw`-vector support. No
  names-on-hover. No expression-derived headers. No new settings. The
  only change is the `.raven_view` type-dispatch gate; `.raven_encode_col`,
  the Arrow write, the `/view-data` POST, and the entire webview /
  wire-format / Arrow-reader / sort / filter / format / copy path are
  untouched.
