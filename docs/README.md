# Raven documentation

Raven is a static analyzer and language server for R. Start with [Getting started](getting-started.md), or pick a topic below.

## Start here

- [Getting started](getting-started.md): Install Raven and catch your first bug in two minutes.
- [Coming from RStudio, vscode-R, Positron, or lintr](coming-from.md): What stays the same, what changes, and which settings to flip.
- [Editor setup](editor-integrations.md): Set up Raven in VS Code, Neovim, Zed, Helix, Emacs, or any LSP client, and check that it works.
- [Raven in CI](ci.md): Run `raven check` on every pull request with GitHub Actions or Bitbucket Pipelines.

## Analysis

- [Diagnostics](diagnostics.md): What Raven reports, how to silence or tune it, and a reference for every diagnostic code.
- [Cross-file analysis](cross-file.md): How Raven follows `source()` chains and resolves paths across files.
- [Non-standard evaluation](non-standard-evaluation.md): How Raven handles dplyr-style column names, and what to do when it can't.
- [Package development](r-package-dev.md): How Raven analyzes R packages: visibility between R/ and tests/, NAMESPACE, and build commands.
- [box and import modules](modules.md): How Raven models `box::use()` and `import::from()` imports.
- [.Rprofile startup files](rprofile.md): How Raven accounts for definitions in a project `.Rprofile`.
- [Linting](linting.md): Opt-in style rules, configured with `raven.toml`, `.lintr`, or VS Code settings.
- [Indentation](indentation.md): How Raven indents R code as you type, and the styles you can choose.

## Navigation and editing

- [Completion](completion.md): Completions for symbols, packages, arguments, `$` fields, and file paths.
- [Hover](hover.md): What hover shows for functions, variables, and package symbols.
- [Go to definition](go-to-definition.md): Jump to where a symbol is defined, across files and into packages.
- [Find references](find-references.md): Find every use of a symbol across your project.
- [Document outline](document-outline.md): The outline and breadcrumbs: sections, functions, and classes.
- [Syntax highlighting](syntax-highlighting.md): Semantic highlighting for R, plus JAGS and Stan grammars.
- [Snippets](snippets.md): The R code snippets Raven provides.

## R session (VS Code)

- [R console](r-console.md): Run R in VS Code and send code from the editor.
- [Debugger](debugger.md): Breakpoints, stepping, and variables for R scripts and documents.
- [Plot viewer](plot-viewer.md): View, browse, and save plots in a VS Code panel.
- [Data viewer](data-viewer.md): Browse, sort, and filter data frames of any size with `View()`.
- [Help viewer](help-viewer.md): Read R help for the function actually in scope.

## R Markdown and Quarto

- [Code chunks](chunks.md): Run, navigate, and get code intelligence in R chunks.
- [R Markdown preview and export](knit.md): Preview `.Rmd` files and export them to HTML, PDF, or Word.
- [Quarto](quarto.md): Preview and render `.qmd` documents with Quarto.

## Reference

- [Directives](directives.md): `# raven:` comments that declare symbols, relationships, and suppressions.
- [Configuration](configuration.md): How settings, `raven.toml`, and `.lintr` combine, and where Raven looks for them.
- [Settings reference](settings-reference.md): Every setting, alphabetically, with its default and `raven.toml` key.
- [Command line](cli.md): `raven check`, `raven lint`, `raven packages`, and the language server command.
- [Keybindings](keybinding-comparison.md): Chunk and console shortcuts compared with RStudio, Quarto, and vscode-R.

## Understanding Raven

- [How Raven compares](comparison.md): Raven next to RStudio, Positron, vscode-R, languageserver, lintr, and Jarl.
- [Using Raven with other R tools](coexistence.md): Run Raven alongside vscode-R or Positron, and choose which tool owns the console.
- [Limitations](limitations.md): What Raven doesn't do yet.
- [Package database](package-database.md): How Raven knows package exports without R, and how to keep that data current.
- [Performance on large projects](cross-file-analysis-performance.md): Speed up analysis when many files source the same scripts.

## Help

- [Troubleshooting](troubleshooting.md): A step-by-step procedure for when Raven misbehaves, and what to include in a bug report.
- [FAQ](faq.md): Short answers to common questions.

## More

- [Project README](https://github.com/jbearak/raven/blob/main/README.md): what Raven is, installation, and license.
- [Report a problem](https://github.com/jbearak/raven/issues). See [Troubleshooting](troubleshooting.md) first for what to include.

<!-- Generated from docs/user-pages.json by scripts/generate-docs-hub.ts. Edit the manifest, then regenerate. -->
