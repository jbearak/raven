import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The walkthrough manifest entry lives in `package.json` —
 * `contributes.walkthroughs`. This module registers the one command the
 * walkthrough invokes (`raven.walkthrough.createSampleRmd`).
 *
 * The command writes a tiny .Rmd via `vscode.workspace.fs.writeFile`
 * rather than `fs.writeFileSync` so the write routes through VS Code's
 * remote-extension-host correctly (SSH, WSL, Codespaces, dev
 * containers). We never auto-invoke knit afterwards — the user should
 * see the file first and understand what they're knitting.
 */
export function registerWalkthroughCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'raven.walkthrough.createSampleRmd',
            async () => { await createSampleRmd(); },
        ),
    );
}

const SAMPLE_CONTENT = [
    '---',
    'title: "Sample R Markdown"',
    'output: html_document',
    '---',
    '',
    '# Hello from Raven',
    '',
    'This is a tiny R Markdown document. Run **Raven: Knit** from the command',
    'palette (Cmd/Ctrl+Shift+P) to render it.',
    '',
    '```{r}',
    'plot(1:10, main = "Example plot")',
    '```',
    '',
].join('\n');

async function createSampleRmd(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const baseUri = folder
        ? folder.uri
        : vscode.Uri.file(os.tmpdir());

    let candidate = vscode.Uri.joinPath(baseUri, 'raven-sample.Rmd');
    let counter = 2;
    while (await uriExists(candidate)) {
        candidate = vscode.Uri.joinPath(baseUri, `raven-sample-${counter}.Rmd`);
        counter += 1;
        if (counter > 100) break; // safety
    }

    try {
        await vscode.workspace.fs.writeFile(
            candidate,
            new TextEncoder().encode(SAMPLE_CONTENT),
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Could not create sample: ${message}`);
        return;
    }

    await vscode.window.showTextDocument(candidate);
    await vscode.window.showInformationMessage(
        `Sample created at ${path.basename(candidate.fsPath)}. Open the command palette and run Raven: Knit.`,
    );
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
