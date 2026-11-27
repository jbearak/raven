import * as path from 'path';
import * as vscode from 'vscode';
import { REDITORSUPPORT_EXTENSION_ID } from './console-picker';
import {
    raven_user_keybindings,
    with_user_keybindings,
    type ContributedKeybinding,
} from './raven-keybinding-entries';

/**
 * **Raven: Use Raven's Keyboard Shortcuts Instead of vscode-R's**, and a
 * one-time offer to run it. With vscode-R installed, its `Cmd+Enter` (and
 * three other shortcuts) run instead of Raven's, so code skips the console
 * the user chose and vscode-R may show its own "Run R code" menu. The
 * command adds user keybindings, which rank above both extensions; see
 * `raven-keybinding-entries.ts` for why and for what is written.
 */

export const ADD_KEYBINDINGS_COMMAND = 'raven.useRavenKeybindingsOverVscodeR';
const OFFER_SHOWN_KEY = 'raven.vscodeRKeybindingsOfferShown';
const COEXISTENCE_URL = 'https://github.com/jbearak/raven/blob/main/docs/coexistence.md#cmdenter-next-to-vscode-r';

/** The user's keybindings.json, opened in an editor. */
async function open_user_keybindings(): Promise<vscode.TextDocument | undefined> {
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
    const is_keybindings = (doc: vscode.TextDocument) =>
        doc.uri.scheme === 'vscode-userdata' && path.posix.basename(doc.uri.path) === 'keybindings.json';
    // Prefer the editor the command just showed; with profiles, other
    // profiles' keybindings.json files can also be open.
    const active = vscode.window.activeTextEditor?.document;
    if (active && is_keybindings(active)) return active;
    return vscode.workspace.textDocuments.find(is_keybindings);
}

/**
 * Adds the keybindings to the user's keybindings.json and saves it, leaving
 * it open. Says what it did. Returns the number of entries added, or
 * `undefined` when the file couldn't be changed.
 */
export async function add_raven_keybindings(extension: vscode.Extension<unknown>): Promise<number | undefined> {
    const contributed = (extension.packageJSON as { contributes?: { keybindings?: ContributedKeybinding[] } })
        .contributes?.keybindings ?? [];
    const entries = raven_user_keybindings(contributed);
    const doc = await open_user_keybindings();
    const text = doc?.getText();
    const updated = text === undefined ? null : with_user_keybindings(text, entries);
    if (!doc || text === undefined || updated === null) {
        void vscode.window.showErrorMessage(
            "Raven couldn't add its keyboard shortcuts: keybindings.json isn't a JSON array Raven can edit. Add them by hand; see docs/coexistence.md.",
        );
        return undefined;
    }
    if (updated.added === 0) {
        void vscode.window.showInformationMessage("Raven's keyboard shortcuts are already in your keybindings.json.");
        return 0;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), updated.text);
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
        void vscode.window.showErrorMessage("Raven couldn't save your keybindings.json.");
        return undefined;
    }
    void vscode.window.showInformationMessage(
        "Added Raven's keyboard shortcuts to your keybindings.json. Cmd+Enter (Ctrl+Enter) in R and R Markdown files now runs Raven's command.",
    );
    return updated.added;
}

/**
 * Offers, once, to add the keybindings: when vscode-R is installed, Raven's
 * console is on (the caller checks), and sends don't go to vscode-R anyway
 * (`raven.rTerminal.program` isn't `vscode-R`). Not in development or test
 * runs, where VS Code registers Raven's bindings last so they already win.
 */
export async function offer_raven_keybindings(context: vscode.ExtensionContext): Promise<void> {
    if (context.extensionMode !== vscode.ExtensionMode.Production) return;
    if (!vscode.extensions.getExtension(REDITORSUPPORT_EXTENSION_ID)) return;
    if (vscode.workspace.getConfiguration('raven.rTerminal').get<string>('program') === 'vscode-R') return;
    if (context.globalState.get<boolean>(OFFER_SHOWN_KEY)) return;
    await context.globalState.update(OFFER_SHOWN_KEY, true);

    const ADD = 'Add Shortcuts';
    const LEARN_MORE = 'Learn More';
    const choice = await vscode.window.showInformationMessage(
        "vscode-R's Cmd+Enter (Ctrl+Enter) runs instead of Raven's, so code skips the console you chose in Raven. Add keyboard shortcuts so Raven's run first in R and R Markdown files?",
        ADD,
        LEARN_MORE,
    );
    if (choice === ADD) {
        await vscode.commands.executeCommand(ADD_KEYBINDINGS_COMMAND);
    } else if (choice === LEARN_MORE) {
        await vscode.env.openExternal(vscode.Uri.parse(COEXISTENCE_URL));
    }
}

export function register_vscode_r_keybindings(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(ADD_KEYBINDINGS_COMMAND, () => add_raven_keybindings(context.extension)),
    );
    void offer_raven_keybindings(context);
}
