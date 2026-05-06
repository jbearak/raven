# Comparison with Other R Language Servers

This page compares Raven with other tools that provide R language intelligence.

| Feature | Raven | RStudio IDE | Positron (Ark) | REditorSupport/languageserver |
|---|---|---|---|---|
| **Cross-file awareness** | `source()`-aware: follows `source()` chains and `@lsp-*` directives, builds a dependency graph, position-aware scope | Workspace function-symbol index (for "Go to File/Function") plus runtime view of `globalenv()` | Workspace-wide tree-sitter indexer of top-level symbols (functions, variables, R6/S7 methods); does not trace `source()` chains | Workspace-wide indexer of top-level symbols across files; does not trace `source()` chains |
| **Diagnostics** | Static: undefined variables, missing packages, circular deps, scope violations | Built-in static "Code Diagnostics" (style/syntax warnings) + runtime errors on execution | Static: scope-aware undefined-symbol, namespace, and missing-package checks, plus runtime errors from the live R kernel | Static: style + correctness linting via `lintr` (e.g. `object_usage_linter` flags undefined globals via `codetools::checkUsage()`); no independent syntax/parse diagnostics |
| **Completions** | Scope-aware static: in-file scope + cross-file (dep-graph) + package exports, position-filtered | Mostly runtime: `globalenv()` and search path, plus function-argument hints; static for current-file local symbols | In-file scope-aware static + flat workspace top-level symbols across files + runtime helpers (e.g. `.DollarNames()` for `$`, slot lookup for `@`) | Static, scope-aware: in-file scope + workspace top-level symbols + installed package signatures |
| **`$` / `@` accessor** | Static completions and go-to-definition against tracked list/data-frame/S4 shapes | Runtime column completion when the object exists in `globalenv()`; no cross-file def/refs | Runtime completions via `.DollarNames()` / slot lookup (requires a live R session); no static defs or refs for accessor RHS | Limited and inconsistent (see [issue #360](https://github.com/REditorSupport/languageserver/issues/360)) |
| **Go-to-definition** | Cross-file (functions and variables) via dep graph | Cross-file but **functions only** (`Code > Go to Function Definition`); no go-to-def for ordinary variable bindings | Cross-file for functions and top-level variables via the workspace indexer | Cross-file via workspace symbols (functions and top-level variables) |
| **Find references** | Cross-file via dep graph | Not supported (only "Find in Files" text search and scope-local rename) | Cross-file via the workspace indexer | Cross-file via workspace symbols |
| **Package awareness** | Static NAMESPACE parsing + on-demand R subprocess for exports; position-aware | Full runtime access via embedded R session | Runtime (live R kernel) + tree-sitter detection of `library()` / `require()` calls | Runtime helpers from the in-process R session for installed package signatures |
| **Language / runtime** | Rust, no R session required | C++/Qt desktop bundled with an embedded R session | Rust LSP + R kernel (Ark binds to R's C API) | R package, runs inside an R session |
| **Editor support** | Any LSP client (VS Code, Zed, Neovim, etc.) | RStudio only | Positron only (LSP not currently exposed to other clients) | Any LSP client (vscode-R, ESS, Sublime, etc.) |
| **Performance model** | Fast startup, low memory; no R session overhead | Tied to R session lifetime | Tied to R kernel startup | Tied to R session startup |

## When to choose Raven

Raven is the only R LSP that traces `source()` chains across a project: it builds a dependency graph and resolves what's in scope at each cursor position based on the actual order of execution, rather than treating the workspace as one flat symbol set. That makes its completions, diagnostics, and navigation correct for multi-file scripted projects, including circular-dependency and scope-violation detection. All of it works statically, without an R session.

## Coexistence

Raven can run alongside other R extensions. See [Editor Integrations](editor-integrations.md) for setup details. In VS Code, you can keep [vscode-R](https://github.com/REditorSupport/vscode-R) installed for its interactive features (running code, viewing plots) while using Raven for code intelligence:

```json
"r.lsp.enabled": false
```
