# Configuration

Most settings are exposed as VS Code settings — search for "raven" in Settings (Cmd/Ctrl-,). A handful of advanced server-side knobs are only available via LSP initialization options; those are noted in the tables below.

## Diagnostics

| Setting | Default | Description |
|---|---|---|
| `raven.diagnostics.enabled` | `true` | Master switch for all diagnostics |

## Cross-File Settings

| Setting | Default | Description |
|---|---|---|
| `raven.crossFile.indexWorkspace` | `true` | Enable background workspace indexing |
| `raven.crossFile.backwardDependencies` | `"auto"` | How backward dependencies are resolved. `"auto"`: infer from workspace scan. `"explicit"`: require `@lsp-sourced-by` directives. See [Backward Dependency Modes](cross-file.md#backward-dependency-modes) |
| `raven.crossFile.hoistGlobalsInFunctions` | `true` | Hoist global definitions inside function bodies (late-binding semantics). See [Global Symbol Hoisting](cross-file.md#global-symbol-hoisting). *LSP init-only — not exposed in the VS Code Settings UI.* |
| `raven.crossFile.assumeCallSite` | `"end"` | Default call site when not specified by directive (`"end"` or `"start"`) |
| `raven.crossFile.maxBackwardDepth` | `10` | Maximum depth for backward directive traversal |
| `raven.crossFile.maxForwardDepth` | `10` | Maximum depth for forward source() traversal |
| `raven.crossFile.maxChainDepth` | `20` | Maximum total chain depth (emits diagnostic when exceeded) |
| `raven.crossFile.maxRevalidationsPerTrigger` | `10` | Max open documents to revalidate per change |
| `raven.crossFile.revalidationDebounceMs` | `200` | Debounce delay for dependent file diagnostics (ms) |
| `raven.crossFile.editedFileDebounceMs` | `50` | Debounce delay for the actively-edited file (ms). *LSP init-only — not exposed in the VS Code Settings UI.* |

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
| `raven.packages.rPath` | auto-detect | Path to R executable for subprocess calls. Must point to vanilla `R` — not `radian` or `arf`, which are interactive REPL wrappers and cannot run the non-interactive scripts Raven uses for package introspection. For the interactive terminal program, see [`raven.rTerminal.program`](r-console.md#choosing-the-r-program). |
| `raven.packages.additionalLibraryPaths` | `[]` | Additional R library paths for package discovery |
| `raven.packages.missingPackageSeverity` | `"warning"` | Severity for missing package diagnostics (`"off"` to disable) |
| `raven.packages.watchLibraryPaths` | `true` | Watch `.libPaths()` directories and invalidate caches on install/remove |
| `raven.packages.watchDebounceMs` | `500` | Coalesce rapid filesystem events into a single invalidation pass (ms) |
| `raven.packages.packageMode` | `"auto"` | R package workspace mode: `"auto"` (detect DESCRIPTION), `"enabled"` (always), `"disabled"` (never). See [R Package Development](r-package-dev.md). |

### Refresh Command

**Raven: Refresh package cache** (`raven.refreshPackages`) — re-runs `.libPaths()`, rebuilds the package library, restarts the filesystem watcher, clears the cache, and republishes diagnostics. Use after `renv::activate()`, `.libPaths()` changes, or if the watcher misses an event.

## Scaffold Commands

These Command Palette entries write starter R config files to the first workspace folder. If the target file already exists, Raven prompts before overwriting.

| Command | File | Contents |
|---|---|---|
| `Raven: Create .gitignore` | `.gitignore` | Standard R ignores (`.Rhistory`, `.RData`, `.Rproj.user/`), OS files (`.DS_Store`, `Thumbs.db`), R Markdown/Quarto/`R CMD check` artifacts, local scratch dirs, and AI-tool user-local overrides |
| `Raven: Create .lintr` | `.lintr` | `linters_with_defaults(line_length_linter(120))` |

## R Console Activation

| Setting | Default | Description |
|---|---|---|
| `raven.rConsole.activation` | `"auto"` | When Raven's R console (and the plot and data viewers it powers) activates. `"enabled"`: always activate. `"disabled"`: never activate. `"auto"`: activate unless the REditorSupport (R) extension is enabled or VS Code is running as Positron. See [R Console](r-console.md) and [Coexistence](coexistence.md). |

## Plot Settings

| Setting | Default | Description |
|---|---|---|
| `raven.plot.viewerColumn` | `beside` | Initial editor column for an R session's plot viewer panel when its first plot arrives. Once you move the panel, Raven leaves it in its new location. Values: `active`, `beside`. See [Plot Viewer](plot-viewer.md). |

## Help Viewer Settings

| Setting | Default | Description |
|---|---|---|
| `raven.help.viewerColumn` | `beside` | Initial editor column when the R help viewer first opens. Once you move the panel, Raven leaves it where you put it. Values: `active`, `beside`. See [Help Viewer](help-viewer.md). |

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
