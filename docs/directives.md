# Directives

[Docs](README.md) › Reference

Directives are `# raven:` comments that tell Raven what it can't work out from your code: which files source each other, the working directory, names created at runtime, how a function evaluates its arguments, and which diagnostics to silence.

| Directive | What it tells Raven | Where it goes |
|---|---|---|
| [`# raven: source <path>`](#forward-directives) | This file sources `<path>` at this line | Anywhere |
| [`# raven: sourced-by <path>`](#backward-directives) | This file is sourced by `<path>` | Header |
| [`# raven: cd <dir>`](#working-directory-directives) | Resolve paths in this file from `<dir>` | Header |
| [`# raven: self-contained`](#self-contained-sourced-files) | Analyze this file without its callers' bindings | Header |
| [`# raven: var <name>`](#variable-declarations) | `<name>` exists from the next line on | Anywhere |
| [`# raven: func <name>(<formals>)`](#function-declarations) | Function `<name>` exists, with these formals | Anywhere |
| [`# raven: nse <name>(<formals>)`](#nse-declarations) | These arguments of `<name>` are captured, not evaluated | Anywhere |
| [`# raven: ignore`, `ignore-next`, `ignore-file`, …](#ignore-directives) | Silence diagnostics | Trailing, or anywhere |

## General syntax

`# raven:` is the prefix for every directive family. The older `@lsp-` prefix is a permanent alias for every directive: `# raven: source utils.R` and `# @lsp-source utils.R` are equivalent, as are `# raven: sourced-by ../main.R` and `# @lsp-sourced-by ../main.R`, `# raven: cd /data` and `# @lsp-cd /data`, and so on. Use `# raven:` in new code; you never need to mix the two.

Directives must be on their own comment line, starting with `#` and optionally indented. Raven doesn't recognize them in trailing comments like `x <- 1 # raven: source file.R`. The exceptions are the line-level ignore markers `# raven: ignore` and `# raven: expect` (and their aliases `@lsp-ignore` and `@lsp-expect`), which work as trailing comments.

Every directive accepts an optional colon and quotes:

```r
# raven: sourced-by ../main.R
# raven: sourced-by: "../main.R"
# raven: sourced-by: '../main.R'
```

**Header-only directives.** Backward directives, working-directory directives, and `self-contained` must be in the file header: the consecutive blank and comment lines at the top of the file, before any code. After the first line of code they are ignored. Forward, declaration, and ignore directives can go anywhere.

## Forward directives

Declare that this file sources another file. Use it when the path is dynamic or conditional:

```r
# raven: source utils/helpers.R
# raven: run utils/helpers.R        # synonym
# raven: include utils/helpers.R    # synonym
# @lsp-source utils/helpers.R       # alias (also @lsp-run / @lsp-include)
```

Symbols from the target file become available after the directive's line. An optional `line=` parameter moves that point:

```r
# raven: source utils/helpers.R line=25
# Symbols from helpers.R become available at line 25 (not at this directive's line)
```

```r
# raven: source utils/helpers.R line=eof
# Symbols become available at end of file (line=end is an accepted synonym)
```

**Path resolution.** Forward directives resolve exactly like `source()` calls: relative to the file's directory, respecting `# raven: cd`, with the workspace-root fallback when no working directory is in effect. See [Path resolution](cross-file.md#path-resolution).

A forward directive without `line=` that names the same file as an earlier `source()` call is reported as a [redundant directive](diagnostics.md#circular-dependency-chain-depth-and-redundant-directives).

## Backward directives

Declare that this file is sourced by another file. These are header-only:

```r
# raven: sourced-by ../main.R
# raven: run-by ../main.R        # synonym
# raven: included-by ../main.R   # synonym
# @lsp-sourced-by ../main.R      # alias (also @lsp-run-by / @lsp-included-by)
```

Optional parameters:

- `line=N`: the 1-based line in the parent where the `source()` call is.
- `line=eof` or `line=end`: use the scope at the end of the parent file.
- `match="pattern"`: text to search for in the parent to find the `source()` call.

```r
# raven: sourced-by ../main.R line=15
```

```r
# raven: sourced-by ../main.R line=eof
# Sees all symbols defined in main.R, including those from other sourced files
```

```r
# raven: sourced-by ../main.R match="source("
# Searches for "source(" in main.R and uses the first match
```

**Call-site inference.** Without `line=` or `match=`, Raven scans the parent for `source()` calls that reference this file. If it finds none, it uses the `raven.crossFile.assumeCallSite` setting (default `"end"`).

**Path resolution.** Backward directives resolve relative to the file's own directory and **ignore** `# raven: cd`. They get the same case-only-mismatch leniency as forward paths, but never the workspace-root fallback. See [Case-only mismatches](cross-file.md#case-only-mismatches).

**Per-file opt-out of auto mode.** A file with an explicit `# raven: sourced-by` has auto-inferred backward links turned off. See [Backward dependency modes](cross-file.md#backward-dependency-modes).

## Working directory directives

Set the working directory used to resolve paths in this file. These are header-only:

```r
# raven: cd /data/scripts
# raven: working-directory /data/scripts   # synonym
# raven: working-dir /data/scripts         # synonym
# raven: current-directory /data/scripts   # synonym
# raven: current-dir /data/scripts         # synonym
# raven: wd /data/scripts                  # synonym
# @lsp-cd /data/scripts                    # alias (every synonym also has an @lsp- form)
```

How the path is read:

- A path starting with `/` is relative to the workspace root: `/data` means `<workspace>/data`.
- Any other path is relative to the file: `../shared` means the parent directory's `shared`.

What it affects:

| Directive type | Uses the `cd` directive? |
|---|---|
| Forward (`source` / `run` / `include`) | **Yes** |
| `source()` calls | **Yes** |
| Backward (`sourced-by` / `run-by` / `included-by`) | **No** |

While a `cd` is in effect, explicit or inherited, Raven doesn't apply the workspace-root fallback, and it overrides the implicit [testthat/testit working directory](cross-file.md#implicit-testthattestit-working-directory).

### Working directory inheritance

A child file that uses a backward directive and has no `cd` of its own inherits the working directory from its parent. Inheritance carries through any number of levels. An explicit `cd` in the child always wins.

```r
# parent.R
# raven: cd /data/project
source("child.R")
```

```r
# child.R
# raven: run-by ../parent.R
# Inherits /data/project from parent
source("utils.R")  # Resolves to <workspace>/data/project/utils.R
```

## Self-contained sourced files

```r
# raven: self-contained
# raven: standalone          # alias
# @lsp-self-contained        # alias
# @lsp-standalone            # alias
```

Put `# raven: self-contained` in the **header** of a sourced helper, setup, or library-style file to declare that it doesn't rely on bindings its callers provide. It takes no arguments and is header-only: a `self-contained` or `standalone` token after code is ignored.

Raven analyzes a self-contained file **in isolation** from the files that `source()` it, both for its own diagnostics and when another file pulls it in as a forward `source()` child:

- It does **not** inherit variables, loaded packages, or the working directory from any caller. Its scope depends only on the file itself and the files it sources, not on who sources it.
- It **still contributes** its own definitions *and* its own `library()` packages to callers, as any sourced file does. A module that loads the packages its callers rely on still works.
- Its own `rm()`/`remove()` of its own symbols still affects what it exports, but it never removes a caller's bindings.

**When to use it.** On a helper or setup file that many others source, especially one that itself sources a deep or broad chain of files. It stops one caller's bindings from leaking into the file's analysis on behalf of another, and can make Raven much faster on deeply nested, widely sourced graphs. See [Performance on large projects](cross-file-analysis-performance.md).

**You vouch for it.** If the file actually relies on a binding a caller provides, the worst case is a false *undefined variable* warning **inside the self-contained file itself**, never a hidden bug in a caller. Mark the *root* setup file that provides the shared environment as self-contained, not a leaf that consumes it.

**Interactions.** `self-contained` only cuts the caller-to-file direction. It works alongside `# raven: cd` (the file uses its own working directory), `# raven: nse` and `# raven: func` (their propagation across `source()` links is unaffected), package mode, and a caller's `local = TRUE` or `sys.source()` (which govern how a *caller* sources the file, separately from the file's own isolation). See [Cross-file analysis](cross-file.md) for the resolution model.

## Declaration directives

Declare symbols created at runtime that Raven can't see. They stop false *undefined variable* warnings for symbols from `eval()`, `assign()`, `load()`, or external data loading.

Declaration directives work in any R file, whether or not it is part of a `source()` chain. In Stan, local `# raven: var` and `# raven: func` declarations are also honored by the conservative undeclared-variable check, from the following line onward. This is local only: it doesn't create R scope or cross-file links for a `.stan` file.

### Variable declarations

```r
# raven: var myvar
# raven: variable myvar           # synonym
# raven: declare-var myvar        # synonym
# raven: declare-variable myvar   # synonym
# @lsp-var myvar                  # alias (every synonym also has an @lsp- form)
```

Raven also treats an `exists("myvar")` call as an automatic `# raven: var myvar`. A probe like `if (!exists("myvar")) myvar <- default` declares `myvar` with no directive, with the same next-line visibility: the name resolves from the line *after* the `exists()` call, and a use before it is still flagged. See [`undefined-variable`](diagnostics.md#undefined-variables) for the exact rules (string-literal name, next-line visibility).

### Function declarations

```r
# raven: func myfunc
# raven: function myfunc          # synonym
# raven: declare-func myfunc      # synonym
# raven: declare-function myfunc  # synonym
# @lsp-func myfunc                # alias (every synonym also has an @lsp- form)
```

`# raven: func` can also declare a formal list, which records the parameter order for `# raven: nse` positional matching (see below). You can paste a real signature; `= default` parts are dropped, keeping just the formal names:

```r
# raven: func my_func(data, x, y)        # declares existence + formal order
# raven: func my_func(data, x = NULL)    # defaults are stripped → data, x
# raven: func pkg::my_func(data, x)      # qualified form
# raven: func "my data fn"               # quote a name with spaces / special chars
```

An unquoted name can be a bare `name` or a single `pkg::name` qualifier, including dotted names like `make.names`, since `.` is an ordinary identifier character in R. Only a name with characters *outside* `[A-Za-z0-9._]`, such as a name with spaces or a replacement function like `` `dim<-` ``, needs the quoted form. A default whose value contains a comma or parentheses (`x = c(1, 2)`) isn't supported; keep formal lists to names and simple literal defaults.

### NSE declarations

Tell Raven that a function uses non-standard evaluation (NSE), so bare names in its captured arguments aren't flagged as undefined variables. For examples and when to use it, see [Non-standard evaluation](non-standard-evaluation.md).

```r
# raven: nse my_func              # whole-call: every argument is NSE
# raven: nse my_func(x)           # only the `x` formal is captured
# raven: nse my_func(x, y)        # `x` and `y` are captured
# raven: nse my_func(...)         # arguments absorbed by `...` are captured
# raven: nse pkg::my_func(x, y)   # qualified form
# raven: nse "my data fn"(x)      # quote a name with spaces (called `my data fn`(x))
# @lsp-nse my_func(x)             # alias (optional colon/spacing also accepted)
```

As with `# raven: func`, the function name can be a bare `name` or a single `pkg::name` unquoted, and a name with characters outside `[A-Za-z0-9._]`, such as spaces, must be quoted.

The declaration applies only to ordinary `name(args)` calls, so it can't apply to operators: `a %+% b` isn't such a call. An operator name has characters outside `[A-Za-z0-9._]`, so it would have to be quoted (`# raven: nse "%+%"`) to parse at all, and even then it has no effect.

A literal `...` in the captured list means the arguments a call passes through the function's `...` are captured. Formals listed before `...` that aren't captured are still checked. Combine it with named formals, as in `# raven: nse my_func(x, ...)`.

`# raven: nse` is position-aware: it applies to calls **after** the directive line, and the most recent declaration for a function wins. It overrides Raven's own inference for that function, but it is **not** a blanket diagnostic ignore: it declares how the named function evaluates its arguments, for every call.

- An *unqualified* declaration overrides even a local `name <- function(...)` definition's inferred policy, since R calls that binding and you are declaring how it evaluates its arguments.
- A *qualified* declaration (`pkg::my_func`) matches both `pkg::my_func(...)` and unqualified `my_func(...)` calls when `pkg` is in scope (through `library()` or package imports). The exception is when a local binding shadows the bare name, since R would then call the local value rather than `pkg::my_func`.

Named arguments match by formal name, in any order. For **positional** arguments Raven needs the formal order, which it reads from a visible local definition or a paired `# raven: func` declaration:

```r
# raven: func my_func(data, x, y)   # declares existence + formal order
# raven: nse my_func(x, y)          # declares which formals are captured
my_func(df, col_a, col_b)           # col_a, col_b suppressed; df checked
```

Raven's diagnostics know installed packages' export names but not their formals, so positional matching for a function from an installed package also needs a paired `# raven: func` with formals.

#### `# raven: nse` is deliberately coarse

`# raven: nse` is a file-level, name-keyed override. Apart from applying only to calls after its own line, it is deliberately **not**:

- **Scope-aware.** It applies to every call of the named function in the file, including calls inside nested function bodies that rebind the name locally. A nested helper that shares a top-level name is still governed by the file-level directive, not by its inner definition.
- **Aware of where `library()` is.** Whether a `pkg::` qualifier's package is in scope is judged for the whole file, so a qualified declaration can govern a bare call even if the matching `library(pkg)` comes later in the file.
- **Checked against the signature.** Raven doesn't compare the captured formals with the function's real definition. In particular, `# raven: nse f(...)` captures a call's trailing arguments even if `f` has no `...` formal.

This is by design: the directive is an opt-in escape hatch, and you're responsible for declaring an accurate policy. It **replaces** Raven's own inference for that function rather than adding to it, so a wrong or stale directive cuts both ways. One *broader* than the real behavior hides diagnostics you may have wanted. One *narrower* than Raven's own inference, such as a partial capture on a function Raven already treats as data-masking, can bring back diagnostics Raven would otherwise have suppressed.

#### `# raven: nse` propagates across the source graph

A `# raven: nse` declaration governs matching calls in **every file connected to it through `source()`**, not just the file it's written in. Declare a helper's NSE contract next to its `library()` call, its definition, or in a sourced setup file, and it suppresses the matching false positives wherever the helper is called. Propagation works in both directions and through any number of hops:

```r
# setup.R
library(arm)
# raven: nse: lmer

# analysis.R
source("setup.R")
lmer(undefined_var)   # `undefined_var` suppressed — lmer is declared NSE in setup.R
```

How a propagated declaration ranks:

- In another connected file, it ignores its original line and governs the whole file.
- In the file that contains it, the usual position-aware, latest-wins rule applies, and that file's own directive beats one propagated from a connected file.
- Raven consults it after its precise built-in policy tables, so it never loosens a function Raven already models (such as `dplyr::filter`). It governs functions that would otherwise be checked as standard evaluation, like `lmer`.
- A local `name <- function(...)` definition **shadows** a propagated declaration entirely, because R would call the local value, so the local definition's own inferred policy applies. A local binding overrides a qualified `# raven: nse pkg::name` the same way.

Two files that aren't connected never share NSE declarations. The context a declaration needs, such as the `library()` call or a `# raven: func` formal order, may be in any connected file, before or after the directive. A propagated **per-formal** declaration gets the function's formal order only from a `# raven: func` in some connected file; a local definition doesn't supply it. Without one, it matches named arguments only.

Propagation uses the same dependency graph as cross-file scope, so it follows `# raven: cd`, the workspace-root fallback, and the `maxChainDepth` limit, and editing a directive in any connected file rechecks the files that rely on it. See [NSE directive propagation](cross-file.md#nse-directive-propagation).

### Position-aware behavior

Declared symbols are available from the next line on:

```r
# raven: var data_from_api
x <- data_from_api  # OK: in scope (next line after directive)
```

```r
x <- data_from_api  # ERROR: used before declaration
# raven: var data_from_api
```

### Cross-file inheritance

Declarations reach sourced child files when they come before the `source()` call:

```r
# parent.R
# raven: var shared_data
source("child.R")  # child.R can use shared_data
```

### Use cases

```r
# Dynamic assignment
assign(paste0("var_", i), value)
# raven: var var_1
# raven: var var_2

# Loading data from external sources
load("data.RData")
# raven: var model_fit
# raven: var training_data

# eval() with constructed expressions
eval(parse(text = code_string))
# raven: func dynamic_function
```

## Ignore directives

Ignore directives silence diagnostics in the editor and in `raven check`, for both Raven's correctness diagnostics and the opt-in [lint rules](linting.md). [Suppressing diagnostics](diagnostics.md#suppressing-diagnostics) is the full reference, including which codes can be suppressed and lintr's `# nolint`.

| Form | What it silences | Full rules |
|---|---|---|
| <a id="line-and-next-line"></a>`x # raven: ignore` (trailing), `# raven: ignore-next` (own line) | This line, or the next line | [Silence a line](diagnostics.md#per-line--raven-ignore) |
| <a id="per-code-selector"></a>`# raven: ignore[undefined-variable, line-length]` | Only the listed codes | [Silence one code](diagnostics.md#silence-one-code) |
| <a id="file-and-block-forms"></a>`# raven: ignore-file`, `# raven: ignore-start` … `# raven: ignore-end` | The whole file, or a block | [Silence a block or a whole file](diagnostics.md#silence-a-block-or-a-whole-file) |
| <a id="expect--assert-that-a-suppression-is-used"></a>`# raven: expect`, `expect-next`, `expect[code]`, `expect-file`, `expect-start` / `expect-end` | Same as `ignore`, and reports an `unused-suppression` hint when nothing was silenced | [Get told when a suppression goes stale](diagnostics.md#get-told-when-a-suppression-goes-stale) |
| <a id="chunk-level-suppression-r-markdown--quarto"></a>`# raven: ignore-chunk`, or the `raven.ignore` chunk option | A whole R Markdown or Quarto chunk | [Code chunks](chunks.md#suppressing-diagnostics-in-a-chunk) |

`# @lsp-ignore`, `# @lsp-ignore-next`, `# @lsp-expect`, and `# @lsp-expect-next` are permanent aliases. In Stan files, ignore directives silence only `undefined-variable`; see [Stan undeclared variables](diagnostics.md#stan-undeclared-variables).

## See also

- [Cross-file analysis](cross-file.md): how `source()` chains and paths resolve
- [Non-standard evaluation](non-standard-evaluation.md): when to use `# raven: nse`
- [Diagnostics](diagnostics.md#suppressing-diagnostics): suppression in full
- [Performance on large projects](cross-file-analysis-performance.md): when to use `# raven: self-contained`
