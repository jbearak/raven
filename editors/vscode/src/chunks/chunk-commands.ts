import * as vscode from 'vscode';
import {
    classify_chunk_document,
    detect_chunks,
    find_chunk_at_line,
    chunks_above,
    extract_chunk_code,
    has_chunk_anchor,
    is_runnable_chunk,
    Chunk,
} from './chunk-detector';
import { get_or_create_r_terminal } from '../send-to-r/r-terminal-manager';
import { send_code, get_send_options } from '../send-to-r/send-code';

type RunMode = 'current' | 'currentAndMove' | 'above' | 'all';

function get_document_lines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return lines;
}

function chunks_for_document(document: vscode.TextDocument): Chunk[] {
    const kind = classify_chunk_document(document.uri.fsPath || document.uri.path);
    // Fast path: skip the per-line scan when the document has no chunk anchors.
    // For a plain `.R` file with no `# %%` markers this avoids materializing the
    // line array AND running the marker regex on every keystroke.
    if (!has_chunk_anchor(document.getText(), kind)) return [];
    return detect_chunks(get_document_lines(document), kind);
}

function combined_code(lines: string[], chunks: Chunk[]): string {
    const parts: string[] = [];
    for (const c of chunks) {
        if (!is_runnable_chunk(c)) continue;
        const code = extract_chunk_code(lines, c);
        if (code.trim().length > 0) parts.push(code);
    }
    return parts.join('\n');
}

async function send_to_r(code: string): Promise<void> {
    if (code.trim().length === 0) return;
    try {
        const terminal = await get_or_create_r_terminal();
        terminal.show(true);
        send_code(terminal, code, get_send_options());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Raven: failed to send chunk to R — ${message}`);
    }
}

function find_visible_editor(uri: vscode.Uri): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri.toString(),
    );
}

function move_cursor_to_next_chunk(
    editor: vscode.TextEditor,
    chunks: Chunk[],
    current: Chunk,
): void {
    const next = chunks.find((c) => c.header_line > current.header_line && is_runnable_chunk(c));
    if (!next) return;
    const target_line = Math.min(next.header_line + 1, editor.document.lineCount - 1);
    const pos = new vscode.Position(target_line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
}

async function run_chunk_at(
    mode: RunMode,
    document: vscode.TextDocument,
    cursor_line: number,
): Promise<void> {
    const editor = find_visible_editor(document.uri);
    const lines = get_document_lines(document);
    const chunks = chunks_for_document(document);
    if (chunks.length === 0) {
        vscode.window.showInformationMessage('Raven: no R chunks found in this document.');
        return;
    }

    if (mode === 'all') {
        const code = combined_code(lines, chunks);
        if (code.length === 0) {
            vscode.window.showInformationMessage('Raven: no runnable R chunks to execute.');
            return;
        }
        await send_to_r(code);
        return;
    }

    if (mode === 'above') {
        const above = chunks_above(chunks, cursor_line);
        const code = combined_code(lines, above);
        if (code.length === 0) {
            vscode.window.showInformationMessage('Raven: no runnable chunks above the cursor.');
            return;
        }
        await send_to_r(code);
        return;
    }

    const current = find_chunk_at_line(chunks, cursor_line);
    if (!current) {
        vscode.window.showInformationMessage(
            'Raven: cursor is not inside an R chunk. Place the cursor inside a ```{r} block or after a `# %%` marker.'
        );
        return;
    }
    if (!is_runnable_chunk(current)) {
        vscode.window.showInformationMessage(
            `Raven: current chunk language is "${current.language}" — only "r" chunks can be sent to the R console.`
        );
        return;
    }
    const code = extract_chunk_code(lines, current);
    if (code.trim().length === 0) {
        vscode.window.showInformationMessage('Raven: current chunk is empty.');
        if (mode === 'currentAndMove' && editor) move_cursor_to_next_chunk(editor, chunks, current);
        return;
    }
    await send_to_r(code);
    if (mode === 'currentAndMove' && editor) move_cursor_to_next_chunk(editor, chunks, current);
}

async function run_chunk(mode: RunMode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await run_chunk_at(mode, editor.document, editor.selection.active.line);
}

async function run_chunk_at_command(
    mode: RunMode,
    uri_or_arg: unknown,
    line_arg: unknown,
): Promise<void> {
    const uri = uri_or_arg instanceof vscode.Uri ? uri_or_arg : null;
    const line = typeof line_arg === 'number' ? line_arg : null;
    if (uri === null || line === null) {
        // Invoked without arguments (e.g. directly from the command palette).
        // Fall back to the active editor's cursor.
        await run_chunk(mode);
        return;
    }
    let document: vscode.TextDocument;
    try {
        document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
        // Stale CodeLens: refuse to silently run a different chunk. Surface the
        // failure so the user knows the click didn't take effect.
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
            `Raven: could not open chunk document (${message}). Try reopening the file.`
        );
        return;
    }
    await run_chunk_at(mode, document, line);
}

export function register_chunk_commands(context: vscode.ExtensionContext): void {
    const handlers: Array<[string, RunMode]> = [
        ['raven.runCurrentChunk', 'current'],
        ['raven.runCurrentChunkAndMove', 'currentAndMove'],
        ['raven.runAboveChunks', 'above'],
        ['raven.runAllChunks', 'all'],
    ];
    for (const [id, mode] of handlers) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, () => run_chunk(mode))
        );
    }

    // Positional variants used by CodeLens (header line is known up-front).
    const positional: Array<[string, RunMode]> = [
        ['raven.runCurrentChunkAt', 'current'],
        ['raven.runAboveChunksAt', 'above'],
    ];
    for (const [id, mode] of positional) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, (uri: unknown, line: unknown) =>
                run_chunk_at_command(mode, uri, line)
            ),
        );
    }
}

export { chunks_for_document, get_document_lines };
