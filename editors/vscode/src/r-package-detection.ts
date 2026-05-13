import * as vscode from 'vscode';

/**
 * Sets the `raven.isRPackage` context key, which gates the visibility of
 * Build commands and the package-tasks editor-title submenu.
 *
 * Detection mirrors the server-side rule documented in
 * `docs/r-package-dev.md` and `crates/raven/src/package_library.rs`:
 *
 *   - `raven.packages.packageMode = "enabled"`  → always on
 *   - `raven.packages.packageMode = "disabled"` → always off
 *   - `raven.packages.packageMode = "auto"`     → on iff the first workspace
 *     folder contains a DESCRIPTION file whose `Package:` field is non-empty
 *
 * The context key is refreshed on activation, when the setting changes, and
 * whenever DESCRIPTION is created/edited/deleted at the workspace root.
 */

export const IS_R_PACKAGE_CONTEXT = 'raven.isRPackage';

const PACKAGE_FIELD_RE = /^Package:\s*(\S.*?)\s*$/m;

export async function detect_r_package(): Promise<boolean> {
    const mode = vscode.workspace
        .getConfiguration('raven')
        .get<string>('packages.packageMode', 'auto');
    if (mode === 'enabled') return true;
    if (mode === 'disabled') return false;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return false;
    const description_uri = vscode.Uri.joinPath(folder.uri, 'DESCRIPTION');
    try {
        const bytes = await vscode.workspace.fs.readFile(description_uri);
        const text = Buffer.from(bytes).toString('utf8');
        return PACKAGE_FIELD_RE.test(text);
    } catch {
        return false;
    }
}

async function refresh_context(): Promise<void> {
    const is_package = await detect_r_package();
    await vscode.commands.executeCommand(
        'setContext',
        IS_R_PACKAGE_CONTEXT,
        is_package,
    );
}

export function register_r_package_detection(
    context: vscode.ExtensionContext,
): void {
    void refresh_context();

    // The watcher is anchored to the first workspace folder's DESCRIPTION,
    // so it must be rebuilt when the workspace folder list changes —
    // otherwise a folder switch leaves the watcher pointed at the previous
    // root and edits to the new DESCRIPTION never re-trigger detection.
    let watcher_disposables: vscode.Disposable[] = [];
    const reset_description_watcher = (): void => {
        for (const d of watcher_disposables) d.dispose();
        watcher_disposables = [];
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        // Pattern is anchored to the root DESCRIPTION; nested packages (e.g.
        // inst/extdata/DESCRIPTION inside a non-package workspace) shouldn't
        // toggle the context key.
        const pattern = new vscode.RelativePattern(folder, 'DESCRIPTION');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher_disposables = [
            watcher,
            watcher.onDidCreate(refresh_context),
            watcher.onDidChange(refresh_context),
            watcher.onDidDelete(refresh_context),
        ];
    };
    reset_description_watcher();
    context.subscriptions.push({
        dispose: () => {
            for (const d of watcher_disposables) d.dispose();
        },
    });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('raven.packages.packageMode')) {
                void refresh_context();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            reset_description_watcher();
            void refresh_context();
        }),
    );
}
