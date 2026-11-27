import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'jsonc-parser';

/**
 * **Raven: Use Raven's Keyboard Shortcuts Instead of vscode-R's** writes to
 * the real keybindings.json of the test instance's user-data directory,
 * through the bundled command. The suite puts the file back afterwards.
 */

const COMMAND = 'raven.useRavenKeybindingsOverVscodeR';

function keybindings_document(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((doc) =>
        doc.uri.scheme === 'vscode-userdata' && path.posix.basename(doc.uri.path) === 'keybindings.json');
}

suite('send-to-r: keyboard shortcuts over vscode-R', () => {
    let original: string | undefined;

    suiteSetup(async () => {
        await vscode.extensions.getExtension('jbearak.raven-r')?.activate();
    });

    suiteTeardown(async () => {
        const doc = keybindings_document();
        if (doc && original !== undefined) {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), original);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('adds the shortcuts to keybindings.json and saves it, once', async () => {
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
        original = keybindings_document()?.getText();
        assert.notStrictEqual(original, undefined, 'keybindings.json should open as a vscode-userdata document');

        const added = await vscode.commands.executeCommand<number | undefined>(COMMAND);
        assert.strictEqual(added, 8, 'two entries (Mac and not) for each of four commands');

        const doc = keybindings_document()!;
        assert.strictEqual(doc.isDirty, false, 'the command saves the file');
        const on_disk = parse(fs.readFileSync(doc.uri.fsPath, 'utf8')) as Array<{ key: string; command: string; when: string }>;
        const run_line = on_disk.filter((entry) => entry.command === 'raven.runLineOrSelection');
        assert.deepStrictEqual(run_line.map((entry) => entry.key).sort(), ['cmd+enter', 'ctrl+enter']);
        for (const entry of run_line) {
            assert.ok(entry.when.endsWith('&& (editorLangId == r || editorLangId == rmd)'), entry.when);
        }

        assert.strictEqual(await vscode.commands.executeCommand<number | undefined>(COMMAND), 0);
    });
});
