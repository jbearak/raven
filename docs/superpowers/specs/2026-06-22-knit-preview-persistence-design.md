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
`rootDir` change that would dispose-and-recreate the panel and confuse the
existing refcount/disposal logic. Per-session isolation (which protects
concurrent windows) is preserved.

Rejected alternatives:

- **Leave artifacts in place, restore pointing at the old path.** Simpler, but
  the restored panel reads from an orphaned old-`sessionId` dir; the first
  "Knit again" writes to the new session dir → `rootDir` changes →
  dispose-and-recreate, and the disposal handler (which computes the *current*
  session's preview dir) can race to delete the freshly-written dir. Adoption
  avoids this entire class of bug.
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

- The webview shell script (`knit-output.ts` / `buildShellHtml`) calls
  `acquireVsCodeApi().setState({ sourceFsPath, outputPath })` once on load so
  VS Code persists enough to reconstruct. (The shell already acquires the VS
  Code API for its `postMessage` calls; this adds a single `setState`.)
- `state` shape: `{ sourceFsPath: string; outputPath: string }`. Validate
  defensively on deserialize — if either field is missing or not a string,
  render the "no longer available" placeholder (see §3).
- New static `KnitOutputPanel.restore(context, panel, state, output)`:
  - Sets `panel.webview.options` to match `create()`'s options
    (`enableScripts`, `enableFindWidget`, `retainContextWhenHidden`,
    `localResourceRoots: [Uri.file(rootDir)]` where `rootDir =
    dirname(adoptedOutputPath)`). `localResourceRoots` **can** be set in
    `deserializeWebviewPanel` because the panel is handed to us before first
    paint.
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
  must keep for restore.
- When `persistPreview` is `false`: today's behavior — remove the whole session
  root immediately.

**Adoption on restore** (new pure-ish helper, e.g.
`adoptPreviewArtifacts(sourceFsPath, persistedOutputPath)` in
`raven-knit-paths.ts` or a small new module):

1. Compute the current-session paths via `previewArtifactPaths(sourceFsPath)`
   → `{ previewDir: newDir, htmlPath: newHtml }`.
2. If `newHtml` already exists, use it as-is (a knit already ran this session;
   nothing to adopt).
3. Else if `persistedOutputPath` exists on disk: ensure `newDir`'s parent
   exists, then `fs.rename(oldPreviewDir, newDir)` (where `oldPreviewDir =
   dirname(persistedOutputPath)`). On `EXDEV` or any rename failure, fall back
   to a recursive copy then best-effort remove of the source. `touch` `newDir`
   (update mtime) so the >7-day stale sweep clock resets for the adopted dir.
   Return the adopted html path (basename preserved — the basename derives from
   the `.Rmd` name, which is stable across sessions).
4. Else (no live artifact anywhere): return a sentinel indicating "missing", so
   the caller renders the placeholder.

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

- Boolean, default `true`, resource-scoped (matches the other `raven.knit.*`
  settings so it can be overridden per-folder).
- Read live via `vscode.workspace.getConfiguration('raven.knit').get(
  'persistPreview', true)` at the two decision points: serializer deserialize
  and deactivation cleanup. Reading live (not cached at activation) means
  toggling it off mid-session takes effect at the next deactivation, and the
  deserialize guard handles the "turned off between sessions" case by disposing
  the restored panel.
- Wiring: add to `editors/vscode/package.json` `configuration` schema →
  regenerate the alphabetical settings index with
  `bun editors/vscode/scripts/generate-settings-reference.mjs` (the drift test
  `tests/bun/settings-reference.test.ts` gates this) → document in
  `docs/knit.md` settings table and `docs/settings-reference.md`.
- **LSP wiring check:** this is a TS-side knit-pipeline setting read directly
  via `getConfiguration`, not consumed by the Rust backend. During
  implementation, confirm no knit setting flows through
  `editors/vscode/src/initializationOptions.ts` / `SETTINGS_MAPPING`; if none
  do, the three-place LSP-setting wiring from CLAUDE.md does not apply and only
  the package.json + settings-reference + docs touchpoints are needed.

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
- Concurrency caveat documented: with two windows on the same workspace, the
  age threshold — not session ownership — is what protects the *other* window's
  files, because session ownership cannot be determined cross-process. The
  threshold makes this safe in practice.

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
- `editors/vscode/package.json`: command + setting contributions.

## Open implementation questions (resolve during build, not blocking)

- Exact module home for the adoption + cleanup-selector helpers (extend
  `raven-knit-paths.ts` vs a new `preview-persistence.ts`). Lean toward a new
  small module to keep `raven-knit-paths.ts` free of `fs`-heavy logic.
- Whether `setState` belongs in the existing shell script or a tiny added
  inline script block — pick whichever keeps the CSP nonce handling simplest.
- The cleanup command's space-reporting fidelity (count vs bytes).
