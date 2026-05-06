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

function is_radian(): boolean {
    const config = vscode.workspace.getConfiguration('raven.rTerminal');
    return config.get<string>('program', 'R') === 'radian';
}

async function handle_send(mode: SendMode): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    let code: string;
    let statement_end_line: number | null = null;

    if (mode === 'file') {
        if (document.isDirty) {
            await document.save();
        }
        const fsPath = document.uri.fsPath.replace(/\\/g, '/').replace(/"/g, '\\"');
        code = `source("${fsPath}", echo = TRUE)`;
    } else if (mode === 'statement') {
        if (!editor.selection.isEmpty) {
            code = document.getText(editor.selection);
        } else {
            const lines = get_lines(document);
            const bounds = detect_r_statement(lines, editor.selection.active.line);
            const selected: string[] = [];
            for (let i = bounds.start_line; i <= bounds.end_line; i++) {
                selected.push(lines[i]);
            }
            code = selected.join('\n');
            statement_end_line = bounds.end_line;
        }
    } else if (mode === 'upward') {
        const lines = get_lines(document);
        const bounds = get_upward_bounds(lines, editor.selection.active.line);
        const selected: string[] = [];
        for (let i = bounds.start_line; i <= bounds.end_line; i++) {
            selected.push(lines[i]);
        }
        code = selected.join('\n');
    } else {
        const lines = get_lines(document);
        const bounds = get_downward_bounds(lines, editor.selection.active.line);
        const selected: string[] = [];
        for (let i = bounds.start_line; i <= bounds.end_line; i++) {
            selected.push(lines[i]);
        }
        code = selected.join('\n');
    }

    const terminal = await get_or_create_r_terminal();
    terminal.show(true);

    if (code.includes('\n')) {
        send_via_tempfile(terminal, code);
    } else {
        terminal.sendText(code);
    }

    if (statement_end_line !== null) {
        advance_cursor(editor, statement_end_line);
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

    const document = editor.document;
    let code: string;
    let statement_end_line: number | null = null;

    if (mode === 'file') {
        if (document.isDirty) {
            await document.save();
        }
        const fsPath = document.uri.fsPath.replace(/\\/g, '/').replace(/"/g, '\\"');
        code = `source("${fsPath}", echo = TRUE)`;
        terminal.sendText(code);
    } else if (mode === 'statement') {
        if (!editor.selection.isEmpty) {
            code = document.getText(editor.selection);
        } else {
            const lines = get_lines(document);
            const bounds = detect_r_statement(lines, editor.selection.active.line);
            const selected: string[] = [];
            for (let i = bounds.start_line; i <= bounds.end_line; i++) {
                selected.push(lines[i]);
            }
            code = selected.join('\n');
            statement_end_line = bounds.end_line;
        }
        send_via_tempfile(terminal, code);
    } else if (mode === 'upward') {
        const lines = get_lines(document);
        const bounds = get_upward_bounds(lines, editor.selection.active.line);
        const selected: string[] = [];
        for (let i = bounds.start_line; i <= bounds.end_line; i++) {
            selected.push(lines[i]);
        }
        code = selected.join('\n');
        send_via_tempfile(terminal, code);
    } else {
        const lines = get_lines(document);
        const bounds = get_downward_bounds(lines, editor.selection.active.line);
        const selected: string[] = [];
        for (let i = bounds.start_line; i <= bounds.end_line; i++) {
            selected.push(lines[i]);
        }
        code = selected.join('\n');
        send_via_tempfile(terminal, code);
    }

    terminal.show(true);

    if (statement_end_line !== null) {
        advance_cursor(editor, statement_end_line);
    }
}

function send_via_tempfile(terminal: vscode.Terminal, code: string): void {
    const tmp = create_temp_file(code);
    const escaped = tmp.replace(/\\/g, '/').replace(/"/g, '\\"');
    terminal.sendText(`source("${escaped}", echo = TRUE)`);
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
