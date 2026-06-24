# De-echo diagnostic messages that restate their rule id

Date: 2026-06-24
Branch: `fix/check-duplicate-diagnostic-label`

## Problem

`raven check` text output prints each diagnostic as:

```
scripts/validate/oos/estimate.r:161:37 warning: Undefined variable: s.j [undefined-variable]
```

This reads as if the error is reported twice. It isn't: the line is two distinct
fields glued together by the text renderer
(`crates/raven/src/cli/shared.rs:330`):

```rust
"{}:{}:{} {}: {} [{}]"   // path:line:col  level: message [rule]
```

- `message` = the human-readable prose (`Undefined variable: s.j`)
- `[rule]` = the stable, machine-readable **rule id** (`undefined-variable`)

The rule id is intentional and matches the wider ecosystem (ESLint appends
`no-unused-vars`, Ruff prefixes `F841`, Clippy shows `#[warn(...)]`, ShellCheck
`SC2034`, and lintr — which raven emulates — appends `[object_usage_linter]`).
It is also the suppression handle (`# nolint: undefined-variable`,
`# raven: ignore[undefined-variable]`) and the thing users grep on.

The redundancy is therefore **not** the rule id — it is that, for a handful of
rules, the message prose is a near-verbatim restatement of the kebab-case id and
adds nothing the id + caret location don't already convey.

## Goal

Keep the `[rule-id]` on every line. Reword the messages whose prose merely
restates the id so that each line's words carry information the id does not.

## Scope: the four echoing analyzer messages

A full audit of analyzer rule ids against their messages (lintr-derived
`LINT_CODES` all use descriptive lintr prose and do **not** echo):

| Rule id | From | To |
|---|---|---|
| `undefined-variable` | `Undefined variable: {name}` | `{name} is not defined` |
| `undefined-variable` (forward ref) | `Undefined variable: {name} (defined later on line {N})` | `{name} is used before it is defined (defined on line {N})` |
| `syntax-error` | `Syntax error` | `R code could not be parsed here` |
| `unused-suppression` (ignore) | `Unused suppression: no matching diagnostic was suppressed here.` | `This directive suppressed no diagnostic.` |
| `unused-suppression` (expect) | `Unused \`expect\` suppression: no matching diagnostic was suppressed here.` | `This \`expect\` directive matched no diagnostic.` |
| `assign-to-string-literal` (string-literal WARNING variant only) | `Assigning to string literal {x}; R will bind the value to the variable named by the string. Was this intentional?` | `The assignment target {x} is a string literal; R will bind the value to the variable named by that string. Was this intentional?` |

Notes on the rewrites:

- **`undefined-variable`**: `{name}` may already be backtick-quoted for
  non-syntactic names (the loop reuses the usage text verbatim), so the reword
  does **not** add surrounding quotes — `s.j is not defined` /
  `` `weird name` is not defined ``. The forward-reference variant must retain
  the "defined on line {N}" fact.
- **`assign-to-string-literal`**: only the WARNING `"string literal"` arm of
  `format_message` echoes. The wording must stay **direction-agnostic** — R's
  right-assignment (`x -> "foo"`, `->>`) puts the target string on the right, so
  "left side of the assignment" would be wrong. `target_text` is the source
  slice of the assignment *target* node (the bound string) regardless of
  direction; "The assignment target {x}" is correct for `<-`, `=`, and
  `->`/`->>`. The other three `format_message` arms (`dots`, `dot-dot-N`,
  generic, and the ERROR arms) already use descriptive prose and are unchanged.
- **`syntax-error`**: only the generic fallback literal at
  `handlers.rs:7937` ("Syntax error") is reworded. The specific child messages
  (unclosed-paren/brace/bracket, "Missing …") are already descriptive.

## Required correctness fix: re-anchor logic on `code`, not message text

Rewording silently breaks any code that detects these diagnostics by string-
matching the message. The change must re-anchor those matchers onto the
`Diagnostic.code` field — which is the whole point: **the code is the stable
handle; the message is free prose.**

1. **Production logic** —
   `has_package_metadata_sensitive_undefined_diagnostic`
   (`crates/raven/src/cli/check.rs:752`):
   ```rust
   d.message.starts_with("Undefined variable:")
       && !d.message.contains("(defined later on line ")
   ```
   Re-anchor on `d.code == undefined-variable`. The forward-reference exclusion
   (currently keyed on the "(defined later on line " substring) must move to a
   non-message signal. Options, in preference order:
   - keep a substring check against the **new** forward-ref marker
     ("used before it is defined"), or
   - (cleaner, if low-cost) add a structured marker so the matcher needn't read
     prose at all.
   The plan will pick one; either way the message text is no longer the sole
   carrier of the forward-ref distinction relied on by production code.

2. **Test filters** — `handlers.rs` syntax-error filters of the form
   `d.message == "Syntax error" || d.message.starts_with("Missing")`
   (lines ~9433–9529) re-anchor onto the `syntax-error` code (and its
   `SYNTAX_ERROR_CHILDREN` via `diagnostic_code::parent`), not the literal.

## Blast radius

Mechanical but real, dominated by `undefined-variable`:

- `Undefined variable` — ~350 references across `crates/raven/src`, almost all
  test assertions (`message == "Undefined variable: x"` / `.contains(...)`).
- `Syntax error` — ~a dozen test filters / equality checks.
- `Unused suppression` — 2 references.
- `Assigning to string literal` — 1 reference.

Every one must be updated to the new wording (or, where appropriate, switched to
assert on `code`). This is the cost of fixing the prose at the source while
keeping the rule id, versus a renderer-only hack.

## Out of scope

- The `[rule]` suffix itself, `--format json|sarif`, and the renderer
  (`shared.rs`) are unchanged.
- `package-not-installed`, `namespace-member-not-found`,
  `unresolved-source-path`, and all `LINT_CODES` messages — they do not echo.

## Docs

- Grep `docs/diagnostics.md` and `docs/linting.md` for any quoted instance of
  the old message strings and update them.

## Verification

- `cargo fmt --all`
- `cargo clippy --workspace --all-targets --features test-support -- -D warnings`
- `cargo test --workspace` (the reworded-message assertions are the bulk of the
  churn; all must pass)
- Manual: run `raven check` on a file with an undefined variable and confirm the
  line reads e.g. `… warning: s.j is not defined [undefined-variable]`.
