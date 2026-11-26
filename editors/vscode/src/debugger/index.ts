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
 * - One session per console at a time. A launch holds its console's stops
 *   back while it resolves and for `LAUNCH_CLAIM_MS` after; a stop that
 *   attaches by itself once that has run out (the launch's `preLaunchTask`
 *   is slow) keeps the console, and the launch is refused (`admit_launch`).
 * - F5 with an R file open and no launch.json sources that file in the
 *   console (a `launch` with `program`); the session itself is the same
 *   attach to the console.
 * - The `raven-r` debugger and the R breakpoint contributions are enabled
 *   only while `raven.rConsoleEnabled` holds (package.json `when`). VS Code
 *   still resolves an explicit launch.json `raven-r` configuration through
 *   its providers, so with the console off `register_debugger_unavailable`
 *   answers it with a message instead of a missing-adapter error.
 */

export const DEBUG_TYPE = 'raven-r';
const FILTERS_KEY = 'raven.debugger.exceptionFilters';
const R_FILE = /\.(r|rmd|rmarkdown|qmd)$/i;
let SOCKET_WAIT_MS = 10_000;
/**
 * How long a new console's first send waits for its breakpoints, and how
 * much longer it waits, once, for a mirror that is on its way to the console
 * when that time is up (see `ConsoleLink.gate_deadline`).
 */
let MIRROR_GATE_MS = 15_000;

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
/**
 * Consoles a session is being started for (a stop can be heard twice), each
 * with the number of that automatic attach (`auto_attach_seq`).
 */
const attaching = new Map<string, number>();
/**
 * Consoles a launch (F5, launch.json, Raven commands) has chosen: held while
 * the launch resolves, then until its session starts or the claim expires
 * (the timer). A stop heard meanwhile is the launch's to show: F5 can
 * connect to a stopped console started elsewhere, whose subscription then
 * replays the stop, and the console replays it to the launch's session too.
 */
const launch_claims = new Map<string, { holds: number; timer?: ReturnType<typeof setTimeout> }>();
let LAUNCH_CLAIM_MS = 10_000;
/** Launches still choosing their console, which may be any of them. */
let launches_choosing = 0;
/**
 * Consoles whose stop was held back for a claim or a launch still choosing.
 * Reconsidered once neither applies, unless a session for it has started:
 * the console pushes a stop only once.
 */
const deferred_stops = new Set<string>();

function claim_of(ipc: string): { holds: number; timer?: ReturnType<typeof setTimeout> } {
    let c = launch_claims.get(ipc);
    if (!c) launch_claims.set(ipc, (c = { holds: 0 }));
    return c;
}

/** Forget `ipc`'s entry once no launch holds it and no claim is timed. */
function prune_claim(ipc: string): void {
    const c = launch_claims.get(ipc);
    if (c && c.holds === 0 && c.timer === undefined) launch_claims.delete(ipc);
}

/** One more launch resolving with `ipc` (no expiry; see `unhold_console`). */
function hold_console(ipc: string): void {
    claim_of(ipc).holds++;
}

function unhold_console(ipc: string): void {
    const c = launch_claims.get(ipc);
    if (c) c.holds = Math.max(0, c.holds - 1);
    prune_claim(ipc);
}

/** Claim `ipc` for a resolved launch until its session starts. */
function claim_console(ipc: string): void {
    const c = claim_of(ipc);
    clearTimeout(c.timer);
    c.timer = setTimeout(() => {
        c.timer = undefined;
        prune_claim(ipc);
        reconsider_stops();
    }, LAUNCH_CLAIM_MS);
}

/** A session started for `ipc`: its timed claim is done (holds remain). */
function end_claim(ipc: string): void {
    const c = launch_claims.get(ipc);
    if (c) {
        clearTimeout(c.timer);
        c.timer = undefined;
    }
    prune_claim(ipc);
}

/**
 * Automatic attaches are numbered in the order they start, across consoles.
 * The number rides on the attach's configuration (`AUTO_ATTACH`), so on its
 * session too; a launch notes the latest number when it resolves
 * (`ATTACH_SEEN`). `admit_launch` compares the two to tell an automatic
 * attach that started after the launch resolved from one already there.
 */
let auto_attach_seq = 0;
/**
 * Private to this module, on debug configurations. Not settings: a value
 * written in launch.json is overwritten or means nothing.
 */
const AUTO_ATTACH = 'ravenAutoAttach';
const ATTACH_SEEN = 'ravenAutoAttachSeen';

/** Test hook: a shorter send gate for consoles registered from now on. */
export function _set_mirror_gate_for_test(ms: number): void {
    MIRROR_GATE_MS = ms;
}

/** Test hook: shorter claim and socket waits. */
export function _set_launch_timeouts_for_test(claim_ms: number, socket_ms: number): void {
    LAUNCH_CLAIM_MS = claim_ms;
    SOCKET_WAIT_MS = socket_ms;
}

function reconsider_stops(): void {
    if (launches_choosing > 0) return;
    for (const ipc of deferred_stops) {
        if (launch_claims.has(ipc)) continue;
        deferred_stops.delete(ipc);
        void auto_attach(ipc);
    }
}

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
 * connection that armed it (another window connected to it first; a window
 * reloads), and the IPC protocol only replaces breakpoints file by file, so
 * the link can't know from its own history which files to clear.
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
    /**
     * Files only the console's summary named; cleared, then forgotten. Each
     * is cleared at most once per connection: a path that no longer
     * resolves to what the console stored (the file was replaced by a
     * symlink) can't be cleared from here, and the console keeps reporting
     * it.
     */
    private discovered = new Set<string>();
    /** Discovered files a mirror the console applied has cleared. */
    private cleared = new Set<string>();
    /** A mirror on this connection has been applied (`ok`). */
    private applied = false;
    /** The initial reconciliation is done and sends are released. */
    private reconciled = false;
    /** One mirror at a time, so the console applies them in order. */
    private in_flight = false;
    private again = false;
    private closed = false;
    /** Release the sends held for this console (idempotent). */
    private mirrored_once: () => void = () => undefined;
    private gate_timer: ReturnType<typeof setTimeout> | undefined;
    private readonly gate_ms = MIRROR_GATE_MS;

    constructor(readonly terminal: vscode.Terminal, readonly ipc: string) {
        // Code sent to a console before it knows the breakpoints would run
        // uninstrumented; hold sends until the first mirror lands.
        gate_sends(ipc, new Promise<void>((resolve) => {
            this.mirrored_once = () => {
                clearTimeout(this.gate_timer);
                resolve();
            };
        }));
        this.gate_timer = setTimeout(() => this.gate_deadline(), this.gate_ms);
        void this.connect();
    }

    /**
     * The held sends have waited `gate_ms` from the link's creation (the
     * console may never listen, answer, or run the debugger, so the wait is
     * bounded). A mirror on its way to the console right now is about to
     * arm the breakpoints those sends need: the socket appeared late, or
     * the debugger started during the first mirror's last retry and its
     * replacement is still being applied. That mirror gets one more
     * `gate_ms`, after which the sends go whatever is in flight (this runs
     * once; the second timer releases them itself), so they are never held
     * more than twice `gate_ms`.
     */
    private gate_deadline(): void {
        if (this.in_flight) {
            this.gate_timer = setTimeout(this.mirrored_once, this.gate_ms);
            return;
        }
        this.mirrored_once();
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
                // R left the stop (resumed, or back at the prompt): one
                // held for a launch or for a session's teardown is over.
                if (msg.event === 'running') {
                    deferred_stops.delete(this.ipc);
                    attach_after_end.delete(this.ipc);
                }
                // The debugger started after R ran its startup profiles: a
                // mirror that gave up waiting for it is sent again.
                if (msg.event === 'ready') this.mirror();
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
        const reported = this.states.map((s) => s.source.path).filter((p) => !wanted.has(p));
        const stale = reported.filter((p) => !this.discovered.has(p));
        if (stale.length > 0) {
            for (const p of stale) {
                this.mirrored.add(p);
                this.discovered.add(p);
            }
            this.mirror();
        } else if (this.applied && !this.in_flight) {
            // The console pushes a summary after each file it applies, so
            // only a summary seen once a whole mirror is in counts.
            for (const p of new Set(reported)) {
                // Only a path that now resolves elsewhere can't be cleared;
                // any other is just in a summary sent before its clear.
                let real = p;
                try { real = fs.realpathSync.native(p); } catch { /* gone: cleared as given */ }
                if (real === p) continue;
                console.warn(`raven: could not clear the R console's breakpoints in ${p}; the path no longer names the file the console armed`);
            }
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
        this.cleared.clear();
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
                // No summary will follow; don't hold sends for one. A
                // replacement mirror started above (the debugger became
                // ready meanwhile) releases them itself.
                if (!this.in_flight) this.mirrored_once();
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
                    if (this.reprobed) {
                        // A mirror still to land schedules its own timer.
                        if (!this.in_flight && !this.again) this.release();
                        return;
                    }
                    this.reprobed = true;
                    this.mirror();
                }, 1_000);
            }
        };
        if (this.closed || !fs.existsSync(this.ipc)) return finish();
        // A discovered file already cleared isn't cleared again (one the
        // editor has breakpoints in again is sent as usual).
        const previous = new Set([...this.mirrored].filter((p) => !this.cleared.has(p)));
        const { msg, files } = mirror_payload(previous);
        for (const f of files) {
            this.mirrored.add(f);
            this.cleared.delete(f);
        }
        const sent = (msg as { files: Record<string, object[]> }).files;
        const clears = [...this.discovered].filter((p) => sent[p]?.length === 0);
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
            // `not-ready`: R is still starting. `unavailable` (the debugger
            // can't run in this console) is final and falls through to
            // `finish()`, releasing sends at once.
            if (reply.includes('"not-ready"') && attempt < 40) {
                // Rebuilt on retry, so it carries any change made meanwhile.
                this.again = false;
                setTimeout(() => this.send_mirror(attempt + 1), 250);
            } else {
                const applied = reply.includes('"ok"');
                if (applied) for (const p of clears) this.cleared.add(p);
                finish(applied);
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
        deferred_stops.delete(this.ipc);
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
    // A stop replayed on subscribe can arrive next to the same stop's push.
    if (attaching.has(ipc)) return;
    if (launches_choosing > 0 || launch_claims.has(ipc)) {
        deferred_stops.add(ipc);
        return;
    }
    const number = ++auto_attach_seq;
    attaching.set(ipc, number);
    try {
        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
            type: DEBUG_TYPE,
            request: 'launch',
            name: 'R console',
            consoleSocket: ipc,
            [AUTO_ATTACH]: number,
        });
    } finally {
        attaching.delete(ipc);
    }
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
        // `""` means no console given, as in `resolve_configuration`.
        const given: unknown = config.consoleSocket || undefined;
        if (typeof given === 'string' && attaching.has(given)) return resolve_configuration(config);
        // Until it knows its console, a launch holds back every stop; then
        // only its console's.
        let choosing = typeof given !== 'string';
        let held: string | undefined;
        const hold = (ipc: string) => {
            if (held === ipc) return;
            if (held !== undefined) unhold_console(held);
            held = ipc;
            hold_console(ipc);
            if (choosing) {
                choosing = false;
                launches_choosing--;
                reconsider_stops();
            }
        };
        if (typeof given === 'string') hold(given);
        else launches_choosing++;
        try {
            const resolved = await resolve_configuration(config, hold);
            const chosen: unknown = resolved?.consoleSocket;
            if (resolved && typeof chosen === 'string') {
                claim_console(chosen);
                // Every time it resolves (a restart re-resolves an edited
                // configuration): what `admit_launch` asks is whether an
                // attach started since this resolution.
                resolved[ATTACH_SEEN] = auto_attach_seq;
                // Only `auto_attach` says what an automatic attach is.
                delete resolved[AUTO_ATTACH];
            }
            return resolved;
        } finally {
            // Also when resolution throws: an untimed hold must not outlive it.
            if (held !== undefined) unhold_console(held);
            if (choosing) launches_choosing--;
            reconsider_stops();
        }
    },
    resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
        return admit_launch(config);
    },
};

/**
 * A launch is about to get its session: VS Code calls this after the
 * launch's `preLaunchTask` has run (debugService.ts `createSession`; the
 * same order in VS Code 1.82, the oldest supported, and today), which can be
 * long after the launch resolved and claimed its console.
 *
 * A claim lasts `LAUNCH_CLAIM_MS`, because VS Code doesn't say when a
 * resolved launch is abandoned (its task failed or was cancelled) and a stop
 * must not wait forever for one. So a stop reported during a longer task
 * attaches by itself once the claim expires. If that session is still there
 * when the launch finally arrives, both would connect to the console's one
 * debug adapter: the launch would cut the session showing the stop off, and
 * its `program` would be sent to an R that is stopped at `Browse>`. The
 * launch is refused instead, and says so. Only for that: a launch that
 * resolved after the attach began, or that finds a session another launch
 * started, replaces the session, as before.
 *
 * Otherwise the launch claims its console again until its session starts,
 * so a stop reported in between is left to it.
 */
function admit_launch(config: vscode.DebugConfiguration): vscode.DebugConfiguration | undefined {
    const ipc: unknown = config.consoleSocket;
    const seen: unknown = config[ATTACH_SEEN];
    // An automatic attach's own configuration isn't marked as a launch.
    if (typeof ipc !== 'string' || typeof seen !== 'number') return config;
    // The automatic attach on this console, if any: still starting, or its
    // session (one the console has ended is on its way out).
    const session = sessions.get(ipc);
    const live: unknown = session && !ending.has(session.id) ? session.configuration[AUTO_ATTACH] : undefined;
    const since = (n: unknown) => typeof n === 'number' && n > seen;
    if (since(attaching.get(ipc)) || since(live)) {
        void vscode.window.showWarningMessage(
            `Raven: R stopped in the debugger while "${config.name}" was waiting to start, and a debug session is showing that stop. `
            + `"${config.name}" was not started${config.program ? ', and its program did not run' : ''}. `
            + 'Start it again once R is back at the prompt.',
        );
        // `undefined` aborts quietly; `null` would open launch.json.
        return undefined;
    }
    claim_console(ipc);
    return config;
}

async function resolve_configuration(
    config: vscode.DebugConfiguration,
    on_console: (ipc: string) => void = () => undefined,
): Promise<vscode.DebugConfiguration | undefined> {
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
    on_console(config.consoleSocket);
    if (!(await wait_for_file(dap_socket_for(config.consoleSocket), SOCKET_WAIT_MS))) {
        void vscode.window.showErrorMessage(
            "Raven: this R console wasn't started with the debugger. Close it and open a new R console.",
        );
        return undefined;
    }
    return config;
}

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

/**
 * With Raven's R console turned off, `raven-r` is disabled (package.json
 * `when`) but a launch.json configuration of that type still reaches its
 * providers. Answer it with why, instead of VS Code's missing-adapter error.
 */
export function register_debugger_unavailable(context: vscode.ExtensionContext): void {
    const why = "Raven: the R debugger runs in Raven's R console, which is turned off in this window (raven.rConsole.activation).";
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
            resolveDebugConfiguration() {
                void vscode.window.showErrorMessage(why);
                // `undefined` aborts quietly; `null` would open launch.json.
                return undefined;
            },
        }),
    );
}

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
                end_claim(s.configuration.consoleSocket);
                // This session shows the console's stop.
                deferred_stops.delete(s.configuration.consoleSocket);
                sessions.set(s.configuration.consoleSocket, s);
                update_status();
                reconsider_stops();
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
