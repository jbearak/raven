# Diagnostics

Raven reports problems in your R code as you type — undefined variables, missing packages, circular dependencies, and scope violations. Diagnostics are cross-file-aware: they reflect the full dependency graph, not just the open buffer.

Diagnostics are deferred until the workspace scan completes (in `auto` backward dependency mode), so cross-file warnings reflect the full project.

Diagnostics fall into two groups. **Correctness diagnostics** — parse errors, undefined variables, package and cross-file issues, assignment-target errors, and semantic warnings — are always on whenever `raven.diagnostics.enabled` is true; per-category severities only tune them. **Style lints** are subjective formatting rules and are off until you set `raven.linting.enabled` to `true`. If you're looking for a specific check, scan the categories below before reaching for [Linting](linting.md), which only covers the opt-in style group.

## Quick Reference

- **Silence one site** — add `# @lsp-ignore` on the line, or `# @lsp-ignore-next` on the line above
- **Declare a symbol the analyzer can't see** — use [`@lsp-var`, `@lsp-func`](directives.md#declaration-directives)
- **Bring a parent file's symbols into scope** — usually nothing to do (auto mode infers relationships). Add `@lsp-sourced-by` only when auto-discovery can't see the link. See [Cross-File Awareness](cross-file.md)
- **Turn a category off globally** — set the matching severity to `"off"` (see [Configuration](configuration.md))
- **Disable everything** — set `raven.diagnostics.enabled` to `false`

## Diagnostic Categories

### Parse Errors

Raven surfaces parse errors from the tree-sitter R grammar whenever the document cannot be parsed as valid R. There's no per-rule severity knob, but the master switch `raven.diagnostics.enabled` suppresses them along with every other diagnostic. Where possible Raven provides a specific, actionable message rather than a generic "Syntax error":

| Message | Trigger |
|---|---|
| `Unclosed string literal` | An opening `"` or `'` has no matching closing delimiter |
| ``Consecutive pipe `\|>`: expected an expression before this operator.`` | Two pipe operators appear back-to-back without an intervening expression (`x \|> \|> y`) |
| ``Mismatched brackets: `(` opened here; close with `)` not `]`.`` | A bracket opened with `(`, `[`, or `[[` is closed with a non-matching bracket (`c(1, 2]`) |
| `Missing )` / `Missing ]` / etc. | A delimiter was opened but never closed (`library(`) |
| `In R, 'else' must appear on the same line as the closing '}' of the if block` | `else` placed on its own line after `if (cond) { body }` — R treats the `if` as complete and the `else` becomes an unexpected token |
| `Syntax error` | Tree-sitter detected a parse error that doesn't match any of the specific patterns above |

### Undefined Variables

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Undefined variable | warning | Symbol used that is not defined in scope (local, cross-file, or package) |

Raven checks whether each symbol reference has a visible definition — either in the current file (above the cursor), in a sourced parent/child file (respecting position), or in a loaded package. If not found, it reports an undefined variable diagnostic at the configured severity (default `warning`; see `raven.diagnostics.undefinedVariableSeverity` in [Configuration](configuration.md)).

**What suppresses it:**
- A definition above the usage in the same file
- A definition in a sourced file (via `source()` or directives)
- A package export from a loaded `library()`
- A declaration directive (`@lsp-var`, `@lsp-func`)
- An `@lsp-ignore` on the line

**Not checked:** Symbols on the RHS of `$` or `@` (member access), function parameters, formula variables, NSE contexts (e.g., `dplyr::select(df, col)`).

### Package Diagnostics

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Missing package | warning | `library()` references a package not installed on the system |

### Cross-File Diagnostics

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Missing file | warning | `source()` or directive references a file that doesn't exist |
| Circular dependency | error | Two files source each other (directly or transitively) |
| Max chain depth exceeded | warning | Source chain exceeds configured maximum depth |
| Out-of-scope symbol | warning | Symbol from a sourced file used before the `source()` call |
| Redundant directive | hint | `@lsp-source` directive for a file already brought in by an earlier `source()` call |

### Assignment Targets

Always on whenever diagnostics are enabled; not configurable per rule. Applies to every assignment operator: `<-`, `<<-`, `=`, `->`, `->>`. For right-arrow operators the target is the right-hand side; for the others it's the left-hand side. Both tiers honor `# @lsp-ignore` / `# @lsp-ignore-next` on the affected line.

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Invalid assignment target | error | Target is a value R rejects outright: a literal (`TRUE`, `FALSE`, `NULL`, any `NA*`, `Inf`, `NaN`, a number including signed `-1`/`+1.5`) or a reserved word (`else`, `in`, `next`, `break`) |
| Suspicious assignment target | warning | Target is something R technically accepts, but the binding is almost always unintended: a string literal (`"foo" <- 1` — R binds the value to a variable named `foo`) or a dots argument (`... <- 1`, `..1 <- 1` — R creates a binding the standard `...` / `..N` accessors can't reach) |

**Not flagged:**
- `T <- FALSE` / `F <- TRUE` — `T` and `F` are ordinary bindings that default to `TRUE`/`FALSE`; R accepts the assignment. Use the [`T` / `F` symbol](#style-lints) style lint if you want these reported.
- `f(name = value)` — named-argument syntax inside a call, not assignment.
- `function(x = TRUE)` — default values in formal parameters, not assignment.
- `if <- 1`, `for <- 1`, `while <- 1`, `function <- 1`, `repeat <- 1` — tree-sitter reports these as syntax errors directly, so the same code surfaces only one diagnostic.

### Semantic Warnings

Always-on diagnostics that flag likely-wrong code — not style preferences. Active as long as `raven.diagnostics.enabled` is true. Configurable severity via `raven.diagnostics.*`; honor `# @lsp-ignore` / `# @lsp-ignore-next` and `# nolint`.

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Mixed logical operators | warning | `\|` / `\|\|` whose immediate operand is a bare `&` / `&&` (no parentheses), e.g. `a & b \| c`. `&` binds more tightly than `\|` in R, making the grouping easy to mis-read. Stops at call/subset boundaries |
| Condition assignment | warning | `=` used as a binary operator directly inside an `if` / `while` condition (`if (x = 1)`). R rejects this as a syntax error at runtime; tree-sitter-r accepts it silently. Stops at call, parenthesized-expression, and braced-expression boundaries |

**Suppression:** `# @lsp-ignore` on the line, `# @lsp-ignore-next` on the line above, or `# nolint` (with optional rule names `mixed_logical`, `condition_assignment`).

**Settings:** `raven.diagnostics.mixedLogicalSeverity` (default `"warning"`), `raven.diagnostics.conditionAssignmentSeverity` (default `"warning"`).

### Style Lints

Native, opt-in style diagnostics (a small subset of [`lintr`](https://lintr.r-lib.org/)). Implemented in Rust against the tree-sitter AST — no R or `lintr` install required. Off by default; enable with `raven.linting.enabled` and tune per rule via the `raven.linting.*` severities. All style lint rules default to severity `hint` so they don't crowd the Problems pane. For a user-facing guide — quick-start config, `.lintr` migration, gaps vs `lintr`, and how to run `lintr` alongside Raven — see [Linting](linting.md).

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Line length | hint | Line exceeds `raven.linting.lineLength` (default 80 UTF-16 code units) |
| Trailing whitespace | hint | Spaces or tabs at end of line |
| Tab character | hint | Tab character anywhere in source |
| Trailing blank lines | hint | Blank lines at end of file, or missing final newline |
| Assignment operator | hint | Top-level assignment uses an operator other than the preferred one (`<-` by default; configurable via `raven.linting.assignmentOperator`) |
| Object name | hint | Function, variable, or argument name doesn't match the configured naming scheme (`snake_case` by default; configurable per kind via `raven.linting.objectNameStyle*`) |
| Object length | hint | Identifier name exceeds `raven.linting.objectLength` characters (default 30; leading `.` not counted) |
| Infix spaces | hint | Missing space around a binary operator (`a+b`, `x<-1`, `a%>%b`, `if (a<=b)`), or stray space around a tight-binding operator (`obj $ field`, `1 : 10`, unary `- x`) |
| Commented code | hint | A standalone comment whose body parses as R and contains a call, assignment, or operator (`# foo(bar)`, `# x <- 1 + 2`) |
| Quotes | hint | String literal not using the preferred delimiter (`raven.linting.stringDelimiter`; default `"`). Raw strings are exempt |
| Commas | hint | Whitespace before `,` (`a , b`) or missing whitespace after `,` (`c(1,2)`). Newline after comma is fine |
| `T` / `F` symbol | hint | Bare `T` / `F` used in reference position (use `TRUE` / `FALSE`). Skipped at assignment targets, named arguments, formal parameters, and `$`/`@` field names |
| Semicolon | hint | `;` separator outside strings/comments (`a; b`, trailing `a;`) |
| Equals NA | hint | `x == NA`, `x != NA`, or any typed-`NA` variant on either side. Use `is.na(x)` |
| Vector logic | hint | `&` or `\|` in an `if` / `while` condition (use `&&` / `\|\|` for scalars). Scan stops at call boundaries |
| Function left parentheses | hint | Whitespace between `function` (or `\`) and `(` (`function (x) ...`, `\ (x) ...`) |
| Spaces inside | hint | Whitespace immediately inside `(`, `[`, or `[[` (`f( x )`, `df[ 1 ]`). Empty groupings and multi-line wrapping are exempt |
| Indentation | hint | Leading whitespace doesn't match the expected indent for the line's AST scope (braced blocks, multi-line argument lists, continuation lines). Configurable indent unit via `raven.linting.indentationUnit` (default 2) |

Lint diagnostics carry the `source` field `raven (lint)` so they're easy to distinguish from cross-file or syntax diagnostics. Named-argument `=` inside function calls is never flagged.

The infix-spaces lint flags two opposing cases. **Spaces required** on both sides: arithmetic (`+`, `-`, `*`, `/`, `^`), comparison (`<`, `<=`, `==`, `!=`, ...), logical (`&`, `&&`, `|`, `||`), assignment (`<-`, `<<-`, `->`, `->>`, `=`), pipe (`|>`, `%>%`, any `%...%`), and binary formula (`y ~ x`). **No spaces** on either side: sequence (`:`), namespace (`::`, `:::`), member access (`$`, `@`), and unary `-`, `+`, `!`, `?`. The rule is conservative — alignment whitespace (`x   <- 1`) is not flagged, and line-continuation cases (operator at end of line, RHS on the next line) are skipped since the line break supplies the separation.

The commented-code lint groups consecutive standalone comment lines and try-parses their bodies as R. A block is reported when it parses without errors **and** contains at least one call, assignment, binary/unary operator, function definition, or control-flow construct — bare identifiers and literals are treated as prose. End-of-line comments next to real code (`x <- 1 # explain`) are never flagged. Roxygen lines (`#'`), shebangs, annotation comments (`# TODO:`, `# FIXME:`, `# NOTE:`, `# XXX:`, `# HACK:`, `# BUG:`, `# WARNING:`, `# OPTIMIZE:`), Emacs mode lines (`# -*- ... -*-`), and `# nolint` / `# @lsp-…` directives are skipped up front.

The object-name lint has independent style settings for **functions** (`objectNameStyleFunction`), **variables** (`objectNameStyleVariable`), and **arguments** (`objectNameStyleArgument`). Each accepts `snake_case`, `camelCase`, `dotted.case`, `UPPER_CASE`, `lowercase`, or `any`. Using `any` accepts all names for that kind — since the three are checked independently, you can enforce a style on two while opting out of the third.

> [!NOTE]
> Some names are always accepted regardless of the configured style:
> - An optional leading `.` is always valid; the rest of the name must still match (e.g. `.helper` under `snake_case` is fine, `.myHelper` is not).
> - Function definitions with the shape `<generic>.<class>` are exempt when `<generic>` is a known base R S3 generic (`print.MyClass`, `as.Date.character`, `print.data.frame`, etc.). For less-common generics, use `# nolint` or `# @lsp-ignore`.
> - Backtick-quoted names (e.g. `` `with spaces` ``, `` `+.MyClass` ``) and non-ASCII identifiers are skipped entirely.

**Suppression:** lint diagnostics honor the `lintr` conventions in addition to Raven's own:

- `# nolint` on a line suppresses lints on that line (rule-name filters like `# nolint: line_length` are accepted; for now, all rules are suppressed on suppressed lines).
- `# nolint start` / `# nolint end` brackets a region.
- The standard `# @lsp-ignore` and `# @lsp-ignore-next` markers also apply to lint diagnostics.

## Suppression

### Per-Line: @lsp-ignore

```r
x <- unknown_var # @lsp-ignore
```

```r
# @lsp-ignore-next
x <- unknown_var
```

### Per-Symbol: Declaration Directives

```r
load("data.RData")
# @lsp-var model_fit
# @lsp-var training_data
x <- model_fit  # No warning
```

See [Directives](directives.md#declaration-directives) for full syntax.

### Per-Category: Configuration

Each diagnostic category has a severity setting that accepts `"error"`, `"warning"`, `"information"`, `"hint"`, or `"off"`:

```json
"raven.crossFile.missingFileSeverity": "off",
"raven.diagnostics.undefinedVariableSeverity": "off"
```

See [Configuration](configuration.md) for all severity settings.

## Cross-File Behavior

Diagnostics respect the full dependency graph:

```r
# main.R
library(dplyr)
source("analysis.R")
```

```r
# analysis.R
# In auto mode, Raven discovers that main.R sources this file
result <- mutate(df, x = 1)  # No warning: dplyr loaded in parent before source()
```

When a parent file changes (e.g., a `library()` call is added or removed), Raven revalidates diagnostics in dependent files automatically.

## JAGS and Stan

Diagnostics are suppressed for JAGS (`.jags`, `.bugs`) and Stan (`.stan`) files because Raven cannot statically determine what is in scope in these languages.
