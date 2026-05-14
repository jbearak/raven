# R Code Chunks

Raven recognizes R code chunks in R Markdown / Quarto documents and `# %%`-delimited cells in plain `.R` files. You can run a single chunk, every chunk above the cursor, or every chunk in the document; navigate forward and backward between chunks; and see a subtle background tint that makes chunks easy to scan.

This is the daily-driver workflow for `.Rmd` / `.qmd` users coming from RStudio or vscode-R.

> [!NOTE]
> Navigation commands (Go to Next/Previous Chunk, Select Current Chunk) and chunk background highlighting work regardless of `raven.rConsole.activation`. The **run** commands (Run Current Chunk, Run Above, Run All) and the `▷ Run Chunk` / `↥ Run Above` CodeLens buttons require Raven's R console because they create or reuse the R terminal Raven manages. If the R console is disabled (or `auto` defers to another R extension), the run commands and CodeLens are not registered. See [Coexistence](./coexistence.md).

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
| **Run All Chunks** | Runs every R chunk in the document, top to bottom. |
| **Go to Next Chunk** | Moves the cursor to the body of the next R chunk. |
| **Go to Previous Chunk** | Moves the cursor to the body of the previous R chunk. |
| **Select Current Chunk** | Selects the body of the chunk at the cursor (excludes header and closing fence). |

CodeLens buttons appear on every R chunk header:

```text
▷ Run Chunk    ↥ Run Above
```{r}
…
```

Buttons for non-R languages are intentionally omitted.

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

A line matching `# %%`, `## %%`, `### %%`, … starts a new cell. The cell extends until the next marker (or end of file). This matches VS Code's native interactive-cell convention used by the Jupyter extension and several R notebook plugins.

```r
# %% Load
library(dplyr)

# %% Transform
mtcars |>
    group_by(cyl) |>
    summarise(mean(mpg))
```

Run Current Chunk on any line inside a cell sends that cell to the R console.

## Limitations

- Knit and Quarto render commands are not yet implemented (tracked separately).
- Nested chunks (the inner chunk inside an outer chunk's body) are not supported — the inner chunk header is treated as ordinary content of the outer chunk.
- `eval = !my_condition` and other dynamic option expressions are read literally; Raven does not evaluate R to determine `eval`.
