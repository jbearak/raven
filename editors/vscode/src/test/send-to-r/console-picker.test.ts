import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ConsolePick, PickerOptions } from '../../send-to-r/console-picker';
import { _set_picker_for_test } from '../../send-to-r/console-picker';
import {
    _add_pending_profile_for_test,
    _dispose_cached_r_terminal_for_test,
    _handle_terminal_opened_for_test,
    _on_program_setting_changed,
    _reset_console_choice_for_test,
    _session_choice_for_test,
    choose_r_console,
    current_target,
    get_or_create_raven_console,
    resolve_send_target,
    terminal_program_of,
} from '../../send-to-r/r-terminal-manager';
import { deliver_to_target, send_to_r_console } from '../../send-to-r/console-send';
import { TERMINAL_ID_ENV } from '../../send-to-r/pending-profiles';
import type { RavenExtensionApi } from '../../extension';

/**
 * Which console sends go to (`raven.rTerminal.program`, the console picker,
 * and the session choice).
 *
 * These tests drive the copy of the send-to-R modules the test runner
 * compiles to `out/`, not the bundled extension's own copy: its session
 * state starts empty, it has no config listener (tests call
 * `_on_program_setting_changed` as the listener would), and it creates
 * terminals through a stubbed `createTerminal`. The last suite drives the
 * bundled commands through the extension API's picker hook.
 */

type FakeTerminal = vscode.Terminal & { sent: string[] };

function fake_terminal(name: string, env?: Record<string, string>): FakeTerminal {
    const sent: string[] = [];
    return {
        name,
        sent,
        sendText: (text: string) => { sent.push(text); },
        show: () => undefined,
        dispose: () => undefined,
        processId: Promise.resolve(undefined),
        creationOptions: { name, env },
        exitStatus: undefined,
        state: { isInteractedWith: false },
    } as unknown as FakeTerminal;
}

const config = () => vscode.workspace.getConfiguration('raven.rTerminal');

async function set_program(value: string | undefined): Promise<void> {
    await config().update('program', value, vscode.ConfigurationTarget.Global);
}

suite('R console choice', () => {
    let original_program: string | undefined;
    const original_create_terminal = vscode.window.createTerminal;
    let created: FakeTerminal[] = [];
    let picker_calls: PickerOptions[] = [];

    function use_picker(answer: () => Promise<ConsolePick | undefined>): void {
        _set_picker_for_test(async (options) => {
            picker_calls.push(options);
            return answer();
        });
    }

    suiteSetup(() => {
        original_program = config().inspect<string>('program')?.globalValue;
    });

    setup(async () => {
        created = [];
        picker_calls = [];
        _reset_console_choice_for_test();
        _dispose_cached_r_terminal_for_test();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).createTerminal = (options: vscode.TerminalOptions) => {
            const terminal = fake_terminal(options.name ?? '');
            created.push(terminal);
            return terminal;
        };
        use_picker(async () => {
            throw new Error('picker opened unexpectedly');
        });
        await set_program('ask');
    });

    teardown(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).createTerminal = original_create_terminal;
        _set_picker_for_test(null);
        _reset_console_choice_for_test();
        _dispose_cached_r_terminal_for_test();
    });

    suiteTeardown(async () => {
        await set_program(original_program);
    });

    test('an explicit setting sends without asking', async () => {
        await set_program('R');
        const target = await resolve_send_target();
        assert.strictEqual(target?.kind, 'terminal');
        assert.deepStrictEqual(created.map(t => t.name), ['R (plain)']);
        assert.strictEqual(picker_calls.length, 0);
    });

    test('ask with no terminal opens the picker; cancel sends nothing', async () => {
        use_picker(async () => undefined);
        assert.strictEqual(await send_to_r_console('x <- 1'), false);
        assert.strictEqual(picker_calls.length, 1);
        assert.strictEqual(picker_calls[0].include_vscode_r, true);
        assert.strictEqual(created.length, 0);
        assert.strictEqual(_session_choice_for_test(), null);
    });

    test("a pick for this session launches that console, named R for Raven's", async () => {
        use_picker(async () => ({ target: 'raven', scope: 'session' }));
        assert.strictEqual(await send_to_r_console('x <- 1'), true);
        assert.deepStrictEqual(created.map(t => t.name), ['R']);
        assert.strictEqual(_session_choice_for_test(), 'raven');
        assert.strictEqual(config().inspect<string>('program')?.globalValue, 'ask');
        // The next send reuses the choice without asking.
        assert.strictEqual(await send_to_r_console('y <- 2'), true);
        assert.strictEqual(picker_calls.length, 1);
        assert.strictEqual(created.length, 1);
    });

    test('the session choice beats an explicit setting', async () => {
        await set_program('R');
        use_picker(async () => ({ target: 'raven', scope: 'session' }));
        await choose_r_console();
        assert.strictEqual(current_target(), 'raven');
        const target = await resolve_send_target();
        assert.ok(target?.kind === 'terminal');
        assert.strictEqual(terminal_program_of(target.terminal), 'raven');
    });

    test('a choice never routes to a terminal running another program', async () => {
        await set_program('R');
        const plain = await resolve_send_target();
        assert.ok(plain?.kind === 'terminal');
        use_picker(async () => ({ target: 'raven', scope: 'session' }));
        await choose_r_console();
        const raven = await resolve_send_target();
        assert.ok(raven?.kind === 'terminal');
        assert.notStrictEqual(raven.terminal, plain.terminal);
        assert.strictEqual(terminal_program_of(raven.terminal), 'raven');
    });

    test('ask with a live managed terminal sends there without asking', async () => {
        await set_program('R');
        const first = await resolve_send_target();
        assert.ok(first?.kind === 'terminal');
        await set_program('ask');
        _on_program_setting_changed();
        const again = await resolve_send_target();
        assert.ok(again?.kind === 'terminal');
        assert.strictEqual(again.terminal, first.terminal);
        assert.strictEqual(picker_calls.length, 0);
    });

    test('"All sessions" writes the user setting and survives the change event', async () => {
        use_picker(async () => ({ target: 'R', scope: 'all' }));
        await choose_r_console();
        assert.strictEqual(config().inspect<string>('program')?.globalValue, 'R');
        // The change event can arrive after update() resolved.
        _on_program_setting_changed();
        assert.strictEqual(_session_choice_for_test(), 'R');
    });

    test('an outside change to another value clears the session choice', async () => {
        use_picker(async () => ({ target: 'raven', scope: 'session' }));
        await choose_r_console();
        await set_program('R');
        _on_program_setting_changed();
        assert.strictEqual(_session_choice_for_test(), null);
        assert.strictEqual(current_target(), 'R');
    });

    test('concurrent first sends open one picker and deliver in order', async () => {
        let answer!: (pick: ConsolePick) => void;
        use_picker(() => new Promise((resolve) => { answer = resolve; }));
        const first = send_to_r_console('a <- 1');
        const second = send_to_r_console('b <- 2');
        // Let both sends reach the picker before answering.
        await new Promise((resolve) => setTimeout(resolve, 50));
        answer({ target: 'R', scope: 'session' });
        assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
        assert.strictEqual(picker_calls.length, 1);
        assert.strictEqual(created.length, 1);
        assert.deepStrictEqual(created[0].sent, ['a <- 1', 'b <- 2']);
    });

    test('Choose R Console joins a picker that is already open', async () => {
        let answer!: (pick: ConsolePick) => void;
        use_picker(() => new Promise((resolve) => { answer = resolve; }));
        const send = send_to_r_console('a <- 1');
        await new Promise((resolve) => setTimeout(resolve, 50));
        const chosen = choose_r_console();
        answer({ target: 'R', scope: 'session' });
        assert.deepStrictEqual(await chosen, { target: 'R', scope: 'session' });
        assert.strictEqual(await send, true);
        assert.strictEqual(picker_calls.length, 1);
    });

    test('the debugger gets a Raven console whatever the choice', async () => {
        await set_program('R');
        await resolve_send_target();
        const console_terminal = await get_or_create_raven_console();
        assert.strictEqual(terminal_program_of(console_terminal), 'raven');
        assert.deepStrictEqual(created.map(t => t.name), ['R (plain)', 'R']);
        assert.strictEqual(current_target(), 'R', 'the debugger does not change the choice');
    });

    test('vscode-R sends through r.runCommand', async () => {
        const received: unknown[] = [];
        const command = vscode.commands.registerCommand('r.runCommand', (code: unknown) => {
            received.push(code);
        });
        const original_get_extension = vscode.extensions.getExtension;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.extensions as any).getExtension = (id: string) =>
            id === 'REditorSupport.r'
                ? { activate: async () => undefined }
                : original_get_extension(id);
        try {
            use_picker(async () => ({ target: 'vscode-R', scope: 'session' }));
            assert.strictEqual(await send_to_r_console('f <- function(x) {\n  x\n}'), true);
            assert.deepStrictEqual(received, ['f <- function(x) {\n  x\n}']);
            assert.strictEqual(created.length, 0);
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.extensions as any).getExtension = original_get_extension;
            command.dispose();
        }
    });

    test('vscode-R missing: the send reports failure', async () => {
        const original_show_error = vscode.window.showErrorMessage;
        const errors: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showErrorMessage = (message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        };
        try {
            assert.strictEqual(await deliver_to_target({ kind: 'vscode-r' }, 'x'), false);
            assert.strictEqual(errors.length, 1);
            assert.match(errors[0], /vscode-R/);
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showErrorMessage = original_show_error;
        }
    });

    test('profile terminals are matched by id, never by name', () => {
        _add_pending_profile_for_test('id-raven', { program: 'raven', generatedAtMs: Date.now() });
        _add_pending_profile_for_test('id-plain', { program: 'R', generatedAtMs: Date.now() });

        const unrelated = fake_terminal('R');
        _handle_terminal_opened_for_test(unrelated);
        assert.strictEqual(terminal_program_of(unrelated), undefined);

        // Overlapping launches opening in reverse order.
        const plain = fake_terminal('R (plain)', { [TERMINAL_ID_ENV]: 'id-plain' });
        const raven = fake_terminal('R', { [TERMINAL_ID_ENV]: 'id-raven' });
        _handle_terminal_opened_for_test(plain);
        _handle_terminal_opened_for_test(raven);
        assert.strictEqual(terminal_program_of(plain), 'R');
        assert.strictEqual(terminal_program_of(raven), 'raven');
    });
});

suite('R console choice: bundled commands', () => {
    let api: RavenExtensionApi;
    let original_program: string | undefined;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension<RavenExtensionApi>('jbearak.raven-r');
        assert.ok(ext);
        api = ext.isActive ? ext.exports : await ext.activate();
        original_program = config().inspect<string>('program')?.globalValue;
    });

    suiteTeardown(async () => {
        api._setConsolePickerForTest(null);
        await set_program(original_program);
    });

    test('a terminal opened from the R profile exposes its id in creationOptions.env', async function () {
        // Profile association relies on this (see pending-profiles.ts).
        const all = new Set(await vscode.commands.getCommands(true));
        if (!all.has('raven.runLineOrSelection')) this.skip();
        await set_program('raven');
        const opened = new Promise<vscode.Terminal>((resolve) => {
            const listener = vscode.window.onDidOpenTerminal((terminal) => {
                listener.dispose();
                resolve(terminal);
            });
        });
        await vscode.commands.executeCommand('workbench.action.terminal.newWithProfile', {
            config: { extensionIdentifier: 'jbearak.raven-r', id: 'raven.rTerminal', title: 'R' },
        });
        const terminal = await Promise.race([
            opened,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20_000)),
        ]);
        assert.ok(terminal, 'the R profile opened a terminal');
        try {
            assert.strictEqual(terminal.name, 'R');
            const env = (terminal.creationOptions as vscode.TerminalOptions).env;
            assert.strictEqual(typeof env?.[TERMINAL_ID_ENV], 'string');
        } finally {
            terminal.dispose();
        }
    });

    test('cancelling the picker sends nothing and leaves the cursor', async function () {
        const all = new Set(await vscode.commands.getCommands(true));
        if (!all.has('raven.runLineOrSelection')) this.skip();

        await set_program('ask');
        api._disposeCachedRTerminalForTest();
        let calls = 0;
        api._setConsolePickerForTest(async () => {
            calls++;
            return undefined;
        });
        const terminals_before = vscode.window.terminals.length;

        const r_doc = await vscode.workspace.openTextDocument({
            language: 'r',
            content: 'x <- 1\ny <- 2\n',
        });
        const r_editor = await vscode.window.showTextDocument(r_doc);
        r_editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('raven.runLineOrSelection');
        assert.strictEqual(calls, 1);
        assert.strictEqual(r_editor.selection.active.line, 0, 'Run Line did not advance');

        const rmd_doc = await vscode.workspace.openTextDocument({
            language: 'rmd',
            content: '```{r}\nx <- 1\n```\n\n```{r}\ny <- 2\n```\n',
        });
        const rmd_editor = await vscode.window.showTextDocument(rmd_doc);
        // Lines 1 and 5 are inside the first and second chunks.
        for (const [command, line] of [
            ['raven.runCurrentChunkAndMove', 1],
            ['raven.runNextChunkAndMove', 1],
            ['raven.runPreviousChunkAndMove', 5],
        ] as const) {
            rmd_editor.selection = new vscode.Selection(line, 0, line, 0);
            await vscode.commands.executeCommand(command);
            assert.strictEqual(rmd_editor.selection.active.line, line, `${command} did not move`);
        }
        assert.strictEqual(calls, 4);
        assert.strictEqual(vscode.window.terminals.length, terminals_before, 'no terminal opened');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
});
