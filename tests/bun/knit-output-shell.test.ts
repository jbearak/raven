import { describe, test, expect } from 'bun:test';
import {
    buildShellHtml,
    rewriteFragmentAnchors,
} from '../../editors/vscode/src/knit/knit-output';

const args = (outputPath: string, nonce = 'NONCE123', initialThemeApplied = false) => ({
    htmlContent: '<!doctype html><html><body><h1>Hi</h1></body></html>',
    baseHref: `https://webview.test${outputPath.replace(/[^/]+$/, '')}`,
    cspSource: 'https://webview.test',
    outputPath,
    nonce,
    initialThemeApplied,
});

describe('buildShellHtml', () => {
    test('CSP <meta> appears in <head>, before <body>', () => {
        const html = buildShellHtml(args('/work/report.html'));
        const cspIdx = html.indexOf('Content-Security-Policy');
        const bodyIdx = html.indexOf('<body');
        expect(cspIdx).toBeGreaterThan(0);
        expect(bodyIdx).toBeGreaterThan(0);
        expect(cspIdx).toBeLessThan(bodyIdx);
    });

    test('CSP contains nonce, frame-src, no default-src loophole', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain("default-src 'none'");
        expect(html).toContain('frame-src https://webview.test');
        expect(html).toContain("script-src 'nonce-NONCE123'");
        expect(html).toContain("connect-src 'none'");
    });

    test('iframe inlines content via srcdoc (not src)', () => {
        // Nested iframes inside VS Code webviews cannot navigate to
        // `webview.asWebviewUri(...)` URLs — Electron's resource
        // handler does not intercept the navigation. Inlining via
        // `srcdoc` is the fix; assert that `src=` is not used.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/<iframe[^>]*\bsrcdoc=/);
        expect(html).not.toMatch(/<iframe[^>]*\ssrc=/);
    });

    test('srcdoc includes the rendered HTML and a base href', () => {
        const a = {
            htmlContent: '<body><p>UNIQ-MARKER-Q4Z9</p></body>',
            baseHref: 'https://webview.test/work/',
            cspSource: 'https://webview.test',
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
            initialThemeApplied: false,
        };
        const html = buildShellHtml(a);
        // srcdoc content is HTML-attribute-escaped, so the marker
        // appears verbatim once unescaped — but the raw escaped text
        // still contains the un-escaped letters of the marker.
        expect(html).toContain('UNIQ-MARKER-Q4Z9');
        // base href appears inside the srcdoc value, escaped for HTML.
        expect(html).toContain('&lt;base href=&quot;https://webview.test/work/&quot;&gt;');
    });

    test('iframe sandbox is allow-same-origin (scripts still blocked)', () => {
        // `sandbox=""` (no flags) gives the iframe a unique opaque
        // origin, which bypasses VS Code's webview resource handler.
        // `allow-same-origin` lets the iframe inherit the parent
        // webview origin; scripts/forms/popups remain blocked because
        // no `allow-scripts` / `allow-forms` / `allow-popups` are set.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/<iframe[^>]*\bsandbox="allow-same-origin"/);
        expect(html).not.toMatch(/<iframe[^>]*\ballow-scripts\b/);
        expect(html).not.toMatch(/<iframe[^>]*\ballow-forms\b/);
        expect(html).not.toMatch(/<iframe[^>]*\ballow-popups\b/);
        expect(html).not.toMatch(/<iframe[^>]*\ballow-top-navigation\b/);
    });

    test('toolbar contains re-knit, open-in-browser, and theme buttons', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('id="raven-knit-refresh"');
        expect(html).toContain('id="raven-knit-open-browser"');
        expect(html).toContain('id="raven-knit-theme"');
    });

    test('re-knit button is labelled "Knit again"', () => {
        // "Refresh" was the original label; the document-rendering
        // analogy doesn't fit because the button re-runs knit (re-
        // executes R code, regenerates the file) rather than
        // refetching the same URL.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/<button[^>]*id="raven-knit-refresh"[^>]*>Knit again<\/button>/);
        expect(html).not.toMatch(/>Refresh</);
    });

    test('theme toggle button starts in unpressed state when not persisted', () => {
        const html = buildShellHtml(args('/work/report.html'));
        // Button must declare aria-pressed so screen readers report
        // the toggle state; on first render the theme has not been
        // applied yet so it should read "false".
        expect(html).toMatch(/<button[^>]*id="raven-knit-theme"[^>]*aria-pressed="false"/);
        expect(html).toContain('>Apply VS Code theme<');
    });

    test('initialThemeApplied=true renders the button in the pressed state', () => {
        // The extension reads the persisted preference from
        // globalState and threads it through here; the rendered
        // button should immediately reflect "theme applied" so the
        // user does not see a one-frame flicker between renders.
        // Note: the button label does NOT change with state — Rmd
        // output has no "document theme" to switch back to, so the
        // active state is conveyed only via aria-pressed + CSS.
        const html = buildShellHtml(args('/work/report.html', 'N', true));
        expect(html).toMatch(/<button[^>]*id="raven-knit-theme"[^>]*aria-pressed="true"/);
        expect(html).toContain('>Apply VS Code theme<');
        // The script's local state variable starts at the same value.
        expect(html).toContain('let themeApplied = true;');
    });

    test('theme button label is constant; state is visual only', () => {
        const off = buildShellHtml(args('/work/r.html', 'N', false));
        const on = buildShellHtml(args('/work/r.html', 'N', true));
        // Both renderings carry the same visible label — only
        // aria-pressed flips. The label never says "Use document
        // theme" since there isn't one.
        expect(off).toContain('>Apply VS Code theme<');
        expect(on).toContain('>Apply VS Code theme<');
        expect(off).not.toContain('Use document theme');
        expect(on).not.toContain('Use document theme');
    });

    test('toggle is right-aligned in the toolbar', () => {
        // The toolbar uses flex layout; `margin-left: auto` on the
        // toggle pushes it to the right edge, separating it from the
        // two action buttons on the left.
        const html = buildShellHtml(args('/work/r.html'));
        expect(html).toMatch(/#raven-knit-theme\s*\{[\s\S]*?margin-left:\s*auto/);
    });

    test('toggle uses input-option styling and a checkmark prefix', () => {
        // Pin the visual contract: the toggle uses VS Code's
        // input-option CSS variables (the same vars the Find widget
        // toggles use), and the active state prepends a ✓ via a
        // ::before pseudo-element. Action buttons must remain on
        // the button-background palette.
        const html = buildShellHtml(args('/work/r.html'));
        expect(html).toContain('--vscode-inputOption-activeBackground');
        expect(html).toContain('--vscode-inputOption-activeBorder');
        expect(html).toContain('--vscode-inputOption-activeForeground');
        expect(html).toMatch(/#raven-knit-theme::before\s*\{[\s\S]*?content:\s*"✓"/);
        expect(html).toMatch(
            /#raven-knit-theme\[aria-pressed="true"\]::before\s*\{\s*visibility:\s*visible/,
        );
    });

    test('script reads computed vscode-editor CSS variables', () => {
        // The injected stylesheet uses RESOLVED color values pulled
        // from the outer shell's computed style — CSS variables do
        // not propagate into a srcdoc iframe, so we resolve them
        // here and inject literal values.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('--vscode-editor-background');
        expect(html).toContain('--vscode-editor-foreground');
        expect(html).toContain('--vscode-textLink-foreground');
    });

    test('theme overlay repaints code-block backgrounds from the theme', () => {
        // The GitHub-palette base stylesheet paints pre/code with
        // --raven-bg, which clashes with the VS Code editor bg when
        // the theme overlay is applied. The overlay must read
        // --vscode-textCodeBlock-background and inject a `pre`
        // background override so code blocks pick up the theme's
        // shading rather than staying on the GitHub palette.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('--vscode-textCodeBlock-background');
        // The injected stylesheet paints `pre` with c.codeBg and
        // forces `pre code` to transparent so a semi-transparent
        // textCodeBlock-background (VS Code's default for dark
        // themes) doesn't double-layer inside the code text area.
        expect(html).toMatch(/pre\s*\{\s*background:/);
        expect(html).toMatch(/pre code\s*\{\s*background:\s*transparent/);
    });

    test('theme overlay re-emits GitHub palette variant on :root', () => {
        // The rendered document bakes --raven-c-* / --raven-fg /
        // --raven-bg at knit time from a single GitHub palette
        // variant. When the user switches VS Code themes after the
        // overlay was enabled, MutationObserver re-runs applyTheme,
        // which updates the code-block background (resolved live
        // from --vscode-textCodeBlock-background). The overlay must
        // also re-emit the matching GitHub palette variant on the
        // iframe's :root so syntax-token colors stay readable on
        // the new code-block background — otherwise dark tokens
        // could end up painted onto a light shade or vice versa.
        const html = buildShellHtml(args('/work/report.html'));
        // Both variants must be baked into the shell so the script
        // can pick at runtime without a network/build step.
        expect(html).toContain('--raven-c-keyword: #cf222e'); // light
        expect(html).toContain('--raven-c-keyword: #ff7b72'); // dark
        // The variant chooser must consult the same body-class
        // regex render-html.ts:composeStylesheet uses, so the
        // overlay-time variant matches the bake-time one.
        expect(html).toMatch(/vscode-\(light\|high-contrast-light\)/);
        // The injected stylesheet must write the chosen variant
        // into :root so var()-referencing token spans pick it up.
        expect(html).toMatch(/:root\s*\{\s*'\s*\+\s*variantCss/);
    });

    test('script observes outer-shell body class for theme switches', () => {
        // VS Code flips body classList between vscode-light /
        // vscode-dark / vscode-high-contrast on theme change. We
        // observe that mutation so the overlay re-injects with the
        // new resolved colors instead of going stale.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/MutationObserver\([\s\S]*?\)\.observe\(document\.body/);
    });

    test('context menu element exposes Copy / Select All / Open in Browser', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/id="raven-knit-context-menu"[^>]*hidden/);
        expect(html).toContain('role="menuitem" data-action="copy"');
        expect(html).toContain('role="menuitem" data-action="select-all"');
        expect(html).toContain('role="menuitem" data-action="open-in-browser"');
    });

    test('script re-dispatches unhandled keystrokes on the outer document', () => {
        // VS Code-level shortcuts (Cmd+J, Cmd+=, Cmd+-, Cmd+\, etc.)
        // are eaten by the iframe when it has keyboard focus because
        // VS Code's chrome never sees keystrokes that fire inside a
        // nested iframe. The webview re-dispatches a synthetic
        // KeyboardEvent on the outer shell document so VS Code's
        // keybinding handler matches it just like a native keystroke.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/new KeyboardEvent\(\s*['"]keydown['"]/);
        expect(html).toMatch(/document\.dispatchEvent\(/);
        // The relevant modifier and identity fields must be cloned
        // so VS Code's keybinding matcher sees an equivalent event.
        expect(html).toContain('key: e.key');
        expect(html).toContain('metaKey: e.metaKey');
        expect(html).toContain('ctrlKey: e.ctrlKey');
        expect(html).toContain('shiftKey: e.shiftKey');
        expect(html).toContain('altKey: e.altKey');
    });

    test('re-dispatch does not eat the C and A handlers', () => {
        // C / A are still handled in-iframe (copy / select all of the
        // iframe selection). They must not also be re-dispatched.
        const html = buildShellHtml(args('/work/report.html'));
        const dispatchIdx = html.indexOf('document.dispatchEvent(');
        const handleCIdx = html.indexOf("k === 'c'");
        const handleAIdx = html.indexOf("k === 'a'");
        expect(handleCIdx).toBeGreaterThan(0);
        expect(handleAIdx).toBeGreaterThan(0);
        expect(dispatchIdx).toBeGreaterThan(handleCIdx);
        expect(dispatchIdx).toBeGreaterThan(handleAIdx);
    });

    test('context menu exposes a Copy image action', () => {
        // Right-clicking an <img> in the rendered output offers a
        // Copy image action in addition to the text-selection Copy /
        // Select All / Open in Browser items.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('data-action="copy-image"');
        expect(html).toContain('>Copy image<');
    });

    test('contextmenu listener detects image targets', () => {
        // The handler must read e.target and check whether the
        // right-clicked element is an HTMLImageElement so the
        // Copy image button can be enabled / disabled and so the
        // image is captured for the copy action.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/tagName[\s\S]*?===[\s\S]*?['"]IMG['"]/i);
    });

    test('copy-image uses canvas (not fetch) to bypass connect-src CSP', () => {
        // The outer-shell CSP sets `connect-src 'none'`, which blocks
        // JS-initiated network requests (including fetch of local
        // webview resources). The Copy image action draws the
        // already-loaded image onto an offscreen canvas instead so
        // it needs no further network access, then writes the canvas
        // as a PNG blob via ClipboardItem.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('createElement(\'canvas\')');
        expect(html).toContain('drawImage(');
        expect(html).toMatch(/canvas\.toBlob\([\s\S]*?['"]image\/png['"]/);
        expect(html).toContain("'image/png'");
        // No fetch() call in the image-copy path.
        expect(html).not.toContain('fetch(src)');
        expect(html).not.toMatch(/fetch\(pending/);
    });

    test('re-dispatch is gated on a modifier (no plain typing forwarded)', () => {
        // Without the modifier gate, plain letters typed into any
        // input/widget rendered in the report would be re-dispatched
        // on the outer document and could fire single-key
        // keybindings the user has configured in VS Code.
        const html = buildShellHtml(args('/work/report.html'));
        // The handler must early-exit when no modifier is held.
        expect(html).toMatch(/if\s*\(!mod\)\s*return/);
    });

    test('re-dispatch skips AltGr-typed characters', () => {
        // AltGr on Windows / many Linux layouts fires as Ctrl+Alt
        // when typing characters like @, €, or accented letters.
        // The handler must consult getModifierState('AltGraph') and
        // skip those keystrokes so users can type.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain("getModifierState('AltGraph')");
    });

    test('copy-image falls back to copying the URL for cross-origin images', () => {
        // Drawing a cross-origin image without CORS headers onto a
        // canvas taints the canvas, and toBlob then throws (or
        // yields null on some platforms). The handler must catch
        // and fall back to copying the image's src as plain text
        // so the user can at least paste the URL.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('copyUrlFallback');
        expect(html).toContain('writeText(img.src)');
    });

    test('script wires Cmd/Ctrl-C and Cmd/Ctrl-A on the iframe', () => {
        // VS Code does not forward Cmd-C / Cmd-A from a nested
        // iframe to the host clipboard command, so we attach our
        // own keydown handler on iframe.contentWindow. The presence
        // of these tokens in the shell script is a structural
        // guarantee that the wiring exists.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/iframe\.contentWindow[\s\S]*?addEventListener\(['"]keydown['"]/);
        // Both the modifier check and the key dispatch must be in
        // place — guarding either alone is not enough.
        expect(html).toMatch(/metaKey\s*\|\|\s*e\.ctrlKey/);
        expect(html).toContain("k === 'c'");
        expect(html).toContain("k === 'a'");
    });

    test('script wires contextmenu listener that suppresses the host menu', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/addEventListener\(['"]contextmenu['"]/);
        expect(html).toMatch(/e\.preventDefault\(\)/);
    });

    test('copy path includes Clipboard API with execCommand fallback', () => {
        // navigator.clipboard.writeText is the modern path; we keep
        // execCommand('copy') as a fallback for older webview hosts
        // that block the async API.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('navigator.clipboard');
        expect(html).toContain("execCommand('copy')");
    });

    test('theme toggle posts themeChanged message instead of using setState', () => {
        // Persistence lives in the extension's globalState so the
        // choice survives panel disposal/recreation across knits.
        // The webview only posts a message; the extension writes.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain("type: 'themeChanged'");
        expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*['"]themeChanged['"]/);
        expect(html).not.toContain('vscode.setState');
    });

    test('filename does not appear in the toolbar (panel title already shows it)', () => {
        const html = buildShellHtml(args('/work/report.html'));
        // The toolbar previously carried a `<span id="raven-knit-filename">`
        // showing the basename, which duplicated the panel tab title.
        expect(html).not.toContain('raven-knit-filename');
        expect(html).not.toMatch(/<span[^>]*aria-live=/);
    });

    test('iframe title still carries the basename for accessibility', () => {
        // We still pass the basename through to the iframe's title
        // attribute so screen readers and the find widget can refer
        // to "Rendered output: report.html".
        const html = buildShellHtml(args('/work/re<port>&.html'));
        expect(html).toContain('title="Rendered output: re&lt;port&gt;&amp;.html"');
    });

    test('toolbar script is nonce-tagged', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(/<script\s+nonce="NONCE123">/);
    });
});

describe('rewriteFragmentAnchors', () => {
    test('rewrites fragment-only double-quoted hrefs', () => {
        const out = rewriteFragmentAnchors('<a href="#results">jump</a>');
        expect(out).toBe('<a href="about:srcdoc#results">jump</a>');
    });

    test('rewrites fragment-only single-quoted hrefs', () => {
        const out = rewriteFragmentAnchors("<a href='#results'>jump</a>");
        expect(out).toBe("<a href='about:srcdoc#results'>jump</a>");
    });

    test('rewrites uppercase tag and attribute names', () => {
        const out = rewriteFragmentAnchors('<A HREF="#x">jump</A>');
        // Replacement preserves the original `<A HREF=` prefix.
        expect(out).toBe('<A HREF="about:srcdoc#x">jump</A>');
    });

    test('handles whitespace around the equals sign', () => {
        const out = rewriteFragmentAnchors('<a href = "#x">jump</a>');
        expect(out).toBe('<a href = "about:srcdoc#x">jump</a>');
    });

    test('rewrites multiple anchors', () => {
        const out = rewriteFragmentAnchors(
            '<a href="#a">A</a> and <a href="#b">B</a>',
        );
        expect(out).toBe(
            '<a href="about:srcdoc#a">A</a> and <a href="about:srcdoc#b">B</a>',
        );
    });

    test('rewrites anchors with extra attributes before href', () => {
        const out = rewriteFragmentAnchors(
            '<a class="toc-link" href="#sec">Sec</a>',
        );
        expect(out).toBe('<a class="toc-link" href="about:srcdoc#sec">Sec</a>');
    });

    test('rewrites anchors with extra attributes after href', () => {
        const out = rewriteFragmentAnchors(
            '<a href="#sec" class="toc-link">Sec</a>',
        );
        expect(out).toBe('<a href="about:srcdoc#sec" class="toc-link">Sec</a>');
    });

    test('does NOT rewrite combined path+fragment hrefs', () => {
        // `page.html#x` is not an in-document anchor; leaving it
        // alone preserves the existing "external links fail silently"
        // behavior (rather than turning it into an in-document
        // navigation that scrolls to the wrong place).
        const original = '<a href="page.html#x">other</a>';
        expect(rewriteFragmentAnchors(original)).toBe(original);
    });

    test('does NOT rewrite empty hrefs or bare hashes', () => {
        // The regex requires at least one character after `#`, so
        // `<a href="#">` is left alone — typical "no-op" anchors.
        const empty = '<a href="">x</a> <a href="#">y</a>';
        expect(rewriteFragmentAnchors(empty)).toBe(empty);
    });

    test('does NOT rewrite href on non-<a> elements', () => {
        // `<link href="#">` and `<base href="#">` aren't navigation
        // targets in the same sense; rewriting them would be wrong.
        const original = '<link href="#x"><base href="#y">';
        expect(rewriteFragmentAnchors(original)).toBe(original);
    });

    test('does NOT rewrite absolute or scheme-prefixed URLs', () => {
        const original = '<a href="https://example.com/#x">ext</a>';
        expect(rewriteFragmentAnchors(original)).toBe(original);
    });

    test('does not cross > boundaries', () => {
        // The non-greedy `[^>]*?` must not let one anchor "absorb"
        // surrounding tags. Adversarial input here would be HTML
        // already containing `>` between `<a` and `href=`.
        const original = '<a class="x">text</a><span> href="#">x</span>';
        // The fragment-anchor regex should not match here at all —
        // the only `href="#"` lives inside the <span>, not an <a>.
        expect(rewriteFragmentAnchors(original)).toBe(original);
    });

    test('fragment-only anchors are rewritten so they navigate inside about:srcdoc', () => {
        // With `<base href>` set, fragment-only hrefs would resolve
        // against the base URL and trigger a full cross-document
        // navigation (which fails for nested webview iframes).
        // Rewriting them to `about:srcdoc#…` keeps fragment scroll
        // working.
        const a = {
            htmlContent: '<a href="#results">Jump to results</a>',
            baseHref: 'https://webview.test/work/',
            cspSource: 'https://webview.test',
            outputPath: '/work/report.html',
            nonce: 'N',
            initialThemeApplied: false,
        };
        const html = buildShellHtml(a);
        expect(html).toContain('href=&quot;about:srcdoc#results&quot;');
        // The naked `href="#results"` must not appear in the
        // srcdoc attribute — that would mean we forgot to rewrite.
        expect(html).not.toContain('href=&quot;#results&quot;');
    });

    test('srcdoc value is HTML-attribute escaped (no breakout)', () => {
        // A `"` in the rendered HTML must not close the srcdoc
        // attribute. Constructing a payload that would, if
        // unescaped, escape from the attribute and inject a new
        // attribute lets us verify the escaping.
        const a = {
            htmlContent: '<body>"><script>alert(1)</script><x foo="</body>',
            baseHref: 'https://webview.test/work/',
            cspSource: 'https://webview.test',
            outputPath: '/work/report.html',
            nonce: 'NONCE123',
            initialThemeApplied: false,
        };
        const html = buildShellHtml(a);
        // The raw quote-bracket-script sequence MUST NOT appear in
        // the outer shell — that would mean the srcdoc closed early
        // and a script was injected into the outer shell.
        expect(html).not.toContain('"><script>alert(1)</script>');
        // The escaped form is what we expect.
        expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });
});
