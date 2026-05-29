# Raven

Raven is a language server for R, Stan, and JAGS. With Raven, what's in scope depends on where your cursor is. The language server traces `source()` chains and resolves scope at your position, so completions, diagnostics, and navigation reflect what's actually defined when each line runs — across files and within a single script (a variable defined on line 50 isn't in scope on line 10).

Raven adds this to your existing setup. [REditorSupport's R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) is the established R extension for VS Code; Raven's language server runs alongside it, contributing cross-file, scope-aware code intelligence (plus RStudio-style indentation) on top of what you already have.

REditorSupport's language intelligence comes from [r-language-server](https://github.com/REditorSupport/languageserver), an R package that runs inside an R session and indexes the documents you have open (and, in an R package, its `R/` directory). Raven is written in Rust to be fast, and needs no R session: it indexes your whole workspace and follows `source()` chains, so completions and navigation reach symbols in files you haven't opened — jump straight to a variable's definition in another file.

As you type, Raven resolves scope — so it can flag undefined variables. It also reports parse errors — unclosed or mismatched brackets, or an `else` that isn't on the same line as the closing `}` — plus likely-bug patterns like mixed logical operators (`a & b | c`).

Raven *can* run without REditorSupport installed. Its language server deliberately needs no live R session, so rather than be forced to pair it with a tool that injects itself into a session, I built a complete R workflow — an R console with plot and data viewers — into the extension. When REditorSupport or Positron is already present, those features stay off by default — they simply don't appear — so Raven leaves your existing setup untouched.

## Features

### Code intelligence

- **[Completions](https://github.com/jbearak/raven/blob/main/docs/completion.md)** — Symbols, packages, and function parameters — across files
- **[Go-to-definition](https://github.com/jbearak/raven/blob/main/docs/go-to-definition.md)** — Jump to definitions across file boundaries
- **[Find references](https://github.com/jbearak/raven/blob/main/docs/find-references.md)** — Locate all usages of a symbol across your project
- **[Hover](https://github.com/jbearak/raven/blob/main/docs/hover.md)** — Symbol info including source file and package origin
- **[Diagnostics](https://github.com/jbearak/raven/blob/main/docs/diagnostics.md)** — Undefined variable detection that understands sourced files and loaded packages
- **[Linting](https://github.com/jbearak/raven/blob/main/docs/linting.md)** — Opt-in style/lint rules (line length, trailing whitespace, trailing blank lines, tabs, assignment operator, object names, infix spaces, commented code, indentation)
- **[Document outline](https://github.com/jbearak/raven/blob/main/docs/document-outline.md)** — Hierarchical view with sections, classes, and nested functions
- **Workspace symbols** — Project-wide symbol search (Cmd/Ctrl+T)
- **File path intellisense** — Completions and cmd-click inside `source()` paths
- **[Smart indentation](https://github.com/jbearak/raven/blob/main/docs/indentation.md)** — Context-aware auto-indent with RStudio-style alignment
- **[Cross-file awareness](https://github.com/jbearak/raven/blob/main/docs/cross-file.md)** — Follows `source()` chains to resolve scope across files
- **[Directives](https://github.com/jbearak/raven/blob/main/docs/directives.md)** — Declare relationships and symbols the analyzer can't infer
- **[Syntax highlighting](https://github.com/jbearak/raven/blob/main/docs/syntax-highlighting.md)** — function names via LSP semantic tokens
- Raven provides lightweight support for **Stan** (`.stan`), **JAGS** (`.jags`), and **BUGS** (`.bugs`) files: syntax highlighting, completions (keywords, distributions, file-local symbols), go-to-definition, find references, and document outline with model structure navigation.


### R session integration

- **[R console](https://github.com/jbearak/raven/blob/main/docs/r-console.md)** — Interactive R console with statement detection and a temp-file fallback for large blocks; supports R, arf, and radian
- **[Code chunks](https://github.com/jbearak/raven/blob/main/docs/chunks.md)** — R Markdown / Quarto chunk detection with Run Chunk / Run Above / Run All commands, CodeLens buttons, navigation, and background highlighting; `# %%` cell support in `.R` files
- **[Knit Preview + Export](https://github.com/jbearak/raven/blob/main/docs/knit.md)** — `Raven: Knit Preview` renders R Markdown to an HTML preview without requiring Pandoc; companion `Export to HTML / PDF / Word` commands save the result next to the `.Rmd` via Pandoc
- **[Plot viewer](https://github.com/jbearak/raven/blob/main/docs/plot-viewer.md)** — Plots render in a VS Code panel via [httpgd](https://nx10.dev/httpgd/), with history navigation, save (PNG/SVG/PDF), and theme-aware background
- **[Data viewer](https://github.com/jbearak/raven/blob/main/docs/data-viewer.md)** — `View(df)` opens a virtualized grid backed by Apache Arrow; viewport-based rendering keeps scrolling responsive on multi-million-row frames
- **[Help viewer](https://github.com/jbearak/raven/blob/main/docs/help-viewer.md)** — Scope-aware R help: hovering shows the function in scope at the cursor instead of falling through to a multi-package list when scope can't be inferred

## Settings

Key settings (all under the `raven.*` prefix):

| Setting | Default | Description |
|---|---|---|
| `raven.rConsole.activation` | `"auto"` | When Raven's R console (and the plot and data viewers it powers) activates: `"enabled"`, `"disabled"`, or `"auto"` (defers when REditorSupport.r is enabled or running in Positron). See [Coexistence](https://github.com/jbearak/raven/blob/main/docs/coexistence.md). |
| `raven.help.viewerColumn` | `"beside"` | Initial editor column when the R help viewer first opens (`"active"` or `"beside"`). Code intelligence and the help viewer are unaffected by `raven.rConsole.activation`. |
| `raven.diagnostics.enabled` | `true` | Enable/disable all diagnostics |
| `raven.diagnostics.undefinedVariableSeverity` | `"warning"` | Severity for undefined variable diagnostics (`"off"` to disable) |
| `raven.linting.enabled` | `"auto"` | Opt-in style/lint rules (a native subset of `lintr`): `"auto"` turns them on when a `.lintr` or `raven.toml` opts in, or set `true` to force them on. See [Linting](https://github.com/jbearak/raven/blob/main/docs/linting.md). |
| `raven.packages.rPath` | auto-detect | Path to R executable |
| `raven.crossFile.indexWorkspace` | `true` | Enable background workspace indexing |
| `raven.server.path` | bundled | Path to `raven` binary (if not using the bundled one) |

See the [full configuration reference](https://github.com/jbearak/raven/blob/main/docs/configuration.md) for all options.

## More Information

See the [main repository](https://github.com/jbearak/raven) for full documentation including cross-file directives, editor integrations, and comparison with other R tools.

If you work with Stata, see Raven's sibling project, [Sight](https://github.com/jbearak/sight), a Stata language server with the same cross-file awareness model.

## License

[GPL-3.0](https://github.com/jbearak/raven/blob/main/LICENSE)
