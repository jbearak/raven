import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Raven plot settings', () => {
    test('raven.plot.enabled defaults to true', () => {
        const cfg = vscode.workspace.getConfiguration('raven.plot');
        assert.strictEqual(cfg.get<boolean>('enabled'), true);
    });

    test('raven.plot.viewerColumn defaults to "beside"', () => {
        const cfg = vscode.workspace.getConfiguration('raven.plot');
        assert.strictEqual(cfg.get<string>('viewerColumn'), 'beside');
    });

    test('raven.plot.viewerColumn enum accepts "active"', async () => {
        const cfg = vscode.workspace.getConfiguration('raven.plot');
        await cfg.update('viewerColumn', 'active', vscode.ConfigurationTarget.Global);
        try {
            assert.strictEqual(cfg.get<string>('viewerColumn'), 'active');
        } finally {
            await cfg.update('viewerColumn', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
