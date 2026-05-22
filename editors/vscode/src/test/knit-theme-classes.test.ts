import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, getFixtureUri, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * `Raven: Knit` must thread VS Code's active color theme through to
 * `runPostKnitRender` as the `themeClasses` argument, so the rendered
 * `.html` paints its code-block spans with the editor theme rather
 * than the user's OS color scheme.
 *
 * Without this wiring the renderer falls back to the standalone /
 * "Open in Browser" stylesheet (both palettes embedded, switched by
 * `@media (prefers-color-scheme: dark)`), and the panel ends up
 * following the OS theme — which is wrong inside VS Code where the
 * editor theme is the ground truth.
 *
 * CodeRabbit flagged this at PR #297 review time; the wiring lives at
 * the single call site in `knit-commands.ts` (the success-branch in
 * `renderOutcome`). This test captures the args passed to
 * `runPostKnitRender` and asserts `themeClasses` is set to a valid
 * `vscode-…` body-class string.
 */
suite('knit threads VS Code theme through to runPostKnitRender', () => {
    test('themeClasses is one of the documented vscode-* values', async () => {
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
            assert.ok(
                typeof captured!.themeClasses === 'string',
                `themeClasses should be threaded through; got ${typeof captured!.themeClasses}`,
            );
            assert.ok(
                /^vscode-(light|dark|high-contrast|high-contrast-light)$/.test(
                    captured!.themeClasses as string,
                ),
                `themeClasses should match the documented vscode-* set; got "${captured!.themeClasses}"`,
            );
        } finally {
            output.dispose();
        }
    });
});
