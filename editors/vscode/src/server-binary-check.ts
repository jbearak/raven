import * as fs from 'fs';

export type ServerBinaryCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify that a path points to a usable LSP server binary before we try to
 * spawn it. The vscode-languageclient library produces a generic "couldn't
 * create connection to server" toast on any spawn failure, which gives the
 * user no actionable information. Running this check first lets `activate()`
 * surface the actual cause (missing file, wrong target, no exec bit) and
 * skip the LSP start that's guaranteed to fail.
 *
 * Pure — no vscode dependency — so it can be exercised from Bun tests.
 */
export function validateServerBinary(serverPath: string): ServerBinaryCheck {
    let stats: fs.Stats;
    try {
        stats = fs.statSync(serverPath);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `not found: ${msg}` };
    }
    if (!stats.isFile()) {
        return { ok: false, reason: `not a regular file (is a directory or special file): ${serverPath}` };
    }
    if (process.platform !== 'win32') {
        try {
            fs.accessSync(serverPath, fs.constants.X_OK);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, reason: `not executable: ${msg}` };
        }
    }
    return { ok: true };
}
