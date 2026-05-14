# R Code Chunks

Raven recognizes R code chunks in R Markdown / Quarto documents and `# %%`-delimited cells in plain `.R` files. You can run a single chunk, every chunk above the cursor, or every chunk in the document; navigate forward and backward between chunks; and see a subtle background tint that makes chunks easy to scan.

This is the daily-driver workflow for `.Rmd` / `.qmd` users coming from RStudio or vscode-R.

> [!NOTE]
> Navigation commands (Go to Next/Previous Chunk, Select Current Chunk) and chunk background highlighting work regardless of `raven.rConsole.activation`. The **run** commands (for example, Run Current Chunk, Run Above Chunks, Run All Chunks — see [Commands](#commands) for the full set) and every chunk CodeLens button (defaults `▷ Run Chunk` / `↥ Run Above`, plus any others added via `raven.chunks.codeLens.commands`) require Raven's R console because they create or reuse the R terminal Raven manages. If the R console is disabled (or `auto` defers to another R extension), the run commands and CodeLens are not registered. See [Coexistence](./coexistence.md).

## Chunk forms

| Form | File types | Example header |
|------|------------|----------------|
| Fenced block | `.Rmd`, `.qmd` | ```` ```{r setup, eval=FALSE} ```` |
| Cell marker | `.R` | `# %% Section 1` |

Fenced blocks may use either backticks or tildes, and four-or-more-character fences nest naturally (so a chunk can contain a literal `` ``` ``).

Only **R** chunks are sent to the R console. Chunks tagged with other languages (`{python}`, `{bash}`, `{julia}`, …) are still recognized for navigation and outline but not for execution.

## Keyboard shortcuts

| Mac | Windows/Linux | Action |
|-----|---------------|--------|
| `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | Run Current Chunk (in `.Rmd` / `.qmd`) |
| `Cmd+Alt+P` | `Ctrl+Alt+P` | Run Above Chunks |
| `Cmd+Alt+N` | `Ctrl+Alt+N` | Go to Next Chunk |
| `Cmd+Alt+Shift+N` | `Ctrl+Alt+Shift+N` | Go to Previous Chunk |

In `.R` files, `Cmd+Shift+Enter` keeps its usual meaning of **Source File** — to run a single cell, use the command palette or the CodeLens "Run Chunk" button.

## Commands

| Command | Description |
|---------|-------------|
| **Run Current Chunk** | Sends the chunk at the cursor to R. |
| **Run Current Chunk and Move** | Runs the current chunk, then moves the cursor into the next R chunk. |
| **Run Above Chunks** | Runs every R chunk that ends before the cursor. The current chunk is not included. |
| **Run Below Chunks** | Runs every R chunk whose header is strictly below the cursor. The current chunk is not included. |
| **Run Current and Below Chunks** | Runs the chunk at the cursor plus every R chunk after it. |
| **Run Previous Chunk** | Runs the R chunk immediately above the cursor (skipping non-R chunks). |
| **Run Next Chunk** | Runs the R chunk immediately below the cursor (skipping non-R chunks). |
| **Run All Chunks** | Runs every R chunk in the document, top to bottom. |
| **Go to Next Chunk** | Moves the cursor to the body of the next R chunk. |
| **Go to Previous Chunk** | Moves the cursor to the body of the previous R chunk. |
| **Select Current Chunk** | Selects the body of the chunk at the cursor (excludes header and closing fence). |

## CodeLens buttons

By default each R chunk header shows two buttons:

```text
▷ Run Chunk    ↥ Run Above
```{r}
…
```

Buttons for non-R languages are intentionally omitted.

The set of buttons (and their order) is controlled by `raven.chunks.codeLens.commands` — an array of run-command ids. The available ids are:

| Command id | Default label |
|------------|---------------|
| `raven.runCurrentChunk` | `▷ Run Chunk` |
| `raven.runCurrentChunkAndMove` | `▷⇣ Run & Move` |
| `raven.runAboveChunks` | `↥ Run Above` |
| `raven.runBelowChunks` | `↧ Run Below` |
| `raven.runCurrentAndBelowChunks` | `▷↓ Run Current and Below` |
| `raven.runPreviousChunk` | `← Run Previous` |
| `raven.runNextChunk` | `→ Run Next` |
| `raven.runAllChunks` | `↻ Run All` |

Example — show four buttons in a custom order:

```jsonc
{
  "raven.chunks.codeLens.commands": [
    "raven.runCurrentChunk",
    "raven.runCurrentAndBelowChunks",
    "raven.runAboveChunks",
    "raven.runAllChunks"
  ]
}
```

Set the array to `[]` to hide all lenses while keeping the commands available from the palette and keybindings. Unknown command ids are silently ignored.

When a chunk's header sets `eval = FALSE`, the `▷ Run Chunk` and `▷⇣ Run & Move` labels gain a `(eval = FALSE)` suffix so you know the chunk would otherwise be skipped by `knitr` / `quarto render`.

## Chunk options

Raven parses the header inside `{…}` and recognizes:

- The **label** — the first bare identifier (e.g. `setup` in `{r setup}`).
- **Key-value options** — comma-separated `key=value` pairs.

Two options affect Raven specifically:

- `eval = FALSE` (or `eval = F`) — Raven dims the chunk's background tint to signal that it will not be evaluated by `knitr` or `quarto render`. The CodeLens still offers to run the chunk manually if you want.

Every other option is preserved on the parsed chunk but Raven does not interpret it.

## Highlighting

Each R chunk gets a faint background tint via two themable colors:

| Color id | Used for |
|----------|----------|
| `raven.chunk.activeBackground` | Default runnable R chunks. |
| `raven.chunk.inactiveBackground` | Chunks with `eval = FALSE`. Lower opacity by default. |

Customize them in `settings.json`:

```jsonc
{
  "workbench.colorCustomizations": {
    "raven.chunk.activeBackground": "#1f7fff10",
    "raven.chunk.inactiveBackground": "#1f7fff05"
  }
}
```

Set `raven.chunks.highlight.enabled` to `false` to turn the background off entirely.

## Plain `.R` cell mode

A line matching `# %%`, `## %%`, `### %%`, … starts a new cell. The cell extends until **whichever comes first**:

1. The next `# %%` marker.
2. An RStudio-style section divider (a comment line ending in 4+ `-`, `#`, `+`, `=`, or `*` characters — for example `# Title ====`, `# Setup ----`, `# Section #####`).
3. End of file.

This matches VS Code's native interactive-cell convention used by the Jupyter extension and brings parity with vscode-R's section dividers.

```r
# %% Load
library(dplyr)

# %% Transform
mtcars |>
    group_by(cyl) |>
    summarise(mean(mpg))
```

Run Current Chunk on any line inside a cell sends that cell to the R console.

### Section dividers as cell boundaries

When you mix `# %%` cells with RStudio section dividers, the divider terminates the surrounding cell. The divider line itself stays in the prior cell; any code between the divider and the next `# %%` is **not** part of a cell and won't be sent by `Run Current Chunk`.

```r
# %% load
library(dplyr)

# Setup ----
helper <- function() 1
# %% transform
mtcars |> mutate(x = helper())
```

In the example above the `load` cell ends at `# Setup ----`. The `helper <- function() 1` line is orphan — it belongs to neither cell. A line that matches both forms (for example `# %% ====`) is treated as a cell marker, so you can still use section-style decoration on a cell header without losing the cell-start meaning.

### Active-cell border

The cell containing the cursor gets a top and bottom border so you can see at a glance which cell `Run Current Chunk` will run. Turn it off with `raven.chunks.activeCellIndicator: false`. The colors are themable via `raven.chunk.activeCellBorderTop` and `raven.chunk.activeCellBorderBottom`.

## Limitations

- Knit and Quarto render commands are not yet implemented (tracked separately).
- Nested chunks (the inner chunk inside an outer chunk's body) are not supported — the inner chunk header is treated as ordinary content of the outer chunk.
- `eval = !my_condition` and other dynamic option expressions are read literally; Raven does not evaluate R to determine `eval`.
