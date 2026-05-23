import * as path from 'path';
import { parseRenderedOutputPath } from './output-path';
import { githubDark, githubLight, type GithubPalette } from './github-colors';

export type KnitOutputMessage =
    | { type: 'refresh' }
    | { type: 'openInBrowser' }
    | { type: 'themeChanged'; applied: boolean }
    | { type: 'themeContext'; editorBackground: string };

/**
 * Marker key on `postMessage` payloads from the extension host to the
 * outer-shell script. We discriminate via a property instead of a
 * `type:` field because the existing in-iframe probe path also uses
 * `event.data.__ravenKnitProbe`, and a shared discriminator field
 * would risk silent collision with that or with VS Code-injected
 * message shapes.
 */
export const VSCODE_PALETTE_UPDATE_KEY = '__ravenVscodeThemePalette';

export interface VscodeThemePaletteUpdate {
    /** Marker — must equal `true`. */
    __ravenVscodeThemePalette: true;
    /**
     * Pre-built CSS declarations matching `paletteCssDeclarations` for
     * the VS Code theme. `null` clears the override so the toggle
     * falls back to the GitHub variant.
     */
    css: string | null;
}

/**
 * Strict type-narrowing for messages posted from the Knit Output webview.
 * The webview is a trust boundary; reject anything we did not explicitly
 * shape. Additional unknown properties on a recognized type are allowed
 * (the handler ignores them).
 */
export function isKnitOutputMessage(msg: unknown): msg is KnitOutputMessage {
    if (msg === null || typeof msg !== 'object') return false;
    const m = msg as { type?: unknown; applied?: unknown; editorBackground?: unknown };
    if (m.type === 'refresh' || m.type === 'openInBrowser') return true;
    if (m.type === 'themeChanged' && typeof m.applied === 'boolean') return true;
    if (m.type === 'themeContext' && typeof m.editorBackground === 'string') return true;
    return false;
}

/**
 * Possible outcomes of a single `runKnit` invocation, after we have
 * classified the raw engine result. Discriminated by `kind`. No user-
 * facing toasts or webview operations have been performed yet — that
 * happens in `renderOutcome`, OUTSIDE the `withProgress` callback. This
 * is the core of the Piece A bug fix: keeping the `withProgress`
 * lifecycle short and predictable.
 */
export type KnitOutcome =
    | { kind: 'spawnError'; error: NodeJS.ErrnoException }
    | { kind: 'cancelled' }
    | { kind: 'timedOut'; timeoutMs?: number }
    | { kind: 'failed'; exitCode: number | null }
    | { kind: 'noOutput' }
    | { kind: 'ok'; parsedOutputs: string[]; cwd: string | undefined };

/** Minimal subset of `runKnit`'s return value classify needs. */
export interface ClassifyInput {
    spawnError: NodeJS.ErrnoException | null;
    cancelled: boolean;
    timedOut: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Pure classifier mapping the engine's raw result onto a KnitOutcome.
 * Branch priority mirrors the original runKnitCommand:
 *   spawnError > cancelled > timedOut > failed > noOutput / ok
 */
export function classify(
    result: ClassifyInput,
    ctx: { cwd: string | undefined },
): KnitOutcome {
    if (result.spawnError) return { kind: 'spawnError', error: result.spawnError };
    if (result.cancelled) return { kind: 'cancelled' };
    if (result.timedOut) return { kind: 'timedOut' };
    if (result.exitCode !== 0) return { kind: 'failed', exitCode: result.exitCode };
    const parsed = parseRenderedOutputPath(result.stdout + '\n' + result.stderr).paths;
    if (parsed.length === 0) return { kind: 'noOutput' };
    return { kind: 'ok', parsedOutputs: parsed, cwd: ctx.cwd };
}

/**
 * Build the CSS variable declarations for a single GitHub palette
 * variant, in the same shape `render-html.ts:paletteAsCssVars` emits
 * when baking the rendered document. Used by the theme overlay to
 * re-emit `--raven-bg` / `--raven-fg` / `--raven-c-*` at overlay time
 * so the syntax-highlight palette tracks VS Code theme switches in
 * lockstep with the code-block background. Without this re-emit, a
 * theme switch after knit would update `--vscode-textCodeBlock-
 * background` (resolved live from the outer shell) while leaving the
 * baked-at-knit `--raven-c-*` tokens on the original variant — e.g.
 * dark tokens on a light shade.
 */
export function paletteCssDeclarations(palette: GithubPalette): string {
    return [
        `--raven-bg: ${palette.background};`,
        `--raven-fg: ${palette.foreground};`,
        `--raven-c-keyword: ${palette.roles.keyword};`,
        `--raven-c-string: ${palette.roles.string};`,
        `--raven-c-number: ${palette.roles.number};`,
        `--raven-c-comment: ${palette.roles.comment};`,
        `--raven-c-function: ${palette.roles.function};`,
        `--raven-c-type: ${palette.roles.type};`,
        `--raven-c-variable: ${palette.roles.variable};`,
        `--raven-c-operator: ${palette.roles.operator};`,
        `--raven-c-punctuation: ${palette.roles.punctuation};`,
        `--raven-c-constant: ${palette.roles.constant};`,
    ].join(' ');
}

/**
 * Minimal vscode.Webview shape buildShellHtml needs. Defined inline so
 * the pure helper has no dependency on the actual vscode module — tests
 * pass a fake.
 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build the outer-shell HTML for the Knit Output webview.
 *
 * The shell is Raven-controlled and owns the CSP in `<head>`; the
 * rendered HTML loads inside `<iframe srcdoc="..." sandbox="allow-
 * same-origin">`. Three independent containment layers (sandbox
 * attribute, outer-shell CSP, `localResourceRoots`) make the security
 * model robust to either layer failing.
 *
 * Why `srcdoc` rather than `src`: a nested `<iframe>` inside a VS Code
 * webview cannot navigate to a `webview.asWebviewUri(...)` URL —
 * Electron's resource handler does not intercept the nested-frame
 * navigation, so the network stack tries DNS resolution on
 * `file+.vscode-resource.vscode-cdn.net` and fails with
 * `ERR_NAME_NOT_RESOLVED`. Inlining the HTML via `srcdoc` avoids the
 * URL navigation entirely; relative subresource URLs in the rendered
 * HTML resolve via the injected `<base href="...">` (which IS a
 * subresource request, and those go through the SW happily).
 *
 * `sandbox="allow-same-origin"` is required (rather than `sandbox=""`)
 * so the srcdoc document inherits the parent webview origin instead of
 * a unique opaque origin. Scripts, forms, popups, and top-navigation
 * remain blocked.
 *
 * Pure helper — no dependency on the vscode module. The caller
 * (`KnitOutputPanel`) reads the rendered HTML from disk and converts
 * the output's parent directory via `webview.asWebviewUri(...)`,
 * passing the results as `htmlContent` and `baseHref`.
 *
 * See `docs/superpowers/specs/2026-05-17-knit-output-webview-design.md`
 * for the threat model.
 */
export function buildShellHtml(args: {
    htmlContent: string;
    baseHref: string;
    cspSource: string;
    outputPath: string;
    nonce: string;
    /**
     * Persisted theme-toggle state. Caller reads it from
     * `context.globalState` so the choice survives panel disposal /
     * recreation between knits.
     */
    initialThemeApplied: boolean;
    /**
     * Pre-built CSS declarations for the active VS Code theme's
     * resolved palette, matching the same shape
     * `paletteCssDeclarations` returns. When non-null, the toggle's
     * applyTheme() prefers these colors over the GitHub variant. If
     * the resolver failed (theme JSON not found, parse error, etc.)
     * the caller passes `null` and the toggle falls back to the
     * GitHub variant — same behavior as before this feature shipped.
     */
    vscodeThemePaletteCss?: string | null;
}): string {
    const {
        htmlContent,
        baseHref,
        cspSource,
        outputPath,
        nonce,
        initialThemeApplied,
        vscodeThemePaletteCss,
    } = args;
    // path.basename handles both POSIX and Windows separators.
    const lastSep = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
    const basename = lastSep >= 0 ? outputPath.slice(lastSep + 1) : outputPath;
    const safeName = escapeHtml(basename);
    // Baked-in CSS strings for the two GitHub palette variants. The
    // overlay script picks one at runtime based on VS Code's current
    // theme variant (read from `document.body.className`) and writes
    // it into the iframe's `:root` so syntax-token colors stay in
    // sync with the live code-block background.
    const lightPaletteCss = paletteCssDeclarations(githubLight);
    const darkPaletteCss = paletteCssDeclarations(githubDark);

    // about:srcdoc bypasses `frame-src` per CSP3, but VS Code's webview
    // can occasionally route the inline document through a real URL
    // (e.g. when the iframe resolves a base-relative resource), so we
    // keep `frame-src ${cspSource}` to whitelist subresource frames as
    // well. `img-src`/`style-src`/`font-src` already permit
    // `${cspSource}` for the rendered HTML's assets.
    const csp = [
        `default-src 'none'`,
        `frame-src ${cspSource}`,
        `img-src ${cspSource} https: data:`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `font-src ${cspSource} https: data:`,
        `script-src 'nonce-${nonce}'`,
        `connect-src 'none'`,
    ].join('; ');

    // Inject the base href so relative URLs in the rendered HTML
    // resolve through `webview.asWebviewUri(...)`, picking up the
    // outer webview's resource handler. Browsers honour a `<base>` tag
    // that appears anywhere in the head; HTML5 parsing creates an
    // implicit head when needed, so prepending is safe even for HTML
    // that already starts with `<!doctype html><html>...`.
    //
    // A `<base href>` also changes how *fragment-only* anchors
    // (`<a href="#section">`) are resolved: instead of resolving
    // against the document URL (`about:srcdoc`), they resolve against
    // the base URL, turning an in-document scroll into a full
    // navigation that fails for nested webview iframes. To preserve
    // intra-document anchor navigation, rewrite fragment-only hrefs
    // to be `about:srcdoc#…` — once the resolved URL matches the
    // document URL (sans fragment), the browser treats the click as
    // a same-document fragment navigation again.
    const srcdocHtml = `<base href="${escapeHtml(baseHref)}">`
        + rewriteFragmentAnchors(htmlContent);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Knit Output</title>
<style nonce="${nonce}">
  body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column;
         font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  #raven-knit-toolbar { display: flex; gap: 0.5rem; align-items: center;
                        padding: 0.4rem 0.75rem;
                        background: var(--vscode-editorWidget-background);
                        border-bottom: 1px solid var(--vscode-editorWidget-border);
                        flex: 0 0 auto; }
  #raven-knit-toolbar button { font: inherit; padding: 0.2rem 0.6rem;
                               background: var(--vscode-button-background);
                               color: var(--vscode-button-foreground);
                               border: 1px solid var(--vscode-button-border, transparent);
                               cursor: pointer; }
  #raven-knit-toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  /*
   * Theme toggle: visually distinct from action buttons.
   * Uses the VS Code "inputOption" CSS variables -- the same vars
   * the Find widget toggles (case-sensitive, whole-word, regex)
   * use. The active state gets a bordered, accent-tinted look
   * that does not collide with the primary action buttons.
   */
  #raven-knit-toolbar button#raven-knit-theme {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid transparent;
    /* Push the toggle to the right edge of the toolbar so it sits
       away from the action buttons -- "Apply theme" is a viewing
       preference, not an action. */
    margin-left: auto;
  }
  #raven-knit-toolbar button#raven-knit-theme:hover {
    background: var(--vscode-inputOption-hoverBackground,
                    var(--vscode-toolbar-hoverBackground,
                        var(--vscode-list-hoverBackground)));
  }
  #raven-knit-toolbar button#raven-knit-theme[aria-pressed="true"] {
    background: var(--vscode-inputOption-activeBackground,
                    var(--vscode-button-background));
    color: var(--vscode-inputOption-activeForeground,
                var(--vscode-button-foreground));
    border: 1px solid var(--vscode-inputOption-activeBorder,
                          var(--vscode-focusBorder));
  }
  #raven-knit-toolbar button#raven-knit-theme[aria-pressed="true"]:hover {
    background: var(--vscode-inputOption-activeBackground,
                    var(--vscode-button-background));
  }
  /*
   * The ::before pseudo-element holds the checkmark prefix and an
   * empty placeholder when the toggle is off. Pre-allocating the
   * width with "visibility: hidden" for the inactive state keeps
   * the button's pixel width stable across toggles so the toolbar
   * does not reflow on every click.
   */
  #raven-knit-toolbar button#raven-knit-theme::before {
    content: "✓";
    margin-right: 0.35em;
    visibility: hidden;
  }
  #raven-knit-toolbar button#raven-knit-theme[aria-pressed="true"]::before {
    visibility: visible;
  }
  #raven-knit-frame { flex: 1 1 auto; width: 100%; border: 0; background: white; }
  #raven-knit-context-menu {
    position: fixed; min-width: 160px; z-index: 9999;
    padding: 0.25rem 0;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    font-family: var(--vscode-font-family); font-size: 13px;
  }
  #raven-knit-context-menu[hidden] { display: none; }
  #raven-knit-context-menu button {
    display: block; width: 100%; text-align: left;
    padding: 0.3rem 1rem;
    background: transparent; color: inherit; border: 0;
    font: inherit; cursor: pointer;
  }
  /*
   * :focus-visible (not plain :focus) -- when the menu opens we
   * programmatically focus the first enabled item for accessibility,
   * but we do NOT want to paint a "this item is hovered" highlight
   * just because the focus moved there. :focus-visible activates
   * only when the focus came from a keyboard interaction (Tab, arrow
   * keys), which is the right time to show the selection ring.
   */
  #raven-knit-context-menu button:hover:not([disabled]),
  #raven-knit-context-menu button:focus-visible:not([disabled]) {
    background: var(--vscode-menu-selectionBackground,
                    var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground,
                var(--vscode-list-activeSelectionForeground));
    outline: none;
  }
  #raven-knit-context-menu button:focus:not(:focus-visible) {
    outline: none;
  }
  #raven-knit-context-menu button[disabled] { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div id="raven-knit-toolbar" role="toolbar" aria-label="Knit output">
    <button id="raven-knit-refresh" type="button" title="Re-knit the source document">Knit again</button>
    <button id="raven-knit-open-browser" type="button" title="Open the rendered file in your default browser">Open in Browser</button>
    <button id="raven-knit-theme" type="button"
            aria-pressed="${initialThemeApplied ? 'true' : 'false'}"
            title="Toggle VS Code editor colors on the rendered output">Apply VS Code theme</button>
  </div>
  <iframe id="raven-knit-frame"
          srcdoc="${escapeHtml(srcdocHtml)}"
          sandbox="allow-same-origin"
          title="Rendered output: ${safeName}"></iframe>
  <div id="raven-knit-context-menu" role="menu" hidden>
    <button type="button" role="menuitem" data-action="copy">Copy</button>
    <button type="button" role="menuitem" data-action="copy-image">Copy image</button>
    <button type="button" role="menuitem" data-action="select-all">Select All</button>
    <button type="button" role="menuitem" data-action="open-in-browser">Open in Browser</button>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const iframe = document.getElementById('raven-knit-frame');
      const themeBtn = document.getElementById('raven-knit-theme');
      let loadFired = false;
      let errorFired = false;
      iframe.addEventListener('load', function () { loadFired = true; });
      iframe.addEventListener('error', function () { errorFired = true; });
      document.getElementById('raven-knit-refresh').addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
      });
      document.getElementById('raven-knit-open-browser').addEventListener('click', function () {
        vscode.postMessage({ type: 'openInBrowser' });
      });

      // --- VS Code theme overlay -------------------------------------
      // The iframe is srcdoc + sandbox=allow-same-origin, which gives
      // the inner document the same origin as this outer shell. That
      // same-origin relationship is what lets the outer script inject
      // a style tag into the iframe contentDocument when the user
      // toggles the theme on. The injected stylesheet uses RESOLVED
      // color values from VS Code CSS variables (those variables are
      // defined on the outer shell html and do not propagate into the
      // iframe document), so when VS Code's active theme changes the
      // body class on the outer shell flips and we re-resolve + re-
      // inject.
      //
      // The initial value comes from the extension (which reads it
      // from globalState), embedded into the template literal below.
      // A toggle posts the new state back to the extension, which
      // persists it. We do not also call webview setState — every
      // shell render embeds the latest persisted value, and a hide/
      // show cycle leaves the in-memory variable intact.
      let themeApplied = ${initialThemeApplied ? 'true' : 'false'};

      // GitHub palette variants serialized at build time. We pick
      // one at overlay-apply time based on the active VS Code
      // theme variant so the syntax-token colors (which the
      // rendered document references via --raven-c-*) match the
      // live code-block background. Without this swap, switching
      // themes after knit could leave e.g. dark-palette tokens on
      // a light textCodeBlock background.
      const RAVEN_PALETTE_CSS = {
        light: ${JSON.stringify(lightPaletteCss)},
        dark: ${JSON.stringify(darkPaletteCss)},
      };

      // Resolved VS Code theme palette. When non-null, the toggle
      // paints these colors instead of the GitHub variant. The
      // extension host posts replacement values whenever the active
      // theme or relevant editor.* settings change; the receiver
      // below applies the update and re-runs applyTheme so the
      // change shows up immediately without a re-knit.
      let vscodePaletteCss = ${
          typeof vscodeThemePaletteCss === 'string' && vscodeThemePaletteCss.length > 0
              ? JSON.stringify(vscodeThemePaletteCss)
              : 'null'
      };

      function activePaletteVariant() {
        // Mirror the regex used by render-html.ts:composeStylesheet
        // so the overlay-time variant choice matches the bake-time
        // logic. vscode-high-contrast (no -light suffix) is the
        // dark high-contrast variant; vscode-high-contrast-light
        // is the light one.
        const cls = document.body.className || '';
        return /\\bvscode-(light|high-contrast-light)\\b/.test(cls) ? 'light' : 'dark';
      }

      function activePaletteCss() {
        // VS Code-extracted palette wins over the GitHub default.
        // Falling through to GitHub when the resolver failed lets
        // the toggle still produce a coherent code-block look
        // matching the live background.
        if (vscodePaletteCss !== null) return vscodePaletteCss;
        return RAVEN_PALETTE_CSS[activePaletteVariant()];
      }

      function syncThemeBtn() {
        // Rmd output has no "document theme" — the toggle just
        // controls whether VS Code theming is overlaid. Keep the
        // button label constant; the active state is conveyed
        // visually via aria-pressed (which CSS styles).
        themeBtn.setAttribute('aria-pressed', themeApplied ? 'true' : 'false');
      }

      function readThemeColors() {
        const cs = getComputedStyle(document.documentElement);
        function v(name, fallback) {
          const x = cs.getPropertyValue(name).trim();
          return x.length > 0 ? x : fallback;
        }
        const bg = v('--vscode-editor-background', '#1e1e1e');
        return {
          bg: bg,
          fg: v('--vscode-editor-foreground', '#cccccc'),
          link: v('--vscode-textLink-foreground', '#3794ff'),
          // textCodeBlock-background is the variable VS Code's own
          // markdown preview uses for code-block shading; it's
          // defined by most themes with a subtle tint relative to
          // the editor background. Fall back to editor-background
          // for themes that don't set it so the block bg at least
          // matches the surrounding surface.
          codeBg: v('--vscode-textCodeBlock-background', bg),
        };
      }

      function applyTheme() {
        const doc = iframe.contentDocument;
        if (!doc || !doc.documentElement) return;
        // contentDocument's head exists on parsed HTML; for srcdoc
        // iframes we may race the parser, so fall back to <html>.
        const host = doc.head || doc.documentElement;
        let style = doc.getElementById('raven-vscode-theme-overrides');
        if (!themeApplied) {
          if (style) style.remove();
          iframe.style.background = '';
          syncThemeBtn();
          return;
        }
        if (!style) {
          style = doc.createElement('style');
          style.id = 'raven-vscode-theme-overrides';
          host.appendChild(style);
        }
        const c = readThemeColors();
        // The GitHub-palette base stylesheet paints both <pre> and
        // its inner <code> with --raven-bg. Override both so the
        // syntax-highlight wrapper and any inline <code> in prose
        // pick up the theme's code-block shading. We ALSO re-emit
        // the matching GitHub palette variant on :root: token spans
        // reference --raven-c-* via var(), so updating those vars
        // here cascades into them automatically and keeps the
        // syntax-token foreground in lockstep with the live code-
        // block background. Without this, a VS Code theme switch
        // after knit would update --vscode-textCodeBlock-background
        // (resolved live from the outer shell) while leaving token
        // colors on the baked-at-knit variant — i.e. dark tokens
        // on a light background, or vice versa.
        const variantCss = activePaletteCss();
        style.textContent =
          ':root { ' + variantCss + ' }'
          + ' html, body { background: ' + c.bg + ' !important; '
          + 'color: ' + c.fg + ' !important; }'
          + ' a { color: ' + c.link + ' !important; }'
          + ' pre, code, pre code { background: ' + c.codeBg + ' !important; }';
        // Paint the iframe element itself too so the brief flash
        // before the inner document parses also matches the theme.
        iframe.style.background = c.bg;
        syncThemeBtn();
      }

      themeBtn.addEventListener('click', function () {
        themeApplied = !themeApplied;
        // Tell the extension so it can persist the choice in
        // globalState; the next panel render reads the saved value
        // back via initialThemeApplied.
        vscode.postMessage({ type: 'themeChanged', applied: themeApplied });
        applyTheme();
      });

      iframe.addEventListener('load', applyTheme);
      // The srcdoc parse may have completed before our script ran;
      // try immediately in that case.
      if (iframe.contentDocument
          && iframe.contentDocument.readyState !== 'loading') {
        applyTheme();
      }

      // --- Copy / Select All / context menu ------------------------
      // VS Code disables the browser's default context menu inside
      // webviews and does not forward Cmd/Ctrl-C to the host clipboard
      // command when the keyboard focus is in a nested iframe. Since
      // the iframe is same-origin (sandbox=allow-same-origin + srcdoc
      // gives it the parent webview's origin), the outer shell can
      // attach handlers to iframe.contentWindow directly and reach
      // the selection.
      const ctxMenu = document.getElementById('raven-knit-context-menu');
      const ctxCopyBtn = ctxMenu.querySelector('[data-action="copy"]');
      const ctxCopyImageBtn = ctxMenu.querySelector('[data-action="copy-image"]');
      // The <img> the user right-clicked, captured at contextmenu
      // time. Cleared when the menu hides so a stale reference
      // can't leak into a follow-up Copy from a text selection.
      // We capture the element (not just its src) because the
      // canvas-based copy below reads pixels from the already-
      // loaded image — fetch() is blocked by the outer-shell CSP's
      // connect-src 'none', so going back to the network would
      // fail for every supported source kind.
      let pendingImage = null;

      function copyIframeSelection() {
        const win = iframe.contentWindow;
        if (!win) return false;
        const sel = win.getSelection();
        const text = sel ? sel.toString() : '';
        if (!text) return false;
        // Prefer the async Clipboard API; fall back to execCommand
        // for older webviews. The keypress / contextmenu-click that
        // triggers this counts as a user gesture, satisfying both
        // browser permission models.
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            return true;
          }
        } catch (e) { /* fall through */ }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
      }

      function selectAllInIframe() {
        const doc = iframe.contentDocument;
        const win = iframe.contentWindow;
        if (!doc || !win || !doc.body) return;
        const range = doc.createRange();
        range.selectNodeContents(doc.body);
        const sel = win.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }

      // Copy the right-clicked image onto the system clipboard.
      // Draws the already-loaded image onto an offscreen canvas
      // and writes the canvas as a PNG blob via the async
      // Clipboard API. We use canvas rather than fetch because the
      // outer-shell CSP sets connect-src 'none', which blocks any
      // JS-initiated request (including same-origin local-resource
      // URLs). The image element has already loaded its pixels by
      // the time the user right-clicks, so the canvas approach
      // needs no further network access. Output is always PNG so
      // the clipboard MIME type is deterministic and supported on
      // every platform.
      function copyImageFromIframe() {
        const img = pendingImage;
        if (!img) return;
        const w = window;
        const hasClipboardImage = !!(w.ClipboardItem
          && navigator.clipboard && navigator.clipboard.write);
        // Fall back to copying the URL when ClipboardItem is
        // unavailable or when the image is cross-origin (canvas
        // would taint and toBlob would throw). The user can still
        // paste the URL into another tool to pick the image up.
        function copyUrlFallback() {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(img.src).catch(function () { /* swallow */ });
          }
        }
        if (!hasClipboardImage) { copyUrlFallback(); return; }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          if (canvas.width === 0 || canvas.height === 0) { copyUrlFallback(); return; }
          const ctx = canvas.getContext('2d');
          if (!ctx) { copyUrlFallback(); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // canvas.toBlob throws SecurityError (or yields null
          // depending on platform) when the canvas is tainted by a
          // cross-origin image without CORS headers.
          canvas.toBlob(function (blob) {
            if (!blob) { copyUrlFallback(); return; }
            try {
              const item = new w.ClipboardItem({ 'image/png': blob });
              navigator.clipboard.write([item]).catch(copyUrlFallback);
            } catch (e) { copyUrlFallback(); }
          }, 'image/png');
        } catch (e) { copyUrlFallback(); }
      }

      function hideContextMenu() {
        ctxMenu.hidden = true;
        pendingImage = null;
      }

      function showContextMenu(clientX, clientY, hasSelection, image) {
        if (hasSelection) {
          ctxCopyBtn.removeAttribute('disabled');
        } else {
          ctxCopyBtn.setAttribute('disabled', 'true');
        }
        if (image) {
          ctxCopyImageBtn.removeAttribute('disabled');
          pendingImage = image;
        } else {
          ctxCopyImageBtn.setAttribute('disabled', 'true');
          pendingImage = null;
        }
        // Render off-screen first to measure, then clamp into the
        // viewport so the menu never spills past the right/bottom
        // edge of the webview.
        ctxMenu.style.left = '-9999px';
        ctxMenu.style.top = '0';
        ctxMenu.hidden = false;
        const r = ctxMenu.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const x = Math.max(0, Math.min(clientX, vw - r.width - 2));
        const y = Math.max(0, Math.min(clientY, vh - r.height - 2));
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
        const firstEnabled = ctxMenu.querySelector('button:not([disabled])');
        if (firstEnabled) firstEnabled.focus();
      }

      ctxMenu.addEventListener('click', function (e) {
        const btn = e.target.closest
          ? e.target.closest('button[data-action]')
          : null;
        if (!btn || btn.hasAttribute('disabled')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'copy') copyIframeSelection();
        else if (action === 'copy-image') copyImageFromIframe();
        else if (action === 'select-all') selectAllInIframe();
        else if (action === 'open-in-browser') vscode.postMessage({ type: 'openInBrowser' });
        hideContextMenu();
      });

      // Outer-shell dismiss handlers — click anywhere outside the
      // menu, scroll the toolbar, or hit Escape.
      document.addEventListener('mousedown', function (e) {
        if (ctxMenu.hidden) return;
        if (!ctxMenu.contains(e.target)) hideContextMenu();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') hideContextMenu();
      });

      function attachIframeInputHandlers() {
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument;
        if (!win || !doc) return;
        // Cmd/Ctrl-C and Cmd/Ctrl-A while the iframe has focus.
        // For every other *modifier* shortcut we synthesize the
        // keydown event on the outer shell document so VS Code's
        // keybinding handler sees it. The iframe is sandboxed and
        // keystrokes that fire inside it don't reach VS Code's
        // chrome otherwise; the same-origin sandbox lets us reach
        // across the document boundary to re-dispatch.
        //
        // We gate on the modifier so plain typing inside any
        // input/widget rendered in the report does NOT bubble out
        // and silently trigger a single-key keybinding the user
        // may have configured in VS Code.
        win.addEventListener('keydown', function (e) {
          const mod = e.metaKey || e.ctrlKey;
          if (!mod) return;
          // AltGr on Windows / many Linux layouts fires as Ctrl+Alt
          // for typing characters like @, €, or accented letters.
          // The platform reports the AltGraph modifier state on
          // those keypresses; skip them so the user can type.
          if (e.getModifierState && e.getModifierState('AltGraph')) return;
          const k = (e.key || '').toLowerCase();
          if (k === 'c') {
            if (copyIframeSelection()) e.preventDefault();
            return;
          }
          if (k === 'a') {
            selectAllInIframe();
            e.preventDefault();
            return;
          }
          // Re-dispatch on the outer shell document. We clone the
          // relevant fields so VS Code's keybinding matcher receives
          // an equivalent event. The synthetic event has
          // isTrusted=false, but VS Code's webview keybinding
          // handler matches on key fields rather than the trust
          // flag, so this is enough to make Cmd+J / Cmd+= / Cmd+- /
          // Cmd+B / Cmd+P / Cmd+S / etc. behave the same way as
          // when the focus is in a regular editor.
          const cloned = new KeyboardEvent('keydown', {
            key: e.key,
            code: e.code,
            keyCode: e.keyCode,
            which: e.which,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            repeat: e.repeat,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          document.dispatchEvent(cloned);
        });
        // Right-click → custom menu in the outer shell. Use mousedown
        // for the dismiss handler ordering; contextmenu still fires
        // after, and we preventDefault to suppress any host menu.
        win.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          const rect = iframe.getBoundingClientRect();
          const x = e.clientX + rect.left;
          const y = e.clientY + rect.top;
          const sel = win.getSelection();
          const hasSel = !!(sel && sel.toString().length > 0);
          // If the user right-clicked on an <img>, capture the
          // element itself so the Copy image action can draw it
          // onto a canvas (fetch() is blocked by the outer-shell
          // CSP's connect-src 'none', so we read pixels from the
          // already-loaded image rather than re-requesting).
          let image = null;
          const tgt = e.target;
          if (tgt && tgt.tagName === 'IMG') image = tgt;
          showContextMenu(x, y, hasSel, image);
        });
        // A new click inside the iframe should dismiss the menu so
        // it does not linger after the user moves on.
        win.addEventListener('mousedown', hideContextMenu);
        win.addEventListener('scroll', hideContextMenu, true);
        // Re-attach is required after every iframe reload (Knit
        // again, or singleton-panel content swap).
      }

      iframe.addEventListener('load', attachIframeInputHandlers);
      if (iframe.contentDocument
          && iframe.contentDocument.readyState !== 'loading') {
        attachIframeInputHandlers();
      }
      // Report the webview's actually-rendered editor background to
      // the extension host. The host uses this to identify which
      // theme VS Code is rendering: the public API exposes only
      // activeColorTheme.kind, which is ambiguous when both
      // workbench.preferredLightColorTheme and
      // workbench.preferredDarkColorTheme have the same kind (e.g.
      // both configured to dark themes). The actual editor background
      // is the only public signal that lets the host match the right
      // theme JSON.
      function reportThemeContext() {
        try {
          var cs = getComputedStyle(document.documentElement);
          var bg = (cs.getPropertyValue('--vscode-editor-background') || '').trim();
          if (bg.length > 0) {
            vscode.postMessage({ type: 'themeContext', editorBackground: bg });
          }
        } catch (e) { /* ignore — host falls back to first candidate */ }
      }
      // Initial report — at this point the outer shell has been
      // styled, so the CSS variable is resolved.
      reportThemeContext();
      // Re-apply when VS Code switches its active theme. The outer
      // shell body class flips between vscode-light, vscode-dark, or
      // vscode-high-contrast, which updates the CSS variables read
      // by readThemeColors. Re-report the editor background too so
      // the host re-resolves to the new theme.
      new MutationObserver(function () {
        applyTheme();
        reportThemeContext();
      }).observe(document.body, {
        attributes: true, attributeFilter: ['class'],
      });
      syncThemeBtn();

      // VS Code theme palette updates from the extension host. We
      // accept the css string only when it round-trips through a
      // strict shape check — the field is concatenated into
      // style.textContent, so a malformed value (or one bearing CSS
      // that escapes the var-declaration form) would corrupt the
      // iframe stylesheet. The regex matches the exact declaration
      // sequence paletteCssDeclarations emits; anything else is
      // dropped and the toggle falls back to the GitHub variant.
      // Mirror vscode-theme-palette.ts:HEX_COLOR_RE — accept only
      // the four CSS-spec hex lengths (3, 4, 6, 8). The wider {3,8}
      // form would silently pass 5/7-digit malformed values that no
      // current code path emits but a future refactor could.
      var RAVEN_PALETTE_CSS_RE = /^(?:--raven-(?:bg|fg|c-[a-z]+): #(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8}); ?)+$/;
      window.addEventListener('message', function (event) {
        var data = event && event.data;
        if (!data) return;
        if (data.__ravenVscodeThemePalette === true) {
          if (typeof data.css === 'string' && RAVEN_PALETTE_CSS_RE.test(data.css)) {
            vscodePaletteCss = data.css;
          } else {
            vscodePaletteCss = null;
          }
          applyTheme();
          return;
        }
        if (data.__ravenRequestThemeContext === true) {
          // The host asked us to re-report the current editor.bg.
          // Fires on theme changes that the MutationObserver above
          // doesn't catch — specifically, swaps between two themes
          // of the same kind (e.g. Solarized Dark <-> Dark 2026,
          // both kind=Dark). Body class stays the same, so the
          // MutationObserver doesn't fire, so the host's cached
          // latestEditorBackground would stay on the old theme's
          // bg. The host invalidates its cache and then pokes us
          // here; we read the current bg and post it back.
          reportThemeContext();
          return;
        }
        if (data.__ravenKnitProbe !== true) return;
        var locationHref = '';
        try {
          locationHref = iframe.contentWindow ? iframe.contentWindow.location.href : '';
        } catch (e) {
          // SecurityError accessing cross-origin location → iframe
          // navigated to its (cross-origin) src; report that
          // sentinel so the extension treats it as success.
          locationHref = 'cross-origin-blocked';
        }
        // Inspect every <img> in the rendered iframe and report
        // whether the browser actually fetched the bytes. Used by
        // the diagnostic test that gates regressions for the
        // "subresource loads from a nested iframe inside a VS Code
        // webview" failure mode.
        var imageStates = [];
        try {
          var idoc = iframe.contentDocument;
          if (idoc) {
            var imgs = idoc.querySelectorAll('img');
            for (var i = 0; i < imgs.length; i++) {
              var im = imgs[i];
              imageStates.push({
                src: im.getAttribute('src') || '',
                resolvedSrc: im.src || '',
                complete: !!im.complete,
                naturalWidth: im.naturalWidth || 0,
                naturalHeight: im.naturalHeight || 0,
              });
            }
          }
        } catch (e) { /* same-origin failure — leave empty */ }
        vscode.postMessage({
          type: 'iframeProbe',
          locationHref: locationHref,
          loadFired: loadFired,
          errorFired: errorFired,
          src: iframe.getAttribute('src'),
          imageStates: imageStates,
        });
      });
      // Surface CSP violations so the test/diagnostic layer can
      // distinguish "blocked by CSP" from "blocked by network".
      window.addEventListener('securitypolicyviolation', function (e) {
        vscode.postMessage({
          type: 'cspViolation',
          violatedDirective: String(e.violatedDirective || ''),
          blockedURI: String(e.blockedURI || ''),
        });
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Rewrite fragment-only anchor hrefs (`<a href="#x">`) so they target
 * `about:srcdoc#x` — the srcdoc iframe's actual document URL.
 *
 * Why this is needed: the outer-shell injects a `<base href>` so the
 * rendered HTML's relative subresource paths (CSS, images, fonts)
 * resolve through `webview.asWebviewUri(...)`. But the base href also
 * changes how fragment-only anchors are resolved — instead of
 * resolving against the iframe's document URL (`about:srcdoc`), they
 * resolve against the base URL, which turns a click on a TOC link
 * into a full cross-document navigation that fails (the nested-frame
 * navigation issue this whole module exists to work around).
 *
 * Rewriting `href="#x"` to `href="about:srcdoc#x"` produces a URL
 * whose non-fragment portion already matches the iframe's document
 * URL, so the browser treats the click as a same-document fragment
 * navigation again and scrolls to the target element.
 *
 * Edge cases NOT rewritten (intentionally):
 *  - `href="page.html#x"` — combined path+fragment, not a pure
 *    in-document anchor.
 *  - `href=""` or `href="#"` — empty or no-op anchors.
 *  - Non-`<a>` elements that happen to have an `href` attribute.
 *  - `href` values containing `<`, `>`, or whitespace — those are
 *    pathological and reject rather than rewrite.
 */
export function rewriteFragmentAnchors(html: string): string {
    // Match `<a ...href="#fragment"...>` and `<a ...href='#fragment'...>`.
    // The lookahead-free pattern matches `<a` followed by anything up
    // to `href=`, then a quoted `#…` value. `[^>]*?` is non-greedy so
    // the regex does not jump across `>` boundaries.
    const re = /(<a\b[^>]*?\shref\s*=\s*)("|')(#[^"'<>\s]+)\2/gi;
    return html.replace(re, (_match, prefix: string, quote: string, fragment: string) =>
        `${prefix}${quote}about:srcdoc${fragment}${quote}`,
    );
}

/**
 * Pick the output path to surface in the Knit Output panel.
 *
 * When `output_format = "all"` (or a custom multi-format render) produces
 * a mix of formats, the user almost always wants the HTML viewer rather
 * than e.g. revealing a PDF in the file browser. Prefer the first HTML
 * output; fall back to the first entry overall.
 *
 * Codex adversarial review #4 on the v1 spec called out that v1 always
 * used `parsed.paths[0]`, which would hide an HTML output behind a
 * PDF/DOCX-first reveal.
 */
export function pickPrimaryOutput(paths: readonly string[]): string | undefined {
    if (paths.length === 0) return undefined;
    const html = paths.find((p) => {
        const ext = path.extname(p).toLowerCase();
        return ext === '.html' || ext === '.htm';
    });
    return html ?? paths[0];
}
