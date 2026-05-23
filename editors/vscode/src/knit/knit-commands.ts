import * as path from 'path';
import * as vscode from 'vscode';
import {
    Blocker,
    detectBlockers,
    detectFormat,
    extractFrontmatter,
    parseFrontmatter,
} from './yaml-frontmatter';
import {
    buildKnitExpression,
    escapeRString,
    ValidateFormatError,
    ValidatePathError,
} from './r-expression';
import { runKnit } from './knit-engine';
import { computeHtmlOutputPath, computeMdOutputPath } from './knit-paths';
import { runPostKnitRender } from './post-knit-renderer';
import type { LanguageClient } from 'vscode-languageclient/node';
import { resolveRConsoleActivation } from '../r-console-activation';
import { KnitOutputPanel } from './knit-output-panel';
import {
    classify,
    pickPrimaryOutput,
    type KnitOutcome,
} from './knit-output';

const OUTPUT_CHANNEL_NAME = 'Raven: Knit';
const DEFAULT_TIMEOUT_MS = 600_000;

type WorkingDirectoryMode = 'document' | 'project' | 'current';

/**
 * Resolved dependency surface used throughout the knit command. The
 * fields are required at the point of use; the public optional shape
 * (`Partial<KnitDeps>` parameter on `registerKnitCommands`) lets tests
 * override individual functions while production omits the parameter
 * entirely.
 */
export interface KnitDeps {
    runKnit: typeof runKnit;
    showOrUpdatePanel: typeof KnitOutputPanel.showOrUpdate;
    /**
     * The live LSP client used by `runPostKnitRender` to fetch
     * Raven's `function` semantic tokens. `undefined` is tolerated
     * (the renderer falls back to grammar-only highlighting).
     */
    getLanguageClient: () => LanguageClient | undefined;
    /**
     * Post-knit render step. Defaults to `runPostKnitRender`; tests
     * override to avoid touching the filesystem and the markdown API.
     */
    runPostKnitRender: typeof runPostKnitRender;
}

/**
 * Top-level registration. Creates the lazy OutputChannel and registers
 * the two commands listed in `package.json`.
 */
export function registerKnitCommands(
    context: vscode.ExtensionContext,
    deps?: Partial<KnitDeps>,
): void {
    const resolved: KnitDeps = {
        runKnit: deps?.runKnit ?? runKnit,
        showOrUpdatePanel: deps?.showOrUpdatePanel ?? KnitOutputPanel.showOrUpdate,
        getLanguageClient: deps?.getLanguageClient ?? (() => undefined),
        runPostKnitRender: deps?.runPostKnitRender ?? runPostKnitRender,
    };

    let outputChannel: vscode.OutputChannel | undefined;
    const getOutput = (): vscode.OutputChannel => {
        if (!outputChannel) {
            outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
            context.subscriptions.push(outputChannel);
        }
        return outputChannel;
    };

    // Per-file in-flight set. A second knit against a file that's
    // already rendering would race on the same output and confuse the
    // user; we surface a clear info message instead. Keyed by the
    // resolved fsPath after the up-front gate/extension checks.
    const inFlight = new Set<string>();

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'raven.knit',
            async (uri?: vscode.Uri) => {
                await runKnitCommand(uri, getOutput(), inFlight, context, resolved);
            },
        ),
        vscode.commands.registerCommand(
            'raven.knit.openOutputChannel',
            () => getOutput().show(true),
        ),
    );
}

async function runKnitCommand(
    explicitUri: vscode.Uri | undefined,
    output: vscode.OutputChannel,
    inFlight: Set<string>,
    context: vscode.ExtensionContext,
    deps: KnitDeps,
): Promise<void> {
    const docUri = explicitUri ?? vscode.window.activeTextEditor?.document.uri;
    if (!docUri) {
        await vscode.window.showInformationMessage(
            'Raven: Knit requires an active editor with a .Rmd file.',
        );
        return;
    }

    // Re-check the *resolved* gate. The command-palette `when` clauses
    // already gate on `raven.rmdKnit.enabled`, but the command itself is
    // registered unconditionally (so the walkthrough's command-link
    // works), and a stale auto-resolution after REditorSupport is
    // enabled would otherwise let knit run.
    if (resolveRConsoleActivation() !== 'enabled') {
        await vscode.window.showInformationMessage(
            'Raven: Knit is disabled by your `raven.rConsole.activation` setting (or because REditorSupport / Positron is active).',
        );
        return;
    }

    // Reject inputs that aren't file-backed `.Rmd` documents. Order
    // matters: an untitled buffer with `languageId === 'rmd'` has a
    // URI scheme of `untitled` and a path without an extension; we
    // surface "save the file first" rather than the misleading
    // "not a .Rmd file" message. The AGENTS.md "File-type tracking"
    // learning calls this out specifically.
    if (docUri.scheme !== 'file' && docUri.scheme !== 'vscode-remote') {
        await vscode.window.showInformationMessage(
            'Save the file to disk before running Raven: Knit.',
        );
        return;
    }

    if (!vscode.workspace.isTrusted) {
        const MANAGE = 'Manage Workspace Trust';
        const choice = await vscode.window.showInformationMessage(
            'Raven: Knit is disabled in untrusted workspaces.',
            MANAGE,
        );
        if (choice === MANAGE) {
            await vscode.commands.executeCommand('workbench.trust.manage');
        }
        return;
    }

    // After the scheme check passes we know we have a file-backed URI.
    const ext = path.extname(docUri.fsPath || docUri.path).toLowerCase();
    if (ext !== '.rmd') {
        await vscode.window.showInformationMessage(
            'Raven: Knit only runs on .Rmd files.',
        );
        return;
    }

    const fsPath = docUri.fsPath;
    if (!fsPath) {
        await vscode.window.showInformationMessage(
            'Save the file to disk before running Raven: Knit.',
        );
        return;
    }

    let documentText: string;
    let sourceLanguageId: string;
    try {
        const doc = await vscode.workspace.openTextDocument(docUri);
        // knitr reads the .Rmd from disk via R's `readLines`, not from
        // VS Code's in-memory buffer. If the editor has unsaved
        // changes, the knit output would silently reflect the
        // stale-on-disk version — which is indistinguishable from "the
        // knit didn't work" from the user's perspective. Save before
        // running so the disk and the buffer agree.
        //
        // `save()` returns false if a participant (formatter,
        // codeActionsOnSave, etc.) refuses the save. In that case we
        // can't know whether the disk reflects the user's intent, so
        // surface the failure and bail rather than knit a stale file.
        if (doc.isDirty) {
            let saved = false;
            try {
                saved = await doc.save();
            } catch (err) {
                output.show(true);
                output.appendLine(
                    `[knit] save failed for ${fsPath}: ` +
                    (err instanceof Error ? err.message : String(err)),
                );
            }
            if (!saved) {
                await vscode.window.showWarningMessage(
                    `Raven: Knit — could not save ${path.basename(fsPath)}. ` +
                    `The knit output would not reflect your unsaved changes.`,
                );
                return;
            }
        }
        documentText = doc.getText();
        sourceLanguageId = doc.languageId;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Raven: Knit could not read document: ${message}`);
        return;
    }

    // [2] Parse YAML front matter.
    const fmText = extractFrontmatter(documentText) ?? '';
    const parsed = parseFrontmatter(fmText);
    if (!parsed.ok) {
        output.show(true);
        output.appendLine(`[YAML parse error] ${parsed.error}`);
        await vscode.window.showWarningMessage(
            'Raven: Knit — YAML front matter is malformed; see Raven: Knit output.',
        );
        return;
    }

    // [3] Detect deferred-feature blockers.
    const blockers = detectBlockers(parsed.value);
    if (blockers.length > 0) {
        await showBlocker(blockers[0], fsPath);
        return;
    }

    // [4] Format detection.
    //
    // Knit Preview ignores the YAML `output:` block when deciding how
    // to render — we always produce an HTML preview into the per-
    // session temp dir, regardless of `output: pdf_document`,
    // `output: word_document`, etc. The format identifier is still
    // computed (and passed through validation downstream) for logging,
    // but no longer gates execution.
    //
    // Why ignore it? `knitr::knit` doesn't read the `output:` block —
    // that's an rmarkdown concept consumed by `rmarkdown::render`.
    // Honoring it would require switching to rmarkdown (requires
    // Pandoc on the preview path) and losing Raven's TextMate-based
    // syntax highlighting + theme overlay. Trade-off documented in
    // the design spec at docs/superpowers/specs/2026-05-23-knit-preview-export-design.md.
    const format = detectFormat(parsed.value);

    // [5] Resolve working directory.
    const workingDirectoryMode = vscode.workspace
        .getConfiguration('raven.knit')
        .get<WorkingDirectoryMode>('workingDirectory', 'document');
    const knitDirResult = resolveKnitDir(docUri, workingDirectoryMode);
    if (!knitDirResult.ok) {
        await vscode.window.showErrorMessage(knitDirResult.error);
        return;
    }
    const { knitRootDir, cwd } = knitDirResult;

    // [6] Build R expression.
    // Predict the intermediate .md path. knitr's default is "strip
    // the .Rmd extension, append .md". We pass it explicitly so the
    // TS-side renderer doesn't have to re-derive — and so any future
    // user-overridable output location can flow through one place.
    const mdOutputPath = computeMdOutputPath(fsPath);

    let expression: string;
    try {
        expression = buildKnitExpression({
            filePath: fsPath,
            outputPath: mdOutputPath,
            format,
            knitRootDir,
        });
    } catch (err) {
        const isPathError = err instanceof ValidatePathError;
        const isFormatError = err instanceof ValidateFormatError;
        const message = err instanceof Error ? err.message : String(err);
        output.show(true);
        output.appendLine(`[validation] ${message}`);
        const surface = isFormatError
            ? `Raven: Knit — unsupported output format identifier in YAML.`
            : isPathError
                ? `Raven: Knit — file path contains an unsupported character. See output for details.`
                : `Raven: Knit — validation failed. See output for details.`;
        await vscode.window.showErrorMessage(surface);
        return;
    }

    // [7] Spawn + [8] Stream + [9] Exit.
    const rBinary = resolveRBinary();
    const timeoutMs = readTimeoutMs();
    const baseName = path.basename(fsPath);

    // Concurrent-knit guard. Re-invoking the command on a file that's
    // already rendering produces two progress notifications, two R
    // subprocesses, and interleaved output into the shared channel.
    // Surface a clear info message instead. The key is the absolute
    // fsPath so the same file under different relative URIs collapses.
    if (inFlight.has(fsPath)) {
        await vscode.window.showInformationMessage(
            `Raven: Knit — ${baseName} is already being knitted.`,
        );
        return;
    }
    inFlight.add(fsPath);

    output.appendLine(`---`);
    output.appendLine(`Knitting ${fsPath}`);
    output.appendLine(`R: ${rBinary}`);
    output.appendLine(`Expression: ${expression}`);
    output.appendLine(`cwd: ${cwd}`);
    output.appendLine(``);

    let outcome: KnitOutcome;
    try {
        outcome = await vscode.window.withProgress<KnitOutcome>(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Knitting ${baseName}…`,
                cancellable: true,
            },
            async (_progress, token) => {
                const result = await deps.runKnit({
                    rBinary,
                    expression,
                    cwd,
                    timeoutMs,
                    output,
                    cancellation: token,
                });
                return classify(result, { cwd });
            },
        );
    } finally {
        // Critical: inFlight.delete runs the moment withProgress resolves,
        // BEFORE any user-facing toast is awaited. This is the Piece A
        // fix — under the previous code, awaiting showInformationMessage
        // inside the withProgress callback held both the progress
        // notification AND the inFlight gate open until the user
        // dismissed the toast, causing a spurious "already being knitted"
        // on rapid re-invocation.
        inFlight.delete(fsPath);
    }

    await renderOutcome(outcome, {
        fsPath,
        baseName,
        sourceUri: docUri,
        sourceLanguageId,
        cwd,
        output,
        rBinary,
        timeoutMs,
        context,
        showOrUpdatePanel: deps.showOrUpdatePanel,
        getLanguageClient: deps.getLanguageClient,
        runPostKnitRender: deps.runPostKnitRender,
    });
}

interface RenderOutcomeCtx {
    fsPath: string;
    baseName: string;
    sourceUri: vscode.Uri;
    sourceLanguageId: string;
    cwd: string | undefined;
    output: vscode.OutputChannel;
    rBinary: string;
    timeoutMs: number;
    context: vscode.ExtensionContext;
    showOrUpdatePanel: KnitDeps['showOrUpdatePanel'];
    getLanguageClient: KnitDeps['getLanguageClient'];
    runPostKnitRender: KnitDeps['runPostKnitRender'];
}

/**
 * Surface the result of a knit to the user. Runs OUTSIDE the
 * `vscode.window.withProgress` callback so that the progress
 * notification closes the moment the R subprocess exits, regardless of
 * how long the user takes to dismiss the success/failure toast.
 */
async function renderOutcome(outcome: KnitOutcome, ctx: RenderOutcomeCtx): Promise<void> {
    if (outcome.kind === 'spawnError') {
        const code = outcome.error.code;
        if (code === 'ENOENT') {
            ctx.output.appendLine(`[error] R not found at "${ctx.rBinary}".`);
            void vscode.window.showErrorMessage(
                'Raven: Knit — R not found on PATH. Set `raven.packages.rPath`.',
            );
        } else {
            ctx.output.appendLine(`[error] ${outcome.error.message}`);
            void vscode.window.showErrorMessage(
                `Raven: Knit — failed to launch R: ${outcome.error.message}`,
            );
        }
        return;
    }

    if (outcome.kind === 'cancelled') {
        ctx.output.appendLine('Knit cancelled.');
        void vscode.window.showInformationMessage('Raven: Knit cancelled.');
        return;
    }

    if (outcome.kind === 'timedOut') {
        ctx.output.appendLine(`Knit timed out after ${ctx.timeoutMs} ms.`);
        ctx.output.show(true);
        void vscode.window.showErrorMessage('Raven: Knit timed out.');
        return;
    }

    if (outcome.kind === 'failed') {
        ctx.output.show(true);
        void vscode.window.showErrorMessage(
            `Raven: Knit failed (exit ${outcome.exitCode}). See Raven: Knit output.`,
        );
        return;
    }

    if (outcome.kind === 'noOutput') {
        const SHOW = 'Show Output';
        const choice = await vscode.window.showInformationMessage(
            'Raven: Knit succeeded (output path unknown).',
            SHOW,
        );
        if (choice === SHOW) ctx.output.show(true);
        return;
    }

    // ok branch — `knitr::knit` writes an intermediate `.md` and the
    // R expression emits one `Output created:` line pointing at it.
    // Our post-knit renderer turns that `.md` into the final `.html`
    // by running it through VS Code's markdown pipeline + Raven's
    // syntax highlighter. The panel shows the resulting `.html`;
    // "Open in Browser" opens the same `.html` so styling is
    // consistent across surfaces.
    const base = outcome.cwd ?? path.dirname(ctx.fsPath);
    const absolutized = outcome.parsedOutputs.map((p) => absolutizeFromCwd(p, base));
    const primary = pickPrimaryOutput(absolutized);
    if (!primary) {
        // Defensive — classify guarantees parsedOutputs.length >= 1 for 'ok'.
        void vscode.window.showInformationMessage('Raven: Knit succeeded.');
        return;
    }

    const mdPath = primary;
    const htmlPath = computeHtmlOutputPath(ctx.fsPath);
    try {
        await ctx.runPostKnitRender({
            mdPath,
            htmlPath,
            context: ctx.context,
            client: ctx.getLanguageClient(),
            sourceUri: ctx.sourceUri,
            sourceLanguageId: ctx.sourceLanguageId,
            // The same `.html` is loaded by both the panel iframe
            // AND "Open in Browser", so the file can't carry
            // surface-specific theme logic — it's a frozen
            // snapshot. We leave `themeClasses` null so
            // `composeStylesheet` emits both palettes and swaps
            // them on `@media (prefers-color-scheme: dark)`:
            //
            //   - Browser: the media query resolves against the
            //     host OS, so the file auto-detects light/dark.
            //   - Webview iframe: VS Code reports
            //     `prefers-color-scheme` via the editor theme
            //     kind (which usually mirrors the OS — with
            //     `window.autoDetectColorScheme` on, it's exactly
            //     the OS).
            //
            // Users who want the panel to paint VS Code's editor
            // theme regardless of OS can toggle "Apply VS Code
            // theme" — that overlay supersedes the baked palette
            // and re-resolves on every theme change.
            themeClasses: null,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.output.appendLine(`[render] post-knit render failed: ${message}`);
        ctx.output.show(true);
        // Knit itself succeeded — `mdPath` exists and is readable.
        // Only the HTML render step failed. Offer the user a way
        // to still see the markdown so a render-step regression
        // (e.g. KaTeX CSS read failure, grammar registry init
        // error) doesn't strand a successful knit with "no output
        // at all" reported to the UI.
        const OPEN_MD = 'Open Markdown';
        const SHOW_OUTPUT = 'Show Output';
        const choice = await vscode.window.showErrorMessage(
            `Raven: Knit produced ${path.basename(mdPath)} but the HTML render step failed. ` +
                `See Raven: Knit output for details.`,
            OPEN_MD,
            SHOW_OUTPUT,
        );
        if (choice === OPEN_MD) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mdPath));
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (openErr) {
                const openMsg = openErr instanceof Error ? openErr.message : String(openErr);
                ctx.output.appendLine(`[render] failed to open ${mdPath}: ${openMsg}`);
                void vscode.window.showErrorMessage(
                    `Raven: Knit — could not open ${path.basename(mdPath)}: ${openMsg}`,
                );
            }
        } else if (choice === SHOW_OUTPUT) {
            ctx.output.show(true);
        }
        return;
    }

    const panelResult = await ctx.showOrUpdatePanel(ctx.context, {
        sourceUri: ctx.sourceUri,
        outputPath: htmlPath,
        output: ctx.output,
    });
    if (!panelResult.ok) {
        ctx.output.appendLine(`[panel] ${panelResult.error}`);
        void revealKnitOutput(htmlPath);
        return;
    }
    // No success popover here: the panel itself is the success
    // signal, and a toast with a "Show Output Panel" button just
    // points at content that's already on screen. If knit produced
    // additional outputs (rare under the new pipeline since we only
    // run knitr::knit, which writes exactly one .md), log them.
    if (absolutized.length > 1) {
        ctx.output.appendLine(
            `[outputs] knit produced ${absolutized.length} files; HTML shown in panel:`,
        );
        for (const p of absolutized) {
            ctx.output.appendLine(`  - ${p}${p === primary ? ' (primary)' : ''}`);
        }
    }
}

/**
 * Test-only entry point that bypasses the registered `raven.knit`
 * command. Exposes the same code path with caller-controlled deps.
 * Used by `knit-progress-lifecycle.test.ts` to verify the Piece A
 * invariant: `inFlight.delete` runs the moment `withProgress` resolves,
 * NOT when the user dismisses the success toast.
 *
 * The `__` prefix signals "test-only"; do not call from production
 * code.
 */
export async function __runKnitCommandForTest(args: {
    uri: vscode.Uri | undefined;
    output: vscode.OutputChannel;
    inFlight: Set<string>;
    context: vscode.ExtensionContext;
    deps: KnitDeps;
}): Promise<void> {
    await runKnitCommand(args.uri, args.output, args.inFlight, args.context, args.deps);
}

interface KnitDirOk {
    ok: true;
    /** `knit_root_dir` argument to rmarkdown::render; null = omit. */
    knitRootDir: string | null;
    /**
     * cwd for the R subprocess. `undefined` = inherit Node's
     * `process.cwd()` (the spec's "R's working directory at subprocess
     * start" — only used in `current` mode without a workspace).
     */
    cwd: string | undefined;
}
interface KnitDirErr { ok: false; error: string; }
type KnitDirResult = KnitDirOk | KnitDirErr;

/**
 * Map the `raven.knit.workingDirectory` mode to the pair (subprocess
 * cwd, `knit_root_dir` argument):
 *
 *   - `document` (default): subprocess cwd = `knit_root_dir` = the
 *     document's parent directory.
 *   - `project`: both = the workspace folder containing the document.
 *     Refuses if the document is outside every workspace folder.
 *   - `current`: omit `knit_root_dir`. When a workspace is open, use the
 *     first workspace folder as cwd (matches VS Code's convention that
 *     R-started-from-the-workspace inherits the workspace root). When
 *     no workspace is open, inherit Node's `process.cwd()` so we don't
 *     pretend the document directory is "R's startup wd" — the spec is
 *     specifically about not pinning a directory in this mode.
 */
function resolveKnitDir(
    docUri: vscode.Uri,
    mode: WorkingDirectoryMode,
): KnitDirResult {
    const fsPath = docUri.fsPath;
    if (mode === 'document') {
        const dir = path.dirname(fsPath);
        return { ok: true, knitRootDir: dir, cwd: dir };
    }
    if (mode === 'project') {
        const folder = vscode.workspace.getWorkspaceFolder(docUri);
        if (!folder) {
            return {
                ok: false,
                error: 'Raven: Knit — cannot resolve project root: document is outside the workspace.',
            };
        }
        return { ok: true, knitRootDir: folder.uri.fsPath, cwd: folder.uri.fsPath };
    }
    // mode === 'current'
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return {
        ok: true,
        knitRootDir: null,
        cwd: workspaceRoot,
    };
}

function resolveRBinary(): string {
    const configured = vscode.workspace
        .getConfiguration('raven.packages')
        .get<string>('rPath', '')
        .trim();
    return configured.length > 0 ? configured : 'R';
}

function readTimeoutMs(): number {
    const configured = vscode.workspace
        .getConfiguration('raven.knit')
        .get<number>('timeoutMs', DEFAULT_TIMEOUT_MS);
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return configured;
}

function absolutizeFromCwd(raw: string, cwd: string): string {
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(cwd, raw);
}


async function showBlocker(blocker: Blocker, fsPath: string): Promise<void> {
    const COPY = 'Copy command';
    // The blocker's copyCommand uses `'FILENAME'` as a quoted
    // placeholder. Substitute the actual path as a properly escaped R
    // literal so Windows backslashes and paths containing apostrophes
    // stay valid R syntax.
    // Replace every `'FILENAME'` placeholder. We use a string-splitting
    // join rather than `String.prototype.replaceAll` to keep
    // compatibility with the project's pre-ES2021 lib target. The
    // placeholder is single-quoted so `escapeRString` (also
    // single-quoted) is a drop-in substitution that stays valid R when
    // the path contains backslashes or apostrophes.
    const filledCommand = blocker.copyCommand
        .split("'FILENAME'")
        .join(escapeRString(fsPath));
    const choice = await vscode.window.showInformationMessage(
        blocker.message,
        { modal: false },
        COPY,
    );
    if (choice === COPY) {
        await vscode.env.clipboard.writeText(filledCommand);
        await vscode.window.showInformationMessage('Command copied to clipboard.');
    }
}

/**
 * Reveal non-HTML knit output. HTML outputs route through the Knit
 * Output webview panel instead (see `renderOutcome`). PDFs / Word docs
 * / etc. open via the OS file browser — the user double-clicks to
 * launch their preferred reader.
 */
async function revealKnitOutput(outputPath: string): Promise<void> {
    const uri = vscode.Uri.file(outputPath);
    await vscode.commands.executeCommand('revealFileInOS', uri);
}
