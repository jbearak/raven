# Raven

Raven finds undefined variables and broken `source()` chains in R code, across files and as you type, without running your code. The same analysis drives completion, go to definition, find references, and hover. The extension also brings an R console, a debugger, plot, data, and help viewers, and R Markdown and Quarto preview, which step aside if you already use vscode-R or Positron.

Here, `analysis.R` sources `helpers.R`, which defines `clean_names()`:

<!-- example: readme-demo file=analysis.R -->
```r
source("helpers.R")

survey <- clean_names(read.csv("survey.csv"))
summary(servey$age)

plot(fit)
fit <- lm(age ~ income, data = survey)
```

<!-- example: readme-demo -->
```console
$ raven check .
analysis.R:4:9 warning: servey is not defined [undefined-variable]
analysis.R:6:6 warning: fit is used before it is defined (defined on line 7) [undefined-variable]
2 issues (0 errors, 2 warnings, 0 infos, 0 hints, 0 notes)
```

![VS Code showing a yellow squiggle under summarize_score and the hover message "summarize_score is not defined (undefined-variable)"](https://raw.githubusercontent.com/jbearak/raven/main/docs/images/undefined-variable.png)

Raven knows `clean_names` came from `helpers.R`, so it doesn't flag it. It flags the typo and the plot that runs before the model exists. Style linters such as lintr and Jarl check how each line is written; Raven checks whether every name your code uses exists at that point, following `source()` across files, and it runs alongside them. In VS Code, the same warnings appear in the editor and the Problems panel as you type. No R session is involved, and the output above was produced with R turned off.

![The VS Code debugger stopped at a breakpoint in an R function, with local variables avg and scores in the Variables view and the R console below](https://raw.githubusercontent.com/jbearak/raven/main/docs/images/debugger.png)

## Get started

Open a folder with R files. Raven starts automatically and needs nothing else installed: the language server ships with the extension, and R is only needed for the console, debugger, and viewers. [Getting started](https://github.com/jbearak/raven/blob/main/docs/getting-started.md) walks through a first example in two minutes.

<a id="features"></a><a id="code-intelligence"></a>
## What you get

**Analysis**

- [Diagnostics](https://github.com/jbearak/raven/blob/main/docs/diagnostics.md): undefined and used-before-defined variables, syntax errors, missing files and packages.
- [Cross-file analysis](https://github.com/jbearak/raven/blob/main/docs/cross-file.md): follows `source()` chains, including computed paths and `{targets}` pipelines.
- [Non-standard evaluation](https://github.com/jbearak/raven/blob/main/docs/non-standard-evaluation.md): dplyr columns, ggplot aesthetics, and other NSE are not flagged.
- [Package development](https://github.com/jbearak/raven/blob/main/docs/r-package-dev.md), [box and import modules](https://github.com/jbearak/raven/blob/main/docs/modules.md), and [`.Rprofile`](https://github.com/jbearak/raven/blob/main/docs/rprofile.md) are modeled too.
- [Linting](https://github.com/jbearak/raven/blob/main/docs/linting.md): opt-in style rules, configured with `raven.toml`, `.lintr`, or VS Code settings.
- [Directives](https://github.com/jbearak/raven/blob/main/docs/directives.md): `# raven:` comments for what static analysis can't see.

**Navigation and editing**

- [Completion](https://github.com/jbearak/raven/blob/main/docs/completion.md), [hover](https://github.com/jbearak/raven/blob/main/docs/hover.md), [go to definition](https://github.com/jbearak/raven/blob/main/docs/go-to-definition.md), and [find references](https://github.com/jbearak/raven/blob/main/docs/find-references.md), across files.
- [Document outline](https://github.com/jbearak/raven/blob/main/docs/document-outline.md), [indentation](https://github.com/jbearak/raven/blob/main/docs/indentation.md) as you type, [syntax highlighting](https://github.com/jbearak/raven/blob/main/docs/syntax-highlighting.md), and [snippets](https://github.com/jbearak/raven/blob/main/docs/snippets.md).
- JAGS and Stan files get [highlighting](https://github.com/jbearak/raven/blob/main/docs/syntax-highlighting.md#jags-and-stan), [completion](https://github.com/jbearak/raven/blob/main/docs/completion.md#jags-and-stan), [definitions](https://github.com/jbearak/raven/blob/main/docs/go-to-definition.md#jags-and-stan), [references](https://github.com/jbearak/raven/blob/main/docs/find-references.md#jags-and-stan), [outlines](https://github.com/jbearak/raven/blob/main/docs/document-outline.md#jags-and-stan-model-structure), [parse errors](https://github.com/jbearak/raven/blob/main/docs/diagnostics.md#jags-and-stan-parse-errors), and Stan [undeclared-variable checks](https://github.com/jbearak/raven/blob/main/docs/diagnostics.md#stan-undeclared-variables).

<a id="r-session-integration"></a>
**R session (VS Code)**

- An [R console](https://github.com/jbearak/raven/blob/main/docs/r-console.md) that runs your installed R, with code sent straight from the editor.
- A [debugger](https://github.com/jbearak/raven/blob/main/docs/debugger.md) with breakpoints, stepping, variables, and the Debug Console.
- [Plot](https://github.com/jbearak/raven/blob/main/docs/plot-viewer.md), [data](https://github.com/jbearak/raven/blob/main/docs/data-viewer.md), and [help](https://github.com/jbearak/raven/blob/main/docs/help-viewer.md) viewers. The data viewer stays fast on millions of rows.

**R Markdown, Quarto, and CI**

- [Chunks](https://github.com/jbearak/raven/blob/main/docs/chunks.md) with run buttons and full code intelligence, [R Markdown preview and export](https://github.com/jbearak/raven/blob/main/docs/knit.md), and [Quarto preview and render](https://github.com/jbearak/raven/blob/main/docs/quarto.md).
- [`raven check` and `raven lint`](https://github.com/jbearak/raven/blob/main/docs/cli.md) for the command line and [CI](https://github.com/jbearak/raven/blob/main/docs/ci.md).

<a id="coexistence-with-vscode-r-and-positron"></a>
## Works with vscode-R and Positron

Raven adds to the tools you already use. Its language server runs alongside vscode-R's; set `r.lsp.enabled` to `false` if you'd rather have only Raven's completions. Raven's console and viewers stay off while vscode-R is enabled or you're in Positron, controlled by `raven.rConsole.activation`. [Using Raven with other R tools](https://github.com/jbearak/raven/blob/main/docs/coexistence.md) explains each combination, and [How Raven compares](https://github.com/jbearak/raven/blob/main/docs/comparison.md) covers the differences.

Raven's [style lints](https://github.com/jbearak/raven/blob/main/docs/linting.md) are opt-in and cover a subset of lintr's rules ([what's not covered](https://github.com/jbearak/raven/blob/main/docs/linting.md#gaps-vs-lintr)).

<a id="settings"></a><a id="more-information"></a>
## Settings and documentation

Every setting is under `raven.*`. See the [settings reference](https://github.com/jbearak/raven/blob/main/docs/settings-reference.md), and the [documentation hub](https://github.com/jbearak/raven/blob/main/docs/README.md) for everything else, including [Troubleshooting](https://github.com/jbearak/raven/blob/main/docs/troubleshooting.md) and running the same checks in [CI](https://github.com/jbearak/raven/blob/main/docs/ci.md). To search all pages, use the [documentation site](https://jbearak.github.io/raven/).

If you work with Stata, Raven's sibling project [Sight](https://github.com/jbearak/sight) brings the same cross-file model to Stata.

## Acknowledgements

Raven builds on open-source work. It started as the language server extracted from [Ark](https://github.com/posit-dev/ark), [tree-sitter-r](https://github.com/r-lib/tree-sitter-r) parses your R code, its linter follows [lintr](https://github.com/r-lib/lintr), and its R grammars come from [vscode-R-syntax](https://github.com/REditorSupport/vscode-R-syntax). The [acknowledgements](https://github.com/jbearak/raven#acknowledgements) describe the main projects Raven draws on and what it takes from each.

## License

[GPL-3.0](https://github.com/jbearak/raven/blob/main/LICENSE)
