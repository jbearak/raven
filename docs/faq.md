# FAQ

[Docs](README.md) › Help

Short answers to the questions people ask most, each with a link to the full story.

## Does Raven run my code?

No. Raven parses your files and works out what is defined where. It never evaluates your R code, so opening a project can't write files, query a database, or start a long job. The R console, debugger, and viewers in VS Code do run R, but only when you send code to them. See [Why static analysis](https://github.com/jbearak/raven/blob/main/README.md#how-raven-differs).

## Do I need R installed?

Not for diagnostics, completion, navigation, or `raven check`. Base R's functions are built into Raven, and other packages' exports come from your installed R libraries when R is present, or from a downloadable [package database](package-database.md) when it isn't. You need R for the [R console](r-console.md), [debugger](debugger.md), plot and data viewers, and help pages.

## Why is a variable flagged as undefined when my code runs fine?

Usually because the name comes from somewhere Raven can't see statically: a file sourced through a computed path, `attach()`, or a function that creates variables at run time. Declare it with a [directive](directives.md), or see the [troubleshooting table](troubleshooting.md#4-match-your-symptom).

## Why isn't `col` in `filter(df, col > 0)` flagged?

Raven knows which arguments of common functions (dplyr, ggplot2, data.table, base R, and others) are evaluated as data columns rather than variables. For your own functions that do this, add [`# raven: nse`](non-standard-evaluation.md).

## How is Raven different from languageserver, Ark, lintr, Jarl, or Air?

languageserver (used by vscode-R) and Ark (used by Positron) answer from a running R session. Raven answers from your files, follows `source()` across them, and checks scope line by line. lintr and Jarl are style linters, and Air is a formatter; Raven runs alongside all three. See [How Raven compares](comparison.md).

## Does Raven format my code?

No. Raven indents each line as you type, but it never reformats a whole file. Use [Air](https://github.com/posit-dev/air) for that; the two don't conflict. See [Indentation](indentation.md).

## Can I use Raven with an AI coding agent?

Yes. Agents that speak LSP can use Raven for diagnostics and navigation, and since Raven never runs code, it is safe to give an agent. [Editor setup](editor-integrations.md#ai-coding-agents) has configurations for several agents, and this documentation is also indexed for agents in [llms.txt](https://github.com/jbearak/raven/blob/main/llms.txt).

## Which editors does Raven support?

Any editor with an LSP client. VS Code and its relatives (Cursor, Positron, VSCodium) get the full extension, including the console, debugger, and viewers. Neovim, Zed, Helix, Emacs, and others get the language server. See the [feature matrix](editor-integrations.md#feature-availability).

## Does it work for R packages and Shiny apps?

Yes. Raven recognizes package structure from `DESCRIPTION` and applies R's visibility rules between `R/` and `tests/`; see [Package development](r-package-dev.md). Shiny's deferred expressions, such as `observe()` and `renderPlot()` bodies, are understood as well; see [Diagnostics](diagnostics.md).

## What does Raven cost?

Nothing. Raven is open source under the [GPL-3.0](https://github.com/jbearak/raven/blob/main/LICENSE) license.

## See also

- [Troubleshooting](troubleshooting.md)
- [Limitations](limitations.md)
- [Getting started](getting-started.md)
