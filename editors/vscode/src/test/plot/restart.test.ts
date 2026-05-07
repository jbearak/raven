import * as assert from 'assert';
import * as vscode from 'vscode';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;

suite('raven.restart command', () => {
    test('runs without throwing when plot services exist', async () => {
        // We only verify the command resolves; deeper state assertions
        // would require access to internal services.
        await vscode.commands.executeCommand('raven.restart');
        assert.ok(true);
    });
});
