# R Markdown / Quarto Knit + Live Preview — Design

**Issue**: [#226](https://github.com/jbearak/raven/issues/226) — replaces the original underspecified body.
**Status**: Design.
**Authors**: jbearak, with Codex adversarial review (2026-05-16).
**Supersedes**: deferred Phase 4 of [#209](https://github.com/jbearak/raven/issues/209) / [PR #225](https://github.com/jbearak/raven/pull/225).

## Overview

Add knit + live-preview surfaces to raven for `.qmd` and `.Rmd` files. Live preview delegates to the Quarto CLI's preview server and iframes it into a VS Code webview; knit runs `rmarkdown::render` (for `.Rmd`) or `quarto render` (for `.qmd`) in a fresh subprocess and reveals the rendered output. Coexistence with `REditorSupport.r` (vscode-R) and `quarto.quarto` is governed by per-file-type activation gates with `auto` defaults.

This design splits issue #226 into two work items:

- **Tier 1** (this design): the daily-driver surface — `quarto preview` iframe for live preview, fresh-subprocess knit, install nags for sibling extensions, workspace-trust gate.
- **Tier 2** (deferred to a new issue): RStudio-style Knit dropdown, custom YAML `knit:` hook (bookdown / xaringan / pkgdown), Knit-with-Parameters dialog, `runtime: shiny` / `rmarkdown::run`, `rmarkdown::render_site`, render-and-rewrite fallback webview for `.Rmd` workflows the Quarto knitr engine cannot drive.

## Goals

1. Provide a working `Raven: Preview` command for `.qmd` and `.Rmd` that opens an embedded, live-reloading preview pane.
2. Provide a working `Raven: Knit` command for `.qmd` and `.Rmd` that produces a rendered output file and reveals it.
3. Avoid duplicating UI surfaces that vscode-R or `quarto.quarto` already provide. Defer to them via `auto`-resolving activation gates.
4. Fail loudly and informatively when prerequisites (Quarto CLI, R, workspace trust) are missing.
5. Set up Tier 1's internal interfaces so Tier 2 plugs in without rewriting Tier 1.

## Non-goals

1. **`.Rmd` live preview without Quarto CLI.** A user on `.Rmd`-only workflows without Quarto installed gets the knit command, not embedded live preview.
2. **Custom YAML `knit:` hook dispatch** (bookdown, xaringan, pkgdown). Deferred to Tier 2.
3. **`runtime: shiny` / `server: shiny` interactive document execution.** Deferred to Tier 2; Tier 1 detects these and surfaces an info message pointing users at the R console.
4. **Multi-format Knit dropdown** (Knit to HTML / PDF / Word picker). Deferred to Tier 2.
5. **Knit-with-Parameters dialog.** Deferred to Tier 2.
6. **Owning a render-and-rewrite webview** for HTML preview (vscode-R-style asset rewriting via `asWebviewUri`). Deferred to Tier 2; revisit only if Tier 1 user feedback indicates demand from `.Rmd`-without-Quarto users.

## Architecture decisions

### A1. Live preview backend = `quarto preview` + iframe

**Decision**: spawn `quarto preview <file> --no-browser --no-watch-inputs` as a managed child process. Open a `WebviewPanel` containing a sandboxed `<iframe>` whose `src` is Quarto's localhost URL. Quarto's preview server handles HTML rendering, asset serving, file-watching (when configured), and WebSocket live-reload.

**Why**:

- The official `quarto.quarto` VS Code extension uses this pattern; the architecture is validated.
- Same-origin iframe ⇒ no `asWebviewUri` asset rewriting, no CSP gymnastics for rendered content.
- Live reload comes free from Quarto's WebSocket; raven doesn't implement reload logic.
- Quarto's knitr engine handles `.Rmd` natively (`quarto preview foo.Rmd` works), so one code path serves both file types.

**Rejected alternatives**:

- **Render-and-rewrite (vscode-R model)**: render to a temp HTML file via `rmarkdown::render`, load in webview with regex-based asset rewriting and `localResourceRoots`, fs-watch the source for re-render. ~3× the spec size; raven owns asset rewriting, CSP, theme injection, reload protocol forever. Forces a parallel pipeline for `.qmd`.
- **Raven-owned HTTP server + WebSocket reload**: spin up a local server for rendered HTML, point a same-origin iframe at it, implement file-watching and WebSocket reload ourselves. Largest scope; we maintain server + reload protocol indefinitely.
- **No embedded preview, knit-and-open-in-browser only**: matches Positron's pure-rmarkdown story. Functional but closes #226 without an in-IDE preview pane.

The Quarto extension itself made the same call. We accept the same trade-off: hard dependency on the CLI, in exchange for not maintaining a parallel rendering subsystem.

### A2. Knit backend = fresh subprocess (R or quarto), never raven's R terminal

**Decision**: `raven.knit` spawns a fresh `R --no-save --no-restore -e "rmarkdown::render(...)"` subprocess for `.Rmd` and a `quarto render <file>` subprocess for `.qmd`. Output streams to a dedicated `Raven: Knit` output channel. The user's interactive R session in raven's R console is untouched.

**Why**:

- Matches vscode-R's default mode (`r.rmarkdown.knit.useBackgroundProcess: true`) and Positron's task-based approach.
- No state pollution: the user's loaded packages, working directory, options remain unchanged.
- Easy cancellation via `subprocess.kill('SIGINT')`.
- Doesn't require raven's R console to be active — knit works as a standalone capability whenever R is on `PATH`.

**Trade-off** (acknowledged): for users with slow-loading packages (Bioconductor, tidymodels), every knit pays the cold-start cost. Tier 2 can add an opt-in `raven.knit.useActiveRConsole` setting; not in Tier 1 to keep scope tight.

### A3. Subprocess execution = `child_process.spawn`, not `vscode.window.createTerminal`

**Decision**: both the live-preview `quarto preview` process and the knit subprocess use `child_process.spawn` with output piped to a dedicated `OutputChannel`. No hidden terminals.

**Why**:

- Known PID + process group ⇒ we can `kill(-pid, 'SIGTERM')` for the whole tree on macOS/Linux and `taskkill /T /F /PID` on Windows. Hidden terminals only send SIGHUP to the shell; daemon-style children can survive.
- Avoids polluting the user's terminal list (even hidden terminals are revealable and clutter the picker).
- We can attach our own stdout parser deterministically (no PTY ANSI noise to filter).
- Symmetric with how raven already spawns R for subprocess work (`r_subprocess.rs` patterns in the LSP).

**Cost**: we don't get PTY-quality output rendering in the channel. Acceptable for knit/preview, which are not interactive REPLs.

### A4. Tier 1 scope is bounded; Tier 1 interfaces are designed for Tier 2 extension

**Decision**: Tier 1 implements `KnitEngine` and `FormatDetector` as named interfaces. Tier 2 implementations (custom-knit-hook engine, multi-format picker, params dialog) extend or wrap these without modifying Tier 1 code.

```ts
interface KnitEngine {
  canHandle(doc: TextDocument, yaml: ParsedYaml): boolean;
  run(opts: KnitRunOptions): Promise<KnitResult>;
}
// Tier 1 ships: RmarkdownRenderEngine, QuartoRenderEngine
// Tier 2 adds:  CustomKnitHookEngine, ShinyRuntimeEngine, RenderSiteEngine
```

This addresses Codex's "structural coupling" concern: Tier 2 adds new `KnitEngine` implementations rather than editing Tier 1's two.

## Components

```text
editors/vscode/src/
  preview/
    index.ts              # activation, command registration, gating evaluation
    quarto-detection.ts   # findQuartoCli(): PATH + known dirs + RStudio.app + Positron bundle; cached per session
    quarto-version.ts     # version compatibility check (refuse <1.4, warn ≥2.0 until verified)
    install-nag.ts        # one-time install prompts for quarto.quarto, REditorSupport.r-syntax
    preview-server.ts     # spawn/kill `quarto preview` child process; stdout URL scraping; render-token POST
    preview-webview.ts    # WebviewPanel + sandboxed iframe + chrome (refresh/zoom/open-external)
    preview-manager.ts    # one-server-per-doc lifecycle, reuse predicate, save-triggered render coalescing
    commands.ts           # raven.preview, raven.previewToSide
  knit/
    index.ts              # activation + command registration
    knit-commands.ts      # raven.knit
    knit-engine.ts        # KnitEngine interface + RmarkdownRenderEngine + QuartoRenderEngine
    yaml-frontmatter.ts   # parseFrontmatter() using js-yaml; detectFormat(); detectKnitHook(); detectRuntime()
    output-path.ts        # parseRenderedOutputPath() from rmarkdown/quarto stdout
```

`quarto-detection.ts` is imported by `knit/` for the `.qmd` path; it's the only inter-module dependency. Otherwise `preview/` and `knit/` share no runtime state.

## Coexistence and gating

### Principle

Raven registers a UI surface only when no sibling extension is already providing it for that file type.

### Settings

| Setting | Type | Default | Scope |
|---|---|---|---|
| `raven.rConsole.activation` | `auto` \| `enabled` \| `disabled` | `auto` | R console + chunks + **Rmd knit/preview** (existing setting, scope expanded) |
| `raven.preview.activation` | `auto` \| `enabled` \| `disabled` | `auto` | **NEW** — `.qmd` knit/preview only |

**Updated description for `raven.rConsole.activation`**:

> Controls when Raven activates its R-language IDE surfaces: the R console, plot/data viewers, chunk run commands, and `.Rmd` knit + live preview. The default `auto` resolves to `disabled` when the REditorSupport (R) extension is enabled or VS Code is running as Positron, so Raven doesn't duplicate surfaces those provide. Code intelligence, help viewer, and `.qmd` knit/preview are unaffected by this setting (see `raven.preview.activation`). See https://github.com/jbearak/raven/blob/main/docs/coexistence.md.

**Per-surface `auto` resolution** within `raven.rConsole.activation` is heterogeneous because the overlapping siblings differ by surface:

| Surface | `auto` defers when |
|---|---|
| R console, plot viewer, data viewer | vscode-R installed OR running in Positron |
| Chunks (run commands, navigation, highlighting) | vscode-R installed OR running in Positron |
| `.Rmd` knit + preview | vscode-R installed OR running in Positron OR `quarto.quarto` installed |

The `.Rmd` knit/preview row includes `quarto.quarto` because the Quarto VS Code extension claims `.rmd` in its `languages` and `workspaceContains` activation events, and `quarto preview foo.Rmd` works via the knitr engine. We avoid the user seeing two preview commands ("Raven: Preview" and "Quarto: Preview") on the same `.Rmd` file. Document this in `docs/coexistence.md` as a non-obvious wrinkle.

**Description for `raven.preview.activation`**:

> Controls when Raven activates `.qmd` knit and live-preview surfaces. The default `auto` resolves to `disabled` when the `quarto.quarto` extension is installed (regardless of activation state), so Raven doesn't duplicate Quarto's preview/render commands. Has no effect on `.Rmd` files (see `raven.rConsole.activation`).

### Resolved gates per surface

| Command | File type | Resolved by | `auto` defers when |
|---|---|---|---|
| `raven.knit`, `raven.preview` | `.Rmd` | `raven.rConsole.activation` (`.Rmd` row in the heterogeneous table above) | vscode-R OR Positron OR `quarto.quarto` |
| `raven.knit`, `raven.preview` | `.qmd` | `raven.preview.activation` | `quarto.quarto` |

### `auto` predicate

```ts
function isQuartoQuartoInstalled(): boolean {
  return vscode.extensions.getExtension('quarto.quarto') !== undefined;
}
function isVscodeRorPositronActive(): boolean {
  // existing helper used by chunks; reused unchanged
}
```

We check **installed**, not **active**: VS Code activates extensions lazily, and the user's choice to install `quarto.quarto` signals "I want Quarto to own `.qmd` features." If they want raven to win instead, they set `raven.preview.activation: enabled` explicitly.

### Re-evaluation on config change

Changing `raven.rConsole.activation` or `raven.preview.activation` prompts a window reload (matching `quarto.quarto`'s pattern for `quarto.path`). We do not attempt live re-registration of commands and menus — too error-prone, and reload is cheap.

### Command/menu registration with `when` clauses

Commands are registered unconditionally at activation. Visibility and runnability are governed by context keys set during gate evaluation:

- `raven.rmdSurfaces.enabled` — true if `.Rmd` surfaces are active for raven
- `raven.qmdSurfaces.enabled` — true if `.qmd` surfaces are active for raven

Editor-title buttons, command-palette filters, and keybindings use `when` clauses like `raven.rmdSurfaces.enabled && resourceExtname =~ /\\.(rmd|Rmd)/`. When raven defers, the commands are still registered but disabled and hidden.

### Telemetry / logging

When raven defers due to a sibling extension's presence, log once to raven's output channel at activation time: `[raven] Preview/knit for .qmd is deferred to quarto.quarto. Set raven.preview.activation to "enabled" to override.` No toast. This satisfies the discoverability concern without nagging.

## Install nags and walkthrough

The nags advertise **grammar and language-server features**, not preview/render, to avoid the contradiction Codex flagged (installing `quarto.quarto` causes raven to defer preview, so promising preview in the nag is misleading).

### Trigger conditions

- `.qmd` opened and `quarto.quarto` is not installed → one-time info message.
- `.Rmd` opened and neither `REditorSupport.r-syntax` nor `REditorSupport.r` is installed → one-time info message.

Dismissal persists in `globalState`. Keys: `raven.installNag.quartoExtension.dismissed`, `raven.installNag.rSyntax.dismissed`.

### Nag wording

```text
Title: "Install the Quarto extension"
Detail: "Raven does not ship Quarto syntax highlighting. Install quarto.quarto
         to get .qmd grammar, language-server features, and the Quarto VS Code
         tools."
Buttons: [Install] [Don't show again]
```

```text
Title: "Install R-syntax for R Markdown"
Detail: "Raven does not ship an R Markdown grammar. Install REditorSupport.r-syntax
         (or REditorSupport.r) to get .Rmd grammar and embedded-language
         highlighting."
Buttons: [Install] [Don't show again]
```

The `[Install]` button executes `vscode.commands.executeCommand('extension.open', '<id>')`, which opens the extension page where the user can click Install.

### Walkthrough

`contributes.walkthroughs` adds a "Get started with Raven for R Markdown / Quarto" walkthrough surfaced on first install and via the command palette. Steps:

1. **Install the Quarto CLI** — links to `https://quarto.org/docs/get-started/`, with a "Verify Installation" button that calls `raven.preview.verifyQuartoCli`.
2. **Install grammar extensions** — links to `quarto.quarto` and `REditorSupport.r-syntax` marketplace pages.
3. **Try a preview** — opens a sample `.qmd` and invokes `raven.preview`.

The walkthrough does not block the nags; users find the walkthrough less often than they hit "open a `.Rmd`," so both surfaces exist.

## Data flow

### Preview lifecycle

```text
User: raven.preview on foo.qmd (or foo.Rmd)
        │
        ▼
 [1] Workspace trust check
   ├─ Untrusted ─► refuse with info message + [Manage Workspace Trust] button
   └─ Trusted ─► continue
        │
        ▼
 [2] quarto-detection.findQuartoCli()
   ├─ Cached result for this session ─► use it
   ├─ raven.preview.quartoPath setting ─► validate (exists, executable, runs --version) ─► cache, use
   ├─ PATH (`quarto --version`) ─► cache, use
   └─ Known dirs scan
       (Windows: %ProgramFiles%\Quarto\bin, %LOCALAPPDATA%\Programs\Quarto\bin, RStudio bundle
        macOS:   /Applications/quarto/bin, ~/Applications/quarto/bin, /Applications/RStudio.app/Contents/Resources/app/quarto/bin
        Linux:   /opt/quarto/bin, RStudio Server bundle paths)
       │
       ├─ Found ─► quarto --version
       │   ├─ Version <1.4 ─► refuse: "Raven requires Quarto 1.4 or later. Upgrade Quarto."
       │   ├─ Version ≥2.0 (unverified) ─► warn once: "Raven hasn't been verified against Quarto 2.x; report issues."
       │   └─ Else ─► cache, use
       └─ Not found ─► modal warning
            Title:  "Quarto installation not found"
            Detail: "Live preview requires the Quarto CLI."
            Buttons: [Install Quarto] [Use Knit instead] [Cancel]
              Install Quarto: vscode.env.openExternal('https://quarto.org/docs/get-started/')
              Use Knit:       run raven.knit on the active doc
              Cancel:         dismiss
        │
        ▼
 [3] preview-manager.openPreview(docUri)
   ├─ Frontmatter pre-flight: parse YAML; if runtime: shiny / server: shiny detected:
   │     info message: "Shiny documents are not supported in Tier 1. Run rmarkdown::run('<file>')
   │                    in the R console instead."
   │     button: [Copy command] ─► writes the command to clipboard
   │     bail.
   ├─ Reusable preview exists? (predicate: same docUri AND same workspaceFolder AND same resolved cwd AND
   │     same detected quartoPath AND child process alive AND webview not disposed AND yaml does not
   │     declare runtime/server: shiny)
   │     ├─ Yes ─► focus webview; trigger save-render path; done
   │     └─ No  ─► if a stale preview exists for the same docUri, terminate it first, then continue
        │
        ▼
 [4] Spawn `quarto preview <file> --no-browser --no-watch-inputs`
   - cwd: resolved per raven.preview.workingDirectory (document | project | current; default document)
   - child_process.spawn, NOT createTerminal
   - stdout/stderr piped to OutputChannel 'Raven: Preview'
   - Progress notification: "Starting Quarto preview…" with Cancel button
        │
        ▼
 [5] URL capture (timeout default 60s, configurable: raven.preview.startupTimeoutMs)
   - The Quarto preview server prints a localhost URL on startup; that URL serves both the rendered HTML
     (what the iframe loads) AND the render-token / terminate-token control endpoints. One URL, two uses.
   - Capture: parse stdout against
       primary:   /(http:\/\/(?:localhost|127\.0\.0\.1):\d+\/?[^\s]*)/
       fallback:  /(?:Browse at|Listening on)\s+(https?:\/\/[^\n\s]*)/
     First match on either pattern wins. (The fallback exists because Quarto's "Browse at" line may
     prepend ANSI or the trailing slash that throws off the primary regex.)
   - If process exits before capture: focus output channel; toast "Quarto preview failed to start — see Raven: Preview".
   - If timeout: kill process tree, focus output channel, toast same.

   Implementation note: render-token and terminate-token strings are constants in the
   quarto-vscode source (apps/vscode/src/providers/preview/preview.ts). Read them from there during
   implementation rather than re-deriving. They are stable within a Quarto-minor-version range; the
   quarto-version compatibility check in [2] is what protects against drift.
        │ (URL captured)
        ▼
 [6] Open WebviewPanel ('raven.preview', column = raven.preview.viewerColumn)
   - localResourceRoots: only raven's own asset dirs (no rendered content paths needed; iframe is same-origin to localhost)
   - Outer CSP: script-src ${webview.cspSource}; nothing else
   - iframe sandbox: allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-downloads
   - iframe.src = captured URL
   - Chrome: Refresh / Open in External Browser / Zoom + / Zoom −
        │
        ▼
 [7] Wire listeners
   - workspace.onDidSaveTextDocument(uri === docUri) ─► see save-triggered render below
   - webviewPanel.onDidDispose ─► preview-manager.terminate(docUri)
   - child.on('exit') ─► webviewPanel.dispose() if still alive
```

### Save-triggered render

```text
onDidSaveTextDocument(doc)
   ├─ doc.uri !== boundDocUri? ─► ignore
   ├─ raven.preview.renderOnSave === false? ─► ignore
   ├─ URL not yet captured? ─► queue one pending render; trigger after capture
   ├─ Render currently in flight? ─► set pending-render flag; the in-flight render's completion handler triggers exactly one follow-up
   └─ Otherwise:
        debounce 300ms (trailing edge)
        ├─ axios.get(controlUrl + '/' + renderToken) — GET, not POST
        ├─ on response 2xx ─► Quarto re-renders and pushes WebSocket reload to iframe (no raven involvement)
        ├─ on response 4xx/5xx or network error ─► log to output channel; no toast (preview server lifecycle independent of save success)
        └─ clear pending-render flag; if pending-render was set during this render, trigger one more
```

Saves arriving on dependency files (sourced `.R` files etc.) are **not tracked** in Tier 1. The `--no-watch-inputs` flag explicitly disables Quarto's own file-watching to keep raven the sole render trigger; if users need dependency tracking they can re-save the parent doc.

### Render-token protocol (stability note)

The `controlUrl + '/' + renderToken` request is an undocumented Quarto CLI protocol cribbed from `quarto-dev/quarto:apps/vscode/src/providers/preview/preview.ts`. It is the same protocol the official extension uses. Raven pins compatibility to Quarto 1.4–1.x; if Quarto changes the protocol in 2.x we surface a clear error and prompt the user to update raven. We do not attempt to wrap this in a stable API.

### Process cleanup

```text
preview-manager.terminate(docUri):
   1. axios.get(controlUrl + '/' + terminateToken)  (graceful)
   2. After 2s: child.kill('SIGTERM') on the process group (macOS/Linux: kill(-pid, 'SIGTERM'); Windows: taskkill /T /PID)
   3. After 5s more: child.kill('SIGKILL') / taskkill /T /F /PID
   4. Dispose WebviewPanel; clear from active-preview map
```

### Knit lifecycle

```text
User: raven.knit on foo.Rmd (or foo.qmd)
        │
        ▼
 [1] Workspace trust check (same as preview)
        │
        ▼
 [2] yaml-frontmatter.parseFrontmatter(doc.getText())
   - js-yaml load with safe schema
   - returns: { output?, format?, knit?, runtime?, params? } or null on parse error
   - On parse error: toast "YAML front matter is malformed; cannot determine output format" + show output channel
        │
        ▼
 [3] yaml-frontmatter.detectBlockingFeatures(yaml)
   ├─ knit: field present (string starting with a function reference) ─► info message:
   │     "This document uses a custom knit: hook. Raven Tier 1 does not honor custom hooks;
   │      run <hook>('<file>') in the R console instead."
   │     button: [Copy command] [Open Tier 2 issue]
   │     bail.
   ├─ runtime: shiny / server: shiny ─► info message: see preview-pre-flight section
   │     bail.
   └─ params: present ─► proceed without dialog; render uses YAML-defined defaults
        │
        ▼
 [4] knit-engine.pickEngine(doc.languageId, yaml)
   ├─ rmd  → RmarkdownRenderEngine (requires R on PATH; if missing, error: "R not found on PATH; install R or set raven.r.executablePath")
   ├─ qmd, quarto CLI available → QuartoRenderEngine
   └─ qmd, quarto CLI missing   → modal warning identical to the preview-path missing-CLI dialog; [Install Quarto] / [Cancel].
                                   We do NOT fall back to rmarkdown::render on .qmd: rmarkdown does not understand all Quarto YAML
                                   (e.g. format: revealjs, engine: jupyter), and a silent partial render is worse than refusal.
        │
        ▼
 [5] yaml-frontmatter.detectFormat(yaml, engine.defaultFormat)
   - Rmd: first key under output:  (e.g. "html_document")
   - qmd: first key under format:  (e.g. "html")
   - Neither: engine's default
        │
        ▼
 [6] Resolve working directory: raven.knit.workingDirectory
   - document (default): path.dirname(docUri.fsPath)
   - project:            workspaceFolder of doc, error if multi-root ambiguity
   - current:            R/quarto's inherited cwd (don't pass knit_root_dir)
        │
        ▼
 [7] Spawn subprocess
   - RmarkdownRenderEngine:
       R --no-save --no-restore -e "rmarkdown::render(input='${file}', output_format='${fmt}', knit_root_dir='${wd}')"
       (shell-escaped via single-quoting; backticks/dollar-signs neutralized)
   - QuartoRenderEngine:
       quarto render "${file}" --to ${fmt}
       (cwd set to ${wd}; format omitted if engine.defaultFormat was used)
        │
        ▼
 [8] Stream stdout/stderr to OutputChannel 'Raven: Knit'
     ProgressLocation.Notification "Knitting foo.Rmd…" with Cancel button:
       SIGINT on cancel; SIGKILL after 5s if still alive
     Timeout: raven.knit.timeoutMs (default 600000); SIGKILL on expiry, toast "Knit timed out"
        │
        ▼
 [9] Exit
   ├─ Exit 0:
   │    output-path.parseRenderedOutputPath(stdout, fmt):
   │      Rmd: regex /Output created: (.+)$/m  (rmarkdown convention)
   │      qmd: regex /Output created: (.+)$/m  (quarto convention; same)
   │    found one path ─► toast "Knit succeeded: <basename>" + [Open] button
   │    found multiple ─► toast "Knit succeeded: <first>" + [Open] [Show All] buttons; Show All opens output channel
   │    found none     ─► toast "Knit succeeded (output path unknown — see Raven: Knit)" + [Show Output]
   └─ Exit ≠ 0:
        toast "Knit failed: see Raven: Knit output channel"
        focus the output channel
```

### Output reveal across local + remote workspaces

`[Open]` button handler:

```ts
const uri = vscode.Uri.file(outputPath);
const ext = path.extname(outputPath).toLowerCase();
if (ext === '.html') {
  // Opens in Simple Browser when remote (SSH/WSL/Codespaces); default browser when local
  await vscode.commands.executeCommand('vscode.open', uri);
} else {
  await vscode.commands.executeCommand('revealFileInOS', uri);
}
```

This avoids `vscode.env.openExternal(file://…)`, which doesn't work in remote workspaces.

### Workspace trust

`package.json` declares:

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": "limited",
    "description": "Raven Knit and Preview execute code from the workspace. They are disabled in untrusted workspaces.",
    "restrictedConfigurations": ["raven.preview.quartoPath", "raven.r.executablePath"]
  }
}
```

In untrusted workspaces:

- `raven.knit` and `raven.preview` commands surface an info message: "Workspace is not trusted. Trust the workspace to enable Knit and Preview." with a `[Manage Workspace Trust]` button.
- Detection / nags / walkthrough still work.

## Webview security

We adopt the same threat model as `quarto.quarto`. The iframe sandbox is:

```
allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-downloads
```

`allow-same-origin` is required for the iframe's WebSocket connection to Quarto's preview server. Removing it disables live reload. The official Quarto extension uses the identical set.

Mitigations:

- **Workspace trust gate** prevents arbitrary documents from loading until the user has trusted the workspace.
- **Outer-webview CSP** locks the chrome's scripts to `${webview.cspSource}`; nothing the iframe runs can affect the chrome.
- **External-navigation interception**: messages from the iframe requesting external navigation prompt before opening, using `vscode.env.openExternal`.
- **No `localResourceRoots` for rendered content**; only raven's own asset directories.

## Configuration surface

All new or amended settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `raven.rConsole.activation` | `auto`/`enabled`/`disabled` | `auto` | **Amended description** — now scopes to R console + chunks + `.Rmd` knit/preview. |
| `raven.preview.activation` | `auto`/`enabled`/`disabled` | `auto` | **NEW** — controls `.qmd` knit/preview. `auto` defers when `quarto.quarto` is installed. |
| `raven.preview.quartoPath` | `string` | `""` (auto-detect) | **NEW** — explicit path to `quarto` executable. Restricted in untrusted workspaces. |
| `raven.preview.viewerColumn` | `active`/`beside` | `beside` | **NEW** — column for preview webview. Mirrors `raven.plot.viewerColumn`. |
| `raven.preview.renderOnSave` | `boolean` | `true` | **NEW** — auto-render on document save. |
| `raven.preview.startupTimeoutMs` | `number` | `60000` | **NEW** — timeout for capturing Quarto's startup URL. |
| `raven.preview.workingDirectory` | `document`/`project`/`current` | `document` | **NEW** — cwd for `quarto preview` subprocess. |
| `raven.knit.workingDirectory` | `document`/`project`/`current` | `document` | **NEW** — cwd for the knit subprocess (RStudio-parity). |
| `raven.knit.timeoutMs` | `number` | `600000` | **NEW** — hard timeout for knit subprocess. |

Removed from the original issue body:

- `raven.chunks.knit.program` — wrong namespace; superseded by `raven.preview.activation` and engine auto-detection.
- `raven.chunks.preview.autoRefresh` — wrong namespace; renamed to `raven.preview.renderOnSave`.
- `raven.chunks.preview.viewerColumn` — wrong namespace; renamed to `raven.preview.viewerColumn`.

## Commands

| Command ID | Title | When |
|---|---|---|
| `raven.preview` | Raven: Preview | active editor is `.qmd` or `.Rmd`, surfaces enabled per gates |
| `raven.previewToSide` | Raven: Preview to the Side | same |
| `raven.knit` | Raven: Knit | same |
| `raven.preview.verifyQuartoCli` | Raven: Verify Quarto Installation | always |
| `raven.preview.openOutputChannel` | Raven: Show Preview Output | always |
| `raven.knit.openOutputChannel` | Raven: Show Knit Output | always |

Keybindings: deferred to Tier 2 (RStudio's `Cmd+Shift+K` would conflict with raven's existing `Cmd+Shift+Enter` Run Chunk binding). For Tier 1, command palette only.

## Error handling matrix

| Condition | Surface |
|---|---|
| Quarto CLI missing | Modal warning with [Install Quarto] / [Use Knit instead] / [Cancel] |
| Quarto CLI version <1.4 | Modal warning: "Upgrade Quarto" |
| Quarto CLI version ≥2.0 unverified | One-time non-modal warning; functionality proceeds |
| R missing on PATH (knit `.Rmd`) | Toast: "R not found; set raven.r.executablePath" |
| Workspace untrusted | Info: "Trust the workspace to enable" + [Manage Workspace Trust] |
| YAML parse error | Toast: "YAML front matter is malformed" + focus output channel |
| Custom `knit:` hook detected | Info: "Tier 1 doesn't honor custom hooks" + [Copy command] [Open Tier 2 issue] |
| `runtime: shiny` detected | Info: "Shiny documents not supported in Tier 1" + [Copy command] |
| Multi-root workspace with `project` working-dir | Toast: "Cannot resolve project root in multi-root workspace; use document or current" |
| URL capture timeout | Toast: "Quarto preview failed to start" + focus output channel; kill process tree |
| Quarto process exits before URL capture | Same as timeout |
| Render token POST fails | Log only (no toast); preview server lifecycle independent |
| Knit subprocess exits non-zero | Toast: "Knit failed" + focus output channel |
| Knit subprocess timeout | Toast: "Knit timed out" + focus output channel; SIGKILL |
| Output path not detected in knit stdout | Toast: "Knit succeeded (output path unknown)" + [Show Output] |
| Cancellation (user clicks Cancel) | SIGINT → SIGKILL after 5s; toast: "Cancelled" |

## Testing approach

### Unit tests (bun)

- `yaml-frontmatter.test.ts` — parses standard YAML, detects custom `knit:`, `runtime`, `params`, handles malformed YAML, multi-document YAML, BOMs.
- `output-path.test.ts` — extracts output paths from rmarkdown stdout, quarto stdout, multi-format outputs, missing outputs.
- `quarto-version.test.ts` — version-range checks (1.3 reject, 1.4–1.99 accept, 2.0+ warn).
- `gate-resolution.test.ts` — `auto` resolves correctly per (file type, sibling-extension-installed) combinations.
- `nag-state.test.ts` — globalState persistence; "don't show again" semantics.
- `knit-engine.test.ts` — engine selection per (file type, quarto-available, R-available).

### Integration tests (vscode-test)

- Open a `.Rmd` fixture, invoke `raven.knit`, assert output file appears.
- Open a `.qmd` fixture, invoke `raven.preview`, assert WebviewPanel opens with non-empty iframe `src`.
- Open a `.qmd` with `runtime: shiny`, assert info message appears.
- Toggle `raven.preview.activation` between `auto`/`enabled`/`disabled`, assert command availability.

Note: integration tests for the WebSocket reload path require a running Quarto CLI in the test environment; mark these as `it.skipIf(!process.env.QUARTO_CLI_AVAILABLE)`.

### Manual smoke tests

Documented in `docs/development.md` once Tier 1 lands:

- macOS / Linux / Windows: install Quarto via official installer, open sample `.qmd`, click Preview, save the doc, verify live reload.
- Remote workspace (Codespaces or SSH): same as above; verify Simple Browser fallback for Knit output.
- Untrusted workspace: open `.Rmd`, invoke Knit, verify info message.

## Out of scope (Tier 2 issue body — preview)

Title: **R Markdown / Quarto Tier 2 — advanced knit features**

Scope:

- RStudio-style Knit dropdown (Knit to HTML / PDF / Word picker; multi-format from YAML).
- Custom YAML `knit:` hook honoring (bookdown::render_book, xaringan::inf_mr, pkgdown).
- Knit-with-Parameters dialog (`params: "ask"` flow).
- `runtime: shiny` / `server: shiny` interactive document handling via `rmarkdown::run`.
- `rmarkdown::render_site` and `site:` YAML field.
- `raven.knit.useActiveRConsole` option (knit in raven's R terminal for users with slow-loading packages).
- Render-and-rewrite fallback webview (vscode-R-style asset rewriting) for `.Rmd` flows the Quarto knitr engine cannot drive. Conditional on user demand from Tier 1 feedback.

Plug points (designed into Tier 1):

- New `KnitEngine` implementations: `CustomKnitHookEngine`, `ShinyRuntimeEngine`, `RenderSiteEngine`.
- Format-picker dropdown wraps `yaml-frontmatter.detectFormat()` to enumerate all formats instead of returning the first.

## References

- Issue #226: https://github.com/jbearak/raven/issues/226
- Issue #209 / PR #225 (Phases 1–3): https://github.com/jbearak/raven/pull/225
- `quarto-dev/quarto` monorepo, VS Code extension: https://github.com/quarto-dev/quarto/tree/main/apps/vscode
  - `apps/vscode/src/providers/preview/preview.ts` — `PreviewManager`, terminal spawn, stdout scraping, server reuse, save-triggered render
  - `apps/vscode/src/core/quarto.ts` — `configuredQuartoPath`, `promptForQuartoInstallation`
  - `packages/quarto-core/src/context.ts` — `detectQuarto`, known-dirs scan
- `REditorSupport/vscode-R` R Markdown subsystem: https://github.com/REditorSupport/vscode-R/tree/master/src/rmarkdown
- Positron R Markdown task: https://github.com/posit-dev/positron/blob/main/extensions/positron-r/src/tasks.ts
- raven coexistence docs: https://github.com/jbearak/raven/blob/main/docs/coexistence.md
- raven AGENTS.md / CLAUDE.md invariants (R subprocess safety, locking discipline): https://github.com/jbearak/raven/blob/main/CLAUDE.md
- Codex adversarial review (this session, 2026-05-16)

## Open questions

1. **Walkthrough copy** — should we include screenshots / animated GIFs? Conventionally walkthroughs are richer; out-of-scope for this design, addressed during implementation.
2. **Render-token protocol monitoring** — should raven add a CI check that pins Quarto compatibility (e.g., a smoke-test workflow that runs against the latest Quarto release)? Recommend yes; tracked separately.
3. **Telemetry** — should we count preview launches / knit invocations? Raven has no telemetry today; out of scope for this design.
