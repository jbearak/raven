# Configuration

All settings can be configured via VS Code settings or LSP initialization options. Search for "raven" in Settings (Cmd/Ctrl-,) to see all options.

## Diagnostics

| Setting | Default | Description |
|---|---|---|
| `raven.diagnostics.enabled` | `true` | Master switch for all diagnostics |
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Severity for undefined variable diagnostics (`"off"` to disable) |

## Cross-File Settings

| Setting | Default | Description |
|---|---|---|
| `raven.crossFile.indexWorkspace` | `true` | Enable background workspace indexing |
| `raven.crossFile.backwardDependencies` | `"auto"` | How backward dependencies are resolved. `"auto"`: infer from workspace scan. `"explicit"`: require `@lsp-sourced-by` directives. See [Backward Dependency Modes](cross-file.md#backward-dependency-modes) |
| `raven.crossFile.hoistGlobalsInFunctions` | `true` | Hoist global definitions inside function bodies (late-binding semantics). See [Global Symbol Hoisting](cross-file.md#global-symbol-hoisting) |
| `raven.crossFile.assumeCallSite` | `"end"` | Default call site when not specified by directive (`"end"` or `"start"`) |
| `raven.crossFile.maxBackwardDepth` | `10` | Maximum depth for backward directive traversal |
| `raven.crossFile.maxForwardDepth` | `10` | Maximum depth for forward source() traversal |
| `raven.crossFile.maxChainDepth` | `20` | Maximum total chain depth (emits diagnostic when exceeded) |
| `raven.crossFile.maxRevalidationsPerTrigger` | `10` | Max open documents to revalidate per change |
| `raven.crossFile.revalidationDebounceMs` | `200` | Debounce delay for dependent file diagnostics (ms) |
| `raven.crossFile.editedFileDebounceMs` | `50` | Debounce delay for the actively-edited file (ms) |

## Diagnostic Severity Settings

Each accepts: `"error"`, `"warning"`, `"information"`, `"hint"`, or `"off"`.

| Setting | Default | Description |
|---|---|---|
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Variable used but not defined in scope, sourced files, or loaded packages |
| `raven.crossFile.missingFileSeverity` | `"warning"` | Missing file referenced by source() or directive |
| `raven.crossFile.circularDependencySeverity` | `"error"` | Circular dependency detected |
| `raven.crossFile.maxChainDepthSeverity` | `"warning"` | Source chain exceeds max depth |
| `raven.crossFile.outOfScopeSeverity` | `"warning"` | Symbol used before it's in scope |
| `raven.crossFile.ambiguousParentSeverity` | `"warning"` | Multiple parents, can't determine which to use |
| `raven.crossFile.redundantDirectiveSeverity` | `"hint"` | Redundant @lsp-source directive |

## Package Settings

| Setting | Default | Description |
|---|---|---|
| `raven.packages.enabled` | `true` | Enable package function awareness |
| `raven.packages.rPath` | auto-detect | Path to R executable for subprocess calls |
| `raven.packages.additionalLibraryPaths` | `[]` | Additional R library paths for package discovery |
| `raven.packages.missingPackageSeverity` | `"warning"` | Severity for missing package diagnostics (`"off"` to disable) |
| `raven.packages.watchLibraryPaths` | `true` | Watch `.libPaths()` directories and invalidate caches on install/remove |
| `raven.packages.watchDebounceMs` | `500` | Coalesce rapid filesystem events into a single invalidation pass (ms) |

### Refresh Command

**Raven: Refresh package cache** (`raven.refreshPackages`) — re-runs `.libPaths()`, rebuilds the package library, restarts the filesystem watcher, clears the cache, and republishes diagnostics. Use after `renv::activate()`, `.libPaths()` changes, or if the watcher misses an event.

## Symbol Settings

| Setting | Default | Description |
|---|---|---|
| `raven.symbols.workspaceMaxResults` | `1000` | Maximum symbols returned by workspace symbol search (Cmd/Ctrl+T). Range: 100–10000. |

## Completion Settings

| Setting | Default | Description |
|---|---|---|
| `raven.completion.triggerOnOpenParen` | `true` | Register `(` as a completion trigger character for parameter suggestions |

## Indentation Settings

| Setting | Default | Description |
|---|---|---|
| `raven.indentation.style` | `"rstudio"` | Indentation style for R code |

Values:
- `"rstudio"` — Same-line arguments align to opening paren; next-line arguments indent from function line (matches RStudio default)
- `"rstudio-minus"` — All arguments indent relative to previous line, regardless of paren position
- `"off"` — Disables AST-aware indentation (Tier 2); only basic declarative rules remain

Raven sets `editor.formatOnType` to `true` for R files by default (lowest-priority VS Code default). This is required for Tier 2 indentation. Disable per-language:

```json
"[r]": {
  "editor.formatOnType": false
}
```

See [Smart Indentation](indentation.md) for details.

## Server Settings

| Setting | Default | Description |
|---|---|---|
| `raven.server.path` | bundled | Path to `raven` binary (if not using the bundled one) |
