import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, getFixtureUri, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * When `knitr::knit` itself succeeds (the intermediate `.md` exists)
 * but `runPostKnitRender` throws — e.g. KaTeX CSS read failure,
 * grammar registry init error, markdown.api.render unavailable — the
 * UI used to surface only an error toast that said "render step
 * failed; see output", leaving the user with no obvious path to the
 * generated markdown.
 *
 * CodeRabbit flagged this at PR #297 review time; the catch block in
 * `renderOutcome` now offers an "Open Markdown" action button on the
 * error toast that opens the produced `.md` in a text editor. This
 * test captures the `showErrorMessage` arguments and asserts both
 * action labels are present.
 */
suite('knit post-render failure keeps mdPath usable', () => {
    test('catch block surfaces an Open Markdown action and a Show Output action', async () => {
        await activate();

        const docUri = getFixtureUri('sample.Rmd');
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);

        const errorCalls: unknown[][] = [];
        const origShowError = vscode.window.showErrorMessage;
        // Resolve to `undefined` so the catch block takes neither
        // action branch — we're only locking down the button shape.
        (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (
            ...args: unknown[]
        ): Thenable<string | undefined> => {
            errorCalls.push(args);
            return Promise.resolve(undefined);
        };

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        const deps: KnitDeps = {
            runKnit: (async () => ({
                spawnError: null,
                cancelled: false,
                timedOut: false,
                exitCode: 0,
                stdout: `Output created: ${path.join(path.dirname(docUri.fsPath), 'sample.md')}\n`,
                stderr: '',
            })) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async () => {
                throw new Error('synthetic post-render failure');
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

            // Locate the render-failure toast specifically (other
            // `showErrorMessage` calls might fire for unrelated
            // reasons in CI).
            const renderToast = errorCalls.find((args) => {
                const label = String(args[0] ?? '');
                return label.includes('HTML render step failed');
            });
            assert.ok(
                renderToast,
                `expected an error toast about the render-step failure; saw ${
                    errorCalls.map((a) => String(a[0] ?? '')).join(' | ')
                }`,
            );

            // The toast args after the message are the action button
            // labels. We require BOTH "Open Markdown" (so the user
            // can salvage the knit) and "Show Output" (so they can
            // see why the render failed).
            const actions = (renderToast as unknown[]).slice(1).map(String);
            assert.ok(
                actions.includes('Open Markdown'),
                `expected an "Open Markdown" action; saw ${JSON.stringify(actions)}`,
            );
            assert.ok(
                actions.includes('Show Output'),
                `expected a "Show Output" action; saw ${JSON.stringify(actions)}`,
            );
        } finally {
            (vscode.window as { showErrorMessage: unknown }).showErrorMessage = origShowError;
            output.dispose();
        }
    });
});
