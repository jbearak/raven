import * as vscode from 'vscode';

/**
 * Recursion guard: prevents re-triggering on our own edits.
 */
let applying = false;

const CLOSING_DELIMITERS = new Set([')', ']', '}']);

/**
 * Register a listener that fixes auto-closing pair overtype after
 * onTypeFormatting moves a closing delimiter to a new line.
 *
 * When the user types a closing delimiter and the next character is
 * the same delimiter, delete the duplicate.
 */
export function registerAutoCloseFix(): vscode.Disposable {
    return vscode.workspace.onDidChangeTextDocument(async (e) => {
        if (applying) return;
        if (e.document.languageId !== 'r') return;
        if (e.contentChanges.length !== 1) return;

        const change = e.contentChanges[0];
        if (change.text.length !== 1 || change.rangeLength !== 0) return;
        if (!CLOSING_DELIMITERS.has(change.text)) return;

        const pos = new vscode.Position(
            change.range.start.line,
            change.range.start.character + 1
        );
        const line = e.document.lineAt(pos.line);
        if (pos.character >= line.text.length) return;
        if (line.text[pos.character] !== change.text) return;

        applying = true;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.delete(e.document.uri, new vscode.Range(pos, pos.translate(0, 1)));
            await vscode.workspace.applyEdit(edit);
        } catch {
            // Silently ignore — document may have changed or been closed
        } finally {
            applying = false;
        }
    });
}
