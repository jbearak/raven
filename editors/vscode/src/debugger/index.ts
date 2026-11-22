import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    console_socket_of,
    gate_sends,
    live_console_sockets,
    on_console_registered,
    send_debug_program,
} from '../send-to-r/console-ipc';
import { socket_endpoint } from '../send-to-r/console-endpoint';
import { get_or_create_raven_console } from '../send-to-r/r-terminal-manager';

/**
 * VS Code side of Raven's R debugger. The debug adapter itself runs inside
 * `raven console` (it owns R; see crates/raven/src/console/dap/mod.rs and
 * docs/superpowers/specs/2026-10-29-r-debugger-design.md §2); this module
 * connects VS Code to it.
 *
 * Invariants:
 * - Attach only when R stops (owner decision, design §2.1): each console
 *   pushes `stopped` over its control connection, and a session is started
 *   then. The console ends the session (`terminated`) when R returns to the
 *   top-level prompt; that end is not a user detach.
 * - Breakpoints are mirrored to every console while no session exists, so
 *   code run before the first stop is already instrumented. VS Code's own
 *   `setBreakpoints` takes over inside a session; both carry the same set.
 *   Each connection to a console makes the console's set exactly the
 *   editor's, clearing files armed by an earlier connection (`ConsoleLink`).
 * - Sessions the extension starts are `launch` sessions, so the toolbar shows
 *   Stop, which quits the browser (`Q`), as stopping a Python or Node
 *   program does. A user-configured `attach` shows Disconnect, which lets R
 *   continue (`c`). The console ignores the `disconnect` VS Code sends after
 *   a `terminated` it sent itself.
 * - A stop pushed while this console's previous session is still tearing
 *   down attaches as soon as that session is gone.
 * - F5 with an R file open and no launch.json sources that file in the
 *   console (a `launch` with `program`); the session itself is the same
 *   attach to the console.
 */

export const DEBUG_TYPE = 'raven-r';
const FILTERS_KEY = 'raven.debugger.exceptionFilters';
const R_FILE = /\.(r|rmd|rmarkdown|qmd)$/i;
const SOCKET_WAIT_MS = 10_000;
/** Longest a new console's first send waits for its breakpoints. */
const MIRROR_GATE_MS = 15_000;

/** The console's DAP socket lives next to its IPC socket. */
export function dap_socket_for(ipc_socket: string): string {
    return path.join(path.dirname(ipc_socket), 'd');
}

export function debugger_enabled(): boolean {
    return vscode.workspace.getConfiguration('raven.debugger').get<boolean>('enabled', true);
}

function attach_policy(): 'onStop' | 'never' {
    return vscode.workspace.getConfiguration('raven.debugger').get<'onStop' | 'never'>('attach', 'onStop');
}

function just_my_code(): boolean {
    return vscode.workspace.getConfiguration('raven.debugger').get<boolean>('justMyCode', true);
}

let context_ref: vscode.ExtensionContext | null = null;
const sessions = new Map<string, vscode.DebugSession>();
/** Consoles that stopped while their previous session was ending. */
const attach_after_end = new Set<string>();
/** Sessions the console has ended (`terminated`) that VS Code is tearing down. */
const ending = new Set<string>();
const links = new Map<string, ConsoleLink>();

function wait_for_file(file: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        const start = Date.now();
        const poll = () => {
            if (fs.existsSync(file)) return resolve(true);
            if (Date.now() - start > ms) return resolve(false);
            setTimeout(poll, 100);
        };
        poll();
    });
}

/**
 * The exception filters to mirror: the last set a session used, or, before
 * any session has run in this workspace, the adapter's defaults (Uncaught
 * errors on; crates/raven/src/console/dap/mod.rs). A stored `[]` is the
 * user turning them all off and is kept.
 */
export function exception_filters(stored: string[] | undefined): string[] {
    return stored ?? ['error'];
}

/** The editor's enabled R line breakpoints by file, and its function breakpoints. */
function editor_breakpoints(): { files: Record<string, object[]>; functions: string[] } {
    const files: Record<string, object[]> = {};
    const functions: string[] = [];
    for (const bp of vscode.debug.breakpoints) {
        if (!bp.enabled) continue;
        if (bp instanceof vscode.SourceBreakpoint) {
            const uri = bp.location.uri;
            if (uri.scheme !== 'file' || !R_FILE.test(uri.fsPath)) continue;
            (files[uri.fsPath] ??= []).push({
                line: bp.location.range.start.line + 1,
                condition: bp.condition ?? '',
                hitCondition: bp.hitCondition ?? '',
                logMessage: bp.logMessage ?? '',
            });
        } else if (bp instanceof vscode.FunctionBreakpoint) {
            functions.push(bp.functionName);
        }
    }
    return { files, functions };
}

/**
 * Every spelling under which the console may report a file the editor has
 * breakpoints in: the editor's path and its real path (the console reports
 * `canonicalize`d paths; macOS's /tmp and /var are symlinks).
 */
function with_real_paths(files: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const f of files) {
        out.add(f);
        try { out.add(fs.realpathSync.native(f)); } catch { /* file gone: the console keeps the path as given */ }
    }
    return out;
}

/**
 * What the extension tells a console about breakpoints while no session
 * exists. Every file in `previous` without breakpoints now is sent as empty,
 * which clears it.
 */
function mirror_payload(previous: Set<string>): { msg: object; files: Set<string> } {
    const { files, functions } = editor_breakpoints();
    const now = new Set(Object.keys(files));
    // Another spelling of a file in `now` (a symlink, or the console's
    // canonical path) must not clear what `now` sets.
    const kept = with_real_paths(now);
    for (const p of previous) {
        if (kept.has(p)) continue;
        let real = p;
        try { real = fs.realpathSync.native(p); } catch { /* as given */ }
        if (!kept.has(real)) files[p] = [];
    }
    const filters = exception_filters(context_ref?.workspaceState.get<string[]>(FILTERS_KEY));
    return {
        msg: { v: 1, id: 0, op: 'breakpoints', files, functions, exceptionFilters: filters },
        files: now,
    };
}

interface BreakpointState {
    verified: boolean;
    line: number;
    message?: string;
    source: { path: string };
}

let status_item: vscode.StatusBarItem | null = null;

/**
 * While no session exists, the status bar summarizes the active console's
 * line breakpoints: how many are bound, and why the others aren't (design
 * §5.5). Inside a session the gutter and Breakpoints view show this.
 */
function update_status(): void {
    if (!status_item) return;
    const active = vscode.window.activeTerminal;
    const ipc = (active && console_socket_of(active)) ?? [...links.keys()].pop();
    const states = (ipc && links.get(ipc)?.states) || [];
    if (states.length === 0 || (ipc && sessions.has(ipc))) {
        status_item.hide();
        return;
    }
    const bound = states.filter((b) => b.verified).length;
    status_item.text = `$(debug-breakpoint) R ${bound}/${states.length}`;
    const md = new vscode.MarkdownString(`**R breakpoints:** ${bound} of ${states.length} bound\n\n`);
    for (const b of states.filter((s) => !s.verified)) {
        const where = `${path.basename(b.source.path)}:${b.line}`;
        md.appendMarkdown(`- \`${where}\`: ${b.message ?? 'not bound'}\n`);
    }
    status_item.tooltip = md;
    status_item.show();
}

/**
 * A path that is never an R file, sent (as empty) in every mirror. The
 * console pushes its full line-breakpoint summary only after it applies a
 * file entry, so this makes every mirror answer with one, even when the
 * editor has no line breakpoints left.
 */
function probe_path(ipc: string): string {
    return path.join(path.dirname(ipc), 'breakpoint-probe');
}

/**
 * The control connection to one console: stop events in, breakpoint mirror
 * out.
 *
 * Each connection brings the console's breakpoints to exactly the editor's,
 * including files that no longer have any. A console can outlive the
 * connection that armed it (a Perch console is detached and reattached; a
 * window reloads), and the IPC protocol only replaces breakpoints file by
 * file, so the link can't know from its own history which files to clear.
 * It asks the console instead: every mirror carries `probe_path`, the
 * console answers with its summary, and any file in that summary the editor
 * has no breakpoints in is cleared by the next mirror (`reconcile`). This
 * happens once per connection, before sends to the console are released;
 * later summaries aren't acted on, so two windows sharing a console don't
 * clear each other's breakpoints back and forth.
 */
class ConsoleLink {
    /** The console's line breakpoint states, as last pushed. */
    states: BreakpointState[] = [];
    private control: net.Socket | null = null;
    /**
     * Every file any mirror has carried breakpoints for, plus every file the
     * console reported that the editor doesn't have. Never shrinks, so a
     * removal is sent even when the mirror that added the file is still in
     * flight (re-sending an empty file is harmless).
     */
    private mirrored = new Set<string>();
    /** The console has pushed a summary on this connection. */
    private heard = false;
    private reprobed = false;
    /**
     * The control connection is subscribed. No mirror goes out before, so
     * the summary it provokes reaches this connection and an edit made
     * while the console starts doesn't release sends early.
     */
    private subscribed = false;
    /** Files only the console's summary named; cleared, then forgotten. */
    private discovered = new Set<string>();
    /** A mirror on this connection has been applied (`ok`). */
    private applied = false;
    /** The initial reconciliation is done and sends are released. */
    private reconciled = false;
    /** One mirror at a time, so the console applies them in order. */
    private in_flight = false;
    private again = false;
    private closed = false;
    private mirrored_once: () => void = () => undefined;

    constructor(readonly terminal: vscode.Terminal, readonly ipc: string) {
        // Code sent to a console before it knows the breakpoints would run
        // uninstrumented; hold sends until the first mirror lands.
        gate_sends(ipc, new Promise<void>((resolve) => {
            this.mirrored_once = resolve;
            setTimeout(resolve, MIRROR_GATE_MS);
        }));
        void this.connect();
    }

    private async connect(): Promise<void> {
        if (!(await wait_for_file(this.ipc, SOCKET_WAIT_MS)) || this.closed) return;
        const sock = net.createConnection(socket_endpoint(this.ipc));
        sock.setEncoding('utf8');
        this.control = sock;
        let buf = '';
        sock.on('connect', () => {
            sock.write(JSON.stringify({ v: 1, id: 0, op: 'subscribe' }) + '\n');
        });
        sock.on('data', (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let msg: { event?: string; status?: string; breakpoints?: BreakpointState[] };
                try { msg = JSON.parse(line); } catch { continue; }
                if (!this.subscribed && msg.status !== undefined) {
                    this.subscribed = true;
                    this.mirror();
                }
                if (msg.event === 'stopped') void auto_attach(this.ipc);
                if (msg.event === 'breakpoints') {
                    this.heard = true;
                    this.states = msg.breakpoints ?? [];
                    update_status();
                    this.reconcile();
                }
            }
        });
        sock.on('error', () => undefined);
        sock.on('close', () => { this.control = null; });
    }

    /**
     * Clear the files the console reported that the editor has no
     * breakpoints in. Inside a session VS Code's `setBreakpoints` own the
     * console's set; the mirror at the session's end reconciles.
     */
    private reconcile(): void {
        if (this.closed || this.reconciled) return;
        if (sessions.has(this.ipc)) {
            // The session owns the console's breakpoints: don't hold sends
            // for it. The mirror at its end reconciles.
            if (this.applied && !this.in_flight) this.mirrored_once();
            return;
        }
        const wanted = with_real_paths(Object.keys(editor_breakpoints().files));
        const stale = this.states.map((s) => s.source.path).filter((p) => !wanted.has(p));
        if (stale.length > 0) {
            for (const p of stale) {
                this.mirrored.add(p);
                this.discovered.add(p);
            }
            this.mirror();
        } else if (this.applied && !this.in_flight) {
            // The console pushes a summary after each file it applies, so
            // only a summary seen once a whole mirror is in counts.
            this.release();
        }
    }

    /** Sends held for this console may run now. */
    private release(): void {
        this.reconciled = true;
        // Confirmed cleared; another window sharing this console may arm
        // them again, and this link's later mirrors mustn't clear them.
        // A file the editor has breakpoints in again stays tracked.
        const kept = Object.keys(editor_breakpoints().files);
        for (const p of this.discovered) if (!kept.includes(p)) this.mirrored.delete(p);
        this.discovered.clear();
        this.mirrored_once();
    }

    /**
     * Send the current breakpoints (retrying while the console is still
     * starting). A change while a mirror is in flight is sent after it, built
     * from the breakpoints as they are then.
     */
    mirror(): void {
        if (!this.subscribed) return;
        if (this.in_flight) {
            this.again = true;
            return;
        }
        this.in_flight = true;
        this.send_mirror(0);
    }

    private send_mirror(attempt: number): void {
        const finish = (applied = false) => {
            this.in_flight = false;
            // A change made meanwhile goes first, so `reconcile` below
            // doesn't release sends while it is still to be applied.
            if (this.again) {
                this.again = false;
                this.mirror();
            }
            if (!applied) {
                // No summary will follow; don't hold sends for one.
                this.mirrored_once();
            } else if (this.heard) {
                this.applied = true;
                this.reconcile();
            } else {
                this.applied = true;
                // The console answers an applied mirror with its summary,
                // which `reconcile` uses. Not heard yet: give it a moment,
                // then mirror once more in case the subscription raced;
                // after that, stop holding sends for it.
                setTimeout(() => {
                    if (this.heard || this.closed) return;
                    if (this.reprobed) return this.release();
                    this.reprobed = true;
                    this.mirror();
                }, 1_000);
            }
        };
        if (this.closed || !fs.existsSync(this.ipc)) return finish();
        const { msg, files } = mirror_payload(this.mirrored);
        for (const f of files) this.mirrored.add(f);
        (msg as { files: Record<string, object[]> }).files[probe_path(this.ipc)] = [];
        const sock = net.createConnection(socket_endpoint(this.ipc));
        sock.setEncoding('utf8');
        let reply = '';
        let done = false;
        sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
        sock.on('data', (d: string) => {
            reply += d;
            if (done || !reply.includes('\n')) return;
            done = true;
            sock.end();
            if (reply.includes('"not-ready"') && attempt < 40) {
                // Rebuilt on retry, so it carries any change made meanwhile.
                this.again = false;
                setTimeout(() => this.send_mirror(attempt + 1), 250);
            } else {
                finish(reply.includes('"ok"'));
            }
        });
        const fail = () => {
            if (!done) {
                done = true;
                sock.destroy();
                finish();
            }
        };
        sock.on('error', fail);
        // The console answers at once; one that doesn't mustn't hold up
        // every later mirror.
        sock.setTimeout(5_000, fail);
    }

    dispose(): void {
        this.mirrored_once();
        this.closed = true;
        this.control?.destroy();
        this.states = [];
        update_status();
    }
}

async function auto_attach(ipc: string): Promise<void> {
    if (!debugger_enabled() || attach_policy() === 'never') return;
    const current = sessions.get(ipc);
    if (current) {
        // A live session receives the stop itself; one that is ending
        // won't, so attach again once it has gone.
        if (ending.has(current.id)) attach_after_end.add(ipc);
        return;
    }
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'R console',
        consoleSocket: ipc,
    });
}

/** The console a new session should attach to, opening one if needed. */
async function choose_console(): Promise<string | undefined> {
    const active = vscode.window.activeTerminal;
    const from_active = active ? console_socket_of(active) : undefined;
    if (from_active) return from_active;
    const live = live_console_sockets();
    if (live.length > 0) return live[live.length - 1][1];
    const terminal = await get_or_create_raven_console();
    terminal.show(true);
    return console_socket_of(terminal);
}

/** One request on a console's socket; resolves with its `status`. */
function console_request(ipc: string, op: string): Promise<string> {
    return new Promise((resolve) => {
        const sock = net.createConnection(socket_endpoint(ipc));
        sock.setEncoding('utf8');
        let reply = '';
        const done = (status: string) => {
            sock.destroy();
            resolve(status);
        };
        sock.on('connect', () => sock.write(JSON.stringify({ v: 1, id: 0, op }) + '\n'));
        sock.on('data', (d: string) => {
            reply += d;
            const nl = reply.indexOf('\n');
            if (nl < 0) return;
            try {
                done(String((JSON.parse(reply.slice(0, nl)) as { status?: unknown }).status ?? ''));
            } catch {
                done('');
            }
        });
        sock.on('error', () => done(''));
        sock.setTimeout(5_000, () => done(''));
    });
}

/**
 * Inspect Last Error: the console opens a browser in the saved frames of the
 * last error that printed a traceback, and the debugger attaches to it as to
 * any stop (with `attach: never`, this starts the session itself).
 */
async function inspect_last_error(): Promise<void> {
    const active = vscode.window.activeTerminal;
    const ipc = (active && console_socket_of(active)) ?? live_console_sockets().pop()?.[1];
    if (!ipc) {
        void vscode.window.showInformationMessage("Raven: no R console is open.");
        return;
    }
    const status = await console_request(ipc, 'inspect');
    const why: Record<string, string> = {
        none: 'Raven: there is no error to inspect. Inspect Last Error opens an error that printed a traceback.',
        busy: 'Raven: R is busy. Inspect the last error once it is back at the prompt.',
        stopped: 'Raven: R is already stopped in the debugger.',
        '': "Raven: this R console can't inspect errors. Open a new R console with the debugger enabled.",
    };
    if (status !== 'ok') {
        void vscode.window.showInformationMessage(why[status] ?? why['']);
        return;
    }
    if (attach_policy() === 'never') {
        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
            type: DEBUG_TYPE,
            request: 'launch',
            name: 'R console',
            consoleSocket: ipc,
        });
    }
}

const configuration_provider: vscode.DebugConfigurationProvider = {
    async resolveDebugConfiguration(_folder, config) {
        if (!debugger_enabled()) {
            void vscode.window.showInformationMessage(
                'Raven: the R debugger is turned off (raven.debugger.enabled).',
            );
            return undefined;
        }
        if (!config.type && !config.request) {
            // F5 with no launch.json: source the open R script, if any.
            const doc = vscode.window.activeTextEditor?.document;
            config = doc && doc.uri.scheme === 'file' && /\.r$/i.test(doc.uri.fsPath)
                ? { type: DEBUG_TYPE, request: 'launch', name: 'Source R file', program: doc.uri.fsPath }
                : { type: DEBUG_TYPE, request: 'launch', name: 'R console' };
        }
        if (config.request === 'launch' && config.program) {
            if (config.program === '${file}') {
                config.program = vscode.window.activeTextEditor?.document.uri.fsPath;
                if (!config.program) {
                    void vscode.window.showErrorMessage('Raven: no R file is open to run.');
                    return undefined;
                }
            }
            const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === config.program);
            if (open?.isDirty && !(await open.save())) return undefined;
        }
        config.justMyCode ??= just_my_code();
        if (!config.consoleSocket) {
            const ipc = await choose_console();
            if (!ipc) {
                void vscode.window.showErrorMessage(
                    "Raven: the R debugger needs Raven's R console, and it couldn't open one.",
                );
                return undefined;
            }
            config.consoleSocket = ipc;
        }
        if (!(await wait_for_file(dap_socket_for(config.consoleSocket), SOCKET_WAIT_MS))) {
            void vscode.window.showErrorMessage(
                "Raven: this R console wasn't started with the debugger. Close it and open a new R console.",
            );
            return undefined;
        }
        return config;
    },
};

const descriptor_factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor(session) {
        const ipc: string | undefined = session.configuration.consoleSocket;
        if (!ipc) throw new Error('No R console to attach to.');
        return new vscode.DebugAdapterNamedPipeServer(socket_endpoint(dap_socket_for(ipc)));
    },
};

const tracker_factory: vscode.DebugAdapterTrackerFactory = {
    createDebugAdapterTracker(session) {
        const ipc: string = session.configuration.consoleSocket;
        const program: string | undefined = session.configuration.program;
        return {
            onDidSendMessage(m: { type?: string; command?: string; event?: string }) {
                if (m.type === 'event' && m.event === 'terminated') ending.add(session.id);
                // Run the program once the session's breakpoints are in.
                if (program && m.type === 'response' && m.command === 'configurationDone') {
                    // A console started outside this window (`consoleSocket`
                    // in launch.json) has no terminal here; the program
                    // still goes to it over its socket.
                    live_console_sockets().find(([, sock]) => sock === ipc)?.[0].show(true);
                    send_debug_program(ipc, `source(${JSON.stringify(program)}, echo = TRUE)`);
                }
            },
            onWillReceiveMessage(m: { command?: string; arguments?: { filters?: string[] } }) {
                if (m.command === 'setExceptionBreakpoints') {
                    // Other consoles pick the change up now, not when this
                    // session ends.
                    void context_ref?.workspaceState
                        .update(FILTERS_KEY, m.arguments?.filters ?? [])
                        .then(mirror_all);
                }
            },
        };
    },
};

function mirror_all(): void {
    for (const link of links.values()) link.mirror();
}

export function register_debugger(context: vscode.ExtensionContext): void {
    context_ref = context;
    status_item = vscode.window.createStatusBarItem('raven.debugger.breakpoints', vscode.StatusBarAlignment.Left, 50);
    status_item.name = 'R breakpoints';
    status_item.command = 'workbench.debug.action.focusBreakpointsView';
    context.subscriptions.push(
        status_item,
        vscode.window.onDidChangeActiveTerminal(update_status),
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configuration_provider),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, descriptor_factory),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, tracker_factory),
        vscode.debug.onDidChangeBreakpoints(mirror_all),
        vscode.debug.onDidStartDebugSession((s) => {
            if (s.type === DEBUG_TYPE && s.configuration.consoleSocket) {
                sessions.set(s.configuration.consoleSocket, s);
                update_status();
            }
        }),
        vscode.debug.onDidTerminateDebugSession((s) => {
            if (s.type !== DEBUG_TYPE) return;
            const ipc: string = s.configuration.consoleSocket;
            if (sessions.get(ipc) === s) sessions.delete(ipc);
            ending.delete(s.id);
            update_status();
            // The console replays a live stop to the next session.
            if (attach_after_end.delete(ipc)) void auto_attach(ipc);
            // Filters may have changed in the session; keep consoles in step.
            mirror_all();
        }),
        vscode.commands.registerCommand('raven.debugger.start', async () => {
            await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
                type: DEBUG_TYPE,
                request: 'launch',
                name: 'R console',
            });
        }),
        vscode.commands.registerCommand('raven.debugger.inspectLastError', inspect_last_error),
        vscode.commands.registerCommand(
            'raven.debugger.viewData',
            async (arg?: { variable?: { evaluateName?: string; name?: string } }) => {
                const session = vscode.debug.activeDebugSession;
                const expr = arg?.variable?.evaluateName;
                if (!session || session.type !== DEBUG_TYPE) return;
                if (!expr) {
                    void vscode.window.showInformationMessage(
                        `Raven: can't open ${arg?.variable?.name ?? 'this value'} in the data viewer (it has no R expression).`,
                    );
                    return;
                }
                // `activeStackItem` (VS Code 1.90+) is newer than the API
                // version this extension compiles against; read it if present.
                const dbg = vscode.debug as unknown as { activeStackItem?: { frameId?: number } };
                const frameId = dbg.activeStackItem?.frameId;
                try {
                    await session.customRequest('evaluate', { expression: `View(${expr})`, frameId, context: 'repl' });
                } catch (e) {
                    void vscode.window.showErrorMessage(`Raven: ${e instanceof Error ? e.message : String(e)}`);
                }
            },
        ),
        on_console_registered((terminal, ipc) => {
            if (!debugger_enabled() || links.has(ipc)) return;
            links.set(ipc, new ConsoleLink(terminal, ipc));
        }),
        vscode.window.onDidCloseTerminal((t) => {
            for (const [ipc, link] of links) {
                if (link.terminal === t) {
                    link.dispose();
                    links.delete(ipc);
                }
            }
        }),
        new vscode.Disposable(() => {
            for (const link of links.values()) link.dispose();
            links.clear();
        }),
    );
}
