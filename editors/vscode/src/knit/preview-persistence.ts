/**
 * Filesystem helpers backing Knit Preview persistence across window
 * reload/restart.
 *
 * Two concerns live here, deliberately kept apart from the `vscode`-aware
 * panel code so they can be unit-tested under `bun test`:
 *
 *  - `adoptPreviewArtifacts` — on restore, fold the orphaned old-session
 *    preview dir (recorded in the webview's persisted state) into the
 *    *current* session's preview path for that source. Adoption keeps the
 *    path model consistent: a later "Knit again" is then a normal in-place
 *    update (same `rootDir`) rather than a `rootDir` change that would
 *    dispose-and-recreate the panel.
 *  - `selectStaleSessionDirs` — the pure selection predicate behind the
 *    `Raven: Clean Up Knit Preview Cache` command. The impure directory
 *    walk lives in the command handler; this predicate decides what to
 *    remove given a listing, so it is testable without touching disk.
 *
 * See `docs/superpowers/specs/2026-06-22-knit-preview-persistence-design.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isUnderContainmentRoot, ravenKnitRoot } from './raven-knit-paths';

// Re-exported so persistence callers can reach the knit-temp root without
// also importing the path module. `raven-knit-paths` is the single owner.
export { ravenKnitRoot };

/**
 * The pair of paths a restore targets for a given source: the
 * current-session preview directory and the rendered HTML inside it.
 * Callers compute this via `previewArtifactPaths(sourceFsPath)`.
 */
export interface CurrentPreviewPaths {
    previewDir: string;
    htmlPath: string;
}

export interface AdoptOutcome {
    /**
     * The HTML path the restored panel should point at — always the
     * *current* session's preview HTML path, whether or not a usable
     * artifact exists there. Pointing at the current-session path means a
     * subsequent "Knit again" writes to the same dir (no `rootDir`
     * change), and the panel updates in place.
     */
    htmlPath: string;
    /**
     * True when a readable rendered artifact now exists at `htmlPath`
     * (either it already did, or we adopted the old-session dir into
     * place). False means the caller should render the "knit again"
     * placeholder — there was nothing to restore.
     */
    available: boolean;
    /** Coarse reason, for logging/tests. */
    reason: 'reused' | 'adopted' | 'in-progress' | 'rejected-path' | 'missing-source';
}

/**
 * Injection seam so the EXDEV copy-fallback branch is unit-testable.
 * Production omits it and the real `fs` module is used.
 */
export interface AdoptIo {
    existsSync(p: string): boolean;
    renameSync(src: string, dst: string): void;
    cpSync(src: string, dst: string): void;
    rmSync(p: string): void;
    mkdirSync(p: string): void;
    /** Best-effort touch (reset mtime) so the stale sweep clock restarts. */
    touch(p: string): void;
}

const realIo: AdoptIo = {
    existsSync: (p) => fs.existsSync(p),
    renameSync: (src, dst) => fs.renameSync(src, dst),
    cpSync: (src, dst) => fs.cpSync(src, dst, { recursive: true }),
    rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
    mkdirSync: (p) => { fs.mkdirSync(p, { recursive: true }); },
    touch: (p) => {
        try {
            const now = new Date();
            fs.utimesSync(p, now, now);
        } catch {
            /* best-effort */
        }
    },
};

/**
 * Decide what a restoring panel should display, adopting the orphaned
 * old-session preview dir into the current session when appropriate.
 *
 * Order of checks (each falls through to "render placeholder"):
 *  1. **Containment.** `persistedOutputPath` must resolve inside
 *     `<tmp>/raven-knit/`. Persisted webview state crosses a trust
 *     boundary; never drive a `rename`/`rm` from a path outside the tree.
 *  2. **Already present.** If the current-session HTML already exists, use
 *     it — a knit ran this session; nothing to adopt.
 *  3. **In-progress / partial.** If the current-session preview *dir*
 *     exists but its HTML does not, a knit is mid-flight (knit-commands
 *     `mkdir`s the dir before writing). Do not clobber it; show the
 *     placeholder and let that knit update the panel in place when done.
 *  4. **Adopt.** If the persisted HTML exists on disk, move its parent dir
 *     into the current-session preview path (rename, falling back to
 *     recursive copy + remove on EXDEV), reset mtime, and use it.
 *  5. Otherwise the source artifact is gone → placeholder.
 */
export function adoptPreviewArtifacts(
    current: CurrentPreviewPaths,
    persistedOutputPath: string,
    io: AdoptIo = realIo,
): AdoptOutcome {
    const htmlPath = current.htmlPath;

    // (1) Containment — reject anything outside the knit temp tree.
    if (
        typeof persistedOutputPath !== 'string'
        || persistedOutputPath.length === 0
        || !isUnderContainmentRoot(persistedOutputPath, ravenKnitRoot())
    ) {
        return { htmlPath, available: false, reason: 'rejected-path' };
    }

    // (2) Current-session output already present.
    if (io.existsSync(htmlPath)) {
        return { htmlPath, available: true, reason: 'reused' };
    }

    // (3) Current-session dir exists without its HTML → knit in progress.
    if (io.existsSync(current.previewDir)) {
        return { htmlPath, available: false, reason: 'in-progress' };
    }

    // (4) Adopt the old-session dir if its artifact is still on disk.
    // (When the persisted dir already IS the current path — e.g. the
    // session id was unchanged on an in-process reload — its HTML would
    // exist and step 2 has already returned 'reused'; so here the source
    // and destination are always distinct.)
    if (io.existsSync(persistedOutputPath)) {
        const oldPreviewDir = path.dirname(persistedOutputPath);
        // Safety: only adopt a preview dir that belongs to THIS source.
        // Its directory name is the source hash, which is identical to the
        // current-session preview dir's name (same `.Rmd` → same hash,
        // regardless of session/workspace). Containment alone would let a
        // crafted or corrupt persisted path point at a whole session /
        // workspace / other-source directory, which the move below would
        // then relocate wholesale.
        if (path.basename(oldPreviewDir) !== path.basename(current.previewDir)) {
            return { htmlPath, available: false, reason: 'rejected-path' };
        }
        // Move the old dir into the current-session path. This must never
        // throw out of restore: any filesystem failure (EXDEV with a
        // failed copy, EACCES, ENOSPC, …) degrades to the placeholder,
        // detected by the existsSync check below.
        try {
            io.mkdirSync(path.dirname(current.previewDir));
            try {
                io.renameSync(oldPreviewDir, current.previewDir);
            } catch {
                // Cross-device (EXDEV) or other rename failure: copy then
                // best-effort remove the source.
                io.cpSync(oldPreviewDir, current.previewDir);
                try {
                    io.rmSync(oldPreviewDir);
                } catch {
                    /* best-effort — source left behind, swept later */
                }
            }
        } catch {
            /* fall through — existsSync(htmlPath) below decides the outcome */
        }
        if (io.existsSync(htmlPath)) {
            io.touch(current.previewDir);
            return { htmlPath, available: true, reason: 'adopted' };
        }
        return { htmlPath, available: false, reason: 'missing-source' };
    }

    return { htmlPath, available: false, reason: 'missing-source' };
}

/** One discovered `<workspaceHash>/<sessionId>` session directory. */
export interface SessionDirInfo {
    /** Absolute path to the session directory. */
    path: string;
    /** The `<sessionId>` segment (directory name). */
    sessionId: string;
    /**
     * Most recent activity timestamp (ms) observed for this session —
     * the max mtime of the session dir and its immediate `preview/`
     * children, so an actively-rendering session in another window reads
     * as recent even though the top-level dir mtime may lag.
     */
    recencyMs: number;
}

/**
 * Pure selection predicate for `Raven: Clean Up Knit Preview Cache`.
 *
 * Removes only *orphaned* session dirs: never the current session (its
 * open panels — and any in-flight knit — live there), and never a session
 * touched within `ageThresholdMs` (a concurrent window may be actively
 * using it; session ownership cannot be determined cross-process, so
 * recency is the only safe cross-window signal). Everything else is
 * reclaimable.
 */
export function selectStaleSessionDirs(args: {
    sessions: readonly SessionDirInfo[];
    currentSessionId: string;
    nowMs: number;
    ageThresholdMs: number;
}): string[] {
    return args.sessions
        .filter((s) => s.sessionId !== args.currentSessionId)
        // Unknown recency (<= 0 — e.g. a stat that failed under fd
        // pressure) means "don't know how old this is"; never delete it.
        // Without this guard `nowMs - 0 > ageThresholdMs` is always true,
        // so a transient stat failure on a live session would select it
        // for removal.
        .filter((s) => s.recencyMs > 0)
        .filter((s) => args.nowMs - s.recencyMs > args.ageThresholdMs)
        .map((s) => s.path);
}

/**
 * Recency (max mtime, ms) of a session dir and its immediate `preview/`
 * children — so a session actively rendering in another window reads as
 * recent even though the top-level dir mtime can lag behind writes that
 * land inside `preview/<sourceHash>/`. Returns 0 when the dir is gone.
 */
export async function sessionRecencyMs(sessionPath: string): Promise<number> {
    let max = 0;
    try {
        max = (await fs.promises.stat(sessionPath)).mtimeMs;
    } catch {
        /* ignore */
    }
    const previewDir = path.join(sessionPath, 'preview');
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(previewDir, { withFileTypes: true });
    } catch {
        return max;
    }
    const childMtimes = await Promise.all(
        entries.map(async (e) => {
            try {
                return (await fs.promises.stat(path.join(previewDir, e.name))).mtimeMs;
            } catch {
                return 0;
            }
        }),
    );
    for (const m of childMtimes) {
        if (m > max) max = m;
    }
    return max;
}

/**
 * Walk `<root>/<workspaceHash>/<sessionId>/` and return one
 * `SessionDirInfo` per discovered session directory (with its recency).
 * Shared by both reclaimers — the activation-time `sweepStaleSessions`
 * and the manual `Raven: Clean Up Knit Preview Cache` — so they observe
 * the same tree shape and recency definition and cannot drift. Returns
 * `[]` when the root does not exist.
 */
export async function listSessionDirs(root: string): Promise<SessionDirInfo[]> {
    let workspaceDirs: fs.Dirent[];
    try {
        workspaceDirs = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    // Collect the session dirs first, then compute their recencies
    // concurrently — the per-session stat walks are independent.
    const found: Array<{ path: string; sessionId: string }> = [];
    for (const wd of workspaceDirs) {
        if (!wd.isDirectory()) continue;
        const wdPath = path.join(root, wd.name);
        let sessDirs: fs.Dirent[];
        try {
            sessDirs = await fs.promises.readdir(wdPath, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const sd of sessDirs) {
            if (!sd.isDirectory()) continue;
            found.push({ path: path.join(wdPath, sd.name), sessionId: sd.name });
        }
    }
    // Compute recencies in bounded batches: each session's stat walk
    // opens several fds, so an unbounded fan-out over a large accumulated
    // cache could exhaust the process fd limit (EMFILE).
    const RECENCY_CONCURRENCY = 16;
    const out: SessionDirInfo[] = [];
    for (let i = 0; i < found.length; i += RECENCY_CONCURRENCY) {
        const batch = found.slice(i, i + RECENCY_CONCURRENCY);
        const resolved = await Promise.all(
            batch.map(async (f) => ({
                path: f.path,
                sessionId: f.sessionId,
                recencyMs: await sessionRecencyMs(f.path),
            })),
        );
        out.push(...resolved);
    }
    return out;
}
