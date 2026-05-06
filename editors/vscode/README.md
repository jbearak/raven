# Raven - R Language Server

A language server for R, JAGS, and Stan with cross-file awareness.

> Raven follows `source()` chains to provide workspace-wide completions, go-to-definition across files, position-aware scope resolution, and diagnostics that understand your project structure — all without running R.

## Features

- **[Completions](https://github.com/jbearak/raven/blob/main/docs/completion.md)** — Symbols, packages, and function parameters — across files
- **Go-to-definition** — Jump to definitions across file boundaries
- **[Find references](https://github.com/jbearak/raven/blob/main/docs/find-references.md)** — Locate all usages of a symbol across your project
- **Hover** — Symbol info including source file and package origin
- **[Diagnostics](https://github.com/jbearak/raven/blob/main/docs/diagnostics.md)** — Undefined variable detection that understands sourced files and loaded packages
- **[Document outline](https://github.com/jbearak/raven/blob/main/docs/document-outline.md)** — Hierarchical view with sections, classes, and nested functions
- **Workspace symbols** — Project-wide symbol search (Cmd/Ctrl+T)
- **File path intellisense** — Completions and cmd-click inside `source()` paths
- **[Smart indentation](https://github.com/jbearak/raven/blob/main/docs/indentation.md)** — Context-aware auto-indent with RStudio-style alignment
- **[Cross-file awareness](https://github.com/jbearak/raven/blob/main/docs/cross-file.md)** — Follows `source()` chains to resolve scope across files
- **[Directives](https://github.com/jbearak/raven/blob/main/docs/directives.md)** — Declare relationships and symbols the analyzer can't infer
- **Syntax highlighting** — JAGS and Stan (R highlighting is built into VS Code)

> [!NOTE]
> Raven also provides lightweight support for **JAGS** (`.jags`, `.bugs`) and **Stan** (`.stan`) files: syntax highlighting, completions (keywords, distributions, file-local symbols), go-to-definition, find references, and document outline with model structure navigation.

## Settings

Key settings (all under the `raven.*` prefix):

| Setting | Default | Description |
|---|---|---|
| `raven.diagnostics.enabled` | `true` | Enable/disable all diagnostics |
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Severity for undefined variable diagnostics (`"off"` to disable) |
| `raven.packages.enabled` | `true` | Enable package function awareness |
| `raven.packages.rPath` | auto-detect | Path to R executable |
| `raven.crossFile.indexWorkspace` | `true` | Enable background workspace indexing |
| `raven.server.path` | bundled | Path to `raven` binary (if not using the bundled one) |

See the [full configuration reference](https://github.com/jbearak/raven/blob/main/docs/configuration.md) for all options.

## Using with vscode-R

To run R code, view plots, and access other interactive features, install [vscode-R](https://github.com/REditorSupport/vscode-R) alongside Raven. Disable its language server to avoid duplicate completions:

```json
"r.lsp.enabled": false
```

## Using with Sight (Stata)

If you work with Stata, see [Sight](https://github.com/jbearak/sight) — a Stata language server with the same cross-file awareness model. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.sight).

## More Information

See the [main repository](https://github.com/jbearak/raven) for full documentation including cross-file directives, editor integrations, and comparison with other R tools.

## License

[GPL-3.0](https://github.com/jbearak/raven/blob/main/LICENSE)
