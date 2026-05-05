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
