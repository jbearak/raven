/**
 * Pandoc subprocess engine. Mirrors the shape of `knit-engine.ts`:
 *
 *   - `child_process.spawn` with the resolved Pandoc path + args array
 *     (never the shell, never string concatenation).
 *   - SIGINT → SIGTERM → SIGKILL escalation ladder for cancel/timeout.
 *   - stderr piped into the knit output channel for the user to inspect.
 *
 * Critical invariant: the destination output is written via temp-then-
 * rename. Pandoc's `-o` flag points to a sibling temp file in the
 * destination's directory; on Pandoc's clean exit we rename over the
 * final destination. On cancel or failure we unlink the temp file
 * without touching any prior good output at the destination path.
 *
 * `cwd` MUST be the directory containing the `.md`. This is what makes
 * relative `figure/foo.png` references resolve against the freshly-
 * generated temp `figure/` and not against stale source-directory
 * artifacts left over from earlier knit runs.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { OutputChannel } from 'vscode';
import type { OperationController } from './operation-controller';
import { chooseTempPath, interpretExitResult } from './pandoc-engine-helpers';

export interface PandocConvertOpts {
    pandocPath: string;
    /**
     * Args from `buildPandocArgs`. We pass them as-is except we strip
     * any `-o <path>` pair and re-add `-o <tmpOut>` so the rename
     * machinery owns the destination contract. Defensive — the
     * intended call site already supplies `-o` pointing at the final
     * destination, but we want a single source of truth for the temp
     * path.
     */
    args: string[];
    mdPath: string;
    destPath: string;
    /** Pandoc cwd — MUST be the directory containing `mdPath`. */
    cwd: string;
    /** SIGINT → SIGTERM → SIGKILL hard deadline. */
    timeoutMs: number;
    controller: OperationController;
    output: OutputChannel;
}

export interface PandocConvertResult {
    status: 'success' | 'cancelled' | 'failure';
    stderr: string;
}

export async function pandocConvert(opts: PandocConvertOpts): Promise<PandocConvertResult> {
    const rand = crypto.randomBytes(6).toString('hex');
    const tmpOut = chooseTempPath(opts.destPath, { pid: process.pid, rand });

    // Strip any pre-existing `-o <path>` pair from incoming args, then
    // add our own. Defense in depth — `buildPandocArgs` will already
    // have placed `-o <destPath>`; replacing with the temp output keeps
    // the temp-then-rename contract intact.
    const args: string[] = [];
    for (let i = 0; i < opts.args.length; i++) {
        if (opts.args[i] === '-o') {
            i++; // skip the value too
            continue;
        }
        args.push(opts.args[i]);
    }
    args.push('-o', tmpOut);

    return new Promise<PandocConvertResult>((resolve) => {
        const child = child_process.spawn(opts.pandocPath, args, { cwd: opts.cwd });
        let stderr = '';
        let cancelled = false;
        let termTimer: NodeJS.Timeout | null = null;
        let killTimer: NodeJS.Timeout | null = null;

        const clearKillTimers = () => {
            if (termTimer) clearTimeout(termTimer);
            if (killTimer) clearTimeout(killTimer);
            termTimer = null;
            killTimer = null;
        };

        const escalate = () => {
            try {
                child.kill('SIGINT');
            } catch {
                /* ignore */
            }
            termTimer = setTimeout(() => {
                try {
                    child.kill('SIGTERM');
                } catch {
                    /* ignore */
                }
                killTimer = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        /* ignore */
                    }
                }, 1500);
            }, 1500);
        };

        const cancelPoll = setInterval(() => {
            if (opts.controller.cancelled && !cancelled) {
                cancelled = true;
                escalate();
                clearInterval(cancelPoll);
            }
        }, 100);

        const hardDeadline = setTimeout(() => {
            if (cancelled) return;
            cancelled = true;
            escalate();
        }, opts.timeoutMs);

        child.stderr?.on('data', (buf: Buffer) => {
            const text = buf.toString();
            stderr += text;
            opts.output.append(`[pandoc] ${text}`);
        });

        child.on('error', (err) => {
            clearInterval(cancelPoll);
            clearTimeout(hardDeadline);
            clearKillTimers();
            opts.output.appendLine(`[pandoc] spawn error: ${err.message}`);
            resolve({ status: 'failure', stderr: stderr + err.message });
        });

        child.on('close', async (code, signal) => {
            clearInterval(cancelPoll);
            clearTimeout(hardDeadline);
            clearKillTimers();

            const exit = interpretExitResult({ code, signal, cancelled });

            if (exit.status === 'success') {
                try {
                    await fs.promises.rename(tmpOut, opts.destPath);
                } catch {
                    // Cross-device fallback: copy then unlink.
                    try {
                        await fs.promises.copyFile(tmpOut, opts.destPath);
                        await fs.promises.unlink(tmpOut);
                    } catch (err2) {
                        opts.output.appendLine(
                            `[pandoc] Failed to finalize ${opts.destPath}: ${(err2 as Error).message}`,
                        );
                        resolve({ status: 'failure', stderr });
                        return;
                    }
                }
                resolve({ status: 'success', stderr });
            } else {
                try {
                    await fs.promises.unlink(tmpOut);
                } catch {
                    /* ignore — temp may not exist if pandoc never wrote it */
                }
                resolve({ status: exit.status, stderr });
            }
        });
    });
}
