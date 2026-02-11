# Raven - Language Server for R

An open-source [Language Server Protocol (LSP)](https://github.com/Microsoft/language-server-protocol) implementation for the R statistical programming language, with a corresponding extension for [VS Code](https://github.com/Microsoft/vscode).

> **tl;dr**: Raven brings **cross-file intelligence** to R coding. Unlike language servers that treat each file in isolation, Raven follows `source()` chains to provide **workspace-wide completions**, **go-to-definition across files**, **position-aware scope resolution**, and **diagnostics that understand your project structure**.
>
> **Development Status:** Raven is an early-stage implementation. While functional, it requires substantial testing and code review. Contributions and feedback are welcome!
>
> **Quick Start:** Download from the [releases page](https://github.com/jbearak/raven/releases), or clone the repo and build from source (`cargo build --release -p raven`). See [Installation](#installation) for details.

Raven works with VS Code, its forks (Antigravity, Cursor, Kiro, Positron, and Windsurf), and any editor with an LSP client. This repository contains the language server and a VS Code extension that activates it. Raven can run alongside existing R extensions like [vscode-R](https://github.com/REditorSupport/vscode-R) — see [Raven vs Ark vs R Language Server](#raven-vs-ark-vs-r-language-server) for how they compare and coexist.

Raven’s sister project [Sight](https://github.com/jbearak/sight) implements a language server, syntax highlighting, and code execution for Stata. Together they bring cross-file navigation, error detection, and code intelligence to two languages widely used in social science research.

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

But if you open `utils.R` directly, Raven doesn’t know which file sources it. Add a directive to tell it:

```r
# utils.R
# @lsp-sourced-by main.R
helper_function <- function(x) { x * 2 }
```

Now Raven resolves the full chain in both directions. See [Cross-File Awareness](docs/cross-file.md) for more directives and dynamic-path handling.

## Installation

### Download from Releases

Pre-built binaries are available from the [releases page](https://github.com/jbearak/raven/releases).

### Editor Setup

Raven runs over stdio (`raven --stdio`) and works with any LSP-capable editor.

**VS Code:** Install the extension (which bundles the binary) from the [releases page](../../releases). Marketplace and OpenVSX publishing is planned but not yet available.

**Zed:** Add to your `settings.json`:

```json
"languages": {
  "R": {
    "language_servers": ["r_language_server"],
    "enable_language_server": true
  }
},
"lsp": {
  "r_language_server": {
    "binary": {
      "path": "/path/to/raven",
      "arguments": ["--stdio"]
    }
  }
}
```

**Other editors:** Run `raven --stdio` and connect via your editor's LSP client.

## Raven vs Ark vs R Language Server

- **[R Language Server](https://github.com/REditorSupport/languageserver)** is the most established general-purpose R LSP.
- **[Ark](https://github.com/posit-dev/ark)** is the R LSP used by **Positron**.

Raven is an alternative focused on cross-file scope, diagnostics, and navigation for multi-file R projects.

### VS Code with the vscode-R extension

The [vscode-R](https://github.com/REditorSupport/vscode-R) extension provides useful features beyond its bundled language server (running R code, viewing plots, etc.). You can leave vscode-R's language server enabled alongside Raven (vscode-R provides formatting diagnostics, Raven provides code diagnostics), or disable it to avoid duplicate completions:

```json
"r.lsp.enabled": false
```

You may also want to push snippets below LSP completions to reduce duplicate entries:

```json
"editor.snippetSuggestions": "bottom"
```

## Features

- **Cross-file awareness** - Symbol resolution across `source()` chains with position-aware scope
- **Declaration directives** - Suppress diagnostics for dynamically-created symbols (`@lsp-var`, `@lsp-func`) that cannot be statically detected
- **Diagnostics** - Scope-aware undefined variable detection that understands sourced files
- **Go-to-definition** - Navigate to symbol definitions across file boundaries
- **Find references** - Locate all symbol usages project-wide
- **Completions** - Workspace-aware completion including symbols from sourced files and loaded packages
- **Function signatures** - Parameter completion and richer function signature hovers
- **Hover** - Symbol information on hover
- **Document symbols** - Hierarchical outline view with R code section support (`# Section ----`), S4/R6 class detection, and nested function display
- **Workspace symbols** - Fast project-wide symbol search (Ctrl+T) with configurable result limits
- **Workspace indexing** - Background indexing of your entire project
- **Smart indentation** - AST-aware auto-indentation with RStudio-style alignment on Enter
- **Package awareness** - Recognition of `library()` calls and package exports

## Documentation

- [Cross-File Awareness](docs/cross-file.md) - Directives, `source()` detection, symbol resolution
- [Declaration Directives](docs/declaration-directives.md) - `@lsp-var`, `@lsp-func` for dynamically-created symbols
- [Package Function Awareness](docs/packages.md) - `library()` support, meta-packages, base packages
- [Smart Indentation](docs/indentation.md) - AST-aware auto-indentation styles and configuration
- [Configuration](docs/configuration.md) - All settings and options

## Development

See [Development Notes](docs/development.md) for build/test, profiling, and internal architecture notes.

## Provenance

Raven includes code derived from two sources:

- **[Ark](https://github.com/posit-dev/ark)** (MIT License, Posit Software, PBC)
  - Raven began as a fork of Ark’s static R language server (`ark-lsp`), inheriting the initial LSP server wiring and tree-sitter-based parsing/handler scaffolding (since modified).
  - See [NOTICE](NOTICE) for the Ark attribution and license text.

- **[Sight](https://github.com/jbearak/sight)** (GPL-3.0)
  - Raven’s cross-file awareness system (directives + position-aware timeline/scope model) was ported from Sight, a Stata language server with similar goals.

Raven and Sight are complementary projects addressing the same problem — navigating large, multi-file scientific codebases — across two languages widely used in social science research.

## License

[GPL-3.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
