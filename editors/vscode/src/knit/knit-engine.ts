/**
 * Spawns the `R --no-save --no-restore -e <expression>` subprocess that
 * runs `rmarkdown::render`, streams its output to a VS Code
 * OutputChannel, and supports cooperative cancel with a SIGINT → SIGTERM
 * → SIGKILL signal ladder.
 *
 * Process-group nuances:
 *   - POSIX: We spawn the child with `detached: true` so it leads a new
 *     process group, then signal that group via `process.kill(-pid, …)`
 *     so any pandoc / tinytex / xelatex helpers rmarkdown spawns are
 *     reaped along with R itself. This matches the spec's "kill the
 *     group" requirement.
 *   - Windows: Node's POSIX-style signals are not meaningful on Windows.
 *     Both escalation steps use `taskkill /T /F`, which walks the
 *     process tree and force-terminates it.
 *
 * The engine is deliberately I/O-only: format detection, gate checks,
 * YAML parsing, and R-expression construction all happen in pure
 * modules (`yaml-frontmatter`, `r-expression`) so this file stays
 * testable by running against a fake spawner if we ever choose to.
 */

import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';

export interface KnitEngineOptions {
    rBinary: string;
    expression: string;
    cwd: string;
    /** Hard timeout; SIGKILL on expiry. */
    timeoutMs: number;
    output: vscode.OutputChannel;
    cancellation: vscode.CancellationToken;
}

export interface KnitEngineResult {
    exitCode: number | null;
    /** Captured stdout for `parseRenderedOutputPath` to read. */
    stdout: string;
    /** True when the run was aborted by the user or by timeout. */
    cancelled: boolean;
    timedOut: boolean;
    /** Spawn-time error (e.g. ENOENT). null on a clean spawn. */
    spawnError: NodeJS.ErrnoException | null;
}

const SIGINT_TO_SIGTERM_MS = 5000;
const SIGTERM_TO_SIGKILL_MS = 5000;

export async function runKnit(opts: KnitEngineOptions): Promise<KnitEngineResult> {
    const { rBinary, expression, cwd, timeoutMs, output, cancellation } = opts;

    const args = ['--no-save', '--no-restore', '-e', expression];
    let child: ChildProcess;
    try {
        child = spawn(rBinary, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            // POSIX: lead a new process group so `process.kill(-pid)`
            // reaches pandoc / tinytex / xelatex helpers rmarkdown spawns.
            // Windows: `detached: true` opens a new console window, so we
            // keep the default there and rely on `taskkill /T /F` for the
            // tree kill instead.
            detached: process.platform !== 'win32',
            env: process.env,
        });
    } catch (err) {
        return {
            exitCode: null,
            stdout: '',
            cancelled: false,
            timedOut: false,
            spawnError: err as NodeJS.ErrnoException,
        };
    }

    let stdout = '';
    let cancelled = false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let closed = false;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        output.append(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
            if (line === '') continue;
            output.appendLine(`[stderr] ${line}`);
        }
    });
    child.on('error', (err) => {
        spawnError = err as NodeJS.ErrnoException;
    });

    const timers: NodeJS.Timeout[] = [];
    const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers.length = 0;
    };
    const escalate = () => {
        if (closed) return;
        try { sendSignal(child, 'SIGINT'); } catch { /* noop */ }
        timers.push(setTimeout(() => {
            if (closed) return;
            sendSignal(child, 'SIGTERM');
            timers.push(setTimeout(() => {
                if (closed) return;
                sendSignal(child, 'SIGKILL');
            }, SIGTERM_TO_SIGKILL_MS));
        }, SIGINT_TO_SIGTERM_MS));
    };

    const cancelHook = cancellation.onCancellationRequested(() => {
        if (cancelled) return;
        cancelled = true;
        escalate();
    });

    const timeoutHandle = setTimeout(() => {
        if (timedOut) return;
        timedOut = true;
        escalate();
    }, timeoutMs);
    timers.push(timeoutHandle);

    const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', (code) => {
            closed = true;
            resolve(code);
        });
    });

    clearTimers();
    cancelHook.dispose();

    return { exitCode, stdout, cancelled, timedOut, spawnError };
}

function sendSignal(child: ChildProcess, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
    try {
        if (process.platform === 'win32') {
            // SIGINT is meaningless on Windows; both SIGTERM and SIGKILL
            // walk the tree via taskkill so detached helpers are reaped.
            if (signal === 'SIGINT') {
                // First-step "give R a chance" maps to plain taskkill (no /F),
                // but we still pass /T so a hung helper doesn't outlive R.
                runTaskkill(child, false);
                return;
            }
            runTaskkill(child, true);
            return;
        }
        // POSIX: signal the process group so helpers (pandoc / xelatex)
        // are reaped along with R. `detached: true` at spawn time put R
        // into its own group.
        if (child.pid !== undefined) {
            try {
                process.kill(-child.pid, signal);
                return;
            } catch (err) {
                // Falls through to direct kill if the group is gone (e.g.
                // child already exited). EPERM / ESRCH are common.
                void err;
            }
        }
        child.kill(signal);
    } catch {
        // Best effort; the close listener still resolves once the OS reaps the child.
    }
}

function runTaskkill(child: ChildProcess, force: boolean): void {
    if (child.pid === undefined) return;
    const args = force
        ? ['/PID', String(child.pid), '/T', '/F']
        : ['/PID', String(child.pid), '/T'];
    const tk = spawn('taskkill', args, { stdio: 'ignore' });
    tk.on('error', () => { /* swallow */ });
}
