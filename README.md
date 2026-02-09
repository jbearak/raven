# Raven

A static R Language Server with cross-file awareness for scientific research workflows.

## Installation

### Building from Source
```bash
git clone <repository-url>
cd raven
./setup.sh
```

### Download from Releases
Pre-built binaries are available from the [releases page](../../releases).

### Editor Setup

Raven is a standard Language Server Protocol (LSP) server. This repository includes a VS Code extension, but the binary works with any editor that supports LSP.

**VS Code:** The extension is bundled with the binary. After running `setup.sh`, reload VS Code to activate.

**Zed:** Add to your `settings.json`:
```json
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
4. Only shows `helper_function` as available *after* the source() line

For files that aren't explicitly sourced, add a directive:
```r
# child.R
# @lsp-sourced-by ../main.R
# Now Raven knows this file's context
```

## When to Use Raven

Raven is a static R language server. What sets it apart is cross-file awareness: symbol resolution across `source()` chains, position-aware scope, and "undefined variable" diagnostics that span file boundaries.

Raven can be used **alongside** other R extensions. In VS Code with the [vscode-R](https://github.com/REditorSupport/vscode-R) extension (which includes the [R Language Server](https://github.com/REditorSupport/languageserver)), you may want to adjust two settings:

- **Disable R-LS diagnostics** to avoid overlap with Raven's cross-file diagnostics:
  ```json
  "r.lsp.diagnostics": false
  ```
- **Push snippets below LSP completions** to reduce duplicate completion entries (VS Code doesn't deduplicate across providers):
  ```json
  "editor.snippetSuggestions": "bottom"
  ```

Neither setting is required — Raven works fine without them.

| Feature | Raven | [Ark](https://github.com/posit-dev/ark) | [R Language Server](https://github.com/REditorSupport/languageserver) |
|---------|-------|-----|-------------------|
| Cross-file `source()` tracking | Yes | No | No |
| Position-aware scope | Yes | No | No |
| Workspace symbol indexing | Yes | Completions only | Open files only |
| Editor support | Any LSP-capable editor | Positron only | VS Code |
| Package export awareness | Yes | Yes | Yes |

## Features

- **Cross-file awareness** - Symbol resolution across `source()` chains with position-aware scope
- **Declaration directives** - Suppress diagnostics for dynamically-created symbols (`@lsp-var`, `@lsp-func`) that cannot be statically detected
- **Diagnostics** - Undefined variable detection that understands sourced files
- **Go-to-definition** - Navigate to symbol definitions across file boundaries
- **Find references** - Locate all symbol usages project-wide
- **Completions** - Intelligent completion including symbols from sourced files
- **Hover** - Symbol information on hover
- **Document symbols** - Hierarchical outline view with R code section support (`# Section ----`), S4/R6 class detection, and nested function display
- **Workspace symbols** - Fast project-wide symbol search (Ctrl+T) with configurable result limits
- **Workspace indexing** - Background indexing of your entire project
- **Package awareness** - Recognition of `library()` calls and package exports

## Documentation

- [Cross-File Awareness](docs/cross-file.md) - Directives, source() detection, symbol resolution
- [Declaration Directives](docs/declaration-directives.md) - @lsp-var, @lsp-func for dynamically-created symbols
- [Package Function Awareness](docs/packages.md) - library() support, meta-packages, base packages
- [Configuration](docs/configuration.md) - All settings and options
- [Development Notes](docs/development.md) - Build/test, profiling, and internal architecture notes

## Provenance

Raven combines code from two sources:

**[Ark](https://github.com/posit-dev/ark)** (MIT License, Posit Software, PBC) - Raven began as a fork of Ark's LSP component. The core LSP infrastructure derives from Ark.

**[Sight](https://github.com/jbearak/sight)** (GPL-3.0) - The cross-file awareness system was ported from Sight, a Stata language server with similar goals.

Both Sight and Raven were written by the same author to address the same problem: scientific research codebases that span many files.

## License

[GPL-3.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
