import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, getFixtureUri, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * Verifies the Piece A fix: `inFlight.delete(fsPath)` must happen the
 * moment `withProgress` resolves, NOT after the user dismisses the
 * success toast. Under the old code, a fake `runKnit` that resolved
 * immediately would still leave the file marked in-flight until the
 * test dismissed the message — which is what caused the user-reported
 * "is already being knitted" bug.
 */
suite('knit progress lifecycle', () => {
    test('inFlight clears the moment runKnit resolves, not when toast is dismissed', async () => {
        await activate();

        const docUri = getFixtureUri('sample.Rmd');
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');

        // Stub showInformationMessage so the test does not hang on the
        // success toast. The bug under test was that inFlight stayed
        // populated until this resolved.
        const origShow = vscode.window.showInformationMessage;
        type Resolver = (v: string | undefined) => void;
        const resolvers: Resolver[] = [];
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (
            ..._args: unknown[]
        ): Thenable<string | undefined> => {
            return new Promise<string | undefined>((res) => {
                resolvers.push(res);
            });
        };

        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        let runKnitCalled = false;
        const deps: KnitDeps = {
            runKnit: (async () => {
                runKnitCalled = true;
                return {
                    spawnError: null,
                    cancelled: false,
                    timedOut: false,
                    exitCode: 0,
                    stdout: `Output created: ${path.join(path.dirname(docUri.fsPath), 'sample.html')}\n`,
                    stderr: '',
                };
            }) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
        };

        try {
            const runPromise = __runKnitCommandForTest({
                uri: docUri,
                output,
                inFlight,
                context: fakeContext,
                deps,
            });

            // Yield to let withProgress + runKnit resolve. After this
            // microtask drain, withProgress should be done AND
            // inFlight.delete should have happened — even though the
            // info-message stub is still suspended.
            await sleep(100);

            assert.ok(
                runKnitCalled,
                'fake runKnit was never invoked — runKnitCommand short-circuited on a precondition check',
            );
            assert.strictEqual(
                inFlight.has(docUri.fsPath),
                false,
                'inFlight should be cleared before the success toast is dismissed',
            );

            // Direct regression check: a second invocation while the first
            // success toast is still pending must NOT report "already being
            // knitted". This reproduces the user-reported bug ("____ is
            // already being knitted" on rapid re-invoke).
            let secondRunKnitCalled = false;
            const secondDeps: KnitDeps = {
                runKnit: (async () => {
                    secondRunKnitCalled = true;
                    return {
                        spawnError: null,
                        cancelled: false,
                        timedOut: false,
                        exitCode: 0,
                        stdout: `Output created: ${path.join(path.dirname(docUri.fsPath), 'sample.html')}\n`,
                        stderr: '',
                    };
                }) as KnitDeps['runKnit'],
                showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            };
            const secondPromise = __runKnitCommandForTest({
                uri: docUri,
                output,
                inFlight,
                context: fakeContext,
                deps: secondDeps,
            });
            await sleep(100);
            assert.ok(
                secondRunKnitCalled,
                'second invocation was blocked by the inFlight gate — the original bug regressed',
            );

            // Now dismiss every pending info-message so both promises resolve.
            for (const res of resolvers) res(undefined);
            await runPromise;
            await secondPromise;
        } finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origShow;
            output.dispose();
        }
    });
});
