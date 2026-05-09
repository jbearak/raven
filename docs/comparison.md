# Comparison with Other R Tools

This page compares Raven with other R tools across two dimensions: **language intelligence** (what the language server provides — completions, diagnostics, navigation) and **R session integration** (the R console, plot viewer, data viewer, and help viewer that ship as part of Raven's VS Code extension).

## Language intelligence

Compares Raven's language server against the language servers and code-intelligence systems in RStudio IDE, [Positron](https://github.com/posit-dev/positron) (via [Ark](https://github.com/posit-dev/ark)), and [REditorSupport/languageserver](https://github.com/REditorSupport/languageserver) (the R-package-based LSP that powers the [REditorSupport (R) VS Code extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) and various other LSP clients).

| Feature | Raven | RStudio IDE | Positron (Ark) | REditorSupport/languageserver |
|---|---|---|---|---|
| **Cross-file awareness** | `source()`-aware: follows `source()` chains and `@lsp-*` directives, builds a dependency graph, position-aware scope | Workspace function-symbol index (for "Go to File/Function") plus runtime view of `globalenv()` | Workspace-wide tree-sitter indexer of top-level symbols (functions, variables, R6/S7 methods); does not trace `source()` chains | Indexes top-level symbols from open documents (and `R/*.R` at startup for projects with a `DESCRIPTION` file); does not trace `source()` chains |
| **Diagnostics** | Static: undefined variables, missing packages, circular deps, scope violations | Built-in static "Code Diagnostics" (style/syntax warnings) + runtime errors on execution | Static: scope-aware undefined-symbol, namespace, and missing-package checks, plus runtime errors from the live R kernel | Static: style + correctness linting via `lintr` (e.g. `object_usage_linter` flags undefined globals via `codetools::checkUsage()`); no independent syntax/parse diagnostics |
| **Completions** | Scope-aware static: in-file scope + cross-file (dep-graph) + package exports, position-filtered | Mostly runtime: `globalenv()` and search path, plus function-argument hints; static for current-file local symbols | In-file scope-aware static + flat workspace top-level symbols across files + runtime helpers (e.g. `.DollarNames()` for `$`, slot lookup for `@`) | Static, scope-aware: in-file scope + symbols from tracked/open documents (and package `R/*.R` when applicable) + installed package signatures |
| **`$` / `@` accessor** | Static completions and go-to-definition against tracked list/data-frame/S4 shapes | Runtime column completion when the object exists in `globalenv()`; no cross-file def/refs | Runtime completions via `.DollarNames()` / slot lookup (requires a live R session); no static defs or refs for accessor RHS | Limited and inconsistent |
| **Go-to-definition** | Cross-file (functions and variables) via dep graph | Cross-file but **functions only** (`Code > Go to Function Definition`); no go-to-def for ordinary variable bindings | Cross-file for functions and top-level variables via the workspace indexer | Across tracked/open documents (and package `R/*.R` when applicable); functions and top-level variables |
| **Find references** | Cross-file via dep graph | Not supported (only "Find in Files" text search and scope-local rename) | Cross-file via the workspace indexer | Across tracked/open documents (and package `R/*.R` when applicable) |
| **Package awareness** | Static NAMESPACE parsing + on-demand R subprocess for exports; position-aware | Full runtime access via embedded R session | Runtime (live R kernel) + tree-sitter detection of `library()` / `require()` calls | Runtime helpers from the in-process R session for installed package signatures |
| **Language / runtime** | Rust, no R session required | C++/Qt desktop bundled with an embedded R session | Rust LSP + R kernel (Ark binds to R's C API) | R package, runs inside an R session |
| **Editor support** | Any LSP client (VS Code, Zed, Neovim, etc.) | RStudio only | Positron only (LSP not currently exposed to other clients) | Any LSP client (vscode-R, ESS, Sublime, etc.) |
| **Performance model** | Starts without launching an R session; memory use is not tied to an R runtime | Tied to R session lifetime | Tied to R kernel startup | Tied to R session startup |

### When to choose Raven for language intelligence

Among the R LSPs we've surveyed, Raven is the only one that traces `source()` chains across a project: it builds a dependency graph and resolves what's in scope at each cursor position based on the actual order of execution, rather than treating the workspace as one flat symbol set. That makes its completions, diagnostics, and navigation reflect actual execution order in multi-file scripted projects, including circular-dependency and scope-violation detection. The analysis is static; Raven does spawn R subprocesses on demand for package metadata (exports, NAMESPACE entries, function signatures), but it doesn't need a live R session to compute scope.

### What REditorSupport's language server offers that Raven doesn't

- **lintr diagnostics** — Style checks and correctness linters (e.g. `object_usage_linter`, `line_length_linter`, `trailing_whitespace_linter`) via the [`lintr`](https://lintr.r-lib.org/) package. Raven has no style linting.
- **Session-aware completions** — When the session watcher is enabled, REditorSupport can complete symbols from the live R session's `globalenv()`, including column names from data frames that only exist at runtime. Raven's completions are purely static.

## R session integration

Raven's VS Code extension also includes an R console, plot viewer, data viewer, and help viewer. The [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) provides equivalents (it's a long-standing, widely used extension), and Positron has its own first-party versions. We chose to build these features rather than rely on REditorSupport because they let us address specific limitations our team has run into — described below.

These comparisons are based on reading the current upstream sources (links cited inline). Where the underlying behavior has been changed recently — e.g. the data viewer's row cap — we note that.

### R console

REditorSupport sends code from the editor to R via VS Code's [`terminal.sendText()` API](https://code.visualstudio.com/api/references/vscode-api#Terminal.sendText) — that is, by simulating typing into the integrated terminal. Its implementation in [`vscode-R/src/rTerminal.ts`](https://github.com/REditorSupport/vscode-R/blob/master/src/rTerminal.ts) splits multi-line code on newlines and `await`s an `rtermSendDelay` (default 8 ms) between lines, optionally wrapping the block in bracketed-paste sequences. On a fresh local R terminal, bracketed paste is generally reliable; the inter-line delay is a deliberate trade-off for reliability, but it's noticeable on large blocks — pasting a 1,000-line block adds at least 8 seconds before R starts parsing.

Bracketed paste becomes less reliable once the destination terminal is something other than a fresh local R process. A common case for our workflow is a long-running R session inside `tmux` (so the session survives across VS Code restarts) into which the user wants to send code from the editor: `tmux`, some `mosh`/`ssh` stacks, and similar layers can strip or split bracketed-paste markers, and large blocks arrive garbled.

Raven's `sendMethod` (default `auto`) pastes short blocks directly and switches to a temp-file `source()` once a block reaches `raven.sendToR.autoTempFileThresholdLines` (default 25). The temp-file path bypasses the typing-simulation pipe entirely: R reads the file from disk, so for those larger blocks there's no inter-line delay and no bracketed-paste compatibility risk. Raven also exposes a separate **Terminal** submenu of send commands in the editor toolbar (and matching commands in the Command Palette) that targets whatever terminal is currently active in VS Code — for example, an `R` running inside `tmux` or a Docker container — using the same temp-file fallback for larger blocks. See [R Console: Editor Toolbar](./r-console.md#editor-toolbar) and [Send method](./r-console.md#send-method) for details and override options.

### Data viewer

REditorSupport's `View()` overrides recently moved into an in-tree R helper package, [`sess`](https://github.com/REditorSupport/vscode-R/tree/master/sess). The data-viewer path serializes the data frame to a JSON file via [`jsonlite::write_json`](https://github.com/REditorSupport/vscode-R/blob/master/sess/R/hooks.R) and loads it into a webview that renders the rows with ag-Grid. Historically, calling `View()` on a large frame could cause VS Code to hang or run out of memory while the JSON was generated and parsed (issue [#1288](https://github.com/REditorSupport/vscode-R/issues/1288)). The current implementation defends against that by capping the view at 100 rows by default (`getOption("sess.row_limit", 100)`); the trade-off is that the default view shows the first 100 rows.

Raven's `View()` writes the frame to an Apache Arrow IPC (Feather v2) file, and the webview decodes only the row windows currently visible. Browser memory and rendering scale with the viewport rather than with the size of the frame, so scrolling stays responsive on multi-million-row frames once R has written the Arrow file. See [Data Viewer](./data-viewer.md) for the full implementation.

### Hover help

REditorSupport's hover is rendered server-side by [`languageserver`](https://github.com/REditorSupport/languageserver), which is itself an R package running inside its own R process. When the hover handler can't resolve a symbol from the in-file scope, it calls `workspace$get_help(token, package)`, which tries [`guess_namespace(topic)`](https://github.com/REditorSupport/languageserver/blob/master/R/workspace.R) against the language server's *workspace-flat* set of attached packages. That set is built by parsing `library()` / `require()` / `pacman::p_load()` calls out of source files and `library()`-ing the named packages inside the language server's own R process — but only for files the user has opened (`didOpen`), with one exception: if the project is an R package (has a `DESCRIPTION` file), `R/*.R` is also pre-scanned at startup. For an ordinary scripted project, `library()` calls in files the user hasn't opened are invisible to the hover; across files the user *has* opened, the package set is unioned without regard to where the cursor is. When `guess_namespace` doesn't return a single match, the handler falls through to `utils::help((topic))` with no `package` argument, which returns matches across **every** installed package — so hovering over `filter` in a script that's loaded `dplyr` can fall through to a multi-package result that includes `dplyr::filter`, `stats::filter`, and other same-named topics.

Raven takes a different approach. Its language server is a separate Rust process that statically traces `library()` / `require()` calls in the file at the cursor and across the `source()` chain — including files the user hasn't opened — plus namespace qualifiers (`pkg::fn`) and `@lsp-*` directives, to compute which package is in scope at the cursor position. It then shows a single help link for that package. Raven does spawn R subprocesses to read package metadata (exports, NAMESPACE entries, function signatures), but the disambiguation logic itself is static — it doesn't depend on whether the user has opened, run, or attached anything. See [Help Viewer](./help-viewer.md).

### What REditorSupport's VS Code extension offers that Raven doesn't

- **Workspace viewer** — A sidebar panel that introspects the live R session, showing objects in `globalenv()` with their types and dimensions, plus attached and loaded namespaces. Objects can be viewed or removed directly from the panel.
- **htmlwidget / Shiny viewer** — Interactive HTML output (plotly, DT, profvis, etc.) and Shiny apps render in VS Code webview panels.
- **R Markdown support** — Chunk highlighting, chunk navigation, run-chunk / run-above CodeLens buttons, and R Markdown preview.
- **List / environment viewer** — `View()` on lists and environments opens a collapsible tree view. Raven's `View()` only handles data frames and matrices.

If you're interested in any of these, please [file an issue](https://github.com/jbearak/raven/issues) or submit a PR.

## Coexistence

See [Coexistence with Other R Extensions](./coexistence.md) for how Raven's R-session features interact with the REditorSupport (R) extension and Positron, how `raven.rConsole.activation` works, and how to run REditorSupport's lintr alongside Raven.
