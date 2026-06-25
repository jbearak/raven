# Issue #537 — NSE column args under the compound-assignment pipe `%<>%` (design spec)

**Status:** v2 — post-Codex adversarial review. **v2 changes:** (1) replaced the
vacuous dot-pronoun test #3 (`mutate(y = nrow(.))` — `mutate`'s captured `...`
swallows the named arg before the `.`-pronoun check, so it passed regardless of
the fix) with a form where the `.` is genuinely a checked identifier (§6). (2)
Corrected the §8 directional-safety claim: the fix is **false-positive-safe**, not
"purely additive" — for functions with *checked overflow* formals past the
captured ones (`pull`, `top_n`), pre-consuming `.data` shifts the positional
binding by one, which can newly surface a *correct* diagnostic (true positive) on
an overflow arg while un-flagging the column previously mis-bound to `.data`. (3)
Strengthened the negative control to a checked-RHS-position case
(`pull(v, nm, typo)`) and added namespace-qualified-verb coverage (§6). (4)
Acknowledged the pre-existing, out-of-scope indentation `%>%` sites (§5).
**Issue:** #537 "NSE column args not resolved under compound-assignment pipe `%<>%` (work under `%>%`)"
**Builds on:** existing magrittr `%>%` / native `|>` pipe-fed NSE handling in `crates/raven/src/handlers.rs`.
**Verified against:** magrittr 2.0.3 semantics; tree-sitter-r AST (confirmed empirically, see §2).

---

## 1. Problem and goal

magrittr's compound-assignment pipe `%<>%` is defined as:

```r
x %<>% f()        #  ≡   x <- x %>% f()
```

So the **data context flowing into the right-hand-side call is identical to `%>%`**:
the LHS value is supplied as the RHS call's implicit first argument, and bare
names in NSE positions are columns of that data, not free variables. The only
extra thing `%<>%` does beyond `%>%` is assign the result back to the LHS name.

Today Raven resolves NSE column arguments correctly under `%>%` but flags them as
`undefined-variable` under `%<>%`:

```r
f <- function(data) {
    data$ring <- factor(data$x)
    data %<>% group_by(ring) %>% mutate(z = x)   # `ring` FLAGGED (false positive)
}

g <- function(data) {
    data$ring <- factor(data$x)
    data %>% group_by(ring) %>% mutate(z = x)    # OK, no diagnostic
}
```

**Goal:** NSE column arguments resolve identically under `%<>%` and `%>%`. The
reported false positive (`group_by(ring)` fed by `%<>%`) disappears, and the
magrittr `.` pronoun on the RHS of a `%<>%` pipe is likewise recognized.

**Non-goal:** Changing how `%<>%`'s *assignment* side is tracked (whether the LHS
name becomes "defined" for subsequent lines). That is a separate concern from NSE
column resolution and is explicitly excluded; see §6 (regression guard).

## 2. Empirical facts (tree-sitter-r AST)

`%<>%` is tokenized exactly like `%>%`: a `special` token inside a
`binary_operator` node. Confirmed by dumping the AST for the issue's repro
`data %<>% group_by(ring) %>% mutate(z = x)`:

```
program
  binary_operator                 ← operator `%>%`, rhs = mutate(...)
    binary_operator               ← operator `%<>%`, rhs = group_by(ring)
      identifier "data"
      special "%<>%"
      call
        identifier "group_by"
        arguments
          argument
            identifier "ring"
      ...
    special "%>%"
    call (mutate ...)
```

By R operator precedence all `%...%` infix operators share one precedence and are
left-associative, so the chain parses as
`(data %<>% group_by(ring)) %>% mutate(z = x)`. Consequences:

- `mutate(z = x)` is the rhs of the **outer** `%>%` operator → already handled
  → no false positive (matches the issue's "OK under downstream verb" row).
- `group_by(ring)` is the rhs of the **inner** `%<>%` operator → **not** handled
  → false positive. This is the single defect.

## 3. Root cause

`call_is_pipe_fed` (`crates/raven/src/handlers.rs:16232`) decides whether a call
receives the piped value as its implicit first argument. It matches only `|>` and
`%>%`:

```rust
parent.children(&mut cursor).any(|child| {
    child.kind() == "|>" || (child.kind() == "special" && node_text(child, text) == "%>%")
})
```

For a `%<>%`-fed call this returns `false`, so the RHS call's first formal
(`.data`/`.tbl`/the data/object argument) is **not** pre-consumed by the pipe.
The syntactic positional arguments then bind starting at the *first* formal
instead of the *second*:

- `group_by(.data, ..., .add, .drop)` with `pipe_fed = false` → the positional
  `ring` binds to `.data`, which is **standard-eval (checked)** → `ring` flagged.
- with `pipe_fed = true` → `.data` is pre-consumed, `ring` binds to the
  data-masked `...` → suppressed (correct).

This also explains why the bug only bites **positional** NSE args. A *named*
data-masked arg (`mutate(z = x)`) binds to `...` regardless of `pipe_fed`, so it
is suppressed either way — which is why the issue's matrix shows the downstream
verb is irrelevant and the trigger is purely the `%<>%` operator feeding the
first NSE verb in the chain.

`call_is_pipe_fed` is the **single** chokepoint: it has three callers
(`handlers.rs:15369`, `:15893`, `:16182`) covering verb-policy detection and the
two main NSE call-processing paths. Fixing it once fixes all three.

## 4. The fix

### 4.1 Core: recognize `%<>%` as a magrittr forward-flow pipe

`%<>%` flows its LHS into the RHS call's first formal and evaluates the RHS in the
same data context as `%>%`. So `call_is_pipe_fed` must treat the `%<>%` `special`
token the same as `%>%`.

Two sites match "is this `special` token a magrittr forward-flow pipe" against the
literal `"%>%"` and must now also accept `"%<>%"`:

1. **`call_is_pipe_fed`** (`handlers.rs:16245`) — the bug. Pipe-feeds the first
   formal.
2. **`is_inside_magrittr_rhs`** (`handlers.rs:16264`) — recognizes the magrittr
   `.` pronoun on the RHS of a pipe (`df %<>% { .$x }`, `df %<>% mutate(y = nrow(.))`).
   The `.` is the piped value in `%<>%` exactly as in `%>%`, so this is the same
   semantic class and is fixed for consistency.

To prevent these two sites from drifting apart, introduce a single shared
predicate and call it from both:

```rust
/// Magrittr **forward-flow** pipe operators: those that supply their LHS as the
/// RHS call's implicit first argument and evaluate the RHS in the LHS's data
/// context. magrittr's compound-assignment pipe `%<>%` (`x %<>% f()` ≡
/// `x <- x %>% f()`) flows data into the RHS identically to `%>%`; the only
/// difference is the write-back to the LHS, which does not affect NSE column
/// resolution. Excludes `%$%` (exposition — handled by `is_inside_exposition_rhs`)
/// and `%T>%` is intentionally out of scope (see spec §5).
fn special_is_magrittr_pipe(op_text: &str) -> bool {
    matches!(op_text, "%>%" | "%<>%")
}
```

Both `call_is_pipe_fed` and `is_inside_magrittr_rhs` replace their inline
`node_text(child, text) == "%>%"` check with
`special_is_magrittr_pipe(node_text(child, text))`. (`call_is_pipe_fed` keeps its
separate `child.kind() == "|>"` arm for the native pipe.)

### 4.2 Deliberately left as `%>%`-only

**`is_functional_sequence_head_dot`** (`handlers.rs:16322`) recognizes the
**leading** `.` of a magrittr functional sequence (`f <- . %>% step1()`). `%<>%`
**cannot** head a functional sequence: its LHS must be an assignable lvalue (it
writes the result back), and magrittr builds functional sequences with `%>%`
only. Leaving it `%>%`-only is correct; a one-line comment records why so a future
reader does not "fix" it by symmetry.

### 4.3 Out of scope (not touched)

- **`detect_consecutive_pipe`** (`handlers.rs:~8908`) — a syntax-error message for
  back-to-back pipe tokens (`x %>% %>% y`). It already omits `%<>%` (lists
  `|> %>% %|>%`). This is a parser-error-message nicety unrelated to NSE column
  resolution; adding `%<>%` there is a separate, optional polish and is **excluded**
  from this change to keep the diff tightly scoped to the reported defect.

## 5. Other pipe operators (explicitly considered, not in scope)

- `%$%` (exposition) — already handled separately by `is_inside_exposition_rhs`;
  unaffected.
- `%T>%` (tee) — flows the LHS *unchanged* to the next stage but still calls the
  RHS with the LHS as first arg, so its RHS *is* pipe-fed like `%>%`. However it is
  rare, not in the issue, and not currently modeled anywhere in the pipe code.
  Adding it is out of scope; this spec does not regress it (it was already
  unhandled).
- `%|>%` — appears only in `detect_consecutive_pipe`'s error list, not in NSE
  resolution; out of scope.

**Indentation (pre-existing, out of scope).** `%>%` is also special-cased in the
indentation engine (`crates/raven/src/indentation/context.rs` — pipe-chain
continuation classification and display). `%<>%` currently falls through to
generic infix handling there. This is a **pre-existing** behavior unrelated to the
undefined-variable false positive in #537, is not a regression introduced by this
change, and is left untouched. Noted here so the omission is deliberate, not an
oversight.

## 6. Testing (TDD — red first)

Use the existing end-to-end harness `collect_undefined_messages` (it builds a real
`DiagnosticsSnapshot` with `library(dplyr)` policy and runs
`collect_undefined_variables_from_snapshot`). Each case pairs the suppression
assertion with a positive control (`really_undefined_xyz`) so a silently-empty
collector fails loudly.

1. **Primary regression (positional NSE arg under `%<>%`)** — currently red:
   ```r
   library(dplyr)
   df <- data.frame(x = 1)
   df %<>% group_by(ring)
   really_undefined_xyz
   ```
   Assert `ring` is **not** flagged; `really_undefined_xyz` **is** flagged.

2. **Full issue repro (mixed `%<>%` then `%>%` chain)**:
   ```r
   library(dplyr)
   df <- data.frame(x = 1)
   df %<>% group_by(ring) %>% mutate(z = x)
   really_undefined_xyz
   ```
   Assert neither `ring` nor `x` is flagged; `really_undefined_xyz` is flagged.

3. **`.` pronoun on `%<>%` RHS** (covers the `is_inside_magrittr_rhs` change).
   The dot must be a *genuinely checked* identifier so the test is not vacuous —
   it must **not** sit in a captured-`...` position (where it would be suppressed
   regardless of the fix, as `mutate(y = nrow(.))` would be). Use a standard-eval
   RHS call whose argument is checked:
   ```r
   library(dplyr)
   df <- data.frame(x = 1)
   df %<>% nrow(.)
   really_undefined_xyz
   ```
   Assert `.` is **not** flagged; `really_undefined_xyz` is flagged. (The exact
   red-before-fix form will be confirmed empirically during TDD; `df %<>% { .$x }`
   is the documented fallback if `nrow(.)` proves not red.)

4. **Negative control — checked overflow position under `%<>%` still flags.**
   `pull(.data, var, name, ...)` captures `var`/`name` but its trailing `...` is
   **not** captured (`nse.rs` `dplyr_policy`, `captured_dots = false`). With the
   pipe pre-consuming `.data`, the first two positionals (`v`, `nm`) bind the
   captured `var`/`name` (suppressed) and the third (`typo`) lands in the checked
   overflow:
   ```r
   library(dplyr)
   df <- data.frame(x = 1)
   df %<>% pull(v, nm, typo)
   really_undefined_xyz
   ```
   Assert `typo` **is** flagged (proves pipe-feeding does not blanket-suppress the
   RHS); `v` and `nm` are **not** flagged; `really_undefined_xyz` is flagged. This
   is the concrete witness of the §8 binding-shift behavior.

5. **Namespace-qualified verb under `%<>%`** — `call_is_pipe_fed` keys off the
   call node's parent operator, independent of whether the callee is bare or
   `pkg::fn`; policy resolution handles the qualified callee separately. Pin it:
   ```r
   library(dplyr)
   df <- data.frame(x = 1)
   df %<>% dplyr::group_by(ring)
   really_undefined_xyz
   ```
   Assert `ring` is **not** flagged; `really_undefined_xyz` is flagged.

All go in the `handlers.rs` test module alongside
`nse_tidyverse_idioms_no_false_positive_end_to_end`.

## 7. Docs

`docs/diagnostics.md` §"The magrittr dot, pipe placeholders, and exposition"
(lines ~139–149) enumerates the recognized magrittr forms. Add `%<>%` alongside
`%>%` where the pipe-fed data context and the RHS `.` pronoun are described, so the
documented surface matches behavior. No other user-facing doc changes.

## 8. Risk and blast radius

- Single shared predicate touched by two call sites; `call_is_pipe_fed` is the
  one chokepoint for pipe-feeding across all three NSE paths.
- The change is **false-positive-safe**, which is the property that matters — but
  it is *not* "purely additive." Accepting `%<>%` makes a `%<>%`-fed call pre-
  consume its first formal, shifting the positional argument binding by one (the
  same shift `%>%` already applies). For the common verbs whose args past `.data`
  are all captured (`group_by`, `mutate`, `filter`, …) this only *suppresses* more.
  But for a verb with **checked overflow** formals past the captured ones (`pull`:
  `.data, var, name, ...` with `...` checked), the shift moves a real overflow
  typo from a suppressed slot into a checked slot, so the fix can **newly surface a
  correct diagnostic** (a true positive) — while simultaneously un-flagging the
  column that was wrongly bound to the checked `.data`. Every newly-flagged arg is
  in a genuine standard-eval position, so no *false* positive is ever introduced.
  Test #4 (`pull(v, nm, typo)`) is the concrete witness; the directional invariant
  is: this change can only move flags toward correctness, never away from it.
- CI gates: `cargo fmt --all`, `cargo clippy --workspace --all-targets
  --features test-support -- -D warnings`, plus the full test suite.
