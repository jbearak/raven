# R Markdown Knit — Output Webview + Progress-Lifecycle Fix

**Status**: Design.
**Date**: 2026-05-17.
**Branch**: `fix-knit-bug`.
**Amends**: [`2026-05-16-rmd-knit-preview-design.md`](2026-05-16-rmd-knit-preview-design.md) — supersedes step 10 ("Reveal") of that spec's data flow and adds one new module. All other sections of the 2026-05-16 spec are unchanged.

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
- htmlwidgets / interactive JS inside the rendered document running in the panel. The panel's CSP allows our refresh-button script (nonce-gated) and inline styles; arbitrary scripts from the rendered HTML do not run. Users who need htmlwidgets can open the `.html` file in a browser via the panel's existing OS file path (current behavior preserved on the success toast for non-HTML outputs, and an `Open in Browser` button on the toast — see "Open Externally" below).
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
  knit-output-panel.ts    # NEW: singleton WebviewPanel + HTML rewrite + refresh wiring
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
  | { kind: 'ok'; parsedOutputs: string[]; cwd: string };

// inside runKnitCommand:
let outcome: KnitOutcome;
try {
  outcome = await vscode.window.withProgress(
    { location: ProgressLocation.Notification, title: `Knitting ${baseName}…`, cancellable: true },
    async (_progress, token) => {
      const result = await runKnit({ /* ... */ cancellation: token });
      return classify(result);              // returns KnitOutcome — no awaits on user input
    },
  );
} finally {
  inFlight.delete(fsPath);
}

await renderOutcome(outcome, { /* fsPath, baseName, sourceUri, output channel, cwd, panelMgr */ });
```

`inFlight.delete(fsPath)` runs the instant `withProgress` resolves, so a second knit invoked between the subprocess exit and the user dismissing the success toast is no longer blocked.

### Verifying the fix

A focused test under `editors/vscode/src/test/` (see "Testing" below) substitutes a fake `runKnit` that resolves immediately with a successful result, and asserts:

- The `withProgress` promise resolves before the success toast is shown.
- `inFlight.has(fsPath) === false` at the moment `withProgress` resolves.
- A second concurrent `raven.knit` invocation issued at that moment is *not* rejected with "already being knitted".

## Piece B — Knit Output webview panel

### Module

`editors/vscode/src/knit/knit-output-panel.ts` exposes a singleton manager modelled on `editors/vscode/src/help/help-panel.ts`:

```ts
export class KnitOutputPanel {
  private static instance: KnitOutputPanel | undefined;
  private panel: vscode.WebviewPanel;
  private rootDir: string;       // current localResourceRoots[0].fsPath
  private sourceUri: vscode.Uri; // for refresh

  static showOrUpdate(
    context: vscode.ExtensionContext,
    args: { sourceUri: vscode.Uri; outputPath: string },
  ): Promise<void>;

  private constructor(/* ... */);
  private updateHtml(outputPath: string): Promise<void>;
  private dispose(): void;
}
```

`showOrUpdate` is the only public entry point. It:

1. Computes `rootDir = path.dirname(outputPath)`.
2. If `instance` exists and `instance.rootDir === rootDir`: replaces content via `updateHtml`, reveals (`panel.reveal(panel.viewColumn ?? ViewColumn.Beside, false)`).
3. If `instance` exists but `instance.rootDir !== rootDir`: disposes the old panel (column is preserved via the `viewColumn` we read before disposing) and creates a new one in the same column. This is the same `localResourceRoots`-immutability workaround used in `help-panel.ts`.
4. If no instance: creates a fresh panel in `ViewColumn.Beside`.

### Webview options

```ts
vscode.window.createWebviewPanel(
  'raven.knitOutput',
  'Knit Output',
  { viewColumn: ViewColumn.Beside, preserveFocus: true },
  {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(rootDir)],
  },
);
```

`preserveFocus: true` keeps the cursor in the editor — the user's primary surface for editing.

### HTML loading and rewrite

`updateHtml(outputPath)`:

1. `const raw = await fs.promises.readFile(outputPath, 'utf-8')`. On error, dispose the panel and surface a toast "Knit Output: could not read rendered file: {message}"; the caller falls back to `revealFileInOS`.
2. Rewrite `src`/`href` attributes with a hand-rolled tag-attribute pass scoped to `<img>`, `<link rel="stylesheet">`, `<script src>`, and `<a href>` — ~60 lines, sufficient for rmarkdown's stock templates. (See Open Question #1 for the `parse5` alternative.) For each relative path:
   - Resolve relative to `path.dirname(outputPath)` to an absolute path.
   - `path.relative(rootDir, absolute)` — reject (skip rewrite, log warning) if the result starts with `..` or is absolute on Windows. This is the path-containment guard.
   - `vscode.Uri.file(absolute)` → `panel.webview.asWebviewUri(...)`.
   - Absolute URLs (`http:`, `https:`, `data:`, `mailto:`, `#fragment`) are passed through unchanged.
3. Inject a CSP `<meta>` and a fixed toolbar at the top of `<body>`:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src ${cspSource} https: data:;
               style-src ${cspSource} 'unsafe-inline';
               font-src ${cspSource} https: data:;
               script-src 'nonce-${nonce}';
               connect-src 'none';">

<div id="raven-knit-toolbar" role="toolbar" aria-label="Knit output">
  <button id="raven-knit-refresh" type="button">Refresh</button>
  <span id="raven-knit-filename" aria-live="polite">${escapeHtml(path.basename(outputPath))}</span>
</div>
<script nonce="${nonce}">
  (function () {
    const vscode = acquireVsCodeApi();
    document.getElementById('raven-knit-refresh').addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
  })();
</script>
```

`'unsafe-inline'` for styles is the same compromise `help-panel.ts` makes — rmarkdown's default templates emit inline `<style>` blocks for highlight themes. Scripts inside the rendered HTML cannot run because they lack the nonce; this is intentional and called out in the non-goals.

The toolbar is appended via DOM-string concatenation rather than DOM injection (the panel never executes the rendered scripts, so a post-load `appendChild` couldn't work). The toolbar markup precedes `<body>`'s existing content, and lightly-styled to float at the top of the viewport.

### Message protocol

The webview never receives the source URI or output path. The extension side captures both when `showOrUpdate` is called and uses them on receipt of:

```ts
type KnitOutputMessage = { type: 'refresh' };
```

Handler:

```ts
panel.webview.onDidReceiveMessage((msg: unknown) => {
  if (isRefreshMessage(msg)) {
    void vscode.commands.executeCommand('raven.knit', this.sourceUri);
  }
});
```

`isRefreshMessage` is a narrow `msg !== null && typeof msg === 'object' && (msg as any).type === 'refresh'` check.

### What refresh does

`raven.knit` re-runs against `this.sourceUri`. Every gate, blocker detection, validation, subprocess invocation, output-channel write, progress notification, cancellation, and reveal step that the original knit went through runs again. The same code path that called `KnitOutputPanel.showOrUpdate` for the original knit calls it again. The panel content is replaced; the panel reference does not change unless the output's `rootDir` did.

The existing `inFlight` Set in `registerKnitCommands` already prevents two concurrent knits of the same file with a clear info toast. Refresh inherits that gate. No webview-side in-flight state is needed.

### Open Externally

The success toast for HTML outputs is replaced with two buttons:

- **Show Output Panel** — focuses the Knit Output webview (`panel.reveal`).
- **Open in Browser** — `vscode.env.openExternal(vscode.Uri.file(outputPath))`. Gives users with htmlwidget / JS-heavy documents an escape hatch to a full browser. In remote workspaces, `openExternal` correctly routes through the remote-tunnel.

Non-HTML output toasts are unchanged.

## Updated data flow (delta from the 2026-05-16 spec)

Steps [1]–[9] are unchanged. Step [10] ("Reveal") is replaced:

```text
 [10] Reveal — supersedes step 10 of the 2026-05-16 spec.

   Exit 0, parsed.paths.length >= 1:
     primary = absolutizeFromCwd(parsed.paths[0], cwd ?? path.dirname(fsPath))
     ext = path.extname(primary).toLowerCase()

     if ext is '.html' or '.htm':
       KnitOutputPanel.showOrUpdate(context, { sourceUri: docUri, outputPath: primary })
       Toast (NON-MODAL, no awaited button): "Knit succeeded: <basename>." with buttons
         [Show Output Panel] [Open in Browser] [Show All if parsed.paths > 1]
       The toast is fire-and-forget; the panel has already opened. The withProgress
       promise has already resolved (Piece A).

     else (PDF, Word, plain text, …):
       Toast (NON-MODAL, no awaited button): "Knit succeeded: <basename>." with buttons
         [Open] [Show All if parsed.paths > 1]
       [Open] → revealFileInOS(primary).
       Behavior is identical to the pre-spec implementation, minus the await-inside-progress bug.
```

The "output path unknown" branch (Exit 0, parsed.paths.length === 0) and the failure branches (non-zero exit, cancellation, timeout, spawn error) are unchanged in semantics but no longer execute inside `withProgress`.

## Security model

1. **`localResourceRoots` is the only escape**: the panel can load images / CSS / fonts only from the rendered file's directory and below. The HTML rewrite pass enforces this by skipping any relative path that resolves outside `rootDir`.
2. **CSP** allows our refresh-button script via nonce and rmarkdown's inline styles via `'unsafe-inline'`. Scripts inside the rendered HTML do not match the nonce and do not run. `connect-src 'none'` prevents any `fetch`/`XHR` even if a script did slip past.
3. **No source URI in the webview.** The refresh-button script posts only `{type: 'refresh'}`. The extension side captures the `sourceUri` once at `showOrUpdate` time. A compromised rendered HTML cannot retarget the refresh to a different file.
4. **Message-type narrowing.** The `onDidReceiveMessage` handler accepts only the exact shape `{type: 'refresh'}`. Anything else is silently dropped.
5. **Path containment** on rewrite uses `path.relative` plus a Windows absolute-path check. We never widen `localResourceRoots` to satisfy a rewrite.

## Error handling

| Condition                                            | Surface                                                                                                                                              |
| --                                                   | --                                                                                                                                                   |
| Rendered HTML file read fails                        | Toast: "Knit Output: could not read rendered file: {message}"; dispose panel; `revealFileInOS` on the path.                                          |
| HTML rewrite throws                                  | Log to `Raven: Knit` output channel with details; render the unrewritten HTML in the panel (broken figures are acceptable; text is still readable).  |
| Refresh-while-knit-in-flight                         | Existing inFlight gate fires: info toast "<file> is already being knitted." No change.                                                               |
| Refresh produces output under a different `rootDir`  | Dispose & recreate panel in the same column. User-visible: brief flash; no error.                                                                    |
| Panel disposed by user, then knit re-run             | A fresh panel opens. The previous singleton was garbage collected on `onDidDispose`.                                                                 |
| Knit re-run produces non-HTML output                 | Existing toast with `[Open]` fires; the previous HTML panel is left visible (it shows the last successful HTML — accurate, not stale-for-the-format). |
| `vscode.env.openExternal` rejected                   | Surface a toast with the message and fall back to `revealFileInOS`.                                                                                  |

## Configuration

No new settings.

## Commands

No new commands. The `Refresh` button invokes `raven.knit`; no separate `raven.knit.refresh` is registered (avoids a UI surface duplicating the gate logic).

## Testing

### Unit tests (Bun, `tests/bun/`)

- **`knit-output-html-rewrite.test.ts`** — given a synthetic rendered HTML string with a mix of relative (`figure-1.png`, `assets/style.css`), absolute (`/etc/passwd`), parent-escaping (`../../secret.txt`), and external (`https://…`, `data:…`) references:
  - relative paths inside `rootDir` are rewritten to `asWebviewUri(...)` results
  - parent-escaping paths are left unrewritten and the rewrite logs a warning
  - absolute and external references are left unchanged
  - the CSP `<meta>`, toolbar markup, and nonce-bearing script are present in the output
- **`knit-output-panel-singleton.test.ts`** — `showOrUpdate` called twice with the same `rootDir` reuses the panel (same panel reference, content swapped). Called with a different `rootDir`, the first is disposed and a new one created.

### VS Code extension tests (Mocha, `editors/vscode/src/test/`)

- **`knit-progress-lifecycle.test.ts`** (Piece A) — substitutes a fake `runKnit` that resolves with a successful result. Asserts:
  - the `withProgress` promise resolves before any `showInformationMessage` is awaited
  - `inFlight.has(fsPath) === false` at the moment `withProgress` resolves
  - a second `raven.knit` invocation issued at that moment is not blocked with "already being knitted"
- **`knit-refresh-roundtrip.test.ts`** — opens the panel by calling `KnitOutputPanel.showOrUpdate` with a fixture HTML, posts `{type: 'refresh'}` from a stubbed webview, asserts `vscode.commands.executeCommand` is called exactly once with `('raven.knit', sourceUri)`.

### Manual smoke (post-merge)

- Knit a simple `.Rmd` on macOS. Verify "Knitting …" closes when R exits; Knit Output panel opens beside the editor; refresh button is visible; clicking it re-knits; second click while still in-flight produces the existing toast.
- Knit on Linux and Windows. Verify CSS / figure loading in all three OSes.
- Knit in a remote workspace (Codespaces). Verify the panel opens with figures intact and `Open in Browser` routes through the remote tunnel.
- Knit a PDF output (`output: pdf_document`). Verify the existing reveal-in-OS path is unchanged.
- Knit a document whose `.html` includes htmlwidgets. Verify the widget JS does not execute in the panel (silent — no errors visible to the user), and that `Open in Browser` from the success toast yields a working widget in the default browser.

## Documentation updates

- **`docs/knit.md`** — rewrite step 10 ("Reveal") to describe the Knit Output panel for HTML, the refresh button, and the `Open in Browser` button. Add one sentence to the "What it does, step by step" preamble noting that HTML output opens in a webview rather than the OS browser by default.
- **`docs/knit.md`** — the "What raven does **not** do" table keeps "Live preview of `.Rmd` or `.qmd`" pointing to `quarto.quarto`. Add a one-line clarification: the post-render viewer is *not* live preview; it is a static viewer with manual refresh.
- **`docs/development.md`** — short note describing the singleton-panel pattern (cross-link to `help-panel.ts`).

## Open questions

1. **`parse5` vs hand-rolled rewriter.** Pulling `parse5` in adds ~500 KB to the extension bundle. A hand-rolled rewrite is ~60 lines and covers `<img>`, `<link rel="stylesheet">`, `<script src>`, and `<a href>` — enough for rmarkdown's stock templates. **Recommendation**: hand-rolled, with a clear comment that we cover the rmarkdown-template subset. Revisit only if a user reports a broken document.
2. **`Open in Browser` placement.** Toast button vs. a second button in the panel toolbar. **Recommendation**: toast button only, to keep the toolbar minimal. Users who need it frequently can re-knit and click again.
3. **`retainContextWhenHidden`** vs. lazy re-render on visibility. `retainContextWhenHidden: true` costs memory proportional to the rendered HTML; lazy re-render adds latency to tab-switching. **Recommendation**: `retainContextWhenHidden: true` for v1; revisit if memory pressure is reported.
