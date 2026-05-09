# Coexistence with Other R Extensions

Raven's VS Code extension includes both a **language server** (completions, diagnostics, navigation) and **R-session features** (R console, plot viewer, data viewer, help viewer). If you also use the [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) or [Positron](https://github.com/posit-dev/positron), Raven is designed to stay out of the way by default.

## What steps aside and what doesn't

Raven's **language server** and **help viewer** always activate — they don't overlap with a running R session.

Raven's **R console**, **plot viewer**, and **data viewer** are the features that can overlap with another extension's R-session integration. The plot and data viewers are reached *through* Raven's R console: the R console boots a profile that overrides `View()` (data viewer) and starts httpgd (plot viewer). When Raven's R console isn't activated, neither of those viewers is wired up — `View(df)` and `plot(...)` go to whatever R session your other extension manages.

## The `raven.rConsole.activation` setting

The `raven.rConsole.activation` setting (default: `"auto"`) controls whether Raven's R console — and therefore its plot and data viewers — activates:

- **`"auto"`** (default) — Raven's R-session features activate *unless* the REditorSupport (R) extension is enabled or VS Code is running as Positron. This keeps Raven out of the way when you already have R-session integration.
- **`"enabled"`** — Always activate Raven's R-session features, even alongside other R extensions. You'll then be responsible for any keybinding or `View()`-override conflicts.
- **`"disabled"`** — Never activate Raven's R-session features, even when no other R extension is present.

The help viewer activates regardless of this setting. It shells out to R on demand to render Rd documentation as HTML, so it works whether or not Raven's R console is active — provided Raven can run the configured R executable.

## Language servers: Raven alone vs. both

Raven's language server traces `source()` chains across your project, so its completions, diagnostics, and navigation reflect actual execution order at the cursor position — including cross-file go-to-definition, find-references, and detection of circular dependencies and scope violations. It doesn't need a running R session.

REditorSupport's language server provides [`lintr`](https://lintr.r-lib.org/) diagnostics, which covers a different surface than Raven's diagnostics: it catches style violations and certain correctness issues that Raven doesn't flag, while Raven catches cross-file scope problems that lintr doesn't see.

If you want both, leave `r.lsp.enabled` at its default (`true`). Both language servers will run, with some overlap in completions and diagnostics.

If you only need Raven's language intelligence and want REditorSupport solely for its R-session features, disable its language server so the two don't compete:

```json
"r.lsp.enabled": false
```

See [Editor Integrations](./editor-integrations.md) for setup details across editors.
