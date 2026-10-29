# Configuration

[Docs](README.md) › Reference

Raven reads settings from your editor, from a project `raven.toml`, and from a `.lintr` file, and combines them key by key so one committed file can govern both your editor and CI.

| Source | Who reads it | Use it for |
|---|---|---|
| Editor settings (`raven.*` in VS Code) | The VS Code extension; other editors through the language server's client settings | Personal preferences and editor-only features such as the console and viewers |
| `raven.toml` at the project root | Every editor and the `raven check` / `raven lint` CLIs | Project policy shared by everyone and by CI |
| `.lintr` | Linting settings only (a subset), when no `raven.toml` is found | Projects that already configure `lintr` |

For every individual key, with its default, type, and `raven.toml` path, see the [Settings reference](settings-reference.md). This page explains how the sources fit together.

## Project config: `raven.toml`

A `raven.toml` file at the project root is the recommended way to configure Raven. Every editor and the `raven check` / `raven lint` CLIs read it, so a single committed file governs both interactive editing and CI.

In VS Code, **Raven: Create raven.toml** writes a starter file (see [Scaffold commands](#scaffold-commands)).

### Discovery

Raven walks upward from the active project root looking for `raven.toml`. The active project root is the first workspace folder in editors, `--workspace` for `raven check`, and the working directory for `raven lint`.

If no `raven.toml` is found, Raven reads `.lintr` for linting settings only (a subset; see [Linting](linting.md#migrating-from-lintr)). The literal home-directory `~/.lintr` is ignored by default, so user-level `lintr` preferences don't silently affect every project. In VS Code, set `raven.linting.readHomeLintr = true` to include it; in the CLI, pass it explicitly with `--config ~/.lintr`.

In multi-root workspaces, open a project folder directly when you need a different folder-specific project config.

### Precedence

Precedence is per key. For each setting, a value in `raven.toml` wins over the value from the editor (the language server's `initializationOptions` and `workspace/didChangeConfiguration` payload). Keys the project file doesn't set keep coming from the editor, or from Raven's defaults if neither sets them.

For example, if `raven.toml` sets `[linting] lineLength = 100` and your VS Code settings set `raven.linting.lineLength = 120` and `raven.linting.lineLengthSeverity = "warning"`, Raven uses a line length of 100 and severity `warning`.

`raven.toml` and `.lintr` don't merge: when a `raven.toml` is found, `.lintr` is not read.

### Schema

Most `raven.toml` keys mirror the editor settings: drop the `raven.` prefix and use the remaining path as the TOML section and key. The top-level sections are `workspace`, `linting`, `crossFile`, `packages`, `diagnostics`, `indentation`, `symbols`, `completion`, and `box`. A few keys live at a different path, and the [Settings reference](settings-reference.md) lists the exact `raven.toml` path for every setting (`—` means the setting isn't read from `raven.toml`).

```toml
[workspace]
exclude = ["generated/**", "archive/**", "!generated/keep.R"]

[linting]
enabled = true
lineLength = 100
lineLengthSeverity = "warning"

[[linting.overrides]]
files = ["tests/**/*.R"]
lineLength = 120

[crossFile]
# tighter than the default of 64
maxChainDepth = 10

[crossFile.diagnostics]
missingFile = "warning"
caseMismatch = "auto"

[packages]
enabled = true

[diagnostics]
enabled = true
jags = "on"
stan = "on"

[diagnostics.severity]
undefinedVariable = "warning"
```

Editor-only settings, such as `raven.sendToR.*`, `raven.rTerminal.*`, `raven.dataViewer.*`, `raven.chunks.*`, `raven.knit.*`, and `raven.pandoc.*`, apply only inside VS Code and aren't read from `raven.toml`. They are documented on their feature pages ([R console](r-console.md), [Data viewer](data-viewer.md), [Chunks](chunks.md), [Knit](knit.md)). `raven.trace.server` is the standard VS Code language-client trace setting (`off`, `messages`, `verbose`), useful when filing bug reports.

Canonical paths shared with Sight, and their permanent compatibility aliases, are specified in [Shared project configuration schema](shared-config-schema.md).

### Per-file overrides

`[[linting.overrides]]` is an array of entries, each a list of globs plus the linting settings to change for matching files. Globs are anchored at the project root. Order matters: later entries win on conflicts. Setting `enabled = false` in an override skips matching files entirely.

### Project exclusions

Raven skips three kinds of files when it discovers files on its own:

- Files ignored by `.gitignore`, by default.
- Files matching `[workspace].exclude` in `raven.toml`.
- Hidden directories and the vendored or build directories `renv`, `packrat`, `node_modules`, and `target`, always.

Discovery here means workspace indexing, CLI directory scans, package R definitions, testthat helpers, `.Rprofile`, and data harvesting. Files you name or open still work: explicit CLI file arguments, open editor buffers, and directly resolved dependencies, including files sourced by a prelude. Closing an ignored buffer removes its buffer-only contribution unless an eligible file still needs it as a dependency.

To stop respecting `.gitignore`, set `raven.workspace.respectGitignore = false` in the editor, or in the project:

```toml
[workspace]
respectGitignore = false
```

`[workspace].exclude` is a `raven.toml`-only list of project-root-relative globs; there is no editor setting for it. The default is `[]`. Use directory globs such as `generated/**`, `archive/**`, or `**/cache/**` to ignore whole trees. A leading `!` re-includes matching paths, so `["generated/**", "!generated/keep.R"]` excludes the generated tree except `generated/keep.R`.

<details markdown="1">
<summary>How <code>.gitignore</code> files are read</summary>

Raven reads root and nested `.gitignore` files, plus ancestors up to the nearest `.git` file or directory. Without a repository marker, inheritance starts at the workspace root. Matching is case-sensitive; the deepest workspace folder owns overlapping paths. Git-style negation cannot re-include a child of an ignored directory, override `workspace.exclude`, or restore directories pruned by the workspace walker. Symlinked `.gitignore` files are not followed.

Git need not be installed: tracked-file status, global Git excludes, and `.git/info/exclude` are not consulted. Edits to ignore files and setting changes refresh discovery live.

</details>

<details markdown="1">
<summary>Exactly what <code>[workspace].exclude</code> affects and how patterns match</summary>

These exclusions are broader than lint overrides. Raven ignores matching files for background workspace indexing, dependency discovery, file-watcher and on-demand indexing, package-mode disk seeding, and default `raven check` discovery. Index entries that become excluded after a live `raven.toml` reload are removed from Raven's indexes and dependency graph.

Raven compiles the glob list once whenever configuration is recomputed and matches paths relative to the containing workspace root. `*` and `?` do not cross `/`; use `**` for recursive matches, such as `**/*.log` for `.log` files at any depth. Patterns are evaluated in order.

Raven skips whole directories during the workspace walk only when a positive directory glob such as `generated/**` proves every descendant is excluded. If any negated pattern is present, this directory skipping is turned off for the list, so re-included files are never dropped before they can match. Files are still filtered by the full ordered pattern list.

Explicit CLI file arguments bypass `[workspace].exclude`: `raven check generated/one.R` reports that file even if it matches an exclusion. Directory arguments are discovery walks, so exclusions still apply inside them. Likewise, a matching file opened in the editor is diagnosed live; exclusion controls bulk discovery and symbol indexing, not an open buffer's diagnostics.

</details>

<details markdown="1">
<summary>Directories that are always skipped</summary>

Some directories are skipped before `[workspace].exclude` is consulted and cannot be re-included: every hidden directory (a name starting with `.`, such as `.git`, `.Rproj.user`, `.vscode`, and AI coding agents' embedded worktrees under `.claude/` or `.codex/`), plus `renv`, `packrat`, `node_modules`, and `target`. This keeps a repository holding many hidden worktree copies of itself from indexing every copy.

The rule governs discovery: both the startup scan and files the editor's file watcher reports later. An open buffer, an explicit `raven check` file argument, and on-demand indexing of a `source()` target under a hidden directory all still work.

</details>

### Live reload

In the editor, edits to `raven.toml` take effect live for every section: `[workspace]` (`exclude`), `[linting]` (including `overrides`), `[crossFile]`, `[packages]` (including `packageMode`, `watchLibraryPaths`, `watchDebounceMs`), `[diagnostics]`, `[indentation]`, `[symbols]`, `[completion]`, and `[box]`. Open documents re-publish diagnostics automatically, with no restart.

The discovered `.lintr` is also watched and reloaded, but only for the supported linting subset described in [Linting](linting.md#migrating-from-lintr). Workspace and non-home ancestor `.lintr` files are discovered by default; the literal `~/.lintr` only when `raven.linting.readHomeLintr = true`.

Package-affecting changes (toggling `[packages].enabled`, `packageMode`, `rprofilePrelude`, `rPath`, `additionalLibraryPaths`, or the watcher settings) are handled the same way as an editor settings change: Raven rebuilds the package library through R if needed, restarts the library-path watcher, and re-registers completion triggers if they changed. This all happens in the background without blocking editing.

The CLI reads configuration once per command. Pass `--config ~/.lintr` to use a literal home `.lintr` for that run.

## Settings in other editors

Editors other than VS Code send settings to the language server as LSP client settings (`initializationOptions` at startup and `workspace/didChangeConfiguration` afterwards). Most keys have the same shape as in `raven.toml`, and a `raven.toml` value wins over them per key. A few advanced server-side settings, such as `raven.crossFile.hoistGlobalsInFunctions`, have no VS Code Settings UI entry and can be set only this way or in `raven.toml`. The simplest portable choice is a `raven.toml`, which every editor reads. See [Editor setup](editor-integrations.md) for each editor.

## Settings by area

The [Settings reference](settings-reference.md) lists every key. This table points from each area to the page that explains it.

| Area | Editor prefix | `raven.toml` section | Explained in |
|---|---|---|---|
| <a id="diagnostics"></a><a id="diagnostic-severity-settings"></a>Diagnostics and severities | `raven.diagnostics.*` | `[diagnostics]` | [Diagnostics](diagnostics.md) |
| <a id="cross-file-settings"></a><a id="on-demand-indexing"></a><a id="cache-sizes"></a>Cross-file analysis | `raven.crossFile.*` | `[crossFile]` | [Cross-file analysis](cross-file.md) |
| <a id="package-settings"></a>Packages | `raven.packages.*` | `[packages]` | [Package development](r-package-dev.md), [.Rprofile startup files](rprofile.md) |
| <a id="linting-settings"></a>Linting | `raven.linting.*` | `[linting]` | [Linting](linting.md) |
| <a id="indentation-settings"></a>Indentation | `raven.indentation.*` | `[indentation]` | [Indentation](indentation.md) |
| <a id="symbol-settings"></a>Workspace symbols | `raven.symbols.*` | `[symbols]` | [Document outline](document-outline.md) |
| <a id="completion-settings"></a>Completion | `raven.completion.*` | `[completion]` | [Completion](completion.md) |
| Workspace discovery | `raven.workspace.*` | `[workspace]` | [Project exclusions](#project-exclusions) |
| `box` modules | — | `[box]` | [Box module search paths](#box-module-search-paths) |
| <a id="r-console-activation"></a>R console activation | `raven.rConsole.activation` | — | [Coexistence](coexistence.md) |
| <a id="plot-settings"></a>Plot viewer | `raven.plot.*` | — | [Plot viewer](plot-viewer.md) |
| <a id="help-viewer-settings"></a>Help viewer | `raven.help.*` | — | [Help viewer](help-viewer.md) |
| <a id="editor-integration-settings-vs-code-only"></a>Editor integration | `raven.editor.*` | — | [Editor setup](editor-integrations.md) |
| <a id="server-settings"></a>Server binary | `raven.server.path` | — | [Server binary](#server-binary) |

Severity settings accept `"error"`, `"warning"`, `"information"` (or its `"info"` alias), `"hint"`, or `"off"`. To turn off one lint rule and keep the rest, set its severity to `"off"`.

## Commands

### Refresh command

**Raven: Refresh package cache** (`raven.refreshPackages`) re-runs `.libPaths()`, rebuilds the package library, restarts the file watcher, clears the cache, and republishes diagnostics. Use it after `renv::activate()`, after `.libPaths()` changes, or if the watcher misses an event. See [When Raven calls R](cross-file.md#when-raven-calls-r) for what these R queries do.

### Scaffold commands

These Command Palette entries write starter config files to the first workspace folder. If the target file already exists, Raven asks before overwriting.

| Command | File | Contents |
|---|---|---|
| `Raven: Create raven.toml` | `raven.toml` | A starter linting-focused project config at the workspace root, with the `[linting]` keys Raven maps from VS Code settings. Add other sections as needed. |
| `Raven: Create .gitignore` | `.gitignore` | Standard R ignores (`.Rhistory`, `.RData`, `.Rproj.user/`), OS files (`.DS_Store`, `Thumbs.db`), R Markdown/Quarto/`R CMD check` artifacts, local scratch directories, and AI-tool user-local overrides |
| `Raven: Create linting settings` | `.vscode/settings.json` | Every project-scoped `raven.linting.*` key Raven maps to `raven.toml`, each with a `//` comment naming its `lintr` equivalent. See below. |

**Raven: Create linting settings** merges into an existing `settings.json` without disturbing unrelated keys or comments, keeps client-only linting settings such as `raven.linting.readHomeLintr`, and asks before overwriting an existing project-scoped `raven.linting.*` block.

## Box module search paths

```toml
[box]
searchPaths = ["modules", "../shared-r"]
```

This project-only setting overrides startup `R_BOX_PATH`, inferred project `.Rprofile` paths, and Rhino's default root. Entries are relative to the config file's directory. An empty list searches only the importing file's directory. The setting changes Raven's static analysis, not R's configuration. Reloading or removing it refreshes module imports. See [box and import modules](modules.md) for precedence, automatic inputs, and external-directory watching.

## Server binary

`raven.server.path` is the path to the `raven` binary the VS Code extension runs. It is empty by default, which uses the binary bundled with the extension.

## Notes on individual settings

The [Settings reference](settings-reference.md) gives a one-line description per key. These notes add what doesn't fit there.

<details markdown="1">
<summary>Diagnostics settings</summary>

- `raven.diagnostics.enabled` is the master switch for all diagnostics. When it is false, the JAGS and Stan switches cannot turn findings on.
- `raven.diagnostics.jags` and `raven.diagnostics.stan` default to `"off"`. Parsing and language features stay active when they are off. `undefinedVariableSeverity = "off"` turns off only Stan's undeclared-variable findings. Like every project setting, a value in `raven.toml` overrides the editor value, and an unset key falls back to the editor value or the built-in `"off"`.
- `raven.diagnostics.maxSyntaxDiagnosticsPerFile` (default `500`, `0` for unlimited) caps Stan and JAGS/BUGS syntax findings per file and does not cap R diagnostics. The editor and `raven check` use the same value.
- `raven.diagnostics.mixedLogicalSeverity` covers `|` or `||` whose immediate operand is a bare `&` or `&&` without parentheses. Since `&` binds tighter than `|` in R, the grouping is silent, so the rule asks for explicit parentheses. It applies everywhere, not just inside `if` and `while` conditions.
- `raven.diagnostics.conditionAssignmentSeverity` covers a binary `=` used directly inside an `if` or `while` condition, where `==` was likely intended.
- `raven.diagnostics.reportUnusedSuppressions` (default `false`) reports **every** suppression comment that suppressed nothing as an `unused-suppression` hint. With the default, only `# raven: expect` comments are checked, and a plain `# raven: ignore`, `# @lsp-ignore`, or `# nolint` stays silent even when it matched nothing. The finding is a hint, so it never fails `raven check` at the default threshold. `raven check` honors it. See [Directives](directives.md#ignore-directives).

</details>

<details markdown="1">
<summary>Cross-file settings</summary>

- `raven.crossFile.backwardDependencies`: `"auto"` infers backward dependencies from a workspace scan; `"explicit"` requires backward directives such as `# raven: sourced-by`. See [Backward dependency modes](cross-file.md#backward-dependency-modes).
- `raven.crossFile.hoistGlobalsInFunctions` is set through client settings or `raven.toml` only; it isn't in the VS Code Settings UI. See [Global symbol hoisting](cross-file.md#global-symbol-hoisting).
- `raven.crossFile.maxChainDepth` (default `64`) also bounds how far Raven walks the dependency graph in both directions, and produces a diagnostic when a chain exceeds it.
- `raven.crossFile.maxTransitiveDependentsVisited` (default `50000`): when this budget cuts analysis short, dropped `source()` edges can show up as false `undefined-variable` warnings. The editor shows a throttled warning and `raven check` prints a one-line note (on stdout with the diagnostics for `text`, on stderr for `json`/`sarif`). Raise it for very large workspaces.
- `raven.crossFile.onDemandIndexing.enabled` indexes files referenced by `source()` or directives that aren't open, so cross-file features work without opening every dependency. Its depth is bounded by `maxForwardDepth` and `maxBackwardDepth`.
- `raven.crossFile.caseMismatchSeverity` also accepts `"auto"` (the default): information on a case-insensitive filesystem, warning on a case-sensitive one. It is independent of `missingFileSeverity`. See [Source path case mismatch](diagnostics.md#source-path-case-mismatch).
- The `raven.crossFile.cache.*` settings size least-recently-used caches. Raise them if a very large workspace re-indexes repeatedly; lower them to save memory. The minimums shown in the Settings reference are enforced by the VS Code Settings UI; the server itself only requires at least `1`, so `raven.toml` and other editors can go lower.

</details>

<details markdown="1">
<summary>Package settings</summary>

- `raven.packages.rPath` is empty by default, in which case Raven searches `PATH`. It must point to plain `R`, not `radian` or `arf`: those are interactive wrappers and can't run the non-interactive scripts Raven uses to read package information. For the interactive console program, see [Choosing the R program](r-console.md#choosing-the-r-program).
- `raven.packages.missingPackageSeverity` set to `"off"` turns off missing-package diagnostics.
- `raven.packages.watchLibraryPaths` watches the `.libPaths()` directories and refreshes package information when packages are installed or removed; `raven.packages.watchDebounceMs` (default `500`) groups rapid file events into one refresh.
- `raven.packages.packageMode`: `"auto"` detects a `DESCRIPTION` file, `"enabled"` always treats the workspace as a package, `"disabled"` never does. See [Package development](r-package-dev.md).
- `raven.packages.rprofilePrelude` uses the workspace-root `.Rprofile` as a startup prelude for ordinary scripts. See [.Rprofile startup files](rprofile.md).

</details>

<details markdown="1">
<summary>Linting settings</summary>

`raven.linting.enabled` is tri-state (default `"auto"`). See the [behavior matrix](linting.md#behavior-matrix) for how it combines with `raven.toml` and `.lintr`. All rules default to severity `information`, matching how REditorSupport's `languageserver` maps `lintr` style findings.

- `raven.linting.readHomeLintr` is a client-only setting: it includes the literal `~/.lintr` in discovery. Workspace and non-home parent `.lintr` files are still discovered when it is `false`; the CLI uses the literal `~/.lintr` only with `--config ~/.lintr`.
- `raven.linting.indentationUnit`: in VS Code, `"auto"` follows each file's `editor.tabSize`; an integer from 1 to 8 sets a fixed unit.
- `raven.linting.objectNameStyle*` settings accept one style or an array, ORed with that kind's `objectNameRegexes*`. Include `"any"` to turn off checking for just that kind. An empty style array with regexes checks regexes only; empty styles and empty regexes together turn that kind off. The regexes are partial matches against the full identifier, including any leading `.`; use `^...$` for whole-name matches. Empty strings are rejected. See [Object names](linting.md#object-names).

</details>

<details markdown="1">
<summary>Indentation settings and format-on-type</summary>

`raven.indentation.style` is a deprecated permanent alias: `rstudio` means argument style `aligned`, `rstudio-minus` means argument style `indented`, and `off` turns syntax-aware indentation off. Explicit new settings win per field over the alias, and the alias never changes the infix setting. See [Indentation](indentation.md#permanent-compatibility-alias).

Raven sets `editor.formatOnType` to `true` for R, R Markdown, and Quarto by default, as the lowest-priority VS Code default. Syntax-aware indentation applies to plain R and to R chunk bodies; prose, YAML, and non-R chunks are left alone. To turn it off per language:

```json
"[r]": {
  "editor.formatOnType": false
},
"[rmd]": {
  "editor.formatOnType": false
},
"[quarto]": {
  "editor.formatOnType": false
}
```

Out of the box Raven produces aligned infix continuations, and its lint accepts both forms. Projects that run real `lintr`, styler, or Air in CI should set both infix settings to `"indented"`; strict-alignment projects should set both to `"aligned"`.

</details>

<details markdown="1">
<summary>Viewer, symbol, completion, and editor settings</summary>

- `raven.plot.viewerColumn` and `raven.help.viewerColumn` (`active` or `beside`, default `beside`) set where the plot viewer or help viewer first opens. Once you move the panel, Raven leaves it there.
- `raven.symbols.workspaceMaxResults` (default `1000`, range 100 to 10000) caps workspace symbol search (Cmd/Ctrl+T).
- `raven.completion.triggerOnOpenParen` registers `(` as a completion trigger for parameter suggestions.
- `raven.editor.dotInWord` was renamed from `raven.editor.dotInWordSeparators`, and the old setting is migrated automatically. Change it at any time by editing the setting.

</details>

## See also

- [Settings reference](settings-reference.md)
- [Linting](linting.md)
- [Editor setup](editor-integrations.md)
- [CLI](cli.md)
