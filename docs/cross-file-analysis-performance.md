# Performance on large projects

[Docs](README.md) › Understanding Raven

On projects where many scripts source one setup file that itself sources many others, mark that setup file `# raven: self-contained` so Raven analyzes it once instead of once per caller. <a id="speeding-up-cross-file-analysis"></a>

```r
# setup.R
# raven: self-contained

source("R/imports.R")
source("R/helpers.R")
source("R/models.R")
source("R/reporting.R")
```

Most projects don't need this. Raven follows `source()` chains so diagnostics, completions, hover, go-to-definition, and find references reflect what's in scope at each line, and a few sourced helper files are cheap: Raven reuses a lot of intermediate work automatically.

## Where the cost comes from

The expensive shape is fan-out, many files sourcing one hub, multiplied by the depth or breadth of that hub's own `source()` chain:

```r
# analysis_01.R
source("setup.R")

# analysis_02.R
source("setup.R")

# ...dozens more scripts...
```

If `setup.R` is sourced by dozens of scripts and also sources dozens of files, possibly through a deeply nested chain, Raven normally has to ask: "what was visible in each caller at the moment it sourced `setup.R`?" That question matters for ordinary script fragments, but for a true helper or setup hub it's wasted work.

`# raven: self-contained` tells Raven the file doesn't depend on variables, loaded packages, or the working directory its callers provide. Raven then resolves it from its own contents and its own `source()` chain, whoever sources it. That is both faster and more precise:

- **Faster**, because Raven resolves the hub once and reuses the result for every caller. In deeply nested, widely sourced graphs, that can cut some analysis work by roughly an order of magnitude.
- **More precise**, because by default a sourced file sees the *union* of all its callers' bindings. A symbol one caller happens to define can hide a real undefined name that another caller would expose. Isolating the file removes that masking.

## What changes

Isolation goes one way:

- Caller facts don't flow into the self-contained file. Raven doesn't use any caller's variables, loaded packages, or working directory to analyze it.
- The file still flows out to callers. Its own definitions and its own `library()` / `require()` loads become visible after the `source()` call, like any sourced file.
- The file's own `source()` calls work normally. A self-contained setup file can source helper files, and Raven includes them.
- `# raven: nse` / `# raven: func` propagation is unaffected. Those declarations travel along `source()` links regardless of scope, so isolating a file never changes which NSE contracts apply across it.

The directive changes only Raven's analysis, not how R runs the file.

## Good fits

Use `# raven: self-contained` when a sourced file behaves like a project-local module:

- A shared helper file sourced by many scripts.
- A setup or bootstrap file that loads packages and defines helpers for its callers.
- A hub file with a deep or broad chain of its own `source()` calls.
- A project-local library file whose inputs come from its own code, its own sourced files, package calls, or explicit function arguments.

It helps most when a file sits at the center of the source graph: many callers source it, and it sources many files or a deeply nested chain. Without the directive, Raven may resolve the same chain again for each caller. With it, Raven reuses one result.

## Bad fits

Don't mark a file self-contained if it intentionally uses its caller's state:

```r
# run-model.R
fit <- lm(y ~ x, data = analysis_data)
```

If each caller creates `analysis_data` before sourcing `run-model.R`, that file isn't self-contained, and Raven should analyze it with each caller's scope, because that's how the project is written. Prefer an explicit function argument where you can:

```r
run_model <- function(analysis_data) {
  lm(y ~ x, data = analysis_data)
}
```

Also don't use it on ordered pipeline steps such as `01-load.R`, `02-clean.R`, and `03-model.R` when each relies on objects created by the earlier ones in the same session. Those are deliberately stateful script steps, not self-contained helpers.

## When a file has external inputs

A wrong guess fails loudly, not silently. If you mark a file self-contained and it does rely on a binding a caller provides, the only effect is a false `undefined` warning **inside that file**, never a missed bug in a caller.

If a mostly self-contained file needs one or two outside values, make the requirement executable. Raven treats `exists("name")` as declaring `name` from the next line on, so a guard both fails clearly at runtime and tells Raven the name is expected:

```r
# helpers.R
# raven: self-contained

if (!exists(".config")) {
  stop("helpers.R requires `.config` to be defined before it is sourced")
}

use_config(.config)
```

For more data than that, an explicit function argument, or moving the setup into the self-contained chain, is usually clearer. Avoid bare `# raven: var` directives for caller-provided values unless there's no runtime check to write, because a directive alone can hide a real missing prerequisite.

## R workflow guidance

R projects often pass through a middle stage: repeated analysis code becomes functions, the functions move into a shared helper file, and many scripts source that file. Raven supports that pattern, and `# raven: self-contained` is the right directive once the helper file no longer depends on whichever script sourced it.

For reusable functions, the long-term R practice is often a small package with the functions under `R/`. Raven treats that layout specially only when [package mode](r-package-dev.md#configuration) is on, for example when the workspace root has a `DESCRIPTION` file with a valid `Package:` field, or `raven.packages.packageMode` is `"enabled"`. In package mode, top-level symbols in `R/*.R` files see each other without `source()` calls.

In an ordinary script project, `R/` is just a folder name. Keeping helpers there is a fine convention, but Raven won't load them just because of where they live; the project still needs `source()` calls, forward directives such as `# raven: source R/helpers.R`, or package metadata. For project-local analysis repos, a sourced helper or setup file is a reasonable middle stage. See [R Packages: The package within](https://r-pkgs.org/package-within.html), [R Packages: R code](https://r-pkgs.org/code.html), and [Package development](r-package-dev.md).

## Syntax

`self-contained` goes in the file header and takes no arguments:

```r
# raven: self-contained
```

These spellings are equivalent:

```r
# raven: standalone
# @lsp-standalone
# @lsp-self-contained
```

Prefer `# raven: self-contained` in new code.

## See also

- [Directives: self-contained sourced files](directives.md#self-contained-sourced-files): full semantics, and how it interacts with `# raven: cd`, package mode, and a caller's `local = TRUE` or `sys.source()`
- [Cross-file analysis](cross-file.md): the scope model this builds on
- [Traversal budgets in large workspaces](cross-file.md#traversal-budgets-in-large-workspaces): limits Raven applies on very dense source graphs
