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
> Both [arf](https://github.com/eitsupi/arf) and [radian](https://github.com/randy3k/radian) provide a significantly better interactive experience than the standard R console: syntax highlighting, multiline editing, and richer history. Note that radian is no longer under active development; its author [recommends arf](https://github.com/randy3k/radian) as the successor.

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

The Terminal submenu uses a temporary file and `source()` to send code, which avoids issues with large pastes over SSH or slow connections.

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

## Configuration Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `raven.rTerminal.program` | enum | `"R"` | Program for the R terminal: `"R"`, `"arf"`, or `"radian"` |
| `raven.sendToR.advanceCursorOnSend` | boolean | `true` | Advance cursor to next line after sending a single statement |
