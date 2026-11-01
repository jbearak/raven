import * as path from 'path';
import { is_terminal_program, TerminalProgram } from './console-choice';
import type { SessionInfo } from './perch-api';

/**
 * Pure rules for R consoles in Perch sessions. No `vscode` import, so the
 * bun suite can test them directly; `perch.ts` holds the connection.
 */

/** Perch's extension ID. */
export const PERCH_EXTENSION_ID = 'jbearak.perch';
/** Raven's extension ID: the `callerId`, and so the `owner` of its sessions. */
export const RAVEN_CALLER_ID = 'jbearak.raven-r';
/** The session kind of every R console Raven starts. */
export const PERCH_R_KIND = 'r';

/** `ipc` marks a session whose console listens on `{dir}/ipc`. */
export const CONSOLE_ANNOTATION = 'raven.console';
/** Which `raven.rTerminal.program` the session runs. */
export const PROGRAM_ANNOTATION = 'raven.program';

/** The console's IPC socket in a session; its DAP socket is `{dir}/d` beside it. */
export const PERCH_CONSOLE_SOCKET = '{dir}/ipc';

/**
 * Makes `text` reach the program literally. `perch new` expands `{dir}` and
 * `{id}` in command arguments and env values and rejects any other lone
 * brace; doubled braces are literal.
 */
export function escape_perch_text(text: string): string {
    return text.replace(/[{}]/g, (c) => c + c);
}

/** `env` with every value escaped (names can't hold braces Perch reads). */
export function escape_perch_env(env: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
    if (env === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) out[name] = escape_perch_text(value);
    return out;
}

export function perch_annotations(program: TerminalProgram, has_console_socket: boolean): Record<string, string> {
    return has_console_socket
        ? { [PROGRAM_ANNOTATION]: program, [CONSOLE_ANNOTATION]: 'ipc' }
        : { [PROGRAM_ANNOTATION]: program };
}

/** What a Raven session runs, from its annotations. */
export function session_program(session: SessionInfo): TerminalProgram {
    const program = session.annotations[PROGRAM_ANNOTATION];
    if (is_terminal_program(program)) return program;
    return session.annotations[CONSOLE_ANNOTATION] === 'ipc' ? 'raven' : 'R';
}

/**
 * The console socket of a Raven session, or undefined when it has none: the
 * program isn't Raven's console, or the session directory was recreated and
 * the socket is gone for good (then only `send` reaches the program).
 */
export function session_console_socket(session: SessionInfo): string | undefined {
    if (session.annotations[CONSOLE_ANNOTATION] !== 'ipc') return undefined;
    if (session.degraded.includes('directory-recreated')) return undefined;
    return path.join(session.dir, 'ipc');
}

export function is_ended(session: SessionInfo): boolean {
    return session.state === 'exited' || session.state === 'lost';
}

/**
 * Sessions the user may reattach to for `program`: Raven's, still running,
 * with no terminal in this window. They can come from any workspace or
 * window on the host, so they are offered, never sent to automatically.
 */
export function reattach_candidates(
    listed: readonly SessionInfo[],
    program: TerminalProgram,
    open_here: ReadonlySet<string>,
): SessionInfo[] {
    return listed.filter((s) =>
        s.owner === RAVEN_CALLER_ID
        && (s.state === 'running' || s.state === 'unresponsive')
        && !open_here.has(s.id)
        && session_program(s) === program,
    );
}

/**
 * `text` as VS Code's `sendText(text)` types it, for `send` with
 * `submit: true`: each line break becomes a carriage return (what Enter
 * sends), and one trailing break is dropped because `submit` adds it, as
 * `sendText` adds one only when the text lacks it.
 */
export function as_typed(text: string): string {
    return text.replace(/\r?\n/g, '\r').replace(/\r$/, '');
}
