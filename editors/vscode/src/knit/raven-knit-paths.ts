/**
 * Pure path / hash helpers for the per-session knit temp-dir layout.
 *
 * Layout:
 *   <os.tmpdir()>/raven-knit/<workspaceHash>/<sessionId>/
 *     preview/<sourceHash>/   ← stable per .Rmd, scoped to this VS Code window
 *     export/<uuid>/          ← throwaway, per editor-toolbar export invocation
 *
 * Keeping this module free of `vscode` imports lets it be unit-tested
 * under `bun test`.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

interface UriLike {
    fsPath: string;
}

/**
 * Stable per-document key used by the OperationController registry.
 *
 * Normalizes path separators (so `./foo.Rmd` and `foo.Rmd` collapse) and
 * lowercases on Windows (NTFS is case-insensitive, so the same file under
 * different casings must collapse to one controller). On POSIX-like
 * filesystems case is preserved.
 */
export function canonicalOpKey(uri: UriLike, platform: NodeJS.Platform = process.platform): string {
    const normalized = path.normalize(uri.fsPath);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** SHA-256 of the workspace folder's URI (string). Stable per workspace. */
export function computeWorkspaceHash(workspaceUri: string): string {
    return crypto.createHash('sha256').update(workspaceUri).digest('hex');
}

/** SHA-256 of an absolute .Rmd path. Stable per source file. */
export function computeSourceHash(absPath: string): string {
    return crypto.createHash('sha256').update(absPath).digest('hex');
}

/**
 * True when `absPath` resolves to a path inside `root` (or equal to it)
 * after normalization. Used to gate YAML-supplied CSS paths against
 * traversal-escape attacks.
 */
export function isUnderContainmentRoot(absPath: string, root: string): boolean {
    const normalizedAbs = path.normalize(absPath);
    const normalizedRoot = path.normalize(root);
    const rel = path.relative(normalizedRoot, normalizedAbs);
    if (rel === '') return true;
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Root of all per-session artifacts: `<tmp>/raven-knit/<workspaceHash>/<sessionId>/`. */
export function sessionRoot(workspaceHash: string, sessionId: string): string {
    return path.join(os.tmpdir(), 'raven-knit', workspaceHash, sessionId);
}

/** `<sessionRoot>/preview/<sourceHash>/`. Stable per `.Rmd` for the session. */
export function previewDirFor(workspaceHash: string, sessionId: string, sourceHash: string): string {
    return path.join(sessionRoot(workspaceHash, sessionId), 'preview', sourceHash);
}

/** `<sessionRoot>/export/<uuid>/`. Throwaway per editor-toolbar export. */
export function exportDirFor(workspaceHash: string, sessionId: string, uuid: string): string {
    return path.join(sessionRoot(workspaceHash, sessionId), 'export', uuid);
}
