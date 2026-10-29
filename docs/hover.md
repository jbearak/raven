# Hover

[Docs](README.md) › Navigation and editing

Hover over a name to see what it refers to at that point in your code: its definition, its package and help text, or its documentation.

```r
library(stats)
filter(x, filt, method = "convolution")  # hover: stats::filter

library(dplyr)
filter(df, x > 0)                        # hover: dplyr::filter (dplyr loaded after stats)
```

The same name can hover differently on different lines, because Raven reports the definition or package that is in scope at the cursor. This is the same scope that [completion](completion.md), [diagnostics](diagnostics.md), and [go to definition](go-to-definition.md) use.

## What you see

| At the cursor | Hover shows |
|---|---|
| The member in `pkg::name` or `pkg:::name` | A bold `pkg::name` help link and R's help text for that topic. Nothing if `name` is missing from the package's complete export set. |
| The package in `pkg::name` | The package's `Title` and `Description` from its installed `DESCRIPTION`. Nothing if the package isn't installed, since [`package-not-installed`](diagnostics.md#package-diagnostics) already flags that token. |
| A local or cross-file definition | The definition statement in a code block, then a [file location line](#file-location-lines) |
| An argument name that matches a formal of your own function (`param` in `f(param = …)`) | The formal and its default, "parameter of `f`", and the formal's `@param` doc if it has one |
| A parameter name where a function is defined (`x` in `f <- function(x)`) | The parameter's `@param` roxygen doc, if the named function is documented |
| An `obj$name` or `obj@slot` member defined in your code | The member's definition statement and a file location line, matching go to definition |
| An exported member of a static `box::use()` alias (`mod$name`, `mod@name`, `mod[["name"]]`) | The original module definition and its location, including through renamed or wildcard re-exports. Package-backed members show the package without a source location. |
| A symbol declared with `# raven: var` or `# raven: func` | `name (declared function)` or `name (declared variable)`, and the directive line that declares it |
| A package export in scope (from `library()`, `require()`, `loadNamespace()`, or directives) | A bold `pkg::name` help link and R's help text |
| A built-in or other unresolved symbol | R's help text, if R has a topic for it |

Hover shows nothing for names R doesn't know that aren't in scope. It also shows nothing for an argument name or `$` member it can't resolve, rather than guessing a package.

## Scope-aware package attribution

Hover finds a symbol's package the same way Raven checks scope everywhere else. A package counts as loaded after `library()` or `require()`, and also after `loadNamespace()` (which R itself treats as load-only), plus namespace qualifiers and declared symbols. The package shown therefore depends on what is loaded at the cursor, as in the example at the top of this page.

`dplyr::filter` and `stats::filter` always hover as their own packages, whatever else is loaded. For how this differs from other R hover implementations, see [Comparison: hover help](comparison.md#hover-help).

## Package exports and the help-panel link

When a hover resolves to a package export and R has a help topic for it, the first line is a bold link such as `dplyr::filter`. In VS Code, clicking it opens the [help viewer](help-viewer.md) beside the editor: the same topic, rendered from Rd, in a resizable panel with back and forward navigation.

If R hasn't rendered the help yet (a cold cache, a large package, or a name without a topic), the hover is shorter. It omits the bold link and shows the name or Raven's parsed signature with a `from {pkg}` attribution. The next hover on the same topic uses Raven's help cache and shows the full text and link.

Qualified calls such as `dplyr::filter` always get the bold link, even when R can't render the topic. The exception: if Raven holds a complete export set for the package and the member isn't in it, hover shows nothing. This is the same condition that raises [`namespace-member-not-found`](diagnostics.md#namespace-member-references-pkgmember). It never applies to `pkg:::name`, because internal names are real members, or when the package's metadata is incomplete or still loading.

## File location lines

When a hover comes from a local or sourced definition, a line under the code block says where the definition is. Package exports show the help link instead.

| Where the definition is | The line reads |
|---|---|
| The same file | `this file, line N` |
| Another file | `[rel/path.R](file:///…), line N`. The link opens the file at the top; use go to definition to land on the line. |
| A file that has moved or changed since Raven read it | *Defined in rel/path.R* |

Paths are relative to the workspace root when there is one, so a symbol defined in `R/utils.R` shows exactly that. The link opens the same file that [go to definition](go-to-definition.md#cross-file-navigation) opens.

Bindings from testthat helper and setup files also show their definition and location. That includes later helpers visible inside function bodies and definitions loaded by static `source()` calls. Hover follows the helper source order and `raven.crossFile.hoistGlobalsInFunctions`. If a contributed name has no recoverable definition, hover shows the name without a location.

## Declared symbols

A symbol declared with [`# raven: var` or `# raven: func`](directives.md#declaration-directives) hovers as a code block with the declaration, then the directive line and, for declarations in another file, that file. For a function declared in another file, the code block is:

```r
name (declared function)
```

Below it, as text, are `Declared via # raven: func directive at line 12` and *Defined in analysis/helpers.R*. The "Defined in" line is left out when the declaration is in the current file.

If a file declares the same name more than once, hover shows the most recent declaration at or before the cursor, matching [completion](completion.md) and [diagnostics](diagnostics.md). [Go to definition](go-to-definition.md#declared-symbols) differs: it jumps to the first declaration in the file.

## With REditorSupport also installed

VS Code asks every enabled extension for a hover and stacks the answers, separated by lines. With both Raven and the [REditorSupport extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) active, REditorSupport's bold help links appear at the top and Raven's result below.

REditorSupport doesn't check scope at the cursor. When it can't narrow a name to one package, it looks the topic up in every installed package. Hovering `filter` after `library(dplyr)` may show both `dplyr::filter` and `stats::filter` at the top, with Raven's single `dplyr::filter` underneath. [Comparison: hover help](comparison.md#hover-help) explains the mechanism.

Both extensions answer independently and VS Code joins the output. To see only Raven's hover, set `"r.lsp.enabled": false`; see [Coexistence](coexistence.md#language-servers-raven-alone-vs-both).

## JAGS hover

In `.jags`, `.bugs`, and `.bug` files, hovering a call to a known JAGS 4.3.2 function shows its signature, the module that provides it, any alias relationship, and the catalog version. The extensions are matched case-insensitively as strict JAGS, not general OpenBUGS, WinBUGS, MultiBUGS, or NIMBLE input. Only call sites get a hover. Plain identifiers, comments, unknown names, names from optional modules, and quoted text in incomplete code stay silent.

Right after `~`, a name hovers as a distribution, and its signature lists only the distribution parameters (the stochastic node is on the left of the `~`). Elsewhere, the ordinary function wins. This matters for names like `dnorm`, which JAGS has in both roles with different numbers of arguments. A distribution-only name such as `dbern` doesn't get a function hover.

JAGS signature help uses the same catalog. It handles nested calls, indexing, arguments split across lines, trailing arguments, and comments, and it never starts R or JAGS.

## Stan hover

In a `.stan` file, hovering a call to a compiler-known function shows representative signatures and a link to the [Stan Functions Reference](https://mc-stan.org/docs/2_39/functions-reference/functions_index.html) for that version. The link goes to the function's entry in the alphabetical index; compiler aliases the reference doesn't document separately land on the index itself. Raven bundles this metadata from the `stanc3` npm package 2.39.1 (compiler 2.39.0), so hover needs no Stan installation, subprocess, or network request.

In a sampling statement, hover knows it is looking at a distribution. Hovering `normal` in `y ~ normal(mu, sigma)` explains that the bare name is notation after `~` and that the statement adds the unnormalized log density from `normal_lupdf` to `target`. The hover labels the `normal_lpdf` signatures it shows as the normalized log-density function and links to that entry. Discrete distributions work the same way with `_lupmf` and `_lpmf`. Truncation can add normalization terms beyond that contribution.

Outside a sampling statement, an exact function wins when a name is ambiguous: `beta(1, 2)` describes the beta special function, not the beta distribution. A bare distribution name with no matching function still gets a distribution hover in incomplete code, and the hover says that forms like `normal(...)` are valid only on the right of `~`.

Some Stan functions have hundreds of overloads. Hover shows at most 12 signatures and gives the full count. Statement-like functions such as `print()` and `reject()` get a reference link even without a conventional signature.

Stan hover covers call sites only. It shows nothing for names in comments or strings, plain identifiers that aren't calls, unknown functions, and calls to a function defined in the current file. A variable with the same name doesn't block a function's hover, and a sampling statement still hovers as a distribution even if you defined a function with the distribution's name.

<a id="limits"></a>

## Limitations

- Hover doesn't open installed package sources. It names the package and links to the help viewer, but go to definition on a package export doesn't jump into the package. See [Go to definition: package exports](go-to-definition.md#package-exports).
- The first hover on an R help topic starts an R process to render the help, so it can take a moment. Later hovers on the same topic use the cache.
- In R Markdown and Quarto, hover and its help link work only in R chunks. Prose, YAML front matter, and non-R chunks show nothing.
- For a Stan function defined in the current file, Raven suppresses the built-in hover but doesn't yet show your function's signature or comments.

## Details

### Resolution order

For R files, hover tries these sources in order and stops at the first match:

1. **Namespace qualifier.** Inside `pkg::name` or `pkg:::name`, the qualifier wins, even if the file's own scope would resolve `name` to something else. Otherwise `filter` in `dplyr::filter(...)` could show `stats::filter`. Hovering the member shows the topic's help; hovering the package shows its `Title` and `Description` (or nothing if it isn't installed), not a `dplyr::dplyr` help page.
2. **Argument names, parameter names, and `$` members.** These never refer to a value when the code runs, so hover never attributes them to an unrelated definition or package. It shows something only when it can resolve them exactly: an argument name that matches a formal of your own function, a parameter name in a documented named function, or an `obj$name` / `obj@slot` member defined in your code. Anything else shows nothing. Hover and diagnostics agree on which names count. The name being assigned, such as `add` in `add <- function(...)`, is a definition, so hover continues to the next step and shows it.
3. **Cross-file scope.** Raven looks the name up in the scope at the cursor, across sourced files. A local definition, sourced definition, declared symbol, or in-scope package export produces the hover.
4. **Loaded packages.** If the name isn't in scope but a package loaded at the cursor exports it (including packages loaded in parent files), hover shows that package's help topic.
5. **R help.** For anything left, such as base and recommended built-ins, hover asks R for a help topic and shows it as is.

### box module members

Static [`box::use()` imports](modules.md#box-modules-boxuse) are resolved before ordinary `$` member lookup. Hover on an exported member of a local module follows the exact definition through named, renamed, and wildcard re-exports, even when the defining module is closed but indexed in the workspace. Private members, and members a complete export set proves absent, show nothing. Partial or unknown export metadata stays conservative. Installed-package imports use Raven's package metadata and help, without inventing a source location for installed code.

<a id="related"></a>

## See also

- [Go to definition](go-to-definition.md)
- [Help viewer](help-viewer.md)
- [Cross-file analysis](cross-file.md)
- [Directives](directives.md)
- [Comparison: hover help](comparison.md#hover-help)
