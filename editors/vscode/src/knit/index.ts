import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { registerKnitCommands } from './knit-commands';
import { disposeKnitGrammarRegistryForDeactivation } from './post-knit-renderer';

export { disposeKnitGrammarRegistryForDeactivation };

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
 *
 * `getLanguageClient` is a thunk over the (singleton) LSP client so
 * the post-knit renderer can fetch Raven's `function` semantic tokens
 * for R code blocks at render time, after the LSP has finished
 * activating. The thunk pattern handles the activation race: knit can
 * be invoked from a walkthrough button before the LSP fully starts,
 * and the renderer tolerates `undefined` by falling back to
 * grammar-only highlighting.
 */
export function registerKnit(
    context: vscode.ExtensionContext,
    enabledFromGate: boolean,
    getLanguageClient?: () => LanguageClient | undefined,
): void {
    void vscode.commands.executeCommand(
        'setContext',
        'raven.rmdKnit.enabled',
        enabledFromGate,
    );
    registerKnitCommands(context, getLanguageClient ? { getLanguageClient } : undefined);
}
