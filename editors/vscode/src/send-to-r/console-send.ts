import * as vscode from 'vscode';
import { console_socket_of, type SendLocation } from './console-ipc';
import { vscode_r_terminal_pick } from './console-choice';
import { REDITORSUPPORT_EXTENSION_ID } from './console-picker';
import { is_raven_console_terminal, resolve_send_target, SendTarget } from './r-terminal-manager';
import { get_send_options, send_code, type SendOptions } from './send-code';

/**
 * Sending editor code to the chosen R console.
 *
 * Sends run one at a time in invocation order: a second Cmd+Enter pressed
 * while the console picker is open waits for the pick, then goes to the same
 * console, instead of opening a second picker or overtaking the first send.
 */

let send_queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every send queued before it has finished. */
export function with_send_queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = send_queue.then(fn, fn);
    send_queue = run.catch(() => undefined);
    return run;
}

/** How long a terminal Raven shows has to become the active terminal. */
const ACTIVATE_TIMEOUT_MS = 1000;

function is_raven_terminal(terminal: vscode.Terminal): boolean {
    return is_raven_console_terminal(terminal) || console_socket_of(terminal) !== undefined;
}

/** Shows `terminal` and waits (briefly) until VS Code reports it active. */
function make_active(terminal: vscode.Terminal): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            listener.dispose();
            clearTimeout(timer);
            resolve();
        };
        const listener = vscode.window.onDidChangeActiveTerminal((active) => {
            if (active === terminal) done();
        });
        const timer = setTimeout(done, ACTIVATE_TIMEOUT_MS);
        terminal.show(true);
    });
}

/**
 * Whether vscode-R will run code in its Interactive session without ever
 * selecting a terminal. vscode-R (3.2 and later, which declare
 * `r.interactive.executionTarget`) offers every send to its Interactive
 * router before the terminal selector, and with the target set to
 * `interactive` the router never falls back to a terminal: it runs the code
 * in a connected session or asks the user to pick or start one (the
 * "create terminal" choice is left out of that prompt). The setting is read
 * for the active editor's document, as vscode-R reads it. With `auto`, the
 * router's choice depends on state vscode-R doesn't expose, so the terminal
 * guard still applies there.
 */
function vscode_r_targets_interactive(extension: vscode.Extension<unknown>): boolean {
    const json = extension.packageJSON as { contributes?: { configuration?: unknown } } | undefined;
    const sections = json?.contributes?.configuration;
    const declared = (Array.isArray(sections) ? sections : [sections]).some((section) =>
        typeof section === 'object' && section !== null
        && 'r.interactive.executionTarget' in ((section as { properties?: object }).properties ?? {}));
    if (!declared) return false;
    const document = vscode.window.activeTextEditor?.document.uri;
    return vscode.workspace.getConfiguration('r', document).get<string>('interactive.executionTarget', 'auto') === 'interactive';
}

/**
 * Makes sure vscode-R's terminal selector (`vscode_r_terminal_pick`) won't
 * pick one of Raven's terminals, which are also named `R`. Does nothing
 * unless a Raven terminal would be picked; then activates vscode-R's own
 * terminal, opening one with `r.createRTerm` if it has none. Returns false
 * if a Raven terminal would still be picked: then nothing may be sent.
 */
async function clear_way_for_vscode_r(): Promise<boolean> {
    const always_active = vscode.workspace.getConfiguration('r').get<boolean>('alwaysUseActiveTerminal', false);
    const pick = () => vscode_r_terminal_pick(vscode.window.terminals, vscode.window.activeTerminal, always_active);
    const first = pick();
    if (first === undefined || !is_raven_terminal(first)) return true;
    const theirs = () => vscode_r_terminal_pick(
        vscode.window.terminals.filter((t) => !is_raven_terminal(t)),
        undefined,
        false,
    );
    let own = theirs();
    if (own === undefined) {
        await vscode.commands.executeCommand('r.createRTerm');
        own = theirs();
    }
    if (own === undefined) return false;
    if (vscode.window.activeTerminal !== own) await make_active(own);
    const now = pick();
    return now !== undefined && !is_raven_terminal(now);
}

/**
 * Sends `code` to vscode-R's R terminal through its `r.runCommand` command,
 * which passes the text to `runTextInTerm` unchanged. vscode-R registers its
 * commands on activation, so activate it first. Returns false (after telling
 * the user) when vscode-R isn't available, or when its selector would pick a
 * Raven terminal (see `clear_way_for_vscode_r`; skipped when vscode-R sends
 * to its Interactive session, see `vscode_r_targets_interactive`).
 *
 * True means vscode-R took the code, not that it ran: `r.runCommand`'s
 * handler discards whether it sent anything (vscode-R 3.4: `async (t) =>
 * { await runTextInTerm(t) }`), so cancelling vscode-R's own execution-target
 * prompt still returns here as a send, and callers move the cursor.
 */
export async function send_to_vscode_r(code: string): Promise<boolean> {
    const extension = vscode.extensions.getExtension(REDITORSUPPORT_EXTENSION_ID);
    try {
        if (!extension) throw new Error("vscode-R isn't installed or is disabled");
        await extension.activate();
        if (!vscode_r_targets_interactive(extension) && !(await clear_way_for_vscode_r())) {
            throw new Error("it would have gone to Raven's own R terminal; click vscode-R's terminal, then send again");
        }
        await vscode.commands.executeCommand('r.runCommand', code);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const CHOOSE = 'Choose R Console';
        void vscode.window
            .showErrorMessage(`Raven: couldn't send code to vscode-R (${message}).`, CHOOSE)
            .then((choice) => {
                if (choice === CHOOSE) void vscode.commands.executeCommand('raven.chooseRConsole');
            });
        return false;
    }
}

export type ConsoleSendOptions = {
    /**
     * `code` (default) uses the configured send method for terminals other
     * than Raven's console. `text` types the code as is (bracketed if it has
     * several lines), for short commands like `source(...)` that shouldn't go
     * through a temp file. Either way Raven's console gets it over its socket.
     */
    how?: 'code' | 'text';
    location?: SendLocation;
};

/**
 * `send_code` options for `how`. Every send, `text` included, goes through
 * `send_code`, so Raven's console receives it over its ordered socket: typed
 * text would land after whatever the user left unentered at the prompt, and
 * overtake earlier sends still waiting (e.g. on the debugger's startup gate).
 */
export function send_options_for(how: ConsoleSendOptions['how']): SendOptions {
    const options = get_send_options();
    return how === 'text' ? { ...options, sendMethod: 'paste' } : options;
}

/** Delivers `code` to an already resolved target. */
export async function deliver_to_target(
    target: SendTarget,
    code: string,
    options: ConsoleSendOptions = {},
): Promise<boolean> {
    if (target.kind === 'vscode-r') return send_to_vscode_r(code);
    target.terminal.show(true);
    send_code(target.terminal, code, send_options_for(options.how), options.location);
    return true;
}

/**
 * Sends `code` to the chosen R console, asking which one if none is chosen.
 * Returns false if nothing was sent (the user cancelled the picker, or
 * vscode-R wasn't available), so callers move the cursor only after a send.
 */
export function send_to_r_console(
    code: string,
    options: ConsoleSendOptions = {},
): Promise<boolean> {
    return with_send_queue(async () => {
        const target = await resolve_send_target();
        if (!target) return false;
        return deliver_to_target(target, code, options);
    });
}
