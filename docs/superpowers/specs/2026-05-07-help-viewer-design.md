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

1. New `get_help_html(topic, package, r_path) -> Result<HelpHtml, HelpHtmlError>` in `help.rs`
   that spawns R and runs
   `tools::Rd2HTML(utils:::.getHelpFile(help(topic, package = (pkg))), ...)`.
   Mirrors the existing `get_help()` synchronous-watchdog timeout pattern (the
   sync function is wrapped by callers in `tokio::task::spawn_blocking`; the
   `tokio::time::timeout` invariant in `CLAUDE.md` is satisfied at that
   spawn-blocking layer, not inside the function itself). The `r_path`
   parameter is the configured/discovered R executable (sourced from the
   shared `RSubprocess`), so help renders against the same R installation
   used elsewhere; both `get_help` and the new `get_help_html` are migrated
   to take this parameter so behavior is consistent. (The existing
   `Command::new("R")` literal in `get_help` is part of the cleanup.)
2. New parallel `HtmlHelpCache` mirroring `HelpCache` exactly:
   `HELP_CACHE_MAX_ENTRIES = 512`, `NEGATIVE_CACHE_TTL = 300s`, drained on
   libpath-change events through the existing `libpath_watcher`. Adds
   **single-flight de-duplication** (see "Caching & concurrency" below) —
   concurrent misses for the same `(topic, package)` share one R subprocess
   call instead of spawning duplicates.
3. Server-side cross-reference link rewriting with **percent-encoded path
   segments** so topics containing operators (`[`, `[[`, `+`, `%in%`, `?`,
   etc.) and aliases containing `/`, `#`, or `%` round-trip safely:
   `raven-help://topic/<pct(pkg)>/<pct(topic)>[#<pct(anchor)>]`.
4. New `raven.getHelpHtml` server command exposed through `workspace/executeCommand`
   (not advertised in `executeCommandProvider.commands`, per the rule in
   `CLAUDE.md`). The dispatcher **independently re-validates** every
   `(topic, package)` pair it receives — webview messages are untrusted.
5. New VS Code extension module under `editors/vscode/src/help/`:
   - `help-panel.ts` — webview lifecycle, history stacks, navigation logic.
   - `messages.ts` — typed wire protocol mirroring `plot/messages.ts`.
   - `index.ts` — command registration and the markdown-trust middleware.
   - `webview/` — Svelte UI mirroring `plot/webview/` patterns.
6. Hover handler change: when `(topic, package)` is known and the existing
   cache (`HelpCache::get_or_fetch()`) returned content, prepend a bold
   clickable line:

   ```text
   **[`pkg::name`](command:raven.openHelpPanel?<encoded-args>)**
   ```

   to the hover markdown. Always include the `pkg::` qualifier (including for
   base packages — the user gets to know where things come from). Note that
   this reuses the **same** `get_or_fetch` value the hover handler already
   computed — no second R subprocess per hover.
7. New setting `raven.help.viewerColumn` (`active` | `beside`, default
   `beside`), wired through all three places per the `CLAUDE.md` rule.
8. Real subprocess-timeout test coverage for both the new `get_help_html` and
   the existing `get_help` (the latter is currently uncovered).
9. Server-side HTML sanitization (allowlist of help-relevant tags via the
   `ammonia` crate — committed dependency, see "HTML sanitization") before
   returning HTML to the extension. Defense in depth on top of CSP;
   protects against malformed Rd that injects `<form>`, `<iframe>`,
   `<object>`, or other tags CSP doesn't constrain.
10. Topic-name validation (new `is_valid_help_topic()` helper) that accepts
    legitimate operator topics (`[`, `[[`, `+`, `%in%`, `if`, `?`, etc.) but
    rejects shell metacharacters, control characters, and oversized inputs.
    Used both at the dispatcher boundary and as a precondition in
    `get_help_html`. The existing `get_help` is also migrated to use this
    validator (a defense gap the new work picks up).

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
                              ┌─────────────────────────────────┐   ┌────────────────────┐
                              │ get_help_html (Rust)            │   │  Webview (Svelte)  │
                              │ • validate topic / package      │   │  • render HTML     │
                              │ • spawn R via configured r_path │   │  • intercept clicks│
                              │ • Rd2HTML + tempfile metadata   │   │    (preventDefault │
                              │ • cap stdout at 8 MiB           │   │     for all anchors│
                              │ • sanitize (ammonia)            │   │     except #anchor)│
                              │ • rewrite cross-refs            │   │  • back / forward  │
                              │ • return html + helpDir +       │   │    button events   │
                              │   libPaths (canonical from R)   │   └─────────┬──────────┘
                              │ • HtmlHelpCache (single-flight) │             │
                              └─────────────────────────────────┘             │  raven-help://...
                                                                              ▼
                                                                    navigate message
                                                                    → HelpPanel (validates
                                                                        before re-issuing)
```

Three components:

### Server-side help renderer

Under `crates/raven/src/help.rs` (or split into `crates/raven/src/help/` if the
file outgrows itself; see "Implementation notes" below):

- `pub fn get_help_html(topic: &str, package: Option<&str>, r_path: &Path) -> HelpHtmlResult`.
- `HelpHtml { html: String, title: String, topic: String, package: String, help_dir: PathBuf, lib_paths: Vec<PathBuf> }`.
  Returns `Result<HelpHtml, HelpHtmlError>` where the error is one of the
  enumerated `reason` values from the LSP response.
- Sync function (mirrors `get_help` exactly): same kill-on-timeout watchdog
  thread + `child.wait()` pattern. Callers wrap it in
  `tokio::task::spawn_blocking` to keep the LSP runtime non-blocking — that
  is where the `tokio::time::timeout` invariant lives. The function does
  **not** itself use `tokio::time::timeout`.
- The `r_path` argument is the configured/discovered R executable, sourced
  from the shared `RSubprocess::r_path()` (or directly from
  `state.r_subprocess`). The existing `Command::new("R")` literal in
  `get_help` is replaced by the same `r_path` parameter as part of this
  work, so help rendering, package indexing, and other R queries always
  agree on the R installation.
- **Single-subprocess strategy with two output sinks**: rendered HTML
  goes to `stdout`; metadata goes to a per-request **tempfile** whose
  path is passed in via R command-line args. This eliminates marker
  collision risk (the previous `<!--RAVEN-META-->` inline marker would
  be ambiguous if a package's documentation happened to include the
  literal string).

  ```r
  # Argument order is fixed: [1]=topic, [2]=package-or-empty, [3]=tempfile path.
  # The caller MUST pass three positional args; pass "" for an absent package.
  args <- commandArgs(trailingOnly = TRUE)
  topic <- args[1]
  pkg <- if (nzchar(args[2])) args[2] else NULL
  meta_path <- args[3]  # absolute path to per-request tempfile
  rd <- utils:::.getHelpFile(help(topic, package = (pkg)))
  resolved_pkg <- attr(rd, "package")
  # Canonical topic: first \alias entry in the Rd object, falling back
  # to the requested topic if Rd2HTML chose to render this same Rd in
  # response to that alias.
  aliases <- vapply(
    Filter(function(x) attr(x, "Rd_tag") == "\\alias", rd),
    function(x) as.character(x[[1]]),
    character(1)
  )
  canonical_topic <- if (length(aliases) >= 1) aliases[1] else topic
  help_dir <- system.file("help", package = resolved_pkg)
  lib_paths <- .libPaths()
  # Write metadata to the tempfile (simple key=value lines, no JSON dep)
  con <- file(meta_path, "w")
  on.exit(close(con))
  cat("topic\t", canonical_topic, "\n", sep = "", file = con)
  cat("package\t", resolved_pkg, "\n", sep = "", file = con)
  cat("helpDir\t", help_dir, "\n", sep = "", file = con)
  for (lp in lib_paths) cat("libPath\t", lp, "\n", sep = "", file = con)
  # Render HTML to stdout
  tools::Rd2HTML(rd, out = stdout(), package = resolved_pkg)
  ```

  - **No `jsonlite` dependency**: the metadata is emitted as
    tab-separated `key\tvalue\n` lines that the Rust side parses with
    `str::lines()` and `split_once('\t')`. Robust against package
    documentation contents.
  - **`canonical_topic`** is the first `\alias` from the Rd object,
    which R uses as the page's primary identifier. Cross-references in
    rewritten URLs and history entries use the canonical topic so
    requesting `("filter.tbl_df", null)` and `("filter", "dplyr")`
    converge on the same cache key after R resolves them.
  - **`help_dir`** is sourced from `system.file("help", package = ...)`,
    not constructed as `<libpath>/<pkg>/help`. R is the authority on
    where its help assets live; this works for unusual installs (binary
    packages with custom layouts, `R CMD INSTALL --prefix`, etc.).
- **Tempfile lifetime**: the metadata tempfile is created server-side
  before the R subprocess is spawned (using `tempfile::NamedTempFile`),
  and its absolute path is the third argument passed to R. The
  `NamedTempFile` is held by an RAII guard for the entire fetch — its
  `Drop` impl removes the file on:
  - Normal completion (after metadata is read).
  - R subprocess spawn failure.
  - R timeout / watchdog kill.
  - Stdout cap exceeded.
  - Owner task panic or cancellation (the RAII guard is dropped on
    unwind).
  - Metadata parse failure (the guard outlives the parse step).

  This guarantees no orphaned tempfiles regardless of the failure
  path. Cleanup errors during `Drop` are logged at `trace` level and
  ignored.
- After R returns, the function:
  1. Reads the tempfile and parses the `key\tvalue` lines.
  2. Validates required keys (`topic`, `package`, `helpDir`, at least
     one `libPath`).
  3. **On metadata parse failure** — empty file, missing required
     keys, or unreadable — returns `HelpHtmlError::RenderFailed`. No
     "fallback to canonical libpath" recovery; the result is too
     degraded to be useful.
  4. Sanitizes the HTML (see "HTML sanitization" below). On
     sanitization failure (extremely rare — `ammonia` panics or
     malformed UTF-8 in Rd2HTML output), returns
     `HelpHtmlError::RenderFailed`.
  5. Runs `rewrite_help_html(html, source_pkg)` — pure function; covered
     below.
  6. Extracts `title` from the sanitized HTML's first `<h2>` (falls
     back to the canonical topic name if no `<h2>` is present).
- **Stdout size cap**: the read thread aborts and returns
  `HelpHtmlError::TooLarge` if more than `HELP_HTML_MAX_BYTES` (default 8
  MiB) is read. Real help pages are far below this. The cap protects the
  LSP from pathological packages and from R looping in some unforeseen
  way.
- Cached by `HtmlHelpCache` (see "Caching & concurrency").

### Extension panel manager

Under `editors/vscode/src/help/`:

- `help-panel.ts`:
  - Singleton webview panel; created lazily on first `raven.openHelpPanel`
    invocation, reused thereafter. Reveals existing panel if already open.
  - Holds the back/forward stacks (cap 50, FIFO drop oldest), current entry,
    and a monotonic request id used to cancel stale `getHelpHtml` responses.
  - **`localResourceRoots` policy**: the panel is created with
    `localResourceRoots = libPaths` from the **first** successful response.
    Every subsequent successful response also carries `libPaths`; the
    extension treats this field as authoritative on every response. If a
    later response's `libPaths` is not a subset of the panel's current
    roots (e.g., R's `.libPaths()` changed mid-session — `.libPaths()`
    mutated, `renv` activation, etc.), the panel is disposed and
    recreated on the next request. No separate polling RPC. (`libPaths`
    appears on every response for simplicity; consumers should treat the
    most recent one as authoritative.)
  - On each `load` from the server, runs the image-rewrite pass per the
    classification rules in the **Image serving** section below
    (`data:` passes through, remote schemes drop, relative paths
    resolve under `helpDir` with traversal guards). The Extension
    panel manager hosts the implementation; the Image serving section
    is the authoritative spec.
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
- Click handler on the help-content area uses **a single delegated listener
  on the help-content root**. Behavior depends on the link kind:
  - `raven-help://topic/<pkg>/<topic>[#anchor]`: `preventDefault()`,
    percent-decode each path segment and the anchor exactly once, then
    post `navigate { topic, package, anchor? }` to extension.
  - `https://...` / `http://...` / `mailto:...` (allowed protocols only):
    `preventDefault()`, post `open-external { url }`. Extension
    validates the URL parses cleanly and that its scheme is
    allowlisted before calling `vscode.env.openExternal`.
  - `#anchor` (in-page only — leading `#`, no scheme, no path):
    **no `preventDefault()`** — let the browser scroll natively.
  - Anything else (other schemes, `javascript:`, malformed URLs, relative
    paths the server rewriter missed, or anchors carrying
    `data-raven-dropped="1"` from server-side neutralization):
    `preventDefault()`, post `report-error` to the extension for
    telemetry. Never navigates.

## LSP protocol surface

One new server command, registered in the `workspace/executeCommand` dispatcher
in `handlers.rs`:

- **Command name**: `raven.getHelpHtml`
- **Args**: `[topic: string, package: string | null]`
- **Returns** (JSON):

  ```jsonc
  // success
  {
    "ok": true,
    "topic": "filter",       // canonical topic R resolved to (may differ from request)
    "package": "dplyr",      // canonical package R resolved to
    "title": "Subset rows using column values",
    "html": "...",
    "helpDir": "/Library/.../dplyr/help",
    "libPaths": ["/Library/Frameworks/R.framework/.../library", "..."]
  }

  // failure
  {
    "ok": false,
    "reason": "not-found" | "package-not-installed" | "render-failed" | "timeout" | "r-unavailable" | "invalid-topic" | "too-large",
    "message": "..."
  }
  ```

- **Canonical topic/package**: R may resolve a request like
  `("filter", "dplyr")` to a help page whose canonical topic is the same, or
  in alias cases (e.g., `("filter.tbl_df", null)`) to a different topic
  string. The server returns whatever R came back with; the extension uses
  these canonical values for the panel title and history entries. The
  rewritten cross-reference URLs use the canonical names so back/forward to
  the same page hits the cache.
- **Dispatcher validation**: the executeCommand handler **independently
  validates** every incoming `(topic, package)` regardless of where the
  call originated. Webview-supplied messages are untrusted — the server
  rewriter is the only entity that emits well-formed `raven-help://` URLs,
  but a malicious or buggy webview could in principle post arbitrary
  navigate messages. Validation:
  - `topic` must satisfy `is_valid_help_topic()` (see "Validation" below).
  - `package` (if provided) must satisfy `is_valid_package_name()`
    (existing function in `r_subprocess.rs`).
  - On failure, return `{ ok: false, reason: "invalid-topic", message }`
    without spawning R.

Per `CLAUDE.md`, the command is **not** added to
`executeCommandProvider.commands` — `vscode-languageclient`'s
`ExecuteCommandFeature` would otherwise auto-register it as a VS Code command,
clashing with the extension's own `raven.openHelpPanel` registration. The
server still handles it from `workspace/executeCommand` regardless.

## Validation

A new `pub(crate) fn is_valid_help_topic(s: &str) -> bool` in `help.rs`:

- Length 1..=256 bytes.
- All chars must be one of:
  - ASCII alphanumeric.
  - `.`, `_`, `-` (legitimate in topic names).
  - The set of R operator-topic characters: `[`, `]`, `(`, `)`, `+`, `-`,
    `*`, `/`, `^`, `<`, `>`, `=`, `!`, `&`, `|`, `~`, `$`, `@`, `:`, `?`,
    `%`, ` ` (e.g., `%>%`, `[[`, `<-`, `if`, `for`, `while`, `Control`).
- Reject if the string contains:
  - Any control character (`\x00..\x1f`, `\x7f`).
  - A NUL byte.
  - Backticks (these confuse R's `help()` semantics; also a strong injection
    smell).
- Used by both the executeCommand dispatcher and `get_help_html` itself
  (defense in depth — same check applied twice). The existing `get_help`
  is migrated to use this validator too.

Note: `is_valid_help_topic` is intentionally permissive about R-syntax
characters because R help genuinely has these topics. It does **not**
prevent every conceivable misuse — its job is to reject obviously
malformed input and keep the API surface predictable. R itself rejects
unknown topics with `not-found`.

## Cross-reference link rewriting

Pure function `rewrite_help_html(html: &str, source_pkg: &str) -> String`,
covered by unit tests with no R subprocess required.

The rewriter walks `<a href="...">` attributes and produces:

| Input | Output |
| --- | --- |
| `../../base/help/sum` | `raven-help://topic/base/sum` |
| `../../dplyr/help/filter` | `raven-help://topic/dplyr/filter` |
| `../../dplyr/help/filter#examples` | `raven-help://topic/dplyr/filter#examples` |
| `../../base/help/%5B` (i.e., `[`) | `raven-help://topic/base/%5B` |
| `../../base/help/+` (operator topic) | `raven-help://topic/base/%2B` |
| `../../<pkg>/topic/<topic>` (older Rd format) | same as `help/` form |
| `../../<pkg>/doc/<vignette>.html` (vignette link) | unchanged (out of v1 scope) |
| `https://example.com/...` | unchanged |
| `http://example.com/...` | unchanged |
| `mailto:...` | unchanged |
| `#examples` (in-page) | unchanged |
| anything else (file://, javascript:, malformed) | replaced with `href="javascript:void(0)"` and `data-raven-dropped="1"` so the webview's universal `preventDefault()` neutralizes them |

**Path-segment encoding rules** (apply uniformly to `pkg`, `topic`, **and**
the optional `anchor`):

1. **Decode-then-encode pipeline**: each segment from the source href is
   percent-decoded **once** (so `%5B` from Rd2HTML becomes `[`), then
   re-encoded with our strict allowlist. This canonicalizes the source
   regardless of how Rd2HTML happened to encode it; identical topics
   always produce identical rewritten URLs.
2. **Encoding allowlist**: keep only `[A-Za-z0-9._~-]` unencoded (RFC 3986
   "unreserved"); percent-encode every other byte, including `/`, `#`,
   `%`, `+`, `?`, ASCII whitespace, control characters, and any non-ASCII
   bytes. This is stricter than `encodeURIComponent` (which leaves `!`,
   `*`, `(`, `)`, `'` unescaped) but produces unambiguous URLs.
3. **Decoding in the webview**: the click handler percent-decodes each
   path segment and the anchor exactly once before forwarding the
   (`topic`, `package`, `anchor?`) tuple to the extension.

The same rules govern hover-link encoding: `encodeURIComponent` is
sufficient on the JSON arg array (it's only used to wrap the JSON for the
`command:` URL).

**Malformed `../../...`** is **not** left in place; the rewriter neutralizes
it as in the table. Relying on a webview "default → ignore" branch to
handle those was the previous draft and was unsafe — it left valid-looking
relative URLs that VS Code's webview could attempt to navigate.

`<img src="...">` is **not** rewritten by the server. The server returns
`helpDir` and the extension does the image-rewrite pass at render time, since
only the extension can call `webview.asWebviewUri(...)`.

## HTML sanitization

After Rd2HTML produces the help body, but before the rewriter runs and the
response is returned, the server passes the HTML through the
[`ammonia`](https://crates.io/crates/ammonia) crate (committed dependency,
not "or equivalent" — this fixes a behavior contract we test against). The
allowlist is restricted to the tags that Rd2HTML actually emits and a small
additional set of generic block/inline tags:

- Headings: `h1`, `h2`, `h3`, `h4`, `h5`, `h6`.
- Block: `p`, `div`, `pre`, `blockquote`, `hr`, `table`, `thead`, `tbody`,
  `tr`, `th`, `td`, `caption`, `dl`, `dt`, `dd`, `ul`, `ol`, `li`.
- Inline: `a`, `code`, `em`, `strong`, `i`, `b`, `span`, `br`, `sub`, `sup`.
- `img` (with the `src` attribute, validated by the extension downstream).

Attribute allowlist:

- Universal: `class`, `id`, `title`.
- `<a>`: `href`.
- `<img>`: `src`, `alt`, `width`, `height`.
- `<table>`/`<th>`/`<td>`: `colspan`, `rowspan`, `align`.

Everything else (e.g., `onclick`, `onload`, `<script>`, `<iframe>`,
`<object>`, `<embed>`, `<form>`, `<input>`, `<style>` elements) is
stripped.

**`style` attribute policy**: `ammonia` does not analyze CSS
declarations, so a fine-grained allowlist of CSS properties is
impractical. Two-step approach instead:

1. Before passing to `ammonia`, run a **regex pre-pass** over the raw
   HTML that strips any `style="..."` attribute whose value contains
   `url(` (case-insensitive). This is a coarse filter — it strips the
   whole attribute even if the URL was benign. It is cheap, well-tested,
   and covers the threat (CSS-loaded images bypassing the image
   policy).
2. `ammonia` then sees `style` attributes that are guaranteed
   `url(`-free; we add `style` to the per-tag attribute allowlist for
   the tags Rd2HTML actually emits with inline styles.

Because every remaining `style=` value is `url(`-free, the
already-strict CSP `default-src 'none'` plus the lack of `https:` in
`img-src` together defang any other CSS-loaded resource (fonts, etc.)
even if `ammonia`'s allowlist later changes.

**Sanitizer failure behavior**: `ammonia::clean()` does not return a
`Result` — it always produces a string. The only failure surface is
panic (e.g., from a malformed UTF-8 input) or upstream library bugs.
The implementation wraps the call in `std::panic::catch_unwind` and
maps any panic to `HelpHtmlError::RenderFailed`. Sanitizer panics are
logged at `warn` level with the offending package/topic for
investigation but never crash the LSP.

## Image serving

- Server returns `helpDir` from R's `system.file("help", package = ...)`.
  This is canonical even on installs where `<libpath>/<package>/help/`
  does not directly hold the assets.
- Extension at panel creation passes `localResourceRoots = libPaths` from
  the first response. The roots are `libPaths`, not just `helpDir`,
  because navigation across packages is expected.
- On each `load`, extension scans the HTML for `<img src="...">` and
  classifies the src by scheme:

  | Source `src` | Action |
  | --- | --- |
  | `data:image/...` | **Pass through unchanged**. CSP allows `data:`. R help may legitimately embed small icons inline. |
  | Relative path (no scheme) | Process: prepend `helpDir`, canonicalize, validate under `helpDir`, rewrite to `webview.asWebviewUri(...)`. |
  | `http:` / `https:` / `ftp:` / `ws:` / `mailto:` / any non-`data:` remote scheme | Replace `src` with `""` (broken-image icon). Blocks privacy/tracking surface. |
  | `file:` (absolute filesystem URL) | Replace `src` with `""`. Rd2HTML should never emit these; if it did we'd lose the helpDir validation. |
  | Anything else (malformed, control chars) | Replace `src` with `""`. |

  For the relative-path case:
  1. Compute absolute path: `join(helpDir, srcRelative)`.
  2. Canonicalize (resolve `..`, symlinks).
  3. Verify the canonicalized path is **under the response's
     `helpDir`** (not just under any libpath root). This blocks
     `\figure{../../etc/passwd}` traversal **and** cross-package
     references like `<img src="../../OTHERPKG/help/figures/x.png">`.
  4. If validated, rewrite to `webview.asWebviewUri(vscode.Uri.file(absPath)).toString()`.
  5. Otherwise, set `src=""`.

CSP for the panel (no `https:` in `img-src`; only `data:` for inline icons
plus the webview's own resource origin for our rewritten file URLs):

```text
default-src 'none';
img-src ${webview.cspSource} data:;
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

- When `(topic, package)` are known and `HelpCache::get_or_fetch(topic, package)`
  returned `Some(text)` (i.e., the hover already computed help text), prepend
  a single line to the hover markdown:

  ```text
  **[`pkg::name`](command:raven.openHelpPanel?<encoded-args>)**
  ```

  where `<encoded-args>` is `encodeURIComponent(JSON.stringify([topic, package]))`.

- **Crucially, this reuses the existing `get_or_fetch` result the hover handler
  already computed.** It does NOT introduce a second R subprocess call per
  hover. The link is purely a markdown prefix derived from the same `(topic,
  package)` the hover handler already resolved.
- The `pkg::` qualifier is always shown, including for base packages
  (`base`, `stats`, `graphics`, `utils`, `methods`, `grDevices`, `datasets`).
  Knowing where a function lives is genuinely useful; users explicitly opted
  into this in the brainstorm.
- When help is unavailable for a symbol (local variable, unknown reference,
  or a function in a package whose help failed to fetch), no line is added —
  the rest of the hover is unchanged.
- **S3/S4 method dispatch**: the hover handler resolves a symbol like
  `print.data.frame` to whatever `(topic, package)` the existing logic
  derives. The resulting help page is whatever R returns for
  `help("print.data.frame", ...)` — sometimes the method-specific Rd,
  sometimes the generic, depending on the package's documentation
  layout. We trust R's resolution rather than re-implementing dispatch
  awareness. The canonical `(topic, package)` the server returns may
  differ from the request, and the panel title / history reflect what R
  actually rendered.

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

## Caching & concurrency

`HtmlHelpCache` mirrors `HelpCache` in structure (LRU 512 entries, negative
TTL 300s, drained on libpath-change events) and adds **single-flight
de-duplication**:

- An `Arc<Mutex<HashMap<String, tokio::sync::broadcast::Sender<HelpHtmlResultShared>>>>`
  holds in-flight fetches keyed by `cache_key(topic_request, package_request)`.
  The shared payload is `Arc<Result<HelpHtml, HelpHtmlError>>` so all
  subscribers share one allocation.
- On a cache miss, a caller acquires the in-flight mutex, then:
  - If no entry exists for the **requested** key, inserts a fresh
    `broadcast::Sender` and proceeds to spawn R as the **owner** of this
    fetch.
  - If an entry exists, calls `sender.subscribe()` to get a receiver,
    drops the mutex, and `await`s the receiver. No second subprocess.
- **Canonical-key convergence**: when R resolves the request, the
  response carries `(canonical_topic, canonical_package)` which may
  differ from the requested values (alias case). On a successful fetch
  the cache writes the result **under BOTH keys** (requested and
  canonical); subsequent requests with either alias hit the cache. This
  costs an extra `lru::push()` per uncached fetch and avoids running R a
  second time when a user navigates between two aliases that resolve to
  the same Rd.
- **Cache-key lookup order** (for a request `(t, p)`):
  1. Probe cache at `cache_key(t, p)` — return on hit.
  2. Probe in-flight map at `cache_key(t, p)` — subscribe on hit.
  3. Spawn R. On success, write the result to BOTH `cache_key(t, p)`
     and `cache_key(canonical_topic, canonical_package)`.
  
  We do not pre-resolve `(t, p)` → canonical before the cache probe
  (that would require a second R round-trip). Two requests for two
  different aliases of the same page will each spawn R **once** the
  first time; from the second onward, both keys are populated.
- When the owner completes:
  1. Decides whether the result should be **cached** based on the
     classification table below.
  2. If cacheable: writes to the LRU cache under the requested key
     **and** the canonical key (positive results) or just the requested
     key (negative results — the canonical key is unknown when R
     reports the topic doesn't exist).
  3. Broadcasts the shared result on the channel.
  4. Removes the in-flight entry from the map.
- **Sender-dropped behavior**: the owner is held in a `tokio::spawn` task
  guarded by a `Drop` impl that, if the task is canceled or panics
  before broadcast, removes the in-flight entry and drops the sender.
  Subscribers receive `RecvError::Closed`, which the caller maps to
  `HelpHtmlError::RenderFailed("subprocess task aborted")`. The owner
  task is **not** canceled when the originating caller's request id is
  superseded — the LSP-side request id only governs whether the LSP
  forwards the result to the extension. Letting the owner finish
  ensures other subscribers (and the cache) still benefit.

**Result-classification table** (which errors get cached):

| Result | Cached as positive? | Cached as negative? | TTL |
| --- | --- | --- | --- |
| `Ok(HelpHtml)` | ✓ | — | until LRU eviction or libpath-change drain |
| `Err(NotFound)` | — | ✓ | 300s (`NEGATIVE_CACHE_TTL`) |
| `Err(PackageNotInstalled)` | — | ✓ | 300s |
| `Err(InvalidTopic)` | — | ✓ | 300s — these args won't become valid |
| `Err(RenderFailed)` | — | ✓ | 300s — the Rd is malformed; not a transient issue |
| `Err(TooLarge)` | — | ✓ | 300s |
| `Err(Timeout)` | — | **not cached** — transient | n/a |
| `Err(RUnavailable)` | — | **not cached** — env will be fixed | n/a |

For non-cached errors, the in-flight entry is removed but no cache write
happens; the next request retries the R subprocess.

The same single-flight pattern is also retrofitted onto
`HelpCache::get_or_fetch` during this work. It's a small refactor (one
new field + one helper) and fixes a long-standing inefficiency under
concurrent hover.

## Edge cases & error handling

| `reason` | Trigger | Panel response |
| --- | --- | --- |
| `not-found` | R returns no Rd db match (typo, deprecated topic, alias not in any installed package) | `"No help available for \`topic\`"` |
| `package-not-installed` | Cross-ref to a package missing from libpaths | `"Package \`pkg\` is not installed."` (no install button in v1) |
| `render-failed` | `Rd2HTML()` errors on a malformed Rd | `"Could not render help for \`topic\`."` + retry button |
| `timeout` | R subprocess exceeds `HELP_TIMEOUT` (10s default) | `"R timed out rendering help."` + retry button |
| `r-unavailable` | R binary not configured / not found | `"R is not configured. Check raven.packages.rPath."` |
| `invalid-topic` | Dispatcher rejected the args before reaching R | `"Invalid help topic: \`topic\`"` (rare; typically only on a buggy webview) |
| `too-large` | Rd2HTML output exceeded `HELP_HTML_MAX_BYTES` (8 MiB default) | `"Help page too large to display."` + suggestion to file an issue |

Other defensive behavior:

- **Race conditions**: each `getHelpHtml` invocation gets a monotonic request
  id; stale responses are dropped.
- **Cache staleness on package install/uninstall**: the existing
  `libpath_watcher` already fires on package library changes; hook
  `HtmlHelpCache` to drain on those events (matches `HelpCache`'s existing
  behavior).
- **Concurrent same-topic requests**: single-flight de-dup (see "Caching &
  concurrency" above) — only one R subprocess per `(topic, package)` at a
  time; subscribers share its result.
- **Special characters in topic names**: operators (`+`, `if`, `%>%`) work
  because args go through R via `--args` rather than shell interpolation,
  and `is_valid_help_topic()` permits the operator-character set explicitly
  (see "Validation"). Path segments in `raven-help://` URLs are
  percent-encoded.
- **External link reachability**: the extension calls
  `vscode.env.openExternal` for allowlisted URLs; if the URL is dead, the
  user's browser surfaces the error. Raven does not pre-flight remote URLs.
- **Vignettes and non-help Rd links**: the rewriter explicitly recognizes
  `../../<pkg>/help/` and `../../<pkg>/topic/` as cross-references to other
  Rd help pages. Vignette links (`../../<pkg>/doc/<vignette>.html`) are
  out-of-scope for v1 and pass through unchanged; the webview's universal
  `preventDefault()` plus the dispatcher's "navigate" allowlist guard
  prevents accidental navigation. Vignette browsing can be added in a
  follow-up by extending the rewriter and adding a dedicated rendering
  path.
- **Multiple R installations**: `get_help_html` always uses the same R
  executable as the rest of Raven (sourced from `RSubprocess::r_path()`).
  `find.package`/`system.file` calls inside the same R subprocess therefore
  resolve against the same `.libPaths()` the user expects. This fixes a
  pre-existing inconsistency where `get_help` ran bare `R` from PATH and
  `r_subprocess.rs` used the configured executable.
- **Webview state across VS Code reload**: not persisted. Panel recreated
  fresh on next open. Within a session, `retainContextWhenHidden: true`
  preserves history when the panel is hidden behind another tab. If the user
  closes the panel, history is dropped.

## Settings & commands

### Settings

```jsonc
"raven.help.viewerColumn": {
  "type": "string",
  "enum": ["active", "beside"],
  "default": "beside",
  "description": "Where the R help viewer panel opens. 'beside' splits the editor; 'active' replaces the current editor."
}
```

Matches the existing `raven.plot.viewerColumn` naming convention. Wired in
three places per `CLAUDE.md`:

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
     structure (e.g., a `<table>` for arguments and the title text), and the
     returned `helpDir`/`libPaths` round-trip parse cleanly.
   - Successful render for an operator topic like `("[", "base")` — verifies
     the percent-encoding path through `<--args>` to R works.
   - Each failure path (`not-found`, `package-not-installed`,
     `render-failed`, `invalid-topic`, `too-large`) returns the right
     `reason`.
   - `r_path` actually used: passing a non-existent path returns
     `r-unavailable`, not a panic; passing a valid path renders correctly.

2. **`is_valid_help_topic` unit tests** (pure):
   - Accepts: `mean`, `[`, `[[`, `+`, `%>%`, `if`, `for`, `<-`, `print.default`,
     `:::`, `?`, mixed case, leading dot.
   - Rejects: empty string, NUL byte, control chars (`\n`, `\t`, `\r`,
     `\x01`), backticks, length > 256, non-ASCII bytes (`é`, emoji), and
     deliberately weird inputs like `topic with spaces and a < newline >`.

3. **HTML rewriting unit tests** (pure, no R needed):
   - `../../base/help/sum` → `raven-help://topic/base/sum`.
   - `../../dplyr/help/filter#examples` → `raven-help://topic/dplyr/filter#examples`.
   - Operator topics in cross-refs are percent-encoded:
     `../../base/help/[` → `raven-help://topic/base/%5B`.
   - `../../base/topic/foo` (older format) rewritten to the same scheme.
   - `../../<pkg>/doc/<vignette>.html` left unchanged (vignettes out of v1).
   - `https://example.com/...`, `mailto:...`, `#examples` pass through.
   - `<img src="figures/foo.png">` is left for the extension; not mangled by
     the server.
   - **Malformed `../../` inputs are neutralized** (rewritten to
     `javascript:void(0)` with `data-raven-dropped="1"`), not left as-is.
   - The rewriter is idempotent: running twice yields the same output.

4. **HTML sanitization unit tests** (pure):
   - `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<input>`
     stripped.
   - `onclick`, `onerror`, `onload` attributes stripped from kept tags.
   - `style="color: red"` preserved; `style="background: url(http://x)"`
     has the `url(...)` expression dropped.
   - Standard Rd2HTML output (table, dl/dt/dd, code/pre) round-trips.

5. **`HtmlHelpCache` tests** — copy the structure of existing `HelpCache`
   tests: LRU eviction (cap 512), negative TTL, concurrent reads/writes,
   drain on libpath-change event. **Plus single-flight de-dup**:
   simultaneous misses for the same key spawn exactly one fetch and all
   callers receive the same result.

6. **executeCommand dispatcher**:
   - `raven.getHelpHtml` returns `{ ok: true, ... }` for known topics and
     the right `{ ok: false, reason }` shape for failures.
   - **Validation enforced at the dispatcher**: invalid topics/packages
     are rejected with `reason: "invalid-topic"` without spawning R
     (verified via a mocked subprocess counter or by passing inputs that
     would fail validation but succeed in R).

7. **Hover integration** — for a known `(topic, package)` like `(filter, dplyr)`,
   the hover begins with a line matching `^\*\*\[`...`\]\(command:raven\.openHelpPanel\?...\)\*\*$`.
   Symbols without help → no link prepended. **No additional R subprocess**
   is spawned by this code path (verified by counting subprocess
   invocations against the cache).

8. **Subprocess timeout** — both `get_help_html` and the existing `get_help`
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

9. **Stdout cap** — feed `get_help_html` a synthetic R snippet that emits
   more than `HELP_HTML_MAX_BYTES`; verify the function returns
   `reason: "too-large"` and the subprocess is reaped (no zombie pid).

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
     because the resolved absolute path is not under the response's
     `helpDir`.
   - Cross-package reference (`../../OTHERPKG/help/figures/x.png`) — even
     though it would resolve under a libpath root, the extension drops it
     because it is not under the **current** `helpDir`.
   - Absolute `http`/`https` srcs are dropped (no remote images).
   - `data:` srcs pass through unchanged.

4. **Settings wiring** — extend `editors/vscode/src/test/settings.test.ts`
   per the existing pattern. New entry in `SETTINGS_MAPPING` for
   `raven.help.viewerColumn`. Verify default and explicit values flow
   through `buildInitializationOptions`.

### Webview-side

Mocha tests using JSDOM:

1. Dispatch click events on `<a href="raven-help://topic/base/sum">`,
   `<a href="raven-help://topic/base/%5B">` (encoded `[`),
   `<a href="https://...">`, `<a href="mailto:...">`, `<a href="#anchor">`,
   `<a href="javascript:alert(1)">`, `<a href="file:///etc/shadow">`,
   `<a href="other://x">`, and a malformed URL.
2. Verify:
   - `raven-help://...` → `preventDefault()` called, `postMessage("navigate", { topic, package, anchor? })`.
     The topic/package values are **percent-decoded** before posting.
   - `https://`/`http://`/`mailto:` → `preventDefault()`, `postMessage("open-external", { url })`.
   - `#anchor` → no `preventDefault()`, no `postMessage`. Browser scrolls.
   - `javascript:`/`file:`/`other:`/malformed → `preventDefault()`,
     `postMessage("report-error", { ... })`. Never navigates.
3. Anchor elements with `data-raven-dropped="1"` (the rewriter's
   neutralization sentinel) trigger no postMessage and call
   `preventDefault()`.

### Manual smoke test plan

To be added to `docs/help-viewer.md` once the user-facing doc is written:

1. Hover over `dplyr::filter` in an R file → bold `dplyr::filter` heading at
   the top of hover; click → panel opens beside.
2. Panel shows R help with package header, title, usage, arguments, examples.
3. Click "See also: arrange" → panel navigates, back arrow now enabled.
4. Back arrow → returns to filter, scroll position restored.
5. Hover `plot(1:5)` → bold `graphics::plot` heading; click → navigates
   correctly even cross-package.
6. Hover an operator: `?\`[\`` or `?\`%in%\`` → bold heading uses the
   operator, click navigates and renders correctly (verifies percent-encoding
   round-trip and `is_valid_help_topic`).
7. Trigger a help page with images (e.g., `?ggplot2::theme` if installed) →
   images load.
8. Trigger an unknown topic by directly invoking the command → panel shows
   the not-found message; previous content & history preserved.
9. Configure a non-default R via `raven.packages.rPath` and verify help
   renders against that R installation (open a topic only available in a
   package installed for that R; should succeed where it would fail against
   system R).

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
- The `raven.help.viewerColumn` setting needs a row in
  `docs/configuration.md` (consistent with other `raven.*` settings).
