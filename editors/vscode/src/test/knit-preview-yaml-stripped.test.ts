import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate } from './helper';
import {
    runPostKnitRender,
    __resetRegistryCacheForTesting,
} from '../knit/post-knit-renderer';

/**
 * End-to-end check that Raven's Knit Preview md→html step strips the
 * YAML frontmatter from the markdown source before invoking VS Code's
 * `markdown.api.render`. Without the strip, the rendered HTML contains
 * the `<table class="frontmatter">` that VS Code's markdown extension
 * emits by default (or one of its alternate shapes if the user has set
 * `markdown.preview.frontMatter` differently).
 *
 * The fix lives in `renderKnitHtml` (see `render-html.ts`); this test
 * exercises the live VS Code wiring through `runPostKnitRender` so a
 * future regression in `post-knit-renderer.ts`'s use of `renderKnitHtml`
 * (e.g. a refactor that bypasses the strip) is caught.
 *
 * See docs/superpowers/specs/2026-05-25-knit-preview-yaml-table-design.md.
 */
suite('Knit Preview strips YAML frontmatter from md→html', () => {
    let tmp: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-knit-yaml-stripped-'));
        __resetRegistryCacheForTesting();
    });

    teardown(() => {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
        __resetRegistryCacheForTesting();
    });

    test('rendered .html contains no frontmatter table, even though the .md has YAML', async function () {
        this.timeout(30000);
        await activate();

        const mdPath = path.join(tmp, 'demo.md');
        const htmlPath = path.join(tmp, 'demo.html');
        // Simulate what knitr writes: the document keeps its YAML
        // frontmatter intact in the .md. The strip must happen on the
        // in-memory source the post-knit renderer passes to
        // markdown.api.render, NOT by editing this file on disk.
        const mdSource = [
            '---',
            'title: My Document Title',
            'author: The Author',
            'date: 2026-05-25',
            'output: html_document',
            '---',
            '',
            '# Body Heading',
            '',
            'KNIT-PREVIEW-YAML-STRIPPED-MARKER',
            '',
        ].join('\n');
        fs.writeFileSync(mdPath, mdSource, 'utf-8');

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

        // The body marker must be present — proves the renderer ran
        // and emitted the post-frontmatter content.
        assert.ok(
            html.includes('KNIT-PREVIEW-YAML-STRIPPED-MARKER'),
            'rendered HTML must include the body marker',
        );

        // Frontmatter must NOT be present in any of the shapes VS
        // Code's markdown extension emits today:
        //   - default `"table"` mode emits `<table class="frontmatter"`
        //   - `"codeBlock"` mode emits `class="frontmatter hljs"` etc.
        //   - any future shape using `data-vscode-context` with the
        //     frontMatter webview section
        assert.ok(
            !/<table[^>]*class="[^"]*\bfrontmatter\b/i.test(html),
            'rendered HTML must not contain a frontmatter <table>',
        );
        assert.ok(
            !/class="[^"]*\bfrontmatter\b[^"]*"/i.test(html),
            'rendered HTML must not contain any element with a `frontmatter` class',
        );
        assert.ok(
            !/data-vscode-context=(?:'[^']*|"[^"]*)\bfrontMatter\b/i.test(html),
            'rendered HTML must not carry the frontmatter data-vscode-context',
        );

        // The literal YAML keys must not appear in the body either.
        // (The fixture used distinctive values so an incidental
        // substring match on `title` from CSS / metadata is implausible.)
        assert.ok(
            !html.includes('My Document Title'),
            'YAML title value must not appear in the rendered HTML body',
        );
        assert.ok(
            !html.includes('The Author'),
            'YAML author value must not appear in the rendered HTML body',
        );

        // The on-disk .md must still have its YAML — Pandoc export
        // re-reads this file and depends on the frontmatter for
        // title/author/output options.
        const mdAfter = fs.readFileSync(mdPath, 'utf-8');
        assert.ok(
            mdAfter.includes('title: My Document Title'),
            'on-disk .md must retain its YAML frontmatter',
        );
        assert.ok(
            mdAfter.includes('author: The Author'),
            'on-disk .md must retain its YAML frontmatter',
        );
    });
});
