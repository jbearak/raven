# R Markdown preview and export

[Docs](README.md) › R Markdown and Quarto

Preview an `.Rmd` or `.Rmarkdown` file as HTML in a VS Code panel, and export it to HTML, PDF, or Word with Pandoc.

<a id="r-markdown-knit"></a>

| You do | Raven does |
|---|---|
| Press `Shift+Cmd+Enter` (`Shift+Ctrl+Enter`) in `report.Rmd` | Saves the file, knits it with knitr in a separate R process, and opens the Knit Preview panel beside the editor |
| Edit the document, then click Knit again | Re-knits and updates the same panel |
| Click Export, then PDF | Writes `report.pdf` next to `report.Rmd` |

For `.qmd` files, the same button and shortcut open [Quarto Preview](quarto.md) instead.

## Preview a document

Run Raven: Knit Preview from the Command Palette, the editor-title Raven menu, or `Shift+Cmd+Enter`. The preview works like this:

- It is always HTML, whatever the YAML `output:` field says. `pdf_document`, `word_document`, and so on still preview as HTML; `output:` only affects the named formats during export.
- It changes only when you ask. The panel has a Knit again button, and `Shift+Cmd+Enter` saves the file if needed and re-knits in one keystroke. Nothing re-renders in the background while you're mid-edit.
- It survives a window reload or restart. If a preview panel is open when you reload the window or quit and reopen VS Code, Raven restores it showing the last rendered output, without re-knitting or starting R. Press Knit again to refresh it. Turn this off with `raven.knit.persistPreview`, and the panel and its temp files go away when the window closes. Surviving a machine reboot isn't supported, because the OS may clear its temp directory. If a restored preview's files are gone, the panel shows a "press Knit again" placeholder.
- It is written to a temp directory, so the source document's folder stays clean. Only export commands write next to the source.

Raven runs [`knitr::knit`](https://yihui.org/knitr/) directly, not [`rmarkdown::render`](https://rmarkdown.rstudio.com/), and renders the resulting Markdown with VS Code's built-in Markdown engine (KaTeX math, image paths, and any Markdown plugins you have installed). Code chunks are highlighted with the GitHub light or dark palette, using the R, Python, SQL, or Bash grammar your installed extensions provide, and R chunks also get Raven's highlighting of function names.

While you edit, VS Code's Outline view and breadcrumbs show the document's Markdown headings, the same structure the preview renders; see [Document outline](document-outline.md).

## When the command is available

Knit Preview is one of Raven's R-session features, so by default it steps aside when REditorSupport is enabled or you're in Positron; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting). It also needs a trusted workspace; in an untrusted one, the command offers a button that opens the trust manager.

When it's available, the command appears in the Command Palette and the editor-title Raven menu when the active file ends in `.rmd`, `.Rmd`, `.RMD`, `.rmarkdown`, `.Rmarkdown`, or `.RMARKDOWN`.

## The preview panel

Each R Markdown file gets its own Knit Preview panel. Knitting a second file opens another panel as a tab in the same column; re-knitting a file updates its panel in place. Raven doesn't show a success message; the panel is the signal.

The toolbar is a single row of icons, from left to right:

- Knit again (refresh icon) re-knits the document, the same as running Raven: Knit Preview.
- Export (share icon) offers Pandoc HTML, PDF, and Word; see [Exporting](#exporting). While an export runs, the icon becomes a stop button that cancels it. The menu closes when you click outside it, press Escape, or click into the report.
- Open in Browser (globe icon) opens the rendered file in your default browser. In remote workspaces (Remote SSH, Dev Containers, WSL, Codespaces), this button and the matching right-click item are hidden, because the file is on the remote machine. Use Export instead, which can download the file.
- [Apply VS Code theme](#apply-vs-code-theme) recolors the preview to match your editor.

You can select and copy text in the preview: `Cmd/Ctrl+C` copies the selection and `Cmd/Ctrl+A` selects all. Right-click for Copy, Copy image, Select All, and Open in Browser.

Links to headings in the same document work. Clicking an external link does nothing, and scripts, forms, and pop-ups in the rendered page are blocked; use Open in Browser for full interactivity, including htmlwidgets.

### Apply VS Code theme

This toggle recolors the rendered document with your editor's background, foreground, and link colors. Code blocks and inline code use the theme's code-block shading. Syntax colors come from your theme's token colors, its semantic token colors that match one of Raven's roles, and your `editor.tokenColorCustomizations`.

SVG plots are recolored too. When the YAML's HTML options don't set `dev`, Raven makes the preview's figures SVG so they can be themed; an explicit `dev` in the YAML or a chunk is still honored. Raster plots (`png`, `jpeg`, and so on) display normally but can't be recolored after knitting; set `dev: svg` if you choose a device and want themed plots.

The toggle is remembered for later knits. The panel follows theme switches and changes to `editor.tokenColorCustomizations` and `editor.semanticTokenColorCustomizations` as they happen, without re-knitting. The button keeps its label and shows its state as a pressed button, because R Markdown output has no document theme to switch back to.

## Exporting

The panel's Export button and the editor-title Raven menu both offer Export to HTML…, Export to PDF…, and Export to Word…. The panel button reuses the preview's knitted Markdown, so it's fast and doesn't re-run R chunks. The editor-title commands always knit fresh.

Both run Pandoc, which Raven looks for the first time you export: `raven.pandoc.path`, then `PATH`, then standard install locations (Homebrew, RStudio's bundled Pandoc, and so on). If Pandoc is missing, Raven shows an error with an Install Pandoc… button.

The exported file is written next to the source as `<basename>.html`, `.pdf`, or `.docx`. A cancelled or failed export never damages an earlier successful one. When the export finishes, a notification offers two buttons:

- Open in Browser (HTML), Open PDF, or Open in Word, which hand the file to your system's default app. In a remote workspace this becomes Download, which reveals the file in the Explorer and copies it to a local path you pick, because the remote machine can't open your local apps.
- Open in Editor, which opens the file in VS Code. How PDF and Word files look there depends on which editor or extension handles that file type.

PDF export uses the engine in `raven.pandoc.pdfEngine`: `xelatex` by default, another LaTeX engine, or `wkhtmltopdf`, which renders through WebKit and needs no LaTeX. If the engine isn't found, Raven suggests installing TinyTeX.

Raven refuses to preview or export three kinds of document it doesn't support: Shiny documents (`runtime: shiny` or `server: shiny`), a custom YAML `knit:` hook, and a `site:` field for `rmarkdown::render_site` or `bookdown::bookdown_site`. Each refusal includes an R command you can copy and run in the R console instead.

### YAML output options

| Key | Where it's applied |
|---|---|
| `fig_width`, `fig_height`, `fig_retina`, `dpi`, `dev` | `knitr::opts_chunk$set` before knitting (preview and export). The preview uses `dev: svg` when you don't set `dev`, so the theme toggle can recolor plots; other devices are honored but can't be recolored. |
| `toc`, `toc_depth` | Pandoc `--toc` / `--toc-depth` (export only) |
| `number_sections` | Pandoc `--number-sections` (export only) |
| `highlight` | Pandoc `--highlight-style` (export only; checked against the known styles) |
| `self_contained` | HTML export always passes Pandoc `--embed-resources` for portable output. `self_contained: false` is logged and ignored, because the preview's figures are deleted when its panel closes. Ignored for PDF and Word too. |
| `css` | Pandoc `--css=<absolute path>`, only for files inside the workspace folder or the document's folder |
| `mathjax` | Pandoc `--mathjax` |
| `pandoc_args` | Added to Pandoc's arguments during export, after Raven's own, except output (`-o`, `--output`) and format (`-t`, `--to`, `-w`, `--write`) flags, which are removed and logged. Preview doesn't run Pandoc, so `pandoc_args` doesn't affect it. |

Nested options under a format are partly honored, as listed above. Raven doesn't honor `theme`, `code_folding`, `df_print`, `code_download`, `template`, or `includes` in preview or export, and logs them to the Raven: Knit output channel when present. These come from `rmarkdown::html_document`'s own R code (Bootstrap themes, a JavaScript runtime, data-frame print methods), which neither pipeline uses: the preview renders knitr's Markdown with VS Code's Markdown engine, and export sends that Markdown straight to Pandoc. For full template fidelity, run `rmarkdown::render(...)` in the R console.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `raven.knit.workingDirectory` | `document` | Where chunks run: `document`, `project`, or `current`; see [step 5](#what-it-does-step-by-step) |
| `raven.knit.timeoutMs` | `600000` | Time limit (ms) for the knit R process |
| `raven.knit.persistPreview` | `true` | Keep the Knit Preview panel across window reloads and restarts |
| `raven.knit.export.timeoutMs` | `120000` | Time limit (ms) for Pandoc during export |
| `raven.knit.fontFamily` | `""` | Body font for the preview. Empty uses `markdown.preview.fontFamily` |
| `raven.knit.monospaceFontFamily` | `""` | Code and output font. Empty uses `editor.fontFamily` |
| `raven.pandoc.path` | `""` | Path to a Pandoc binary. Empty searches `PATH` and standard install locations |
| `raven.pandoc.pdfEngine` | `xelatex` | PDF engine: `xelatex`, `pdflatex`, `lualatex`, `tectonic` (LaTeX), or `wkhtmltopdf` (WebKit) |
| `raven.packages.rPath` | (auto) | Path to the R binary. Empty searches `PATH` |

Whether the command is available at all depends on `raven.rConsole.activation`; see [When the command is available](#when-the-command-is-available). All settings are in the [settings reference](settings-reference.md).

### Fonts

The two font settings take the same comma-separated list as CSS `font-family`; quoted names with spaces are fine, for example `"JetBrains Mono", "Fira Code", monospace`. For each slot, Raven uses:

1. Your `raven.knit.fontFamily` or `raven.knit.monospaceFontFamily`, if not empty.
2. VS Code's `markdown.preview.fontFamily` (body) or `editor.fontFamily` (code). These have system defaults when you haven't set them, so the preview looks reasonable on the machine you knit on.
3. A built-in fallback, if step 2 yields an invalid value.

Both settings can differ per folder in a multi-root workspace (`.vscode/settings.json`). The code-font fallback also honors `[rmd]` and `[quarto]` language-specific `editor.fontFamily` settings, so a per-language editor font carries into the preview.

An open preview updates as soon as you change any of these four settings, without re-knitting. The `.html` file keeps the fonts from the last knit, so Open in Browser shows new fonts only after you knit again, and anyone you send the file to sees the fonts from knit time.

A browser reads font names from the file, so a reader without your fonts falls through your list. Raven adds a generic family at the end (`, monospace` for code, `, sans-serif` for body) when your value doesn't end with one. For the best results across machines, give your own fallback list, such as `"JetBrains Mono", "Fira Code", Menlo, monospace`. Values that break the rules under [Details](#details) are skipped in favor of the next item.

<a id="what-raven-does-not-do"></a>

## Limitations

| Capability | Where it lives |
|---|---|
| Automatic refresh of `.Rmd` / `.Rmarkdown` preview after saves | Not provided. Knit Preview updates when you choose Knit again. |
| `.qmd` preview or rendering with the Knit Preview command | Use Raven's [Quarto Preview and Render](quarto.md) commands, or `quarto.quarto`. The shared preview shortcut picks the right command for the file. |
| Visual Mode and Quarto-aware YAML intelligence | `quarto.quarto`. Raven supplies `.qmd` highlighting and R-chunk language features, but not these Quarto editor features. |
| `html_document`-specific YAML options (`theme`, `code_folding`, `df_print`, …) | Out of scope; honoring them means running `rmarkdown::html_document` (Bootstrap and a JavaScript runtime). Use `rmarkdown::render(...)` in the R console. |
| Passing every `pandoc_args` entry through | Output and format flags are removed, because the export command chooses the destination (next to the source) and the format. Everything else passes through; see [YAML output options](#yaml-output-options). |
| Custom YAML `knit:` hook | Run the hook function yourself in the R console. |
| Knit with Parameters dialog | Edit the YAML defaults, or call `rmarkdown::render(params = list(...))`. |
| `runtime: shiny` documents | `rmarkdown::run('foo.Rmd')` in the R console. |
| `rmarkdown::render_site` | Run `rmarkdown::render_site()` in the R console. |

## Details

### What it does, step by step

1. Trust check. The command is disabled in untrusted workspaces and offers a button to open the trust manager.
2. Front matter. Raven reads the `---` … `---` YAML block. YAML `null`, booleans, and numbers keep their types. If the YAML is malformed, the Raven: Knit output channel opens with the error.
3. Unsupported documents. Shiny documents, custom `knit:` hooks, and `site:` documents are refused, as described under [Exporting](#exporting). Export goes through the preview pipeline, so a refused document can't be exported either.
4. Output options. Any `output:` format previews as HTML, with options applied as in [YAML output options](#yaml-output-options).
5. Working directory, set by `raven.knit.workingDirectory`:
   - `document` (default): the directory containing the R Markdown file.
   - `project`: the workspace folder containing the file. Raven refuses if the file is outside every workspace folder.
   - `current`: R's startup working directory (`getwd()`).
6. The R command. Raven rejects file paths containing NUL, most control characters, or DEL, and quotes each path as an R string. See the expression below.
7. The R process. Raven runs `R --no-save --no-restore -e <expression>` directly, never through a shell, with your current environment. R comes from `raven.packages.rPath` if set, otherwise from `PATH`.
8. Output. R's standard output goes to the Raven: Knit output channel as-is; standard error lines are prefixed `[stderr]`. A notification with a Cancel button shows while it runs.
9. Cancel and timeout. Both stop R with SIGINT, then SIGTERM after 5 seconds, then SIGKILL after another 5 seconds. Windows uses `taskkill /T /F` instead. The default time limit is 10 minutes (`raven.knit.timeoutMs`).
10. Rendering. Raven renders knitr's Markdown to HTML without the YAML front matter, so the preview never shows a front-matter table (the `.md` file on disk keeps it for Pandoc export). Code chunks get the highlighting described under [Preview a document](#preview-a-document). Only input chunks get the bordered code panel; output blocks show as plain monospace text, so you can tell input from output as in Quarto's preview.
11. Display. The HTML file is replaced in one step, so the panel never shows a half-written file, and the panel opens or updates.

<details markdown="1">
<summary>The R expression Raven runs to knit</summary>

Simplified, it looks like this:

```r
local({
  knitr::opts_knit$set(root.dir = '...');
  out <- knitr::knit(input = '...', output = '....md',
                     envir = new.env(), quiet = TRUE);
  cat('Output created: ', out, '\n', sep = '')
})
```

The real expression also sets `base.dir` and a chunk `fig.path`, and writes the Markdown to a temporary file that replaces the old one only when knitting succeeds, so a failed render never overwrites a previous result. Raven also sets `options(knitr.graphics.rel_path = FALSE)` for this R process only, so `include_graphics()` with an absolute path doesn't fail the knit. If the output path can't be read from R's output, Raven reports "Knit succeeded (output path unknown)"; R's exit code decides success.

</details>

<details markdown="1">
<summary>How images appear in the preview</summary>

The preview shows local images, both knitr's generated `figure/` plots and existing images you include with `knitr::include_graphics()`.

- A relative image path is looked up in the preview's output directory first (where generated plots live), then in the knit working directory (where `include_graphics("images/logo.png")` is rooted). An absolute path is used as-is.
- An image is shown only if its real path, after following symlinks, is inside the temp preview directory, the workspace folder containing the document (or the document's own folder when no workspace is open), or the knit working directory. Other images are left out.
- The knit working directory here is the one `raven.knit.workingDirectory` sets. If R changes directory at run time, through a setup chunk's `knitr::opts_knit$set(root.dir = …)` or a `setwd()` in `.Rprofile`, relative images don't follow it. Use absolute paths (for example with `normalizePath(...)`) for those.
- The `.html` file keeps the original image paths, so Open in Browser stays small. As a result, a relative `include_graphics` path rooted at the working directory shows in the panel but not in the browser, which looks for it next to the temp `.html`. Use an absolute path if you need the image in both. Generated `figure/` plots work in both, because knitr writes them next to the `.html`.

</details>

<details markdown="1">
<summary>Where preview files live and when they are removed</summary>

```text
<temp>/raven-knit/<workspace hash>/<session id>/preview/<source hash>/
  <basename>.md     intermediate Markdown knitr wrote
  <basename>.html   rendered HTML the panel reads
  figure/           knitr-generated plots
```

`<temp>` is the system temp directory. The workspace hash comes from the first workspace folder (or the document's folder when no workspace is open). The session id is new each time the extension starts, so two VS Code windows on the same workspace don't collide. The source hash comes from the document's absolute path.

A document's preview directory is removed when you close its panel. At window exit, what happens depends on `raven.knit.persistPreview`:

- On (default): the preview files of panels still open are kept so they can be restored next time; only export scratch files are removed. On restore, Raven moves the old preview directory into the new session, so a later Knit again updates it in place. Leftovers from windows never reopened are removed by the 7-day cleanup and by Raven: Clean Up Knit Preview Cache.
- Off: the whole session directory is removed when VS Code exits.

Sessions older than 7 days are removed when the extension starts, regardless of the setting. Raven: Clean Up Knit Preview Cache removes old session directories on demand. It never touches the current session, or any session written in the last few minutes, so a preview open in another window on the same workspace survives.

</details>

<details markdown="1">
<summary>How the theme toggle maps colors</summary>

- SVG plots in the preview's `figure/` folder are sanitized and recolored with the same background, text, and stroke rules as Raven's [plot viewer](plot-viewer.md#color-theme).
- Token colors map onto ten coarse roles: keyword, string, number, comment, function, type, variable, operator, punctuation, constant. Semantic-token selectors with modifiers (`function.declaration`, `*.defaultLibrary`) are not honored; only bare type names are. The result matches your editor's broad palette, not VS Code's exact code coloring.
- If Raven can't read the active theme's colors (for example, the theme is in tmTheme XML format, has an `include` chain Raven can't follow, or isn't valid JSON), the toggle uses Raven's built-in GitHub light/dark palette and writes one line to the Raven: Knit output channel.
- The GitHub palette follows the system color scheme when the file is opened in a browser, and VS Code's theme in the panel.

</details>

<details markdown="1">
<summary>Which font values Raven rejects</summary>

A font value is skipped, and the next item in the [fallback order](#fonts) is used, when it:

- Is longer than 500 characters.
- Contains any of `;` `{` `}` `<` `>` `\` or a control character (`\n` `\r` `\t` `\f` `\v` `\0`).
- Contains `/*` or `*/`.
- Has an unmatched `"` or `'`.
- Has `(` or `)` outside a quoted family name. Parentheses inside quotes are fine, so `"Aptos (Body)", sans-serif` is accepted, but a bare `Foo(bar` is not.
- Has a leading, trailing, or doubled comma, such as `Georgia,` or `Arial,,Times`.
- Is exactly one of the CSS-wide keywords `inherit`, `initial`, `unset`, `revert`, or `revert-layer`, which have nothing useful to inherit from in the preview.

The VS Code Settings UI checks the character and length rules as you type. The quote and parenthesis rules are checked only when Raven applies the value.

</details>

### targets pipelines

When a targets pipeline names an `.Rmd` or `.Rmarkdown` file with a literal `tarchetypes::tar_render()` or `tar_knit()` path, Raven connects the document to the pipeline for target-name diagnostics and navigation. `tar_read()` and statically listable `tar_load()` names in R chunks resolve against the pipeline's declarations, without bringing in the pipeline's ordinary R scope. This is language-server analysis only: Knit Preview knits as usual, and Raven never runs tarchetypes during analysis. See [Cross-file analysis: tarchetypes target factories and report documents](cross-file.md#tarchetypes-target-factories-and-report-documents).

### Grammars

Raven ships the R and R Markdown grammars from REditorSupport, so `.Rmd` / `.Rmarkdown` files are highlighted in fresh installs and remote workspaces. When `REditorSupport.r-syntax`, `REditorSupport.r`, or the built-in `vscode.r` grammar is installed, Raven still prefers it. The preview's R chunks use the first one found in that order, then Raven's own. See [Coexistence](coexistence.md) for what else Raven leaves to other extensions, notably `quarto.quarto`.

## See also

- [Code chunks](chunks.md)
- [Quarto](quarto.md)
- [Coexistence with other R extensions](coexistence.md)
- [Settings reference](settings-reference.md)
