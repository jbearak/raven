# foreach iterator scope design

Date: 2026-06-06
Issue: https://github.com/jbearak/raven/issues/404

## Summary

Raven currently reports false undefined-variable diagnostics for iterator
variables inside `foreach` loops, for example:

```r
foreach(i = 1:10) %do% {
  print(i)
}
```

This regressed after the NSE/call-argument changes in #401 because `foreach` is
parsed as a call plus a special infix execution operator, not as a
`for_statement`. The iterator name is the named argument label in
`foreach(i = ...)`, while the loop body is the right-hand side of `%do%` or
`%dopar%`.

The fix should model named `foreach()` iterator arguments as scoped bindings
visible only inside the right-hand-side expression executed by `%do%` or
`%dopar%`. It must not suppress the foreach body wholesale: real undefined
symbols in the body still need diagnostics.

## User-visible behavior

Raven should recognize:

```r
foreach(i = 1:10, j = ys, .combine = c) %do% {
  i + j + typo
}

foreach(i = 1:10) %dopar% sqrt(i)
```

The named, non-control arguments to `foreach()` define iterator bindings for the
right-hand side only. In the examples above, `i` and `j` are visible inside the
RHS braced body or bare RHS expression.

Iterator names are limited to named `foreach()` arguments whose names are valid
identifier nodes and do not start with `.`. Dot-prefixed options such as
`.combine`, `.packages`, `.export`, `.noexport`, and `.verbose` are control
arguments, not iterator bindings.

Raven should continue checking:

- iterator value expressions, so `foreach(i = missing_vec) %do% i` reports
  `missing_vec`;
- control argument values, so `foreach(i = 1:3, .combine = missing_combine) %do% i`
  reports `missing_combine`;
- ordinary undefined symbols in the body, so `foreach(i = 1:3) %do% i + typo`
  reports `typo`.

The iterator bindings are not modeled after the foreach execution expression.
This is intentional for #404: the regression is about diagnostics inside the
RHS body, and `%do%`/`%dopar%` leakage semantics are subtle enough to keep out
of the minimal fix.

## Parser shape

With the pinned `tree-sitter-r`, `foreach(i = 1:10) %do% { print(i) }` parses
as:

- a top-level `binary_operator`;
- `lhs`: a `call` whose `function` is `identifier` text `foreach`;
- the infix operator token has kind `special` and text `%do%`;
- `rhs`: the executed expression, often a `braced_expression`;
- iterator `i`: the `name` field of an `argument` under the LHS call's
  `arguments` node.

`%dopar%` has the same shape with operator text `%dopar%`.

## Architecture

Add a small foreach execution recognizer shared by scope construction and
diagnostic collection. The recognizer should answer:

- whether a `binary_operator` is a foreach execution expression;
- whether the operator text is `%do%` or `%dopar%`;
- whether the LHS is a call to bare `foreach(...)` or a namespace-qualified
  `foreach::foreach(...)` / `foreach:::foreach(...)`;
- which LHS call arguments define iterator variables.

The recognizer should be syntax-based. It should not require live package
metadata. A same-named local function or package lookalike can be revisited if
it causes real-world false positives, but #404 is a regression in the standard
foreach idiom.

### Scope construction

In `crates/raven/src/cross_file/scope.rs`, add synthetic RHS-only scope events
for recognized foreach execution expressions. The event should cover the RHS
node's exact range and carry iterator symbols as parameters.

This mirrors the useful part of a `FunctionScope`: outer bindings remain visible
inside the RHS, iterator symbols are visible while the RHS is active, and
definitions made inside the RHS do not leak into the surrounding scope.

Use the iterator name node's position as the symbol definition location so
go-to-definition and hover can point back to `i` in `foreach(i = ...)` if they
consume these symbols later.

Do not add normal `Def` events for foreach iterators, because that would make
the iterators visible after the foreach expression, which is outside the #404
scope.

### Undefined-variable collection

In `crates/raven/src/handlers.rs`, preserve normal argument checking. The
existing structural non-reference logic already skips named argument labels, so
the important diagnostic behavior comes from the RHS-only scope event:

- the iterator name inside the RHS resolves;
- the iterator value expression is still traversed and checked;
- control argument values are still traversed and checked;
- body typos still report.

If tests expose a collector-only gap, add the narrowest special case there, but
do not solve #404 by suppressing the whole RHS or whole call.

## Acceptance tests

Add end-to-end undefined-variable tests for:

```r
foreach(i = 1:10) %do% { print(i) }
```

Expected: no diagnostic for `i`.

```r
foreach(i = 1:10) %dopar% { print(i) }
```

Expected: no diagnostic for `i`.

```r
foreach(i = 1:3, j = 4:6) %do% i + j
```

Expected: no diagnostics for `i` or `j`.

```r
foreach(i = 1:3) %do% i + typo
```

Expected: diagnostic for `typo`, no diagnostic for `i`.

```r
foreach(i = missing_vec) %do% i
```

Expected: diagnostic for `missing_vec`, no diagnostic for `i`.

```r
foreach(i = 1:3, .combine = missing_combine) %do% i
```

Expected: diagnostic for `missing_combine`, no diagnostic for `i`.

```r
foreach(i = 1:3) %do% i
print(i)
```

Expected: diagnostic for the `i` in `print(i)` when no outer binding exists.
This is the iterator leak guard.

```r
foreach(i = 1:3) %do% {
  inner <- i
  inner
}
print(inner)
```

Expected: diagnostic for `inner` in `print(inner)`. This is the RHS local
definition leak guard.

```r
outer <- 1
foreach(i = 1:3) %do% outer + i
```

Expected: no diagnostics. This verifies the synthetic RHS scope does not hide
outer bindings.

```r
foreach::foreach(i = 1:3) %do% i
```

Expected: no diagnostic for `i`.

```r
other_foreach(i = 1:3) %do% i
```

Expected: diagnostic for the RHS `i`; non-foreach lookalikes are not special.

Add lower-level scope tests in `crates/raven/src/cross_file/scope.rs` for the
recognizer and the RHS-only interval:

- iterator symbols are present when querying inside the RHS;
- iterator symbols are absent immediately after the RHS;
- multiple iterators produce multiple parameters;
- dot-prefixed controls produce no parameters.

## Documentation

Update `docs/diagnostics.md` in the undefined-variable / NSE section with a
short note:

- `foreach(...) %do% expr` and `foreach(...) %dopar% expr` expose named
  non-dot `foreach()` arguments as iterator variables inside `expr`;
- Raven still checks the iterator value expressions, control argument values,
  and ordinary symbols in the body;
- nested `%:%` composition and `when(...)` filters are tracked in a separate
  follow-up.

No `README.md` change is needed.

## Follow-up issue

Full nested foreach composition is tracked separately in
https://github.com/jbearak/raven/issues/406.

Filed title:

```text
Model nested foreach composition with %:% and when() filters
```

Filed body:

```markdown
Follow-up to #404.

#404 covers the minimal regression fix: named non-dot iterator arguments from
`foreach(...)` are visible inside the RHS of `%do%` / `%dopar%`.

Nested foreach composition needs a separate design because `%:%` and `when()`
introduce additional binding/filter scopes before the final execution operator:

```r
foreach(i = 1:3) %:% foreach(j = 1:3) %do% i + j
foreach(i = 1:3) %:% when(i %% 2 == 0) %do% i
```

Follow-up acceptance criteria:

- how iterator bindings flow across `%:%`;
- whether `when(...)` filter expressions see iterators from the left side;
- how multiple nested foreach levels compose for `%do%` and `%dopar%`;
- leak behavior after the composed expression.
```

## Out of scope

- Modeling `%:%` nested composition and `when(...)` filters.
- Modeling foreach iterator or RHS-local leakage after the foreach execution
  expression.
- Inferring foreach behavior from arbitrary user-defined functions named
  `foreach`.
- Changing the general NSE policy table for unrelated packages.
