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
    ValidateFormatError,
    ValidatePathError,
} from './r-expression';
import { runKnit } from './knit-engine';
import { parseRenderedOutputPath } from './output-path';

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

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'raven.knit',
            async (uri?: vscode.Uri) => {
                await runKnitCommand(uri, getOutput());
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
): Promise<void> {
    const docUri = explicitUri ?? vscode.window.activeTextEditor?.document.uri;
    if (!docUri) {
        await vscode.window.showInformationMessage(
            'Raven: Knit requires an active editor with a .Rmd file.',
        );
        return;
    }

    // Gate check via context key — set by `registerKnit`. Re-check the
    // setting too, in case someone invokes the command from a script
    // ignoring our `when` clauses.
    const knitEnabled = vscode.workspace
        .getConfiguration('raven.rConsole')
        .get<string>('activation', 'auto') !== 'disabled';
    if (!knitEnabled) {
        await vscode.window.showInformationMessage(
            'Raven: Knit is disabled by `raven.rConsole.activation`.',
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

    if (docUri.scheme !== 'file' && docUri.scheme !== 'vscode-remote') {
        await vscode.window.showInformationMessage(
            'Save the file to disk before running Raven: Knit.',
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
    const knitDirResult = resolveKnitRootDir(docUri, workingDirectoryMode);
    if (!knitDirResult.ok) {
        await vscode.window.showErrorMessage(knitDirResult.error);
        return;
    }
    const knitRootDir = knitDirResult.value;

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
    const cwd = knitRootDir ?? path.dirname(fsPath);
    const baseName = path.basename(fsPath);

    output.appendLine(`---`);
    output.appendLine(`Knitting ${fsPath}`);
    output.appendLine(`R: ${rBinary}`);
    output.appendLine(`Expression: ${expression}`);
    output.appendLine(`cwd: ${cwd}`);
    output.appendLine(``);

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

            const parsedOutputs = parseRenderedOutputPath(result.stdout).paths;
            if (parsedOutputs.length === 0) {
                const SHOW = 'Show Output';
                const choice = await vscode.window.showInformationMessage(
                    'Raven: Knit succeeded (output path unknown).',
                    SHOW,
                );
                if (choice === SHOW) output.show(true);
                return;
            }
            const primary = absolutizeFromCwd(parsedOutputs[0], cwd);
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
}

interface KnitDirOk { ok: true; value: string | null; }
interface KnitDirErr { ok: false; error: string; }
type KnitDirResult = KnitDirOk | KnitDirErr;

function resolveKnitRootDir(
    docUri: vscode.Uri,
    mode: WorkingDirectoryMode,
): KnitDirResult {
    const fsPath = docUri.fsPath;
    if (mode === 'document') return { ok: true, value: path.dirname(fsPath) };
    if (mode === 'current') return { ok: true, value: null };
    // project
    const folder = vscode.workspace.getWorkspaceFolder(docUri);
    if (!folder) {
        return {
            ok: false,
            error: 'Raven: Knit — cannot resolve project root: document is outside the workspace.',
        };
    }
    return { ok: true, value: folder.uri.fsPath };
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
    const filledCommand = blocker.copyCommand.replace('FILENAME', fsPath);
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
