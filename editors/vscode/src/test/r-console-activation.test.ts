import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    isPositron,
    readRConsoleActivation,
    resolveRConsoleActivation,
} from '../r-console-activation';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;
declare const teardown: Mocha.HookFunction;

suite('Raven R-console activation', () => {
    teardown(async () => {
        await vscode.workspace
            .getConfiguration('raven.rConsole')
            .update('activation', undefined, vscode.ConfigurationTarget.Global);
    });

    test('readRConsoleActivation defaults to "auto"', () => {
        assert.strictEqual(readRConsoleActivation(), 'auto');
    });

    test('readRConsoleActivation reflects an explicit "enabled"', async () => {
        await vscode.workspace
            .getConfiguration('raven.rConsole')
            .update('activation', 'enabled', vscode.ConfigurationTarget.Global);
        assert.strictEqual(readRConsoleActivation(), 'enabled');
    });

    test('readRConsoleActivation reflects an explicit "disabled"', async () => {
        await vscode.workspace
            .getConfiguration('raven.rConsole')
            .update('activation', 'disabled', vscode.ConfigurationTarget.Global);
        assert.strictEqual(readRConsoleActivation(), 'disabled');
    });

    test('explicit "enabled" resolves to "enabled" regardless of REditorSupport / Positron', () => {
        assert.strictEqual(resolveRConsoleActivation('enabled'), 'enabled');
    });

    test('explicit "disabled" resolves to "disabled" regardless of REditorSupport / Positron', () => {
        assert.strictEqual(resolveRConsoleActivation('disabled'), 'disabled');
    });

    test('"auto" resolves based on REditorSupport / Positron presence', () => {
        // We can't fully control the test environment, but we can assert the
        // resolution is consistent with the detection helpers.
        const resolved = resolveRConsoleActivation('auto');
        const reditor = vscode.extensions.getExtension('REditorSupport.r') !== undefined;
        const positron = isPositron();
        const expected: 'enabled' | 'disabled' =
            reditor || positron ? 'disabled' : 'enabled';
        assert.strictEqual(resolved, expected);
    });

    test('isPositron is case-insensitive on the appName substring', () => {
        assert.strictEqual(isPositron('Positron'), true);
        assert.strictEqual(isPositron('POSITRON'), true);
        assert.strictEqual(isPositron('positron'), true);
        assert.strictEqual(isPositron('Visual Studio Code'), false);
        assert.strictEqual(isPositron('Cursor'), false);
        assert.strictEqual(isPositron('Code - OSS'), false);
    });
});
