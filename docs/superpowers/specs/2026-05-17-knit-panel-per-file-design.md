# R Markdown Knit — Per-`.Rmd` Output Panels

**Status**: Design.
**Date**: 2026-05-17.
**Branch**: `further-improve-knit`.
**Amends**: [`2026-05-17-knit-output-webview-design.md`](2026-05-17-knit-output-webview-design.md) — supersedes the singleton paragraphs of that spec (the non-goal "A multi-tab 'history' of past knits. The panel is a singleton…" and the "Singleton: one panel per VS Code window" doc comment). The CSP `<head>` placement, `localResourceRoots` confinement, progress-lifecycle fix, and `pickPrimaryOutput` semantics from the 2026-05-17 spec are unchanged. The sandbox attribute (`allow-same-origin`, not `""`), the loading mechanism (`srcdoc` + `<base href>` + a narrow fragment-anchor rewrite, not iframe `src`), and the message protocol (three typed messages plus two diagnostic-only messages, not two) all diverged from the prior spec's text during implementation; this spec describes what is actually in the code today and treats those as authoritative. See "Security model" and "Per-instance behavior" below.

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
    if (KnitOutputPanel.instances.size === 0) {
        KnitOutputPanel.previewColumn = undefined;
        return;
    }
    const target = KnitOutputPanel.previewColumn;
    if (target !== undefined) {
        for (const inst of KnitOutputPanel.instances.values()) {
            if (inst.panel.viewColumn === target) return; // still occupied
        }
    }
    // Either no preview column was set, or the recorded one is no longer
    // occupied. Adopt the column of any surviving panel so the next new
    // knit lands next to the existing one rather than scattering to
    // ViewColumn.Beside. (Pick the first iteration order; in practice all
    // panels cluster in the same column.)
    for (const inst of KnitOutputPanel.instances.values()) {
        const col = inst.panel.viewColumn;
        if (col !== undefined) {
            KnitOutputPanel.previewColumn = col;
            return;
        }
    }
    KnitOutputPanel.previewColumn = undefined;
}
```

**`onDidDispose`** per instance:

```ts
panel.onDidDispose(() => {
    // Guard against a stale dispose listener for an instance that has
    // since been replaced under the same key (the rootDir-mismatch
    // branch disposes the old panel and inserts a new one). VS Code's
    // dispose() is synchronous today, but the guard makes the
    // invariant explicit and survives any future async change.
    if (KnitOutputPanel.instances.get(key) === instance) {
        KnitOutputPanel.instances.delete(key);
    }
    KnitOutputPanel.recomputePreviewColumn();
});
```

The dispose handler captures the instance it was registered for (closure over `instance`). The replacement panel registers its own `onDidDispose` for the *new* instance.

## Per-instance behavior (unchanged)

- The constructor captures `context`, `panel`, `rootDir`, `sourceUri`, `outputPath`, `output` exactly as today.
- `updateContent` regenerates the shell HTML each call. Title is `Knit Output: ${path.basename(outputPath)}` — same as today, which already disambiguates panels in the tab strip.
- `handleMessage` dispatches three typed message types against the captured `sourceUri` / `outputPath` of *that* instance: `{type: 'refresh'}`, `{type: 'openInBrowser'}`, `{type: 'themeChanged', applied: boolean}`. No registry lookups. The `themeChanged` message updates the global theme preference (see below) and is *not* documented in the prior spec's protocol section (which lists only `refresh` / `openInBrowser`); it was added in `4270fc8 feat(knit): fix white iframe + overhaul panel UX`. The webview shell additionally posts `{type: 'iframeProbe', …}` and `{type: 'cspViolation', …}` messages for in-iframe load diagnostics and CSP-violation surfacing. These are *not* members of `KnitOutputMessage` and `isKnitOutputMessage` returns false for them, so the extension-side handler silently drops them. They exist only so tests / future telemetry can observe iframe state via a dedicated listener; the per-file-panel work does not touch them. This spec treats the implemented three-typed-message + two-diagnostic-message protocol as authoritative.
- Theme preference is global (lives in `context.globalState`, key `raven.knit.applyVSCodeTheme`). Changing the toggle on one panel does not retro-apply to other open panels in this session — applies on the next `updateContent` (i.e. the next knit of that file). Documented as the intentional shape, mirroring how the existing singleton already behaves across knits.

## Edge cases

| Scenario | Behavior |
|--|--|
| Knit `A.Rmd`, close A's editor, knit `A.Rmd` again via explorer context menu | Panel for A is found in the Map by `sourceUri.toString()` and reused. The closed editor is irrelevant. |
| Same `.Rmd` opened in two VS Code windows | Each window has its own extension host and `instances` Map. No cross-window interference. |
| User drags A's panel into a different column (e.g. column 1 where A.Rmd lives) | `onDidChangeViewState` fires; `recomputePreviewColumn` runs. If any other knit panel still occupies the old preview column, `previewColumn` stays put (subsequent knits stack with the cluster that didn't move). If A was the only one, `previewColumn` *adopts* A's new column so the next knit lands next to A rather than scattering to `Beside`. |
| Same `.Rmd` knit produces output to a different directory on the second run | A's existing panel is disposed and recreated in *its* current column (the `rootDir`-mismatch branch). Other panels are untouched. |
| Multi-output knit (HTML + PDF) | Unchanged: HTML wins for the panel, additional paths go to the `Raven: Knit` output channel. The Map is keyed by source, not output. |
| `Refresh` invoked while a knit of the same file is in flight | Existing `inFlight` Set in `knit-commands.ts` fires the "already being knitted" toast. Unchanged. |
| 20+ different `.Rmd`s knit in one session | No hard cap. VS Code's tab-strip handles overflow. Documented as expected. |
| User reloads the VS Code window | All panels are lost (no webview serializer). On the next knit, fresh panels are created. Same as today. |

## Security model

Each panel reuses the three-layer model already implemented in `knit-output-panel.ts` + `knit-output.ts`. Going from one to many panels does not widen the security surface; each layer is per-instance.

1. **`iframe sandbox="allow-same-origin"`** — blocks scripts, forms, popups, and top-navigation in the rendered HTML. `allow-same-origin` is set (rather than the empty `sandbox=""` that the prior spec described) because an opaque-origin sandbox bypasses the VS Code webview service worker, causing `ERR_NAME_NOT_RESOLVED` on `vscode-cdn.net` resources; `allow-same-origin` re-enters the SW scope without enabling scripts or forms. The trade-off (rendered HTML inside the iframe can read its own DOM via JS that we would otherwise have allowed — but `sandbox` strips script execution regardless, so this is moot) is documented in the doc comment on `buildShellHtml`.
2. **Outer-shell CSP** in `<head>` — `default-src 'none'`, `frame-src ${cspSource}`, `script-src 'nonce-${nonce}'`, `connect-src 'none'`.
3. **`localResourceRoots`** confined to *that panel's* `path.dirname(outputPath)`. Two panels for `A.Rmd` and `B.Rmd` whose outputs live in different directories receive different roots — neither can resolve resources from the other's directory.

**Loading mechanism** (also unchanged from the implementation, but worth restating because the prior spec is imprecise): the rendered HTML is read from disk via `fs.readFileSync`, run through `rewriteFragmentAnchors` (see below), and embedded as `srcdoc` on the iframe, with a `<base href>` set to the webview URI of the output's directory so relative subresources resolve through `localResourceRoots`. This is *not* iframe `src` loading; the prior spec's `src="${asWebviewUri(outputPath)}"` text described a design that was changed during implementation to work around nested-iframe navigation issues with `webview.asWebviewUri`.

**`rewriteFragmentAnchors`** is a single targeted regex rewrite that only touches `<a href="#frag">` attribute values, replacing them with `<a href="about:srcdoc#frag">`. It is required because the `<base href>` we inject — needed for relative subresources — would otherwise turn intra-document fragment clicks into full document navigations, which fail in the nested-frame setup. The rewrite is documented in detail on the function itself (`knit-output.ts:583-618`) including the *intentionally* unrewritten cases (`href="page.html#x"`, empty/`"#"` hrefs, non-`<a>` elements, hrefs containing `<`/`>`/whitespace).

Security implication: the prior spec disfavored Raven-side HTML rewriting because a *general* rewriter that misses cases could re-serialize untrusted HTML through Raven's hands. `rewriteFragmentAnchors` is narrow enough that the failure mode is "TOC anchor falls back to a no-op navigation," not script-execution. The sandbox + CSP + `localResourceRoots` stack still governs everything the iframe does, regardless of whether the rewrite succeeds or partially fails on adversarial input. This spec does not change the rewriter; it is documented here so future maintainers do not "discover" it and undo it.

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

- **`knit-multi-panel.test.ts`** — knit `A.Rmd`, knit `B.Rmd` (with outputs under distinct directories). Assert:
  - `getInstancesForTesting().size === 2`;
  - both `getPanelForTesting().viewColumn` values equal `getPreviewColumnForTesting()`;
  - A's and B's `getPanelForTesting().webview.options.localResourceRoots` are *distinct*, each containing only its own output directory (per-panel isolation claim);
  - re-knit `A.Rmd` and assert `instances.size === 2` still (no new panel for the same key) and that the `WebviewPanel` reference from `getPanelForTesting()` is identical to the pre-existing one.
- **`knit-preview-column.test.ts`** — knit `A.Rmd`, capture the column VS Code assigned via `getPreviewColumnForTesting()`, dispose A's panel via `disposeAllForTesting()`; knit `B.Rmd`, assert it opens in `ViewColumn.Beside` (preview column was reset on Map-empty). Then knit `A.Rmd` again and assert A's new panel lands in B's column (the new preview column).
- **`knit-rootdir-change.test.ts`** — knit `A.Rmd` so its output lives under `/tmp/dir1/`. Assert `getPanelForTesting().webview.options.localResourceRoots` contains `/tmp/dir1`. Re-invoke `showOrUpdate` with the *same* sourceUri but an `outputPath` under `/tmp/dir2/`. Assert: the original `WebviewPanel` reference observed earlier no longer matches what `getInstancesForTesting().get(key)?.getPanelForTesting()` returns (it has been disposed and replaced); the new panel's `localResourceRoots` contains `/tmp/dir2`; the new panel's `viewColumn` matches the captured old `viewColumn`; `instances.size === 1`. This is the highest-risk lifecycle branch and was previously only manually smoked.
- **`knit-recompute-preview-column.test.ts`** — unit test for `recomputePreviewColumn` driven via `setInstancesForTesting(fakes)` + `setPreviewColumnForTesting(col)` + `recomputePreviewColumnForTesting()`. Cases (each starts with `disposeAllForTesting()` to reset state):
  - empty fakes, previewColumn = One → previewColumn becomes undefined;
  - one fake in One, previewColumn = One → stays One;
  - one fake in One, previewColumn = Two (no fakes at Two) → adopts One;
  - two fakes split (One, Two), previewColumn = One → stays One;
  - two fakes both in Three, previewColumn = One → adopts Three.
  Drives the panel-drag scenario without needing VS Code to simulate a real drag.

### Test-only API on `KnitOutputPanel`

The new tests require accessors that the production interface does not expose. All are gated by name suffix `…ForTesting`, mirroring the existing `disposeForTesting` / `getInstanceForTesting` conventions:

```ts
// Registry inspection.
static getInstancesForTesting(): ReadonlyMap<string, KnitOutputPanel>;
static getPreviewColumnForTesting(): vscode.ViewColumn | undefined;
static disposeAllForTesting(): void;

// Per-instance inspection — needed because `panel` and its `webview.options`
// are private. Returns the underlying objects so tests can assert on
// viewColumn and localResourceRoots without unsafe casts.
getPanelForTesting(): vscode.WebviewPanel;
getRootDirForTesting(): string;

// Recompute driver — enables knit-recompute-preview-column.test.ts to
// exercise the column-tracking state machine through controlled fake
// instances rather than relying on VS Code to simulate a real drag.
static setInstancesForTesting(fakes: ReadonlyArray<{ key: string; viewColumn: vscode.ViewColumn | undefined }>): void;
static recomputePreviewColumnForTesting(): void;
static setPreviewColumnForTesting(col: vscode.ViewColumn | undefined): void;
```

`setInstancesForTesting` installs lightweight stand-ins (objects shaped like `{ panel: { viewColumn } }`) into the static `instances` Map, bypassing real `createWebviewPanel`. The recompute logic only reads `inst.panel.viewColumn`, so duck-typing is sufficient. `disposeAllForTesting` clears the Map and `previewColumn` regardless of how entries were inserted (real or fake), so production tests can interleave with recompute tests.

The existing `disposeForTesting()` / `getInstanceForTesting()` are renamed (`disposeAllForTesting` / `getInstancesForTesting`) and the existing test callers update accordingly.

### Manual smoke

- Open two `.Rmd`s. Knit one, then the other. Verify both panels appear in the same column, stacked as tabs.
- Re-knit the first. Verify its tab updates in place and the second panel is untouched.
- Drag the first panel into the editor column. Knit a third `.Rmd`. Verify the third panel anchors to whichever column the second panel occupies (the preview column was recomputed when the first was dragged).
- Close all knit panels. Knit any `.Rmd`. Verify the panel opens `Beside` again (preview column was reset).
- Reload the window with two knit panels open. Verify both vanish (expected, no serializer). Knit either `.Rmd` and verify fresh panels are created.

## Documentation updates

- `docs/knit.md`, step 10 ("Reveal") — change "the **Knit Output** webview panel" to "a **Knit Output** webview panel for that `.Rmd`," and add one sentence: "Multiple `.Rmd` files can have panels open at once; new panels stack as tabs alongside any existing knit panels."
- `docs/knit.md` non-goals — remove any wording implying the panel is a singleton.
- `docs/development.md` — **supersedes** the singleton-panel pattern note that the prior 2026-05-17 spec added (so the two specs do not leave the development docs describing two contradictory architectures). New text: `KnitOutputPanel` keeps a per-`sourceUri` registry and tracks a "preview column" for new panels. Cross-link from `help-panel.ts`'s doc comment (which remains singleton — distinct domain, only one R-help context per session).
- `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md` — link this spec in the header as a successor for the singleton paragraphs.

## Open questions

1. **`onDidChangeViewState` cost** — fires on every visibility / state change, not just column moves. The handler does an O(n) Map walk; with realistic n ≤ ~10, the overhead is negligible. If users report panel-switching jank with many panels, debounce or compare against a cached column before walking.
2. **Tab grouping (drag-as-group)** — VS Code does not expose programmatic tab grouping. Users can manually group knit panels via the tab-strip context menu. Out of scope.

## v2 → v3 changes (response to second Codex pass)

| Codex finding | v3 disposition |
| --            | --             |
| #1 Header "unchanged" framing contradicts the patched sandbox/protocol/loading details | Header rewritten to enumerate what is *actually* unchanged (CSP placement, `localResourceRoots`, progress-lifecycle fix, `pickPrimaryOutput`) and what diverged (sandbox attribute, loading mechanism, message protocol), with pointers to the relevant sections. |
| #2 `iframeProbe` / `cspViolation` messages omitted | Per-instance behavior section now documents both diagnostic messages, notes they are *not* members of `KnitOutputMessage`, and notes `isKnitOutputMessage` silently drops them at the extension boundary. |
| #3 `rewriteFragmentAnchors` step omitted from loading-mechanism description | New paragraph documents the rewriter, its narrow surface (regex on `<a href="#…">` only), the intentional non-rewrite cases, and why "narrow rewrite for fragment-only anchors" is safe in a way "general HTML rewriter" is not. |
| #4 `recomputePreviewColumn` test seam missing | Test-only API section adds `setInstancesForTesting`, `recomputePreviewColumnForTesting`, `setPreviewColumnForTesting`. The recompute test now exercises the state machine directly without VS Code drag simulation. |
| #5 `panel` / `localResourceRoots` test access undefined | Test-only API section adds `getPanelForTesting()` / `getRootDirForTesting()` on the instance so tests can read `viewColumn` and `webview.options.localResourceRoots` without unsafe casts. The three new tests' assertions are rewritten to use these accessors explicitly. |

## v1 → v2 changes (response to Codex adversarial review)

| Codex finding | v2 disposition |
| --            | --             |
| #1 `sandbox=""` claim contradicts implementation's `allow-same-origin` | Security section rewritten to describe `sandbox="allow-same-origin"` and why (VS Code service-worker / `ERR_NAME_NOT_RESOLVED`). |
| #2 Spec describes iframe `src` loading; implementation uses `srcdoc` + `<base href>` | New "Loading mechanism" paragraph explicitly documents `srcdoc` + `baseHref` and notes the security properties hold for both. |
| #3 `themeChanged` message type not in prior protocol but used in implementation | Per-instance behavior section enumerates all three messages (`refresh`, `openInBrowser`, `themeChanged`) and points to the commit that introduced the third. |
| #4 Prior spec's `Promise<void>` signature vs. current `{ok, error?}` union | Acknowledged as drift in the *prior* spec. This spec uses the current correct signature; no change needed here. |
| #5 `previewColumn` resets to undefined when the only panel is dragged → scatters | `recomputePreviewColumn` now *adopts* a surviving panel's column instead of resetting to undefined whenever the Map is non-empty. Reset only happens when the Map is empty. Edge-case row updated to match. |
| #6 `onDidDispose` could delete a replacement instance under the same key | Dispose handler now guards with `if (instances.get(key) === instance)` before deleting. Documented as defense-in-depth against any future async dispose. |
| #7 Drag-recompute behavior only in manual smoke | New `knit-recompute-preview-column.test.ts` exercises `recomputePreviewColumn` directly via a test-only harness with controlled fake instances. |
| #8 No automated test for `rootDir`-mismatch dispose-and-recreate | New `knit-rootdir-change.test.ts` covers the highest-risk lifecycle branch with `localResourceRoots` and column assertions. |
| #9 `localResourceRoots` isolation claim untested | `knit-multi-panel.test.ts` now asserts each panel's `webview.options.localResourceRoots` contains only its own output directory. |
| #10 `docs/development.md` contradicts the prior spec's singleton note | Doc-update section now explicitly *supersedes* the prior singleton note rather than adding alongside it. |
