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
    };
}

const plot_services = {
    ensureStarted: async () => true,
    server: { port: 4242, token: TOKEN, markSessionEnded: () => undefined },
};

let context = fake_context();

beforeEach(() => {
    fake.reset();
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

// ---------------------------------------------------------------------------

describe('vscode-R sends never reach Raven\'s terminal', () => {
    /**
     * vscode-R 3.4.0's terminal selector (`dist/extension.js`): among live
     * terminals, the active one if `r.alwaysUseActiveTerminal` is on;
     * otherwise those named `R` or `R Interactive`, the active one if it is
     * one of them, else the newest.
     */
    function vscode_r_selector(): FakeTerminal | undefined {
        const live = fake.window.terminals.filter((t) => t.exitStatus === undefined && !t.name.toLowerCase().includes('deactivate'));
        if (fake.module.workspace.getConfiguration('r').get('alwaysUseActiveTerminal')) {
            return live.find((t) => t === fake.window.activeTerminal);
        }
        const named = live.filter((t) => t.name === 'R' || t.name === 'R Interactive');
        if (named.length === 0) return undefined;
        const active = fake.window.activeTerminal;
        return active && named.includes(active) ? active : named[named.length - 1];
    }

    /** Code vscode-R ran in its Interactive session. */
    let interactive: string[] = [];

    /** The user dismisses vscode-R's own "Run R code" prompt. */
    let prompt_cancelled = false;
    /** Times vscode-R ran the editor's selection instead of given code. */
    let ran_selection = 0;
    /** Sends a 2.x `r.runSelection` started without waiting for them. */
    let unawaited_sends = 0;

    function install_vscode_r(version = '3.4.0') {
        const created: FakeTerminal[] = [];
        interactive = [];
        prompt_cancelled = false;
        ran_selection = 0;
        unawaited_sends = 0;
        fake.state.extensions.set('REditorSupport.r', {
            activate: async () => undefined,
            packageJSON: {
                version,
                // 3.2 added the Interactive session and its setting.
                contributes: { configuration: { properties: version.startsWith('2.') ? {} : { 'r.interactive.executionTarget': { default: 'auto' } } } },
            },
        });
        fake.commands.set('r.createRTerm', async () => {
            const t = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
            created.push(t);
            t.show();
        });
        // vscode-R 3.4.0's `runTextInTerm`: true when the code was sent.
        const run_text = async (code: string): Promise<boolean> => {
            // The user dismissed vscode-R's "Run R code" prompt.
            if (prompt_cancelled) return false;
            // The code is offered to the Interactive router first; with the
            // target set to `interactive` it never picks a terminal.
            if (fake.module.workspace.getConfiguration('r').get('interactive.executionTarget') === 'interactive') {
                interactive.push(code);
                return true;
            }
            let t = vscode_r_selector();
            if (!t) {
                await fake.module.commands.executeCommand('r.createRTerm');
                t = vscode_r_selector();
            }
            if (!t) return false;
            t.sendText(code);
            return true;
        };
        // `r.runCommand` discards whether it ran; `r.runSelection` with a
        // code argument returns it (3.2.2 and 3.4.0), and before 3.2
        // returned nothing.
        fake.commands.set('r.runCommand', async (code: unknown) => { await run_text(String(code)); });
        fake.commands.set('r.runSelection', async (code: unknown) => {
            if (!code) { ran_selection += 1; return undefined; }
            if (version.startsWith('2.')) {
                // 2.8.8 neither waits for the send nor returns its result.
                unawaited_sends += 1;
                void run_text(String(code));
                return undefined;
            }
            return run_text(String(code));
        });
        return created;
    }

    async function make_active(t: FakeTerminal) {
        t.show();
        await settle();
        expect(fake.window.activeTerminal).toBe(t);
    }

    // Raven's console tab is `R (Raven)`, which vscode-R doesn't pick by name.
    test("with vscode-R's terminal open and Raven's active, without moving the focus", async () => {
        install_vscode_r();
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');

        expect(await send.send_to_r_console('x <- 1')).toBe(true);
        expect(ours.typed).toEqual([]);
        expect(theirs.typed).toEqual(['x <- 1']);
        expect(fake.window.activeTerminal).toBe(ours);
    });

    // With `r.alwaysUseActiveTerminal` on, vscode-R would send to whichever
    // terminal is active, Raven's included.
    test("with vscode-R's terminal open, Raven's active, and r.alwaysUseActiveTerminal on", async () => {
        install_vscode_r();
        fake.set_setting('r.alwaysUseActiveTerminal', 'global', true);
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');

        expect(await send.send_to_r_console('x <- 1')).toBe(true);
        expect(ours.typed).toEqual([]);
        expect(theirs.typed).toEqual(['x <- 1']);
    });

    test("with no vscode-R terminal yet, Raven's active, and r.alwaysUseActiveTerminal on", async () => {
        const created = install_vscode_r();
        fake.set_setting('r.alwaysUseActiveTerminal', 'global', true);
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
        fake.set_setting('r.alwaysUseActiveTerminal', 'global', true);
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

    test("sends to vscode-R's Interactive target without opening a terminal", async () => {
        const created = install_vscode_r();
        fake.set_setting('r.alwaysUseActiveTerminal', 'global', true);
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
        fake.set_setting('r.alwaysUseActiveTerminal', 'global', true);
        fake.commands.set('r.createRTerm', async () => undefined);
        const ours = await rtm.get_or_create_terminal_for('raven') as unknown as FakeTerminal;
        await make_active(ours);
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        fake.set_setting('r.interactive.executionTarget', 'global', 'interactive');

        expect(await send.send_to_r_console('t <- 7')).toBe(true);
        expect(fake.errors).toEqual([]);
        expect(interactive).toEqual(['t <- 7']);
    });

    // vscode-R's `r.runCommand` hides whether anything was sent; Raven asks
    // through `r.runSelection`, which reports it.
    test("cancelling vscode-R's own prompt sends nothing and says so to the caller", async () => {
        install_vscode_r();
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        prompt_cancelled = true;

        // False: the caller leaves the cursor where it is.
        expect(await send.send_to_r_console('v <- 8')).toBe(false);
        expect(theirs.typed).toEqual([]);
        // The user cancelled; that is no error to report.
        expect(fake.errors).toEqual([]);

        prompt_cancelled = false;
        expect(await send.send_to_r_console('v <- 8')).toBe(true);
        expect(theirs.typed).toEqual(['v <- 8']);
    });

    test('vscode-R before 3.2 still gets the code through r.runCommand, which waits for the send', async () => {
        install_vscode_r('2.8.8');
        const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        expect(await send.send_to_r_console('y <- 9')).toBe(true);
        expect(theirs.typed).toEqual(['y <- 9']);
        expect(unawaited_sends).toBe(0);
    });

    test("empty code never makes vscode-R run the editor's selection", async () => {
        install_vscode_r();
        fake.window.createTerminal({ name: 'R Interactive' });
        fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
        expect(await send.send_to_r_console('')).toBe(true);
        expect(ran_selection).toBe(0);
    });

    describe('Install and Restart says what to restart', () => {
        const install = async () => {
            build.register_build_commands(context as never);
            await fake.module.commands.executeCommand('raven.build.installAndRestart');
        };

        test("vscode-R's Interactive session", async () => {
            install_vscode_r();
            fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
            fake.set_setting('r.interactive.executionTarget', 'global', 'interactive');
            await install();
            expect(interactive).toEqual(['devtools::install(".")']);
            expect(fake.infos).toEqual([
                'Raven: sent devtools::install() to vscode-R. When it finishes, run "R: Restart Interactive Session" to load the new version.',
            ]);
        });

        test("vscode-R's terminal, when it only uses terminals", async () => {
            for (const setup of [
                () => { install_vscode_r(); fake.set_setting('r.interactive.executionTarget', 'global', 'terminal'); },
                () => { install_vscode_r('2.8.8'); },
            ]) {
                fake.infos.splice(0);
                setup();
                const theirs = fake.window.createTerminal({ name: 'R Interactive' }) as FakeTerminal;
                fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
                await install();
                expect(theirs.typed).toEqual(['devtools::install(".")']);
                expect(fake.infos).toEqual([
                    "Raven: sent devtools::install() to vscode-R. When it finishes, restart R in vscode-R's terminal to load the new version.",
                ]);
            }
        });

        test('either, when vscode-R decides per send (auto)', async () => {
            install_vscode_r();
            fake.window.createTerminal({ name: 'R Interactive' });
            fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
            await install();
            expect(fake.infos).toEqual([
                'Raven: sent devtools::install() to vscode-R. When it finishes, restart R where vscode-R ran it (its R terminal, or "R: Restart Interactive Session") to load the new version.',
            ]);
        });

        test("nothing, when vscode-R's prompt was cancelled", async () => {
            install_vscode_r();
            fake.set_setting('raven.rTerminal.program', 'global', 'vscode-R');
            fake.set_setting('r.interactive.executionTarget', 'global', 'interactive');
            prompt_cancelled = true;
            await install();
            expect(interactive).toEqual([]);
            expect(fake.infos).toEqual([]);
        });
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

    test('two tasks requested at once share one terminal', async () => {
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        const [a, b] = await Promise.all([build.get_or_create_tasks_terminal(), build.get_or_create_tasks_terminal()]);
        expect(b).toBe(a);
        expect(fake.window.terminals.length).toBe(1);
    });

    // The fixture is a shell script.
    test.skipIf(process.platform === 'win32')('a creation that finishes after a settings change keeps the newer one shared', async () => {
        binary._clear_console_probes_for_test();
        const slow = path.join(storage, 'raven-slow-probe-2');
        fs.writeFileSync(slow, '#!/bin/sh\nsleep 0.3\necho "raven console"\n', { mode: 0o755 });
        rtm._set_server_binaries_for_test(() => ({ configured: slow, bundled: BUNDLED }));
        build.register_build_commands(context as never);
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        const a = build.get_or_create_tasks_terminal();
        await settle(20);
        // radian's PATH check outlasts the first creation.
        rtm._set_validator_for_test(async () => { await settle(700); return true; });
        await fake.module.workspace.getConfiguration('raven').update('rTerminal.program', 'radian', fake.module.ConfigurationTarget.Global);
        const b = build.get_or_create_tasks_terminal();
        await a;
        const c = build.get_or_create_tasks_terminal();
        expect(await c).toBe(await b);
        expect(fake.window.terminals.length).toBe(2);
    });

    // The fixture is a shell script.
    test.skipIf(process.platform === 'win32')('a task requested while the first is still starting follows the new choice', async () => {
        binary._clear_console_probes_for_test();
        // The first task's `console --help` probe takes a moment.
        const slow = path.join(storage, 'raven-slow-probe');
        fs.writeFileSync(slow, '#!/bin/sh\nsleep 0.3\necho "raven console"\n', { mode: 0o755 });
        rtm._set_server_binaries_for_test(() => ({ configured: slow, bundled: BUNDLED }));
        fake.set_setting('raven.rTerminal.program', 'global', 'raven');
        const first = build.get_or_create_tasks_terminal();
        await settle(20);

        picker._set_picker_for_test(async () => ({ target: 'R', scope: 'session' }));
        await rtm.choose_r_console();
        picker._set_picker_for_test(null);

        const second = await build.get_or_create_tasks_terminal() as unknown as FakeTerminal;
        expect(second.creationOptions.shellPath).toBe('R');
        expect(second).not.toBe(await first);
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

    // Windows bare names aren't stamped (libuv's lookup isn't reproduced).
    test.skipIf(process.platform === 'win32')('a bare command name is stamped as the file PATH finds', async () => {
        const dir = fs.mkdtempSync(path.join(storage, 'bin-'));
        const name = 'raven-on-path';
        const file = path.join(dir, name);
        fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const saved = process.env.PATH;
        process.env.PATH = dir;
        try {
            let probes = 0;
            const b = { configured: name, bundled: BUNDLED };
            const old = async () => { probes++; return false; };
            expect(await binary.console_binary(b, () => undefined, old)).toBe(BUNDLED);
            expect(await binary.console_binary(b, () => undefined, old)).toBe(BUNDLED);
            expect(probes).toBe(1);
            // Replaced by a build with `console`.
            fs.writeFileSync(file, '#!/bin/sh\nexit 0\n# rebuilt, longer\n');
            expect(await binary.console_binary(b, () => undefined, async () => true)).toBe(name);
        } finally {
            process.env.PATH = saved;
        }
    });

    test('a binary that cannot be found is probed again next time', async () => {
        let probes = 0;
        const probe = async () => { probes++; return false; };
        const b = { configured: 'raven-nowhere-on-path-0123', bundled: BUNDLED };
        await binary.console_binary(b, () => undefined, probe);
        await binary.console_binary(b, () => undefined, probe);
        expect(probes).toBe(2);
    });

    test('no configured binary means the bundled one, without probing', async () => {
        let probes = 0;
        const probe = async () => { probes++; return true; };
        expect(await binary.console_binary({ configured: undefined, bundled: BUNDLED }, () => undefined, probe)).toBe(BUNDLED);
        expect(probes).toBe(0);
    });
});
