import * as vscode from 'vscode';
import { register_chunk_commands } from './chunk-commands';
import { register_chunk_codelens } from './chunk-codelens';
import { register_chunk_navigation } from './chunk-navigation';
import { register_chunk_decorations } from './chunk-highlighting';

/**
 * Register chunk features that do NOT need an R terminal:
 *
 *   - Navigation commands (`raven.goToNextChunk`, `raven.goToPreviousChunk`,
 *     `raven.selectCurrentChunk`).
 *   - Background-tint decorations and the active-cell indicator.
 *
 * Although these surfaces don't strictly require an R terminal, they overlap
 * with REditorSupport's chunk navigation and visuals. Callers gate them
 * behind `raven.rConsole.activation` (only register when resolved to
 * `enabled`) so coexistence users don't get duplicate behaviour.
 */
export function register_chunks_navigation_and_highlight(
    context: vscode.ExtensionContext,
): void {
    register_chunk_navigation(context);
    register_chunk_decorations(context);
}

/**
 * Register chunk features that DO need an R terminal:
 *
 *   - Run commands (`raven.runCurrentChunk` and friends, plus the positional
 *     variants the CodeLens invokes).
 *   - The chunk CodeLens provider (button set is user-configurable via
 *     `raven.chunks.codeLens.commands`).
 *
 * Callers must only invoke this when Raven's R console is enabled (i.e. inside
 * the `r_console_resolved === 'enabled'` branch of `activate()`), otherwise
 * `get_or_create_r_terminal()` has no terminal manager to consult.
 */
export function register_chunks_with_terminal(
    context: vscode.ExtensionContext,
): void {
    register_chunk_commands(context);
    register_chunk_codelens(context);
}
