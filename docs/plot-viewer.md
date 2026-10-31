# Plot viewer

[Docs](README.md) › R session (VS Code)

See plots from Raven's R console in a VS Code panel, with plot history and export to PNG, SVG, or PDF.

| You do | Raven does |
|---|---|
| Run `plot(1:10)` or `ggplot(df, aes(x, y)) + geom_point()` in the R terminal | Opens a "Raven Plot Viewer" panel beside your editor and shows the plot |
| Run another plot | Adds it to that panel's history without taking focus from your editor |
| Click the share icon, then PNG | Exports the current plot as PNG |

The viewer uses [httpgd](https://nx10.dev/httpgd/), a headless graphics device for R that serves plots over a local HTTP/WebSocket server. Each R session gets its own panel with independent history.

The plot viewer works only when Raven's R console is active, which by default it isn't in Positron; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting).

## Prerequisites

Install the [httpgd](https://nx10.dev/httpgd/) R package, version `2.0.2` or newer:

```r
install.packages("httpgd")
```

No other R packages are required. Standard R, [arf](https://github.com/eitsupi/arf), and [radian](https://github.com/randy3k/radian) all work, because Raven loads its startup profile through `R_PROFILE_USER`.

<a id="behavior"></a>

## View and save plots

- Run any plotting code in the R terminal Raven manages, for example `plot(1:10)` or `ggplot(...) + geom_point()`.
- The first plot from each R session opens its own "Raven Plot Viewer" panel in the column set by `raven.plot.viewerColumn` (default: `beside`). The second session's panel is "Raven Plot Viewer 2", the third "Raven Plot Viewer 3", and so on, numbered per VS Code window. Each R terminal gets a separate viewer with its own plot history.
- Later plots from the same session update that session's panel without taking focus from your editor.
- If the R session ends, the last plot stays visible with an "R session ended" indicator until you close the panel.
- When you start a new R session or reopen the panel, the next plot from the new session recreates the panel.

The toolbar has previous and next buttons for history, a button that removes the current plot, and three icons on the right:

- A share icon that opens Copy, PNG, SVG, and PDF export actions.
- Open in browser.
- Apply VS Code theme, a color-palette icon whose background fills with the accent color when on (see [Color theme](#color-theme)).

Hover any icon for a tooltip. The three right-side controls also have accessible labels for screen readers; the history and remove buttons rely on their tooltip text. Right-clicking a plot copies it to the clipboard as PNG.

## Color theme

The toolbar's Apply VS Code theme button recolors the live plot to match your editor theme. When on, the plot's canvas background is hidden so the editor background shows through, axis labels and tick text use the editor's foreground color, and the strokes of other shapes (axes, gridlines, and the outlines of shapes such as bars) use the same foreground color. When off, plots render with their R-supplied colors on a white canvas, which matches what `plot()` and `ggplot()` produce in any other R environment.

The toggle is off by default, is remembered across VS Code sessions, and applies to every open plot panel: toggling it in one panel updates the others. The toolbar button is the only control; there is no Command Palette entry or keybinding. It matches REditorSupport's `r.plot.toggleStyle`.

## Troubleshooting

- No viewer appears. Confirm httpgd is installed (`packageVersion("httpgd")`) and that R is running in a terminal Raven launched (the "R" entry in the terminal profile dropdown, or any of Raven's send-to-R commands). Plots from terminals you opened outside Raven don't reach the viewer.
- R prints a message about installing or upgrading httpgd. Follow the printed `install.packages("httpgd")` instructions. Plots go to R's default graphics device until httpgd is available.
- The plot viewer doesn't activate at all. Raven's R console is probably off; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting) for when it activates and how to turn it on.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `raven.plot.viewerColumn` | `beside` | Initial column when a new viewer opens. |

There is no separate on/off setting for the plot viewer; it follows Raven's R console. See the [settings reference](settings-reference.md) for all settings.

<a id="known-limitations"></a>

## Limitations

These apply to the Apply VS Code theme toggle:

- Your own colors are overridden. Aesthetic mappings like `aes(color = species)` or `plot(..., col = "red")` are replaced by the theme's foreground color. Turn the toggle off to see your palette.
- Text positions may shift. httpgd measures text with R's chosen font, while the themed view uses the editor's font, which can have different glyph widths. Rotated tick labels or dense legends can overlap. For publication-quality output, export PNG or SVG with the toggle off.
- Exported images aren't recolored. Copy, PNG, SVG, PDF, and Open in browser always use httpgd's default white background, so shared images look the same in any theme. The toggle affects only the panel.
- Light themes change less. On a light theme the editor background is near-white and the foreground near-black, so the difference from the default plot is subtle.

## Details

<a id="substrate-for-the-curious"></a>

### How the theme toggle reaches the plot

The panel shows each plot as SVG embedded in the page rather than as an image, which lets the theme's colors and fonts reach individual plot elements. Before display, the SVG is sanitized with [DOMPurify](https://github.com/cure53/DOMPurify): scripts, event handlers, external references, and inline `style` attributes are removed. Presentation properties such as fill, stroke, and font are kept, so plot colors survive sanitizing.

## See also

- [R console](r-console.md)
- [Data viewer](data-viewer.md)
- [Coexistence with other R extensions](coexistence.md)
