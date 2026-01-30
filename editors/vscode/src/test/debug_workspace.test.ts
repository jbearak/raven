import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, openDocument, sleep } from './helper';

suite('Debug Workspace Indexing', () => {
    suiteSetup(async () => {
        await activate();
        await sleep(3000); // Give LSP time to initialize
    });

    test('check workspace folders', async () => {
        const folders = vscode.workspace.workspaceFolders;
        console.log('Workspace folders:', folders);
        console.log('Workspace folder count:', folders?.length);
        if (folders) {
            folders.forEach((f, i) => {
                console.log(`  [${i}] ${f.uri.toString()}`);
            });
        }
        assert.ok(folders && folders.length > 0, 'Expected workspace folders to be set');
    });
});
