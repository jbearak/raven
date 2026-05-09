# Raven — R language server and VS Code extension

Raven is an R extension for VS Code, plus a standalone [language server](https://github.com/Microsoft/language-server-protocol) for other LSP-compatible editors (Zed, Neovim, and AI agents).

The language server analyzes your code in realtime. It completes variable and accessor names as you type, flags syntax errors and undefined variables, and lets you jump to where a variable or function is defined or list all the other places that your codebase references it. The VS Code extension bundles the language server alongside an integrated [R console](docs/r-console.md), [plot viewer](docs/plot-viewer.md), [data viewer](docs/data-viewer.md), and [help viewer](docs/help-viewer.md).

Compared with [REditorSupport's R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r), Raven's language server traces `source()` chains to resolve what's in scope at each cursor position, rather than treating the workspace as a flat set of top-level symbols. Raven also sends large blocks of code to R faster, and uses a virtualized Arrow-backed data viewer that stays responsive on large frames.

> [!NOTE]
> If you already have the REditorSupport (R) extension installed, or you're using Positron, Raven's R-console features (R console, plot viewer, data viewer) step aside by default — see [Comparison: Coexistence](docs/comparison.md#coexistence). The language server and help viewer are unaffected.

> **Status:** Raven is under active development. It works well for day-to-day use but hasn't been widely announced yet. Bug reports and feedback are welcome!

> **Quick Start:** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r) or [OpenVSX](https://open-vsx.org/extension/jbearak/raven-r), or download from the [releases page](https://github.com/jbearak/raven/releases). See [Installation](#installation) for details.

Raven's sister project [Sight](https://github.com/jbearak/sight) implements a language server for Stata. Together they bring cross-file navigation, error detection, and code intelligence to two languages widely used in social science research.

## Quick Start

Raven tracks `source()` chains and understands scope. Consider this project:

```r
# main.R
source("utils.R")
result <- helper_function(42)  # Raven knows helper_function comes from utils.R
```

```r
# utils.R
helper_function <- function(x) { x * 2 }
```

When you open `main.R`, Raven:

1. Detects the `source("utils.R")` call
2. Indexes symbols from `utils.R`
3. Provides completions, hover, and go-to-definition for `helper_function`
4. Only shows `helper_function` as available *after* the `source()` line

For statically detectable `source()` patterns, opening `utils.R` directly is enough — Raven discovers that `main.R` sources it and resolves the chain in both directions.

## Features

### Code intelligence

- **[Completions](docs/completion.md)** — Symbols, packages, and function parameters — across files
- **Go-to-definition** — Jump to definitions across file boundaries
- **[Find references](docs/find-references.md)** — Locate all usages of a symbol across your project
- **Hover** — Symbol info including source file and package origin
- **[Diagnostics](docs/diagnostics.md)** — Undefined variable detection that understands sourced files and loaded packages
- **[Document outline](docs/document-outline.md)** — Hierarchical view with sections, classes, and nested functions
- **Workspace symbols** — Project-wide symbol search (Cmd/Ctrl+T)
- **File path intellisense** — Completions and cmd-click inside `source()` paths
- **[Smart indentation](docs/indentation.md)** — Context-aware auto-indent with RStudio-style alignment
- **[Cross-file awareness](docs/cross-file.md)** — Follows `source()` chains to resolve scope across files
- **[Directives](docs/directives.md)** — Declare relationships and symbols the analyzer can't infer
- **Syntax highlighting** — JAGS and Stan (R highlighting is built into VS Code)

### R session integration

- **[R console](docs/r-console.md)** — Interactive R console with statement detection and a temp-file fallback for large blocks; supports R, arf, and radian
- **[Plot viewer](docs/plot-viewer.md)** — Plots render in a VS Code panel via [httpgd](https://nx10.dev/httpgd/), with history navigation, save (PNG/SVG/PDF), and theme-aware background
- **[Data viewer](docs/data-viewer.md)** — `View(df)` opens a virtualized grid backed by Apache Arrow; viewport-based rendering keeps scrolling responsive on multi-million-row frames
- **[Help viewer](docs/help-viewer.md)** — Scope-aware R help: hovering shows the function in scope at the cursor instead of falling through to a multi-package list when scope can't be inferred

> [!NOTE]
> Raven also provides lightweight support for **JAGS** (`.jags`, `.bugs`) and **Stan** (`.stan`) files: syntax highlighting, completions (keywords, distributions, file-local symbols), go-to-definition, find references, and document outline with model structure navigation. See [Document Outline](docs/document-outline.md#jags-and-stan-model-structure).

## Documentation

**Code intelligence:**

- [Cross-File & Package Awareness](docs/cross-file.md) — How Raven understands multi-file projects
- [Directives](docs/directives.md) — All `@lsp-*` directive syntax
- [Diagnostics](docs/diagnostics.md) — What's reported and how to suppress
- [Completions](docs/completion.md) — What's offered and scope rules
- [Find References](docs/find-references.md) — Cross-file reference finding
- [Document Outline](docs/document-outline.md) — Hierarchical symbol view
- [Smart Indentation](docs/indentation.md) — AST-aware indentation styles

**R session integration:**

- [R Console](docs/r-console.md) — Interactive console, send-to-R commands, send method
- [Plot Viewer](docs/plot-viewer.md) — httpgd-backed plot panel
- [Data Viewer](docs/data-viewer.md) — Arrow-backed `View()` replacement
- [Help Viewer](docs/help-viewer.md) — Scope-aware R help

**Setup and reference:**

- [Editor Integrations](docs/editor-integrations.md) — VS Code, Zed, Neovim, AI agents
- [Configuration](docs/configuration.md) — All settings and options
- [Comparison](docs/comparison.md) — How Raven compares to other R tools

## Installation

**VS Code:** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r) or [OpenVSX](https://open-vsx.org/extension/jbearak/raven-r).

**Other editors:** Download a pre-built binary from the [releases page](https://github.com/jbearak/raven/releases), then run `raven --stdio` and connect via your editor's LSP client. See [Editor Integrations](docs/editor-integrations.md) for Zed, Neovim, and AI agent configurations.

**Build from source:** See [Development Notes](docs/development.md).

## How Raven Compares

For a detailed comparison with RStudio, Positron (Ark), and REditorSupport — covering both language intelligence and R session integration — see [docs/comparison.md](docs/comparison.md).

## Development

See [Development Notes](docs/development.md) for build/test, profiling, and internal architecture.

## Provenance

Raven includes code derived from [Ark](https://github.com/posit-dev/ark) (MIT License, Posit Software, PBC) — initial LSP wiring and tree-sitter scaffolding — and [Sight](https://github.com/jbearak/sight) (GPL-3.0) — the cross-file awareness system (directives + position-aware scope model). See [NOTICE](NOTICE) for full attribution.

## License

[GPL-3.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
