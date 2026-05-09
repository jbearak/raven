# Plot Viewer

Raven shows plots from its managed R terminal directly in VS Code via a built-in viewer panel. The viewer is backed by [httpgd](https://nx10.dev/httpgd/), a headless graphics device for R that exposes plots over a local HTTP/WebSocket server. Each R session gets its own plot panel with independent history, theme-aware backgrounds, and export to PNG, SVG, or PDF.

> [!NOTE]
> The plot viewer is reached through Raven's R console: it activates only when Raven's R console activates (`raven.rConsole.activation`, default: `auto`). When the REditorSupport (R) extension is enabled or VS Code is running as Positron, Raven's R console — and therefore the plot viewer — steps aside automatically. See [Comparison: Coexistence](./comparison.md#coexistence) for details.

## Prerequisites

Install the [httpgd](https://nx10.dev/httpgd/) R package, version `2.0.2` or newer:

```r
install.packages("httpgd")
```

No other R packages are required. Standard R, [arf](https://github.com/eitsupi/arf), and [radian](https://github.com/randy3k/radian) all work because Raven loads its bootstrap profile via `R_PROFILE_USER`.

## Behavior

- Run any plotting code in the Raven R terminal (e.g., `plot(1:10)`, `ggplot(...) + geom_point()`).
- The first plot from each R session opens its own "Raven Plot Viewer" panel in the column configured by `raven.plot.viewerColumn` (default: `beside`). The second session's panel is "Raven Plot Viewer 2", the third "Raven Plot Viewer 3", and so on (numbered per VS Code window). Each R terminal therefore gets a separate viewer with its own plot history.
- Subsequent plots from the same session update that session's panel without stealing focus from your editor.
- The viewer toolbar provides previous/next history navigation, remove current plot, copy to clipboard, save (PNG/SVG/PDF), and open externally. Right-clicking a plot copies it to the clipboard as PNG.
- If your terminal exits (R session ends), the last rendered plot stays visible with an "R session ended" indicator and must be closed manually.
- When a new R session is started or the panel is reopened, a subsequent plot from that new session will recreate the plot panel.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `raven.plot.viewerColumn` | `beside` | Initial column when a new viewer opens. |

The viewer's overall enable/disable is controlled by `raven.rConsole.activation` — there is no separate `raven.plot.enabled` toggle.

## Troubleshooting

- **No viewer appears.** Confirm httpgd is installed (`packageVersion("httpgd")`) and that you're running R inside a terminal launched via Raven (the terminal profile dropdown's "R (Raven)" entry, or any of Raven's send-to-R commands). Plots from terminals you opened manually outside Raven won't trigger the viewer.
- **httpgd console message about installing or upgrading.** Follow the printed `install.packages("httpgd")` instructions. Plots fall back to R's default graphics device until httpgd is available.
- **The plot viewer doesn't activate at all.** Check `raven.rConsole.activation`. If you have the REditorSupport (R) extension enabled or you're using Positron, the default `auto` value disables Raven's R-session features. Set it explicitly to `"enabled"` to override.
