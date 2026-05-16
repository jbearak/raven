import * as vscode from 'vscode';
import {
    NagKey,
    QUARTO_EXTENSION_ID,
    R_FULL_EXTENSION_ID,
    R_SYNTAX_EXTENSION_ID,
    markNagDismissed,
    nagStateForLanguageId,
    shouldShowNag,
} from './nag-state';

/**
 * Watches editor activations for the first `.qmd` or `.Rmd` document
 * opened in a session and surfaces a one-time install info message.
 * Dismissal persists across sessions via `globalState`; in-session
 * dismissal (including closing the toast with the X button) is tracked
 * by `shownThisSession` so we don't re-fire every time the user
 * switches editors.
 *
 * The message recommends grammar / LSP extensions only. It deliberately
 * does NOT promise Raven preview or render features — Raven defers
 * preview entirely to `quarto.quarto`.
 */
export function registerInstallNags(context: vscode.ExtensionContext): void {
    const shownThisSession = new Set<NagKey>();
    const inFlight = new Set<NagKey>();

    const consider = (document: vscode.TextDocument | undefined): void => {
        if (!document) return;
        const key = nagStateForLanguageId(document.languageId);
        if (!key) return;
        if (shownThisSession.has(key) || inFlight.has(key)) return;
        const isInstalled = (id: string): boolean =>
            vscode.extensions.getExtension(id) !== undefined;
        if (!shouldShowNag(context.globalState, key, isInstalled)) return;
        inFlight.add(key);
        void surfaceNag(context, key).finally(() => {
            inFlight.delete(key);
            shownThisSession.add(key);
        });
    };

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            consider(editor?.document);
        }),
    );

    consider(vscode.window.activeTextEditor?.document);
}

async function surfaceNag(
    context: vscode.ExtensionContext,
    key: NagKey,
): Promise<void> {
    const config = nagDefinition(key);
    const INSTALL = 'Install';
    const DONT_SHOW = "Don't show again";
    const choice = await vscode.window.showInformationMessage(
        config.message,
        INSTALL,
        DONT_SHOW,
    );
    if (choice === INSTALL) {
        await vscode.commands.executeCommand('extension.open', config.extensionId);
        // We don't auto-dismiss on install — the user could cancel the
        // install dialog. The next session will re-check installation
        // state and not nag again if the extension is now present.
    } else if (choice === DONT_SHOW) {
        await markNagDismissed(context.globalState, key);
    }
}

interface NagDefinition {
    message: string;
    extensionId: string;
}

function nagDefinition(key: NagKey): NagDefinition {
    if (key === NagKey.QuartoForQmd) {
        return {
            message:
                'Raven does not handle .qmd files directly. Install Quarto for .qmd grammar, LSP features, and live preview.',
            extensionId: QUARTO_EXTENSION_ID,
        };
    }
    return {
        message:
            'Raven does not ship an R Markdown grammar. Install R Syntax (or R) for .Rmd grammar and embedded-language highlighting.',
        extensionId: R_SYNTAX_EXTENSION_ID,
    };
}

/** Re-exported for callers that want to whitelist the full r extension too. */
export const RECOMMENDED_RMD_EXTENSIONS = [R_SYNTAX_EXTENSION_ID, R_FULL_EXTENSION_ID];
