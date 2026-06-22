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
import { computeSourceHash, computeWorkspaceHash, sessionRoot } from './raven-knit-paths';

export interface SessionInfo {
    sessionId: string;
    /**
     * Hash of the first workspace folder URI when a workspace is open.
     * `null` when no workspace is open — in single-file mode we defer
     * computing `workspaceHash` until a knit-time `.Rmd` is known, then
     * substitute `sha256(parentDir(rmdAbsPath))` per the spec.
     */
    workspaceHash: string | null;
}

let state: SessionInfo | null = null;

export interface InitSessionStateOpts {
    sessionId: string;
    /** First workspace folder's URI string, or `null` when no workspace is open. */
    workspaceUri: string | null;
}

export function initSessionState(opts: InitSessionStateOpts): SessionInfo {
    const workspaceHash = opts.workspaceUri ? computeWorkspaceHash(opts.workspaceUri) : null;
    state = { sessionId: opts.sessionId, workspaceHash };
    return state;
}

/**
 * Resolve the workspace hash to use for a particular `.Rmd`. Honors
 * the configured workspace when one is open; falls back to a hash of
 * the .Rmd's parent directory in single-file mode. This keeps two
 * single-file `.Rmd` files in different directories isolated from each
 * other while still producing a deterministic path.
 */
export function workspaceHashFor(rmdAbsPath: string): string {
    if (!state) {
        throw new Error('Raven knit session state not initialized.');
    }
    if (state.workspaceHash !== null) return state.workspaceHash;
    return computeSourceHash(path.dirname(rmdAbsPath));
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

/**
 * Remove this session's temp artifacts at deactivation.
 *
 * When `persistPreview` is false (the feature is disabled) this removes
 * the entire session root immediately — the historical behavior.
 *
 * When `persistPreview` is true, the open Knit Preview panels are about
 * to be serialized by VS Code and restored on the next launch, so their
 * `preview/<sourceHash>/` artifacts MUST survive. We therefore remove
 * only the throwaway `export/` subtree and leave `preview/` in place.
 * (Closed panels already self-clean their own `preview/<sourceHash>` dir
 * via `KnitOutputPanel.onDidDispose → requestPreviewDirDeletion`, so the
 * only preview dirs left at shutdown back panels that are still open —
 * exactly the set restore needs.) Orphaned leftovers are reclaimed by
 * `sweepStaleSessions` (>7 days) and the `Raven: Clean Up Knit Preview
 * Cache` command.
 */
export async function cleanupCurrentSession(persistPreview: boolean = false): Promise<void> {
    if (!state) return;
    if (state.workspaceHash === null) {
        // Single-file mode — per-`.Rmd` parent-dir hashes were used.
        // We can't enumerate them at cleanup without keeping a registry,
        // so we sweep the whole sessionId by walking every workspaceHash
        // directory that contains our sessionId subdir. Best effort.
        const knitRoot = path.join(require('os').tmpdir(), 'raven-knit');
        let workspaceDirs: string[];
        try { workspaceDirs = await fs.promises.readdir(knitRoot); } catch { return; }
        for (const wd of workspaceDirs) {
            const sessionPath = path.join(knitRoot, wd, state.sessionId);
            const target = persistPreview ? path.join(sessionPath, 'export') : sessionPath;
            try { await fs.promises.rm(target, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        return;
    }
    const root = sessionRoot(state.workspaceHash, state.sessionId);
    const target = persistPreview ? path.join(root, 'export') : root;
    try {
        await fs.promises.rm(target, { recursive: true, force: true });
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
