# Raven - R Language Server

A static R language server with cross-file awareness for scientific research workflows. Raven provides LSP features (completions, diagnostics, go-to-definition, hover) without embedding R runtime, using tree-sitter for parsing.

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

Raven settings are available under the `raven.*` prefix in VS Code. Open **Settings** (Ctrl+, / Cmd+,) and search for "raven" to see all available options, including:

- **Server**: Custom binary path
- **Cross-file**: Traversal depth limits, call-site assumptions, revalidation behavior, cache sizes
- **Diagnostics**: Enable/disable diagnostics, undefined variable detection
- **Packages**: Package awareness, library paths, R executable path
- **Symbols**: Workspace symbol result limits

## Using with Other R Extensions

If you use Raven alongside [vscode-R](https://github.com/REditorSupport/vscode-R), you may see duplicate entries in the completion menu (e.g., `source` appearing twice). This happens because VS Code does not deduplicate completions across providers — Raven contributes package export completions while vscode-R contributes R snippets for the same functions.

To reduce clutter, add this to your VS Code settings:

```json
"editor.snippetSuggestions": "bottom"
```

This pushes snippet completions below LSP completions, so Raven's results (with package attribution like `{base}`) appear first.

## More Information

See the [main repository README](https://github.com/jbearak/Raven) for full documentation including installation, cross-file directives, and configuration details.
