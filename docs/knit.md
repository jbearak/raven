# R Markdown knit

Raven ships a single command, `Raven: Knit`, that renders the active
`.Rmd` document to HTML and reveals the result in a webview panel.
The pipeline is intentionally narrow:

- HTML output only. Documents whose YAML `output:` resolves to
  `pdf_document`, `word_document`, `ioslides_presentation`, custom
  formats, etc. are refused with a copy-paste `rmarkdown::render(...)`
  command. Run those formats manually in the R console.
- No live preview. The Knit Output panel is a static viewer with a
  Refresh button — not a live recompile.
- No `.qmd` rendering. That belongs to `quarto.quarto`'s
  `Quarto: Render`.

For HTML, Raven calls
[`knitr::knit`](https://yihui.org/knitr/) directly — not
[`rmarkdown::render`](https://rmarkdown.rstudio.com/) — and renders
the post-knit markdown through VS Code's built-in markdown pipeline
(KaTeX math, image rewriting, registered `markdown-it` plugins).
Code blocks are re-highlighted with the GitHub light/dark palette
using whichever R / Python / SQL / Bash grammar your installed VS
Code extensions contribute, with Raven's `function` semantic-token
overlay layered on top of R blocks.

See [docs/coexistence.md](coexistence.md) for the surfaces Raven
defers to other extensions (most notably `quarto.quarto` and
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
3. **Deferred-feature detection.** Raven refuses four document shapes
   it doesn't implement — `runtime: shiny`, a custom YAML `knit:` hook,
   the `site:` field for `rmarkdown::render_site` /
   `bookdown::bookdown_site`, and any non-HTML output format. Each
   refusal includes a copy-pasteable R command you can run yourself in
   the R console.
4. **Format gate.** The first key under `output:` (or the string value
   of `output:` if it's a single string) must resolve to an HTML
   format (`html_document`, `html_notebook`, `html_vignette`,
   `html_fragment`, or one of the popular namespaced flavors from
   `bookdown`, `distill`, `pkgdown`, `rmdformats`, `tufte`, and
   `prettydoc`). Any other value is refused with a copy-paste
   `rmarkdown::render('FILENAME', output_format = '...')` command.
   When `output:` is absent Raven defaults to `html_document`.
5. **Working-directory resolution.** Controlled by
   `raven.knit.workingDirectory`:
   - `document` (default) — directory containing the `.Rmd`.
   - `project` — workspace folder containing the `.Rmd`. Refuses if
     the document is outside every workspace folder.
   - `current` — substitutes `getwd()` for `root.dir`, so chunks
     evaluate from R's startup working directory.
6. **R expression construction.** Raven validates the file and output
   paths (rejecting NUL, most control characters, DEL) and escapes
   each interpolated value as a single-quoted R literal. The result
   is one expression:
   ```r
   local({
     knitr::opts_knit$set(root.dir = '...');
     out <- knitr::knit(input = '...', output = '....md',
                        envir = new.env(), quiet = TRUE);
     cat('Output created: ', out, '\n', sep = '')
   })
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
10. **Post-knit render.** `knitr::knit` writes `<basename>.md` next to
    the source. Raven reads that markdown, calls VS Code's
    `markdown.api.render` to convert it to HTML (KaTeX math, image
    rewriting, scroll-sync metadata, and any registered `markdown-it`
    plugins all happen here), and then walks the result for
    `<pre><code class="language-X">` blocks. Each block is
    re-highlighted using:

    - the GitHub light/dark palette (selected by VS Code's active
      theme variant when shown in the panel; by
      `prefers-color-scheme` when the same file is opened in a
      browser);
    - whichever TextMate grammar your installed VS Code extensions
      contribute for the chunk's language. For R the resolution
      priority is `REditorSupport.r-syntax` →
      `REditorSupport.r` → the built-in `vscode.r`;
    - Raven's `function` LSP semantic-token overlay on top of R
      blocks, so function definitions and call heads pick up the
      `function` color even when the TextMate grammar doesn't
      classify them.

    The result is written atomically to `<basename>.html` via a
    temp-and-rename next to the source, so a concurrent re-knit
    can never expose a half-written file to the panel.

11. **Reveal.** Raven opens the rendered HTML in a **Knit Output**
    webview panel beside the editor — no success popover, the panel
    itself is the signal. Each `.Rmd` gets its own panel; knitting a
    second `.Rmd` opens a separate panel that stacks as a tab in the
    same "preview" column rather than replacing the first. Re-knitting
    the same `.Rmd` updates its panel in place. The panel toolbar
    has three buttons:

    - **Knit again** — re-knits the source `.Rmd` (the same code path
      as invoking `Raven: Knit` from the palette).
    - **Open in Browser** — opens the rendered file in your OS default
      browser. In remote workspaces (SSH, Codespaces, dev containers)
      this may not work because `file://` URIs target the remote
      machine; Raven warns and writes the path to the `Raven: Knit`
      output channel as a fallback.
    - **Apply VS Code theme** — toggle that overlays the rendered
      document with VS Code's active editor background, foreground,
      and link colors. Code blocks (both fenced and inline `<code>`)
      pick up the theme's `textCodeBlock` shading so they match the
      rest of the surface. Syntax-token colors are extracted from
      the active theme's TextMate `tokenColors` (plus any
      `semanticTokenColors` entries that map to one of Raven's
      coarse roles, plus your `editor.tokenColorCustomizations`)
      and applied to the rendered code spans. If Raven cannot
      resolve the active theme's JSON — for example because the
      theme ships in tmTheme XML format, has an unresolvable
      `include` chain, or fails JSON parsing — the toggle falls
      back to Raven's bundled light/dark GitHub palette and a
      single line is written to the `Raven: Knit` output channel.
      The button keeps its label and conveys the active state
      visually (pressed-button styling, `aria-pressed` for screen
      readers) — Rmd output doesn't have a "document theme" to
      switch back to, so the toggle simply represents whether the
      overlay is on. The preference is persisted to `globalState`
      so subsequent knits restore it, and the panel tracks VS Code
      theme switches and changes to
      `editor.tokenColorCustomizations` /
      `editor.semanticTokenColorCustomizations` in real time —
      no re-knit required.

      The role mapping is coarse (ten roles: keyword, string,
      number, comment, function, type, variable, operator,
      punctuation, constant). Semantic-token selectors with
      modifiers (`function.declaration`, `*.defaultLibrary`) are
      not honored; only bare type names are. The result is
      "theme-tinted" highlighting that matches the editor's mood
      and broad role palette, not a pixel-identical rendering of
      VS Code's own code coloring.

    Standard text copy works inside the rendered output:
    Cmd/Ctrl-C copies the current iframe selection to the system
    clipboard, Cmd/Ctrl-A selects all, and right-clicking opens a
    small menu with **Copy**, **Select All**, and **Open in
    Browser**. VS Code suppresses the browser's default context menu
    and does not forward Cmd-C from a nested iframe to its own
    clipboard command, so Raven wires these by hand on the iframe's
    same-origin `contentWindow`.

    The rendered HTML loads inside an `<iframe srcdoc="..."
    sandbox="allow-same-origin">` — scripts, forms, popups, and
    top-navigation are blocked. The HTML is inlined into the iframe
    via `srcdoc` (a nested webview iframe cannot navigate to
    `webview.asWebviewUri(...)` URLs — Electron's resource handler
    does not intercept nested-frame navigations); a `<base href>`
    injected at the top of the inlined HTML lets relative images,
    CSS, and fonts resolve through the webview's resource handler.
    Intra-document anchor links (`#section`) work; clicking an
    external `<a>` does nothing (use **Open in Browser** for full
    interactivity, including htmlwidgets). When the output-path
    parse fails Raven surfaces "Knit succeeded (output path
    unknown)" — the subprocess exit code is the ground truth.

    The on-disk artifacts after a successful knit are:

    - `<basename>.md` — the intermediate markdown knitr wrote.
      Kept on disk because it's useful for debugging: if a chunk
      output looks wrong, the `.md` is the ground truth for what
      knitr produced before the rendering step touched it.
    - `<basename>.html` — the final rendered HTML the panel and
      **Open in Browser** open.
    - `<basename>_files/figure-md/` — figures emitted by knitr's
      chunk hooks (plots, images), referenced from the `.md` by
      relative path so they resolve in both the webview and the
      browser.

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
| Auto-refresh / live preview on save | `quarto.quarto`'s `Quarto: Preview`. The Knit Output panel is a static viewer with a manual Refresh button — not a live recompile. |
| `.qmd` rendering | `quarto.quarto`'s `Quarto: Render` |
| `.qmd` grammar / LSP | `quarto.quarto` |
| `.Rmd` grammar | `REditorSupport.r-syntax` or `REditorSupport.r` |
| Non-HTML output (`pdf_document`, `word_document`, `ioslides`, …) | `rmarkdown::render('FILENAME', output_format = '...')` in the R console (Raven shows the exact command via the "Copy command" affordance) |
| Custom YAML `knit:` hook dispatch | Run the hook function manually in the R console |
| Knit-with-Parameters dialog | Edit YAML defaults, or call `rmarkdown::render(params = list(...))` |
| `runtime: shiny` documents | `rmarkdown::run('foo.Rmd')` in the R console |
| `rmarkdown::render_site` | Run `rmarkdown::render_site()` in the R console |
| YAML output options (`toc`, `theme`, `code_folding`, …) | Out of scope for the current HTML-only pipeline. Raven ignores them and emits its own minimal HTML shell. To honor the full template, run `rmarkdown::render(...)` in the R console. |

A walkthrough ("Get started with Raven for R Markdown") in
**Welcome ▸ Walkthroughs** wires installation of the recommended
extensions and creates a sample `.Rmd` for a quick smoke test.
