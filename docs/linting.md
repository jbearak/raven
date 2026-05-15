# Linting

Raven ships an opt-in, native style linter that re-implements a small subset of [`lintr`](https://lintr.r-lib.org/) rules in Rust against the tree-sitter AST. No R session or `lintr` install is needed — rules run on the parse tree Raven already builds for completions and diagnostics.

This page is the landing point for users coming from `lintr` or `REditorSupport`. The full per-rule trigger details live in [Diagnostics § Style Lints](diagnostics.md#style-lints); per-key configuration reference lives in [Configuration § Linting Settings](configuration.md#linting-settings). This page ties them together.

## Quick start

The linter is off by default. The minimum `settings.json` to turn it on with default rules:

```json
{
  "raven.linting.enabled": true
}
```

All rules default to severity `hint` so they don't crowd the Problems pane. To raise a rule (e.g. line length) to `warning`, or to disable an individual rule, set its severity:

```json
{
  "raven.linting.enabled": true,
  "raven.linting.lineLengthSeverity": "warning",
  "raven.linting.commentedCodeSeverity": "off"
}
```

To change the line-length threshold or pick a different naming scheme:

```json
{
  "raven.linting.enabled": true,
  "raven.linting.lineLength": 120,
  "raven.linting.objectNameStyleFunction": "camelCase",
  "raven.linting.objectNameStyleVariable": "snake_case",
  "raven.linting.objectNameStyleArgument": "any"
}
```

Setting an `objectNameStyle*` to `"any"` disables the check for that symbol kind while leaving the other two active. Setting `raven.linting.objectNameSeverity` to `"off"` disables the rule entirely.

Lint diagnostics carry the `source` field `raven (lint)`, so they're easy to filter from Raven's other diagnostics in the Problems pane.

## Settings reference by rule

Each rule lists the Raven settings that control it and the `lintr` linter it mirrors. Severities accept `"error"`, `"warning"`, `"information"`, `"hint"`, or `"off"`. See [Diagnostics § Style Lints](diagnostics.md#style-lints) for the exact trigger of each rule.

### Line length

- **Raven:** `raven.linting.lineLength` (default `80`), `raven.linting.lineLengthSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::line_length_linter(length = 80L)`.
- Line length is measured in UTF-16 code units to match how LSP positions are reported.

### Trailing whitespace

- **Raven:** `raven.linting.trailingWhitespaceSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::trailing_whitespace_linter()`.

### Tab characters

- **Raven:** `raven.linting.noTabSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::whitespace_linter()` (the no-tab portion).
- One diagnostic per line containing a tab, anchored at the first tab on that line.

### Trailing blank lines

- **Raven:** `raven.linting.trailingBlankLinesSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::trailing_blank_lines_linter()`.
- Also fires when the file is missing a final newline.

### Assignment operator

- **Raven:** `raven.linting.assignmentOperator` (default `"<-"`, alternative `"="`), `raven.linting.assignmentOperatorSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::assignment_linter()`.
- Named-argument `=` inside function calls (`f(name = value)`) is never flagged. Assignments inside nested expressions — function bodies, braced blocks, control flow — are checked even when they appear inside an argument list.

### Object names

- **Raven:** `raven.linting.objectNameStyleFunction`, `raven.linting.objectNameStyleVariable`, `raven.linting.objectNameStyleArgument` (each defaults to `"snake_case"`), `raven.linting.objectNameSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::object_name_linter(styles = ...)`.
- Each kind accepts `"snake_case"`, `"camelCase"`, `"dotted.case"`, `"UPPER_CASE"`, `"lowercase"`, or `"any"` (disable that kind).
- Carve-outs: an optional leading `.` is always valid, but the rest of the name must still match the configured style (so `.helper` is fine under `snake_case`, but `.onLoad` is not — pick `camelCase` for that kind, or suppress it); S3-method names of the form `<known-base-generic>.<class>` (e.g. `print.MyClass`, `as.Date.character`) are exempt; backtick-quoted names and non-ASCII identifiers are skipped.

### Infix spaces

- **Raven:** `raven.linting.infixSpacesSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::infix_spaces_linter()`.
- Spaces required on both sides of arithmetic, comparison, logical, assignment, pipe (`|>`, `%>%`, and any `%...%` user-defined operator), and binary `~`. No spaces on either side of `:`, `::`, `:::`, `$`, `@`, and unary `-`, `+`, `!`, `?`. Alignment whitespace (`x   <- 1`) is allowed; operator-at-end-of-line line continuations are skipped.

### Commented code

- **Raven:** `raven.linting.commentedCodeSeverity` (default `"hint"`).
- **`lintr` equivalent:** `lintr::commented_code_linter()`.
- Flags a standalone comment block (consecutive `#` lines) whose body parses as R and contains a call, assignment, operator, or function definition. Roxygen (`#'`), shebangs, annotation comments (`# TODO:`, `# FIXME:`, `# NOTE:`, `# XXX:`, `# HACK:`, `# BUG:`, `# WARNING:`, `# OPTIMIZE:`), Emacs mode lines, and `# nolint` / `# @lsp-…` directives are skipped. End-of-line comments next to real code (`x <- 1 # explain`) are never flagged.

## Migrating from `.lintr`

Raven does not read `.lintr` files — its rules are configured per VS Code settings instead. The table below maps the `lintr` linters covered by Raven to their Raven equivalents. For each `lintr` linter you currently enable, set the corresponding `raven.linting.*` keys; for ones not listed, see [Gaps vs `lintr`](#gaps-vs-lintr).

| `.lintr` linter | Raven settings |
|---|---|
| `line_length_linter(length = N)` | `raven.linting.lineLength = N`, `raven.linting.lineLengthSeverity` |
| `trailing_whitespace_linter()` | `raven.linting.trailingWhitespaceSeverity` |
| `whitespace_linter()` (no-tab portion) | `raven.linting.noTabSeverity` |
| `trailing_blank_lines_linter()` | `raven.linting.trailingBlankLinesSeverity` |
| `assignment_linter()` | `raven.linting.assignmentOperator`, `raven.linting.assignmentOperatorSeverity` |
| `object_name_linter(styles = c("snake_case"))` | `raven.linting.objectNameStyleFunction`, `raven.linting.objectNameStyleVariable`, `raven.linting.objectNameStyleArgument`, `raven.linting.objectNameSeverity` |
| `infix_spaces_linter()` | `raven.linting.infixSpacesSeverity` |
| `commented_code_linter()` | `raven.linting.commentedCodeSeverity` |

To disable a rule from a `.lintr` `linters_with_defaults(..., default = list())` setup, set its severity to `"off"`. To raise a rule that `lintr` would flag as a `warning`, raise its severity from `"hint"` to `"warning"`.

If you'd also like a starter `.lintr` for running `lintr` itself alongside Raven (see [below](#filling-the-gaps-with-lintr-itself)), run the **Raven: Create .lintr** command from the Command Palette ([Configuration § Scaffold Commands](configuration.md#scaffold-commands)). It writes a minimal `linters: linters_with_defaults(line_length_linter(120))` to the workspace root.

## Gaps vs `lintr`

`lintr` ships several dozen linters. Raven implements the eight in the table above. Common `lintr` linters that have **no Raven equivalent** include (non-exhaustive):

- `object_usage_linter` — flags undefined globals inside function bodies via `codetools::checkUsage()`. Raven's [Undefined variable diagnostic](diagnostics.md#undefined-variables) covers similar ground at the file and `source()`-chain level (via static cross-file scope), but with different semantics: Raven's check is scope- and position-aware across `source()` chains, while `object_usage_linter` runs inside individual function bodies via R's own analyzer.
- `cyclocomp_linter` — cyclomatic complexity.
- `T_and_F_symbol_linter`, `quotes_linter`, `single_quotes_linter`.
- `semicolon_linter`, `seq_linter`, `vector_logic_linter`, `equals_na_linter`.
- `brace_linter`, `paren_body_linter`, `indentation_linter`, `function_left_parentheses_linter`, `spaces_inside_linter`, `spaces_left_parentheses_linter`, `commas_linter`.
- `pipe_continuation_linter`, `pipe_call_linter`.
- `absolute_path_linter`, `object_length_linter`.

If you rely on any of these, the recommended setup is to run `lintr` via the `REditorSupport (R)` extension alongside Raven — Raven's language server is designed to coexist with REditorSupport. See [below](#filling-the-gaps-with-lintr-itself).

### Filling the gaps with `lintr` itself

The [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) runs `lintr` from inside its own R-based language server, so it covers every linter `lintr` ships. To run both at once:

1. Keep Raven installed and enabled.
2. Install the REditorSupport (R) extension. Leave `r.lsp.enabled` at its default (`true`).
3. Place a `.lintr` file at your project root. The **Raven: Create .lintr** command writes a starter (`linters: linters_with_defaults(line_length_linter(120))`).
4. Install `lintr` in the R session REditorSupport uses (`install.packages("lintr")`).

REditorSupport's LSP will surface `lintr` diagnostics; Raven will continue to surface its own. Both sets will appear in the Problems pane and you can tell them apart by the `source` field (`raven (lint)` for Raven, `lintr` for REditorSupport). See [Coexistence § Language servers](coexistence.md#language-servers-raven-alone-vs-both) for the broader cross-extension model.

## Suppression matrix

Raven recognizes both `lintr` and its own suppression markers. All four apply to lint diagnostics. `# @lsp-ignore` and `# @lsp-ignore-next` additionally apply to Raven's non-lint diagnostics (undefined variable, cross-file, etc.); `# nolint` and `# nolint start/end` apply to lint diagnostics only.

| Marker | Scope | Origin | Applies to |
|---|---|---|---|
| `# nolint` (trailing) | The line it appears on | `lintr` convention | Lint diagnostics |
| `# nolint: rule_a, rule_b` | The line it appears on | `lintr` convention | Lint diagnostics (rule filter accepted but currently ignored — suppresses all rules on the line) |
| `# nolint start` … `# nolint end` | Inclusive range between the two markers | `lintr` convention | Lint diagnostics |
| `# @lsp-ignore` | The line it appears on | Raven | All Raven diagnostics |
| `# @lsp-ignore-next` | The *following* source line | Raven | All Raven diagnostics |

Notes:

- A `# nolint` marker inside a string literal (`x <- "# nolint"`) is not parsed as a marker.
- A typo like `# nolinter` or `# @lsp-ignored` is intentionally not recognized — better to surface the lint than to silently swallow it.
- An unterminated `# nolint start` suppresses through end of file (matching `lintr`).

### One known suppression edge case

Raven's suppression parser scans each line left-to-right and treats the **first** `#` (outside any string literal) as the marker comment. A trailing `# nolint` next to real code works fine — there's no earlier `#` on that line — but an inline `# nolint` *inside* a commented-code line does **not** suppress the `commented_code` lint:

```r
# x <- 1 # nolint
```

The leading `#` is taken as the marker comment, and its body is `x <- 1 # nolint` — which doesn't start with `nolint` or `@lsp-ignore`, so no suppression is registered. The `commented_code` rule then parses `x <- 1` as R code and flags it.

To suppress the rule on a commented-code line, put the marker on a separate line:

```r
# @lsp-ignore-next
# x <- 1
```

Or use a block:

```r
# nolint start
# x <- 1
# y <- 2
# nolint end
```

This is consistent with how `lintr` itself treats a same-line `# nolint` — the marker has to be a *separate* comment, not nested inside another one.

## Performance and scope notes

- **Static, no R subprocess.** Raven's lint rules run against the tree-sitter parse it already maintains for completions and diagnostics. There's no `lintr` install, no `R` process, no startup cost. The `commented_code` rule re-parses each candidate comment body via a thread-local parser pool; every other rule walks only the already-parsed tree.
- **UTF-16 line length.** Raven measures line length in UTF-16 code units (matching LSP position reporting), so a non-BMP character counts as two. `lintr` counts characters; for ASCII-only code the two agree.
- **`commented_code` differs subtly from `lintr`.** Both decide whether a comment body "looks like code" by parsing it, but Raven parses with tree-sitter and `lintr` parses with R itself. Edge cases that exercise R-specific syntax (very old `_` assignment, non-ASCII operator overloads, etc.) may be classified differently.
- **Position-aware, but not call-flow-aware.** Raven walks the AST top-down for most rules and does not run R-level data-flow analysis. Rules that would need that (`object_usage_linter`, `cyclocomp_linter`, `seq_linter`) are intentionally out of scope for the native linter — run `lintr` for those (see [above](#filling-the-gaps-with-lintr-itself)).

## See also

- [Diagnostics § Style Lints](diagnostics.md#style-lints) — full trigger list and rule details.
- [Configuration § Linting Settings](configuration.md#linting-settings) — every `raven.linting.*` key.
- [Coexistence § Language servers](coexistence.md#language-servers-raven-alone-vs-both) — running Raven and REditorSupport together.
- [Comparison](comparison.md) — how Raven differs from REditorSupport, Positron/Ark, and RStudio.
