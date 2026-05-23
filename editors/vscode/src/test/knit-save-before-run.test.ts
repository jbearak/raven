import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, awaitActive, getFixtureUri, sleep } from './helper';
import { __runKnitCommandForTest, type KnitDeps } from '../knit/knit-commands';

/**
 * Regression: `raven.knit` must save unsaved changes before invoking
 * the R subprocess. knitr reads the .Rmd from disk via R's
 * `readLines`, NOT from VS Code's in-memory buffer — so without an
 * explicit save the rendered output silently reflects whatever was
 * last persisted to disk, which from the user's perspective is
 * indistinguishable from "the knit didn't pick up my edits".
 */
suite('knit saves dirty buffers before invoking R', () => {
    test('dirty document is saved before runKnit is called', async () => {
        await activate();

        // Work on a private copy so the assertions can mutate the
        // on-disk content without disturbing other suites.
        const fixture = getFixtureUri('sample.Rmd');
        const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'raven-knit-save-'));
        const tmpPath = path.join(tmpDir, 'unsaved.Rmd');
        fs.copyFileSync(fixture.fsPath, tmpPath);
        const tmpUri = vscode.Uri.file(tmpPath);

        const doc = await vscode.workspace.openTextDocument(tmpUri);
        const editor = await vscode.window.showTextDocument(doc);

        // Mutate the in-memory buffer so the document becomes dirty.
        // The append goes at the very end (after the trailing "Hello.")
        // so it doesn't touch the YAML front-matter the knit command
        // re-parses.
        const insertedLine = '\nKnit-save-regression marker.\n';
        const edited = await editor.edit((b) => {
            const end = doc.lineAt(doc.lineCount - 1).range.end;
            b.insert(end, insertedLine);
        });
        assert.ok(edited, 'edit() refused to apply the in-memory change');
        assert.strictEqual(doc.isDirty, true, 'document should be dirty after the edit');

        // Snapshot the on-disk bytes BEFORE running knit. If the save
        // didn't fire, the file still won't contain the marker.
        const beforeDisk = fs.readFileSync(tmpPath, 'utf-8');
        assert.ok(
            !beforeDisk.includes('Knit-save-regression marker.'),
            'pre-condition: marker should not yet be on disk',
        );

        const inFlight = new Set<string>();
        const output = vscode.window.createOutputChannel('Knit Test');

        // Stub showInformationMessage so the test never hangs on a
        // success toast.
        const origShow = vscode.window.showInformationMessage;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = (
            ..._args: unknown[]
        ): Thenable<string | undefined> => Promise.resolve(undefined);

        const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        // The fake runKnit reads the file from disk and records what it
        // observed — this is the same surface the real R subprocess
        // would see via readLines.
        let observedOnDisk: string | undefined;
        let runKnitCalled = false;
        const deps: KnitDeps = {
            runKnit: (async () => {
                runKnitCalled = true;
                observedOnDisk = fs.readFileSync(tmpPath, 'utf-8');
                return {
                    spawnError: null,
                    cancelled: false,
                    timedOut: false,
                    exitCode: 0,
                    stdout: `Output created: ${path.join(path.dirname(tmpPath), 'unsaved.html')}\n`,
                    stderr: '',
                };
            }) as KnitDeps['runKnit'],
            showOrUpdatePanel: (async () => ({ ok: true })) as KnitDeps['showOrUpdatePanel'],
            getLanguageClient: () => undefined,
            runPostKnitRender: (async () => undefined) as KnitDeps['runPostKnitRender'],
        };

        try {
            await __runKnitCommandForTest({
                uri: tmpUri,
                output,
                inFlight,
                context: fakeContext,
                deps,
            });
            // Allow the post-knit microtasks to settle.
            await sleep(50);
        } finally {
            (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origShow;
        }

        assert.ok(runKnitCalled, 'runKnit was never invoked — the command short-circuited');
        assert.ok(
            observedOnDisk !== undefined,
            'observedOnDisk was never captured',
        );
        assert.ok(
            observedOnDisk!.includes('Knit-save-regression marker.'),
            'R subprocess would have seen the pre-edit on-disk version — save-before-knit regressed',
        );
        assert.strictEqual(
            doc.isDirty,
            false,
            'document should no longer be dirty after the save',
        );

        // Cleanup: close the editor and remove the temp file.
        // Wait for the editor we opened to be the active one before
        // closing — showTextDocument resolves before VS Code promotes
        // the editor to active, and the suite's cumulative state can
        // leave a different editor active when this test starts.
        await awaitActive(editor);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore cleanup errors */ }
    });
});
