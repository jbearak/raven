import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    INSPECTION_COMMANDS,
    get_inspection_target,
} from '../../send-to-r/inspect-commands';

suite('quick inspection commands', () => {
    test('INSPECTION_COMMANDS wraps target in the documented R calls', () => {
        const wraps = Object.fromEntries(
            INSPECTION_COMMANDS.map((c) => [c.id, c.wrap('x')])
        );
        assert.strictEqual(wraps['raven.inspect.nrow'], 'nrow(x)');
        assert.strictEqual(wraps['raven.inspect.length'], 'length(x)');
        assert.strictEqual(wraps['raven.inspect.head'], 'head(x)');
        assert.strictEqual(
            wraps['raven.inspect.headTransposed'],
            't(head(x))'
        );
        assert.strictEqual(wraps['raven.inspect.names'], 'names(x)');
        assert.strictEqual(wraps['raven.inspect.view'], 'View(x)');
    });

    test('every inspection command is registered in VS Code', async () => {
        const all = new Set(await vscode.commands.getCommands(true));
        for (const cmd of INSPECTION_COMMANDS) {
            assert.ok(
                all.has(cmd.id),
                `expected command "${cmd.id}" to be registered`
            );
        }
    });

    test('get_inspection_target returns the word at cursor when no selection', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'r',
            content: 'my_data\n',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 3),
            new vscode.Position(0, 3)
        );
        assert.strictEqual(get_inspection_target(editor), 'my_data');
    });

    test('get_inspection_target returns the selection text when a range is selected', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'r',
            content: 'df$col[1:5]\n',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 0),
            new vscode.Position(0, 11)
        );
        assert.strictEqual(get_inspection_target(editor), 'df$col[1:5]');
    });

    test('get_inspection_target returns null when the cursor is not on a word', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'r',
            content: '   \n',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 1),
            new vscode.Position(0, 1)
        );
        assert.strictEqual(get_inspection_target(editor), null);
    });

    test('get_inspection_target treats whitespace-only selection as no target', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'r',
            content: '   x\n',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 0),
            new vscode.Position(0, 2)
        );
        assert.strictEqual(get_inspection_target(editor), null);
    });

    test('INSPECTION_COMMANDS are advertised in package.json under the R category', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require('../../../package.json') as {
            contributes: {
                commands: Array<{
                    command: string;
                    title: string;
                    category?: string;
                }>;
            };
        };
        const declared = new Map(
            pkg.contributes.commands.map((c) => [c.command, c])
        );
        for (const cmd of INSPECTION_COMMANDS) {
            const entry = declared.get(cmd.id);
            assert.ok(entry, `package.json must declare ${cmd.id}`);
            assert.strictEqual(
                entry.title,
                cmd.title,
                `package.json must declare ${cmd.id} with title "${cmd.title}"`
            );
            assert.strictEqual(
                entry.category,
                'R',
                `package.json must declare ${cmd.id} under the "R" category`
            );
        }
    });

    test('command no-ops when active editor is not an R document', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: 'my_data\n',
        });
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 3),
            new vscode.Position(0, 3)
        );

        // Capture the info message rather than asserting on the terminal.
        // The handler should fail closed (no terminal created) when the
        // active document isn't R.
        const original = vscode.window.showInformationMessage;
        let last_message: string | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.window as any).showInformationMessage = (msg: string) => {
            last_message = msg;
            return Promise.resolve(undefined);
        };
        try {
            await vscode.commands.executeCommand('raven.inspect.nrow');
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).showInformationMessage = original;
        }
        assert.ok(
            last_message && last_message.includes('R file'),
            `expected an info message about opening an R file, got: ${String(last_message)}`
        );
    });
});
