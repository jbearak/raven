import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    resolve_program,
    _clear_validation_state_for_test,
    _set_validator_for_test,
} from '../../send-to-r/r-terminal-manager';

suite('rTerminal.program shell-validated fallback', () => {
    const original_show_warning = vscode.window.showWarningMessage;
    let warnings: { message: string; items: string[] }[] = [];
    let warning_response: string | undefined = undefined;
    let validator_calls: string[] = [];

    setup(async () => {
        warnings = [];
        warning_response = undefined;
        validator_calls = [];
        // Replace the warning popup with a recorder; the test sets
        // `warning_response` to control which button the prompt "clicks".
        // Cast through `any`: showWarningMessage has many overloads that
        // are awkward to satisfy structurally.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = (msg: string, ...items: string[]) => {
            warnings.push({ message: msg, items });
            return Promise.resolve(warning_response);
        };
        await _clear_validation_state_for_test();
    });

    teardown(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = original_show_warning;
        _set_validator_for_test(null);
        await _clear_validation_state_for_test();
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', undefined, vscode.ConfigurationTarget.Global);
    });

    test('R configured: returns R, no validation, no prompt', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'R', vscode.ConfigurationTarget.Global);
        _set_validator_for_test(async (name) => {
            validator_calls.push(name);
            return false;
        });
        assert.strictEqual(await resolve_program(), 'R');
        assert.deepStrictEqual(validator_calls, []);
        assert.deepStrictEqual(warnings, []);
    });

    test('shell finds program: returns it, persists, never re-validates', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'radian', vscode.ConfigurationTarget.Global);
        _set_validator_for_test(async (name) => {
            validator_calls.push(name);
            return true;
        });
        assert.strictEqual(await resolve_program(), 'radian');
        assert.strictEqual(await resolve_program(), 'radian');
        assert.deepStrictEqual(validator_calls, ['radian'], 'second call hits persisted state');
        assert.deepStrictEqual(warnings, []);
    });

    test('shell does not find program, user picks Switch to R: updates setting and returns R', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'arf', vscode.ConfigurationTarget.Global);
        _set_validator_for_test(async () => false);
        warning_response = 'Switch to R';

        assert.strictEqual(await resolve_program(), 'R');
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0].message, /'arf' was not found/);
        assert.ok(warnings[0].items.includes('Switch to R'));
        assert.ok(warnings[0].items.includes('Keep'));

        const after = vscode.workspace.getConfiguration('raven.rTerminal').get<string>('program');
        assert.strictEqual(after, 'R');
    });

    test('user picks Keep: subsequent launches re-validate but do not re-prompt', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'arf', vscode.ConfigurationTarget.Global);
        let validator_count = 0;
        _set_validator_for_test(async () => { validator_count++; return false; });
        warning_response = 'Keep';

        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(validator_count, 3, 'validator runs every call until success persists');
        assert.strictEqual(warnings.length, 1, 'prompt only once per session after Keep');
    });

    test('mid-session install: validator flips to true, success persists, prompt does not recur', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'arf', vscode.ConfigurationTarget.Global);
        let installed = false;
        let validator_count = 0;
        _set_validator_for_test(async () => { validator_count++; return installed; });
        warning_response = 'Keep';

        // Initial launch: not installed yet, user picks Keep.
        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(warnings.length, 1);

        // User installs `arf` in another window during the session.
        installed = true;

        // Next launch re-validates, succeeds, persists. No prompt.
        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(warnings.length, 1, 'no second prompt');

        // Subsequent launches short-circuit on persisted success.
        const before = validator_count;
        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(validator_count, before, 'persisted success skips validator');
    });

    test('user dismisses prompt: behaves like Keep (suppressed this session)', async () => {
        await vscode.workspace
            .getConfiguration('raven.rTerminal')
            .update('program', 'arf', vscode.ConfigurationTarget.Global);
        _set_validator_for_test(async () => false);
        warning_response = undefined; // simulates closing the toast without picking

        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(await resolve_program(), 'arf');
        assert.strictEqual(warnings.length, 1, 'no reprompt within session after dismiss');
    });
});
