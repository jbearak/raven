import * as assert from 'assert';
import * as vscode from 'vscode';
import { migrateDotInWordSetting } from '../extension';

declare const suite: Mocha.SuiteFunction;
declare const test: Mocha.TestFunction;
declare const setup: Mocha.HookFunction;
declare const teardown: Mocha.HookFunction;

async function resetDotInWordSettings() {
    const config = vscode.workspace.getConfiguration('raven');
    await config.update('editor.dotInWord', undefined, vscode.ConfigurationTarget.Global);
    await config.update('editor.dotInWordSeparators', undefined, vscode.ConfigurationTarget.Global);
}

// Integration coverage for the rename `dotInWordSeparators` -> `dotInWord`.
// Exercises the migration against the real VS Code configuration store (the
// per-scope decision logic itself is unit-tested via `planDotInWordMigration`
// in extensionHelpers.test.ts).
suite('Raven dotInWord migration', () => {
    setup(resetDotInWordSettings);
    teardown(resetDotInWordSettings);

    test('migrates an explicitly-set old key to the new key and clears the old', async () => {
        const config = vscode.workspace.getConfiguration('raven');
        await config.update('editor.dotInWordSeparators', 'no', vscode.ConfigurationTarget.Global);

        await migrateDotInWordSetting();

        const after = vscode.workspace.getConfiguration('raven');
        assert.strictEqual(after.inspect<string>('editor.dotInWord')?.globalValue, 'no');
        assert.strictEqual(
            after.inspect<string>('editor.dotInWordSeparators')?.globalValue,
            undefined,
            'old key must be cleared after migration',
        );
    });

    test('is idempotent on a second run', async () => {
        const config = vscode.workspace.getConfiguration('raven');
        await config.update('editor.dotInWordSeparators', 'no', vscode.ConfigurationTarget.Global);

        await migrateDotInWordSetting();
        await migrateDotInWordSetting();

        const after = vscode.workspace.getConfiguration('raven');
        assert.strictEqual(after.inspect<string>('editor.dotInWord')?.globalValue, 'no');
        assert.strictEqual(
            after.inspect<string>('editor.dotInWordSeparators')?.globalValue,
            undefined,
        );
    });

    test('keeps the new key and only clears the old when both are set', async () => {
        const config = vscode.workspace.getConfiguration('raven');
        await config.update('editor.dotInWord', 'yes', vscode.ConfigurationTarget.Global);
        await config.update('editor.dotInWordSeparators', 'no', vscode.ConfigurationTarget.Global);

        await migrateDotInWordSetting();

        const after = vscode.workspace.getConfiguration('raven');
        assert.strictEqual(after.inspect<string>('editor.dotInWord')?.globalValue, 'yes');
        assert.strictEqual(
            after.inspect<string>('editor.dotInWordSeparators')?.globalValue,
            undefined,
        );
    });
});
