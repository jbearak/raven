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
import * as os from 'os';
import * as path from 'path';
import { isUnderContainmentRoot } from './raven-knit-paths';

/** Root under which every per-session knit artifact lives. */
export function ravenKnitRoot(): string {
    return path.join(os.tmpdir(), 'raven-knit');
}

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
    if (io.existsSync(persistedOutputPath)) {
        const oldPreviewDir = path.dirname(persistedOutputPath);
        // No-op guard: if the persisted dir already IS the current path
        // (e.g. session id unchanged), there is nothing to move.
        if (path.resolve(oldPreviewDir) === path.resolve(current.previewDir)) {
            return io.existsSync(htmlPath)
                ? { htmlPath, available: true, reason: 'reused' }
                : { htmlPath, available: false, reason: 'missing-source' };
        }
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
        io.touch(current.previewDir);
        return io.existsSync(htmlPath)
            ? { htmlPath, available: true, reason: 'adopted' }
            : { htmlPath, available: false, reason: 'missing-source' };
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
        .filter((s) => args.nowMs - s.recencyMs > args.ageThresholdMs)
        .map((s) => s.path);
}
