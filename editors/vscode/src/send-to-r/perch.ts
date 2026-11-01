import * as vscode from 'vscode';
import { perch_error_code, PerchApiV1, PerchExports, SessionInfo } from './perch-api';
import { as_typed, is_ended, PERCH_EXTENSION_ID, RAVEN_CALLER_ID } from './perch-sessions';

/**
 * R consoles in Perch sessions (github.com/jbearak/perch, API v1), which
 * survive a closed window or a dropped connection.
 *
 * Two questions, answered separately:
 * - Can Raven use Perch here? Perch must be installed, answer, and be
 *   `available()`, and its API must reach Raven: a local window, or a remote
 *   one where Raven runs in the remote (workspace) extension host. Then Raven
 *   connects, adopts its Perch terminals in this window, and starts a console
 *   from Perch's list (`new_console_in_perch` in `r-terminal-manager.ts`).
 * - Do Raven's own new consoles go to Perch? Only in a remote window where
 *   Perch is usable. In a local window, Raven's own consoles, its terminal
 *   profile, and its sends stay ordinary terminals and never wait for Perch;
 *   only consoles started from Perch's list, and those Perch restores, run in
 *   sessions there.
 * Anything else, including any error while looking Perch up, keeps the
 * ordinary terminal path. Installing Perch is the switch; there is no setting.
 *
 * Invariants:
 * - Only sessions with a Perch terminal in this window are automatic send
 *   targets. Other Raven sessions on the host (other workspaces, other
 *   windows, closed terminals) are offered for reattaching, never sent to.
 * - Closing a Perch terminal is a detach: the console keeps running, so
 *   console state is torn down on `onDidEndSession`, not on close.
 * - Raven never types into a Perch session with `terminal.sendText`; text
 *   goes through `send`, in order, and is never resent after
 *   `outcome_unknown`.
 */

/** Where Raven runs, as far as Perch is concerned. */
export type PerchHost = {
    /** A remote window (SSH, WSL, a container, a tunnel). */
    remote: boolean;
    /** Perch's API can reach Raven here. */
    reachable: boolean;
};

/** Where Raven runs and how it finds Perch; replaced in tests. */
export type PerchDeps = {
    host: () => PerchHost;
    get_extension: () => vscode.Extension<PerchExports | undefined> | undefined;
};

/**
 * Test-only: makes a local window count as a remote one, so an end-to-end
 * test can exercise the remote behavior without a remote. Never set by users.
 */
const TREAT_AS_REMOTE_ENV = 'RAVEN_TEST_PERCH_TREAT_AS_REMOTE';

/**
 * Where Raven runs. In a local window every extension shares one host, so
 * Perch's API reaches Raven. In a remote window it does only when Raven runs
 * in the workspace extension host, next to Perch; a user's
 * `remote.extensionKind` override can run Raven as a UI extension there.
 */
export function perch_host(
    remote_name: string | undefined,
    extension_kind: vscode.ExtensionKind,
    env: Readonly<Record<string, string | undefined>>,
): PerchHost {
    if (env[TREAT_AS_REMOTE_ENV] === '1') return { remote: true, reachable: true };
    if (remote_name === undefined) return { remote: false, reachable: true };
    return { remote: true, reachable: extension_kind === vscode.ExtensionKind.Workspace };
}

export function default_perch_deps(context: vscode.ExtensionContext): PerchDeps {
    return {
        host: () => perch_host(vscode.env.remoteName, context.extension.extensionKind, process.env),
        get_extension: () => vscode.extensions.getExtension<PerchExports | undefined>(PERCH_EXTENSION_ID),
    };
}

/**
 * Perch's API if Raven can use it here, else undefined.
 * Never rejects: a Perch that fails to activate or answer means "no Perch".
 */
export async function find_perch(deps: PerchDeps): Promise<PerchApiV1 | undefined> {
    if (!deps.host().reachable) return undefined;
    const ext = deps.get_extension();
    if (ext === undefined) return undefined;
    try {
        const exports = ext.isActive ? ext.exports : await ext.activate();
        const api = exports?.getApi(1, RAVEN_CALLER_ID) as PerchApiV1 | undefined;
        if (api === undefined || !(await api.available())) return undefined;
        return api;
    } catch (err) {
        console.warn('raven: Perch is installed but not usable; R consoles use ordinary terminals:', err);
        return undefined;
    }
}

/** What Raven does when Perch reports one of its sessions. */
export type PerchHandlers = {
    /** A terminal of this window is attached to one of Raven's sessions. */
    attached(session: SessionInfo, terminal: vscode.Terminal, api: PerchApiV1): void;
    /** One of Raven's sessions ended. */
    ended(session: SessionInfo): void;
};

let deps: PerchDeps | null = null;
let handlers: PerchHandlers | null = null;
let current: PerchApiV1 | undefined;
let events: vscode.Disposable | undefined;
// Which lookup is current; a later one, or disposal, discards earlier results.
let generation = 0;
// The latest lookup; a new console waits for it, so one opened while Raven
// activates still runs in Perch.
let lookup: Promise<void> = Promise.resolve();

/**
 * Perch terminals of this window running Raven sessions, and the API that
 * reaches each. A session keeps its API if Perch is later looked up again.
 */
const terminals = new Map<vscode.Terminal, { id: string; api: PerchApiV1 }>();

/** Looks Perch up now and whenever extensions change. */
export function start_perch(
    context: vscode.ExtensionContext,
    on: PerchHandlers,
    perch_deps: PerchDeps = default_perch_deps(context),
): void {
    deps = perch_deps;
    handlers = on;
    context.subscriptions.push(
        vscode.extensions.onDidChange(() => void connect_perch()),
        new vscode.Disposable(() => {
            generation++;
            events?.dispose();
            events = undefined;
            current = undefined;
        }),
    );
    void connect_perch();
}

/**
 * Looks Perch up and, for a new API object, subscribes to its events, then
 * adopts the Raven terminals already open in this window (after a reload,
 * Perch reopens them before or after Raven activates). Subscribing first
 * means an attach between the two steps is not lost; adopting twice is
 * harmless. Never rejects.
 */
export function connect_perch(): Promise<void> {
    lookup = look_up_perch();
    return lookup;
}

async function look_up_perch(): Promise<void> {
    if (!deps || !handlers) return;
    const on = handlers;
    const mine = ++generation;
    const api = await find_perch(deps);
    if (mine !== generation || api === current) return;
    events?.dispose();
    events = undefined;
    current = api;
    if (api === undefined) return;
    try {
        events = vscode.Disposable.from(
            api.onDidAttach(({ session, terminal }) => {
                if (session.owner === RAVEN_CALLER_ID && !is_ended(session)) on.attached(session, terminal, api);
            }),
            api.onDidEndSession((session) => {
                if (session.owner === RAVEN_CALLER_ID) on.ended(session);
            }),
        );
        for (const { session, terminal } of api.terminals()) {
            if (session.owner === RAVEN_CALLER_ID && !is_ended(session)) on.attached(session, terminal, api);
        }
    } catch (err) {
        console.warn('raven: could not read Perch sessions:', err);
    }
}

/** True in a remote window; false before activation. Never waits. */
function in_remote_window(): boolean {
    return deps?.host().remote ?? false;
}

/**
 * Settles when the latest lookup has, including adopting the Raven
 * terminals Perch already has open in this window, so a new console doesn't
 * duplicate one. In a local window it settles at once: Raven's own consoles
 * never wait for Perch there, and Perch's terminals join through
 * `onDidAttach` whenever the lookup ends.
 */
export function perch_lookup_settled(): Promise<void> {
    return in_remote_window() ? lookup : Promise.resolve();
}

/**
 * Perch's API for one of Raven's own new consoles, or undefined for an
 * ordinary terminal. Undefined at once in a local window; in a remote one,
 * waits for the lookup, which settles at once without Perch next to Raven.
 */
export async function perch_for_new_console(): Promise<PerchApiV1 | undefined> {
    if (!in_remote_window()) return undefined;
    await lookup;
    return current;
}

/**
 * Perch's API if Raven can use it here, waiting up to `timeout_ms` for the
 * lookup (and any lookup started meanwhile). For a console the user asked
 * Perch for, in any window.
 */
export async function usable_perch(timeout_ms: number): Promise<PerchApiV1 | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed_out = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeout_ms);
    });
    try {
        for (;;) {
            const awaited = lookup;
            if ((await Promise.race([awaited, timed_out])) === 'timeout' || lookup === awaited) return current;
        }
    } finally {
        clearTimeout(timer);
    }
}

export function track_perch_terminal(terminal: vscode.Terminal, id: string, api: PerchApiV1): void {
    terminals.set(terminal, { id, api });
}

export function untrack_perch_terminal(terminal: vscode.Terminal): void {
    terminals.delete(terminal);
}

/** The Perch session of a Raven terminal in this window, if it runs in one. */
export function perch_session_of(terminal: vscode.Terminal): string | undefined {
    return terminals.get(terminal)?.id;
}

/** IDs of the Raven sessions with a terminal in this window. */
export function perch_sessions_open_here(): Set<string> {
    return new Set([...terminals.values()].map((t) => t.id));
}

// Per session: settles when the latest `send` has been answered, so sends
// reach the session in the order they were made.
const send_tails = new Map<string, Promise<void>>();

function report_send_failure(err: unknown): void {
    const code = perch_error_code(err);
    if (code === 'outcome_unknown') {
        void vscode.window.showWarningMessage(
            'Raven: lost contact with the R session while sending code; it may not have run.',
        );
        return;
    }
    const why = code === 'queue_full'
        ? "the R session's input queue is full"
        : code === 'no_session'
            ? 'the R session has ended'
            : err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Raven: couldn't send code to the R session (${why}).`);
}

/**
 * Types `text` and Enter into `terminal`, as `terminal.sendText(text)` does.
 * For a terminal running a Perch session, the text goes through Perch's
 * `send` instead, after any earlier send to that session.
 */
export function type_into(terminal: vscode.Terminal, text: string): void {
    const tracked = terminals.get(terminal);
    if (!tracked) {
        terminal.sendText(text);
        return;
    }
    const { id, api } = tracked;
    const step = () => api.send(id, as_typed(text), { submit: true }).then(() => undefined, report_send_failure);
    const next = (send_tails.get(id) ?? Promise.resolve()).then(step);
    send_tails.set(id, next);
    void next.finally(() => {
        if (send_tails.get(id) === next) send_tails.delete(id);
    });
}

/** Test-only: forget Perch and every tracked terminal. */
export function _reset_perch_for_test(): void {
    generation++;
    events?.dispose();
    events = undefined;
    current = undefined;
    lookup = Promise.resolve();
    deps = null;
    handlers = null;
    terminals.clear();
    send_tails.clear();
}

/** Test-only: look Perch up with `perch_deps`, reporting to `on`. */
export async function _connect_perch_for_test(perch_deps: PerchDeps, on: PerchHandlers): Promise<void> {
    deps = perch_deps;
    handlers = on;
    await connect_perch();
}
