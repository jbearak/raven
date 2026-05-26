# Coexistence with Other R Extensions

Raven's VS Code extension includes both a **language server** (completions, diagnostics, navigation) and **R-session features** (R console, plot viewer, data viewer, help viewer). If you also use the [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) or [Positron](https://github.com/posit-dev/positron), Raven is designed to stay out of the way by default.

## What steps aside and what doesn't

Raven's **language server** and **help viewer** always activate — they don't overlap with a running R session.

Raven's **R console**, **plot viewer**, and **data viewer** are the features that can overlap with another extension's R-session integration. The plot and data viewers are reached *through* Raven's R console: the R console boots a profile that overrides `View()` (data viewer) and starts httpgd (plot viewer). When Raven's R console isn't activated, neither of those viewers is wired up — `View(df)` and `plot(...)` go to whatever R session your other extension manages.

Several editor surfaces that overlap with REditorSupport's R Markdown / Quarto tooling are gated behind the same R-console-activation switch:

- **Chunk navigation** commands and keybindings (`raven.goToNextChunk`, `raven.goToPreviousChunk`, `raven.selectCurrentChunk`).
- **Chunk background highlighting** and the **active-cell indicator** in `.Rmd` / `.qmd` documents.
- **`.R` cell mode** support: `# %%` cell markers and RStudio-style `# Section ----` dividers used for chunk navigation / highlighting in plain `.R` files.
- **R-language snippets in `.Rmd` / `.qmd` fenced chunks** — Raven's `r.json` snippets (`if`, `fun`, `for`, etc.) are registered for `rmd` / `quarto` only when Raven's R console is active. R-Markdown- and Quarto-specific snippets that scaffold new chunks (`rchunk`, `setupchunk`, ...) always register, since REditorSupport doesn't ship equivalents.

## Who benefits from Raven's R console?

Raven's R console, plot viewer, and data viewer overlap with [REditorSupport (R)](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r)'s equivalents. Whether Raven's versions help you depends on your workflow:

- **You'd benefit** — e.g., you send large blocks to R over `tmux` / SSH (Raven's temp-file `source()` sidesteps bracketed-paste issues), or you regularly view large frames (Raven's data viewer streams Arrow rows on demand). See [Comparison: R session integration](./comparison.md#r-session-integration).
- **No practical improvement** — for smaller frames on local R sessions, REditorSupport handles the job well. There's no reason to switch; keep using REditorSupport. You can still use Raven's language server for the cross-file awareness REditorSupport doesn't provide.
- **You'd lose something** — REditorSupport ships a few features Raven doesn't: a workspace viewer, an htmlwidget / Shiny viewer, and a list / environment tree. It also offers an `.Rmd` preview; Raven's `Raven: Knit Preview` is deliberately manual instead — see the callout below for the design reasoning. (`.qmd` rendering belongs to the [Quarto extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto), not to REditorSupport. See [Coexistence with the Quarto extension](#coexistence-with-the-quarto-extension) for how Raven and Quarto split chunk-execution UI on `.qmd` files — including the awkward case where you have both installed but not REditorSupport, and Quarto's `Run Cell` buttons stay inert because their dispatcher checks for REditorSupport's extension ID.) If you rely on REditorSupport's workspace / Shiny / list-tree viewers, keep its R-session features enabled. If you also want Raven's console for `.R` scripts — while REditorSupport's console continues to handle your `.Rmd` work — set `raven.rConsole.activation` to `"enabled"` so both R consoles are available. `Cmd+Enter` / `Ctrl+Enter` can only be bound to one extension's send command; VS Code's keybinding editor lets you rebind either. (`View()` overrides aren't a cross-extension concern — each console rebinds `View()` inside its own R session, so whichever console you're in owns its own override.)

  > [!NOTE]
  > **Raven's knit preview is manual on purpose.** Re-knitting on every save would make the preview a moving target while you're mid-edit. Instead, `Shift+Cmd+Enter` (or `Shift+Ctrl+Enter` on Windows/Linux) saves the buffer if it's unsaved and re-knits in one keystroke — so you re-render exactly when you mean to, with one chord that already lives in your hand. The webview's **Knit again** toolbar button does the same thing for mouse-driven workflows.

Raven's plot viewer ships an **Apply VS Code theme** toolbar toggle that recolors the live plot to match your editor theme — parity with REditorSupport.R's `r.plot.toggleStyle` / `r.plot.defaults.colorTheme: "vscode"`. The persistence and broadcast shape match REditorSupport's, so users migrating between extensions get the same on/off semantics. See [Plot Viewer → Color theme](./plot-viewer.md#color-theme) for details.

These last two cases are why `raven.rConsole.activation` defaults to `auto`, which steps Raven's R-session features aside whenever REditorSupport is enabled or VS Code is running as Positron. Raven's language server and help viewer activate either way — you don't lose cross-file intelligence by leaving the R console off.

For a broader list of Raven's gaps across features, see [Limitations](./limitations.md).

## The `raven.rConsole.activation` setting

The `raven.rConsole.activation` setting (default: `"auto"`) controls whether Raven's R console — and therefore its plot and data viewers — activates:

- **`"auto"`** (default) — Raven's R-session features activate *unless* the REditorSupport (R) extension is enabled or VS Code is running as Positron. This keeps Raven out of the way when you already have R-session integration.
- **`"enabled"`** — Always activate Raven's R console, plot viewer, and data viewer, even when another R extension is present. With REditorSupport also enabled, both extensions' R consoles are available; `Cmd+Enter` / `Ctrl+Enter` can only be bound to one extension's send command, and VS Code's keybinding editor lets you rebind either.
- **`"disabled"`** — Never activate Raven's R-session features, even when no other R extension is present.

Code intelligence and the help viewer are unaffected by this setting. The help viewer shells out to R on demand to render Rd documentation as HTML, so it works whether or not Raven's R console is active — provided Raven can run the configured R executable.

## Language servers: Raven alone vs. both

Raven's language server traces `source()` chains across your project, so its completions, diagnostics, and navigation reflect actual execution order at the cursor position — including cross-file go-to-definition, find-references, and detection of circular dependencies and scope violations. It doesn't need a running R session.

REditorSupport's language server provides [`lintr`](https://lintr.r-lib.org/) diagnostics, which covers a different surface than Raven's diagnostics: it catches style violations and certain correctness issues that Raven doesn't flag, while Raven catches cross-file scope problems that lintr doesn't see. Raven also has its own [opt-in style linter](./linting.md) that mirrors a small subset of `lintr`'s rules; for the rules Raven doesn't ship, run `lintr` via REditorSupport alongside Raven.

If you want both, leave `r.lsp.enabled` at its default (`true`). Both language servers will run, with some overlap in completions and diagnostics.

One reason to keep REditorSupport installed even if Raven covers your language-intelligence needs is its workspace viewer — a sidebar panel that introspects your active R session, showing live objects, their types, and dimensions. Raven doesn't have an equivalent. If you're interested in a workspace viewer or lintr integration in Raven, please [file an issue](https://github.com/jbearak/raven/issues) — I haven't prioritized building these, but I'd consider them if there's interest.

If you keep REditorSupport installed but don't need its language server (e.g. you only want the workspace viewer), you can disable it to avoid the overhead of running two LSPs:

```json
"r.lsp.enabled": false
```

See [Editor Integrations](./editor-integrations.md) for setup details across editors.

## Coexistence with the Quarto extension

When the [Quarto extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto) is installed alongside Raven, *and* Raven's R console is active, you'll see two CodeLens rows above every R chunk in a `.qmd` file: Quarto's (**Run Cell · Run Next Cell · Run Above**) and Raven's (**▷ Run Chunk · ↘ Run Next Chunk · ↥ Run Above**, configurable via `raven.chunks.codeLens.commands`).

Raven's chunk CodeLens activates with Raven's R console — see [The `raven.rConsole.activation` setting](#the-ravenrconsoleactivation-setting). Under the default `"auto"`, Raven's R console activates only when no other R extension (REditorSupport.r, or Positron) is enabled. So the dueling-row case appears when you have Quarto installed but not REditorSupport.r, or when you've explicitly set `raven.rConsole.activation` to `"enabled"` alongside REditorSupport.r.

What each row does depends on whether REditorSupport.r is installed:

- **REditorSupport.r not installed**. Quarto's row shows "Executing r cells requires the R extension" and does nothing — its dispatcher checks for REditorSupport's extension ID, not for the underlying `r.runSelection` command. Raven's row works as usual: clicking **▷ Run Chunk** sends the chunk to Raven's R terminal.
- **REditorSupport.r installed, `raven.rConsole.activation` set to `"enabled"`**. Both rows work — Quarto's dispatches to REditorSupport's `r.runSelection`; Raven's runs the chunk in Raven's terminal.

Both extensions register CodeLens providers for `.qmd`, and VS Code doesn't expose a way for one extension to suppress another's lenses, so when both rows appear they stay independent. Quarto's check looks for the REditorSupport extension by ID, so Raven can't satisfy it from this side regardless of which commands Raven registers — the only clean fix lives upstream in the Quarto extension.

If the duplication bothers you and you're not relying on Quarto's other features (preview, format conversion, project tooling, or the Python / Julia / Observable cell executors), disabling the Quarto extension removes its row entirely — Raven's R console, chunk navigation, run commands, and CodeLens cover the same execution surface for `.qmd` files. Otherwise, the simplest habit is to use Raven's row for R chunks; Quarto's row remains useful for cells in other languages when their respective extensions are installed.

### `.Rmd` files belong to the `rmd` language

The Quarto extension contributes both `.qmd` and `.rmd` under `editorLangId == quarto`. When only Raven and Quarto are installed, VS Code's `contributes.languages` extension resolver can pick Quarto's claim over Raven's `rmd` contribution — the resolution order across extensions is not a documented invariant — so `.Rmd` files can end up tagged as `quarto`. Most Raven affordances handle both lang ids (run-line, navigation, CodeLens, the send-to-R menus), but **Knit Preview** is gated on `editorLangId == rmd || == r` and silently stops firing. The visible symptom is `Shift+Cmd+Enter` (`Shift+Ctrl+Enter` on Linux/Windows) triggering Quarto's "Editor selection is not within an executable cell" message instead of opening the knit preview.

Raven ships a `files.associations` default pinning `*.rmd` (the pattern is case-insensitive on VS Code's lookup, but Raven's `contributes.languages` extension list lives alongside as `.rmd` / `.Rmd` / `.RMD` for consistency) to the `rmd` language. `files.associations` is registered ahead of `contributes.languages` in VS Code's resolver, so this anchors `.Rmd` to `rmd` regardless of whether REditorSupport.r-syntax is installed alongside.

Trade-off: this also disables Quarto's `.Rmd`-targeted UI (Run Cell, Insert Cell, preview-related menus, the chunk CodeLens) for users who keep the default, because those gate on `editorLangId == quarto`. Quarto's `.qmd` handling is untouched. If you'd rather hand `.rmd` files back to Quarto, override the default explicitly in user or workspace settings:

```json
"files.associations": {
  "*.rmd": "quarto",
  "*.Rmd": "quarto",
  "*.RMD": "quarto"
}
```

`files.associations` is an object-merge setting, so the override above replaces only the keys it lists — other Raven `files.associations` defaults (none today, but possible in the future) stay in effect.
