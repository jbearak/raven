import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Which binary runs `raven console`. No `vscode` import, so the bun suite can
 * test it directly.
 *
 * `raven.server.path` can point at a Raven from before the console existed;
 * v0.21 and older reject `console` with "Unknown argument", which would leave
 * every console and package task without R. `console --help` exits 0 only
 * where the subcommand exists, so a configured binary that fails it is
 * skipped for the console in favor of the bundled one (the language server
 * still uses the configured binary). Results are cached by the file the
 * binary resolves to (through PATH for a bare command name), its size and
 * modification time, so a rebuilt binary is probed again.
 */

/** The server binary the user configured, if any, and the bundled one. */
export type ServerBinaries = { configured: string | undefined; bundled: string };

const PROBE_TIMEOUT_MS = 5000;

/** Whether `binary` has the `console` subcommand. Never rejects. */
export function probe_console_support(binary: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const child = execFile(binary, ['console', '--help'], { timeout: PROBE_TIMEOUT_MS }, (err) => resolve(!err));
            child.stdin?.end();
        } catch {
            resolve(false);
        }
    });
}

const probed = new Map<string, { stamp: string; ok: Promise<boolean> }>();

/**
 * The file `execFile(binary)` runs. A bare command name (no directory) is
 * looked up on the extension host's PATH, in order, as `execFile` does
 * (on POSIX an empty entry is the working directory; on Windows the working
 * directory comes first, and each directory is tried with `.com` and
 * `.exe`, after the name as given only if it has an extension, as libuv
 * does). Anything else names a file relative to the working directory.
 */
function file_run_for(binary: string): string | undefined {
    const bare = path.basename(binary) === binary && !binary.includes('/');
    // With PATH unset the lookup falls back to platform defaults; don't
    // guess which file that finds (the result just isn't cached).
    if (bare && process.env.PATH === undefined) return undefined;
    // libuv parses quoted Windows PATH entries; don't guess at those either.
    if (bare && process.platform === 'win32' && process.env.PATH?.includes('"')) return undefined;
    const candidates = bare
        ? [
            // libuv on Windows looks in the working directory first.
            ...(process.platform === 'win32' ? [process.cwd()] : []),
            ...(process.env.PATH ?? '').split(path.delimiter)
                .map((dir) => (dir === '' && process.platform !== 'win32' ? '.' : dir))
                .filter(Boolean),
        ].flatMap((dir) =>
            (process.platform !== 'win32' ? [''] : path.extname(binary) === '' ? ['.com', '.exe'] : ['', '.com', '.exe'])
                .map((ext) => path.join(dir, binary + ext)))
        : [binary];
    return candidates.find((file) => {
        try {
            // `execvp` passes over files it can't execute.
            if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    });
}

/**
 * Identifies the file `binary` runs, so a replaced binary (or a different
 * one earlier on PATH) is probed again. Undefined when that file can't be
 * found: such a result isn't cached.
 */
function stamp_of(binary: string): string | undefined {
    const file = file_run_for(binary);
    if (file === undefined) return undefined;
    try {
        const s = fs.statSync(file);
        return `${file}:${s.size}:${s.mtimeMs}`;
    } catch {
        return undefined;
    }
}

/**
 * The binary to run `console` with: the configured one if it has the
 * subcommand, else the bundled one, after calling `on_fallback` with the
 * configured path so the caller can say so.
 */
export async function console_binary(
    binaries: ServerBinaries,
    on_fallback: (configured: string) => void,
    probe: (binary: string) => Promise<boolean> = probe_console_support,
): Promise<string> {
    const { configured, bundled } = binaries;
    if (!configured || configured === bundled) return bundled;
    const stamp = stamp_of(configured);
    let entry = probed.get(configured);
    if (stamp === undefined) {
        probed.delete(configured);
        entry = { stamp: '', ok: probe(configured) };
    } else if (!entry || entry.stamp !== stamp) {
        entry = { stamp, ok: probe(configured) };
        probed.set(configured, entry);
    }
    if (await entry.ok) return configured;
    on_fallback(configured);
    return bundled;
}

/** Test-only: forget every probe result. */
export function _clear_console_probes_for_test(): void {
    probed.clear();
}
