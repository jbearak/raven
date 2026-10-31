# R code chunks

[Docs](README.md) › R Markdown and Quarto

Run, navigate, and get full R code intelligence in the R chunks of `.Rmd`, `.Rmarkdown`, and `.qmd` documents and in `# %%` cells of `.R` files.

````markdown
```{r}
fit <- lm(mpg ~ wt, data = mtcars)
```

Some prose.

```{r}
summary(fit)   # `fit` resolves to the chunk above; hover and go-to-definition work
```
````

| You do | Raven does |
|---|---|
| Press `Cmd+Alt+Enter` (`Ctrl+Alt+Enter`) in a chunk | Sends that chunk to the R console |
| Click `▷ Run Chunk` above a chunk header | Same, from the CodeLens |
| Press `Cmd+PageDown` | Moves the cursor into the next chunk |

Each chunk gets a faint background tint that makes chunks easy to scan. In regular Markdown files, fenced blocks tagged `r` or `R` get a Run Chunk CodeLens too.

Chunk navigation, highlighting, cell mode, the run commands, and the CodeLens buttons are part of Raven's R-session features, so by default they step aside in Positron, which handles chunks itself; see [Coexistence](coexistence.md#what-steps-aside-and-what-doesnt). The run commands and CodeLens also need Raven's R console, because they send to the console you chose and open it if needed.

## Chunk forms

| Form | File types | Example header |
|------|------------|----------------|
| Fenced block | `.Rmd`, `.Rmarkdown`, `.qmd` | ```` ```{r setup, eval=FALSE} ```` |
| Markdown R block | `.md`, `.markdown` | ```` ```r ```` |
| Cell marker | `.R` | `# %% Section 1` |

Fenced blocks may use backticks or tildes, and fences of four or more characters nest, so a chunk can contain a literal `` ``` ``.

In regular Markdown, Raven supports only running code: an `r` / `R` fence gets a single Run Chunk CodeLens that sends its body to Raven's R console. It doesn't add knitting, chunk navigation or highlighting, or R language-server features to `.md` files. Like every Raven run command, the lens appears only when Raven's R console is active.

Only R chunks are sent to the R console. Chunks in other languages (`{python}`, `{bash}`, `{julia}`, …) are recognized for navigation and the outline but not run.

Chunks appear in the document outline (`Cmd/Ctrl+Shift+O`) as their own symbol kind, separate from section headers; see [Document outline](document-outline.md#r-markdown--quarto-chunks).

## Language features inside chunks

Raven analyzes all R chunk bodies in a document as a single R program, so R language features work inside chunks of `.Rmd`, `.Rmarkdown`, and `.qmd` documents and resolve symbols across chunks. A function defined in one chunk can be used, navigated to, and completed in a later chunk. This covers [diagnostics](diagnostics.md), [completion](completion.md), [hover](hover.md), signature help, [go-to-definition](go-to-definition.md), [find-references](find-references.md), folding, expand-selection, and on-type [indentation](indentation.md).

These features work only inside R chunk bodies. On prose, YAML front matter, or non-R chunks, completion, signature help, and on-type indentation produce nothing rather than treating the line as top-level R. Non-R chunks are not analyzed as R.

### Cross-file resolution from chunks

[Cross-file analysis](cross-file.md) reads only chunk bodies, never prose. A `source("helpers.R")` inside an R chunk creates a real dependency: symbols defined in the sourced file resolve in later chunks, and a missing target is flagged. The same text in prose, or in a comment outside a chunk, is ignored. `library()` calls and directives such as `# raven: cd` and `# raven: sourced-by` are also honored only inside chunks.

It works in the other direction too. A plain `.R` file can declare `# raven: sourced-by analysis.Rmd`, and Raven reads the Rmd's chunks (not its prose) to supply the helper's inherited scope. Raven doesn't scan the workspace for `.Rmd`, `.Rmarkdown`, or `.qmd` files ahead of time, so this direction needs the directive on the `.R` file, or the Rmd open in the editor.

A targets pipeline can also connect a document through a literal `tarchetypes::tar_render()`, `tar_knit()`, or single-document `tar_quarto()` path. The document then does not inherit ordinary pipeline variables or packages. Its R chunks share only the pipeline's target names: `targets::tar_read(model)` and statically listable `tar_load()` names are checked and navigable against the pipeline's declarations. See [Cross-file analysis: tarchetypes target factories and report documents](cross-file.md#tarchetypes-target-factories-and-report-documents).

### Suppressing diagnostics in a chunk

You can silence Raven's diagnostics for a whole chunk in two ways.

Use the knitr chunk option `raven.ignore` in the chunk header:

````markdown
```{r, raven.ignore=TRUE}
result <- some_undefined_thing   # no diagnostics in this chunk
```
````

`raven.ignore=TRUE` (or `=T`) suppresses everything in the chunk body, and `raven.ignore=FALSE` (the default) does nothing. Narrow it to specific codes with a quoted, comma-separated list: `raven.ignore="undefined-variable, line-length"`. An explicitly empty list (`raven.ignore=""`) is the empty set of codes, so it suppresses nothing; use `raven.ignore=TRUE` to silence the whole chunk.

Or put the directive `# raven: ignore-chunk` anywhere in the chunk body, optionally with codes as in `# raven: ignore-chunk[undefined-variable]`:

````markdown
```{r}
# raven: ignore-chunk
result <- some_undefined_thing
```
````

Both work like the file, line, and block [ignore directives](directives.md#ignore-directives), so the `[code]` selector behaves the same way. For finer control, the ordinary `# raven: ignore`, `# raven: ignore-next`, and `# raven: ignore-start` … `# raven: ignore-end` markers work inside a chunk body exactly as in a plain `.R` file. Other ways to silence diagnostics are in [Diagnostics](diagnostics.md).

## Keyboard shortcuts

| Mac | Windows/Linux | Action |
|-----|---------------|--------|
| `Cmd+Enter` | `Ctrl+Enter` | Run Line or Selection |
| `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | Source File (`.R`) / Knit Preview (`.Rmd`, `.Rmarkdown`) / Quarto Preview (`.qmd`) |
| `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` | Run Current Chunk |
| `Cmd+Alt+Shift+Enter` | `Ctrl+Alt+Shift+Enter` | Run Current Chunk and Move |
| `Cmd+Alt+P` | `Ctrl+Alt+P` | Run Previous Chunk |
| `Cmd+Alt+N` | `Ctrl+Alt+N` | Run Next Chunk |
| `Cmd+Alt+Shift+P` | `Ctrl+Alt+Shift+P` | Run Above Chunks |
| `Cmd+Alt+Shift+N` | `Ctrl+Alt+Shift+N` | Run Below Chunks |
| `Cmd+PageDown` | `Ctrl+PageDown` | Go to Next Chunk |
| `Cmd+PageUp` | `Ctrl+PageUp` | Go to Previous Chunk |

The letter-key shortcuts (`P`/`N`) run code and follow the [Quarto VS Code extension](https://quarto.org/docs/tools/vscode.html): unshifted runs one neighboring chunk, and Shift runs all chunks above or below. `PageDown`/`PageUp` only move the cursor. See [Keybindings](keybinding-comparison.md) for a comparison with other tools.

In `.R` files without `# %%` cell markers, the current-chunk shortcuts show an information notification; use [cell mode](#plain-r-cell-mode) to make them useful in plain `.R` files.

## Commands

| Command | Description |
|---------|-------------|
| Run Current Chunk | Sends the chunk at the cursor to R. |
| Run Current Chunk and Move | Runs the current chunk, then moves the cursor into the next R chunk. |
| Run Above Chunks | Runs every R chunk that ends before the cursor. The current chunk is not included. |
| Run Below Chunks | Runs every R chunk whose header is strictly below the cursor. The current chunk is not included. |
| Run Current and Below Chunks | Runs the chunk at the cursor plus every R chunk after it. |
| Run Previous Chunk | Runs the R chunk immediately above the cursor, skipping non-R chunks. The cursor does not move. |
| Run Previous Chunk and Move | Runs the previous R chunk and moves the cursor to its first body line (or its header line if the chunk is empty). This is Quarto's "Run Previous Chunk" behavior. |
| Run Next Chunk | Runs the R chunk immediately below the cursor, skipping non-R chunks. The cursor does not move. |
| Run Next Chunk and Move | Runs the next R chunk and moves the cursor to its first body line (or its header line if the chunk is empty). This is Quarto's "Run Next Chunk" behavior. |
| Run All Chunks | Runs every R chunk in the document, top to bottom. |
| Go to Next Chunk | Moves the cursor to the body of the next chunk (or its header line if the chunk is empty). Visits every chunk, not just R chunks. |
| Go to Previous Chunk | Moves the cursor to the body of the previous chunk (or its header line if the chunk is empty). Visits every chunk, not just R chunks. |
| Select Current Chunk | Selects the body of the chunk at the cursor, without the header and closing fence. |

## CodeLens buttons

By default each R chunk header shows up to three buttons:

```text
▷ Run Chunk    ↘ Run Next Chunk    ↥ Run Above
```

A button that targets a neighboring chunk is hidden when there is none. The first runnable chunk drops `↥ Run Above`, `← Run Previous`, and `↖ Run Previous Chunk`; the last drops `↧ Run Below`, `→ Run Next`, and `↘ Run Next Chunk`. Chunks in other languages get no buttons.

`raven.chunks.codeLens.commands` sets which buttons appear and in what order. It is an array of these command ids:

| Command id | Default label |
|------------|---------------|
| `raven.runCurrentChunk` | `▷ Run Chunk` |
| `raven.runCurrentChunkAndMove` | `▷⇣ Run & Move` |
| `raven.runAboveChunks` | `↥ Run Above` |
| `raven.runBelowChunks` | `↧ Run Below` |
| `raven.runCurrentAndBelowChunks` | `▷↓ Run Current and Below` |
| `raven.runPreviousChunk` | `← Run Previous` |
| `raven.runPreviousChunkAndMove` | `↖ Run Previous Chunk` |
| `raven.runNextChunk` | `→ Run Next` |
| `raven.runNextChunkAndMove` | `↘ Run Next Chunk` |
| `raven.runAllChunks` | `↻ Run All` |

For example, to show four buttons in a custom order:

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

Set the array to `[]` to hide all buttons while keeping the commands in the palette and on their keybindings. Unknown command ids are ignored.

When a chunk's header sets `eval = FALSE`, the `▷ Run Chunk` and `▷⇣ Run & Move` labels gain an `(eval = FALSE)` suffix, so you know `knitr` / `quarto render` would skip the chunk.

With the Quarto extension also installed, `.qmd` files show two CodeLens rows: Raven's (when Raven's R console is active) and Quarto's. See [Coexistence with the Quarto extension](coexistence.md#coexistence-with-the-quarto-extension) for what each row does.

## Chunk options

Raven reads the chunk header inside `{…}`: the label (the first bare identifier, such as `setup` in `{r setup}`) and comma-separated `key=value` options. Two options affect Raven:

- `eval = FALSE` (or `eval = F`) in the header, or `#| eval: false` in the body, dims the chunk's background tint and suppresses diagnostics inside it. Its definitions and imports don't enter the scope of other chunks. The CodeLens still offers to run the chunk.
- `raven.ignore` suppresses Raven's diagnostics for the chunk body; see [Suppressing diagnostics in a chunk](#suppressing-diagnostics-in-a-chunk).

Raven keeps every other option but doesn't interpret it.

In Quarto and R Markdown, Raven also reads `eval` from the `#| ` YAML option lines directly after the opening fence:

````qmd
```{r}
#| label: example
#| eval: false
unfinished <- (
```
````

A body `eval` option overrides the header, so `#| eval: true` re-enables a chunk whose header says `eval=FALSE`. The exact parsing rules are under [Details](#details).

## Highlighting

Each R chunk gets a faint background tint from two theme colors:

| Color id | Used for |
|----------|----------|
| `raven.chunk.activeBackground` | Runnable R chunks. |
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

Set `raven.chunks.highlight.enabled` to `false` to turn the background off.

## Plain `.R` cell mode

A line matching `# %%`, `## %%`, `### %%`, … starts a new cell. The cell extends until whichever comes first:

1. The next `# %%` marker.
2. An RStudio-style section divider: a comment line ending in 4 or more `-`, `#`, `+`, `=`, or `*` characters, such as `# Title ====`, `# Setup ----`, or `# Section #####`. Roxygen lines (`#'`) don't count, so `#' @param x A value -----` doesn't end a cell.
3. The end of the file.

This follows VS Code's interactive-cell convention used by the Jupyter extension, and matches vscode-R's section dividers.

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

When you mix `# %%` cells with RStudio section dividers, a divider ends the cell around it. The divider line itself stays in the earlier cell; code between the divider and the next `# %%` isn't in any cell, and Run Current Chunk won't send it.

```r
# %% load
library(dplyr)

# Setup ----
helper <- function() 1
# %% transform
mtcars |> mutate(x = helper())
```

Here the `load` cell ends at `# Setup ----`, and the `helper <- function() 1` line belongs to neither cell. A line that matches both forms (for example `# %% ====`) is a cell marker, so you can decorate a cell header like a section without losing the cell.

### Active-cell border

The cell containing the cursor gets a top and bottom border, so you can see which cell Run Current Chunk will run. Turn it off with `raven.chunks.activeCellIndicator: false`. The colors are the theme colors `raven.chunk.activeCellBorderTop` and `raven.chunk.activeCellBorderBottom`.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `raven.chunks.codeLens.commands` | Run Chunk, Run Next Chunk, Run Above | Which CodeLens buttons appear, in order; see [CodeLens buttons](#codelens-buttons) |
| `raven.chunks.highlight.enabled` | `true` | Background tint on R chunks and `# %%` cells |
| `raven.chunks.activeCellIndicator` | `true` | Border around the `# %%` cell containing the cursor |

See the [settings reference](settings-reference.md) for all settings.

## Limitations

- Whole-document rendering is separate from chunks: [Knit Preview](knit.md) runs `.Rmd` / `.Rmarkdown` files, and [Quarto Preview and Render](quarto.md) handle `.qmd` files.
- Nested chunks (a chunk inside another chunk's body) are not supported; the inner chunk header is ordinary content of the outer chunk.
- `eval = !my_condition` and other computed option values are read literally; Raven doesn't run R to work out `eval`.

## Details

<details markdown="1">
<summary>Exactly how Raven reads <code>#| eval</code> body options</summary>

- The option block is the contiguous run of `#| ` lines directly after the opening fence. A blank line, ordinary comment, or R code ends it.
- Nested `eval` keys and text inside captions are not chunk options.
- Raven treats the YAML booleans `false`, `False`, and `FALSE` as false. Quoted values and expressions such as `!expr` do not disable analysis.
- Invalid options, aliases, merge keys, and explicit tags leave analysis enabled.
- Mapping keys must be ASCII names such as `eval`, `fig-width`, or `fig.cap`, not numeric, boolean, null, or collection keys. This also applies inside nested option values.
- Mappings in flow sequences need braces, such as `[{name: value}]` instead of `[name: value]`.
- Parsing is limited to 64 KiB of body options and bounded nesting.
- R-style `#| eval=FALSE` body options are not interpreted.
- These rules don't apply to `.R` cells or ordinary Markdown fences.

</details>

## See also

- [R console](r-console.md)
- [R Markdown preview and export](knit.md)
- [Quarto](quarto.md)
- [Keybindings](keybinding-comparison.md)
- [Coexistence with other R extensions](coexistence.md)
