# Bracket / brace / paren diagnostics: helpful messages and anchor on opener

**Status:** Approved (design); ready for implementation plan
**Date:** 2026-05-17
**Scope:** `crates/raven/src/handlers.rs` (syntax-error pipeline) and `docs/diagnostics.md`.

## Problem

Two related shortcomings in how Raven reports unbalanced delimiters:

1. **Stray closer** (a `}`, `)`, `]`, or `]]` that has no matching opener in the file)
   emits the generic message `Syntax error` instead of telling the user what's
   actually wrong. The audited table in `docs/diagnostics.md` does not list any
   targeted message for this case — only the unclosed-opener row exists.

2. **Unclosed opener** (a `{`, `(`, `[`, or `[[` with no matching closer) emits
   the diagnostic squiggle at the *end of the offending statement* — the spot
   where tree-sitter inserted its `MISSING` node, walked back to the last code
   line by `anchor_missing_position`. The squiggle never lands on the opening
   delimiter itself, so the user's eye is directed at "where parsing ran out"
   rather than at the broken expression's actual start.

Both shortcomings show up in well-formed R that's missing exactly one
character. They're the kind of mistake users make often when typing.

## Approved decisions

| Decision | Value |
|---|---|
| Anchor for unclosed opener | On the opening `{`/`(`/`[`/`[[` character, spanning to end of opener's line |
| Message for unclosed opener | `` Unclosed `(`: missing matching `)` `` (and `{`/`[`/`[[` variants) |
| Anchor for stray closer | On the closer character itself (width = token width) |
| Message for stray closer | `` Missing opening `{` `` (and `(`/`[`/`[[` variants) |
| Multi-fault behavior | Each delimiter problem emits its own diagnostic |
| Mismatched-bracket case | Existing `Mismatched brackets: …` message keeps priority (no double-fire) |
| Unclosed string literal | Unchanged (separate issue) |

## Architecture

All changes live in `crates/raven/src/handlers.rs`, inside the existing
syntax-error pipeline: `collect_syntax_errors` →
`classify_error` / `minimize_error_range` / `anchor_missing_position`.
No new modules.

Two new responsibilities for the diagnostic walk:

1. **Stray-closer detection.** A new classifier
   `detect_stray_closer(node, text) -> Option<(String, Range)>`, invoked from
   `classify_error` **after** mismatched-bracket detection so `c(1, 2]` keeps
   its more specific message. The classifier scans the `ERROR` node's direct
   children left-to-right for the first child whose token text matches a
   closer (`}`, `)`, `]`, `]]`, longest-first so `]]` matches before `]`),
   and fires only when no earlier direct sibling in the same `ERROR` is the
   matching opener (`{` / `(` / `[` / `[[`). The diagnostic range is the
   closer token's UTF-16 `start..end`.

2. **Opener anchoring for `MISSING`.** When `minimize_error_range` finds a
   `MISSING` descendant, route bracket/brace/paren kinds through a new helper
   that walks upward to the structural parent and uses that parent's opening
   delimiter token as the anchor. The opener is found by scanning the
   structural parent's direct children left-to-right for the first child
   whose token text matches the expected opener for that node kind:

   | Structural parent (tree-sitter-r) | Opener token text |
   |---|---|
   | `call` | `(` |
   | `subset` | `[` |
   | `subset2` | `[[` |
   | `braced_expression` | `{` |
   | `parenthesized_expression` | `(` |

   For `call`, `subset`, `subset2` the opener is NOT the first child —
   the first child is the callee/object expression (e.g. `mean` in `mean(...)`,
   `vec` in `vec[1]`). For `braced_expression` and `parenthesized_expression`
   the opener IS the first child.

   Range = `(opener_row, opener_col_utf16)` →
   `(opener_row, utf16_len_of_opener_line)`. The range always spans to the
   end of the line containing the opener; the opener token's own width is
   irrelevant to the final range (the range subsumes it).

   If no structural parent is found (defensive fallback for unrecognized tree
   shapes), keep today's `anchor_missing_position` behavior.

   Non-bracket `MISSING` kinds (e.g. the trailing identifier of `x <-`)
   continue through the existing direct-`MISSING` branch unchanged.

### Independent emission inside one ERROR

Today `collect_syntax_errors` emits exactly one diagnostic per `ERROR`
(handlers.rs:6302: "Don't recurse into ERROR children"). To honor the
"detect each independently" decision, the `ERROR` branch becomes:

- If a whole-`ERROR` classifier matches (unclosed string, consecutive pipe,
  mismatched bracket, fat-arrow), emit that single diagnostic and stop —
  these classifications describe the whole `ERROR`.
- Otherwise, walk the `ERROR`'s direct children and emit:
  - one diagnostic per `MISSING` descendant whose kind is a bracket/brace/paren
    closer and whose structural-parent walk finds a matching opener
    (anchored on the opener line);
  - one diagnostic per stray closer token (anchored on the closer);
  - fall back to a single `Syntax error` at the minimized range if neither
    fires.

This contract preserves "one diagnostic per ERROR" for everything tree-sitter
classifies as a single coherent error, but allows separate diagnostics when an
`ERROR` legitimately contains two distinct user mistakes (e.g. `f(} y` →
unclosed `(` AND stray `}`).

### Classifier ordering inside `classify_error`

1. Unclosed string literal *(existing)*
2. Consecutive pipe *(existing)*
3. Mismatched bracket *(existing — consumes closers attached to mismatched openers)*
4. Fat-arrow typo *(existing)*
5. **Stray closer** *(new — closers that survived steps 1–4)*

## Anchoring details

### Unclosed opener — finding the right `(`/`{`/`[`/`[[`

Walk upward from the `MISSING` node to the first ancestor whose kind is one
of `call`, `subset`, `subset2`, `braced_expression`,
`parenthesized_expression`. Inside that ancestor, scan direct children
left-to-right for the first child whose token text matches the expected
opener for that node kind (see the table in *Architecture* above). That
token's `start_position()` is the anchor.

Range: `(opener_row, opener_col_utf16)` →
`(opener_row, utf16_len_of_opener_line)`.

If no structural parent is found, fall back to today's
`anchor_missing_position` behavior (`raw_row` walked back to the last code
line, end-of-line column). The fallback exists for defensive coverage; we
do not expect it to trigger on real R code.

### Stray closer — finding the right `}`/`)`/`]`/`]]`

Inside an `ERROR` node, scan direct children for the first token whose text
matches `}`, `)`, `]`, or `]]` (longest-first, so `]]` matches before `]`),
where no earlier direct sibling is a matching opener. That token is the
stray closer. The diagnostic range is the token's `start..end` (UTF-16).

The "no earlier matching opener" check is a single linear pass over earlier
direct siblings — keeps the mismatched-bracket case (`c(1, 2]`) from being
re-classified as a stray closer once the mismatched-bracket detector has
already returned its more specific message. In practice, when mismatched-
bracket fires, the whole-`ERROR` classifier short-circuits before the
stray-closer pass runs; the per-sibling check is belt-and-braces.

## Edge cases

**E1. `[[` and `]]`.** Single tokens in tree-sitter-r. The stray-closer scan
matches `]]` before `]` (longest-first). For openers, anchor at the `[[`
token's start column, span to EOL.

**E2. Top-level `MISSING` outside any `ERROR`.** `x <-` produces a lone
`MISSING identifier` at the program level. No opener to anchor on. The
direct-`MISSING` branch (handlers.rs:6308) is unchanged in message and
anchor for non-bracket `MISSING` kinds. Bracket-kind `MISSING` nodes at the
top level *are* re-routed through the new opener-walking logic so that
`library(` still produces a useful diagnostic anchored on the `(`.

**E3. Nested unclosed openers.** `f(g(h(` has three unclosed `(`.
Tree-sitter inserts three `MISSING` `)` closers, one per level. The
structural-parent walk from each `MISSING` finds its matching opener.
Result: three diagnostics on three `(` characters.

**E4. Mismatched-bracket case keeps priority.** `c(1, 2]` emits the existing
`Mismatched brackets: \`(\` opened here; close with \`)\` not \`]\`.`
diagnostic. The stray-closer pass does NOT additionally emit
`Missing opening \`[\`` for the `]`. This is enforced by the whole-`ERROR`
classifier short-circuit (mismatched-bracket is in the priority list above
stray-closer).

**E5. Stray closer immediately after a valid expression.** `f() }` — `f()`
parses as a complete `call`, then `}` is its own `ERROR` sibling at the
program level. The stray-closer detector fires on that `ERROR`. One
diagnostic, on the `}`, `Missing opening \`{\``.

**E6. Multiple stray closers in a row.** `}}}` produces three sibling
`ERROR` nodes at the program level. Three diagnostics. Expected behavior
per "detect each independently."

**E7. Unclosed opener at end of file.** `library(` with no trailing
newline. `MISSING` `)` is placed at the file's end byte. Structural-parent
walk: `MISSING` → `call` → first child `(` at column 7. Range = col 7 → EOL
of opener's line. Works.

**E8. R Markdown / Quarto code chunks.** Diagnostics already operate on a
per-chunk tree-sitter parse upstream of `collect_syntax_errors`. No
additional handling needed — the new logic operates on the same node tree
contract.

**E9. `# @lsp-ignore` suppression.** Both new diagnostics flow through the
same suppression path as existing parse diagnostics. The suppression marker
must be on the line containing the *new* anchor — i.e., the opener line for
the unclosed case, the closer line for the stray case. Document this in
`docs/diagnostics.md` alongside the new table rows.

## Out of scope

- Unclosed string literal anchoring/messaging — separate issue.
- Backtick-quoted identifier mismatches — backticks aren't brackets.
- Heuristics like "did you mean to add `}` on line N?" — would require
  multi-line layout analysis beyond what's needed.

## Tests

All new tests go in the existing `syntax_error_range_tests` module in
`crates/raven/src/handlers.rs` (line 6485+), reusing the `collect(code)`
helper.

### Stray-closer detection (new)

| Test | Input | Expected |
|---|---|---|
| `stray_close_brace_emits_missing_opening` | `"x <- 1\n}\n"` | exactly one diagnostic, message `` Missing opening `{` ``, range on the `}` |
| `stray_close_paren_emits_missing_opening` | `"x <- 1\n)\n"` | exactly one diagnostic, message `` Missing opening `(` ``, range on the `)` |
| `stray_close_bracket_emits_missing_opening` | `"x <- 1\n]\n"` | exactly one diagnostic, message `` Missing opening `[` ``, range on the `]` |
| `stray_double_close_bracket_emits_missing_opening` | `"x <- 1\n]]\n"` | message `` Missing opening `[[` `` (longest-first match), range covers both `]]` |
| `multiple_stray_closers_emit_one_each` | `"}}}"` | three diagnostics, each on its own `}` |
| `mismatched_bracket_still_wins` | `"c(1, 2]"` | existing mismatched-bracket message; **no** `Missing opening \`[\`` diagnostic |
| `stray_closer_after_valid_expr` | `"f() }"` | exactly one diagnostic for the `}`, none for `f()` |

### Opener anchoring for unclosed cases (range = opener-line)

| Test | Input | Expected |
|---|---|---|
| `unclosed_paren_anchors_on_opener` | `"x <- mean(c(1, 2, 3)\n\n# comment\n"` | range starts at the `(` of `mean(` (col 9), ends at EOL of the opener line; message `` Unclosed `(`: missing matching `)` `` |
| `unclosed_brace_anchors_on_opener` | `"f <- function() {\n  x <- 1\n  y <- 2\n"` | range on `{` only (opener at EOL); message `` Unclosed `{`: missing matching `}` `` |
| `unclosed_bracket_anchors_on_opener` | `"vec[1, 2\n"` | range from `[` (col 3) through EOL; message `` Unclosed `[`: missing matching `]` `` |
| `unclosed_double_bracket_anchors_on_opener` | `"vec[[1, 2\n"` | range from `[[` start through EOL; message `` Unclosed `[[`: missing matching `]]` `` |
| `nested_unclosed_opens_emit_per_level` | `"f(g(h(\n"` | three diagnostics, one anchored on each `(` |
| `unclosed_paren_at_end_of_file` | `"library("` | range on the `(` through EOL; message `` Unclosed `(`: missing matching `)` `` |

### Combined faults (independent emission)

| Test | Input | Expected |
|---|---|---|
| `unclosed_opener_and_stray_closer_in_same_error` | `"f(} y\n"` | two diagnostics: one `` Unclosed `(`: missing matching `)` `` on the `(`, one `` Missing opening `{` `` on the `}` |

### Regression / non-regression

| Test | Input | Behavior to preserve |
|---|---|---|
| `unclosed_paren_diagnostic_anchors_on_offending_line` (handlers.rs:6635) | unchanged | rewrite assertions to expect new anchor on the opener instead of end-of-statement |
| `mismatched_bracket_emits_descriptive_message` (handlers.rs:7335) | unchanged | unchanged behavior |
| `incomplete_assignment_in_block_minimized` (handlers.rs:6509) | unchanged | unchanged behavior — non-bracket `MISSING`, uses unchanged code path |
| `top_level_incomplete_assignment` (handlers.rs:6605) | unchanged | unchanged behavior (same reason) |
| `unclosed_string_literal_*` tests | unchanged | string-literal anchoring untouched |

### Helper-level unit test

Add a unit test for the new `find_opener_for_missing(missing) -> Option<(Node, Range)>`
helper, covering: `MISSING` inside `call`, inside `subset`, inside `subset2`,
inside `braced_expression`, inside `parenthesized_expression`, and the
defensive `None` case (synthetic `MISSING` with no structural parent).

## Documentation

`docs/diagnostics.md` — replace the current row:

```text
| `Missing )` / `Missing ]` / etc. | A delimiter was opened but never closed (`library(`) |
```

with two rows:

```text
| `` Unclosed `(`: missing matching `)` `` / `` Unclosed `{`: missing matching `}` `` / `` Unclosed `[`: missing matching `]` `` / `` Unclosed `[[`: missing matching `]]` `` | A delimiter was opened but never closed (`library(`, `function() {`). The diagnostic is anchored on the opening delimiter, spanning to the end of that line. |
| `` Missing opening `{` `` / `` Missing opening `(` `` / `` Missing opening `[` `` / `` Missing opening `[[` `` | A closing delimiter appears with no matching opener (`}` at top level, `)` after a complete expression). |
```

No changes to `docs/development.md` — the new logic is local to
`handlers.rs` and doesn't affect cross-file invariants, caching, or any
architectural concerns covered there. No `CLAUDE.md` updates — the changes
don't add a new module-spanning invariant.
