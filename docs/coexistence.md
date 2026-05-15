# Coexistence with Other R Extensions

Raven's VS Code extension includes both a **language server** (completions, diagnostics, navigation) and **R-session features** (R console, plot viewer, data viewer, help viewer). If you also use the [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) or [Positron](https://github.com/posit-dev/positron), Raven is designed to stay out of the way by default.

## What steps aside and what doesn't

Raven's **language server** and **help viewer** always activate — they don't overlap with a running R session.

Raven's **R console**, **plot viewer**, and **data viewer** are the features that can overlap with another extension's R-session integration. The plot and data viewers are reached *through* Raven's R console: the R console boots a profile that overrides `View()` (data viewer) and starts httpgd (plot viewer). When Raven's R console isn't activated, neither of those viewers is wired up — `View(df)` and `plot(...)` go to whatever R session your other extension manages.

## Who benefits from Raven's R console?

Raven's R console, plot viewer, and data viewer overlap with [REditorSupport (R)](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r)'s equivalents. Whether Raven's versions help you depends on your workflow:

- **You'd benefit** — e.g., you send large blocks to R over `tmux` / SSH (Raven's temp-file `source()` sidesteps bracketed-paste issues), or you regularly view large frames (Raven's data viewer streams Arrow rows on demand). See [Comparison: R session integration](./comparison.md#r-session-integration).
- **No practical improvement** — for smaller frames on local R sessions, REditorSupport handles the job well. There's no reason to switch; keep using REditorSupport. You can still use Raven's language server for the cross-file awareness REditorSupport doesn't provide.
- **You'd lose something** — REditorSupport has features Raven doesn't, including R Markdown (chunk highlighting, navigation, CodeLens, preview), a workspace viewer, an htmlwidget / Shiny viewer, and a list / environment tree. If you rely on any of these, keep REditorSupport's R-session features. If you also want Raven's console for `.R` scripts — while REditorSupport's console continues to handle your `.Rmd` work — set `raven.rConsole.activation` to `"enabled"` so both R consoles are available. `Cmd+Enter` / `Ctrl+Enter` can only be bound to one extension's send command; VS Code's keybinding editor lets you rebind either. (`View()` overrides aren't a cross-extension concern — each console rebinds `View()` inside its own R session, so whichever console you're in owns its own override.)

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
