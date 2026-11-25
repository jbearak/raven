/**
 * The debugger's side of the console IPC protocol (editors/vscode/src/
 * debugger/index.ts) against a fake console that behaves like
 * crates/raven/src/console/ipc.rs + dap::set_file_breakpoints:
 * - `subscribe` is acknowledged and pushes nothing;
 * - `breakpoints` replaces breakpoints file by file under the file's
 *   canonical path, and only a message with at least one file entry makes
 *   the console push its full line-breakpoint summary to subscribers;
 * - `execute` is queued and recorded.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------- vscode mock

type Bp = { enabled: boolean };
const bps: Bp[] = [];
const change_listeners: Array<() => void> = [];
const close_listeners: Array<(t: unknown) => void> = [];
const start_listeners: Array<(s: unknown) => void> = [];
let tracker_factory: { createDebugAdapterTracker(s: unknown): { onDidSendMessage(m: unknown): void } } | null = null;
/** Every `startDebugging` call's configuration. */
const started: Array<{ consoleSocket?: string }> = [];
/** Configuration providers by registration order. */
const config_providers: Array<{ resolveDebugConfiguration(...a: unknown[]): unknown }> = [];
const error_messages: string[] = [];
/** Open documents (`workspace.textDocuments`). */
const text_documents: Array<{ uri: { fsPath: string }; isDirty: boolean; save(): Promise<boolean> }> = [];

class SourceBreakpoint {
    enabled = true;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
    constructor(public location: { uri: { scheme: string; fsPath: string }; range: { start: { line: number } } }) {}
}
class FunctionBreakpoint {
    enabled = true;
    constructor(public functionName: string) {}
}
class Disposable {
    constructor(private fn: () => void = () => undefined) {}
    dispose(): void { this.fn(); }
}
const disposable = () => new Disposable();

mock.module('vscode', () => ({
    SourceBreakpoint,
    FunctionBreakpoint,
    Disposable,
    MarkdownString: class { appendMarkdown() { return this; } },
    DebugAdapterNamedPipeServer: class { constructor(public path: string) {} },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: { registerCommand: disposable, executeCommand: async () => undefined },
    debug: {
        get breakpoints() { return bps; },
        activeDebugSession: undefined,
        registerDebugConfigurationProvider: (_t: string, p: (typeof config_providers)[number]) => {
            config_providers.push(p);
            return disposable();
        },
        registerDebugAdapterDescriptorFactory: disposable,
        registerDebugAdapterTrackerFactory: (_t: string, f: typeof tracker_factory) => {
            tracker_factory = f;
            return disposable();
        },
        onDidChangeBreakpoints: (cb: () => void) => { change_listeners.push(cb); return disposable(); },
        onDidStartDebugSession: (cb: (s: unknown) => void) => { start_listeners.push(cb); return disposable(); },
        onDidTerminateDebugSession: disposable,
        startDebugging: async (_f: unknown, config: { consoleSocket?: string }) => {
            started.push(config);
            // VS Code takes a moment to start a session.
            await new Promise((r) => setTimeout(r, 50));
            return true;
        },
    },
    window: {
        activeTerminal: undefined,
        activeTextEditor: undefined,
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        onDidChangeActiveTerminal: disposable,
        onDidCloseTerminal: (cb: (t: unknown) => void) => { close_listeners.push(cb); return disposable(); },
        showInformationMessage: async () => undefined,
        showErrorMessage: async (m: string) => { error_messages.push(m); return undefined; },
        showWarningMessage: async () => undefined,
    },
    workspace: {
        workspaceFolders: undefined,
        get textDocuments() { return text_documents; },
        getConfiguration: () => ({ get: (_k: string, fallback?: unknown) => fallback }),
    },
}));

const { register_debugger, register_debugger_unavailable, _set_launch_timeouts_for_test } = await import('../../editors/vscode/src/debugger/index');
const ipc = await import('../../editors/vscode/src/send-to-r/console-ipc');

// --------------------------------------------------------------- fake console

type Wire = Record<string, unknown> & { op?: string; id?: number };

class FakeConsole {
    /** canonical path -> lines */
    files = new Map<string, number[]>();
    executes: Wire[] = [];
    /** Reply `ok` before applying, as when the summary thread lags. */
    ok_first = false;
    /**
     * How a mirror is answered: applied (`ok`), as by a console still
     * running R's startup profiles (`not-ready`), or as by one whose
     * debugger can't start (`unavailable`).
     */
    mirror_mode: 'ok' | 'not-ready' | 'unavailable' = 'ok';
    private subscribers: net.Socket[] = [];
    private server: net.Server;
    constructor(readonly socket: string) {
        this.server = net.createServer((sock) => {
            let buf = '';
            sock.setEncoding('utf8');
            sock.on('error', () => undefined);
            sock.on('data', (d: string) => {
                buf += d;
                let nl: number;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const msg = JSON.parse(buf.slice(0, nl)) as Wire;
                    buf = buf.slice(nl + 1);
                    this.handle(sock, msg);
                }
            });
        });
    }
    listen(): Promise<void> {
        return new Promise((resolve) => this.server.listen(this.socket, resolve));
    }
    close(): void {
        for (const s of this.subscribers) s.destroy();
        this.server.close();
    }
    /** Push an event to every subscriber. */
    push(event: object): void {
        for (const s of this.subscribers) s.write(JSON.stringify(event) + '\n');
    }
    private reply(sock: net.Socket, id: unknown, status: string): void {
        sock.write(JSON.stringify({ id, status }) + '\n');
    }
    private handle(sock: net.Socket, msg: Wire): void {
        switch (msg.op) {
            case 'subscribe':
                this.reply(sock, msg.id, 'ok');
                this.subscribers.push(sock);
                return;
            case 'breakpoints': {
                if (this.mirror_mode !== 'ok') {
                    this.reply(sock, msg.id, this.mirror_mode);
                    sock.end();
                    return;
                }
                const files = (msg.files ?? {}) as Record<string, Array<{ line: number }>>;
                // Like set_file_breakpoints: one file at a time, each
                // followed by a full summary (with a gap, so a client that
                // acts on a summary before the reply is caught).
                if (this.ok_first) this.reply(sock, msg.id, 'ok');
                void (async () => {
                    for (const [p, list] of Object.entries(files)) {
                        await new Promise((r) => setTimeout(r, 30));
                        let key = p;
                        try { key = fs.realpathSync(p); } catch { /* as given, like canonical() */ }
                        if (list.length === 0) this.files.delete(key);
                        else this.files.set(key, list.map((b) => b.line));
                        const states = [...this.files].flatMap(([f, lines]) =>
                            lines.map((line) => ({ verified: false, line, source: { path: f } })));
                        const push = JSON.stringify({ event: 'breakpoints', breakpoints: states }) + '\n';
                        for (const s of this.subscribers) s.write(push);
                    }
                    if (!this.ok_first) this.reply(sock, msg.id, 'ok');
                    sock.end();
                })();
                return;
            }
            case 'execute':
                // What the console held when the code arrived.
                this.executes.push({ ...msg, armed: Object.fromEntries(this.files) });
                this.reply(sock, msg.id, 'queued');
                this.reply(sock, msg.id, 'done');
                sock.end();
                return;
            default:
                this.reply(sock, msg.id, 'invalid');
        }
    }
}

// --------------------------------------------------------------------- helpers

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > ms) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
    }
}
async function settle(ms = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

// os.tmpdir() is under a symlink on macOS (/var -> /private/var), so the
// editor's paths and the console's canonical paths differ there.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-dbg-link-'));
const a_r = path.join(root, 'a.R');
const b_r = path.join(root, 'b.R');
const real = (p: string) => fs.realpathSync(p);
fs.writeFileSync(a_r, 'x <- 1\ny <- 2\nz <- 3\n');
fs.writeFileSync(b_r, 'x <- 1\ny <- 2\nz <- 3\nw <- 4\nv <- 5\n');

function line_bp(file: string, line: number): SourceBreakpoint {
    return new SourceBreakpoint({ uri: { scheme: 'file', fsPath: file }, range: { start: { line: line - 1 } } });
}
function set_breakpoints(list: Bp[]): void {
    bps.splice(0, bps.length, ...list);
    for (const l of change_listeners) l();
}

let n = 0;
async function console_at(listen = true): Promise<{ con: FakeConsole; sock: string }> {
    const dir = path.join(root, `c${n++}`);
    fs.mkdirSync(dir);
    const sock = path.join(dir, 's');
    const con = new FakeConsole(sock);
    if (listen) await con.listen();
    consoles.push(con);
    return { con, sock };
}

/** One request on the console's socket, as another client would send it. */
function raw_request(sock: string, msg: object): Promise<void> {
    return new Promise((resolve) => {
        const c = net.createConnection(sock);
        c.on('connect', () => c.write(JSON.stringify(msg) + '\n'));
        c.on('data', () => { c.end(); resolve(); });
        c.on('error', () => resolve());
    });
}
const consoles: FakeConsole[] = [];

/** A Perch-style terminal: closing it detaches; the console keeps running. */
const attached = new Set<object>();
function attach(sock: string): object {
    const terminal = { name: 'R', show() {} };
    ipc.register_console_terminal(terminal as never, sock, { owns_dir: false });
    attached.add(terminal);
    return terminal;
}
function detach(terminal: object): void {
    attached.delete(terminal);
    for (const l of close_listeners) l(terminal);
    ipc.forget_console_terminal(terminal as never);
}

const context = { subscriptions: [] as Array<{ dispose(): void }>, workspaceState: { get: () => undefined, update: async () => undefined } };
beforeAll(() => {
    register_debugger(context as never);
});
afterAll(() => {
    // console-ipc is shared by every test file in the run: leave no
    // debugger listener or registered console behind.
    for (const d of context.subscriptions) d.dispose();
    for (const t of attached) ipc.forget_console_terminal(t as never);
    for (const c of consoles) c.close();
    fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------------ tests

describe('breakpoints across a detach and reattach', () => {
    test('a breakpoint removed while detached is cleared on reattach', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(a_r, 3), line_bp(b_r, 5)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 2);
        detach(t1);

        set_breakpoints([line_bp(a_r, 3)]);
        attach(sock);
        await until(() => con.files.size === 1);
        await settle();
        expect([...con.files]).toEqual([[real(a_r), [3]]]);
    });

    test("the last breakpoint removed while detached is cleared on reattach", async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(b_r, 5)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 1);
        detach(t1);

        set_breakpoints([]);
        attach(sock);
        await until(() => con.files.size === 0);
        await settle();
        expect(con.files.size).toBe(0);
    });

    test('a symlinked spelling of a kept file is not mistaken for a stale one', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(a_r, 2)]);
        attach(sock);
        await until(() => con.files.size === 1);
        // Several more round trips: the console's summary (real paths) must
        // never clear the editor's (symlinked) file.
        set_breakpoints([line_bp(a_r, 2), line_bp(a_r, 3)]);
        await until(() => con.files.get(real(a_r))?.length === 2);
        await settle();
        expect([...con.files]).toEqual([[real(a_r), [2, 3]]]);
    });

    test('code sent right after reattach runs with the breakpoints exactly in place', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(a_r, 3), line_bp(b_r, 5)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 2);
        detach(t1);

        set_breakpoints([line_bp(a_r, 1), line_bp(a_r, 2)]);
        attach(sock);
        ipc.send_debug_program(sock, 'source("a.R")');
        await until(() => con.executes.length === 1);
        expect(con.executes[0].armed).toEqual({ [real(a_r)]: [1, 2] });
    });

    test('code sent to a new console waits until every file is armed', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(a_r, 1), line_bp(b_r, 2)]);
        attach(sock);
        ipc.send_debug_program(sock, 'source("a.R")');
        await until(() => con.executes.length === 1);
        expect(con.executes[0].armed).toEqual({ [real(a_r)]: [1], [real(b_r)]: [2] });
    });

    test('a breakpoint edit while the console starts does not release sends early', async () => {
        const { con, sock } = await console_at(false);
        set_breakpoints([line_bp(a_r, 1)]);
        attach(sock);
        set_breakpoints([line_bp(a_r, 1), line_bp(b_r, 2)]);
        ipc.send_debug_program(sock, 'source("a.R")');
        await settle(300);
        await con.listen();
        await until(() => con.executes.length === 1);
        expect(con.executes[0].armed).toEqual({ [real(a_r)]: [1], [real(b_r)]: [2] });
    });

    test("a file cleared on reattach and re-armed by another window isn't cleared again", async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(b_r, 5)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 1);
        detach(t1);
        set_breakpoints([line_bp(a_r, 1)]);
        attach(sock);
        await until(() => con.files.size === 1 && con.files.has(real(a_r)));
        await settle();
        // Another window arms b.R; then an unrelated edit here.
        await raw_request(sock, { v: 1, id: 9, op: 'breakpoints', files: { [b_r]: [{ line: 4 }] } });
        await until(() => con.files.has(real(b_r)));
        set_breakpoints([line_bp(a_r, 1), line_bp(a_r, 2)]);
        await until(() => con.files.get(real(a_r))?.length === 2);
        await settle();
        expect(con.files.get(real(b_r))).toEqual([4]);
    });

    test('a file re-added during reconciliation is still cleared when removed later', async () => {
        const { con, sock } = await console_at();
        // The console reports this file under the path the editor uses.
        const c_r = path.join(real(root), 'c.R');
        fs.writeFileSync(c_r, 'x <- 1\ny <- 2\n');
        set_breakpoints([line_bp(c_r, 2)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 1);
        detach(t1);
        set_breakpoints([]);
        attach(sock);
        // Re-added while the reattach reconciles: the stale c.R has just
        // been cleared and the clearing mirror isn't answered yet.
        await until(() => con.files.size === 0, 5_000);
        set_breakpoints([line_bp(c_r, 1)]);
        await until(() => con.files.get(c_r)?.[0] === 1);
        await settle();
        set_breakpoints([]);
        await until(() => con.files.size === 0);
        expect(con.files.size).toBe(0);
    });

    test('a console a debug session owns does not hold sends for the full timeout', async () => {
        const { con, sock } = await console_at();
        for (const l of start_listeners) l({ type: 'raven-r', id: 'live', configuration: { consoleSocket: sock } });
        set_breakpoints([line_bp(a_r, 1)]);
        attach(sock);
        ipc.send_debug_program(sock, 'source("a.R")');
        await until(() => con.executes.length === 1, 3_000);
        expect(con.executes[0].armed).toEqual({ [real(a_r)]: [1] });
    });

    test('a symlinked breakpoint re-added after its real path was cleared stays armed', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(a_r, 3)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 1);
        detach(t1);
        // Reattach with none: the link clears the console's real path.
        set_breakpoints([]);
        attach(sock);
        await until(() => con.files.size === 0);
        await settle();
        // Re-add through the editor's (symlinked) spelling.
        set_breakpoints([line_bp(a_r, 3)]);
        await until(() => con.files.size === 1);
        await settle();
        expect([...con.files]).toEqual([[real(a_r), [3]]]);
    });
});

describe('a console path the client cannot clear', () => {
    test('is cleared once per connection, without holding sends', async () => {
        const { con, sock } = await console_at();
        // Own files: this test turns one into a symlink.
        const dir = fs.mkdtempSync(path.join(root, 'swap-'));
        const s_a = path.join(dir, 'a.R');
        const s_b = path.join(dir, 'b.R');
        fs.writeFileSync(s_a, 'x <- 1\ny <- 2\n');
        fs.writeFileSync(s_b, 'x <- 1\n');
        set_breakpoints([line_bp(s_a, 2)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 1);
        detach(t1);
        // The console remembers a.R's canonical path, which now resolves to
        // b.R: clearing it clears b.R, and the console keeps reporting a.R.
        fs.rmSync(s_a);
        fs.symlinkSync(s_b, s_a);
        set_breakpoints([]);
        const warn = console.warn;
        const warned: unknown[][] = [];
        console.warn = (...args: unknown[]) => { warned.push(args); };
        const stale = path.join(real(dir), "a.R");
        const s_c = path.join(dir, 'c.R');
        fs.writeFileSync(s_c, 'x <- 1\n');
        let mirrors = 0;
        let clears = 0;
        const original = con['handle'].bind(con);
        con['handle'] = (s: net.Socket, msg: Wire) => {
            if (msg.op === 'breakpoints') {
                mirrors++;
                const files = msg.files as Record<string, unknown[]>;
                if (files[stale]?.length === 0 && ++clears === 1) {
                    // An edit while the clear is applied queues another mirror.
                    setTimeout(() => set_breakpoints([line_bp(s_c, 1)]), 0);
                }
            }
            original(s, msg);
        };
        try {
            attach(sock);
            const start = Date.now();
            ipc.send_debug_program(sock, 'source("b.R")');
            await until(() => con.executes.length === 1, 5_000);
            expect(Date.now() - start).toBeLessThan(3_000);
            await settle(900);
            // The first mirror, the one clear, the edit, and nothing after.
            expect(clears).toBe(1);
            expect(mirrors).toBeLessThanOrEqual(4);
            expect(warned.filter((a) => String(a[0]).includes('could not clear')).length).toBe(1);
        } finally {
            console.warn = warn;
        }
    }, 20_000);
});

describe('a cleared file reported before its clear lands', () => {
    test('is not logged as one the client could not clear', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([line_bp(b_r, 5)]);
        const t1 = attach(sock);
        await until(() => con.files.size === 1);
        detach(t1);
        set_breakpoints([]);
        con.ok_first = true;
        const warn = console.warn;
        const warned: unknown[][] = [];
        console.warn = (...args: unknown[]) => { warned.push(args); };
        try {
            attach(sock);
            await until(() => con.files.size === 0);
            await settle(600);
            expect(warned.filter((a) => String(a[0]).includes('could not clear'))).toEqual([]);
        } finally {
            console.warn = warn;
        }
    });
});

describe('launch with program', () => {
    async function run_program(sock: string): Promise<void> {
        const tracker = tracker_factory!.createDebugAdapterTracker({
            id: `s${n}`,
            configuration: { consoleSocket: sock, program: '/w/prog.R' },
        });
        tracker.onDidSendMessage({ type: 'response', command: 'configurationDone' });
    }

    test('an external console (consoleSocket, no terminal here) sources the program once', async () => {
        const { con, sock } = await console_at();
        await run_program(sock);
        await until(() => con.executes.length >= 1);
        await settle();
        expect(con.executes.map((e) => [e.code, e.debugProgram])).toEqual([
            ['source("/w/prog.R", echo = TRUE)', true],
        ]);
    });

    test('a console with a terminal in this window sources the program once', async () => {
        const { con, sock } = await console_at();
        attach(sock);
        await until(() => con.files.size === 0 && ipc.live_console_sockets().some(([, s]) => s === sock));
        await run_program(sock);
        await until(() => con.executes.length >= 1);
        await settle();
        expect(con.executes.length).toBe(1);
        expect(con.executes[0].debugProgram).toBe(true);
    });
});

describe('a console whose debugger is not running yet, or never will', () => {
    test("a console that can't run the debugger releases sends at once", async () => {
        const { con, sock } = await console_at();
        con.mirror_mode = 'unavailable';
        set_breakpoints([line_bp(a_r, 1)]);
        attach(sock);
        const start = Date.now();
        ipc.send_debug_program(sock, 'source("a.R")');
        await until(() => con.executes.length === 1, 5_000);
        expect(Date.now() - start).toBeLessThan(1_000);
    });

    test('breakpoints are armed when the debugger starts after the mirror gave up', async () => {
        const { con, sock } = await console_at();
        con.mirror_mode = 'not-ready';
        set_breakpoints([line_bp(a_r, 2)]);
        attach(sock);
        // The profiles outlast the link's retries (about 10 s): it gives up
        // and releases sends with nothing armed.
        ipc.send_debug_program(sock, 'source("a.R")');
        await until(() => con.executes.length === 1, 20_000);
        expect(con.files.size).toBe(0);
        // R finishes its startup profiles and the debugger starts.
        con.mirror_mode = 'ok';
        con.push({ event: 'ready' });
        await until(() => con.files.size === 1);
        expect([...con.files]).toEqual([[real(a_r), [2]]]);
    }, 30_000);
});

describe('auto-attach', () => {
    test('a stop heard twice (replayed on subscribe and pushed) starts one session', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([]);
        attach(sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === sock));
        await settle(200);
        const before = started.filter((c) => c.consoleSocket === sock).length;
        con.push({ event: 'stopped', reason: 'breakpoint' });
        con.push({ event: 'stopped', reason: 'breakpoint' });
        await settle(300);
        expect(started.filter((c) => c.consoleSocket === sock).length - before).toBe(1);
    });
});

describe('an explicit launch', () => {
    test('a stop heard while it resolves (F5 reattaching a stopped console) is left to its session', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([]);
        attach(sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === sock));
        await settle(200);
        // The console's DAP socket, which the launch waits for.
        fs.writeFileSync(path.join(path.dirname(sock), 'd'), '');
        const before = started.filter((c) => c.consoleSocket === sock).length;
        const resolving = config_providers[0].resolveDebugConfiguration(
            undefined,
            { type: 'raven-r', request: 'launch', name: 'Source R file', consoleSocket: sock },
        );
        con.push({ event: 'stopped', reason: 'breakpoint' });
        expect(await resolving).toMatchObject({ consoleSocket: sock });
        // Still before VS Code has started the launch's session.
        con.push({ event: 'stopped', reason: 'breakpoint' });
        await settle(300);
        expect(started.filter((c) => c.consoleSocket === sock).length - before).toBe(0);
        // The launch's session starts and shows the stop.
        for (const l of start_listeners) l({ type: 'raven-r', id: 'f5', configuration: { consoleSocket: sock } });
    });

    test("one console's launch doesn't hold back another console's stop", async () => {
        const a = await console_at();
        const b = await console_at();
        set_breakpoints([]);
        attach(a.sock);
        attach(b.sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === b.sock));
        await settle(200);
        // A's launch waits for A's DAP socket, which doesn't exist yet.
        const resolving = config_providers[0].resolveDebugConfiguration(
            undefined,
            { type: 'raven-r', request: 'launch', name: 'Source R file', consoleSocket: a.sock },
        );
        b.con.push({ event: 'stopped', reason: 'breakpoint' });
        await until(() => started.some((c) => c.consoleSocket === b.sock), 2_000);
        fs.writeFileSync(path.join(path.dirname(a.sock), 'd'), '');
        await resolving;
        for (const l of start_listeners) l({ type: 'raven-r', id: 'fa', configuration: { consoleSocket: a.sock } });
    });

    test("a stop held for a launch whose session never starts isn't lost", async () => {
        const { con, sock } = await console_at();
        set_breakpoints([]);
        attach(sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === sock));
        await settle(200);
        fs.writeFileSync(path.join(path.dirname(sock), 'd'), '');
        _set_launch_timeouts_for_test(600, 10_000);
        try {
            await config_providers[0].resolveDebugConfiguration(
                undefined,
                { type: 'raven-r', request: 'launch', name: 'Source R file', consoleSocket: sock },
            );
            con.push({ event: 'stopped', reason: 'breakpoint' });
            await settle(300);
            expect(started.some((c) => c.consoleSocket === sock)).toBe(false);
            // The claim expires with no session: the stop auto-attaches.
            await until(() => started.some((c) => c.consoleSocket === sock), 3_000);
        } finally {
            _set_launch_timeouts_for_test(10_000, 10_000);
        }
    });

    test('a launch still resolving keeps its console past the claim timeout', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([]);
        attach(sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === sock));
        await settle(200);
        fs.writeFileSync(path.join(path.dirname(sock), 'd'), '');
        // Saving the program takes longer than a claim lasts.
        const program = path.join(root, 'slow-save.R');
        let saved: (ok: boolean) => void = () => undefined;
        text_documents.push({ uri: { fsPath: program }, isDirty: true, save: () => new Promise((r) => { saved = r; }) });
        _set_launch_timeouts_for_test(200, 10_000);
        try {
            const resolving = config_providers[0].resolveDebugConfiguration(
                undefined,
                { type: 'raven-r', request: 'launch', name: 'Source R file', program, consoleSocket: sock },
            );
            con.push({ event: 'stopped', reason: 'breakpoint' });
            await settle(500);
            expect(started.some((c) => c.consoleSocket === sock)).toBe(false);
            saved(true);
            expect(await resolving).toMatchObject({ consoleSocket: sock });
            for (const l of start_listeners) l({ type: 'raven-r', id: 'slow', configuration: { consoleSocket: sock } });
            await settle(400);
            expect(started.some((c) => c.consoleSocket === sock)).toBe(false);
        } finally {
            text_documents.length = 0;
            _set_launch_timeouts_for_test(10_000, 10_000);
        }
    });

    test("a launch that has chosen its console doesn't hold back another console's stop", async () => {
        const b = await console_at();
        const a = await console_at();
        set_breakpoints([]);
        attach(b.sock);
        attach(a.sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === a.sock));
        await settle(200);
        // F5 with no console given picks the newest (A) and waits for its
        // DAP socket, which doesn't exist yet.
        const resolving = config_providers[0].resolveDebugConfiguration(
            undefined,
            { type: 'raven-r', request: 'launch', name: 'R console' },
        );
        await settle(100);
        b.con.push({ event: 'stopped', reason: 'breakpoint' });
        await until(() => started.some((c) => c.consoleSocket === b.sock), 2_000);
        fs.writeFileSync(path.join(path.dirname(a.sock), 'd'), '');
        expect(await resolving).toMatchObject({ consoleSocket: a.sock });
        for (const l of start_listeners) l({ type: 'raven-r', id: 'f5a', configuration: { consoleSocket: a.sock } });
    });

    test('a held stop that R has moved past is dropped', async () => {
        const { con, sock } = await console_at();
        set_breakpoints([]);
        attach(sock);
        await until(() => ipc.live_console_sockets().some(([, s]) => s === sock));
        await settle(200);
        // The launch waits for a DAP socket that never appears, and fails.
        _set_launch_timeouts_for_test(10_000, 600);
        try {
            const resolving = config_providers[0].resolveDebugConfiguration(
                undefined,
                { type: 'raven-r', request: 'launch', name: 'Source R file', consoleSocket: sock },
            );
            con.push({ event: 'stopped', reason: 'breakpoint' });
            await settle(100);
            con.push({ event: 'running' });
            expect(await resolving).toBeUndefined();
            await settle(300);
            expect(started.some((c) => c.consoleSocket === sock)).toBe(false);
        } finally {
            _set_launch_timeouts_for_test(10_000, 10_000);
        }
    });
});

describe('with the R console turned off', () => {
    test('a raven-r launch configuration says why instead of failing to find an adapter', async () => {
        const ctx = { subscriptions: [] as Array<{ dispose(): void }> };
        const n_before = config_providers.length;
        register_debugger_unavailable(ctx as never);
        const provider = config_providers[n_before];
        expect(provider).toBeDefined();
        const result = await provider.resolveDebugConfiguration(undefined, { type: 'raven-r', request: 'launch', name: 'x' });
        expect(result).toBeUndefined();
        expect(error_messages.at(-1)).toContain('raven.rConsole.activation');
        for (const d of ctx.subscriptions) d.dispose();
    });
});
