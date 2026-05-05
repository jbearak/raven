# Comparison with Other R Language Servers

This page compares Raven with other tools that provide R language intelligence.

| Feature | Raven | RStudio IDE | Positron (Ark) | REditorSupport/languageserver |
|---|---|---|---|---|
| **Cross-file awareness** | Full: follows `source()` chains, builds dependency graph, position-aware scope | Limited: autocomplete sees workspace objects at runtime | Limited: runtime object inspection | None: each file analyzed independently |
| **Diagnostics** | Static: undefined variables, missing packages, circular deps, scope violations | Runtime: errors on execution | Runtime: errors on execution | Static: basic linting via `lintr` |
| **Completions** | Scope-aware: local + cross-file + package exports (position-filtered) | Runtime: objects in global environment | Runtime: objects in global environment | Static: file-local + installed packages |
| **Go-to-definition** | Cross-file: follows source() chains to find definitions | Within-file only | Within-file + runtime objects | Within-file only |
| **Find references** | Cross-file: dep-graph-reachable files | Within-file only | Within-file only | Within-file only |
| **Package awareness** | Static NAMESPACE parsing + R subprocess for exports; position-aware | Full runtime access | Full runtime access | Static: installed package signatures |
| **Language / runtime** | Rust (no R session required) | R (embedded session) | Rust + R (embedded session) | R (runs inside R session) |
| **Editor support** | Any LSP client (VS Code, Zed, Neovim, etc.) | RStudio only | Positron only | Any LSP client |
| **Performance model** | Fast startup, low memory; no R session overhead | Tied to R session | Tied to R session | Tied to R session startup |

## When to choose Raven

Raven provides scope-aware analysis for R — completions, diagnostics, and navigation that understand what's defined at each point in your code. For multi-file projects, it additionally follows `source()` chains and tracks package loading across files. All of this works statically, without running R.

## Coexistence

Raven can run alongside other R extensions. See [Editor Integrations](editor-integrations.md) for setup details. In VS Code, you can keep [vscode-R](https://github.com/REditorSupport/vscode-R) installed for its interactive features (running code, viewing plots) while using Raven for code intelligence:

```json
"r.lsp.enabled": false
```
