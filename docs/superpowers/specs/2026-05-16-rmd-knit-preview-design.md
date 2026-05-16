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
3. Refuse `.Rmd` files that need Tier-2 features (`runtime: shiny`, custom YAML `knit:` hook) with a copy-paste command the user can run manually.
4. Nudge users toward `quarto.quarto` for preview and toward `REditorSupport.r-syntax` (or `REditorSupport.r`) for `.Rmd` grammar, via one-time install info messages and a walkthrough.
5. Avoid duplicating UI surfaces that sibling extensions already provide.

## Non-goals

The following are explicitly out of scope. They belong to `quarto.quarto`, vscode-R, or a future Tier 2 raven feature:

| Capability | Where it lives instead |
|---|---|
| Live preview of `.qmd` or `.Rmd` | `quarto.quarto`'s `Quarto: Preview` command |
| `.qmd` rendering | `quarto.quarto`'s `Quarto: Render` command |
| `.qmd` syntax / grammar / LSP | `quarto.quarto` |
| `.Rmd` syntax / grammar | `REditorSupport.r-syntax` or `REditorSupport.r` |
| `.Rmd` knit dropdown (Knit to HTML / PDF / Word picker) | Tier 2 |
| Custom YAML `knit:` hook dispatch (bookdown / xaringan / pkgdown) | Tier 2 |
| Knit-with-Parameters dialog | Tier 2 |
| `runtime: shiny` / `server: shiny` documents | Tier 2 (raven Tier 1 detects and refuses with copyable command) |
| `rmarkdown::render_site` | Tier 2 |
| Knit in raven's active R console (vs. fresh subprocess) | Tier 2, opt-in setting |

## Architecture

A single command. No webview, no HTTP, no token scraping.

```text
User: raven.knit on foo.Rmd
        │
        ▼
 [1] Workspace trust check
 [2] YAML front matter parse + Tier-2-blocker detection
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

Trade-off: users with slow-loading packages pay cold-start cost on every knit. Tier 2 adds an opt-in `raven.knit.useActiveRConsole` for that case.

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
3. **Try Raven: Knit** — opens a sample `.Rmd` from raven's assets and invokes `raven.knit`. (The walkthrough sample is a `.Rmd`, not a `.qmd`, so step 3 cannot route the user into a deferral.)

## Data flow

### Knit lifecycle (detailed)

```text
User: raven.knit on foo.Rmd
        │
        ▼
 [1] Gate check
   - context key raven.rmdKnit.enabled is true? If not, info: "Raven knit is disabled. See `raven.rConsole.activation`."
   - Workspace is trusted? If not, info: "Workspace is not trusted." with [Manage Workspace Trust] button.
        │
        ▼
 [2] Parse YAML front matter
   - js-yaml.load(frontmatterText, { schema: SAFE_SCHEMA })
   - On parse error: toast "YAML front matter is malformed; see Raven: Knit output" + open output channel with the parse error.
        │
        ▼
 [3] Detect Tier-2 blockers (yaml-frontmatter.detectTier2Blockers)
   The detection is intentionally permissive — when in doubt, bail. Anything more permissive risks silent
   misbehavior on a feature we don't yet implement.

   Bail conditions, each with [Copy command] and [Learn more] buttons:

   - `knit:` field present (any non-null value):
       message: "This document specifies a custom knit hook. Raven Tier 1 doesn't honor custom hooks. Run
                the equivalent in the R console."
       copyable command: "rmarkdown::render('foo.Rmd')" or, if the knit: value is a recognizable R
                function call, the inferred call.

   - `runtime: shiny` or `server: shiny`:
       message: "Shiny documents aren't supported in Raven Tier 1."
       copyable command: "rmarkdown::run('foo.Rmd')"

   - `site:` field present (rmarkdown::render_site / bookdown::bookdown_site):
       message: "Site projects aren't supported in Raven Tier 1."
       copyable command: "rmarkdown::render_site()" or "bookdown::serve_book()" depending on site: value.

   - `params:` field present:
       message: NOT a blocker. Render proceeds with defaults defined in the YAML. If the user wants
                the interactive params dialog, that's Tier 2.

   - `output:` with multiple top-level entries:
       NOT a blocker. We pick the first and proceed; multi-format Knit dropdown is Tier 2.
        │
        ▼
 [4] Format detection (yaml-frontmatter.detectFormat)
   - First key under `output:`, e.g. "html_document", "pdf_document", "word_document"
   - If `output:` is a single string value (legacy: `output: html_document`): use that string
   - If `output:` is absent: default to "html_document"
        │
        ▼
 [5] Resolve working directory (raven.knit.workingDirectory)
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
   - String safety: each interpolated path goes through escapeRString() which:
       1. Validates the input is a single string (no array-like values).
       2. Escapes backslash → \\\\ and single-quote → \\'.
       3. Wraps in single quotes.
     This produces a literal R character vector with one element. Resulting expression:
       rmarkdown::render(input = 'foo.Rmd', output_format = 'html_document', knit_root_dir = '/path/to')
   - This is R-literal-injection prevention, not shell-injection (we use child_process.spawn with an
     argv array; no shell parses anything).
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

`rmarkdown::render` prints `Output created: <path>` on success. Regex: `/^\s*Output created:\s*(.+?)\s*$/m`. Multiple matches are possible if a single `rmarkdown::render` call produces multiple outputs (rare in practice, but `output_format = "all"` triggers it). We return all matches; UI handles 0 / 1 / >1.

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

No keybindings in Tier 1; users invoke via command palette or context menu. RStudio's `Cmd+Shift+K` is not bound, both to keep scope tight and to avoid colliding with other extensions users might have configured.

## Error handling matrix

| Condition | Surface |
|---|---|
| Gate closed (`raven.rConsole.activation` resolves to disabled) | Info on command invocation: "Raven knit is disabled by your settings." |
| Workspace untrusted | Info: "Trust the workspace to enable" + `[Manage Workspace Trust]` |
| R missing on PATH | Toast: "R not found; set `raven.r.executablePath`" |
| YAML parse error | Toast: "YAML front matter is malformed" + focus output channel with the parse error |
| Custom YAML `knit:` field | Info: "Tier 1 doesn't honor custom hooks" + `[Copy command]` |
| `runtime: shiny` / `server: shiny` | Info: "Shiny documents not supported in Tier 1" + `[Copy command]` |
| `site:` field present | Info: "Site projects not supported in Tier 1" + `[Copy command]` |
| Working dir `project` with file outside workspace folders | Toast: "Cannot resolve project root: document is outside the workspace" |
| Subprocess exits non-zero | Toast: "Knit failed" + focus output channel |
| Subprocess timeout | Toast: "Knit timed out" + focus output channel; kill subprocess |
| User cancels | SIGINT → SIGTERM 5s later → SIGKILL 5s after that; toast: "Knit cancelled" |
| Output path not detected | Toast: "Knit succeeded (output path unknown)" + `[Show Output]` |

## Testing approach

### Unit tests (bun)

- `yaml-frontmatter.test.ts` — parses standard YAML, detects `knit:`, `runtime`, `site`, `params`, multi-output; handles malformed YAML, BOMs, missing front matter.
- `output-path.test.ts` — extracts single, multiple, and zero output paths from rmarkdown stdout fixtures.
- `r-expression.test.ts` — escapes single quotes, backslashes, embedded `${}` (R doesn't interpolate, but verify no shell interaction). Properties: round-trips arbitrary paths; never produces shell-active characters at command-argv level.
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

## Out of scope — Tier 2 issue body (preview)

Title: **R Markdown Tier 2 — advanced knit features**

Scope:

- RStudio-style Knit dropdown (Knit to HTML / PDF / Word picker; multi-format from YAML).
- Custom YAML `knit:` hook dispatch (bookdown::render_book, xaringan::inf_mr, pkgdown).
- Knit-with-Parameters dialog (`params: "ask"` flow).
- `runtime: shiny` / `server: shiny` interactive document handling via `rmarkdown::run`.
- `rmarkdown::render_site` and `site:` YAML field.
- `raven.knit.useActiveRConsole` opt-in setting (knit in raven's R terminal for users with slow-loading packages).

Tier 2 implementation reuses Tier 1's `yaml-frontmatter.parseFrontmatter`, `r-expression.escapeRString`, and `output-path.parseRenderedOutputPath`. The Knit-dropdown picker reads from the same YAML structure Tier 1 already parses. New `KnitEngine` implementations (e.g., `CustomKnitHookEngine`, `ShinyRuntimeEngine`) plug in alongside Tier 1's `RmarkdownRenderEngine`. None of Tier 2's additions require modifying Tier 1's hot paths.

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

1. **Walkthrough sample `.Rmd` content** — what should the sample document contain? Probably the simplest possible (one chunk, one heading, one paragraph). Addressed during implementation.
2. **Editor-title button vs. command-palette-only** — RStudio puts Knit in the editor title bar. Should raven? Modest discoverability win; deferable to a follow-up. Current spec: command palette only.
3. **`raven.r.executablePath`** — already exists in raven for the R console. Reusing it for the knit subprocess is the natural choice and assumed throughout this spec.
