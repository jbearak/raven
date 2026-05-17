import * as path from 'path';
import { parseRenderedOutputPath } from './output-path';

export type KnitOutputMessage =
    | { type: 'refresh' }
    | { type: 'openInBrowser' };

/**
 * Strict type-narrowing for messages posted from the Knit Output webview.
 * The webview is a trust boundary; reject anything we did not explicitly
 * shape. Additional unknown properties on a recognized type are allowed
 * (the handler ignores them).
 */
export function isKnitOutputMessage(msg: unknown): msg is KnitOutputMessage {
    if (msg === null || typeof msg !== 'object') return false;
    const t = (msg as { type?: unknown }).type;
    return t === 'refresh' || t === 'openInBrowser';
}

/**
 * Possible outcomes of a single `runKnit` invocation, after we have
 * classified the raw engine result. Discriminated by `kind`. No user-
 * facing toasts or webview operations have been performed yet — that
 * happens in `renderOutcome`, OUTSIDE the `withProgress` callback. This
 * is the core of the Piece A bug fix: keeping the `withProgress`
 * lifecycle short and predictable.
 */
export type KnitOutcome =
    | { kind: 'spawnError'; error: NodeJS.ErrnoException }
    | { kind: 'cancelled' }
    | { kind: 'timedOut'; timeoutMs?: number }
    | { kind: 'failed'; exitCode: number | null }
    | { kind: 'noOutput' }
    | { kind: 'ok'; parsedOutputs: string[]; cwd: string | undefined };

/** Minimal subset of `runKnit`'s return value classify needs. */
export interface ClassifyInput {
    spawnError: NodeJS.ErrnoException | null;
    cancelled: boolean;
    timedOut: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Pure classifier mapping the engine's raw result onto a KnitOutcome.
 * Branch priority mirrors the original runKnitCommand:
 *   spawnError > cancelled > timedOut > failed > noOutput / ok
 */
export function classify(
    result: ClassifyInput,
    ctx: { cwd: string | undefined },
): KnitOutcome {
    if (result.spawnError) return { kind: 'spawnError', error: result.spawnError };
    if (result.cancelled) return { kind: 'cancelled' };
    if (result.timedOut) return { kind: 'timedOut' };
    if (result.exitCode !== 0) return { kind: 'failed', exitCode: result.exitCode };
    const parsed = parseRenderedOutputPath(result.stdout + '\n' + result.stderr).paths;
    if (parsed.length === 0) return { kind: 'noOutput' };
    return { kind: 'ok', parsedOutputs: parsed, cwd: ctx.cwd };
}

/**
 * Pick the output path to surface in the Knit Output panel.
 *
 * When `output_format = "all"` (or a custom multi-format render) produces
 * a mix of formats, the user almost always wants the HTML viewer rather
 * than e.g. revealing a PDF in the file browser. Prefer the first HTML
 * output; fall back to the first entry overall.
 *
 * Codex adversarial review #4 on the v1 spec called out that v1 always
 * used `parsed.paths[0]`, which would hide an HTML output behind a
 * PDF/DOCX-first reveal.
 */
export function pickPrimaryOutput(paths: readonly string[]): string | undefined {
    if (paths.length === 0) return undefined;
    const html = paths.find((p) => {
        const ext = path.extname(p).toLowerCase();
        return ext === '.html' || ext === '.htm';
    });
    return html ?? paths[0];
}
