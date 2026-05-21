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
        });

        assert.ok(
            fs.existsSync(htmlPath),
            `expected the renderer to have written ${htmlPath}`,
        );
        const html = fs.readFileSync(htmlPath, 'utf-8');

        // Sanity checks: the document is self-contained, includes our
        // marker, includes the GitHub palette as a CSS variable, and
        // wrapped the R block in a `<pre><code class="language-r">`
        // structure.
        assert.match(html, /^<!doctype html>/i);
        assert.ok(html.includes('POST-KNIT-RENDERER-MARKER'));
        assert.ok(/--raven-bg:/.test(html), 'GitHub palette CSS vars should be inlined');
        assert.ok(
            /<pre><code class="language-r">/i.test(html),
            'R code block should round-trip with the language-r class',
        );
        // KaTeX CSS should be inlined (vscode.markdown-math is a
        // built-in). The CSS file contains the `.katex` selector and
        // multiple `katex` font/spacing declarations, so a case-
        // insensitive `katex` match is a stable proxy.
        assert.ok(
            /\bkatex\b/i.test(html),
            'KaTeX CSS should be inlined from vscode.markdown-math',
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
