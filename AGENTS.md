# AGENTS.md - LLM Guidance for Rlsp

## Project Overview

Rlsp is a static R Language Server extracted from Ark. It provides LSP features without embedding R runtime. Uses tree-sitter for parsing, subprocess calls for help.

## Repository Structure

- `crates/rlsp/`: Main LSP implementation
- `editors/vscode/`: VS Code extension
- `Cargo.toml`: Workspace root
- `setup.sh`: Build and install script

## Build Commands

- `cargo build -p rlsp` - Debug build
- `cargo build --release -p rlsp` - Release build
- `cargo test -p rlsp` - Run tests
- `./setup.sh` - Build and install everything

## LSP Architecture

- Static analysis using tree-sitter-r
- Workspace symbol indexing (functions, variables)
- Package awareness (library() calls, NAMESPACE)
- Help via R subprocess (tools::Rd2txt)
- Thread-safe caching (RwLock)

## VS Code Extension

- TypeScript client in `editors/vscode/src/`
- Bundles platform-specific rlsp binary
- Configuration: `rlsp.server.path`

## Coding Style

- No `bail!`, use explicit `return Err(anyhow!(...))`
- Omit `return` in match expressions
- Direct formatting: `anyhow!("Message: {err}")`
- Use `log::trace!` instead of `log::debug!`
- Fully qualified result types

## Testing

Property-based tests with proptest, integration tests

## Built-in Functions

`build_builtins.R` generates `src/builtins.rs` with 2,355 R functions

## Release Process

Manual tagging (`git tag vX.Y.Z && git push origin vX.Y.Z`) triggers GitHub Actions