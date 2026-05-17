# R Markdown Knit — Output Webview + Progress-Lifecycle Fix

**Status**: Design (v2 — addresses Codex adversarial review of v1).
**Date**: 2026-05-17.
**Branch**: `fix-knit-bug`.
**Amends**: [`2026-05-16-rmd-knit-preview-design.md`](2026-05-16-rmd-knit-preview-design.md) — supersedes step 10 ("Reveal") of that spec's data flow and adds one new module. All other sections of the 2026-05-16 spec are unchanged.
**Review**: Codex adversarial review pass on v1 surfaced two critical issues (CSP-in-`<body>` is not honored; rewrite-pass failure could bypass the security model). v2 replaces the in-place CSP+rewrite architecture with an iframe-sandbox shell, eliminating both by construction.

## Why this spec exists

Two user-visible regressions in the shipped `Raven: Knit` flow:

1. **The "Knitting …" progress notification never closes after a successful knit**, and a second invocation reports `"<file> is already being knitted"` until the user dismisses the success toast.
2. **HTML output opens as raw markup** in a text editor on local workspaces (`vscode.commands.executeCommand('vscode.open', <html-uri>)` only routes to Simple Browser in remote workspaces; locally it opens the file in the default text editor).

The user also asks for a **refresh button** so they can re-knit from the viewer without round-tripping to the command palette.

## Relationship to the 2026-05-16 spec

The earlier design deliberately kept *live preview* (iframe + recompile-on-save, the `quarto preview` model) out of scope to avoid duplicating `quarto.quarto`. That decision stands. This design adds a **post-render output viewer**, which is a different surface:

| Feature                         | `quarto.quarto`'s live preview | This spec's Knit Output viewer |
| --                              | --                             | --                             |
| Trigger                         | Save / edit in the source      | Explicit `Raven: Knit` command |
| Recompile cadence               | Automatic, debounced           | Manual, only when user clicks  |
| Transport                       | Quarto's internal token/iframe | Static HTML loaded into webview |
| `.qmd` support                  | Yes                            | Out of scope                   |
| Requires Quarto CLI             | Yes                            | No                             |

`Raven: Knit` only runs when `raven.rConsole.activation` resolves to `enabled` — i.e. `REditorSupport.r` is not active and we're not in Positron. In that population, no sibling extension is providing post-render output viewing for `.Rmd` files. There is no overlap to defer.

## Goals

1. The "Knitting …" progress notification closes the moment the R subprocess exits, regardless of subsequent UI prompts.
2. Repeated knits of the same file are not blocked by an unresolved success/failure toast from the previous knit.
3. Successful HTML knits render the output in a VS Code webview panel, not as raw HTML in a text editor.
4. The webview panel exposes a **Refresh** button that re-invokes `Raven: Knit` for the originating `.Rmd`.
5. No new commands, no new settings, no change to gating, working-directory resolution, or subprocess lifecycle.

## Non-goals

- Live / auto-refresh preview. Refresh is exclusively manual.
- Rendering `.qmd`. `quarto.quarto` continues to own that.
- htmlwidgets / interactive JS inside the rendered document running in the panel. The rendered HTML loads inside an `<iframe sandbox>` with no flags — scripts, forms, and same-origin access are all blocked. Users who need widgets click the panel toolbar's **Open in Browser** button.
- External hyperlinks inside the rendered HTML opening in a new tab from inside the panel. The iframe sandbox prevents script-driven navigation and the outer CSP's `frame-src` directive prevents the iframe from navigating to external URLs. Anchors with `href="#…"` (intra-document) work; relative anchors to other rendered files work; external `http(s)://…` anchors fail silently inside the iframe. Documented in `docs/knit.md`.
- PDF / DOCX inline rendering. Non-HTML outputs continue to use `revealFileInOS`.
- A multi-tab "history" of past knits. The panel is a singleton and always shows the most recent successful output.
- Persisting panel state across window reloads (`retainContextWhenHidden: true` is enabled for switching editor groups; full session restoration is not).

## Architecture

```text
editors/vscode/src/knit/
  index.ts                # unchanged
  knit-commands.ts        # CHANGED: progress lifecycle + reveal dispatch
  knit-engine.ts          # unchanged
  yaml-frontmatter.ts     # unchanged
  r-expression.ts         # unchanged
  output-path.ts          # unchanged
  knit-output-panel.ts    # NEW: singleton WebviewPanel with iframe-sandbox shell + refresh / open-in-browser wiring
```

No changes to `package.json` contributions, settings schema, or context keys.

## Piece A — progress-lifecycle fix

### Root cause

In `editors/vscode/src/knit/knit-commands.ts`, the `vscode.window.withProgress(...)` callback (line ~218) `await`s `vscode.window.showInformationMessage(...)` for the success-path "Open" / "Show All" toast (line ~299). `showInformationMessage` resolves only when the user clicks a button or dismisses the toast. Until then:

- The "Knitting …" progress notification stays visible.
- The `finally` block at line ~309 cannot run.
- `inFlight.delete(fsPath)` is deferred, so re-invoking the command hits the gate at line ~202 and reports `"<file> is already being knitted"`.

The "spawn error", "cancelled", "timed out", and non-zero exit branches all have the same shape and the same defect.

### Fix

The `withProgress` callback returns a plain result discriminated union; no user-facing toasts are awaited inside it. The post-knit branching (toast, panel open, output-channel focus, OS reveal) runs after `withProgress` resolves.

```ts
type KnitOutcome =
  | { kind: 'spawnError'; error: NodeJS.ErrnoException; rBinary: string }
  | { kind: 'cancelled' }
  | { kind: 'timedOut'; timeoutMs: number }
  | { kind: 'failed'; exitCode: number | null }
  | { kind: 'noOutput' }
  | { kind: 'ok'; parsedOutputs: string[]; cwd: string | undefined };
//                                                ^^^^^^^^^^^^^^^^^^^
// `cwd` is `string | undefined`, matching the existing `resolveKnitDir`
// return (undefined when mode === 'current' with no workspace open).
// `renderOutcome` falls back to `path.dirname(fsPath)` when needed.

// inside runKnitCommand:
let outcome: KnitOutcome;
try {
  outcome = await vscode.window.withProgress(
    { location: ProgressLocation.Notification, title: `Knitting ${baseName}…`, cancellable: true },
    async (_progress, token) => {
      const result = await runKnitImpl({ /* ... */ cancellation: token });
      return classify(result);              // returns KnitOutcome — no awaits on user input
    },
  );
} finally {
  inFlight.delete(fsPath);
}

await renderOutcome(outcome, { fsPath, baseName, sourceUri, output, panelMgr });
```

**Injection seam for testing.** `registerKnitCommands` accepts an optional `deps: { runKnit?: typeof runKnit; openPanel?: typeof KnitOutputPanel.showOrUpdate }` parameter, defaulting to the real implementations imported from `./knit-engine` and `./knit-output-panel`. Tests pass fakes via this parameter. The lifecycle test (see "Testing" below) substitutes `runKnit` and asserts the `withProgress` promise resolves before `renderOutcome` runs. No top-level module mocking required.

`inFlight.delete(fsPath)` runs the instant `withProgress` resolves, so a second knit invoked between the subprocess exit and the user dismissing the success toast is no longer blocked.

### Verifying the fix

A focused test under `editors/vscode/src/test/` (see "Testing" below) substitutes a fake `runKnit` that resolves immediately with a successful result, and asserts:

- The `withProgress` promise resolves before the success toast is shown.
- `inFlight.has(fsPath) === false` at the moment `withProgress` resolves.
- A second concurrent `raven.knit` invocation issued at that moment is *not* rejected with "already being knitted".

## Piece B — Knit Output webview panel (iframe-sandbox shell)

### Architectural choice

The panel is an **outer Raven-controlled shell document** that hosts an `<iframe sandbox>` pointing at the rendered HTML. Security is enforced by:

- The outer shell's CSP (in `<head>`, fully under our control).
- The iframe's `sandbox` attribute (no flags — blocks scripts, forms, same-origin access, popups, and top-navigation).
- `webview.localResourceRoots` confined to the rendered output's parent directory.

We do not parse or rewrite the rendered HTML. The iframe loads it directly from `webview.asWebviewUri(...)`; relative asset paths (figures, CSS) resolve against the webview origin naturally because `localResourceRoots` includes the output's parent directory.

This addresses Codex critical findings #1 (CSP must live in `<head>`) and #2 (security model must not depend on a rewrite that may throw) by construction — there is no rewrite, and the CSP lives in our shell's head.

### Module

`editors/vscode/src/knit/knit-output-panel.ts` exposes a singleton manager modelled on `editors/vscode/src/help/help-panel.ts`:

```ts
export class KnitOutputPanel {
  private static instance: KnitOutputPanel | undefined;
  private panel: vscode.WebviewPanel;
  private rootDir: string;       // current localResourceRoots[0].fsPath
  private sourceUri: vscode.Uri; // for refresh
  private outputPath: string;    // for Open in Browser

  static showOrUpdate(
    context: vscode.ExtensionContext,
    args: { sourceUri: vscode.Uri; outputPath: string },
  ): Promise<void>;

  private constructor(/* ... */);
  private updateContent(args: { sourceUri: vscode.Uri; outputPath: string }): void;
  private dispose(): void;
}
```

`showOrUpdate` is the only public entry point. It:

1. Verifies `outputPath` exists with `fs.promises.access(outputPath, fs.constants.R_OK)`. On failure, returns a "could not read rendered file" error; the caller falls back to `revealFileInOS`.
2. Computes `rootDir = path.dirname(outputPath)`.
3. If `instance` exists and `instance.rootDir === rootDir`: replaces content via `updateContent`, reveals (`panel.reveal(panel.viewColumn ?? ViewColumn.Beside, /* preserveFocus */ true)`).
4. If `instance` exists but `instance.rootDir !== rootDir`: disposes the old panel (column read first) and creates a new one in the same column. (`localResourceRoots` is immutable post-creation — same workaround `help-panel.ts` uses.)
5. If no instance: creates a fresh panel in `ViewColumn.Beside`.

### Webview options

```ts
vscode.window.createWebviewPanel(
  'raven.knitOutput',
  'Knit Output',
  { viewColumn: ViewColumn.Beside, preserveFocus: true },
  {
    enableScripts: true,
    enableFindWidget: true,           // Cmd/Ctrl-F over the rendered text
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(rootDir)],
  },
);
```

`preserveFocus: true` keeps the cursor in the editor.

### Outer shell HTML

`updateContent` regenerates the shell HTML each time and assigns to `panel.webview.html`. The shell is a small fixed template:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               frame-src ${cspSource};
               img-src ${cspSource} https: data:;
               style-src ${cspSource} 'unsafe-inline';
               font-src ${cspSource} https: data:;
               script-src 'nonce-${nonce}';
               connect-src 'none';">
<title>Knit Output</title>
<style nonce="${nonce}">
  /* toolbar styles — fixed at top, ~36px tall, VS Code theme variables */
</style>
</head>
<body>
  <div id="raven-knit-toolbar" role="toolbar" aria-label="Knit output">
    <button id="raven-knit-refresh" type="button" title="Re-knit the source document">Refresh</button>
    <button id="raven-knit-open-browser" type="button" title="Open the rendered file in your default browser">Open in Browser</button>
    <span id="raven-knit-filename" aria-live="polite">${escapeHtml(path.basename(outputPath))}</span>
  </div>
  <iframe id="raven-knit-frame"
          src="${asWebviewUri(outputPath)}"
          sandbox=""
          referrerpolicy="no-referrer"
          title="Rendered output: ${escapeHtml(path.basename(outputPath))}"></iframe>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      document.getElementById('raven-knit-refresh').addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
      });
      document.getElementById('raven-knit-open-browser').addEventListener('click', function () {
        vscode.postMessage({ type: 'openInBrowser' });
      });
    })();
  </script>
</body>
</html>
```

Notes:

- `sandbox=""` (empty value) is the most restrictive sandbox: no scripts, no forms, no same-origin, no popups, no top-navigation. The rendered HTML is purely static rendering.
- `frame-src ${cspSource}` confines the iframe to the webview origin. External anchors in the rendered HTML cannot navigate the iframe to an external host (the navigation is blocked silently).
- `'unsafe-inline'` for styles is needed by rmarkdown's stock templates (inline `<style>` for highlight themes); the iframe sandbox makes this safe because the inline styles cannot reach the outer toolbar.
- The toolbar uses VS Code theme variables (`--vscode-button-background`, etc.) for visual consistency. Standard pattern across `help-panel.ts` and `plot-viewer-panel.ts`.

### Message protocol

```ts
type KnitOutputMessage =
  | { type: 'refresh' }
  | { type: 'openInBrowser' };
```

The webview never receives the source URI or output path. The extension side captures both at `showOrUpdate` time and uses them on receipt:

```ts
panel.webview.onDidReceiveMessage((msg: unknown) => {
  if (!isKnitOutputMessage(msg)) return;     // strict type-narrowing
  if (msg.type === 'refresh') {
    void vscode.commands.executeCommand('raven.knit', this.sourceUri);
  } else if (msg.type === 'openInBrowser') {
    void openInBrowser(this.outputPath, this.output);
  }
});
```

### What refresh does

`raven.knit` re-runs against `this.sourceUri`. Every gate, blocker detection, validation, subprocess invocation, output-channel write, progress notification, cancellation, and reveal step that the original knit went through runs again. The same code path that called `KnitOutputPanel.showOrUpdate` for the original knit calls it again. The iframe's `src` is replaced; the panel reference does not change unless the output's `rootDir` did.

The existing `inFlight` Set in `registerKnitCommands` already prevents two concurrent knits of the same file with a clear info toast. Refresh inherits that gate.

### Open in Browser

`openInBrowser(outputPath, output)`:

```ts
async function openInBrowser(outputPath: string, output: vscode.OutputChannel): Promise<void> {
  const uri = vscode.Uri.file(outputPath);
  const opened = await vscode.env.openExternal(uri);
  if (opened) return;
  // Remote workspaces: openExternal(file:) opens on the extension-host
  // machine, which is the remote server — not where the user is sitting.
  // Surface a clear fallback message and keep the rendered path in the
  // output channel so the user can act on it.
  output.appendLine(`[Open in Browser] file:// did not open on the local machine.`);
  output.appendLine(`Rendered output is at: ${outputPath}`);
  await vscode.window.showWarningMessage(
    'Open in Browser is not available for this workspace. The rendered file path has been written to the Raven: Knit output channel.',
  );
}
```

The previous spec's claim that `openExternal(file:)` "correctly routes through the remote-tunnel" was unverified (Codex finding #6); it is retracted here. Local workspaces continue to use the OS default browser via `openExternal`; remote workspaces surface a clear fallback rather than silently failing.

## Updated data flow (delta from the 2026-05-16 spec)

Steps [1]–[9] are unchanged. Step [10] ("Reveal") is replaced:

```text
 [10] Reveal — supersedes step 10 of the 2026-05-16 spec.

   Exit 0, parsed.paths.length >= 1:
     base = cwd ?? path.dirname(fsPath)
     absolutized = parsed.paths.map(p => absolutizeFromCwd(p, base))

     // Codex finding #4: when output_format = "all" produces a mix of formats,
     // prefer the HTML output for the webview. The user explicitly asked for
     // an HTML viewer; PDF/DOCX outputs of the same knit still surface via
     // the toast.
     html = absolutized.find(p =>
       ['.html', '.htm'].includes(path.extname(p).toLowerCase())
     )
     primary = html ?? absolutized[0]
     ext = path.extname(primary).toLowerCase()

     if ext is '.html' or '.htm':
       panelResult = KnitOutputPanel.showOrUpdate(context, {
         sourceUri: docUri, outputPath: primary,
       })
       if panelResult is { ok: false }:
         output.appendLine(`[panel] ${panelResult.error}`)
         fall through to revealFileInOS(primary) — see "else" branch
       else:
         Toast (NON-MODAL, fire-and-forget): "Knit succeeded: <basename>." with buttons
           [Show Output Panel] [Show All if absolutized.length > 1]
         The panel has already opened; the toast is for feedback.
         Open in Browser lives in the panel toolbar, not on the toast.

     else (PDF, Word, plain text, …):
       Toast (NON-MODAL, fire-and-forget): "Knit succeeded: <basename>." with buttons
         [Open] [Show All if absolutized.length > 1]
       [Open] → revealFileInOS(primary).
       Behavior is identical to the pre-spec implementation, minus the
       await-inside-progress bug.
```

The "output path unknown" branch (Exit 0, parsed.paths.length === 0) and the failure branches (non-zero exit, cancellation, timeout, spawn error) are unchanged in semantics but no longer execute inside `withProgress`.

## Security model

The model has three independent layers; each enforces containment by itself, and any one of them failing does not breach the others.

1. **`iframe sandbox` (no flags).** The rendered HTML loads inside `<iframe sandbox="" …>`. This blocks scripts, forms, popups, top-level navigation, and same-origin access. The iframe cannot read or modify the outer toolbar; the outer toolbar's scripts cannot inspect the iframe content. Even if the rendered HTML contains `<script>` tags, they do not execute.
2. **Outer-shell CSP** (in `<head>` of the Raven-controlled shell). `default-src 'none'`, `frame-src ${cspSource}` (blocks the iframe navigating to external hosts), `script-src 'nonce-${nonce}'` (only our toolbar script runs), `connect-src 'none'` (no `fetch`/`XHR`). The CSP is in `<head>` and is guaranteed honored, addressing Codex critical finding #1.
3. **`localResourceRoots`.** Confined to `path.dirname(outputPath)`. The webview can resolve files only from that directory and below. Defense in depth — even if the iframe sandbox were misconfigured, the renderer cannot fetch arbitrary files.

Additional invariants:

- **No source URI in the webview.** The toolbar script posts only `{type: 'refresh'}` or `{type: 'openInBrowser'}`. The extension captures the `sourceUri` and `outputPath` once at `showOrUpdate` time. Compromised rendered HTML cannot retarget the refresh to a different file.
- **Message-type narrowing.** `onDidReceiveMessage` accepts only the two exact message shapes; anything else is silently dropped.
- **No HTML parsing on Raven's side.** Codex finding #7 (hand-rolled parser misses single-quoted attrs, `srcset`, CSS `url(...)`, etc.) is moot — we don't parse. The iframe's browser parses the rendered HTML, and the sandbox+CSP+roots stack governs what the browser can do with it.
- **No rewrite-failure fallback path.** Codex finding #2 (rewrite throws → renders unrewritten in script-enabled webview) is moot — there is no rewrite. The shell is a small fixed template; if it can't be assembled, we fall back to `revealFileInOS`.

## Error handling

| Condition                                            | Surface                                                                                                                                                                                                            |
| --                                                   | --                                                                                                                                                                                                                 |
| Rendered HTML file not readable (`fs.access` fails)  | Toast: "Knit Output: could not access rendered file: {message}"; log to output channel; do not open the panel; fall back to `revealFileInOS` on the path.                                                          |
| Refresh-while-knit-in-flight                         | Existing inFlight gate fires: info toast "<file> is already being knitted." No change.                                                                                                                             |
| Refresh produces output under a different `rootDir`  | Dispose & recreate panel in the same column. User-visible: brief flash; no error.                                                                                                                                  |
| Panel disposed by user, then knit re-run             | A fresh panel opens. The previous singleton was garbage collected on `onDidDispose`.                                                                                                                               |
| Knit re-run produces non-HTML output                 | The new toast with `[Open]` fires; the previous HTML panel is left visible (it shows the last successful HTML — accurate, not stale-for-the-format).                                                               |
| `vscode.env.openExternal` returns false              | Surface "Open in Browser is not available for this workspace" toast and write the rendered file path to the Raven: Knit output channel. Common in remote workspaces where `file:` URIs target the remote machine. |
| User clicks external `<a>` inside the rendered HTML  | Navigation blocked silently by `frame-src` CSP and `sandbox`. Document this in `docs/knit.md` as a known limitation; users use **Open in Browser** for interactive content.                                        |

## Configuration

No new settings.

## Commands

No new commands. The `Refresh` button invokes `raven.knit`; no separate `raven.knit.refresh` is registered (avoids a UI surface duplicating the gate logic).

## Testing

### Unit tests (Bun, `tests/bun/`)

- **`knit-output-shell.test.ts`** — given fixed inputs (sourceUri, outputPath, fake webview with `asWebviewUri` and `cspSource`), the shell HTML emitted by `buildShellHtml(...)`:
  - includes a CSP `<meta>` inside `<head>` (asserted by checking the offset of `Content-Security-Policy` is before the offset of `<body>`)
  - sets the iframe `src` to the `asWebviewUri` of the output path and `sandbox=""` (empty)
  - includes the nonce-bearing `<script>` and the two toolbar buttons with the expected IDs
  - HTML-escapes the filename in the toolbar (test with a filename containing `<script>` to verify escaping)
- **`knit-multi-output.test.ts`** — `pickPrimaryOutput([pdf, html, docx])` returns the html; `pickPrimaryOutput([pdf, docx])` returns the pdf; `pickPrimaryOutput([html])` returns the html. Asserts the Codex-finding-#4 fix.
- **`knit-output-message.test.ts`** — `isKnitOutputMessage` accepts `{type: 'refresh'}` and `{type: 'openInBrowser'}` only; rejects `{type: 'evil'}`, `null`, `undefined`, `'refresh'`, `{}`, and additional-property variants.

### VS Code extension tests (Mocha, `editors/vscode/src/test/`)

- **`knit-progress-lifecycle.test.ts`** (Piece A) — calls `registerKnitCommands` with a fake `runKnit` via the injection seam. Fires `raven.knit`; the fake resolves with a successful result. Asserts:
  - the `withProgress` promise resolves before any `showInformationMessage` is observed
  - `inFlight.has(fsPath) === false` at the moment `withProgress` resolves
  - a second `raven.knit` invocation issued at that moment is not blocked with "already being knitted"
- **`knit-panel-singleton.test.ts`** — calling `KnitOutputPanel.showOrUpdate` twice with the same `rootDir` reuses the panel (same `panel` reference, iframe src swapped). With a different `rootDir`, the first is disposed and a new one created in the same column.
- **`knit-refresh-roundtrip.test.ts`** — opens a panel with a fixture HTML on disk, posts `{type: 'refresh'}` from `panel.webview.onDidReceiveMessage` test-only fake, asserts `vscode.commands.executeCommand` is called exactly once with `('raven.knit', sourceUri)`. Same test plus `{type: 'openInBrowser'}` asserts `vscode.env.openExternal` is called with the file URI.

### Manual smoke (post-merge)

- Knit a simple `.Rmd` on macOS. Verify "Knitting …" closes when R exits; Knit Output panel opens beside the editor; **Refresh** and **Open in Browser** are visible in the toolbar; Refresh re-knits; second Refresh while still in-flight produces the existing toast.
- Knit on Linux and Windows. Verify CSS / figure loading in the iframe in all three OSes.
- Knit in a remote workspace (Codespaces / SSH). Verify the panel renders and Refresh works. Verify **Open in Browser** either opens locally (best case) OR surfaces the "not available for this workspace" warning + path-in-output-channel fallback (acceptable case). Codex finding #6: we make no guarantees about remote `openExternal(file:)`; the fallback is the contract.
- Knit a PDF output (`output: pdf_document`). Verify the existing reveal-in-OS path is unchanged.
- Knit a document whose `.html` includes htmlwidgets. Verify the widget JS does not execute in the panel (silent — sandbox blocks it). Click **Open in Browser** and verify a working widget loads in the default browser (local workspaces only).
- Knit a document with `output_format = "all"` producing both HTML and PDF. Verify the HTML opens in the panel, the success toast names the HTML's basename, and the PDF is accessible via **Show All** in the output channel.
- Knit a document with external anchor links (e.g. `[Google](https://google.com)`). Verify clicking the link inside the iframe does not navigate anywhere (silently blocked). Verify **Open in Browser** opens the rendered file in the default browser, where the link works.

## Documentation updates

- **`docs/knit.md`** — rewrite step 10 ("Reveal") to describe the Knit Output panel for HTML, the refresh button, and the `Open in Browser` button. Add one sentence to the "What it does, step by step" preamble noting that HTML output opens in a webview rather than the OS browser by default.
- **`docs/knit.md`** — the "What raven does **not** do" table keeps "Live preview of `.Rmd` or `.qmd`" pointing to `quarto.quarto`. Add a one-line clarification: the post-render viewer is *not* live preview; it is a static viewer with manual refresh.
- **`docs/development.md`** — short note describing the singleton-panel pattern (cross-link to `help-panel.ts`).

## Open questions

1. **`retainContextWhenHidden`** vs. lazy re-render on visibility. `retainContextWhenHidden: true` costs memory proportional to the rendered HTML; lazy re-render adds latency to tab-switching. **Recommendation**: `retainContextWhenHidden: true` for v1; revisit if memory pressure is reported.
2. **`Refresh` button availability during in-flight knit.** The button currently doesn't know about the inFlight gate; clicking it during a knit produces the existing "already being knitted" toast. We could disable the button while a knit is running by sending a status message from the extension. **Recommendation**: don't add it in v1; the toast is already clear and the cross-component state is real complexity. File a follow-up if a user reports the friction.
3. **Internal anchor support inside the iframe.** Intra-document anchors (`#section`) work natively; relative anchors to sibling rendered files (e.g. another section of a bookdown chapter) also work because the webview origin governs both. External anchors are blocked (documented as a limitation). **Recommendation**: ship the current behavior; revisit if bookdown / multi-file rendering becomes a use case (currently out of scope per the 2026-05-16 spec).

## v1 → v2 changes (response to Codex review)

Summary of changes between this revision and the version reviewed by Codex (`109d932`):

| Codex finding | v2 disposition |
| --            | --             |
| #1 CSP-in-`<body>` not honored | Iframe-sandbox shell: CSP lives in the outer shell's `<head>`; rendered HTML is in a sandboxed iframe. |
| #2 Rewrite-failure renders unrewritten HTML | No rewrite; no fallback path. Shell is a fixed template. |
| #3 No anchor-click classifier | Iframe `sandbox=""` + `frame-src ${cspSource}` blocks external navigation; documented as a limitation. |
| #4 Multi-output prefers `parsed.paths[0]` | `pickPrimaryOutput` prefers any HTML; documented and unit-tested. |
| #5 `runKnit` injection seam unspecified | `registerKnitCommands(context, deps?)` accepts a `deps` parameter for tests. |
| #6 `openExternal(file:)` remote-tunnel claim | Retracted; remote-workspace fallback explicit (warning toast + path written to output channel). |
| #7 Hand-rolled HTML rewriter too narrow | No rewriter; the rendered browser parses the HTML and the sandbox+CSP stack governs it. |
| #8 `KnitOutcome.cwd` type mismatch | `cwd: string | undefined`; `renderOutcome` resolves with `cwd ?? path.dirname(fsPath)` as fallback. |
| #9 Open-in-Browser only on toast | Moved to the panel toolbar; persistent and always reachable. |
| #10 Missing `enableFindWidget` | Added. |
