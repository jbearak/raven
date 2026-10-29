import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    console_socket_of,
    live_console_sockets,
    on_console_registered,
} from '../send-to-r/console-ipc';
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
 * - A user disconnect suppresses auto-attach for that console for 30 s.
 */

export const DEBUG_TYPE = 'raven-r';
const FILTERS_KEY = 'raven.debugger.exceptionFilters';
const R_FILE = /\.(r|rmd|rmarkdown|qmd)$/i;
const DETACH_COOLDOWN_MS = 30_000;
const SOCKET_WAIT_MS = 10_000;

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

let context_ref: vscode.ExtensionContext | null = null;
const sessions = new Map<string, vscode.DebugSession>();
const ended_by_console = new Set<string>();
const detached_until = new Map<string, number>();
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

/** What the extension tells a console about breakpoints while no session exists. */
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

/** The control connection to one console: stop events in, breakpoint mirror out. */
class ConsoleLink {
    private control: net.Socket | null = null;
    private mirrored = new Set<string>();
    private closed = false;

    constructor(readonly terminal: vscode.Terminal, readonly ipc: string) {
        void this.connect();
    }

    private async connect(): Promise<void> {
        if (!(await wait_for_file(this.ipc, SOCKET_WAIT_MS)) || this.closed) return;
        const sock = net.createConnection(this.ipc);
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
                let msg: { event?: string };
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.event === 'stopped') void auto_attach(this.ipc);
            }
        });
        sock.on('error', () => undefined);
        sock.on('close', () => { this.control = null; });
    }

    /** Send the current breakpoints (retrying while the console is still starting). */
    mirror(attempt = 0): void {
        if (this.closed || !fs.existsSync(this.ipc)) return;
        const { msg, files } = mirror_payload(this.mirrored);
        const sock = net.createConnection(this.ipc);
        sock.setEncoding('utf8');
        let reply = '';
        sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
        sock.on('data', (d: string) => {
            reply += d;
            if (!reply.includes('\n')) return;
            sock.end();
            if (reply.includes('"not-ready"')) {
                if (attempt < 40) setTimeout(() => this.mirror(attempt + 1), 250);
            } else {
                this.mirrored = files;
            }
        });
        sock.on('error', () => undefined);
    }

    dispose(): void {
        this.closed = true;
        this.control?.destroy();
    }
}

async function auto_attach(ipc: string): Promise<void> {
    if (!debugger_enabled() || attach_policy() === 'never') return;
    if (sessions.has(ipc)) return;
    if ((detached_until.get(ipc) ?? 0) > Date.now()) return;
    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
        type: DEBUG_TYPE,
        request: 'attach',
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
            config = { type: DEBUG_TYPE, request: 'attach', name: 'R console' };
        }
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
        return new vscode.DebugAdapterNamedPipeServer(dap_socket_for(ipc));
    },
};

const tracker_factory: vscode.DebugAdapterTrackerFactory = {
    createDebugAdapterTracker(session) {
        const ipc: string = session.configuration.consoleSocket;
        return {
            onDidSendMessage(m: { type?: string; event?: string }) {
                if (m.type === 'event' && m.event === 'terminated') ended_by_console.add(session.id);
            },
            onWillReceiveMessage(m: { command?: string; arguments?: { filters?: string[] } }) {
                if (m.command === 'disconnect' && !ended_by_console.has(session.id)) {
                    detached_until.set(ipc, Date.now() + DETACH_COOLDOWN_MS);
                }
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
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, configuration_provider),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, descriptor_factory),
        vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, tracker_factory),
        vscode.debug.onDidChangeBreakpoints(mirror_all),
        vscode.debug.onDidStartDebugSession((s) => {
            if (s.type === DEBUG_TYPE && s.configuration.consoleSocket) {
                sessions.set(s.configuration.consoleSocket, s);
            }
        }),
        vscode.debug.onDidTerminateDebugSession((s) => {
            if (s.type !== DEBUG_TYPE) return;
            if (sessions.get(s.configuration.consoleSocket) === s) sessions.delete(s.configuration.consoleSocket);
            ended_by_console.delete(s.id);
            // Filters may have changed in the session; keep consoles in step.
            mirror_all();
        }),
        vscode.commands.registerCommand('raven.debugger.start', async () => {
            await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
                type: DEBUG_TYPE,
                request: 'attach',
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
