# Raven - R Language Server

An R language server with cross-file awareness.

## Features

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

## Settings

Raven settings are available under the `raven.*` prefix in VS Code. Open **Settings** (Ctrl+, / Cmd+,) and search for "raven" to see all available options.

## Using with vscode-R

To run R code, view plots, and access other interactive features, install the [vscode-R](https://github.com/REditorSupport/vscode-R) extension alongside Raven. You can leave both language servers enabled (vscode-R provides formatting diagnostics, Raven provides code diagnostics), or disable vscode-R's language server to avoid duplicate completions:

```json
"r.lsp.enabled": false
```


You may also want to push snippets below LSP completions to reduce duplicate entries:

```json
"editor.snippetSuggestions": "bottom"
```

## More Information

See the [main repository README](https://github.com/jbearak/raven) for full documentation including installation, cross-file directives, and configuration details.
