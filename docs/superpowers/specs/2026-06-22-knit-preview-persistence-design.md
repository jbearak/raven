# Knit Preview persistence across window reload/restart

## Problem

When a user knits an `.Rmd` in VS Code, the **Knit Preview** webview panel
shows the rendered HTML. If the user reloads the window (`Developer: Reload
Window`) or quits and reopens VS Code, the panel disappears and the user must
re-knit. Knitting can be slow (it runs the R subprocess over every chunk), so
losing the rendered output on every window reload is a recurring annoyance.

The goal: a previously-open Knit Preview panel comes back automatically after a
window reload or a full VS Code restart, showing the **last rendered output**,
with **no R subprocess re-run** and no popup.

Out of scope: surviving a machine reboot (the OS may clear `os.tmpdir()`); a
"live"/auto-refresh preview; re-knitting on restore.

## Why it doesn't persist today

Two independent mechanisms each defeat persistence:

1. **No webview serializer.** VS Code discards all webviews on reload/restart.
   An extension must register a `WebviewPanelSerializer` for its view type to
   get them back. Raven registers none — `knit-output-panel.ts` only ever
   *creates* panels via `createWebviewPanel`. So the panel tab vanishes.

2. **Ephemeral artifacts.** The rendered `.html` / `.md` / `figure/` live under
   `<tmpdir>/raven-knit/<workspaceHash>/<sessionId>/preview/<sourceHash>/`. The
   `sessionId` is a fresh UUID on every activation (`knit/index.ts`), and
   `cleanupCurrentSession()` is wired as a deactivation disposable that
   `rm -rf`s the whole session root on window close. So even if the panel came
   back, the file it pointed at would be both gone and at an unreachable path.

Persistence therefore requires both: re-create the panel **and** ensure the
rendered artifact it reads still exists.

## Decisions (settled during brainstorming)

- **Scope:** survive `Reload Window` and a full quit-and-reopen. Both use the
  serializer mechanism. Artifacts stay in `os.tmpdir()`; reboot survival is
  explicitly out of scope.
- **Restore behavior:** show the last rendered HTML statically and silently —
  identical to how the panel looks right after a knit. No R subprocess.
- **Disable setting:** `raven.knit.persistPreview`, boolean, default `true`
  (the new behavior). Setting it `false` restores today's behavior.
- **Manual cleanup command:** `Raven: Clean Up Knit Preview Cache` removes
  *orphaned* dirs only — never a dir backing a panel open in this window, and
  never a dir written within a short age threshold (so a concurrent window's
  fresh files are spared).

## Approach

Register a `WebviewPanelSerializer` for `raven.knitOutput`, and on restore
**adopt** the orphaned old-session preview dir into the *current* session's
preview path for that source. Adoption keeps the path model consistent: a
later "Knit again" is a normal in-place update (same `rootDir`), not a
`rootDir` change that dispose-and-recreates the panel — and it folds the
orphaned old-`sessionId` dir back into the session tree so it isn't left for
the 7-day sweep. Per-session isolation (which protects concurrent windows) is
preserved.

(Note: the dispose-and-recreate branch in `showOrUpdate` is not itself a
data-loss risk today — the knit pipeline pins the preview dir before writing
and cancels any stale deletion after a successful write, so a re-knit that
changes `rootDir` does not delete fresh output. Adoption's value is therefore
path-consistency and orphan-avoidance, not race-avoidance.)

Rejected alternatives:

- **Leave artifacts in place, restore pointing at the old path.** Simpler, but
  the restored panel reads from an orphaned old-`sessionId` dir that the 7-day
  sweep eventually reclaims out from under a long-lived restored panel, and the
  first "Knit again" changes `rootDir` (old session → new session), forcing an
  unnecessary dispose-and-recreate. Adoption keeps everything in one session
  tree.
- **Relocate previews to `context.storageUri`.** Durable across reboot, but
  reboot is out of scope and this is the heaviest option (relocating `figure/`
  images, larger persistent storage footprint).

## Design

### 1. Panel serializer

Register in `registerKnit` (`knit/index.ts`):

```ts
vscode.window.registerWebviewPanelSerializer('raven.knitOutput', {
  deserializeWebviewPanel: async (panel, state) => {
    if (!persistPreviewEnabled()) { panel.dispose(); return; }
    await KnitOutputPanel.restore(context, panel, state, knitOutput);
  },
});
```

- **Activation event.** Add `"onWebviewPanel:raven.knitOutput"` to
  `editors/vscode/package.json` `activationEvents`. Without it, VS Code does
  not activate the extension to restore a serialized panel on a cold restart,
  and the serializer is never registered — the feature silently no-ops on
  restart (it would still work on in-window reload, masking the bug).
- The webview shell script (`knit-output.ts` / `buildShellHtml`) calls
  `acquireVsCodeApi().setState({ sourceFsPath, outputPath })` once on load so
  VS Code persists enough to reconstruct. (The shell already acquires the VS
  Code API for its `postMessage` calls; this adds a single `setState`.)
  `sourceFsPath` is **not currently threaded** into `buildShellHtml` — thread
  it `updateContent → buildShellHtml → inline <script>` alongside the existing
  `outputPath` arg.
- `state` shape: `{ sourceFsPath: string; outputPath: string }`. Validate
  defensively on deserialize — if either field is missing/not a string, **or**
  `outputPath` does not resolve inside the `<tmp>/raven-knit/` tree (see §2
  containment check), render the "no longer available" placeholder (see §3).
- New static `KnitOutputPanel.restore(context, panel, state, output)`:
  - Sets `panel.webview.options = { enableScripts: true, localResourceRoots:
    [Uri.file(rootDir)] }` where `rootDir = dirname(adoptedOutputPath)`. Only
    the `WebviewOptions` are settable post-construction; `enableFindWidget` and
    `retainContextWhenHidden` are `WebviewPanelOptions` fixed at creation and
    restored by VS Code from the serialized panel — do **not** try to assign
    them to `webview.options` (no-op / type error). If VS Code does not restore
    `retainContextWhenHidden`, the only consequence is the hidden-tab DOM is
    rebuilt from disk on reveal, which is harmless here.
  - Performs artifact adoption (§2) to compute the live `outputPath`.
  - Registers the instance in `KnitOutputPanel.instances` keyed by
    `sourceUri.fsPath`, wires the same theme/config/font listeners and
    `onDidDispose` handler as `create()`, applies the viewer tab icon, then
    runs `updateContent(...)`.
  - `create()` and `restore()` share a private helper for the
    listener/registry wiring so the two paths cannot drift.

`applyViewerTabIcon`, the `globalState` theme preference, and the live font
resolution all attach unchanged, so a restored panel themes and fonts itself
correctly with no extra work.

### 2. Artifact survival + adoption (gated on the setting)

**Deactivation cleanup** (`session-state.ts` `cleanupCurrentSession`, invoked by
the `knit/index.ts` deactivation disposable):

- When `persistPreview` is `true`: skip removal of `preview/` subdirs; still
  remove `export/` throwaways and any otherwise-empty session scaffolding.
  Closed panels already self-clean via the existing
  `onDidDispose → requestPreviewDirDeletion` path, so the only `preview/` dirs
  left at shutdown are those backing panels still open — exactly the set we
  must keep for restore. **This applies to both branches of
  `cleanupCurrentSession`**: the workspace branch (`workspaceHash !== null`,
  removes `sessionRoot`) and the single-file branch (`workspaceHash === null`,
  walks every `workspaceHash/<sessionId>` dir). Both must switch from
  "remove session root" to "remove only `export/` + empty scaffolding" when the
  flag is on.
- When `persistPreview` is `false`: today's behavior — remove the whole session
  root immediately (both branches unchanged).

**Adoption on restore** (new helper in a small new module, e.g.
`preview-persistence.ts`, keeping `raven-knit-paths.ts` free of `fs`-heavy
logic — `adoptPreviewArtifacts(sourceFsPath, persistedOutputPath)`):

1. **Containment check.** Reject unless `persistedOutputPath` resolves (via
   `realpath`, reusing `isUnderContainmentRoot`) inside
   `<tmp>/raven-knit/`. A corrupted or crafted persisted state must never drive
   a `rename`/`rm` on an arbitrary directory. On rejection → "missing"
   sentinel.
2. Compute current-session paths via `previewArtifactPaths(sourceFsPath)`
   → `{ previewDir: newDir, htmlPath: newHtml }`.
3. **Guard against an in-progress / completed current-session knit.** If
   `newDir` already exists (a knit ran or is running this session — VS Code may
   deserialize a hidden panel lazily, after a re-knit has started), do **not**
   adopt: return `newHtml` if it exists, else "missing". Never `rename`/copy
   into an existing destination, and never adopt while the source op is busy.
4. Else if `persistedOutputPath` exists: ensure `newDir`'s parent exists, then
   `fs.rename(oldPreviewDir, newDir)` (`oldPreviewDir =
   dirname(persistedOutputPath)`). On `EXDEV`/rename failure, fall back to
   recursive copy + best-effort remove of the source. `touch` `newDir` so the
   >7-day sweep clock resets. Return the adopted html path (basename derives
   from the stable `.Rmd` name).
5. Else: return "missing" → caller renders the placeholder.

The basename of the html under `newDir` is recomputed from `sourceFsPath` via
the same `previewArtifactPaths` logic, so adoption does not depend on parsing
the persisted path beyond locating the old dir.

**Orphan cleanup:** the existing `sweepStaleSessions` (>7 days, run at
activation) remains the passive backstop for old-session dirs that were never
adopted (window closed and never reopened). The new manual command (§4) gives
an active reclaim path.

### 3. Restore failure handling

If adoption returns "missing" (persisted `outputPath` gone — tmp cleared,
swept, or manually cleaned), `updateContent` renders a small in-iframe
placeholder instead of a broken/blank webview:

> This preview is no longer available. Press **Knit again** to regenerate it.

The toolbar's **Knit again** button works immediately — it only needs
`sourceUri`, which comes from the persisted `sourceFsPath`. (This reuses the
existing read-failure fallback branch in `updateContent`, with copy tuned for
the restore case.)

### 4. New setting `raven.knit.persistPreview`

- Boolean, default `true`. **`window` scope, not resource scope.** It is a
  behavior flag, not a per-document value like the font settings, and the
  deactivation-cleanup decision point has no source URI to resolve a
  resource-scoped value against — a `window`-scoped setting reads cleanly with
  a bare `getConfiguration('raven.knit').get('persistPreview', true)`.
- Read live (not cached at activation) at the two decision points: serializer
  deserialize and deactivation cleanup. Toggling it off mid-session takes
  effect at the next deactivation; the deserialize guard handles the "turned
  off between sessions" case by disposing the restored panel.
- Wiring: add to `editors/vscode/package.json` `configuration` schema →
  regenerate the alphabetical settings index with
  `bun editors/vscode/scripts/generate-settings-reference.mjs` (the drift test
  `tests/bun/settings-reference.test.ts` gates this) → document in
  `docs/knit.md` settings table and `docs/settings-reference.md`.
- **LSP wiring: not needed (confirmed).** No `raven.knit.*` setting flows
  through `editors/vscode/src/initializationOptions.ts` / `SETTINGS_MAPPING`
  (verified — none of the knit settings appear there; they are read directly
  via `getConfiguration` on the TS side). So the three-place LSP-setting wiring
  from CLAUDE.md does not apply: only the package.json + settings-reference +
  docs touchpoints are needed.

### 5. New command `Raven: Clean Up Knit Preview Cache` (`raven.knit.cleanupCache`)

- Registered alongside the other knit commands; gated by the same
  `raven.rConsole.activation` resolution. Title under the `Raven:` category.
- Algorithm — walk `<tmpdir>/raven-knit/`:
  - **Protect** any current-session `preview/<sourceHash>` dir that backs a
    panel open in *this* window (derive the protected set from
    `KnitOutputPanel.instances` keys → `previewArtifactPaths`).
  - **Protect** any dir whose mtime is within a short threshold
    (e.g. `5 * 60 * 1000` ms) so a concurrent window's just-written files are
    not yanked away mid-knit.
  - **Remove** everything else (`rm -rf`, best-effort, errors logged to the
    Knit output channel).
- On completion, show an information notification reporting how many dirs /
  roughly how much space was freed (best-effort byte count, or just a count if
  sizing is too slow).
- **Concurrency caveat (honestly documented).** Session ownership cannot be
  determined cross-process, so the age threshold — not ownership — is what
  spares another window's files. The residual gap: a preview open in another
  window, idle for longer than the threshold, can have its temp dir removed.
  The severity is limited because that window's panel uses
  `retainContextWhenHidden`, so the *running* panel keeps its rendered DOM in
  memory and is unaffected; only a *future* restore of that panel would fall
  back to the "knit again" placeholder. We accept this for a manual,
  user-invoked command and document it in `docs/knit.md`.
- **Optional hardening (deferred, flagged for the user).** If cross-window
  restore-survival turns out to matter, a per-preview lease file (touched by
  open panels on render/restore and on a modest interval) would let cleanup
  distinguish "live elsewhere" from "orphaned" without relying on age. This
  adds a per-panel timer; not built in v1 unless requested.

### 6. Untouched

- Theme toggle persistence (`globalState`) and font resolution (live config)
  already survive reload; restored panels pick them up via the existing
  listeners.
- No R subprocess runs on restore.
- Each previously-open `.Rmd` panel restores independently — VS Code calls
  `deserializeWebviewPanel` once per persisted panel.
- The per-source panel registry, in-flight export gate, preview-dir refcount
  pinning, and the `>7-day` sweep all stay as-is.

## Testing

**Bun units:**

- Adoption helper: new-empty + old-exists → moves dir, returns adopted html;
  old-gone → returns "missing" sentinel; both-exist → returns existing new html
  without clobbering; rename `EXDEV` → copy-then-remove fallback path.
- Cleanup selector (pure function over a directory listing + protected set +
  now): protect-by-open-set, protect-by-age-threshold, delete-rest. Keep the
  filesystem walk and the selection predicate separate so the predicate is
  unit-testable without touching disk.

**`vscode-test` integration:**

- Drive `deserializeWebviewPanel` with synthetic `{ sourceFsPath, outputPath }`
  state pointing at a fixture html → assert a panel is registered in
  `KnitOutputPanel.instances` and its content reflects the adopted file.
- With `raven.knit.persistPreview: false` → assert the deserialize callback
  disposes the panel and registers nothing.
- Deactivation cleanup with `persistPreview: true` leaves an open panel's
  `preview/` dir intact; with `false` removes the session root.

**Drift/CI:** `tests/bun/settings-reference.test.ts` after regenerating the
settings index; `cargo fmt`/`clippy` unaffected (no Rust changes expected).

## Docs to update

- `docs/knit.md`: the "static viewer" framing (note that the panel now
  restores on reload/restart), the temp-dir lifecycle paragraph (currently
  states the dir is removed on exit — qualify with the `persistPreview`
  behavior), the settings table (new `raven.knit.persistPreview` row), and a
  short entry for the new cleanup command.
- `docs/settings-reference.md`: regenerated.
- `editors/vscode/package.json`: `activationEvents` (`onWebviewPanel:raven.knitOutput`),
  command contribution (`raven.knit.cleanupCache`), and the
  `raven.knit.persistPreview` setting.

## Open implementation questions (resolve during build, not blocking)

- Whether `setState` belongs in the existing shell script or a tiny added
  inline script block — pick whichever keeps the CSP nonce handling simplest.
- The cleanup command's space-reporting fidelity (count vs bytes).

## Review

This spec was adversarially reviewed by Codex (2026-06-22). Incorporated:
the missing `onWebviewPanel:` activation event (§1), the
`WebviewOptions`/`WebviewPanelOptions` split (§1), `window`-scope for the
setting (§4), the adoption guard against an in-progress current-session knit
and the path-containment check (§2), the single-file-mode cleanup branch (§2),
and `sourceFsPath` threading (§1). The cleanup cross-window concern (§5) was
calibrated — the running panel is unaffected (`retainContextWhenHidden`), so
the age-threshold approach is kept with the limitation documented and a
lease-file hardening flagged as deferred. The overstated adoption-vs-race
rationale was softened (the knit pipeline already guards that race).
