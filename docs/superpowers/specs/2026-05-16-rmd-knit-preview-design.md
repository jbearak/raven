# R Markdown Knit — Design

**Issue**: [#226](https://github.com/jbearak/raven/issues/226) — replaces the original underspecified body.
**Status**: Design (Option Y — scope reduced after architectural review).
**Authors**: jbearak, with two rounds of adversarial review from Codex (2026-05-16).
**Supersedes**: deferred Phase 4 of [#209](https://github.com/jbearak/raven/issues/209) / [PR #225](https://github.com/jbearak/raven/pull/225).

## Why this spec is small

The original issue body asked for knit commands **plus** a live-preview webview. After researching how vscode-R, RStudio, and Positron implement the live-preview side, two facts forced a scope cut:

1. **The official `quarto.quarto` extension already implements live preview** for both `.qmd` and `.Rmd` (via Quarto's knitr engine). It does so with a `quarto preview` + iframe pattern that depends on undocumented Quarto-internal token protocols. Raven duplicating that pattern would add no user value, would couple raven to a private Quarto protocol forever, and would force per-surface gating gymnastics that obscure what raven actually does.

2. **The only knit/preview capability `quarto.quarto` does not cover well** is `rmarkdown::render` for `.Rmd` files when the user has R installed but not Quarto CLI. That is a real gap (vscode-R fills it; raven users who prefer raven over vscode-R lose it).

Raven therefore ships **one command** — `Raven: Knit` for `.Rmd` — and defers everything else to `quarto.quarto`. Preview, in any form, is not in scope.

## Goals

1. Provide `Raven: Knit` for `.Rmd` files: runs `rmarkdown::render` in a fresh R subprocess and reveals the rendered output.
2. Detect missing prerequisites (R, workspace trust) cleanly with actionable error messages.
3. Refuse `.Rmd` files that need deferred features (`runtime: shiny`, custom YAML `knit:` hook) with a copy-paste command the user can run manually.
4. Nudge users toward `quarto.quarto` for preview and toward `REditorSupport.r-syntax` (or `REditorSupport.r`) for `.Rmd` grammar, via one-time install info messages and a walkthrough.
5. Avoid duplicating UI surfaces that sibling extensions already provide.

## Non-goals

The following are explicitly out of scope. They belong to `quarto.quarto`, vscode-R, or potential future work (not currently tracked — see the "Potential future work" section below):

| Capability | Where it lives instead |
|---|---|
| Live preview of `.qmd` or `.Rmd` | `quarto.quarto`'s `Quarto: Preview` command |
| `.qmd` rendering | `quarto.quarto`'s `Quarto: Render` command |
| `.qmd` syntax / grammar / LSP | `quarto.quarto` |
| `.Rmd` syntax / grammar | `REditorSupport.r-syntax` or `REditorSupport.r` |
| `.Rmd` knit dropdown (Knit to HTML / PDF / Word picker) | Use `quarto render foo.Rmd --to <fmt>` via Quarto CLI |
| Custom YAML `knit:` hook dispatch (bookdown / xaringan / pkgdown) | Run the hook function manually in the R console (deferral message includes copyable command) |
| Knit-with-Parameters dialog | Edit YAML defaults and re-knit, or `rmarkdown::render(params = list(...))` programmatically |
| `runtime: shiny` / `server: shiny` documents | `rmarkdown::run('foo.Rmd')` in the R console; or use Quarto's `server: shiny` |
| `rmarkdown::render_site` | `rmarkdown::render_site()` in the R console; or migrate to Quarto Websites |
| Knit in raven's active R console (vs. fresh subprocess) | Potential future opt-in setting; manual `rmarkdown::render(...)` in console for now |

## Architecture

A single command. No webview, no HTTP, no token scraping.

```text
User: raven.knit on foo.Rmd
        │
        ▼
 [1] Workspace trust check
 [2] YAML front matter parse + deferred-feature-blocker detection
 [3] Format detection (first `output:` entry, else "html_document")
 [4] Resolve working directory
 [5] R subprocess: child_process.spawn("R", ["--no-save", "--no-restore", "-e", "<expr>"])
 [6] Stream stdout/stderr to OutputChannel "Raven: Knit"; progress notification with Cancel
 [7] Parse output path from stdout
 [8] Reveal output (HTML → vscode.open in Simple Browser when remote; else revealFileInOS)
```

### Why fresh R subprocess (not raven's R terminal)

- Matches vscode-R's default and Positron's task model.
- No state pollution: user's loaded packages and options are untouched.
- Easy cancellation via signal.
- Doesn't require raven's R console to be active. `raven.knit` works whenever R is on PATH, regardless of whether the user has the R console enabled.

Trade-off: users with slow-loading packages pay cold-start cost on every knit. An opt-in `raven.knit.useActiveRConsole` setting could address this in a future enhancement; not in scope here.

### Why no `.qmd` knit

`quarto.quarto`'s `Quarto: Render` covers this. Duplicating it from raven adds no value and forces raven to track the Quarto CLI's option surface (`--to`, `--execute`, `--profile`, etc.) indefinitely.

If the user opens a `.qmd` without `quarto.quarto` installed, raven nags them to install it. Raven does not attempt to render `.qmd` files itself.

## Components

```text
editors/vscode/src/
  knit/
    index.ts              # activation, command registration, gating
    knit-commands.ts      # raven.knit + raven.knit.openOutputChannel
    knit-engine.ts        # spawn R, stream output, kill on cancel/timeout
    yaml-frontmatter.ts   # parseFrontmatter() (js-yaml); detectFormat(); detectTier2Blockers()
    r-expression.ts       # buildKnitExpression(): R-string-safe construction of the rmarkdown::render call
    output-path.ts        # parseRenderedOutputPath(stdout) for the "Output created:" line
  recommendations/
    install-nag.ts        # one-time prompts for quarto.quarto and REditorSupport.r-syntax
    walkthrough.ts        # contributes.walkthroughs registration
```

No `preview/` directory. No `quarto-detection.ts`. No webview anywhere in this design.

## Gating

`raven.knit` is gated behind the **existing** `raven.rConsole.activation` setting, with the same auto-defer behavior chunks already use:

| Sibling extension active | `raven.rConsole.activation = auto` resolves to |
|---|---|
| vscode-R or Positron | `disabled` (vscode-R provides `r.knitRmd`) |
| Otherwise | `enabled` |

**`quarto.quarto`'s presence does NOT defer `raven.knit`.** Rationale: `raven.knit` exists specifically to serve users without Quarto CLI installed. `quarto.quarto`'s `quarto render` requires Quarto CLI, so the two commands cover non-overlapping user populations.

**Updated description for `raven.rConsole.activation`**:

> Controls when Raven activates its R-language IDE surfaces: the R console, plot/data viewers, chunk run commands, and the `.Rmd` knit command. The default `auto` resolves to `disabled` when the REditorSupport (R) extension is enabled or VS Code is running as Positron, so Raven doesn't duplicate surfaces those provide. Code intelligence and the help viewer are unaffected by this setting. See https://github.com/jbearak/raven/blob/main/docs/coexistence.md.

The gate is enforced two ways:

1. Context key `raven.rmdKnit.enabled` set at activation time based on the resolved gate.
2. `when` clauses on command-palette entries and any editor-title contributions: `raven.rmdKnit.enabled && resourceExtname =~ /\\.(rmd|Rmd)/`.
3. `raven.knit` command handler **re-checks the gate** when invoked directly (not just through filtered UI), and surfaces a clear message if the gate is closed.

Re-evaluation on configuration change: prompts a window reload (matches Quarto's pattern for `quarto.path` changes; avoids fragile live re-registration).

## Install nags and walkthrough

Two one-time dismissible info messages plus a walkthrough. Persist dismissal in `globalState`.

### Nag triggers

| Trigger | Condition | Message body |
|---|---|---|
| `.qmd` opened | `quarto.quarto` not installed and not dismissed | "Raven does not handle `.qmd` files directly. Install `quarto.quarto` for `.qmd` grammar, LSP features, and live preview." |
| `.Rmd` opened | Neither `REditorSupport.r-syntax` nor `REditorSupport.r` installed, not dismissed | "Raven does not ship an R Markdown grammar. Install `REditorSupport.r-syntax` (or `REditorSupport.r`) for `.Rmd` grammar and embedded-language highlighting." |

Buttons: `[Install]` (executes `extension.open <id>`) and `[Don't show again]` (writes to `globalState`).

These nags **do not** promise raven preview/render features. They promise grammar/LSP from the recommended extension. That's the actual value proposition and avoids the contradiction Codex flagged.

### Walkthrough

`contributes.walkthroughs` adds "Get started with Raven for R Markdown":

1. **Install `quarto.quarto`** for `.qmd` and live preview support — links to marketplace.
2. **Install `REditorSupport.r-syntax`** (or the full `REditorSupport.r`) for `.Rmd` grammar — links to marketplace.
3. **Create a sample `.Rmd` and run Raven: Knit** — button: "Create sample.Rmd".

#### How step 3 materializes the sample

The `[Create sample.Rmd]` button invokes a `raven.walkthrough.createSampleRmd` command which:

1. Picks a target directory: the first workspace folder if one exists, otherwise `os.tmpdir()`.
2. Picks a filename: `raven-sample.Rmd`, or `raven-sample-2.Rmd`, ... if the name is taken.
3. Writes a minimal sample via `vscode.workspace.fs.writeFile(targetUri, content)` — using the FS API (not `fs.writeFileSync`) so the write routes through VS Code's remote-extension-host correctly for SSH / WSL / Codespaces / dev containers.
4. Opens the document with `vscode.window.showTextDocument(targetUri)`.
5. Surfaces an info toast "Sample created. Press the command palette and run **Raven: Knit**." (We intentionally don't auto-invoke knit; the user should see the file first and understand what they're knitting.)

This guarantees `raven.knit` runs against a real file-backed URI that the R subprocess can resolve — both locally and in remote-extension-host setups, because the file lives in the workspace's filesystem rather than in raven's extension-installation directory.

If no workspace is open and we fall back to `os.tmpdir()`, the sample uri uses the `file://` scheme on the **extension host** side. In a remote workspace with no folder open, this is the remote host's tmpdir, which is reachable by the R subprocess (also spawned on the remote host). In a local workspace with no folder open, it's the local tmpdir. Either way, the R subprocess sees a normal local path.

Sample content (~15 lines):

````rmarkdown
---
title: "Sample R Markdown"
output: html_document
---

# Hello from Raven

This is a tiny R Markdown document. Run **Raven: Knit** from the command
palette (Cmd/Ctrl+Shift+P) to render it.

```{r}
plot(1:10, main = "Example plot")
```
````

## Data flow

### Knit lifecycle (detailed)

```text
User: raven.knit on foo.Rmd
        │
        ▼
 [1] Gate check
   - context key raven.rmdKnit.enabled is true? If not, info: "Raven knit is disabled. See `raven.rConsole.activation`."
   - Workspace is trusted? If not, info: "Workspace is not trusted." with [Manage Workspace Trust] button.
   - Document is file-backed? Reject untitled / non-file URIs (scheme !== 'file' and scheme !== 'vscode-remote')
     with info: "Save the file to disk before running Raven: Knit." rmarkdown::render() requires a path
     on disk; we never attempt to materialize untitled buffers to a temp file silently — the user's
     "where did the output go?" expectation depends on the file having a known location.
        │
        ▼
 [2] Parse YAML front matter
   - js-yaml.load(frontmatterText, { schema: SAFE_SCHEMA })
   - On parse error: toast "YAML front matter is malformed; see Raven: Knit output" + open output channel with the parse error.
        │
        ▼
 [3] Detect deferred-feature blockers (yaml-frontmatter.detectBlockers)
   The detection is intentionally conservative — when in doubt, bail. Anything more permissive risks silent
   misbehavior on a feature this design doesn't implement.

   Bail conditions, each with [Copy command] button:

   - `knit:` field present (any non-null value):
       message: "This document specifies a custom knit hook. Raven doesn't honor custom hooks. Run
                the equivalent in the R console."
       copyable command: "rmarkdown::render('foo.Rmd')" or, if the knit: value is a recognizable R
                function call, the inferred call.

   - `runtime: shiny` or `server: shiny`:
       message: "Shiny documents aren't supported by Raven: Knit."
       copyable command: "rmarkdown::run('foo.Rmd')"

   - `site:` field present (rmarkdown::render_site / bookdown::bookdown_site):
       message: "Site projects aren't supported by Raven: Knit."
       copyable command: "rmarkdown::render_site()" or "bookdown::serve_book()" depending on site: value.

   - `params:` field present:
       message: NOT a blocker. Render proceeds with defaults defined in the YAML. Interactive params
                dialog is potential future work; users who want it pass `params = list(...)`
                programmatically.

   - `output:` with multiple top-level entries:
       NOT a blocker. We pick the first and proceed. Multi-format picker is potential future work;
       users who need it shell out to `quarto render foo.Rmd --to <fmt>`.
        │
        ▼
 [4] Format detection (yaml-frontmatter.detectFormat)
   - First key under `output:`, e.g. "html_document", "pdf_document", "word_document"
   - If `output:` is a single string value (legacy: `output: html_document`): use that string
   - If `output:` is absent: default to "html_document"
        │
        ▼
 [5] Resolve working directory (raven.knit.workingDirectory)
   The file-backed check in [1] guarantees docUri has a meaningful fsPath; we don't re-check here.
   - document (default): path.dirname(docUri.fsPath)
   - project:            workspace folder that contains docUri.fsPath. If the document is outside all
                         workspace folders, error: "Cannot resolve project root: document is outside the
                         workspace." If multi-root and the file is in exactly one folder, that folder
                         wins; if (somehow) in zero, the same error.
   - current:            do not pass knit_root_dir; R's working directory at subprocess start applies
                         (which is the workspace root, by VS Code convention)
        │
        ▼
 [6] Build R expression (r-expression.buildKnitExpression)
   - Inputs: filePath, format, knitRootDir
   - Output: a single R expression string passed to `R -e <expr>`
   - Pre-validation (validatePathForRExpression): EACH interpolated string passes through a strict
     check before escaping. Reject (throw, caught by [9] error handler with a clear toast) any input
     containing:
       • NUL byte (0x00) — un-representable in argv on every platform; in R, embedded NUL inside a
         string literal terminates the C string and produces a value that does NOT equal the original.
         This is an immediate refusal, not a sanitization.
       • Other ASCII control characters in the range 0x01–0x1F EXCEPT 0x09 (tab) — the rejected
         controls (CR, LF, FF, etc.) can mangle the R expression's diagnostic output and have no
         legitimate place in a filesystem path or format identifier. Tab is the one control we keep
         because some filesystems do permit it and it's harmless inside a single-quoted R string.
       • DEL (0x7F).
     Bidi-override / other non-printable Unicode characters are NOT pre-rejected; they are exotic but
     legitimate in some filesystems. They round-trip through escapeRString correctly.
   - Format identifier additionally validated: must match /^[A-Za-z0-9_:.-]+$/ (covers
     "html_document", "pdf_document", "bookdown::pdf_document2", "all", and "default"; rejects
     anything stranger). YAML provides this so the input is normally trustworthy; the regex is a
     defense-in-depth check.
   - escapeRString() (only runs after pre-validation passes):
       1. Validate input is a single non-empty string.
       2. Escape backslash → \\\\ and single-quote → \\'.
       3. Wrap in single quotes.
     Produces a literal R character vector of length one. Resulting expression:
       rmarkdown::render(input = 'foo.Rmd', output_format = 'html_document', knit_root_dir = '/path/to')
   - This is R-literal-injection prevention, not shell-injection (we use child_process.spawn with an
     argv array; no shell parses anything). The pre-validation step is what guards against the small
     set of inputs that escaping alone cannot make safe.
        │
        ▼
 [7] Spawn subprocess
   - argv: [resolveRBinary(), "--no-save", "--no-restore", "-e", expression]
   - options: { stdio: ['ignore', 'pipe', 'pipe'], detached: false, env: <inherit> }
   - resolveRBinary(): reuses raven's existing R-path resolution (raven.r.executablePath setting and
     PATH lookup). If R is missing: error toast "R not found on PATH. Set raven.r.executablePath."
        │
        ▼
 [8] Stream output
   - stdout → OutputChannel "Raven: Knit" (no transformation; raw R output)
   - stderr → same channel, prefixed [stderr]
   - Progress: ProgressLocation.Notification with title "Knitting foo.Rmd…"
   - Cancel button:
       1. child.kill('SIGINT')  (R's interrupt; lets rmarkdown clean up)
       2. After 5s if still alive: kill(-child.pid, 'SIGTERM') on macOS/Linux; taskkill /T /F /PID on Windows
       3. Toast: "Knit cancelled"
   - Timeout (raven.knit.timeoutMs, default 600000 = 10 min): same kill ladder, toast "Knit timed out"
        │
        ▼
 [9] Exit
   - Exit 0:
       parsed = parseRenderedOutputPath(stdout)
       parsed.paths.length === 1:  toast "Knit succeeded: <basename>" + [Open] button
       parsed.paths.length  >  1:  toast "Knit succeeded: <first>" + [Open] [Show All] buttons
                                   ([Show All] opens output channel scrolled to the output-paths block)
       parsed.paths.length === 0:  toast "Knit succeeded (output path unknown)" + [Show Output]
   - Exit ≠ 0:
       toast "Knit failed: see Raven: Knit output"
       focus output channel
```

### Output path parsing

**Best-effort parsing.** `rmarkdown::render` prints `Output created: <path>` on the R console at the end of a successful render. The exact line comes from `rmarkdown:::render_print` (see `rmarkdown/R/render.R` in the rmarkdown source tree). We match it with `/^\s*Output created:\s*(.+?)\s*$/m`.

Caveats we accept:

- The string is **not localized** in current rmarkdown (the source emits it as a literal English message via `message()`), but rmarkdown could localize in the future. If parsing fails, we still show "Knit succeeded (output path unknown)" — never a false-success or false-failure on the user's screen.
- `output_format = "all"` (or a multi-output knit hook) produces one `Output created:` line per format. We capture all matches; UI shows the first with `[Show All]` to surface the rest.
- Quiet modes (`quiet = TRUE`, or `--quiet` via R startup) may suppress the message. We treat a clean exit with no captured path as "succeeded, unknown path."
- The exit code from `rmarkdown::render` (which propagates from R) is the ground truth for success/failure. Output-path parsing is purely a UX nicety.

This implementation pins the regex with a fixture file (`tests/fixtures/rmarkdown-stdout/*.txt`) captured from real `rmarkdown::render` runs across the supported output formats (html_document, pdf_document, word_document, github_document). If rmarkdown changes the message in a future release, the fixture test catches it and we tighten the regex or accept the new format.

### Output reveal

```ts
function revealKnitOutput(outputPath: string): Thenable<void> {
  const uri = vscode.Uri.file(outputPath);
  const ext = path.extname(outputPath).toLowerCase();
  if (ext === '.html' || ext === '.htm') {
    // Opens in Simple Browser when in a remote workspace (SSH, WSL, Codespaces, dev containers).
    // Opens in the default browser when local.
    return vscode.commands.executeCommand('vscode.open', uri);
  }
  // PDFs, Word docs, etc.: reveal in OS file browser; user double-clicks to open.
  return vscode.commands.executeCommand('revealFileInOS', uri);
}
```

This avoids `vscode.env.openExternal(file://…)`, which doesn't behave correctly in remote workspaces.

### Workspace trust

`package.json` declares:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": "limited",
    "description": "Raven Knit executes R code from the workspace and is disabled in untrusted workspaces.",
    "restrictedConfigurations": ["raven.r.executablePath"]
  }
}
```

In untrusted workspaces:
- `raven.knit` surfaces an info message with `[Manage Workspace Trust]`.
- Install nags and walkthrough still work (they don't execute workspace code).

## Configuration

Only one amended setting and two new ones. No new activation gate.

| Setting | Type | Default | Description |
|---|---|---|---|
| `raven.rConsole.activation` | `auto`/`enabled`/`disabled` | `auto` | **Amended description** — now includes `.Rmd` knit. Defers to vscode-R / Positron. |
| `raven.knit.workingDirectory` | `document`/`project`/`current` | `document` | **NEW** — working directory for the R subprocess. Matches RStudio's Knit Directory submenu. |
| `raven.knit.timeoutMs` | number | `600000` | **NEW** — hard timeout for the knit subprocess (SIGKILL on expiry). |

Removed from the original issue body:

- `raven.chunks.knit.program` — superseded; we always run `rmarkdown::render` in R, never `quarto render`.
- `raven.chunks.preview.autoRefresh` — preview is out of scope.
- `raven.chunks.preview.viewerColumn` — preview is out of scope.

## Commands

| Command ID | Title | `when` |
|---|---|---|
| `raven.knit` | Raven: Knit | `raven.rmdKnit.enabled && resourceExtname =~ /\\.(rmd\|Rmd)/` |
| `raven.knit.openOutputChannel` | Raven: Show Knit Output | always |

No keybinding in this design; users invoke via command palette or context menu. RStudio's `Cmd+Shift+K` is not bound, both to keep scope tight and to avoid colliding with other extensions users might have configured.

## Error handling matrix

| Condition | Surface |
|---|---|
| Gate closed (`raven.rConsole.activation` resolves to disabled) | Info on command invocation: "Raven knit is disabled by your settings." |
| Workspace untrusted | Info: "Trust the workspace to enable" + `[Manage Workspace Trust]` |
| R missing on PATH | Toast: "R not found; set `raven.r.executablePath`" |
| YAML parse error | Toast: "YAML front matter is malformed" + focus output channel with the parse error |
| Custom YAML `knit:` field | Info: "Raven doesn't honor custom knit hooks" + `[Copy command]` |
| `runtime: shiny` / `server: shiny` | Info: "Shiny documents not supported" + `[Copy command]` |
| `site:` field present | Info: "Site projects not supported" + `[Copy command]` |
| Document is untitled / non-file URI | Info: "Save the file to disk before running Raven: Knit." |
| Path contains NUL or rejected control character | Toast: "File path contains an unsupported character" + focus output channel with details |
| Working dir `project` with file outside workspace folders | Toast: "Cannot resolve project root: document is outside the workspace" |
| Subprocess exits non-zero | Toast: "Knit failed" + focus output channel |
| Subprocess timeout | Toast: "Knit timed out" + focus output channel; kill subprocess |
| User cancels | SIGINT → SIGTERM 5s later → SIGKILL 5s after that; toast: "Knit cancelled" |
| Output path not detected | Toast: "Knit succeeded (output path unknown)" + `[Show Output]` |

## Testing approach

### Unit tests (bun)

- `yaml-frontmatter.test.ts` — parses standard YAML, detects `knit:`, `runtime`, `site`, `params`, multi-output; handles malformed YAML, BOMs, missing front matter.
- `output-path.test.ts` — extracts single, multiple, and zero output paths from rmarkdown stdout fixtures.
- `r-expression.test.ts` — covers `validatePathForRExpression` and `escapeRString`. **Rejection tests**: NUL bytes (0x00), CR/LF/FF/other 0x01–0x1F controls except tab, DEL (0x7F) — each rejected with a `ValidatePathError`. **Property test**: for inputs drawn from "safe" code-point range (printable Unicode + tab + bidi-override chars), `escapeRString` round-trips through R such that `parse(text = expr)` recovers the original string byte-for-byte. **Format-identifier tests**: accepts "html_document", "pdf_document", "bookdown::pdf_document2", "default", "all"; rejects backtick / quote / paren / semicolon variants.
- `gate-resolution.test.ts` — `raven.rConsole.activation` resolves correctly with each combination of sibling extensions.
- `nag-state.test.ts` — globalState persistence; "don't show again" doesn't re-fire.

### Integration tests (vscode-test)

- Open a `.Rmd` fixture, invoke `raven.knit`, assert output `.html` appears next to the source and a toast is shown.
- Open a `.Rmd` with `runtime: shiny`, invoke `raven.knit`, assert info message + `[Copy command]` button presence (no subprocess spawned).
- Open a `.qmd`, assert `quarto.quarto` install nag appears (when nag is enabled and quarto.quarto absent).
- Toggle `raven.rConsole.activation` between `auto`/`enabled`/`disabled`, assert command availability matches.

Integration tests requiring R installed are gated on a `RAVEN_TEST_R` env var; CI sets it appropriately.

### Manual smoke (post-merge)

Documented in `docs/development.md`:

- Knit a simple `.Rmd` on macOS / Linux / Windows.
- Knit in a remote workspace (Codespaces): verify Simple Browser fallback opens the HTML.
- Knit in an untrusted workspace: verify trust message.
- Cancel a long-running knit: verify SIGINT then SIGKILL.

## Potential future work (not tracked)

These features are recorded for institutional memory but are **not** tracked in a separate GitHub issue. If demand emerges for any one of them, file a focused issue at that time. Most are largely covered by `quarto.quarto` when the user has Quarto CLI installed; this list represents the small surface area where `quarto.quarto` does not cover the workflow.

| Feature | Why it's deferred / dropped |
|---|---|
| RStudio-style Knit dropdown (HTML / PDF / Word picker) | `quarto render foo.Rmd --to <fmt>` covers this for users with Quarto CLI. Building our own dropdown adds little. |
| Custom YAML `knit:` hook dispatch (bookdown / xaringan / pkgdown) | Only genuinely uncovered item. bookdown / xaringan / pkgdown users currently invoke `bookdown::serve_book()` etc. in the R console directly. A "Knit button" honoring the YAML `knit:` field would be a workflow nicety, not a blocker. File a focused issue if a user asks. |
| Knit-with-Parameters dialog (`params: "ask"`) | Users can edit YAML defaults and re-knit, or pass `params = list(...)` programmatically. Niche UI feature. |
| `runtime: shiny` / `rmarkdown::run` | Legacy rmarkdown Shiny; superseded by Quarto's `server: shiny`. Declining usage. |
| `rmarkdown::render_site` / `site:` field | Superseded by Quarto Websites. Near-zero new usage in 2026. |
| `raven.knit.useActiveRConsole` opt-in setting | Trades subprocess isolation for cold-start cost; helps users with slow-loading packages. Small implementation if anyone asks. |

If implemented later, all of these can plug into this design's existing seams: `yaml-frontmatter.parseFrontmatter`, `r-expression.escapeRString`, `output-path.parseRenderedOutputPath`, and new `KnitEngine` implementations alongside `RmarkdownRenderEngine`. No invasive changes to this design's hot paths required.

## References

- Issue #226: https://github.com/jbearak/raven/issues/226
- Issue #209 / PR #225 (Phases 1–3): https://github.com/jbearak/raven/pull/225
- `REditorSupport/vscode-R` R Markdown subsystem: https://github.com/REditorSupport/vscode-R/tree/master/src/rmarkdown
- `quarto-dev/quarto` VS Code extension (reference for what raven defers to): https://github.com/quarto-dev/quarto/tree/main/apps/vscode
- Positron R Markdown task (similar minimal scope): https://github.com/posit-dev/positron/blob/main/extensions/positron-r/src/tasks.ts
- Raven coexistence docs: https://github.com/jbearak/raven/blob/main/docs/coexistence.md
- Raven AGENTS.md / CLAUDE.md (R subprocess safety): https://github.com/jbearak/raven/blob/main/CLAUDE.md
- Two rounds of Codex adversarial review (this session, 2026-05-16)

## Open questions

1. **Editor-title button vs. command-palette-only** — RStudio puts Knit in the editor title bar. Should raven? Modest discoverability win; deferable to a follow-up. Current spec: command palette only.
2. **`raven.r.executablePath`** — already exists in raven for the R console. Reusing it for the knit subprocess is the natural choice and assumed throughout this spec.
