# How Raven compares

[Docs](README.md) › Understanding Raven

Raven reads your R code without running it, follows `source()` chains across files, and tells you what is in scope at each line; this page compares that with the R tools you may already use. <a id="comparison-with-other-r-tools"></a>

| Tool | What it is | Where it overlaps with Raven |
|---|---|---|
| [RStudio IDE](https://posit.co/products/open-source/rstudio/) | Desktop IDE with an embedded R session | Code intelligence, R console, plot, data, and help viewers |
| [Positron](https://github.com/posit-dev/positron) with [Ark](https://github.com/posit-dev/ark) | Posit's VS Code-based IDE; Ark is its R kernel and language server | Code intelligence and R session features |
| [vscode-R](https://github.com/REditorSupport/vscode-R) (REditorSupport) | VS Code extension with an R terminal, viewers, and the `languageserver` package | Code intelligence and R session features |
| [languageserver](https://github.com/REditorSupport/languageserver) | Language server written as an R package; runs inside an R session | Code intelligence |
| [lintr](https://lintr.r-lib.org/) | Linter written as an R package | Raven's opt-in lints re-implement 18 of its rules |
| [Jarl](https://github.com/etiennebacher/jarl) | Linter written in Rust (Etienne Bacher) | Style lints only |
| [Air](https://github.com/posit-dev/air) | Formatter and formatting language server written in Rust (Posit) | None; Raven indents as you type but never reformats whole files |

The comparisons below come from reading each project's documentation and source at the time of writing. These projects change, so a claim can go out of date. If you find one that no longer matches, [file an issue](https://github.com/jbearak/raven/issues). To run Raven next to any of these tools, see [Using Raven with other R tools](coexistence.md).

## Why Raven exists

Raven began as a port of [Sight](https://github.com/jbearak/sight), a similar tool its author wrote for Stata to try agentic coding workflows on a language with no language server. Porting Sight's scope engine to R became Raven.

Raven differs from [languageserver](https://github.com/REditorSupport/languageserver) and [Ark](https://github.com/posit-dev/ark) in two ways. Both rely on a live R session for at least some features, so part of what they show reflects code you have run, not only what the file says. And neither resolves scope at the cursor: symbols indexed across the workspace are offered as one flat set.

Raven works like the language servers for TypeScript or Rust. It parses each file, builds a syntax tree, resolves scope, and follows `source()` chains across files. That has four practical consequences.

- **It is available immediately, even for code you haven't run.** Answers come the moment you open a file, including code that errors halfway, is missing a dependency, or that you are only reading, such as an unfamiliar repository or a pull request under review.
- **It reflects what your code says, not what your session remembers.** A session-based tool sees whatever is in `globalenv()` right now, which depends on what you ran and in what order. Comment out `library(dplyr)` while dplyr is still attached, and a session-based tool keeps completing dplyr functions without flagging them. Raven reads the file and knows dplyr isn't loaded at that point. The same holds for a variable you renamed in the script whose old binding lingers in the session.
- **It is read-only and has no side effects.** Computing scope never runs your code, so nothing that code does (writing files, querying a database, starting a long job) can be triggered. This also makes Raven safe to run behind an AI coding agent.
- **It runs in CI and other headless environments.** Scope resolution needs no R session, so Raven's diagnostics and lints run in a CI pipeline, the automated checks on each push and pull request, to catch errors in analysis code before merge. See [Raven in CI](ci.md). Raven still starts its own short-lived R subprocess for package metadata when R is available, never your interactive session, but the core analysis doesn't depend on it.

The two approaches can run together. You can install Raven next to the vscode-R extension and run both language servers at once. By default Raven also leaves its own R console off while vscode-R is enabled, so vscode-R keeps running code, rendering plots, and opening data frames. See [Using Raven with other R tools](coexistence.md).

## Language intelligence

This section compares Raven's language server with the code intelligence in RStudio IDE, [Positron](https://github.com/posit-dev/positron) (through [Ark](https://github.com/posit-dev/ark)), and [languageserver](https://github.com/REditorSupport/languageserver), the R package that powers the [vscode-R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) and other LSP clients.

| Feature | Raven | RStudio IDE | Positron (Ark) | REditorSupport/languageserver |
|---|---|---|---|---|
| **Cross-file awareness** | `source()`-aware: follows `source()` chains and `# raven:` / `@lsp-` directives, treats workspace-root `.Rprofile` as a startup prelude, builds a dependency graph, position-aware scope | Workspace function-symbol index (for "Go to File/Function") plus runtime view of `globalenv()` | Workspace-wide tree-sitter indexer of top-level symbols (functions, variables, R6/S7 methods); does not trace `source()` chains | Indexes top-level symbols from open documents (and `R/*.R` at startup for projects with a `DESCRIPTION` file); does not trace `source()` chains |
| **Diagnostics** | Static: scope- and position-aware undefined variables across the resolved `source()` graph and workspace-root `.Rprofile` prelude, plus missing packages, circular deps, scope violations | Built-in static "Code Diagnostics": current-file scope/order-aware undefined variables, style/syntax warnings, runtime errors on execution; does not follow `source()` chains | Static name-existence checks over document, flat workspace, package, and live-session symbols, plus namespace and missing-package checks; not `source()`- or execution-order-scoped | Static style + correctness linting via `lintr` / `codetools` (e.g. undefined globals); no independent syntax/parse diagnostics and no `source()` graph |
| **NSE-aware undefined-variable checks** | Yes: resolves the callee and suppresses only captured / data-masked / tidy-selected arguments, while still checking ordinary arguments | Configurable but not NSE-aware: the documented workaround is to turn off diagnostics inside all R function calls; captured and ordinary arguments are treated alike | No: Ark currently skips missing-symbol diagnostics inside call-like arguments and `[` / `[[` indices rather than applying per-callee argument policies | No dedicated per-argument LSP model; relies on `lintr` / `codetools` heuristics and user/package global declarations |
| **Completions** | Scope-aware static: in-file scope + cross-file (dep-graph) + package exports, position-filtered | Mostly runtime: `globalenv()` and search path, plus function-argument hints; static for current-file local symbols | Static document symbols + flat workspace top-level symbols across files + runtime helpers for `$` / `@` accessors | Static, scope-aware: in-file scope + symbols from tracked/open documents (and package `R/*.R` when applicable) + installed package signatures |
| **`$` / `@` accessor** | Static completions and go-to-definition against tracked list/data-frame/S4 shapes | Runtime column completion when the object exists in `globalenv()`; no cross-file def/refs | Runtime completions (requires a live R session); no static defs or refs for accessor RHS | Token-based static completions from any identifier used after `$` or inside `[[ ]]` in the file, not tied to the LHS object; no go-to-def or find-references for accessor RHS |
| **Go-to-definition** | Cross-file (functions and variables) via dep graph | Cross-file but **functions only** (`Code > Go to Function Definition`); no go-to-def for ordinary variable bindings | Cross-file for functions and top-level variables via the workspace indexer | Across tracked/open documents (and package `R/*.R` when applicable); functions and top-level variables |
| **Find references** | Cross-file via dep graph | No first-class find-references; the practical workflow is "Find in Files" text search plus scope-local rename | Cross-file via the workspace indexer | Across tracked/open documents (and package `R/*.R` when applicable) |
| **Package awareness** | Static NAMESPACE parsing + on-demand R subprocess for exports; position-aware | Full runtime access via embedded R session | Runtime (live R kernel) + tree-sitter detection of `library()` / `require()` calls | Runtime helpers from the in-process R session for installed package signatures |
| **Language / runtime** | Rust, no R session required | Electron desktop (and a browser-based Server edition) bundled with an embedded R session | Rust LSP backed by a live R kernel | R package, runs inside an R session |
| **Editor support** | Any LSP client (VS Code, Zed, Neovim, etc.) | RStudio only | Currently only exposed through Positron; Ark's README says the LSP "will be made available to other frontends in the future" | Any LSP client (vscode-R, ESS, Sublime, etc.) |
| **Performance model** | Starts without launching an R session; memory use is not tied to an R runtime | Tied to R session lifetime | Tied to R kernel startup | Tied to R session startup |

### When to choose Raven for language intelligence

No single alternative is closest to Raven on every axis. RStudio's diagnostics are scope- and order-aware within the current file, so they can tell a name defined earlier in the file from one defined later. RStudio doesn't follow `source()` chains, though, so that model stops at the file boundary.

Positron, through Ark, has broader workspace reach: its indexer sees variables and functions defined anywhere in your project. As of this writing, Ark's diagnostics treat that workspace as one flat symbol set, so a symbol defined in any indexed file satisfies the "is this name known?" check. Raven instead builds a dependency graph from your `source()` chains, treats the workspace-root `.Rprofile` as a startup prelude for ordinary scripts, and resolves scope at each position in execution order.

Raven also handles non-standard evaluation differently. As of this writing, Ark skips missing-symbol checks inside call-like arguments and `[` / `[[` indices, because it does not yet model how calls like `quote()`, `mutate()`, or data.table `[` evaluate their arguments. RStudio offers a broader switch for diagnostics inside function calls, and its documentation recommends turning it off when NSE-heavy code produces wrong diagnostics.

Raven models the policy per call and per argument. `paste(undefined_var)` and `lst[[typo]]` are flagged. `with(df, col + 1)` checks `df` but not `col`. `substitute(expr, env = typo_env)` skips `expr` but flags `typo_env`. So Raven's diagnostics, completions, and navigation follow execution order in multi-file script projects, including circular-dependency and scope-violation detection, without assuming everything inside a function call might be NSE.

Raven's static analysis also covers accessors, one level deep. It can complete `fruit$apple` from shapes it sees in your code with no R session, where Positron's accessor completions come from a live session. Raven starts short-lived R subprocesses for package metadata (exports, NAMESPACE entries, function signatures), separate from your interactive session, but it never needs a live session to compute scope or accessor shapes.

### What REditorSupport's language server offers that Raven doesn't

- **Session-aware completions.** With the session watcher on, vscode-R can complete symbols from the live session's `globalenv()`, including column names of data frames that exist only at runtime. Raven's completions are purely static.
- **Full `lintr` compatibility.** languageserver runs the [`lintr`](https://lintr.r-lib.org/) package itself, so it covers every lintr rule (for example `object_usage_linter`, `line_length_linter`, `trailing_whitespace_linter`) plus custom linters. Raven implements 18 lintr rules natively, most of lintr's default set (see [Linting](linting.md)), and doesn't run lintr. For other rules, run lintr through vscode-R next to Raven. For the rules it implements, Raven reads a documented subset of your `.lintr`, and you can also configure them in `raven.toml` or the VS Code Settings UI.

## Linters and formatters

Raven is a cross-file language server. It also folds two lighter features into the same process: syntax-aware [indentation](indentation.md) as you type, and an opt-in subset of common [style lints](linting.md), off by default. If basic tidying is all you need, you get it without a second process. Raven doesn't reformat whole files, and its lint set is deliberately a subset, so it complements dedicated tools rather than replacing them.

| | Raven | lintr | Jarl | Air |
|---|---|---|---|---|
| Job | Cross-file analysis; opt-in style lints; indentation as you type | Linting | Linting | Formatting |
| Written in | Rust | R | Rust | Rust |
| Style rules | 18 lintr rules, off by default | Full lintr rule set plus custom linters | Its own rule set | — |
| Reformats whole files | No | No | No | Yes |
| Configured by | `raven.toml`, a subset of `.lintr`, VS Code settings | `.lintr` | Its own configuration | Its own configuration |

## R session integration

Raven's VS Code extension also includes an R console, plot viewer, data viewer, and help viewer. The [vscode-R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r), a long-standing and widely used extension, has equivalents, and Positron has its own. Raven builds its own versions so it can offer a complete R workflow that doesn't depend on a tool attached to a live session, and to address the specific limitations described below.

### R console

vscode-R sends code from the editor to R through VS Code's [`terminal.sendText()` API](https://code.visualstudio.com/api/references/vscode-api#Terminal.sendText), which simulates typing into the integrated terminal. [Its terminal code](https://github.com/REditorSupport/vscode-R/blob/master/src/rTerminal.ts) splits multi-line code on newlines and waits `rtermSendDelay` (default 8 ms) between lines, optionally wrapping the block in bracketed-paste sequences. On a fresh local R terminal, bracketed paste is generally reliable. The delay trades speed for reliability, and it shows on large blocks: a 1,000-line block takes at least 8 seconds before R starts parsing.

To target a terminal other than the one vscode-R manages, such as R inside `tmux` so the session survives VS Code restarts, vscode-R offers a workspace-wide setting, `r.alwaysUseActiveTerminal`, that routes every send to the active terminal. That works when one terminal is always the right destination, but it is a global toggle rather than a per-send choice. The alternative, binding `workbench.action.terminal.sendSequence`, sends only the current line, with no multi-line statement detection.

Raven's `raven.sendToR.sendMethod` (default `auto`) pastes short blocks directly and switches to a temp-file `source()` once a block reaches `raven.sendToR.autoTempFileThresholdLines` (default 25). R reads the temp file from disk, so larger blocks skip the typing simulation and its per-line delay. Besides the main send commands, which target Raven's managed R terminal, a separate **Terminal** submenu in the editor toolbar (and matching Command Palette commands) targets whatever terminal is active: R in `tmux`, a Docker container, or any shell. It uses the same statement detection and temp-file fallback. See [R console: editor toolbar](r-console.md#editor-toolbar) and [send method](r-console.md#send-method).

Raven's default console (`raven.rTerminal.program` = `raven`; see [Raven's console](r-console.md#ravens-console)) doesn't simulate typing at all. It embeds your R and accepts editor sends over a local socket, so a block of any size starts at once, appears in the console as a highlighted transcript, and stops at the first error instead of running the remaining lines. Compared with the third-party consoles it can also launch:

- [radian](https://github.com/randy3k/radian) runs R inside Python, which ties the session to a Python runtime (relevant for reticulate and fork-based parallelism). Raven's console is a native binary that ships with the extension.
- [arf](https://github.com/eitsupi/arf), also a Rust console that embeds R, decides when input is complete with tree-sitter heuristics. Raven's console asks R's own parser, and colors errors, warnings, and messages distinctly; arf colors all stderr output alike ([reported upstream](https://github.com/eitsupi/arf/issues/490)).
- Both have features Raven's console doesn't yet: arf's fuzzy history search, and richer prompt customization in radian and arf.

### Debugger

| | Raven | Positron (Ark) | RStudio | REditorSupport + [R Debugger](https://github.com/ManuelHentschel/VSCode-R-Debugger) |
|---|---|---|---|---|
| Editor | VS Code | Positron | RStudio | VS Code |
| Breakpoints in code run from the editor | Lines, chunks and files, including top-level lines | Lines and files; top-level lines in sent code stay unverified | `source()` and functions | Its own launch modes |
| Conditional / hit count / logpoints | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | — | — |
| Function breakpoints | ✓ | — | — | — |
| `load_all()` | ✓ (pkgload's hook) | ✓ | ✓ | packages you name |
| Stop on errors / warnings / interrupts | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | errors | errors |
| Reason a breakpoint isn't active | Shown per breakpoint | Partly | Partly | — |
| Variables view | Paged; never runs your code | Not paged | Environment pane | Paged |
| Breakpoints in already-loaded code | Re-run to activate | Re-run to activate | ✓ for named functions | ✓ for named functions |

Raven's debugger runs inside its console, so typing `n` at `Browse[1]>` and clicking **Step Over** are the same thing. See [Debugger](debugger.md).

### Data viewer

vscode-R's `View()` keeps the data frame [live in R's memory](https://github.com/REditorSupport/vscode-R/blob/master/sess/R/handlers.R) and serves row windows to the webview on demand. Raven's `View()` writes the frame once to an Apache Arrow IPC (Feather v2) file on disk, and the webview decodes only the visible row windows from that file.

Each choice has trade-offs. Keeping data live in R makes a refresh against an updated frame cheap. Snapshotting to disk lets Raven page through rows without waiting on R's main thread when R is busy. In both designs, webview memory and rendering scale with the viewport. On the R side, vscode-R holds the whole frame in R memory, while Raven streams it out to Arrow once. In Raven's smoke tests the Arrow path has stayed responsive on very large frames where the R-staged path can hit memory limits.

The two viewers also treat value-labelled data differently. Raven recognizes `haven_labelled` plus `foreign` / `readstata13`-style label maps and shows the label when its Labels toggle is on (see [Data viewer: labels](data-viewer.md#labels)). vscode-R classifies labelled columns as formatted numerics and shows the underlying codes. See [Data viewer](data-viewer.md).

Sorting differs across R data viewers in gesture, in the sort key for labelled data, and in whether the sort survives calling `View()` again:

| | Gesture | Multi-column | Labelled-column key | Survives reopen |
| --- | --- | --- | --- | --- |
| RStudio | Header click | No (single column only) | Factor integer code | No |
| REditorSupport (ag-grid) | Header click; Shift-click appends | Yes | `tolower(as.character(...))` | No |
| Positron | Header right-click / ellipsis menu | Yes (repeated invocation) | Factor integer code | Session-only |
| Raven | Header right-click; Shift+pick appends | Yes | Follows the Labels toggle (WYSIWYG) | Yes, per panel × schema hash |

Every viewer puts NA and NaN last in both directions, matching `order(..., na.last = TRUE)`. See [Data viewer: sorting](data-viewer.md#sorting).

Row filtering also differs:

| | How you filter | Survives reopen |
| --- | --- | --- |
| RStudio | A filter row under the headers: histogram-brush range for numeric columns, single-select dropdown for factors, substring box for others; plus a global search box across all columns | No |
| Positron | A filter bar of column-predicate chips combined with AND/OR, evaluated by the R kernel | No |
| REditorSupport (ag-grid) | ag-Grid's per-column funnel menu (set filter for character columns, number filter for numerics); no factor multi-select or regex; no global search beyond ag-Grid's quick filter | No |
| Data Wrangler | Filters are cleaning steps that generate transformation code, not a live view of the original frame | — |
| Raven | Typed per-column predicates in a chip strip, combined with AND; each chip can be turned on or off | Yes, per panel × schema hash |

Raven's predicates cover numeric, factor checklist, character with regex, boolean, date, and empty / not-empty for any column. Factor and value-labelled string columns filter on the displayed string, following the Labels toggle. Labelled-numeric columns, such as `haven_labelled` on a numeric base, are the exception: their `is one of` and `is not one of` filters match the underlying code regardless of the toggle. See [Data viewer: filtering](data-viewer.md#filtering).

### Hover help

vscode-R's hover help comes from [languageserver](https://github.com/REditorSupport/languageserver) inside its R process. When it can't pin a symbol to one package, it looks up help with no package specified, which can return several same-named topics. Hovering `filter` in a script that loads dplyr may show `dplyr::filter`, `stats::filter`, and others together, rather than the one in scope at the cursor.

Raven's language server statically traces `library()` / `require()` calls in the current file and across the `source()` chain, including files you haven't opened, plus `pkg::fn` qualifiers and `# raven:` / `@lsp-` directives. From these it works out which package is in scope at the cursor and shows one help link for that package. Raven starts R subprocesses to read package metadata, but the choice of package is static: it doesn't depend on what you have opened, run, or attached. See [Help viewer](help-viewer.md).

### What REditorSupport's VS Code extension offers that Raven doesn't

- **Workspace viewer.** A sidebar panel that inspects the live R session, showing objects in `globalenv()` with their types and dimensions, plus attached and loaded namespaces. You can view or remove objects from the panel.
- **htmlwidget and Shiny viewer.** Interactive HTML output (plotly, DT, profvis, and others) and Shiny apps render in VS Code webview panels.
- **List and environment viewer.** `View()` on a list or environment opens a collapsible tree. Raven's `View()` handles only data frames and matrices.

<a id="coexistence"></a>

## See also

- [Using Raven with other R tools](coexistence.md): run Raven next to vscode-R, Positron, Quarto, lintr, Jarl, or Air, and choose which tool owns the console.
- [Limitations](limitations.md): what Raven doesn't do yet.
- [Raven in CI](ci.md): run `raven check` on every pull request.
- [Linting](linting.md): Raven's opt-in style rules.
