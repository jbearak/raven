# Data viewer: clearer error messages for un-`View()`-able lists and arrays

**Date:** 2026-06-27
**Status:** Approved (design)

## Problem

Since the vectors/scalars/flat-lists feature
(`58b38a61`, spec `2026-06-27-data-viewer-vectors-scalars-design.md`),
a **flat** list — every element a scalar/vector — is `View()`-able. But a
list that is empty or has a non-flat element still falls through to the
generic type-dispatch error in `.raven_view`:

```r
> View(list(a = 1, b = list(2)))
Error: Can't `View()` an object of class `list`
```

This message blames the **class** (`list`), which reads as "lists aren't
supported" — yet most lists view fine. The real reason is the list's
**contents** (a nested list / data.frame / matrix element, etc.) or that
it is empty. The class-based message is correct for genuinely
unsupported classes (functions, environments, `NULL`, `raw`, S4) but
wrong for lists.

**The same defect affects arrays.** A 2-D array is a matrix
(`is.matrix()` is true for any dim-length-2 object) and already renders.
But an array whose `dim` length is **not** 2 falls through:

```r
> View(array(1:8, c(2, 2, 2)))
Error: Can't `View()` an object of class `array`
```

The real reason is **dimensionality** — the data viewer shows
2-dimensional tables, and a 3-D+ array has more dimensions than a table
can hold. The class-based message hides that. A **1-D** array
(`array(1:3)`) is rejected for the opposite reason: it is effectively a
vector, but the vector branch's `is.null(dim(x))` guard excludes it for
having a `dim` at all.

## Scope

In scope: the type-dispatch in `.raven_view`
(`editors/vscode/src/plot/r-bootstrap-profile.ts`, lines ~393–411):

1. The **list branch** — split the combined
   `else if (is.list(x) && length(x) > 0L && all(...))` into a dedicated
   `is.list(x)` branch with tailored error messages. Message wording
   only; the set of `View()`-able lists is unchanged.
2. The **vector branch** — relax its `dim` guard so a **1-D array** is
   accepted and rendered as a vector (a behavior change: `array(1:3)`
   becomes `View()`-able).
3. A new **`>2`-dimensional branch** — arrays/tables with a `dim` of
   length ≥ 3 get a dimensionality-aware message instead of the
   class-based one.

Out of scope: the conversion-to-data.frame helpers themselves
(`.raven_list_elem_ok`, `.raven_list_to_df`, `.raven_vector_to_df`) and
everything downstream of `df` (encode / Arrow write / POST / webview).
The webview renders any data.frame; nothing in its contract changes.

## Design

All changes live in `.raven_view`'s type-dispatch chain. The order is:
`matrix` → `data.frame` → **vector (incl. 1-D array)** → **list** →
**`>2`-D array** → generic `else`. Branch order is load-bearing:
`matrix`/`data.frame` first (a data.frame is also a list), then the
vector branch (so a 1-D array is treated as a vector before the array
branch can see it), then the list branch, then the dimensionality branch
catches the remaining dim-≥3 arrays/tables, and finally the generic
`else`.

### Vector branch — accept 1-D arrays

Today the vector branch requires `is.null(dim(x))`, which rejects any
object carrying a `dim` — including a 1-D array, which is effectively a
vector. Relax the guard to `length(dim(x)) <= 1L` (true for a plain
vector, whose `dim` is `NULL` → `length(NULL)` is `0`, **and** for a 1-D
array, whose `dim` has length 1; false for a matrix's length-2 `dim` and
a 3-D+ array's length-≥3 `dim`). The `!is.null(x)` guard stays — it must
still come first because `is.atomic(NULL)` is `TRUE` on R < 4.4 and
`length(dim(NULL))` is `0 <= 1`.

A 1-D array's `dim`/`dimnames` must be stripped before it flows into
`.raven_vector_to_df` (which calls `unname(x)` and reads `names(x)` —
`unname` drops names but keeps `dim`, and a column with a `dim` attribute
would break the data.frame construction). Setting `dim(x) <- NULL`
removes `dim` **and** `dimnames` while preserving the underlying type and
any non-dim attributes (e.g. a factor's `levels`/`class`). Carry the 1-D
array's `dimnames[[1]]` over to `names(x)` first, so a named 1-D array
keeps its names as the leading `name` column:

```r
} else if (!is.null(x) && length(dim(x)) <= 1L && !is.raw(x) &&
           (is.atomic(x) || is.factor(x) || inherits(x, "haven_labelled"))) {
    if (length(dim(x)) == 1L) {
        dn <- dimnames(x)
        dim(x) <- NULL                       # also drops dimnames
        if (!is.null(dn)) names(x) <- dn[[1L]]
    }
    .raven_vector_to_df(x)
```

### List branch

Replace the single combined list condition + shared `else` with a
dedicated list branch that either produces `df` or stops with a tailored
message. A `data.frame` is also a list, but it is caught by the earlier
`is.data.frame(x)` branch, so this branch only ever sees
**non-data.frame** lists.

```r
} else if (is.list(x)) {
    if (length(x) == 0L) {
        stop("Can't `View()` an empty list.", call. = FALSE)
    }
    ok <- vapply(x, .raven_list_elem_ok, logical(1L))
    if (!all(ok)) {
        i <- which(!ok)[[1L]]                 # first offender
        nm <- names(x)
        label <- if (!is.null(nm) && !is.na(nm[[i]]) && nzchar(nm[[i]])) {
            paste0("element `", nm[[i]], "`")
        } else {
            paste0("element ", i)
        }
        stop("Can't `View()` this list: ", label, " has class `",
             paste(class(x[[i]]), collapse = "/"),
             "`. Only flat lists (every element a vector) are supported.",
             call. = FALSE)
    }
    .raven_list_to_df(x)
} else if (length(dim(x)) > 2L) {
    stop("Can't `View()` an array with ", length(dim(x)),
         " dimensions; the data viewer shows 2-dimensional tables only.",
         call. = FALSE)
} else {
    stop("Can't `View()` an object of class `",
         paste(class(x), collapse = "/"), "`", call. = FALSE)
}
```

### Message wording

- **Empty list** (`list()`):
  `` Can't `View()` an empty list. ``
- **Non-flat list**, named offender (`View(list(a = 1, b = list(2)))`):
  `` Can't `View()` this list: element `b` has class `list`. Only flat lists (every element a vector) are supported. ``
- **Non-flat list**, unnamed / blank-named offender
  (`View(list(1, list(2)))`):
  `` Can't `View()` this list: element 2 has class `list`. Only flat lists (every element a vector) are supported. ``
- **`>2`-D array / table** (`View(array(1:8, c(2, 2, 2)))`):
  `` Can't `View()` an array with 3 dimensions; the data viewer shows 2-dimensional tables only. ``
  The dim count is interpolated, and is always ≥ 3 here (1-D arrays are
  handled by the vector branch and 2-D arrays by the matrix branch), so
  the noun is always plural — no singular/plural handling needed.
- **Everything else** (functions, environments, `NULL`, `raw`, S4):
  unchanged — `` Can't `View()` an object of class `<class>` ``.

Wording notes:

- **"has class `X`"** (not the brainstorm preview's "is a X"): keeps the
  sentence grammatical for every offender type — "is a raw" / "is a
  environment" / "is a matrix/array" are awkward or wrong, and the
  backtick-quoted class matches the style of the rest of the message and
  the trailing `else`.
- **First offender only.** `which(!ok)[[1L]]` — reporting one concrete
  element is enough to point the user at the problem; enumerating all is
  noise.
- **`names(x)` guard.** A fully unnamed list has `names(x) == NULL`;
  `NULL[[i]]` errors, so the `!is.null(nm)` check must come first (it is
  the left operand of `&&`, so `nm[[i]]` is never evaluated when `nm` is
  `NULL`). A partially-named list has `""`/`NA` slots → fall to the
  positional `element <i>` form.
- **Offender class** uses `paste(class(x[[i]]), collapse = "/")` (mirrors
  the trailing `else`), so e.g. a matrix element reads
  `` has class `matrix/array` ``.

The `else` (true non-list) branch is byte-for-byte the existing message,
so any object that is not a matrix / data.frame / accepted vector /
list keeps its current behavior, including `View(NULL)` and
`View(as.raw(1:3))`.

## Testing

`tests/bun/data-viewer-bootstrap-r-integration.test.ts` (real R, gated on
`HAS_R`/`HAS_ARROW`, captures the `/view-data` POST):

- **Update** `View(nested list)` (`View(list(a = 1, b = list(1, 2)))`):
  assert `r.stderr` contains the new
  `` Can't `View()` this list: `` text **and** names the offender —
  `` element `b` has class `list` ``; still posts nothing.
- **Add** empty list `View(list())`: stderr contains
  `` Can't `View()` an empty list. ``; posts nothing.
- **Add** unnamed offender `View(list(1, list(2)))`: stderr contains
  `element 2 has class `list``; posts nothing.
- **Keep unchanged** `View(as.raw(1:3))` and `View(NULL)`: these hit the
  `else` branch, so they still contain
  `` Can't `View()` an object of class `` — these tests guard that the
  list/array rewording did **not** leak into the generic path.
- **Add** 1-D array `View(array(1:3))`: posts `/view-data`; the resulting
  Arrow file has a single `values` column with 3 rows (the array is
  rendered as a vector, no error).
- **Add** named 1-D array
  `View(array(1:2, dimnames = list(c("a", "b"))))`: posts; the Arrow file
  carries a leading `name` column (`a`, `b`) plus the value column —
  guards the `dimnames[[1]]` → `names` carry-over.
- **Add** 3-D array `View(array(1:8, c(2, 2, 2)))`: stderr contains
  `` Can't `View()` an array with 3 dimensions ``; posts nothing.

`tests/bun/data-viewer-bootstrap-content.test.ts` (string-level pin of
the bootstrap source):

- **Update** the "atomic vectors / scalars via a !is.null + !is.raw +
  dim guard" test: the pinned `is.null(dim(x))` string becomes
  `length(dim(x)) <= 1L` (the relaxed guard). Keep the `!is.null(x)`,
  `!is.raw(x)`, and `is.atomic … is.factor … haven_labelled` assertions.
- **Add** assertions that the source contains the new list strings:
  `` Can't `View()` an empty list. ``,
  `` Can't `View()` this list: ``, and
  `Only flat lists (every element a vector) are supported.`.
- **Add** an assertion for the array message
  (`the data viewer shows 2-dimensional tables only.`) and the
  `length(dim(x)) > 2L` branch guard.
- **Keep** the existing "Positron-style message for unsupported types"
  test — the `else` branch still contains
  `` Can't `View()` an object of class ``.

## Docs

`docs/data-viewer.md`:

- "What it shows" — note that a 1-D array renders like a vector.
- "Other classes" bullet: the example block uses `View(sum)` (a
  function), which is unaffected. Add a one-line note that
  nested/recursive lists report *which* element is unsupported (rather
  than blaming the `list` class) and that arrays with more than two
  dimensions report their dimension count, so the doc matches behavior.

## Non-goals

No nested/recursive list support. No flattening / slicing of `>2`-D
arrays into 2-D pages. No enumerating every offending list element. No
change to the conversion helpers or anything downstream of `df`.
