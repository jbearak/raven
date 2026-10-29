# Quarto preview and render

[Docs](README.md) › R Markdown and Quarto

Preview and render `.qmd` documents with the Quarto CLI from inside VS Code.

| You do | Raven does |
|---|---|
| Press `Shift+Cmd+Enter` (`Shift+Ctrl+Enter`) in `report.qmd` | Saves the file, starts `quarto preview`, and shows the page in a Quarto Preview panel |
| Edit and save `report.qmd` | Quarto re-renders it and the panel reloads |
| Run Raven: Quarto Render | Runs `quarto render report.qmd` and offers to open the output |

Raven runs the Quarto CLI directly, so the Quarto VS Code extension isn't required. Preview and Render need a trusted workspace, because Quarto may run code from the document.

<a id="why-raven-includes-a-quarto-workflow"></a>

## When to use these commands

The Quarto extension's buttons for running R cells send code through REditorSupport, not to Raven's console. Raven's chunk controls together with Quarto Preview and Render give you a complete R-focused `.qmd` workflow when Raven's console owns the R session, without REditorSupport or the Quarto extension. See [Coexistence with the Quarto extension](coexistence.md#coexistence-with-the-quarto-extension) for how the two extensions interact.

Quarto Preview and Render are R-session features, so by default they step aside when REditorSupport is enabled or you're in Positron; see [Coexistence](coexistence.md#the-ravenrconsoleactivation-setting).

You'll find the commands in the Command Palette and, for `.qmd` files, in the editor-title Send to R (▶) menu. A preview button in the editor title bar starts Quarto Preview directly, as does `Shift+Cmd+Enter` (`Shift+Ctrl+Enter` on Windows/Linux). In `.Rmd` / `.Rmarkdown` files, the same button and shortcut run [Knit Preview](knit.md), so one preview action covers both formats. To remove the button, right-click the editor toolbar and choose Hide.

## Requirements and Quarto discovery

Install the [Quarto CLI](https://quarto.org/docs/get-started/) on the machine where the VS Code extension host runs: your local machine for a local window, the remote machine under Remote SSH. If you also use the Quarto extension, see [Coexistence with the Quarto extension](coexistence.md#coexistence-with-the-quarto-extension).

Raven looks for Quarto when you first use it for a document, in this order:

1. `raven.quarto.path`, when not empty. Set it to the absolute path of the Quarto executable. If that path is unusable or isn't Quarto, Raven reports it instead of quietly trying another executable.
2. `quarto` on the extension host's `PATH`.
3. Standard locations:
   - macOS: `/opt/homebrew/bin/quarto`, `/usr/local/bin/quarto`, then RStudio's bundled Quarto at `/Applications/RStudio.app/Contents/Resources/app/quarto/bin/quarto`.
   - Windows: `%LOCALAPPDATA%\Programs\Quarto\bin\quarto.exe`, then `%PROGRAMFILES%\Quarto\bin\quarto.exe`, when those environment variables are defined.
   - Linux: `/usr/local/bin/quarto`, then `/opt/quarto/bin/quarto`.

Each candidate must identify itself as Quarto through `quarto --help`. In a multi-root workspace, `raven.quarto.path` is read for the document's folder, so folders can use different paths. If Raven can't find Quarto, the error offers Install… and Set Path….

## Commands

### Quarto Preview

Raven: Quarto Preview saves the document first if it has unsaved changes. If saving is refused or fails, Raven stops, because Quarto would render stale content. The document must be a saved `.qmd` file on disk; virtual documents such as Git diff revisions are rejected so Quarto can't render a different revision from the one in the editor. Raven then runs the equivalent of:

```text
quarto preview <file> --no-browser --host 127.0.0.1
```

Raven runs Quarto directly, not through a shell. The working directory is the nearest Quarto project root (see [Preview ownership and keying](#preview-ownership-and-keying)), or the document's folder when there is no project.

The page appears in the Quarto Preview panel once Quarto's server responds. Raven doesn't watch the file itself: when you save, Quarto's own watcher re-renders and the page reloads. A long first render is fine as long as Quarto keeps printing output; Raven treats startup as hung only after 120 seconds with no output. If the server keeps answering 404, the format can't be previewed in a browser, and the panel tells you to use Raven: Quarto Render.

The panel has Open in Browser, Stop Preview, and, after a stop, a failure, a restored tab, or an unexpected exit, Restart Preview. Raven never opens an external browser on its own. If VS Code can't open the browser, Raven warns and writes the URL to the Raven: Quarto output channel so you can copy it.

### Stop Quarto Preview

Raven: Stop Quarto Preview stops the preview for the active document's project (or file, outside a project). It doesn't save the file, read front matter, check workspace trust, or look for Quarto. Closing a preview panel also stops the preview that panel owns.

Stopping twice is harmless: a second request while the preview is already stopping does nothing. Raven tells you when the preview stopped or when no matching preview is running. Stop also cancels a Preview command that is still saving or looking for Quarto, before Quarto starts.

### Quarto Render

Raven: Quarto Render saves the document if needed, then runs:

```text
quarto render <file>
```

It runs in the same project-aware working directory as Preview, shows a cancellable progress notification, and streams output to Raven: Quarto. It doesn't start a preview server. Only one render runs at a time per Quarto project, so two documents can't change shared `_site`, `.quarto`, or freeze state at once. Standalone files each render independently, and a symlink counts as the same file as its target. The next render can start as soon as Quarto finishes, whether or not you've answered the outcome notification.

After Quarto exits:

- If Quarto reports an HTML, PDF, or DOCX output, a Saved notification offers ways to open it. In a remote workspace, the external-open action becomes Download. Open in Editor is always offered. Relative output paths are checked against both the document's folder and the Quarto project directory.
- For another output type, a Rendered notification offers Reveal.
- If Quarto succeeds but Raven can't read an output path, Raven says rendering succeeded and points you to the output channel.
- A non-zero exit shows an error with Show Output. A timeout names `raven.quarto.render.timeoutMs`. If you cancel, Raven stops the process and says nothing more.

Render never opens the output by itself; you choose from the notification.

### Show Quarto Output

Raven: Show Quarto Output opens the Raven: Quarto output channel, which logs preview startup, Quarto's output, front-matter parse fallbacks, render output, and panel messages. The command is always in the Command Palette.

## Apply VS Code theme

The preview toolbar's Apply VS Code theme toggle recolors the live page to match your VS Code theme and preview fonts. It is off by default, so you see Quarto's own appearance until you turn it on. Switching the toggle, changing a font setting, or changing the color theme updates the open preview without reloading or re-rendering. The setting is per user, shared by all open Quarto preview panels, and remembered across VS Code sessions.

The theme works with standard Quarto HTML documents, websites, and books. Raven reapplies it after Quarto re-renders and as you follow links between pages of a website or book. Turning it off restores the document's own theme. It never changes the source, the rendered output, or the page Open in Browser shows.

The color mapping is deliberately coarse. Raven maps syntax into ten broad roles such as keyword, string, comment, and function, and covers common Quarto, Pandoc, and Bootstrap elements. The goal is a preview that feels at home in the editor, not an exact match for VS Code's highlighting or every custom Quarto theme rule. The page background follows `editor.background`, and inline and block code use `textCodeBlock.background`, as VS Code's own Markdown preview does.

If the theme can't be applied, the preview falls back to Quarto's ordinary appearance rather than failing. See [Security model](#security-model) for how the theme reaches the page.

### Fonts

The two Quarto font settings take the same comma-separated list as CSS `font-family`; quoted names with spaces are fine, for example `"JetBrains Mono", "Fira Code", monospace`.

When Apply VS Code theme is on, Raven picks each font in this order:

1. `raven.quarto.fontFamily` for body text or `raven.quarto.monospaceFontFamily` for code, when not empty.
2. `markdown.preview.fontFamily` for body text or `editor.fontFamily` for code. The code fallback honors `[quarto]` language-specific `editor.fontFamily` settings.
3. A built-in sans-serif or monospace font, if the configured values are invalid.

Both Raven settings can differ per folder in a multi-root workspace. Changing either Raven setting or either VS Code setting updates an open preview at once. Raven cleans the values and adds a generic family when needed. CSS-wide keywords, unsafe characters, unbalanced quotes, and bare parentheses make a value fall through to the next one in the order above.

## Troubleshooting

### Start with the output channel

Run Raven: Show Quarto Output. The Raven: Quarto channel has Quarto's exact output and Raven's preview and render messages. Check it first for missing dependencies, invalid YAML, errors in your code, an unexpected preview exit, or a timeout.

If Quarto is installed but Raven can't find it, set `raven.quarto.path` to the absolute path of the executable on the extension host. Under Remote SSH, a path on your local machine isn't visible to the remote extension host.

### The preview panel is blank

Raven can't look inside the preview frame to tell whether it rendered. If the page hasn't responded to Raven after eight seconds, the panel shows "If the preview looks blank, try Open in Browser." This doesn't prove loading failed; it's a hint, and it goes away by itself if the page responds later.

Use Open in Browser to open the preview's local address through VS Code. Under Remote SSH, Quarto runs on the remote machine and VS Code forwards the address to your machine. If the panel stays blank, check VS Code's Ports view and your organization's port-forwarding or proxy policy, then try Open in Browser. Preview isn't guaranteed to work in Codespaces.

### Preview reports HTTP 404

Formats such as DOCX and PPTX render fine but can't be shown in a browser. Quarto may still print a preview address for them; Raven turns the persistent 404 into a message suggesting Raven: Quarto Render. Render the document, then open, download, or reveal the file from the notification.

## Settings

| Setting | Default | Effect |
|---|---:|---|
| `raven.quarto.path` | `""` | Absolute path to the Quarto CLI. Empty searches `PATH` and the [standard locations](#requirements-and-quarto-discovery). |
| `raven.quarto.viewerColumn` | `"beside"` | Column for new preview panels: `"active"` or `"beside"`. Doesn't move an existing panel. |
| `raven.quarto.render.timeoutMs` | `600000` | Time limit in milliseconds for Quarto Render. Cancel and timeout stop the process and its children, escalating signals as needed. |
| `raven.quarto.fontFamily` | `""` | Body font for the themed preview. Empty uses `markdown.preview.fontFamily`. |
| `raven.quarto.monospaceFontFamily` | `""` | Code font for the themed preview. Empty uses `editor.fontFamily`. |

See the [settings reference](settings-reference.md) for all settings.

## Limitations

- Preview and Render require a trusted workspace.
- Shiny isn't supported. Raven rejects `server: shiny` and `server: { type: shiny }` in the document's own front matter. This check is best-effort: Shiny set in `_quarto.yml`, `_metadata.yml`, or profiles isn't detected before Quarto runs. Shiny needs the separate `quarto serve` command.
- Browser preview depends on the output format. Formats such as DOCX and PPTX fail to preview with a 404 message; use Render.
- A page whose Content Security Policy (`script-src` or `style-src`) allows scripts or styles only by nonce or hash can block the theme. The toggle then reports "Theme bridge unavailable on this page".
- RevealJS presentations, heavily customized SCSS, and author-provided light/dark toggles are themed on a best-effort, coarse basis. Exact highlighting and full custom-theme fidelity aren't promised.
- A remote tunnel mounted under a URL path prefix, rather than mapped by host and port, can break redirects. VS Code's usual Remote SSH, WSL, and Dev Container port mappings are host-and-port based.
- Apply VS Code theme doesn't affect PDF and other non-HTML previews.
- Quarto processes belong to the VS Code window that started them. Previews and running renders stop when the extension deactivates or the window reloads, and Stop doesn't reach previews owned by another window.
- Remote SSH uses VS Code's port forwarding, but Quarto Preview isn't guaranteed to work in Codespaces.

## Details

### Preview ownership and keying

Raven tracks one preview per Quarto project, or per file outside a project:

- Starting at the document's folder, Raven walks up to the filesystem root looking for the nearest `_quarto.yml` or `_quarto.yaml`. The walk isn't limited to the VS Code workspace.
- If it finds one, that folder is the preview's key and working directory, and every `.qmd` in the project shares one preview.
- Otherwise the `.qmd` file is the key, and its folder is the working directory.

Previews with different keys can run at the same time. Previewing another document with the same key stops the old Quarto process and starts a new one; Raven doesn't point a running process at a new file. Stop from any document in a project stops that project's preview.

Each VS Code window has its own previews, so Stop affects only the current window. If VS Code restores a preview tab after a window reload, Raven shows a placeholder and doesn't start Quarto or run any code. Choose Restart Preview to start it again.

This lookup only decides Raven's key and working directory. Quarto still does its own project discovery from the file.

### Security model

Quarto rendering can run code from the workspace, so Raven offers Preview and Render only in trusted workspaces and checks trust again when they run.

Raven starts Quarto with `--host 127.0.0.1` and accepts only an `http:` address whose host is exactly `127.0.0.1`, `localhost`, or `[::1]`. Addresses with credentials, other hosts, malformed ports, or another scheme are rejected. This matters because document code can print text that looks like Quarto's startup messages. Raven reads the address from Quarto's `Listening on` and `Browse at` lines and checks that it responds before showing it.

For the theme, Raven puts its own local proxy in front of Quarto's preview server and adds a small script to the HTML pages it serves. The proxy only forwards to that one checked Quarto address, including live-reload traffic, so it can't be used as an open proxy. If the proxy can't start, Raven shows Quarto's page directly, without the theme.

The rendered document can contain JavaScript. Raven runs it in a sandboxed frame on a separate origin, not in Raven's own panel. The frame allows what ordinary Quarto output needs (scripts, forms, downloads, and access to its own resources) and blocks top-level navigation and pop-ups. It can't reach the surrounding panel or VS Code's API. The theme script doesn't change that: it accepts only a theme message from the panel and applies only checked colors and cleaned font names.

VS Code maps the preview address each time the frame loads, which also enables remote port forwarding where supported. Raven doesn't cache that mapping and never opens a browser on its own. Open in Browser opens Quarto's original address, for when a widget, browser policy, or remote tunnel doesn't work inside the panel.

### targets pipelines

The language server also recognizes a literal single-document `tarchetypes::tar_quarto()` path ending in `.qmd`, `.Rmd`, or `.Rmarkdown`. It connects that document to the targets pipeline for target-name diagnostics and navigation: `tar_read()` and statically listable `tar_load()` references in R chunks resolve against the pipeline's declarations, but ordinary pipeline variables and packages don't carry into the document. Quarto project directories and computed paths aren't inferred. This analysis never runs Quarto or tarchetypes. See [Cross-file analysis: tarchetypes target factories and report documents](cross-file.md#tarchetypes-target-factories-and-report-documents).

## See also

- [Code chunks](chunks.md)
- [R Markdown preview and export](knit.md)
- [Coexistence with the Quarto extension](coexistence.md#coexistence-with-the-quarto-extension)
- [Settings reference](settings-reference.md)
