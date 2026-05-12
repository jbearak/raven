# R Console

Raven provides an integrated R console inside VS Code, plus commands to send R code from the editor to that console for execution. It supports the standard R console as well as [arf](https://github.com/eitsupi/arf) and [radian](https://github.com/randy3k/radian) — modern third-party R consoles with syntax highlighting and richer interactive features.

The R console is the entry point to Raven's [plot viewer](./plot-viewer.md) and [data viewer](./data-viewer.md): plots produced in this console render in a VS Code panel via httpgd, and `View(df)` opens Raven's data viewer instead of R's default. Raven's [help viewer](./help-viewer.md) works independently of the R console.

> [!NOTE]
> Whether the R console activates is controlled by `raven.rConsole.activation` (default: `auto`). When the REditorSupport (R) extension is enabled or VS Code is running as Positron, Raven's R console — and therefore its plot and data viewers — is off by default. See [Coexistence](./coexistence.md) for details.

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
> Both [arf](https://github.com/eitsupi/arf) and [radian](https://github.com/randy3k/radian) add interactive features the standard R console lacks: syntax highlighting, multiline editing, popup completions, and `Ctrl+R` history search. radian is no longer under active development; arf is its successor.

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

Code sent via the Terminal submenu follows the same send method as the main commands. By default, Raven pastes short blocks directly and writes longer blocks to a temporary file, executing them with `source()`. **Terminal: Source File** runs `source()` directly against the document's saved path on disk (saving first if the buffer has unsaved changes).

## Statement Detection

When no text is selected, **Run Line or Selection** uses heuristics to detect complete R statements spanning multiple lines. The extension recognizes:

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

By default (`auto`), Raven pastes short blocks directly and switches to a temporary file once a block has at least `raven.sendToR.autoTempFileThresholdLines` lines (≥ N — default 25, so paste up to 24 lines, temp-file 25 or more), running it with `source()`. Override this with `raven.sendToR.sendMethod`:

- **`paste`** — always pastes. For multi-line code, uses bracketed paste mode to deliver the block as a single unit.
- **`tempfile`** — always writes to a temp file and runs `source()`. Use this when you want larger and smaller sends to follow the same `source()` path, or when even single-line paste is unreliable.

### Why `auto` switches to a temp file for larger blocks

Pasting works well for short blocks. For longer blocks it gets slow — the terminal feeds characters to R's stdin one at a time, so code that would start executing sooner via `source()` can take noticeably longer to type out. Pasting can also be unreliable over remote sessions (SSH, VS Code Remote, mosh): if too many lines arrive at once they sometimes get garbled.

Writing larger blocks to a temp file and `source()`-ing them sidesteps both, avoiding the inter-line paste delay and bracketed-paste compatibility issues for those blocks. `source(echo = TRUE)` also produces cleaner output, with `+` continuation prompts matching how R normally displays interactive input.

The cutover point is controlled by `raven.sendToR.autoTempFileThresholdLines` — a block with at least this many lines (≥ N) goes through a temp file; smaller blocks are pasted. The default of 25 is arbitrary but reasonable — most blocks below it paste fast and reliably on a local terminal. Lower it for slow remote connections; raise it if you prefer to see your code echoed in the terminal. Setting it to 2 reproduces the prior behavior of always temp-filing any multi-line block.

For a comparison with how the [REditorSupport (R) extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) sends code, see [Comparison: R console](./comparison.md#r-console). If you prefer paste-everywhere behavior — for example, because you want raw paste output rather than `source()` echoing — set `raven.sendToR.sendMethod` to `"paste"`.

## Configuration Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `raven.rConsole.activation` | enum | `"auto"` | When Raven's R console activates: `"enabled"`, `"disabled"`, or `"auto"` (off when REditorSupport.r is enabled or running in Positron). |
| `raven.rTerminal.program` | enum | `"R"` | Program for the R terminal: `"R"`, `"arf"`, or `"radian"` |
| `raven.sendToR.advanceCursorOnSend` | boolean | `true` | Advance cursor to next line after sending a single statement |
| `raven.sendToR.sendMethod` | enum | `"auto"` | How code is sent to R: `"auto"`, `"paste"`, or `"tempfile"` |
| `raven.sendToR.autoTempFileThresholdLines` | integer | `25` | In `auto` mode, blocks with **≥ N lines** use a temp file; smaller blocks are pasted (so `25` means: paste up to 24 lines, temp-file 25 or more) |
