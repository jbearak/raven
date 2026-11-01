import type * as vscode from 'vscode';

/**
 * Version 1 of the Perch API (github.com/jbearak/perch, `docs/api.md`),
 * copied rather than imported so Raven has no dependency on Perch. Only
 * the members Raven uses are listed; Perch's exports have more.
 */

export interface SessionInfo {
    /** 8 characters, [a-z0-9]. */
    id: string;
    name: string;
    kind: string;
    /** The callerId that created it. */
    owner?: string;
    annotations: Record<string, string>;
    /** The session directory, `{dir}`. */
    dir: string;
    /** Problems the session has had, e.g. `directory-recreated`. */
    degraded: string[];
    cwd: string;
    host: string;
    /** RFC 3339, UTC. */
    createdAt: string;
    state: 'starting' | 'running' | 'exited' | 'lost' | 'unresponsive';
    /** A terminal is attached, here or anywhere. */
    attached: boolean;
    /** Attached by a terminal of this window. */
    attachedHere: boolean;
}

export interface CreateOptions {
    name: string;
    kind: string;
    /** `{dir}` and `{id}` expand; `{{` and `}}` are literal braces. */
    command: string[];
    cwd?: string;
    /** `{dir}` and `{id}` expand in values, as in `command`. */
    env?: Record<string, string>;
    annotations?: Record<string, string>;
}

export interface PerchApiV1 {
    readonly version: 1;
    available(): Promise<boolean>;
    prepareLaunch(options: CreateOptions): { id: string; options: vscode.TerminalOptions };
    waitForSession(id: string, terminal: vscode.Terminal): Promise<SessionInfo>;
    listSessions(filter?: { owner?: string; kind?: string }): Promise<SessionInfo[]>;
    terminals(): ReadonlyArray<{ session: SessionInfo; terminal: vscode.Terminal }>;
    attach(id: string, options?: { show?: boolean }): Promise<vscode.Terminal>;
    send(id: string, text: string, options?: { paste?: boolean; submit?: boolean }): Promise<'queued'>;
    readonly onDidAttach: vscode.Event<{ session: SessionInfo; terminal: vscode.Terminal }>;
    readonly onDidEndSession: vscode.Event<SessionInfo>;
}

export interface PerchExports {
    getApi(version: number, callerId: string): unknown;
}

/** Why a call failed; check `code`, since Perch doesn't export the class. */
export type PerchErrorCode = 'queue_full' | 'outcome_unknown' | 'no_session' | 'unavailable';

export function perch_error_code(err: unknown): PerchErrorCode | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const { name, code } = err as { name?: unknown; code?: unknown };
    if (name !== 'PerchApiError') return undefined;
    return code === 'queue_full' || code === 'outcome_unknown' || code === 'no_session' || code === 'unavailable'
        ? code
        : undefined;
}
