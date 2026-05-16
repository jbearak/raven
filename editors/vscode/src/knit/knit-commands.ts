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
import { parseRenderedOutputPath } from './output-path';
import { resolveRConsoleActivation } from '../r-console-activation';

const OUTPUT_CHANNEL_NAME = 'Raven: Knit';
const DEFAULT_TIMEOUT_MS = 600_000;

type WorkingDirectoryMode = 'document' | 'project' | 'current';

/**
 * Top-level registration. Creates the lazy OutputChannel and registers
 * the two commands listed in `package.json`.
 */
export function registerKnitCommands(context: vscode.ExtensionContext): void {
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
                await runKnitCommand(uri, getOutput(), inFlight);
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
    try {
        const doc = await vscode.workspace.openTextDocument(docUri);
        documentText = doc.getText();
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
    let expression: string;
    try {
        expression = buildKnitExpression({
            filePath: fsPath,
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

    try {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Knitting ${baseName}…`,
            cancellable: true,
        },
        async (_progress, token) => {
            const result = await runKnit({
                rBinary,
                expression,
                cwd,
                timeoutMs,
                output,
                cancellation: token,
            });

            if (result.spawnError) {
                const code = result.spawnError.code;
                if (code === 'ENOENT') {
                    output.appendLine(`[error] R not found at "${rBinary}".`);
                    await vscode.window.showErrorMessage(
                        'Raven: Knit — R not found on PATH. Set `raven.packages.rPath`.',
                    );
                } else {
                    output.appendLine(`[error] ${result.spawnError.message}`);
                    await vscode.window.showErrorMessage(
                        `Raven: Knit — failed to launch R: ${result.spawnError.message}`,
                    );
                }
                return;
            }

            if (result.cancelled) {
                output.appendLine('Knit cancelled.');
                await vscode.window.showInformationMessage('Raven: Knit cancelled.');
                return;
            }

            if (result.timedOut) {
                output.appendLine(`Knit timed out after ${timeoutMs} ms.`);
                output.show(true);
                await vscode.window.showErrorMessage('Raven: Knit timed out.');
                return;
            }

            if (result.exitCode !== 0) {
                output.show(true);
                await vscode.window.showErrorMessage(
                    `Raven: Knit failed (exit ${result.exitCode}). See Raven: Knit output.`,
                );
                return;
            }

            // rmarkdown::render's "Output created:" line is emitted
            // via R's `message()`, which writes to stderr. Older
            // configurations / future versions could route it to stdout,
            // so we parse both streams to stay robust.
            const parsedOutputs = parseRenderedOutputPath(
                result.stdout + '\n' + result.stderr,
            ).paths;
            if (parsedOutputs.length === 0) {
                const SHOW = 'Show Output';
                const choice = await vscode.window.showInformationMessage(
                    'Raven: Knit succeeded (output path unknown).',
                    SHOW,
                );
                if (choice === SHOW) output.show(true);
                return;
            }
            // Resolve any relative `Output created:` path against the
            // subprocess cwd we passed (or the document directory when
            // `current` mode is in effect with no workspace open). The
            // input file is always absolute, so rmarkdown normally
            // prints absolute paths and `absolutizeFromCwd` short-
            // circuits via `path.isAbsolute`.
            const base = cwd ?? path.dirname(fsPath);
            const primary = absolutizeFromCwd(parsedOutputs[0], base);
            const OPEN = 'Open';
            const SHOW_ALL = 'Show All';
            const buttons = parsedOutputs.length > 1 ? [OPEN, SHOW_ALL] : [OPEN];
            const baseLabel = path.basename(primary);
            const choice = await vscode.window.showInformationMessage(
                parsedOutputs.length > 1
                    ? `Raven: Knit succeeded: ${baseLabel} (and ${parsedOutputs.length - 1} more).`
                    : `Raven: Knit succeeded: ${baseLabel}.`,
                ...buttons,
            );
            if (choice === OPEN) await revealKnitOutput(primary);
            else if (choice === SHOW_ALL) output.show(true);
        },
    );
    } finally {
        inFlight.delete(fsPath);
    }
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
    const filledCommand = blocker.copyCommand.includes("'FILENAME'")
        ? blocker.copyCommand.replace("'FILENAME'", escapeRString(fsPath))
        : blocker.copyCommand;
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

async function revealKnitOutput(outputPath: string): Promise<void> {
    const uri = vscode.Uri.file(outputPath);
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
        await vscode.commands.executeCommand('vscode.open', uri);
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', uri);
}
