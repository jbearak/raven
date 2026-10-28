# R Console

Raven provides an integrated R console inside VS Code, plus commands to send R code from the editor to that console for execution. By default it uses [Raven's own console](#ravens-console), which adds syntax highlighting, multi-line editing, Tab completion, and colored output to the R you already have. You can switch to the standard R console, or to [arf](https://github.com/eitsupi/arf) or [radian](https://github.com/randy3k/radian), third-party R consoles.

The R console is the entry point to Raven's [plot viewer](./plot-viewer.md) and [data viewer](./data-viewer.md): plots produced in this console render in a VS Code panel via httpgd, and `View(df)` opens Raven's data viewer instead of R's default. Raven's [help viewer](./help-viewer.md) works independently of the R console.

> [!NOTE]
> Whether the R console activates is controlled by `raven.rConsole.activation` (default: `auto`). When the REditorSupport extension is enabled or VS Code is running as Positron, Raven's R console — and therefore its plot and data viewers — is off by default. See [Coexistence](./coexistence.md) for details.

## R Terminal Profile

The extension registers an "R" terminal profile in VS Code's terminal dropdown. You can open an R terminal manually from the terminal profile picker at any time.

### Choosing the R program

The `raven.rTerminal.program` setting controls which program is launched:

| Value | Description |
|-------|-------------|
| **raven** (default) | [Raven's console](#ravens-console), built into Raven. macOS and Linux; on Windows this setting starts plain R. |
| **R** | Standard R console |
| **arf** | Rust-based R console with syntax highlighting, fuzzy history search (`Ctrl+R`), interactive help, and rig integration |
| **radian** | Python-based R console with syntax highlighting, multiline editing, and mouse support |

arf and radian must be available on your PATH. Raven's console needs only R itself.

## Raven's console

Raven's console runs the same R you get by typing `R` in a terminal: the one on your `PATH`, or `R_HOME` if you set it. It loads that installation's R library into its own process and drives R's own read–eval–print loop. Everything R does at its prompt works as usual: autoprinting, `.Last.value`, `browser()`, `readline()`, `menu()`, error recovery, and your `.Rprofile` and `.Renviron`. If the console can't embed your R (for example, R built without `--enable-R-shlib`), it says why in one line and starts plain R instead, so you always get a working session.

### Editing

- **Syntax highlighting** as you type, using the same R grammar as Raven's language server. The bracket at the cursor and its match are underlined.
- **Multi-line editing.** Enter runs your input when R's own parser says it is complete, and starts a new, indented line when it isn't — after `function(x) {`, `data.frame(a = 1,` or a trailing `|>`, just as in plain R. A syntax error is reported by R rather than leaving you stuck in continuation lines. **Alt+Enter** always inserts a newline. Arrow keys move between lines.
- **History** is kept across sessions (`~/Library/Application Support/raven/console_history` on macOS, `~/.local/share/raven/console_history` on Linux). Up and Down step through earlier entries, and a multi-line entry comes back whole. **Ctrl+R** searches history for text you type, and a dimmed suggestion from history appears as you type; press → to accept it.
- **Emacs key bindings** by default; set `raven.console.editMode` to `vi` for vi bindings.
- **Ctrl+C** clears the line you're editing, or interrupts R while it runs. At a `+` continuation line it abandons the unfinished expression, and at a `readline()` or `menu()` prompt it interrupts the code that asked, as in plain R. **Ctrl+D** on an empty line quits.
- `options(width)` follows the terminal width as you resize it, unless you set `width` yourself.

### Completion

Press **Tab** to complete. A single match is inserted directly; otherwise a menu opens. Keep typing to narrow it, use Tab/Shift+Tab or the arrow keys to move, Enter to accept, and Esc to close. Completion uses R's own completion engine on your live session. It covers objects and functions, `df$` columns, `obj@` slots, function arguments (`name = `), `pkg::` exports, and file paths inside strings. After `library(`, `require(`, `requireNamespace(` or `loadNamespace(`, it completes installed package names. If a completion is slow, Ctrl+C interrupts it, as it would interrupt any R code; compiled code that never checks for interrupts can't be stopped this way.

### Colored output

The console colors output with your terminal theme's own palette, so it suits light and dark themes without configuration. `raven.console.colorOutput` chooses how much:

| Value | Effect |
|-------|--------|
| **streams** (default) | Errors in red, warnings in yellow, and other messages in cyan. Ordinary output is unchanged. |
| **values** | Also colors printed values, like the [colorout](https://github.com/jalvesaq/colorout) package: numbers, quoted strings, `NA`/`NULL`/`TRUE`/`FALSE`/`Inf`, and `[1]`-style indices. Numbers inside words, such as hashes, hostnames, versions and `x86_64`, are left alone. |
| **off** | No colors added. |

Output that already has colors, such as from the cli package or crayon, always keeps them. R gives the console text, not condition objects, so the colors come from recognising R's own error and warning headers (in your session's language). The rare message that happens to start like an R warning will be colored as one.

Raven's console replaces colorout. If your `.Rprofile` loads colorout, the console turns it off for that session and says so in one dimmed line; colorout writes to the terminal directly, which would bypass the console's handling of output. Use `raven.console.colorOutput` = `values` for colorout-style colors.

### Running code from the editor

Code you send from the editor (Run Line or Selection, Run Chunk, Source File, and so on) goes straight to the console instead of being typed into the terminal, so blocks of any size start immediately. The console shows each line at its prompt with highlighting, as if you'd typed it, with output in between. If a line fails with an error, the rest of that block doesn't run, so you get one error instead of a cascade. Anything you were typing at the console prompt is set aside and comes back afterwards.

### Outside VS Code

The console is the `raven console` command of the `raven` binary (see [CLI](./cli.md#raven-console)), so you can run it in any terminal. R's own options pass through, e.g. `raven console --no-save --vanilla`.

## Keyboard Shortcuts

| Mac | Windows/Linux | Action |
|-----|---------------|--------|
| `Cmd+Enter` | `Ctrl+Enter` | Run line or selection (every supported file type) |
| `Shift+Cmd+Enter` | `Shift+Ctrl+Enter` | Source File (`.R`), Knit Preview (`.Rmd` / `.Rmarkdown`), or Quarto Preview (`.qmd`); all require Raven's R console to be active |

> [!TIP]
> You can also access these commands via the editor toolbar menu (`▶` button) or the command palette (`Cmd+Shift+P`).

## Commands

| Command | Description |
|---------|-------------|
| **Run Line or Selection** | Sends the current selection to R. If no selection, detects and sends the complete multi-line statement at the cursor. |
| **Run Upward Lines** | Sends all lines from the start of the file to the current line (extending to complete any multi-line statement). |
| **Run Downward Lines** | Sends all lines from the current line to the end of the file (extending upward to include the full statement start). |
| **Source File** | Runs `source("filepath", echo = TRUE)` in the R terminal. |

### Quick Inspection Commands

These commands wrap the word under the cursor (or the current selection) in a common inspection function and send it to the R terminal — one keystroke to check an object's shape. They're registered under the **Raven** category, so typing `Raven:` in the Command Palette surfaces them all. No default keybindings; bind them in `keybindings.json` if you want shortcuts.

| Command | Sends to R |
|---------|------------|
| **Raven: Show nrow** | `nrow(<target>)` |
| **Raven: Show length** | `length(<target>)` |
| **Raven: Show head** | `head(<target>)` |
| **Raven: Show head (transposed)** | `t(head(<target>))` |
| **Raven: Show names** | `names(<target>)` |
| **Raven: View** | `View(<target>)` |

If a selection is active, the entire selection is used as the target — handy for expressions like `df$col` or `subset(df, x > 0)`. Otherwise the word at the cursor is used. The commands run when the active editor's language is `r`, `rmd`, or `quarto` — placing the cursor on an R identifier inside an R chunk inside a `.Rmd` / `.Rmarkdown` / `.qmd` file is the intended use; placing it on a prose word will send something to R that R will reject.

Single-line wrapped expressions go straight to the terminal via direct paste; if the wrapped expression spans multiple lines (because the selection did), it honors the user's `raven.sendToR.sendMethod` setting. This avoids writing a one-liner like `nrow(x)` to a temp file just because `tempfile` mode is configured for normal sends.

## Editor Toolbar

A toolbar button (▶) appears in the editor title bar for `.R`, `.Rmd`, `.Rmarkdown`, and `.qmd` files, providing quick access to send commands relevant to the open file's type. The menu is organized into two sections:

- **Main commands** — Send code to the managed R terminal. If no R terminal is open, one is created automatically.
- **Terminal submenu** — Send code to whatever terminal is currently active in VS Code, regardless of type. This is useful for sending commands to R running inside `tmux`, a Docker container, or any other terminal session that isn't the extension's built-in R terminal.

For `.R` files, the menu shows **Run Line or Selection**, **Run Upward Lines**, **Run Downward Lines**, **Source File**, and the **Terminal** submenu (which mirrors the same four entries against the active terminal). Chunk commands are reserved for chunk-based documents — `.R` files with `# %%` cells access **Run Current Chunk** etc. through the CodeLens or the command palette, not the toolbar. For `.Rmd`, `.Rmarkdown`, and `.qmd` files, the entries that auto-include prose or YAML — **Run Upward Lines**, **Run Downward Lines**, and **Source File** — are hidden, and the menu shows **Run Line or Selection**, the current-chunk pair (**Run Current Chunk**, **Run Current Chunk and Move**), the directional pair (**Run Above Chunks**, **Run Below Chunks**), the whole-document pair (**Run All Chunks**, plus **Knit Preview** and the **Knit: Export to HTML / PDF / Word** commands for `.Rmd` / `.Rmarkdown` files when Raven's R console is active), and the **Terminal** submenu. Inside the Terminal submenu the same chunk pairs mirror the main menu (sans the knit commands, since knitr always renders against the document on disk rather than the active terminal). The Source-File keyboard shortcut (`Shift+Cmd+Enter` / `Shift+Ctrl+Enter`) is repurposed on `.Rmd` / `.Rmarkdown` files when knit is enabled to invoke **Knit Preview**, and on `.qmd` files to invoke **Quarto Preview**. Quarto Preview and Render require Raven's R console to be active and a trusted workspace. When the console gate is closed, the Preview shortcut is unbound; **Stop Quarto Preview** remains available from the Command Palette so an existing process can still be cleaned up.

Code sent via the Terminal submenu follows the same send method as the main commands. By default, Raven pastes short blocks directly and writes longer blocks to a temporary file, executing them with `source()`. **Terminal: Source File** runs `source()` directly against the document's saved path on disk (saving first if the buffer has unsaved changes).

> [!TIP]
> **Remote sessions and long-running jobs** — If you're connected to a remote host via VS Code Remote Development and want an R session that survives disconnections (closing your laptop, losing internet, etc.), launch a terminal multiplexer like `tmux` and start R inside it. Then use the Terminal submenu to send code to that tmux-hosted R session. Because tmux keeps running on the remote host independently of your VS Code connection, you can disconnect and reconnect hours or days later with your session — and any long-running computation (MCMC sampling in Stan or JAGS, large simulations, etc.) — still intact.

The Terminal submenu commands — `raven.terminal.runLineOrSelection`, `raven.terminal.runUpwardLines`, `raven.terminal.runDownwardLines`, `raven.terminal.sourceFile`, plus the chunk-mode counterparts `raven.terminal.runCurrentChunk`, `raven.terminal.runCurrentChunkAndMove`, `raven.terminal.runAboveChunks`, `raven.terminal.runBelowChunks`, and `raven.terminal.runAllChunks` — ship without default keybindings. Assign your own in `keybindings.json` if you want keyboard access. A common convention is to mirror the main send shortcuts with `Option` (Mac) or `Alt` (Windows/Linux) in place of `Cmd`/`Ctrl`, e.g. binding `alt+enter` (or `option+enter`) to `raven.terminal.runLineOrSelection`.

## Statement Detection

When no text is selected, **Run Line or Selection** uses heuristics to detect complete R statements spanning multiple lines. The extension recognizes:

- **Unmatched brackets** — `(`, `[`, `{` that haven't been closed
- **Trailing operators** — lines ending with `+`, `-`, `*`, `/`, `^`, `|>`, `%>%`, `%any%`, `||`, `&&`, `|`, `&`, `~`, `=`, `<-`, `->`, `<<-`, `->>`, `<=`, `>=`, `==`, `!=`, `<`, `>`, `,`, `::`, `:::`
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

This section applies to R terminals other than Raven's console, which [receives code directly](#running-code-from-the-editor), and to the Terminal submenu.

By default (`auto`), Raven pastes short blocks directly and switches to a temporary file once a block has at least `raven.sendToR.autoTempFileThresholdLines` lines (≥ N — default 25, so paste up to 24 lines, temp-file 25 or more), running it with `source()`. Override this with `raven.sendToR.sendMethod`:

- **`paste`** — always pastes. For multi-line code, uses bracketed paste mode to deliver the block as a single unit.
- **`tempfile`** — always writes to a temp file and runs `source()`. Use this when you want larger and smaller sends to follow the same `source()` path.

### Why `auto` switches to a temp file for larger blocks

Pasting works well for short blocks. For longer blocks it gets slow — the terminal feeds characters to R's stdin one at a time, so code that would start executing sooner via `source()` can take noticeably longer to type out.

Writing larger blocks to a temp file and `source()`-ing them sidesteps this, avoiding the inter-line paste delay and bracketed-paste compatibility issues for those blocks.

The cutover point is controlled by `raven.sendToR.autoTempFileThresholdLines` — a block with at least this many lines (≥ N) goes through a temp file; smaller blocks are pasted. The default of 25 is arbitrary but reasonable — most blocks below it paste fast and reliably on a local terminal. Lower it for slow remote connections; raise it if you prefer to see your code echoed in the terminal.

For a comparison with how the [REditorSupport extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) sends code, see [Comparison: R console](./comparison.md#r-console). If you prefer paste-everywhere behavior — for example, because you want raw paste output rather than `source()` echoing — set `raven.sendToR.sendMethod` to `"paste"`.

## Configuration Options

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `raven.rConsole.activation` | enum | `"auto"` | When Raven's R console activates: `"enabled"`, `"disabled"`, or `"auto"` (off when REditorSupport.r is enabled or running in Positron). |
| `raven.rTerminal.program` | enum | `"raven"` | Program for the R terminal: `"raven"`, `"R"`, `"arf"`, or `"radian"` |
| `raven.console.editMode` | enum | `"emacs"` | Key bindings in Raven's console: `"emacs"` or `"vi"` |
| `raven.console.colorOutput` | enum | `"streams"` | Output colors in Raven's console: `"streams"`, `"values"`, or `"off"` |
| `raven.sendToR.advanceCursorOnSend` | boolean | `true` | Advance cursor to next line after sending a single statement |
| `raven.sendToR.sendMethod` | enum | `"auto"` | How code is sent to R terminals other than Raven's console: `"auto"`, `"paste"`, or `"tempfile"` |
| `raven.sendToR.autoTempFileThresholdLines` | integer | `25` | In `auto` mode, blocks with **≥ N lines** use a temp file; smaller blocks are pasted (so `25` means: paste up to 24 lines, temp-file 25 or more) |
