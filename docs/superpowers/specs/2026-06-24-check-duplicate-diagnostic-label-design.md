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

## Codex adversarial review (2026-06-24) — additional dependencies found

A codex review surfaced message-text dependencies beyond the single matcher
originally noted. All must be migrated for the reword to be correct:

1. **Package-corpus fixtures (large).** `crates/raven/tests/package_corpus.rs`
   keys diagnostics by exact `message` (`DiagnosticKey`, ~line 548) and compares
   observed diagnostics against TOML ledgers. The ledgers contain the old
   prose: **~1366 `Undefined variable: …` lines in
   `known_false_positives.toml`, 67 in `accepted_real_diagnostics.toml`, and 9
   `Assigning to string literal …` lines** in the accepted ledger (no
   syntax-error / unused-suppression entries). These must be transformed with
   the *identical* rule as the emitter so keys still match. Transform is regular
   (the message is the only varying field), so it is scriptable + verifiable by
   grep. The heavy corpus run is `#[ignore]` (needs downloaded packages, not in
   routine CI per project policy), but the ledgers are a maintained asset and
   must stay correct.
2. **More syntax-error test filters.** Beyond `handlers.rs:9433–9529`, also
   `handlers.rs:9562, 9690, 9706, 9729, 10423` compare `d.message == "Syntax
   error"`. These are test filters → update the literal.
3. **Undefined-variable test *helpers* that parse the prefix.**
   `handlers.rs:58460` uses `strip_prefix("Undefined variable: ")` to extract
   the name, and `handlers.rs:58784` filters with the same prefix. These must
   be migrated to the new wording (extract via the new shape, or anchor on
   `code`) or they silently stop collecting diagnostics.
4. **VS Code tests.** `editors/vscode/src/test/lsp.test.ts:201,218` classify via
   `message.toLowerCase().includes('undefined')` — the new wording drops the
   word "undefined", so switch to `includes('is not defined')`. Test-only; no
   runtime extension code parses these strings.
5. **Docs.** `docs/diagnostics.md:80` (`Syntax error`) and `:92`
   (`Undefined variable: total_count (defined later on line 7)`) quote old
   examples. `diagnostics.md:88` already describes undefined-variable misses
   across local / cross-file / package scope, confirming "{name} is not
   defined" is accurate (no "in this scope" qualifier).

Confirmed clean by the review: `assign-to-string-literal` directionality (the
`->`/`->>` target is the rhs — `handlers.rs:12879,12884` — so "assignment
target" is direction-agnostic and correct); no cross-file NSE / interface-hash
coupling on message text (`collect_cross_file_nse` and `compute_interface_hash`
key on metadata + `code`, not prose); no runtime LSP/editor consumer parses
these four messages.

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
   (lines ~9433–9529, plus 9562/9690/9706/9729/10423). These are tests, not
   production code, so updating the `"Syntax error"` literal in place is correct
   and lower-risk than re-anchoring on `code`; the `|| starts_with("Missing")`
   branch stays. (Re-anchoring is reserved for the production matcher in #1.)

## Blast radius

Mechanical but real, dominated by `undefined-variable`. Two surfaces:

**Source (`crates/raven/src`), ~350 references** — almost all test assertions
(`message == "Undefined variable: x"` / `.contains(...)`), plus the emitter, the
production matcher, and the two parsing helpers above. Patterns vary
(`format!`, `==`, `.contains`, `strip_prefix`), so this is handled with scoped
regex substitutions verified by recompile + full test run, not a blind sed.

**Fixtures (`crates/raven/tests/fixtures/package_corpus`), ~1433 lines** —
regular `message = "…"` data, transformed by script with the identical rule and
verified by grep (zero old-form remaining).

Bare-phrase occurrences without the `: name` colon (e.g. comment prose
`// false "Undefined variable" diagnostics`, and synthetic placeholder
diagnostics in `backend.rs` whose `message` is literally `"Undefined variable"`)
are **not** message instances and are left untouched — the transform keys on the
`Undefined variable: ` prefix (colon + space).

This is the cost of fixing the prose at the source while keeping the rule id,
versus a renderer-only hack.

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
