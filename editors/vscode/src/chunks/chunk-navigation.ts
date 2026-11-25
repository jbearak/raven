import * as vscode from 'vscode';
import { chunks_for_document } from './chunk-commands';
import {
    Chunk,
    classify_chunk_document_for_document,
    find_chunk_at_line,
} from './chunk-detector';

function supports_chunk_navigation(document: vscode.TextDocument): boolean {
    // Regular Markdown intentionally gets only the execution CodeLens. Keep
    // the globally registered palette commands from turning it into another
    // chunk-authoring surface.
    return classify_chunk_document_for_document(document) !== 'markdown';
}

/**
 * Context key: the active editor's document has chunks to move between.
 *
 * Gates the Ctrl/Cmd+PageDown and Ctrl/Cmd+PageUp bindings of
 * `raven.goToNextChunk` / `raven.goToPreviousChunk`. On Windows and Linux
 * those keys are VS Code's Next/Previous Editor; in an R file without
 * chunks the commands would do nothing, so the keys must fall through to
 * switching tabs. The commands stay in the palette regardless.
 */
export const HAS_CHUNKS_CONTEXT = 'raven.editorHasChunks';

/** Whether `document` has a chunk the navigation commands can move to. */
export function has_navigable_chunks(document: vscode.TextDocument): boolean {
    // The keybindings fire only in these languages; don't scan other files.
    if (!['r', 'rmd', 'quarto'].includes(document.languageId)) return false;
    return chunks_for_document(document).length > 0;
}

/**
 * Keep {@link HAS_CHUNKS_CONTEXT} in step with the active editor: at once on
 * an editor switch or a language-mode change (VS Code reopens the document),
 * and shortly after an edit to its document (adding or removing a `# %%`
 * marker or fence changes it).
 */
function track_chunk_context(context: vscode.ExtensionContext): void {
    let current: boolean | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
        if (pending !== undefined) clearTimeout(pending);
        pending = undefined;
        const doc = vscode.window.activeTextEditor?.document;
        const value = doc !== undefined && has_navigable_chunks(doc);
        if (value === current) return;
        current = value;
        void vscode.commands.executeCommand('setContext', HAS_CHUNKS_CONTEXT, value);
    };
    update();
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(update),
        vscode.workspace.onDidOpenTextDocument(update),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document !== vscode.window.activeTextEditor?.document) return;
            if (pending !== undefined) clearTimeout(pending);
            pending = setTimeout(update, 150);
        }),
        new vscode.Disposable(() => {
            if (pending !== undefined) clearTimeout(pending);
        }),
    );
}

function move_to_line(editor: vscode.TextEditor, line: number): void {
    const safe = Math.max(0, Math.min(line, editor.document.lineCount - 1));
    const text = editor.document.lineAt(safe).text;
    const column = Math.min(editor.selection.active.character, text.length);
    const pos = new vscode.Position(safe, column);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
}

function go_to_next(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!supports_chunk_navigation(editor.document)) return;
    const chunks = chunks_for_document(editor.document);
    if (chunks.length === 0) return;
    const cursor = editor.selection.active.line;
    const next = chunks.find((c) => c.header_line > cursor);
    if (!next) {
        vscode.window.setStatusBarMessage('Raven: already at the last chunk.', 2000);
        return;
    }
    // Place the cursor one line below the header (i.e. inside the chunk body) when possible.
    const target = next.header_line + 1 <= next.end_line ? next.header_line + 1 : next.header_line;
    move_to_line(editor, target);
}

function go_to_previous(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!supports_chunk_navigation(editor.document)) return;
    const chunks = chunks_for_document(editor.document);
    if (chunks.length === 0) return;
    const cursor = editor.selection.active.line;
    // Find the last chunk whose header is strictly above the cursor's current header.
    const current = find_chunk_at_line(chunks, cursor);
    const reference_header = current ? current.header_line : cursor;
    let prev: Chunk | null = null;
    for (const c of chunks) {
        if (c.header_line < reference_header) prev = c;
        else break;
    }
    if (!prev) {
        vscode.window.setStatusBarMessage('Raven: already at the first chunk.', 2000);
        return;
    }
    const target = prev.header_line + 1 <= prev.end_line ? prev.header_line + 1 : prev.header_line;
    move_to_line(editor, target);
}

function select_current(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!supports_chunk_navigation(editor.document)) return;
    const chunks = chunks_for_document(editor.document);
    if (chunks.length === 0) return;
    const cursor = editor.selection.active.line;
    const current = find_chunk_at_line(chunks, cursor);
    if (!current) {
        vscode.window.setStatusBarMessage(
            'Raven: cursor is not inside a chunk.',
            2000,
        );
        return;
    }
    // Empty chunk (no body lines): collapse the cursor to the end of the header
    // rather than pretending we selected content. This avoids accidentally
    // capturing the closing fence (Rmd) or cell-marker line (.R).
    if (current.end_line <= current.header_line) {
        const header_text = editor.document.lineAt(current.header_line).text;
        const pos = new vscode.Position(current.header_line, header_text.length);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
        return;
    }
    const start = new vscode.Position(current.header_line + 1, 0);
    const end_text = editor.document.lineAt(current.end_line).text;
    const end = new vscode.Position(current.end_line, end_text.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end));
}

export function register_chunk_navigation(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('raven.goToNextChunk', go_to_next),
        vscode.commands.registerCommand('raven.goToPreviousChunk', go_to_previous),
        vscode.commands.registerCommand('raven.selectCurrentChunk', select_current),
    );
    track_chunk_context(context);
}
