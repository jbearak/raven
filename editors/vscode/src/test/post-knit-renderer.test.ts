import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from './helper';
import { runPostKnitRender, __resetRegistryCacheForTesting } from '../knit/post-knit-renderer';

/**
 * End-to-end test for the post-knit render pipeline. Drives the full
 * production wiring of `runPostKnitRender`:
 *   - reads a real `.md` from disk
 *   - calls `markdown.api.render` through VS Code
 *   - discovers the live R grammar via `vscode.extensions.all`
 *   - writes a real `.html` next to the source
 *
 * The LSP client is intentionally `undefined` so the test does NOT
 * depend on the full LSP being up — the renderer falls back to
 * grammar-only highlighting. Exercising the LSP-overlay path requires
 * a live LSP, which is covered by the unit tests for
 * `semanticOverlaysFromLspData` and the `code-highlighter` overlay
 * tests; here we only need to confirm the production glue calls each
 * dependency.
 */
suite('runPostKnitRender end-to-end', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-post-knit-render-'));
        __resetRegistryCacheForTesting();
    });

    teardown(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
        __resetRegistryCacheForTesting();
    });

    test('writes a self-contained HTML file with the GitHub palette and a highlighted R code block', async function () {
        this.timeout(30000);
        await activate();

        const mdPath = path.join(tmp, 'demo.md');
        const htmlPath = path.join(tmp, 'demo.html');
        const mdSource = [
            '# Heading',
            '',
            '```r',
            'library(ggplot2)',
            '```',
            '',
            'POST-KNIT-RENDERER-MARKER',
            '',
        ].join('\n');
        fs.writeFileSync(mdPath, mdSource, 'utf-8');

        // Minimal ExtensionContext stub — only `extensionUri` is used
        // by the renderer (to resolve onig.wasm). The real ext URI
        // points at our development extension's root.
        const ravenExt = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ravenExt, 'raven extension must be present');
        const fakeContext = {
            extensionUri: ravenExt.extensionUri,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        await runPostKnitRender({
            mdPath,
            htmlPath,
            context: fakeContext,
            client: undefined,
            hadSourceFrontmatter: false,
        });

        assert.ok(
            fs.existsSync(htmlPath),
            `expected the renderer to have written ${htmlPath}`,
        );
        const html = fs.readFileSync(htmlPath, 'utf-8');

        // Sanity checks: the document is self-contained, includes our
        // marker, includes the GitHub palette as a CSS variable, and
        // wrapped the R block in a
        // `<pre class="raven-knit-code"><code class="language-r">…`
        // structure. The marker class scopes the panel chrome to input
        // chunks; output blocks (untagged) render bare.
        assert.match(html, /^<!doctype html>/i);
        assert.ok(html.includes('POST-KNIT-RENDERER-MARKER'));
        assert.ok(/--raven-bg:/.test(html), 'GitHub palette CSS vars should be inlined');
        // Font CSS variables are baked in at render time (the same
        // `.html` is consumed by the panel AND "Open in Browser", so
        // font resolution has to happen once in the host). Even with
        // neither raven setting configured the fallback chain
        // resolves through VS Code defaults to a non-empty,
        // generic-family-terminated string.
        assert.ok(
            /--raven-font-text:/.test(html),
            'body font CSS var should be inlined (falls back through markdown.preview.fontFamily)',
        );
        assert.ok(
            /--raven-font-mono:/.test(html),
            'mono font CSS var should be inlined (falls back through editor.fontFamily)',
        );
        assert.ok(
            /font-family: var\(--raven-font-text\)/.test(html),
            'body selector should reference --raven-font-text',
        );
        assert.ok(
            /font-family: var\(--raven-font-mono\)/.test(html),
            'code selector should reference --raven-font-mono',
        );
        assert.ok(
            /<pre class="raven-knit-code"><code class="language-r">/i.test(html),
            'R code block should round-trip with the language-r class and raven-knit-code marker',
        );
        // KaTeX CSS should be inlined (vscode.markdown-math is a
        // built-in). The CSS file contains the `.katex` selector and
        // multiple `katex` font/spacing declarations, so a case-
        // insensitive `katex` match is a stable proxy.
        assert.ok(
            /\bkatex\b/i.test(html),
            'KaTeX CSS should be inlined from vscode.markdown-math',
        );

        // Inside <pre><code class="language-r">…</code></pre> we
        // expect multiple distinct token roles painted via
        // `var(--raven-c-XXX)` references (the grammar paints
        // operators / strings / punctuation / etc. with different
        // role variables) and specifically the function role on
        // `library`. This is the canary for the bug fixed in an
        // earlier commit: VS Code's `markdown.api.render` pre-runs
        // each code block through markdown-it's highlight.js hook
        // and emits inline `<span class="hljs-…">` wrappers inside
        // `<code>`. If `decodeCodeBlock` doesn't strip those
        // wrappers before handing the body to vscode-textmate, the
        // grammar tokenizes the literal HTML markup as R source and
        // the resulting output ends up monochrome.
        //
        // Spans use CSS variables (not baked-in hex) so the
        // stylesheet's palette swap — both the `prefers-color-scheme:
        // dark` swap on the standalone file and the panel theme
        // swap — actually reaches the highlighted spans.
        const blockMatch = html.match(
            /<pre(?:\s+class="raven-knit-code")?><code class="language-r">([\s\S]*?)<\/code><\/pre>/i,
        );
        assert.ok(
            blockMatch,
            'expected a <pre class="raven-knit-code"><code class="language-r">...</code></pre> block in the output',
        );
        const body = blockMatch![1];
        const roleVars = new Set<string>();
        const reRoleVar = /color:var\((--raven-c-[a-z]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = reRoleVar.exec(body)) !== null) {
            roleVars.add(m[1]);
        }
        assert.ok(
            roleVars.size >= 2,
            `expected multiple distinct --raven-c-* role variables inside the R block, got ` +
                `${roleVars.size} (${[...roleVars].join(', ')})\n---body---\n${body}`,
        );
        assert.ok(
            body.includes('color:var(--raven-c-function)">library'),
            `expected --raven-c-function (function role) on library; body:\n${body}`,
        );
    });

    test('writes atomically via a temp-and-rename, leaving no stray .tmp files', async function () {
        this.timeout(30000);
        await activate();

        const mdPath = path.join(tmp, 'atomic.md');
        const htmlPath = path.join(tmp, 'atomic.html');
        fs.writeFileSync(mdPath, '# Hello\n', 'utf-8');

        const ravenExt = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ravenExt);
        const fakeContext = {
            extensionUri: ravenExt.extensionUri,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        await runPostKnitRender({
            mdPath,
            htmlPath,
            context: fakeContext,
            client: undefined,
            hadSourceFrontmatter: false,
        });

        const html = fs.readFileSync(htmlPath, 'utf-8');
        // Sanity: it's a complete document, not a truncated write.
        assert.match(html, /^<!doctype html>/i);
        assert.ok(html.endsWith('</html>'));

        // No stray temp files — they live in the same dir with a
        // leading `.` and the `.tmp` suffix.
        const stragglers = fs.readdirSync(tmp).filter((name) =>
            name.startsWith('.atomic.html.') && name.endsWith('.tmp'),
        );
        assert.deepStrictEqual(
            stragglers,
            [],
            `expected no stray .tmp files in ${tmp}, found ${JSON.stringify(stragglers)}`,
        );
    });

    test('strips YAML front matter so it does not render as a styled box', async function () {
        this.timeout(30000);
        await activate();

        // Regression: `knitr::knit` leaves the source `---...---`
        // block in its output `.md`. Without the gate added in
        // `renderKnitHtml`, VS Code's `markdown.api.render` wraps
        // that block in `<pre class="frontmatter">…</pre>` — visible
        // at the top of the preview as an unwanted table-like box.
        // This case exercises the REAL `markdown.api.render` (the
        // bun unit test in `render-html.test.ts` uses a fake renderer
        // and can't see the live markdown-it plugin behavior).
        const mdPath = path.join(tmp, 'frontmatter.md');
        const htmlPath = path.join(tmp, 'frontmatter.html');
        const mdSource = [
            '---',
            'title: My Document',
            'author: Test Author',
            'output: html_document',
            '---',
            '',
            'POST-KNIT-RENDERER-MARKER',
            '',
        ].join('\n');
        fs.writeFileSync(mdPath, mdSource, 'utf-8');

        const ravenExt = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ravenExt);
        const fakeContext = {
            extensionUri: ravenExt.extensionUri,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        await runPostKnitRender({
            mdPath,
            htmlPath,
            context: fakeContext,
            client: undefined,
            hadSourceFrontmatter: true,
        });

        const html = fs.readFileSync(htmlPath, 'utf-8');
        // The body must still appear.
        assert.ok(
            html.includes('POST-KNIT-RENDERER-MARKER'),
            'body marker should survive the strip',
        );
        // VS Code's frontmatter plugin tags the block with the
        // `frontmatter` class — that class must NOT appear in the
        // rendered HTML.
        assert.ok(
            !/class="frontmatter\b/.test(html),
            `expected no <pre class="frontmatter"> in output; got:\n${html}`,
        );
        // And the raw YAML values must not leak through as visible
        // prose either.
        assert.ok(
            !/title:\s*My Document/.test(html),
            'YAML `title:` line should not appear in rendered HTML',
        );
        assert.ok(
            !/author:\s*Test Author/.test(html),
            'YAML `author:` line should not appear in rendered HTML',
        );
    });

    test('decodes HTML entities so source round-trips through the highlighter', async function () {
        this.timeout(30000);
        await activate();

        // A `<-` arrow is a common case: VS Code's markdown pipeline
        // emits `&lt;-` and the highlighter must decode it back to
        // `<-` for grammar tokenization, then re-escape in the final
        // output so the HTML is structurally valid.
        const mdPath = path.join(tmp, 'arrow.md');
        const htmlPath = path.join(tmp, 'arrow.html');
        const mdSource = '```r\nx <- 1\n```\n';
        fs.writeFileSync(mdPath, mdSource, 'utf-8');

        const ravenExt = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ravenExt);
        const fakeContext = {
            extensionUri: ravenExt.extensionUri,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        await runPostKnitRender({
            mdPath,
            htmlPath,
            context: fakeContext,
            client: undefined,
            hadSourceFrontmatter: false,
        });

        const html = fs.readFileSync(htmlPath, 'utf-8');
        // The output should contain `&lt;-` (re-escaped for HTML
        // safety) — and crucially NOT the raw `<-` (which would be
        // parsed as an HTML tag).
        assert.ok(html.includes('&lt;-'), 'HTML body should re-escape < in the code block');
        assert.ok(!/<-/.test(html.replace(/&lt;-/g, '')),
            'No raw < followed by - should appear outside the escaped form');
    });
});
