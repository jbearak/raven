import * as vscode from 'vscode';
import {
    detect_r_statement,
    get_upward_bounds,
    get_downward_bounds,
} from './statement-detector';
import { get_or_create_r_terminal } from './r-terminal-manager';
import { create_temp_file, schedule_temp_file_cleanup } from './temp-file';

type SendMode = 'statement' | 'upward' | 'downward' | 'file';

function get_lines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return lines;
}

function advance_cursor(
    editor: vscode.TextEditor,
    end_line: number
): void {
    const config = vscode.workspace.getConfiguration('raven.sendToR');
    if (!config.get<boolean>('advanceCursorOnSend', true)) return;

    const next = end_line + 1;
    if (next >= editor.document.lineCount) return;

    const pos = new vscode.Position(next, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
}

async function compute_send_payload(
    editor: vscode.TextEditor,
    mode: SendMode,
): Promise<{ code: string; advance_to_line: number | null } | null> {
    const document = editor.document;

    if (mode === 'file') {
        if (document.isUntitled || document.isDirty) {
            const saved = await document.save();
            if (!saved) return null;
        }
        if (document.isUntitled) return null;
        return {
            code: `source(${JSON.stringify(document.uri.fsPath)}, echo = TRUE)`,
            advance_to_line: null,
        };
    }

    if (mode === 'statement') {
        if (!editor.selection.isEmpty) {
            return { code: document.getText(editor.selection), advance_to_line: null };
        }
        const lines = get_lines(document);
        const bounds = detect_r_statement(lines, editor.selection.active.line);
        return {
            code: lines.slice(bounds.start_line, bounds.end_line + 1).join('\n'),
            advance_to_line: bounds.end_line,
        };
    }

    const lines = get_lines(document);
    const bounds = mode === 'upward'
        ? get_upward_bounds(lines, editor.selection.active.line)
        : get_downward_bounds(lines, editor.selection.active.line);
    return {
        code: lines.slice(bounds.start_line, bounds.end_line + 1).join('\n'),
        advance_to_line: null,
    };
}

async function handle_send(mode: SendMode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const payload = await compute_send_payload(editor, mode);
    if (!payload) return;
    const { code, advance_to_line } = payload;

    const terminal = await get_or_create_r_terminal();
    terminal.show(true);

    if (code.includes('\n')) {
        send_via_tempfile(terminal, code);
    } else {
        terminal.sendText(code);
    }

    if (advance_to_line !== null) {
        advance_cursor(editor, advance_to_line);
    }
}

async function handle_terminal_send(mode: SendMode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
        vscode.window.showErrorMessage('No active terminal. Open a terminal first.');
        return;
    }

    const payload = await compute_send_payload(editor, mode);
    if (!payload) return;
    const { code, advance_to_line } = payload;

    terminal.show(true);

    if (mode === 'file') {
        terminal.sendText(code);
    } else {
        send_via_tempfile(terminal, code);
    }

    if (advance_to_line !== null) {
        advance_cursor(editor, advance_to_line);
    }
}

function send_via_tempfile(terminal: vscode.Terminal, code: string): void {
    const tmp = create_temp_file(code);
    // Have R unlink the script's per-call directory as part of consuming it,
    // so cleanup is tied to execution rather than a wall-clock timer. The JS
    // fallback below only runs if R never reaches the source() line (e.g.
    // session crashed).
    const path_literal = JSON.stringify(tmp);
    terminal.sendText(
        `local({ .raven_src <- ${path_literal}; on.exit(unlink(dirname(.raven_src), recursive = TRUE)); source(.raven_src, echo = TRUE) })`
    );
    schedule_temp_file_cleanup(tmp);
}

export function register_send_to_r_commands(
    context: vscode.ExtensionContext
): void {
    const commands: Array<[string, SendMode]> = [
        ['raven.runLineOrSelection', 'statement'],
        ['raven.runUpwardLines', 'upward'],
        ['raven.runDownwardLines', 'downward'],
        ['raven.sourceFile', 'file'],
    ];

    for (const [id, mode] of commands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, () => handle_send(mode))
        );
    }

    // Terminal submenu: send to active terminal via tempfile
    const terminal_commands: Array<[string, SendMode]> = [
        ['raven.terminal.runLineOrSelection', 'statement'],
        ['raven.terminal.runUpwardLines', 'upward'],
        ['raven.terminal.runDownwardLines', 'downward'],
        ['raven.terminal.sourceFile', 'file'],
    ];

    for (const [id, mode] of terminal_commands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, () => handle_terminal_send(mode))
        );
    }
}
