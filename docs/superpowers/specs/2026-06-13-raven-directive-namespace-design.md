# Unify the `# raven:` directive namespace across all directive families (#421)

**Status:** approved (design)
**Issue:** #421
**Date:** 2026-06-13

## Problem

The `# raven:` directive namespace was introduced (PR #420) for diagnostic
suppression, where it is the *primary* prefix and `@lsp-ignore` / `@lsp-expect`
are aliases. Every *other* directive family is still `@lsp-`-only:

| Family | Tokens | `@lsp-` form | `# raven:` form (today) |
|---|---|---|---|
| Suppression | `ignore`, `expect` (+ `-next`/`-start`/`-end`/`-file`) | ✅ (alias) | ✅ **primary** |
| Forward source | `source` / `run` / `include` | ✅ | ❌ |
| Backward provenance | `sourced-by` / `run-by` / `included-by` | ✅ | ❌ |
| Working directory | `cd` (+ `wd`/`working-directory`/…) | ✅ | ❌ |
| Declarations | `var`/`variable`, `func`/`function` (+ `declare-*`) | ✅ | ❌ |

A user who learns `# raven: ignore` reasonably expects `# raven: source …` to
work, but it doesn't — they must switch to `@lsp-source`. Two user-facing
prefixes where one covers only suppression and the other covers everything is
inconsistent and hard to teach.

## Decision

**Option 1 (additive, non-breaking):** make `# raven:` the single canonical
user-facing prefix across **all** directive families, keeping **every** existing
`@lsp-` token as a permanent backward-compatible alias.

This is the dominant best practice. Pyright (`# pyright:`), Pyrefly
(`# pyrefly:`), pylint (`# pylint:`), and ESLint (`eslint-*`) each use a single
branded prefix that covers all directive families; ruff makes the inherited
`# flake8: noqa` a permanent alias of its branded `# ruff: noqa`. The only major
tool with a *split* directive surface is TypeScript (`/// <reference>` vs
`// @ts-*`), and that split is documented historical accretion, not deliberate
design — the exact inconsistency #421 describes. (Convergent aside: TS
`@ts-expect-error` and Rust `#[expect]` both adopted "suppress **and**
warn-if-unused", which raven already mirrors with `expect`.)

Confirmed sub-decisions:

- **Full synonym parity.** Every `@lsp-` keyword also works under `raven:`
  (`# raven: run`, `# raven: wd`, `# raven: variable`, …). This falls out for
  free from generalizing the prefix, since the keyword vocabularies are shared.
- **Docs lead with `raven:`** across every family, with a one-line "all `@lsp-`
  forms remain permanent aliases" note, mirroring how the suppression section
  already reads.

### Backward compatibility

All existing `@lsp-` directives keep working indefinitely. `raven:` forms are
purely additive aliases, never replacements. No behavior of any `@lsp-` form
changes.

## Architecture

Directive recognition lives in exactly two regex sets, which share only their
keyword vocabularies (`FORWARD_DIRECTIVE_KEYWORDS`, `BACKWARD_DIRECTIVE_KEYWORDS`
in `cross_file/directive.rs`) — the `@lsp-` prefix is written separately in each
pattern. The change generalizes that prefix in both sets.

### 1. Core parser — `crates/raven/src/cross_file/directive.rs`

In `patterns()`, replace the literal `@lsp-` in the five structural patterns
(`backward`, `forward`, `working_dir`, `declare_var`, `declare_func`) with the
alternation `(?:@lsp-|raven:\s*)`. The keyword groups and separator tails are
unchanged, so:

- All synonyms are auto-mirrored under `raven:` (full parity, no per-keyword
  work).
- The optional-colon/optional-space and quoted/`line=`/`match=` grammars carry
  over verbatim: `# raven: source: "u.R" line=20`,
  `# raven: sourced-by ../m.R line=15 match="source("`, `# raven: cd "../d"`,
  `# raven: var x`.
- `# raven:source` (no space) is accepted, matching the existing suppression
  grammar (`raven:\s*`).

Suppression patterns (`raven_ignore`, `raven_ignore_next`, …) are **untouched**
— they already carry `raven:` forms.

**No collision.** The structural keyword groups (`source|run|include`,
`sourced-by|run-by|included-by`, the cd/wd family, the var/func family) are
disjoint from `ignore|expect`. `# raven: ignore` still routes to the suppression
branch; `# raven: source` to the forward branch. The full-file pass already
tries forward/suppression/declaration patterns in sequence; the disjoint keyword
sets make the order immaterial for `raven:` lines.

**Semantics inherited unchanged.** Header-only gating (backward + working-dir)
and full-file recognition (forward + declarations) run on the same branches, so
`# raven: sourced-by` / `# raven: cd` are header-only and `# raven: source` /
`# raven: var` work anywhere — automatically matching their `@lsp-` counterparts.

### 2. Path intellisense — `crates/raven/src/file_path_intellisense.rs`

Apply the same `(?:@lsp-|raven:\s*)` generalization to the `backward` and
`forward` patterns in `directive_path_patterns()`. This is **required** for
functional parity: without it, `# raven: source foo.R` would lose path
completion, go-to-definition on the path argument, and missing-file path
diagnostics. The BOM-tolerant leading character class (`[\s\u{feff}]*`) and the
shared keyword constants are unchanged.

### 3. Commented-code lint marker — `crates/raven/src/linting/rules/commented_code.rs`

`is_directive_marker` already returns true for any `# raven:` line (it strips the
`raven` prefix and checks for a following `:`), so the new families are already
treated as directive markers rather than commented-out code. **No code change**;
add tests to lock in the behavior for the new families.

### 4. Diagnostic-message wording — `crates/raven/src/handlers.rs`

Several path/line diagnostics for forward sources hardcode the prefix, e.g.
*"Cannot resolve path '…' in @lsp-source directive"*. A user who wrote
`# raven: source` would see a mismatched prefix. Soften the wording to drop the
hardcoded prefix (e.g. *"…in source directive"*, *"referenced by source
directive"*). This touches:

- the message-text gate at `handlers.rs:4584-4585`
  (`d.message.contains("… @lsp-source directive")`), which must be updated in
  lockstep with the new wording, and
- any tests asserting the literal message strings.

Mechanical, but must move together so the gate keeps matching.

### 5. Docs — `docs/directives.md` (+ `README.md` if it shows examples)

- Update the General-Syntax note: `# raven:` is the canonical prefix across all
  families; every `@lsp-` form remains a permanent alias.
- Flip each family's primary examples (Forward, Backward, Working Directory,
  Declarations) to lead with `# raven: …`, showing the `@lsp-` form as the alias
  — mirroring the existing Ignore section.

## Testing strategy

TDD: write the failing parity/near-miss tests first, then make the prefix
changes.

- **`directive.rs`**
  - Per family: a `raven:` happy-path test and a parity assertion that the
    `raven:` form produces the same parsed `CrossFileMetadata` as the `@lsp-`
    form (path/line/symbol/call-site).
  - Header-only parity: `# raven: sourced-by` / `# raven: cd` after a line of
    code are ignored (like their `@lsp-` forms).
  - Full synonym coverage: drive every keyword in the shared alternations under
    `raven:`.
  - **Near-miss matrix** (must NOT match), mirroring the suppression near-miss
    tests: `# raven source …` (no colon), `# ravens: source …`,
    `# ravenx: source`, leading non-comment junk, etc.
- **`file_path_intellisense.rs`**
  - Extend the existing keyword round-trip test (`FORWARD`/`BACKWARD`
    alternations) to also drive `# raven: {kw}` for forward and backward.
  - A path-context test confirming the path column/range is detected for a
    `# raven: source` / `# raven: sourced-by` directive.
- **`commented_code.rs`**
  - `is_directive_marker("# raven: source ../h.R")`, `"# raven: cd /d"`,
    `"# raven: var x"` → true; near-misses → false.
- **`handlers.rs`**
  - Update any message-text assertions for the new wording; add/extend a test
    that a `# raven: source` to a missing file produces the (re-worded)
    diagnostic.

## CI gates

Both must be green before commit:

- `cargo fmt --all`
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings`

## Out of scope (YAGNI)

- No new keywords or "cleaner" canonical spellings under `raven:` — additive only.
- No change to any `@lsp-` behavior.
- No migration tooling or deprecation of `@lsp-`.
