import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Client side of `raven console --ipc`: code sent from the editor goes to
 * Raven's console over a Unix socket instead of being typed into the
 * terminal. The console echoes it as if typed, runs it through R's own REPL,
 * and stops at the first error.
 *
 * Invariant — never run code twice: the paste fallback is used only when no
 * console is listening (the socket file is absent, or `connect()` fails, e.g.
 * because the console fell back to plain R). Once connected, the request is
 * never resent, even if the connection drops before the console's `queued`
 * acknowledgement; that case is reported as "may not have run".
 *
 * Invariant — sends run in the order they were made: each send to a console
 * waits for the previous one's `queued` acknowledgement (by which point that
 * request is in the console's queue), so `x <- 1` then `print(x)` from two
 * quick Run Line presses can't swap.
 */

type ConsoleTerminal = {
    socket: string;
    /** When the terminal was launched; the console creates its socket at startup. */
    launched_ms: number;
    /** The socket never appeared: the console fell back to plain R. */
    fell_back: boolean;
};

const terminal_sockets = new WeakMap<vscode.Terminal, ConsoleTerminal>();
let next_request_id = 1;
/** Per socket: settles when the latest send has been acknowledged (or lost). */
const send_tails = new Map<string, Promise<void>>();

/** Run `step` after every earlier send to `socket_path` has settled. */
function in_order(socket_path: string, step: () => Promise<void>): void {
    const prev = send_tails.get(socket_path) ?? Promise.resolve();
    const next = prev.then(step, step);
    send_tails.set(socket_path, next);
    void next.finally(() => {
        if (send_tails.get(socket_path) === next) send_tails.delete(socket_path);
    });
}

/**
 * How long a send waits for a just-launched console to create its socket.
 * The console listens within milliseconds of starting (before R runs any
 * profile), but finding R can take longer on a cold machine.
 */
const STARTUP_WAIT_MS = 5_000;

/**
 * How long a connected console has to acknowledge a send. It acknowledges as
 * soon as the request is queued (no R work happens first), so this only
 * fires for a console that is stopped or wedged — and keeps it from holding
 * up every later send forever.
 */
const ACK_TIMEOUT_MS = 10_000;

/**
 * A fresh socket path in a new 0700 directory (mkdtemp). Kept short: macOS
 * limits Unix socket paths to 104 bytes and `os.tmpdir()` there is already
 * ~50.
 */
export function make_console_socket_path(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-c'));
    return path.join(dir, 's');
}

export function register_console_terminal(terminal: vscode.Terminal, socket_path: string): void {
    terminal_sockets.set(terminal, { socket: socket_path, launched_ms: Date.now(), fell_back: false });
}

/** Remove the socket's directory once its terminal is gone. */
export function forget_console_terminal(terminal: vscode.Terminal): void {
    const entry = terminal_sockets.get(terminal);
    if (!entry) return;
    terminal_sockets.delete(terminal);
    fs.rm(path.dirname(entry.socket), { recursive: true, force: true }, () => undefined);
}

/**
 * How to send to `terminal`:
 * - `type`: not a Raven console, or its console fell back to plain R — type the code;
 * - `socket`: the console is listening;
 * - `starting`: launched moments ago and not listening yet — wait for it
 *   (typing now would land in a console that hasn't reached its prompt).
 * Synchronous, so callers that type keep their synchronous send path.
 */
export function console_route(
    terminal: vscode.Terminal,
): { kind: 'type' } | { kind: 'socket' | 'starting'; socket: string } {
    const entry = terminal_sockets.get(terminal);
    if (!entry) return { kind: 'type' };
    // Checked even after a fallback: a console that was slow to start may be
    // listening now.
    if (fs.existsSync(entry.socket)) return { kind: 'socket', socket: entry.socket };
    if (entry.fell_back) return { kind: 'type' };
    if (Date.now() - entry.launched_ms < STARTUP_WAIT_MS) return { kind: 'starting', socket: entry.socket };
    entry.fell_back = true;
    return { kind: 'type' };
}

/**
 * Type `type_it` for a console terminal without overtaking an earlier send
 * to it that is still pending (e.g. one still waiting for a starting console
 * when the startup window closed).
 */
export function type_in_order(terminal: vscode.Terminal, type_it: () => void): void {
    const entry = terminal_sockets.get(terminal);
    if (entry && send_tails.has(entry.socket)) {
        in_order(entry.socket, async () => type_it());
    } else {
        type_it();
    }
}

/**
 * Wait for a starting console's socket, then send; type the code instead if
 * the console never starts listening (and remember that it fell back).
 */
export function send_when_listening(
    terminal: vscode.Terminal,
    socket_path: string,
    code: string,
    fallback: () => void,
): void {
    in_order(socket_path, () => new Promise<void>((done) => {
        const poll = () => {
            if (fs.existsSync(socket_path)) {
                deliver(socket_path, code, fallback).then(done, done);
                return;
            }
            const entry = terminal_sockets.get(terminal);
            if (!entry || Date.now() - entry.launched_ms >= STARTUP_WAIT_MS) {
                if (entry) entry.fell_back = true;
                fallback();
                done();
                return;
            }
            setTimeout(poll, 25);
        };
        poll();
    }));
}

/**
 * Send `code` for execution. `fallback` runs only if nothing was delivered
 * (connect failed).
 */
export function send_via_console(socket_path: string, code: string, fallback: () => void): void {
    in_order(socket_path, () => deliver(socket_path, code, fallback));
}

/** One request; settles once it is acknowledged, or known not delivered. */
function deliver(socket_path: string, code: string, fallback: () => void): Promise<void> {
    return new Promise<void>((settled) => {
        const id = next_request_id++;
        let connected = false;
        let acknowledged = false;
        const socket = net.createConnection(socket_path);
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            connected = true;
            socket.write(JSON.stringify({ v: 1, id, op: 'execute', code }) + '\n');
        });
        let buffered = '';
        socket.on('data', (chunk: string) => {
            buffered += chunk;
            let nl: number;
            while ((nl = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, nl);
                buffered = buffered.slice(nl + 1);
                let status: unknown;
                try { status = (JSON.parse(line) as { status?: unknown }).status; } catch { continue; }
                if (status === 'queued') {
                    // Delivered: the console owns it now. Nothing else to wait for.
                    acknowledged = true;
                    socket.end();
                    settled();
                }
            }
        });
        let reported = false;
        const lost = () => {
            if (reported || acknowledged) return;
            reported = true;
            if (!connected) {
                fallback();
            } else {
                void vscode.window.showWarningMessage(
                    'Raven: lost the connection to the R console while sending code; it may not have run.',
                );
            }
            settled();
        };
        // A clean close before the acknowledgement emits no 'error'.
        socket.on('error', lost);
        socket.on('close', lost);
        const timer = setTimeout(() => {
            lost();
            socket.destroy();
        }, ACK_TIMEOUT_MS);
        socket.on('close', () => clearTimeout(timer));
    });
}
