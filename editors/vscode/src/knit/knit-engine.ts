/**
 * Spawns the `R --no-save --no-restore -e <expression>` subprocess that
 * runs `rmarkdown::render`, streams its output to a VS Code
 * OutputChannel, and supports cooperative cancel with a SIGINT → SIGTERM
 * → SIGKILL signal ladder. Windows takes a fast `taskkill /T /F` path
 * because Node has no portable signal model there.
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
            // detached: false ensures we don't form a new process group on
            // POSIX; on Windows it's a no-op for our taskkill path.
            detached: false,
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

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        output.append(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        // Prefix each line so users can distinguish stderr at a glance.
        for (const line of chunk.split(/\r?\n/)) {
            if (line === '') continue;
            output.appendLine(`[stderr] ${line}`);
        }
    });
    child.on('error', (err) => {
        // ENOENT (R not on PATH) lands here on POSIX.
        spawnError = err as NodeJS.ErrnoException;
    });

    const timers: NodeJS.Timeout[] = [];
    const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers.length = 0;
    };
    const escalate = () => {
        if (child.exitCode !== null || child.killed) return;
        try { child.kill('SIGINT'); } catch { /* noop */ }
        timers.push(setTimeout(() => {
            if (child.exitCode !== null || child.killed) return;
            killHard(child, 'SIGTERM');
            timers.push(setTimeout(() => {
                if (child.exitCode !== null || child.killed) return;
                killHard(child, 'SIGKILL');
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
        child.on('close', (code) => resolve(code));
    });

    clearTimers();
    cancelHook.dispose();

    return { exitCode, stdout, cancelled, timedOut, spawnError };
}

function killHard(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
        if (process.platform === 'win32') {
            // Node on Windows accepts kill() but the signal is ignored;
            // taskkill /T (tree) /F (force) is the reliable path.
            const { spawn: spawnSync } = require('child_process') as typeof import('child_process');
            if (child.pid !== undefined) {
                const tk = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                    stdio: 'ignore',
                });
                tk.on('error', () => { /* swallow */ });
            }
            return;
        }
        child.kill(signal);
    } catch {
        // Best effort; the close listener still resolves once the OS reaps the child.
    }
}
