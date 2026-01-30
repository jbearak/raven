# Rlsp

A static R Language Server with workspace symbol indexing for fast, dependency-free R development support.

## Quick Start

```bash
./setup.sh
```

## Features

- **Diagnostics** - Static code analysis and error detection
- **Go-to-definition** - Navigate to symbol definitions
- **Find references** - Locate all symbol usages
- **Completions** - Intelligent code completion
- **Hover** - Symbol information on hover
- **Document symbols** - Outline view for R files
- **Workspace indexing** - Project-wide symbol resolution
- **Package-aware analysis** - Understanding of R package structure

## Differences from Other R Language Servers

### vs Ark LSP
Rlsp is the extracted and focused LSP component from Ark. Ark includes additional features like Jupyter kernel support and Debug Adapter Protocol (DAP), while Rlsp focuses solely on language server functionality.

### vs R Language Server
Rlsp provides static analysis without requiring an R runtime, while the R Language Server uses dynamic introspection with a running R session. This makes Rlsp faster to start and more suitable for environments without R installed.

## Why Use Rlsp

- **Fast startup** - No R runtime initialization required
- **No R dependencies** - Works without R installation for basic features
- **Workspace-wide symbol resolution** - Understands your entire project structure
- **Package-aware diagnostics** - Intelligent analysis of R package code

## Installation

### Building from Source
```bash
git clone <repository-url>
cd rlsp
./setup.sh
```

### Download from Releases
Pre-built binaries are available from the [releases page](../../releases).

## Releases

Releases use semantic versioning with git tags. Creating a tag in the format `vX.Y.Z` automatically triggers CI to build and publish a new release.

## Attribution

**Rlsp is extracted from [Ark's](https://github.com/posit-dev/ark) static LSP implementation.** We gratefully acknowledge the Ark project for providing the foundation for this language server.

**Inspired by and complementary to the [R Language Server](https://github.com/REditorSupport/languageserver).** Both projects serve the R community with different approaches to language server functionality.

## License

MIT License