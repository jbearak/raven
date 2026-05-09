import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Raven plot terminal integration', () => {
    test('raven.rTerminal terminal profile is registered', async () => {
        const id = 'raven.rTerminal';
        const ext = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ext, 'raven-r extension is loaded');
        const contributes = ext!.packageJSON.contributes;
        const profiles = contributes?.terminal?.profiles ?? [];
        const found = profiles.some((p: { id?: string }) => p.id === id);
        assert.ok(found, 'raven.rTerminal terminal profile is contributed');
    });
});
