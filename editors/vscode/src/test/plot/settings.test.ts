import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Raven plot settings', () => {
    test('raven.plot.viewerColumn defaults to "beside"', () => {
        const cfg = vscode.workspace.getConfiguration('raven.plot');
        assert.strictEqual(cfg.get<string>('viewerColumn'), 'beside');
    });

    test('raven.plot.viewerColumn enum accepts "active"', async () => {
        await vscode.workspace
            .getConfiguration('raven.plot')
            .update('viewerColumn', 'active', vscode.ConfigurationTarget.Global);
        try {
            assert.strictEqual(
                vscode.workspace.getConfiguration('raven.plot').get<string>('viewerColumn'),
                'active',
            );
        } finally {
            await vscode.workspace
                .getConfiguration('raven.plot')
                .update('viewerColumn', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
