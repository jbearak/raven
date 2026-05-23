# R Markdown knit

Raven ships **`Raven: Knit Preview`** for previewing R Markdown and
three companion **export** commands (`Knit: Export to HTML…`,
`Knit: Export to PDF…`, `Knit: Export to Word…`) for saving the
rendered document next to the source `.Rmd`. The pipeline is
intentionally narrow:

- The preview is always HTML, regardless of the YAML `output:`
  field. `pdf_document`, `word_document`, etc. still preview as HTML;
  the `output:` field only affects the named formats during export.
- The preview is a static viewer with a manual Refresh button — not a
  live recompile. Click **Knit again** to re-render after editing.
- The preview is saved to a per-session temp directory under
  `<os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/preview/<sourceHash>/`,
  so the `.Rmd`'s own directory stays clean. Export commands write the
  final file (HTML / PDF / DOCX) next to the `.Rmd`.
- Export commands shell out to Pandoc. PDF export additionally needs a
  LaTeX engine (`xelatex` by default).
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
3. **Deferred-feature detection.** Raven refuses three document
   shapes it doesn't implement — `runtime: shiny`, a custom YAML
   `knit:` hook, and the `site:` field for `rmarkdown::render_site` /
   `bookdown::bookdown_site`. Each refusal includes a copy-pasteable
   R command you can run yourself in the R console.
4. **YAML output options.** Any `output:` format (`html_document`,
   `pdf_document`, `word_document`, `bookdown::pdf_document2`, etc.)
   previews as HTML. Nested options are partially honored — see the
   "YAML output options honored / ignored" section below.
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

    - the GitHub light/dark palette, selected by
      `@media (prefers-color-scheme: dark)` so the same file
      auto-detects the OS color scheme when opened in a browser
      and follows VS Code's editor theme (which usually mirrors
      the OS) when shown in the panel iframe;
    - whichever TextMate grammar your installed VS Code extensions
      contribute for the chunk's language. For R the resolution
      priority is `REditorSupport.r-syntax` →
      `REditorSupport.r` → the built-in `vscode.r`;
    - Raven's `function` LSP semantic-token overlay on top of R
      blocks, so function definitions and call heads pick up the
      `function` color even when the TextMate grammar doesn't
      classify them.

    Only the input chunks (the blocks that carry a `language-X`
    class) get the bordered code-panel surface. Output blocks —
    emitted by `knitr` as untagged fenced blocks — render as bare
    monospace text, so a reader can tell input from output the
    same way Quarto's preview does.

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

    The on-disk artifacts after a successful preview are:

    ```text
    <os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/preview/<sourceHash>/
      <basename>.md     — intermediate markdown knitr wrote
      <basename>.html   — final rendered HTML the panel reads
      figure/           — knitr-generated plots
    ```

    Where `<workspaceHash>` is a SHA-256 of the first workspace folder
    URI (or the `.Rmd`'s parent directory when no workspace is open),
    `<sessionId>` is a UUID generated at extension activation so two
    VS Code windows on the same workspace are isolated, and
    `<sourceHash>` is a SHA-256 of the `.Rmd`'s absolute path. The
    whole directory is removed when the panel is disposed; the entire
    session subtree is removed when VS Code exits. Stale sibling
    sessions (>7 days) are swept on activation.

## Exporting

The webview's `Export ▾` button and the editor-title Raven menu both
expose `Export to HTML…`, `Export to PDF…`, and `Export to Word…`.
The webview button reuses the cached preview `.md` — so it's fast and
won't re-run R chunks. The editor-title commands always knit fresh
(they don't peek at panel state).

Both paths shell out to Pandoc, which is resolved lazily on first use
from `raven.pandoc.path`, then from `PATH`, then from standard install
locations (Homebrew, RStudio's bundled Pandoc, etc.). If Pandoc is
missing Raven shows an actionable error with an "Install Pandoc…"
button.

The exported file is written next to the source `.Rmd` as
`<basename>.{html,pdf,docx}`. Writes are atomic (temp file + rename),
so a cancelled or failed export never corrupts a prior successful
output. A notification offers an "Open in Browser" / "View PDF" /
"Open in Word" button on success.

PDF export uses the LaTeX engine configured at `raven.pandoc.pdfEngine`
(default `xelatex`). If the engine isn't found Raven surfaces an
"Install TinyTeX…" hint.

### YAML output options honored / ignored

| Key | Where it's applied |
|---|---|
| `fig_width`, `fig_height`, `fig_retina`, `dpi`, `dev` | `knitr::opts_chunk$set` before knitting |
| `toc`, `toc_depth` | Pandoc `--toc` / `--toc-depth` (export only) |
| `number_sections` | Pandoc `--number-sections` (export only) |
| `highlight` | Pandoc `--highlight-style` (export only; validated against the known list) |
| `self_contained` | Pandoc `--embed-resources --standalone` |
| `css` | Pandoc `--css=<absolute path>` (containment-checked against the workspace folder / .Rmd parent) |
| `mathjax` | Pandoc `--mathjax` |

Keys **not honored**: `theme`, `code_folding`, `df_print`,
`code_download`, `template`, `includes`, `pandoc_args`. They are logged
to the `Raven: Knit` output channel when present in your YAML. The
omissions are deliberate — most are html_document-specific Bootstrap /
JS runtime features that Raven's preview pipeline can't reproduce
without becoming `rmarkdown::html_document`. `pandoc_args` is excluded
on security grounds (a document could otherwise inject `--output`,
`--lua-filter`, etc., bypassing Raven's controlled destination).

## Settings

| Setting | Default | Description |
|---|---|---|
| `raven.rConsole.activation` | `auto` | Gates the knit command (and the R console / plot / data viewers / chunk run commands). |
| `raven.knit.workingDirectory` | `document` | `document` / `project` / `current`. |
| `raven.knit.timeoutMs` | `600000` | Hard timeout (ms) for the knit R subprocess. |
| `raven.knit.export.timeoutMs` | `120000` | Hard timeout (ms) for the Pandoc subprocess during export. |
| `raven.knit.fontFamily` | `""` | Body/prose font for the preview. Empty inherits `markdown.preview.fontFamily`. |
| `raven.knit.monospaceFontFamily` | `""` | Monospace font for code chunks and output. Empty inherits `editor.fontFamily`. |
| `raven.pandoc.path` | `""` | Absolute path to a Pandoc binary. Empty uses PATH + standard install locations. |
| `raven.pandoc.pdfEngine` | `xelatex` | LaTeX engine for PDF export (`xelatex`, `pdflatex`, `lualatex`, `tectonic`, `wkhtmltopdf`). |
| `raven.packages.rPath` | (auto) | Path to the R binary. Empty means "search PATH". |

### Fonts

The two font settings accept the same comma-separated form as CSS
`font-family` — quoted names with spaces are fine, e.g.
`"JetBrains Mono", "Fira Code", monospace`.

Resolution order per slot:

1. Your `raven.knit.fontFamily` / `raven.knit.monospaceFontFamily` if
   non-empty.
2. VS Code's `markdown.preview.fontFamily` (body) or
   `editor.fontFamily` (mono). These resolve to OS-specific defaults
   when you have not set them, so the preview always looks reasonable
   on the machine you're knitting on.
3. A hard-coded fallback if step 2 somehow yields an invalid value.

Both settings are **resource-scoped** — you can override them
per-folder in a multi-root workspace via `.vscode/settings.json`. The
mono fallback also honors VS Code's `[rmd]` / `[quarto]` language-scoped
`editor.fontFamily` blocks, so a per-language editor font flows into
the preview.

Fonts are **baked into the rendered `.html` at knit time**, AND the
open preview panel updates **live** when you change any of the four
settings above. No re-knit is needed while the panel is open — the
extension recomputes the fallback chain on every
`onDidChangeConfiguration` event and pushes the result into the
webview. The on-disk `.html` keeps the snapshot from the last knit, so
"Open in Browser" picks up the new fonts the next time you re-knit.
The same is true if you email or host the file: the recipient sees
whatever fonts were active at knit time.

**Browser portability.** The `.html` that "Open in Browser" produces
is the same file the panel reads. The browser reads font names
verbatim from the CSS, so a reader without your configured fonts
installed will fall through the comma list. Raven automatically
appends a generic terminator (`, monospace` for code, `, sans-serif`
for body) when your value doesn't already end with one, so the browser
always lands on a sensible generic family rather than reverting to
Times. For the most robust portability across machines include your
own fallback list, e.g.
`"JetBrains Mono", "Fira Code", Menlo, monospace`.

**Rejection rules.** A value is rejected (and the next item in the
fallback chain is used) when it:

- Exceeds 500 characters.
- Contains any of `;` `{` `}` `<` `>` `\` or a control character
  (`\n` `\r` `\t` `\f` `\v` `\0`).
- Contains the CSS comment sequences `/*` or `*/`.
- Has an unmatched `"` or `'` (CSS string would run past the
  declaration and corrupt adjacent styles).
- Has any `(` or `)` outside a quoted family name. Parens inside
  quoted names are fine — `"Aptos (Body)", sans-serif` is accepted —
  but a bare `Foo(bar` would open a CSS function-token that escapes
  the declaration.
- Has a leading, trailing, or consecutive comma — `Georgia,` or
  `Arial,,Times` would produce an empty entry that the browser drops
  via IACVT.
- Is exactly one of the CSS-wide keywords (`inherit`, `initial`,
  `unset`, `revert`, `revert-layer`). The iframe has no useful parent
  for those to resolve against, so the fallback chain produces a
  better outcome.

The VS Code Settings UI also enforces the character and length rules
at edit time via a JSON schema `pattern`, so most character-class
rejections are caught before they reach the knit pipeline. The
schema cannot enforce balanced-paren / balanced-quote semantics, so
those checks live in the runtime sanitizer only.

## What Raven does **not** do

| Capability | Where it lives |
|---|---|
| Live preview of `.Rmd` or `.qmd` | `quarto.quarto`'s `Quarto: Preview` |
| Auto-refresh / live preview on save | `quarto.quarto`'s `Quarto: Preview`. The Knit Output panel is a static viewer with a manual Refresh button — not a live recompile. |
| `.qmd` rendering | `quarto.quarto`'s `Quarto: Render` |
| `.qmd` grammar / LSP | `quarto.quarto` |
| `.Rmd` grammar | `REditorSupport.r-syntax` or `REditorSupport.r` |
| html_document-specific YAML options (`theme`, `code_folding`, `df_print`, …) | Out of scope. Honoring them requires becoming `rmarkdown::html_document` (Bootstrap + JS runtime). Use `rmarkdown::render(...)` in the R console for full template fidelity. |
| `pandoc_args:` passthrough | Cut on security grounds — could inject `--output`, `--lua-filter`, etc. A safer audited subset may land later; track follow-up issues. |
| Custom YAML `knit:` hook dispatch | Run the hook function manually in the R console. |
| Knit-with-Parameters dialog | Edit YAML defaults, or call `rmarkdown::render(params = list(...))`. |
| `runtime: shiny` documents | `rmarkdown::run('foo.Rmd')` in the R console. |
| `rmarkdown::render_site` | Run `rmarkdown::render_site()` in the R console. |

A walkthrough ("Get started with Raven for R Markdown") in
**Welcome ▸ Walkthroughs** wires installation of the recommended
extensions and creates a sample `.Rmd` for a quick smoke test.
