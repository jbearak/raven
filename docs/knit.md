# R Markdown knit

Raven ships a single command, `Raven: Knit`, that runs
[`rmarkdown::render`](https://rmarkdown.rstudio.com/) in a fresh R
subprocess against the active `.Rmd` document and reveals the rendered
output. It is intentionally narrow: previewing, `.qmd` rendering, and
the RStudio "Knit to ..." dropdown are all out of scope. See
[docs/coexistence.md](coexistence.md) for the surfaces Raven defers to
other extensions (most notably `quarto.quarto` and
`REditorSupport.r-syntax`).

## When the command is available

`Raven: Knit` is gated by `raven.rConsole.activation`. With the
default `"auto"` setting it is **disabled** when the
`REditorSupport.r` extension is enabled or VS Code is running as
Positron — both already provide their own knit affordances. In every
other environment it is enabled and appears in the command palette on
`.Rmd` files.

The command appears in the command palette only when the resolved gate
is open and the active file is `.Rmd` / `.rmd` / `.RMD`. Invoke it on
the active editor, or right-click an `.Rmd` file in the explorer (the
explorer-context-menu hook is opt-in via your own keybindings).

## What it does, step by step

1. **Trust check.** The command is disabled in untrusted workspaces and
   offers a button to open the trust manager.
2. **YAML front matter parse.** Raven parses the `---` ... `---` block
   with the YAML failsafe schema. Malformed YAML opens the
   `Raven: Knit` output channel with the parse error.
3. **Deferred-feature detection.** Raven refuses three document shapes
   it doesn't implement — `runtime: shiny`, a custom YAML `knit:` hook,
   and the `site:` field for `rmarkdown::render_site` /
   `bookdown::bookdown_site`. Each refusal includes a copy-pasteable R
   command you can run yourself in the R console.
4. **Format detection.** The first key under `output:` (or the string
   value of `output:` if it's a single string, e.g.
   `output: pdf_document`) is forwarded to `rmarkdown::render`. When
   `output:` is absent Raven defaults to `html_document`.
5. **Working-directory resolution.** Controlled by
   `raven.knit.workingDirectory`:
   - `document` (default) — directory containing the `.Rmd`.
   - `project` — workspace folder containing the `.Rmd`. Refuses if
     the document is outside every workspace folder.
   - `current` — don't pass `knit_root_dir`; R uses its startup
     working directory.
6. **R expression construction.** Raven validates the file path and
   format identifier (rejecting NUL, most control characters, DEL, and
   any format outside `[A-Za-z0-9_:.-]+`) and escapes each interpolated
   value as a single-quoted R literal. The result is one expression:
   ```r
   rmarkdown::render(input = '...', output_format = '...', knit_root_dir = '...')
   ```
7. **Subprocess spawn.** Raven spawns `R --no-save --no-restore -e
   <expression>` via `child_process.spawn` (never a shell), inheriting
   the current environment. The R binary path is taken from
   `raven.packages.rPath` if set, otherwise from `PATH`.
8. **Streaming.** Standard output goes to the `Raven: Knit` output
   channel verbatim. Standard error lines are prefixed `[stderr]`. A
   notification with a "Cancel" button runs alongside.
9. **Cancellation / timeout.** Cancel and timeout use the same kill
   ladder: SIGINT, then SIGTERM after 5 s, then SIGKILL after another
   5 s. The default timeout is 10 minutes
   (`raven.knit.timeoutMs = 600000`). Windows uses `taskkill /T /F`
   instead of POSIX signals.
10. **Reveal.** On a clean exit Raven parses `Output created: <path>`
    out of stdout and offers an `Open` button. `.html` / `.htm` open
    via `vscode.open` (which routes through Simple Browser in remote
    workspaces); everything else opens via `revealFileInOS`. When the
    parse fails Raven still surfaces "Knit succeeded (output path
    unknown)" — the subprocess exit code is the ground truth.

## Settings

| Setting | Default | Description |
|---|---|---|
| `raven.rConsole.activation` | `auto` | Gates the knit command (and the R console / plot / data viewers / chunk run commands). |
| `raven.knit.workingDirectory` | `document` | `document` / `project` / `current`. |
| `raven.knit.timeoutMs` | `600000` | Hard timeout (ms). On expiry Raven escalates the kill ladder. |
| `raven.packages.rPath` | (auto) | Path to the R binary. Empty means "search PATH". |

## What Raven does **not** do

| Capability | Where it lives |
|---|---|
| Live preview of `.Rmd` or `.qmd` | `quarto.quarto`'s `Quarto: Preview` |
| `.qmd` rendering | `quarto.quarto`'s `Quarto: Render` |
| `.qmd` grammar / LSP | `quarto.quarto` |
| `.Rmd` grammar | `REditorSupport.r-syntax` or `REditorSupport.r` |
| Knit-to-... format picker | `quarto render foo.Rmd --to <fmt>` |
| Custom YAML `knit:` hook dispatch | Run the hook function manually in the R console |
| Knit-with-Parameters dialog | Edit YAML defaults, or call `rmarkdown::render(params = list(...))` |
| `runtime: shiny` documents | `rmarkdown::run('foo.Rmd')` in the R console |
| `rmarkdown::render_site` | Run `rmarkdown::render_site()` in the R console |

A walkthrough ("Get started with Raven for R Markdown") in
**Welcome ▸ Walkthroughs** wires installation of the recommended
extensions and creates a sample `.Rmd` for a quick smoke test.
