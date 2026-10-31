# R console

[Docs](README.md) › R session (VS Code)

Run R inside VS Code and send code to it from the editor.

| You do | Raven does |
|---|---|
| Put the cursor in a pipe chain and press `Cmd+Enter` (`Ctrl+Enter` on Windows/Linux) | Sends the whole multi-line statement to R |
| Select some lines and press `Cmd+Enter` | Sends exactly the selection |
| Press `Shift+Cmd+Enter` in an `.R` file | Runs `source("file.R", echo = TRUE)` |
| Call `plot(1:10)` or `View(df)` in the console | Opens Raven's [plot viewer](plot-viewer.md) or [data viewer](data-viewer.md) |

<a id="r-terminal-profile"></a>
<a id="open-an-r-terminal"></a>

## Open the console

The first time you send code in a session, Raven asks where to send it. A menu titled "Send R code to" lists the consoles it can use:

| Menu item | Shown when |
|---|---|
| Raven's R console | Always. This is [Raven's console](#ravens-console), which adds syntax highlighting, multi-line editing, Tab completion, colored output, and the debugger to the R you already have. |
| R command line | Always. Plain R, as when you type `R` in a shell. |
| arf | arf is on your shell's PATH. |
| radian | radian is on your shell's PATH. |
| vscode-R | The vscode-R (REditorSupport) extension is installed. Raven sends the code to vscode-R's R terminal. |

Then pick **This session** to use that console until you close or reload the window, or **All sessions** to save it in your user settings as `raven.rTerminal.program`. Press Escape at either step to cancel the send. Nothing runs and the cursor stays where it was.

Every command that sends code asks this way: Run Line or Selection, the chunk commands, Source File, the [quick inspection commands](#quick-inspection-commands), and the [package commands](r-package-dev.md) that run in your console. The console opens in VS Code's terminal panel when you send code and none is running.

You can also open a console yourself by choosing **R** from the terminal panel's profile dropdown. If you haven't chosen a console yet, the same menu appears, without vscode-R. If a console Raven opened is already running when you first send code (from the dropdown, or one the [debugger](debugger.md) opened), Raven sends to it without asking.

> [!NOTE]
> In Positron, Raven leaves R sessions to Positron and turns off its R console, its send-code commands, and its plot and data viewers. To use them anyway, set `raven.rConsole.activation` to `"enabled"`. See [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting).

<a id="choosing-the-r-program"></a>

### Choose a console

To change your choice, run **Raven: Choose R Console** from the Command Palette, or pick **Choose R Console** at the bottom of the editor toolbar's `▶` menu. Consoles that are already running keep running. The next send goes to a terminal running the console you picked, and Raven opens one if none is running.

To skip the menu, set `raven.rTerminal.program`:

| Value | Console |
|-------|-------------|
| `ask` (default) | Ask the first time you send code in each session. |
| `raven` | [Raven's console](#ravens-console). |
| `R` | Plain R, as when you type `R` in a shell |
| `arf` | Rust-based R console with syntax highlighting, fuzzy history search (`Ctrl+R`), interactive help, and rig integration |
| `radian` | Python-based R console with syntax highlighting, multiline editing, and mouse support |
| `vscode-R` | vscode-R's R terminal; see [Send to vscode-R](#send-to-vscode-r) |

A choice made for this session wins over the setting, so **Raven: Choose R Console** can switch consoles without changing your settings. arf and radian must be on your PATH. Raven's console needs only R itself.

The terminals are named `R` for Raven's console, `R (plain)` for plain R, and `arf` and `radian` for those consoles. The [debugger](debugger.md) always uses Raven's console. It opens one if none is running, and doesn't change your choice.

### Send to vscode-R

When you choose vscode-R, Raven hands the code to vscode-R's `r.runCommand`, which sends it to vscode-R's R terminal and opens one if needed. vscode-R's `r.bracketedPaste` setting decides how the code is typed in; Raven's `raven.sendToR.sendMethod` doesn't apply. From there vscode-R handles the code as if you'd sent it with its own commands: recent versions may ask where to run it (an Interactive session or an R terminal), and may wait for their session watcher to attach before sending.

Raven's plot viewer, data viewer, and debugger work only in terminals Raven opens. `plot()` and `View()` in vscode-R's terminal go to vscode-R's viewers. To have both extensions' `Cmd+Enter` behave the way you expect, see [Cmd+Enter next to vscode-R](coexistence.md#cmdenter-next-to-vscode-r).

## Raven's console

Raven's console runs the same R you get by typing `R` in a terminal: the one on your `PATH`, or `R_HOME` if you set it. On Windows, where the installer doesn't put R on `PATH`, it also finds the R recorded in the registry; it needs R 4.2 or later there. It loads that installation's R library into its own process and drives R's own read–eval–print loop. Everything R does at its prompt works as usual: autoprinting, `.Last.value`, `browser()`, `readline()`, `menu()`, error recovery, and your `.Rprofile` and `.Renviron`. If the console can't embed your R (for example, R built without `--enable-R-shlib`), it says why in one line and starts plain R instead, so you always get a working session.

### Editing

- Syntax highlighting as you type, using the same R grammar as Raven's language server. The bracket at the cursor and its match are underlined.
- Multi-line editing. Enter runs your input when R's own parser says it is complete, and starts a new, indented line when it isn't, for example after `function(x) {`, `data.frame(a = 1,` or a trailing `|>`, just as in plain R. R reports a syntax error rather than leaving you stuck in continuation lines. `Alt+Enter` always inserts a newline. Arrow keys move between lines.
- History is kept across sessions (`~/Library/Application Support/raven/console_history` on macOS, `~/.local/share/raven/console_history` on Linux, `%APPDATA%\raven\console_history` on Windows). Up and Down step through earlier entries, and a multi-line entry comes back whole. `Ctrl+R` searches history for text you type, and a dimmed suggestion from history appears as you type; press → to accept it.
- Emacs-style key bindings by default; set `raven.console.editMode` to `vi` for vi-style bindings. [Console key bindings](console-key-bindings.md) explains the two styles and lists their keys.
- `Ctrl+C` clears the line you're editing, or interrupts R while it runs. At a `+` continuation line it abandons the unfinished expression, and at a `readline()` or `menu()` prompt it interrupts the code that asked, as in plain R. `Ctrl+D` on an empty line quits.
- `options(width)` follows the terminal width as you resize it, unless you set `width` yourself.

### Completion

Press Tab to complete. A single match is inserted directly; otherwise a menu opens. Keep typing to narrow it, use Tab/Shift+Tab or the arrow keys to move, Enter to accept, and Esc to close. If nothing matches, Tab does nothing. On a blank line, or before any code on the line, Tab indents by two spaces.

Completion uses R's own completion engine on your live session. It covers objects and functions, `df$` columns, `obj@` slots, function arguments (`name = `), `pkg::` exports, and file paths inside strings. After `library(`, `require(`, `requireNamespace(` or `loadNamespace(`, it completes installed package names. If a completion is slow, `Ctrl+C` interrupts it, as it would interrupt any R code; compiled code that never checks for interrupts can't be stopped this way.

### Colored output

The console colors output with your terminal theme's own palette, so it suits light and dark themes without configuration. `raven.console.colorOutput` chooses how much:

| Value | Effect |
|-------|--------|
| `streams` (default) | Errors in red, warnings in yellow, and other messages in cyan. Ordinary output is unchanged. |
| `values` | Also colors printed values, like the [colorout](https://github.com/jalvesaq/colorout) package: numbers, quoted strings, `NA`/`NULL`/`TRUE`/`FALSE`/`Inf`, and `[1]`-style indices. Numbers inside words, such as hashes, hostnames, versions and `x86_64`, are left alone. |
| `off` | No colors added. |

Output that already has colors, such as from the cli package or crayon, always keeps them. R gives the console text, not condition objects, so the colors come from recognising R's own error and warning headers (in your session's language). The rare message that happens to start like an R warning is colored as one.

Raven's console replaces colorout. If your `.Rprofile` loads colorout, the console turns it off for that session and says so in one dimmed line, because colorout writes to the terminal directly and would bypass the console's handling of output. Set `raven.console.colorOutput` to `values` for colorout-style colors.

### Running code from the editor

Code you send from the editor (Run Line or Selection, Run Chunk, Source File, and so on) goes straight to Raven's console instead of being typed into the terminal, so blocks of any size start immediately. The console shows each line at its prompt with highlighting, as if you'd typed it, with output in between. If a line fails with an error, the rest of that block doesn't run, so you get one error instead of a cascade. Anything you were typing at the console prompt is set aside and comes back afterwards.

### Debugging

Raven's console includes a debugger for VS Code: breakpoints, stepping, the call stack, variables and the Debug Console, attached automatically when R stops. An uncaught error in code from a file also prints a [traceback](debugger.md#tracebacks) with clickable file locations that you can [open in the debugger](debugger.md#inspect-the-last-error) afterwards, and warnings from your files say [where they came from](debugger.md#where-warnings-came-from). See [Debugger](debugger.md).

### Outside VS Code

The console is the `raven console` command of the `raven` binary (see [CLI](cli.md#raven-console)), so you can run it in any terminal. R's own options pass through, for example `raven console --no-save --vanilla`.

## Keyboard shortcuts

| Mac | Windows/Linux | Action |
|-----|---------------|--------|
| `Cmd+Enter` | `Ctrl+Enter` | Run line or selection (every supported file type) |
| `Shift+Cmd+Enter` | `Shift+Ctrl+Enter` | Source File (`.R`), Knit Preview (`.Rmd` / `.Rmarkdown`), or Quarto Preview (`.qmd`); all require Raven's R console to be active |

You can also run these commands from the editor toolbar menu (the `▶` button) or the Command Palette (`Cmd+Shift+P`). Chunk shortcuts are listed in [Code chunks](chunks.md#keyboard-shortcuts) and compared with other tools in [Keybindings](keybinding-comparison.md).

## Commands

| Command | Description |
|---------|-------------|
| Run Line or Selection | Sends the current selection to R. With no selection, detects and sends the complete multi-line statement at the cursor. |
| Run Upward Lines | Sends all lines from the start of the file to the current line, extending to complete any multi-line statement. |
| Run Downward Lines | Sends all lines from the current line to the end of the file, extending upward to include the full statement start. |
| Source File | Runs `source("filepath", echo = TRUE)` in the R console. |
| Choose R Console | Asks which console to send code to; see [Choose a console](#choosing-the-r-program). |

### Quick inspection commands

These commands wrap the word under the cursor (or the current selection) in a common inspection function and send it to the R console, so one keystroke checks an object's shape. They're in the Raven category, so typing `Raven:` in the Command Palette lists them all. They have no default keybindings; bind them in `keybindings.json` if you want shortcuts.

| Command | Sends to R |
|---------|------------|
| Raven: Show nrow | `nrow(<target>)` |
| Raven: Show length | `length(<target>)` |
| Raven: Show head | `head(<target>)` |
| Raven: Show head (transposed) | `t(head(<target>))` |
| Raven: Show names | `names(<target>)` |
| Raven: View | `View(<target>)` |

If a selection is active, the whole selection is the target, which suits expressions like `df$col` or `subset(df, x > 0)`. Otherwise the word at the cursor is the target. The commands run when the active editor's language is `r`, `rmd`, or `quarto`. In a `.Rmd`, `.Rmarkdown`, or `.qmd` file, put the cursor on an R identifier inside an R chunk; on a prose word, the command sends something R will reject.

A single-line wrapped expression is always pasted directly into the terminal. If the wrapped expression spans several lines (because the selection did), it follows your `raven.sendToR.sendMethod` setting. This keeps a one-liner like `nrow(x)` out of a temp file even when you set `tempfile` mode for normal sends.

## Editor toolbar

A `▶` button in the editor title bar for `.R`, `.Rmd`, `.Rmarkdown`, and `.qmd` files opens a menu of send commands for that file type. The main entries send code to the R console, opening one if none is open. **Choose R Console** at the bottom of the menu changes which console that is. The Terminal submenu sends the same code to whichever terminal is active in VS Code, such as R running inside `tmux`, a Docker container, or any other terminal session.

| File type | Main entries | Terminal submenu |
|---|---|---|
| `.R` | Run Line or Selection, Run Upward Lines, Run Downward Lines, Source File | The same four entries |
| `.Rmd`, `.Rmarkdown`, `.qmd` | Run Line or Selection, Run Current Chunk, Run Current Chunk and Move, Run Above Chunks, Run Below Chunks, Run All Chunks; Knit Preview and Knit: Export to HTML / PDF / Word for R Markdown when Raven's R console is active | The same chunk entries, without the knit commands |

In documents, the entries that would include prose or YAML (Run Upward Lines, Run Downward Lines, Source File) are hidden. The Terminal submenu has no knit commands because knitr always renders the document on disk rather than in the active terminal. In `.R` files with `# %%` cells, the chunk commands are in the CodeLens and the Command Palette, not the toolbar.

`Shift+Cmd+Enter` (`Shift+Ctrl+Enter`) runs Knit Preview on `.Rmd` / `.Rmarkdown` files when knit is enabled, and Quarto Preview on `.qmd` files. Quarto Preview and Render require Raven's R console to be active and a trusted workspace. When the console is off, the Preview shortcut is unbound, but Stop Quarto Preview stays in the Command Palette so you can still stop a running preview.

Code sent through the Terminal submenu follows the same [send method](#send-method) as the main commands. Terminal: Source File runs `source()` on the document's saved path, saving first if the buffer has unsaved changes.

> [!TIP]
> For an R session that survives disconnecting from a remote host (closing your laptop, losing internet), start `tmux` on the remote host, run R inside it, and send code with the Terminal submenu. tmux keeps running independently of your VS Code connection, so you can reconnect hours or days later with the session and any long-running computation (MCMC sampling in Stan or JAGS, large simulations) still intact.

The Terminal submenu commands have no default keybindings: `raven.terminal.runLineOrSelection`, `raven.terminal.runUpwardLines`, `raven.terminal.runDownwardLines`, `raven.terminal.sourceFile`, `raven.terminal.runCurrentChunk`, `raven.terminal.runCurrentChunkAndMove`, `raven.terminal.runAboveChunks`, `raven.terminal.runBelowChunks`, and `raven.terminal.runAllChunks`. Assign your own in `keybindings.json`. A common convention mirrors the main shortcuts with `Option` (Mac) or `Alt` (Windows/Linux) in place of `Cmd`/`Ctrl`, for example binding `alt+enter` to `raven.terminal.runLineOrSelection`.

## Statement detection

With no text selected, Run Line or Selection detects complete R statements that span several lines. It recognizes:

- Unmatched brackets: `(`, `[`, `{` that haven't been closed.
- Trailing operators: lines ending with `+`, `-`, `*`, `/`, `^`, `|>`, `%>%`, `%any%`, `||`, `&&`, `|`, `&`, `~`, `=`, `<-`, `->`, `<<-`, `->>`, `<=`, `>=`, `==`, `!=`, `<`, `>`, `,`, `::`, `:::`.
- Continuation lines: lines starting with `|>`, `%>%`, `)`, `]`, `}`, `+`, or other operators.

So pipe chains, multi-line function calls, ggplot layers, and if/else blocks are sent as complete units:

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

## Cursor advancement

By default, the cursor moves to the next line after you send a single statement (not a selection or file), so repeated `Cmd+Enter` presses run code line by line. Turn this off with `raven.sendToR.advanceCursorOnSend`.

## Send method

This section applies to plain R, arf, and radian, and to the Terminal submenu. Raven's console [receives code directly](#running-code-from-the-editor) instead, and vscode-R uses [its own setting](#send-to-vscode-r).

By default (`auto`), Raven pastes short blocks directly and switches to a temporary file once a block has at least `raven.sendToR.autoTempFileThresholdLines` lines, running it with `source()`. The default threshold is 25, so blocks of up to 24 lines are pasted and blocks of 25 or more go through a temp file. Override this with `raven.sendToR.sendMethod`:

- `paste` always pastes. For multi-line code, it uses bracketed paste mode to deliver the block as a single unit.
- `tempfile` always writes to a temp file and runs `source()`. Use this when you want larger and smaller sends to follow the same `source()` path.

### Why `auto` switches to a temp file for larger blocks

Pasting works well for short blocks. For longer blocks it gets slow: the terminal feeds characters to R's stdin one at a time, so code that would start sooner through `source()` can take noticeably longer to type out. Writing larger blocks to a temp file and sourcing them avoids the inter-line paste delay and bracketed-paste compatibility issues.

The default threshold of 25 lines is arbitrary but reasonable: most blocks below it paste fast and reliably on a local terminal. Lower it for slow remote connections; raise it if you prefer to see your code echoed in the terminal. If you want raw paste output everywhere rather than `source()` echoing, set `raven.sendToR.sendMethod` to `"paste"`. For how the [REditorSupport extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) sends code, see [Comparison: R console](comparison.md#r-console).

<a id="configuration-options"></a>

## Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `raven.rConsole.activation` | `"auto"` | Whether Raven's R console activates; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting) |
| `raven.rTerminal.program` | `"ask"` | Which console to send code to: `"ask"`, `"raven"`, `"R"`, `"arf"`, `"radian"`, or `"vscode-R"` |
| `raven.console.editMode` | `"emacs"` | Key bindings in Raven's console: `"emacs"` or `"vi"`; see [Console key bindings](console-key-bindings.md) |
| `raven.console.colorOutput` | `"streams"` | Output colors in Raven's console: `"streams"`, `"values"`, or `"off"` |
| `raven.sendToR.advanceCursorOnSend` | `true` | Move the cursor to the next line after sending a single statement |
| `raven.sendToR.sendMethod` | `"auto"` | How code is sent to consoles other than Raven's: `"auto"`, `"paste"`, or `"tempfile"` |
| `raven.sendToR.autoTempFileThresholdLines` | `25` | In `auto` mode, blocks with at least this many lines use a temp file; smaller blocks are pasted |

All settings, with types and allowed values, are in the [settings reference](settings-reference.md).

## See also

- [Debugger](debugger.md)
- [Code chunks](chunks.md)
- [Plot viewer](plot-viewer.md) and [Data viewer](data-viewer.md)
- [Coexistence with other R extensions](coexistence.md)
- [Command line: `raven console`](cli.md#raven-console)
