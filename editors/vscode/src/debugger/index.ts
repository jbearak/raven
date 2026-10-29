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
import { get_or_create_r_terminal } from '../send-to-r/r-terminal-manager';

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
 * What the extension tells a console about breakpoints while no session
 * exists. Every file in `previous` without breakpoints now is sent as empty,
 * which clears it.
 */
function mirror_payload(previous: Set<string>): { msg: object; files: Set<string> } {
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
    const now = new Set(Object.keys(files));
    for (const p of previous) if (!now.has(p)) files[p] = [];
    const filters = context_ref?.workspaceState.get<string[]>(FILTERS_KEY, []) ?? [];
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

/** The control connection to one console: stop events in, breakpoint mirror out. */
class ConsoleLink {
    /** The console's line breakpoint states, as last pushed. */
    states: BreakpointState[] = [];
    private control: net.Socket | null = null;
    /**
     * Every file any mirror has carried breakpoints for. Never shrinks, so a
     * removal is sent even when the mirror that added the file is still in
     * flight (re-sending an empty file is harmless).
     */
    private mirrored = new Set<string>();
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
            this.mirror();
        });
        sock.on('data', (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let msg: { event?: string; breakpoints?: BreakpointState[] };
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.event === 'stopped') void auto_attach(this.ipc);
                if (msg.event === 'breakpoints') {
                    this.states = msg.breakpoints ?? [];
                    update_status();
                }
            }
        });
        sock.on('error', () => undefined);
        sock.on('close', () => { this.control = null; });
    }

    /**
     * Send the current breakpoints (retrying while the console is still
     * starting). A change while a mirror is in flight is sent after it, built
     * from the breakpoints as they are then.
     */
    mirror(): void {
        if (this.in_flight) {
            this.again = true;
            return;
        }
        this.in_flight = true;
        this.send_mirror(0);
    }

    private send_mirror(attempt: number): void {
        const finish = () => {
            this.in_flight = false;
            this.mirrored_once();
            if (this.again) {
                this.again = false;
                this.mirror();
            }
        };
        if (this.closed || !fs.existsSync(this.ipc)) return finish();
        const { msg, files } = mirror_payload(this.mirrored);
        for (const f of files) this.mirrored.add(f);
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
                finish();
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
    const terminal = await get_or_create_r_terminal();
    terminal.show(true);
    return console_socket_of(terminal);
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
                    "Raven: the R debugger needs Raven's R console (raven.rTerminal.program = \"raven\").",
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
                    const terminal = live_console_sockets().find(([, sock]) => sock === ipc)?.[0];
                    if (!terminal) return;
                    terminal.show(true);
                    send_debug_program(ipc, `source(${JSON.stringify(program)}, echo = TRUE)`);
                }
            },
            onWillReceiveMessage(m: { command?: string; arguments?: { filters?: string[] } }) {
                if (m.command === 'setExceptionBreakpoints') {
                    void context_ref?.workspaceState.update(FILTERS_KEY, m.arguments?.filters ?? []);
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
