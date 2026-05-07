import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    resolve_program,
    _reset_fallback_warned_for_test,
} from '../../send-to-r/r-terminal-manager';

suite('rTerminal.program fallback', () => {
    const original_show_warning = vscode.window.showWarningMessage;
    let warnings: string[] = [];

    setup(() => {
        warnings = [];
        // Replace the warning popup with a recorder. Cast the recorder
        // through `any` because showWarningMessage has many overloads that
        // are awkward to satisfy structurally.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = (msg: string) => {
            warnings.push(msg);
            return Promise.resolve(undefined);
        };
        _reset_fallback_warned_for_test();
    });

    teardown(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = original_show_warning;
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', undefined, vscode.ConfigurationTarget.Global);
        _reset_fallback_warned_for_test();
    });

    test('returns R unchanged without checking PATH', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'R', vscode.ConfigurationTarget.Global);
        assert.strictEqual(resolve_program(), 'R');
        assert.deepStrictEqual(warnings, []);
    });

    test('returns configured program when present on PATH', async () => {
        // `node` is guaranteed to be on PATH since the test harness runs under Node.
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'node', vscode.ConfigurationTarget.Global);
        assert.strictEqual(resolve_program(), 'node');
        assert.deepStrictEqual(warnings, []);
    });

    test('falls back to R and warns when program is missing', async () => {
        const missing = 'raven-test-definitely-not-a-real-binary-xyz';
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', missing, vscode.ConfigurationTarget.Global);
        assert.strictEqual(resolve_program(), 'R');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], new RegExp(`'${missing}' is not on PATH`));
        assert.match(warnings[0], /standard R console/);
    });

    test('warns only once per session for the same missing program', async () => {
        const missing = 'raven-test-definitely-not-a-real-binary-xyz';
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', missing, vscode.ConfigurationTarget.Global);
        resolve_program();
        resolve_program();
        resolve_program();
        assert.strictEqual(warnings.length, 1);
    });
});
