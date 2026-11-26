# Non-standard evaluation

[Docs](README.md) › Analysis

Raven knows which arguments of `with()`, dplyr verbs, ggplot2's `aes()`, and other non-standard evaluation (NSE) functions name data columns rather than variables, so it doesn't flag them, while it keeps checking the rest of the call.

<!-- example: nse-data-mask file=analysis.R -->
```r
cars <- data.frame(mpg = c(21, 33), cyl = c(6, 4))
ratio <- with(cars, mpg / cyl)
label <- paste(missing_label, ratio)
```

<!-- example: nse-data-mask -->
```console
$ raven check .
analysis.R:3:16 warning: missing_label is not defined [undefined-variable]
1 issues (0 errors, 1 warnings, 0 infos, 0 hints, 0 notes)
```

`with()` evaluates `mpg / cyl` inside `cars`, so `mpg` and `cyl` are columns, not missing variables. `paste()` evaluates its arguments normally, so the misspelled `missing_label` is reported.

R uses NSE when a function treats an argument as unevaluated code, evaluates it in a data mask, or captures it for later. A bare name inside such a call isn't always an ordinary variable reference:

```r
library(dplyr)

filter(mtcars, cyl > 4)
# `cyl` is a column in the data mask, so Raven does not flag it.
# `mtcars` is still an ordinary argument and is still checked.
```

```r
library(ggplot2)

ggplot(mtcars, aes(cyl, mpg)) +
  geom_point()
# `aes()` captures mappings, so `cyl` and `mpg` are not treated as missing
# variables in the surrounding script.
```

```r
select(mtcars, starts_with("c"), mpg)
# Tidyselect arguments name columns, not variables in the current R scope.
```

## What Raven checks

Raven doesn't silence a whole call because the function uses NSE. It works out which function is called, within the [limits below](#limitations), and applies an argument policy:

- Standard-evaluation arguments are checked normally.
- Captured, data-masked, and tidy-selected arguments are not.
- A local function with the same name as a package function wins, as it does in R, and Raven uses the local function's policy.

For example, `dplyr::filter(missing_df, cyl > 4)` skips `cyl` as a column reference but still checks the data argument `missing_df`. A standard-evaluation call such as `paste(missing_value)` is checked as usual.

For Shiny and `foreach()`, Raven models the names those constructs provide instead of suppressing everything inside them. Shiny's deferred expressions keep outer bindings visible while Raven checks the real references inside. `foreach()` iterators are available inside the loop body, while the iterator value expressions and control arguments are still checked.

## How Raven recognizes NSE

Raven combines several sources:

- Built-in policies for common R functions and package families, such as tidyverse, ggplot2, Shiny, foreach, targets, recipes, and table-building packages.
- Which package a function comes from, through `library()`, `pkg::fn`, imports, and meta-packages, so `library(tidyverse); mutate(...)` uses dplyr's policy.
- Local function definitions it can see. If a helper captures a formal with `substitute()`, `enquo()`, `enexpr()`, `ensym()`, or a recognized tidy-eval forwarding pattern, Raven infers the helper's policy.
- Cross-file scope. The `source()` graph that drives diagnostics, completions, and navigation also carries NSE declarations.

## When Raven needs a hint

Raven can't infer every package-specific or external NSE helper. If a function captures arguments and Raven doesn't know its policy, declare it with `# raven: nse`:

```r
# raven: func summarize_by(data, group, value)
# raven: nse summarize_by(group, value)

summarize_by(mtcars, cyl, mpg)
# `cyl` and `mpg` are captured; `mtcars` is still checked.
```

The `# raven: func` line records the formal order for positional calls. When the arguments are named, Raven matches them by name:

```r
# raven: nse summarize_by(group, value)

summarize_by(data = mtcars, group = cyl, value = mpg)
```

Use `...` when a helper captures arguments passed through its dots:

```r
# raven: nse select_like(...)

select_like(mtcars, cyl, mpg)
```

In the file where it appears, `# raven: nse` applies to calls after the directive line, and the most recent declaration wins. Across files connected by `source()`, it applies as a coarse, whole-file fact, so you can declare a helper's policy once in a setup file and use the helper anywhere connected. See [NSE declarations](directives.md#nse-declarations) for the full syntax and [NSE directive propagation](cross-file.md#nse-directive-propagation) for the cross-file rules.

## Choosing the right escape hatch

| The false positive comes from | Use | What Raven keeps checking |
|---|---|---|
| A function argument that is captured, data-masked, or tidy-selected | `# raven: nse` | The function's other arguments |
| A name created where Raven can't see it: `eval()`, a dynamic `assign()`, a runtime setup step, or external data | [`# raven: var`](directives.md#variable-declarations) | Everything else |
| Code too dynamic to model, or a one-off | [`# raven: ignore`](diagnostics.md#per-line--raven-ignore) or `# raven: ignore-next` | Everything off that line |

If a workspace is so dynamic that targeted escape hatches are too noisy, you can turn off undefined-variable checking inside call arguments with `raven.diagnostics.undefinedVariableInCallArguments`, or inside `[` and `[[` indices with `raven.diagnostics.undefinedVariableInBracketIndices`. These are broad: they cut false positives by giving up real undefined-variable checks in those positions.

## Declaring NSE from a package

`# raven: nse` describes a helper from the *calling* side, which suits a helper defined in your own project. A package author can instead ship the policy with the package, so every user gets it without writing directives.

Put the declarations in `inst/raven/nse.toml`. `R CMD INSTALL` copies `inst/` into the package root, so Raven reads the installed file at `<libpath>/<pkg>/raven/nse.toml`, next to `NAMESPACE`.

```toml
schema = 1

[[function]]
name = "gen"
formals = ["data", "variable", "values", "where"]
captured = ["variable", "values", "where"]
```

With that installed, `gen(survey, adjusted, income + 5)` skips `adjusted` and `income` and still checks `survey`.

Each `[[function]]` entry takes:

| Key | Meaning |
| --- | --- |
| `name` | The exported function. A name the package doesn't export is ignored. An infix operator (`"%where%"`, `":="`) counts: its entry applies to `a %where% b` as it does to `` `%where%`(a, b) ``, with `a` as the first argument and `b` as the second. |
| `policy` | `"per-formal"` (the default), `"whole-call"`, or `"named-arguments"`: the three policy kinds Raven's built-in table uses. |
| `formals` | The function's formal arguments **in declaration order**. Raven matches positional arguments against this list, so a stale order shifts which argument is skipped. |
| `captured` | The formals whose argument is captured, data-masked, or tidy-selected. Every name must appear in `formals`. |
| `captured_dots` | `true` when arguments absorbed by `...` are captured too. |

`formals` and `captured` apply to `policy = "per-formal"` only; the other two kinds need just a `name`.

Three rules keep a declaration file from making diagnostics worse:

- **Built-ins win.** Raven consults a declaration only after its own table misses, so an installed package can't silence a diagnostic Raven models itself.
- **Exports only.** Declarations are intersected with the package's export set, so an entry for an internal helper is dropped rather than applied to an unrelated call.
- **Failure is silent and safe.** A missing, malformed, or newer-schema file yields no policies: you get the false positives you had before, never fewer checks.

A declaration takes effect once the package is installed and Raven has loaded it, because Raven reads the file from the installed package. A binding such as `gen <- dtatools::gen` is the exception. The editor loads a package the file names with `::`. `raven check` doesn't, so for calls of that `gen` it reads dtatools's declaration from the installed package even when nothing attaches dtatools. Policies aren't yet stored in `.raven/packages.json`, so a CI run that relies on [`raven packages freeze`](package-database.md) instead of an installed library doesn't see them.

<details markdown="1">
<summary>Which package's declaration applies to a call</summary>

A bare call such as `gen(...)` or `a %where% b` names a function, not a package. Raven applies a package's declaration when the code around the call brings that package in: a `library()`, `require()`, or `loadNamespace()` call, a `NAMESPACE` `import()` or `importFrom()` or a `DESCRIPTION` `Depends:` entry in the package you're developing, or a binding such as `gen <- dtatools::gen`. It doesn't work out which function R finds first. In three cases that can hide an error R raises at the call:

- **A later package masks the declaring one.** After `library(dtatools)` and then `library(other)`, where both export `gen`, R calls `other::gen`. If that function evaluates an argument that dtatools's `gen` captures, R stops on an undefined name there. Raven still applies dtatools's declaration and skips the argument. R's choice depends on which package was attached first, on `library()` arguments such as `exclude`, and on packages attached by code Raven doesn't read.
- **The package is loaded but not attached.** After `loadNamespace("dtatools")` alone, R can't find `gen` and stops. Raven counts a loaded package's exports as available, so it reports neither `gen` nor the arguments its declaration covers. That reads a script correctly when it attaches the namespace somewhere Raven can't follow, such as `attachNamespace()` or a helper function.
- **The file rebinds the name further down.** When `gen <- dtatools::gen` is the file's last top-level binding of `gen`, and Raven has loaded dtatools (a `library(dtatools)` in another checked file is enough), Raven applies dtatools's declaration to the `gen(...)` calls above that line too. A call there that reaches a different `gen` can stop on an argument Raven skips. Some calls written above the binding do run after it, from a function body or a loop. When `raven check` hasn't loaded dtatools, it reads the declaration for the binding alone and applies it more narrowly: only to calls written below a binding that the file makes unconditionally, at top level, and only when the rest of the file does nothing with `gen` but call it. It doesn't read the declaration at all when dtatools's `NAMESPACE` has an `if` or a pattern export, because only R can say what such a file exports.

When two of the packages Raven counts as brought in at a bare call both declare the name, and no definition the call reaches (in the file, an enclosing function, or a sourced file) binds the name, Raven picks one of the two declarations by its own order, not by the order R attached the packages. Often that is the package whose name sorts first. So Raven can apply a different package's declaration than the one R calls: after `library(dtatools)` and then `library(other)`, where both export and declare `gen`, R calls `other::gen` and Raven reads dtatools's declaration. Depending on which arguments each declaration captures, Raven can report a name R never evaluates, or skip one R stops on. The call alone can't settle it: two packages can ship the same declaration for an argument that one never evaluates and the other evaluates among a data frame's columns, where a misspelled column stops R.

When the package R calls declares nothing, you can have the arguments checked by naming the function at the call: `other::gen(...)`, or for an operator `` other::`%where%`(a, b) ``. To keep the infix form, bind the operator at top level above the calls with `` `%where%` <- other::`%where%` ``, and don't bind it again at top level further down. When both packages declare the name, the same two forms choose which package's declaration Raven applies, and the arguments that declaration captures stay unchecked.

</details>

### Declaring data.table-style `[` semantics

Raven treats `[` on a data.table specially: `d[, mean(x), by = grp]` quotes `x` and `grp`, so they aren't undefined variables (see [`undefined-variable`](diagnostics.md#undefined-variables)). A package whose own container uses that bracket notation can declare it with an optional `[subset]` table in the same file:

```toml
schema = 1

# `[` on this package's objects is data-masking, like data.table's.
[subset]
constructors = ["dibble", "as_dibble", "read_dta", "read_arrow"]
converters = ["set_dibble"]
```

The table's presence is the declaration. While the package is in play, `[` indices on an object Raven can't classify are skipped, exactly as when data.table is in play. "In play" uses the same rule as for data.table: a `library()`, `require()`, or `loadNamespace()` call, a DESCRIPTION `Imports:` or `importFrom`, a `pkg::` reference anywhere in the file, and the other sources listed under [call arguments and bracket indices](diagnostics.md#call-arguments-and-bracket-indices).

The two optional lists refine this for objects Raven can trace to a definition:

| Key | Meaning |
| --- | --- |
| `constructors` | Exported functions that return such a container. `x <- pkg::dibble(...)` classifies `x`, as does a bare `x <- dibble(...)` while the package is in play, so `x[, mean(v), by = g]` is skipped. The analogue of `data.table()`, `as.data.table()`, and `fread()`. |
| `converters` | Exported by-reference converters whose first argument becomes such a container from that call on. The analogue of `setDT(x)`. |

<details markdown="1">
<summary>Exact limits of a <code>[subset]</code> declaration</summary>

- Both lists may be empty or omitted.
- A bare (unqualified) declared name counts only while the declaring package is in play, so a sidecar installed in your library can't reclassify a same-named function in a file that never loads or references that package.
- A known data.frame-family object (`data.frame()`, `tibble()`, `read.csv()`, and so on) keeps its indices checked regardless. A declaration can't claim those names.
- `setDF()` and `setattr()` keep their built-in meaning, `[[` is always standard evaluation, and a `:=` argument already marks a `[` call as NSE without any declaration.
- The lists are intersected with the package's export set, like `[[function]]` entries, and share their size limits: the file may be at most 256 KiB, and each list honors its first 2,000 entries, ignoring any beyond that.
- `data.table` itself is built in. A sidecar under that name can't change Raven's own entry.
- Older Raven versions that predate `[subset]` ignore the table, since unknown keys are never an error, so it ships under `schema = 1`.

</details>

### Declaring an assignment operator

Some packages export an infix operator that writes a column of a data frame, with the row selection and the new value evaluated among the data frame's columns. datakit's `:=` is one:

```r
library(datakit)
d[age >= 40, older] := 1
d[, avg, by = region] := mean(income, na.rm = TRUE)
```

Here `d[...]` isn't an ordinary read, so neither a `[[function]]` entry nor `[subset]` describes it. `[subset]` would also be wrong for datakit, because its `[` is base R's: it would silence `d[typo > 1, ]` everywhere. Declare the operator with an `[[operator]]` entry instead:

```toml
schema = 1

[[operator]]
name = ":="
form = "subset-assign"
masked_arguments = ["by"]
```

With that installed and the package loaded, Raven reads `x[...] := value` like this:

- `x` is an ordinary variable and is checked, so an undefined `d` is still reported. In `l$d[...] := value`, `l` is checked.
- Every positional index except the last is evaluated among the columns, so its names aren't checked, apart from the function names it calls (see below). That's `i` in `d[i, name]`.
- The last positional index is the column to write. A bare name or a string isn't a reference. In parentheses, `(var)` is evaluated, so `var` is checked.
- A named index listed in `masked_arguments` is evaluated among the columns: `by = g`, `by = .(g, h)`, or `by = c("g", "h")`. Any other named index is checked.
- With `raven.diagnostics.undefinedVariableInBracketIndices` off, no index is checked, `(var)` and other named indices included, as in an ordinary `[`.
- `value` is evaluated among the columns, so its names aren't checked either, apart from the function names it calls.

An `x[...]` that isn't on the left of the operator keeps its ordinary meaning. A left side that isn't a `[` call, such as `a := b`, does too, unless a `[[function]]` entry for the operator applies (see below).

| Key | Meaning |
| --- | --- |
| `name` | The exported operator: `":="` or a `"%op%"` name. A name the package doesn't export is ignored. |
| `form` | Required. `"subset-assign"` is the only form so far. An entry with a missing or unknown form is ignored, so a future form can ship under `schema = 1`. |
| `masked_arguments` | Named `[` arguments evaluated among, or naming, the columns. May be empty or omitted. |

<details markdown="1">
<summary>When an operator declaration applies</summary>

- An infix operator can't be written `pkg::op`, so Raven applies a declaration only where it counts the package as available at the call: the package is brought in at that point through a `library()`, `require()`, or `loadNamespace()` call above it (in the file or in a file that sources it), a `NAMESPACE` `import()` of the package or `importFrom()` of the operator, a `DESCRIPTION` `Depends:` entry, or its own sources, or the file binds `` `:=` <- datakit::`:=` ``. A `library()` call further down doesn't count for a top-level call above it; a function body sees the packages the file attaches anywhere, as it does for the package's functions. A `pkg::` reference to another of the package's functions doesn't count either, because it doesn't put the operator on the search path.
- When a second attached package exports the same operator, Raven doesn't work out which of the two R calls. See [which package's declaration applies](#declaring-nse-from-a-package).
- A definition of `` `:=` `` that the call reaches first shadows every package's declaration, as it shadows the package's operator in R: one at the file's top level, in an enclosing function, or in a sourced file. Raven's lookup is a little stricter than R's. A binding of `` `:=` `` in an enclosing function or a sourced file counts as a shadow even when it isn't a function (`` `:=` <- 1 ``), which R skips. A top-level one is skipped, as in R. It also counts an enclosing function's later definition as a shadow for a closure the function calls before making it. In both cases Raven checks the operator's arguments as ordinary code.
- Function names in the masked positional indices and the value are still checked, because a column can't be called: in `d[, avg] := maen(income)`, `income` is a column but `maen` is reported. Names inside a call that doesn't evaluate its argument, such as `quote(foo())`, stay unchecked, and named indices listed in `masked_arguments` stay fully masked, so `.` in `by = .(g, h)` isn't checked. Inside data.table's `[` and dplyr verbs, Raven still skips call heads too.
- An `[[operator]]` entry and a `[[function]]` entry may name the same operator. The `[[function]]` policy applies when the left side doesn't match the form.
- A declaration for an operator Raven models itself is ignored. That covers magrittr's pipes and `%$%`, zeallot's `%<-%` and `%->%`, foreach's `%do%`, `%dopar%`, `%dorng%`, `%dofuture%`, and `%:%`, and base R's operators such as `%in%`. The same holds for `[[function]]` entries naming those operators.
- Older Raven versions ignore `[[operator]]`, so it ships under `schema = 1`.

</details>

## Toward NSE metadata

R package metadata lists exported symbols, including function names, but has no machine-readable table of function signatures or argument-evaluation policy. [`inst/raven/nse.toml`](#declaring-nse-from-a-package) is Raven's version of that table: lightweight metadata about exported functions (names, formal argument names, and which arguments are evaluated non-standardly) that a package can author and ship today. It is Raven-specific by necessity, not by preference, and its shape is simple enough to propose as a convention other R tools could read.

That covers only packages whose authors opt in. Raven could also try generating the same metadata itself from package source, including across public repositories such as CRAN and Bioconductor. A table derived that way could improve Raven's own diagnostics, and could start a discussion about including such data in the R packaging ecosystem.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `raven.diagnostics.undefinedVariableInCallArguments` | `true` | Check names inside call arguments |
| `raven.diagnostics.undefinedVariableInBracketIndices` | `true` | Check names inside `[` and `[[` indices |

See the [settings reference](settings-reference.md) for allowed values and `raven.toml` paths.

## Limitations

- Raven's built-in policy table covers common, slow-moving packages, but it isn't exhaustive, and finding which package a function comes from depends on package metadata. A helper Raven doesn't know can still cause a false positive until you add `# raven: nse` or Raven learns its policy. See [What the built-in table covers](#what-the-built-in-table-covers).
- Some code is too dynamic to classify. After `fn <- get_function()`, Raven sees `fn(typo)` but not whether `fn` treats `typo` as a variable or as captured code. In such cases Raven may skip argument diagnostics rather than guess.
- Names created at runtime, `attach()`, package loads built at runtime, and computed data or column names may still need declarations or local suppressions.
- Raven applies a [package's declaration](#declaring-nse-from-a-package) to a bare call without working out which function R finds first. When a later package masks the declaring one, the package is loaded but never attached, or the file binds the name further down, Raven can miss an error R raises at that call. When two of the packages Raven counts at the call both declare the name, Raven doesn't choose between them by attach order, so it can also report a name R never evaluates.
- In projects where data.table, or any package that [declares data.table-style `[` semantics](#declaring-datatable-style--semantics), is detectably in play, an unresolved object inside `[` can be treated as data.table-like. This avoids many false positives but can miss a real undefined index in ambiguous code.
- A `[` call with a `:=` argument is treated as NSE no matter which package is in play or what the object is, because no base `[` method evaluates `:=`. That covers both `d[, col := value, by = grp]` and the functional `` `:=`(...) `` spelling, but only when `:=` is the argument itself, not nested in another expression. Packages that adopt data.table's bracket notation get this without a declaration. The cost is that a typo elsewhere in the same call (`d[typo, y := 1]`) goes unreported.

### What the built-in table covers

The NSE policy table covers the common, slow-moving surface. It isn't exhaustive, and source resolution depends on package-metadata coverage, so an uncatalogued NSE helper can still produce a false positive.

<details markdown="1">
<summary>Functions and packages with built-in NSE policies</summary>

- base and utils metaprogramming and object-name helpers;
- `subset` and `weights` data masking in the default-attached `stats` model-fitting functions;
- `dplyr` and `tidyr` data-masking and tidy-select verbs, including attached Bioconductor tidy-omics generics from `plyranges`, `tidySummarizedExperiment`, and `tidySingleCellExperiment`;
- `tibble` and `targets` constructors and target-name helpers, including the `names` selector of `tar_make()`, `tar_make_future()`, and `tar_make_clustermq()`;
- common `tarchetypes` target factories, plus precise `tar_map()`, `tar_plan()`, and report-factory policies;
- `gt` and `gtsummary` table-column selectors;
- `recipes` step and role column captures;
- ggplot2 mapping helpers (`aes`, `vars`, `qplot`);
- `tidyr::gather` key and value outputs;
- `tidytext` (`unnest_tokens`, `bind_tf_idf`);
- `modelr::data_grid`;
- `drake::readd`;
- rlang capture helpers;
- the `plyr::.()` quoting helper, so `ddply(df, .(col), ...)` doesn't flag `col`, and the `*ply` split-apply verbs. Their trailing `...` are data-masked, and so skipped, only when `.fun` is a data-masking verb such as `summarise`, `mutate`, or `transform`, as in `ddply(df, .(g), summarise, n = length(unique(team)))`. With an ordinary `.fun`, the `...` stay checked;
- `survival::tmerge` time-dependent terms;
- a few DSLs.

</details>

## See also

- [Directives](directives.md#nse-declarations): the full `# raven: nse` and `# raven: func` syntax
- [Diagnostics](diagnostics.md#undefined-variable): the `undefined-variable` code and suppression
- [Cross-file analysis](cross-file.md#nse-directive-propagation): how NSE declarations travel between files
- [Package development](r-package-dev.md#shipping-nse-metadata-with-your-package): shipping `nse.toml` with your package
