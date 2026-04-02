# Raven - R Language Server

A language server for R, JAGS, and Stan with cross-file awareness.

## Features

### R

- **Cross-file `source()` tracking** — Detects `source()` calls and LSP directives to resolve symbols across file boundaries
- **Position-aware scope** — Symbols from sourced files are only available after the `source()` call
- **Completions** — Intelligent completion for local symbols, cross-file symbols, and package exports (with `{package}` attribution)
- **Diagnostics** — Undefined variable detection that understands sourced files and loaded packages
- **Go-to-definition** — Navigate to symbol definitions across file boundaries
- **Find references** — Locate all symbol usages project-wide
- **Hover** — Symbol information including source file and package origin
- **Document symbols** — Hierarchical outline with R code section support (`# Section ----`)
- **Workspace symbols** — Fast project-wide symbol search (Ctrl+T / Cmd+T)
- **Package awareness** — Recognition of `library()` calls and package exports with static NAMESPACE parsing

### JAGS (`.jags`, `.bugs`) and Stan (`.stan`)

- **Syntax highlighting** — Keywords, types, distributions, and comments
- **Completions** — Language keywords, distributions, and built-in functions
- **Document symbols** — Hierarchical outline with structural blocks (e.g. `model`, `data`, `parameters`), loops, and comment sections
- **Go-to-definition** — Navigate to variable and function definitions within a file
- **Find references** — Locate all usages of a symbol within a file and across open documents
- **Hover** — Symbol information including definition location

## Settings

Key settings (all under the `raven.*` prefix):

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.diagnostics.enabled` | `true` | Enable/disable all diagnostics |
| `raven.diagnostics.undefinedVariables` | `true` | Enable undefined variable diagnostics |
| `raven.packages.enabled` | `true` | Enable package function awareness |
| `raven.packages.rPath` | auto-detect | Path to R executable |
| `raven.crossFile.indexWorkspace` | `true` | Enable background workspace indexing |
| `raven.server.path` | bundled | Path to `raven` binary (if not using the bundled one) |

Open **Settings** (Ctrl+, / Cmd+,) and search for "raven" to see all options, or see the [full configuration reference](https://github.com/jbearak/raven/blob/main/docs/configuration.md).

## Using with vscode-R

To run R code, view plots, and access other interactive features, install the [vscode-R](https://github.com/REditorSupport/vscode-R) extension alongside Raven. You can leave the language server that comes with vscode-R enabled (vscode-R provides formatting diagnostics, Raven provides code diagnostics), or disable vscode-R's language server to avoid duplicate completions:

```json
"r.lsp.enabled": false
```


You may also want to push snippets below LSP completions to reduce duplicate entries:

```json
"editor.snippetSuggestions": "bottom"
```

## Using with Sight (Stata)

If you work with Stata, see [Sight](https://github.com/jbearak/sight)—a Stata language server with the same cross-file awareness model as Raven. The [Sight](https://marketplace.visualstudio.com/items?itemName=jbearak.sight) extension provides the language server plus syntax highlighting and code execution features.

## More Information

See the [main repository README](https://github.com/jbearak/raven) for full documentation including installation, cross-file directives, and configuration details.

## License

[GPL-3.0](https://github.com/jbearak/raven/blob/main/LICENSE)
