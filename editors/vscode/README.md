# Raven

R language support with cross-file code intelligence (completions, diagnostics, navigation), an [R console](https://github.com/jbearak/raven/blob/main/docs/r-console.md), and [plot](https://github.com/jbearak/raven/blob/main/docs/plot-viewer.md), [data](https://github.com/jbearak/raven/blob/main/docs/data-viewer.md), and [help](https://github.com/jbearak/raven/blob/main/docs/help-viewer.md) viewers.

The language server analyzes your code in realtime: it completes variable and accessor names as you type, flags syntax errors and undefined variables, and lets you jump to where a variable or function is defined or list all the other places that your codebase references it.

Compared with [REditorSupport's R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r), [Positron](https://github.com/posit-dev/positron), and RStudio, Raven's language server is the only one that traces `source()` chains, so completions, diagnostics, and navigation reflect the actual order of execution at each cursor position. Of those three, REditorSupport is the only other VS Code option; against REditorSupport specifically, Raven adds RStudio-style indentation on Enter without disturbing the surrounding code, sends large blocks of code to R faster, and uses a virtualized Arrow-backed data viewer that stays responsive on large frames.

> If you already have the REditorSupport (R) extension installed, or you're using Positron, Raven's R-console features (R console, plot viewer, data viewer) step aside by default — see [Coexistence](#coexistence-with-vscode-r-and-positron) below. Raven still provides code intelligence and scope-aware help in either setup.

## Features

### Code intelligence

- **[Completions](https://github.com/jbearak/raven/blob/main/docs/completion.md)** — Symbols, packages, and function parameters — across files
- **[Go-to-definition](https://github.com/jbearak/raven/blob/main/docs/go-to-definition.md)** — Jump to definitions across file boundaries
- **[Find references](https://github.com/jbearak/raven/blob/main/docs/find-references.md)** — Locate all usages of a symbol across your project
- **[Hover](https://github.com/jbearak/raven/blob/main/docs/hover.md)** — Symbol info including source file and package origin
- **[Diagnostics](https://github.com/jbearak/raven/blob/main/docs/diagnostics.md)** — Undefined variable detection that understands sourced files and loaded packages
- **[Document outline](https://github.com/jbearak/raven/blob/main/docs/document-outline.md)** — Hierarchical view with sections, classes, and nested functions
- **Workspace symbols** — Project-wide symbol search (Cmd/Ctrl+T)
- **File path intellisense** — Completions and cmd-click inside `source()` paths
- **[Smart indentation](https://github.com/jbearak/raven/blob/main/docs/indentation.md)** — Context-aware auto-indent with RStudio-style alignment
- **[Cross-file awareness](https://github.com/jbearak/raven/blob/main/docs/cross-file.md)** — Follows `source()` chains to resolve scope across files
- **[Directives](https://github.com/jbearak/raven/blob/main/docs/directives.md)** — Declare relationships and symbols the analyzer can't infer
- **[Syntax highlighting](https://github.com/jbearak/raven/blob/main/docs/syntax-highlighting.md)** — R function names via LSP semantic tokens, plus JAGS and Stan syntax highlighting
- **[Snippets](https://github.com/jbearak/raven/blob/main/docs/snippets.md)** — Built-in snippets for common R patterns (control flow, apply family, ggplot2 scaffolds, roxygen2 tags) plus R Markdown / Quarto chunk and YAML scaffolds

### R session integration

- **[R console](https://github.com/jbearak/raven/blob/main/docs/r-console.md)** — Interactive R console with statement detection and a temp-file fallback for large blocks; supports R, arf, and radian
- **[Plot viewer](https://github.com/jbearak/raven/blob/main/docs/plot-viewer.md)** — Plots render in a VS Code panel via [httpgd](https://nx10.dev/httpgd/), with history navigation, save (PNG/SVG/PDF), and theme-aware background
- **[Data viewer](https://github.com/jbearak/raven/blob/main/docs/data-viewer.md)** — `View(df)` opens a virtualized grid backed by Apache Arrow; viewport-based rendering keeps scrolling responsive on multi-million-row frames
- **[Help viewer](https://github.com/jbearak/raven/blob/main/docs/help-viewer.md)** — Scope-aware R help: hovering shows the function in scope at the cursor instead of falling through to a multi-package list when scope can't be inferred

> Raven also provides lightweight support for **JAGS** (`.jags`, `.bugs`) and **Stan** (`.stan`) files: syntax highlighting, completions (keywords, distributions, file-local symbols), go-to-definition, find references, and document outline with model structure navigation.

## Settings

Key settings (all under the `raven.*` prefix):

| Setting | Default | Description |
|---|---|---|
| `raven.rConsole.activation` | `"auto"` | When Raven's R console (and the plot and data viewers it powers) activates: `"enabled"`, `"disabled"`, or `"auto"` (off when REditorSupport.r is enabled or running in Positron). See [Coexistence](https://github.com/jbearak/raven/blob/main/docs/coexistence.md). |
| `raven.help.viewerColumn` | `"beside"` | Initial editor column when the R help viewer first opens (`"active"` or `"beside"`). Code intelligence and the help viewer are unaffected by `raven.rConsole.activation`. |
| `raven.diagnostics.enabled` | `true` | Enable/disable all diagnostics |
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Severity for undefined variable diagnostics (`"off"` to disable) |
| `raven.packages.rPath` | auto-detect | Path to R executable |
| `raven.crossFile.indexWorkspace` | `true` | Enable background workspace indexing |
| `raven.server.path` | bundled | Path to `raven` binary (if not using the bundled one) |

See the [full configuration reference](https://github.com/jbearak/raven/blob/main/docs/configuration.md) for all options.

## Coexistence with vscode-R and Positron

Raven's R-console features (R console, plot viewer, data viewer) and REditorSupport's [vscode-R](https://github.com/REditorSupport/vscode-R) cover overlapping ground. By default `raven.rConsole.activation` is `"auto"`, which leaves Raven's R-console features off when vscode-R is enabled or you're running inside Positron. Raven's help viewer and language server activate either way.

Set `"enabled"` so Raven's R console is available alongside REditorSupport's. `Cmd+Enter` / `Ctrl+Enter` can only be bound to one extension's send command; VS Code's keybinding editor lets you rebind either. See [Coexistence](https://github.com/jbearak/raven/blob/main/docs/coexistence.md) for when you'd want to do this.

REditorSupport's `lintr` diagnostics are provided by its language server. If you want lintr alongside Raven, leave `r.lsp.enabled` at its default (`true`) — both language servers will run, with some overlap in completions and diagnostics. If you don't need lintr and only want vscode-R for its R-session features, disable its language server:

```json
"r.lsp.enabled": false
```

For a deeper comparison see [docs/comparison.md](https://github.com/jbearak/raven/blob/main/docs/comparison.md).

## Using with Sight (Stata)

If you work with Stata, see [Sight](https://github.com/jbearak/sight) — a Stata language server with the same cross-file awareness model. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.sight).

## More Information

See the [main repository](https://github.com/jbearak/raven) for full documentation including cross-file directives, editor integrations, and comparison with other R tools.

## License

[GPL-3.0](https://github.com/jbearak/raven/blob/main/LICENSE)
