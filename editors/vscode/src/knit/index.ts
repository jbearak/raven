import * as vscode from 'vscode';
import { registerKnitCommands } from './knit-commands';

/**
 * Register `Raven: Knit` and its output-channel command. The commands
 * are registered unconditionally so walkthrough deep-links work even
 * when the resolved gate is closed; the handler re-checks
 * `resolveRConsoleActivation()` at invocation and surfaces an info
 * message if the gate has since closed (e.g. REditorSupport was enabled
 * after activation).
 *
 * The `raven.rmdKnit.enabled` context key controls whether the
 * command-palette entry is visible — set from the *resolved* gate, not
 * the raw setting.
 */
export function registerKnit(
    context: vscode.ExtensionContext,
    enabledFromGate: boolean,
): void {
    void vscode.commands.executeCommand(
        'setContext',
        'raven.rmdKnit.enabled',
        enabledFromGate,
    );
    registerKnitCommands(context);
}
