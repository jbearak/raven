import * as vscode from 'vscode';
import { registerKnitCommands } from './knit-commands';

/**
 * Register `Raven: Knit` and its output-channel command. Gated by the
 * same `raven.rConsole.activation` resolution used by chunks and the R
 * console — callers in `extension.ts` only invoke this when R-console
 * features are enabled.
 *
 * `raven.rmdKnit.enabled` context key is set here as well, so any
 * editor-title / menu contributions that rely on it match the resolved
 * gate.
 */
export function registerKnit(context: vscode.ExtensionContext): void {
    void vscode.commands.executeCommand('setContext', 'raven.rmdKnit.enabled', true);
    registerKnitCommands(context);
}
