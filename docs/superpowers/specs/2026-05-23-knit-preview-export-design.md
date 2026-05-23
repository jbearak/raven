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

If the open source `.Rmd` is dirty (unsaved changes) or its on-disk mtime is newer than the cached preview's `.md`, a top item appears:

```text
$(warning)    Preview may be out of date — Knit again first?
─────────────
$(file-code)  Export to HTML…
...
```

**This mtime check is advisory UI only.** It is not used to invalidate the cache or block export. If the user picks one of the format items below, we export the cached `.md` as-is (per Approach C in the Architecture section). If they pick the top item, we run knit-then-export as a single cancellable progress operation.

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
              └── chunk options + fig.path injected           webview iframe
                  via opts_chunk$set
```

**`fig.path` is set explicitly** to a relative path that knitr resolves under its working directory — e.g., `opts_chunk$set(fig.path = 'figure/')` while `opts_knit$set(base.dir = <tempDir>, root.dir = <user setting>)`. Setting `base.dir` to the temp dir (separate from `root.dir`, which controls *where R code runs*) directs knitr's plot-saving to the temp dir without changing the working directory the user's chunks see. This avoids: (a) plots landing in the user's source folder during knit (regression we'd hit if we only set `output`); (b) plots landing in the user's CWD (the wrong place too).

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
<os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/
  ├── preview/<sha256(absRmdPath)>/        ← stable, one per .Rmd, scoped to this VS Code window
  │     ├── <basename>.md
  │     ├── <basename>.html
  │     └── figure/                        ← knitr-generated plots
  └── export/<uuid>/                       ← unique per editor-toolbar invocation
        └── ...
```

- `<workspaceHash>` is `sha256` of the first workspace folder's URI (stable per workspace, distinct across workspaces sharing the same machine). If no workspace is open (the user opened a single `.Rmd` directly), we fall back to `sha256` of the .Rmd's parent directory absolute path.
- **`<sessionId>` is a per-extension-host UUID generated at activation** (closes Codex finding #5). Two VS Code windows open on the same workspace get isolated `sessionId` subdirs, so one window's `deactivate()` cleanup cannot delete temp dirs the other window is still using.
- Preview subdirs are stable so the iframe can keep referencing the same paths across re-knits, and `figure/` artifacts stay alive while the panel is open.
- Editor-toolbar export subdirs are throwaway.

### Cleanup

| Trigger | Action |
|---|---|
| `KnitOutputPanel.onDidDispose` | Mark that source's `preview/<sha256>/` for deletion; remove immediately if no in-flight exports reference it, otherwise defer until refcount drops to 0. |
| Successful or failed export | Decrement preview-dir refcount; remove `export/<uuid>/` in `finally`. |
| Extension `deactivate()` | Remove only **this session's** dir: `raven-knit/<workspaceHash>/<sessionId>/`. Sibling sessions' dirs are left alone. |
| Extension `activate()` | Sweep `raven-knit/*/*` orphans (any `<workspaceHash>/<sessionId>` dir with mtime > 7 days). |

**Preview-dir pinning**: each in-flight export that consumes `preview/<sha256>/` (the webview-export path) increments a refcount on that subdir for the duration of the Pandoc subprocess. Closing the panel mid-export is allowed but the temp dir is preserved until the refcount drops to 0, then deleted. This closes the race where panel disposal removes the `.md` and `figure/` while Pandoc is still reading them.

The pinning structure is in-memory only — process crash leaves orphans, swept on next activation.

### Webview reuses cached `.md` unconditionally (Approach C)

The brainstorming process explicitly considered mtime-based invalidation (Approach B) and rejected it. R Markdown chunks routinely read external data (`read.csv('data.csv')`), source other scripts, or pull from remote sources. None of that is reflected in the .Rmd's mtime, so any "reuse if .Rmd unchanged" check would be a partial lie that erodes user trust.

The contract is therefore: **the webview Export button saves the preview you're currently looking at.** If the user wants a fresh render, they click "Knit again" first (or pick the stale-preview shortcut item in the export quickpick). Editor-toolbar exports always re-knit because they have no preview state to consume.

### Cancellable operations

Every long-running operation (knit, export) runs inside `vscode.window.withProgress({ location: Notification, cancellable: true })`. Cancellation:

1. Sends `SIGINT` to the R or Pandoc subprocess.
2. If the process is still alive after 1.5s, escalates to `SIGTERM`.
3. If still alive after another 1.5s, `SIGKILL`. Same ladder `knit-engine.ts` uses for `raven.knit.timeoutMs`.

The notification's native Cancel button is the canonical "stop this now" affordance.

### Operation controller (replaces the current in-flight Set)

`knit-commands.ts` currently tracks in-flight knits as a bare `Set<string>` of source paths keyed by normalized `fsPath`. The export feature needs richer state — toolbar buttons need to know what op + phase is running, the webview needs to display the spinner, and `cancelExport` messages need a handle to call into. So we replace the Set with an `OperationController` registry:

```typescript
type OpKind = 'knit-preview' | 'export-html' | 'export-pdf' | 'export-docx' | 'knit-then-export';
type OpPhase = 'starting' | 'knitting' | 'converting' | 'finalizing';

interface OperationController {
  /** Normalized fsPath key. NEVER raw URI string — see registry rules. */
  key: string;
  kind: OpKind;
  phase: OpPhase;
  cancellation: vscode.CancellationTokenSource;
  promise: Promise<void>;          // resolves on cleanup, even after cancel
  broadcastToPanel: (phase: OpPhase | 'done' | 'cancelled') => void;
}
```

**Registry contract (closes Codex finding #1):**

1. **Canonical key**: `path.normalize(uri.fsPath)`, lowercased on Windows (since NTFS is case-insensitive). The same `.Rmd` opened under different URI casings or relative paths must collapse to one controller. Defined as a single shared `canonicalOpKey(uri: vscode.Uri): string` helper, used everywhere.
2. **Synchronous register-before-await**: the entry point (command handler or webview-message handler) MUST call `registry.beginOp(key, kind)` *before* its first `await`. `beginOp` either inserts a `pending` controller and returns it, or — if a controller for `key` already exists — returns `{ existing: <controller> }` so the caller can show the conflict toast. Any async work (Pandoc detection, save, quickpick) runs only after registration succeeds. This closes the two-clicks-race finding.
3. **One controller per key at a time** (the existing one-per-source invariant). New ops on the same key must `await previous.promise` after calling `previous.cancellation.cancel()`, before inserting their own controller.
4. The webview Export button posts `{ type: 'cancelExport' }`; the host looks up the controller for the panel's source key and calls `cancellation.cancel()`.
5. **Test**: `knit-op-registry-race.test.ts` — two `vscode.commands.executeCommand('raven.knit.exportPdf', uri)` calls fired without awaiting either; assert exactly one Pandoc invocation occurs and the second call surfaces the busy-toast.

### Conflicting operations

If the user clicks Export or Knit again while an operation is in flight on the same `.Rmd`, show a non-modal toast:

```text
"A knit is in progress for foo.Rmd."
[Cancel and re-knit]  [Wait]
```

`Cancel and re-knit` cancels the in-flight op (via the SIGINT ladder), awaits its exit, then starts the new operation. `Wait` dismisses; the in-flight op continues; the user can still hit the progress notification's Cancel at any time.

Webview button states during in-flight ops:

- While a **knit** is running: the `Knit again` button shows a spinner with tooltip `"Cancel and re-knit"`. Clicking it triggers the toast above. The `Export ▾` button is disabled with tooltip `"Wait for knit to finish, or cancel it"`.
- While an **export** is running: the `Export ▾` button shows a spinner with tooltip `"Cancel current export"`. Clicking it cancels the in-flight export (no toast — single-op cancel). The `Knit again` button is disabled with tooltip `"Wait for export to finish"`.
- Unrelated buttons (Open in Browser, Apply VS Code theme) stay enabled regardless.

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
  // Pandoc-mappable (export only). pandoc_args is NOT included in v1 — see
  // honored-keys table below. Adding it later requires an allowlist gate.
  pandocFlags: {
    toc?: boolean; toc_depth?: number;
    number_sections?: boolean;
    highlight?: string;
    self_contained?: boolean;
    css?: string[]; mathjax?: boolean;
  };
  ignored: string[];  // logged-but-not-applied keys (includes pandoc_args)
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
| `highlight: <style>` | `--highlight-style=<style>` (style validated against Pandoc's known list) |
| `self_contained: true` | `--embed-resources --standalone` |
| `css: [file.css]` | `--css=<absolute path>` — see CSS path resolution rule below |
| `mathjax: <bool>` | `--mathjax` or omit |

**CSS path resolution (closes Codex finding #2):** since Pandoc's `cwd` is the temp `.md` directory (not the source `.Rmd` directory), source-relative paths in YAML's `css:` list would resolve against the wrong directory. We resolve each entry against the source `.Rmd`'s parent directory, validate that the resolved absolute path is inside a **containment root**, reject anything that fails validation (logged as ignored, just like `pandoc_args`), and pass the absolute path to Pandoc. Same rule applies to `--reference-doc` if ever added.

**Containment root**: the workspace folder containing the `.Rmd`. If the user has no workspace open (opened the `.Rmd` directly as a single file), the containment root falls back to the `.Rmd`'s parent directory. This matches the temp-dir layout's no-workspace fallback (`<workspaceHash>` falls back to the .Rmd parent dir), so a `style.css` next to the `.Rmd` is accepted in both single-file and workspace contexts.

**`pandoc_args` is NOT honored in v1** (security: a document could pass `--output`, `--lua-filter`, `--metadata-file`, `--extract-media`, or other flags that bypass Raven's controlled destination or execute external code). Tracked in follow-up issue #2 with a defined allowlist/blocklist as a prerequisite.

### YAML option merge precedence

When the user requests export to format F (HTML, PDF, DOCX), option resolution proceeds in strict precedence order, first-match wins:

1. Block keyed by the requested format's rmarkdown equivalent: `html_document:` for HTML, `pdf_document:` for PDF, `word_document:` for DOCX. (Also accept `bookdown::html_document2`, `tufte::tufte_html`, etc., from `SUPPORTED_HTML_FORMATS` — these all map to "HTML" intent.)
2. Top-level keys directly under `output:` (e.g., `output: { toc: true, pdf_document: {...} }`).
3. Raven's built-in defaults.

Format blocks for *non-matching* formats are completely ignored. Specifically: when exporting to PDF, options inside `html_document:` are NOT consulted. This avoids the spec ambiguity where a `toc_depth` set under `html_document:` accidentally drives the PDF table-of-contents depth. Same applies to chunk-level options that come from a format block.

For preview (always HTML), the format-matching layer uses `html_document:` (with the alias list).

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
- `Set path…` → opens settings UI scoped to `raven.pandoc.path` via `vscode.commands.executeCommand('workbench.action.openSettings', '@id:raven.pandoc.path')` (the `@id:` filter restricts the search to that one setting).

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
- **`cwd` is the temp directory containing the `.md`**, never the source `.Rmd` directory. This guarantees relative `figure/foo.png` references in the .md resolve against the freshly-generated temp `figure/` and not against stale source-directory artifacts left over from earlier knit runs.
- **The destination output is written via temp-then-rename** (same pattern as `post-knit-renderer.ts:writeFileAtomic`). Pandoc's `-o` flag points to a unique sibling temp path inside the destination directory (e.g., `.foo.docx.<pid>.<rand>.tmp`); on Pandoc's clean exit Raven renames over the final destination. On cancel/failure the temp is unlinked, leaving any prior good output untouched. Cross-device renames aren't a concern since the temp lives next to the destination.

### Webview message trust boundary (security)

Adding `requestExport` requires updating the existing trust boundary in `knit-output.ts` and `knit-output-panel.ts`. **Validation rule: exact-schema match per message type** — for each known `type`, the validator declares the exact allowed key set, and any message with extra/missing/misnamed keys is rejected. (Earlier draft had two contradictory rules — reject *and* ignore extras — Codex P2-3 picked exact-match; P3-1 then noted the rule must be per-type, since existing messages legitimately carry payloads.)

The full per-type schema after this change:

| `type` value | Allowed key set |
|---|---|
| `requestExport` | `{ type }` |
| `cancelExport` | `{ type }` |
| `refresh` | `{ type }` |
| `openInBrowser` | `{ type }` |
| `themeChanged` | `{ type, applied }` |
| `themeContext` | `{ type, editorBackground }` |
| `paletteRequest` | `{ type }` |
| `fontRequest` | `{ type }` |

(The four `themeChanged`/`themeContext`/`paletteRequest`/`fontRequest` rows reflect what the validator already does; restating them ensures `isKnitOutputMessage` stays consistent after the change. Existing tests already cover these; the new tests below cover the two new types.)

- Add `'requestExport'` and `'cancelExport'` to the `KnitOutputMessage` discriminated union with payload shape `{ type: 'requestExport' }` / `{ type: 'cancelExport' }` — no other fields. The native quickpick the host opens collects the format choice; format never crosses the webview boundary, so untrusted payload surface is zero.
- Extend `isKnitOutputMessage` so each known `type` checks `Object.keys(msg).sort()` against that type's allowed key set (sorted) for exact equality.
- Add unit test asserting `{ type: 'requestExport', format: '../etc/passwd' }` is rejected (extra key violates exact-match).
- Add unit test asserting `{ type: 'requestExport' }` with no extra keys is accepted and dispatches the host's quickpick.
- Add a regression unit test asserting existing payloaded messages (`themeChanged`, `themeContext`) still validate after the change.

## Post-export feedback

Both entry points (webview and editor toolbar) share this notification, which mirrors the existing remote-workspace fallback pattern from `knit-output-panel.ts:openInBrowser`:

```typescript
async function openExportedFile(savedUri: vscode.Uri, format: 'html' | 'pdf' | 'docx', output: vscode.OutputChannel): Promise<void> {
  const label = format === 'docx' ? 'Open in Word' : format === 'pdf' ? 'View PDF' : 'Open in Browser';
  const action = await vscode.window.showInformationMessage(`Saved ${path.basename(savedUri.fsPath)}`, label);
  if (action !== label) return;

  let opened = false;
  try {
    opened = await vscode.env.openExternal(savedUri);
  } catch (err) {
    output.appendLine(`[Export] openExternal threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opened) return;
  // Remote workspaces: file:// URIs may route to the extension-host machine
  // rather than the user's. Same fallback as the existing Open in Browser flow.
  output.appendLine(`[Export] file:// did not open. Output is at: ${savedUri.fsPath}`);
  void vscode.window.showWarningMessage(
    `${label} is not available for this workspace. The file path has been written to the Raven: Knit output channel.`,
  );
}
```

`vscode.env.openExternal` handles macOS/Windows/Linux without per-platform plumbing in *local* workspaces. Remote workspaces (SSH, dev containers, codespaces) need the fallback because `file:` URIs may resolve on the wrong side of the remote bridge.

## Migration

- Current code writes `<basename>.md` + `figure/` into the .Rmd directory. After this lands those locations are no longer written; existing files are left in place (already gitignored per commit `109110cd`). No prompt, no auto-delete.
- The gate is removed. Documents that today produce the "Copy command" dialog now silently render as HTML preview. Documented in the PR description (Raven has no `CHANGELOG.md`; user-facing change notes live in PR descriptions and `docs/knit.md`).
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
- `knit-export-atomic.test.ts` — pre-existing good `<basename>.docx` next to .Rmd; export is cancelled mid-Pandoc; assert the existing file is untouched and no `.tmp` sibling remains.
- `knit-export-pinning.test.ts` — start a webview export, dispose the panel mid-export, assert temp dir survives until Pandoc exits, then is cleaned up.
- `knit-export-stale-figures.test.ts` — pre-existing `figure/old.png` in the .Rmd's directory; new knit produces a different plot in temp `figure/`; assert exported PDF references the new plot, not the stale one.
- `knit-export-pandoc-args-rejected.test.ts` — YAML containing `pandoc_args: ['--output=/tmp/pwned', '--lua-filter=evil.lua']` is parsed but those args are NOT passed to Pandoc; the keys appear in the ignored-output channel log.
- `knit-export-yaml-merge.test.ts` — YAML with both `html_document:` and `pdf_document:` blocks; exporting to PDF picks only `pdf_document:` options (not `html_document:`).
- `knit-export-remote-fallback.test.ts` — mock `vscode.env.openExternal` to return false; assert warning toast shown and the output path appears in the knit channel.
- `knit-multi-root-isolation.test.ts` — two workspace folders contain `analysis.Rmd` files at different absolute paths; assert their temp subdirs hash to different `preview/<sha256>/` paths and neither knit reads the other's `.md`.
- `knit-multi-window-isolation.test.ts` — simulate two extension-host sessions on the same workspace; assert their temp subdirs are under different `<sessionId>` paths and one session's `deactivate()` doesn't delete the other's preview/export dirs.
- `knit-op-registry-race.test.ts` — fire two `raven.knit.exportPdf` commands on the same URI without awaiting; assert exactly one Pandoc invocation and the second call triggers the busy-toast.
- `knit-export-css-resolution.test.ts` — assert that:
  - With a workspace: `output.html_document.css: ['style.css']` next to the .Rmd → Pandoc receives `--css=<absolute-path>`. `css: ['../../etc/passwd']` is dropped and logged.
  - Without a workspace (single .Rmd opened directly): `style.css` next to the .Rmd is still accepted. `../style.css` is rejected as it escapes the .Rmd parent dir.
- `knit-figpath-modes.test.ts` — integration test that knits a chunk producing a plot, under each of the three `raven.knit.workingDirectory` modes (`document`, `project`, `current`); assert the plot file lands in the per-document preview `figure/` subdir and not in any source-tree location.

### Pure-function unit tests

- `buildPandocArgs.test.ts` — exhaustive cases for honored keys. Asserts `pandoc_args` from YAML is dropped and surfaces in `ignored`.
- `output-options-parse.test.ts` — new structured extraction in `yaml-frontmatter.ts`. Edge cases: object vs string output form, multiple formats listed, key collisions.

### Sandbox-skip

Tests that spawn Pandoc or that depend on subprocess signal delivery self-skip via `isClaudeCodeSandbox()` (per CLAUDE.md "macOS FSEvents" learning), reporting "skipped (sandbox)" instead of timing out.

## Docs

- **`docs/knit.md`**: rewrite to reflect the new pipeline. Sections: "What Knit Preview does", "Where files go" (temp dir + how to find them), "Exporting" (HTML/PDF/Word, what each needs), "YAML options honored / ignored" (full table).
- **`README.md`**: update the Knit feature paragraph to mention export.
- **`docs/coexistence.md`**: note that REditorSupport.R's `r.knitRmdToPdf` etc. continue to work; user picks.
- **`CLAUDE.md`** Knit invariants section: add (1) the temp-dir layout contract, (2) the webview-export-reuses-cached-md contract, (3) the chunk-option injection safety rule, (4) the centralized-Pandoc-args invariant.

## Invariants worth pinning in CLAUDE.md

1. **Temp-dir layout** (`raven-knit/<workspaceHash>/preview|export/...`) is the contract; tests assert it. Don't relocate without updating tests + cleanup paths in lockstep.
2. **Webview Export reuses the cached `.md` unconditionally.** Editor-toolbar Export always re-knits. Don't add hidden mtime checks — the brainstorming process rejected that approach because R chunks read external state the .Rmd's mtime doesn't capture.
3. **Chunk-option injection passes values as R-side variables**, never interpolated into the R code string. Dev/format strings are validated against an allowlist before injection.
4. **Pandoc-flag mapping is centralized in `buildPandocArgs()`.** Adding a new honored YAML key means adding to that function + its tests; not scattering format logic across the export commands.
5. **`pandocConvert` never invokes the shell.** `child_process.spawn` with an args array. All paths arrive as args; never concatenated into a command string.
6. **Pandoc's `cwd` is the temp `.md` directory, never the source `.Rmd` directory.** This prevents relative `figure/foo.png` references in the .md from resolving against stale source-directory artifacts.
7. **Export destinations are written via temp-then-rename.** Same `writeFileAtomic` shape as `post-knit-renderer.ts`. Cancel/failure during Pandoc must not corrupt or clobber a prior good output.
8. **Preview temp dirs are refcounted during in-flight exports.** Panel disposal marks for deletion; actual `rm -rf` waits for refcount → 0. Don't add a code path that removes the temp dir while an export references it.
9. **`pandoc_args` from YAML is not honored.** A document could otherwise inject `--output`, `--lua-filter`, `--metadata-file`. If support is added later, it MUST go through an allowlist/blocklist defined adjacent to `buildPandocArgs`.
10. **Webview→host messages stay in the trust boundary.** Any new message type (`requestExport`, `cancelExport`) must be added to `KnitOutputMessage` AND `isKnitOutputMessage` in the same commit, with a unit test proving malformed payloads are rejected.

## Follow-up issues

1. **Custom highlighting-preserving Word/PDF renderer.** Build a tiny renderer that consumes Raven's role-tagged token stream and emits OOXML (via the `docx` npm package) and PDF (via `pdfmake` or `jsPDF` with colored runs). Goal: beat Pandoc on the highlighting dimension we already win on for HTML preview. Substantial work; only worth doing once Pandoc-only path is shipped and stable.
2. **Audited `pandoc_args` passthrough.** Define an allowlist of safe Pandoc flags (e.g., `--shift-heading-level-by`, `--reference-doc` from a workspace path) and a blocklist (anything that changes destination, format, or executes code). Behind a workspace-trust gate.

## Codex adversarial review

The spec was reviewed against the criteria in the user's `feedback_codex_adversarial_review` memory. Two passes; all findings addressed inline above.

**Pass 1 — 10 original findings:**

| # | Severity | Topic | Addressed in |
|---|---|---|---|
| 1 | Critical | `pandoc_args` verbatim passthrough is unsafe | Honored-keys table; `OutputOptions` struct; follow-up #2 |
| 2 | Critical | Export destination not atomic | Subprocess invocation section; invariant #7 |
| 3 | High | Temp-dir cleanup races webview export | Cleanup section + refcount; invariant #8 |
| 4 | High | Stale source-dir artifacts shadow temp figures | Subprocess invocation `cwd`; invariant #6 |
| 5 | High | knitr `fig.path` not forced into temp | Preview pipeline (`base.dir` + `fig.path`) |
| 6 | High | YAML option merge order undefined | New "Merge precedence" subsection |
| 7 | Medium | `requestExport` not in trust boundary | Webview message trust boundary section; invariant #10 |
| 8 | Medium | No operation registry | Operation controller section |
| 9 | Medium | Remote-workspace `openExternal` fallback missing | Post-export feedback section |
| 10 | Low | Test plan omitted critical failure modes | Six new test files added |

**Pass 2 — 7 follow-on findings from reviewing Pass 1 fixes:**

| # | Severity | Topic | Addressed in |
|---|---|---|---|
| P2-1 | High | OperationController keying + sync-register contract | Registry contract subsection + race test |
| P2-2 | High | CSS path resolution broken by Pandoc cwd change | CSS path resolution rule + `knit-export-css-resolution.test.ts` |
| P2-3 | High | Trust-boundary self-contradiction (reject vs ignore extras) | Exact key-set match rule |
| P2-4 | Medium | `pandoc_args` still in `OutputOptions` struct/tests | Removed from `pandocFlags`; only in `ignored` |
| P2-5 | Medium | Multi-window deactivate race | `<sessionId>` subdir + `knit-multi-window-isolation.test.ts` |
| P2-6 | Medium | knit-then-export needs `kind`/`phase` model | Updated `OperationController` shape |
| P2-7 | Low | `fig.path` claim needs explicit verification test | `knit-figpath-modes.test.ts` added |

**Pass 3 — 2 wording-precision findings:**

| # | Severity | Topic | Addressed in |
|---|---|---|---|
| P3-1 | Medium | Trust-boundary "only `type`" rule would break existing payloaded messages | Per-type exact-schema table |
| P3-2 | Medium | CSS containment root undefined for no-workspace files | Explicit fallback to .Rmd parent dir; test added |
