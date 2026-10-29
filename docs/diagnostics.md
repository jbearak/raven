# Diagnostics

[Docs](README.md) › Analysis

Raven reports problems in your R code as you type and in `raven check`: undefined variables, broken `source()` paths, missing packages, parse errors, and likely-wrong code, checked across every file your script sources.

<!-- example: diag-undefined-variable file=analysis.R -->
```r
scores <- c(82, 91, 77)
average <- mean(scroes)
print(average)
```

<!-- example: diag-undefined-variable -->
```console
$ raven check .
analysis.R:2:17 warning: scroes is not defined [undefined-variable]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

Each finding carries a stable code in brackets, such as `[undefined-variable]`. Look the code up under [Diagnostic codes](#diagnostic-codes) for what it means and how to fix or silence it.

## What you see

In the editor, findings appear as squiggles and in the Problems pane. From the command line, `raven check` prints one line per finding with the file, line, column, severity, message, and code, then a summary line. See [Command line](cli.md) for output formats and exit codes.

Diagnostics follow the whole dependency graph, not just the open file. A symbol defined in a sourced file, or a package loaded by the script that sources yours, counts as defined.

In auto backward-dependency mode, Raven waits for the workspace scan to finish before it publishes diagnostics, so cross-file warnings reflect the full project.

Raven's checks fall into two groups:

- **Correctness diagnostics**: parse errors, undefined variables, package and cross-file problems, assignment-target errors, and semantic warnings. These are on whenever `raven.diagnostics.enabled` is true. Most have a severity setting that can raise, lower, or turn them off. R parse errors and assignment-target errors have no setting of their own and follow only the master switch. JAGS/BUGS and Stan diagnostics are opt-in with `raven.diagnostics.jags` and `raven.diagnostics.stan` (both default `"off"`).
- **Style lints**: subjective formatting rules, controlled by `raven.linting.enabled`. See [Style lints](#style-lints) and [Linting](linting.md).

<a id="cross-file-behavior"></a>
### When dependencies change

When a parent file changes, Raven rechecks the files that depend on it. In this pair, `mutate()` in `analysis.R` is not flagged because `main.R` loads dplyr before it sources `analysis.R`. Remove the `library(dplyr)` line and the warning appears in `analysis.R`.

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

### Which files get diagnostics in VS Code

In the VS Code extension, Raven shows diagnostics for files open in a tab.

- Files Raven indexed in the background, or that another extension opened without a tab, still contribute symbols and dependencies, but get no Problems entries of their own.
- Closing a file's last tab clears its diagnostics, even if another extension keeps the document open. Opening a tab for it shows them again.
- In a diff editor, the modified side gets diagnostics. The original side gets them only if it is also shown on its own, in a regular tab or another visible editor such as a peek view.

Other LSP editors that don't tell Raven which files are shown use the standard rule: an open document gets diagnostics, and closing it clears them.

<a id="quick-reference"></a>
## Common fixes

| You want to | Do this |
|---|---|
| Silence one line | Add `# raven: ignore` at the end of the line, or `# raven: ignore-next` on the line above. See [Suppressing diagnostics](#suppressing-diagnostics). |
| Declare a symbol Raven can't see | Use [`# raven: var` or `# raven: func`](directives.md#declaration-directives). |
| Stop false positives from an NSE helper Raven doesn't know | Use [`# raven: nse`](non-standard-evaluation.md#when-raven-needs-a-hint) to name the captured arguments. Raven keeps checking the other arguments, which a blanket ignore would not. |
| See a parent file's symbols | Usually nothing: auto mode finds the relationship. Add `# raven: sourced-by` only when it can't. See [Cross-file analysis](cross-file.md). |
| Account for project startup helpers | Raven reads a workspace-root `.Rprofile` for ordinary scripts. See [.Rprofile startup files](rprofile.md). |
| Silence a whole R Markdown or Quarto chunk | Add `raven.ignore=TRUE` to the chunk header, or `# raven: ignore-chunk` inside it. See [Chunks](chunks.md#suppressing-diagnostics-in-a-chunk). |
| Turn a category off | Set its severity setting to `"off"`. See [Turn a category off](#per-category-configuration). |
| Check JAGS or Stan files | Set `raven.diagnostics.jags` or `raven.diagnostics.stan` to `"on"`. |
| Turn off all diagnostics | Set `raven.diagnostics.enabled` to `false`. |

<a id="suppression"></a>
## Suppressing diagnostics

Suppression comments work the same in the editor and in `raven check`. They cover Raven's correctness diagnostics that are marked suppressible in the [code index](#diagnostic-codes), and every style lint. Parse errors and dependency-graph diagnostics (missing files, circular dependencies, chain depth, redundant directives) can't be suppressed by comment; use their severity settings instead.

<a id="per-line--raven-ignore"></a>
### Silence a line

Put `# raven: ignore` at the end of the line, or `# raven: ignore-next` on its own line above it:

```r
x <- unknown_var # raven: ignore
```

```r
# raven: ignore-next
x <- unknown_var
```

`# @lsp-ignore` and `# @lsp-ignore-next` are permanent aliases for these two forms.

A standalone `# raven: ignore` on a line by itself does nothing, since comment lines carry no diagnostics. The `-next`, file, and block forms must be on their own line: a trailing `x <- 1 # raven: ignore-next` is ignored.

### Silence one code

Add a `[code]` selector to silence only that code and leave other findings in place:

```r
x <- foo # raven: ignore[undefined-variable]
# raven: ignore[undefined-variable, line-length]
```

List several codes separated by commas. Codes are the kebab-case names in the [code index](#diagnostic-codes) and the lint rule names in [Linting](linting.md). lintr's `snake_case` spelling (`line_length`) works too. Without a selector, `# raven: ignore` silences every diagnostic on the line.

A selector naming a code that can't be suppressed, such as `# raven: ignore[syntax-error]` or `# raven: ignore[unresolved-source-path]`, does nothing.

### Silence a block or a whole file

```r
# raven: ignore-file                     # suppress the whole file
# raven: ignore-file[undefined-variable] # only this code

# raven: ignore-start                    # open a block
x <- foo
y <- bar
# raven: ignore-end                      # close it (inclusive of both directive lines)
```

An `ignore-start` with no matching `ignore-end` runs to the end of the file. In R Markdown and Quarto you can also silence a whole chunk with the `raven.ignore` chunk option or `# raven: ignore-chunk`; see [Code chunks](chunks.md#suppressing-diagnostics-in-a-chunk).

### Get told when a suppression goes stale

Every form above has an `expect` version: `# raven: expect`, `expect-next`, `expect[code]`, `expect-file`, `expect-start` / `expect-end`, and the `@lsp-expect` / `@lsp-expect-next` aliases. `expect` suppresses exactly like `ignore`, but if it matches nothing, Raven reports an [`unused-suppression`](#unused-suppression) hint on the directive's line, so you know to delete it. This works like Rust's `#[expect]` and TypeScript's `@ts-expect-error`.

```r
result <- compute() # raven: expect[undefined-variable]
```

A plain `ignore` is never reported as unused unless you set `raven.diagnostics.reportUnusedSuppressions` to `true`, which extends the check to every ignore directive.

### `# nolint` (lintr style)

Raven also honors lintr's markers, for style lints and the [`mixed-logical`](#mixed-logical) and [`condition-assignment`](#condition-assignment) checks:

- `# nolint` at the end of a line silences that line.
- `# nolint: line_length, object_name` narrows it to the named rules.
- `# nolint start` and `# nolint end` bracket a region. An unterminated `# nolint start` runs to the end of the file, matching lintr.

`# nolint` does not silence undefined variables, package diagnostics, or parse errors. Use `# raven: ignore` for those.

<details markdown="1">
<summary>Which marker silences which diagnostics</summary>

| Marker | Scope | Applies to |
|---|---|---|
| `# raven: ignore` (trailing), `# @lsp-ignore` | The line it's on | Style lints, `mixed-logical`, `condition-assignment`, and every suppressible correctness code, including out-of-scope uses (which carry `undefined-variable`). Not parse errors or dependency-graph diagnostics. |
| `# raven: ignore-next`, `# @lsp-ignore-next` | The next source line | Same as `# raven: ignore` |
| `# raven: ignore-start` … `# raven: ignore-end` | The range, inclusive of both markers | Same as `# raven: ignore` |
| `# raven: ignore-file` | The whole file | Same as `# raven: ignore` |
| `# raven: ignore[code]` | Any of the above, narrowed to the listed codes | The selector is enforced per code in every form |
| `# raven: expect…`, `# @lsp-expect…` | Same as the matching `ignore` form | Suppresses identically and reports `unused-suppression` if it matched nothing |
| `# nolint` (trailing) | The line it's on | Style lints, `mixed-logical`, `condition-assignment` |
| `# nolint: rule_a, rule_b` | The line it's on | The same, narrowed to the named rules |
| `# nolint start` … `# nolint end` | The range, inclusive | Style lints, `mixed-logical`, `condition-assignment` |

Notes:

- A marker inside a string literal (`x <- "# nolint"`) is not a marker.
- Typos such as `# nolinter` or `# @lsp-ignored` are not recognized. Raven would rather show the finding than silently swallow it.
- A same-line marker inside a commented-code line, as in `# x <- 1 # nolint`, works. Raven only treats the inner marker as one when the text between the outer `#` and the inner `# nolint` parses as R, so the same marker inside prose is left alone.
- An `expect` whose selector names only codes that can't be suppressed is not reported as unused.

</details>

<a id="per-symbol-declaration-directives"></a>
### Declare a symbol instead

When a name really exists at run time but Raven can't see where it comes from, declare it rather than ignoring the line. The declaration covers every later use:

```r
load("data.RData")
# raven: var model_fit
# raven: var training_data
x <- model_fit  # No warning
```

See [Directives](directives.md#declaration-directives) for the full syntax, and [`# raven: nse`](non-standard-evaluation.md#when-raven-needs-a-hint) for functions that capture their arguments.

<a id="per-category-configuration"></a>
### Turn a category off

Each category has a severity setting that accepts `"error"`, `"warning"`, `"information"` (or `"info"`), `"hint"`, or `"off"`:

```json
{
  "raven.crossFile.missingFileSeverity": "off",
  "raven.diagnostics.undefinedVariableSeverity": "off"
}
```

The [code index](#diagnostic-codes) names the setting for each code. In `raven.toml` the same settings use the paths listed in the [settings reference](settings-reference.md).

## Diagnostics in other file types

### R Markdown and Quarto

In `.Rmd`, `.Rmarkdown`, and `.qmd` documents, Raven checks the R code in the chunks as one R program. It blanks out every non-R line (prose, YAML front matter, and non-R chunks such as Python or Bash) while keeping R chunk bodies at their original lines and columns. As a result:

- Syntax errors, undefined variables, and lint findings in `{r}` and `{rscript}` chunks appear at the document's own line and column, as in a `.R` file.
- Prose, YAML, Markdown links, and non-R chunks never produce diagnostics.
- A variable assigned in one R chunk is defined in later R chunks.
- A chunk with `eval=FALSE` in its header, or a leading `#| eval: false` in its body, gets no diagnostics, so it can hold deliberately incomplete code. Its definitions and imports don't count in other chunks. Body options override header options; see [Chunk options](chunks.md#chunk-options). Editor features that work by position, such as hover, still work inside it.
- `# nolint` and `# raven: ignore` work inside chunks as in plain R.

Code intelligence for individual chunks is covered in [Code chunks](chunks.md).

#### Parameterized reports (`params`)

When the YAML front matter has a top-level `params:` key, `params` counts as defined in that document, so undefined-variable and out-of-scope checks don't flag it in R chunks. Without a `params:` key, `params` is flagged like any other undefined name.

### JAGS and Stan

Raven can check standalone `.jags`, `.bugs`, `.bug`, and `.stan` files, in the editor and in `raven check`. Turn this on with `raven.diagnostics.jags` for JAGS/BUGS and `raven.diagnostics.stan` for Stan. Both default to `"off"`, and the `raven.diagnostics.enabled` master switch still wins. Untitled buffers whose language is `jags` or `stan` follow the same settings.

<!-- example: diag-stan-undeclared-variable file=raven.toml -->
```toml
[diagnostics]
stan = "on"
```

- JAGS/BUGS files get syntax errors only.
- Stan files get syntax errors plus a conservative check for undeclared variables.
- Neither gets R's semantic, lint, package, or cross-file diagnostics.

Raven does not check dimensions or distribution signatures, type-check Stan, or run JAGS, `stanc`, R, or any network process, so other semantic errors stay silent. See [JAGS and Stan parse errors](#jags-and-stan-parse-errors) and [Stan undeclared variables](#stan-undeclared-variables) for the exact rules.

Turning these settings off does not turn off language registration, parsing, completion, hover, navigation, syntax highlighting, or `raven check` file discovery for model files. It only empties their diagnostics.

A model file whose language is switched off is skipped without being opened, so naming an unreadable one on the `raven check` command line exits `0` rather than the usual `2`. The `raven.diagnostics.enabled` master switch is different: it hides findings, but an unreadable path still exits `2`. See [Exit codes](cli.md#exit-codes).

<a id="diagnostic-categories"></a>
## Diagnostic codes

Most diagnostics carry a stable code, shown in brackets at the end of each `raven check` line. This page writes codes in kebab-case. Style lints and the `mixed-logical` and `condition-assignment` checks print in lintr's snake_case (`mixed_logical`), and suppression selectors accept either spelling. Only codes marked suppressible can be silenced with `# raven: ignore`; the others follow only their severity setting. Settings are listed by their VS Code name; see the [settings reference](settings-reference.md) for defaults and `raven.toml` paths.

| Code | Default severity | Suppressible | Setting |
|---|---|---|---|
| [`undefined-variable`](#undefined-variable) | warning | Yes | `raven.diagnostics.undefinedVariableSeverity`; out-of-scope uses: `raven.crossFile.outOfScopeSeverity` |
| [`syntax-error`](#syntax-error) | error | No | — (master switch only) |
| [`chained-comparison`](#chained-comparison) | error | No | — (master switch only) |
| [`unresolved-source-path`](#unresolved-source-path) | warning | No | `raven.crossFile.missingFileSeverity` |
| [`source-path-case-mismatch`](#source-path-case-mismatch) | information or warning, by filesystem | No | `raven.crossFile.caseMismatchSeverity` |
| [`box-module-not-found`](#box-module-not-found) | warning | No | `raven.crossFile.missingFileSeverity` |
| [`box-module-case-mismatch`](#box-module-case-mismatch) | warning | No | `raven.crossFile.caseMismatchSeverity` |
| [`box-export-not-found`](#box-export-not-found) | warning | Yes | `raven.packages.namespaceMemberSeverity` |
| [`import-module-not-found`](#import-module-not-found) | warning | No | `raven.crossFile.missingFileSeverity` |
| [`import-module-case-mismatch`](#import-module-case-mismatch) | information or warning, by filesystem | No | `raven.crossFile.caseMismatchSeverity` |
| [`import-export-not-found`](#import-export-not-found) | warning | Yes | `raven.packages.namespaceMemberSeverity` |
| [`assign-to-string-literal`](#assign-to-string-literal) | warning; error for literals and reserved words | Yes | — (master switch only) |
| [`package-not-installed`](#package-not-installed) | warning | Yes | `raven.packages.missingPackageSeverity` |
| [`package-outside-active-library`](#package-outside-active-library) | warning | Yes | `raven.packages.missingPackageSeverity` |
| [`namespace-member-not-found`](#namespace-member-not-found) | warning | Yes | `raven.packages.namespaceMemberSeverity` |
| [`mixed-logical`](#mixed-logical) | warning | Yes, also `# nolint` | `raven.diagnostics.mixedLogicalSeverity` |
| [`condition-assignment`](#condition-assignment) | warning | Yes, also `# nolint` | `raven.diagnostics.conditionAssignmentSeverity` |
| [`unused-suppression`](#unused-suppression) | hint | No | `raven.diagnostics.reportUnusedSuppressions` widens it |
| [Circular dependency](#circular-dependency-chain-depth-and-redundant-directives) (no code) | error | No | `raven.crossFile.circularDependencySeverity` |
| [Max chain depth exceeded](#circular-dependency-chain-depth-and-redundant-directives) (no code) | warning | No | `raven.crossFile.maxChainDepthSeverity` |
| [Redundant directive](#circular-dependency-chain-depth-and-redundant-directives) (no code) | hint | No | `raven.crossFile.redundantDirectiveSeverity` |
| [Style lints](#style-lints) (`line_length`, `object_name`, …) | information | Yes, also `# nolint` | `raven.linting.*` |

<a id="undefined-variables"></a>
### `undefined-variable`

A name is used where no definition is visible: not in this file above the use, not in a sourced file, and not in a loaded package.

**Example**

<!-- example: diag-undefined-variable file=analysis.R -->
```r
scores <- c(82, 91, 77)
average <- mean(scroes)
print(average)
```

<!-- example: diag-undefined-variable -->
```console
$ raven check .
analysis.R:2:17 warning: scroes is not defined [undefined-variable]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

If the name is defined later in the same file at top level, the message says so, for example `total_count is used before it is defined (defined on line 7)`. R does not hoist top-level bindings, so the use is still flagged, but you can tell a forward reference from a typo. A name that comes from a file sourced later reads `'helper_value' is used before it's available (sourced on line 2)`; this out-of-scope variant has its own severity setting.

**Fix**

Correct the typo, define the name above its use, source the file that defines it, or load the package that exports it:

```r
scores <- c(82, 91, 77)
average <- mean(scores)
print(average)
```

If the name exists at run time in a way Raven can't see, such as from `load()` of a file with a non-conventional name, declare it with `# raven: var name`. If a function captures the argument as a column name, declare it with [`# raven: nse`](non-standard-evaluation.md#when-raven-needs-a-hint).

**Suppressible**: yes, with `# raven: ignore` or `# raven: ignore[undefined-variable]`.

**Setting**: `raven.diagnostics.undefinedVariableSeverity` (default `"warning"`). Out-of-scope uses follow `raven.crossFile.outOfScopeSeverity` (default `"warning"`). `raven.diagnostics.undefinedVariableInCallArguments` and `raven.diagnostics.undefinedVariableInBracketIndices` (both default `true`) control whether Raven looks inside call arguments and `[` indices.

Raven never checks names on the right of `$` or `@`, function parameters, named-argument labels, or formula variables (`y ~ x`).

<details markdown="1">
<summary>What counts as a definition</summary>

Any of these makes a name defined:

- a definition above the use in the same file
- a definition in a sourced file (through `source()` or a directive)
- a package export from a loaded `library()`
- a namespace alias or attached member from a static `box::use()` import
- a declaration directive (`# raven: var`, `# raven: func`)

Raven also recognizes call forms that bind a name at run time, so the name resolves without a directive:

- `assign("x", ...)` and write or append mode `textConnection("x", "w")` bind `x`.
- `load("foo.rda")` binds the conventional object name `foo`.
- `data(foo, bar)` binds each named dataset (`foo`, `bar`) from the call onward, whether given as a bare name or a string. Named arguments such as `package=` are ignored.
- `exists("apple")` declares `apple` from the line after the call onward, like `# raven: var apple`. If you probe `exists("apple")`, you are asserting you know the name, so the guard `if (!exists("apple")) apple <- default` and later uses of `apple` resolve. The name must be a non-empty string literal: `exists(varname)` and `exists("")` declare nothing. A use before the `exists()` call is still flagged, matching the directive's next-line visibility.
- `setGeneric("g", ...)` and `setGroupGeneric("g", ...)` bind the generic `g`, so other files in the same package that call it resolve. This is common in S4-heavy packages such as Matrix, whose generics live in one `R/` file.
- zeallot's `c(a, b) %<-% value` binds each bare symbol on the left, including nested `c(...)` destructuring, and rlang's `x %<~% value` binds its bare-symbol left side. Both take effect from the statement onward, like `<-`. Other custom `%op%` operators don't bind.
- Inside an S4 method body (`setMethod("Ops"|"Math"|"Summary"|…, ...)`) or an S3 method bound to a `generic.class` name, the dispatcher-injected `.Generic`, `.Method`, and `.Class` are in scope.
- Inside inline R6 methods, including defaults and nested closures, `self`, `private`, and `super` are in scope. Classes with a literal `portable = FALSE` also expose bare public, private, and active members, including statically resolved inheritance. These bindings don't leak into field initializers or unrelated functions. Known masks turn off bare `R6Class`/`list` recognition; `R6::R6Class` and `base::list` keep their qualified identities. See [non-portable R6 classes](r-package-dev.md#non-portable-r6-classes).
- Base R's implicit search-path globals resolve as bare names: `.Autoloaded` (the startup `Autoloads` environment), and `.Random.seed` after a visible earlier `set.seed()` call.
- `delayedAssign("x", expr)` binds the promise `x` from the call onward. At top level it becomes a package-internal symbol; inside a function body it stays local, matching R's default `assign.env`. The name must be a string literal.
- rlang's `env_bind_active(current_env(), a = ..., b = ...)` and `env_bind_lazy(current_env(), ...)` bind each named argument (`a`, `b`) in the enclosing environment. Only the `current_env()` form is modeled; binding into another environment is not assumed local.
- `utils::globalVariables(c("a", "b"))`, R's own way to declare names bound at run time for `R CMD check`, makes each listed name resolve package-wide. The bare `.` pronoun is deliberately not honored this way: Raven resolves `.` by context (see the magrittr section below), and a blanket `globalVariables(".")` would hide real `.` mistakes.
- An active binding installed in a package's `.onLoad`/`.onAttach` hook with `makeActiveBinding("name", fn, env)`, when `env` is the package namespace (`asNamespace(...)`, `topenv(...)`, or `environment(<a package function>)`), adds `name` to the package's internal scope. This sits alongside the existing `assign("name", ..., envir = ns)` and `ns$name <- ...` recognition.
- Package source and testthat package tests recognize R's implicit `.packageName`. Hook assignments through `ns <- base::topenv(); ns$name <- value` also add package-internal names. See [namespace runtime bindings](r-package-dev.md#namespace-runtime-bindings) for the static subset and context limits.

In an R package's source tree, a script anywhere (`inst/`, `tools/`, `data-raw/`, `debug/`, …) that calls `devtools::load_all()`, `pkgload::load_all()`, or a bare `load_all()` is treated as attaching the package under development. The package's internal, exported, sysdata, and `.onLoad`/`.onAttach`-bound symbols become visible in that file, as `load_all()` does at run time. Names the package doesn't provide are still flagged.

Windows-only base functions (`shell.exec`, `Sys.junction`, `readRegistry`, the `win*` and clipboard helpers, …) count as builtins even though Raven's builtin list is generated on non-Windows hosts, so platform-guarded code is not flagged.

Exported dot-prefixed base functions (`.Call`, `.External`, `.Internal`, `.subset2`, `.row_names_info`, `.libPaths`, `...length`, …) count as builtins as well, with or without R available.

</details>

<a id="call-arguments-and-bracket-indices"></a>
<details markdown="1">
<summary>Call arguments and bracket indices</summary>

Raven checks names inside ordinary call arguments and `[` / `[[` indices, so real bugs like `paste(undefined_var)`, `df[undefined_var, ]`, and `lst[[typo]]` are flagged. To avoid false positives in [non-standard evaluation](non-standard-evaluation.md) (NSE), it resolves each call's function to its source and applies a per-call argument policy:

- A standard-evaluation function (such as `paste`, `print`, `stats::filter`) has its arguments checked.
- A function with a known NSE policy skips only the captured, data-masked, or tidy-selected arguments. `with(df, col + 1)` and `dplyr::filter(df, col)` still check `df` but skip `col`. `substitute(expr, env)` skips `expr` but checks `env`. `aes(x, y)` and the rlang plural capture helpers skip every argument.
- Local definitions shadow packages, so in `filter <- function(x) x; filter(undefined_var)`, `undefined_var` is checked because this `filter` is not `dplyr::filter`. For a local helper, Raven also infers which formals are captured: if the body calls `substitute()`, `enquo()`, `enexpr()`, or `ensym()` on a formal, only the argument bound to that formal is skipped.
- Non-literal local rebindings shadow packages the same way, matching R's lookup of a function in call position. A simple qualified alias keeps its target's policy: `filter <- stats::filter; filter(df, typo)` checks `typo`, while `filter <- dplyr::filter; filter(df, col)` still skips the data-masked `col`. A callable whose policy can't be known statically (`filter <- get_filter()`, or a bare identifier alias) is skipped conservatively: its whole call is treated as non-standard. An obvious non-function literal (`filter <- 1`) is not a shadow, because R skips it in call position, so a later `filter(df, col)` still resolves to the package function. The last top-level binding of a name wins.
- Tidy-eval wrapper functions pass the data mask on. A local function that embraces a formal into a call argument (`my_filter <- function(data, cond) filter(data, {{ cond }})`) is itself data-masking, so `my_filter(df, x > 2)` does not flag `x` (`df` is still checked). The same applies when the body defuses `...` through a plural capture helper (`enquos(...)` and friends), or forwards `...` directly into a data-mask position of a known function (`function(...) join_by(...)`). The dots check resolves the inner function one level deep through the built-in policy tables, and a local redefinition of that function turns it off. The default expression of a defused formal (such as `values_from = value` in a pivot-style signature) is quoted rather than evaluated, so it is skipped too. Only these verified forwarding shapes count: a local helper that doesn't forward (`f <- function(x) x`) keeps its arguments checked.
- An unresolved function (not local, not a builtin, not a known export of a package in play) has its arguments skipped rather than guessed: `unknown_fn(typo)` flags `unknown_fn` but not `typo`.
- In an R package you are developing, the package's own exported NSE functions keep their policy inside the package's own files (any `.R`, `.Rmd`, `.Rmarkdown`, or `.qmd` file under `R/`, `tests/`, vignettes, `man/` examples, `inst/`, `data-raw/`, and so on), even though no `library()` call attaches the package. For example, dplyr's own tests calling `filter(df, x > 1)` don't flag `x`. A truly undefined name outside a masked position is still flagged.

For `[`, base subscripting evaluates normally, so indices are checked unless the object is data.table-like: a known `data.table()`, `as.data.table()`, or `fread()` object, or an unresolved object when a bracket-NSE package is in play. A package is in play through a `library(data.table)` call, a `data.table::` reference, or a package `Imports:`/`importFrom`.

data.table is the built-in bracket-NSE package. An installed package whose own container uses the same notation joins the set by shipping a `[subset]` table in its [`inst/raven/nse.toml`](non-standard-evaluation.md#declaring-datatable-style--semantics). That table can also name the constructors (`x <- dibble(...)`) and by-reference converters that classify an object the way `data.table()` and `setDT()` do. Such a package is put in play by the same signals as data.table: its `library()` call, `Imports:`/`importFrom`, or any `pkg::` reference in the file (such as `pkg::dibble(...)`).

Separately from that classification, a `[` call with any argument that is a `:=` assignment (`d[, avg := mean(x), by = grp]`, `d[cond, tag := 0]`, or `` d[, `:=`(a = 1, b = 2)] ``) is always treated as NSE, and all its indices are skipped. Base R has no `:=` function and no base `[` method evaluates one, so Raven treats the call as data.table-style whichever package supplies the method. The `:=` must be the argument itself, not nested in another expression. It wins even over a known non-data.table object: `df[, y := 1]` on a plain data.frame fails at run time either way, and an undefined-variable report on `y` would mislead. `[[` is always checked, since `DT[[x]]` reads `x` as a real variable.

data.table's by-reference converters are recognized too. A statement-level `setDT(x)` makes `x` a data.table from that line on, so a later `x[, mean(value), by = grp]` no longer flags `value` or `grp`. `setDF(x)` makes it a plain data.frame again, and `setattr(x, "class", ...)` sets the class explicitly. The change is positional: a `[` above the converter keeps the object's earlier classification.

When a function is not in Raven's policy table, use [`# raven: nse`](non-standard-evaluation.md#when-raven-needs-a-hint) to declare which arguments it captures. This is better than a blanket ignore because it records a reusable per-function policy, either whole-call or per-formal, and keeps checking the other arguments. It applies to calls after the directive line, and the most recent declaration for a function wins. A declaration also spreads across the `source()` graph: it covers matching calls in every connected file, in both directions and transitively, so you can declare a helper once near its `library()` call or definition. See [NSE directive propagation](cross-file.md#nse-directive-propagation).

When an `undefined-variable` sits inside a call argument whose function is not a builtin or base-package export, and no `# raven: nse` covers it, `raven check` can suggest an `# raven: nse` line. The suggestion is never part of the diagnostic message, because a per-finding hint is verbose and reads as if Raven were asserting the call is NSE. The editor shows only the plain `undefined-variable` message, with no hint or code action. The suggestion appears once, in the [text-output footer](cli.md#nse-discoverability-footer) of `raven check`; the `json` and `sarif` formats carry none. It is reserved for package functions Raven can't analyze. A bare call to a function defined at top level in the same file gets no suggestion, since Raven has read that function's body. A qualified `pkg::fn(...)` call always keeps the suggestion, because it calls the package export.

</details>

<a id="the-magrittr-dot-pipe-placeholders-and-exposition"></a>
<details markdown="1">
<summary>The magrittr dot, pipe placeholders, and exposition</summary>

Raven recognizes the placeholders used by magrittr and dplyr, so they are not flagged, while keeping them tightly scoped so real bugs still show:

- The magrittr dot `.` on the right of a `%>%` or `%<>%` pipe (`df %>% nrow(.)`, `df %<>% { .$x }`) is the piped value.
- The leading `.` of a magrittr functional sequence (`f <- . %>% step1() %>% step2()`) is the anonymous function's formal. Only `%>%` builds functional sequences; `%<>%` can't start one, since it assigns its result back to the left side.
- The compound-assignment pipe `%<>%` (`x %<>% f()`, meaning `x <- x %>% f()`) feeds its left side into the right-hand call's first argument like `%>%`, so column arguments resolve the same way: `df %<>% group_by(ring)` treats `ring` as a column.
- `.` inside `dplyr::do(...)` (the current group's data frame) and inside the scoped-verb predicates `all_vars(...)` / `any_vars(...)` (the column being evaluated).
- Every free name on the right of the exposition operator `lhs %$% rhs` (which means `with(lhs, rhs)`), since `rhs` runs in a data mask of `lhs`. `mtcars %$% cor(cyl, am)` treats `cyl` and `am` as columns and still checks `mtcars`.
- The native-pipe placeholder `_` on the right of a `|>` pipe (R 4.2+).

These apply only in the magrittr, `do()`, and `all_vars()` contexts. A bare `.` used as a native `|>` placeholder, a common mistake when moving from `%>%` to `|>` (as in `x |> f(.)`), is not one of these forms and stays flagged.

</details>

<a id="shiny-deferred-expression-scopes"></a>
<details markdown="1">
<summary>Shiny deferred-expression scopes</summary>

Shiny's deferred-expression helpers, `reactive()`, `observe()`, `observeEvent()`, `eventReactive()`, and the `render*()` family, evaluate their `{ ... }` body later in a child environment. Raven treats each body as a nested scope rather than skipping it. Names inside are checked, outer bindings (including server-function parameters like `input`, `output`, `session`) stay visible, and a definition inside the body does not leak out. In `server <- function(input, output, session) { output$plot <- renderPlot({ plot(input$x, typo_var) }) }`, only `typo_var` is flagged.

This applies to `shiny::`-qualified calls, and to bare calls when Shiny is in play through a `library(shiny)` or `require(shiny)` call, even without Shiny export metadata. A top-level definition that shadows the name (`renderPlot <- function(...) ...`) turns the Shiny treatment off. `isolate({ ... })` evaluates in the current environment, so it is deliberately not a nested scope.

The recognition is heuristic and errs toward checking without isolating, which can miss a diagnostic but never adds a false one:

- The `render*()` family is matched by name (a `render` prefix plus an upper-case letter). That covers the render ecosystem (`renderPlotly`, `renderLeaflet`, …) but could match a same-named eager function from another package while Shiny is loaded.
- Only the positional `{ ... }` body is isolated. A body passed by name (`renderPlot(expr = { ... })`) or a block passed to a named eager parameter such as `outputArgs = { ... }` is not.
- Isolation of bare calls needs a `library(shiny)` / `require(shiny)` in the file or a `shiny::` qualifier. In a package file that gets Shiny only through DESCRIPTION `Imports:` or `importFrom(shiny, …)`, the body is still checked but may not be isolated.
- Only top-level definitions count as shadows, so a helper redefined inside a function (a `renderPlot <- function(...) ...` nested in the server) is still treated as Shiny's.

</details>

<a id="foreach-iterator-scopes"></a>
<details markdown="1">
<summary>foreach iterator scopes</summary>

`foreach(...) %do% expr` and `foreach(...) %dopar% expr`, plus the drop-in operators other packages register for `foreach()` (doRNG's `%dorng%` and doFuture's `%dofuture%`), expose the named, non-dot arguments of `foreach()` as iterator variables inside `expr`. In `foreach(i = 1:10, j = ys) %do% { i + j + typo }`, `i` and `j` resolve and only `typo` is flagged.

Dot-prefixed options such as `.combine`, `.packages`, `.export`, `.noexport`, and `.verbose` are control arguments, not iterators. Raven still checks the iterator value expressions (`foreach(i = missing_vec) %do% i` flags `missing_vec`), the control argument values (`foreach(i = 1:3, .combine = missing_combine) %do% i` flags `missing_combine`), and ordinary names in the body.

As with Shiny scopes, the body is a nested scope: outer bindings stay visible, and a definition inside it doesn't leak out. Assignments inside an iterator value expression are isolated the same way, because foreach evaluates those arguments in its own environment: in `foreach(i = { x <- 1; 1:3 }) %do% i`, `x` is visible neither in the body nor after the loop (in R, `exists("x")` stays `FALSE`). Recognition is by syntax. It matches bare `foreach(...)` and qualified `foreach::foreach(...)` / `foreach:::foreach(...)`, and does not need foreach package metadata.

Nested compositions joined by `%:%`, and `when(...)` filters, are modeled too. In `foreach(i = 1:3) %:% when(i %% 2 == 0) %:% foreach(j = 1:3) %do% i + j`, every `foreach()` in the chain contributes iterators. Binding goes left to right, as in R. Each iterator is visible from its own `foreach()` call onward: in later `when(...)` filters, in later iterator value expressions (so an inner `foreach(j = seq_len(i))` resolves the outer `i`), and in the body, but not to its left. So `foreach(i = seq_len(j)) %:% foreach(j = 1:3)` still flags `j`, just as R reports "object 'j' not found". When two levels share an iterator name, the body uses the innermost (rightmost) `foreach`, and a `when(...)` filter uses the nearest `foreach` on its left. `when(...)` is a filter, so it adds no iterators.

</details>

<a id="targets-and-tarchetypes-target-names"></a>
<details markdown="1">
<summary>targets and tarchetypes target names</summary>

Raven keeps static target names separate from ordinary R bindings. Target declarations from `tar_target()` and supported tarchetypes factories, named `tar_plan()` commands, and a bounded literal `tar_map()` subset can satisfy explicit `tar_read()` / `tar_load()` references. This works in the pipeline and in R chunks of a document connected by `tar_render()`, `tar_knit()`, or single-document `tar_quarto()`.

An unresolved reference reports, for example, `Target 'model' is not declared in the connected targets pipeline`. It carries `undefined-variable`, uses `raven.diagnostics.undefinedVariableSeverity`, and honors the usual line, file, and chunk suppression forms. A missing literal report file instead carries the non-suppressible [`unresolved-source-path`](#unresolved-source-path) code and uses the missing-file severity. See [tarchetypes target factories and report documents](cross-file.md#tarchetypes-target-factories-and-report-documents) for the supported forms and what is out of scope.

</details>

Stan files use this code too. See [Stan undeclared variables](#stan-undeclared-variables).

<a id="parse-errors"></a>
### `syntax-error`

The file can't be parsed as R (or, with model diagnostics on, as JAGS or Stan).

**Example**

<!-- example: diag-syntax-error file=totals.R -->
```r
totals <- c(10, 20, 30]
```

<!-- example: diag-syntax-error -->
```console
$ raven check .
totals.R:1:23 error: Mismatched brackets: `(` opened here; close with `)` not `]`. [syntax-error]
1 issues (1 errors, 0 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Close the bracket you opened:

```r
totals <- c(10, 20, 30)
```

**Suppressible**: no. Comments can't silence parse errors.

**Setting**: none of its own. Only `raven.diagnostics.enabled` turns parse errors off.

`syntax-error` is an umbrella code. Most parse errors carry it directly; [`chained-comparison`](#chained-comparison) is a sub-kind with its own code.

<details markdown="1">
<summary>Parse error messages and what triggers them</summary>

Where it can, Raven gives a specific message rather than the generic "R code could not be parsed here":

| Message | Trigger |
|---|---|
| `Unclosed string literal` | An opening `"` or `'` has no matching closing quote |
| ``Consecutive pipe `\|>`: expected an expression before this operator.`` | Two pipe operators back to back with nothing between (`x \|> \|> y`) |
| ``Mismatched brackets: `(` opened here; close with `)` not `]`.`` | A bracket opened with `(`, `[`, or `[[` is closed with a different bracket (`c(1, 2]`) |
| ``Unexpected `>`: R has no `=>` operator. For assignment use `<-`; for a pipeline use `\|>` (R 4.1+) or `%>%`.`` | A `=>` appears where R expected an expression, common when porting from JavaScript (`x => 1`) |
| `` Unclosed `(`: missing matching `)` `` / `` Unclosed `{`: missing matching `}` `` / `` Unclosed `[`: missing matching `]` `` / `` Unclosed `[[`: missing matching `]]` `` | A bracket was opened and never closed (`library(`, `function() {`). The range starts at the opener and spans the meaningful code on that line. |
| `` Missing opening `{` `` / `` Missing opening `(` `` / `` Missing opening `[` `` / `` Missing opening `[[` `` | A closer with no opener (`}` at top level, `)` after a complete expression). A run of stray closers (`}}}`) gets one diagnostic. |
| `In R, 'else' must appear on the same line as the closing '}' of the if block` | `else` on its own line after `if (cond) { body }`. R treats the `if` as complete, so the `else` is unexpected. |
| ``'else' without a preceding 'if' body: in R, 'else' must follow `if (...) {...}` on the same line`` | `else` anywhere R rejects a bare `else`: `else { 1 }` at the top of a file, inside `{ … }`, `(else)`, `else \|> f()`, or as a function argument or assignment value |
| `R code could not be parsed here` | A parse error that matches none of the patterns above |

The mismatched-brackets message also covers a wrong closer typed right after an unclosed opener: `f(}` gives one `` Mismatched brackets: `(` opened here; close with `)` not `}`. `` diagnostic, not two.

</details>

For JAGS and Stan parse errors, see [JAGS and Stan parse errors](#jags-and-stan-parse-errors).

### `chained-comparison`

A chained comparison such as `0 < x < 1` or `a == b == c`. R rejects it as a parse error, but the parser Raven uses accepts it, so Raven reports it separately.

**Example**

<!-- example: diag-chained-comparison file=range.R -->
```r
x <- 0.5
in_range <- 0 < x < 1
```

<!-- example: diag-chained-comparison -->
```console
$ raven check .
range.R:2:19 error: R does not support chained comparisons: `a < b < c` is a parse error. Combine separate comparisons with `&&` for scalar conditions (`x > 0 && x < 1`) or `&` for vectorized expressions (`x > 0 & x < 1`). [chained-comparison]
1 issues (1 errors, 0 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Combine two comparisons, with `&&` for a single value or `&` for a vector:

```r
x <- 0.5
in_range <- 0 < x && x < 1
```

**Suppressible**: no. It is a `syntax-error` sub-kind.

**Setting**: none of its own; `raven.diagnostics.enabled` only.

Raven reports one diagnostic per chain, on the second comparison operator, where R's own error points. The operators are `<`, `<=`, `>`, `>=`, `==`, and `!=`. If the chain itself has a parse error, for example while you are still typing `0 < x <`, Raven reports only that parse error. A complete chain next to a separate parse error is still reported. Parenthesized forms like `(0 < x) < 1` are valid R and are never flagged.

### `unresolved-source-path`

A path in a `source()` call or a source directive doesn't lead to a file.

This covers `source()` calls, forward directives (`# raven: source`, `run`, `include`), and backward directives (`# raven: sourced-by`, `run-by`, `included-by`). The path may be missing, outside the workspace, or ambiguous because two files match it when case is ignored. It also covers a missing literal `tar_render()`, `tar_knit()`, or single-document `tar_quarto()` report path.

**Example**

<!-- example: diag-unresolved-source-path file=main.R -->
```r
source("R/helpers.R")
```

<!-- example: diag-unresolved-source-path -->
```console
$ raven check .
main.R:1:1 warning: File not found: 'R/helpers.R' [unresolved-source-path]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Point the path at the real file. Relative paths resolve from the file's directory, or from the directory set by `# raven: cd`; see [Cross-file analysis](cross-file.md) for the full rules.

```r
source("helpers.R")
```

**Suppressible**: no. Use the severity setting.

**Setting**: `raven.crossFile.missingFileSeverity` (default `"warning"`).

An exact optional-source guard, `if (file.exists("path")) source("path")` with the same plain literal path, produces neither `unresolved-source-path` nor `source-path-case-mismatch` when the file is absent. The source still enters the dependency graph and provides symbols when the file exists. Guarded files that exist outside the workspace are still diagnosed.

### `source-path-case-mismatch`

A source path matches the real filename only when case is ignored, such as `templates.r` for `templates.R`.

**Example**

<!-- example-exempt: severity depends on the host filesystem (information on macOS, warning on Linux) -->
```text
main.R:1:1 info: Case mismatch: 'Helpers.r' resolves to 'helpers.R' on this filesystem, but will not be found on a case-sensitive filesystem (e.g. Linux CI). [source-path-case-mismatch]
```

**Fix**

Match the filename's case exactly:

```r
source("helpers.R")
```

**Suppressible**: no. Use the severity setting.

**Setting**: `raven.crossFile.caseMismatchSeverity` (default `"auto"`). Pin a fixed level or set `"off"`.

<details markdown="1">
<summary>How case mismatches are resolved and reported</summary>

Raven still resolves the file into the source graph, so the symbols it defines stay visible and you don't get a flood of false `undefined-variable` warnings. It reports the problem once, on the path's line. This covers forward references (a `source()` call or `# raven: source` / `run` / `include`) and backward directives (`# raven: sourced-by` / `run-by` / `included-by`).

Under the default `"auto"`, severity depends on the host filesystem:

- Case-insensitive filesystem (macOS, typical Windows): information. The path works here, but it won't be found on a case-sensitive filesystem such as Linux CI.
- Case-sensitive filesystem (Linux, CI): warning. For a forward `source()`, R itself would fail at `source()` time. Raven still resolves the single case-insensitive match so this one warning isn't buried under follow-on errors.

So the same code can be information on a developer's Mac and a warning in Linux CI. That is intended: CI is where the case-sensitive failure happens.

For a backward directive the message differs. R never runs a `# raven: sourced-by`, so the diagnostic doesn't claim R would fail; it says the directive's casing doesn't match the file on disk and asks you to fix it. Raven still resolves the relationship on both kinds of filesystem.

When two files on disk match the path case-insensitively (possible only on a case-sensitive filesystem), the path is ambiguous. Raven leaves it unresolved and reports [`unresolved-source-path`](#unresolved-source-path) instead. Matching is ASCII-only. See [Case-only mismatches](cross-file.md#case-only-mismatches).

</details>

### `box-module-not-found`

A static relative or configured `box::use()` target doesn't resolve to a file module or an `__init__.r` / `__init__.R` module.

**Example**

<!-- example: diag-box-module-not-found file=main.R -->
```r
box::use(./modules/cleaning)
```

<!-- example: diag-box-module-not-found -->
```console
$ raven check .
main.R:1:10 warning: Cannot resolve local box module [box-module-not-found]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Create `modules/cleaning.R`, or correct the module path to an existing file.

**Suppressible**: no. Use the severity setting.

**Setting**: `raven.crossFile.missingFileSeverity` (default `"warning"`). See [box and import modules](modules.md).

### `box-module-case-mismatch`

A static relative or configured box module exists only under a filename with different case.

**Example**

<!-- example-exempt: the message contains absolute paths that vary per machine -->
```text
main.R:1:10 warning: box module path case mismatch: expected '/path/to/project/mods/Util.r', found '/path/to/project/mods/util.R' [box-module-case-mismatch]
```

**Fix**

Write the module name with the file's exact case: `box::use(./mods/util)`.

**Suppressible**: no. Use the severity setting.

**Setting**: `raven.crossFile.caseMismatchSeverity`. Under `"auto"`, box module mismatches are reported as warnings on every filesystem.

### `box-export-not-found`

A name attached by `box::use()`, directly or renamed, is not in the module's or package's export list. Raven reports it only when it knows the complete export list.

**Example**

<!-- example: diag-box-export-not-found file=main.R -->
```r
box::use(./modules/summaries[trimmed_mean, winsorize])

trimmed_mean(c(1, 2, 3, 100))
```

<!-- example: diag-box-export-not-found file=modules/summaries.R -->
```r
#' @export
trimmed_mean <- function(x) mean(x, trim = 0.1)
```

<!-- example: diag-box-export-not-found -->
```console
$ raven check .
main.R:1:44 warning: 'winsorize' is not exported by this box import source [box-export-not-found]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Remove the name from the attach list, correct its spelling, or export it from the module with `#' @export`.

**Suppressible**: yes, with `# raven: ignore[box-export-not-found]`.

**Setting**: `raven.packages.namespaceMemberSeverity` (default `"warning"`).

### `import-module-not-found`

A literal `.R` or `.r` script module in an `{import}` call can't be found.

**Example**

<!-- example: diag-import-module-not-found file=main.R -->
```r
import::from("scripts/tools.R", clean_names)
```

<!-- example: diag-import-module-not-found -->
```console
$ raven check .
main.R:1:14 warning: Cannot resolve literal import script module [import-module-not-found]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Correct the path, or create the script.

**Suppressible**: no. Use the severity setting.

**Setting**: `raven.crossFile.missingFileSeverity` (default `"warning"`). See [box and import modules](modules.md).

### `import-module-case-mismatch`

A literal `{import}` script path exists only under a filename with different case.

**Example**

<!-- example-exempt: the message contains absolute paths that vary per machine, and severity depends on the host filesystem -->
```text
main.R:1:14 info: import script path case mismatch: expected '/path/to/project/scripts/Tools.R', found '/path/to/project/scripts/tools.R' [import-module-case-mismatch]
```

**Fix**

Match the script's filename case exactly.

**Suppressible**: no. Use the severity setting.

**Setting**: `raven.crossFile.caseMismatchSeverity`. Under `"auto"` it follows the host filesystem, like [`source-path-case-mismatch`](#source-path-case-mismatch).

### `import-export-not-found`

A name you select explicitly in an `{import}` call is not in the package's complete export list.

**Example**

<!-- example-exempt: needs an installed package's export list -->
```text
main.R:1:21 warning: 'not_a_function' is not exported by this import source [import-export-not-found]
```

```r
import::from(dplyr, not_a_function)
```

**Fix**

Correct the name, or drop it from the selection.

**Suppressible**: yes, with `# raven: ignore[import-export-not-found]`.

**Setting**: `raven.packages.namespaceMemberSeverity` (default `"warning"`).

<a id="assignment-targets"></a>
### `assign-to-string-literal`

An assignment target that R rejects outright, or that R accepts but is almost never what you meant.

**Example**

<!-- example: diag-assign-to-string-literal file=setup.R -->
```r
"total" <- 10
TRUE <- 0
```

<!-- example: diag-assign-to-string-literal -->
```console
$ raven check .
setup.R:1:1 warning: The assignment target "total" is a string literal; R will bind the value to the variable named by that string. Was this intentional? [assign-to-string-literal]
setup.R:2:1 error: Cannot assign to logical literal `TRUE`. [assign-to-string-literal]
2 issues (1 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Assign to a name:

```r
total <- 10
is_ready <- FALSE
```

**Suppressible**: yes, both tiers, with `# raven: ignore` or `# raven: ignore-next` on the line.

**Setting**: none of its own. It is on whenever diagnostics are enabled.

The check covers every assignment operator: `<-`, `<<-`, `=`, `->`, and `->>`. For right-arrow operators the target is on the right; for the others it is on the left.

| Tier | Severity | Target |
|---|---|---|
| Invalid target | error | A value R rejects: a literal (`TRUE`, `FALSE`, `NULL`, any `NA*`, `Inf`, `NaN`, a number including signed `-1`/`+1.5`) or a reserved word (`else`, `in`, `next`, `break`) |
| Suspicious target | warning | Something R accepts but rarely intended: a string literal (`"foo" <- 1` binds a variable named `foo`) or a dots argument (`... <- 1`, `..1 <- 1`, which creates a binding `...` / `..N` can't reach) |

<details markdown="1">
<summary>Assignments that are not flagged</summary>

- `"[.Surv" <- function(x, i) …`, `"coef<-.varPower" <- function(…) …`, `"area" <- function(r) …`. A quoted-string target whose value is a function definition is idiomatic R (S3, replacement, or operator methods for names that aren't syntactic, and old S-style definitions), the same as the backtick form. This holds for every assignment spelling, including chained definitions (`"coef<-" <- "coefficients<-" <- function(…) …`) and `.Primitive(…)` values. Any other non-function value on a string target is still flagged.
- `"iris" <- <value>` at the top level of a package's `data/*.R` file. This is the form `data()` expects for registering datasets, used throughout R-core's `datasets` package. String targets nested inside functions in those files are still flagged.
- `T <- FALSE` / `F <- TRUE`. `T` and `F` are ordinary bindings that default to `TRUE`/`FALSE`, and R accepts the assignment. Turn on the [`T` / `F` symbol](linting.md#t--f-symbol) style lint if you want these reported.
- `f(name = value)`: named-argument syntax inside a call, not assignment.
- `function(x = TRUE)`: a default value for a parameter, not assignment.
- `if <- 1`, `for <- 1`, `while <- 1`, `function <- 1`, `repeat <- 1`. The parser reports these as syntax errors directly, so you get one diagnostic, not two.

</details>

<a id="package-diagnostics"></a>
### `package-not-installed`

`library()`, `require()`, a static selective import, or a `pkg::member` / `pkg:::member` reference names a package that isn't in the active library paths.

**Example**

<!-- example-exempt: needs a configured R library; the docs examples run with package loading off -->
```text
analysis.R:1:1 warning: No installed package named 'dpylr' [package-not-installed]
```

```r
library(dpylr)
```

**Fix**

Fix the package name, or install the package (for example `install.packages("dplyr")` or `renv::restore()`).

**Suppressible**: yes, with `# raven: ignore[package-not-installed]`. This also silences its child code, [`package-outside-active-library`](#package-outside-active-library).

**Setting**: `raven.packages.missingPackageSeverity` (default `"warning"`).

`raven check` does not report generic missing packages by default, because CI usually doesn't install them. Pass [`--report-uninstalled`](cli.md#missing-package-reporting-in-ci) to turn it on. The editor reports them whenever it knows what is installed. See [Package names vs. install status](#package-names-vs-install-status).

### `package-outside-active-library`

A package is installed in a regular R library that your active renv project removed from `.libPaths()`. It is a child of `package-not-installed`.

**Example**

<!-- example-exempt: needs an renv project and an outside R library -->
```text
analysis.R:1:1 warning: Package 'dplyr' is installed outside this active renv project library; run renv::hydrate("dplyr") to add it to the project library. [package-outside-active-library]
```

**Fix**

Run `renv::hydrate("dplyr")` (with your package's name) to add it to the project library. The named form also works when renv uses explicit snapshots, where a bare `renv::hydrate()` only considers dependencies declared in `DESCRIPTION`.

**Suppressible**: yes. Silencing `package-not-installed` also silences this code.

**Setting**: `raven.packages.missingPackageSeverity`. Unlike generic missing packages, `raven check` reports this code by default.

<details markdown="1">
<summary>When Raven reports packages outside the renv library</summary>

When Raven activates an explicit workspace's `renv/activate.R`, it compares the regular and active library paths. If a referenced package exists only in a path that activation removed, Raven reports `package-outside-active-library` and suggests `renv::hydrate("package")`.

Raven reports this at most once per package per document, even when the document has many qualified references. It may use explicitly declared exports from that outside installation only to avoid a cascade of undefined-variable findings after a real `library()` / `require()` call. That evidence never makes the package available for completion, `system.file()`, or package loading.

Packages installed after startup are picked up when the library is rebuilt, for example with `raven.refreshPackages`. Changes made only in an outside regular library are picked up by the next refresh, not watched continuously. Multi-root editor sessions never report this code, because there is no single renv project to compare against.

</details>

<a id="namespace-member-references-pkgmember"></a>
### `namespace-member-not-found`

In `pkg::member`, the package's complete export list has no exported object named `member`. Never reported for `pkg:::member`.

**Example**

<!-- example-exempt: needs package export metadata; the docs examples run with package loading off -->
```text
analysis.R:2:14 warning: 'mutat' is not an exported object of package 'dplyr' [namespace-member-not-found]
```

```r
library(dplyr)
df <- dplyr::mutat(mtcars, kpl = mpg * 0.425)
```

**Fix**

Correct the member name (`dplyr::mutate`). If the object is internal, use `pkg:::member`, which Raven never checks.

**Suppressible**: yes, with `# raven: ignore[namespace-member-not-found]`.

**Setting**: `raven.packages.namespaceMemberSeverity` (default `"warning"`).

<details markdown="1">
<summary>When Raven trusts an export list</summary>

Writing `pkg::member` or `pkg:::member` makes Raven load `pkg`'s metadata (export names, datasets) into its package cache even without `library(pkg)`, so completion and hover work. It does not attach `pkg` for bare names; only `library()` and `require()` do that. A `pkg:::member` loads the package too, but gives no completions and is never checked.

Raven reports a missing member only when it holds a complete export list for the package. Completeness depends on the source:

- **Complete**: a static NAMESPACE parse without `exportPattern()`, R's `getNamespaceExports()`, the committed package database, or the embedded base table. A missing name is conclusive, so the diagnostic fires.
- **Partial**: exports recovered only from the `INDEX` file, which lists documented topics rather than every export. No diagnostic, to avoid false positives.
- **Unknown**: the package hasn't been loaded yet, or can't be resolved without R. No diagnostic. Raven never starts R to check a member, so the diagnostic appears only after background loading finishes and Raven rechecks, including in other open documents that use the same `pkg::`.

Data objects (a package's lazy data, and base datasets such as `datasets::mtcars`) can confirm that a member exists but never prove one absent, so a `pkg::dataset` reference is never flagged. A precise check for data members is planned.

</details>

<a id="semantic-warnings"></a>
### `mixed-logical`

`|` or `||` has a bare `&` or `&&` as a direct operand, as in `a & b | c`. `&` binds more tightly than `|` in R, so the grouping is easy to misread.

**Example**

<!-- example: diag-mixed-logical file=filter.R -->
```r
a <- TRUE
b <- FALSE
c <- TRUE
keep <- a & b | c
```

<!-- example: diag-mixed-logical -->
```console
$ raven check .
filter.R:4:15 warning: Mixed `&` and `|` without parentheses; `&` binds tighter than `|`. Add parentheses to clarify intent: `(a & b) | c` or `a & (b | c)`. [mixed_logical]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Add parentheses that say what you mean:

```r
keep <- (a & b) | c
```

**Suppressible**: yes, with `# raven: ignore`, `# raven: ignore-next`, or `# nolint` (optionally `# nolint: mixed_logical`).

**Setting**: `raven.diagnostics.mixedLogicalSeverity` (default `"warning"`).

The CLI prints the code as `mixed_logical`; either spelling works in a selector. The check stops at call and subset boundaries.

### `condition-assignment`

`=` is used as an operator directly inside an `if` or `while` condition, as in `if (x = 1)`. R rejects this when it runs, but the parser Raven uses accepts it.

**Example**

<!-- example: diag-condition-assignment file=check.R -->
```r
n <- 3
if (n = 3) print("three")
```

<!-- example: diag-condition-assignment -->
```console
$ raven check .
check.R:2:7 warning: Use `==` to test equality; `=` is not valid in R conditions. For assignment use `<-`. [condition_assignment]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

**Fix**

Use `==` to compare:

```r
n <- 3
if (n == 3) print("three")
```

**Suppressible**: yes, with `# raven: ignore`, `# raven: ignore-next`, or `# nolint` (optionally `# nolint: condition_assignment`).

**Setting**: `raven.diagnostics.conditionAssignmentSeverity` (default `"warning"`).

The CLI prints the code as `condition_assignment`; either spelling works in a selector. The check stops at call, parenthesized-expression, and braced-expression boundaries.

### `unused-suppression`

A `# raven: expect` directive, or with `raven.diagnostics.reportUnusedSuppressions` on, any ignore directive, suppressed nothing.

**Example**

<!-- example: diag-unused-suppression file=report.R -->
```r
total <- 10
print(total) # raven: expect[undefined-variable]
```

<!-- example: diag-unused-suppression -->
```console
$ raven check .
report.R:2:1 hint: This `expect` directive matched no diagnostic. [unused-suppression]
1 issues (0 errors, 0 warnings, 0 infos, 1 hints, 0 notes)
```

**Fix**

Delete the directive; the problem it covered is gone.

```r
total <- 10
print(total)
```

**Suppressible**: no.

**Setting**: `raven.diagnostics.reportUnusedSuppressions` (default `false`) extends the check from `expect` directives to every ignore directive.

It is a hint, so it doesn't fail `raven check` at the default `--max-severity`. See [Get told when a suppression goes stale](#get-told-when-a-suppression-goes-stale).

<a id="cross-file-diagnostics"></a>
### Circular dependency, chain depth, and redundant directives

These dependency-graph diagnostics carry no code, so `raven check` prints empty brackets after them. They can't be silenced by comment; use each one's severity setting.

| Diagnostic | Default severity | Trigger | Setting |
|---|---|---|---|
| Circular dependency | error | Two files source each other, directly or through other files | `raven.crossFile.circularDependencySeverity` |
| Max chain depth exceeded | warning | A source chain is deeper than `raven.crossFile.maxChainDepth` | `raven.crossFile.maxChainDepthSeverity` |
| Redundant directive | hint | A `# raven: source` directive names a file an earlier `source()` call already brings in | `raven.crossFile.redundantDirectiveSeverity` |

**Example**

<!-- example: diag-circular-dependency file=a.R -->
```r
source("b.R")
```

<!-- example: diag-circular-dependency file=b.R -->
```r
source("a.R")
```

<!-- example: diag-circular-dependency -->
```console
$ raven check .
a.R:1:1 error: Circular dependency: b.R line 1 sources this file []
b.R:1:1 error: Circular dependency: a.R line 1 sources this file []
2 issues (2 errors, 0 warnings, 0 infos, 0 hints, 0 notes)
```

<!-- example: diag-redundant-directive file=main.R -->
```r
source("helpers.R")
# raven: source helpers.R
```

<!-- example: diag-redundant-directive -->
```console
$ raven check .
main.R:2:1 hint: Redundant source directive: 'helpers.R' is already sourced by a source() call []
1 issues (0 errors, 0 warnings, 0 infos, 1 hints, 0 notes)
```

**Fix**

Break the cycle by removing one of the `source()` calls, usually by moving shared code into a third file both can source. Delete a redundant directive. For a chain that is deep on purpose, raise `raven.crossFile.maxChainDepth`.

The other cross-file diagnostics have codes: [`unresolved-source-path`](#unresolved-source-path), [`source-path-case-mismatch`](#source-path-case-mismatch), and out-of-scope uses, which carry [`undefined-variable`](#undefined-variable) and honor `# raven: ignore`.

### Style lints

Raven has native versions of 18 of [lintr](https://lintr.r-lib.org/)'s default rules, with no R or lintr install needed. They are off unless `raven.linting.enabled` turns them on. Its default `"auto"` turns them on when a `.lintr` or `raven.toml` opts in; the [behavior matrix](linting.md#behavior-matrix) covers the exceptions for `~/.lintr`, REditorSupport, and Positron.

Each rule has its own code, such as `line-length` or `object-name`. All default to information, matching how REditorSupport's languageserver reports lintr findings. Lint diagnostics show the source `raven (lint)`, so you can tell them apart from Raven's other findings. Selectors accept both the kebab-case code and lintr's `snake_case` name.

| Code | Checks |
|---|---|
| [`line-length`](linting.md#line-length) | Lines longer than `raven.linting.lineLength` (default 80) |
| [`trailing-whitespace`](linting.md#trailing-whitespace) | Spaces or tabs at the end of a line |
| [`no-tab`](linting.md#tab-characters) | Tabs used for indentation |
| [`trailing-blank-lines`](linting.md#trailing-blank-lines) | Blank lines at the end of the file, or a missing final newline |
| [`assignment-operator`](linting.md#assignment-operator) | An assignment operator other than the preferred one (`<-` by default) |
| [`object-name`](linting.md#object-names) | Names that don't match the configured styles or regexes |
| [`object-length`](linting.md#object-length) | Names longer than `raven.linting.objectLength` (default 30) |
| [`infix-spaces`](linting.md#infix-spaces) | Missing spaces around low-precedence operators (`a+b`, `x<-1`) |
| [`commented-code`](linting.md#commented-code) | Comments that contain R code |
| [`quotes`](linting.md#quotes) | Strings not using the preferred quote (`"` by default) |
| [`commas`](linting.md#commas) | Space before a comma, or none after it |
| [`t-and-f-symbol`](linting.md#t--f-symbol) | Bare `T` / `F` instead of `TRUE` / `FALSE` |
| [`semicolon`](linting.md#semicolon) | `;` separators |
| [`equals-na`](linting.md#equals-na) | `x == NA` and similar; use `is.na(x)` |
| [`vector-logic`](linting.md#vector-logic) | `&` / `\|` in `if` conditions, `&&` / `\|\|` in `subset()` / `filter()` |
| [`function-left-parentheses`](linting.md#function-left-parentheses) | Space between a function name and `(` |
| [`spaces-inside`](linting.md#spaces-inside) | Space just inside `(`, `[`, or `[[` |
| [`indentation`](linting.md#indentation) | Leading whitespace that doesn't match the surrounding code |

See [Linting](linting.md) for each rule's exact behavior and settings.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `raven.diagnostics.enabled` | `true` | Master switch for every diagnostic |
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Severity of [`undefined-variable`](#undefined-variable) |
| `raven.diagnostics.undefinedVariableInCallArguments` | `true` | Check names inside call arguments |
| `raven.diagnostics.undefinedVariableInBracketIndices` | `true` | Check names inside `[` indices |
| `raven.diagnostics.mixedLogicalSeverity` | `"warning"` | Severity of [`mixed-logical`](#mixed-logical) |
| `raven.diagnostics.conditionAssignmentSeverity` | `"warning"` | Severity of [`condition-assignment`](#condition-assignment) |
| `raven.diagnostics.reportUnusedSuppressions` | `false` | Report unused `ignore` directives, not just `expect` |
| `raven.diagnostics.jags` | `"off"` | Check standalone JAGS/BUGS files |
| `raven.diagnostics.stan` | `"off"` | Check standalone Stan files |
| `raven.diagnostics.maxSyntaxDiagnosticsPerFile` | `500` | Limit on Stan and JAGS syntax findings per file; `0` for no limit |
| `raven.crossFile.*Severity` | varies | Severity of each cross-file diagnostic |
| `raven.packages.missingPackageSeverity`, `raven.packages.namespaceMemberSeverity` | `"warning"` | Severity of package diagnostics |

The [code index](#diagnostic-codes) maps every code to its setting. See the [settings reference](settings-reference.md) for allowed values and `raven.toml` paths, and [Configuration](configuration.md) for how settings combine.

## Limitations

- Raven's NSE policy table covers common packages but is not exhaustive, and resolving a function to its package depends on package metadata. A function Raven doesn't know can still cause a false `undefined-variable`. Use [`# raven: nse`](non-standard-evaluation.md#when-raven-needs-a-hint) for it, or fall back to `# nolint`, `# raven: ignore`, or the call-argument and bracket-index settings. See [Non-standard evaluation](non-standard-evaluation.md#limitations) for what the table covers.
- When data.table or another bracket-NSE package is in play, an unresolved non-data.table object such as `df[typo, ]` may be skipped silently.
- A `[` call with a `:=` argument is skipped entirely, so a typo elsewhere in the call (`d[typo, y := 1]`) is not reported. The rule keys on `:=` only. data.table's `let()` alias is an ordinary name any package or script can define, so `d[, let(a = 1)]` is treated as data.table-style only when a bracket-NSE package is in play or `d` is a known data.table.
- <a id="accepted-gap"></a>Because `raven check` doesn't report generic missing packages by default, a typo such as `library(dpylr)`, unknown to every package source, is silent unless you pass `--report-uninstalled`. The default avoids nagging about dependencies CI hasn't installed. Pass the flag in a pipeline that runs `renv::restore()` to catch packages that failed to install. The editor still flags such a call whenever it knows what is installed.
- Stan and JAGS chunks inside R Markdown or Quarto are not checked as standalone programs.

## Details

### Package names vs. install status

Raven can learn a package's export names from three sources, tried in order: installed packages (Tier 1), a committed `.raven/packages.json` (Tier 2), and Raven's `names.db` package database (Tier 3) when available. So symbols from `library(pkg)` resolve even when the package isn't installed, for example in CI with no R. The database is not bundled with the binary; install it with `raven packages update` for broad CRAN and Bioconductor coverage. See [Package database](package-database.md).

Knowing a package's exports is kept separate from knowing whether it is installed:

- **Export resolution**, which prevents undefined-variable noise, uses all three tiers in every mode.
- **Install status**, which drives `package-not-installed`, uses Tier 1 only: what is really in the local library paths. A database that knows `dplyr`'s exports does not make `dplyr` count as installed.

<a id="per-mode-behavior"></a>

| | Export resolution | Missing package ("not installed") |
|---|---|---|
| **Editor** | Tiers 1, 2, 3. Prevents a flood of undefined variables when R is absent and Tier 2 or Tier 3 covers the package. | Reported when install state is known and the package is absent, whatever the database says. Export metadata stops the undefined-variable flood but never hides the install reminder. |
| **`raven check` (CI)** | Tiers 1, 2, 3 | Generic absence is off by default, since CI usually skips installation. `package-outside-active-library` stays on. Turn generic absence on with [`--report-uninstalled`](cli.md#missing-package-reporting-in-ci). |

With `--report-uninstalled`, Raven reports `library()` calls for packages not present in the local library paths, regardless of Tier 2 or Tier 3 metadata. Use it when a `library(X)` call must really succeed: CI that installs packages (for example with `renv::restore()`) and wants to catch failures, or CI that runs your R scripts after `raven check`, as in package development. CI that only gates on `raven check` and never runs the scripts wants the default.

### JAGS and Stan parse errors

With model diagnostics on, syntax errors in Stan and JAGS files use the non-suppressible [`syntax-error`](#syntax-error) code and error severity.

<!-- example: diag-jags-syntax-error file=model.jags -->
```jags
model {
  for (i in 1:N) {
    y[i] ~ dnorm(mu, tau)
  }
  mu ~ dnorm(0, 0.001
  tau ~ dgamma(0.01, 0.01)
}
```

<!-- example: diag-jags-syntax-error -->
```console
$ raven check .
model.jags:5:13 error: Unclosed `(`: missing matching `)` [syntax-error]
1 issues (1 errors, 0 warnings, 0 infos, 0 hints, 0 notes)
```

Stan and JAGS syntax findings share `raven.diagnostics.maxSyntaxDiagnosticsPerFile` (default `500`). Raven drops exact duplicate findings, sorts the rest by position, and keeps the first N. Set it to `0` for no limit. The limit bounds memory and the size of editor and CLI output, while checking continues so cancellation stays responsive. It does not apply to R diagnostics.

<details markdown="1">
<summary>How Stan and JAGS syntax messages are chosen</summary>

When the parser's recovery gives clear structural evidence, Stan and JAGS findings explain missing closers, missing openers, and mismatches for `()`, `[]`, and `{}`, with the same wording as R. An unclosed-bracket range starts at the opener and spans the meaningful code on that line; a stray or wrong closer is highlighted directly. Stan and JAGS don't use R's `[[` / `]]` delimiters.

Raven confirms these explanations with one bounded, language-aware scan of the text. Brackets inside Stan strings, comments, and complete `#include` paths, or inside JAGS comments and `%...%` operators, don't affect pairing; an unfinished include keeps the generic message. A missing closer the parser inserted can still be explained when a later closer clearly belongs to an enclosing construct. If the structural and text evidence disagree, a scan limit is reached, unparseable text overlaps the recovery, or more than one bracket fault is plausible, Raven keeps the generic `Stan code could not be parsed here` or `JAGS code could not be parsed here` rather than guess.

High-confidence program-structure recovery also gets specific wording:

- Complete Stan declarations, function definitions, and statements at the top level are told they must be inside a program block such as `functions`, `data`, `parameters`, or `model`. Raven doesn't guess which block is right.
- Complete top-level JAGS relations and loops are told they belong in a `data` or `model` block.
- A missing required JAGS `model` block, an empty or comment-only model, and duplicate or out-of-order `var`, `data`, and `model` sections get their own explanations, anchored on the relevant section.

Incomplete fragments, misspelled block names, balanced malformed expressions, and other ambiguous recovery stay generic. All of these findings keep error severity and the `syntax-error` code.

JAGS findings come from Raven's own clean-room grammar. They cover parser errors and required missing tokens, in stable source order, without duplicate recovery cascades. The grammar and its diagnostics are checked against 806 recorded outcomes from the public JAGS 4.3.2 command-line parse phase. Raven applies this strict JAGS dialect to `.jags`, `.bugs`, and `.bug` files, case-insensitively. Treating those extensions as JAGS does not claim compatibility with OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE.

Full-line Raven directives are allowed in Stan files and don't cause parse errors. Stan's own `#include` is part of the Stan grammar; other unknown `#` lines are diagnosed. Raven doesn't check whether an include target exists. `.stanfunctions` helper files are not checked as standalone programs.

A trailing `# raven: ignore` or `# @lsp-ignore` is hidden from the Stan parser while the code before it stays intact. This never hides a real syntax error in that code, and syntax findings stay non-suppressible. Marker-shaped text inside a Stan string, `//` comment, or `/* ... */` comment, including strings and block comments that span lines, is never treated as a directive or suppression.

</details>

### Stan undeclared variables

With `raven.diagnostics.stan` on, a structurally complete Stan program gets undeclared-variable findings with the [`undefined-variable`](#undefined-variable) code and `raven.diagnostics.undefinedVariableSeverity` (warning by default). Setting that severity to `"off"` turns off only this check; Stan syntax findings stay on.

<!-- example: diag-stan-undeclared-variable file=model.stan -->
```stan
data {
  int<lower=0> N;
  vector[N] y;
}
parameters {
  real mu;
}
model {
  y ~ normal(mu, sigma);
}
```

<!-- example: diag-stan-undeclared-variable -->
```console
$ raven check .
model.stan:9:18 warning: sigma is not defined [undefined-variable]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

To fix it, declare `sigma`, for example as `real<lower=0> sigma;` in the `parameters` block. A value that R passes in must still be declared in Stan's `data` block.

Local `# raven: var` and `# raven: func` declarations, and `# raven: ignore` / `# raven: ignore-next`, apply to Stan undeclared-variable findings in the editor and the CLI. This is a narrow escape hatch: it does not put Stan into R's scope or cross-file analysis. A value supplied by R is still reported unless it is declared in Stan or covered by one of these directives.

<details markdown="1">
<summary>Exact Stan scoping rules</summary>

The check models declaration order; the visibility order data → transformed data → parameters → transformed parameters → model → generated quantities; function parameters and locals; statement-block locals; and `for` loop variables. It checks references in dimensions, constraints, initializers, and statements. Function and distribution names are a separate namespace, so calls, sampling distributions, prototypes, and a user function passed as a higher-order argument are not mistaken for variables.

Raven does not report whether a called function or sampling distribution exists; that needs the compiler's overload and type resolution. A name used as a higher-order value is a variable expression, though, so an unknown value such as `reduce_sum(missing_fun, ...)` is reported.

Declaration order follows the pinned compiler. Shared type dimensions and constraints are resolved before any declared name; the current local name is visible in its own initializer; and comma-separated declarators become visible left to right, so `real a = 1, b = a` is clean while `real a = b, b = 1` reports `b`. Branch, loop, `while`, nested-block, and `profile` locals are visible only inside their own statement.

Completeness is syntactic: the program must contain at least one real `functions`, `data`, `transformed data`, `parameters`, `transformed parameters`, `model`, or `generated quantities` block at the top level. A file with no such block gets syntax diagnostics only. That keeps standalone fragments quiet, including files organized by comments such as `//--- data` or `//--- model`, because other fragments may supply their declarations. Missing one optional block does not turn the check off: `model { target += from_r; }` still reports `from_r`, because data supplied by R must be declared in Stan.

Raven never looks inside parser-recovery regions for declarations or references. If recovery could have hidden a declaration, unresolved references that could see it are not reported, while independent scopes and blocks are still checked. If a file contains any `#include`, anywhere, Raven reports no Stan undeclared variables for that file, because an include can add declarations and Raven doesn't preprocess includes.

Stan semantic findings have a fixed limit of 500 unique findings per file, in source order. It is separate from `maxSyntaxDiagnosticsPerFile`, so changing the syntax setting doesn't change undeclared-variable output. Checking continues after the limit so cancellation stays responsive.

</details>

## See also

- [Linting](linting.md): opt-in style rules and their settings
- [Directives](directives.md): every `# raven:` comment
- [Non-standard evaluation](non-standard-evaluation.md): how Raven treats dplyr-style column names
- [Cross-file analysis](cross-file.md): how `source()` chains and paths resolve
- [Command line](cli.md): `raven check` flags, formats, and exit codes
