import * as vscode from 'vscode';
import type { SendLocation } from './console-ipc';
import { REDITORSUPPORT_EXTENSION_ID } from './console-picker';
import { resolve_send_target, SendTarget } from './r-terminal-manager';
import { get_send_options, send_code } from './send-code';

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

/**
 * Sends `code` to vscode-R's R terminal through its `r.runCommand` command,
 * which passes the text to `runTextInTerm` unchanged. vscode-R registers its
 * commands on activation, so activate it first. Returns false (after telling
 * the user) when vscode-R isn't available.
 */
export async function send_to_vscode_r(code: string): Promise<boolean> {
    const extension = vscode.extensions.getExtension(REDITORSUPPORT_EXTENSION_ID);
    try {
        if (!extension) throw new Error("vscode-R isn't installed or is disabled");
        await extension.activate();
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
     * `code` (default) uses `send_code`: Raven's console socket, or the
     * configured send method for other terminals. `text` types the line as
     * is, for one-line commands like `source(...)` that shouldn't go through
     * a temp file.
     */
    how?: 'code' | 'text';
    location?: SendLocation;
};

/** Delivers `code` to an already resolved target. */
export async function deliver_to_target(
    target: SendTarget,
    code: string,
    options: ConsoleSendOptions = {},
): Promise<boolean> {
    if (target.kind === 'vscode-r') return send_to_vscode_r(code);
    target.terminal.show(true);
    if (options.how === 'text') {
        target.terminal.sendText(code);
    } else {
        send_code(target.terminal, code, get_send_options(), options.location);
    }
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
