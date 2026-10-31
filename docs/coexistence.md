# Using Raven with other R tools

[Docs](README.md) › Understanding Raven

Raven's language server runs next to any other R tool. Its R console and viewers run next to vscode-R too, and Raven asks which console to send code to. In Positron, which has its own console, they turn themselves off by default. <a id="coexistence-with-other-r-extensions"></a>

| You run | Raven's language server and help viewer | Raven's R console, viewers, chunk and preview commands |
|---|---|---|
| VS Code with Raven only | On | On |
| VS Code with Raven and the Quarto extension | On | On |
| VS Code with Raven and vscode-R (REditorSupport) enabled | On | On; you choose the console when you first send code |
| Positron with Raven | On | Off by default |
| Any of the above, with `raven.rConsole.activation` set to `"enabled"` | On | On |
| Any of the above, with `raven.rConsole.activation` set to `"disabled"` | On | Off |
| Neovim, Zed, Helix, Emacs, or another LSP editor | Language server only | Not available; these are part of the VS Code extension |

## Why Raven's console stepped aside

If you saw a notification saying Raven left its R console, plot viewer, and data viewer turned off, Raven found it was running inside Positron. Positron already gives you an R session, so under the default `raven.rConsole.activation` value, `"auto"`, Raven doesn't add a second one. Its completions, diagnostics, and navigation work either way.

The notification appears once and offers three choices: **Learn more** opens this page, **Open setting** jumps to `raven.rConsole.activation`, and **Don't show again** silences it.

To use Raven's console anyway, set `raven.rConsole.activation` to `"enabled"` and reload the window. [Who benefits from Raven's R console](#who-benefits-from-ravens-r-console) helps you decide.

With vscode-R installed, Raven's console stays on. A one-time notification says so: "Raven's R console now runs alongside vscode-R. When you first send code, Raven asks which console to use, unless raven.rTerminal.program names one." See [Run Raven next to vscode-R](#run-raven-next-to-vscode-r).

## The `raven.rConsole.activation` setting

This setting decides whether Raven's R-session features activate. It is the only switch for them: there is no separate setting for the plot viewer or the data viewer.

| Value | What Raven does |
|---|---|
| `"auto"` (default) | Activates the R-session features unless VS Code is running as Positron. vscode-R doesn't turn them off. |
| `"enabled"` | Always activates them, including in Positron. |
| `"disabled"` | Never activates them. |

Raven doesn't start or stop these features mid-session. When you change the setting, Raven asks you to reload the window.

The setting decides whether Raven's console exists at all. Which console your code goes to is a separate choice; see [Choose a console](r-console.md#choosing-the-r-program).

### What steps aside and what doesn't

The setting turns these on or off together:

- Raven's [R console](r-console.md).
- The [plot viewer](plot-viewer.md) and [data viewer](data-viewer.md). Both are reached through Raven's R console: the console starts a profile that overrides `View()` and starts httpgd. When the console is off, `View(df)` and `plot(...)` go to whatever R session your other extension manages.
- [Chunk](chunks.md) navigation commands and keybindings (Go to Next Chunk, Go to Previous Chunk, Select Current Chunk).
- Chunk background highlighting and the active-cell indicator in `.Rmd`, `.Rmarkdown`, and `.qmd` files.
- `.R` cell mode: `# %%` cell markers and RStudio-style `# Section ----` dividers in plain `.R` files.
- Chunk run commands and every chunk CodeLens button, including the **Run Chunk** lens on R code blocks in plain Markdown files.
- Raven's R [snippets](snippets.md) (`if`, `fun`, `for`, and others) inside R chunks of `.Rmd`, `.Rmarkdown`, and `.qmd` files.
- [Knit Preview](knit.md), its command, and its `Shift+Cmd+Enter` / `Shift+Ctrl+Enter` keybinding. Knit Preview also needs `raven.rmdKnit.enabled`.
- [Quarto Preview and Render](quarto.md): the commands, the editor-title button, and the Preview keybinding. **Stop Quarto Preview** stays in the Command Palette so you can always stop a running preview.
- The [R package build commands](r-package-dev.md) (Load All, Document, Test Package, Check Package, and the rest).

These stay on regardless of the setting:

- The language server: completions, diagnostics, hover, navigation, and everything else that doesn't need an R session.
- The [help viewer](help-viewer.md). It runs R on demand to render help pages, so it works whenever Raven can run the configured R executable, whether or not Raven's console is active.
- Raven's R snippets in plain `.R` files, and the R Markdown and Quarto snippets that scaffold new chunks (`rchunk`, `setupchunk`, and others). vscode-R's R Markdown snippets use different prefixes, so the two sets don't collide.

### Who benefits from Raven's R console

Raven's console and viewers overlap with vscode-R's. Whether Raven's versions help you depends on how you work.

You would likely benefit if you:

- send large blocks to R. Raven sends larger blocks through a temp-file `source()`, which avoids the delays of simulated typing and bracketed paste.
- view large data frames. Raven's data viewer streams rows from an Arrow file on demand.
- work with labelled data. Raven's data viewer reads variable and value labels from `haven` imports of Stata and SPSS files and shows value labels instead of the underlying codes.
- want a themeable `.Rmd` / `.Rmarkdown` preview. Knit Preview renders through VS Code's built-in Markdown pipeline, and its **Apply VS Code theme** toggle recolors prose, syntax highlighting, and plots to match your editor theme.

You would lose something if you rely on vscode-R's workspace viewer, its htmlwidget and Shiny viewer, or `View()` on lists and environments. Raven has no equivalents; its data viewer handles only data frames and matrices. Those viewers work only with vscode-R's R terminal, so choose vscode-R as your console if you need them.

See [How Raven compares: R session integration](comparison.md#r-session-integration) and [Limitations](limitations.md).

## Run Raven next to vscode-R

| You want | Do this |
|---|---|
| Both language servers (the default) | Leave `r.lsp.enabled` at `true`. Completions and diagnostics overlap somewhat. |
| Raven alone for code intelligence, keeping vscode-R for its workspace viewer | Set `"r.lsp.enabled": false`. |
| vscode-R's language server without its lintr style diagnostics | Set `"r.lsp.diagnostics": false`. You keep Raven's syntax and scope diagnostics. |
| Raven's style lints instead of lintr | Turn off vscode-R's diagnostics as above, then set `raven.linting.enabled` to `true`. See [Linting](linting.md). |
| Both linters on the same project, on purpose | Set `raven.linting.enabled` to `true`. |
| Send code to vscode-R's R terminal | Pick **vscode-R** when Raven asks, or set `raven.rTerminal.program` to `"vscode-R"`. |
| Send code to Raven's R console | Pick **Raven's R console** when Raven asks, or set `raven.rTerminal.program` to `"raven"`. See also [Cmd+Enter next to vscode-R](#cmdenter-next-to-vscode-r). |
| Hide Raven's chunk CodeLens row in `.Rmd` files | Set `raven.chunks.codeLens.commands` to `[]`. Both extensions otherwise show a row. |
| No Raven console at all | Set `raven.rConsole.activation` to `"disabled"`. |

To turn off vscode-R's language server, add this to your VS Code settings:

```json
{
  "r.lsp.enabled": false
}
```

### Cmd+Enter next to vscode-R

Raven and vscode-R both bind `Cmd+Enter` (`Ctrl+Enter` on Windows and Linux) in R files, and VS Code decides which extension's binding wins. Neither extension can change that. If vscode-R's wins, `Cmd+Enter` sends straight to vscode-R's terminal and Raven's menu never appears. Raven's `▶` menu, CodeLens buttons, and Command Palette commands still ask.

To make `Cmd+Enter` run Raven's command, add a user keybinding. User keybindings win over extension ones. Open **Preferences: Open Keyboard Shortcuts (JSON)** and add:

```json
[
  {
    "key": "cmd+enter",
    "command": "raven.runLineOrSelection",
    "when": "editorTextFocus && editorLangId == r"
  }
]
```

Use `ctrl+enter` on Windows and Linux. For R Markdown and Quarto files, add entries with `editorLangId == rmd` or `editorLangId == quarto`.

Raven still sends to whichever console you chose, so with this binding `Cmd+Enter` can reach vscode-R's terminal through Raven. Raven's plot viewer, data viewer, and debugger work only in terminals Raven opens; `plot()` and `View()` in vscode-R's terminal go to vscode-R's viewers.

### Language servers: Raven alone vs. both

Raven's language server traces `source()` chains across your project, so its completions, diagnostics, and navigation follow execution order at the cursor. That includes cross-file go-to-definition, find references, and detection of circular dependencies and scope violations. It doesn't need a running R session.

vscode-R's language server provides [lintr](https://lintr.r-lib.org/) diagnostics. They cover different ground: lintr catches style problems and some correctness issues Raven doesn't flag, and Raven catches cross-file scope problems lintr can't see. Raven's [opt-in lints](linting.md) re-implement 18 of lintr's default linters. For the rest, run lintr through vscode-R next to Raven.

To avoid reporting style problems twice, the default `raven.linting.enabled: "auto"` doesn't turn on Raven's lints from a discovered `.lintr` while vscode-R's lintr diagnostics are live (vscode-R installed and enabled, with `r.lsp.enabled` and `r.lsp.diagnostics` on) or while you're in Positron. That `.lintr` belongs to them. See [Linting: `"auto"` and REditorSupport / Positron](linting.md#auto-and-reditorsupport--positron).

A reason to keep vscode-R installed even when Raven covers your code intelligence is its workspace viewer, a sidebar panel that shows the live objects in your R session with their types and dimensions. Raven has no equivalent. If that's all you use vscode-R for, turn off its language server to avoid running two.

See [Editor setup](editor-integrations.md) for other editors.

## Run Raven in Positron

Raven's language server and help viewer activate in Positron as in VS Code. Under the default `"auto"`, Raven's R console, viewers, chunk commands, and preview commands stay off, and Positron's own R session handles them. Raven's lints also don't turn on automatically from a `.lintr` in Positron. To use Raven's console in Positron, set `raven.rConsole.activation` to `"enabled"`.

<a id="coexistence-with-the-quarto-extension"></a>

## Run Raven next to the Quarto extension

If the [Quarto extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto) is installed and Raven's R console is active, every R chunk in a `.qmd` file shows two CodeLens rows: Quarto's (**Run Cell · Run Next Cell · Run Above**) and Raven's (**▷ Run Chunk · ↘ Run Next Chunk · ↥ Run Above**, configurable with `raven.chunks.codeLens.commands`). Under `"auto"`, this happens in VS Code with or without vscode-R.

- **Without vscode-R**, Quarto's row says "Executing r cells requires the R extension" and does nothing. Raven's row works: **▷ Run Chunk** sends the chunk to the console you chose.
- **With vscode-R**, both rows work. Quarto's sends to vscode-R; Raven's sends the chunk to the console you chose.

VS Code doesn't let one extension hide another's CodeLens, and Quarto checks for vscode-R by extension ID, so Raven can't fix the duplicate row from its side.

If the duplicate row bothers you, you can disable the Quarto extension and use Raven alone. Raven highlights `.qmd` with its bundled R Markdown grammar, supplies Quarto and R snippets, provides chunk navigation and CodeLens execution through its R console, and offers [Quarto Preview and Render](quarto.md) through the Quarto CLI. You lose the Quarto extension's Visual Mode, its Quarto-aware YAML intelligence, and its Python and Julia cell runners. If you need those, keep both extensions and use Raven's row for R chunks.

### `.Rmd` / `.Rmarkdown` files belong to the `rmd` language

Raven opens `.Rmd` and `.Rmarkdown` files as its `rmd` language by default, so Knit Preview works even with the Quarto extension installed. This also turns off the Quarto extension's `.Rmd` features (Run Cell, Insert Cell, preview menus, and its chunk CodeLens). Quarto's `.qmd` handling is untouched.

To give `.Rmd` files back to Quarto, override the default in your user or workspace settings:

```json
{
  "files.associations": {
    "*.rmd": "quarto",
    "*.Rmd": "quarto",
    "*.RMD": "quarto"
  }
}
```

The override replaces only the keys it lists.

## Run Raven next to lintr, Jarl, or Air

- **lintr.** Run it through vscode-R's language server, or from the command line, next to Raven. Raven's own lints are off by default and cover 18 lintr rules; see [Linting](linting.md) for how Raven reads a `.lintr`.
- **Jarl.** Run it alongside Raven. Raven's lints are off by default, so the two don't report the same problem unless you turn Raven's lints on.
- **Air.** Raven indents lines as you type but never reformats whole files, so it doesn't conflict with Air formatting your files. See [Indentation](indentation.md).

## Settings

| Setting | What it controls |
|---|---|
| `raven.rConsole.activation` | Whether Raven's R console, viewers, chunk commands, and preview commands activate. |
| `raven.rTerminal.program` | Which console Raven sends code to, or `"ask"` to choose each session. |
| `raven.linting.enabled` | Whether Raven's style lints run, and whether `"auto"` defers to vscode-R or Positron. |
| `raven.chunks.codeLens.commands` | Which run commands appear in Raven's chunk CodeLens row. |
| `raven.rmdKnit.enabled` | Whether Knit Preview is available, together with the console activation. |

See the [settings reference](settings-reference.md) for defaults and allowed values.

## Details

<details markdown="1">
<summary>Why the Quarto extension can take over <code>.Rmd</code> files, and how Raven prevents it</summary>

The Quarto extension registers both `.qmd` and `.rmd` under its `quarto` language. With only Raven and Quarto installed, VS Code can pick Quarto's claim over Raven's `rmd` language, because the order in which VS Code resolves competing language contributions from different extensions isn't documented. A `.Rmd` file can then open as `quarto`.

Most Raven features handle both languages: run line, chunk navigation, CodeLens, and the send-to-R menus. Knit Preview only runs for files in the `rmd` or `r` language with an R Markdown extension, so it stops working when a `.Rmd` file opens as `quarto`. The symptom is `Shift+Cmd+Enter` (`Shift+Ctrl+Enter` on Linux and Windows) showing Quarto's "Editor selection is not within an executable cell" message instead of opening the preview.

To prevent this, Raven sets a default `files.associations` entry for six case variants, `*.rmd`, `*.Rmd`, `*.RMD`, `*.rmarkdown`, `*.Rmarkdown`, and `*.RMARKDOWN`, all mapped to `rmd`. VS Code applies `files.associations` before extension language contributions, so these files open as `rmd` whether or not vscode-R's syntax extension is also installed.

`files.associations` merges by key, so an override like the one above replaces only the keys it lists. Any other `files.associations` defaults Raven adds stay in effect.

</details>

<details markdown="1">
<summary>Why Quarto's CodeLens row does nothing without vscode-R</summary>

Quarto's R cell runner checks for vscode-R's extension ID, not for the `r.runSelection` command it calls. Raven can't satisfy that check whatever commands it registers, so the fix would have to come from the Quarto extension. Quarto's row stays useful for other languages when their runners are installed.

</details>

## See also

- [How Raven compares](comparison.md): Raven next to RStudio, Positron, vscode-R, lintr, Jarl, and Air.
- [R console](r-console.md): run R and send code from the editor.
- [Linting](linting.md): Raven's opt-in style rules and how they read `.lintr`.
- [Limitations](limitations.md): what Raven doesn't do yet.
