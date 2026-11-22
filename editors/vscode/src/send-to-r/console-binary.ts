import { execFile } from 'child_process';
import * as fs from 'fs';

/**
 * Which binary runs `raven console`. No `vscode` import, so the bun suite can
 * test it directly.
 *
 * `raven.server.path` can point at a Raven from before the console existed;
 * v0.21 and older reject `console` with "Unknown argument", which would leave
 * every console and package task without R. `console --help` exits 0 only
 * where the subcommand exists, so a configured binary that fails it is
 * skipped for the console in favor of the bundled one (the language server
 * still uses the configured binary). Results are cached by path, size and
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

function stamp_of(binary: string): string {
    try {
        const s = fs.statSync(binary);
        return `${s.size}:${s.mtimeMs}`;
    } catch {
        return 'missing';
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
    if (!entry || entry.stamp !== stamp) {
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
