/**
 * Pandoc-driven export commands.
 *
 *   - `raven.knit.exportHtml`
 *   - `raven.knit.exportPdf`
 *   - `raven.knit.exportDocx`
 *
 * Two entry-point modes:
 *
 *   - `editor-toolbar`: re-knit fresh into a throwaway export subdir,
 *     then run Pandoc and save next to the .Rmd. The user invokes
 *     these from the editor-title Raven menu.
 *   - `webview`: reuse the cached `.md` produced by the most recent
 *     Knit Preview (Approach C). The user invokes these via the
 *     `Export ▾` button in the webview's toolbar. The previewed `.md`
 *     is pinned in the OperationRegistry while Pandoc reads it so
 *     panel disposal can't yank the file out from under us.
 *
 * In both modes the export pipeline:
 *
 *   1. Resolves Pandoc (lazy, on first use), surfaces an actionable
 *      error if missing.
 *   2. Parses YAML output options and builds Pandoc args.
 *   3. Runs `pandocConvert` which writes to a temp file and renames
 *      atomically over the destination — partial output never clobbers
 *      a prior good file.
 *   4. Shows a "Saved …" notification with an Open button via the
 *      shared `openExportedFile` helper.
 *
 * The whole thing runs inside `vscode.window.withProgress({ cancellable:
 * true })`. Cancelling sends SIGINT → SIGTERM → SIGKILL to the running
 * subprocess (R during knit, Pandoc during convert).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractFrontmatter, parseFrontmatter } from './yaml-frontmatter';
import { parseOutputOptions, type TargetFormat } from './output-options';
import { buildPandocArgs } from './pandoc-args';
import { pandocConvert } from './pandoc-engine';
import { PandocResolver, PandocNotFoundError } from './pandoc-detect';
import { OperationRegistry, type OpKind, type OperationController } from './operation-controller';
import { canonicalOpKey, previewArtifactPaths } from './raven-knit-paths';
import { openExportedFile, type ExportFormat } from './open-exported-file';

export interface ExportDeps {
    resolver: PandocResolver;
    registry: OperationRegistry;
    getOutput: () => vscode.OutputChannel;
    /**
     * Invoked to run a fresh knit when the editor-toolbar entry needs
     * one. Receives the export's OperationController so the inner
     * subprocess can listen to the export's cancellation signal —
     * cancelling the export must stop the R subprocess mid-knit, not
     * let it run to completion. Production wires this to
     * `runKnitWithExistingController`; tests override.
     */
    runKnit: (uri: vscode.Uri, exportController: OperationController) => Promise<void>;
}

const EXPORT_OP_KIND: Record<TargetFormat, OpKind> = {
    html: 'export-html',
    pdf: 'export-pdf',
    docx: 'export-docx',
};

const EXPORT_EXTENSION: Record<TargetFormat, string> = {
    html: 'html',
    pdf: 'pdf',
    docx: 'docx',
};

export function registerExportCommands(context: vscode.ExtensionContext, deps: ExportDeps): void {
    const register = (id: string, format: TargetFormat): void => {
        context.subscriptions.push(
            // Second positional arg is an optional `{ entry }` hint passed by
            // the panel when the user clicks Export ▾ in the webview.
            // Default is `editor-toolbar`, which re-knits fresh; `webview`
            // reuses the cached preview .md without re-running R chunks.
            vscode.commands.registerCommand(id, async (uri?: vscode.Uri, opts?: Partial<RunExportOpts>) => {
                const target = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target) {
                    void vscode.window.showWarningMessage('No .Rmd file selected to export.');
                    return;
                }
                if (!/\.[Rr]md$/.test(target.fsPath)) {
                    void vscode.window.showWarningMessage(`Cannot export ${path.basename(target.fsPath)} — not an .Rmd file.`);
                    return;
                }
                const entry: RunExportOpts['entry'] = opts?.entry ?? 'editor-toolbar';
                await runExport(target, format, deps, { entry });
            }),
        );
    };
    register('raven.knit.exportHtml', 'html');
    register('raven.knit.exportPdf', 'pdf');
    register('raven.knit.exportDocx', 'docx');

    // Cancel-export command. The webview's Export ▾ button dispatches
    // this when the user clicks it while an export is already in flight
    // (the button's busy state). The registry is the single source of
    // truth for "is there a running export"; we look up the controller
    // for the source URI and `cancel()` it. No-op when nothing is
    // running.
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.knit.cancelExport', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            const op = deps.registry.current(canonicalOpKey(target));
            if (op && op.kind.startsWith('export-')) op.cancel();
        }),
    );
}

export interface RunExportOpts {
    /** webview = reuse cached .md (Approach C); editor-toolbar = re-knit fresh. */
    entry: 'webview' | 'editor-toolbar';
}

/**
 * Exported for use by `knit-output-panel.ts` when the user picks an
 * export format from the webview's Export ▾ quickpick.
 */
export async function runExport(
    rmd: vscode.Uri,
    format: TargetFormat,
    deps: ExportDeps,
    opts: RunExportOpts,
): Promise<void> {
    const key = canonicalOpKey(rmd);
    const opKind = EXPORT_OP_KIND[format];
    const begin = deps.registry.beginOp(key, opKind);
    if (begin.kind === 'busy') {
        await offerCancelAndRetryToast(begin.existing, rmd, () =>
            runExport(rmd, format, deps, opts),
        );
        return;
    }
    const controller = begin.controller;

    let pinnedPreviewKey: string | null = null;
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                cancellable: true,
                title: `Exporting to ${format.toUpperCase()}…`,
            },
            async (_progress, token) => {
                token.onCancellationRequested(() => controller.cancel());
                await runExportInner(rmd, format, deps, opts, controller, (key: string) => {
                    pinnedPreviewKey = key;
                });
            },
        );
    } finally {
        if (pinnedPreviewKey !== null) deps.registry.unpinPreviewDir(pinnedPreviewKey);
        deps.registry.endOp(controller, controller.cancelled ? 'cancelled' : 'done');
    }
}

async function runExportInner(
    rmd: vscode.Uri,
    format: TargetFormat,
    deps: ExportDeps,
    opts: RunExportOpts,
    controller: OperationController,
    onPin: (previewKey: string) => void,
): Promise<void> {
    const output = deps.getOutput();
    const previewPaths = previewArtifactPaths(rmd.fsPath);

    // [1] Ensure we have a .md to feed Pandoc.
    if (opts.entry === 'webview') {
        if (!fs.existsSync(previewPaths.mdPath)) {
            void vscode.window.showWarningMessage('No cached preview. Knit first, then export.');
            return;
        }
        deps.registry.pinPreviewDir(previewPaths.previewKey);
        onPin(previewPaths.previewKey);
    } else {
        // editor-toolbar: re-knit fresh.
        //
        // Critical: `runKnit` (= `vscode.commands.executeCommand('raven.knit', uri)`)
        // does NOT throw on knit failure — the command handler in
        // `knit-commands.ts` surfaces errors via `vscode.window.showErrorMessage`
        // and returns. Without the pre-delete below, a stale `.md`
        // left over from a previous successful knit would silently
        // satisfy the existence check and we'd export an outdated
        // document. Delete first, then knit, then verify the .md was
        // re-created. If knit didn't run / aborted / failed the
        // existence check now correctly fails the export.
        try {
            await fs.promises.unlink(previewPaths.mdPath);
        } catch (err) {
            // ENOENT is fine — there was nothing to delete. Anything
            // else (EACCES, etc.) is fatal: continuing would risk
            // exporting whichever file happened to be there.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                output.appendLine(
                    `[Export] could not remove stale preview .md at ${previewPaths.mdPath}: ${(err as Error).message}`,
                );
                return;
            }
        }
        controller.updatePhase('knitting');
        try {
            await deps.runKnit(rmd, controller);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`[Export] knit failed: ${msg}`);
            return;
        }
        if (!fs.existsSync(previewPaths.mdPath)) {
            output.appendLine(`[Export] knit did not produce a .md at ${previewPaths.mdPath} (knit was likely refused or failed); aborting export.`);
            return;
        }
    }

    // [2] Resolve Pandoc.
    controller.updatePhase('converting');
    let pandocBin: string;
    try {
        pandocBin = await deps.resolver.resolve();
    } catch (err) {
        if (err instanceof PandocNotFoundError) {
            await offerPandocInstall();
            return;
        }
        throw err;
    }

    // [3] Parse YAML + build Pandoc args.
    let documentText: string;
    try {
        documentText = (await vscode.workspace.fs.readFile(rmd)).toString();
    } catch (err) {
        output.appendLine(`[Export] failed to read source: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    const fmInner = extractFrontmatter(documentText) ?? '';
    const fmParse = parseFrontmatter(fmInner);
    const fm = fmParse.ok ? fmParse.value : {};
    const outOpts = parseOutputOptions(fm, format);

    for (const key of outOpts.ignored) {
        output.appendLine(`[knit] Ignored output: option '${key}'`);
    }

    const sourceDir = path.dirname(rmd.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(rmd)?.uri.fsPath;
    const containmentRoot = workspaceFolder ?? sourceDir;
    const baseName = path.basename(rmd.fsPath).replace(/\.[Rr][Mm][Dd]$/, '');
    const destPath = path.join(sourceDir, `${baseName}.${EXPORT_EXTENSION[format]}`);

    const pdfEngine = resolvePdfEngineSetting(
        vscode.workspace.getConfiguration('raven').get<string>('pandoc.pdfEngine', 'xelatex'),
        output,
    );
    const detailed = buildPandocArgs.detailed(outOpts, format, {
        mdPath: previewPaths.mdPath,
        outPath: destPath,
        sourceDir,
        containmentRoot,
        pdfEngine,
    });
    for (const dropped of detailed.droppedCss) {
        output.appendLine(`[knit] CSS path outside containment root, dropped: '${dropped}'`);
    }

    // [4] Run Pandoc.
    const timeoutMs = vscode.workspace.getConfiguration('raven').get<number>('knit.export.timeoutMs', 120_000);
    const result = await pandocConvert({
        pandocPath: pandocBin,
        args: detailed.args,
        mdPath: previewPaths.mdPath,
        destPath,
        cwd: previewPaths.previewDir,
        timeoutMs,
        controller,
        output,
    });

    controller.updatePhase('finalizing');
    if (result.status === 'success') {
        await openExportedFile(vscode.Uri.file(destPath), formatToExport(format), output);
    } else if (result.status === 'cancelled') {
        output.appendLine('[Export] Cancelled.');
    } else {
        await offerPandocFailure(format, result.stderr, output, rmd);
    }
}

function formatToExport(f: TargetFormat): ExportFormat {
    return f;
}

/**
 * Allowlist of Pandoc PDF engines that match the `package.json` enum.
 * `getConfiguration().get<string>(...)` returns whatever the user wrote
 * in `settings.json`, bypassing the JSON-schema enum check, so we
 * re-validate here before handing the value to Pandoc as a flag. An
 * untrusted workspace could otherwise steer export at an attacker-
 * controlled binary via `--pdf-engine=<bogus>`.
 */
const PDF_ENGINE_ALLOWLIST: ReadonlySet<string> = new Set([
    'xelatex',
    'pdflatex',
    'lualatex',
    'tectonic',
    'wkhtmltopdf',
]);

function resolvePdfEngineSetting(raw: string, output: vscode.OutputChannel): string {
    if (PDF_ENGINE_ALLOWLIST.has(raw)) return raw;
    output.appendLine(
        `[Export] Ignored raven.pandoc.pdfEngine = ${JSON.stringify(raw)} (not in allowlist); falling back to xelatex.`,
    );
    return 'xelatex';
}

async function offerPandocInstall(): Promise<void> {
    const INSTALL = 'Install Pandoc…';
    const SET_PATH = 'Set path…';
    const choice = await vscode.window.showErrorMessage(
        'Pandoc not found. Install it to export to PDF, Word, or HTML.',
        INSTALL,
        SET_PATH,
    );
    if (choice === INSTALL) {
        void vscode.env.openExternal(vscode.Uri.parse('https://pandoc.org/installing.html'));
    } else if (choice === SET_PATH) {
        void vscode.commands.executeCommand('workbench.action.openSettings', '@id:raven.pandoc.path');
    }
}

async function offerPandocFailure(
    format: TargetFormat,
    stderr: string,
    output: vscode.OutputChannel,
    rmd: vscode.Uri,
): Promise<void> {
    output.appendLine(`[Export] Pandoc stderr:\n${stderr}`);

    // PDF-specific LaTeX engine hint. The `tectonic` regex is forgiving
    // about Pandoc's message phrasing across versions.
    if (format === 'pdf' && /(xelatex|pdflatex|lualatex|tectonic)[\s.,'"]*(?:not[\s-]?found|could[\s-]?not|is[\s-]?missing|no[\s-]?such)/i.test(stderr)) {
        const INSTALL = 'Install TinyTeX…';
        const SHOW = 'Show details';
        const choice = await vscode.window.showErrorMessage(
            'PDF export needs a LaTeX engine.',
            INSTALL,
            SHOW,
        );
        if (choice === INSTALL) {
            void vscode.env.openExternal(vscode.Uri.parse('https://yihui.org/tinytex/'));
        } else if (choice === SHOW) {
            output.show(true);
        }
        return;
    }

    const SHOW = 'Show details';
    const TRY_WORD = 'Try Word instead';
    const buttons = format === 'pdf' ? [SHOW, TRY_WORD] : [SHOW];
    const choice = await vscode.window.showErrorMessage(
        `Export to ${format.toUpperCase()} failed.`,
        ...buttons,
    );
    if (choice === SHOW) output.show(true);
    else if (choice === TRY_WORD) {
        void vscode.commands.executeCommand('raven.knit.exportDocx', rmd);
    }
}

async function offerCancelAndRetryToast(
    existing: OperationController,
    uri: vscode.Uri,
    retry: () => Promise<void>,
): Promise<void> {
    const CANCEL = 'Cancel and retry';
    const WAIT = 'Wait';
    const kind = humanizeOpKind(existing.kind);
    const choice = await vscode.window.showInformationMessage(
        `A ${kind} is in progress for ${path.basename(uri.fsPath)}.`,
        CANCEL,
        WAIT,
    );
    if (choice !== CANCEL) return;

    existing.cancel();
    // Wait up to ~5s for the in-flight op to settle; then proceed.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (existing.phase === 'cancelled' || existing.phase === 'done') break;
        await new Promise((r) => setTimeout(r, 100));
    }
    await retry();
}

function humanizeOpKind(kind: OpKind): string {
    switch (kind) {
        case 'knit-preview':
            return 'knit';
        case 'export-html':
            return 'HTML export';
        case 'export-pdf':
            return 'PDF export';
        case 'export-docx':
            return 'Word export';
        case 'knit-then-export':
            return 'knit-then-export';
    }
}
