import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, getFixtureUri, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * When a knit succeeds and produces an HTML output, the panel itself
 * is the success signal — the user is staring at the rendered content.
 * The previous code surfaced a `Raven: Knit succeeded: X.html` toast
 * with a "Show Output Panel" button, which (a) duplicates an obvious
 * affordance the user can already see, and (b) costs an explicit
 * dismissal click. This test pins the contract: no popover on HTML
 * success.
 *
 * Failures, timeouts, cancellation, and non-HTML success keep their
 * popovers — those are the only outcomes the user wouldn't otherwise
 * see.
 */
suite('knit success: no popover when HTML output is shown', () => {
    test('HTML success does not call showInformationMessage', async () => {
        await activate();

        const docUri = getFixtureUri('sample.Rmd');
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);

        const calls: unknown[][] = [];
        const origShow = vscode.window.showInformationMessage;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (
            ...args: unknown[]
        ): Thenable<string | undefined> => {
            calls.push(args);
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
                stdout: `Output created: ${path.join(path.dirname(docUri.fsPath), 'sample.html')}\n`,
                stderr: '',
            })) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async () => undefined) as KnitDeps['runPostKnitRender'],
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

            // We tolerate a single info-message for the workspace-
            // trust prompt if it fires in CI; assert no toast text
            // contains the success label, which is what the user
            // explicitly objected to.
            for (const args of calls) {
                const label = String(args[0] ?? '');
                assert.ok(
                    !label.startsWith('Raven: Knit succeeded'),
                    `Unexpected success toast: ${label}`,
                );
            }
        } finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origShow;
            output.dispose();
        }
    });

    test('multi-output HTML success logs all paths to the output channel', async () => {
        await activate();

        const docUri = getFixtureUri('sample.Rmd');
        const dir = path.dirname(docUri.fsPath);

        const lines: string[] = [];
        const fakeOutput = {
            append: (s: string) => lines.push(s),
            appendLine: (s: string) => lines.push(s),
            replace: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
            name: 'Knit Test',
        } as unknown as vscode.OutputChannel;

        const origShow = vscode.window.showInformationMessage;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (
            ..._args: unknown[]
        ): Thenable<string | undefined> => Promise.resolve(undefined);

        const inFlight = new Set<string>();
        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        const html = path.join(dir, 'sample.html');
        const pdf = path.join(dir, 'sample.pdf');

        const deps: KnitDeps = {
            runKnit: (async () => ({
                spawnError: null,
                cancelled: false,
                timedOut: false,
                exitCode: 0,
                stdout: `Output created: ${html}\nOutput created: ${pdf}\n`,
                stderr: '',
            })) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async () => undefined) as KnitDeps['runPostKnitRender'],
        };

        try {
            await __runKnitCommandForTest({
                uri: docUri,
                output: fakeOutput,
                inFlight,
                context: fakeContext,
                deps,
            });
            await sleep(50);

            const joined = lines.join('\n');
            assert.ok(
                joined.includes('sample.html'),
                'multi-output knit should log the HTML primary path',
            );
            assert.ok(
                joined.includes('sample.pdf'),
                'multi-output knit should log the secondary PDF path',
            );
            assert.ok(
                /primary/i.test(joined),
                'output channel should mark the primary output',
            );
        } finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origShow;
        }
    });
});
