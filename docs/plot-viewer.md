# Plot Viewer

Raven shows plots from its managed R terminal directly in VS Code via a built-in viewer panel. The viewer is backed by [httpgd](https://nx10.dev/httpgd/), a headless graphics device for R that exposes plots over a local HTTP/WebSocket server. Each R session gets its own plot panel with independent history, theme-aware backgrounds, and export to PNG, SVG, or PDF.

> [!NOTE]
> The plot viewer is reached through Raven's R console: it activates only when Raven's R console activates (`raven.rConsole.activation`, default: `auto`). When the REditorSupport (R) extension is enabled or VS Code is running as Positron, Raven's R console — and therefore the plot viewer — is off by default. See [Coexistence](./coexistence.md) for details.

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
- The viewer toolbar provides previous/next history navigation, remove the current plot, and three icon-only controls on the right: a **share** icon that opens a popover with **Copy** / **PNG** / **SVG** / **PDF** export actions, an **Open in browser** button, and an **Apply VS Code theme** toggle (a color-palette icon; the button background fills with the accent color when on). Hover any icon for a descriptive tooltip; assistive technologies read the same labels via `aria-label`. Right-clicking a plot copies it to the clipboard as PNG.
- If your terminal exits (R session ends), the last rendered plot stays visible with an "R session ended" indicator and must be closed manually.
- When a new R session is started or the panel is reopened, a subsequent plot from that new session will recreate the plot panel.

## Color theme

The toolbar's **Apply VS Code theme** button recolors the live plot to match your active editor theme. When on, the plot's canvas background is hidden by a CSS overlay (the webview's editor background shows through), axis labels and tick text use `--vscode-editor-foreground`, and the strokes of other shape elements (axes, gridlines, and the outlines of shapes such as bars) use the same foreground color. When off, plots render with their R-supplied colors against a white canvas (the default — matches what `plot()` and `ggplot()` produce in any other R environment).

The setting is **off by default**, persists globally via VS Code's `Memento`, and applies to every open plot panel — toggling in one panel updates the others. There is no command-palette entry or keybinding; the toolbar button is the only control. (Parity with REditorSupport.R's `r.plot.toggleStyle`.)

### Known limitations

- **User-supplied colors are clobbered.** Aesthetic mappings like `aes(color = species)` or `plot(..., col = "red")` are overridden by the CSS overlay's `stroke: var(--vscode-editor-foreground)` rule. If you want to see your palette, turn the toggle off.
- **Text positions may shift.** httpgd computes text widths at render time using R's chosen font; the CSS overlay forces `--vscode-editor-font-family`, which can produce different glyph widths and cause rotated tick labels or dense legends to overlap. For publication-quality output use Export PNG / SVG with the toggle off.
- **Exported images aren't retinted.** Copy, Save (PNG/SVG/PDF), and Open in browser always use httpgd's default (white) background so shared images stay portable across themes. The toggle is webview-only.
- **Light themes change less.** On a light theme the editor's background is near-white and the foreground is near-black, so the visible difference vs. the default plot is subtle.

### Substrate (for the curious)

The toggle works by rendering the plot as **inline SVG** inside the webview's document (not as `<img src=>`). This lets CSS variables and selectors reach into the SVG nodes. The SVG is sanitized by [DOMPurify](https://github.com/cure53/DOMPurify) before insertion (script tags, event handlers, external references, and inline `style="..."` attributes are stripped). Safe presentation properties (fill, stroke, font, etc.) are first migrated from `style="..."` to SVG presentation attributes, so plot colors survive the sanitizer.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `raven.plot.viewerColumn` | `beside` | Initial column when a new viewer opens. |

The viewer's overall enable/disable is controlled by `raven.rConsole.activation` — there is no separate `raven.plot.enabled` toggle.

## Troubleshooting

- **No viewer appears.** Confirm httpgd is installed (`packageVersion("httpgd")`) and that you're running R inside a terminal launched via Raven (the terminal profile dropdown's "R" entry, or any of Raven's send-to-R commands). Plots from terminals you opened manually outside Raven won't trigger the viewer.
- **httpgd console message about installing or upgrading.** Follow the printed `install.packages("httpgd")` instructions. Plots fall back to R's default graphics device until httpgd is available.
- **The plot viewer doesn't activate at all.** Check `raven.rConsole.activation`. If you have the REditorSupport (R) extension enabled or you're using Positron, the default `auto` value leaves Raven's R-session features off. Set it to `"enabled"` to turn them on.
