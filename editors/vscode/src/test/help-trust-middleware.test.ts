import * as assert from 'assert';
import * as vscode from 'vscode';
import { wrapHoverWithHelpTrust } from '../help/hover-trust-middleware';

suite('help-trust-middleware', () => {
    test('marks MarkdownString as trusted for raven.openHelpPanel only', async () => {
        const md = new vscode.MarkdownString('hello');
        const next = async () => new vscode.Hover([md]);
        const wrapped = wrapHoverWithHelpTrust(next);
        const result = await wrapped(
            {} as vscode.TextDocument,
            new vscode.Position(0, 0),
            new vscode.CancellationTokenSource().token,
        );
        assert.ok(result);
        const c = result.contents[0] as vscode.MarkdownString;
        const t = c.isTrusted;
        assert.ok(typeof t === 'object' && t !== null);
        // VS Code's API uses `enabledCommands`.
        assert.deepStrictEqual((t as { enabledCommands: string[] }).enabledCommands, [
            'raven.openHelpPanel',
        ]);
    });

    test('returns null hover unchanged', async () => {
        const next = async () => null;
        const wrapped = wrapHoverWithHelpTrust(next);
        const result = await wrapped(
            {} as vscode.TextDocument,
            new vscode.Position(0, 0),
            new vscode.CancellationTokenSource().token,
        );
        assert.strictEqual(result, null);
    });
});
