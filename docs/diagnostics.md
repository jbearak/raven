# Diagnostics

Raven reports problems in your R code as you type — undefined variables, missing packages, circular dependencies, and scope violations. Diagnostics are cross-file-aware: they reflect the full dependency graph, not just the open buffer.

Diagnostics are deferred until the workspace scan completes (in `auto` backward dependency mode), so cross-file warnings reflect the full project.

## Quick Reference

- **Silence one site** — add `# @lsp-ignore` on the line, or `# @lsp-ignore-next` on the line above
- **Declare a symbol the analyzer can't see** — use [`@lsp-var`, `@lsp-func`](directives.md#declaration-directives)
- **Bring a parent file's symbols into scope** — usually nothing to do (auto mode infers relationships). Add `@lsp-sourced-by` only when auto-discovery can't see the link. See [Cross-File Awareness](cross-file.md)
- **Turn a category off globally** — set the matching severity to `"off"` (see [Configuration](configuration.md))
- **Disable everything** — set `raven.diagnostics.enabled` to `false`

## Diagnostic Categories

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
| Out-of-scope symbol | warning | Symbol from a sourced file used before the source() call |
| Ambiguous parent | warning | Multiple parents source this file and auto-inference can't determine which to use |
| Redundant directive | hint | `@lsp-source` directive for a file already sourced via `source()` on the same line |

### Style Lints

Native, opt-in style diagnostics (a small subset of [`lintr`](https://lintr.r-lib.org/)). Implemented in Rust against the tree-sitter AST — no R or `lintr` install required. Off by default; enable with `raven.linting.enabled` and tune per rule via the `raven.linting.*` severities. All rules default to severity `hint` so they don't crowd the Problems pane.

| Diagnostic | Default Severity | Trigger |
|---|---|---|
| Line length | hint | Line exceeds `raven.linting.lineLength` (default 80 UTF-16 code units) |
| Trailing whitespace | hint | Spaces or tabs at end of line |
| Tab character | hint | Tab character anywhere in source |
| Trailing blank lines | hint | Blank lines at end of file, or missing final newline |
| Assignment operator | hint | Top-level assignment uses an operator other than the preferred one (`<-` by default; configurable via `raven.linting.assignmentOperator`) |
| Object name | hint | Function, variable, or argument name doesn't match the configured naming scheme (`snake_case` by default; configurable per kind via `raven.linting.objectNameStyle*`) |

Lint diagnostics carry the `source` field `raven (lint)` so they're easy to distinguish from cross-file or syntax diagnostics. Named-argument `=` inside function calls is never flagged.

The object-name lint has independent style settings for **functions**, **variables**, and **arguments**. Each accepts `snake_case`, `camelCase`, `dotted.case`, `UPPER_CASE`, `lowercase`, or `any` (which disables that specific kind without disabling the rule entirely). An optional leading `.` (R's "hidden identifier" convention — e.g. `.helper`, `.config`) is accepted under every scheme; the body after the dot must still match. Function definitions whose name has the shape `<generic>.<class>` are exempt when `<generic>` is a known base R S3 generic — this includes methods of single-word generics (`print.MyClass`, `format.Date`, `summary.lm`) as well as methods of generics that themselves contain a dot (`as.Date.character`, `is.numeric.foo`, `all.equal.default`); class names with dots (`print.data.frame`) also match. For less-common generics, use `# nolint` or `# @lsp-ignore` on the definition. Backtick-quoted names (e.g. `` `with spaces` <- 1 ``, operator overloads like `` `+.MyClass` <- function(x, y) ... ``) and non-ASCII identifiers are also skipped.

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
