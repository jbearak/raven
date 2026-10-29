# Chunk keybinding comparison

[Docs](README.md) › Reference

Raven's chunk and console shortcuts, and how they compare with Quarto, RStudio, REditorSupport, and Positron.

Raven's chunk keybindings follow the [Quarto VS Code extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto), which separates running code (letter keys) from moving the cursor (PageDown/PageUp) most consistently.

## Design principles

1. `Cmd/Ctrl+Alt+P` and `Cmd/Ctrl+Alt+N` run the previous or next single chunk, matching Quarto and RStudio.
2. Adding Shift runs all chunks above or below rather than a single neighbor, matching Quarto.
3. PageDown/PageUp move the cursor without running anything, matching Quarto and RStudio's section navigation.
4. Enter variants act on the current chunk: run it, or run it and move on.

## Raven keybindings

| Mac | Windows/Linux | Action |
|-----|---------------|--------|
| `Cmd+Enter` | `Ctrl+Enter` | Run Line or Selection |
| `Cmd+Shift+Enter` | `Ctrl+Shift+Enter` | Source File (`.R`) / Knit Preview (`.Rmd`) / Quarto Preview (`.qmd`) |
| `Cmd+Alt+Enter` | `Ctrl+Alt+Enter` | Run Current Chunk |
| `Cmd+Alt+Shift+Enter` | `Ctrl+Alt+Shift+Enter` | Run Current Chunk and Move |
| `Cmd+Alt+P` | `Ctrl+Alt+P` | Run Previous Chunk |
| `Cmd+Alt+N` | `Ctrl+Alt+N` | Run Next Chunk |
| `Cmd+Alt+Shift+P` | `Ctrl+Alt+Shift+P` | Run Above Chunks (all chunks above cursor) |
| `Cmd+Alt+Shift+N` | `Ctrl+Alt+Shift+N` | Run Below Chunks (all chunks below cursor) |
| `Cmd+PageDown` | `Ctrl+PageDown` | Go to Next Chunk |
| `Cmd+PageUp` | `Ctrl+PageUp` | Go to Previous Chunk |

## Cross-tool comparison

### Execution shortcuts

| Shortcut (Mac) | Raven | Quarto | RStudio | REditorSupport |
|----------------|-------|--------|---------|----------------|
| `Cmd+Enter` | Run Line or Selection | Run Current Code | Run current line/selection | Run Selection |
| `Cmd+Shift+Enter` | Source File (`.R`) / Knit Preview (`.Rmd`) / Quarto Preview (`.qmd`) | Run Current Cell | Source document (with echo) | Run Current Chunk (`.Rmd`) / Source with Echo (`.R`) |
| `Cmd+Alt+Enter` | Run Current Chunk | — | Send line to terminal | — |
| `Cmd+Alt+P` | Run Previous Chunk | Run Previous Cell | Re-run previous region | Run Above Chunks |
| `Cmd+Alt+N` | Run Next Chunk | Run Next Cell | Run next Sweave/Rmd chunk | *(unbound)* |
| `Cmd+Alt+Shift+P` | Run Above Chunks | Run Cells Above | Run previous Sweave/Rmd code | *(unbound)* |
| `Cmd+Alt+Shift+N` | Run Below Chunks | Run Cells Below | — | *(unbound)* |
| `Cmd+Alt+C` | — | — | Run current Sweave/Rmd chunk | — |
| `Cmd+Alt+R` | — | Run All Cells | Run current document | — |

### Navigation shortcuts

| Shortcut (Mac) | Raven | Quarto | RStudio | REditorSupport |
|----------------|-------|--------|---------|----------------|
| `Cmd+PageDown` | Go to Next Chunk | Go to Next Cell | Next section | *(unbound)* |
| `Cmd+PageUp` | Go to Previous Chunk | Go to Previous Cell | Previous section | *(unbound)* |

REditorSupport has `r.goToNextChunk` and `r.goToPreviousChunk` commands but ships no default keybinding for them.

### Key differences from each tool

Quarto is nearly identical. Raven uses `Cmd+Alt+Enter` for Run Current Chunk where Quarto uses `Cmd+Shift+Enter`, and Raven adds `Cmd+Alt+Shift+Enter` for Run Current Chunk and Move. The P, N, Shift+P, Shift+N, PageDown, and PageUp mappings match exactly.

RStudio uses `Cmd+Alt+P` for "re-run previous region" (which re-runs whatever you last ran, not necessarily a chunk) and `Cmd+Alt+N` for "run next chunk". The meanings are close but not identical. RStudio uses `Cmd+Alt+C` to run the current chunk and `Cmd+PageDown`/`Cmd+PageUp` for section navigation, which includes chunks. RStudio has no "run below" shortcut.

REditorSupport ships only one chunk keybinding by default: `Cmd+Alt+P` runs Run Above Chunks (all above, not the single previous chunk). Its other chunk commands exist but are unbound. If you relied on `Cmd+Alt+P` for "run all above" in REditorSupport, use `Cmd+Alt+Shift+P` in Raven.

Positron ships no chunk-specific keybindings. Its RStudio keymap mode adds general RStudio shortcuts but not the chunk keys. Positron's built-in shortcuts focus on `Cmd+Enter` (run selection or statement) and `Cmd+Shift+Enter` (source file).

## Migration notes

If you're coming from REditorSupport and used `Cmd+Alt+P` to run all chunks above the cursor, that action is now `Cmd+Alt+Shift+P`. The unshifted `Cmd+Alt+P` runs only the single previous chunk, matching Quarto and RStudio.

If you used `Cmd+Alt+N` in earlier Raven versions to move to the next chunk, that key now runs the next chunk. Use `Cmd+PageDown` / `Cmd+PageUp` to move between chunks.

## See also

- [Code chunks](chunks.md)
- [R console](r-console.md)
