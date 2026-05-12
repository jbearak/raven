import * as vscode from 'vscode';
import { get_or_create_r_terminal } from './r-terminal-manager';

export interface InspectionCommand {
    id: string;
    title: string;
    wrap: (expr: string) => string;
}

export const INSPECTION_COMMANDS: InspectionCommand[] = [
    {
        id: 'raven.inspect.nrow',
        title: 'Show nrow',
        wrap: (e) => `nrow(${e})`,
    },
    {
        id: 'raven.inspect.length',
        title: 'Show length',
        wrap: (e) => `length(${e})`,
    },
    {
        id: 'raven.inspect.head',
        title: 'Show head',
        wrap: (e) => `head(${e})`,
    },
    {
        id: 'raven.inspect.headTransposed',
        title: 'Show head (transposed)',
        wrap: (e) => `t(head(${e}))`,
    },
    {
        id: 'raven.inspect.names',
        title: 'Show names',
        wrap: (e) => `names(${e})`,
    },
    {
        id: 'raven.inspect.view',
        title: 'View',
        wrap: (e) => `View(${e})`,
    },
];

export function get_inspection_target(editor: vscode.TextEditor): string | null {
    const selection = editor.selection;
    if (!selection.isEmpty) {
        const text = editor.document.getText(selection).trim();
        return text.length > 0 ? text : null;
    }
    const range = editor.document.getWordRangeAtPosition(selection.active);
    if (!range) return null;
    const text = editor.document.getText(range).trim();
    return text.length > 0 ? text : null;
}

export function register_inspection_commands(
    context: vscode.ExtensionContext
): void {
    for (const cmd of INSPECTION_COMMANDS) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, async () => {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.document.languageId !== 'r') {
                    vscode.window.showInformationMessage(
                        'Open an R file to use quick inspection commands.'
                    );
                    return;
                }
                const target = get_inspection_target(editor);
                if (!target) {
                    vscode.window.showInformationMessage(
                        'Place the cursor on an R identifier or select an expression.'
                    );
                    return;
                }
                const code = cmd.wrap(target);
                const terminal = await get_or_create_r_terminal();
                terminal.show(true);
                terminal.sendText(code);
            })
        );
    }
}
