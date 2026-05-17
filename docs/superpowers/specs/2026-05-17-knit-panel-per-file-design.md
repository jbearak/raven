# R Markdown Knit — Per-`.Rmd` Output Panels

**Status**: Design.
**Date**: 2026-05-17.
**Branch**: `further-improve-knit`.
**Amends**: [`2026-05-17-knit-output-webview-design.md`](2026-05-17-knit-output-webview-design.md) — supersedes the singleton paragraphs of that spec (the non-goal "A multi-tab 'history' of past knits. The panel is a singleton…" and the "Singleton: one panel per VS Code window" doc comment). Everything else in the 2026-05-17 spec (iframe-sandbox shell, CSP, progress-lifecycle fix, message protocol, security model) is unchanged.

## Why this spec exists

When a user is editing two or more `.Rmd` files in one VS Code window, the current singleton `KnitOutputPanel` shows whichever was knit last. Knitting `B.Rmd` blows away the view of `A.Rmd`'s output, and the toolbar's `Refresh` button silently retargets from A to B. A side-by-side view of two rendered outputs is impossible without splitting the editor manually and re-knitting.

This spec replaces the singleton with a per-source-path registry: each `.Rmd` gets its own `Knit Output` webview panel, all anchored in a tracked "preview column" so they stack as tabs in one place rather than scattering across the workspace.

## Goals

1. Knitting `A.Rmd` and `B.Rmd` in the same window produces two distinct panels, both visible until the user closes them.
2. Re-knitting `A.Rmd` updates A's panel in place — the `Refresh` button on each panel remains bound to *its* source `.Rmd` for the life of the panel.
3. New panels open in the same column as existing knit panels (they stack as tabs), so the user does not have to rearrange the workspace after each knit.
4. No new commands, no new settings. The webview shell HTML, CSP, sandbox, message protocol, theme handling, and security model are unchanged.

## Non-goals

- Hard cap on the number of simultaneous panels. (VS Code's own tab-strip limits apply.)
- Restoring panels across window reloads. `retainContextWhenHidden: true` continues to handle hide/show within a session; full session restore requires a webview serializer and is deferred.
- Cross-window coordination. Each VS Code window has its own extension host and its own panel registry.
- Auto-disposing a panel when the source `.Rmd` editor closes. The panel survives until the user closes it manually. The `Refresh` button continues to work because `sourceUri` was captured at panel creation.
- A "history" of past renders for the same `.Rmd`. Re-knitting `A.Rmd` always replaces A's panel content — there is one panel per source path, not one per knit invocation.

## Architecture

```text
editors/vscode/src/knit/
  knit-output-panel.ts    # CHANGED: singleton → per-source-path registry + preview-column tracking
  knit-commands.ts        # UNCHANGED: still calls KnitOutputPanel.showOrUpdate(context, args)
  knit-output.ts          # UNCHANGED
  knit-engine.ts          # UNCHANGED
  ...
```

No changes to `package.json`, settings schema, context keys, or the message protocol. No changes to the iframe shell HTML or CSP. No changes outside `knit-output-panel.ts` and its tests.

## State model

```ts
export class KnitOutputPanel {
    private static instances = new Map<string, KnitOutputPanel>();
    private static previewColumn: vscode.ViewColumn | undefined;

    // Per-instance fields are unchanged from the singleton design:
    private panel: vscode.WebviewPanel;
    private rootDir: string;
    private sourceUri: vscode.Uri;
    private outputPath: string;
    private readonly output: vscode.OutputChannel;
    private readonly context: vscode.ExtensionContext;
    // …
}
```

- **`instances` key**: `sourceUri.toString()`. Using the URI rather than `fsPath` gives free, platform-correct normalization (Windows drive-letter case, URI-encoding of spaces, etc.) and is the same value the rest of the extension keys on.
- **`previewColumn`**: the concrete `vscode.ViewColumn` (1, 2, 3, …) that the first surviving knit panel was placed in. Used to anchor subsequent *new* panels. Reset to `undefined` whenever no surviving panel occupies it.

## `showOrUpdate` flow

```ts
static async showOrUpdate(
    context: vscode.ExtensionContext,
    args: { sourceUri: vscode.Uri; outputPath: string; output: vscode.OutputChannel },
): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        await fs.promises.access(args.outputPath, fs.constants.R_OK);
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const key = args.sourceUri.toString();
    const rootDir = path.dirname(args.outputPath);
    const existing = KnitOutputPanel.instances.get(key);

    if (existing && existing.rootDir === rootDir) {
        existing.updateContent({ sourceUri: args.sourceUri, outputPath: args.outputPath });
        existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
        return { ok: true };
    }

    if (existing) {
        // localResourceRoots is immutable post-creation — dispose+recreate in
        // the same column. Scoped to this source; other panels untouched.
        const column = existing.panel.viewColumn ?? vscode.ViewColumn.Beside;
        existing.panel.dispose(); // onDidDispose deletes the Map entry.
        KnitOutputPanel.create(context, args, rootDir, column);
        return { ok: true };
    }

    const column = KnitOutputPanel.previewColumn ?? vscode.ViewColumn.Beside;
    KnitOutputPanel.create(context, args, rootDir, column);
    return { ok: true };
}
```

## Column tracking

Inside `create`, after `vscode.window.createWebviewPanel(...)`:

```ts
const resolved = panel.viewColumn;
if (resolved !== undefined && KnitOutputPanel.previewColumn === undefined) {
    KnitOutputPanel.previewColumn = resolved;
}
```

The first surviving knit anchors the preview column. From then on, `previewColumn` stays put until the registry stops occupying it.

**`onDidChangeViewState`** — when a panel is dragged to a different column:

```ts
panel.onDidChangeViewState(() => KnitOutputPanel.recomputePreviewColumn());
```

```ts
private static recomputePreviewColumn(): void {
    const target = KnitOutputPanel.previewColumn;
    if (target === undefined) return;
    let stillThere = false;
    for (const inst of KnitOutputPanel.instances.values()) {
        if (inst.panel.viewColumn === target) {
            stillThere = true;
            break;
        }
    }
    if (!stillThere) KnitOutputPanel.previewColumn = undefined;
}
```

**`onDidDispose`** per instance:

```ts
panel.onDidDispose(() => {
    KnitOutputPanel.instances.delete(key);
    if (KnitOutputPanel.instances.size === 0) {
        KnitOutputPanel.previewColumn = undefined;
    } else {
        KnitOutputPanel.recomputePreviewColumn();
    }
});
```

## Per-instance behavior (unchanged)

- The constructor captures `context`, `panel`, `rootDir`, `sourceUri`, `outputPath`, `output` exactly as today.
- `updateContent` regenerates the shell HTML each call. Title is `Knit Output: ${path.basename(outputPath)}` — same as today, which already disambiguates panels in the tab strip.
- `handleMessage` dispatches `refresh`, `openInBrowser`, `themeChanged` against the captured `sourceUri` / `outputPath` of *that* instance. No registry lookups.
- Theme preference is global (lives in `context.globalState`, key `raven.knit.applyVSCodeTheme`). Changing the toggle on one panel does not retro-apply to other open panels in this session — applies on the next `updateContent` (i.e. the next knit of that file). Documented as the intentional shape, mirroring how the existing singleton already behaves across knits.

## Edge cases

| Scenario | Behavior |
|--|--|
| Knit `A.Rmd`, close A's editor, knit `A.Rmd` again via explorer context menu | Panel for A is found in the Map by `sourceUri.toString()` and reused. The closed editor is irrelevant. |
| Same `.Rmd` opened in two VS Code windows | Each window has its own extension host and `instances` Map. No cross-window interference. |
| User drags A's panel into the editor column (column 1) where A.Rmd lives | `onDidChangeViewState` fires; `recomputePreviewColumn` checks whether any other knit panel still occupies the old preview column. If not, `previewColumn = undefined` and the next *new* knit re-anchors to `Beside`. |
| Same `.Rmd` knit produces output to a different directory on the second run | A's existing panel is disposed and recreated in *its* current column (the `rootDir`-mismatch branch). Other panels are untouched. |
| Multi-output knit (HTML + PDF) | Unchanged: HTML wins for the panel, additional paths go to the `Raven: Knit` output channel. The Map is keyed by source, not output. |
| `Refresh` invoked while a knit of the same file is in flight | Existing `inFlight` Set in `knit-commands.ts` fires the "already being knitted" toast. Unchanged. |
| 20+ different `.Rmd`s knit in one session | No hard cap. VS Code's tab-strip handles overflow. Documented as expected. |
| User reloads the VS Code window | All panels are lost (no webview serializer). On the next knit, fresh panels are created. Same as today. |

## Security model

Unchanged from `2026-05-17-knit-output-webview-design.md`. Each panel has the same three independent layers:

1. **`iframe sandbox=""`** — blocks scripts, forms, popups, top-navigation, same-origin access in the rendered HTML.
2. **Outer-shell CSP** in `<head>` — `default-src 'none'`, `frame-src ${cspSource}`, `script-src 'nonce-${nonce}'`, `connect-src 'none'`.
3. **`localResourceRoots`** confined to *that panel's* `path.dirname(outputPath)`.

Because each instance owns its own `localResourceRoots`, panels cannot read each other's output directories. Going from one to many panels does not widen the security surface.

## Error handling

Same as the prior spec, scoped per source:

| Condition | Surface |
|--|--|
| Rendered HTML not readable (`fs.access` fails) | `showOrUpdate` returns `{ ok: false, error }`. Caller in `knit-commands.ts` logs to the output channel and falls back to `revealFileInOS`. Other panels untouched. |
| Refresh on a file whose source `.Rmd` was deleted | `raven.knit` runs and fails its YAML parse / file-existence check; the panel stays visible showing the last successful render. |
| `vscode.env.openExternal` returns false on Open in Browser | Warning toast + path written to the output channel. Unchanged. |

## Configuration

No new settings.

## Commands

No new commands. `Refresh` continues to invoke `raven.knit` against each panel's captured `sourceUri`.

## Testing

### Bun unit tests (`tests/bun/`)

No changes. `knit-output-shell.test.ts`, `knit-output-message.test.ts`, `knit-output-classify.test.ts`, `knit-output-pick-primary.test.ts`, `knit-output-shell.test.ts` exercise pure functions that do not touch the registry.

### VS Code suite (`editors/vscode/src/test/`)

**Updated:**

- **`knit-output-panel.test.ts`** — the existing "second knit reuses the same panel reference" case splits into:
  - re-knit *same* `sourceUri` reuses the same `WebviewPanel`;
  - knit a *different* `sourceUri` produces a second instance in the Map; both `WebviewPanel`s are alive.

**New:**

- **`knit-multi-panel.test.ts`** — knit `A.Rmd`, knit `B.Rmd`. Assert: `getInstancesForTesting().size === 2`, both panels share `viewColumn === previewColumn`. Re-knit `A.Rmd` and assert `instances.size === 2` still (no new panel for the same key) and that A's panel reference is identical to the pre-existing one.
- **`knit-preview-column.test.ts`** — knit `A.Rmd`, capture the column VS Code assigned, dispose A's panel; knit `B.Rmd`, assert it opens in `ViewColumn.Beside` (preview column was reset on Map-empty). Then knit `A.Rmd` again and assert A's new panel lands in B's column (the new preview column).

Test-only statics on `KnitOutputPanel`:

```ts
static getInstancesForTesting(): ReadonlyMap<string, KnitOutputPanel> { return KnitOutputPanel.instances; }
static getPreviewColumnForTesting(): vscode.ViewColumn | undefined { return KnitOutputPanel.previewColumn; }
static disposeAllForTesting(): void {
    for (const inst of [...KnitOutputPanel.instances.values()]) inst.panel.dispose();
    KnitOutputPanel.previewColumn = undefined;
}
```

The existing `disposeForTesting()` / `getInstanceForTesting()` are renamed and updated. Callers in the test suite update accordingly.

### Manual smoke

- Open two `.Rmd`s. Knit one, then the other. Verify both panels appear in the same column, stacked as tabs.
- Re-knit the first. Verify its tab updates in place and the second panel is untouched.
- Drag the first panel into the editor column. Knit a third `.Rmd`. Verify the third panel anchors to whichever column the second panel occupies (the preview column was recomputed when the first was dragged).
- Close all knit panels. Knit any `.Rmd`. Verify the panel opens `Beside` again (preview column was reset).
- Reload the window with two knit panels open. Verify both vanish (expected, no serializer). Knit either `.Rmd` and verify fresh panels are created.

## Documentation updates

- `docs/knit.md`, step 10 ("Reveal") — change "the **Knit Output** webview panel" to "a **Knit Output** webview panel for that `.Rmd`," and add one sentence: "Multiple `.Rmd` files can have panels open at once; new panels stack as tabs alongside any existing knit panels."
- `docs/knit.md` non-goals — remove any wording implying the panel is a singleton.
- `docs/development.md` — short note: `KnitOutputPanel` keeps a per-`sourceUri` registry and tracks a "preview column" for new panels. Cross-link from `help-panel.ts`'s doc comment (which remains singleton — distinct domain, only one R-help context per session).
- `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md` — link this spec in the header as a successor for the singleton paragraphs.

## Open questions

1. **`onDidChangeViewState` cost** — fires on every visibility / state change, not just column moves. The handler does an O(n) Map walk; with realistic n ≤ ~10, the overhead is negligible. If users report panel-switching jank with many panels, debounce or compare against a cached column before walking.
2. **Tab grouping (drag-as-group)** — VS Code does not expose programmatic tab grouping. Users can manually group knit panels via the tab-strip context menu. Out of scope.
