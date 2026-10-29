# Coming from RStudio, vscode-R, Positron, or lintr

[Docs](README.md) › Start here

What stays the same and what changes when you add Raven to the way you already work in R.

| You use | Keep using | Raven adds | Settings to look at |
|---|---|---|---|
| RStudio | Your projects, `.Rprofile`, and packages | Cross-file diagnostics and navigation, a VS Code R console, viewers | None to start |
| vscode-R | vscode-R's console, workspace viewer, and lintr | A second language server that follows `source()` | `r.lsp.enabled`, `r.lsp.diagnostics` |
| Positron | Positron's console, plots, and data explorer | Cross-file diagnostics and navigation | None to start |
| lintr | Your `.lintr` file | Fast checks as you type and in CI | `raven.linting.enabled` |

## From RStudio

Raven's VS Code extension covers the parts of RStudio most people use day to day:

- **Run code.** `Cmd+Enter` / `Ctrl+Enter` sends the line or selection to Raven's [R console](r-console.md). Chunk shortcuts follow Quarto and RStudio; see the [keybinding comparison](keybinding-comparison.md).
- **Plots and data.** `plot()` output appears in the [plot viewer](plot-viewer.md), and `View(df)` opens the [data viewer](data-viewer.md).
- **R Markdown.** **Knit Preview** shows a live HTML preview, and you can export to HTML, PDF, or Word. See [R Markdown preview and export](knit.md). For `.qmd`, see [Quarto](quarto.md).
- **Help.** Hover a function and follow the help link, or use the [help viewer](help-viewer.md).
- **Debugging.** Set breakpoints in the gutter and start the [debugger](debugger.md).

What changes is where answers come from. RStudio's completions and diagnostics reflect your running session. Raven's reflect the files themselves, so a typo is flagged before you run anything, and a function you sourced an hour ago but then deleted is reported as undefined. [How Raven compares](comparison.md) has the details.

RStudio-style `# Section ----` comments become entries in the [document outline](document-outline.md), and in `.R` files they also mark runnable cells.

## From vscode-R

Keep vscode-R installed if you like it. Raven's language server runs next to vscode-R's, and Raven's own console and viewers stay off while vscode-R is enabled, so nothing you rely on changes.

Two vscode-R settings let you trim the overlap:

- To have only Raven's completions and navigation, set `r.lsp.enabled` to `false`.
- To keep vscode-R's language server but drop its lintr diagnostics, set `r.lsp.diagnostics` to `false`.

If you later want Raven's console instead of vscode-R's, set `raven.rConsole.activation` to `"enabled"`. [Using Raven with other R tools](coexistence.md#run-raven-next-to-vscode-r) covers every combination.

## From Positron

Raven's language server and help viewer work in Positron. Positron's own console, plots, and data explorer stay in charge: Raven's console and viewers stay off unless you set `raven.rConsole.activation` to `"enabled"`. See [Run Raven in Positron](coexistence.md#run-raven-in-positron).

## From lintr

Raven reads your `.lintr` file and implements 18 of lintr's rules natively, so they run as you type and in CI without R. Linting is off until you turn it on, and the default `"auto"` setting turns it on when a `.lintr` or a `raven.toml` asks for it. Raven doesn't turn on from a `.lintr` while vscode-R's lintr diagnostics are live, so the same problem isn't reported twice.

- Existing `# nolint` comments keep working. See [Suppressing diagnostics](diagnostics.md#suppressing-diagnostics).
- Rules Raven doesn't implement are listed in [gaps versus lintr](linting.md#gaps-vs-lintr). Keep running lintr for those.
- Raven's main value is beyond style: it finds undefined variables across `source()` chains, which lintr's object-usage checks can't see across files.

## See also

- [Getting started](getting-started.md)
- [Using Raven with other R tools](coexistence.md)
- [How Raven compares](comparison.md)
- [Keybindings](keybinding-comparison.md)
