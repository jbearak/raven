# VS Code Plot Viewer

Date: 2026-05-06
Status: Draft for review

## Problem

Raven can now send R code to a managed terminal, but plots have no Raven-owned
viewer. Users who run:

```r
plot(1:10)
```

need the result to appear inside VS Code without installing the larger
[vscode-R](https://github.com/REditorSupport/vscode-R) extension or relying on an
external browser. The viewer must work for the standard R console, `radian`, and
`arf`, and it must be wired through Raven's managed terminal paths rather than
the Rust LSP server.

The product shape was settled in the 2026-05-06 brainstorm:

- `httpgd`-only (no static-PNG fallback, no auto-install).
- Custom Svelte webview (not an iframe of httpgd's built-in UI).
- Single shared panel that updates to the most recent plot without stealing
  focus from the active editor.
- Lazy panel: created on the first plot, recreated automatically on the next
  plot if the user closes it.
- v1 controls: latest-plot display with auto-resize, theme-aware background,
  prev/next history navigation, remove-current-plot, save (PNG/SVG/PDF) through
  the OS save dialog, open-externally, and explicit loading/empty/disconnected
  states.

## Goals / Non-Goals

Goals:

1. Start one plot-session server per VS Code window, lazily, when Raven creates
   a managed R terminal.
2. Inject the same Raven plot bootstrap into both managed-terminal creation
   paths: `get_or_create_r_terminal()` and the contributed `raven.rTerminal`
   terminal profile.
3. Use `httpgd >= 2.0.2` as the only R graphics backend.
4. Show a single shared VS Code webview panel that switches to the most recent
   plot across managed R terminals.
5. Preserve the user's normal R startup behavior even though Raven must set
   `R_PROFILE_USER`.
6. Keep the Rust LSP server untouched.

Non-goals for v1:

- Static PNG fallback, base `png()` fallback, or non-`httpgd` graphics devices.
- Auto-installing `httpgd` or showing VS Code modal install prompts.
- Thumbnail picker for plot history.
- Copy-to-clipboard.
- Zoom, pan, and fit-to-window controls.
- Bulk "clear all plots" action (single-plot remove only).
- Migration from older managed-terminal behavior; the managed terminal has not
  shipped yet.
- Supporting arbitrary user-created terminals that were not launched through
  Raven's terminal manager or Raven's contributed terminal profile.

## Behavior Contract

When `raven.plot.enabled` is `true`, a user running R through Raven's managed
terminal sees:

1. The first Raven-managed R terminal starts normally, using the configured
   `raven.rTerminal.program` (`R`, `radian`, or `arf`).
2. If `httpgd` is missing, R prints a `Raven: ...` console message explaining
   that Raven plots require `install.packages("httpgd")`. No VS Code modal
   appears and Raven does not install anything.
3. If `httpgd` is installed but older than `2.0.2`, R prints a `Raven: ...`
   console message explaining the minimum supported version. The plot device is
   not started.
4. If `httpgd` is available, Raven starts an `httpgd` device for that R session
   and the bootstrap reports the device endpoint to the extension.
5. The first plot opens a single shared "Raven Plot Viewer" panel in the
   configured editor column. Later plots reuse that panel and update its content
   to the newest plot. Reusing the panel does not steal focus from the user's
   current editor or change the panel's column.
6. Multiple Raven-managed R terminals share the same extension session server.
   The most recent plot from any live session becomes the active plot.
7. The viewer exposes previous/next history navigation, remove-current-plot,
   save (PNG/SVG/PDF), and open-externally controls.
8. Closing the viewer panel does not disable plotting. The next plot recreates
   the panel.
9. If an R terminal exits, the viewer remains open with the last rendered plot
   and shows that the producing R session ended. Plots from other live sessions
   can still replace it.
10. Once the user moves the panel (drag to a different editor column, pin to a
    side bar, etc.), Raven leaves the panel where it is. `raven.plot.viewerColumn`
    only controls the *initial* reveal column; subsequent reveals do not pass a
    `viewColumn`, so VS Code preserves the panel's current location.
11. If the extension-side session server cannot start, R still starts normally
    and Raven logs the failure to the Raven output channel. The plot viewer is
    disabled for that window until the user runs **Raven: Restart Language
    Server** or the extension reactivates.

## Architecture Overview

The feature lives entirely in the VS Code extension.

```text
VS Code window
├─ extension.ts
│  └─ register_r_terminal(context, plot_services)
├─ send-to-r/
│  ├─ r-terminal-manager.ts   (env injection on both creation paths)
│  └─ commands.ts
└─ plot/
   ├─ session-server.ts       (HTTP localhost server; single shared instance)
   ├─ r-bootstrap-profile.ts  (profile generator + env builder)
   ├─ plot-viewer-panel.ts    (singleton webview host)
   ├─ messages.ts             (typed extension <-> webview message contract)
   └─ webview/
      ├─ App.svelte
      ├─ main.ts
      └─ styles.css

Managed R terminal
└─ generated R_PROFILE_USER
   ├─ source the user's normal startup profile
   ├─ verify httpgd >= 2.0.2
   ├─ start httpgd::hgd(...)
   ├─ POST session-ready event to extension server
   └─ POST plot-available events on httpgd state changes
```

The session server listens on `127.0.0.1` with an OS-assigned port from
`net.listen({ host: '127.0.0.1', port: 0 })`. It generates one random 32-byte
hex token for its lifetime. Both terminal creation paths receive the
following env vars through `TerminalOptions.env`:

```text
R_PROFILE_USER                = <generated Raven profile path>
RAVEN_ORIGINAL_R_PROFILE_USER = <previous R_PROFILE_USER, or "">
RAVEN_SESSION_PORT            = <extension server port>
RAVEN_SESSION_TOKEN           = <32-byte hex token>
RAVEN_R_SESSION_ID            = <per-terminal random id, generated at env-injection time>
```

`RAVEN_R_SESSION_ID` is a fresh `crypto.randomUUID()` generated each time
`get_plot_terminal_env()` is called, so each managed terminal carries a unique
identity that the extension can correlate to a `vscode.Terminal` instance (see
[Terminal Manager Integration](#terminal-manager-integration)).

The R-to-extension v1 wire protocol is plain localhost HTTP POST from base R.
The bootstrap does not require an R WebSocket package; a tiny base-R POST over
`socketConnection()` with hand-built HTTP framing is sufficient for short
session events. The extension server is structured so that a future WS upgrade
handler can be added on the same port without changing the bootstrap. v1
implements only the HTTP POST receiver.

The webview talks **directly** to httpgd over HTTP (for plot rendering and
listing) and WebSocket (for plot-update push notifications). The extension is
not in the data path between the webview and httpgd. The extension *does*
mediate save and open-externally, because those need VS Code APIs.

## Components

### Session Server

`plot/session-server.ts` owns the per-window server lifetime:

- Lazily started on the first managed terminal creation when `raven.plot.enabled`
  is `true`.
- Binds to `127.0.0.1` on port `0` and exposes the assigned port.
- Generates `RAVEN_SESSION_TOKEN` once per server lifetime as
  `crypto.randomBytes(32).toString('hex')` (64 hex characters).
- Accepts authenticated HTTP POST messages from R. Every message carries the
  token in an `X-Raven-Session-Token` header and the `RAVEN_R_SESSION_ID` in the
  body.
- Tracks live R sessions and the active plot source.
- Notifies `plot-viewer-panel.ts` when a newer plot arrives or a session ends.
  Session-ready events update the registry but do not surface the panel — the
  panel is plot-driven, not session-driven.
- Disposes naturally on extension deactivation through VS Code subscriptions.
- Restarts when the user runs **Raven: Restart Language Server**: the existing
  `raven.restart` command also calls `plot_services.restart()`, which disposes
  the current server and reinitializes the lazy-start state.

The server is local-only. It rejects requests without the current token and
logs malformed payloads to the Raven output channel without surfacing user
modals.

#### R-to-extension HTTP endpoints

The extension server exposes two HTTP POST endpoints. Both require
`X-Raven-Session-Token: <RAVEN_SESSION_TOKEN>`.

| Endpoint | Body | Effect |
|----------|------|--------|
| `POST /session-ready` | `{ sessionId, httpgdHost, httpgdPort, httpgdToken }` | Registers a live R session. Stores the httpgd endpoint for the webview. |
| `POST /plot-available` | `{ sessionId, hsize, upid }` | Marks `sessionId` as the active plot source and triggers panel reveal. `hsize` and `upid` are read from httpgd's `/state` HTTP endpoint (URL via `httpgd::hgd_url(endpoint = "state")`); httpgd >= 2.0 removed the R-side `hgd_state()` accessor. |

A future WebSocket upgrade handler can be added on the same port for
bidirectional push (e.g., extension-to-R signals). It is not implemented in v1.

### R Bootstrap Profile

`plot/r-bootstrap-profile.ts` writes a generated profile file at
`${context.globalStorageUri}/r-profile.R` and returns the environment block for
terminal creation. The profile is regenerated every time
`get_plot_terminal_env()` is called, so newer extension versions can update its
contents without manual cache busting. The file does not embed per-session
state — port, token, and session ID are passed via env vars at runtime.

Concurrent regeneration is safe: the profile content depends only on the
extension version, so simultaneous writes from multiple terminal-creation calls
produce identical bytes. The implementation may still write to a temp path and
rename atomically, but a clobber is harmless.

The generated profile must be careful because setting `R_PROFILE_USER` replaces
R's normal user-profile search. It must:

1. Source the profile R would normally have sourced into `globalenv()`:
   - `Sys.getenv("RAVEN_ORIGINAL_R_PROFILE_USER")`, if set and readable.
   - Otherwise `.Rprofile` in the startup working directory, if readable.
   - Otherwise `~/.Rprofile`, if readable.
2. Run Raven bootstrap code inside `local({ ... })` so it does not pollute
   `globalenv()`.
3. Avoid loading non-base packages before checking `httpgd` availability.

Sourcing the user's profile first preserves normal startup semantics. If the
user profile deliberately disables or replaces the active device later in the
session, Raven does not fight that choice.

The bootstrap checks:

```r
requireNamespace("httpgd", quietly = TRUE)
utils::packageVersion("httpgd") >= "2.0.2"
```

If either check fails, it prints a Raven-prefixed console message and returns.
If checks pass, it calls `httpgd::hgd(host = "127.0.0.1", port = 0, token = TRUE, silent = TRUE)`,
captures the resulting host/port/token via `httpgd::hgd_details()`, POSTs
`/session-ready` with the unpacked endpoint, then installs an `addTaskCallback()`
that fetches httpgd's `/state` HTTP endpoint (via `httpgd::hgd_url(endpoint = "state")`)
after each top-level command. The callback parses `hsize` and `upid` out of the
small JSON response, compares against the previous pair, and POSTs `/plot-available`
only when those advance. The R-side `hgd_state()` accessor was removed in httpgd
2.0, so the HTTP endpoint is the only state interface that works on supported
versions.

`R`, `radian`, and `arf` all honor `R_PROFILE_USER` as long as the terminal is
not launched with `--no-init-file` or `--vanilla`. Raven's current shell args
are `--no-save --no-restore`, so the profile is read for all three. Local
empirical checks on 2026-05-06 confirmed the generated profile executes under
the installed `R`, `radian`, and `arf` binaries.

### Terminal Manager Integration

`r-terminal-manager.ts` already has both terminal creation paths:

- Programmatic path: `get_or_create_r_terminal()` calls `create_r_terminal()`
  which invokes `vscode.window.createTerminal({ ... })`.
- Profile path: `registerTerminalProfileProvider(PROFILE_ID, provider)` returns
  a `vscode.TerminalProfile` from `provideTerminalProfile()`, which is already
  `async`.

Both paths call the same async helper before constructing terminal options:

```ts
const plot_env = await get_plot_terminal_env(context, program_name);
```

The helper:

1. Lazily starts the session server.
2. Generates a fresh `RAVEN_R_SESSION_ID`.
3. Writes (or overwrites) the bootstrap profile under `globalStorageUri`.
4. Returns the env block, plus the generated session ID for the caller to track.

If `raven.plot.enabled` is `false` or the server failed to start, the helper
returns no env and the terminal is created as it is today.

To correlate `vscode.Terminal` instances back to `RAVEN_R_SESSION_ID`:

- **Programmatic path:** `create_r_terminal()` receives the `Terminal` object
  synchronously from `createTerminal(...)` and immediately sets
  `terminal_to_session_id.set(terminal, sessionId)`.
- **Profile path:** `provideTerminalProfile()` cannot see the `Terminal`
  instance — VS Code creates it later. The provider pushes
  `{ sessionId, programName, generatedAtMs }` onto a FIFO
  `pending_profile_session_ids` queue. `onDidOpenTerminal` is already used
  (with `pending_profile_creation_count`) to detect Raven profile terminals;
  extend that handler to also dequeue from `pending_profile_session_ids` and
  set `terminal_to_session_id`. Entries older than 30 seconds (e.g., user
  cancelled terminal creation) are discarded by a periodic sweep on each
  enqueue.

`onDidCloseTerminal` looks up the session ID from `terminal_to_session_id` and
calls `plot_services.markSessionEnded(sessionId)`, which informs the panel.

### Plot Viewer Webview

`plot/plot-viewer-panel.ts` owns the single shared webview panel:

- Creates the panel lazily on first `/plot-available` and reveals it once in
  `raven.plot.viewerColumn` (with `preserveFocus: true`).
- For subsequent plots, posts a `state-update` to the existing webview to
  update content. Does not call `panel.reveal()` again, so the panel stays in
  whatever column the user has it in and never steals focus.
- Recreates the panel automatically on the next plot if the user disposed it.
  The recreation reveal again uses `raven.plot.viewerColumn`.
- Serves the Svelte bundle from `editors/vscode/dist/webviews/plot-viewer/` via
  `webview.asWebviewUri`.
- Mediates messages with the webview using the typed contract in
  `plot/messages.ts` (see "Extension ↔ Webview Message Protocol" below).

The panel's CSP allows the webview to talk directly to httpgd on
`127.0.0.1:*`:

```text
default-src 'none';
img-src ${webview.cspSource} http://127.0.0.1:* data:;
script-src ${webview.cspSource} 'nonce-${nonce}';
style-src ${webview.cspSource} 'unsafe-inline';
font-src ${webview.cspSource};
connect-src http://127.0.0.1:* ws://127.0.0.1:*;
```

The Svelte app:

- Connects to the active session's httpgd over WebSocket and listens for state
  changes; on each change it fetches plot metadata and the active plot via
  HTTP.
- Authenticates with httpgd using the token reported in `/session-ready` (passed
  through to the webview via the message channel).
- Tracks plot history client-side from httpgd's plot list. Prev/next buttons
  navigate within that list without round-tripping through the extension.
- Reads the current VS Code editor background from `--vscode-editor-background`
  (a CSS variable VS Code injects into webviews) and includes it as a `bg`
  query parameter on every plot fetch URL. The extension subscribes to
  `vscode.window.onDidChangeActiveColorTheme` and posts a `theme-changed`
  message; the webview re-reads the CSS variable and re-fetches the active
  plot. httpgd renders against the supplied background each request.
- Handles three lifecycle states explicitly:
  - **Loading** — between session-ready and first plot render.
  - **Empty** — session exists but no plots yet ("Run plot(1:10) to see it
    here").
  - **Disconnected** — last known active session ended (terminal closed) or
    httpgd is unreachable. The display shows the last successfully rendered
    plot plus a banner.

#### Build pipeline

Svelte is bundled with the extension's existing esbuild via the
`esbuild-svelte` plugin. `editors/vscode/scripts/bundle.js` (currently a
binary-copy script) is renamed/repurposed: extension bundling moves into a new
`scripts/build.js` that runs two esbuild passes — one for the extension entry
(`src/extension.ts` → `dist/extension.js`) and one for the webview entry
(`src/plot/webview/main.ts` → `dist/webviews/plot-viewer/index.js` and
`index.css`). The existing `copy-binary` script is kept as-is (it copies the
Rust binary; orthogonal to this change).

`package.json` script wiring:

```json
{
  "scripts": {
    "bundle": "bun scripts/build.js",
    "copy-binary": "bun scripts/bundle-binary.js",
    "compile": "bun run bundle",
    "package": "bun run bundle && bun run copy-binary && vsce package --allow-missing-repository"
  }
}
```

(`scripts/bundle.js` is renamed to `scripts/bundle-binary.js` for clarity. The
`compile`/`package` invocation order is preserved.)

New devDependencies: `svelte`, `esbuild-svelte`, `@types/svelte` (if available
for the chosen Svelte version).

### Extension ↔ Webview Message Protocol

`plot/messages.ts` defines a discriminated-union message contract used by both
sides.

**Extension → Webview:**

| `type` | Payload | Meaning |
|--------|---------|---------|
| `state-update` | `{ activeSession: { sessionId, httpgdBaseUrl, httpgdToken } \| null, sessionEnded: boolean }` | Authoritative state. Sent on panel ready, on every active-session change, on session-end. |
| `theme-changed` | `{}` | Hint that the webview should re-read CSS theme variables and re-fetch the active plot. (Optional — the webview can also observe DOM mutation directly. Sending the message keeps the trigger explicit and testable.) |

**Webview → Extension:**

| `type` | Payload | Meaning |
|--------|---------|---------|
| `webview-ready` | `{}` | Webview finished bootstrapping. Extension responds with the latest `state-update`. |
| `request-save-plot` | `{ plotId: string, format: 'png' \| 'svg' \| 'pdf' }` | Asks the extension to download the plot from httpgd and prompt for save location via `vscode.window.showSaveDialog`. |
| `request-open-externally` | `{ plotId: string }` | Asks the extension to open the plot URL in the OS default handler via `vscode.env.openExternal`. |
| `report-error` | `{ message: string }` | Webview reporting a non-fatal error (e.g., httpgd fetch failed). Extension logs to the Raven output channel. |

History navigation (prev/next) and remove-current-plot are handled
**within the webview** by calling httpgd directly: prev/next is local list
indexing, and remove uses httpgd's plot-removal endpoint. They do not round-
trip through the extension.

Save flow:

1. User clicks Save.
2. Webview sends `request-save-plot { plotId, format }`.
3. Extension calls `vscode.window.showSaveDialog({ defaultUri: ..., filters: ... })`
   with a sensible default filename (e.g., `plot-${timestamp}.${format}`).
4. If the user picks a path, the extension fetches the plot via `fetch()` from
   the httpgd endpoint with the token, writes the bytes via `fs.writeFile`.
5. On error, extension shows `vscode.window.showErrorMessage`.

## Data Flow

Example: user runs `plot(1:10)` in a freshly-opened Raven terminal.

1. User invokes **Raven: Run Line or Selection** or opens **R (Raven)** from the
   terminal profile dropdown.
2. `r-terminal-manager.ts` calls `get_plot_terminal_env(context, program_name)`.
3. The helper lazily starts the session server, generates a fresh
   `RAVEN_R_SESSION_ID`, writes the bootstrap profile to
   `globalStorageUri/r-profile.R`, and returns the env block.
4. The terminal is created. For the programmatic path, `terminal_to_session_id`
   is set immediately. For the profile path, the session ID is queued and
   matched in `onDidOpenTerminal`.
5. VS Code starts `R`, `radian`, or `arf` with `R_PROFILE_USER` pointing at the
   generated profile.
6. R sources the generated profile. The profile sources the original
   `R_PROFILE_USER` (or `.Rprofile`, or `~/.Rprofile`) so user customizations
   still run.
7. Raven's bootstrap verifies `httpgd >= 2.0.2`, calls `httpgd::hgd(...)`,
   reads the resulting endpoint via `httpgd::hgd_details()`, installs the
   state-change task callback, and POSTs `/session-ready` with
   `{ sessionId, httpgdHost, httpgdPort, httpgdToken }`.
8. Extension stores the session in its registry. No panel yet.
9. The user runs `plot(1:10)`.
10. `httpgd` records the new plot. Its internal state advances `(hsize, upid)`.
11. The Raven task callback observes the state change after the top-level
    command completes and POSTs `/plot-available { sessionId, hsize, upid }`.
12. The session server marks `sessionId` as the active plot source and notifies
    `plot-viewer-panel.ts`. If the panel does not exist, the panel host creates
    it, reveals it once in `raven.plot.viewerColumn`, and posts a `state-update`
    once the webview sends `webview-ready`. If the panel already exists, the
    host posts a `state-update` directly without revealing.
13. The Svelte webview connects to httpgd's WebSocket, fetches the plot list,
    fetches the active plot SVG with `?bg=<theme-bg>`, and renders.
14. The plot appears in VS Code.

## Error Handling

`httpgd` missing or too old:

- R prints a Raven-prefixed console message with installation/upgrade hint.
- No VS Code modal. Terminal remains usable.
- Bootstrap does not POST `/session-ready`. Extension remains in lazy-start
  state for that terminal.

Session server startup failure (port bind error, etc.):

- Extension logs the failure to the Raven output channel.
- Terminal creation continues without Raven plot env.
- Plot viewer is disabled for that VS Code window until **Raven: Restart
  Language Server** runs or the extension reactivates.

Bootstrap fails to source the user's normal profile:

- Bootstrap prints a Raven-prefixed warning with the path and error message,
  then continues with httpgd setup. Raven's plot bootstrap must not make the R
  session unusable.

R session crash or terminal exit:

- `onDidCloseTerminal` looks up the session ID in `terminal_to_session_id`,
  removes the entry, and notifies the panel.
- The panel marks the active session as ended and shows the disconnected
  banner. The last plot stays visible.
- New plots from other live managed sessions can still replace the view.

httpgd unreachable while terminal is still open (rare — e.g., user called
`httpgd::hgd_close()` manually):

- The webview's WebSocket to httpgd disconnects. The webview shows a
  "httpgd disconnected" banner (distinct copy from "session ended") and posts
  `report-error`. The extension does not mark the session ended on this
  signal alone — terminal close is the authoritative end signal.

User closes the viewer:

- The webview panel is disposed. Extension keeps session state.
- The next `/plot-available` recreates the panel.

Malformed or unauthenticated session messages:

- Server rejects the request with HTTP 401/400.
- Raven logs the issue to the output channel for diagnostics.
- No user-facing modal.

User clicks Save but the fetch fails:

- Extension shows `vscode.window.showErrorMessage` with a short message.
- Webview is told via `report-error` echo so it can drop any pending UI state.

## Testing

Bun-runnable pure TypeScript tests (no VS Code dependency):

1. `plot/messages.ts` discriminated-union shape exhaustiveness.
2. Bootstrap-profile generator produces correct R code given the env inputs;
   correctly preserves `RAVEN_ORIGINAL_R_PROFILE_USER` chaining.
3. Session-server token validation, malformed-payload rejection, and session
   state transitions (`/session-ready` then `/plot-available` then
   `markSessionEnded`).
4. FIFO matching of `pending_profile_session_ids` to terminals on
   `onDidOpenTerminal`.
5. Webview message reducer/state model for loading, empty, connected,
   active-history, disconnected, and session-ended states.
6. Theme-bg URL parameter is included on plot fetch URLs.

VS Code extension (Mocha) tests:

1. Programmatic `get_or_create_r_terminal()` path receives the plot env block
   when `raven.plot.enabled` is `true`, and not when it is `false`.
2. `provideTerminalProfile()` returns a profile whose `env` contains the same
   keys.
3. `raven.restart` disposes and reinitializes plot services.
4. Settings parsing for `raven.plot.enabled` and `raven.plot.viewerColumn`.

Build smoke test:

1. `bun run bundle` emits `dist/extension.js` AND
   `dist/webviews/plot-viewer/index.js` + `index.css`.
2. `vsce package` succeeds and the resulting `.vsix` contains both bundles.

Optional integration tests (skipped when prerequisites absent):

1. End-to-end with installed R + httpgd: generated profile starts, session-ready
   POST arrives, base plot is fetchable from httpgd at the reported endpoint.
2. Console compatibility checks for `R`, `radian`, and `arf` verifying
   `R_PROFILE_USER` execution. Subprocess tests skipped when the console binary
   is absent.

The Rust LSP test suite does not change for this feature.

## Settings Reference

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `raven.plot.enabled` | boolean | `true` | user/workspace | Enable Raven's `httpgd`-backed plot viewer for Raven-managed R terminals. Not restricted in untrusted workspaces. |
| `raven.plot.viewerColumn` | enum (`active`, `beside`) | `beside` | user/workspace | Initial editor column for the shared plot viewer panel. Once the user moves the panel, Raven leaves it where it is. |

There is intentionally no `raven.plot.useHttpgd` setting. The feature is
`httpgd`-only, so a boolean backend selector would imply a fallback path that
does not exist.

`raven.plot.enabled` is **not** added to
`capabilities.untrustedWorkspaces.restrictedConfigurations`. It is a pure
boolean toggle with no path or credential implications, consistent with
`raven.diagnostics.enabled` and other pure-toggle settings already shipped.

## Files to Create / Modify

| Path | Action | Description |
|------|--------|-------------|
| `editors/vscode/package.json` | Modify | Add `raven.plot.enabled`, `raven.plot.viewerColumn`. Add `svelte` and `esbuild-svelte` devDependencies. Update build scripts. |
| `editors/vscode/scripts/build.js` | Create | New entry script that runs two esbuild passes (extension + webview). |
| `editors/vscode/scripts/bundle.js` | Rename to `bundle-binary.js` | Existing binary copy script renamed for clarity; logic unchanged. |
| `editors/vscode/src/extension.ts` | Modify | Construct plot services, pass to terminal registration, wire `raven.restart` to also restart plot services, dispose on deactivate. |
| `editors/vscode/src/send-to-r/r-terminal-manager.ts` | Modify | Inject plot env into both `createTerminal` and `TerminalProfileProvider` paths. Track `terminal_to_session_id`. |
| `editors/vscode/src/plot/session-server.ts` | Create | Lazy per-window localhost HTTP server, token validation, session registry. |
| `editors/vscode/src/plot/r-bootstrap-profile.ts` | Create | Profile file writer (to `globalStorageUri/r-profile.R`) and env builder. |
| `editors/vscode/src/plot/plot-viewer-panel.ts` | Create | Singleton webview host and message dispatcher. |
| `editors/vscode/src/plot/messages.ts` | Create | Typed extension <-> webview message contract. |
| `editors/vscode/src/plot/webview/main.ts` | Create | Svelte webview entry. |
| `editors/vscode/src/plot/webview/App.svelte` | Create | Plot viewer UI and httpgd client. |
| `editors/vscode/src/plot/webview/styles.css` | Create | VS Code-themed webview styles. |
| `editors/vscode/src/test/plot/*.test.ts` | Create | VS Code Mocha tests for settings, terminal env injection, restart wiring. |
| `tests/bun/plot-*.test.ts` | Create | Pure TypeScript tests (no VS Code dependency). |
| `docs/send-to-r.md` | Modify | Document Raven-managed plotting behavior and the `httpgd` prerequisite. |
| `docs/configuration.md` | Modify | Document the new `raven.plot.*` settings. |
| `README.md` | Modify | Mention built-in plot viewer in the VS Code feature list. |

## Future Work

Explicit deferrals, not omissions:

- Thumbnail picker for plot history.
- Copy plot to clipboard.
- Zoom, pan, and fit-to-window.
- Bulk "clear all plots" action.
- Static image fallback when `httpgd` is unavailable.
- Supporting unmanaged user terminals that were not created by Raven.
- A richer R-to-extension WebSocket protocol if future features need
  long-lived bidirectional messages from R. The session server is structured
  to allow this addition without rewriting the bootstrap.
