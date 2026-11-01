import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { console_socket_of } from '../../send-to-r/console-ipc';
import type { CreateOptions, PerchApiV1, PerchExports, SessionInfo } from '../../send-to-r/perch-api';
import {
    _reset_perch_for_test,
    find_perch,
    PerchDeps,
    perch_host,
    perch_session_of,
    type_into,
} from '../../send-to-r/perch';
import { _set_picker_for_test } from '../../send-to-r/console-picker';
import {
    _add_pending_profile_for_test,
    _connect_perch_for_r_terminals_for_test,
    _dispose_cached_r_terminal_for_test,
    _handle_terminal_closed_for_test,
    _handle_terminal_opened_for_test,
    _provide_r_terminal_profile_for_test,
    _reset_console_choice_for_test,
    _set_reattach_picker_for_test,
    _set_server_path_for_test,
    _set_validator_for_test,
    get_or_create_terminal_for,
    new_console_in_perch,
    resolve_send_target,
    terminal_program_of,
} from '../../send-to-r/r-terminal-manager';
import { send_code } from '../../send-to-r/send-code';

const RAVEN = 'jbearak.raven-r';
const OPTIONS = { sendMethod: 'paste' as const, autoTempFileThresholdLines: 25 };

function perch_error(code: string): Error {
    return Object.assign(new Error(code), { name: 'PerchApiError', code });
}

/** A terminal stand-in that records what `sendText` typed. */
function fake_terminal(env: Record<string, string> = {}): { terminal: vscode.Terminal; typed: string[] } {
    const typed: string[] = [];
    const terminal = {
        name: 'R',
        creationOptions: { env },
        sendText: (text: string) => typed.push(text),
        show: () => undefined,
        dispose: () => undefined,
    } as unknown as vscode.Terminal;
    return { terminal, typed };
}

/** Perch's API v1, in memory. Sessions live in temp directories. */
class FakePerch implements PerchApiV1 {
    readonly version = 1 as const;
    is_available = true;
    launches: CreateOptions[] = [];
    sends: { id: string; text: string; options?: { paste?: boolean; submit?: boolean } }[] = [];
    send_result: () => Promise<'queued'> = async () => 'queued';
    listed: SessionInfo[] = [];
    open: { session: SessionInfo; terminal: vscode.Terminal }[] = [];
    attach_result: (id: string) => Promise<vscode.Terminal> = async () => fake_terminal().terminal;
    private readonly attach_events = new vscode.EventEmitter<{ session: SessionInfo; terminal: vscode.Terminal }>();
    private readonly end_events = new vscode.EventEmitter<SessionInfo>();
    readonly onDidAttach = this.attach_events.event;
    readonly onDidEndSession = this.end_events.event;
    readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-fake-'));
    private next = 0;

    session(overrides: Partial<SessionInfo> = {}): SessionInfo {
        const id = overrides.id ?? `sess${String(this.next++).padStart(4, '0')}`;
        const dir = path.join(this.root, id);
        fs.mkdirSync(dir, { recursive: true });
        return {
            id, name: 'R', kind: 'r', owner: RAVEN,
            annotations: { 'raven.program': 'raven', 'raven.console': 'ipc' },
            dir, degraded: [], cwd: '/work', host: 'h', createdAt: '2026-11-01T12:00:00Z',
            state: 'running', attached: true, attachedHere: true,
            ...overrides,
        };
    }

    async available(): Promise<boolean> { return this.is_available; }
    prepareLaunch(options: CreateOptions): { id: string; options: vscode.TerminalOptions } {
        this.launches.push(options);
        const id = `new${String(this.next++).padStart(5, '0')}`;
        return { id, options: { name: options.name, shellPath: '/bin/sh', shellArgs: ['-c', 'sleep 120'], isTransient: true } };
    }
    async waitForSession(id: string): Promise<SessionInfo> {
        const launch = this.launches[this.launches.length - 1];
        return this.session({ id, annotations: { ...launch.annotations } });
    }
    async listSessions(): Promise<SessionInfo[]> { return this.listed; }
    terminals(): ReadonlyArray<{ session: SessionInfo; terminal: vscode.Terminal }> { return this.open; }
    attach(id: string): Promise<vscode.Terminal> { return this.attach_result(id); }
    send(id: string, text: string, options?: { paste?: boolean; submit?: boolean }): Promise<'queued'> {
        this.sends.push({ id, text, options });
        return this.send_result();
    }
    fire_attach(session: SessionInfo, terminal: vscode.Terminal): void { this.attach_events.fire({ session, terminal }); }
    fire_end(session: SessionInfo): void { this.end_events.fire(session); }
}

type DepsOptions = { remote?: boolean; reachable?: boolean; activate?: () => Promise<PerchExports> };

/** A remote window where Perch reaches Raven, unless `opts` says otherwise. */
function deps_for(perch: FakePerch | undefined, opts: DepsOptions = {}): PerchDeps & { looked_up: number } {
    const deps = {
        looked_up: 0,
        host: () => ({ remote: opts.remote ?? true, reachable: opts.reachable ?? true }),
        get_extension: () => {
            deps.looked_up++;
            if (!perch && !opts.activate) return undefined;
            const exports: PerchExports = { getApi: (v: number, caller: string) => (v === 1 && caller === RAVEN ? perch : undefined) };
            return {
                isActive: false,
                exports: undefined,
                activate: opts.activate ?? (async () => exports),
            } as unknown as vscode.Extension<PerchExports | undefined>;
        },
    };
    return deps;
}

async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), what);
}

suite('R consoles in Perch sessions', () => {
    if (process.platform === 'win32') return;

    const created: vscode.Terminal[] = [];
    const original_create_terminal = vscode.window.createTerminal;
    const original_info = vscode.window.showInformationMessage;
    const original_warning = vscode.window.showWarningMessage;
    let infos: string[] = [];
    let warnings: string[] = [];

    setup(() => {
        _reset_perch_for_test();
        _dispose_cached_r_terminal_for_test();
        infos = [];
        warnings = [];
        _set_validator_for_test(async () => true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = async (m: string) => { infos.push(m); return undefined; };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = async (m: string) => { warnings.push(m); return undefined; };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).createTerminal = (...args: unknown[]) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const t = (original_create_terminal as any)(...args) as vscode.Terminal;
            created.push(t);
            return t;
        };
    });

    teardown(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = original_info;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showWarningMessage = original_warning;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).createTerminal = original_create_terminal;
        for (const t of created.splice(0)) t.dispose();
        _set_reattach_picker_for_test(null);
        _reset_console_choice_for_test();
        _set_server_path_for_test(null);
        _set_validator_for_test(null);
        _reset_perch_for_test();
        _dispose_cached_r_terminal_for_test();
    });

    suite('when Raven uses Perch', () => {
        test('Perch reaches Raven in a local window, and in a remote one only from the workspace host', () => {
            const { UI, Workspace } = vscode.ExtensionKind;
            assert.deepStrictEqual(perch_host(undefined, UI, {}), { remote: false, reachable: true }, 'local window');
            assert.deepStrictEqual(perch_host('ssh-remote', Workspace, {}), { remote: true, reachable: true });
            assert.deepStrictEqual(perch_host('wsl', Workspace, {}), { remote: true, reachable: true });
            assert.deepStrictEqual(perch_host('ssh-remote', UI, {}), { remote: true, reachable: false }, 'Raven forced to UI');
            assert.deepStrictEqual(
                perch_host(undefined, UI, { RAVEN_TEST_PERCH_TREAT_AS_REMOTE: '1' }),
                { remote: true, reachable: true },
                'the end-to-end test override',
            );
        });

        test('local window: Perch is usable', async () => {
            const perch = new FakePerch();
            assert.strictEqual(await find_perch(deps_for(perch, { remote: false })), perch);
        });

        test('remote window, Raven forced to UI: Perch is not even looked up', async () => {
            const deps = deps_for(new FakePerch(), { reachable: false });
            assert.strictEqual(await find_perch(deps), undefined);
            assert.strictEqual(deps.looked_up, 0);
        });

        test('remote window without Perch: none', async () => {
            assert.strictEqual(await find_perch(deps_for(undefined)), undefined);
        });

        test('Perch unavailable on this host: none', async () => {
            const perch = new FakePerch();
            perch.is_available = false;
            assert.strictEqual(await find_perch(deps_for(perch)), undefined);
        });

        test('Perch whose activation rejects: none, and nothing unhandled', async () => {
            const unhandled: unknown[] = [];
            const on_unhandled = (e: unknown) => unhandled.push(e);
            process.on('unhandledRejection', on_unhandled);
            try {
                const deps = deps_for(undefined, { activate: () => Promise.reject(new Error('boom')) });
                assert.strictEqual(await find_perch(deps), undefined);
                await new Promise((r) => setTimeout(r, 20));
                assert.deepStrictEqual(unhandled, []);
            } finally {
                process.off('unhandledRejection', on_unhandled);
            }
        });

        test('no Perch: a new console is an ordinary terminal', async () => {
            await _connect_perch_for_r_terminals_for_test(deps_for(undefined));
            const terminal = await get_or_create_terminal_for('R');
            assert.strictEqual(perch_session_of(terminal), undefined);
            assert.strictEqual(terminal.creationOptions.name, 'R (plain)');
            assert.strictEqual((terminal.creationOptions as vscode.TerminalOptions).shellPath, 'R');
        });

        test('remote window with Perch: the console starts in a session', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            _set_server_path_for_test(() => '/opt/raven{1}/bin/raven');
            const terminal = await get_or_create_terminal_for('raven');

            assert.strictEqual(perch.launches.length, 1);
            const launch = perch.launches[0];
            assert.strictEqual(launch.kind, 'r');
            assert.strictEqual(launch.name, 'R');
            assert.strictEqual(launch.cwd, undefined, "the terminal's own working directory, as today");
            assert.deepStrictEqual(launch.annotations, { 'raven.program': 'raven', 'raven.console': 'ipc' });
            // The binary path is escaped; the sockets are Perch's {dir}.
            assert.strictEqual(launch.command[0], '/opt/raven{{1}}/bin/raven');
            const ipc = launch.command.indexOf('--ipc');
            assert.strictEqual(launch.command[ipc + 1], '{dir}/ipc');
            const dap = launch.command.indexOf('--dap');
            assert.strictEqual(launch.command[dap + 1], '{dir}/d');
            assert.deepStrictEqual(launch.command.slice(-2), ['--no-save', '--no-restore']);

            const id = perch_session_of(terminal);
            assert.ok(id);
            assert.strictEqual(terminal_program_of(terminal), 'raven');
            assert.strictEqual(console_socket_of(terminal), path.join(perch.root, id, 'ipc'));
            assert.deepStrictEqual(infos, [], 'a console started here has its plots');
        });

        test('a console asked for while Perch is still being looked up waits for it', async () => {
            const perch = new FakePerch();
            let answer: (yes: boolean) => void = () => undefined;
            perch.available = () => new Promise<boolean>((resolve) => { answer = resolve; });
            const connecting = _connect_perch_for_r_terminals_for_test(deps_for(perch));
            const creating = get_or_create_terminal_for('R');
            await new Promise((r) => setTimeout(r, 20));
            answer(true);
            await connecting;
            const terminal = await creating;
            assert.ok(perch_session_of(terminal), 'started in Perch, not an ordinary terminal');
            assert.strictEqual(perch.launches.length, 1);
        });

        test('another program runs in a session too, without a console socket', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            const terminal = await get_or_create_terminal_for('radian');
            assert.deepStrictEqual(perch.launches[0].command, ['radian', '--no-save', '--no-restore']);
            assert.deepStrictEqual(perch.launches[0].annotations, { 'raven.program': 'radian' });
            assert.strictEqual(terminal_program_of(terminal), 'radian');
            assert.strictEqual(console_socket_of(terminal), undefined);
        });

        test('a profile terminal from prepareLaunch is managed once its session runs', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            _add_pending_profile_for_test('prof0001', { program: 'raven', generatedAtMs: Date.now(), perch });
            perch.launches.push({ name: 'R', kind: 'r', command: ['raven'], annotations: { 'raven.program': 'raven', 'raven.console': 'ipc' } });
            const { terminal } = fake_terminal({ RAVEN_TERMINAL_ID: 'prof0001' });
            _handle_terminal_opened_for_test(terminal);
            await until(() => perch_session_of(terminal) === 'prof0001', 'adopted');
            assert.strictEqual(console_socket_of(terminal), path.join(perch.root, 'prof0001', 'ipc'));
            assert.strictEqual(await get_or_create_terminal_for('raven'), terminal);
        });
    });

    suite('adoption', () => {
        test("after a reload, this window's Perch terminal is the send target; other workspaces' sessions are not", async () => {
            const perch = new FakePerch();
            const mine = perch.session();
            const other_workspace = perch.session({ cwd: '/elsewhere', attachedHere: false });
            perch.listed = [mine, other_workspace];
            const { terminal } = fake_terminal();
            perch.open = [{ session: mine, terminal }];
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));

            assert.strictEqual(await get_or_create_terminal_for('raven'), terminal);
            assert.strictEqual(console_socket_of(terminal), path.join(mine.dir, 'ipc'));
            assert.strictEqual(perch.launches.length, 0);
            assert.strictEqual(infos.length, 1, 'one notice that plots need a console restart');
            assert.match(infos[0], /plots and data viewer/);
        });

        test('a terminal Perch reopened is used even when asked for during the lookup', async () => {
            const perch = new FakePerch();
            const restored = perch.session();
            const { terminal } = fake_terminal();
            perch.open = [{ session: restored, terminal }];
            perch.listed = [restored];
            let answer: (yes: boolean) => void = () => undefined;
            perch.available = () => new Promise<boolean>((resolve) => { answer = resolve; });
            const connecting = _connect_perch_for_r_terminals_for_test(deps_for(perch));
            const getting = get_or_create_terminal_for('raven');
            await new Promise((r) => setTimeout(r, 20));
            answer(true);
            await connecting;
            assert.strictEqual(await getting, terminal);
            assert.strictEqual(perch.launches.length, 0, 'no second console');
        });

        test('an attach after connecting is adopted; sessions of other callers are not', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            const sight = fake_terminal().terminal;
            perch.fire_attach(perch.session({ owner: 'jbearak.sight' }), sight);
            assert.strictEqual(terminal_program_of(sight), undefined);
            const { terminal } = fake_terminal();
            const session = perch.session({ annotations: { 'raven.program': 'arf' } });
            perch.fire_attach(session, terminal);
            perch.fire_attach(session, terminal);
            assert.strictEqual(terminal_program_of(terminal), 'arf');
            assert.strictEqual(perch_session_of(terminal), session.id);
        });

        test('a session whose directory was recreated has no console socket', async () => {
            const perch = new FakePerch();
            const { terminal } = fake_terminal();
            perch.open = [{ session: perch.session({ degraded: ['directory-recreated'] }), terminal }];
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            assert.strictEqual(terminal_program_of(terminal), 'raven');
            assert.strictEqual(console_socket_of(terminal), undefined);
        });

        test('closing the terminal detaches: the session directory stays; the session end tears down', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            const terminal = await get_or_create_terminal_for('raven');
            const id = perch_session_of(terminal) as string;
            const dir = path.join(perch.root, id);

            _handle_terminal_closed_for_test(terminal);
            await new Promise((r) => setTimeout(r, 50));
            assert.ok(fs.existsSync(dir), 'Raven leaves the session directory to Perch');
            assert.strictEqual(terminal_program_of(terminal), undefined, 'no terminal here to send to');

            // Reattach in this window: the same session, no restart notice.
            const { terminal: again } = fake_terminal();
            perch.fire_attach(perch.session({ id }), again);
            assert.strictEqual(perch_session_of(again), id);
            assert.deepStrictEqual(infos, []);

            perch.fire_end(perch.session({ id, state: 'exited' }));
            assert.strictEqual(terminal_program_of(again), undefined);
            assert.strictEqual(console_socket_of(again), undefined);
            assert.strictEqual(perch_session_of(again), undefined);
        });
    });

    suite('local window', () => {
        const local = { remote: false };

        test("a terminal Perch restored is adopted and is the send target", async () => {
            const perch = new FakePerch();
            const restored = perch.session();
            const { terminal } = fake_terminal();
            perch.open = [{ session: restored, terminal }];
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, local));
            assert.strictEqual(perch_session_of(terminal), restored.id);
            assert.strictEqual(console_socket_of(terminal), path.join(restored.dir, 'ipc'));
            assert.strictEqual(await get_or_create_terminal_for('raven'), terminal);
            assert.strictEqual(perch.launches.length, 0);
        });

        test("Raven's own new consoles and its terminal profile stay ordinary, with no reattach offer", async () => {
            const perch = new FakePerch();
            perch.listed = [perch.session({ attached: false, attachedHere: false })];
            _set_reattach_picker_for_test(async () => assert.fail('no reattach offer in a local window'));
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, local));

            const terminal = await get_or_create_terminal_for('raven');
            assert.strictEqual(perch_session_of(terminal), undefined);
            const profile = await _provide_r_terminal_profile_for_test();
            assert.strictEqual((profile.options as vscode.TerminalOptions).shellPath, 'raven');
            assert.strictEqual(perch.launches.length, 0);
        });

        test('a lookup that never settles delays neither a new console nor the terminal profile', async () => {
            const perch = new FakePerch();
            perch.available = () => new Promise<boolean>(() => undefined);
            void _connect_perch_for_r_terminals_for_test(deps_for(perch, local));
            const deadline = new Promise<'waited'>((r) => setTimeout(() => r('waited'), 2000));

            const terminal = await Promise.race([get_or_create_terminal_for('R'), deadline]);
            assert.notStrictEqual(terminal, 'waited', 'a new console waited for Perch');
            assert.strictEqual(perch_session_of(terminal as vscode.Terminal), undefined);
            const profile = await Promise.race([_provide_r_terminal_profile_for_test(), deadline]);
            assert.notStrictEqual(profile, 'waited', 'the terminal profile waited for Perch');
        });

        test("Perch's list starts a console in a new session, which becomes the send target", async () => {
            const perch = new FakePerch();
            perch.listed = [perch.session({ attached: false, attachedHere: false })];
            _set_reattach_picker_for_test(async () => assert.fail('the launcher never offers to reattach'));
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, local));
            const ordinary = await get_or_create_terminal_for('raven');
            _set_server_path_for_test(() => '/opt/raven/bin/raven');

            await new_console_in_perch();
            assert.strictEqual(perch.launches.length, 1);
            assert.deepStrictEqual(perch.launches[0].annotations, { 'raven.program': 'raven', 'raven.console': 'ipc' });
            const target = await resolve_send_target();
            assert.ok(target?.kind === 'terminal');
            assert.notStrictEqual(target.terminal, ordinary);
            const id = perch_session_of(target.terminal);
            assert.ok(id, 'the send target runs in a Perch session');
            assert.strictEqual(console_socket_of(target.terminal), path.join(perch.root, id, 'ipc'));
            assert.deepStrictEqual(infos, [], 'a console started here has its plots');
        });

        test('a program with no console socket started from the list gets sends through Perch', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, local));
            const config = vscode.workspace.getConfiguration('raven.rTerminal');
            const before = config.inspect<string>('program')?.globalValue;
            await config.update('program', 'R', vscode.ConfigurationTarget.Global);
            try {
                await new_console_in_perch();
                const target = await resolve_send_target();
                assert.ok(target?.kind === 'terminal');
                const id = perch_session_of(target.terminal);
                assert.ok(id);
                send_code(target.terminal, 'x <- 1', OPTIONS);
                await until(() => perch.sends.length === 1, 'sent through Perch');
                assert.strictEqual(perch.sends[0].id, id);
            } finally {
                await config.update('program', before, vscode.ConfigurationTarget.Global);
            }
        });
    });

    suite("Perch's list", () => {
        test('rejects when Perch is not usable', async () => {
            await _connect_perch_for_r_terminals_for_test(deps_for(undefined, { remote: false }));
            await assert.rejects(new_console_in_perch(), /^Error: Perch is not available here\.$/);

            const perch = new FakePerch();
            perch.is_available = false;
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, { remote: false }));
            await assert.rejects(new_console_in_perch(), /Perch is not available here/);

            await _connect_perch_for_r_terminals_for_test(deps_for(new FakePerch(), { reachable: false }));
            await assert.rejects(new_console_in_perch(), /Perch is not available here/, 'remote window, Raven forced to UI');
        });

        test('waits a bounded time for the lookup', async () => {
            const perch = new FakePerch();
            perch.available = () => new Promise<boolean>(() => undefined);
            void _connect_perch_for_r_terminals_for_test(deps_for(perch, { remote: false }));
            await assert.rejects(new_console_in_perch(50), /Perch is not available here/);
        });

        test('waits for a lookup in progress', async () => {
            const perch = new FakePerch();
            let answer: (yes: boolean) => void = () => undefined;
            perch.available = () => new Promise<boolean>((resolve) => { answer = resolve; });
            void _connect_perch_for_r_terminals_for_test(deps_for(perch, { remote: false }));
            const starting = new_console_in_perch();
            await new Promise((r) => setTimeout(r, 20));
            answer(true);
            await starting;
            assert.strictEqual(perch.launches.length, 1);
        });

        test('rejects with the reason when the session does not start', async () => {
            const perch = new FakePerch();
            perch.waitForSession = async () => { throw new Error('the program exited'); };
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, { remote: false }));
            await assert.rejects(new_console_in_perch(), /didn't start in a Perch session \(the program exited\)/);
        });

        test('cancelling the console picker cancels', async () => {
            const perch = new FakePerch();
            await _connect_perch_for_r_terminals_for_test(deps_for(perch, { remote: false }));
            const config = vscode.workspace.getConfiguration('raven.rTerminal');
            const before = config.inspect<string>('program')?.globalValue;
            await config.update('program', 'ask', vscode.ConfigurationTarget.Global);
            _set_picker_for_test(async () => undefined);
            try {
                await assert.rejects(new_console_in_perch(), vscode.CancellationError);
                assert.strictEqual(perch.launches.length, 0);
            } finally {
                _set_picker_for_test(null);
                await config.update('program', before, vscode.ConfigurationTarget.Global);
            }
        });

        test('the command is registered, and says so when Perch is absent', async () => {
            // The extension under test runs in a local window without Perch.
            await assert.rejects(
                Promise.resolve(vscode.commands.executeCommand('raven.perch.newConsole')),
                /Perch is not available here/,
            );
        });

        test('remote window: the list starts a session too, without a reattach offer', async () => {
            const perch = new FakePerch();
            perch.listed = [perch.session({ attached: false, attachedHere: false })];
            _set_reattach_picker_for_test(async () => assert.fail('the launcher never offers to reattach'));
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));
            await new_console_in_perch();
            assert.strictEqual(perch.launches.length, 1);
        });
    });

    suite('reattaching', () => {
        test('a running session with no terminal here is offered, and the pick is reattached', async () => {
            const perch = new FakePerch();
            const detached = perch.session({ attached: false, attachedHere: false });
            perch.listed = [detached];
            const { terminal } = fake_terminal();
            const attached: string[] = [];
            perch.attach_result = async (id) => { attached.push(id); return terminal; };
            const offered: string[][] = [];
            _set_reattach_picker_for_test(async (candidates) => {
                offered.push(candidates.map((s) => s.id));
                return candidates[0];
            });
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));

            assert.strictEqual(await get_or_create_terminal_for('raven'), terminal);
            assert.deepStrictEqual(offered, [[detached.id]]);
            assert.deepStrictEqual(attached, [detached.id]);
            assert.strictEqual(perch.launches.length, 0);
            assert.strictEqual(console_socket_of(terminal), path.join(detached.dir, 'ipc'));
        });

        test('"Start a new" starts one; dismissing cancels', async () => {
            const perch = new FakePerch();
            perch.listed = [perch.session({ attached: false, attachedHere: false })];
            let answer: 'new' | undefined = 'new';
            _set_reattach_picker_for_test(async () => answer);
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));

            const terminal = await get_or_create_terminal_for('raven');
            assert.strictEqual(perch.launches.length, 1);
            _handle_terminal_closed_for_test(terminal);

            answer = undefined;
            await assert.rejects(get_or_create_terminal_for('raven'), vscode.CancellationError);
            assert.strictEqual(perch.launches.length, 1);
        });
    });

    suite('sending', () => {
        test('typing goes through send, in order, once each; never sendText', async () => {
            const perch = new FakePerch();
            const session = perch.session({ annotations: { 'raven.program': 'R' } });
            const { terminal, typed } = fake_terminal();
            perch.open = [{ session, terminal }];
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));

            send_code(terminal, 'x <- 1\nprint(x)', OPTIONS);
            type_into(terminal, 'y <- 2');
            await until(() => perch.sends.length === 2, 'two sends');
            assert.deepStrictEqual(typed, []);
            assert.deepStrictEqual(perch.sends, [
                { id: session.id, text: '\x1b[200~x <- 1\rprint(x)\x1b[201~', options: { submit: true } },
                { id: session.id, text: 'y <- 2', options: { submit: true } },
            ]);
        });

        test('outcome_unknown: the user is told it may not have run, and nothing is resent', async () => {
            const perch = new FakePerch();
            perch.send_result = () => Promise.reject(perch_error('outcome_unknown'));
            const { terminal } = fake_terminal();
            perch.open = [{ session: perch.session({ annotations: {} }), terminal }];
            await _connect_perch_for_r_terminals_for_test(deps_for(perch));

            type_into(terminal, 'x <- 1');
            await until(() => warnings.length === 1, 'warned');
            await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual(perch.sends.length, 1);
            assert.match(warnings[0], /may not have run/);
        });

        test("Raven's console in a session gets code over its socket, not send", async () => {
            const perch = new FakePerch();
            const session = perch.session();
            const { terminal, typed } = fake_terminal();
            perch.open = [{ session, terminal }];
            const received: string[] = [];
            const server = net.createServer((conn) => {
                conn.setEncoding('utf8');
                conn.on('data', (chunk: string) => {
                    for (const line of chunk.split('\n').filter(Boolean)) {
                        const msg = JSON.parse(line) as { id: number; code: string };
                        received.push(msg.code);
                        conn.write(JSON.stringify({ id: msg.id, status: 'queued' }) + '\n');
                    }
                });
            });
            await new Promise<void>((resolve) => server.listen(path.join(session.dir, 'ipc'), resolve));
            try {
                await _connect_perch_for_r_terminals_for_test(deps_for(perch));
                send_code(terminal, 'z <- 3', OPTIONS);
                await until(() => received.length === 1, 'delivered over the socket');
                await new Promise((r) => setTimeout(r, 50));
                assert.deepStrictEqual(received, ['z <- 3']);
                assert.deepStrictEqual(perch.sends, []);
                assert.deepStrictEqual(typed, []);
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });
    });
});
