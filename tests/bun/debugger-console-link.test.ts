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
        registerDebugConfigurationProvider: disposable,
        registerDebugAdapterDescriptorFactory: disposable,
        registerDebugAdapterTrackerFactory: (_t: string, f: typeof tracker_factory) => {
            tracker_factory = f;
            return disposable();
        },
        onDidChangeBreakpoints: (cb: () => void) => { change_listeners.push(cb); return disposable(); },
        onDidStartDebugSession: (cb: (s: unknown) => void) => { start_listeners.push(cb); return disposable(); },
        onDidTerminateDebugSession: disposable,
        startDebugging: async () => true,
    },
    window: {
        activeTerminal: undefined,
        activeTextEditor: undefined,
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        onDidChangeActiveTerminal: disposable,
        onDidCloseTerminal: (cb: (t: unknown) => void) => { close_listeners.push(cb); return disposable(); },
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showWarningMessage: async () => undefined,
    },
    workspace: {
        workspaceFolders: undefined,
        textDocuments: [],
        getConfiguration: () => ({ get: (_k: string, fallback?: unknown) => fallback }),
    },
}));

const { register_debugger } = await import('../../editors/vscode/src/debugger/index');
const ipc = await import('../../editors/vscode/src/send-to-r/console-ipc');

// --------------------------------------------------------------- fake console

type Wire = Record<string, unknown> & { op?: string; id?: number };

class FakeConsole {
    /** canonical path -> lines */
    files = new Map<string, number[]>();
    executes: Wire[] = [];
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
                const files = (msg.files ?? {}) as Record<string, Array<{ line: number }>>;
                // Like set_file_breakpoints: one file at a time, each
                // followed by a full summary (with a gap, so a client that
                // acts on a summary before the reply is caught).
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
                    this.reply(sock, msg.id, 'ok');
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
