# Configuration

Most settings are exposed as VS Code settings — search for "raven" in Settings (Cmd/Ctrl-,). A handful of advanced server-side knobs are only available via LSP initialization options; those are noted in the tables below.

> Looking for a specific key? See [Settings reference](settings-reference.md) for an alphabetical index of every `raven.*` setting with default, type, `raven.toml` path, and a one-line description. The sections below add context: when each setting matters, how the project file interacts with VS Code settings, and which knobs hang together.

## Project config: `raven.toml`

The recommended way to configure Raven is a `raven.toml` file at the project root. Every editor and the `raven lint` CLI read this file, so a single committed config governs both interactive editing and CI.

### Discovery

Raven walks upward from each workspace folder looking for `raven.toml`. If none is found, `.lintr` is read for linting settings only (subset; see [Linting](linting.md#migrating-from-lintr)).

### Precedence

Per-key. For each setting, project values win over the LSP client's `initializationOptions` / `did_change_configuration` payload. Keys not pinned by the project file continue to come from client settings (or Raven's defaults if neither layer specifies them).

### Schema

The TOML mirrors the LSP `initializationOptions` shape 1:1. The reference tables below cover every key the server reads from `raven.toml` (top-level sections: `linting`, `crossFile`, `packages`, `diagnostics`, `indentation`, `symbols`, `completion`), plus a handful of VS Code-only settings whose behavior is most useful to document alongside them (R-console activation, plot/help viewer columns, the word-separator opt-in, and the server-binary override). Other VS Code-only client settings — `raven.sendToR.*`, `raven.rTerminal.*`, `raven.dataViewer.*`, `raven.chunks.*`, `raven.knit.*` — only apply inside VS Code and aren't read from `raven.toml`; they're documented on their feature pages ([R Console](r-console.md), [Data Viewer](data-viewer.md), [Chunks](chunks.md), [Knit](knit.md)). `raven.trace.server` is the standard `vscode-languageclient` LSP-trace setting (`off` / `messages` / `verbose`) — useful when filing bug reports, but otherwise not Raven-specific. The same key in `raven.toml` is at the path indicated.

```toml
[linting]
enabled = true
lineLength = 100
lineLengthSeverity = "warning"

[[linting.overrides]]
files = ["tests/**/*.R"]
lineLength = 120

[crossFile]
# tighter than the default of 20
maxChainDepth = 10

[packages]
enabled = true

[diagnostics]
undefinedVariableSeverity = "warning"
```

### Per-file overrides

`[[linting.overrides]]` is an array of glob → patch entries. Globs are anchored at the project root. Order matters: later entries win on conflicts. Setting `enabled = false` in an override skips matching files entirely.

### Live reload

Edits to `raven.toml` (or `.lintr`) are picked up live for every section: `[linting]` (including `overrides`), `[crossFile]`, `[packages]` (including `packageMode`, `watchLibraryPaths`, `watchDebounceMs`), `[diagnostics]`, `[indentation]`, `[symbols]`, `[completion]`. Open documents re-publish diagnostics automatically — no Raven restart required.

Package-affecting changes (toggling `[packages].enabled`, `packageMode`, `rPath`, `additionalLibraryPaths`, or the watcher knobs) reuse the same reconciliation path as `workspace/didChangeConfiguration`: the package library is rebuilt via R if needed, the libpath watcher is restarted, and any updated completion-trigger registration is re-applied — all asynchronously, off the LSP write lock.

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

### Background indexing

| Setting | Default | Description |
|---|---|---|
| `raven.crossFile.onDemandIndexing.enabled` | `true` | Index files referenced by `source()` / directives that aren't currently open, so cross-file features work without opening every dependency |
| `raven.crossFile.onDemandIndexing.maxTransitiveDepth` | `2` | How deep to follow transitive dependencies (files sourced by sourced files) when indexing in the background |
| `raven.crossFile.onDemandIndexing.maxQueueSize` | `50` | Cap on files queued for background indexing at once |

### Cache sizes

LRU-evicted; raise these if you have a very large workspace and see repeated re-indexing, lower them to reduce memory. The minimums quoted below are the lower bounds enforced by the VS Code Settings UI; the server itself only clamps each cache to a minimum of `1`, so `raven.toml` and other LSP clients can go lower if they really want to.

| Setting | Default | Description |
|---|---|---|
| `raven.crossFile.cache.metadataMaxEntries` | `1000` | Parsed file metadata (directives, source calls). VS Code UI minimum `100`. |
| `raven.crossFile.cache.fileContentMaxEntries` | `500` | Full file text used during resolution. VS Code UI minimum `50`. |
| `raven.crossFile.cache.existenceMaxEntries` | `2000` | Cached `Path::exists` results for resolved references. VS Code UI minimum `100`. |
| `raven.crossFile.cache.workspaceIndexMaxEntries` | `5000` | Closed-file entries in the cross-file workspace index (parsed metadata + scope artifacts). VS Code UI minimum `100`. |

## Diagnostic Severity Settings

Each accepts: `"error"`, `"warning"`, `"information"`, `"hint"`, or `"off"`.

| Setting | Default | Description |
|---|---|---|
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Variable used but not defined in scope, sourced files, or loaded packages |
| `raven.crossFile.missingFileSeverity` | `"warning"` | Missing file referenced by source() or directive |
| `raven.crossFile.circularDependencySeverity` | `"error"` | Circular dependency detected |
| `raven.crossFile.maxChainDepthSeverity` | `"warning"` | Source chain exceeds max depth |
| `raven.crossFile.outOfScopeSeverity` | `"warning"` | Symbol used before it's in scope |
| `raven.crossFile.redundantDirectiveSeverity` | `"hint"` | Redundant `@lsp-source` directive |
| `raven.diagnostics.mixedLogicalSeverity` | `"warning"` | `\|` / `\|\|` whose immediate operand is a bare `&` / `&&` (not wrapped in parentheses). Since `&` binds tighter than `\|` in R, the grouping is silent — the rule asks for explicit parentheses. Applies everywhere, not just inside `if` / `while` conditions. |
| `raven.diagnostics.conditionAssignmentSeverity` | `"warning"` | Binary `=` used directly inside an `if` / `while` condition (likely `==` intended). |

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
| `Raven: Create linting settings` | `.vscode/settings.json` | Every `raven.linting.*` key Raven understands, each prefaced with a `//` comment naming its `lintr` equivalent. Merges into an existing `settings.json` without disturbing unrelated keys or comments; prompts before overwriting an existing `raven.linting.*` block |

## R Console Activation

| Setting | Default | Description |
|---|---|---|
| `raven.rConsole.activation` | `"auto"` | When Raven's R console — and the surfaces gated alongside it (plot viewer, data viewer, chunk navigation / highlighting / active-cell indicator, `.R` cell mode, and the `r.json` snippets contributed to `.Rmd` / `.qmd`) — activates. `"enabled"`: always activate. `"disabled"`: never activate. `"auto"`: activate unless the REditorSupport (R) extension is enabled or VS Code is running as Positron. See [R Console](r-console.md) and [Coexistence](coexistence.md). |

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

## Linting Settings

Native style/lint diagnostics. Tri-state master switch `raven.linting.enabled` (default `"auto"`); auto turns on when a `.lintr` or `raven.toml` opts in, set `true`/`false` for explicit overrides. Implemented in Rust against the tree-sitter AST — no `lintr` install required. All rules default to severity `hint` so they don't crowd the Problems pane. See [Style Lints](diagnostics.md#style-lints) for the full rule list and suppression conventions, and [Linting](linting.md) for the master-switch behavior matrix, quick-start configuration, mapping from a `.lintr` file, and the suppression matrix.

| Setting | Default | Description |
|---|---|---|
| `raven.linting.enabled` | `"auto"` | Master switch (`"auto"` / `"on"` / `"off"` / `true` / `false`). See the [behavior matrix](linting.md#behavior-matrix). |
| `raven.linting.lineLength` | `80` | Maximum line length (UTF-16 code units) |
| `raven.linting.objectLength` | `30` | Maximum identifier length for the object-length lint |
| `raven.linting.indentationUnit` | `"auto"` | Spaces per indent level used by the indentation lint. In VS Code, `"auto"` tracks each file's resolved `editor.tabSize`; set an integer `1..=8` for a fixed unit. |
| `raven.linting.assignmentOperator` | `"<-"` | Preferred assignment operator (`"<-"` or `"="`) |
| `raven.linting.stringDelimiter` | `"\""` | Preferred string-literal delimiter (`"\""` or `"'"`); used by the quotes lint |
| `raven.linting.lineLengthSeverity` | `"hint"` | Severity for over-long lines (or `"off"`) |
| `raven.linting.trailingWhitespaceSeverity` | `"hint"` | Severity for trailing whitespace |
| `raven.linting.noTabSeverity` | `"hint"` | Severity for tab characters |
| `raven.linting.trailingBlankLinesSeverity` | `"hint"` | Severity for blank lines or missing newline at end of file |
| `raven.linting.assignmentOperatorSeverity` | `"hint"` | Severity for mismatched assignment operator |
| `raven.linting.objectNameStyleFunction` | `"snake_case"` | Naming scheme for functions (`"snake_case" \| "camelCase" \| "dotted.case" \| "UPPER_CASE" \| "lowercase" \| "any"`) |
| `raven.linting.objectNameStyleVariable` | `"snake_case"` | Naming scheme for variables (same enum as above) |
| `raven.linting.objectNameStyleArgument` | `"snake_case"` | Naming scheme for function formal arguments (same enum as above) |
| `raven.linting.objectNameSeverity` | `"hint"` | Severity for the object-name lint (set to `"off"` to disable entirely; set a specific style to `"any"` to disable just that kind) |
| `raven.linting.infixSpacesSeverity` | `"hint"` | Severity for the infix-spaces lint (whitespace around operators) |
| `raven.linting.commentedCodeSeverity` | `"hint"` | Severity for the commented-code lint (standalone comments whose body parses as R code) |
| `raven.linting.quotesSeverity` | `"hint"` | Severity for the quotes lint (string-literal delimiter style) |
| `raven.linting.commasSeverity` | `"hint"` | Severity for the commas lint (spacing around `,`) |
| `raven.linting.tAndFSymbolSeverity` | `"hint"` | Severity for the T/F-symbol lint (bare `T` / `F` used as `TRUE` / `FALSE`) |
| `raven.linting.semicolonSeverity` | `"hint"` | Severity for the semicolon lint (`;` separators in source) |
| `raven.linting.equalsNaSeverity` | `"hint"` | Severity for the equals-NA lint (`x == NA`, `x != NA`, typed-`NA` variants) |
| `raven.linting.objectLengthSeverity` | `"hint"` | Severity for the object-length lint |
| `raven.linting.vectorLogicSeverity` | `"hint"` | Severity for the vector-logic lint (`&` / `\|` in `if` / `while` conditions) |
| `raven.linting.functionLeftParenthesesSeverity` | `"hint"` | Severity for the function-left-parentheses lint (whitespace between `function` and `(`) |
| `raven.linting.spacesInsideSeverity` | `"hint"` | Severity for the spaces-inside lint (whitespace inside `(`, `[`, `[[`) |
| `raven.linting.indentationSeverity` | `"hint"` | Severity for the indentation lint (lines whose leading whitespace doesn't match the expected indent for their AST scope) |

To disable an individual rule while leaving the rest enabled, set its severity to `"off"`. For the object-name lint, you can also set any of the three style settings to `"any"` to disable just that symbol kind while keeping the others active.

## Editor Integration Settings (VS Code only)

| Setting | Default | Description |
|---|---|---|
| `raven.editor.dotInWordSeparators` | `"ask"` | Whether to treat `.` as part of words (rather than a word separator) in R and JAGS files. `"ask"` prompts on first use, `"yes"` applies the override to `editor.wordSeparators` for `[r]` / `[jags]`, `"no"` never applies it. |

## Server Settings

| Setting | Default | Description |
|---|---|---|
| `raven.server.path` | bundled | Path to `raven` binary (if not using the bundled one) |
