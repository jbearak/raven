# Raven - Language Server for R

An open-source [Language Server Protocol (LSP)](https://github.com/Microsoft/language-server-protocol) implementation for R, with a corresponding extension for [VS Code](https://github.com/Microsoft/vscode).

> **tl;dr**: Raven brings **cross-file intelligence** to R coding. It follows `source()` chains to provide **workspace-wide completions**, **go-to-definition across files**, **position-aware scope resolution**, and **diagnostics that understand your project structure** — all without running R.

> **Status:** Raven is under active development. It works well for day-to-day use but hasn't been widely announced yet. Bug reports and feedback are welcome!

> **Quick Start:** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r) or [OpenVSX](https://open-vsx.org/extension/jbearak/raven-r), or download from the [releases page](https://github.com/jbearak/raven/releases). See [Installation](#installation) for details.

Raven works with VS Code, its forks, and any editor with an LSP client. Raven's sister project [Sight](https://github.com/jbearak/sight) implements a language server for Stata. Together they bring cross-file navigation, error detection, and code intelligence to two languages widely used in social science research.

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

And if you open `utils.R` directly, Raven automatically discovers that `main.R` sources it and resolves the full chain in both directions — no configuration needed.

## Features

- **[Completions](docs/completion.md)** — Symbols, packages, and function parameters — across files
- **Go-to-definition** — Jump to definitions across file boundaries
- **[Find references](docs/find-references.md)** — Locate all usages of a symbol across your project
- **Hover** — Symbol info including source file and package origin
- **[Diagnostics](docs/diagnostics.md)** — Undefined variable detection that understands sourced files and loaded packages
- **[Document outline](docs/document-outline.md)** — Hierarchical view with sections, classes, and nested functions
- **Workspace symbols** — Project-wide symbol search (Cmd/Ctrl+T)
- **File path intellisense** — Completions and cmd-click inside `source()` paths
- **[Smart indentation](docs/indentation.md)** — Context-aware auto-indent with RStudio-style alignment
- **[Send to R](docs/send-to-r.md)** — Interactive R console with statement detection and radian support
- **[Cross-file awareness](docs/cross-file.md)** — Follows `source()` chains to resolve scope across files
- **[Directives](docs/directives.md)** — Declare relationships and symbols the analyzer can't infer
- **Syntax highlighting** — JAGS and Stan (R highlighting is built into VS Code)
- **Bundled binary** — No separate installation needed in VS Code

> [!NOTE]
> Raven also provides lightweight support for **JAGS** (`.jags`, `.bugs`) and **Stan** (`.stan`) files: syntax highlighting, completions (keywords, distributions, file-local symbols), go-to-definition, find references, and document outline with model structure navigation. See [Document Outline](docs/document-outline.md#jags-and-stan-model-structure).

## Documentation

- [Cross-File & Package Awareness](docs/cross-file.md) — How Raven understands multi-file projects
- [Directives](docs/directives.md) — All `@lsp-*` directive syntax
- [Diagnostics](docs/diagnostics.md) — What's reported and how to suppress
- [Completions](docs/completion.md) — What's offered and scope rules
- [Find References](docs/find-references.md) — Cross-file reference finding
- [Document Outline](docs/document-outline.md) — Hierarchical symbol view
- [Smart Indentation](docs/indentation.md) — AST-aware indentation styles
- [Editor Integrations](docs/editor-integrations.md) — VS Code, Zed, Neovim, AI agents
- [Configuration](docs/configuration.md) — All settings and options
- [Comparison](docs/comparison.md) — How Raven compares to other R tools

## Installation

**VS Code:** Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jbearak.raven-r) or [OpenVSX](https://open-vsx.org/extension/jbearak/raven-r).

**Other editors:** Download a pre-built binary from the [releases page](https://github.com/jbearak/raven/releases), then run `raven --stdio` and connect via your editor's LSP client. See [Editor Integrations](docs/editor-integrations.md) for Zed, Neovim, and AI agent configurations.

**Build from source:** See [Development Notes](docs/development.md).

## How Raven Compares

Raven is a static analysis tool that provides scope-aware intelligence for R — without requiring a running R session. For a detailed feature comparison with RStudio, Positron (Ark), and REditorSupport/languageserver, see [docs/comparison.md](docs/comparison.md).

## Development

See [Development Notes](docs/development.md) for build/test, profiling, and internal architecture.

## Provenance

Raven includes code derived from [Ark](https://github.com/posit-dev/ark) (MIT License, Posit Software, PBC) — initial LSP wiring and tree-sitter scaffolding — and [Sight](https://github.com/jbearak/sight) (GPL-3.0) — the cross-file awareness system (directives + position-aware scope model). See [NOTICE](NOTICE) for full attribution.

## License

[GPL-3.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
