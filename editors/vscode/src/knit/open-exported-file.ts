/**
 * Shared helper for opening a finished export (HTML, PDF, or DOCX) in
 * its OS-default handler. Mirrors the existing `openInBrowser` flow's
 * remote-workspace fallback: `vscode.env.openExternal` of a `file:` URI
 * may route to the extension-host machine instead of the user's, in
 * which case we write the path to the output channel and warn rather
 * than silently fail.
 */

import * as path from 'path';
import * as vscode from 'vscode';

export type ExportFormat = 'html' | 'pdf' | 'docx';

const LABELS: Record<ExportFormat, string> = {
    html: 'Open in Browser',
    pdf: 'View PDF',
    docx: 'Open in Word',
};

export interface OpenExportedFileOptions {
    /**
     * Set to `false` to skip the "Saved …" info toast and go straight
     * to the open-external call. The existing `openInBrowser` flow uses
     * this for the toolbar button — the panel itself is the "you have
     * a result" signal there.
     */
    showSavedToast?: boolean;
}

export async function openExportedFile(
    savedUri: vscode.Uri,
    format: ExportFormat,
    output: vscode.OutputChannel,
    options: OpenExportedFileOptions = {},
): Promise<void> {
    const label = LABELS[format];
    if (options.showSavedToast !== false) {
        const action = await vscode.window.showInformationMessage(
            `Saved ${path.basename(savedUri.fsPath)}`,
            label,
        );
        if (action !== label) return;
    }

    let opened = false;
    try {
        opened = await vscode.env.openExternal(savedUri);
    } catch (err) {
        output.appendLine(
            `[Export] openExternal threw: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (opened) return;
    output.appendLine(`[Export] file:// did not open. Output is at: ${savedUri.fsPath}`);
    void vscode.window.showWarningMessage(
        `${label} is not available for this workspace. The file path has been written to the Raven: Knit output channel.`,
    );
}
