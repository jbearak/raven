# Cross-file analysis

[Docs](README.md) › Analysis

Raven follows `source()` calls between your R files, so a function defined in one file counts as defined in every file that sources it, from the `source()` line onward. <a id="cross-file--package-awareness"></a>

<!-- example: cross-file-source-order file=main.R -->
```r
source("utils.R")
total <- add_tax(100)
refund <- add_taxes(-20)
```

<!-- example: cross-file-source-order file=utils.R -->
```r
add_tax <- function(x) x * 1.08
```

<!-- example: cross-file-source-order -->
```console
$ raven check .
main.R:3:11 warning: add_taxes is not defined [undefined-variable]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

Line 2 is fine: `add_tax()` comes from `utils.R`. Line 3 is flagged because no file defines `add_taxes`. You don't configure anything for this: ordinary `source()` calls just work. A sourced file's symbols count only below the `source()` line, as at runtime; see [Position-aware scope](#position-aware-scope).

## How it works

When you open a file in a workspace, Raven:

1. Scans the workspace for `source()` calls and builds a dependency graph of which file sources which.
2. Works out which symbols are available at each line of each file.
3. Uses that graph for completions, diagnostics, hover, and go-to-definition.

Packages follow the same model: a `library()` call in `main.R` makes the package available in the files `main.R` sources after that call. See [Package awareness](#package-awareness).

## Automatic `source()` detection

Raven reads these forms without any configuration:

| You write | Raven does |
|---|---|
| `source("utils.R")`, `source('utils.R')`, `source(file = "utils.R")` | Follows the file. |
| `sys.source("utils.R", envir = globalenv())` | Follows the file. Without a global `envir`, the child's symbols don't come back to the caller. |
| `source(system.file("helper.R", package = "pkg"))` | Resolves to `inst/helper.R` for the package you're developing, or to the installed package's copy. |
| `source(file.path("scripts", "helpers.R"))` | Folds a path built from fixed parts into a plain path. |
| `if (file.exists("config.R")) source("config.R")` | Follows the file when it exists, and reports nothing when it doesn't. |
| `files <- list.files("functions", pattern = "\\.R$", full.names = TRUE)` then `for (file in files) source(file)` | Sources each `.R` file in that folder, in order. |
| `source(paste0(dir, "/x.R"))`, `source(Sys.getenv("SETUP"))` | Skips the call. Use a [directive](#when-raven-cant-see-the-link). |

Each form has exact limits, described in [How Raven reads `source()` calls](#how-raven-reads-source-calls). Raven also models how [Shiny apps](#shiny-application-loading) load `R/` helpers and `global.R`, and how [`targets::tar_source()`](#targetstar_source-scripts) loads pipeline scripts.

Inside `source()` strings and path-taking directives, Raven completes `.R`/`.r` file and directory names, and Cmd/Ctrl-click opens the target file.

### R Markdown / Quarto chunks

Inside `.Rmd`, `.Rmarkdown`, and `.qmd` documents, only R chunk bodies count. Raven masks out prose and YAML front matter, so a `source()` or `library()` call in a chunk works exactly as in a `.R` file, while the same text in prose is ignored. Within one document, bindings from earlier chunks are visible in later chunks: define `x` in chunk 1 and it resolves in chunk 3.

A `.R` file can declare `# raven: sourced-by report.Rmd`, and Raven reads the report's chunks to supply that file's inherited scope. Raven's workspace scan doesn't include `.Rmd`, `.Rmarkdown`, or `.qmd` files, so the editor sees these relationships when the document is open or when a `.R` file points at it with a backward directive. See [Code chunks](chunks.md#cross-file-resolution-from-chunks).

## When Raven can't see the link

If a path is computed at runtime, or a file is sourced by something Raven doesn't scan, declare the relationship with a [directive](directives.md):

```r
# main.R
source(Sys.getenv("SETUP_SCRIPT"))
# raven: source setup/default.R
```

```r
# helpers.R
# raven: sourced-by ../main.R
```

- `# raven: source <path>` says "this file sources `<path>` here". The target's symbols are available after the directive's line.
- `# raven: sourced-by <path>` says "this file is sourced by `<path>`", so it sees the parent's symbols. It goes in the file's header, before any code.
- `# raven: cd <dir>` sets the working directory used to resolve paths, for scripts that run from somewhere other than their own folder.

### Backward dependency modes

The `raven.crossFile.backwardDependencies` setting controls how Raven finds the files that source the current file.

- **`"auto"` (default)**: Raven scans the workspace for `source()` calls and infers who sources whom, so you don't need `# raven: sourced-by`. Diagnostics wait until the workspace scan finishes, to avoid false positives.
- **`"explicit"`**: Raven uses only relationships declared with `# raven: sourced-by`. Use this if auto inference gives unwanted results, for example a file sourced by several parents whose scopes conflict.
- **Per-file opt-out**: adding an explicit `# raven: sourced-by` to a file turns off inference for that file.

## Where symbols become visible

### Position-aware scope

Symbols from sourced files are available only **after** the `source()` call:

```r
x <- 1
source("a.R")  # Symbols from a.R available after this line
y <- foo()     # foo() from a.R is now in scope
```

This applies to `source()` calls and to forward directives. The scope model aims to match what is available at runtime, for the cases Raven can determine statically. See [Symbol recognition](#symbol-recognition) for what's covered.

`source("child.R", local = TRUE)` at the top level of a script behaves like a plain `source()`. Inside a function body, the child sees that function's frame instead of the parent's top-level symbols. Under `local = TRUE`, the child's own definitions never come back out to the parent. See [`local` and `chdir`](#how-raven-reads-source-calls) for the exact rules.

### Global symbol hoisting

R binds names late: a function can call another function that doesn't exist yet when the first is *defined*, as long as it exists when the first is *called*:

```r
main <- function() {
  helper()  # helper doesn't exist yet, but will when main() is called
}
helper <- function() { 42 }
main()  # works fine
```

Raven supports this by hoisting global definitions into function bodies. Inside a function body, every global definition is visible regardless of position. Function-local variables stay strictly positional.

Hoisting is on by default. To turn it off, set the LSP init option `crossFile.hoistGlobalsInFunctions` to `false`. It is init-only and isn't in the VS Code Settings UI; see the [settings reference](settings-reference.md).

### Symbol recognition

Raven recognizes these R constructs as definitions:

- `name <- expr`, `name <<- expr`, `expr -> name`, `expr ->> name`
- `name = expr` (in assignment context)
- `assign("name", expr)` (string-literal names only)

For symbols created dynamically (`eval()`, `load()`, `assign()` with a computed name), use [declaration directives](directives.md#declaration-directives).

### Symbol removal (`rm`/`remove`)

Raven tracks `rm()` and `remove()` calls:

```r
x <- 1
rm(x)
x  # Warning: undefined variable
```

Raven understands `rm(x)`, `rm(x, y)`, and `rm(list = c("x", "y"))`. Dynamic forms like `rm(list = ls())` are skipped.

## Path resolution

When a path in one file points at another, the base directory depends on where the path came from:

- **`source()` calls and forward directives** (`# raven: source`, `run`, `include`) resolve relative to the directory of the file they're in, and honor a [`# raven: cd`](directives.md#working-directory-directives) working directory when one is in effect.
- **Backward directives** (`# raven: sourced-by`, `run-by`, `included-by`) resolve relative to the file's own directory and **ignore `# raven: cd`**.
- **Workspace-root fallback**: for `source()` calls and forward directives, when no working directory is in effect (neither an explicit `# raven: cd` nor one inherited from a parent file), a path that doesn't resolve from the file's directory is also tried from the workspace root. It never applies to backward directives.

Forward directives resolve exactly like `source()` calls, across dependencies, scope, missing-file diagnostics, Cmd/Ctrl-click, and path completion.

Two more rules handle common layouts:

- **Tests run from their own folder.** Files under `tests/testthat/` or `tests/testit/` resolve forward paths from that folder, the way testthat and testit run them. See [Implicit testthat/testit working directory](#implicit-testthattestit-working-directory).
- **Case-only mismatches still resolve.** `source("helpers.r")` finds an on-disk `helpers.R`, and Raven reports the mismatch once, as [`source-path-case-mismatch`](diagnostics.md#source-path-case-mismatch). See [Case-only mismatches](#case-only-mismatches).

## Package awareness

Raven recognizes `library()`, `require()`, `loadNamespace()`, and static `pacman::p_load()` calls, and makes the package's exports available to completions, hover, and diagnostics. See [`pacman::p_load()`](#pacmanp_load) for which `p_load()` forms count.

> [!TIP]
> **Developing an R package?** When the workspace root has a `DESCRIPTION` file, Raven switches to package mode: all `R/*.R` files see each other without `source()` calls, and `@import`/`@importFrom` annotations suppress undefined-variable diagnostics. See [Package development](r-package-dev.md).

A workspace-root `.Rprofile` is modeled separately from package mode. If your project `.Rprofile` defines helpers, attaches packages, or sources setup files, see [.Rprofile startup files](rprofile.md).

<a id="how-it-works-1"></a>
When you write `library(dplyr)`, Raven:

1. Detects the call and extracts the package name.
2. Resolves the package's exported symbols, usually by reading its installed `NAMESPACE` file directly with no R involved. See [When Raven calls R](#when-raven-calls-r) for the cases that need R.
3. Makes those symbols available with `{dplyr}` attribution in completions.
4. Stops reporting the package's exports as undefined variables.

### Position-aware loading

Package exports are available only after the `library()` call:

```r
mutate(df, x = 1)  # Warning: undefined variable 'mutate'
library(dplyr)
mutate(df, y = 2)  # OK: dplyr is now loaded
```

### Function-scoped loading

A `library()` call inside a function makes the exports available only within that function:

```r
my_analysis <- function(data) {
  library(dplyr)
  mutate(data, x = 1)  # OK: dplyr available inside function
}
mutate(df, y = 2)  # Warning: dplyr not available at global scope
```

### Cross-file package propagation

Packages loaded in a parent file are available in the files it sources afterward:

```r
# main.R
library(dplyr)
source("analysis.R")  # dplyr available in analysis.R
library(ggplot2)      # NOT available in analysis.R (loaded after source)
```

Packages loaded in a child file don't propagate back to its parents.

### Meta-package support

Raven knows which packages these meta-packages attach:

- **tidyverse**: dplyr, readr, forcats, stringr, ggplot2, tibble, lubridate, tidyr, purrr
- **tidymodels**: broom, dials, dplyr, ggplot2, infer, modeldata, parsnip, purrr, recipes, rsample, tibble, tidyr, tune, workflows, workflowsets, yardstick

Hover, help, and NSE handling use the package that really defines a symbol, so `mutate` under `library(tidyverse)` resolves to dplyr. See [Availability vs. ownership](#availability-vs-ownership).

### Supported call patterns

| Pattern | Supported |
|---|---|
| `library(pkgname)` | Yes |
| `library("pkgname")` | Yes |
| `require(pkgname)` | Yes |
| `loadNamespace("pkgname")` | Yes |
| `library(pkg, character.only = TRUE)` | No (dynamic) |
| `sapply(c("a","b"), library, character.only = TRUE)` | Yes ([apply family](#apply-family-loads)) |
| `sapply(libs, library, character.only = TRUE)` where `libs <- c("a","b")` | Yes (same-file variable) |
| `purrr::map(c("a","b"), library, character.only = TRUE)` | Yes (purrr family) |
| `for (pkg in libs) library(pkg, character.only = TRUE)` where `libs <- c("a","b")` | Yes ([loader loop](#deterministic-package-loader-loops)) |
| `sapply(paste0(...), library, character.only = TRUE)` | No (dynamic vector) |
| `tar_option_set(packages = c("a","b"))` | Yes, when the file also attaches targets ([details](#targetstar_option_set-worker-packages)) |
| `targets::tar_option_set(packages = "a")` | Yes (qualified, so no `library(targets)` needed) |
| `tar_option_set(TRUE, c("a"))` | No (positional `packages` is not matched) |

Base R packages (base, methods, utils, grDevices, graphics, stats, datasets) are always available without a `library()` call. See [Base packages](#base-packages) for datasets and `data()`.

### Keeping packages in sync

Raven watches your `.libPaths()` directories and refreshes when packages are installed, upgraded, or removed. If it misses a change, for example after `renv::activate()`, run **Raven: Refresh package cache** from the Command Palette. The `packages.watchLibraryPaths` and `packages.watchDebounceMs` settings control the watcher.

## Module & import systems

The `box` and `import` packages define selective-import systems. Raven models them differently from `source()` and `library()`: an import binds only the names it requests, rather than merging a file's definitions or attaching a whole package. See [box and import modules](modules.md).

## NSE directive propagation

A `# raven: nse` declaration (see [Non-standard evaluation](non-standard-evaluation.md) and [NSE declarations](directives.md#nse-declarations)) applies across files, like defined symbols and `library()` loads. It governs its named function in every file connected to it through `source()`, in both directions and through any number of hops.

Declare a helper's NSE contract once, next to its `library()` call, next to its definition, or in a sourced setup file, and Raven stops flagging the captured arguments at call sites in the connected files. Two files that aren't connected never share NSE declarations. See [How NSE declarations propagate](#how-nse-declarations-propagate) for the exact rules.

## Self-contained sourced files (`# raven: self-contained`)

By default a sourced file's scope includes what its callers had defined at each `source()` call that pulls it in. That matches R for ordinary script fragments, which may use variables their caller created.

A shared helper or setup file is often different: it defines its own inputs, loads its own packages, and sources its own helpers. Put `# raven: self-contained` (alias `# raven: standalone`) in its header and Raven analyzes it **without** its callers' bindings, while its definitions and `library()` loads still flow to every caller.

This is more precise, and on large projects it can be much faster: a setup file sourced by dozens of scripts, which itself sources dozens of files, is analyzed once instead of once per caller. See [Performance on large projects](cross-file-analysis-performance.md) for when to use it and [Directives](directives.md#self-contained-sourced-files) for the exact syntax. `# raven: nse` and `# raven: func` propagation is unaffected.

## How this feeds into features

- **[Diagnostics](diagnostics.md)**: undefined-variable warnings respect cross-file scope and loaded packages.
- **[Completions](completion.md)**: symbols from sourced files and packages appear with where they came from.
- **[Find references](find-references.md)**: finds occurrences by name across open and indexed files. This is a plain name match, not limited to the dependency graph.
- **[Go to definition](go-to-definition.md)**: jumps to definitions in other files.
- **[Hover](hover.md)**: shows where a symbol is defined and which package it comes from.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `raven.crossFile.backwardDependencies` | `"auto"` | How Raven finds the files that source the current one. See [Backward dependency modes](#backward-dependency-modes). |
| `raven.crossFile.assumeCallSite` | `"end"` | Where a `# raven: sourced-by` parent is assumed to call `source()` when Raven can't find the call |
| `raven.crossFile.maxChainDepth` | `64` | How deep Raven follows `source()` chains. See [Traversal budgets](#traversal-budgets-in-large-workspaces). |
| `raven.crossFile.maxTransitiveDependentsVisited` | `50000` | How many files Raven visits when building a file's neighborhood |
| `raven.crossFile.missingFileSeverity`, `caseMismatchSeverity`, `outOfScopeSeverity` | varies | Severity of the cross-file diagnostics |
| `raven.packages.rPath` | `""` | The R executable Raven runs for library paths and package exports |
| `raven.packages.additionalLibraryPaths` | `[]` | Extra package libraries to search |
| `raven.packages.watchLibraryPaths`, `watchDebounceMs` | `true`, `500` | Watch package libraries for installs and removals |

See the [settings reference](settings-reference.md) for every `raven.crossFile.*` and `raven.packages.*` setting, and [Configuration](configuration.md) for how settings combine.

## Limitations

- Dynamic paths such as `paste0(...)` or `Sys.getenv(...)` are skipped. Add a [forward directive](directives.md#forward-directives) for them.
- `lapply`, `sapply`, and `purrr::walk` idioms that source a list of files aren't followed. Use the exact [`list.files()` loop](#how-raven-reads-source-calls) or explicit `source()` calls.
- Path folding is lexical: `setwd()` calls and the symlink resolution that `normalizePath()` does at runtime are ignored, as they are for literal paths.
- When a child inherits its parent's scope through `# raven: sourced-by` or an inferred backward link, a `data()` call in the parent passes only the dataset's literal name to the child, not every object the data file defines. In `data(api)`, `api` flows to the child but `apiclus1` and `apistrat` may not. Forward `source()` children get every object. Repeat the `data()` call in the child, or declare the names with [`# raven: var`](directives.md#declaration-directives).
- A script that runs in more than one `tar_source()` batch is still one file to navigation, missing-file checks, and rechecking. See [`targets::tar_source()` scripts](#targetstar_source-scripts).

## Details

<a id="advanced"></a>

### How Raven reads `source()` calls

Raven reads `source()` and `sys.source()` with single or double quotes, a named `file =` argument, and static `local` and `chdir` values (`TRUE`/`FALSE` and the unshadowed aliases `T`/`F`). The blocks below give the exact limits of each form.

<details markdown="1">
<summary><code>system.file()</code> paths</summary>

`source(system.file("helper.R", package = "pkg"))` is resolved statically. For the package being analyzed it maps to the source tree's `inst/` directory. For an installed package it is found under the library paths. Either way, the helper contributes its definitions like any other `source()` target.

Resolution follows package changes live. Installing or removing the referenced package mid-session, or renaming the workspace package in `DESCRIPTION`, re-resolves these links without editing the file or restarting.

</details>

<details markdown="1">
<summary>Computed paths that Raven folds</summary>

Paths built from statically known parts are folded to a plain path:

- `file.path("scripts", "helpers.R")`. Every part must fold. `fsep` is accepted only as the default `"/"`, and any other named argument stops folding.
- A `normalizePath(...)` wrapper, peeled off syntactically. `winslash` and `mustWork` are ignored.
- A local variable assigned exactly once at the top level before its use.

So the common testthat idiom resolves:

```r
repo_root <- normalizePath(file.path("..", ".."))
source(file.path(repo_root, "scripts/helpers.R"))
```

Folding is all-or-nothing. Raven skips the call rather than guess if any part isn't statically known: another function call, a variable that is reassigned, modified by a replacement function, removed, or assigned conditionally, a shadowed `file.path` or `normalizePath`, or a string literal containing escape sequences.

A `readLines(...)` call elsewhere in the file doesn't stop a variable from folding. Raven knows that `readLines(...)`, `base::readLines(...)`, and `base:::readLines(...)` don't change bindings, as long as their arguments contain no binding change Raven recognizes. A bare `readLines` gets that treatment only when Raven's bounded scan of the file finds no local definition of `readLines` and no dynamic binding operation it recognizes. Search-path attachment, sourced definitions, and opaque evaluation are outside that check, as for other bare helpers. Other calls are treated conservatively.

Folding is lexical. `setwd()` calls and the symlink resolution that runtime `normalizePath()` would do are ignored, the same limitation literal paths have.

Folded paths work everywhere a literal path does: dependencies, scope, missing-file diagnostics, and Cmd/Ctrl-click. A click on any string part of the expression, such as `"scripts/helpers.R"` in `file.path(repo_root, "scripts/helpers.R")`, opens the joined target. A click on a variable part such as `repo_root` still goes to that variable's assignment.

</details>

<details markdown="1">
<summary>Optional sources guarded by <code>file.exists()</code></summary>

`if (file.exists("scripts/config.R")) source("scripts/config.R")` reports no missing-file or case-mismatch diagnostic when the file is absent. When the file exists, it is an ordinary source dependency and contributes scope normally.

Recognition is narrow:

- `file.exists()` must receive one plain literal.
- The `source()` path must fold to exactly the same string.
- The `source()` must be the only consequence, written directly or alone inside braces.
- An `else` branch may provide a fallback, but a `source()` in the `else` branch isn't treated as guarded.

For a bare `file.exists`, Raven applies the same bounded check as for other bare base helpers: a definition or dynamic named assignment of `file.exists` in the same file rejects the pattern, while definitions that might come only from packages or sourced code are outside the check. Write `base::file.exists(...)` when your code deliberately masks the bare name. Dynamic paths and broader conditions are diagnosed like ordinary `source()` calls.

</details>

<details markdown="1">
<summary>Directory source loops with <code>list.files()</code></summary>

This pair of statements sources the `.R` files directly inside `functions/` as one ordered batch:

```r
files <- list.files("functions", pattern = "\\.R$", full.names = TRUE)
for (file in files) source(file)
```

The files share one source environment from first to last, and the finished batch lends its final scope to the code after the loop. Raven orders the files by platform-native lexical order (raw bytes on Unix). R's order can vary with `LC_COLLATE`, so if your definitions depend on locale-specific filename order, use explicit `source()` calls.

Raven requires all of these:

- The two statements are adjacent, executable, and at the top level.
- One literal directory, exactly `pattern = "\\.R$"`, and `full.names = TRUE`.
- A loop body that is only `source(iterator)`, written directly or alone inside braces.

`base::` and `base:::` qualification is accepted. The following fail closed, contributing nothing: extra arguments, other patterns (including regex equivalents such as `"\\.[Rr]$"` and `"[.]R$"`), dynamic paths, code between the two statements, shadowed helpers, nested or deferred loops, lowercase `.r` files, hidden entries, files in subdirectories, and paths outside the workspace. `lapply`, `sapply`, and `purrr::walk` idioms aren't supported.

Project-excluded files don't take part. If a matching entry is a directory, a directory entry or matching file can't be read, or there are more than 256 matches, Raven drops the whole batch rather than model a partial run. The reason goes to the log at debug level, and the editor shows no hint, because filesystem failures can be temporary. Missing and empty directories stay watched, so creating a file there later updates the analysis.

</details>

<details markdown="1">
<summary><code>local</code>, <code>chdir</code>, and <code>sys.source()</code></summary>

For `source()`, these mean global sourcing: an omitted `local`, `FALSE`, an unshadowed `F`, and the unshadowed `.GlobalEnv` and `globalenv()`. `TRUE` and an unshadowed `T` mean local sourcing.

A shadowed alias or environment name, or any other dynamic `local` value, is treated as an environment that doesn't inherit. The child then neither borrows the caller's ordinary bindings nor lends symbols back. The link is still kept for missing-file diagnostics, rechecking, and following the chain, and declarations such as `# raven: var` still reach the child.

For `chdir`, Raven recognizes `TRUE`/`FALSE` and unshadowed `T`/`F`. A shadowed or dynamic value isn't assumed to turn it on.

`sys.source()` defaults to an environment that doesn't inherit. Its child receives declarations but not the caller's ordinary bindings, and its symbols do **not** come back to the calling file unless `envir` is the unshadowed `globalenv()` or `.GlobalEnv`. Its `chdir` argument follows the same rules as `source()`.

</details>

<details markdown="1">
<summary><code>source(local = TRUE)</code> inheritance</summary>

`source("child.R", local = TRUE)` evaluates the child in the environment that calls `source()`. At the **top level** of a script that environment is the global environment, so the child sees every parent binding defined before the call, exactly as with the default `local = FALSE`, and Raven resolves those earlier definitions in the child.

Only when the `source(local = TRUE)` call sits **inside a function body** does the child bind to that function's frame instead of the globals. The child then doesn't inherit the parent's top-level symbols through the relationship, though declared symbols from `# raven: var` still flow. The child's own new definitions never leak back to the parent's global scope under `local = TRUE`.

This proven current-frame case is different from `local = some_environment`, `local = new.env()`, or another unknown expression, which don't inherit even at top level. The same rules apply inside evaluated capture code: `base::bquote(.(source("child.R", local = TRUE)), where = env)` doesn't inherit when `env` can't be proven to be the caller or global environment, while a proven `.GlobalEnv` `where` makes the call global.

</details>

### Shiny application loading

Raven recognizes Shiny's implicit application layouts without running R. Entry filenames match case-insensitively. A `server.R` selects the legacy layout, even when `app.R` also exists. `app.R` selects the single-file layout only when there is no `server.R`. Raven never combines the two layouts, and doesn't infer `shinyAppFile()` calls that name arbitrary files.

<details markdown="1">
<summary>How each layout loads, and which files take part</summary>

In a **single-file application**, Raven models Shiny's shared support environment: the `R/*.[Rr]` files directly in `R/` load in C-locale filename order, then `app.R` loads in a child environment. Earlier helpers are visible to later helpers immediately, while functions defined by an earlier helper look up names late, in the completed support environment. An adjacent `global.R` isn't loaded implicitly.

In a **legacy application**, `global.R` loads in the global environment, the `R/*.[Rr]` helpers load into one shared child support environment, and `ui.R` and `server.R` load into separate sibling environments. Both entries see global and support bindings, with helper bindings shadowing globals, but neither sees the other's own definitions. `global.R` can't see bindings that helpers create later, and Raven doesn't assume an order between `ui.R` and `server.R`.

Only direct children of the exact `R/` directory take part. Hidden files and nested files are skipped, and more than 256 matching helpers fails closed rather than modeling a partial batch. A direct `R/_disable_autoload.R` marker, matched case-insensitively, turns off the helper batch. It doesn't turn off legacy `global.R`, and it never makes `global.R` load in single-file mode. Raven doesn't execute R or guess the process-wide `options(shiny.autoload.r = ...)` setting.

Project exclusions apply before Raven picks a layout. An excluded `server.R` can't select legacy mode, and excluded entries, globals, helpers, or disable markers don't take part. Negated exclusion rules can re-include individual helpers. Conventional files that are inactive in the chosen layout, such as `global.R` beside `app.R`, `app.R` in legacy mode, or helpers turned off by the marker, keep ordinary standalone path and navigation behavior.

Global, helper, and entry files run with the application directory as their working directory. Relative `source()` calls in them resolve from the application root unless an explicit [`# raven: cd`](directives.md#working-directory-directives) applies, and `source(..., chdir = TRUE)` still switches a sourced child's base to that child's directory. Backward directives stay file-relative and ignore runtime working directories.

Entry files, the `R/` directory, helpers, `global.R`, and the disable marker are watched together. Creating, deleting, renaming, or changing the case of any of them refreshes the selected layout and scope, for open and closed files. Applications opened through a symlink still react to changes on the real path, without getting a second copy of the application's scope. If you open only a helper or a legacy `global.R`, Raven reads the selected `app.R` or `server.R` before publishing that file's first diagnostics.

The same model feeds diagnostics, completion, hover, navigation, references, and `raven check`. An unresolved name inside an application never falls through to a sibling entry's environment or to an unrelated application.

</details>

### Open buffers, disk state, and closing files

While a file is open, its buffer is the truth: unsaved edits that add or remove `source()` calls or directives update the dependency graph live, and disk changes to that file are ignored until you close it.

When you close a file without saving, Raven re-reads just that file from disk. A `source()` link added only in the discarded buffer disappears, and one the buffer had removed comes back. If the file no longer exists on disk, Raven drops it entirely. Open files that depend on it get refreshed diagnostics. Closing never triggers a workspace rescan, and reopening the file right away always wins over the disk re-read.

<details markdown="1">
<summary>Files opened through a different case or a symlink</summary>

If a buffer is opened under a case-only spelling difference (for example `child.R` for an on-disk `child.r`) or through a symlink that resolves to a workspace file, Raven treats the workspace file as open:

- Dependents recheck as you type, and cross-file scope reads the live buffer.
- Package-internal symbols, rechecking of sibling package files, your package's own NSE policy, and parameter and signature lookups use the workspace file.
- Raven skips file-watcher resyncs for the workspace spelling until you close the buffer.
- A workspace-root `.Rprofile` opened this way supplies the startup prelude while open, and scripts opened this way receive the prelude through their workspace path.

Diagnostics still publish to the spelling the editor opened. For closed files, Raven keys files by their raw path spelling rather than fully resolving symlinks, because full resolution follows symlinks and could disagree with the workspace index. Path resolution may still correct a case-only mismatch to the on-disk spelling so links line up with the workspace index. The dependency link always targets the real on-disk spelling.

</details>

<details markdown="1">
<summary>R Markdown and Quarto files after they close</summary>

For R Markdown or Quarto documents whose extension doesn't identify them as chunk documents, Raven remembers the editor's last R Markdown or Quarto language choice after the file closes. Disk changes and closed-file reads keep masking prose until Raven drops that file's cross-file state, so `source()` calls and directives written in prose don't start counting just because the document closed.

</details>

### Traversal budgets in large workspaces

Raven follows the `source()` graph under two budgets that bound the cost of very dense graphs:

- **`raven.crossFile.maxTransitiveDependentsVisited`** (default `50000`): the most files Raven visits while building one file's neighborhood.
- **`raven.crossFile.maxChainDepth`** (default `64`): the deepest chain Raven follows.

The defaults are sized so realistic workspaces never reach them, since a neighborhood can't be larger than the workspace. If a large, dense workspace does exhaust a budget, Raven stops following some `source()` links, and the symbols those files define can show up as **false `undefined-variable` warnings**. When that happens:

- The editor shows a throttled warning naming the setting to raise.
- `raven check` prints a one-line note: with the diagnostics on stdout for the default `text` output, or on stderr for `json` and `sarif` (see [Output streams](cli.md#output-streams)). This keeps budget-induced warnings distinguishable from real undefined variables in CI.

Raise the relevant setting in `raven.toml` to analyze more of the graph. See [Configuration](configuration.md).

### Implicit testthat/testit working directory

testthat's `test_dir()` and `test_local()`, and testit's `test_dir()`, run helper and test files with `tests/testthat/` (or `tests/testit/`) as the working directory. Raven mirrors this automatically: for a file anywhere under `<workspace root>/tests/testthat/` or `tests/testit/`, relative forward paths in `source()` calls and forward directives resolve from that directory. This depends only on the folder layout, not on a `DESCRIPTION` file or package mode.

It is a **soft default**, weaker than a `# raven: cd`:

- An explicit `# raven: cd`, or one inherited from a parent file, overrides it.
- It does **not** turn off the workspace-root fallback, and it never carries into files the test file sources. A sourced `scripts/helpers.R` still resolves its own `source()` calls from its own directory, with the fallback.
- For a file **nested below** the test directory (such as `tests/testthat/fixtures/helper.R`), Raven also tries the file's own directory when the test-directory path misses, so file-relative paths that worked before keep working.
- Backward directives are unaffected: they always resolve from the file's own directory.

Path completion inside a `source()` string or forward directive in these files offers entries from the test directory. For a nested file it also offers entries from the file's own directory, matching the fallback above. A name present in both appears once, and the test-directory entry wins, as in resolution. An explicit or inherited `# raven: cd` turns off both implicit bases, and completion uses only that working directory.

### Case-only mismatches

For a path in a `source()` call or directive, an **exact-case match always wins**. If the path differs from the real on-disk filename **only by case**, as in `source("scripts/templates.r")` for an on-disk `templates.R`, Raven resolves it to the real file anyway, provided exactly one file matches case-insensitively. The file joins the dependency graph and its symbols stay visible, consistently across dependencies, scope, diagnostics, Cmd/Ctrl-click, and path completion.

Raven reports the mismatch once, at the path's line, as [`source-path-case-mismatch`](diagnostics.md#source-path-case-mismatch): information on a case-insensitive filesystem (typical on macOS and Windows), warning on a case-sensitive one (typical on Linux), where R itself wouldn't find the file. Resolving it anyway keeps one clear warning from turning into many false `undefined-variable` warnings. If two on-disk files match case-insensitively, which can only happen on a case-sensitive filesystem, the path is ambiguous and stays unresolved (`unresolved-source-path`). Matching is ASCII-only.

<details markdown="1">
<summary>Backward directives and buffers opened under another case</summary>

The leniency applies in **both directions**: to `source()` calls and forward directives (`# raven: source`, `run`, `include`), **and** to backward directives (`# raven: sourced-by`, `run-by`, `included-by`). A wrong-cased `# raven: sourced-by parent.r` still resolves to an on-disk `Parent.R` on a case-sensitive filesystem such as Linux CI, so the child keeps the parent's scope instead of producing a cascade of false `undefined-variable` warnings.

The backward diagnostic has a different message. R never runs a backward directive, since it's a Raven-only comment, so the message doesn't claim R would fail. It asks you to fix the directive's casing to match the file on disk.

The workspace-root fallback is separate from this leniency and stays forward-only: backward directives get the case leniency but never the fallback.

If the buffer itself is open under a different case spelling than the file on disk, Raven connects that buffer to the on-disk file for live rechecking and content. The dependency link still targets the real on-disk spelling, and diagnostics for the open buffer still publish to the spelling the editor opened.

</details>

### How NSE declarations propagate

<details markdown="1">
<summary>Path rules, which files share declarations, and precedence</summary>

Propagation uses the same dependency graph and path rules (`# raven: cd`, workspace-root fallback, `maxChainDepth`) as scope and package loading. Backward directives take part as ordinary links but gain no extra path fallback.

A file shares declarations with its ancestors (the files that source it, directly or indirectly), and with everything those ancestors or the file itself source, directly or indirectly. Editing a `# raven: nse`, or a `# raven: func` whose formals feed positional matching in another file, in any connected file rechecks the files that rely on it.

Propagation is deliberately **coarse and file-level**. A propagated declaration ignores its original line and governs the whole connected file. Raven consults it after its precise built-in NSE policy tables, so it can't loosen a function Raven already models. See [`# raven: nse` propagates across the source graph](directives.md#-raven-nse-propagates-across-the-source-graph) for precedence against local definitions and own-file declarations.

</details>

### When Raven calls R

Raven's analysis is static: it parses your code and your installed packages' `NAMESPACE` files without a running R session. It does start a short-lived, non-interactive R process, the `R` on your `PATH` or [`raven.packages.rPath`](configuration.md#package-settings), in two situations. These are Raven's own processes, never your interactive R session, and when no R is found Raven falls back gracefully.

1. **To find where your packages are installed.** Raven runs `.libPaths()` to find your library directories. Where packages live depends on your R installation, version, and project setup, including [`renv`](https://rstudio.github.io/renv/) project libraries, which Raven activates before reading the paths. Without R, Raven falls back to the standard platform locations plus any [`raven.packages.additionalLibraryPaths`](configuration.md#package-settings), which may miss user or project libraries.
2. **To expand exports that `NAMESPACE` text can't list.** Most packages list exports with explicit `export(name)` lines, which Raven reads directly. A package can instead, or also, declare `exportPattern("<regex>")`: "export every object whose name matches". Raven can't expand that from the file alone, so it asks R with `getNamespaceExports()`. Several base R packages use `exportPattern`, as do a minority of CRAN packages. Without R, Raven approximates their exports from the package's `INDEX` file plus any explicit `export()` lines, which covers documented functions but may miss pattern-only or generated symbols.

Run **Raven: Refresh package cache** after changing `.libPaths()` or running `renv::activate()` to re-run these queries.

### Resolving exports without R

When a package isn't in any local library, typically in CI where `.libPaths()` is empty, Raven still resolves its **export names** from an ordered list of sources, per package. What triggers this is a **missing package directory**, not a missing R. A package that *is* installed still resolves from its installed copy even with no R, and only its `exportPattern` exports fall back to the `INDEX` approximation.

1. **Installed packages.** Parse the installed `NAMESPACE`, expanding `exportPattern` through R when possible and approximating from `INDEX` when not. Exact for the installed version.
2. **The repo database.** A committed, project-specific `.raven/packages.json` that you generate with [`raven packages freeze`](cli.md#raven-packages-freeze). It's a frozen copy of step 1: exports, `Depends`, and datasets, exact for the versions installed when you generated it.
3. **The `names.db` database.** Raven's package database, built append-only from a reference R installation plus CRAN and Bioconductor (through [r-universe](https://r-universe.dev)), keeping the **highest version** of each package. It isn't bundled with the binary; install it with `raven packages update` for broad CRAN and Bioconductor coverage. It has exports, `Depends`, and dataset names.

The repo database outranks `names.db` because it's specific to your project. A repo without one still works in CI through `names.db` alone, when that database is present. Both databases carry **export names, `Depends`, and datasets only**: no `:::` internals and no function signatures, which still need a local install.

This fallback affects **export resolution** only. It never changes whether a package counts as installed (see [Package names vs. install status](diagnostics.md#package-names-vs-install-status)). The full model, its accuracy caveats, and how to generate the repo database are in [Package database](package-database.md).

### Base packages

Base R packages are always available without a `library()` call: **base**, **methods**, **utils**, **grDevices**, **graphics**, **stats**, **datasets**. Raven uses this fixed list rather than asking R which base packages exist. It asks R for your *installed* packages, through the library paths. Base-package *exports* are still expanded through R, since they use `exportPattern` (see [When Raven calls R](#when-raven-calls-r)).

Lazy-loaded datasets are a related special case. Packages expose data objects, such as `mtcars` and `iris` from base `datasets`, `flights` from **nycflights13**, or `diamonds` from **ggplot2**, that appear neither in `NAMESPACE` `export()` lines nor in `getNamespaceExports()`. Base-package datasets are always available. A non-base package's datasets become available after its `library()` call, like its function exports, and resolve through `Depends` and meta-packages (`library(tidyverse); diamonds`).

<details markdown="1">
<summary>How Raven finds dataset names</summary>

How Raven discovers datasets depends on whether the package uses R's LazyData mechanism:

- **LazyData packages** (whose `DESCRIPTION` sets `LazyData: true`, recognizable by a `data/Rdata.rdb` file) build one binary database of all data objects. Their `data/` file names don't reliably list object names: **survival** ships `lung` with no `data/lung.rda` file. So Raven asks R with `data(package = "pkg")$results` for the full set. Without R it falls back to the file names, with lower accuracy.
- **Packages without LazyData** store datasets as individual `.rda`/`.RData` files in `data/`. Raven reads those file names and the `INDEX` file directly, with no R process.

</details>

<details markdown="1">
<summary>How <code>data()</code> calls bind names</summary>

A `data()` call binds a dataset's objects from the call onward, as in R. `data(api, package = "survey")` puts every object the package's `api` data file defines (`apiclus1`, `apistrat`, and so on) in scope, even when one data file ships several differently named objects.

Because R loads those objects into the calling environment, a `data()` call overwrites earlier bindings of the same names there, and later assignments can overwrite the data objects again.

The bare form `data(api)`, with no `package =`, searches the packages attached at or before the call and then the default base packages, binding the objects from the first package that provides the dataset. This mirrors R, where the first search-path match wins and attached packages come before base packages. Raven doesn't track attachment order, so when several attached packages provide the same dataset, it picks the alphabetically first.

The literal argument (`api`) is always bound too, so behavior degrades gracefully without R. Resolving the *object* names beyond the file name needs a listing of the package's `data/` directory, captured when the package is loaded; `raven check` loads the packages named in `data(package = …)` for this.

A package's internal `sysdata.rda` objects, such as `cli`'s internal `emojis` table, are never exposed this way. `library(cli)` followed by `emojis` is a real R error, and Raven flags it.

</details>

### `pacman::p_load()`

<details markdown="1">
<summary>Which <code>p_load()</code> calls attach packages</summary>

A qualified `pacman::p_load()` is always recognized. A bare `p_load()` is recognized only when `pacman` is already attached on the resolved search path and no local binding shadows `p_load`. That includes `pacman` inherited through an explicit `source()` relationship. Calling `loadNamespace("pacman")` alone doesn't enable the bare form.

Quoted and unquoted package arguments work, as does an exact static `char = c("pkg1", "pkg2")`, or a same-file static character vector assigned once. `char` follows pacman's runtime rules and replaces the ordinary `...` arguments. Dynamic, malformed, and `character.only = TRUE` forms are left unresolved rather than evaluated.

Raven doesn't install or update packages, and doesn't treat `p_load_gh()` as attaching a package.

</details>

<a id="devtoolsload_all--virtual-attached-package"></a>
### `devtools::load_all()` as an attached package

`devtools::load_all()`, `pkgload::load_all()`, and a bare `load_all()` are modeled as attaching the package under development. From the call onward, Raven makes the package's internal symbols available, as `library()` does for an installed package's exports: exported and internal `R/` definitions, `R/sysdata.rda` objects, names bound in `.onLoad`/`.onAttach`, and `NAMESPACE` imports.

They propagate like `library()`:

- **Position-aware**: symbols appear only after the `load_all()` call.
- **Forward only**: a `source()` child whose parent calls `load_all()` inherits the internals. A parent doesn't pick them up from a child's `load_all()`.
- **Through chains**: they pass through any number of `source()` hops.
- **From any parent**: when a file has several parents and at least one calls `load_all()`, the child gets the internals.

A workspace-root `.Rprofile` that calls `load_all()` gives the package internals to ordinary scripts. In package mode, `R/` source files, package tests, and built-documentation directories don't get them through `.Rprofile`, since package mode already provides them. See [.Rprofile startup files](rprofile.md).

A file **outside the package workspace root** that calls `load_all()` does not get the package internals, so unrelated scratch files keep their real diagnostics.

Unlike `library(yourpkg)`, `load_all()` exposes internals even when they aren't exported, matching `load_all()`'s own `export_all = TRUE` default. See [Package development](r-package-dev.md#scripts-that-call-devtoolsload_all).

### Availability vs. ownership

A symbol made visible through a meta-package, an attached package, or a `Depends` chain has two package answers, which Raven keeps apart:

- **Availability**: *which loaded package made this visible?* This is what stops undefined-variable warnings. `library(tidyverse)` makes `mutate` available because Raven combines the exports of the packages tidyverse attaches.
- **Ownership**: *which package actually provides the symbol?* This package supplies hover help, the help panel, signature help, completion detail, and the NSE policy for data-masking arguments. For `mutate` under `library(tidyverse)`, the owner is dplyr.

This matters because `help("mutate", package = "tidyverse")` is empty: only dplyr owns the topic. So `library(tidyverse); mutate(...)` stays *available* through tidyverse but gets hover, help, signatures, completion detail, and NSE policy from dplyr. A direct `library(dplyr)` and an explicit `dplyr::mutate(...)` resolve to dplyr as before. A package's own exports are always owned by that package, even when it's the meta-package. When Raven can't find the owning package, the usual not-found behavior applies.

### Apply-family loads

Raven recognizes package loads written as apply-family calls when every package name is known statically:

```r
libs <- c("dplyr", "tidyr")
sapply(libs, require, character.only = TRUE)
```

This works for `sapply`, `lapply`, `vapply`, `mapply`, and the purrr forms (`map`, `walk`, `map_chr`, and so on, bare or `purrr::`-qualified). `character.only = TRUE` must be present; without it, R itself wouldn't load the strings as packages.

<details markdown="1">
<summary>Which package vectors count</summary>

The package vector must be one of:

- An inline, non-empty `c("a", "b", ...)` of string literals. Literal `NULL` entries are allowed and dropped, as base `c()` does.
- A same-file variable assigned exactly once at the top level to such a vector, with `<-`, `=`, or an eligible bare or `base::`-qualified `assign()`.

For `assign()`, Raven accepts only destinations proven to create the file's top-level binding:

- the default current frame when the call is at top level (`pos` and `envir` omitted);
- `pos = 1` or `1L` with `envir` omitted;
- `envir = .GlobalEnv`, `globalenv()`, or `base::globalenv()` with `pos` omitted. Bare `.GlobalEnv` and `globalenv()` must be unshadowed.

In each form, `inherits` must be omitted, missing, or literal `FALSE`, which is equivalent to omitting it here. Supplying both `pos` and `envir`, a dynamic or non-global destination, any other `inherits` value, or a nested call means the call can't supply the vector. Conditional, reassigned, or removed bindings likewise make the variable unusable.

Empty vectors (`c()`, `character(0)`), dynamic constructions such as `paste0(...)`, `tolower(x)`, or `c(libs1, libs2)`, function parameters, and values defined in another file are ignored silently.

</details>

### Deterministic package-loader loops

Raven recognizes the explicit-loop equivalent when the package vector meets the same rules as [apply-family loads](#apply-family-loads):

```r
packages <- c("dplyr", "ggplot2", NULL)
for (package in packages) {
  if (!requireNamespace(package, quietly = TRUE)) install.packages(package)
  library(package, character.only = TRUE)
}
source("analysis.R")
```

<details markdown="1">
<summary>What the loop must look like</summary>

The `library()` or `require()` call must be an unconditional top-level statement in the loop body, must load the loop variable, and must set `character.only = TRUE`. Raven records the packages as attached only after the loop finishes, so they reach later sourced files without appearing inside the loop itself.

Raven ignores dynamic vectors, vectors reassigned before the loop, conditional loaders, a different package expression, writes to or removal of the loop variable before the loader, locally shadowed `library` or `require`, and loops that may `break` or `return()` before loading every package. A named vector is resolved only for a loop known to run eagerly in the file. A loop inside a function body, which runs later, can still use an inline `c("a", "b")` sequence.

</details>

### `targets::tar_option_set()` worker packages

Raven treats a [{targets}](https://docs.ropensci.org/targets/) `tar_option_set(packages = ...)` declaration as packages for the whole pipeline, not as a `library()` call at one position. The packages are available throughout the declaring pipeline and in every member of each `tar_source()` batch, whether the declaration comes before or after the batch:

```r
# _targets.R
library(targets)
tar_source("R")
tar_option_set(packages = c("dplyr", "tidyr"))

# dplyr and tidyr resolve throughout _targets.R and in every tar_source() member.
```

This applies only to targets execution. It doesn't reach an ordinary `source()` child or a `source(list.files(...))` batch. Real `library()`, `require()`, and `loadNamespace()` calls stay position-sensitive and propagate normally.

<details markdown="1">
<summary>Exact rules for <code>tar_option_set()</code></summary>

- **Bare vs. qualified.** `targets::tar_option_set(...)` and `targets:::tar_option_set(...)` are always recognized, even when a local binding named `tar_option_set` exists. The bare `tar_option_set(...)` is recognized only when the same file also attaches targets with `library(targets)` or `require(targets)`, anywhere in the file, and the bare name isn't locally shadowed.
- **Named `packages =` only.** `tar_option_set`'s first formal is `tidy_eval`, not `packages`, so positional forms like `tar_option_set(TRUE, c("dplyr"))` aren't matched.
- **Accepted values.** A single string literal (`packages = "dplyr"`), an inline non-empty `c("a", "b", ...)` of string literals, or a same-file variable assigned exactly once at the top level to such a vector. That includes an eligible bare or `base::`-qualified `assign()`, with the same global-destination rules as [apply-family loads](#apply-family-loads). Nested, conditional, dynamic, non-global, reassigned, or removed bindings, `character(0)`, and empty `c()` are ignored. Raven never runs R to resolve a dynamic value.
- **Per-package location.** `tar_option_set()` calls often span many lines, so each package's missing-package diagnostic sits on that package's own string literal, and a `# nolint` on that line suppresses it. When the packages come from a variable, the diagnostic sits at the end of the call.
- **Union across calls.** Several `tar_option_set()` calls in one file combine their `packages =` vectors. At runtime in targets the last call wins, but Raven deliberately prefers missing a problem to reporting a false one here.

</details>

### `targets::tar_source()` scripts

Raven expands static `targets::tar_source()` calls and adds their `.R`/`.r` scripts to the same dependency and scope model as `source()`. The scripts run as one ordered batch. Each one sees `_targets.R` as it was before the call, plus the definitions, removals, and package attachments from earlier scripts. A later script replaces an earlier binding of the same name, and no script sees a later one.

<details markdown="1">
<summary>Which calls and files count, and in what order</summary>

`targets::` and `targets:::` spellings are always recognized. A bare `tar_source()` needs an unshadowed top-level attachment of targets. `files =` may be a string, a non-empty literal character vector, or a top-level variable assigned once to one of those.

Directories are walked recursively in a fixed path order. Hidden entries are skipped unless the hidden path itself was named. Order compares the relative paths' platform bytes or code units, which approximates `sort(..., method = "radix")` under `LC_COLLATE=C`. Locale-specific collation and mixed-case or non-ASCII names can therefore run in a different order in R; use consistently cased ASCII names when sibling order matters. Project-excluded scripts don't take part.

`change_directory = TRUE` is honored, including for ordinary `source()` calls inside a member. The file-level `tar_option_set(packages = ...)` set applies to every member, including the first, while package loads inside members flow through the ordered batch as usual.

Only calls Raven can determine statically take part. Dynamic `files =` expressions, computed `change_directory` values, and calls inside functions or quoted expressions are ignored.

</details>

<details markdown="1">
<summary>Live updates in the editor</summary>

Creating, deleting, or renaming a script in a `tar_source()` path updates the batch and the affected diagnostics without editing `_targets.R`. Missing paths, case-corrected paths, and symlink targets stay watched when the editor's workspace watcher covers them. Paths outside that coverage, including external symlink targets, refresh on the next workspace refresh or reopen and on every `raven check` run. A missing literal path can become active after a workspace change, but a missing path outside the workspace can't be watched reliably.

</details>

<details markdown="1">
<summary>Scripts that run in more than one batch</summary>

When the same script runs in several batches with different working directories, scope follows each run, so its nested `source()` calls can contribute different symbols in each.

Navigation, missing-file checks, and rechecking after an edit don't follow each run separately. They treat each script as one file with one target per `source()` call, so a nested call whose target differs between runs uses a single target. The same holds for a nested `tar_source()` batch inside one script, which is expanded once for that file, and for forward directives that depend on the working directory and propagated `# raven: nse` / `# raven: func` declarations.

When separate runs need distinct nested batches, directives, NSE contracts, navigation, or rechecking, give each run its own small wrapper or loader script.

</details>

### tarchetypes target factories and report documents

Raven extends the same static `{targets}` model to common [`{tarchetypes}`](https://docs.ropensci.org/tarchetypes/) archetypes. Target names are a separate namespace from R variables: a declaration can satisfy `tar_read()` or `tar_load()` without making the name an R binding, and a report never receives the pipeline's ordinary variables, packages, or `# raven: nse` / `# raven: func` declarations.

`targets::`/`targets:::` and `tarchetypes::`/`tarchetypes:::` calls are recognized without an attachment. A bare call needs the package attached by a top-level `library()` or `require()`, and no local binding may shadow the function, so your own functions with the same names keep ordinary R behavior. Aliases and programmatic calls aren't followed.

#### Static target declarations

Raven records target names from `targets::tar_target()` and these tarchetypes factories:

- Storage and file factories: `tar_url()`, `tar_file()`, `tar_file_fast()`, `tar_rds()`, `tar_qs()`, `tar_keras()`, `tar_torch()`, `tar_arrow_feather()`, `tar_parquet()`, `tar_fst()` and its data-frame, data-table, and tibble variants, `tar_nanoparquet()`, and the superseded `tar_aws_*()` variants.
- Control and group factories: `tar_file_read()` (the requested name plus its `_file` helper), `tar_change()` and `tar_force()` (the requested name plus their `_change` helper), `tar_skip()`, `tar_group_by()`, `tar_group_select()`, `tar_group_count()`, `tar_group_size()`, and `tar_combine()`.
- Document factories: `tar_render()`, `tar_knit()`, and `tar_quarto()`.

`tar_plan()` declares a target for each exactly named argument:

```r
tarchetypes::tar_plan(
  prepared = clean(raw_data),
  tarchetypes::tar_render(report, "report.Rmd")
)
```

The named command is delayed code. Unnamed factory calls inside are analyzed on their own, so their own target and path rules still apply. Partial argument matching, missing values, computed names, and calls inside functions or quoted code fail closed.

#### Static `tar_map()` names

`tar_map()` generates a set of targets per row of a value table. Raven predicts the generated names when the table and selection are **literal**: a literal `list()`, `data.frame()`, or `tibble()` with named scalar or literal-vector columns, a static column selection, and a literal delimiter. It reproduces tarchetypes' own name mangling. A reference to a generated name navigates to the base target, since the generated spelling never appears in your code.

Expansion is all-or-nothing: if any generated name can't be reproduced statically, Raven expands none of them, and the unsuffixed targets passed through `...` aren't pipeline targets themselves. Dynamic tables, selections, or delimiters, and the runtime-hash fallback for an empty selection, are left unexpanded. The exact grammar and edge cases are in [Limitations: targets and tarchetypes](limitations.md#targets-and-tarchetypes).

#### Connected R Markdown and Quarto documents

A document factory links to its document when both the target name and the path are static and the path names a document Raven can analyze:

- `tar_render()` and `tar_knit()`: `.Rmd` or `.Rmarkdown`.
- Single-document `tar_quarto()`: `.qmd`, `.Rmd`, or `.Rmarkdown`.

Paths follow the ordinary forward rules: an explicit or inherited `# raven: cd` applies, and otherwise the workspace-root fallback may apply. Cmd/Ctrl-click on the path opens an existing document. A missing document reports `unresolved-source-path` at the configured missing-file severity and stays watched, so creating or deleting it refreshes the link. Quarto project directories and computed paths aren't inferred.

Inside the connected document's R chunks, `targets::tar_read(name)` and the plain names in `targets::tar_load(name)` or `targets::tar_load(c(name1, name2))` resolve against the pipeline's static target declarations. Target constructors written inside a report chunk don't declare pipeline targets or create nested report links. Bare calls follow the same attachment and shadowing rule. A missing name uses the `undefined-variable` severity and suppression controls, with a target-specific message, and Cmd/Ctrl-click goes to the declaration. Dynamic tidyselect expressions such as `tar_load(starts_with(prefix))` are left unresolved.

<details markdown="1">
<summary>How reports and pipelines recheck each other</summary>

The report link is watched and rechecked in both directions, but it never lends ordinary R scope. Only the pipeline and the files it sources in the ordinary way can declare targets; a helper sourced only while the report renders can't.

Editing a pipeline declaration rechecks connected reports. Editing a target reference in a report rechecks the declaring pipeline and the other files that declare its targets. Case and symlink spellings of the same file count as one file, and navigation opens the spelling you already have open.

</details>

### `$` and `@` member resolution

When you Cmd/Ctrl-click `foo$bar` (or `foo@slot` for S4 objects), Raven resolves the member against `foo`, not as a free variable. It looks for:

- Member assignments: `foo$bar <- …`, `foo["bar"] <- …`, or `foo[["bar"]] <- …` (the string-subscript forms apply to `$` only), and `foo@slot <- …` for S4 slots.
- Named arguments in constructors such as `list()`, `c()`, `data.frame()`, `tibble()`, `data.table()`, `environment()`, `list2env()`, and `new()`.

Completions after `$` use the same rules: typing `foo$` offers the known members of `foo`.

## See also

- [Directives](directives.md): every `# raven:` comment, including `source`, `sourced-by`, and `cd`
- [Diagnostics](diagnostics.md): the codes cross-file analysis reports
- [Package development](r-package-dev.md): how package mode changes visibility
- [Performance on large projects](cross-file-analysis-performance.md): when to mark a file self-contained
