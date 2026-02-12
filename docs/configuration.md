# Configuration

All settings can be configured via VS Code settings or LSP initialization options.

## Cross-File Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.crossFile.maxBackwardDepth` | 10 | Maximum depth for backward directive traversal |
| `raven.crossFile.maxForwardDepth` | 10 | Maximum depth for forward source() traversal |
| `raven.crossFile.maxChainDepth` | 20 | Maximum total chain depth (emits diagnostic when exceeded) |
| `raven.crossFile.assumeCallSite` | "end" | Default call site when not specified ("end" or "start") |
| `raven.crossFile.indexWorkspace` | true | Enable workspace file indexing |
| `raven.crossFile.maxRevalidationsPerTrigger` | 10 | Max open documents to revalidate per change |
| `raven.crossFile.revalidationDebounceMs` | 200 | Debounce delay for cross-file diagnostics (ms) |
| `raven.crossFile.hoistGlobalsInFunctions` | true | Hoist global definitions inside function bodies (see [Global Symbol Hoisting](cross-file.md#global-symbol-hoisting)) |

## Diagnostic Severity Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.crossFile.missingFileSeverity` | "warning" | Severity for missing file diagnostics (`"off"` to disable) |
| `raven.crossFile.circularDependencySeverity` | "error" | Severity for circular dependency diagnostics (`"off"` to disable) |
| `raven.crossFile.maxChainDepthSeverity` | "warning" | Severity for max chain depth exceeded diagnostics (`"off"` to disable) |
| `raven.crossFile.outOfScopeSeverity` | "warning" | Severity for out-of-scope symbol diagnostics (`"off"` to disable) |
| `raven.crossFile.ambiguousParentSeverity` | "warning" | Severity for ambiguous parent diagnostics (`"off"` to disable) |
| `raven.crossFile.redundantDirectiveSeverity` | "hint" | Severity for redundant @lsp-source directives (`"off"` to disable) |
| `raven.diagnostics.undefinedVariables` | true | Enable undefined variable diagnostics |

## Package Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.packages.enabled` | true | Enable/disable package function awareness |
| `raven.packages.additionalLibraryPaths` | [] | Additional R library paths for package discovery |
| `raven.packages.rPath` | auto-detect | Path to R executable for subprocess calls |
| `raven.packages.missingPackageSeverity` | "warning" | Severity for missing package diagnostics (`"off"` to disable) |

## Symbol Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.symbols.workspaceMaxResults` | 1000 | Maximum number of symbols returned by workspace symbol search (Ctrl+T). Valid range: 100-10000. Values outside this range are clamped to the nearest boundary. |

## Completion Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.completion.triggerOnOpenParen` | true | Register `(` as a completion trigger character so parameter suggestions appear when opening a function call. Set to `false` to disable. |

## Indentation Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `raven.indentation.style` | "rstudio" | Indentation style for R code. Controls AST-aware (Tier 2) indentation behavior. See [Smart Indentation](indentation.md) for details. |

`raven.indentation.style` accepts one of:
- `"rstudio"` — Same-line arguments align to opening paren; next-line arguments indent from function line (matches the RStudio IDE default)
- `"rstudio-minus"` — All arguments indent relative to previous line, regardless of paren position
- `"off"` — Disables AST-aware indentation (Tier 2); only basic declarative rules (Tier 1) remain active

Raven also sets `editor.formatOnType` to `true` for R files by default (lowest-priority VS Code default — your explicit settings take precedence). This is required for Tier 2 indentation to function. You can disable it per-language:

```json
"[r]": {
  "editor.formatOnType": false
}
```

## Severity Values

All severity settings accept one of:
- `"error"` - Displayed as error (red squiggle)
- `"warning"` - Displayed as warning (yellow squiggle)
- `"information"` - Displayed as info (blue squiggle)
- `"hint"` - Displayed as hint (subtle indicator)
- `"off"` - Diagnostic disabled
