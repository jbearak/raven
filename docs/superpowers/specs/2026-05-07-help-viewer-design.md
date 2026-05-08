# R Help Viewer

Date: 2026-05-07
Status: Draft for review

## Problem

Raven can show R help text inline in hovers, but the markdown surface is cramped
for anything longer than a short signature plus description. Users who want to
read full help — usage, arguments, details, examples, see-also — currently have
to hover-and-squint, switch to RStudio, or install the larger
[vscode-R](https://github.com/REditorSupport/vscode-R) extension alongside Raven.

A Raven-native help viewer should:

- Render full R help in a webview panel that fits comfortably alongside the
  editor.
- Let users follow `See also` cross-references with one click and walk back
  through where they came from.
- Reach the panel from the existing hover, with no separate "open help" command
  required for v1.

The product shape was settled in the 2026-05-07 brainstorm:

- Backend: extend `crates/raven/src/help.rs` with `tools::Rd2HTML()` rendering.
  No `tools::startDynamicHelp()` HTTP server, no long-lived helper R process.
  Help fetches happen via the same kill-on-timeout ad-hoc subprocess pattern
  the existing `get_help()` already uses.
- Frontend: a single VS Code webview panel, opened beside the editor (matching
  the plot viewer), reused across topics, with back/forward navigation.
- Trigger: the function name at the top of the existing hover becomes a bold,
  clickable link that opens the panel for that topic. No command palette
  command, no quick-pick, no package browser in v1.
- Rendering: server returns HTML, rewrites cross-reference links to a custom
  scheme the webview recognizes, returns the package help directory for image
  serving.

## Goals / Non-goals

Goals:

1. New `get_help_html(topic, package) -> Option<HelpHtml>` in `help.rs` that
   spawns R and runs `tools::Rd2HTML(utils:::.getHelpFile(help(topic, package = (pkg))), ...)`,
   reusing the existing watchdog-based timeout, stdin/stderr discipline, and
   topic/package validation from `get_help()`.
2. New parallel `HtmlHelpCache` mirroring `HelpCache` (LRU 256, negative TTL
   ~300s, drained on libpath changes via the existing `libpath_watcher`).
3. Server-side cross-reference link rewriting so the webview only needs to
   recognize one URL scheme (`raven-help://topic/<pkg>/<topic>[#anchor]`).
4. New `raven.getHelpHtml` server command exposed through `workspace/executeCommand`
   (not advertised in `executeCommandProvider.commands`, per the rule in
   `CLAUDE.md`).
5. New VS Code extension module under `editors/vscode/src/help/`:
   - `help-panel.ts` — webview lifecycle, history stacks, navigation logic.
   - `messages.ts` — typed wire protocol mirroring `plot/messages.ts`.
   - `index.ts` — command registration and the markdown-trust middleware.
   - `webview/` — Svelte UI mirroring `plot/webview/` patterns.
6. Hover handler change: when `(topic, package)` is known and
   `get_help_cached()` returned content, prepend a bold clickable line:

   ```text
   **[`pkg::name`](command:raven.openHelpPanel?<encoded-args>)**
   ```

   to the hover markdown. Always include the `pkg::` qualifier (including for
   base packages — the user gets to know where things come from).
7. New setting `raven.help.viewer.viewColumn` (`active` | `beside`, default
   `beside`), wired through all three places per the `CLAUDE.md` rule.
8. Real subprocess-timeout test coverage for both the new `get_help_html` and
   the existing `get_help` (the latter is currently uncovered).

Non-goals for v1:

- `tools::startDynamicHelp()` HTTP server, long-lived help R process, or any
  HTTP-based help proxying.
- Quick-pick topic search across installed packages, package browser tree
  view, "Open in browser" command, click-to-run examples, vignette browsing.
- "Open in new help panel" / multi-panel UX.
- Persisting panel history across VS Code reloads.
- Discoverability tooling (toasts, banners, walkthroughs) for the clickable
  hover heading. Add later only if usage data shows it's needed.

## Architecture

```text
┌─────────────────┐  command:raven.openHelpPanel  ┌─────────────────────┐
│  Hover markdown │ ─────────────────────────────▶│ raven.openHelpPanel │
│  (server side)  │                               │  VS Code command    │
└─────────────────┘                               └──────────┬──────────┘
                                                             │
                                                             ▼
                                              ┌──────────────────────────┐
                                              │  HelpPanel (singleton)   │
                                              │  • back / forward stacks │
                                              │  • current topic         │
                                              │  • request id (cancel)   │
                                              └─────┬────────────────┬───┘
                                                    │                │
                                workspace/executeCommand           postMessage
                                  raven.getHelpHtml                load / error
                                                    │                │
                                                    ▼                ▼
                              ┌────────────────────────┐   ┌────────────────────┐
                              │ get_help_html (Rust)   │   │  Webview (Svelte)  │
                              │ • spawn R subprocess   │   │  • render HTML     │
                              │ • Rd2HTML render       │   │  • intercept clicks│
                              │ • rewrite cross-refs   │   │  • back / forward  │
                              │ • return helpDir       │   │    button events   │
                              │ • HtmlHelpCache        │   └─────────┬──────────┘
                              └────────────────────────┘             │
                                                                     │  raven-help://...
                                                                     ▼
                                                           navigate message
                                                           → HelpPanel
```

Three components:

### Server-side help renderer

Under `crates/raven/src/help.rs` (or split into `crates/raven/src/help/` if the
file outgrows itself; see "Implementation notes" below):

- `pub fn get_help_html(topic: &str, package: Option<&str>) -> Option<HelpHtml>`.
- `HelpHtml { html: String, title: String, package: String, help_dir: PathBuf }`.
- Reuses the same R-spawning, kill-on-timeout, validate-args pattern as
  `get_help()`. The R snippet differs only in the rendering call:

  ```r
  tools::Rd2HTML(
    utils:::.getHelpFile(help(topic, package = (pkg))),
    out = stdout(),
    package = pkg
  )
  ```

- After R returns, the function:
  1. Resolves the package help directory by reading `find.package(pkg, lib.loc = .libPaths())[1]`
     (or piggybacks on `package_library`'s already-known libpath for the package).
  2. Runs `rewrite_help_html(html, source_pkg)` — pure function; covered below.
  3. Extracts `title` from the rendered HTML's first `<h2>`.
- Cached by `HtmlHelpCache` keyed `"package\0topic"` with the same LRU + negative
  TTL parameters as the existing `HelpCache`. Drained on libpath-change events.

### Extension panel manager

Under `editors/vscode/src/help/`:

- `help-panel.ts`:
  - Singleton webview panel; created lazily on first `raven.openHelpPanel`
    invocation, reused thereafter. Reveals existing panel if already open.
  - Holds the back/forward stacks (cap 50, FIFO drop oldest), current entry,
    and a monotonic request id used to cancel stale `getHelpHtml` responses.
  - At panel creation, the first `raven.getHelpHtml` response carries the
    list of R libpaths (`libPaths: string[]`); the extension uses them as
    `localResourceRoots` for the panel. Subsequent responses also include
    `libPaths`; if they differ from the panel's roots (rare — only happens
    when `.libPaths()` changes mid-session), the panel is disposed and
    recreated on the next request. No separate libpath-polling RPC.
  - On each `load` from the server, runs the image-rewrite pass over the HTML
    (resolves relative `<img src>`s via `helpDir`, validates the resolved
    absolute path is under one of the libpath roots, otherwise drops the img).
- `messages.ts`: typed wire protocol mirroring `plot/messages.ts`, with runtime
  type guards and no DOM/VS Code imports.
- `index.ts`:
  - Registers `raven.openHelpPanel`, `raven.help.back`, `raven.help.forward`.
  - Installs the hover trust middleware (sets
    `isTrusted: { enabledCommands: ['raven.openHelpPanel'] }` on returned
    `MarkdownString` instances).

### Webview UI

Under `editors/vscode/src/help/webview/`:

- Svelte, styled with VS Code CSS variables (`--vscode-editor-foreground`,
  `--vscode-editor-background`, etc.) so the panel theme tracks the editor.
- Toolbar: ← back, → forward. Buttons disabled when their stack is empty.
  Both buttons send messages to the extension; the extension owns history
  state. The webview never decides what topic to load.
- Click handler on the help-content area distinguishes:
  - `raven-help://topic/<pkg>/<topic>[#anchor]` → posts `navigate` to extension.
  - `https://...` / `http://...` → posts `open-external`.
  - `#anchor` → lets the browser scroll natively.
  - Anything else → ignored (defense in depth — server should never emit
    these).

## LSP protocol surface

One new server command, registered in the `workspace/executeCommand` dispatcher
in `handlers.rs`:

- **Command name**: `raven.getHelpHtml`
- **Args**: `[topic: string, package: string | null]`
- **Returns** (JSON):

  ```jsonc
  // success
  { "ok": true, "topic": "...", "package": "...", "title": "...", "html": "...", "helpDir": "...", "libPaths": ["...", "..."] }

  // failure
  { "ok": false, "reason": "not-found" | "package-not-installed" | "render-failed" | "timeout" | "r-unavailable", "message": "..." }
  ```

Per `CLAUDE.md`, the command is **not** added to
`executeCommandProvider.commands` — `vscode-languageclient`'s
`ExecuteCommandFeature` would otherwise auto-register it as a VS Code command,
clashing with the extension's own `raven.openHelpPanel` registration. The
server still handles it from `workspace/executeCommand` regardless.

## Cross-reference link rewriting

Pure function `rewrite_help_html(html: &str, source_pkg: &str) -> String`,
covered by unit tests with no R subprocess required.

| Input pattern in `<a href="...">` | Output |
| --- | --- |
| `../../base/help/sum` | `raven-help://topic/base/sum` |
| `../../dplyr/help/filter` | `raven-help://topic/dplyr/filter` |
| `../../dplyr/help/filter#examples` | `raven-help://topic/dplyr/filter#examples` |
| `https://example.com/...` | unchanged |
| `http://example.com/...` | unchanged |
| `#examples` (in-page) | unchanged |

Anchors that don't match any of these patterns are left as-is. Malformed
`../../...` paths (e.g., `../foo`, `../../`) are left unchanged so the
webview's "default → ignore" branch handles them.

`<img src="...">` is **not** rewritten by the server. The server returns
`helpDir` and the extension does the image-rewrite pass at render time, since
only the extension can call `webview.asWebviewUri(...)`.

## Image serving

- Server returns `helpDir = <libpath>/<package>/help` (absolute).
- Extension at panel creation passes `localResourceRoots = libpaths` (one root
  per configured libpath; covers all installed packages).
- On each `load`, extension scans the HTML for `<img src="...">` and:
  1. If src is absolute http/https, leave it alone.
  2. If src is relative, prepend `helpDir` to get an absolute filesystem path.
  3. Canonicalize the absolute path and verify it falls under one of the
     `localResourceRoots`. If not, replace the src with an empty string (the
     `<img>` renders broken; defense against `\figure{../../etc/passwd}{...}`).
  4. Replace src with `webview.asWebviewUri(vscode.Uri.file(absPath)).toString()`.

CSP for the panel:

```text
default-src 'none';
img-src ${webview.cspSource} https: data:;
script-src ${webview.cspSource} 'nonce-${nonce}';
style-src ${webview.cspSource} 'unsafe-inline';
font-src ${webview.cspSource};
```

`style-src 'unsafe-inline'` is required — `tools::Rd2HTML()` emits inline
`style="..."` attributes. `script-src` excludes `'unsafe-inline'`; the bundled
Svelte app loads via `webview.cspSource` with a nonce.

No image caching — VS Code's webview will re-fetch on each render, but the
files are tiny and local; the cost is negligible.

## Hover integration

Server-side change in the existing hover handler in `crates/raven/src/handlers.rs`:

- When `(topic, package)` are known and `get_help_cached()` returned content,
  prepend a single line to the hover markdown:

  ```text
  **[`pkg::name`](command:raven.openHelpPanel?<encoded-args>)**
  ```

  where `<encoded-args>` is `encodeURIComponent(JSON.stringify([topic, package]))`.

- The `pkg::` qualifier is always shown, including for base packages
  (`base`, `stats`, `graphics`, `utils`, `methods`, `grDevices`, `datasets`).
  Knowing where a function lives is genuinely useful; users explicitly opted
  into this in the brainstorm.
- When help is unavailable for a symbol (local variable, unknown reference,
  or a function in a package whose help failed to fetch), no line is added —
  the rest of the hover is unchanged.

Extension-side change — markdown trust middleware under
`editors/vscode/src/help/`:

```typescript
provideHover: async (document, position, token, next) => {
    const hover = await next(document, position, token);
    if (!hover) return hover;
    for (const c of hover.contents) {
        if (c instanceof vscode.MarkdownString) {
            c.isTrusted = { enabledCommands: ['raven.openHelpPanel'] };
        }
    }
    return hover;
}
```

Narrow trust — only `raven.openHelpPanel`. No risk of arbitrary
command-link execution.

## Navigation, history, and request lifecycle

- History entry shape: `{ topic, package, scrollY, anchor? }`.
- On `navigate` (cross-ref click in the webview):
  1. Capture the current entry's `scrollY` from the webview.
  2. Push current to back stack (cap 50; oldest dropped).
  3. Clear forward stack.
  4. Post `loading` to webview (placeholder content area).
  5. Send `raven.getHelpHtml` with a fresh request id; if a newer request id
     is issued before the response arrives, drop the response.
  6. On success, post `load { html, title, anchor? }` and let the webview
     scroll to anchor or top.
  7. On failure, post `error { reason, message }` to be shown inline.
     **Failures do not mutate stacks** — the user stays on the previous topic;
     clicking back returns them where they were.
- Back / forward: pop one stack, push current onto the other, replay
  (cache hit) or refetch the entry; restore its `scrollY`. Buttons disabled
  when the corresponding stack is empty.

The panel `title` (VS Code editor tab label) is updated per topic to
`R Help: pkg::topic`. Combined with the `pkg {topic}` header that
`Rd2HTML` already includes in the body, no extra breadcrumb is needed in the
toolbar.

## Edge cases & error handling

| `reason` | Trigger | Panel response |
| --- | --- | --- |
| `not-found` | R returns no Rd db match (typo, deprecated topic) | `"No help available for \`topic\`"` |
| `package-not-installed` | Cross-ref to a package missing from libpaths | `"Package \`pkg\` is not installed."` (no install button in v1) |
| `render-failed` | `Rd2HTML()` errors on a malformed Rd | `"Could not render help for \`topic\`."` + retry button |
| `timeout` | R subprocess exceeds `HELP_TIMEOUT` (10s default) | `"R timed out rendering help."` + retry button |
| `r-unavailable` | R binary not configured / not found | `"R is not configured. Check raven.r.path."` |

Other defensive behavior:

- **Race conditions**: each `getHelpHtml` invocation gets a monotonic request
  id; stale responses are dropped.
- **Cache staleness on package install/uninstall**: the existing
  `libpath_watcher` already fires on package library changes; hook
  `HtmlHelpCache` to drain on those events (matches `HelpCache`'s existing
  behavior).
- **Concurrent same-topic requests**: no in-flight de-dup. Both spawn R, both
  write to cache; second write wins. Cache writes are idempotent.
- **Special characters in topic names**: operators (`+`, `if`, `%>%`) work
  because args go through R via `--args` rather than shell interpolation —
  same as the existing `get_help`. Topic-name regex validation rejects shell
  metacharacters before reaching R.
- **Webview state across VS Code reload**: not persisted. Panel recreated
  fresh on next open. Within a session, `retainContextWhenHidden: true`
  preserves history when the panel is hidden behind another tab. If the user
  closes the panel, history is dropped.

## Settings & commands

### Settings

```jsonc
"raven.help.viewer.viewColumn": {
  "type": "string",
  "enum": ["active", "beside"],
  "default": "beside",
  "description": "Where the R help viewer panel opens. 'beside' splits the editor; 'active' replaces the current editor."
}
```

Mirrors the plot viewer's `raven.plot.viewer.viewColumn`. Wired in three places
per `CLAUDE.md`:

1. `editors/vscode/package.json` — schema entry above.
2. `editors/vscode/src/initializationOptions.ts` — exposed as
   `helpViewer: { viewColumn }` in `RavenInitializationOptions`.
3. `editors/vscode/src/test/settings.test.ts` — added to `SETTINGS_MAPPING`
   with a default-value and an explicit-value test.

No `raven.help.enabled` toggle in v1. The added surface is one bold/clickable
line in hovers, unobtrusive enough that no opt-out is needed yet. Easy to add
later if users complain.

### Commands

| Command | Args | Purpose |
| --- | --- | --- |
| `raven.openHelpPanel` | `topic, package?` | Main entry. Reveals existing panel or creates one. |
| `raven.help.back` | — | Pops back stack. Disabled when empty. |
| `raven.help.forward` | — | Pops forward stack. |

No default keybindings. Users can bind via `keybindings.json`; the back /
forward commands have a `when` clause of `activeWebviewPanelId == 'raven.helpViewer'`
so the bindings only fire while the panel is focused.

No new menu contributions. The hover heading link is the only entry path in
v1.

### Server-side commands

| Command | Args | Purpose |
| --- | --- | --- |
| `raven.getHelpHtml` | `[topic, package?]` | Exposed via `workspace/executeCommand`. Not added to `executeCommandProvider.commands` per `CLAUDE.md`. |

### Deferred (not v1)

- `raven.openHelpInNewPanel` — second panel for side-by-side comparison.
- `raven.help.search` — quick-pick topic search across installed packages.
- `raven.help.openExternal` — open current topic via the OS browser.
- Click-to-run examples, vignette browsing, package browser tree view.

## Testing approach

### Server-side (Rust)

1. **`get_help_html` integration tests** (R required; gated like existing
   R-dependent tests):
   - Successful render for `("mean", "base")` — output contains expected HTML
     structure (e.g., a `<table>` for arguments and the title text).
   - Each failure path (`not-found`, `package-not-installed`, `render-failed`)
     returns the right `reason`.
   - Topic-name validation rejects shell-meta characters before reaching R.

2. **HTML rewriting unit tests** (pure, no R needed):
   - `../../base/help/sum` → `raven-help://topic/base/sum`.
   - `../../dplyr/help/filter#examples` → `raven-help://topic/dplyr/filter#examples`.
   - `https://example.com/...` passes through.
   - `#examples` (in-page anchor) passes through.
   - `<img src="figures/foo.png">` is left for the extension; not mangled by
     the server.
   - Malformed inputs (`../../`, `../foo`, empty href) don't crash.

3. **`HtmlHelpCache` tests** — copy the structure of existing `HelpCache`
   tests: LRU eviction, negative TTL, concurrent reads/writes, drain on
   libpath-change event.

4. **executeCommand dispatcher** — `raven.getHelpHtml` returns `{ ok: true, ... }`
   for known topics and the right `{ ok: false, reason }` shape for failures.

5. **Hover integration** — for a known `(topic, package)` like `(filter, dplyr)`,
   the hover begins with a line matching `^\*\*\[`...`\]\(command:raven\.openHelpPanel\?...\)\*\*$`.
   Symbols without help → no link prepended.

6. **Subprocess timeout** — both `get_help_html` and the existing `get_help`
   need real coverage of the watchdog path (the existing one currently has
   none). Approach:
   - Parameterize the timeout, either through a `RAVEN_HELP_TIMEOUT_MS` env
     var or a test-only `_with_timeout` overload. Production keeps using
     `HELP_TIMEOUT = 10s`.
   - Test calls into the function with a small timeout (e.g., 200ms) against
     an R snippet known to hang (e.g., one that calls `Sys.sleep(60)` from
     within R, reachable via a test fixture).
   - Assert: returns the timeout variant, total elapsed time < 1s, and on
     Unix the spawned pid no longer exists (`kill(pid, 0) == ESRCH`). Skip
     the pid-existence check on Windows.

### Extension-side (TypeScript)

1. **Hover trust middleware test** (Mocha, `editors/vscode/src/test/`):
   `MarkdownString`s returned by `provideHover` carry
   `isTrusted: { enabledCommands: ['raven.openHelpPanel'] }`. No other
   commands trusted.

2. **`HelpPanel` state machine** — pure unit tests with a mocked LSP client:
   - `navigate(t, p)` pushes prior to back, clears forward.
   - Back / forward swap entries correctly.
   - Failed `getHelpHtml` does **not** mutate stacks.
   - Stale request ids dropped (newer request supersedes).

3. **Image URL rewriter test** (pure):
   - `<img src="figures/x.png">` + `helpDir = /lib/dplyr/help` → mocked
     `webview.asWebviewUri(/lib/dplyr/help/figures/x.png)`.
   - Path traversal (`figures/../../etc/passwd`) — extension drops the img
     because the resolved absolute path is not under any libpath root.
   - Absolute http/https srcs pass through.

4. **Settings wiring** — extend `editors/vscode/src/test/settings.test.ts`
   per the existing pattern. New entry in `SETTINGS_MAPPING` for
   `raven.help.viewer.viewColumn`. Verify default and explicit values flow
   through `buildInitializationOptions`.

### Webview-side

One Mocha test using JSDOM. Dispatch click events on `<a href="raven-help://...">`,
`<a href="https://...">`, `<a href="#anchor">`, `<a href="other://x">`, and
verify the correct `postMessage` payload (or none, for in-page or unknown
schemes).

### Manual smoke test plan

To be added to `docs/help-viewer.md` once the user-facing doc is written:

1. Hover over `dplyr::filter` in an R file → bold `dplyr::filter` heading at
   the top of hover; click → panel opens beside.
2. Panel shows R help with package header, title, usage, arguments, examples.
3. Click "See also: arrange" → panel navigates, back arrow now enabled.
4. Back arrow → returns to filter, scroll position restored.
5. Hover `plot(1:5)` → bold `graphics::plot` heading; click → navigates
   correctly even cross-package.
6. Trigger a help page with images (e.g., `?ggplot2::theme` if installed) →
   images load.
7. Trigger an unknown topic by directly invoking the command → panel shows
   the not-found message; previous content & history preserved.

### What we won't test

- `tools::Rd2HTML()` output structure itself (R's responsibility).
- VS Code webview internals.

## Implementation notes

- File layout for `help.rs`: if the new HTML path adds enough surface to push
  the file past a comfortable size, split into `crates/raven/src/help/{mod.rs,
  text.rs, html.rs, cache.rs}`. Decide based on diff size at implementation
  time; not a v1 requirement.
- Module declarations in BOTH `crates/raven/src/lib.rs` AND
  `crates/raven/src/main.rs` for any new top-level module, per `CLAUDE.md`.
- The existing markdown-link middleware infrastructure in `editors/vscode/`
  may need a small generalization to chain the new `provideHover` handler
  without breaking other middleware. If there's already a hover middleware
  in place, extend it; if not, create one.
- Logging: existing `log::trace!` calls in `get_help` are reused in
  `get_help_html`. Extension side: an output channel for `Raven Help Viewer`
  if useful for debugging, gated behind a verbose-logging setting only if we
  add one (don't add one in v1).

## Documentation requirements

Per `CLAUDE.md`, on completion:

- New `docs/help-viewer.md` (user-facing) with: what it does, how to open it,
  the back/forward navigation, the v1 limitations (no search, no examples
  runner), and the manual smoke test plan above.
- Update `README.md` if the feature should appear in the top-level feature
  list.
- Update `CLAUDE.md`'s "What to read (in order)" pointer block to include
  `docs/help-viewer.md`.
- The `raven.help.viewer.viewColumn` setting needs a row in
  `docs/configuration.md` (consistent with other `raven.*` settings).
