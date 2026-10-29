# Raven

Raven finds undefined variables and broken `source()` chains in R code, across files and as you type, without running your code. It is a language server for R, so the same analysis drives completion, go to definition, find references, and hover in VS Code, Neovim, Zed, or any editor that speaks the Language Server Protocol. A command-line `raven check` runs it in CI.

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

![VS Code showing a yellow squiggle under summarize_score and the hover message "summarize_score is not defined (undefined-variable)"](docs/images/undefined-variable.png)

*The same check in VS Code, from the [Getting started](docs/getting-started.md) tutorial (Raven 0.21.1).*

Raven knows `clean_names` came from `helpers.R`, so it doesn't flag it. It flags the typo and the plot that runs before the model exists. Style linters such as lintr and Jarl check how each line is written; Raven checks whether every name your code uses exists at that point, following `source()` across files, and it runs alongside them. In your editor, the same warnings appear as you type. No R session is involved, and the output above was produced with R turned off.

## Installation

- **VS Code:** install [Raven from the Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r). The extension includes the language server.
- **Cursor, Positron, VSCodium:** install from [Open VSX](https://open-vsx.org/extension/jbearak/raven-r).
- **Other editors:** install the `raven` binary (below), then follow [Editor setup](docs/editor-integrations.md) for Neovim, Zed, Helix, Emacs, and others.

Then follow [Getting started](docs/getting-started.md). It takes two minutes.

### Command line

The `raven` binary is the language server and the CLI.

- **macOS (Apple Silicon):** `brew install jbearak/raven/raven`. Use the full name, since Homebrew core has an unrelated `raven`.
- **Ubuntu:** use the signed apt repository. See [Ubuntu installation](docs/cli.md#ubuntu-installation).
- **Arch Linux:** the community AUR packages [raven](https://aur.archlinux.org/packages/raven) and [raven-bin](https://aur.archlinux.org/packages/raven-bin), maintained by Novica.
- **Anything else:** download a binary from the [releases page](https://github.com/jbearak/raven/releases), or build from source with `cargo install --git https://github.com/jbearak/raven raven`.

<a id="ci"></a>
To run Raven on every pull request, see [Raven in CI](docs/ci.md). GitHub Actions users can install it with `jbearak/setup-raven@v1`.

<a id="features"></a>
## What you get

<a id="code-intelligence"></a>
**Analysis**

- [Diagnostics](docs/diagnostics.md): undefined and used-before-defined variables, syntax errors, missing files and packages.
- [Cross-file analysis](docs/cross-file.md): follows `source()` chains, including computed paths and `{targets}` pipelines.
- [Non-standard evaluation](docs/non-standard-evaluation.md): dplyr columns, ggplot aesthetics, and other NSE are not flagged.
- [Package development](docs/r-package-dev.md), [box and import modules](docs/modules.md), and [`.Rprofile`](docs/rprofile.md) are modeled too.
- [Linting](docs/linting.md): opt-in style rules, configured with `raven.toml`, `.lintr`, or VS Code settings.
- [Directives](docs/directives.md): `# raven:` comments for what static analysis can't see.

**Navigation and editing**

- [Completion](docs/completion.md), [hover](docs/hover.md), [go to definition](docs/go-to-definition.md), and [find references](docs/find-references.md), across files.
- [Document outline](docs/document-outline.md), [indentation](docs/indentation.md) as you type, [syntax highlighting](docs/syntax-highlighting.md), and [snippets](docs/snippets.md).
- JAGS and Stan files get [highlighting](docs/syntax-highlighting.md#jags-and-stan), [completion](docs/completion.md#jags-and-stan), [definitions](docs/go-to-definition.md#jags-and-stan), [references](docs/find-references.md#jags-and-stan), [outlines](docs/document-outline.md#jags-and-stan-model-structure), [parse errors](docs/diagnostics.md#jags-and-stan-parse-errors), and Stan [undeclared-variable checks](docs/diagnostics.md#stan-undeclared-variables).

<a id="r-session-integration"></a>
**R session (VS Code)**

- An [R console](docs/r-console.md) that runs your installed R, with code sent straight from the editor.
- A [debugger](docs/debugger.md) with breakpoints, stepping, variables, and the Debug Console.
- [Plot](docs/plot-viewer.md), [data](docs/data-viewer.md), and [help](docs/help-viewer.md) viewers. The data viewer stays fast on millions of rows.

**R Markdown, Quarto, and CI**

- [Chunks](docs/chunks.md) with run buttons and full code intelligence, [R Markdown preview and export](docs/knit.md), and [Quarto preview and render](docs/quarto.md).
- [`raven check` and `raven lint`](docs/cli.md) for the command line and [CI](docs/ci.md).

<a id="how-raven-differs"></a>
## Why static analysis

Raven reads your files instead of asking a running R session what exists. That has four consequences:

- It answers the moment you open a file, even code that errors halfway or that you're only reading.
- It reflects what the file says, not what your session remembers from an hour ago.
- It never runs your code, so it is safe on any project and behind an AI agent.
- It runs anywhere, including CI, with no R installed.

[How Raven compares](docs/comparison.md) covers RStudio, Positron, vscode-R, lintr, Jarl, and Air.

## Works with your setup

Raven adds to the R tools you already use. Its language server runs alongside vscode-R's, and its R console and viewers step aside when vscode-R or Positron is present. [Using Raven with other R tools](docs/coexistence.md) explains each combination.

## Documentation

All pages are listed in the [documentation hub](docs/README.md). Start with [Getting started](docs/getting-started.md), and see [Troubleshooting](docs/troubleshooting.md) or the [FAQ](docs/faq.md) when something is unclear. Raven is under active development; bug reports and feedback are welcome in [issues](https://github.com/jbearak/raven/issues).

Raven's sibling project [Sight](https://github.com/jbearak/sight) is a language server for Stata with the same cross-file model.

<a id="editors"></a><a id="development"></a>
Contributors: [development notes](docs/development.md) cover building, testing, and internals.

## Provenance

Raven includes code derived from [Ark](https://github.com/posit-dev/ark) (MIT License, Posit Software, PBC) — initial LSP wiring and tree-sitter scaffolding — and from Raven's sister project [Sight](https://github.com/jbearak/sight) (also GPL-3.0) — the cross-file awareness system (directives + position-aware scope model). The bundled R and R Markdown TextMate grammars come from [vscode-R-syntax](https://github.com/REditorSupport/vscode-R-syntax) (MIT). Raven's native lint compatibility tests adapt behavioral cases from [lintr](https://github.com/r-lib/lintr)'s test suite (MIT). Stan syntax diagnostics use [tree-sitter-stan](https://github.com/WardBrian/tree-sitter-stan) (MIT), pinned to an audited revision. The generated Stan callable and distribution metadata comes through the [stanc3 npm package](https://github.com/WardBrian/npm-stanc3js) 2.39.1, which bundles the [Stan compiler](https://github.com/stan-dev/stanc3) 2.39.0 (BSD-3-Clause). Raven's JAGS parser and JAGS 4.3.2 catalog are clean-room interoperability artifacts built from independently authored syntax rules and factual metadata, with the official command-line oracle and source URL/SHA-256 retained for reproducibility; Raven does not copy or bundle JAGS code or documentation.

Raven's downloadable package-symbol database is built from CRAN/Bioconductor metadata published by [r-universe](https://r-universe.dev), maintained by [rOpenSci](https://ropensci.org/r-universe/). See [Package database](docs/package-database.md#data-source-and-acknowledgement).

## License

[GPL-3.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
