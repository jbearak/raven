# Send to R

The extension provides an interactive R console and commands to send R code directly from the editor to R for execution. It supports the standard R console as well as [arf](https://github.com/eitsupi/arf) and [radian](https://github.com/randy3k/radian) — modern third-party R consoles with syntax highlighting and richer interactive features.

## R Terminal Profile

The extension registers an "R" terminal profile in VS Code's terminal dropdown. You can open an R terminal manually from the terminal profile picker at any time.

### Choosing the R program

The `raven.rTerminal.program` setting controls which program is launched:

| Value | Description |
|-------|-------------|
| **R** (default) | Standard R console |
| **arf** | Rust-based R console with syntax highlighting, fuzzy history search (`Ctrl+R`), interactive help, and rig integration |
| **radian** | Python-based R console with syntax highlighting, multiline editing, and mouse support |

> [!TIP]
> Both [arf](https://github.com/eitsupi/arf) and [radian](https://github.com/randy3k/radian) provide a significantly better interactive experience than the standard R console: syntax highlighting, multiline editing, popup completions, and `Ctrl+R` history search. Note that radian is no longer under active development; its author [recommends arf](https://github.com/randy3k/radian) as the successor.

The selected program must be available on your PATH.

## Keyboard Shortcuts

| Mac | Windows/Linux | Action |
|-----|---------------|--------|
| `Cmd+Enter` | `Ctrl+Enter` | Run line or selection |
| `Shift+Cmd+Enter` | `Shift+Ctrl+Enter` | Source file |

> [!TIP]
> You can also access these commands via the editor toolbar menu (`▶` button) or the command palette (`Cmd+Shift+P`).

## Commands

| Command | Description |
|---------|-------------|
| **Run Line or Selection** | Sends the current selection to R. If no selection, detects and sends the complete multi-line statement at the cursor. |
| **Run Upward Lines** | Sends all lines from the start of the file to the current line (extending to complete any multi-line statement). |
| **Run Downward Lines** | Sends all lines from the current line to the end of the file (extending upward to include the full statement start). |
| **Source File** | Runs `source("filepath", echo = TRUE)` in the R terminal. |

## Editor Toolbar

A toolbar button (▶) appears in the editor title bar for R files, providing quick access to all send commands. The menu is organized into two sections:

- **Main commands** — Send code to the managed R (Raven) terminal. If no R terminal is open, one is created automatically.
- **Terminal submenu** — Send code to whatever terminal is currently active in VS Code, regardless of type. This is useful for sending commands to R running inside `tmux`, a Docker container, or any other terminal session that isn't the extension's built-in R terminal.

Code sent via the Terminal submenu follows the same send method as the main commands. By default, Raven pastes single-line code directly and writes multi-line code to a temporary file, executing it with `source()`. **Terminal: Source File** runs `source()` directly against the document's saved path on disk (saving first if the buffer has unsaved changes).

## Statement Detection

When no text is selected, **Run Line or Selection** intelligently detects complete R statements spanning multiple lines. The extension recognizes:

- **Unmatched brackets** — `(`, `[`, `{` that haven't been closed
- **Trailing operators** — lines ending with `+`, `-`, `*`, `/`, `|>`, `%>%`, `%any%`, `||`, `&&`, `|`, `&`, `~`, `=`, `<-`, `->`, `,`, `::`, `:::`
- **Continuation lines** — lines starting with `|>`, `%>%`, `)`, `]`, `}`, `+`, or other operators

This means pipe chains, multi-line function calls, ggplot layers, and if/else blocks are sent as complete units:

```r
# Cursor anywhere in this block sends all 3 lines:
df |>
  filter(x > 1) |>
  select(a, b)

# Same for ggplot:
ggplot(df, aes(x, y)) +
  geom_point() +
  theme_minimal()

# And function calls:
result <- foo(
  x = 1,
  y = 2
)
```

## Cursor Advancement

By default, the cursor advances to the next line after sending a single statement (not a selection or file). This allows rapid line-by-line execution with repeated `Cmd+Enter` presses.

**Configuration**: `raven.sendToR.advanceCursorOnSend` (default: `true`)

## Send Method

By default (`auto`), Raven pastes single-line code directly and writes multi-line code to a temporary file, executing it with `source()`. Override this with `raven.sendToR.sendMethod`:

- **`paste`** — always pastes. For multi-line code, uses bracketed paste mode to deliver the block as a single unit.
- **`tempfile`** — always writes to a temp file and runs `source()`. Use this for maximum consistency, or when even single-line paste is unreliable.

**Why Raven defaults to temp files for multi-line code**

When multi-line code is pasted, the terminal delivers characters to R's stdin faster than readline can process them, which can silently drop or corrupt lines. This affects the standard R console as well as arf and radian. Writing to a temp file sidesteps this entirely: R reads from disk rather than stdin, so there is no terminal paste-buffer race, no practical paste-size limit from stdin buffering, and no sensitivity to connection speed.

`source(echo = TRUE)` also produces cleaner output: code is echoed line-by-line with `+` continuation prompts, matching how R normally displays interactive input.

REditorSupport pastes directly for all code. If you prefer that behavior — for example, because you want raw paste output rather than `source()` echoing — set `raven.sendToR.sendMethod` to `"paste"`.

## Configuration Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `raven.rTerminal.program` | enum | `"R"` | Program for the R terminal: `"R"`, `"arf"`, or `"radian"` |
| `raven.sendToR.advanceCursorOnSend` | boolean | `true` | Advance cursor to next line after sending a single statement |
| `raven.sendToR.sendMethod` | enum | `"auto"` | How code is sent to R: `"auto"`, `"paste"`, or `"tempfile"` |

## Plot Viewer

When `raven.plot.enabled` is `true` (the default), Raven shows plots from the
managed R terminal directly in VS Code via a built-in viewer.

### Prerequisites

Install the [httpgd](https://nx10.dev/httpgd/) R package, version `2.0.2` or
newer:

```r
install.packages("httpgd")
```

No other R packages are required. Standard R, [arf](https://github.com/eitsupi/arf),
and [radian](https://github.com/randy3k/radian) all work because Raven loads its
bootstrap profile via `R_PROFILE_USER`.

### Behavior

- Run any plotting code in the Raven R terminal (e.g., `plot(1:10)`, `ggplot(...) + geom_point()`).
- The first plot from each R session opens its own "Raven Plot Viewer" panel
  in the column configured by `raven.plot.viewerColumn` (default: `beside`).
  The second session's panel is "Raven Plot Viewer 2", the third "Raven Plot
  Viewer 3", and so on (numbered per VS Code window). Each R terminal
  therefore gets a separate viewer with its own plot history.
- Subsequent plots from the same session update that session's panel without
  stealing focus from your editor.
- The viewer toolbar provides previous/next history navigation, remove
  current plot, copy to clipboard, save (PNG/SVG/PDF), and open externally.
  Right-clicking a plot copies it to the clipboard as PNG.
- If your terminal exits (R session ends), the last rendered plot stays
  visible with an "R session ended" indicator and must be closed manually.
- When a new R session is started or the panel is reopened, a subsequent
  plot from that new session will recreate the plot panel.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `raven.plot.enabled` | `true` | Enable the plot viewer for Raven-managed terminals. |
| `raven.plot.viewerColumn` | `beside` | Initial column when a new viewer opens. |

### Troubleshooting

- **No viewer appears.** Confirm httpgd is installed (`packageVersion("httpgd")`)
  and that you're running R inside a terminal launched via Raven (the terminal
  profile dropdown's "R (Raven)" entry, or any of Raven's send-to-R commands).
  Plots from terminals you opened manually outside Raven won't trigger the viewer.
- **httpgd console message about installing or upgrading.** Follow the printed
  `install.packages("httpgd")` instructions. Plots fall back to R's default
  graphics device until httpgd is available.

## Data Viewer

When `raven.dataViewer.enabled` is `true` (the default), Raven overrides R's
`View()` so calls in a Raven-managed R terminal open in a virtualized grid
panel that scales smoothly to multi-million-row data frames.

```r
View(mtcars)
View(head(iris, 50))
View(my_df, "Custom panel name")
```

Other classes raise an error in R, mirroring Positron:

```r
> View(1)
Error in `View()`:
! Can't `View()` an object of class `numeric`
```

The toolbar offers a Labels toggle (factor codes ↔ levels, plus
`haven_labelled` value labels), a Format toggle with a digits dropdown,
and a Columns popover for hide/show. `Cmd/Ctrl+C` copies a rectangular
selection as TSV honoring the active toggles.

Requires the [`arrow`](https://arrow.apache.org/docs/r/) R package.

See [docs/data-viewer.md](./data-viewer.md) for full settings and
behavior.
