import * as assert from 'assert';
import * as vscode from 'vscode';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;
declare const teardown: Mocha.HookFunction;

suite('Raven plot terminal integration', () => {
    teardown(async () => {
        await vscode.workspace
            .getConfiguration('raven.plot')
            .update('enabled', undefined, vscode.ConfigurationTarget.Global);
    });

    test('raven.rTerminal terminal profile is registered', async () => {
        const id = 'raven.rTerminal';
        const ext = vscode.extensions.getExtension('jbearak.raven-r');
        assert.ok(ext, 'raven-r extension is loaded');
        const contributes = ext!.packageJSON.contributes;
        const profiles = contributes?.terminal?.profiles ?? [];
        const found = profiles.some((p: { id?: string }) => p.id === id);
        assert.ok(found, 'raven.rTerminal terminal profile is contributed');
    });

    test('disabling raven.plot.enabled does not throw', async () => {
        await vscode.workspace
            .getConfiguration('raven.plot')
            .update('enabled', false, vscode.ConfigurationTarget.Global);
        const cfg = vscode.workspace.getConfiguration('raven.plot');
        assert.strictEqual(cfg.get<boolean>('enabled'), false);
    });
});
