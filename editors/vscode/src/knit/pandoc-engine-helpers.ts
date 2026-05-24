/**
 * Pure helpers extracted from `pandoc-engine.ts` so they can be
 * unit-tested without spawning subprocesses.
 */

import * as path from 'path';

export interface TempPathOpts {
    pid: number;
    rand: string;
}

/**
 * Sibling temp file in the same directory as `destPath`. The same-dir
 * placement is required for `fs.promises.rename` to be atomic on POSIX
 * and Windows (a cross-device rename would silently fall back to copy +
 * unlink and lose atomicity).
 */
export function chooseTempPath(destPath: string, opts: TempPathOpts): string {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath);
    return path.join(dir, `.${base}.${opts.pid}.${opts.rand}.tmp`);
}

export interface ExitInput {
    code: number | null;
    signal: NodeJS.Signals | null;
    cancelled: boolean;
}

export type ExitResult =
    | { status: 'success' }
    | { status: 'cancelled' }
    | { status: 'failure' };

export function interpretExitResult(input: ExitInput): ExitResult {
    if (input.cancelled) return { status: 'cancelled' };
    if (input.code === 0) return { status: 'success' };
    return { status: 'failure' };
}
