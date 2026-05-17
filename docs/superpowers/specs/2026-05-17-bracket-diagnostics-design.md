# Bracket / brace / paren diagnostics: helpful messages and anchor on opener

**Status:** Approved (design); ready for implementation plan
**Date:** 2026-05-17
**Scope:** `crates/raven/src/handlers.rs` (syntax-error pipeline) and `docs/diagnostics.md`.

## Problem

Two related shortcomings in how Raven reports unbalanced delimiters:

1. **Stray closer** (a `}`, `)`, `]`, or `]]` that has no matching opener in the file)
   emits the generic message `Syntax error` instead of telling the user what's
   actually wrong. The audited table in `docs/diagnostics.md` does not list any
   targeted message for this case.

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
| Anchor for unclosed opener | On the opening `{`/`(`/`[`/`[[` character, spanning to the end of meaningful content on that line (trailing comments and trailing whitespace excluded). |
| Message for unclosed opener | `` Unclosed `(`: missing matching `)` `` (and `{`/`[`/`[[` variants) |
| Anchor for stray closer | On the closer token's own UTF-16 `start..end` |
| Message for stray closer | `` Missing opening `{` `` (and `(`/`[`/`[[` variants) |
| Multi-fault behavior | Each *distinct* delimiter problem emits its own diagnostic — but a stray closer that lives inside an unclosed opener's arguments (e.g. `f(}`) coalesces into a single `Mismatched brackets` diagnostic, because the user almost certainly typed the wrong closer character. |
| Closer runs (`}}}`, `)))`, etc.) | One diagnostic covering the whole run — tree-sitter does not tokenize the characters individually, and splitting them ourselves would add noise without informational value. |
| Mismatched-bracket case | Existing `Mismatched brackets: …` message keeps priority; its scope is extended to also fire when the opener lives in a structural parent of the stray closer's ERROR (see `f(}` case). |
| Unclosed string literal | Unchanged (separate issue) |

## Empirically verified tree-sitter-r parse shapes

The design depends on what tree-sitter-r actually produces. These shapes were
verified by probe against the pinned grammar
(`95aff097aa927a66bb357f715b58cde821be8867` per `crates/raven/Cargo.toml`):

- **`x <- 1\n}\n`** → `program(binary_operator, ERROR(ERROR "}"))` — stray `}`
  is a single ERROR leaf at top level.
- **`}}}\n`** → `program(ERROR(ERROR "}}}"))` — runs of closers are a single
  undifferentiated ERROR span. Tree-sitter does NOT split them into per-`}`
  tokens.
- **`x <- 1\n]]\n`** → `program(binary_operator, ERROR(ERROR "]]"))` — `]]` is
  a single token even when stray.
- **`f(g(h(\n`** → `program(identifier "f", ERROR("(" "g" "(" "h" "("))` — when
  multiple openers are unclosed at the same nesting depth, tree-sitter
  produces a FLAT ERROR containing each opener token as a direct child. There
  are NO `MISSING` nodes in this shape. Any design that finds the opener only
  by walking up from a `MISSING` will miss every level.
- **`f <- function() { x <- 1\n y <- 2\n`** → `function_definition(...,
  braced_expression("{" ... } [MISSING] ""))` — the unclosed `{` lives as the
  first child of `braced_expression`; the `MISSING }` is the last child of
  the same node. Single-level parent walk from `MISSING` finds the opener.
- **`x <- mean(c(1, 2, 3)\n`** → `binary_operator(call(identifier,
  arguments("(" ... ")" comment ")" [MISSING])))` — the unclosed `(` of
  `mean(` lives in `arguments` (parent of the `MISSING )`), not in `call`.
  The opener is `arguments`'s first child.
- **`vec[1, 2\n`** → `subset(identifier "vec", arguments("[" ... "]"
  [MISSING]))` — same pattern as call. The `arguments` node is the direct
  parent of `MISSING`, opener `[` is its first child.
- **`vec[[1, 2\n`** → `subset2(identifier "vec", arguments("[[" ... "]]"
  [MISSING]))` — same pattern; opener `[[` (width 2 token), `MISSING ]]`.
- **`library(`** → `program(call(identifier, arguments("(" ")" [MISSING])))`
  — top-level unclosed call. `MISSING )` has parent `arguments`, opener `(`
  is its first child.
- **`f() }\n`** → `program(call(...), ERROR(ERROR "}"))` — complete call,
  then a sibling ERROR for the stray `}`.
- **`f(} y\n`** → `program(call(identifier "f", arguments("(" ERROR(ERROR
  "}") argument ")" [MISSING])))` — unclosed `(` with a stray `}` and
  trailing identifier inside its argument list. The `}` is an ERROR child of
  `arguments`; the `MISSING )` is at the end of `arguments`. This is the
  case that gets coalesced into a mismatched-bracket diagnostic.
- **`c(1, 2]`** → `program(identifier, ERROR("(" arg "," arg ERROR "]"))` —
  the existing mismatched-bracket detector handles this shape.
- **`f( # comment\n`** → `program(call(identifier, arguments("(" comment ")"
  [MISSING])))` — opener line has nothing of value after the `(` except a
  comment; the spec's "spans to end of meaningful content" rule must trim
  past the comment.

## Architecture

All changes live in `crates/raven/src/handlers.rs`, inside the existing
syntax-error pipeline: `collect_syntax_errors` →
`classify_error` / `minimize_error_range` / `anchor_missing_position`. No
new modules.

Because today's `classify_error` returns a single `String` and the existing
contract emits exactly one diagnostic per `ERROR`, supporting "multiple
diagnostics per ERROR" requires a structural refactor of that boundary
without breaking the existing classifiers.

### Internal types

```rust
struct ClassifiedSyntaxDiagnostic {
    message: String,
    range: Range,
}

enum ErrorClassification {
    /// One diagnostic describes the whole ERROR (e.g. unclosed string,
    /// mismatched bracket). Stop iterating.
    Whole(ClassifiedSyntaxDiagnostic),
    /// Multiple diagnostics extracted from the ERROR's children.
    /// Empty Vec means "no specific classification — caller falls back
    /// to a single generic 'Syntax error' at the minimized range".
    Multi(Vec<ClassifiedSyntaxDiagnostic>),
}
```

`classify_error` returns `ErrorClassification` instead of `String`. The
caller (`collect_syntax_errors`) decides whether to emit one or many
diagnostics for each ERROR. This keeps the single-classifier contract for
existing classifiers (they all return `Whole`) while allowing the new
delimiter logic to return `Multi` when appropriate.

### Classifier ordering inside `classify_error`

The classifier runs each pass in this order, returning the first result
that classifies the ERROR:

1. Unclosed string literal *(existing — `Whole`)*
2. Consecutive pipe *(existing — `Whole`)*
3. Mismatched bracket — **extended** to also detect openers in structural
   parents (the `f(}` case). Returns `Whole` with `Mismatched brackets: …`.
4. Fat-arrow typo *(existing — `Whole`)*
5. **Delimiter scan** *(new — `Multi`)*. Scans the ERROR's direct children
   for opener tokens (unclosed) and closer tokens (stray) and produces one
   diagnostic per finding. See *Delimiter scan rules* below.
6. Fallback: return `Multi(vec![])` → caller emits a single
   `Syntax error` at the minimized range (today's behavior).

### Delimiter scan rules

When the delimiter scan runs on an ERROR, it does this single pass:

1. Iterate the ERROR's *direct* children left-to-right, tracking a stack
   of unmatched openers.
2. For each child whose token text is an opener (`(`, `{`, `[`, `[[`),
   push `(kind, position, line, end_of_meaningful_content_col)` onto the
   stack.
3. For each child whose token text is a closer (`)`, `}`, `]`, `]]`),
   look at the top of the stack:
   - If the stack is empty → it's a stray closer. Emit
     `Missing opening `X`` at the closer token's range.
   - If the top of the stack matches (same kind) → pop and discard
     (this matched pair lived inside the ERROR; nothing to report).
   - If the top of the stack is a mismatched opener → emit
     `Mismatched brackets: ` and pop. (This handles e.g. `(...]` patterns
     embedded inside a broader ERROR.)
4. For each opener left on the stack at the end → emit
   `Unclosed `X`: missing matching `Y`` ranged from the opener through
   end-of-meaningful-content on the opener's line.

This pass produces between zero and N diagnostics where N is the number of
delimiter tokens in the ERROR. For `f(g(h(` the stack has three unclosed
`(` at the end → three diagnostics. For `}}}` there's one ERROR whose only
direct child is `ERROR "}}}"` (a single undifferentiated leaf) — the leaf
is not parsed as three closer tokens, so the rule above sees one closer
token of text `"}}}"`. We treat that whole leaf as a single stray-closer
diagnostic and produce ONE `Missing opening `{`` ranged over the entire
leaf.

### Stray closer in unclosed-opener arguments (coalescing rule)

For the very common `f(}` typo, the parse shape is **NOT** the same as the
ERROR-scan case above: the `}` lives inside the `arguments` node, not
inside an ERROR that also contains the `(`. The mismatched-bracket
detector at step 3 of the classifier order is extended to handle this:

When the existing mismatched-bracket detector finds an ERROR whose only
non-whitespace child is a closer token, it now also walks up one level to
check whether the parent is `arguments`, `braced_expression`, or
`parenthesized_expression` AND whether that parent contains an opener
*and* a `MISSING` closer of the expected kind. If yes, emit a single
mismatched-bracket diagnostic anchored on the stray closer, with message
`` Mismatched brackets: `(` opened here; close with `)` not `}`. ``
(opener character substituted from the parent's actual opener; stray-closer
character substituted from the ERROR's child).

The diagnostic suppresses the `MISSING` follow-up that would otherwise
produce a separate "Unclosed `(`" message for the same opener — the
mismatched-bracket diagnostic already names it. This is implemented by
having the `MISSING`-handling branch consult a small per-traversal set of
"openers already covered by a mismatched-bracket diagnostic" populated at
classification time.

### Opener anchoring via MISSING (single-level parent walk)

For `MISSING` nodes whose kind is a closer (`)`, `}`, `]`, `]]`) and which
are NOT already covered by the coalescing rule above:

1. Get the `MISSING`'s direct parent.
2. Confirm the parent kind is one of `arguments`, `braced_expression`,
   `parenthesized_expression` (verified shapes — see above).
3. Take that parent's first child token as the opener.
4. Anchor range: `(opener_row, opener_col_utf16)` →
   `(opener_row, end_of_meaningful_content_col)` (defined below).
5. If the parent kind is unrecognized (defensive), fall back to today's
   `anchor_missing_position` behavior.

Non-bracket `MISSING` kinds (e.g. the trailing identifier of `x <-`)
continue through the existing direct-`MISSING` branch unchanged.

### End-of-meaningful-content column

The opener-line range stops at the start of any trailing comment, and
trims trailing whitespace. Concretely:

1. Take the line containing the opener.
2. Find the last non-whitespace byte before the first `#` *that is outside
   any string or backtick* on that line.
3. Convert that byte offset to a UTF-16 column via
   `byte_offset_to_utf16_column`.
4. If there is nothing meaningful after the opener (only whitespace or a
   comment), the range collapses to the opener token's own width.

This avoids underlining comments and trailing whitespace in cases like
`f( # comment` (range = just the `(`) and `f(   ` (range = just the `(`).

## Edge cases

**E1. `[[` and `]]` are single tokens.** The delimiter scan and
mismatched-bracket detector both recognise these as one token of width 2.

**E2. Top-level `MISSING` outside any `ERROR`.** `x <-` produces a lone
`MISSING identifier` at the program level. No opener to anchor on. The
direct-`MISSING` branch (handlers.rs:6308 today) is unchanged in message
and anchor for non-bracket `MISSING` kinds. Bracket-kind `MISSING` nodes
at the top level *are* re-routed through the single-level parent walk so
that `library(` still produces a useful diagnostic anchored on the `(`.

**E3. Nested unclosed openers — flat ERROR.** `f(g(h(` parses as a flat
ERROR containing three `(` tokens and two intervening identifiers, with
NO `MISSING` nodes. The delimiter-scan rule handles this: stack ends with
three unclosed `(` → three diagnostics, one anchored on each `(`. The
spec's earlier draft assumed `MISSING` descendants; this case is now
covered by the structural scan instead.

**E4. Mismatched-bracket: extended scope.**
- `c(1, 2]` — opener and wrong closer both inside the same ERROR;
  existing detector handles this and returns `Whole`.
- `f(}` — opener in `arguments`, wrong closer inside an ERROR child of
  `arguments`; new extended detector returns `Whole` (single mismatched-
  brackets diagnostic) and suppresses the `MISSING )` follow-up.
- The stray-closer pass does NOT additionally emit `Missing opening `X``
  in either case.

**E5. Stray closer immediately after a valid expression.** `f() }` — `f()`
parses as a complete `call`, then `}` is its own ERROR sibling. The
delimiter scan on that ERROR finds one stray closer with no preceding
opener → one diagnostic `Missing opening `{`` on the `}`.

**E6. Multiple stray closers in a run.** `}}}` parses as ONE `ERROR`
containing ONE leaf ERROR whose text is `"}}}"`. The delimiter scan treats
this leaf as a single stray closer and emits ONE diagnostic
`Missing opening `{`` spanning the whole leaf. This was a deliberate
design choice (see *Approved decisions*) — splitting `}}}` into three
diagnostics adds noise without information.

**E7. Unclosed opener at end of file.** `library(` with no trailing
newline. `MISSING )` is placed at the file's end byte. Direct parent is
`arguments`; opener is `(` at column 7. Range = `(0, 7)` → end-of-
meaningful-content on line 0 = `(0, 8)`. One column wide because nothing
follows the `(`. Works.

**E8. Comment on opener line.** `f( # comment\n` — opener `(` at col 1,
then `# comment`. End-of-meaningful-content col = 2 (just past the `(`).
Range collapses to just the `(`. Comment is not underlined.

**E9. Trailing whitespace on opener line.** `f(   \n` — opener `(` at
col 1, then three spaces. End-of-meaningful-content col = 2 (just past the
`(`). Range collapses to just the `(`.

**E10. CRLF line endings.** Tree-sitter reports byte columns including
`\r` but `byte_offset_to_utf16_column` strips line endings before
computing UTF-16 columns. The implementation must compute
end-of-meaningful-content using the line's logical content (no `\r`/`\n`).
Add a regression test using `\r\n`.

**E11. No final newline.** `library(` — no `\n` at EOF. The opener's line
is the only line. End-of-meaningful-content col is computed from the line
slice as if EOF were the line terminator. Same code path as E10.

**E12. BOM at start of file.** A UTF-8 BOM (`\xEF\xBB\xBF`) shifts every
byte column by 3. Tree-sitter reports byte columns including the BOM;
`byte_offset_to_utf16_column` accounts for this. All range computations
must go through that helper — no bare `column` field uses.

**E13. Non-ASCII identifiers and emoji.** A line containing `é` or `😀`
before the opener has byte columns > UTF-16 columns. The same
`byte_offset_to_utf16_column` helper handles this. Add explicit tests for
non-ASCII (`é`) and astral-plane (`😀`, which is a UTF-16 surrogate pair —
two code units).

**E14. R Markdown / Quarto code chunks.** Diagnostics already operate on
a per-chunk tree-sitter parse upstream of `collect_syntax_errors`. No
additional handling needed.

**E15. `# @lsp-ignore` suppression.** Both new diagnostics flow through
the same suppression path as existing parse diagnostics. The suppression
marker must be on the line containing the *new* anchor — i.e., the opener
line for the unclosed case, the closer line for the stray case. Documented
in `docs/diagnostics.md`.

## Performance

Worst-case shape: deeply nested unclosed openers (e.g. `f(` repeated N
times). Today's classifier is O(1) per ERROR; the new delimiter scan is
O(direct-children) per ERROR. `collect_syntax_errors` walks each
non-ERROR child recursively but does not recurse into ERROR children, so
the total cost is bounded by O(total ERROR direct children) ≤ O(tokens).
The single-level parent walk for `MISSING` is O(1). No O(N²) hazard.

For defensive measure, the delimiter scan emits at most N diagnostics per
ERROR where N is the number of delimiter tokens. We do not add an
artificial cap; tree-sitter's grammar already bounds this in practice.

## Out of scope

- Unclosed string literal anchoring/messaging — separate issue.
- Backtick-quoted identifier mismatches — backticks aren't brackets.
- Heuristics like "did you mean to add `}` on line N?" — would require
  multi-line layout analysis beyond what's needed.

## Tests

All new tests go in `mod syntax_error_range_tests` in
`crates/raven/src/handlers.rs`, reusing the `collect(code)` helper.

### Stray-closer detection (new)

| Test | Input | Expected |
|---|---|---|
| `stray_close_brace_emits_missing_opening` | `"x <- 1\n}\n"` | one diagnostic, message `` Missing opening `{` ``, range on the `}` |
| `stray_close_paren_emits_missing_opening` | `"x <- 1\n)\n"` | one diagnostic, message `` Missing opening `(` ``, range on the `)` |
| `stray_close_bracket_emits_missing_opening` | `"x <- 1\n]\n"` | one diagnostic, message `` Missing opening `[` ``, range on the `]` |
| `stray_double_close_bracket_emits_missing_opening` | `"x <- 1\n]]\n"` | message `` Missing opening `[[` ``, range covers `]]` (width 2) |
| `closer_run_emits_single_diagnostic` | `"}}}"` | exactly ONE diagnostic, message `` Missing opening `{` ``, range spans the whole `}}}` leaf (cols 0-3). Replaces the earlier-considered "three diagnostics" expectation. |
| `mismatched_bracket_still_wins` | `"c(1, 2]"` | existing `Mismatched brackets: …` message; no `Missing opening …` diagnostic |
| `stray_closer_after_valid_expr` | `"f() }"` | one diagnostic on the `}`, none on `f()` |

### Unclosed-opener anchoring

| Test | Input | Expected |
|---|---|---|
| `unclosed_paren_anchors_on_opener` | `"x <- mean(c(1, 2, 3)\n\n# comment\n"` | range from `(` of `mean(` (col 9) through end of meaningful content on line 0 (col 20 = end of inner `c(1,2,3)`); message `` Unclosed `(`: missing matching `)` `` |
| `unclosed_brace_anchors_on_opener` | `"f <- function() {\n  x <- 1\n  y <- 2\n"` | range on `{` only (opener at EOL); message `` Unclosed `{`: missing matching `}` `` |
| `unclosed_bracket_anchors_on_opener` | `"vec[1, 2\n"` | range from `[` (col 3) through end of line content (col 8); message `` Unclosed `[`: missing matching `]` `` |
| `unclosed_double_bracket_anchors_on_opener` | `"vec[[1, 2\n"` | range from `[[` start (col 3) through end of line content (col 9); message `` Unclosed `[[`: missing matching `]]` `` |
| `nested_flat_unclosed_emits_per_opener` | `"f(g(h(\n"` | THREE diagnostics, one anchored on each `(` (cols 1, 3, 5). Each range covers its `(` only (no content after). |
| `unclosed_paren_at_end_of_file` | `"library("` | range on the `(`; message `` Unclosed `(`: missing matching `)` `` |
| `unclosed_opener_with_trailing_comment` | `"f( # comment\n"` | range covers just the `(` (comment excluded); message `` Unclosed `(`: missing matching `)` `` |
| `unclosed_opener_with_trailing_whitespace` | `"f(   \n"` | range covers just the `(` (whitespace excluded); message `` Unclosed `(`: missing matching `)` `` |

### Coalescing — stray closer inside an unclosed opener

| Test | Input | Expected |
|---|---|---|
| `wrong_closer_in_args_coalesces` | `"f(}\n"` | exactly ONE diagnostic, message `` Mismatched brackets: `(` opened here; close with `)` not `}`. ``, range on the `}` |
| `wrong_closer_followed_by_content_coalesces` | `"f(} y\n"` | exactly ONE diagnostic (Mismatched brackets), NOT two |
| `wrong_closer_for_subset_coalesces` | `"vec[}\n"` | one Mismatched-brackets diagnostic naming `[` and `}` |

### Encoding / line-ending edge cases

| Test | Input | Expected |
|---|---|---|
| `unclosed_opener_crlf` | `"library(\r\n"` | range computed correctly (no `\r` in range), single diagnostic |
| `unclosed_opener_no_final_newline` | `"library("` | works without EOF newline |
| `unclosed_opener_with_bom` | `"\u{FEFF}library("` | UTF-16 col reflects BOM stripped; range valid |
| `unclosed_opener_non_ascii_before` | `"é_func("` | UTF-16 col for `(` reflects single-code-unit `é`; range valid |
| `unclosed_opener_astral_before` | `"😀_func("` | UTF-16 col for `(` accounts for the surrogate pair (`😀` = 2 code units); range valid |

### Regression / non-regression

| Test | Behavior to preserve |
|---|---|
| `unclosed_paren_diagnostic_anchors_on_offending_line` (existing) | Rewrite to expect new anchor (on opener) instead of end-of-statement. |
| `mismatched_bracket_emits_descriptive_message` (existing) | Unchanged behavior. |
| `incomplete_assignment_in_block_minimized` (existing) | Unchanged — non-bracket `MISSING`, uses unchanged code path. |
| `top_level_incomplete_assignment` (existing) | Unchanged (same reason). |
| `unclosed_string_literal_*` (existing) | Unchanged — string-literal handling untouched. |

### Helper-level unit test

Add a unit test for the new helpers:

- `find_opener_for_missing(missing) -> Option<(Node, Range)>` — covers
  `MISSING` inside `arguments` (with `(`/`[`/`[[` opener), inside
  `braced_expression`, inside `parenthesized_expression`, and the
  defensive `None` case.
- `end_of_meaningful_content(line, byte_col) -> u32` — covers a line with
  trailing whitespace, with a trailing comment, with a `#` inside a string
  (must not trim there), and with CRLF.

## Documentation

`docs/diagnostics.md` — replace the current row:

```text
| `Missing )` / `Missing ]` / etc. | A delimiter was opened but never closed (`library(`) |
```

with two rows:

```text
| `` Unclosed `(`: missing matching `)` `` / `` Unclosed `{`: missing matching `}` `` / `` Unclosed `[`: missing matching `]` `` / `` Unclosed `[[`: missing matching `]]` `` | A delimiter was opened but never closed (`library(`, `function() {`). The diagnostic is anchored on the opening delimiter, spanning to the end of meaningful content on that line. |
| `` Missing opening `{` `` / `` Missing opening `(` `` / `` Missing opening `[` `` / `` Missing opening `[[` `` | A closing delimiter appears with no matching opener (`}` at top level, `)` after a complete expression). A run of stray closers (`}}}`) reports a single diagnostic for the whole run. |
```

Also note that the existing `` Mismatched brackets: … `` row's coverage
extends to the `f(}` case (wrong closer immediately inside an unclosed
opener).

No changes to `docs/development.md` — the new logic is local to
`handlers.rs` and doesn't affect cross-file invariants, caching, or any
architectural concerns covered there. No `CLAUDE.md` updates — the
changes don't add a new module-spanning invariant.
