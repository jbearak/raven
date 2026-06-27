# Data viewer: clearer error message for un-`View()`-able lists

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

## Scope

In scope: the list branch of the type-dispatch in `.raven_view`
(`editors/vscode/src/plot/r-bootstrap-profile.ts`, currently the
combined `else if (is.list(x) && length(x) > 0L && all(...))` condition
at lines 405–411). Message wording only — what is and isn't
`View()`-able does not change.

Out of scope: the conversion logic (`.raven_list_elem_ok`,
`.raven_list_to_df`, `.raven_vector_to_df`), the vector branch, and
everything downstream (encode / Arrow write / POST / webview). The set
of accepted/rejected objects is **identical** before and after — only
the rejection *message* for lists changes.

## Design

All changes live in `.raven_view`. Replace the single combined list
condition + shared `else` with a dedicated list branch that either
produces `df` or stops with a tailored message. A `data.frame` is also a
list, but it is caught by the earlier `is.data.frame(x)` branch, so this
branch only ever sees **non-data.frame** lists.

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
- **Everything else** (functions, environments, `NULL`, `raw`, S4,
  multi-dim arrays): unchanged —
  `` Can't `View()` an object of class `<class>` ``.

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
  list rewording did **not** leak into the generic path.

`tests/bun/data-viewer-bootstrap-content.test.ts` (string-level pin of
the bootstrap source):

- **Add** assertions that the source contains the new list strings:
  `` Can't `View()` an empty list. ``,
  `` Can't `View()` this list: ``, and
  `Only flat lists (every element a vector) are supported.`.
- **Keep** the existing "Positron-style message for unsupported types"
  test — the `else` branch still contains
  `` Can't `View()` an object of class ``.

## Docs

`docs/data-viewer.md` "Other classes" bullet: the example block uses
`View(sum)` (a function), which is unaffected. Add a one-line note that
nested/recursive lists report *which* element is unsupported rather than
blaming the `list` class, so the doc matches the behavior.

## Non-goals

No change to which objects are `View()`-able. No enumerating every
offending element. No change to the conversion helpers, the vector
branch, or anything downstream of `df`.
