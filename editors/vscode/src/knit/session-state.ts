/**
 * Per-extension-session state for the knit pipeline.
 *
 * VS Code may run several extension hosts simultaneously (the user has
 * multiple windows open on the same workspace, or remote vs local
 * sessions). Each gets a fresh `sessionId` so their temp dirs are
 * isolated under `raven-knit/<workspaceHash>/<sessionId>/`. The
 * deactivation cleanup path can then safely `rm -rf` the current
 * session's root without touching any sibling session's in-flight
 * artifacts.
 *
 * `initSessionState` runs once during `activate()`. Tests that need to
 * exercise the knit pipeline must call it (or fail with an explicit
 * error from `currentSession()` rather than corrupt-look behavior).
 */

import * as fs from 'fs';
import * as path from 'path';
import { computeWorkspaceHash, sessionRoot } from './raven-knit-paths';

export interface SessionInfo {
    sessionId: string;
    workspaceHash: string;
}

let state: SessionInfo | null = null;

export interface InitSessionStateOpts {
    sessionId: string;
    /** First workspace folder's URI string, or `null` when no workspace is open. */
    workspaceUri: string | null;
}

export function initSessionState(opts: InitSessionStateOpts): SessionInfo {
    const workspaceHash = computeWorkspaceHash(opts.workspaceUri ?? 'no-workspace');
    state = { sessionId: opts.sessionId, workspaceHash };
    return state;
}

export function currentSession(): SessionInfo {
    if (!state) {
        throw new Error(
            'Raven knit session state not initialized. Call initSessionState() at activation.',
        );
    }
    return state;
}

export function maybeCurrentSession(): SessionInfo | null {
    return state;
}

/** Test-only: clear the session so a fresh init can run. */
export function __resetSessionStateForTests(): void {
    state = null;
}

export async function cleanupCurrentSession(): Promise<void> {
    if (!state) return;
    const root = sessionRoot(state.workspaceHash, state.sessionId);
    try {
        await fs.promises.rm(root, { recursive: true, force: true });
    } catch {
        /* ignore — best effort */
    }
}

/**
 * Remove stale `<workspaceHash>/<sessionId>/` directories whose mtime is
 * older than `maxAgeMs`. Runs in the background at activation.
 */
export async function sweepStaleSessions(
    ravenKnitRoot: string,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): Promise<void> {
    let workspaceDirs: string[];
    try {
        workspaceDirs = await fs.promises.readdir(ravenKnitRoot);
    } catch {
        return;
    }
    const now = Date.now();
    for (const wd of workspaceDirs) {
        const wdPath = path.join(ravenKnitRoot, wd);
        let sessions: string[];
        try {
            sessions = await fs.promises.readdir(wdPath);
        } catch {
            continue;
        }
        for (const session of sessions) {
            const sPath = path.join(wdPath, session);
            try {
                const stat = await fs.promises.stat(sPath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    await fs.promises.rm(sPath, { recursive: true, force: true });
                }
            } catch {
                /* ignore */
            }
        }
    }
}
