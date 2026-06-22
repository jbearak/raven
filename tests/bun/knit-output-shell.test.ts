import { describe, test, expect } from 'bun:test';
import {
    buildShellHtml,
    paletteCssDeclarations,
    rewriteFragmentAnchors,
} from '../../editors/vscode/src/knit/knit-output';
import { githubDark, githubLight } from '../../editors/vscode/src/knit/github-colors';

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

    test('persists restore state via setState when sourceFsPath is given', () => {
        const html = buildShellHtml({
            ...args('/work/report.html'),
            sourceFsPath: '/work/report.Rmd',
        });
        // The serializer-restore record must carry both fields.
        expect(html).toContain('vscode.setState(ravenRestoreState)');
        expect(html).toContain('sourceFsPath: "/work/report.Rmd"');
        expect(html).toContain('outputPath: "/work/report.html"');
    });

    test('escapes < in the setState path so a </script> in a path cannot break out', () => {
        const html = buildShellHtml({
            ...args('/work/weird</script><x>.html'),
            sourceFsPath: '/work/weird</script><x>.Rmd',
        });
        // The raw closing-tag sequence must NOT appear inside the inline script.
        const scriptStart = html.indexOf('<script nonce');
        const script = html.slice(scriptStart);
        expect(script).toContain('\\u003c/script>');
        expect(script).not.toContain('</script><x>');
    });

    test('skips setState when sourceFsPath is absent', () => {
        // Non-persistence callers (unit tests) omit sourceFsPath; the
        // guard means no useless restore record is stored.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('sourceFsPath: ""');
        // The guard `if (ravenRestoreState.sourceFsPath)` gates the call.
        expect(html).toContain('if (ravenRestoreState.sourceFsPath)');
    });

    test('open-in-browser renders visible in a local workspace', () => {
        // `isRemoteWorkspace` defaults to false; both the toolbar
        // button (icon-only after the icon-toolbar redesign) and the
        // context-menu item (still text-labeled) must render WITHOUT
        // the `hidden` attribute so the user gets the OS browser path.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-open-browser"(?![^>]*\bhidden\b)[^>]*>/,
        );
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-open-browser"[^>]*\baria-label="Open in Browser"/,
        );
        expect(html).toMatch(
            /<button[^>]*data-action="open-in-browser"(?![^>]*\bhidden\b)[^>]*>Open in Browser<\/button>/,
        );
        expect(html).toContain('title="Open in Browser (open the rendered file in your default browser)"');
    });

    test('open-in-browser is hidden when isRemoteWorkspace=true', () => {
        // In a remote workspace, file:// targets the extension-host
        // machine rather than where the user is sitting, so the
        // browser action cannot reach the user's local apps. The
        // toolbar button AND the right-click menu item must both
        // render with the `hidden` HTML attribute (which the user
        // agent stylesheet maps to display:none + aria-hidden, and
        // which also blocks click event dispatch). The DOM nodes
        // still exist so the script's `getElementById(...)`
        // .addEventListener wiring keeps working without a null
        // guard.
        const html = buildShellHtml({
            ...args('/work/report.html'),
            isRemoteWorkspace: true,
        });
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-open-browser"[^>]*\bhidden\b/,
        );
        expect(html).toMatch(
            /<button[^>]*data-action="open-in-browser"[^>]*\bhidden\b[^>]*>Open in Browser<\/button>/,
        );
        expect(html).toContain('#raven-knit-context-menu button[hidden] { display: none; }');
        // The hidden state must NOT carry the local-workspace
        // tooltip past the boundary into screen reader output — the
        // `hidden` attribute already implies `aria-hidden`, but
        // belt-and-braces: assert no `disabled` attribute (which
        // would still expose the button to AT with a tooltip).
        expect(html).not.toMatch(
            /<button[^>]*id="raven-knit-open-browser"[^>]*\bdisabled\b/,
        );
    });

    test('only open-in-browser is hidden by isRemoteWorkspace', () => {
        // Defensive scope check: the remote flag must not leak onto
        // the other toolbar entries or the other context-menu items.
        const html = buildShellHtml({
            ...args('/work/report.html'),
            isRemoteWorkspace: true,
        });
        expect(html).not.toMatch(/<button[^>]*id="raven-knit-refresh"[^>]*\bhidden\b/);
        expect(html).not.toMatch(/<button[^>]*id="raven-knit-export"[^>]*\bhidden\b/);
        expect(html).not.toMatch(/<button[^>]*id="raven-knit-theme"[^>]*\bhidden\b/);
        expect(html).not.toMatch(/<button[^>]*data-action="copy"[^>]*\bhidden\b/);
        expect(html).not.toMatch(/<button[^>]*data-action="select-all"[^>]*\bhidden\b/);
        expect(html).not.toMatch(/<button[^>]*data-action="copy-image"[^>]*\bhidden\b/);
    });

    test('re-knit button carries the "Knit again" aria-label and tooltip', () => {
        // "Refresh" was the original label; the document-rendering
        // analogy doesn't fit because the button re-runs knit (re-
        // executes R code, regenerates the file) rather than
        // refetching the same URL. After the icon-toolbar redesign
        // the label moves to aria-label/title so the button stays
        // icon-only — the row height never changes when state
        // labels rotate.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-refresh"[^>]*\baria-label="Knit again"/,
        );
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-refresh"[^>]*\btitle="Knit again \(re-knit the source document\)"/,
        );
        // The button is icon-only — no visible text label.
        expect(html).not.toMatch(/<button[^>]*id="raven-knit-refresh"[^>]*>[^<]*Knit again[^<]*</);
        expect(html).not.toMatch(/<button[^>]*id="raven-knit-refresh"[^>]*>Refresh</);
    });

    test('theme toggle button starts in unpressed state when not persisted', () => {
        const html = buildShellHtml(args('/work/report.html'));
        // Button must declare aria-pressed so screen readers report
        // the toggle state; on first render the theme has not been
        // applied yet so it should read "false". The label lives in
        // aria-label now (icon-only design).
        expect(html).toMatch(/<button[^>]*id="raven-knit-theme"[^>]*aria-pressed="false"/);
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-theme"[^>]*\baria-label="Apply VS Code theme"/,
        );
    });

    test('initialThemeApplied=true renders the button in the pressed state', () => {
        // The extension reads the persisted preference from
        // globalState and threads it through here; the rendered
        // button should immediately reflect "theme applied" so the
        // user does not see a one-frame flicker between renders.
        // Note: the icon does NOT change with state — Rmd output has
        // no "document theme" to switch back to, so the active state
        // is conveyed only via aria-pressed + CSS.
        const html = buildShellHtml(args('/work/report.html', 'N', true));
        expect(html).toMatch(/<button[^>]*id="raven-knit-theme"[^>]*aria-pressed="true"/);
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-theme"[^>]*\baria-label="Apply VS Code theme"/,
        );
        // The script's local state variable starts at the same value.
        expect(html).toContain('let themeApplied = true;');
    });

    test('theme button aria-label is constant; state is visual only', () => {
        const off = buildShellHtml(args('/work/r.html', 'N', false));
        const on = buildShellHtml(args('/work/r.html', 'N', true));
        // Both renderings carry the same aria-label — only aria-pressed
        // flips. The label never says "Use document theme" since
        // there isn't one.
        expect(off).toContain('aria-label="Apply VS Code theme"');
        expect(on).toContain('aria-label="Apply VS Code theme"');
        expect(off).not.toContain('Use document theme');
        expect(on).not.toContain('Use document theme');
    });

    test('toolbar groups Knit again on the left and everything else on the right', () => {
        // Layout mirrors the Plot Viewer toolbar (Svelte App.svelte):
        // the primary action that re-runs work sits on the left, the
        // share / browse / theme cluster goes on the right after a
        // flex: 1 spacer. The viewing-preference toggle is the
        // right-most item so it never collides with the action group.
        const html = buildShellHtml(args('/work/r.html'));
        const refreshIdx = html.indexOf('id="raven-knit-refresh"');
        const spacerIdx = html.indexOf('class="raven-knit-spacer"');
        const exportIdx = html.indexOf('id="raven-knit-export"');
        const browserIdx = html.indexOf('id="raven-knit-open-browser"');
        const themeIdx = html.indexOf('id="raven-knit-theme"');
        expect(refreshIdx).toBeGreaterThan(0);
        expect(spacerIdx).toBeGreaterThan(refreshIdx);
        expect(exportIdx).toBeGreaterThan(spacerIdx);
        expect(browserIdx).toBeGreaterThan(spacerIdx);
        expect(themeIdx).toBeGreaterThan(spacerIdx);
        // Theme toggle is the right-most control.
        expect(themeIdx).toBeGreaterThan(exportIdx);
        expect(themeIdx).toBeGreaterThan(browserIdx);
        expect(html).toMatch(/\.raven-knit-spacer\s*\{[\s\S]*?flex:\s*1/);
    });

    test('toggle uses primary-button palette for the engaged state', () => {
        // Pin the visual contract: the toggle's engaged state fills
        // the icon-only button with VS Code's primary-button accent
        // (the same vars the Plot Viewer toolbar's theme toggle
        // uses). The prior ::before checkmark is gone because the
        // icon-only redesign uses the codicon glyph + colored
        // background to convey state, and the prior inputOption-*
        // accent was too subtle against the editorWidget surface.
        const html = buildShellHtml(args('/work/r.html'));
        // The CSS targets the aria-pressed state directly and uses
        // the primary-button palette so the engaged state is
        // unambiguous across every theme.
        expect(html).toMatch(
            /#raven-knit-toolbar button#raven-knit-theme\[aria-pressed="true"\]\s*\{[\s\S]*?background:\s*var\(--vscode-button-background\)/,
        );
        expect(html).toMatch(
            /#raven-knit-toolbar button#raven-knit-theme\[aria-pressed="true"\]\s*\{[\s\S]*?color:\s*var\(--vscode-button-foreground\)/,
        );
        expect(html).toMatch(
            /#raven-knit-theme\[aria-pressed="true"\]:hover[^{]*\{[\s\S]*?background:\s*var\(--vscode-button-hoverBackground\)/,
        );
        // ::before checkmark has been retired with the icon redesign;
        // assert it didn't sneak back in.
        expect(html).not.toMatch(/#raven-knit-theme::before/);
        // The brittle inputOption-* vars are also gone from the
        // toggle's styling.
        expect(html).not.toMatch(
            /#raven-knit-theme\[aria-pressed="true"\]\s*\{[\s\S]*?--vscode-inputOption-/,
        );
    });

    test('toolbar buttons are icon-only (SVG glyphs, no visible labels)', () => {
        // Pin the visual contract for the icon-toolbar redesign: each
        // toolbar button contains an inline <svg> codicon, and none of
        // them carries a visible text label. Text labels live in
        // aria-label and title so AT users still hear them.
        const html = buildShellHtml(args('/work/r.html'));
        const buttons = [
            'raven-knit-refresh',
            'raven-knit-open-browser',
            'raven-knit-export',
            'raven-knit-theme',
        ];
        for (const id of buttons) {
            const re = new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/button>`);
            const m = html.match(re);
            expect(m).not.toBeNull();
            const inner = m![1];
            expect(inner).toContain('<svg');
            expect(inner).toContain('fill="currentColor"');
            // Strip the SVG and assert no residual visible text.
            const withoutSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, '');
            expect(withoutSvg.replace(/\s+/g, '')).toBe('');
        }
    });

    test('toolbar stays single-row at every panel width', () => {
        // The redesign pins flex-wrap: nowrap on the toolbar so a
        // future text-bearing button (or a long aria-label that
        // somehow leaks visually) can't wrap to a second row and
        // bump the height. overflow-x: auto with a hidden scrollbar
        // is the safety net for very narrow panels.
        const html = buildShellHtml(args('/work/r.html'));
        expect(html).toMatch(/#raven-knit-toolbar\s*\{[\s\S]*?flex-wrap:\s*nowrap/);
        expect(html).toMatch(/#raven-knit-toolbar\s*\{[\s\S]*?overflow-x:\s*auto/);
        expect(html).toContain('scrollbar-width: none');
    });

    test('export trigger carries an explicitly synced aria-expanded', () => {
        // The trigger uses declarative `popovertarget` to toggle the
        // popover, which also excludes it from the popover's light-
        // dismiss algorithm (without `popovertarget`, a click on the
        // trigger while the popover is open would be classified as an
        // outside click, the popover would close on pointerup, and a
        // JS click handler that then called showPopover() would just
        // reopen it — the trigger could never close the popover).
        // Pin `popovertarget` as a load-bearing attribute, the
        // `aria-expanded="false"` initial state for AT, and the
        // `beforetoggle` listener that keeps the attribute in sync
        // (belt-and-suspenders alongside the browser's native
        // popovertarget aria-expanded auto-mirror).
        const html = buildShellHtml(args('/work/r.html'));
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-export"[^>]*popovertarget="raven-knit-export-popover"/,
        );
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-export"[^>]*\baria-expanded="false"/,
        );
        expect(html).toMatch(
            /exportPopover\.addEventListener\(['"]beforetoggle['"][\s\S]*?exportBtn\.setAttribute\(['"]aria-expanded['"]/,
        );
    });

    test('export popover replaces VS Code QuickPick with an in-shell menu', () => {
        // The Export button previously posted a payload-less
        // `requestExport` and the host opened VS Code's native
        // QuickPick; the redesign moves the format choice into a
        // webview-side HTML popover (mirroring the plot viewer's
        // share popover) so the format value reaches the host via
        // the validated `requestExport.format` field instead.
        const html = buildShellHtml(args('/work/r.html'));
        expect(html).toContain('id="raven-knit-export-popover"');
        expect(html).toMatch(/popover="auto"/);
        expect(html).toContain('role="group"');
        expect(html).toContain('data-format="html"');
        expect(html).toContain('data-format="pdf"');
        expect(html).toContain('data-format="docx"');
        // The export trigger references the popover via aria-controls
        // for AT popup tracking. The actual open/close is driven by
        // the declarative `popovertarget` attribute (pinned in the
        // sibling test above); the busy-state click handler then
        // pre-empts that declarative toggle via `e.preventDefault()`
        // when the user clicks the cancel-icon to abort an in-flight
        // export.
        expect(html).toMatch(
            /<button[^>]*id="raven-knit-export"[^>]*aria-controls="raven-knit-export-popover"/,
        );
        // The webview now posts the format on the request — the
        // host-side QuickPick is gone from the panel code.
        expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*['"]requestExport['"]\s*,\s*format:/);
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
        // The injected stylesheet paints `pre.raven-knit-code` (input
        // chunks) with c.codeBg and forces any descendant `code` to
        // transparent so a semi-transparent textCodeBlock-background
        // (VS Code's default for dark themes) doesn't double-layer
        // inside the code text area. The descendant combinator
        // (`pre code` rather than `pre > code`) also covers
        // span-wrapped `<pre><span>…<code>` shapes some plugins emit.
        expect(html).toMatch(/pre\.raven-knit-code\s*\{\s*background:/);
        expect(html).toMatch(/pre code\s*\{\s*background:\s*transparent/);
        // Output `<pre>` blocks (untagged) are explicitly flattened.
        // The flatten declarations live on the next concatenation
        // line, so assert each property separately rather than
        // trying to match across the `' + '` boundary. The flatten
        // intentionally omits `!important` so user-authored
        // `<pre style="…">` in asis output keeps its inline style.
        expect(html).toMatch(/pre:not\(\.raven-knit-code\)\s*\{/);
        expect(html).toContain('background: transparent; border: 0; padding: 0;');
    });

    test('theme overlay recolors inline SVG plots and hides tagged plot backgrounds', () => {
        // Knit Preview figures are marked as SVG plots by
        // inlineLocalImagesAsDataUrls, then inlined into the sandboxed
        // iframe by the shell script. Once inline, the same structural
        // overlay idea used by the plot viewer can reach text, strokes,
        // and tagged background rects.
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('.raven-knit-plot-host svg.raven-knit-plot-svg text');
        expect(html).toContain('path:not(.raven-bg):not(.raven-text-glyph)');
        expect(html).toContain('.raven-knit-plot-host svg.raven-knit-plot-svg rect:not(.raven-bg)');
        expect(html).toContain('.raven-knit-plot-host svg.raven-knit-plot-svg .raven-bg');
        expect(html).toContain('fill: none !important;');
        expect(html).toContain('stroke: none !important;');
    });

    test('theme overlay does not stroke grDevices SVG font glyph paths', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('tagKnitPlotGlyphPaths(svg)');
        expect(html).toContain("defs path");
        expect(html).toContain("classList.add('raven-text-glyph')");
        expect(html).toContain('path:not(.raven-bg):not(.raven-text-glyph)');
        expect(html).toContain('path.raven-text-glyph');
        expect(html).toContain('stroke: none !important;');
    });

    test('shell tags grDevices SVG canvas rects and first clipped fill path as backgrounds', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('isInitialDirectSvgRect');
        expect(html).toContain('grDevices::svg commonly emits duplicate top-level canvas');
        expect(html).toContain('tagKnitPlotBackgroundPaths(svg)');
        expect(html).toContain('firstClipPathGroup');
        expect(html).toContain('clipPathBoundsForGroup');
        expect(html).toContain('boundsNearlyEqual');
        expect(html).toContain("pathEl.classList.add('raven-bg')");
    });

    test('shell inlines only SVGs marked as knit plots and sanitizes before insertion', () => {
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain('img[data-raven-plot-svg="true"]');
        expect(html).toContain('DOMParser');
        expect(html).toContain('raven-knit-plot-svg');
        expect(html).toContain('raven-bg');
        expect(html).toContain("'foreignobject'");
        expect(html).toContain("'feimage'");
        expect(html).toContain("name.indexOf('on') === 0");
        expect(html).toContain("name === 'href'");
        expect(html).toContain("name === 'xlink:href'");
    });

    test('shell leaves marked SVG plots as images until the theme overlay is applied', () => {
        const html = buildShellHtml(args('/work/report.html'));
        const applyTheme = html.indexOf('function applyTheme()');
        const offBranch = html.indexOf('if (!themeApplied)', applyTheme);
        const inlineCall = html.indexOf('inlineKnitSvgPlots(doc);', applyTheme);
        expect(applyTheme).toBeGreaterThanOrEqual(0);
        expect(offBranch).toBeGreaterThan(applyTheme);
        expect(inlineCall).toBeGreaterThan(offBranch);
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

    test('theme toggle posts themeChanged message (persistence is host-side globalState)', () => {
        // The theme-toggle choice lives in the extension's globalState so
        // it survives panel disposal/recreation across knits; the webview
        // only posts a message and the extension writes. (Note: the shell
        // DOES use vscode.setState — but only to persist the
        // serializer-restore record {sourceFsPath, outputPath}, never the
        // theme choice. Those are separate concerns.)
        const html = buildShellHtml(args('/work/report.html'));
        expect(html).toContain("type: 'themeChanged'");
        expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*['"]themeChanged['"]/);
        // The only setState call is the restore-record one.
        expect(html).toContain('vscode.setState(ravenRestoreState)');
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

    test('export popover aria-label escapes the basename', () => {
        // The popover aria-label now templates the basename so AT users
        // hear "Export <basename>". macOS and Linux both permit `<`,
        // `>`, `&`, and `"` in filenames; an unescaped basename would
        // break out of the attribute value and inject markup into the
        // toolbar. The basename flows through the same `escapeHtml`
        // helper as the iframe title test above.
        const html = buildShellHtml(args('/work/re<script>"&.html'));
        expect(html).toContain(
            'aria-label="Export re&lt;script&gt;&quot;&amp;.html"',
        );
        // Defense in depth: the unescaped form must not appear
        // anywhere in the emitted shell.
        expect(html).not.toContain('re<script>"&.html');
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

/**
 * The webview-side `RAVEN_PALETTE_CSS_RE` and `paletteCssIsComplete`
 * trust boundary in `knit-output.ts` is what gates the VS Code theme
 * palette overlay from being applied to the iframe's stylesheet. If
 * `paletteCssDeclarations` ever emits a shape the webview rejects, the
 * toggle silently degrades to the GitHub palette with no diagnostic.
 *
 * Mirror both checks here as a guardrail test: any drift between the
 * declarations and the accept regex/whitelist (e.g. a new TokenRole
 * with a digit or uppercase letter, a renamed variable, a missing var)
 * fails this test rather than silently breaking the live overlay.
 *
 * Keep these literals in sync with `knit-output.ts`.
 */
describe('paletteCssDeclarations <-> webview accept-regex round-trip', () => {
    const RAVEN_PALETTE_CSS_RE
        = /^(?:--raven-(?:bg|fg|c-[a-zA-Z]+): #(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8}); ?)+$/;
    const REQUIRED_NAMES = [
        '--raven-bg',
        '--raven-fg',
        '--raven-c-keyword',
        '--raven-c-string',
        '--raven-c-number',
        '--raven-c-comment',
        '--raven-c-function',
        '--raven-c-type',
        '--raven-c-variable',
        '--raven-c-operator',
        '--raven-c-punctuation',
        '--raven-c-constant',
    ];

    function paletteCssIsComplete(css: string): boolean {
        const seen = new Set<string>();
        const pat = /--raven-(?:bg|fg|c-[a-zA-Z]+)(?=:)/g;
        let m: RegExpExecArray | null;
        while ((m = pat.exec(css)) !== null) {
            if (seen.has(m[0])) return false;
            seen.add(m[0]);
        }
        for (const name of REQUIRED_NAMES) {
            if (!seen.has(name)) return false;
        }
        return seen.size === REQUIRED_NAMES.length;
    }

    test('githubLight palette is accepted by the shape regex', () => {
        const css = paletteCssDeclarations(githubLight);
        expect(RAVEN_PALETTE_CSS_RE.test(css)).toBe(true);
    });

    test('githubDark palette is accepted by the shape regex', () => {
        const css = paletteCssDeclarations(githubDark);
        expect(RAVEN_PALETTE_CSS_RE.test(css)).toBe(true);
    });

    test('githubLight palette contains every required variable name', () => {
        const css = paletteCssDeclarations(githubLight);
        expect(paletteCssIsComplete(css)).toBe(true);
    });

    test('githubDark palette contains every required variable name', () => {
        const css = paletteCssDeclarations(githubDark);
        expect(paletteCssIsComplete(css)).toBe(true);
    });

    test('a payload missing a required variable is rejected', () => {
        // Drop --raven-c-constant.
        const css = paletteCssDeclarations(githubLight)
            .replace(/--raven-c-constant: #[0-9a-fA-F]+; ?/, '');
        expect(paletteCssIsComplete(css)).toBe(false);
    });

    test('a payload with a duplicated variable is rejected', () => {
        const css = paletteCssDeclarations(githubLight) + ' --raven-bg: #ffffff;';
        expect(paletteCssIsComplete(css)).toBe(false);
    });
});
