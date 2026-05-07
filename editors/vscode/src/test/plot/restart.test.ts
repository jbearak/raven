import * as assert from 'assert';
import * as vscode from 'vscode';

suite('raven.restart command', () => {
    test('runs without throwing when plot services exist', async () => {
        // We only verify the command resolves; deeper state assertions
        // would require access to internal services.
        await vscode.commands.executeCommand('raven.restart');
        assert.ok(true);
    });
});
