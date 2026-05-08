import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { HelpPanel } from './help-panel';
import { wrapHoverWithHelpTrust } from './hover-trust-middleware';

export function activateHelpViewer(
    context: vscode.ExtensionContext,
    client: LanguageClient,
): void {
    const panelHolder: { current: HelpPanel | null } = { current: null };

    const open = vscode.commands.registerCommand(
        'raven.openHelpPanel',
        async (topic: string, pkg: string | null) => {
            if (!panelHolder.current) {
                panelHolder.current = HelpPanel.create(context, client, () => {
                    panelHolder.current = null;
                });
            }
            await panelHolder.current.openTopic(topic, pkg, null);
        },
    );
    const back = vscode.commands.registerCommand('raven.help.back', () =>
        panelHolder.current?.back(),
    );
    const forward = vscode.commands.registerCommand('raven.help.forward', () =>
        panelHolder.current?.forward(),
    );
    context.subscriptions.push(open, back, forward);
}

export { wrapHoverWithHelpTrust };
