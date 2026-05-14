import * as vscode from 'vscode';
import { register_chunk_commands } from './chunk-commands';
import { register_chunk_codelens } from './chunk-codelens';
import { register_chunk_navigation } from './chunk-navigation';
import { register_chunk_decorations } from './chunk-highlighting';

/**
 * Register every chunk-related contribution: commands, CodeLens provider,
 * navigation commands, and background decorations. Callers must invoke this
 * during extension activation regardless of `raven.rConsole.activation` —
 * navigation and CodeLens still make sense even when there is no R terminal.
 * The run-chunk commands themselves create/reuse the terminal on demand.
 */
export function register_chunks(context: vscode.ExtensionContext): void {
    register_chunk_commands(context);
    register_chunk_codelens(context);
    register_chunk_navigation(context);
    register_chunk_decorations(context);
}
