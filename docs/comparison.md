# Comparison with Other R Tools

This page compares Raven with other R tools across two dimensions: **language intelligence** (what the language server provides — completions, diagnostics, navigation) and **R session integration** (the R console, plot viewer, data viewer, and help viewer that ship as part of Raven's VS Code extension).

## Language intelligence

Compares Raven's language server against the language servers and code-intelligence systems in RStudio IDE, [Positron](https://github.com/posit-dev/positron) (via [Ark](https://github.com/posit-dev/ark)), and [REditorSupport/languageserver](https://github.com/REditorSupport/languageserver) (the R-package-based LSP that powers the [REditorSupport (R) VS Code extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) and various other LSP clients).

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

### When to choose Raven for language intelligence

Raven is the only R LSP that traces `source()` chains across a project: it builds a dependency graph and resolves what's in scope at each cursor position based on the actual order of execution, rather than treating the workspace as one flat symbol set. That makes its completions, diagnostics, and navigation correct for multi-file scripted projects, including circular-dependency and scope-violation detection. All of it works statically, without an R session.

## R session integration

Raven's VS Code extension also includes an R console, plot viewer, data viewer, and help viewer. The [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) provides equivalents (it's a long-standing, widely used extension), and Positron has its own first-party versions. We chose to build these features rather than rely on REditorSupport because they let us address specific limitations we and our users have run into — described below.

These comparisons are based on reading the current upstream sources (links cited inline). Where the underlying behavior has been changed recently — e.g. the data viewer's row cap — we note that.

### R console

REditorSupport sends code from the editor to R via VS Code's [`terminal.sendText()` API](https://code.visualstudio.com/api/references/vscode-api#Terminal.sendText) — that is, by simulating typing into the integrated terminal. Its implementation in [`vscode-R/src/rTerminal.ts`](https://github.com/REditorSupport/vscode-R/blob/master/src/rTerminal.ts) splits multi-line code on newlines and `await`s an `rtermSendDelay` (default 8 ms) between lines, optionally wrapping the block in bracketed-paste sequences. Pasting a 1,000-line block costs at minimum 8 seconds of forced delay before R has parsed anything, and reliability of bracketed paste over remote sessions (SSH, mosh, VS Code Remote) depends on the user's terminal stack — some intermediate layers strip or split bracketed-paste markers.

Raven's `sendMethod` (default `auto`) pastes short blocks directly and switches to a temp-file `source()` once a block reaches `raven.sendToR.autoTempFileThresholdLines` (default 25). The temp-file path bypasses the typing-simulation pipe entirely: R reads the file from disk, so there's no inter-line delay and no bracketed-paste compatibility risk. See [R Console: Send method](./r-console.md#send-method) for details and override options.

### Data viewer

REditorSupport's `View()` overrides recently moved into an in-tree R helper package, [`sess`](https://github.com/REditorSupport/vscode-R/tree/master/sess). The data-viewer path serializes the data frame to a JSON file via [`jsonlite::write_json`](https://github.com/REditorSupport/vscode-R/blob/master/sess/R/hooks.R) and loads it into a webview that renders the rows with ag-Grid. Historically, calling `View()` on a large frame could cause VS Code to hang or run out of memory while the JSON was generated and parsed (issues [#1288](https://github.com/REditorSupport/vscode-R/issues/1288), [#1463](https://github.com/REditorSupport/vscode-R/issues/1463)). The current implementation defends against that by capping the view at 100 rows by default (`getOption("sess.row_limit", 100)`) — so very large frames no longer hang the editor, but you also no longer see all rows unless you opt into a higher limit.

Raven's `View()` writes the frame to an Apache Arrow IPC (Feather v2) file and the webview decodes only the row windows currently visible. Memory and time scale with the visible viewport, not with the size of the frame, so opening multi-million-row data frames is fast and there's no row cap to opt around. See [Data Viewer](./data-viewer.md) for the full implementation.

### Hover help

REditorSupport's hover is rendered server-side by `languageserver`. When the hover handler can't resolve a symbol locally, it calls `workspace$get_help(token, package)`, which tries [`guess_namespace(topic)`](https://github.com/REditorSupport/languageserver/blob/master/R/workspace.R) over the language server's own loaded-package list. If that returns nothing, it falls through to `utils::help((topic))` with no `package` argument, and `utils::help()` without a package returns matches across **every** installed package. The hover then renders all of them — which means hovering over `filter` in a script that's loaded `dplyr` can show the `dplyr::filter`, `stats::filter`, and any other installed-package `filter` help links side by side, even though only one is in scope at the cursor.

Raven's hover uses the language server's scope analysis to determine which package the function actually resolves to at the cursor — based on `library()` / `require()` calls in this file and any sourced files, namespace qualifiers (`pkg::fn`), `@lsp-*` directives, and the standard package search path — then shows a single link to that package's help page. See [Help Viewer](./help-viewer.md).

## Coexistence

Raven's data viewer and plot viewer are reached *through* its R console: the R console boots a profile that overrides `View()` (data viewer) and starts httpgd (plot viewer). When Raven's R console isn't activated, neither of those viewers is wired up — `View(df)` and `plot(...)` go to whatever R session your other extension manages.

Raven's help viewer operates independently of the R console: it shells out to R on demand to render `Rd → HTML`, so it works whether or not Raven's R console is active. Help is always-on regardless of `raven.rConsole.activation`.

With the default `raven.rConsole.activation: "auto"`, the R console (and therefore its plot and data viewers) steps aside automatically when the [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) is enabled or VS Code is running as Positron — so Raven supplements your existing R-session setup rather than fighting it. Set the value explicitly to `"enabled"` if you want both extensions' R-session features active at once; you'll then be responsible for any keybinding or `View()`-override conflicts that result. Set `"disabled"` to never activate Raven's R-session features even when no other R extension is present.

If you want to run REditorSupport's language server alongside Raven (for example, to use `lintr` diagnostics), keep its language-server feature off:

```json
"r.lsp.enabled": false
```

See [Editor Integrations](./editor-integrations.md) for setup details across editors.
