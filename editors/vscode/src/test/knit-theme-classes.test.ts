import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, getFixtureUri, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * `Raven: Knit` writes a single `.html` to disk that is shared by
 * both the panel iframe and "Open in Browser". A frozen file cannot
 * carry surface-specific theme logic, so `runPostKnitRender` must
 * be called with `themeClasses: null` — that path embeds both
 * palettes and swaps them on `@media (prefers-color-scheme: dark)`,
 * which resolves against the host OS in a browser and against
 * VS Code's editor theme inside the webview iframe.
 *
 * A previous wiring (PR #297) pinned VS Code's editor theme into
 * the bake so the panel would match the editor. That pinned the
 * browser surface too, since both surfaces share the file — opening
 * the result in a browser always showed whatever theme VS Code
 * happened to be on at knit time. This test guards against that
 * regression by asserting `themeClasses` is left null at the
 * production call site.
 */
suite('knit does not bake the editor theme into the .html', () => {
    test('themeClasses is null so prefers-color-scheme drives the bake', async () => {
        await activate();

        const docUri = getFixtureUri('sample.Rmd');
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);

        let captured: Parameters<typeof import('../knit/post-knit-renderer').runPostKnitRender>[0] | undefined;

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        const deps: KnitDeps = {
            runKnit: (async () => ({
                spawnError: null,
                cancelled: false,
                timedOut: false,
                exitCode: 0,
                stdout: `Output created: ${path.join(path.dirname(docUri.fsPath), 'sample.html')}\n`,
                stderr: '',
            })) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async (args) => {
                captured = args;
            }) as KnitDeps['runPostKnitRender'],
        };

        try {
            await __runKnitCommandForTest({
                uri: docUri,
                output,
                inFlight,
                context: fakeContext,
                deps,
            });
            await sleep(50);

            assert.ok(captured, 'runPostKnitRender should have been called');
            assert.strictEqual(
                captured!.themeClasses,
                null,
                'themeClasses must be null so the .html embeds both palettes ' +
                    'and swaps via @media (prefers-color-scheme: dark); ' +
                    `got ${JSON.stringify(captured!.themeClasses)}`,
            );
        } finally {
            output.dispose();
        }
    });
});
