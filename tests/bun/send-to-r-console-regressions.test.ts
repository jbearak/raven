/**
 * Regressions in sending code to R consoles, driven through the real
 * send-to-R modules with an in-memory `vscode` (see
 * `_helpers/fake-vscode-terminals.ts`). Each `describe` is one bug found in
 * the pre-release audit against v0.21.1.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { make_fake_vscode, type FakeTerminal } from './_helpers/fake-vscode-terminals';

const fake = make_fake_vscode();
mock.module('vscode', () => fake.module);

const rtm = await import('../../editors/vscode/src/send-to-r/r-terminal-manager');
const send = await import('../../editors/vscode/src/send-to-r/console-send');
const ipc = await import('../../editors/vscode/src/send-to-r/console-ipc');
const perch = await import('../../editors/vscode/src/send-to-r/perch');
const build = await import('../../editors/vscode/src/build-commands');
const picker = await import('../../editors/vscode/src/send-to-r/console-picker');
const binary = await import('../../editors/vscode/src/send-to-r/console-binary');

const TOKEN = 'secret-session-token-0123456789';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-send-test-'));
const BUNDLED = '/ext/bin/raven';

function fake_context() {
    const state = new Map<string, unknown>();
    return {
        subscriptions: [] as { dispose(): unknown }[],
        globalStorageUri: { fsPath: storage },
        globalState: {
            get: (k: string) => state.get(k),
            update: async (k: string, v: unknown) => { state.set(k, v); },
            keys: () => [...state.keys()],
        },
        extension: { extensionKind: 2 },
    };
}

const plot_services = {
    ensureStarted: async () => true,
    server: { port: 4242, token: TOKEN, markSessionEnded: () => undefined },
};

let context = fake_context();

beforeEach(() => {
    fake.reset();
    perch._reset_perch_for_test();
    rtm._dispose_cached_r_terminal_for_test();
    rtm._reset_console_choice_for_test();
    rtm._set_validator_for_test(null);
    build._reset_tasks_terminal_for_test();
    context = fake_context();
    rtm.register_r_terminal(context as never, plot_services as never, () => ({ configured: undefined, bundled: BUNDLED }));
    rtm._set_extension_context_for_test(context as never);
});

afterEach(() => {
    for (const d of context.subscriptions) d.dispose();
});

afterAll(() => {
    fs.rmSync(storage, { recursive: true, force: true });
});

/** Waits for queued microtasks and timers to run. */
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Mimics Perch's `prepareLaunch`: `env` becomes `--env NAME=VALUE` arguments. */
function fake_perch_api(wait: () => Promise<void> = async () => undefined) {
    const launches: { id: string; options: Record<string, unknown> }[] = [];
    let n = 0;
    const api = {
        version: 1 as const,
        available: async () => true,
        prepareLaunch(o: { name: string; kind: string; command: string[]; env?: Record<string, string> }) {
            const id = `sess${String(++n).padStart(4, '0')}`;
            const args = ['new', '--id', id, '--name', o.name, '--kind', o.kind];
            for (const [k, v] of Object.entries(o.env ?? {})) args.push('--env', `${k}=${v}`);
            args.push('--', ...o.command);
            const launch = { id, options: { name: o.name, shellPath: '/usr/bin/perch', shellArgs: args, isTransient: true } };
            launches.push(launch);
            return launch;
        },
        waitForSession: async (id: string) => (await wait(), {
            id, name: 'R', kind: 'r', owner: 'jbearak.raven-r',
            annotations: { 'raven.program': 'raven', 'raven.console': 'ipc' },
            dir: path.join(storage, id), degraded: [], cwd: '/', host: 'h',
            createdAt: new Date().toISOString(), state: 'running' as const,
            attached: true, attachedHere: true,
        }),
        listSessions: async () => [],
        terminals: () => [],
        attach: async () => { throw new Error('unused'); },
        send: async () => 'queued' as const,
        onDidAttach: () => ({ dispose() {} }),
        onDidEndSession: () => ({ dispose() {} }),
    };
    return { api, launches };
}

async function connect(api: unknown) {
    await rtm._connect_perch_for_r_terminals_for_test({
        host: () => ({ remote: true, reachable: true }),
        get_extension: () => ({ isActive: true, exports: { getApi: () => api } }) as never,
    });
}


// ---------------------------------------------------------------------------

describe('Perch launches keep the session token off the command line', () => {
    function assert_token_only_in_env(options: Record<string, unknown>) {
        const argv = [String(options.shellPath), ...(options.shellArgs as string[])];
        expect(argv.join(' ')).not.toContain(TOKEN);
        expect((options.env as Record<string, string>).RAVEN_SESSION_TOKEN).toBe(TOKEN);
    }

    test('a console Raven opens', async () => {
        const { api } = fake_perch_api();
        await connect(api);
        const terminal = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        assert_token_only_in_env(terminal.creationOptions);
    });

    test('the terminal profile', async () => {
        const { api } = fake_perch_api();
        await connect(api);
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        const profile = await rtm._provide_r_terminal_profile_for_test() as unknown as { options: Record<string, unknown> };
        assert_token_only_in_env(profile.options);
    });

    test("a console from Perch's list", async () => {
        const { api } = fake_perch_api();
        await connect(api);
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        await rtm.new_console_in_perch(100);
        assert_token_only_in_env(fake.window.terminals[0].creationOptions);
    });
});

// ---------------------------------------------------------------------------

describe('vscode-R sends never reach Raven\'s terminal', () => {
    /**
     * vscode-R 3.4.0's terminal selector (`dist/extension.js`): live
     * terminals named `R` or `R Interactive`; the active one if it is one of
     * them, else the newest.
     */
    function vscode_r_selector(): FakeTerminal | undefined {
        const live = fake.window.terminals.filter((t) => t.exitStatus === undefined && !t.name.toLowerCase().includes('deactivate'));
        const named = live.filter((t) => t.name === 'R' || t.name === 'R Interactive');
        if (named.length === 0) return undefined;
        const active = fake.window.activeTerminal;
        return active && named.includes(active) ? active : named[named.length - 1];
    }

    /** Code vscode-R ran in its Interactive session. */
    let interactive: string[] = [];

    function install_vscode_r() {
        const created: FakeTerminal[] = [];
        interactive = [];
        fake.state.extensions.set('REditorSupport.r', {
            activate: async () => undefined,
            packageJSON: {
                version: '3.4.0',
                contributes: { configuration: { properties: { 'r.interactive.executionTarget': { default: 'auto' } } } },
            },
        });
        fake.commands.set('r.createRTerm', async () => {
            const t = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
            created.push(t);
            t.show();
        });
        // `r.runCommand` discards whether it ran, as in vscode-R 3.4.0.
        fake.commands.set('r.runCommand', async (code: unknown) => {
            // vscode-R 3.4.0 offers the code to its Interactive router first;
            // with the target set to `interactive` it never picks a terminal.
            if (fake.module.workspace.getConfiguration('r').get('interactive.executionTarget') === 'interactive') {
                interactive.push(String(code));
                return;
            }
            let t = vscode_r_selector();
            if (!t) {
                await fake.module.commands.executeCommand('r.createRTerm');
                t = vscode_r_selector();
            }
            t?.sendText(String(code));
        });
        return created;
    }

    async function make_active(t: FakeTerminal) {
        t.show();
        await settle();
        expect(fake.window.activeTerminal).toBe(t);
    }

    test("with vscode-R's terminal open and Raven's active", async () => {
        install_vscode_r();
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');

        expect(await send.send_to_r_console('x <- 1')).toBe(true);
        expect(ours.typed).toEqual([]);
        expect(theirs.typed).toEqual(['x <- 1']);
    });

    test("with no vscode-R terminal yet and Raven's open", async () => {
        const created = install_vscode_r();
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');

        expect(await send.send_to_r_console('y <- 2')).toBe(true);
        expect(ours.typed).toEqual([]);
        expect(created.length).toBe(1);
        expect(created[0].typed).toEqual(['y <- 2']);
    });

    test('refuses rather than send to Raven when its terminal cannot be moved aside', async () => {
        install_vscode_r();
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.state.show_activates = false;
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');

        expect(await send.send_to_r_console('z <- 3')).toBe(false);
        expect(ours.typed).toEqual([]);
        expect(theirs.typed).toEqual([]);
        expect(fake.errors.length).toBe(1);
    });

    test("a Raven console still starting in Perch isn't vscode-R's", async () => {
        install_vscode_r();
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        let started!: () => void;
        const { api } = fake_perch_api(() => new Promise<void>((r) => { started = r; }));
        await connect(api);
        const opening = rtm.get_or_create_terminal_for('raven');
        await settle(10);
        const ours = fake.window.terminals[1];
        expect(ours.name).toBe('R');
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');

        expect(await send.send_to_r_console('v <- 5')).toBe(true);
        expect(ours.typed).toEqual([]);
        expect(theirs.typed).toEqual(['v <- 5']);
        started();
        await opening;
    });

    test("sends to vscode-R's Interactive target without opening a terminal", async () => {
        const created = install_vscode_r();
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        fake.set_setting('r.interactive.executionTarget', 'global', 'interactive');

        expect(await send.send_to_r_console('u <- 6')).toBe(true);
        expect(created).toEqual([]);
        expect(ours.typed).toEqual([]);
        expect(interactive).toEqual(['u <- 6']);
    });

    test('an Interactive target needs no terminal even when none can be opened', async () => {
        install_vscode_r();
        fake.commands.set('r.createRTerm', async () => undefined);
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        fake.set_setting('r.interactive.executionTarget', 'global', 'interactive');

        expect(await send.send_to_r_console('t <- 7')).toBe(true);
        expect(fake.errors).toEqual([]);
        expect(interactive).toEqual(['t <- 7']);
    });

    test('leaves vscode-R alone when no Raven terminal is in its way', async () => {
        install_vscode_r();
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        expect(await send.send_to_r_console('w <- 4')).toBe(true);
        expect(theirs.typed).toEqual(['w <- 4']);
    });
});

// ---------------------------------------------------------------------------

describe('Switch to R after a missing program', () => {
    test('a workspace setting: one prompt, one terminal, user setting untouched', async () => {
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        fake.set_setting('raven.rTerminal.program', 'workspace', 'radian');
        rtm._set_validator_for_test(async () => false);
        fake.state.answer_warning = (w) => (w.items.includes('Switch to R') ? 'Switch to R' : undefined);

        await send.send_to_r_console('a <- 1');
        await send.send_to_r_console('b <- 2');

        expect(fake.warnings.filter((w) => w.items.includes('Switch to R')).length).toBe(1);
        expect(fake.window.terminals.length).toBe(1);
        expect(fake.window.terminals[0].name).toBe('R (plain)');
        expect(fake.window.terminals[0].typed).toEqual(['a <- 1', 'b <- 2']);
        expect(fake.setting('raven.rTerminal.program', 'global')).toBe('raven');
    });

    test('a user setting: saved as R there, one terminal', async () => {
        fake.set_setting('raven.rTerminal.program', 'global', 'radian');
        rtm._set_validator_for_test(async () => false);
        fake.state.answer_warning = (w) => (w.items.includes('Switch to R') ? 'Switch to R' : undefined);

        await send.send_to_r_console('a <- 1');
        await send.send_to_r_console('b <- 2');

        expect(fake.warnings.length).toBe(1);
        expect(fake.window.terminals.length).toBe(1);
        expect(fake.setting('raven.rTerminal.program', 'global')).toBe('R');
    });

    test('package tasks after switching a user setting reuse one terminal', async () => {
        build.register_build_commands(context as never);
        fake.set_setting('raven.rTerminal.program', 'global', 'radian');
        rtm._set_validator_for_test(async () => false);
        fake.state.answer_warning = (w) => (w.items.includes('Switch to R') ? 'Switch to R' : undefined);

        const first = await build.get_or_create_tasks_terminal();
        const second = await build.get_or_create_tasks_terminal();
        expect(second).toBe(first);
        expect(fake.window.terminals.length).toBe(1);
    });

    test('package tasks after the switch reuse one terminal', async () => {
        fake.set_setting('raven.rTerminal.program', 'workspace', 'radian');
        rtm._set_validator_for_test(async () => false);
        fake.state.answer_warning = (w) => (w.items.includes('Switch to R') ? 'Switch to R' : undefined);

        const first = await build.get_or_create_tasks_terminal();
        const second = await build.get_or_create_tasks_terminal();
        expect(second).toBe(first);
        expect(fake.warnings.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------

describe("every send to Raven's console goes through its ordered socket", () => {
    /** A console socket that records each request and acknowledges it. */
    function console_server(socket_path: string) {
        const received: string[] = [];
        const server = net.createServer((conn) => {
            conn.setEncoding('utf8');
            let buf = '';
            conn.on('data', (chunk: string) => {
                buf += chunk;
                const nl = buf.indexOf('\n');
                if (nl < 0) return;
                const req = JSON.parse(buf.slice(0, nl)) as { id: number; code: string };
                received.push(req.code);
                conn.end(JSON.stringify({ id: req.id, status: 'queued' }) + '\n');
            });
        });
        return new Promise<{ received: string[]; close: () => void }>((resolve) => {
            server.listen(socket_path, () => resolve({ received, close: () => server.close() }));
        });
    }

    async function raven_console() {
        const terminal = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        const socket = ipc.console_socket_of(terminal as never)!;
        expect(socket).toBeDefined();
        const server = await console_server(socket);
        return { terminal, socket, server };
    }

    // The fixture listens on a Unix socket path; Windows consoles use a named pipe.
    test.skipIf(process.platform === 'win32')('Source File does not type into the prompt', async () => {
        const { terminal, server } = await raven_console();
        await send.deliver_to_target({ kind: 'terminal', terminal: terminal as never }, 'source("/a.R", echo = TRUE)', { how: 'text' });
        await settle(100);
        expect(terminal.typed).toEqual([]);
        expect(server.received).toEqual(['source("/a.R", echo = TRUE)']);
        server.close();
    });

    // The fixture listens on a Unix socket path; Windows consoles use a named pipe.
    test.skipIf(process.platform === 'win32')('a quick inspection waits behind an earlier gated send', async () => {
        const { terminal, socket, server } = await raven_console();
        let open!: () => void;
        ipc.gate_sends(socket, new Promise<void>((r) => { open = r; }));
        const target = { kind: 'terminal' as const, terminal: terminal as never };
        await send.deliver_to_target(target, 'x <- 1');
        await send.deliver_to_target(target, 'length(x)', { how: 'text' });
        await settle(50);
        expect(terminal.typed).toEqual([]);
        expect(server.received).toEqual([]);
        open();
        await settle(200);
        expect(server.received).toEqual(['x <- 1', 'length(x)']);
        expect(terminal.typed).toEqual([]);
        server.close();
    });
});

// ---------------------------------------------------------------------------

describe('package tasks follow a session console choice', () => {
    test('choosing R for this session moves the next task to R', async () => {
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        const first = await build.get_or_create_tasks_terminal() as unknown as FakeTerminal;
        expect(first.creationOptions.shellPath).toBe(BUNDLED);

        picker._set_picker_for_test(async () => ({ target: 'R', scope: 'session' }));
        await rtm.choose_r_console();
        picker._set_picker_for_test(null);

        const second = await build.get_or_create_tasks_terminal() as unknown as FakeTerminal;
        expect(second).not.toBe(first);
        expect(second.creationOptions.shellPath).toBe('R');
    });
});

// ---------------------------------------------------------------------------

describe('a raven.server.path from before `raven console`', () => {
    /** A binary that answers `console --help` like v0.21.1 or like a current one. */
    function fake_binary(name: string, has_console: boolean): string {
        const file = path.join(storage, name);
        fs.writeFileSync(
            file,
            has_console
                ? '#!/bin/sh\necho "raven console"\nexit 0\n'
                : '#!/bin/sh\necho "Error: Unknown argument: \'$1\'" >&2\nexit 1\n',
            { mode: 0o755 },
        );
        return file;
    }

    beforeEach(() => binary._clear_console_probes_for_test());

    test.skipIf(process.platform === 'win32')('the console and package tasks use the bundled binary, saying so once', async () => {
        const old = fake_binary('raven-0.21.1', false);
        rtm._set_server_binaries_for_test(() => ({ configured: old, bundled: BUNDLED }));
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');

        const console_terminal = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        expect(console_terminal.creationOptions.shellPath).toBe(BUNDLED);
        const tasks = await build.get_or_create_tasks_terminal() as unknown as FakeTerminal;
        expect(tasks.creationOptions.shellPath).toBe(BUNDLED);
        expect((tasks.creationOptions.shellArgs as string[])[0]).toBe('console');
        expect(fake.warnings.length).toBe(1);
        expect(fake.warnings[0].message).toContain(old);
    });

    test.skipIf(process.platform === 'win32')('a configured binary with `console` is used', async () => {
        const current = fake_binary('raven-current', true);
        rtm._set_server_binaries_for_test(() => ({ configured: current, bundled: BUNDLED }));
        const terminal = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        expect(terminal.creationOptions.shellPath).toBe(current);
        expect(fake.warnings).toEqual([]);
    });

    test('probes once per binary version', async () => {
        const file = fake_binary('raven-probed', true);
        let probes = 0;
        const probe = async () => { probes++; return false; };
        const b = { configured: file, bundled: BUNDLED };
        expect(await binary.console_binary(b, () => undefined, probe)).toBe(BUNDLED);
        expect(await binary.console_binary(b, () => undefined, probe)).toBe(BUNDLED);
        expect(probes).toBe(1);
        fs.writeFileSync(file, '#!/bin/sh\nexit 0\n# rebuilt, longer\n');
        expect(await binary.console_binary(b, () => undefined, async () => true)).toBe(file);
    });

    test('no configured binary means the bundled one, without probing', async () => {
        let probes = 0;
        const probe = async () => { probes++; return true; };
        expect(await binary.console_binary({ configured: undefined, bundled: BUNDLED }, () => undefined, probe)).toBe(BUNDLED);
        expect(probes).toBe(0);
    });
});
