import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { registerKnitCommands } from './knit-commands';
import { disposeKnitGrammarRegistryForDeactivation } from './post-knit-renderer';
import {
    cleanupCurrentSession,
    initSessionState,
    maybeCurrentSession,
    sweepStaleSessions,
} from './session-state';

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
 *
 * Also initializes the per-session knit state (workspaceHash +
 * sessionId) so the temp-dir layout under `<tmpdir>/raven-knit/...`
 * isolates this VS Code window from concurrent ones, and kicks off a
 * background sweep of stale (>7 day) sibling sessions.
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

    // Idempotency guard — if the extension is re-activated within the
    // same process (rare, but happens in dev with reload-extension)
    // we don't want to clobber the existing session id.
    if (maybeCurrentSession() === null) {
        const workspaceUri =
            vscode.workspace.workspaceFolders?.[0]?.uri.toString()
            ?? vscode.workspace.workspaceFile?.toString()
            ?? null;
        initSessionState({ sessionId: crypto.randomUUID(), workspaceUri });
        context.subscriptions.push({
            dispose: () => { void cleanupCurrentSession(); },
        });
        // Non-blocking sweep of orphaned sibling sessions. Best effort —
        // errors are swallowed inside `sweepStaleSessions`.
        void sweepStaleSessions(path.join(os.tmpdir(), 'raven-knit'));
    }

    registerKnitCommands(context, getLanguageClient ? { getLanguageClient } : undefined);
}
