import type { TerminalProgram } from './console-choice';

/**
 * Terminals the profile provider has described but VS Code hasn't opened yet.
 *
 * VS Code creates the terminal from the returned profile itself, so Raven only
 * meets it later in `onDidOpenTerminal`. Each launch carries a unique
 * `RAVEN_TERMINAL_ID` in its environment, and the open handler claims the
 * entry with that id. The terminal's name is not identity: an unrelated
 * terminal can share it, and overlapping launches can open out of order.
 */
export type PendingProfile = {
    program: TerminalProgram;
    /** Raven's console only: where it listens for code. */
    consoleSocket?: string;
    /** Plot/data-viewer session the terminal's R profile reports to. */
    sessionId?: string;
    generatedAtMs: number;
};

/** Env var that ties an opened terminal to its pending profile entry. */
export const TERMINAL_ID_ENV = 'RAVEN_TERMINAL_ID';

/**
 * Removes and returns the entry for `id`, first dropping entries older than
 * `ttl_ms` (launches VS Code never opened). Returns null for an unknown or
 * expired id.
 */
export function take_pending_profile(
    pending: Map<string, PendingProfile>,
    id: string | undefined,
    now_ms: number = Date.now(),
    ttl_ms: number = 30_000,
): PendingProfile | null {
    for (const [key, entry] of pending) {
        if (now_ms - entry.generatedAtMs > ttl_ms) pending.delete(key);
    }
    if (id === undefined) return null;
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    return entry;
}
