# Dev moves: batch F

Material removed from user pages in batch F, for docs/development.md.

## Help viewer smoke test

From docs/help-viewer.md "Manual smoke test plan". `editors/vscode/src/test/help-viewer.test.ts` points here; keep this heading name.

1. Hover over `dplyr::filter` in an R file → bold `dplyr::filter` heading at the top of hover; click → panel opens beside.
2. Panel shows R help with package header, title, usage, arguments, examples.
3. Click "See also: arrange" → panel navigates, back arrow now enabled.
4. Back arrow → returns to filter, scroll position restored.
5. Hover `plot(1:5)` → bold `graphics::plot` heading; click → navigates correctly even cross-package.
6. Hover an operator: `` ?\`[\` `` or `` ?\`%in%\` `` → bold heading uses the operator, click navigates and renders correctly (verifies percent-encoding round-trip and `is_valid_help_topic`).
7. Trigger a help page with images (e.g., `?ggplot2::theme` if installed) → images load.
8. Trigger an unknown topic (hover a symbol whose topic cannot be resolved, or invoke `raven.openHelpPanel` programmatically with a bogus topic) → panel shows the not-found message; previous content & history preserved.
9. Configure a non-default R via `raven.packages.rPath` and verify help renders against that R installation (open a topic only available in a package installed for that R; should succeed where it would fail against system R).

### Help viewer internals (from docs/help-viewer.md)

- Internal cross-references are rewritten to a custom URL scheme that round-trips operator topics like `` \`[\` `` and `` \`%in%\` ``.
- `tools::Rd2HTML()` output is sanitized with ammonia. Remote `<img>` sources are stripped by the sanitizer; local images are served via webview URIs from package help directories.
- Bundled-manual links: `Rd2HTML` emits `<a href="/doc/manual/<name>.html">`; the renderer rewrites the allowlisted names (`R-intro`, `R-admin`, `R-data`, `R-exts`, `R-FAQ`, `R-ints`, `R-lang`) to `https://cran.r-project.org/doc/manuals/r-release/<name>.html`, percent-encoding the anchor.
- `Run examples` and per-package `Index` footer links are stripped because they target R's dynamic-help-server endpoints, which the panel doesn't run. Vignette links (`../../<pkg>/doc/<vignette>.html`) are neutralized.

## Plot viewer internals

From docs/plot-viewer.md "Substrate (for the curious)" and "Color theme":

- The theme toggle renders the plot as inline SVG inside the webview document (not `<img src=>`) so CSS variables and selectors reach SVG nodes.
- DOMPurify strips script tags, event handlers, external references, and inline `style="..."` attributes. Before sanitizing, safe presentation properties (fill, stroke, font, etc.) are migrated from `style="..."` to SVG presentation attributes so plot colors survive.
- The overlay hides the canvas background with CSS; text uses `--vscode-editor-foreground` and `--vscode-editor-font-family`; non-text shape strokes use `stroke: var(--vscode-editor-foreground)`.
- The toggle state persists globally via VS Code's `Memento`. The three right-side toolbar controls carry `aria-label`s; history/remove buttons use `title` text.

## Data viewer internals

From docs/data-viewer.md "How it works":

1. The Raven bootstrap profile (loaded via `R_PROFILE_USER` when you start a Raven-managed R terminal) installs a custom `View()` in `globalenv()` before the plot bridge runs. A failure in the plot bridge does not affect `View()`.
2. On `View(df)`, R writes the data frame to an Apache Arrow IPC (Feather v2) file in `<extension globalStorage>/data-viewer/`. Per-column variable-label and value-label metadata is captured into a single schema-level JSON blob (R's `arrow` package doesn't expose per-field metadata writes through its public API).
3. R POSTs the path to the extension's loopback HTTP server (`POST /view-data` with `{ sessionId, panelName, filePath, nrow }`). The route validates that the canonical path is under the per-extension data-viewer directory, rejecting anything else.
4. The extension opens the file via `apache-arrow` (JS), indexes record-batch starts, and serves row windows on demand to the webview over postMessage. Decoded batches are LRU-cached.

Also: persisted layout/sort/filter state is keyed by panel name × schema hash; the user page now says "panel name and the data's column layout". Sort restore stores only keys plus a Labels-state snapshot; the permutation is always recomputed because schema-hash equality doesn't imply equal row values. The toolbar wrap decision uses a hysteresis band. Factor filter checklists depend on whether the column's value dictionary has been shipped to the webview; large or unshipped dictionaries fall back to a free-text list.

## Knit internals

From docs/knit.md "What it does, step by step", "Fonts", and the preview-panel description:

- YAML front matter is parsed with js-yaml's `JSON_SCHEMA`, preserving YAML `null`, booleans, and numbers as their JS equivalents.
- The knit R process is spawned with `child_process.spawn` (never a shell), inheriting the environment.
- Post-knit, the in-memory Markdown (front matter stripped) is rendered with VS Code's `markdown.api.render` (KaTeX, image rewriting, scroll-sync metadata, registered `markdown-it` plugins), then `<pre><code class="language-X">` blocks are re-highlighted. R grammar priority: `REditorSupport.r-syntax` → `REditorSupport.r` → built-in `vscode.r` → Raven's vendored grammar. Raven's `function` LSP semantic-token overlay is layered on R blocks.
- The preview HTML loads in `<iframe srcdoc="..." sandbox="allow-same-origin">` (scripts, forms, popups, top-navigation blocked). HTML is inlined via `srcdoc` because a nested webview iframe cannot navigate to `webview.asWebviewUri(...)` URLs (Electron's resource handler does not intercept nested-frame navigations); an injected `<base href>` lets relative CSS and fonts resolve through the webview resource handler.
- Local `<img>` sources are read off disk and inlined as `data:` URLs before the HTML reaches the iframe, because a nested `<iframe srcdoc>` cannot fetch webview subresources. Containment uses `realpath`. Only the in-memory copy is rewritten; the on-disk `.html` keeps original paths.
- Copy, Select All, and the context menu are wired by hand on the iframe's same-origin `contentWindow`, because VS Code suppresses the default context menu and doesn't forward Cmd-C from a nested iframe.
- Theme toggle state is persisted in `globalState`; syntax colors come from the theme's TextMate `tokenColors` plus `semanticTokenColors` that map to a coarse role, plus `editor.tokenColorCustomizations`. The pressed state is exposed with `aria-pressed`.
- `<workspaceHash>` is SHA-256 of the first workspace folder URI (or the source's parent directory); `<sessionId>` is a UUID generated at extension activation; `<sourceHash>` is SHA-256 of the source's absolute path. Base is `<os.tmpdir()>/raven-knit/`.
- Fonts: the panel recomputes the fallback chain on every `onDidChangeConfiguration` event and pushes it into the webview (`__ravenFontFamilies` postMessage). The Settings UI enforces character and length rules via a JSON schema `pattern`; balanced-paren and balanced-quote checks live only in the runtime sanitizer. Bare parens are rejected because they would open a CSS function token; empty comma entries would be dropped by the browser via IACVT.

## Quarto internals

From docs/quarto.md "Quarto Preview", "Apply VS Code theme", and "The preview panel is blank":

- Readiness: Raven reads both stdout and stderr and strips terminal control sequences; takes the server origin from Quarto's `Listening on` line and the document path from `Browse at` when both are present; validates the URL as loopback-only HTTP; and probes it from the extension host until it responds before installing it in the panel. Stopping Preview cancels any outstanding readiness probe.
- The theme bridge is injected into eligible HTML responses by the loopback proxy. Only the enabled state, colors, and sanitized font families cross the frame boundary; the bridge accepts an exact, parent-source-checked message. The blank-panel advisory fires when the bridge hasn't confirmed a responsive HTML page within eight seconds.
- Render runs one-at-a-time per Quarto project (standalone files have independent slots; symlink aliases are the same file). The guard is released when the Quarto process finishes, not when the outcome notification is dismissed.
