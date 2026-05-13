import * as vscode from 'vscode';

/**
 * Templates and commands that scaffold R-specific workspace files
 * (`.gitignore`, `.lintr`). Written to the first workspace folder; if the
 * file already exists the user is prompted before it is overwritten.
 */

export const GITIGNORE_TEMPLATE = `# History files
.Rhistory
.Rapp.history

# Session Data files
.RData
.RDataTmp

# User-specific files
.Ruserdata

# RStudio files
.Rproj.user/

# R Environment Variables
.Renviron

# pkgdown site
docs/

# translation temp files
po/*~

# OS files
.DS_Store
Thumbs.db

# R Markdown / knitr artifacts
*_cache/
*_files/

# R CMD check output
.Rcheck/

# Quarto cache
.quarto/

# Local scratch / output
output/
scratch/
scratch.R

# AI tool user-local files
.claude/settings.local.json
.claude/agent-memory-local/
.claude/scheduled_tasks.lock
.cursorignore.local
`;

export const LINTR_TEMPLATE = `linters: linters_with_defaults(
    line_length_linter(120)
  )
`;

/**
 * Return the first workspace folder, or surface a message and return
 * `undefined` if none is open. Without a workspace folder there is no
 * unambiguous place to write the scaffold file.
 */
function getTargetWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        void vscode.window.showErrorMessage(
            'Raven: open a folder before creating an R scaffold file.',
        );
        return undefined;
    }
    return folders[0];
}

/**
 * Write `content` to `fileName` in the given workspace folder, prompting
 * before overwriting an existing file. Returns the target URI on success.
 */
export async function createScaffoldFile(
    folder: vscode.WorkspaceFolder,
    fileName: string,
    content: string,
): Promise<vscode.Uri | undefined> {
    const target = vscode.Uri.joinPath(folder.uri, fileName);

    let exists = false;
    try {
        await vscode.workspace.fs.stat(target);
        exists = true;
    } catch {
        exists = false;
    }

    if (exists) {
        const choice = await vscode.window.showWarningMessage(
            `${fileName} already exists in ${folder.name}. Overwrite?`,
            { modal: true },
            'Overwrite',
        );
        if (choice !== 'Overwrite') {
            return undefined;
        }
    }

    const bytes = Buffer.from(content, 'utf8');
    await vscode.workspace.fs.writeFile(target, bytes);

    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });

    void vscode.window.setStatusBarMessage(
        `Raven: ${exists ? 'overwrote' : 'created'} ${fileName}`,
        3000,
    );

    return target;
}

/**
 * Run `createScaffoldFile` and surface a Raven-branded error notification on
 * failure. Mirrors the try/catch pattern used by `raven.refreshPackages` so
 * filesystem errors (permission denied, read-only workspace) get a clearer
 * message than VS Code's default rejection toast.
 */
async function runScaffoldCommand(fileName: string, content: string): Promise<void> {
    const folder = getTargetWorkspaceFolder();
    if (!folder) return;
    try {
        await createScaffoldFile(folder, fileName, content);
    } catch (err) {
        void vscode.window.showErrorMessage(
            `Raven: failed to create ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

export function registerScaffoldCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.scaffold.gitignore', () =>
            runScaffoldCommand('.gitignore', GITIGNORE_TEMPLATE),
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('raven.scaffold.lintr', () =>
            runScaffoldCommand('.lintr', LINTR_TEMPLATE),
        ),
    );
}
