# Knit Preview + Pandoc Export — Design

**Status**: Design (post-brainstorming).
**Author**: jbearak.
**Supersedes**: parts of [`2026-05-16-rmd-knit-preview-design.md`](./2026-05-16-rmd-knit-preview-design.md) and [`2026-05-17-knit-output-webview-design.md`](./2026-05-17-knit-output-webview-design.md) — both remain authoritative for what they covered; this design alters the user-facing command surface, output destinations, and adds export.

## Summary

Three changes to Raven's knit feature:

1. **`Knit` becomes `Knit Preview`** (title only; command ID `raven.knit` stays). The preview writes its intermediate `.md`, final `.html`, and `figure/` artifacts into a per-document temp directory rather than next to the source `.Rmd`.

2. **The YAML `output:` block stops being a gate.** Today, anything other than `html_document` (and friends) trips `buildNonHtmlFormatBlocker` and shows a "copy this `rmarkdown::render` command" dialog. After this change, preview always renders to HTML regardless of YAML output format. Nested YAML options inside `output:` are partially honored (chunk-level options applied; Pandoc-mappable options applied during export; the rest logged as ignored).

3. **New export commands** (Pandoc-driven). Save the rendered document to PDF, Word, or HTML next to the `.Rmd`. Exposed both from a new dropdown in the webview's toolbar and as flat items in the editor-title Raven menu.

## Motivation

Three problems with the status quo:

- **The gate is unfriendly.** Documents with `output: pdf_document` cannot be previewed at all today; the user has to paste an `rmarkdown::render` command into the R console. For previewing-in-editor, the output format is irrelevant — the user wants to see *something* rendered.
- **Artifacts pollute the source directory.** Demo commit `109110cd` had to add `*.md` and `figure/` to `.gitignore` for the raven demo repo. Users who don't ignore these end up with junk committed to git.
- **No in-editor path to PDF/Word.** Users today open the R console and run `rmarkdown::render(..., output_format = ...)` themselves. REditorSupport.R offers `r.knitRmdToPdf` / `r.knitRmdToDocx` for users who have that extension installed, but Raven users without it have no equivalent affordance.

## Non-goals

- **Quarto (`.qmd`) support.** Defer to `quarto.quarto`, consistent with REditorSupport.R and with Raven's existing scope.
- **Built-in (no-Pandoc) PDF/DOCX renderer.** Research shows pure-JS HTML→PDF/DOCX libraries cannot preserve Raven's syntax highlighting or KaTeX math; bundling headless Chromium would add ~200 MB. Pandoc-only is the honest answer. (A follow-up issue will track a hand-rolled custom renderer that preserves highlighting by emitting OOXML/PDF directly from Raven's token stream — worth doing later because it lets Raven beat Pandoc on the one dimension we're already best at.)
- **Honoring html_document-specific YAML keys** (`theme`, `code_folding`, `df_print`, `code_download`, `template`, `includes`). These are Bootstrap+JS runtime features that Raven's preview pipeline can't reproduce without becoming `rmarkdown::html_document`. Logged as ignored.
- **Knit-with-parameters dialog**, **shiny runtime**, **rmarkdown::render_site**. As in the prior spec, the user does these from the R console.
- **Suppressing or auto-suppressing REditorSupport.R's parallel commands.** If the user has both extensions, they see Raven's `Knit Preview` / `Export to …` alongside REditorSupport.R's `r.knitRmd*`. The user picks. Documented in `docs/coexistence.md`.

## Confirmed assumptions (from brainstorming research)

- **`vscode.env.openExternal(uri)` is the cross-platform open path.** No `osascript`/`start`/`xdg-open` plumbing needed; mirrors the `manuscript-markdown` extension's pattern.
- **REditorSupport.R already ships `r.knitRmdToPdf` / `r.knitRmdToHtml` / `r.knitRmdToAll`.** They use `rmarkdown::render` (which requires Pandoc). Raven's export path uses `knitr::knit` + Pandoc separately, which reuses an already-knitted `.md` from a preview (avoiding re-running R chunks).
- **REditorSupport.R's preview already writes to `tmpDir()` and forces `output_format = rmarkdown::html_document()`.** Issue #1345 in their tracker shows users want this; Raven's redesign aligns.
- **No pure-JS HTML→PDF/DOCX library preserves syntax highlighting + math at acceptable fidelity.** `html-to-docx` / `@turbodocx/html-to-docx` lose code-block colors. `html2pdf.js` rasterizes (loses selectable text). `wkhtmltopdf` is abandonware. Pandoc-only is the right call.

## User-facing surface

### Commands

| Command ID | Title | Where it appears |
|---|---|---|
| `raven.knit` | "Knit Preview" *(renamed)* | Command Palette, `editor/title/run` group, keybinding `cmd/ctrl+shift+enter` |
| `raven.knit.exportHtml` | "Knit: Export to HTML…" *(new)* | Command Palette, `editor/title/run` group |
| `raven.knit.exportPdf` | "Knit: Export to PDF…" *(new)* | Command Palette, `editor/title/run` group |
| `raven.knit.exportDocx` | "Knit: Export to Word…" *(new)* | Command Palette, `editor/title/run` group |
| `raven.knit.openOutputChannel` | (unchanged) | Command Palette |

Command IDs preserved (`raven.knit` keeps its name) so existing keybindings, `tasks.json` entries, and the walkthrough completion event (`onCommand:raven.knit`) keep working.

Same `when` clauses as today: `raven.rmdKnit.enabled && editorLangId == rmd && resourceExtname =~ /^\.[Rr]md$/`. Group ordinals (`raven_knit@1`..`@4`) place Knit Preview above the three Export items.

### Webview toolbar

```text
[Knit again]  [Open in Browser]  [Export ▾]      [Apply VS Code theme]
```

The Export button posts `{ type: 'requestExport' }` to the extension host, which opens a native `vscode.window.showQuickPick`:

```text
$(file-code)  Export to HTML…
$(file-pdf)   Export to PDF…
$(file-word)  Export to Word…
```

If the source `.Rmd` is dirty or its on-disk mtime is newer than the cached preview's `.md`, a top item appears:

```text
$(warning)    Preview may be out of date — Knit again first?
─────────────
$(file-code)  Export to HTML…
...
```

Picking the top item runs knit-then-export as a single cancellable progress operation.

### Editor-title Raven menu

```text
Raven ▾
  Knit Preview                ⌘⇧↵
  ─────────────
  Export to HTML…
  Export to PDF…
  Export to Word…
```

`editor/title/run` group entries with ordinals 1/2/3/4 in groups `raven_knit@1`..`@4`.

### Settings

New:

| Key | Type | Default | Purpose |
|---|---|---|---|
| `raven.pandoc.path` | string | `""` | Absolute path to `pandoc`. Empty = use PATH. |
| `raven.pandoc.pdfEngine` | enum | `"xelatex"` | One of `xelatex`, `pdflatex`, `lualatex`, `tectonic`, `wkhtmltopdf`. Passed as Pandoc's `--pdf-engine=`. |
| `raven.knit.export.timeoutMs` | integer | `120000` | Pandoc subprocess timeout. Pandoc itself is fast; this only bounds runaway invocations. |

Existing settings unchanged: `raven.knit.workingDirectory`, `raven.knit.timeoutMs`, `raven.knit.fontFamily`, `raven.knit.monospaceFontFamily`. The font settings still drive only the webview preview (Pandoc owns export styling).

Settings sync touch-points (per CLAUDE.md): `editors/vscode/package.json` schema, `editors/vscode/src/initializationOptions.ts`, `SETTINGS_MAPPING` in `editors/vscode/src/test/settings.test.ts`, regenerate via `bun editors/vscode/scripts/generate-settings-reference.mjs`.

## Architecture

### Preview pipeline

```text
.Rmd ──knitr::knit──▶ <tempDir>/<basename>.md ──Raven renderer──▶ <tempDir>/<basename>.html
              ▲                                                        │
              │                                                        ▼
              └── chunk options injected via opts_chunk$set       webview iframe
```

### Export pipeline (two entry points share the back end)

```text
              ┌─ webview Export button ──▶ reuse <tempDir>/<basename>.md  ─┐
              │                                                            │
.Rmd ─────────┤                                                            ├──▶ Pandoc ──▶ <rmdDir>/<basename>.<ext>
              │                                                            │
              └─ editor toolbar Export ─▶ fresh knit (own temp subdir) ────┘
```

### Temp directory layout

```text
<os.tmpdir()>/raven-knit/<workspaceHash>/
  ├── preview/<sha256(absRmdPath)>/        ← stable, one per .Rmd
  │     ├── <basename>.md
  │     ├── <basename>.html
  │     └── figure/                        ← knitr-generated plots
  └── export/<uuid>/                       ← unique per editor-toolbar invocation
        └── ...
```

- `<workspaceHash>` is `sha256` of the first workspace folder's URI (stable per workspace, distinct across workspaces sharing the same machine).
- Preview subdirs are stable so the iframe can keep referencing the same paths across re-knits, and `figure/` artifacts stay alive while the panel is open.
- Editor-toolbar export subdirs are throwaway.

### Cleanup

| Trigger | Action |
|---|---|
| `KnitOutputPanel.onDidDispose` | Remove that source's `preview/<sha256>/` subdir |
| Successful or failed export | Remove `export/<uuid>/` in `finally` |
| Extension `deactivate()` | Remove the whole `raven-knit/<workspaceHash>/` dir |
| Extension `activate()` | Sweep `raven-knit/*` orphans with mtime > 7 days |

### Webview reuses cached `.md` unconditionally (Approach C)

The brainstorming process explicitly considered mtime-based invalidation (Approach B) and rejected it. R Markdown chunks routinely read external data (`read.csv('data.csv')`), source other scripts, or pull from remote sources. None of that is reflected in the .Rmd's mtime, so any "reuse if .Rmd unchanged" check would be a partial lie that erodes user trust.

The contract is therefore: **the webview Export button saves the preview you're currently looking at.** If the user wants a fresh render, they click "Knit again" first (or pick the stale-preview shortcut item in the export quickpick). Editor-toolbar exports always re-knit because they have no preview state to consume.

### Cancellable operations

Every long-running operation (knit, export) runs inside `vscode.window.withProgress({ location: Notification, cancellable: true })`. Cancellation:

1. Sends `SIGINT` to the R or Pandoc subprocess.
2. If the process is still alive after 1.5s, escalates to `SIGTERM`.
3. If still alive after another 1.5s, `SIGKILL`. Same ladder `knit-engine.ts` uses for `raven.knit.timeoutMs`.

The notification's native Cancel button is the canonical "stop this now" affordance.

### Conflicting operations

If the user clicks Export or Knit again while an operation is in flight on the same `.Rmd`, show a non-modal toast:

```text
"A knit is in progress for foo.Rmd."
[Cancel and re-knit]  [Wait]
```

`Cancel and re-knit` cancels the in-flight op (via the SIGINT ladder), awaits its exit, then starts the new operation. `Wait` dismisses; the in-flight op continues; the user can still hit the progress notification's Cancel at any time.

Webview button states during in-flight ops:

- The triggering button shows a spinner and changes its tooltip to `"Cancel and start a new export"`. Clicking it triggers the same toast.
- Unrelated buttons (Open in Browser) stay enabled.

## YAML `output:` handling

The gate (`buildNonHtmlFormatBlocker`) is removed. The gate test (`knit-html-only.test.ts`) is repurposed to assert every output format silently becomes an HTML preview.

`yaml-frontmatter.ts` gains a structured view of `output:`:

```typescript
interface OutputOptions {
  // knitr chunk-level (apply via opts_chunk$set before knit)
  chunkOpts: {
    fig_width?: number; fig_height?: number; fig_retina?: number;
    dpi?: number; dev?: string;
  };
  // Pandoc-mappable (export only)
  pandocFlags: {
    toc?: boolean; toc_depth?: number;
    number_sections?: boolean;
    highlight?: string;
    self_contained?: boolean;
    css?: string[]; mathjax?: boolean;
    pandoc_args?: string[];
  };
  ignored: string[];  // logged-but-not-applied keys
}
```

If multiple formats are listed (`output: { pdf_document: {...}, word_document: {...} }`), keys present in the user-requested format block win over keys present in other format blocks. Top-level keys under `output:` apply when no format-specific block contains them.

### Honored keys

**Apply via `knitr::opts_chunk$set(...)` before `knitr::knit(...)` (preview AND export):**

`fig_width`, `fig_height`, `fig_retina`, `dpi`, `dev`.

**Apply as Pandoc flags during export:**

| YAML key | Pandoc flag |
|---|---|
| `toc: true` | `--toc` |
| `toc_depth: N` | `--toc-depth=N` |
| `number_sections: true` | `--number-sections` |
| `highlight: <style>` | `--highlight-style=<style>` |
| `self_contained: true` | `--embed-resources --standalone` |
| `css: [file.css]` | `--css=file.css` (one flag per file) |
| `mathjax: <bool>` | `--mathjax` or omit |
| `pandoc_args: [...]` | passed through verbatim (last) |

### Ignored keys

`theme`, `code_folding`, `df_print`, `code_download`, `template`, `includes`. On each knit/export, ignored keys appear in the `raven.knit.openOutputChannel` channel:

```text
[knit] Ignored output: option 'theme' (html_document Bootstrap themes are not supported by Raven's preview)
[knit] Ignored output: option 'code_folding' (requires html_document JS runtime)
```

No popup. Documented in `docs/knit.md` with the full table.

### R-side safety

Chunk options are injected via R-side variables, never interpolated into the R code string (per the CLAUDE.md "R subprocess safety" invariant):

```r
fig.width <- 5L
fig.height <- 4L
knitr::opts_chunk$set(fig.width = fig.width, fig.height = fig.height)
```

Values are constrained to numeric / boolean / a short allowlist of enum strings (`dev = 'png' | 'pdf' | 'svg' | 'jpeg' | 'cairo_pdf'`). Anything else is dropped with a logged warning.

## Pandoc detection

Lazy: first export attempt only. No probe at activation (keeps startup fast and avoids stale-PATH problems).

```typescript
async function resolvePandoc(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('raven').get<string>('pandoc.path');
  if (configured) {
    await fs.access(configured, fs.constants.X_OK);
    return configured;
  }
  return cachedDetectFromPath();
}
```

In-memory cache cleared on `did_change_configuration` for any `raven.pandoc.*` key. No persistent cache.

Standard install dirs probed when `pandoc` isn't on PATH:

- macOS: `/usr/local/bin/pandoc`, `/opt/homebrew/bin/pandoc`, RStudio's bundled `/Applications/RStudio.app/Contents/Resources/app/quarto/bin/tools/pandoc`.
- Windows: `%LOCALAPPDATA%\Pandoc\pandoc.exe`, `%PROGRAMFILES%\Pandoc\pandoc.exe`.
- Linux: `/usr/bin/pandoc`, `/usr/local/bin/pandoc`.

### Failure UX — Pandoc missing

```text
"Pandoc not found. Install it to export to PDF or Word."
[Install Pandoc…]  [Set path…]  [Dismiss]
```

- `Install Pandoc…` → `vscode.env.openExternal('https://pandoc.org/installing.html')`
- `Set path…` → opens settings UI scoped to `raven.pandoc.path` via `vscode.commands.executeCommand('workbench.action.openSettings', 'raven.pandoc.path')`

### Failure UX — Pandoc invocation fails

```text
"Export to PDF failed."
[Show details]  [Try Word instead]  [Dismiss]
```

- `Show details` reveals the last Pandoc stderr in `raven.knit.openOutputChannel`.
- `Try Word instead` re-invokes `raven.knit.exportDocx` on the same source. Only shown for PDF failures (LaTeX engine issues are the common cause).

### LaTeX engine detection (PDF only)

If Pandoc's stderr matches `/(xelatex|pdflatex|lualatex|tectonic) not found/`, show a more specific message:

```text
"PDF export needs a LaTeX engine."
[Install TinyTeX…]  [Show details]  [Dismiss]
```

`Install TinyTeX…` opens the TinyTeX install guide URL. Raven does **not** auto-install.

### Subprocess invocation

A new `pandocConvert(mdPath, format, args, opts)` in `editors/vscode/src/knit/pandoc-engine.ts`, shaped like `knit-engine.ts`:

- `child_process.spawn` with the resolved Pandoc path + args (never `shell: true`).
- All paths passed as args, never interpolated.
- Same SIGINT → SIGTERM → SIGKILL escalation ladder, `raven.knit.export.timeoutMs`.
- stderr piped into the knit output channel.
- Format flags: `exportHtml` → `--to html5 --standalone`, `exportPdf` → `--to pdf --pdf-engine=<setting>`, `exportDocx` → `--to docx`.

## Post-export feedback

Both entry points (webview and editor toolbar) share this notification:

```typescript
const action = await vscode.window.showInformationMessage(
  `Saved ${basename}.${ext}`,
  format === 'docx' ? 'Open in Word' :
  format === 'pdf'  ? 'View PDF' :
                      'Open in Browser'
);
if (action) {
  await vscode.env.openExternal(savedUri);
}
```

`vscode.env.openExternal` handles macOS/Windows/Linux without per-platform plumbing.

## Migration

- Current code writes `<basename>.md` + `figure/` into the .Rmd directory. After this lands those locations are no longer written; existing files are left in place (already gitignored per commit `109110cd`). No prompt, no auto-delete.
- The gate is removed. Documents that today produce the "Copy command" dialog now silently render as HTML preview. `CHANGELOG.md` notes the behavior change.
- Existing keybindings, `tasks.json` entries, and the walkthrough completion event keep firing — command ID `raven.knit` unchanged.

## Tests

### Existing test files

| File | Action |
|---|---|
| `knit-html-only.test.ts` | **Repurpose** — assert every output format becomes an HTML preview. Rename to `knit-yaml-output-ignored.test.ts`. |
| `knit-output-panel.test.ts` | **Update** — output paths move to per-source temp subdir. |
| `knit-progress-lifecycle.test.ts` | **Extend** — verify cancellable progress wires into export commands too. |
| `knit-render-failure-fallback.test.ts` | **Update** — fallback opens temp-dir `.md`, not source-dir. |
| `knit-save-before-run.test.ts`, `knit-multi-panel.test.ts`, `knit-rootdir-change.test.ts`, `knit-recompute-preview-column.test.ts`, `knit-success-no-popover.test.ts`, `knit-theme-classes.test.ts`, `knit-output-iframe-load.test.ts`, `knit-preview-column.test.ts` | Unchanged |

### New test files

- `knit-export-html.test.ts` — webview Export → HTML copies cached .md, runs Pandoc HTML, lands at `<rmdDir>/<basename>.html`; notification offers "Open in Browser".
- `knit-export-pdf.test.ts` — Pandoc PDF path mocked (no LaTeX needed); verifies args + output path.
- `knit-export-docx.test.ts` — same for DOCX.
- `knit-export-cancel.test.ts` — start an export, cancel mid-knit, assert R subprocess receives SIGINT and no output file is written.
- `knit-export-pandoc-missing.test.ts` — mock `resolvePandoc` to throw ENOENT; assert dialog with "Install Pandoc…" / "Set path…" actions.
- `knit-export-yaml-args.test.ts` — `output.pdf_document.toc: true` produces `--toc`; `theme:` is logged as ignored.
- `knit-export-busy.test.ts` — clicking Export during an in-flight knit shows the `[Cancel and re-knit] / [Wait]` toast; cancel restarts.
- `knit-temp-dir-cleanup.test.ts` — closing the panel removes the per-source preview subdir; deactivating removes the workspace root.

### Pure-function unit tests

- `buildPandocArgs.test.ts` — exhaustive cases for honored keys + `pandoc_args` pass-through allowlist.
- `output-options-parse.test.ts` — new structured extraction in `yaml-frontmatter.ts`. Edge cases: object vs string output form, multiple formats listed, key collisions.

### Sandbox-skip

Tests that spawn Pandoc or that depend on subprocess signal delivery self-skip via `isClaudeCodeSandbox()` (per CLAUDE.md "macOS FSEvents" learning), reporting "skipped (sandbox)" instead of timing out.

## Docs

- **`docs/knit.md`**: rewrite to reflect the new pipeline. Sections: "What Knit Preview does", "Where files go" (temp dir + how to find them), "Exporting" (HTML/PDF/Word, what each needs), "YAML options honored / ignored" (full table).
- **`README.md`**: update the Knit feature paragraph to mention export.
- **`docs/coexistence.md`**: note that REditorSupport.R's `r.knitRmdToPdf` etc. continue to work; user picks.
- **`CHANGELOG.md`**: Knit → Knit Preview rename, files-to-temp, gate removed, new export commands, new settings.
- **`CLAUDE.md`** Knit invariants section: add (1) the temp-dir layout contract, (2) the webview-export-reuses-cached-md contract.

## Invariants worth pinning in CLAUDE.md

1. **Temp-dir layout** (`raven-knit/<workspaceHash>/preview|export/...`) is the contract; tests assert it. Don't relocate without updating tests + cleanup paths in lockstep.
2. **Webview Export reuses the cached `.md` unconditionally.** Editor-toolbar Export always re-knits. Don't add hidden mtime checks — the brainstorming process rejected that approach because R chunks read external state the .Rmd's mtime doesn't capture.
3. **Chunk-option injection passes values as R-side variables**, never interpolated into the R code string. Dev/format strings are validated against an allowlist before injection.
4. **Pandoc-flag mapping is centralized in `buildPandocArgs()`.** Adding a new honored YAML key means adding to that function + its tests; not scattering format logic across the export commands.
5. **`pandocConvert` never invokes the shell.** `child_process.spawn` with an args array. All paths arrive as args; never concatenated into a command string.

## Follow-up issues

1. **Custom highlighting-preserving Word/PDF renderer.** Build a tiny renderer that consumes Raven's role-tagged token stream and emits OOXML (via the `docx` npm package) and PDF (via `pdfmake` or `jsPDF` with colored runs). Goal: beat Pandoc on the highlighting dimension we already win on for HTML preview. Substantial work; only worth doing once Pandoc-only path is shipped and stable.
2. **Per-format YAML option scoping.** Today we merge multiple format blocks. Consider a stricter mode (only the requested format's block is consulted) if users complain about cross-contamination.
